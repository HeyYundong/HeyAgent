// 子 agent：开子运行（docs/dev/sub-agents.md 4.2、5.1、5.2）。
// 一个事务里（全有或全无）：锁住父运行这一行，每个子目标从父快照派生子快照（shared 的 deriveSubSnapshot）、
// 按 <父运行编号>.<n> 插一行 sessions（kind = sub、parent_session_id、triggered_by = sub、cost_limit_usd / max_steps = 子 agent 上限），
// 写第一条消息和「运行开始」事件，先全部挂起排队（等 subagent.queue:<父>），同一个事务里发 subagent.pump。
// 开运行的公共部分（编号撞号用 savepoint 重试、写第一条消息、「运行开始」事件）从 sessions.ts 的 startSessionInTx 拆出来共用；
// 子运行不走 buildSnapshot、不挪附件（第 12 节第 5 条：只读地并进快照的 attachments）、不发 session.run（排队，由 pump 放行）。
import type { SessionSnapshot, SubagentItemInput } from "@heyagent/shared"

import type { Db } from "../../db/client.js"
import type { Tx } from "../queue.js"
import type { SessionRow } from "../tools/builtin.js"
import { notReady } from "./not-ready.js"

export interface StartSubRunsInput {
  /** 父运行（调用方已经 for update 锁住、检查过 kind = run） */
  parent: SessionRow
  /** 父运行的快照（库里的那份：自动挑选记忆已经写回） */
  parentSnapshot: SessionSnapshot
  items: SubagentItemInput[]
  /** 子 agent 的上限（设置 subagent.maxCostUsd / maxSteps），写进每个子运行的 cost_limit_usd / max_steps */
  limits: { maxCostUsd: number; maxSteps: number }
}

export interface StartedSubRun {
  id: string
  n: number
  title: string
}

/** 开出子运行（排队状态）。n 接着这个父运行已有的最大 n 往下数（补拆的接着数） */
export async function startSubRunsInTx(_db: Db, _tx: Tx, _input: StartSubRunsInput): Promise<StartedSubRun[]> {
  return notReady("开子运行")
}

/** 子运行的第一条用户消息（5.2）：编号、父运行、子目标、输入（只当数据）、给它的文件、要交回的字段、只做这一件。sessions.ts 的 firstUserMessage 有 snapshot.sub 时调它 */
export function subFirstUserMessage(_snapshot: SessionSnapshot & { sub: NonNullable<SessionSnapshot["sub"]> }): string {
  return notReady("子运行的第一条消息")
}
