// 派活：单最终结束（办完 / 没办成 / 不办了）时，叫醒等事件 work.done:<单号> 的运行（第二期，开发说明第 2 节）。
// 结束的那个事务里只发一个 work.notify（和单的结束一起提交）；worker 处理时按事件名找等待、resume。
// 不在结束的事务里直接 resume：resume 自己开事务、还要发 session.run。叫醒是幂等的（等待 resume 一次就变成 fired），多发没有副作用。
// 中间排队等自动重试的不算结束，不叫醒。
import { runOutcomeLabel, WORK_DONE_EVENT_PREFIX, workDoneEvent, workReportLine, type WorkItem, type WorkItemStatus } from "@heyagent/shared"
import { eq } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { toWorkItems } from "../../work/service.js"
import { bossFor, QUEUES, sendInTx, workNotifyJobOptions, type Tx } from "../queue.js"
import { resume, waitsForEvent } from "../waits.js"

/** 单最终结束的状态 */
export const isFinalWorkStatus = (status: WorkItemStatus) => status === "done" || status === "failed" || status === "cancelled"

/** 在单结束的事务里发：提交了 worker 才会去叫醒 */
export async function sendWorkDoneInTx(db: Db, tx: Tx, itemId: string) {
  await sendInTx(db, tx, QUEUES.workNotify, { itemId }, workNotifyJobOptions())
}

export async function sendWorkDone(db: Db, itemId: string) {
  const boss = await bossFor(db)
  await boss.send(QUEUES.workNotify, { itemId }, workNotifyJobOptions())
}

/** 事件名 work.done:W-57 → W-57；不是派活的事件返回 null */
export function itemIdOfEvent(event: string | null | undefined): string | null {
  if (!event?.startsWith(WORK_DONE_EVENT_PREFIX)) return null
  return event.slice(WORK_DONE_EVENT_PREFIX.length).trim() || null
}

const clip = (value: string, max: number) => {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** 叫醒时的事件数据（resume 消息里给 agent 看，也是 waitsForEvent 匹配用的数据） */
export function workDoneData(item: WorkItem) {
  return {
    item: item.id,
    status: item.status as "done" | "failed" | "cancelled",
    title: item.title,
    // 结果（run-outcome 6.2）：办完的也可能没核实，派活方自己判断要不要重派或者报给人
    ...(item.outcome ? { outcome: item.outcome } : {}),
    ...(item.outcomeReason ? { outcomeReason: item.outcomeReason.slice(0, 1000) } : {}),
    ...(item.result?.summary ? { summary: item.result.summary.slice(0, 2000) } : {}),
    ...(item.error && item.status !== "done" ? { error: item.error } : {}),
    ...(item.result?.data && Object.keys(item.result.data).length ? { report: item.result.data } : {}),
  }
}

/** 一句话：「W-57「标题」办完（办成）：总结… · 结果：件数=3」 */
export function workDoneText(item: WorkItem): string {
  const data = workReportLine(item.result?.data)
  const tail = data ? ` · 结果：${data}` : ""
  const outcome = item.outcome ? `（${runOutcomeLabel[item.outcome]}${item.outcome === "unverified" && item.outcomeReason ? `：${clip(item.outcomeReason, 200)}` : ""}）` : ""
  if (item.status === "done") return `${item.id}「${item.title}」办完${outcome}${item.result?.summary ? `：${clip(item.result.summary, 500)}` : ""}${tail}`
  if (item.status === "failed") return `${item.id}「${item.title}」没办成${item.outcome === "partial" ? "（部分办成）" : ""}${item.error ? `：${clip(item.error, 500)}` : ""}${tail}`
  if (item.status === "cancelled") return `${item.id}「${item.title}」不办了${item.error ? `：${clip(item.error, 500)}` : ""}`
  return `${item.id}「${item.title}」还没结束`
}

/** 给 agent 的那段话（叫醒的消息、session.wait 发现单已经结束时的返回，内容一样） */
export function workDoneMessage(item: WorkItem): string {
  return `${workDoneText(item)}\n事件数据：${JSON.stringify(workDoneData(item)).slice(0, 4000)}`
}

/** work.notify 的处理：单已经最终结束就叫醒等它的运行 */
export async function onWorkNotify(db: Db, data: { itemId: string }): Promise<{ resumed: string[] }> {
  const [row] = await db.select().from(t.workItems).where(eq(t.workItems.id, data.itemId))
  if (!row || !isFinalWorkStatus(row.status)) return { resumed: [] }
  const [item] = await toWorkItems(db, [row])
  const event = workDoneEvent(row.id)
  const resumed: string[] = []
  for (const wait of await waitsForEvent(db, event, workDoneData(item!))) {
    const sessionId = await resume(db, {
      waitId: wait.id,
      cause: "event",
      title: `等到了事件：${event}`,
      message: `等到了事件「${event}」（派活单结束）。之前在等：${wait.what}\n${workDoneMessage(item!)}`,
    })
    if (sessionId) resumed.push(sessionId)
  }
  return { resumed }
}

/**
 * 先结束、后挂起的窗口（开发说明 2.2）：session.wait 处理时单还没结束，挂起的事务提交之前它结束了，
 * 那次 work.notify 可能没看到这条等待。挂起提交以后再查一次：已经结束就自己补发一个 work.notify
 */
export async function recheckWorkDoneAfterSuspend(db: Db, event: string | null | undefined) {
  const itemId = itemIdOfEvent(event)
  if (!itemId) return
  const [row] = await db.select({ status: t.workItems.status }).from(t.workItems).where(eq(t.workItems.id, itemId))
  if (row && isFinalWorkStatus(row.status)) await sendWorkDone(db, itemId)
}
