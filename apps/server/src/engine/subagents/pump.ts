// 子 agent：按名额放行排队的子运行（docs/dev/sub-agents.md 6.2，队列 subagent.pump，全系统一个）。
// 事务里 pg_advisory_xact_lock(hashtext('subagent.pump'))；全局空位 = maxRunningGlobal − 全系统占名额的子运行数；
// 有排队子运行、父运行还没结束的父运行按最早排队的时间排，每个放 min(maxParallel − 它占名额的, 全局空位) 个（按 n），
// 放行 = resumeInTx(waitId, cause "resume_now", message "", title "轮到了，开始")；父运行已经结束的，排队的子运行一起取消（settle.ts）。
// 占名额：执行中、验收中、挂起等浏览器 / 等桌面（shared 的 holdsSubagentSlot）；等人处理、排队不占。
import type { Db } from "../../db/client.js"
import { notReady } from "./not-ready.js"

export interface SubagentPumpResult {
  /** 放行的子运行编号 */
  released: string[]
  /** 父运行已经结束、跟着取消的排队子运行 */
  cancelled: string[]
}

/** subagent.pump 的处理函数（worker-runtime.ts 注册） */
export async function pumpSubagents(_db: Db): Promise<SubagentPumpResult> {
  return notReady("放行排队的子运行")
}
