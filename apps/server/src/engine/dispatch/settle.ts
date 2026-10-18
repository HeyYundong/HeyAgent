// 派活：被派的运行结束时，派活单跟着结束（办完 / 没办成），结果写回单上，再发 work.pump（空出名额）。
// 运行结束的 5 处（loop.ts 写「已完成」、failSession，control.ts 取消，humans.ts 上限「不继续」、验收争议判通过 / 失败）
// 都在自己的事务里调 settleWorkItemInTx；漏掉的由 work.sweep 补写（sweep.ts）。
import type { WorkLogEntry, WorkResult } from "@heyagent/shared"
import { and, asc, desc, eq, sql } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import type { Tx } from "../queue.js"
import { sendPumpInTx } from "./signal.js"

export interface SettleOutcome {
  status: "done" | "failed"
  /** 办完：agent 最后那段总结；不给就从消息历史里取最后一条 assistant 的文字 */
  summary?: string
  /** 没办成：原因；不给就用运行上的 error */
  error?: string
}

type WorkItemRow = typeof t.workItems.$inferSelect

/** 往单的处理记录里追加一条（jsonb 拼接，不用先读） */
export const appendLog = (entry: WorkLogEntry) => sql`${t.workItems.log} || ${JSON.stringify([entry])}::jsonb`

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
 * 运行结束：带 work_item_id、单还是「在办」、单的 session_id 就是这次运行时，单改成办完 / 没办成。
 * 在调用方的事务里（和运行的最终状态一起提交）。不是被派的运行、单已经不归它（重办过、人点了不办了）时什么都不做，返回 false
 */
export async function settleWorkItemInTx(db: Db, tx: Tx, sessionId: string, outcome: SettleOutcome): Promise<boolean> {
  const [session] = await tx
    .select({ id: t.sessions.id, workItemId: t.sessions.workItemId, error: t.sessions.error, verification: t.sessions.verification })
    .from(t.sessions)
    .where(eq(t.sessions.id, sessionId))
  if (!session?.workItemId) return false
  const [item] = await tx.select().from(t.workItems).where(eq(t.workItems.id, session.workItemId)).for("update")
  if (!item || item.status !== "running" || item.sessionId !== sessionId) return false
  await writeSettled(db, tx, item, session, outcome)
  return true
}

/** 写单的结束状态（settleWorkItemInTx 和清扫共用）。session 为 null = 运行记录没了 */
export async function writeSettled(
  db: Db,
  tx: Tx,
  item: WorkItemRow,
  session: { id: string; error: string | null; verification: (typeof t.sessions.$inferSelect)["verification"] } | null,
  outcome: SettleOutcome
) {
  const now = new Date()
  let result: WorkResult | null = null
  let error: string | null = null
  if (outcome.status === "done" && session) {
    const summary = (outcome.summary ?? (await lastAssistantText(tx, session.id))).trim().slice(0, 2000)
    const files = await tx
      .select({ id: t.files.id })
      .from(t.files)
      .where(and(eq(t.files.sessionId, session.id), eq(t.files.kind, "artifact")))
      .orderBy(asc(t.files.createdAt), asc(t.files.id))
    const verification = session.verification?.status === "passed" ? session.verification.headline : undefined
    result = { summary, ...(verification ? { verification } : {}), fileIds: files.map((file) => file.id) }
  } else {
    error = (outcome.error ?? session?.error ?? "运行失败").slice(0, 2000)
  }
  await tx
    .update(t.workItems)
    .set({
      status: outcome.status === "done" && session ? "done" : "failed",
      result,
      error,
      finishedAt: now,
      updatedAt: now,
      log: appendLog({ at: now.toISOString(), kind: "run_ended", ...(session ? { sessionId: session.id } : {}), note: result ? "done" : "failed" }),
    })
    .where(eq(t.workItems.id, item.id))
  await sendPumpInTx(db, tx, item.taskId)
}
