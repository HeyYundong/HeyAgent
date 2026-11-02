// 挂起和继续（方案 2.3.5）。
// - 挂起：同一个事务里改 session 状态、写 session_waits、排定时任务（叫醒 / 兜底提醒）；
// - 继续：到点、事件到了、人处理完、人点「立即继续」、待办触发，都走 resumeInTx。
//   入口用「status = 'waiting' 才改」的条件更新，谁先到谁生效，后到的什么都不做；
// - 兜底期限：到期只提醒负责人，不自动继续；
// - 继续时：追加一条「等到了什么」的消息，排进 session.run，同一个 session id 接着跑；
// - 被派的运行要名额（2026-11-02）：从不占名额的等待（agent 自己挂起、等人处理）醒来时，任务的名额满了就不进「执行中」，
//   改成挂起等 work.slot:<任务>（等名额），原来的继续（消息、标题）存在这条等待的 match.slot 上；
//   work.pump 有空位时先放行它们（releaseSlotWaitersInTx，最早等的先），再领新单；「立即继续」不看名额。
import { and, asc, eq, inArray, isNull, lte, sql } from "drizzle-orm"
import {
  fmtDateTime,
  holdsDispatchSlot,
  holdsSubagentSlot,
  isSubagentQueueEvent,
  isWorkSlotEvent,
  workSlotEvent,
  workSlotWhat,
} from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { notifyUsers, sessionLink } from "./notify.js"
import { sendPumpInTx } from "./dispatch/signal.js"
import { sendSubagentPumpInTx } from "./subagents/signal.js"
import { QUEUES, runJobOptions, sendInTx, type Tx } from "./queue.js"
import { appendEvent, appendMessage, writeAudit } from "./records.js"
import { lockTaskInTx, occupiedSlots, slotWaitingCount } from "../work/service.js"

export type WaitRow = typeof t.sessionWaits.$inferSelect
/** slot：等名额的运行被 work.pump 放行（2026-11-02） */
export type ResumeCause = "timer" | "event" | "human" | "resume_now" | "todo" | "slot"

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
  /** M3：等审批的工具调用 */
  pending?: t.PendingToolCalls | null
  /** session 现在应该是什么状态才能挂起（默认只认「执行中」；验收争议是「验收中」） */
  fromStatuses?: ("running" | "verifying")[]
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
      and(
        eq(t.sessions.id, input.sessionId),
        inArray(t.sessions.status, input.fromStatuses ?? ["running"])
      )
    )
    .returning({ id: t.sessions.id, taskId: t.sessions.taskId, workItemId: t.sessions.workItemId, kind: t.sessions.kind })
  if (updated.length === 0) return undefined
  // 被派的运行挂起：agent 自己挂起、等人处理不占名额，空出位子给排队的单；等浏览器、等桌面、等子 agent 的照样占名额，不发
  // （docs/dev/sub-agents.md 第 12 节第 4 条：shared 的 holdsDispatchSlot，和 work/service.ts 的 occupiesSlotSql 同一份前缀）
  if (updated[0]!.workItemId && !holdsDispatchSlot(input.event))
    await sendPumpInTx(db, tx, updated[0]!.taskId)
  // 子运行挂起等人处理（验证码、登录、审批）不占子 agent 名额：空出来放行排队的（6.2）；排队本身、等浏览器 / 桌面的不发
  if (updated[0]!.kind === "sub" && !holdsSubagentSlot(input.event) && !isSubagentQueueEvent(input.event))
    await sendSubagentPumpInTx(db, tx)
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
      pending: input.pending ?? null,
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
  /** 给 agent 的消息：等到了什么。空字符串 = 不加消息（审批工具调用：结果由引擎继续时作为工具结果写） */
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
  // 原来等的是名额：之前那次继续的消息（人处理了什么、等到了什么）这次一起交给 agent。
  // 原来的消息是空的（审批工具调用，结果由引擎作为工具结果写）就一直不加消息：工具调用和结果之间不能插一条用户消息
  const slot = slotResumeOf(wait)
  const message = slot ? (slot.message ? [slot.message, input.message].filter(Boolean).join("\n") : "") : input.message
  // 被派的运行从不占名额的等待里醒来：名额满了就去等名额
  const full = await slotFullInTx(tx, wait, input.cause)
  if (full) return toSlotWaitInTx(db, tx, wait, { ...input, message }, full)
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
  if (message)
    await appendMessage(tx, wait.sessionId, {
      role: "user",
      content: `【继续】现在是 ${fmtDateTime(new Date())}（上海时间）。${message}`,
    })
  await appendEvent(tx, wait.sessionId, {
    kind: "resume",
    title: input.title,
    detail: message || null,
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

/** 等名额的等待上存的「原来那次继续」（match.slot） */
export interface SlotResume {
  cause: ResumeCause
  title: string
  message: string
}

/** 这条等待是等名额的，取出原来那次继续；不是（或者没存，按普通等待算）返回 undefined */
export function slotResumeOf(wait: Pick<WaitRow, "event" | "match">): SlotResume | undefined {
  if (!isWorkSlotEvent(wait.event)) return undefined
  return (wait.match as { slot?: SlotResume } | null)?.slot
}

/**
 * 这次继续要不要等名额：被派的运行（work_item_id 不空），原来的等待不占名额（不是等浏览器、桌面、子 agent），
 * 任务开着被派活、名额（减去已经在等名额的）没有空位。要等时返回任务和名额；不用等返回 undefined。
 * 不用等的：work.pump 放行（cause = slot，它已经数过）、人在等名额的运行上点了「立即继续」（插队）。
 * 数名额前拿任务的领单锁（和 pumpTask、现在就办同一把），并发的继续、领单不会一起超
 */
async function slotFullInTx(tx: Tx, wait: WaitRow, cause: ResumeCause): Promise<{ taskId: string; maxRunning: number; room: number } | undefined> {
  if (cause === "slot" || holdsDispatchSlot(wait.event)) return undefined
  if (cause === "resume_now" && isWorkSlotEvent(wait.event)) return undefined
  const [session] = await tx
    .select({ taskId: t.sessions.taskId, workItemId: t.sessions.workItemId })
    .from(t.sessions)
    .where(eq(t.sessions.id, wait.sessionId))
  if (!session?.workItemId) return undefined
  await lockTaskInTx(tx, "pump", session.taskId)
  const [task] = await tx.select({ dispatch: t.tasks.dispatch }).from(t.tasks).where(eq(t.tasks.id, session.taskId))
  // 关了被派活：没有名额可数，直接继续
  if (!task?.dispatch) return undefined
  const room = task.dispatch.maxRunning - (await occupiedSlots(tx, session.taskId))
  // 已经有人在等名额：排在它们后面（空出来的位子先给它们）
  const ahead = await slotWaitingCount(tx, session.taskId)
  if (room - ahead > 0) return undefined
  return { taskId: session.taskId, maxRunning: task.dispatch.maxRunning, room }
}

/** 名额满了：session 改成挂起等名额（不进执行中、不发 session.run），原来那次继续存在新等待上，放行时交给 agent */
async function toSlotWaitInTx(
  db: Db,
  tx: Tx,
  wait: WaitRow,
  input: ResumeInput,
  full: { taskId: string; maxRunning: number; room: number }
): Promise<string | false> {
  const updated = await tx
    .update(t.sessions)
    .set({ ...input.sessionPatch, status: "waiting" })
    .where(and(eq(t.sessions.id, wait.sessionId), sql`${t.sessions.status} in ('waiting', 'needs_human')`))
    .returning({ id: t.sessions.id })
  if (updated.length === 0) return false
  const slot: SlotResume = { cause: input.cause, title: input.title, message: input.message }
  await tx.insert(t.sessionWaits).values({
    sessionId: wait.sessionId,
    what: workSlotWhat(full.maxRunning),
    triggerKind: "event",
    event: workSlotEvent(full.taskId),
    match: { slot },
  })
  await appendEvent(tx, wait.sessionId, {
    kind: "wait",
    title: `${input.title}；名额满了，先等名额`,
    detail: `任务同时最多 ${full.maxRunning} 个在跑，现在满了。空出来自动继续（比排队的新单先放行），不想等可以点「立即继续」。${input.message ? `\n继续时交给 agent：${input.message}` : ""}`,
  })
  // 有空位、只是前面还有人在等：叫 work.pump 放行（它按先后放）
  if (full.room > 0) await sendPumpInTx(db, tx, full.taskId)
  if (input.actorId)
    await writeAudit(tx, {
      actorId: input.actorId,
      action: `session.resume.${input.cause}`,
      targetTable: "sessions",
      targetId: wait.sessionId,
      detail: { waitId: wait.id, slotWait: true },
    })
  return wait.sessionId
}

/**
 * 放行等名额的运行（pumpTask 在任务的领单锁里调）：最早开始等的先，最多 limit 个（Infinity = 全部：关了被派活的任务没有名额）。
 * 返回放行的运行编号
 */
export async function releaseSlotWaitersInTx(db: Db, tx: Tx, taskId: string, limit: number): Promise<string[]> {
  if (limit <= 0) return []
  const query = tx
    .select({ id: t.sessionWaits.id })
    .from(t.sessionWaits)
    .where(and(eq(t.sessionWaits.status, "waiting"), eq(t.sessionWaits.event, workSlotEvent(taskId))))
    .orderBy(asc(t.sessionWaits.createdAt), asc(t.sessionWaits.id))
  const rows = Number.isFinite(limit) ? await query.limit(limit) : await query
  const released: string[] = []
  for (const row of rows) {
    const resumed = await resumeInTx(db, tx, {
      waitId: row.id,
      cause: "slot",
      title: "名额空出来了，接着做",
      message: "（刚才这个任务同时在跑的满了，等名额等到现在。）",
    })
    if (resumed) released.push(resumed)
  }
  return released
}

/** 这次运行现在是不是在等名额（继续以后给页面说「已处理、等名额」用） */
export async function isSlotWaitingInTx(tx: Db | Tx, sessionId: string): Promise<boolean> {
  const [wait] = await tx
    .select({ event: t.sessionWaits.event })
    .from(t.sessionWaits)
    .where(and(eq(t.sessionWaits.sessionId, sessionId), eq(t.sessionWaits.status, "waiting")))
  return isWorkSlotEvent(wait?.event)
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
