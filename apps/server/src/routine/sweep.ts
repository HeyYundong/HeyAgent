// 固化的清扫（docs/dev/solidify.md 17.3），队列 routine.sweep 每 5 分钟一次。
// 骨架：内容由第二期第一批的 A2 包写。
import type { Db } from "../db/client.js"

/**
 * 试跑中的版本、这一轮的试跑运行已经结束 → 发 routine.compile（引擎漏发的兜底）；
 * 写脚本中、30 分钟没动静的版本 → 再发一次 routine.compile（任务丢了的兜底）
 */
export async function sweepRoutines(_db: Db): Promise<void> {}
