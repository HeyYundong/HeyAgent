// 派活第二期的两个内置工具（开发说明 2.4、第 3 节）：
// - work.list「查派过的活」：派活方查自己任务派出去的单（选了「派活」自动带上）；
// - work.report「报结果」：被派来的运行把几个「名字 → 值」写回自己那张单，也能报「这件办不成」（被派来的运行自动带上）。
import {
  RUN_FINISH_TOOL_ID,
  WORK_REPORT_MAX_FIELDS,
  workItemStatusLabel,
  workReportLine,
  type builtinToolInputs,
  type WorkItemStatus,
  type WorkReportValue,
  type WorkResult,
} from "@heyagent/shared"
import { and, count, desc, eq, inArray, type SQL } from "drizzle-orm"
import type { z } from "zod"

import * as t from "../../db/schema.js"
import { toWorkItems } from "../../work/service.js"
import type { ToolContext, ToolOutcome } from "../tools/builtin.js"
import { describeItem } from "./dispatch.js"
import { appendLog, reportedIn } from "./settle.js"

const fail = (output: string): ToolOutcome => ({ output, isError: true })

// ---------- work.list ----------

type ListInput = z.infer<(typeof builtinToolInputs)["work.list"]>

/** 只能查这个任务派出去的单（from_task_id = 自己的任务），最新的在前，默认 20 张 */
export async function listFromAgent(ctx: ToolContext, input: ListInput): Promise<ToolOutcome> {
  const { db, session, snapshot } = ctx
  const limit = input.limit ?? 20
  const where: SQL[] = [eq(t.workItems.fromTaskId, snapshot.task.id)]
  if (input.thisRun) where.push(eq(t.workItems.fromSessionId, session.id))
  const ids = [...new Set((input.items ?? []).map((id) => id.trim()).filter(Boolean))]
  if (ids.length) where.push(inArray(t.workItems.id, ids))
  if (input.status === "open") where.push(inArray(t.workItems.status, ["queued", "running"] satisfies WorkItemStatus[]))
  else if (input.status) where.push(eq(t.workItems.status, input.status))
  const [rows, [total]] = await Promise.all([
    db
      .select()
      .from(t.workItems)
      .where(and(...where))
      .orderBy(desc(t.workItems.createdAt), desc(t.workItems.id))
      .limit(limit),
    db.select({ n: count() }).from(t.workItems).where(and(...where)),
  ])
  const items = await toWorkItems(db, rows)
  const lines: string[] = []
  const which = input.status === "open" ? "还没结束的" : input.status ? `「${workItemStatusLabel[input.status]}」的` : ""
  const scope = `${input.thisRun ? "这次运行" : "这个任务"}派出去的${which}`
  lines.push(items.length ? `${scope}单：共 ${total?.n ?? items.length} 张${(total?.n ?? 0) > items.length ? `，列出最新的 ${items.length} 张` : ""}。` : `${scope}单：一张都没有。`)
  for (const item of items) lines.push(`- ${item.id}「${item.title}」${describeItem(item)}${item.taskTitle ? `（派给「${item.taskTitle}」）` : ""}`)
  const missing = ids.filter((id) => !items.some((item) => item.id === id))
  if (missing.length && !input.status && !input.thisRun) lines.push(`- 没有找到：${missing.join("、")}（不存在，或者不是这个任务派的）`)
  const more = (total?.n ?? 0) - items.length
  if (more > 0) lines.push(`还有 ${more} 张没列出来，用 status / items 缩小范围。`)
  return { output: lines.join("\n") }
}

// ---------- work.report ----------

type ReportInput = z.infer<(typeof builtinToolInputs)["work.report"]>

/**
 * 写进 work_items.result.data：可以调多次，每次合并，同名字段以后一次为准；这次运行第一次报时，上一次运行（重办以前）报的清掉。
 * outcome = not_done：单上先记下「agent 判断办不成：原因」（failKind = not_done），运行结束时单记没办成、不重试；
 * outcome = done 撤回之前报的办不成。单还在办的时候就写进去，派活页能看到「已报：…」
 */
export async function reportFromAgent(ctx: ToolContext, input: ReportInput): Promise<ToolOutcome> {
  const { db, session, snapshot } = ctx
  const itemId = snapshot.dispatch?.itemId
  if (!itemId) return fail("这次运行不是被派来的，没有派活单可以报结果")
  const data: Record<string, WorkReportValue> = Object.fromEntries(Object.entries(input.data ?? {}).map(([name, value]) => [name.trim(), typeof value === "string" ? value.trim() : value] as const).filter(([name]) => name))
  if (!Object.keys(data).length && !input.outcome) return fail("data 和 outcome 至少给一个")
  const reason = input.reason?.trim()
  if (input.outcome === "not_done" && !reason) return fail("报「办不成」要写 reason：为什么办不成")

  return db.transaction(async (tx) => {
    const [item] = await tx.select().from(t.workItems).where(eq(t.workItems.id, itemId)).for("update")
    if (!item) return fail(`派活单 ${itemId} 不在了`)
    if (item.status !== "running" || item.sessionId !== session.id) return fail(`派活单 ${itemId} 已经不归这次运行了（可能被人点了不办了，或者已经结束），不用再报`)
    const first = !reportedIn(item.log, session.id)
    const merged = { ...(first ? {} : (item.result?.data ?? {})), ...data }
    if (Object.keys(merged).length > WORK_REPORT_MAX_FIELDS) return fail(`结果最多 ${WORK_REPORT_MAX_FIELDS} 个字段，这次合并以后有 ${Object.keys(merged).length} 个。把不要紧的去掉，或者合成一个字段`)
    // 这次运行第一次报：上一次运行（重办以前）的结果整个换掉，总结等运行结束时再写（在办时 summary 是空串）
    const result: WorkResult = first ? { summary: "", fileIds: [], data: merged } : { ...(item.result ?? { summary: "", fileIds: [] }), data: merged }
    const now = new Date()
    const outcome =
      input.outcome === "not_done"
        ? { failKind: "not_done" as const, error: `agent 判断办不成：${reason}`.slice(0, 2000) }
        : input.outcome === "done" && item.failKind === "not_done"
          ? { failKind: null, error: null }
          : {}
    await tx
      .update(t.workItems)
      .set({
        result,
        ...outcome,
        updatedAt: now,
        // 同一次运行只记第一次（可能报很多次）
        ...(first
          ? { log: appendLog({ at: now.toISOString(), kind: "reported", sessionId: session.id, note: (input.outcome === "not_done" ? `办不成：${reason}` : workReportLine(merged)).slice(0, 500) }) }
          : {}),
      })
      .where(eq(t.workItems.id, item.id))
    const line = workReportLine(merged)
    if (input.outcome === "not_done")
      return {
        output: snapshot.tools.some((tool) => tool.id === RUN_FINISH_TOOL_ID)
          ? `已记在派活单 ${item.id}：这件办不成（${reason}）${line ? `；结果 ${line}` : ""}。这次运行结束后单记「没办成」，不会自动重试。接着调用 run_finish 报没办成（reason 写为什么办不成、试过哪些办法）。`
          : `已记在派活单 ${item.id}：这件办不成（${reason}）${line ? `；结果 ${line}` : ""}。这次运行结束后单记「没办成」，不会自动重试。接着照常回复一段总结（为什么办不成、试过哪些办法），不要再调工具。`,
      }
    return { output: `已写到派活单 ${item.id}：${line || "（没有字段）"}${"failKind" in outcome && outcome.failKind === null ? "。之前报的「办不成」已撤回" : ""}。` }
  })
}
