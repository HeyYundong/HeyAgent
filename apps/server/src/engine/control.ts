// 人对 session 的操作：取消、立即继续；外部事件（webhook 或控制台手动触发）。
import { and, eq, inArray, notInArray } from "drizzle-orm"
import { ENDED_RUN_STATUSES, isRunEnded, runOutcomeLabel, type FireEventResult, type SetOutcomeInput } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { settleWorkItemInTx } from "./dispatch/settle.js"
import { failedOutcome } from "./outcome.js"
import type { Tx } from "./queue.js"
import { appendEvent, writeAudit } from "./records.js"
import { fireTodo, todosForEvent } from "./schedule.js"
import { EngineError } from "./sessions.js"
import { resume, waitsForEvent } from "./waits.js"

export interface CancelSessionInput {
  sessionId: string
  actorId: string
  actorName: string
  reason?: string
}

/** 取消：标「失败」并写清原因（已经结束的：已完成、没完成、失败，不能取消）；等待作废，没处理的事一并取消。正在跑的循环在下一步之前发现状态变了就停 */
export async function cancelSessionImpl(db: Db, input: CancelSessionInput) {
  return db.transaction((tx) => cancelSessionInTx(db, tx, input))
}

/** 取消（在调用方的事务里）：派活页「不办了」要和派活单一起改 */
export async function cancelSessionInTx(db: Db, tx: Tx, input: CancelSessionInput) {
  const reason = `${input.actorName}取消了这次运行${input.reason ? `：${input.reason}` : ""}`
  const updated = await tx
    .update(t.sessions)
    // 取消的运行：状态照旧记失败，结果记没办成（run-outcome 2.2）；人取消的记 human（清扫补写派活单时据此不重试）
    .set({ status: "failed", endedAt: new Date(), error: reason, ...failedOutcome(reason, "human") })
    .where(
      and(
        eq(t.sessions.id, input.sessionId),
        notInArray(t.sessions.status, [...ENDED_RUN_STATUSES])
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
  // 被派的运行：派活单跟着记「没办成」，人取消的不自动重试（人在派活页点「不办了」时单已经先改成不办了，这里不动它）
  await settleWorkItemInTx(db, tx, input.sessionId, { status: "failed", error: reason, retryable: false, failKind: "cancelled_run" })
  return { sessionId: input.sessionId }
}

/**
 * 人改结果（run-outcome 第 8 节）：只改结果列，不重开运行；已经结束的运行（已结束、出错、取消的都行）都能改成办成或没办成。记过程记录（human）和审计。
 * 复核还在跑时改了的，复核回来不再覆盖（loop.ts 的 reviewAfterFinish）。
 * 被派的单：还是这次运行的单、已经结束的，跟着改结果，不改单的状态。权限（负责人、主管）由接口查
 */
export async function setOutcomeImpl(db: Db, input: SetOutcomeInput & { actorId: string; actorName: string }) {
  return db.transaction(async (tx) => {
    const [session] = await tx
      .select({ id: t.sessions.id, status: t.sessions.status, outcome: t.sessions.outcome, workItemId: t.sessions.workItemId })
      .from(t.sessions)
      .where(eq(t.sessions.id, input.id))
      .for("update")
    if (!session) throw new EngineError("NOT_FOUND", `找不到运行 ${input.id}`)
    if (!isRunEnded(session.status)) throw new EngineError("BAD_REQUEST", "这次运行还没结束，结束以后才能改结果")
    const reason = input.reason.trim()
    await tx
      .update(t.sessions)
      .set({ outcome: input.outcome, outcomeReason: reason, outcomeBy: "human" })
      .where(eq(t.sessions.id, session.id))
    await appendEvent(tx, session.id, {
      kind: "human",
      title: `${input.actorName}把结果改成「${runOutcomeLabel[input.outcome]}」`,
      detail: `理由：${reason}${session.outcome ? `\n原来是「${runOutcomeLabel[session.outcome]}」` : ""}`,
    })
    await writeAudit(tx, {
      actorId: input.actorId,
      action: "session.set_outcome",
      targetTable: "sessions",
      targetId: session.id,
      detail: { from: session.outcome, to: input.outcome, reason },
    })
    if (session.workItemId)
      await tx
        .update(t.workItems)
        .set({ outcome: input.outcome, outcomeReason: reason, updatedAt: new Date() })
        .where(and(eq(t.workItems.id, session.workItemId), eq(t.workItems.sessionId, session.id), inArray(t.workItems.status, ["done", "failed"])))
    return { sessionId: session.id, outcome: input.outcome }
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
        ? "这次运行在等人处理，先处理那件事（在会话页打开这次运行，最上面就是）"
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
