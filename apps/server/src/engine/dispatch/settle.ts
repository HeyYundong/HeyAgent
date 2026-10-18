// 派活：被派的运行结束时，派活单跟着结束（办完 / 没办成），结果写回单上，再发 work.pump（空出名额）。
// 运行结束的 5 处（loop.ts 写「已完成」、failSession，control.ts 取消，humans.ts 上限「不继续」、验收争议判通过 / 失败）
// 都在自己的事务里调 settleWorkItemInTx；漏掉的由 work.sweep 补写（sweep.ts）。
// 第二期：运行出错（retryable）且这一轮的自动重试还没用完 → 单回到排队、到点再领（not_before）；
// agent 用 work.report 报了办不成 → 单记没办成（failKind = not_done），不重试；最终结束时发 work.notify 叫醒等结果的派活方。
import { WORK_RETRY_DELAY_DEFAULT, type WorkFailKind, type WorkLogEntry, type WorkResult } from "@heyagent/shared"
import { and, asc, desc, eq, sql } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { QUEUES, sendInTx, workPumpJobOptions, type Tx } from "../queue.js"
import { sendWorkDoneInTx } from "./notify.js"
import { sendPumpInTx } from "./signal.js"

export interface SettleOutcome {
  status: "done" | "failed"
  /** 办完：agent 最后那段总结；不给就从消息历史里取最后一条 assistant 的文字 */
  summary?: string
  /** 没办成：原因；不给就用运行上的 error */
  error?: string
  /**
   * 没办成时能不能自动重试（开发说明 4.2）：运行出错（模型、程序出错、验收判失败、运行记录丢了）= true；
   * 人取消、人选不继续、人判验收失败、规则让它失败 = false。不写当 false
   */
  retryable?: boolean
  /** 不重试时记成哪种没办成；不写：retryable 的记 error，其余记 cancelled_run */
  failKind?: WorkFailKind
}

/** 单这次怎么结束的（调用方决定发不发通知：还会重试的不发；最后一次没办成才发） */
export type SettleResult =
  | { kind: "done" }
  | { kind: "failed"; failKind: WorkFailKind; error: string; autoRetries: number }
  | { kind: "retry"; retry: number; retries: number; notBefore: Date; error: string }

type WorkItemRow = typeof t.workItems.$inferSelect

/** 往单的处理记录里追加几条（jsonb 拼接，不用先读） */
export const appendLog = (...entries: WorkLogEntry[]) => sql`${t.workItems.log} || ${JSON.stringify(entries)}::jsonb`

/** 这次运行用 work.report 报过结果（处理记录里有这次运行的 reported） */
export const reportedIn = (log: WorkLogEntry[], sessionId: string) => log.some((entry) => entry.kind === "reported" && entry.sessionId === sessionId)

/** 消息历史里最后一条 assistant 的文字（办完时的总结） */
async function lastAssistantText(tx: Tx, sessionId: string): Promise<string> {
  const rows = await tx
    .select({ content: t.sessionMessages.content })
    .from(t.sessionMessages)
    .where(and(eq(t.sessionMessages.sessionId, sessionId), eq(t.sessionMessages.role, "assistant")))
    .orderBy(desc(t.sessionMessages.seq))
    .limit(1)
  const content = (rows[0]?.content as { content?: unknown } | undefined)?.content
  if (typeof content === "string") return content
  if (Array.isArray(content))
    return content
      .filter((part): part is { type: "text"; text: string } => part?.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
  return ""
}

/**
 * 运行结束：带 work_item_id、单还是「在办」、单的 session_id 就是这次运行时，单改成办完 / 没办成 / 排队等重试。
 * 在调用方的事务里（和运行的最终状态一起提交）。不是被派的运行、单已经不归它（重办过、人点了不办了）时什么都不做，返回 null
 */
export async function settleWorkItemInTx(db: Db, tx: Tx, sessionId: string, outcome: SettleOutcome): Promise<SettleResult | null> {
  const [session] = await tx
    .select({ id: t.sessions.id, workItemId: t.sessions.workItemId, error: t.sessions.error, verification: t.sessions.verification })
    .from(t.sessions)
    .where(eq(t.sessions.id, sessionId))
  if (!session?.workItemId) return null
  const [item] = await tx.select().from(t.workItems).where(eq(t.workItems.id, session.workItemId)).for("update")
  if (!item || item.status !== "running" || item.sessionId !== sessionId) return null
  return writeSettled(db, tx, item, session, outcome)
}

/** 办完 / 办不成时写回单上的结果：总结、验收结论、产物、这次运行报的结构化结果 */
async function buildResult(tx: Tx, item: WorkItemRow, session: { id: string; verification: (typeof t.sessions.$inferSelect)["verification"] }, summary: string | undefined): Promise<WorkResult> {
  const text = (summary ?? (await lastAssistantText(tx, session.id))).trim().slice(0, 2000)
  const files = await tx
    .select({ id: t.files.id })
    .from(t.files)
    .where(and(eq(t.files.sessionId, session.id), eq(t.files.kind, "artifact")))
    .orderBy(asc(t.files.createdAt), asc(t.files.id))
  const verification = session.verification?.status === "passed" ? session.verification.headline : undefined
  // 上一次运行（重办以前）报的不算：这次运行报过才带上
  const data = reportedIn(item.log, session.id) ? item.result?.data : undefined
  return { summary: text, ...(verification ? { verification } : {}), fileIds: files.map((file) => file.id), ...(data && Object.keys(data).length ? { data } : {}) }
}

/** 写单的结束状态（settleWorkItemInTx 和清扫共用）。session 为 null = 运行记录没了 */
export async function writeSettled(
  db: Db,
  tx: Tx,
  item: WorkItemRow,
  session: { id: string; error: string | null; verification: (typeof t.sessions.$inferSelect)["verification"] } | null,
  outcome: SettleOutcome
): Promise<SettleResult> {
  const now = new Date()
  const ended: WorkLogEntry = { at: now.toISOString(), kind: "run_ended", ...(session ? { sessionId: session.id } : {}), note: "failed" }
  const finish = async (set: Partial<typeof t.workItems.$inferInsert>, entries: WorkLogEntry[]) => {
    await tx
      .update(t.workItems)
      .set({ ...set, updatedAt: now, log: appendLog(...entries) })
      .where(eq(t.workItems.id, item.id))
    await sendPumpInTx(db, tx, item.taskId)
  }

  // agent 用 work.report 报了办不成（这次运行里）：不管运行怎么结束的，单都记「没办成 · agent 判断办不成」，不重试
  const notDone = item.failKind === "not_done" && Boolean(session && reportedIn(item.log, session.id))
  if (notDone && session) {
    const error = item.error ?? "agent 判断办不成"
    const result = await buildResult(tx, item, session, outcome.status === "done" ? outcome.summary : undefined)
    await finish({ status: "failed", failKind: "not_done", result, error, notBefore: null, finishedAt: now }, [{ ...ended, note: "not_done" }])
    await sendWorkDoneInTx(db, tx, item.id)
    return { kind: "failed", failKind: "not_done", error, autoRetries: item.autoRetries }
  }

  if (outcome.status === "done" && session) {
    const result = await buildResult(tx, item, session, outcome.summary)
    await finish({ status: "done", result, error: null, failKind: null, notBefore: null, finishedAt: now }, [{ ...ended, note: "done" }])
    await sendWorkDoneInTx(db, tx, item.id)
    return { kind: "done" }
  }

  const error = (outcome.error ?? session?.error ?? "运行失败").slice(0, 2000)
  if (outcome.retryable) {
    // 没办成自动重试（开发说明第 4 节）：按库里现在的配置算（运行中途改了配置，下一次就按新的）
    const [task] = await tx.select({ dispatch: t.tasks.dispatch }).from(t.tasks).where(eq(t.tasks.id, item.taskId))
    const retries = task?.dispatch?.retries ?? 0
    if (item.autoRetries < retries) {
      const retry = item.autoRetries + 1
      const notBefore = new Date(now.getTime() + (task?.dispatch?.retryDelayMinutes ?? WORK_RETRY_DELAY_DEFAULT) * 60_000)
      await finish(
        { status: "queued", result: null, error, failKind: null, notBefore, autoRetries: retry, finishedAt: null },
        [ended, { at: now.toISOString(), kind: "retry_scheduled", retry, notBefore: notBefore.toISOString(), note: error }]
      )
      // 到点再领：发一个延迟的 work.pump。work.pump 是 stately（同一个 singletonKey 最多排一个），
      // 延迟的那个要用自己的 key，不然它排在那里时，别的即时 work.pump 会被合并掉；兜底还有每分钟的清扫（只看到点的）
      await sendInTx(db, tx, QUEUES.workPump, { taskId: item.taskId }, { ...workPumpJobOptions(item.taskId), singletonKey: `${item.taskId}@${notBefore.toISOString()}`, startAfter: notBefore })
      return { kind: "retry", retry, retries, notBefore, error }
    }
  }
  const failKind: WorkFailKind = outcome.failKind ?? (outcome.retryable ? "error" : "cancelled_run")
  await finish({ status: "failed", result: null, error, failKind, notBefore: null, finishedAt: now }, [ended])
  await sendWorkDoneInTx(db, tx, item.id)
  return { kind: "failed", failKind, error, autoRetries: item.autoRetries }
}
