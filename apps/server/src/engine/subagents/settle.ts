// 子 agent：运行结束时要做的事、停掉子运行、父 + 子的合计花费（docs/dev/sub-agents.md 6.4、7.4、第 8 节）。
// 都在调用方的事务里；由 engine/run-ended.ts 的 afterRunEndedInTx 统一调（运行结束的 5 处），漏掉的由 sweep.ts 兜底。
import type { SubResult } from "@heyagent/shared"

import type { Db } from "../../db/client.js"
import type { DbLike } from "../records.js"
import type { Tx } from "../queue.js"
import { notReady } from "./not-ready.js"

/** 子运行结束（7.4 第 2 步）：是子运行（kind = sub）→ 发 subagent.notify（父）和 subagent.pump；不是就什么都不做 */
export async function settleSubRunInTx(_db: Db, _tx: Tx, _sessionId: string): Promise<void> {
  return notReady("子运行结束时结算")
}

/**
 * 父运行结束（7.4 第 3 步、第 8 节）：还有没结束的子运行就全部停掉，原因「父运行 <编号> 已经结束（取消 / 出错），跟着停了」；
 * 排队的直接取消。返回停掉的子运行编号。不是父运行（没有子运行）就返回空
 */
export async function stopChildrenInTx(_db: Db, _tx: Tx, _parentSessionId: string, _reason: string): Promise<string[]> {
  return notReady("停掉子运行")
}

/**
 * 停掉一个子运行（subagent.cancel、stopChildrenInTx 共用）：复用 control.ts 取消的写法（状态出错、结果没办成、作废等待、取消要人办的事、写过程），
 * 但不用人的身份：outcome_by = rule，原因写清谁停的、为什么；审计记系统。已经结束的返回 false。
 * 正在跑的子运行在下一个工具调用之前发现状态变了就停（loop.ts 现在就这样），Chrome 跟着关
 */
export async function stopSubRunInTx(_db: Db, _tx: Tx, _sessionId: string, _reason: string): Promise<boolean> {
  return notReady("停掉一个子运行")
}

/** 父 + 全部子运行的花费（6.4）：自己的 cost_usd + 子运行 cost_usd 之和。loop.ts 的上限检查、humans.ts 同意继续、rules.ts「花费超过 X」用 */
export async function familyCost(_db: DbLike, _sessionId: string): Promise<number> {
  return notReady("合计花费")
}

/**
 * 写子运行交回的结果（sessions.sub_result）：run.finish 收尾时写 summary / evidence，work.report 在子运行里写 data（同名字段以后一次为准），
 * 交给父以后写 deliveredAt。只改给了的字段
 */
export async function patchSubResultInTx(_tx: Tx, _sessionId: string, _patch: Partial<SubResult>): Promise<void> {
  return notReady("写子运行的结果")
}
