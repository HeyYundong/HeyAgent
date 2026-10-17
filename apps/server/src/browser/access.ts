// API 这一侧：找带 Chrome 的 worker、调它的内部控制接口、判断谁能在远程画面里操作。
import { and, eq, gt } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import type { Keyring } from "../lib/crypto.js"
import { INTERNAL_HEADER, internalToken } from "./token.js"

/** worker 心跳在这个时间内的才算在线 */
const WORKER_FRESH_MS = 60_000

export type InstanceRow = typeof t.browserInstances.$inferSelect

export async function instanceRow(db: Db, browserId: string): Promise<InstanceRow | undefined> {
  const [row] = await db.select().from(t.browserInstances).where(eq(t.browserInstances.id, browserId))
  return row
}

export async function workerUrl(db: Db, workerId: string): Promise<string | undefined> {
  const [row] = await db.select({ url: t.browserWorkers.controlUrl }).from(t.browserWorkers).where(eq(t.browserWorkers.id, workerId))
  return row?.url
}

/** 在线的、开着的 Chrome 最少的 worker（「打开 Chrome 登录」用） */
export async function pickWorker(db: Db): Promise<{ id: string; controlUrl: string } | undefined> {
  const workers = await db
    .select({ id: t.browserWorkers.id, controlUrl: t.browserWorkers.controlUrl })
    .from(t.browserWorkers)
    .where(gt(t.browserWorkers.heartbeatAt, new Date(Date.now() - WORKER_FRESH_MS)))
  if (!workers.length) return undefined
  const counts = await db.select({ workerId: t.browserInstances.workerId }).from(t.browserInstances)
  const load = (id: string) => counts.filter((row) => row.workerId === id).length
  return workers.sort((a, b) => load(a.id) - load(b.id))[0]
}

export class WorkerCallError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

/** 调 worker 的内部控制接口（带令牌头） */
export async function callWorker<T>(keyring: Keyring, controlUrl: string, path: string, body?: unknown): Promise<T> {
  let res: Response
  try {
    res = await fetch(`${controlUrl}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { [INTERNAL_HEADER]: internalToken(keyring), ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
  } catch (error) {
    throw new WorkerCallError(503, `连不上带 Chrome 的 worker：${(error as Error).message}`)
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new WorkerCallError(res.status, data.error ?? `worker 返回 ${res.status}`)
  return data
}

/**
 * 谁能在远程画面里操作（鼠标、键盘、导航）：主管；session 的 Chrome 是任务负责人、被分配处理这次运行里某件事的人；
 * 「打开 Chrome 登录」的 Chrome 是打开它的人。其他人只能看。
 */
export async function canControlBrowser(db: Db, user: { id: string; isAdmin: boolean }, row: Pick<InstanceRow, "kind" | "sessionId" | "openedById">): Promise<boolean> {
  if (user.isAdmin) return true
  if (row.kind === "login") return row.openedById === user.id
  if (!row.sessionId) return false
  return canControlSession(db, user, row.sessionId)
}

export async function canControlSession(db: Db, user: { id: string; isAdmin: boolean }, sessionId: string): Promise<boolean> {
  if (user.isAdmin) return true
  const [owner] = await db
    .select({ ownerId: t.tasks.ownerId })
    .from(t.sessions)
    .innerJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))
    .where(eq(t.sessions.id, sessionId))
  if (owner?.ownerId === user.id) return true
  const [assigned] = await db
    .select({ id: t.humanItems.id })
    .from(t.humanItems)
    .where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.assigneeId, user.id), eq(t.humanItems.status, "open")))
  return Boolean(assigned)
}
