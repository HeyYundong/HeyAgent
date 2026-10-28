// 发布进流程库前的分析（docs/dev/routine-library.md 4.2、4.3、4.4、5.8、2.3）。B 包实现，现在是空壳。
// - 要的工具（requires）：用 checks.ts 的那套 AST 分析（B 包从 checks.ts 导出），ha.browser.* → "browser"，ha.tool("x") → "x"，
//   ha.file.* 不算；ha.browser.fetch → browser.fetch 开关；按坐标的工具（ha.tool("browser.mouse_click_xy") 这类、copyImage 写 x / y）→ vision 开关；
//   ha.routine("短名") → routines（第一个参数要是字面量，不是就算程序检查没过）。调的库流程要的工具一并算进来（传递，按它们登记的 requires）。
// - 风险：没有 ha.commit、用到的非浏览器工具都是只读 → read；否则取最高的：浏览器 external，HTTP / MCP 按工具自己的，调的库流程按它登记的。
// - 环和层数：按登记的 requires.routines 画图，有环不让发；加上它以后最深超过 MAX_LIBRARY_DEPTH 不让发。
// - 不兼容改动：shared 的 compareRoutineSchemas + routineRequiresAdded（和现在发布的那一版比）。
// - 给模型的说明（4.2）：routineToolDescription，存 tools.description。
import type { Risk, RoutineCompatIssue, RoutineRequires } from "@heyagent/shared"

import type { DbOrTx } from "../../data/config/common.js"
import { libraryNotYet } from "./service.js"

/** 一段脚本自己用到的（不算传递）：analyzeLibraryCode 的结果 */
export interface LibraryCodeAnalysis {
  /** 直接用到的工具 id（"browser" 是组；不含 routine.*） */
  toolIds: string[]
  browser: RoutineRequires["browser"]
  /** ha.routine 直接调的短名 */
  routines: string[]
  /** 有没有 ha.commit（没有、工具又都是只读的 = 只读） */
  usesCommit: boolean
  /** 分析不了的写法（ha.routine 的短名不是字面量……） */
  problems: string[]
}

/** 只看这一段脚本（纯函数，B 包从 checks.ts 抽出公共的 AST 分析） */
export function analyzeLibraryCode(_code: string): LibraryCodeAnalysis {
  throw libraryNotYet()
}

/** 风险等级（4.3）：tools 是用到的非浏览器工具的风险，routines 是调的库流程登记的风险 */
export function libraryRisk(_input: { usesCommit: boolean; usesBrowser: boolean; tools: Risk[]; routines: Risk[] }): Risk {
  throw libraryNotYet()
}

/** 从 start 出发按 edges（短名 → 它调的短名）走，有环返回环上的短名（按顺序），没有返回 undefined */
export function findLibraryCycle(_edges: ReadonlyMap<string, readonly string[]>, _start: string): string[] | undefined {
  throw libraryNotYet()
}

/** 从 start 出发最深几层（start 自己算 1；没有环时才有意义） */
export function libraryDepthOf(_edges: ReadonlyMap<string, readonly string[]>, _start: string): number {
  throw libraryNotYet()
}

/** 某个固化流程的某一版发布进库的话：要的工具（含传递）、风险、程序检查没过的地方 */
export async function analyzeForPublish(
  _db: DbOrTx,
  _input: { routineId: string; version: number; slug: string }
): Promise<{ requires: RoutineRequires; risk: Risk; commits: string[]; problems: string[] }> {
  throw libraryNotYet()
}

/** 和现在发布的版本比的不兼容改动（第一次发布是空的）：compareRoutineSchemas + routineRequiresAdded */
export async function compatWithPublished(_db: DbOrTx, _input: { routineId: string; version: number; requires: RoutineRequires }): Promise<RoutineCompatIssue[]> {
  throw libraryNotYet()
}

/**
 * 给模型的说明（4.2 的模板）：固化好的流程（几秒做完）、什么时候用、做什么（步骤说明最多 LIBRARY_DESCRIPTION_STEPS 行）、
 * 要的输入（按 toolSchemaOf 转过的参数名）、交回、会真的提交（commits，没有写「只读，不改东西」）、用的是你这次运行的浏览器、跑不通怎么办
 */
export function routineToolDescription(_input: {
  summary: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  commits: string[]
  usesBrowser: boolean
}): string {
  throw libraryNotYet()
}
