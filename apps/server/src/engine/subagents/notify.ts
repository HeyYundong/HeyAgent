// 子 agent：子运行结束后叫醒等它们的父运行（docs/dev/sub-agents.md 7.1、7.2，队列 subagent.notify，参数是父运行编号）。
// 找父运行正在等的那条等待（subagent.all:<父> / subagent.any:<父>）；没有就结束（父在干别的，醒来以后自己会 subagent.wait）。
// 按 mode 判断条件（all：全部结束；any：有结束了、还没交给过父的），满足了一个事务里 resumeInTx（消息是 results.ts 的结果文字），
// 并把这次交出去的子运行写 sub_result.deliveredAt。叫醒是幂等的。
import type { Db } from "../../db/client.js"
import { notReady } from "./not-ready.js"

/** subagent.notify 的处理函数（worker-runtime.ts 注册）。返回叫醒的父运行编号（没叫醒是 null） */
export async function onSubagentNotify(_db: Db, _data: { parentSessionId: string }): Promise<{ resumed: string | null }> {
  return notReady("叫醒父运行")
}

/**
 * 先结束、后挂起的窗口（7.1，照 dispatch/notify.ts 的 recheckWorkDoneAfterSuspend）：父运行挂起等子 agent 的事务提交以后再查一次，
 * 条件已经满足就补发 subagent.notify。event 不是父运行等子 agent 的事件（shared 的 parseSubagentWaitEvent 认不出）就什么都不做
 */
export async function recheckSubagentWaitAfterSuspend(_db: Db, _event: string | null | undefined): Promise<void> {
  return notReady("挂起后补查")
}
