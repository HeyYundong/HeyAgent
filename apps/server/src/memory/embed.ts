// 记忆的向量（docs/dev/memory-retrieval.md 第 2 节）。
// - 用的模型 = 图库的 embedding 模型（model_defaults 的 embed，gallery/embed.ts 的 currentEmbedModel），向量 1024 维，调 gallery/embed.ts 的 embed()（文字输入）；
// - 只算「生效」的记忆；向量按 (memory_id, model_id) 存在 memory_embeddings，content_hash = md5(shared 的 memoryEmbedText)；
// - 「要算」= 当前模型下没有行，或者行里的 content_hash 和记忆现在的内容对不上（改过）。判断全在 SQL 里：
//   md5(applies_to || E'\n' || content)，所以谁改了记忆（记忆页、助手、导入、审核通过）都不用另外通知，后台自己会发现；
// - 后台循环在 API 进程（index.ts 里和图库的并列启动），一批 32 条，失败的隔 10 分钟再试，多进程用事务级 advisory lock；
//   当前模型一条不落都算完了才删别的模型的行（同图库）。
import { createHash } from "node:crypto"

import { memoryEmbedText, type MemoryEmbedInfo } from "@heyagent/shared"
import { and, asc, count, eq, exists, inArray, isNull, ne, notExists, or, sql, type SQL } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import type { DbLike } from "../engine/records.js"
import { currentEmbedModel, embed } from "../gallery/embed.js"

const IDLE_MS = 60_000
/** 模型调用失败后歇一会儿再接着算别的，免得一直打到限流（算失败的那几条要隔 10 分钟才再试，见 retryable） */
const ERROR_MS = 30_000
const LOCK_KEY = sql`hashtext('heyagent.memory_embed')`

/** JS 里算的 content_hash：和 SQL 的 md5(applies_to || E'\n' || content) 一样（库是 UTF-8） */
export const memoryContentHash = (memory: { appliesTo: string; content: string }) =>
  createHash("md5").update(memoryEmbedText(memory), "utf8").digest("hex")

/** SQL 里记忆现在的 content_hash */
const currentHash = sql`md5(${t.memories.appliesTo} || E'\\n' || ${t.memories.content})`

/** 写 embed_error / embed_tried_at 时 updated_at 不动（那是人改记忆的时间） */
const keepUpdatedAt = { updatedAt: sql`${t.memories.updatedAt}` }

const embeddingOf = (db: DbLike, modelId: string) =>
  db
    .select({ one: sql`1` })
    .from(t.memoryEmbeddings)
    .where(and(eq(t.memoryEmbeddings.memoryId, t.memories.id), eq(t.memoryEmbeddings.modelId, modelId), eq(t.memoryEmbeddings.contentHash, currentHash)))

/** 这条记忆在 modelId 下有按现在的内容算好的向量（用在 from memories 的查询里） */
export const memoryEmbedReady = (db: DbLike, modelId: string): SQL => exists(embeddingOf(db, modelId))

/** 没失败过、算成过，或者失败已经过了 10 分钟 */
const retryable = or(isNull(t.memories.embedTriedAt), isNull(t.memories.embedError), sql`${t.memories.embedTriedAt} < now() - interval '10 minutes'`)

/** 当前模型下还没算好的生效记忆（不管失败过没有） */
export function memoriesNotReady(db: DbLike, modelId: string): SQL {
  return and(eq(t.memories.status, "active"), notExists(embeddingOf(db, modelId)))!
}

/** 存向量：主键冲突就更新 hash 和向量（后台和运行开始时同时算同一条也没事），并清掉失败记录（会推 memories，记忆页跟着刷新） */
export async function saveMemoryEmbeddings(
  db: DbLike,
  modelId: string,
  rows: { id: string; appliesTo: string; content: string; vector: number[] }[]
): Promise<void> {
  if (rows.length === 0) return
  const now = new Date()
  await db
    .insert(t.memoryEmbeddings)
    .values(rows.map((row) => ({ memoryId: row.id, modelId, contentHash: memoryContentHash(row), embedding: row.vector, createdAt: now })))
    .onConflictDoUpdate({
      target: [t.memoryEmbeddings.memoryId, t.memoryEmbeddings.modelId],
      set: { contentHash: sql`excluded.content_hash`, embedding: sql`excluded.embedding`, createdAt: now },
    })
  await db.update(t.memories).set({ embedError: null, embedTriedAt: now, ...keepUpdatedAt }).where(inArray(t.memories.id, rows.map((row) => row.id)))
}

let wake: (() => void) | undefined

/**
 * 记忆新建、修改、审核通过、换了 embedding 模型以后调用：后台循环在跑就马上叫醒它（没在跑就什么也不做）。
 * 不调也行，后台每分钟自己看一次
 */
export function kickMemoryEmbeddings(): void {
  wake?.()
}

/** 处理一批要算的记忆，返回处理了几条；没设 embedding 模型返回 0；拿不到锁（别的进程在算）返回 0。模型出错时记下原因再抛出 */
export async function embedPendingMemoriesOnce(db: Db, batch = 32): Promise<number> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(${LOCK_KEY}) as ok`)
    if (!locked.rows[0]?.ok) return 0
    return embedPending(db, batch)
  })
}

async function embedPending(db: Db, batch: number): Promise<number> {
  const model = await currentEmbedModel(db)
  if (!model) return 0
  const rows = await db
    .select({ id: t.memories.id, appliesTo: t.memories.appliesTo, content: t.memories.content })
    .from(t.memories)
    .where(and(memoriesNotReady(db, model.id), retryable))
    .orderBy(asc(t.memories.id))
    .limit(batch)
  if (rows.length === 0) {
    // 当前模型把所有生效的记忆都算完了，别的模型的向量才删（换回来时再算，一条不到一厘钱）
    const [left] = await db.select({ n: count() }).from(t.memories).where(memoriesNotReady(db, model.id))
    if ((left?.n ?? 0) === 0) await db.delete(t.memoryEmbeddings).where(ne(t.memoryEmbeddings.modelId, model.id))
    return 0
  }
  try {
    const vectors = await embed(db, model.id, rows.map((row) => ({ text: memoryEmbedText(row) })))
    await saveMemoryEmbeddings(db, model.id, rows.map((row, i) => ({ ...row, vector: vectors[i]! })))
  } catch (error) {
    const reason = (error as Error).message.slice(0, 500)
    await db.update(t.memories).set({ embedError: reason, embedTriedAt: new Date(), ...keepUpdatedAt }).where(inArray(t.memories.id, rows.map((row) => row.id)))
    throw error
  }
  return rows.length
}

/** 启动后台循环，返回停止函数（关机时调用）。写法同 gallery/background.ts 的 startGalleryEmbeddings */
export function startMemoryEmbeddings(db: Db): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      wake = () => {
        clearTimeout(timer)
        resolve()
      }
      timer = setTimeout(resolve, ms)
      timer.unref?.()
    })
  void (async () => {
    while (!stopped) {
      let wait = IDLE_MS
      try {
        if ((await embedPendingMemoriesOnce(db)) > 0) wait = 0
      } catch (error) {
        console.warn(`[memory] 后台算记忆的向量失败，${ERROR_MS / 1000} 秒后接着算别的：${(error as Error).message}`)
        wait = ERROR_MS
      }
      if (wait > 0 && !stopped) await sleep(wait)
    }
  })()
  return () => {
    stopped = true
    wake?.()
    wake = undefined
  }
}

/**
 * 记忆列表要的：每条「生效」记忆在当前 embedding 模型下算没算好（memories.list 的 MemoryRef.embed）。
 * 没设 embedding 模型时返回空 Map（页面显示「没设 embedding 模型」）
 */
export async function memoryEmbedInfos(db: DbLike): Promise<Map<string, MemoryEmbedInfo>> {
  const model = await currentEmbedModel(db)
  if (!model) return new Map()
  const rows = await db
    .select({ id: t.memories.id, ready: memoryEmbedReady(db, model.id).mapWith(Boolean), error: t.memories.embedError })
    .from(t.memories)
    .where(eq(t.memories.status, "active"))
  return new Map(
    rows.map((row): [string, MemoryEmbedInfo] => [
      row.id,
      row.ready ? { state: "ready" } : row.error ? { state: "failed", error: row.error } : { state: "pending" },
    ])
  )
}
