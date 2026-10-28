// 子 agent 的骨架（docs/dev/sub-agents.md 第 14 节）：约定已写好、功能还没做。后端实现完删掉这个文件和所有引用。
import type { ToolOutcome } from "../tools/builtin.js"

export const SUBAGENT_NOT_READY = "拆给子 agent 还没做好（docs/dev/sub-agents.md），这次先自己做"

/** 工具的桩：回「还没做好」，算工具出错（模型看得到，自己接着做） */
export const notReadyTool = (): ToolOutcome => ({ output: SUBAGENT_NOT_READY, isError: true })

/** 别的空函数：被调到就是接线接早了 */
export function notReady(what: string): never {
  throw new Error(`子 agent：${what} 还没做好（docs/dev/sub-agents.md）`)
}
