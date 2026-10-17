// 后台补算图库的向量（API 进程里跑）：刚换了 embedding 模型要全部重算、传图时模型调用失败要重试。
// 一批 8 张，算完一批马上接下一批；没活干时每分钟看一次，换模型时由 kickGalleryEmbeddings() 立刻叫醒。
// 多个 API 进程同时跑时用事务级 advisory lock，同一时刻只有一个在算。
import { sql } from "drizzle-orm"

import type { Db } from "../db/client.js"
import { embedPending } from "./service.js"

const IDLE_MS = 60_000
/** 模型调用失败后歇一会儿再试，免得一直打到限流 */
const ERROR_MS = 30_000
const LOCK_KEY = sql`hashtext('heyagent.gallery_embed')`

let wake: (() => void) | undefined

/** 换了默认 embedding 模型时调用：后台循环在跑就马上开始重算（没在跑就什么也不做） */
export function kickGalleryEmbeddings() {
  wake?.()
}

/** 处理一批；拿不到锁（别的进程在算）返回 0 */
export async function embedPendingOnce(db: Db, batch = 8): Promise<number> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ ok: boolean }>(sql`select pg_try_advisory_xact_lock(${LOCK_KEY}) as ok`)
    if (!locked.rows[0]?.ok) return 0
    return embedPending(db, batch)
  })
}

/** 启动后台循环，返回停止函数（关机时调用） */
export function startGalleryEmbeddings(db: Db): () => void {
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
        if ((await embedPendingOnce(db)) > 0) wait = 0
      } catch (error) {
        console.warn(`[gallery] 后台算向量失败，${ERROR_MS / 1000} 秒后重试：${(error as Error).message}`)
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
