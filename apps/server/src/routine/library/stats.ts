// 库流程的调用记录、连续跑不通的计数、自动停用（docs/dev/routine-library.md 6.5、6.6）。A 包实现，现在是空壳。
// 每次调用（agent 调、脚本调都算；两层嵌套时每一层各一行）结束时调一次 recordRoutineCall：
// - 写一行 routine_calls；
// - 按 shared 的 libraryStreakChange 改登记的 fail_streak（fail +1 / reset 清零 / keep 不动）；
// - fail_streak 满 LIBRARY_PAUSE_AFTER_FAILS 而且还在库里 → 自动停用：status = paused，paused_reason 写清最近三次停在哪
//   （库流程第几步、原因、哪次运行），审计 routine.library.auto_pause，通知来源任务负责人和最近一次发布的主管。
// 调用方的运行：这次调用算一次工具调用，执行模型的步数不加；脚本里的判断题花费记在调用方（同 ha.judge）。
// 来源任务「固化流程」区块的成绩不变，只算来源任务自己的运行（runtime/stats.ts）。
import type { RoutineCallResult, RoutineCallVia, RoutineStopKind } from "@heyagent/shared"

import type { Db } from "../../db/client.js"
import { libraryNotYet } from "./service.js"

/** 一次调用（routine_calls 的一行） */
export interface NewRoutineCall {
  routineId: string
  version: number
  /** 调用方的运行、任务 */
  sessionId: string
  taskId: string
  /** agent 调 = 模型的工具调用 id；脚本调 = 进入那一步的调用 id（同 trace.library.callId） */
  callId: string
  via: RoutineCallVia
  depth: number
  result: RoutineCallResult
  stopKind?: RoutineStopKind
  /** 停在库流程的第几步 */
  stopStep?: number
  stopReason?: string
  steps: number
  ms: number
}

/** 记一次调用，改计数，满了自动停用、通知。返回这次有没有把它自动停用 */
export async function recordRoutineCall(_db: Db, _call: NewRoutineCall): Promise<{ autoPaused: boolean }> {
  throw libraryNotYet()
}
