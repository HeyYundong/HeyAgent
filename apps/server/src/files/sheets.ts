// 表格文件（xlsx、xls、xlsm、xlsb、ods、csv、tsv）的读写，用 SheetJS 社区版（从 cdn.sheetjs.com 装的 0.20.3，见 docs/dev/conventions.md）。
// - 读：只读单元格里存着的值（不读公式），日期转成 YYYY-MM-DD（有时间带 HH:mm），给 agent 的是带行号的制表符分隔文本，给页面的是 JSON；
// - 写：agent 给每个工作表的行（文字、数字、是否、空），生成 xlsx 或 xls。社区版不能写加粗、冻结窗格，只设列宽。
// 合并单元格的值只在左上角那格。文件内容不会变（同一个 id 永远是同一份），解析结果按 id 缓存几分钟，分页读不用每次重新解析。
import { extname } from "node:path"

import * as XLSX from "xlsx"
import * as cptable from "xlsx/dist/cpexcel.full.mjs"
import type { SheetPreview } from "@heyagent/shared"

import { readFileData, type FileRow } from "./service.js"

// 老的 xls 里不是 Unicode 的文字（例如 GBK）要靠代码页表解码
XLSX.set_cptable(cptable)

export const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
export const XLS_MIME = "application/vnd.ms-excel"

const SHEET_EXTENSIONS = new Set([".xlsx", ".xlsm", ".xlsb", ".xls", ".ods", ".csv", ".tsv"])
const SHEET_MIMES = new Set([
  XLSX_MIME,
  XLS_MIME,
  "application/vnd.ms-excel.sheet.macroenabled.12",
  "application/vnd.ms-excel.sheet.binary.macroenabled.12",
  "application/vnd.oasis.opendocument.spreadsheet",
  "text/csv",
  "text/tab-separated-values",
])
/** 纯文本的表格（也能按原文读） */
const PLAIN_EXTENSIONS = new Set([".csv", ".tsv"])

export const isSheetFile = (name: string, mime: string) =>
  SHEET_EXTENSIONS.has(extname(name).toLowerCase()) || SHEET_MIMES.has(mime.toLowerCase())
export const isPlainSheet = (name: string, mime: string) =>
  PLAIN_EXTENSIONS.has(extname(name).toLowerCase()) || ["text/csv", "text/tab-separated-values"].includes(mime.toLowerCase())

/** 表格内容有问题（打不开、参数不对、写不了），message 直接给 agent 或页面看 */
export class SheetError extends Error {}

export interface ParsedSheet {
  name: string
  hidden: boolean
  /** 有内容的范围（0 开始，含两端）；空表 empty = true */
  empty: boolean
  firstRow: number
  lastRow: number
  firstCol: number
  lastCol: number
  /** 每格已经转成文字：cells[r][c]（r、c 是表里的绝对位置，0 开始） */
  cells: string[][]
  merges: string[]
}

export interface ParsedBook {
  sheets: ParsedSheet[]
}

const pad = (value: number) => String(value).padStart(2, "0")

/** SheetJS 读出来的日期是「墙上时间」放在 UTC 里（和时区无关），按 UTC 取年月日时分 */
function dateText(value: Date) {
  if (Number.isNaN(value.getTime())) return ""
  const day = `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
  const h = value.getUTCHours()
  const m = value.getUTCMinutes()
  const s = value.getUTCSeconds()
  if (!h && !m && !s) return day
  return `${day} ${pad(h)}:${pad(m)}${s ? `:${pad(s)}` : ""}`
}

function cellText(cell: XLSX.CellObject | undefined): string {
  if (!cell) return ""
  if (cell.t === "e") return cell.w ?? "#错误"
  const value = cell.v
  if (value === undefined || value === null) return ""
  if (value instanceof Date) return dateText(value)
  if (typeof value === "number") {
    // 百分比照显示的写（0.125 写成 12.5%）；其他数字给原值，去掉浮点误差（0.30000000000000004 → 0.3）
    if (cell.w && /%\s*$/.test(cell.w)) return cell.w.trim()
    return String(Number(value.toPrecision(15)))
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE"
  return String(value)
}

/** csv / tsv 的编码：是合法的 UTF-8 就按 UTF-8（TextDecoder 会去掉开头的 BOM），不是就当 GB18030（国内系统导出的 csv 常见） */
function decodePlain(data: Buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data)
  } catch {
    return new TextDecoder("gb18030").decode(data)
  }
}

function toParsedSheet(name: string, sheet: XLSX.WorkSheet, hidden: boolean): ParsedSheet {
  const data = (sheet["!data"] ?? []) as (XLSX.CellObject[] | undefined)[]
  const cells: string[][] = []
  let firstRow = Infinity
  let lastRow = -1
  let firstCol = Infinity
  let lastCol = -1
  for (let r = 0; r < data.length; r++) {
    const row = data[r]
    if (!row) continue
    const out: string[] = []
    for (let c = 0; c < row.length; c++) {
      const text = cellText(row[c])
      if (!text) continue
      out[c] = text
      if (r < firstRow) firstRow = r
      if (r > lastRow) lastRow = r
      if (c < firstCol) firstCol = c
      if (c > lastCol) lastCol = c
    }
    if (out.length) cells[r] = out
  }
  const empty = lastRow < 0
  return {
    name,
    hidden,
    empty,
    firstRow: empty ? 0 : firstRow,
    lastRow: empty ? -1 : lastRow,
    firstCol: empty ? 0 : firstCol,
    lastCol: empty ? -1 : lastCol,
    cells,
    merges: ((sheet["!merges"] ?? []) as XLSX.Range[]).map((range) => XLSX.utils.encode_range(range)),
  }
}

/** 解析整个文件。打不开（坏了、加密了、不是表格）抛 SheetError */
export function parseBook(data: Buffer, name: string, mime: string): ParsedBook {
  let book: XLSX.WorkBook
  try {
    const common = { dense: true, cellDates: true, cellFormula: false, cellHTML: false, cellStyles: false } as const
    if (isPlainSheet(name, mime)) {
      const tsv = extname(name).toLowerCase() === ".tsv" || mime === "text/tab-separated-values"
      // raw：csv 里的值照原文（不把 00123 变成 123、不猜日期）
      book = XLSX.read(decodePlain(data), { ...common, type: "string", raw: true, ...(tsv ? { FS: "\t" } : {}) })
    } else {
      book = XLSX.read(data, { ...common, type: "buffer" })
    }
  } catch (error) {
    const message = (error as Error).message ?? String(error)
    if (/password|encrypt/i.test(message)) throw new SheetError(`${name} 有密码保护，打不开`)
    throw new SheetError(`${name} 打不开，可能文件坏了或者不是表格：${message.slice(0, 200)}`)
  }
  const meta = book.Workbook?.Sheets ?? []
  return {
    sheets: book.SheetNames.map((sheetName, index) => toParsedSheet(sheetName, book.Sheets[sheetName] ?? { "!data": [] }, Boolean(meta[index]?.Hidden))),
  }
}

const CACHE_MS = 5 * 60_000
const cache = new Map<string, { book: ParsedBook; at: number }>()

/** 按文件 id 缓存最近解析过的 3 个 */
export async function loadBook(row: FileRow): Promise<ParsedBook> {
  const now = Date.now()
  for (const [key, entry] of cache) if (now - entry.at > CACHE_MS) cache.delete(key)
  const hit = cache.get(row.id)
  if (hit) {
    hit.at = now
    return hit.book
  }
  const book = parseBook(await readFileData(row), row.name, row.mime)
  cache.set(row.id, { book, at: now })
  while (cache.size > 3) cache.delete(cache.keys().next().value!)
  return book
}

const colName = (c: number) => XLSX.utils.encode_col(c)
const refText = (sheet: ParsedSheet) =>
  sheet.empty ? "空表" : `${colName(sheet.firstCol)}${sheet.firstRow + 1}:${colName(sheet.lastCol)}${sheet.lastRow + 1}`
const sizeText = (sheet: ParsedSheet) =>
  sheet.empty ? "空表" : `${refText(sheet)}，${sheet.lastRow - sheet.firstRow + 1} 行 × ${sheet.lastCol - sheet.firstCol + 1} 列`

/** 单元格写进一行文本：反斜杠、制表符、换行转义，太长的截断 */
const CELL_LIMIT = 1000
function escapeCell(text: string) {
  const cut = text.length > CELL_LIMIT ? `${text.slice(0, CELL_LIMIT)}…（共 ${text.length} 字）` : text
  return cut.replace(/\\/g, "\\\\").replace(/\t/g, "\\t").replace(/\r?\n|\r/g, "\\n")
}

function rowLine(sheet: ParsedSheet, r: number) {
  const row = sheet.cells[r] ?? []
  const values: string[] = []
  for (let c = sheet.firstCol; c <= Math.min(sheet.lastCol, row.length - 1); c++) values.push(escapeCell(row[c] ?? ""))
  return [String(r + 1), ...values].join("\t")
}

function headerLine(sheet: ParsedSheet) {
  const cols: string[] = []
  for (let c = sheet.firstCol; c <= sheet.lastCol; c++) cols.push(colName(c))
  return ["行", ...cols].join("\t")
}

/** 从第 from 行（0 开始的绝对位置）起写，最多 count 行、不超过 budget 个字；返回写到了哪一行 */
function renderRows(sheet: ParsedSheet, from: number, count: number, budget: number) {
  const lines: string[] = []
  let used = 0
  let r = from
  const end = Math.min(sheet.lastRow, from + count - 1)
  for (; r <= end; r++) {
    const line = rowLine(sheet, r)
    if (lines.length && used + line.length + 1 > budget) break
    lines.push(line)
    used += line.length + 1
  }
  return { text: lines.join("\n"), next: r }
}

const READ_NOTE = "格式：第一行是列名，之后每行开头是行号，格子之间用制表符隔开，空格子留空；格子里的换行、制表符写成 \\n、\\t。日期写成 YYYY-MM-DD（有时间带 HH:mm）；只给存着的值，不给公式；合并单元格的值只在左上角那格。"

function mergesNote(sheet: ParsedSheet) {
  if (!sheet.merges.length) return ""
  const shown = sheet.merges.slice(0, 10).join("、")
  return `\n合并单元格 ${sheet.merges.length} 处：${shown}${sheet.merges.length > 10 ? " 等" : ""}`
}

/** 概览：每个工作表的名字、范围、前 20 行 */
export function overviewText(book: ParsedBook, fileName: string, limit: number) {
  const parts = [`${fileName}：${book.sheets.length} 个工作表。${READ_NOTE}`]
  let budget = limit - parts[0]!.length - 300
  for (const [index, sheet] of book.sheets.entries()) {
    const title = `\n## ${index + 1}.「${sheet.name}」${sheet.hidden ? "（隐藏）" : ""}${sizeText(sheet)}`
    if (sheet.empty || budget < 500) {
      parts.push(title + (sheet.empty ? "" : "（字数到上限了，这里不列内容，用 sheet 单独读）"))
      budget -= title.length
      continue
    }
    const share = Math.max(500, Math.floor(budget / (book.sheets.length - index)))
    const rows = renderRows(sheet, sheet.firstRow, 20, share)
    const rest = sheet.lastRow - rows.next + 1
    const block = `${title}${mergesNote(sheet)}\n${headerLine(sheet)}\n${rows.text}${rest > 0 ? `\n…（这里是前 ${rows.next - sheet.firstRow} 行，后面还有 ${rest} 行）` : ""}`
    parts.push(block)
    budget -= block.length
  }
  parts.push(`\n接着读：file.read 加 sheet（工作表名字或序号）、startRow（从第几行，按上面的行号）、rows（默认 200，最多 500）。`)
  return parts.join("\n")
}

export function findSheet(book: ParsedBook, key: string | number): ParsedSheet {
  const byName = typeof key === "string" ? book.sheets.find((sheet) => sheet.name === key) ?? book.sheets.find((sheet) => sheet.name.trim().toLowerCase() === key.trim().toLowerCase()) : undefined
  const index = typeof key === "number" ? key : /^\d+$/.test(key.trim()) ? Number(key.trim()) : NaN
  const found = byName ?? (Number.isInteger(index) ? book.sheets[index - 1] : undefined)
  if (!found) throw new SheetError(`没有工作表「${key}」。有：${book.sheets.map((sheet, i) => `${i + 1}.「${sheet.name}」`).join("、")}`)
  return found
}

/** 读一段：sheet 的第 startRow 行起 rows 行（行号从 1 开始，和表里的一样） */
export function rangeText(book: ParsedBook, fileName: string, options: { sheet?: string | number; startRow?: number; rows?: number }, limit: number) {
  const sheet = options.sheet === undefined ? book.sheets[0] : findSheet(book, options.sheet)
  if (!sheet) throw new SheetError(`${fileName} 里没有工作表`)
  const label = `${fileName} 的「${sheet.name}」`
  if (sheet.empty) return `${label}是空表。`
  const from = Math.max(sheet.firstRow, (options.startRow ?? sheet.firstRow + 1) - 1)
  if (from > sheet.lastRow) return `${label}没有第 ${from + 1} 行，内容到第 ${sheet.lastRow + 1} 行为止（${sizeText(sheet)}）。`
  const count = Math.min(500, options.rows ?? 200)
  // 不是从头读时带上第一行（一般是表头），方便对上列
  const head = from > sheet.firstRow ? `${rowLine(sheet, sheet.firstRow)}\n` : ""
  const intro = `${label}（${sizeText(sheet)}），第 ${from + 1} 行起：${READ_NOTE}${mergesNote(sheet)}\n${headerLine(sheet)}\n${head ? `（第 ${sheet.firstRow + 1} 行是表头，先列在这里）\n${head}` : ""}`
  const rows = renderRows(sheet, from, count, limit - intro.length - 200)
  const rest = sheet.lastRow - rows.next + 1
  const tail =
    rest > 0
      ? `\n…（到第 ${rows.next} 行${rows.next - from < count ? "，字数到上限了" : ""}；后面还有 ${rest} 行，用 startRow = ${rows.next + 1} 接着读）`
      : "\n（读完了）"
  return `${intro}${rows.text}${tail}`
}

/** 页面预览：每个工作表前 rowLimit 行，格子转成文字（太长的截断） */
export function previewOf(book: ParsedBook, rowLimit: number): SheetPreview {
  return {
    rowLimit,
    sheets: book.sheets.map((sheet) => {
      const columns: string[] = []
      for (let c = sheet.firstCol; c <= sheet.lastCol; c++) columns.push(colName(c))
      const rows: string[][] = []
      const end = Math.min(sheet.lastRow, sheet.firstRow + rowLimit - 1)
      for (let r = sheet.firstRow; r <= end; r++) {
        const row = sheet.cells[r] ?? []
        const out: string[] = []
        for (let c = sheet.firstCol; c <= Math.min(sheet.lastCol, row.length - 1); c++) {
          const text = row[c] ?? ""
          out.push(text.length > 500 ? `${text.slice(0, 500)}…` : text)
        }
        rows.push(out)
      }
      return {
        name: sheet.name,
        hidden: sheet.hidden,
        firstRow: sheet.firstRow + 1,
        columns,
        rows,
        totalRows: sheet.empty ? 0 : sheet.lastRow - sheet.firstRow + 1,
        totalCols: sheet.empty ? 0 : sheet.lastCol - sheet.firstCol + 1,
        merged: sheet.merges.length,
      }
    }),
  }
}

// ---------- 写 ----------

export type SheetCell = string | number | boolean | null
export interface SheetInput {
  name: string
  rows: SheetCell[][]
}

const LIMITS = {
  xlsx: { rows: 1_048_576, cols: 16_384 },
  xls: { rows: 65_536, cols: 256 },
} as const
const CELL_MAX = 32_767

/** Excel 的工作表名规则：1～31 个字，不能有 [ ] : * ? / \，不能以单引号开头或结尾，不能重名（不分大小写） */
export function checkSheetNames(names: string[]) {
  const seen = new Set<string>()
  for (const raw of names) {
    const name = raw.trim()
    if (!name) throw new SheetError("工作表名不能是空的")
    if (name.length > 31) throw new SheetError(`工作表名「${name}」太长：最多 31 个字`)
    if (/[[\]:*?/\\]/.test(name)) throw new SheetError(`工作表名「${name}」里不能有 [ ] : * ? / \\`)
    if (name.startsWith("'") || name.endsWith("'")) throw new SheetError(`工作表名「${name}」不能以单引号开头或结尾`)
    const key = name.toLowerCase()
    if (seen.has(key)) throw new SheetError(`工作表名「${name}」重复了`)
    seen.add(key)
  }
}

/** 中日韩文字按两个字符宽算 */
const displayWidth = (text: string) => {
  let width = 0
  for (const char of text) width += /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(char) ? 2 : 1
  return width
}

/** 生成 xlsx / xls。名字、行列数、格子长度不合规矩抛 SheetError */
export function buildWorkbook(sheets: SheetInput[], format: "xlsx" | "xls"): Buffer {
  if (!sheets.length) throw new SheetError("至少要有一个工作表")
  checkSheetNames(sheets.map((sheet) => sheet.name))
  const limit = LIMITS[format]
  const book = XLSX.utils.book_new()
  for (const input of sheets) {
    const name = input.name.trim()
    if (input.rows.length > limit.rows) throw new SheetError(`工作表「${name}」有 ${input.rows.length} 行，${format} 最多 ${limit.rows} 行${format === "xls" ? "（行多请用 xlsx）" : ""}`)
    const widths: number[] = []
    for (const [r, row] of input.rows.entries()) {
      if (!Array.isArray(row)) throw new SheetError(`工作表「${name}」第 ${r + 1} 行不是数组`)
      if (row.length > limit.cols) throw new SheetError(`工作表「${name}」第 ${r + 1} 行有 ${row.length} 列，${format} 最多 ${limit.cols} 列${format === "xls" ? "（列多请用 xlsx）" : ""}`)
      for (const [c, value] of row.entries()) {
        if (typeof value === "number" && !Number.isFinite(value)) throw new SheetError(`工作表「${name}」第 ${r + 1} 行第 ${c + 1} 列不是有效的数字`)
        const text = value === null || value === undefined ? "" : String(value)
        if (text.length > CELL_MAX) throw new SheetError(`工作表「${name}」第 ${r + 1} 行第 ${c + 1} 列太长：一格最多 ${CELL_MAX} 个字`)
        widths[c] = Math.max(widths[c] ?? 0, Math.min(60, Math.max(...text.split("\n").map(displayWidth))))
      }
    }
    // 字符串一律存成文字（以 = 开头的也不会变成公式）；null 是空格子
    const sheet = XLSX.utils.aoa_to_sheet(input.rows, { dense: true })
    sheet["!cols"] = Array.from(widths, (width) => ({ wch: Math.max(6, (width ?? 0) + 2) }))
    XLSX.utils.book_append_sheet(book, sheet, name)
  }
  try {
    return XLSX.write(book, { type: "buffer", bookType: format, compression: true }) as Buffer
  } catch (error) {
    throw new SheetError(`生成 ${format} 出错：${(error as Error).message}`)
  }
}
