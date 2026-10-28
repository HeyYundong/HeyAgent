// 记忆按内容自动挑选（docs/dev/memory-retrieval.md 第 3、5 节）。
// 开始运行的事务里（engine/sessions.ts 的 buildSnapshot）只在快照里写 autoMemory = { status: "pending", limit }，不调模型；
// worker 进这次运行时（engine/loop.ts 的 runSession，建系统提示之前）调 resolveAutoMemory：算查询文字的向量、挑、写回快照。
import {
  AUTO_MEMORY_INLINE_EMBED_MAX,
  AUTO_MEMORY_LIMIT_DEFAULT,
  AUTO_MEMORY_QUERY_MAX_CHARS,
  AUTO_MEMORY_TIMEOUT_MS,
  autoMemoryMinScore,
  memoryEmbedText,
  type AutoMemorySnapshot,
  type RunMemoryUse,
  type SessionSnapshot,
} from "@heyagent/shared"
import { and, asc, count, eq, inArray, notInArray, sql, type SQL } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { appendEvent } from "../engine/records.js"
import { runtime } from "../engine/runtime.js"
import { currentEmbedModel, embed, vectorLiteral } from "../gallery/embed.js"
import { memoriesNotReady, saveMemoryEmbeddings } from "./embed.js"

/** 一条挑中的记忆：相似度从高到低 */
export interface PickedMemory {
  id: string
  appliesTo: string
  content: string
  /** 余弦相似度，四舍五入到 4 位小数 */
  score: number
}

export interface AutoMemoryResult {
  /** 写回快照的 autoMemory（status 不会是 pending） */
  autoMemory: AutoMemorySnapshot
  picked: PickedMemory[]
  /** 一条都不够门槛时，最像的那一条（给过程里写「最像的是 …」） */
  best?: PickedMemory
}

const round4 = (value: number) => Math.round(value * 10_000) / 10_000
const score2 = (value: number) => value.toFixed(2)
const clipText = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value)

/**
 * 拿来挑记忆的文字（设计 3.1）：任务标题、目标、步骤、这次的说明（note）、派活的标题 / 说明 / 参数，
 * 一项一行，截到 AUTO_MEMORY_QUERY_MAX_CHARS。纯函数，单元测试直接测
 */
export function autoMemoryQueryText(snapshot: SessionSnapshot): string {
  const dispatch = snapshot.dispatch
  const lines = [
    snapshot.task.title,
    snapshot.task.goal,
    ...snapshot.task.steps.map((step) => step.text),
    snapshot.note,
    dispatch?.title,
    dispatch?.note,
    ...Object.entries(dispatch?.params ?? {}).map(([name, value]) => (value.trim() ? `${name}：${value}` : "")),
  ]
  return lines
    .map((line) => line?.trim() ?? "")
    .filter(Boolean)
    .join("\n")
    .slice(0, AUTO_MEMORY_QUERY_MAX_CHARS)
}

class PickTimeout extends Error {}

/**
 * 挑（设计 3.2～3.4）：候选 = 生效、不是手选的、不是 web_unverified（来自网页没核实）的、向量按现在的内容算好了的记忆；顺手补算没算好的（最多 AUTO_MEMORY_INLINE_EMBED_MAX 条）；
 * 按余弦相似度从高到低取 ≥ 门槛的前 limit 条。不写库（除了补算的向量），出错不抛：返回 failed / skipped
 */
export async function pickMemories(db: Db, snapshot: SessionSnapshot): Promise<AutoMemoryResult> {
  const limit = snapshot.autoMemory?.limit ?? AUTO_MEMORY_LIMIT_DEFAULT
  const timeoutMs = runtime.autoMemoryTimeoutMs ?? AUTO_MEMORY_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      pick(db, snapshot, limit),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PickTimeout()), timeoutMs)
      }),
    ])
  } catch (error) {
    const reason =
      error instanceof PickTimeout
        ? `等了 ${Math.round(timeoutMs / 1000)} 秒还没挑完（embedding 模型太慢或连不上）`
        : clipText((error as Error).message || String(error), 300)
    return { autoMemory: { status: "failed", limit, at: new Date().toISOString(), reason }, picked: [] }
  } finally {
    clearTimeout(timer)
  }
}

async function pick(db: Db, snapshot: SessionSnapshot, limit: number): Promise<AutoMemoryResult> {
  const at = () => new Date().toISOString()
  const model = await currentEmbedModel(db)
  if (!model) return { autoMemory: { status: "skipped", limit, at: at(), reason: "还没设 embedding 模型（模型页 → 默认设置）" }, picked: [] }

  // 能挑的：生效、不是手选的、不是来自网页没核实的
  const manualIds = snapshot.memories.filter((memory) => !memory.auto).map((memory) => memory.id)
  const eligible: SQL = and(
    eq(t.memories.status, "active"),
    eq(t.memories.webUnverified, false),
    manualIds.length ? notInArray(t.memories.id, manualIds) : undefined
  )!
  const [total] = await db.select({ n: count() }).from(t.memories).where(eligible)
  if ((total?.n ?? 0) === 0) return { autoMemory: { status: "skipped", limit, at: at(), modelId: model.id, reason: "记忆库里没有能挑的记忆" }, picked: [] }

  // 还没按现在的内容算好向量的：最多 64 条和查询放在同一次调用里算掉，多的这次不参与
  const missing = and(eligible, memoriesNotReady(db, model.id))
  const [missingCount] = await db.select({ n: count() }).from(t.memories).where(missing)
  const inline = (missingCount?.n ?? 0)
    ? await db
        .select({ id: t.memories.id, appliesTo: t.memories.appliesTo, content: t.memories.content })
        .from(t.memories)
        .where(missing)
        .orderBy(asc(t.memories.id))
        .limit(AUTO_MEMORY_INLINE_EMBED_MAX)
    : []
  const notReady = (missingCount?.n ?? 0) - inline.length

  const query = autoMemoryQueryText(snapshot)
  const [queryVector, ...inlineVectors] = await embed(db, model.id, [{ text: query }, ...inline.map((row) => ({ text: memoryEmbedText(row) }))])
  await saveMemoryEmbeddings(db, model.id, inline.map((row, i) => ({ ...row, vector: inlineVectors[i]! })))

  // 精确余弦（不建 HNSW，几千条也只要几毫秒）：只用当前模型、按现在的内容算的向量
  const distance = sql<number>`(${t.memoryEmbeddings.embedding} <=> ${vectorLiteral(queryVector!)}::vector)`
  const rows = await db
    .select({ id: t.memories.id, appliesTo: t.memories.appliesTo, content: t.memories.content, distance })
    .from(t.memoryEmbeddings)
    .innerJoin(t.memories, eq(t.memories.id, t.memoryEmbeddings.memoryId))
    .where(
      and(
        eligible,
        eq(t.memoryEmbeddings.modelId, model.id),
        eq(t.memoryEmbeddings.contentHash, sql`md5(${t.memories.appliesTo} || E'\\n' || ${t.memories.content})`)
      )
    )
    .orderBy(distance, asc(t.memories.id))
    .limit(limit)
  const minScore = autoMemoryMinScore(model.id)
  const scored = rows.map((row) => ({ id: row.id, appliesTo: row.appliesTo, content: row.content, score: round4(1 - Number(row.distance)) }))
  const picked = scored.filter((row) => row.score >= minScore)
  const best = picked.length === 0 ? scored[0] : undefined
  // 一条都没过门槛：最像的那条写进 reason，运行详情显示在「没有够像的记忆（…）」里
  const reason =
    picked.length > 0 ? undefined : best ? `最像的是 ${best.id}（${score2(best.score)}），没到门槛 ${score2(minScore)}` : "没有算好向量的记忆可比"
  return {
    autoMemory: {
      status: "done",
      limit,
      at: at(),
      modelId: model.id,
      minScore,
      candidates: Math.max(0, (total?.n ?? 0) - notReady),
      notReady,
      query,
      ...(reason ? { reason } : {}),
    },
    picked,
    ...(best ? { best } : {}),
  }
}

/** 过程里的那一条（设计 5.3） */
function eventOf(result: AutoMemoryResult): { title: string; detail: string } {
  const auto = result.autoMemory
  const notReadyLine = auto.notReady ? `还有 ${auto.notReady} 条没算好，这次没参与` : undefined
  if (auto.status === "skipped") return { title: "没自动挑记忆", detail: auto.reason ?? "" }
  if (auto.status === "failed") return { title: "自动挑记忆没做成", detail: `${auto.reason ?? "原因不明"}；这次只用手选的记忆` }
  const threshold = `门槛 ${score2(auto.minScore ?? 0)}`
  if (result.picked.length === 0) {
    const best = result.best ? `，最像的是 ${result.best.id}（${score2(result.best.score)}）` : ""
    return { title: "没有够像的记忆", detail: [`${threshold}${best}`, `参与挑选 ${auto.candidates ?? 0} 条`, notReadyLine].filter(Boolean).join("\n") }
  }
  return {
    title: `自动挑了 ${result.picked.length} 条记忆`,
    detail: [
      ...result.picked.map((memory) => `${memory.id} [${memory.appliesTo}] ${clipText(memory.content.replace(/\s+/g, " "), 40)} · 相似度 ${score2(memory.score)}`),
      `参与挑选 ${auto.candidates ?? 0} 条，${threshold}`,
      notReadyLine,
    ]
      .filter(Boolean)
      .join("\n"),
  }
}

/**
 * worker 用（设计 5.1）：快照的 autoMemory 是 pending 时挑一次，在一个事务里写回 sessions.snapshot
 * （memories 追加挑中的、autoMemory 换成结果；条件是 snapshot->'autoMemory'->>'status' = 'pending'，不会挑两次）、
 * 写一条 plan 过程、给挑中的记忆写 lastUsedAt。返回更新后的快照（不是 pending 时原样返回，不调模型）
 */
export async function resolveAutoMemory(db: Db, sessionId: string, snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  if (snapshot.autoMemory?.status !== "pending") return snapshot
  const result = await pickMemories(db, snapshot)
  const taken = new Set(snapshot.memories.map((memory) => memory.id))
  const picked = result.picked.filter((memory) => !taken.has(memory.id))
  const next: SessionSnapshot = {
    ...snapshot,
    memories: [...snapshot.memories, ...picked.map(({ id, content, appliesTo, score }) => ({ id, content, appliesTo, auto: { score } }))],
    autoMemory: result.autoMemory,
  }
  const written = await db.transaction(async (tx) => {
    const updated = await tx
      .update(t.sessions)
      .set({ snapshot: next })
      .where(and(eq(t.sessions.id, sessionId), sql`${t.sessions.snapshot}->'autoMemory'->>'status' = 'pending'`))
      .returning({ id: t.sessions.id })
    if (updated.length === 0) return false
    await appendEvent(tx, sessionId, { kind: "plan", ...eventOf({ ...result, picked }) })
    if (picked.length)
      await tx
        .update(t.memories)
        .set({ lastUsedAt: new Date(), lastUsedSessionId: sessionId })
        .where(inArray(t.memories.id, picked.map((memory) => memory.id)))
    return true
  })
  if (written) return next
  // 别处（另一个 worker 进程）已经挑过：用库里的
  const [row] = await db.select({ snapshot: t.sessions.snapshot }).from(t.sessions).where(eq(t.sessions.id, sessionId))
  return row?.snapshot ?? next
}

/** 运行详情（sessions.get 的 memoryUse）：从快照里取，手选的在前、自动挑的在后 */
export function runMemoryUseOf(snapshot: SessionSnapshot): RunMemoryUse {
  const manual = snapshot.memories.filter((memory) => !memory.auto)
  const auto = snapshot.memories.filter((memory) => memory.auto).sort((a, b) => b.auto!.score - a.auto!.score)
  return {
    items: [...manual, ...auto].map(({ id, appliesTo, content, auto: picked }) => ({ id, appliesTo, content, ...(picked ? { auto: { score: picked.score } } : {}) })),
    ...(snapshot.autoMemory ? { auto: snapshot.autoMemory } : {}),
    taskMemoryCount: snapshot.taskMemory?.length ?? 0,
  }
}
