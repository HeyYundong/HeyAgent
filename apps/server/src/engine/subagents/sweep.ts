// 子 agent 的清扫（docs/dev/sub-agents.md 6.5）：并进每分钟的 work.sweep（dispatch/sweep.ts 的 sweepWork 末尾调它），不另开定时。
// 1. 有排队子运行、名额有空的 → 发 subagent.pump；
// 2. 父运行在等子 agent、条件已经满足（漏了叫醒）→ 发 subagent.notify；
// 3. 父运行已经结束、还有没结束的子运行 → 停掉（漏了跟着停的）。
import type { Db } from "../../db/client.js"
import { notReady } from "./not-ready.js"

export interface SubagentSweepResult {
  pumped: boolean
  notified: string[]
  stopped: string[]
}

export async function sweepSubagents(_db: Db): Promise<SubagentSweepResult> {
  return notReady("子 agent 的清扫")
}
