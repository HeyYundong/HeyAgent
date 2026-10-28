// 子 agent 的三个内置工具（docs/dev/sub-agents.md 4.1、7.1、第 8 节）：
// - subagent.start「拆给子 agent」：一个事务里开出几个子运行（start.ts），先全部排队，发 subagent.pump 按名额放行；
// - subagent.wait「等子 agent」：all（默认）/ any 条件满足了直接返回结果，没满足就挂起等 subagent.all:<父> / subagent.any:<父>；none 只看现状；
// - subagent.cancel「停掉子 agent」：停掉这次运行拆出去的几个（settle.ts 的 stopSubRunInTx），发 subagent.pump。
// 只有父运行（kind = run、快照里有 subagent.start）能用；子快照里本来就没有这三个，处理函数里再挡一次。
import type { builtinToolInputs } from "@heyagent/shared"
import type { z } from "zod"

import type { ToolContext, ToolOutcome } from "../tools/builtin.js"
import { notReadyTool } from "./not-ready.js"

type StartInput = z.infer<(typeof builtinToolInputs)["subagent.start"]>
type WaitInput = z.infer<(typeof builtinToolInputs)["subagent.wait"]>
type CancelInput = z.infer<(typeof builtinToolInputs)["subagent.cancel"]>

/**
 * 拆（4.2）：检查（kind、快照、总数上限 subagent.maxPerRun、fileIds 都是父运行能读的）不合格整次拒绝、一个都不开；
 * 合格的调 start.ts 的 startSubRunsInTx，返回每个一行（编号、标题）+ 名额和总数说明
 */
export async function startFromAgent(_ctx: ToolContext, _input: StartInput): Promise<ToolOutcome> {
  return notReadyTool()
}

/**
 * 等（7.1）：一次都没拆过回「这次运行没有拆过子 agent」；all / any 已经满足的直接返回 results.ts 的结果文字（并写 deliveredAt），
 * 没满足的返回 suspend（事件 subagentWaitEvent(父, mode)，what「等子 agent：还有 N 个没结束」，照只等事件的兜底期限）；
 * 挂起提交以后由 notify.ts 的 recheckSubagentWaitAfterSuspend 补查一次
 */
export async function waitFromAgent(_ctx: ToolContext, _input: WaitInput): Promise<ToolOutcome> {
  return notReadyTool()
}

/** 停（第 8 节）：只能停这次运行拆出去的、还没结束的；返回停掉了哪几个、哪些已经结束了 / 不是这次运行的 */
export async function cancelFromAgent(_ctx: ToolContext, _input: CancelInput): Promise<ToolOutcome> {
  return notReadyTool()
}
