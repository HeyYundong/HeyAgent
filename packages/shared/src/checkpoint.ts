// 从一句检查点内容认出类型和目标数，例如「访问了 3 个网站」→ 访问 · 目标 3（原型 lib/checkpoint.ts）。
// 用简单关键词匹配，认不出的归为「说明」。新建任务、看懂架构、M3 的检查点识别都用它。
import type { CheckpointKind } from "./schemas.js"

export interface RecognizedCheckpoint {
  title: string
  kind: CheckpointKind
  target?: number
}

const CN_NUM: Record<string, number> = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

function targetOf(text: string): number | undefined {
  const match = text.match(/(\d+)|([一两二三四五六七八九十])\s*[个家份条款次]/)
  if (!match) return undefined
  return match[1] ? Number(match[1]) : CN_NUM[match[2]!]
}

function kindOf(text: string, target?: number): CheckpointKind {
  if (/已(审核|确认|批准)|人工确认|审批/.test(text)) return "confirm"
  if (target && /发.{0,6}(消息|询价)|发送/.test(text)) return "message"
  if (target && /访问|搜|打开|浏览|对比|比较/.test(text)) return "visit"
  if (/保存|文件|上传|已生成/.test(text)) return "artifact"
  if (target && /≥|>=|至少|不少于/.test(text)) return "count"
  return "note"
}

/** 一句检查点内容；可以用「；」写多条 */
export function recognizeCheckpoints(text: string): RecognizedCheckpoint[] {
  return text
    .split(/[；;]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((title) => {
      const target = targetOf(title)
      const kind = kindOf(title, target)
      const hasTarget = kind === "visit" || kind === "message" || kind === "count"
      return { title, kind, target: hasTarget ? target : undefined }
    })
}
