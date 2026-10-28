// 子 agent：运行结束时要做的事、停掉子运行、父 + 子的合计花费（docs/dev/sub-agents.md 6.4、7.4、第 8 节）。
// 都在调用方的事务里；由 engine/run-ended.ts 的 afterRunEndedInTx 统一调（运行结束的 6 个调用），漏掉的由 sweep.ts 兜底。
import { ENDED_RUN_STATUSES, type SubResult } from "@heyagent/shared"
import { and, eq, notInArray, sql } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { failedOutcome } from "../outcome.js"
import type { Tx } from "../queue.js"
import { appendEvent, writeAudit, type DbLike } from "../records.js"
import { sendSubagentNotifyInTx, sendSubagentPumpInTx } from "./signal.js"

/** 子运行结束（7.4 第 2 步）：是子运行（kind = sub）→ 发 subagent.notify（父）和 subagent.pump；不是就什么都不做 */
export async function settleSubRunInTx(db: Db, tx: Tx, sessionId: string): Promise<void> {
  const [row] = await tx.select({ kind: t.sessions.kind, parentSessionId: t.sessions.parentSessionId }).from(t.sessions).where(eq(t.sessions.id, sessionId))
  if (row?.kind !== "sub" || !row.parentSessionId) return
  await sendSubagentNotifyInTx(db, tx, row.parentSessionId)
  await sendSubagentPumpInTx(db, tx)
}

/** 父运行还没结束的子运行（kind = sub：被派的运行也写了 parent_session_id，一律带上 kind） */
export async function openChildrenOf(db: DbLike, parentSessionId: string): Promise<string[]> {
  const rows = await db
    .select({ id: t.sessions.id })
    .from(t.sessions)
    .where(and(eq(t.sessions.parentSessionId, parentSessionId), eq(t.sessions.kind, "sub"), notInArray(t.sessions.status, [...ENDED_RUN_STATUSES])))
    .orderBy(t.sessions.startedAt, t.sessions.id)
  return rows.map((row) => row.id)
}

/**
 * 父运行结束（7.4 第 3 步、第 8 节）：还有没结束的子运行就全部停掉，原因「父运行 <编号> 已经结束（取消 / 出错），跟着停了」；
 * 排队的直接取消。返回停掉的子运行编号。不是父运行（没有子运行）就返回空
 */
export async function stopChildrenInTx(db: Db, tx: Tx, parentSessionId: string, reason: string): Promise<string[]> {
  const stopped: string[] = []
  for (const id of await openChildrenOf(tx, parentSessionId)) if (await stopSubRunInTx(db, tx, id, reason)) stopped.push(id)
  return stopped
}

/**
 * 停掉一个子运行（subagent.cancel、stopChildrenInTx、放行时父运行已经结束的共用）：复用 control.ts 取消的写法
 * （状态出错、结果没办成、作废等待、取消要人办的事、写过程），但不用人的身份：outcome_by = rule，原因写清谁停的、为什么；审计记系统。
 * 已经结束的（或者不是子运行）返回 false。正在跑的子运行在下一个工具调用之前发现状态变了就停（loop.ts 现在就这样），Chrome 跟着关。
 * 结束了照样发 subagent.notify / subagent.pump（settleSubRunInTx）：名额空出来，等它的父运行可能该醒了
 */
export async function stopSubRunInTx(db: Db, tx: Tx, sessionId: string, reason: string): Promise<boolean> {
  const now = new Date()
  const text = reason.slice(0, 2000)
  const updated = await tx
    .update(t.sessions)
    .set({ status: "failed", endedAt: now, error: text, ...failedOutcome(text, "rule") })
    .where(and(eq(t.sessions.id, sessionId), eq(t.sessions.kind, "sub"), notInArray(t.sessions.status, [...ENDED_RUN_STATUSES])))
    .returning({ id: t.sessions.id })
  if (updated.length === 0) return false
  await tx
    .update(t.sessionWaits)
    .set({ status: "cancelled", firedCause: "cancel", firedAt: now })
    .where(and(eq(t.sessionWaits.sessionId, sessionId), eq(t.sessionWaits.status, "waiting")))
  await tx
    .update(t.humanItems)
    .set({ status: "cancelled", resolvedById: null, resolvedAt: now, resolution: { how: "cancelled", note: text } })
    .where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open")))
  await appendEvent(tx, sessionId, { kind: "error", title: "已停掉", detail: text })
  await writeAudit(tx, { actorId: null, action: "session.subagent.stop", targetTable: "sessions", targetId: sessionId, detail: { reason: text } })
  await settleSubRunInTx(db, tx, sessionId)
  return true
}

/** 父 + 全部子运行的花费（6.4）：自己的 cost_usd + 子运行 cost_usd 之和。loop.ts 的上限检查、humans.ts 同意继续、rules.ts「花费超过 X」用 */
export async function familyCost(db: DbLike, sessionId: string): Promise<number> {
  // 写成整条 SQL：drizzle 在只有一张表的 select 字段里不带表名，子查询里的「sessions.id」会被认成子查询自己的 id
  const result = await db.execute<{ total: string | null }>(
    sql`select s.cost_usd + coalesce((select sum(c.cost_usd) from sessions c where c.parent_session_id = s.id and c.kind = 'sub'), 0) as total from sessions s where s.id = ${sessionId}`
  )
  return Number(result.rows[0]?.total ?? 0)
}

/**
 * 写子运行交回的结果（sessions.sub_result）：run.finish 收尾时写 summary / evidence，work.report 在子运行里写 data（同名字段以后一次为准），
 * 交给父以后写 deliveredAt。只改给了的字段；data 是合并（不是整个换掉）
 */
export async function patchSubResultInTx(tx: Tx, sessionId: string, patch: Partial<SubResult>): Promise<void> {
  const [row] = await tx.select({ subResult: t.sessions.subResult }).from(t.sessions).where(eq(t.sessions.id, sessionId)).for("update")
  if (!row) return
  const current = row.subResult ?? {}
  const next: SubResult = { ...current }
  if (patch.summary !== undefined) next.summary = patch.summary
  if (patch.evidence !== undefined) next.evidence = patch.evidence
  if (patch.deliveredAt !== undefined) next.deliveredAt = patch.deliveredAt
  if (patch.data !== undefined) next.data = { ...(current.data ?? {}), ...patch.data }
  await tx.update(t.sessions).set({ subResult: next }).where(eq(t.sessions.id, sessionId))
}
