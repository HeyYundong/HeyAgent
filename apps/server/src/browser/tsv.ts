// 剪贴板里的表格（docs/dev/online-sheets.md 第一节）：在线表格、Excel 复制出来的是 TSV，
// 格子里有制表符、换行、引号时整格加引号、里面的引号写两遍（Excel 的规则）。这里编、解 TSV，把读回的内容整理成给 agent 看的文字（分段）。

/** 一格要加引号：含制表符、换行、引号 */
const NEEDS_QUOTE = /[\t\n\r"]/

/** 二维数组 → TSV（行之间用 \n，最后不带换行；格子按 Excel 的规则加引号） */
export function encodeTsv(table: string[][]): string {
  return table.map((row) => row.map((cell) => (NEEDS_QUOTE.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell)).join("\t")).join("\n")
}

/**
 * TSV → 二维数组。引号开头的格子按 Excel 的规则解（里面可以有制表符、换行，"" 是一个引号）；
 * 引号没配对、收尾引号后面还跟着别的字的，整格照原文算（网页复制出来的文字里本来就可能有引号）。
 * \r\n 当成换行；最后一个换行不算多一行。
 */
export function parseTsv(text: string): string[][] {
  const source = text.replace(/\r\n?/g, "\n").replace(/\n$/, "")
  const rows: string[][] = []
  let row: string[] = []
  let i = 0
  const n = source.length
  if (!n) return []
  for (;;) {
    let cell = ""
    let end = i
    let quoted = false
    if (source[i] === '"') {
      // 找配对的收尾引号："" 是转义
      let j = i + 1
      let value = ""
      for (; j < n; j++) {
        if (source[j] === '"') {
          if (source[j + 1] === '"') {
            value += '"'
            j++
          } else break
        } else value += source[j]
      }
      // 收尾引号后面必须是格子结束（制表符、换行、结尾），否则不算加了引号的格子
      if (j < n && (j + 1 === n || source[j + 1] === "\t" || source[j + 1] === "\n")) {
        cell = value
        end = j + 1
        quoted = true
      }
    }
    if (!quoted) {
      end = i
      while (end < n && source[end] !== "\t" && source[end] !== "\n") end++
      cell = source.slice(i, end)
    }
    row.push(cell)
    if (end >= n) {
      rows.push(row)
      return rows
    }
    if (source[end] === "\n") {
      rows.push(row)
      row = []
    }
    i = end + 1
    if (i >= n) {
      // 以制表符结尾：最后还有一个空格子
      row.push("")
      rows.push(row)
      return rows
    }
  }
}

/** 像表格：有制表符而且不止一行 */
export function looksLikeTable(text: string, rows: string[][]): boolean {
  return text.includes("\t") && rows.length > 1
}

/** 格子写进一行：反斜杠、制表符、换行转义（和 file.read 读表格一样），太长的截断 */
const CELL_LIMIT = 1000
function escapeCell(text: string) {
  const cut = text.length > CELL_LIMIT ? `${text.slice(0, CELL_LIMIT)}…（共 ${text.length} 字）` : text
  return cut.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r?\n|\r/g, "\\n")
}

export interface TextPage {
  /** 这一段的文字（每行开头是行号） */
  text: string
  /** 下一段从第几行开始（0 开始）；没有了 = total */
  next: number
  total: number
}

/** 从第 offset 行（0 开始）起，按字数上限切一段；每行开头是行号（从 1 开始） */
function paginate(lines: string[], offset: number, budget: number): TextPage {
  const out: string[] = []
  let used = 0
  let r = Math.max(0, offset)
  for (; r < lines.length; r++) {
    const line = `${r + 1}\t${lines[r]}`
    if (out.length && used + line.length + 1 > budget) break
    out.push(line)
    used += line.length + 1
  }
  return { text: out.join("\n"), next: r, total: lines.length }
}

/** 表格的一段：格子之间用制表符，格子里的换行、制表符转义 */
export function tablePage(rows: string[][], offset: number, budget: number): TextPage & { cols: number } {
  const cols = rows.reduce((max, row) => Math.max(max, row.length), 0)
  return { ...paginate(rows.map((row) => row.map(escapeCell).join("\t")), offset, budget), cols }
}

/** 普通文字的一段（按行） */
export function linesPage(text: string, offset: number, budget: number): TextPage {
  return paginate(text.replace(/\r\n?/g, "\n").split("\n"), offset, budget)
}
