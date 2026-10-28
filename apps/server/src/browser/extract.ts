// 两个只读的浏览器工具（docs/dev/solidify.md 4.4、4.5）：browser.extract 按定位读页面上的字（一行一个对象），
// browser.wait_any 等页面出现几种结果里的一个。用编排器自己的 Playwright 连接做（和页面概况 page-brief.ts 一样），不经 MCP。
// 定位认两种写法，和 MCP 动作的 target 一样：
// - 录下来的 JS 写法：getByRole('button', { name: '查询' }).nth(1)、getByText('暂无数据')、locator('css')……
//   自己解析成 Playwright 的调用链：只认白名单里的方法，参数只认字面量（不执行任何代码）；
// - 选择器字符串：role=button[name="查询"]、text=…、CSS。JS 写法解析不了的也当选择器字符串。
import type { Locator, Page } from "playwright-core"

/** extract 一次最多读几行；不给 limit 时读几行 */
export const EXTRACT_MAX_ROWS = 500
export const EXTRACT_DEFAULT_ROWS = 50
/** 给模型的文字里最多列几行、每格最多几个字 */
const TEXT_ROWS = 50
const CELL_CHARS = 100
/** wait_any 默认等多久、最多等多久（秒） */
export const WAIT_ANY_DEFAULT_SECONDS = 10
export const WAIT_ANY_MAX_SECONDS = 60
const POLL_MS = 200
/** 读一个格子最多等多久（元素已经在了，只是取文字） */
const READ_TIMEOUT_MS = 2000

// ---------- 解析 JS 写法的定位 ----------

type Literal = string | number | boolean | null | RegExp | { [key: string]: Literal }
interface Call {
  method: string
  args: Literal[]
}

class ParseError extends Error {}

/** 很小的字面量解析器：字符串（'' "" 不带 ${} 的 ``）、数字、true / false / null、正则、对象 */
class Reader {
  private i = 0
  private readonly s: string
  constructor(source: string) {
    this.s = source
  }

  done() {
    this.space()
    return this.i >= this.s.length
  }

  private space() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++
  }

  peek() {
    this.space()
    return this.s[this.i]
  }

  eat(char: string) {
    if (this.peek() !== char) throw new ParseError(`第 ${this.i + 1} 个字符应该是 ${char}`)
    this.i++
  }

  tryEat(char: string) {
    if (this.peek() !== char) return false
    this.i++
    return true
  }

  ident(): string {
    this.space()
    const match = /^[A-Za-z_$][\w$]*/.exec(this.s.slice(this.i))
    if (!match) throw new ParseError(`第 ${this.i + 1} 个字符应该是名字`)
    this.i += match[0].length
    return match[0]
  }

  literal(): Literal {
    const char = this.peek()
    if (char === "'" || char === '"' || char === "`") return this.string(char)
    if (char === "{") return this.object()
    if (char === "/") return this.regex()
    const rest = this.s.slice(this.i)
    const number = /^-?\d+(\.\d+)?/.exec(rest)
    if (number) {
      this.i += number[0].length
      return Number(number[0])
    }
    const word = /^(true|false|null)\b/.exec(rest)
    if (word) {
      this.i += word[0].length
      return word[1] === "true" ? true : word[1] === "false" ? false : null
    }
    throw new ParseError(`第 ${this.i + 1} 个字符开始的参数不是字面量`)
  }

  private string(quote: string): string {
    this.i++
    let out = ""
    while (this.i < this.s.length) {
      const char = this.s[this.i++]!
      if (char === quote) return out
      if (quote === "`" && char === "$" && this.s[this.i] === "{") throw new ParseError("模板字符串里不能有 ${…}")
      if (char !== "\\") {
        out += char
        continue
      }
      const next = this.s[this.i++]
      if (next === undefined) break
      const escapes: Record<string, string> = { n: "\n", t: "\t", r: "\r", "0": "\0", b: "\b", f: "\f", v: "\v" }
      if (next === "u") {
        const hex = /^\{([0-9a-fA-F]+)\}|^([0-9a-fA-F]{4})/.exec(this.s.slice(this.i))
        if (!hex) throw new ParseError("\\u 后面不是十六进制")
        out += String.fromCodePoint(parseInt(hex[1] ?? hex[2]!, 16))
        this.i += hex[0].length
      } else if (next === "x") {
        const hex = /^[0-9a-fA-F]{2}/.exec(this.s.slice(this.i))
        if (!hex) throw new ParseError("\\x 后面不是十六进制")
        out += String.fromCharCode(parseInt(hex[0], 16))
        this.i += 2
      } else out += escapes[next] ?? next
    }
    throw new ParseError("字符串没有结束的引号")
  }

  private regex(): RegExp {
    this.i++
    let body = ""
    let inClass = false
    while (this.i < this.s.length) {
      const char = this.s[this.i++]!
      if (char === "\\") {
        body += char + (this.s[this.i++] ?? "")
        continue
      }
      if (char === "[") inClass = true
      else if (char === "]") inClass = false
      else if (char === "/" && !inClass) {
        const flags = /^[dgimsuyv]*/.exec(this.s.slice(this.i))![0]
        this.i += flags.length
        try {
          return new RegExp(body, flags)
        } catch (error) {
          throw new ParseError(`正则写错了：${(error as Error).message}`)
        }
      }
      body += char
    }
    throw new ParseError("正则没有结束的 /")
  }

  private object(): { [key: string]: Literal } {
    this.eat("{")
    const out: { [key: string]: Literal } = {}
    while (!this.tryEat("}")) {
      const char = this.peek()
      const key = char === "'" || char === '"' ? this.string(char) : this.ident()
      this.eat(":")
      out[key] = this.literal()
      if (!this.tryEat(",")) {
        this.eat("}")
        break
      }
    }
    return out
  }
}

/** 白名单：方法名 → 参数个数（最少、最多） */
const METHODS: Record<string, [number, number]> = {
  getByRole: [1, 2],
  getByText: [1, 2],
  getByLabel: [1, 2],
  getByPlaceholder: [1, 2],
  getByAltText: [1, 2],
  getByTitle: [1, 2],
  getByTestId: [1, 1],
  locator: [1, 2],
  first: [0, 0],
  last: [0, 0],
  nth: [1, 1],
  filter: [1, 1],
}

/** JS 写法 → 调用链；不是 JS 写法（或者用了白名单以外的东西）返回 undefined，调用方当选择器字符串 */
export function parseLocatorChain(text: string): Call[] | undefined {
  let source = text.trim().replace(/;+$/, "").trim()
  source = source.replace(/^await\s+/, "").replace(/^page\s*\./, "")
  if (!/^[A-Za-z_$][\w$]*\s*\(/.test(source)) return undefined
  try {
    const reader = new Reader(source)
    const calls: Call[] = []
    for (;;) {
      const method = reader.ident()
      const arity = METHODS[method]
      if (!arity) return undefined
      reader.eat("(")
      const args: Literal[] = []
      while (!reader.tryEat(")")) {
        args.push(reader.literal())
        if (!reader.tryEat(",")) {
          reader.eat(")")
          break
        }
      }
      if (args.length < arity[0] || args.length > arity[1]) return undefined
      calls.push({ method, args })
      if (reader.done()) return calls
      reader.eat(".")
    }
  } catch (error) {
    if (error instanceof ParseError) return undefined
    throw error
  }
}

const isText = (value: Literal): value is string | RegExp => typeof value === "string" || value instanceof RegExp
const options = (value: Literal | undefined): Record<string, Literal> =>
  value && typeof value === "object" && !(value instanceof RegExp) ? value : {}
/** 只取这几个键、而且类型对的选项 */
function pick(value: Literal | undefined, keys: Record<string, "string" | "text" | "boolean" | "number">) {
  const out: Record<string, unknown> = {}
  for (const [key, raw] of Object.entries(options(value))) {
    const want = keys[key]
    if (!want) throw new ParseError(`不认识的选项 ${key}`)
    const ok =
      want === "text" ? isText(raw) : want === "string" ? typeof raw === "string" : typeof raw === want
    if (!ok) throw new ParseError(`选项 ${key} 的类型不对`)
    out[key] = raw
  }
  return out
}

type Root = Page | Locator

function applyChain(root: Root, calls: Call[]): Locator {
  let current: Root = root
  for (const { method, args } of calls) {
    const [first, second] = args
    const text = () => {
      if (first === undefined || !isText(first)) throw new ParseError(`${method} 的第一个参数要是字符串或正则`)
      return first
    }
    switch (method) {
      case "getByRole": {
        if (typeof first !== "string") throw new ParseError("getByRole 的第一个参数要是角色名")
        const opts = pick(second, { name: "text", exact: "boolean", checked: "boolean", disabled: "boolean", expanded: "boolean", includeHidden: "boolean", level: "number", pressed: "boolean", selected: "boolean" })
        current = current.getByRole(first as Parameters<Page["getByRole"]>[0], opts)
        break
      }
      case "getByText":
      case "getByLabel":
      case "getByPlaceholder":
      case "getByAltText":
      case "getByTitle":
        current = current[method](text(), pick(second, { exact: "boolean" }))
        break
      case "getByTestId":
        current = current.getByTestId(text())
        break
      case "locator": {
        if (typeof first !== "string") throw new ParseError("locator 的第一个参数要是选择器字符串")
        current = current.locator(first, pick(second, { hasText: "text", hasNotText: "text" }))
        break
      }
      case "first":
      case "last":
        if (!("first" in current)) throw new ParseError(`${method}() 不能直接用在页面上`)
        current = current[method]()
        break
      case "nth":
        if (!("nth" in current)) throw new ParseError("nth() 不能直接用在页面上")
        if (typeof first !== "number" || !Number.isInteger(first)) throw new ParseError("nth 的参数要是整数")
        current = current.nth(first)
        break
      case "filter":
        if (!("filter" in current)) throw new ParseError("filter() 不能直接用在页面上")
        current = current.filter(pick(first, { hasText: "text", hasNotText: "text", visible: "boolean" }))
        break
    }
  }
  if (current === root) throw new ParseError("定位是空的")
  return current as Locator
}

/** 定位（JS 写法或选择器字符串）→ root（页面或一行）下的 Locator */
export function buildLocator(root: Root, target: string): Locator {
  const text = target.trim()
  if (!text) throw new Error("定位是空的")
  const chain = parseLocatorChain(text)
  if (chain)
    try {
      return applyChain(root, chain)
    } catch (error) {
      if (!(error instanceof ParseError)) throw error
      throw new Error(`定位「${text}」写得不对：${error.message}`, { cause: error })
    }
  return root.locator(text)
}

// ---------- browser.extract ----------

export type ExtractField = string | { target: string; attr?: string }
export interface ExtractInput {
  list?: string
  fields: Record<string, ExtractField>
  limit?: number
}
export type ExtractRow = Record<string, string | null>

const tidy = (value: string) =>
  value
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n[\s]*/g, "\n")
    .trim()

/** 网址类的属性：换成完整的网址（相对页面的网址） */
const URL_ATTRS = new Set(["href", "src", "action", "poster"])

/**
 * attr 是取 HTML 属性（getAttribute）。没有叫 textContent、innerText、text 的属性，写了只会读出 null
 * （基准 E：脚本写 attr: "textContent"，提交后的核对一直失败）：这几个按文字读
 */
const TEXT_ATTRS = new Set(["textcontent", "innertext", "text"])

async function readField(row: Root, field: ExtractField, pageUrl: string): Promise<string | null> {
  const { target, attr } = typeof field === "string" ? { target: field, attr: undefined } : field
  const locator = buildLocator(row, target)
  if ((await locator.count()) === 0) return null
  const element = locator.first()
  // textContent 连藏起来的字也读（和 DOM 的 textContent 一样）；innerText、text 照不写 attr 读
  if (attr?.toLowerCase() === "textcontent") return tidy((await element.textContent({ timeout: READ_TIMEOUT_MS })) ?? "")
  if (attr && !TEXT_ATTRS.has(attr.toLowerCase())) {
    // value 取输入框现在的值（不是 HTML 里写的初始值）
    if (attr === "value") return element.inputValue({ timeout: READ_TIMEOUT_MS }).catch(() => element.getAttribute("value", { timeout: READ_TIMEOUT_MS }))
    const value = await element.getAttribute(attr, { timeout: READ_TIMEOUT_MS })
    if (value === null || !URL_ATTRS.has(attr)) return value
    try {
      return new URL(value, pageUrl).href
    } catch {
      return value
    }
  }
  const visible = tidy(await element.innerText({ timeout: READ_TIMEOUT_MS }))
  if (visible) return visible
  // 藏起来的元素 innerText 是空的：退回 textContent
  return tidy((await element.textContent({ timeout: READ_TIMEOUT_MS })) ?? "")
}

/** 按定位读页面：list 是每一行，fields 是行里的字段（相对这一行定位）；没有 list = 整页一行。一行也没有不算出错 */
export async function extractRows(page: Page, input: ExtractInput): Promise<{ rows: ExtractRow[]; total: number }> {
  const limit = Math.min(EXTRACT_MAX_ROWS, Math.max(1, input.limit ?? EXTRACT_DEFAULT_ROWS))
  const names = Object.keys(input.fields)
  const readRow = async (row: Root) => {
    const out: ExtractRow = {}
    for (const name of names) out[name] = await readField(row, input.fields[name]!, page.url())
    return out
  }
  if (!input.list) return { rows: [await readRow(page)], total: 1 }
  const list = buildLocator(page, input.list)
  const total = await list.count()
  const rows: ExtractRow[] = []
  for (let index = 0; index < Math.min(total, limit); index++) rows.push(await readRow(list.nth(index)))
  return { rows, total }
}

const cell = (value: string | null) => {
  if (value === null) return "（没有）"
  const flat = value.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|")
  return flat.length > CELL_CHARS ? `${flat.slice(0, CELL_CHARS - 1)}…` : flat || "（空）"
}

/** 给模型看的小表：最多 50 行，每格最多 100 字 */
export function formatExtract(input: ExtractInput, result: { rows: ExtractRow[]; total: number }): string {
  const names = Object.keys(input.fields)
  const { rows, total } = result
  if (input.list && total === 0) return `列表 ${input.list} 一行也没找到（0 行）。`
  const head = input.list
    ? `列表 ${input.list} 一共 ${total} 行，读了 ${rows.length} 行${rows.length < total ? `（limit = ${rows.length}，要更多就加大 limit，最多 ${EXTRACT_MAX_ROWS}）` : ""}：`
    : "读到："
  const shown = rows.slice(0, TEXT_ROWS)
  const lines = [head, `| # | ${names.map((name) => name.replace(/\|/g, "\\|")).join(" | ")} |`, `|---|${names.map(() => "---").join("|")}|`]
  for (const [index, row] of shown.entries()) lines.push(`| ${index + 1} | ${names.map((name) => cell(row[name] ?? null)).join(" | ")} |`)
  if (rows.length > shown.length) lines.push(`…（后面还有 ${rows.length - shown.length} 行没列出来）`)
  if (rows.some((row) => names.some((name) => row[name] === null))) lines.push("（没有 = 这一行里没找到这个字段的元素）")
  return lines.join("\n")
}

// ---------- browser.wait_any ----------

/** 导航中、页面关了这类一会儿就好的错：接着等 */
const TRANSIENT = /Execution context was destroyed|Target (page, context or browser )?(has been )?closed|frame was detached|navigat/i

/**
 * 等页面上出现其中一个（看得见的）：按声明的顺序看，同时出现时取前面的。url=片段 表示网址里包含这一段。
 * 每 200 毫秒看一次当前页面（中途跳转、开了新标签页也跟着看）。超时返回 matched = undefined；定位写错了直接抛错
 */
export async function waitAnyOutcome(
  currentPage: () => Page | undefined,
  outcomes: Record<string, string>,
  timeoutMs: number,
  dialogOpen: (page: Page) => boolean = () => false
): Promise<{ matched?: string; ms: number }> {
  const started = Date.now()
  const entries = Object.entries(outcomes)
  for (;;) {
    const page = currentPage()
    if (page && dialogOpen(page)) throw new Error("页面上开着网页弹框，先用 browser_handle_dialog 处理")
    if (page)
      for (const [name, target] of entries) {
        const text = target.trim()
        if (text.startsWith("url=")) {
          if (page.url().includes(text.slice(4))) return { matched: name, ms: Date.now() - started }
          continue
        }
        try {
          if (await buildLocator(page, text).first().isVisible()) return { matched: name, ms: Date.now() - started }
        } catch (error) {
          if (!TRANSIENT.test((error as Error).message)) throw new Error(`「${name}」的定位 ${text} 有问题：${(error as Error).message.split("\n")[0]}`, { cause: error })
        }
      }
    if (Date.now() - started >= timeoutMs) return { ms: Date.now() - started }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS))
  }
}
