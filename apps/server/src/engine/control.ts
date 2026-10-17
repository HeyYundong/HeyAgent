// 人对 session 的操作：取消、立即继续；外部事件（webhook 或控制台手动触发）。
import { and, eq, notInArray } from "drizzle-orm"
import type { FireEventResult } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { appendEvent, writeAudit } from "./records.js"
import { fireTodo, todosForEvent } from "./schedule.js"
import { EngineError } from "./sessions.js"
import { resume, waitsForEvent } from "./waits.js"

/** 取消：标「失败」并写清原因；等待作废，没处理的事一并取消。正在跑的循环在下一步之前发现状态变了就停 */
export async function cancelSessionImpl(
  db: Db,
  input: {
    sessionId: string
    actorId: string
    actorName: string
    reason?: string
  }
) {
  return db.transaction(async (tx) => {
    const reason = `${input.actorName}取消了这次运行${input.reason ? `：${input.reason}` : ""}`
    const updated = await tx
      .update(t.sessions)
      .set({ status: "failed", endedAt: new Date(), error: reason })
      .where(
        and(
          eq(t.sessions.id, input.sessionId),
          notInArray(t.sessions.status, ["done", "failed"])
        )
      )
      .returning({ id: t.sessions.id })
    if (updated.length === 0)
      throw new EngineError("CONFLICT", "这次运行已经结束了")
    await tx
      .update(t.sessionWaits)
      .set({ status: "cancelled", firedCause: "cancel", firedAt: new Date() })
      .where(
        and(
          eq(t.sessionWaits.sessionId, input.sessionId),
          eq(t.sessionWaits.status, "waiting")
        )
      )
    await tx
      .update(t.humanItems)
      .set({
        status: "cancelled",
        resolvedById: input.actorId,
        resolvedAt: new Date(),
        resolution: { how: "cancelled", note: reason },
      })
      .where(
        and(
          eq(t.humanItems.sessionId, input.sessionId),
          eq(t.humanItems.status, "open")
        )
      )
    await appendEvent(tx, input.sessionId, {
      kind: "error",
      title: "已取消",
      detail: reason,
    })
    await writeAudit(tx, {
      actorId: input.actorId,
      action: "session.cancel",
      targetTable: "sessions",
      targetId: input.sessionId,
      detail: { reason: input.reason },
    })
    return { sessionId: input.sessionId }
  })
}

/** 立即继续：只对挂起等待中的 session（等人处理的要先处理那件事） */
export async function resumeNowImpl(
  db: Db,
  input: { sessionId: string; actorId: string; actorName: string }
) {
  const [session] = await db
    .select({ status: t.sessions.status })
    .from(t.sessions)
    .where(eq(t.sessions.id, input.sessionId))
  if (!session)
    throw new EngineError("NOT_FOUND", `找不到 session ${input.sessionId}`)
  if (session.status !== "waiting")
    throw new EngineError(
      "BAD_REQUEST",
      session.status === "needs_human"
        ? "这次运行在等人处理，先去待办里处理那件事"
        : "这次运行没有在等待"
    )
  const resumed = await resume(db, {
    sessionId: input.sessionId,
    cause: "resume_now",
    title: `${input.actorName}点了立即继续`,
    message: `${input.actorName}让你立即继续（原来等的事可能还没到，请根据现状决定下一步）。`,
    actorId: input.actorId,
  })
  if (!resumed) throw new EngineError("CONFLICT", "这次运行刚刚已经继续了")
  return { sessionId: input.sessionId }
}

/** 事件：按事件名匹配等待中的 session（继续）和待办（触发） */
export async function fireEventImpl(
  db: Db,
  input: {
    event: string
    data?: Record<string, unknown>
    actorId?: string | null
    via: "webhook" | "console"
  }
): Promise<FireEventResult> {
  const data = input.data ?? {}
  const result: FireEventResult = { resumedSessionIds: [], firedTodoIds: [] }
  const payload = Object.keys(data).length
    ? `\n事件数据：${JSON.stringify(data).slice(0, 4000)}`
    : ""
  for (const wait of await waitsForEvent(db, input.event, data)) {
    const resumed = await resume(db, {
      waitId: wait.id,
      cause: "event",
      title: `等到了事件：${input.event}`,
      message: `等到了事件「${input.event}」（${input.via === "webhook" ? "外部系统发来" : "控制台手动触发"}）。之前在等：${wait.what}${payload}`,
      actorId: input.actorId,
    })
    if (resumed) result.resumedSessionIds.push(resumed)
  }
  for (const todo of await todosForEvent(db, input.event)) {
    const fired = await fireTodo(db, todo.id, "event").catch((error) => {
      console.warn(
        `[engine] 待办 ${todo.id} 触发失败：${(error as Error).message}`
      )
      return null
    })
    if (fired) result.firedTodoIds.push(todo.id)
  }
  await writeAudit(db, {
    actorId: input.actorId ?? null,
    action: "event.fire",
    targetTable: "events",
    targetId: input.event,
    detail: { via: input.via, ...result },
  })
  return result
}
