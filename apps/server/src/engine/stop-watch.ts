// 运行被停掉时的中止信号（docs/dev/sub-agents.md 21.3 第 4 条）：人取消、父结束连带停子运行、清扫，都是在别的事务里（常常在 API 进程）
// 把运行改成结束的状态，正在跑它的 worker 不知道。这里每个进程一个轮询：runSession 期间登记，每 stopPollMs 查一次这些运行的状态，
// 已经结束的就 abort 它的信号；正在调的模型（AbortSignal）、正在起的 Chrome（chrome.ts 的 startChrome）跟着马上停，不等调完、不等启动超时。
// 只认「已经结束」（ENDED_RUN_STATUSES），运行自己挂起（waiting）、交接不算。
import { ENDED_RUN_STATUSES } from "@heyagent/shared"
import { inArray } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { runtime } from "./runtime.js"

const ended = new Set<string>(ENDED_RUN_STATUSES)
const watched = new Map<string, Set<AbortController>>()
let timer: ReturnType<typeof setTimeout> | undefined
let pollDb: Db | undefined

async function poll() {
  timer = undefined
  const db = pollDb
  const ids = [...watched.keys()]
  if (db && ids.length) {
    try {
      const rows = await db.select({ id: t.sessions.id, status: t.sessions.status }).from(t.sessions).where(inArray(t.sessions.id, ids))
      for (const row of rows) {
        if (!ended.has(row.status)) continue
        for (const controller of watched.get(row.id) ?? []) controller.abort(new RunStoppedError(row.id))
        watched.delete(row.id)
      }
    } catch (error) {
      console.warn(`[engine] 查运行有没有被停掉时出错：${(error as Error).message}`)
    }
  }
  schedule()
}

function schedule() {
  if (timer || watched.size === 0) return
  timer = setTimeout(() => void poll(), runtime.stopPollMs)
  timer.unref()
}

/** 中止的原因：运行已经被停掉了（取消、父结束、清扫） */
export class RunStoppedError extends Error {
  readonly sessionId: string
  constructor(sessionId: string) {
    super(`运行 ${sessionId} 已经停掉了`)
    this.name = "AbortError"
    this.sessionId = sessionId
  }
}

/**
 * 登记一次 runSession：返回的 signal 在这次运行被停掉（状态变成已结束）后 abort。用完调 dispose（runSession 的 finally）。
 * 同一个进程里所有在跑的运行共用一次查询
 */
export function watchRunStop(db: Db, sessionId: string): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController()
  pollDb = db
  let set = watched.get(sessionId)
  if (!set) watched.set(sessionId, (set = new Set()))
  set.add(controller)
  schedule()
  return {
    signal: controller.signal,
    dispose: () => {
      const current = watched.get(sessionId)
      current?.delete(controller)
      if (current && current.size === 0) watched.delete(sessionId)
      if (watched.size === 0 && timer) {
        clearTimeout(timer)
        timer = undefined
      }
    },
  }
}
