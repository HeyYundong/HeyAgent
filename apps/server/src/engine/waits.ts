// 挂起和继续（方案 2.3.5）。
// - 挂起：同一个事务里改 session 状态、写 session_waits、排定时任务（叫醒 / 兜底提醒）；
// - 继续：到点、事件到了、人处理完、人点「立即继续」、待办触发，都走 resumeInTx。
//   入口用「status = 'waiting' 才改」的条件更新，谁先到谁生效，后到的什么都不做；
// - 兜底期限：到期只提醒负责人，不自动继续；
// - 继续时：追加一条「等到了什么」的消息，排进 session.run，同一个 session id 接着跑。
import { and, eq, isNull, lte, sql } from "drizzle-orm"
import { fmtDateTime } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { notifyUsers, sessionLink } from "./notify.js"
import { QUEUES, runJobOptions, sendInTx, type Tx } from "./queue.js"
import { appendEvent, appendMessage, writeAudit } from "./records.js"

export type WaitRow = typeof t.sessionWaits.$inferSelect
export type ResumeCause = "timer" | "event" | "human" | "resume_now" | "todo"

export interface SuspendInput {
  sessionId: string
  status: "waiting" | "needs_human"
  what: string
  triggerKind: "time" | "event" | "time_or_event"
  resumeAt?: Date | null
  event?: string | null
  match?: Record<string, unknown> | null
  fallbackDays?: number | null
  deadlineAt?: Date | null
  humanItemId?: string | null
}

/** 挂起（在调用方的事务里）。session 已经不是「执行中」（例如刚被取消）时返回 false，调用方应回滚或放弃 */
export async function suspendInTx(
  db: Db,
  tx: Tx,
  input: SuspendInput
): Promise<WaitRow | undefined> {
  const updated = await tx
    .update(t.sessions)
    .set({ status: input.status })
    .where(
      and(eq(t.sessions.id, input.sessionId), eq(t.sessions.status, "running"))
    )
    .returning({ id: t.sessions.id })
  if (updated.length === 0) return undefined
  const [wait] = await tx
    .insert(t.sessionWaits)
    .values({
      sessionId: input.sessionId,
      what: input.what,
      triggerKind: input.triggerKind,
      resumeAt: input.resumeAt ?? null,
      event: input.event ?? null,
      match: input.match ?? null,
      fallbackDays: input.fallbackDays ?? null,
      deadlineAt: input.deadlineAt ?? null,
      humanItemId: input.humanItemId ?? null,
    })
    .returning()
  if (input.resumeAt)
    await sendInTx(
      db,
      tx,
      QUEUES.wake,
      { sessionId: input.sessionId, waitId: wait!.id },
      { startAfter: input.resumeAt }
    )
  if (input.deadlineAt)
    await sendInTx(
      db,
      tx,
      QUEUES.remind,
      { waitId: wait!.id },
      { startAfter: input.deadlineAt }
    )
  const parts = [
    input.resumeAt ? `到点继续：${fmtDateTime(input.resumeAt)}` : null,
    input.event ? `等事件：${input.event}` : null,
    input.deadlineAt
      ? `兜底期限：${fmtDateTime(input.deadlineAt)}（到期只提醒负责人）`
      : null,
  ]
  await appendEvent(tx, input.sessionId, {
    kind: "wait",
    title: `挂起：${input.what}`,
    detail: parts.filter(Boolean).join("；") || null,
  })
  return wait
}

export interface ResumeInput {
  /** 指定哪条等待；不给就取这个 session 正在等的那条 */
  waitId?: number
  sessionId?: string
  cause: ResumeCause
  /** 给 agent 的消息：等到了什么 */
  message: string
  /** 过程里显示的一句话 */
  title: string
  actorId?: string | null
  /** 继续前再改点 session 的字段（例如人同意继续后调高花费上限） */
  sessionPatch?: Partial<typeof t.sessions.$inferInsert>
}

/** 继续（在调用方的事务里）。等待已经不在「等待中」（别人先到了）时返回 false */
export async function resumeInTx(
  db: Db,
  tx: Tx,
  input: ResumeInput
): Promise<string | false> {
  const condition =
    input.waitId !== undefined
      ? eq(t.sessionWaits.id, input.waitId)
      : eq(t.sessionWaits.sessionId, input.sessionId ?? "")
  const [wait] = await tx
    .update(t.sessionWaits)
    .set({ status: "fired", firedCause: input.cause, firedAt: new Date() })
    .where(and(condition, eq(t.sessionWaits.status, "waiting")))
    .returning()
  if (!wait) return false
  const updated = await tx
    .update(t.sessions)
    .set({ ...input.sessionPatch, status: "running" })
    .where(
      and(
        eq(t.sessions.id, wait.sessionId),
        sql`${t.sessions.status} in ('waiting', 'needs_human')`
      )
    )
    .returning({ id: t.sessions.id })
  if (updated.length === 0) return false
  await appendMessage(tx, wait.sessionId, {
    role: "user",
    content: `【继续】现在是 ${fmtDateTime(new Date())}（上海时间）。${input.message}`,
  })
  await appendEvent(tx, wait.sessionId, {
    kind: "resume",
    title: input.title,
    detail: input.message,
  })
  await sendInTx(
    db,
    tx,
    QUEUES.run,
    { sessionId: wait.sessionId },
    runJobOptions(wait.sessionId)
  )
  if (input.actorId)
    await writeAudit(tx, {
      actorId: input.actorId,
      action: `session.resume.${input.cause}`,
      targetTable: "sessions",
      targetId: wait.sessionId,
      detail: { waitId: wait.id },
    })
  return wait.sessionId
}

export async function resume(
  db: Db,
  input: ResumeInput
): Promise<string | false> {
  return db.transaction((tx) => resumeInTx(db, tx, input))
}

/** session.wake：到点了。等待已经被别的原因继续过，就什么都不做 */
export async function onWake(
  db: Db,
  data: { sessionId: string; waitId: number }
) {
  const [wait] = await db
    .select()
    .from(t.sessionWaits)
    .where(eq(t.sessionWaits.id, data.waitId))
  if (!wait || wait.status !== "waiting" || !wait.resumeAt) return false
  return resume(db, {
    waitId: wait.id,
    cause: "timer",
    title: "到点继续",
    message: `到点了（原定 ${fmtDateTime(wait.resumeAt)}，上海时间）。之前在等：${wait.what}`,
  })
}

/** session.remind：兜底期限到了，只提醒负责人，不继续 */
export async function onRemind(db: Db, data: { waitId: number }) {
  const now = new Date()
  const [wait] = await db
    .update(t.sessionWaits)
    .set({ remindedAt: now })
    .where(
      and(
        eq(t.sessionWaits.id, data.waitId),
        eq(t.sessionWaits.status, "waiting"),
        isNull(t.sessionWaits.remindedAt),
        lte(t.sessionWaits.deadlineAt, now)
      )
    )
    .returning()
  if (!wait) return false
  const [session] = await db
    .select({
      id: t.sessions.id,
      taskId: t.sessions.taskId,
      ownerId: t.tasks.ownerId,
      title: t.tasks.title,
    })
    .from(t.sessions)
    .innerJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))
    .where(eq(t.sessions.id, wait.sessionId))
  if (!session) return false
  const waited = wait.event ? `事件「${wait.event}」` : wait.what
  await appendEvent(db, session.id, {
    kind: "wait",
    title: "兜底期限到了，已提醒负责人",
    detail: `还没等到${waited}。session 继续挂起，负责人可以点「立即继续」或取消。`,
  })
  await notifyUsers(db, {
    userIds: [session.ownerId],
    title: `${session.title}：等了很久还没等到`,
    body: `运行 ${session.id} 在等${waited}，已经到了兜底期限。可以去看看要不要立即继续或取消。`,
    link: sessionLink(session.taskId, session.id),
    taskId: session.taskId,
    sessionId: session.id,
  })
  return true
}

/** 按事件名找等待中的 session：事件名完全相同，并且（如果等待写了匹配条件）事件数据包含这些字段 */
export async function waitsForEvent(
  db: Db,
  event: string,
  data: Record<string, unknown>
) {
  return db
    .select()
    .from(t.sessionWaits)
    .where(
      and(
        eq(t.sessionWaits.status, "waiting"),
        eq(t.sessionWaits.event, event),
        isNull(t.sessionWaits.humanItemId),
        sql`(${t.sessionWaits.match} is null or ${JSON.stringify(data)}::jsonb @> ${t.sessionWaits.match})`
      )
    )
}
