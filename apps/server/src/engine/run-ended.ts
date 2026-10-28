// 运行结束时要做的事，统一一个入口（docs/dev/sub-agents.md 7.4）。
// 运行结束的 5 处（loop.ts 的 finishRun（有复核的在 reviewAfterFinish 里）/ failSession，control.ts 的取消，
// humans.ts 的上限「不继续」、验收争议判通过 / 失败）现在各自调 settleWorkItemInTx；后端实现子 agent 时改成都调这一个，
// 以后再有「运行结束时要做的事」只加在这里。漏掉的由每分钟的清扫兜底（dispatch/sweep.ts、subagents/sweep.ts）。
import type { Db } from "../db/client.js"
import { settleWorkItemInTx, type SettleOutcome, type SettleResult } from "./dispatch/settle.js"
import type { Tx } from "./queue.js"

/**
 * 在结束运行的那个事务里调（状态已经改成结束以后）：
 * 1. settleWorkItemInTx：被派的运行结算派活单（原样，返回值照旧给调用方决定发不发通知）；
 * 2. settleSubRunInTx（subagents/settle.ts）：是子运行 → 叫醒父运行、放行排队的（TODO 后端）；
 * 3. stopChildrenInTx（subagents/settle.ts）：是父运行、还有没结束的子运行 → 全部停掉（TODO 后端）。
 */
export async function afterRunEndedInTx(db: Db, tx: Tx, sessionId: string, outcome: SettleOutcome): Promise<SettleResult | null> {
  const settled = await settleWorkItemInTx(db, tx, sessionId, outcome)
  // TODO(子 agent 后端)：await settleSubRunInTx(db, tx, sessionId)；await stopChildrenInTx(db, tx, sessionId, 原因)
  return settled
}
