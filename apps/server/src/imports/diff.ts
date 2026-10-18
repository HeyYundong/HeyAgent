// 按行对比两段文字（最长公共子序列），输出 DiffLine（和技能修改建议同一个形状，页面用 CodeBlock 的 added / removed 行显示）。
// 用在导入时「已有同名技能」：已有的当前版 → 包里的版本。
import type { DiffLine } from "@heyagent/shared"

/** 太长的正文不逐行算（O(n·m)），超过就整段算「删掉旧的、加上新的」 */
const MAX_CELLS = 4_000_000

export function lineDiff(before: string, after: string, maxLines = 5000): DiffLine[] {
  const a = before.split("\n")
  const b = after.split("\n")
  if (a.length * b.length > MAX_CELLS) {
    return [...a.map((text) => ({ variant: "removed" as const, text })), ...b.map((text) => ({ variant: "added" as const, text }))].slice(0, maxLines)
  }
  // lcs[i][j] = a[i..] 和 b[j..] 的最长公共子序列长度（一维数组按行存）
  const width = b.length + 1
  const lcs = new Uint32Array((a.length + 1) * width)
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i * width + j] = a[i] === b[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
    }
  }
  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      out.push({ variant: "default", text: a[i]! })
      i++
      j++
    } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
      out.push({ variant: "removed", text: a[i]! })
      i++
    } else {
      out.push({ variant: "added", text: b[j]! })
      j++
    }
  }
  while (i < a.length) out.push({ variant: "removed", text: a[i++]! })
  while (j < b.length) out.push({ variant: "added", text: b[j++]! })
  return out.slice(0, maxLines)
}

/** 一句话说两边差在哪 */
export function diffNote(diff: DiffLine[], version: number): string {
  const added = diff.filter((line) => line.variant === "added" && line.text.trim()).length
  const removed = diff.filter((line) => line.variant === "removed" && line.text.trim()).length
  if (added === 0 && removed === 0) return `和已有的第 ${version} 版内容一样`
  const parts = [added ? `多了 ${added} 行` : "", removed ? `少了 ${removed} 行` : ""].filter(Boolean)
  return `和已有的第 ${version} 版比，包里的${parts.join("、")}`
}
