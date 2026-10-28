// 开始运行时冻库流程（docs/dev/routine-library.md 6.2）、准备沙箱代码目录里的库流程模块（5.2、5.6）、系统提示的一节（4.2）。
// A 包实现，现在是空壳。engine/sessions.ts 冻快照时调 freezeLibraryRoutines，结果放 snapshot.libraryRoutines：
// - 任务 toolIds 里的 routine.*（selected = true），取登记发布的那一版；它们 requires.routines 里调的（传递，selected = false，已经选了的不重复）；
// - 这次用不了的仍冻进来，带 unavailable：停用（「停用了：…」）、撤下、登记没了、缺要的工具（「任务没选『浏览器』」）、
//   缺开关（「任务没打开『允许直接调网站接口』」，按 missingRoutineRequires）、它调的库流程用不了（「它调的『…』用不了：…」）；
// - 调用方自己的固化脚本里 ha.routine 的流程：也要在任务里选上才在这里（同「用到的工具都在任务里」），程序检查（checks.ts）管。
// 子 agent（docs/dev/sub-agents.md）从父运行的快照抄，libraryRoutines 一起抄。
import type { LibraryRoutineSnapshot, SessionSnapshot } from "@heyagent/shared"

import type { DbOrTx } from "../../data/config/common.js"
import { libraryNotYet } from "./service.js"

/** 冻快照：task 是任务的配置（toolIds 里有 routine.*；两个浏览器开关）。没选库流程返回空数组（快照里不写这个字段） */
export async function freezeLibraryRoutines(
  _db: DbOrTx,
  _task: { toolIds: readonly string[]; allowBrowserFetch: boolean; allowBrowserVision: boolean }
): Promise<LibraryRoutineSnapshot[]> {
  throw libraryNotYet()
}

/**
 * 沙箱代码目录里要放的库流程模块：从 root（agent 调的那个库流程；固化脚本、code.run 是 undefined = 快照里所有用得了的）出发，
 * 按 requires.routines 传递收齐，每个一项 { path: libraryModulePath(短名), code }。用不了的不放（ha.routine 调到时工具桥报错）
 */
export function libraryModules(_snapshot: SessionSnapshot, _root?: string): { path: string; code: string }[] {
  throw libraryNotYet()
}

/** 系统提示「## 固化好的流程」一节（engine/prompt.ts 调；这次没有 selected 的库流程返回 undefined） */
export function libraryPromptSection(_routines: readonly LibraryRoutineSnapshot[]): string | undefined {
  throw libraryNotYet()
}
