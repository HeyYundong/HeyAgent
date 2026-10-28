// 库流程当工具给 agent 调（docs/dev/routine-library.md 5.1、5.2、5.5）。A 包实现，现在是空壳。
// 网关（engine/gateway.ts）给 snapshot.libraryRoutines 里 selected、没有 unavailable 的每个库流程一个工具：
// 名字 safeName("routine.<短名>")，参数 toolSchemaOf(inputSchema).jsonSchema，执行是这里的 executeLibraryTool：
// 1. inputOfToolArgs 转回脚本的输入（attachments 按调用方能读的文件展开），再按 inputSchema 校验（checks.ts 的 schemaProblems），不合格当场出错、不起沙箱；
// 2. 起沙箱（同固化脚本：不挂出网代理，/workspace 只读），代码目录放这个库流程（routine.mjs）、它调的库流程（routines/<短名>.mjs，snapshot.ts 的 libraryModules）、SDK；
// 3. 起工具桥 mode = tool：每一步 gateway.call()，调用 id `<这次的调用 id>-l<步>`，trace.library（callId = 这次的调用 id，depth 1）；
//    要审批 → 停在它前面、不发起审批（同 browser.batch）；会改东西的 browser.fetch 前要有自己的 ha.commit（库流程都是固化脚本，19.5 的规矩照用）；
//    ha.finish / ha.work.report 收进交回值，ha.checkpoint.mark 不做（过程里记一句「库流程里的检查点不算」）；不记重放日志；
// 4. 结局：报了结果 → 交回值（routineReturnSchema，文字 + data）；ha.fail("input") → 出错「输入有问题：…（流程没改任何东西）」；
//    别的停下 → 出错，文字是交接的话（handoff.ts 抽出的「步骤行」按 trace.library.callId 取），data 是 routineToolStopDataSchema；
//    要挂起 → 同 code.run（tools）：结果带 suspend、signals、facts，引擎照常挂起，库流程不接着跑；
// 5. 上限：routineLimits 的次数、时间，时间还要压在这次运行剩下的时间里；
// 6. 每次调用写一行 routine_calls（stats.ts 的 recordRoutineCall，via = tool）。
import type { LibraryRoutineSnapshot, RoutineCallerFile, SessionSnapshot } from "@heyagent/shared"

import type { Db } from "../../db/client.js"
import type { ToolGateway } from "../../engine/gateway.js"
import type { SessionRow, ToolOutcome } from "../../engine/tools/builtin.js"
import { libraryNotYet } from "./service.js"

export interface LibraryToolContext {
  db: Db
  session: SessionRow
  snapshot: SessionSnapshot
  /** 调用方这次运行的网关：库流程里的每一步都走它（同 code.run 带 tools 的 scriptTools.gateway） */
  gateway: ToolGateway
  /** 这次运行还剩多少毫秒（上限按 routineLimits.timeoutMs 和它取小的） */
  remainingMs: () => number
  /** 调用方能读的文件（attachments 展开用）：快照的附件 + 这次运行的产物 */
  files: () => Promise<RoutineCallerFile[]>
  signal?: AbortSignal
}

/** 网关执行 routine.<短名>：args 是模型给的参数（已经按 toolSchemaOf 的 JSON Schema 校验过），call 是这次的模型工具调用 */
export async function executeLibraryTool(
  _ctx: LibraryToolContext,
  _routine: LibraryRoutineSnapshot,
  _args: Record<string, unknown>,
  _call: { toolCallId: string }
): Promise<ToolOutcome> {
  throw libraryNotYet()
}
