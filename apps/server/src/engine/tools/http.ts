// HTTP 工具：照工具配置里的模板发请求。
// - {参数} 由模型填（URL 里做 URL 编码；JSON 请求体的字符串里做 JSON 转义，字符串外面填成 JSON 值：
//   json 类型原样放进去，string 类型填成带引号的 JSON 字符串）；
// - {{名字}} 执行时从 secrets 解密替换，模型永远看不到原文；返回里出现密钥原文换成 [已隐藏]；
// - 模板只扫一遍：模型填进来的值里就算写了 {{名字}} 也不会被替换成密钥；
// - JSON 请求体填好以后一定先解析一遍，不是合法 JSON 就不发，报错说清是哪个参数附近、贴出那一段。
import {
  httpParamsOf,
  isJsonBody,
  scanTemplate,
  type HttpParam,
  type HttpSpec,
  type HttpTemplatePart,
} from "@heyagent/shared"
import { z } from "zod"

import type { DbLike } from "../records.js"
import { runtime } from "../runtime.js"
import {
  HIDDEN,
  loadGlobalSecrets,
  MissingSecretError,
  redactSecrets,
  secretNamesIn,
} from "../secrets.js"
import type { ToolOutcome } from "./builtin.js"

/** 参数名在 JSON Schema 里的键：模型厂商只认字母数字下划线，中文等名字换成 p1、p2，原名写进说明 */
export function httpParamKeys(
  spec: HttpSpec
): { param: HttpParam; name: string; key: string }[] {
  return httpParamsOf(spec).map((param, index) => ({
    param,
    name: param.name,
    key: /^[A-Za-z0-9_]{1,64}$/.test(param.name) ? param.name : `p${index + 1}`,
  }))
}

/**
 * json 类型的值：模型把 JSON 写成了字符串就解析回来；像数组、对象却解析不了的拒绝；别的字符串当 JSON 字符串。
 * z.unknown() 本身允许缺这个键：必填的要自己查
 */
const jsonValue = (required: boolean) =>
  z.unknown().transform((value, ctx) => {
    if (value === undefined && required) {
      ctx.addIssue({ code: "custom", message: "必填" })
      return z.NEVER
    }
    if (typeof value !== "string") return value
    try {
      return JSON.parse(value) as unknown
    } catch (error) {
      if (/^\s*[[{]/.test(value)) {
        ctx.addIssue({
          code: "custom",
          message: `不是合法 JSON：${(error as Error).message}。直接传 JSON 值（数组、对象），不要写成字符串`,
        })
        return z.NEVER
      }
      return value
    }
  })

const stringValue = z
  .union([z.string(), z.number(), z.boolean()])
  .transform(String)

function paramDescription(param: HttpParam, name: string, key: string) {
  return [
    key === name ? `模板里的 {${name}}` : `模板里的 {${name}}（${name}）`,
    param.type === "json"
      ? "直接传 JSON 值（数组、对象、数字、true/false、null），不要先转成字符串"
      : "",
    param.description ?? "",
    param.required ? "" : "可以不传",
  ]
    .filter(Boolean)
    .join("。")
}

export function httpInputSchema(spec: HttpSpec) {
  const keys = httpParamKeys(spec)
  const jsonSchema = {
    type: "object",
    properties: Object.fromEntries(
      keys.map(({ param, name, key }) => [
        key,
        {
          ...(param.type === "string" ? { type: "string" } : {}),
          description: paramDescription(param, name, key),
        },
      ])
    ),
    required: keys.filter(({ param }) => param.required).map(({ key }) => key),
    additionalProperties: false,
  }
  const validator = z
    .object(
      Object.fromEntries(
        keys.map(({ param, key }) => {
          const value =
            param.type === "json" ? jsonValue(param.required) : stringValue
          return [key, param.required ? value : value.nullable().optional()]
        })
      )
    )
    .strict()
  return { jsonSchema, validator }
}

/** 可选参数没传、要整段去掉时先填进去的记号：JSON 解析以后去掉含它的字段 / 数组项，URL 去掉那个查询参数，请求头去掉那一行 */
const OMIT = "\u0000HEYAGENT_OMIT\u0000"
/** OMIT 在 JSON 字符串里的写法（\u0000 转义） */
const OMIT_ESCAPED = JSON.stringify(OMIT).slice(1, -1)

interface Fill {
  param: HttpParam
  present: boolean
  value: unknown
}

/** 填进去的一段（报 JSON 错时找是哪个参数附近；贴片段时把密钥那段换成 [已隐藏]） */
interface Span {
  start: number
  end: number
  /** 在模板里的位置（报保存时的错用） */
  from: number
  to: number
  label: string
  secret: boolean
}

interface Rendered {
  text: string
  spans: Span[]
  omitted: boolean
}

type Mode = "url" | "header" | "json" | "raw"

/** 参数值的文字：string 原样，json 是它的 JSON 文本 */
const textOf = (fill: Fill) =>
  fill.param.type === "json"
    ? (JSON.stringify(fill.value) ?? "null")
    : String(fill.value)

function render(
  template: string,
  part: HttpTemplatePart,
  mode: Mode,
  fills: Map<string, Fill>,
  secrets: Map<string, string>,
  used: Set<string>
): Rendered {
  let text = ""
  let last = 0
  let omitted = false
  const spans: Span[] = []
  for (const each of scanTemplate(template, part, mode === "json")) {
    text += template.slice(last, each.index)
    last = each.index + each.length
    let piece: string
    if (each.kind === "secret") {
      const value = secrets.get(each.name)
      if (value === undefined)
        throw new MissingSecretError(
          `密钥 ${each.name} 还没有存，请先在「工具」页保存`
        )
      used.add(value)
      piece =
        mode === "json" && each.inString
          ? JSON.stringify(value).slice(1, -1)
          : value
    } else {
      const fill = fills.get(each.name)
      if (!fill) piece = ""
      else if (!fill.present && fill.param.omitIfAbsent) {
        omitted = true
        piece =
          mode !== "json"
            ? OMIT
            : each.inString
              ? OMIT_ESCAPED
              : JSON.stringify(OMIT)
      } else if (!fill.present)
        piece =
          mode === "json" && !each.inString
            ? fill.param.type === "json"
              ? "null"
              : '""'
            : ""
      else if (mode === "url") piece = encodeURIComponent(textOf(fill))
      else if (mode === "json")
        piece = each.inString
          ? JSON.stringify(textOf(fill)).slice(1, -1)
          : fill.param.type === "json"
            ? textOf(fill)
            : JSON.stringify(String(fill.value))
      else piece = textOf(fill)
    }
    spans.push({
      start: text.length,
      end: text.length + piece.length,
      from: each.index,
      to: last,
      label: each.kind === "secret" ? `{{${each.name}}}` : `{${each.name}}`,
      secret: each.kind === "secret",
    })
    text += piece
  }
  return { text: text + template.slice(last), spans, omitted }
}

/** URL 里去掉没传的可选参数：查询串里整个 key=… 去掉，路径里（保存时就不让）填空 */
function dropOmittedFromUrl(url: string) {
  if (!url.includes(OMIT)) return url
  const hash = url.indexOf("#")
  const fragment = hash >= 0 ? url.slice(hash) : ""
  const rest = hash >= 0 ? url.slice(0, hash) : url
  const mark = rest.indexOf("?")
  if (mark < 0) return rest.split(OMIT).join("") + fragment
  const path = rest.slice(0, mark).split(OMIT).join("")
  const query = rest
    .slice(mark + 1)
    .split("&")
    .filter((pair) => !pair.includes(OMIT))
    .join("&")
  return `${path}${query ? `?${query}` : ""}${fragment}`
}

const hasOmit = (value: unknown) =>
  typeof value === "string" && value.includes(OMIT)

/** 去掉含记号的字段（键或字符串值里有）和数组项 */
function stripOmitted(value: unknown): unknown {
  if (Array.isArray(value))
    return value.filter((item) => !hasOmit(item)).map(stripOmitted)
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([key, item]) => !key.includes(OMIT) && !hasOmit(item))
        .map(([key, item]) => [key, stripOmitted(item)])
    )
  return value
}

/** 第一个不合 JSON 语法的位置（JSON.parse 的报错有时不带位置）；合法返回 -1 */
export function jsonErrorPosition(text: string): number {
  let i = 0
  const ws = () => {
    while (i < text.length && " \t\n\r".includes(text[i]!)) i++
  }
  const fail = (): never => {
    throw new JsonSyntaxAt(i)
  }
  const literal = (re: RegExp) => {
    re.lastIndex = i
    if (!re.exec(text)) fail()
    i = re.lastIndex
  }
  const string = () => {
    i++
    while (i < text.length) {
      const ch = text[i]!
      if (ch === '"') {
        i++
        return
      }
      if (ch === "\\") literal(/\\(?:["\\/bfnrt]|u[0-9a-fA-F]{4})/y)
      else if (ch < " ") fail()
      else i++
    }
    fail()
  }
  const value = (): void => {
    ws()
    const ch = text[i]
    if (ch === "{" || ch === "[") {
      const close = ch === "{" ? "}" : "]"
      i++
      ws()
      if (text[i] === close) {
        i++
        return
      }
      for (;;) {
        if (ch === "{") {
          ws()
          if (text[i] !== '"') fail()
          string()
          ws()
          if (text[i] !== ":") fail()
          i++
        }
        value()
        ws()
        if (text[i] === ",") i++
        else if (text[i] === close) {
          i++
          return
        } else fail()
      }
    }
    if (ch === '"') return string()
    literal(/-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y)
  }
  try {
    value()
    ws()
    if (i < text.length) fail()
    return -1
  } catch (error) {
    if (error instanceof JsonSyntaxAt) return error.at
    return -1
  }
}

class JsonSyntaxAt {
  readonly at: number
  constructor(at: number) {
    this.at = at
  }
}

/** 出错位置前后约 80 字；碰到密钥的那段整段换成 [已隐藏]（不会只切掉半个密钥漏出另一半） */
function snippetAround(rendered: Rendered, at: number) {
  const { text } = rendered
  let from = Math.max(0, at - 40)
  let to = Math.min(text.length, at + 40)
  const hidden: Span[] = []
  for (const span of rendered.spans) {
    if (!span.secret || span.end <= from || span.start >= to) continue
    from = Math.min(from, span.start)
    to = Math.max(to, span.end)
    hidden.push(span)
  }
  let out = ""
  let cursor = from
  for (const span of hidden) {
    out += text.slice(cursor, span.start) + HIDDEN
    cursor = span.end
  }
  out += text.slice(cursor, to)
  return `${from > 0 ? "…" : ""}${out}${to < text.length ? "…" : ""}`
}

/** JSON 解析出错的位置、是哪个占位符填进去的内容（或附近）、解析报错 */
function locateJsonError(rendered: Rendered, error: Error) {
  const reported = /at position (\d+)/.exec(error.message)
  const found = jsonErrorPosition(rendered.text)
  const at =
    found >= 0 ? found : reported ? Number(reported[1]) : rendered.text.length
  const covering = rendered.spans.find(
    (span) => span.start <= at && at < Math.max(span.end, span.start + 1)
  )
  const near = covering
    ? undefined
    : rendered.spans
        .map((span) => ({
          span,
          distance: at < span.start ? span.start - at : at - span.end,
        }))
        .filter(({ distance }) => distance <= 20)
        .sort((a, b) => a.distance - b.distance)[0]?.span
  // V8 的报错里会带一小段原文（可能切到密钥）和位置（按填好的文字算，和上面说的第几个字符对不上），去掉
  const reason = error.message
    .replace(/,\s*(?:\.\.\.)?".*"(?:\.\.\.)? is not valid JSON$/s, "")
    .replace(/\s*in JSON at position \d+.*$/s, "")
    .trim()
  return { at, covering, near, reason }
}

/** 填好的请求体不是合法 JSON 时的说明：哪个参数附近、解析报错、那一段 */
function jsonBodyError(rendered: Rendered, error: Error) {
  const { at, covering, near, reason } = locateJsonError(rendered, error)
  const where = covering
    ? `出错的地方在 ${covering.label} 填进去的内容里`
    : near
      ? `出错的地方在 ${near.label} 填进去的内容附近`
      : "出错的地方不在填进去的参数里，多半是请求体模板本身写错了"
  return `请求体填上参数以后不是合法 JSON，没有发出去。${where}（第 ${at + 1} 个字符，${reason}）。那一段：${snippetAround(rendered, at)}`
}

/**
 * 保存时检查 JSON 请求体模板：参数填上样子值（文本 "x"、JSON null）、密钥填 0，看能不能解析。
 * 能就返回 undefined，不能返回说明（位置按模板算，贴的是模板里的那一段，模板里没有密钥原文）
 */
export function checkJsonBodyTemplate(spec: HttpSpec): string | undefined {
  if (!isJsonBody(spec.body)) return undefined
  const fills = new Map(
    httpParamsOf(spec).map((param): [string, Fill] => [
      param.name,
      { param, present: true, value: param.type === "json" ? null : "x" },
    ])
  )
  const secrets = new Map(
    scanTemplate(spec.body, "body")
      .filter((each) => each.kind === "secret")
      .map((each): [string, string] => [each.name, "0"])
  )
  const rendered = render(spec.body, "body", "json", fills, secrets, new Set())
  try {
    JSON.parse(rendered.text)
    return undefined
  } catch (error) {
    const { at, covering, reason } = locateJsonError(rendered, error as Error)
    // 换回模板里的位置：落在占位符里就算占位符开头
    let offset = 0
    let pos: number | undefined
    for (const span of rendered.spans) {
      if (at < span.start) break
      if (at < span.end) {
        pos = span.from
        break
      }
      offset += span.end - span.start - (span.to - span.from)
    }
    pos ??= at - offset
    const body = spec.body
    const from = Math.max(0, pos - 40)
    const to = Math.min(body.length, pos + 40)
    // 只说落在哪个占位符上；「附近」在模板里多半是模板本身的错，不提参数免得误导
    const label = covering?.label
    return `请求体模板填上参数以后不是合法 JSON：第 ${pos + 1} 个字符附近${label ? `（${label} 那里）` : ""}，${reason}。那一段：${from > 0 ? "…" : ""}${body.slice(from, to)}${to < body.length ? "…" : ""}`
  }
}

async function readCapped(
  res: Response,
  max: number
): Promise<{ text: string; truncated: boolean }> {
  if (!res.body) return { text: "", truncated: false }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > max) {
      chunks.push(value.subarray(0, value.length - (size - max)))
      truncated = true
      await reader.cancel().catch(() => {})
      break
    }
    chunks.push(value)
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated }
}

class BodyError extends Error {}

export async function executeHttpTool(
  db: DbLike,
  spec: HttpSpec,
  input: Record<string, unknown>
): Promise<ToolOutcome> {
  const fills = new Map(
    httpParamKeys(spec).map(({ param, key }): [string, Fill] => {
      const value = input[key]
      // 可选参数传 null 也算没传（有的模型对可选字段一律填 null）
      const present =
        value !== undefined && !(value === null && !param.required)
      return [param.name, { param, present, value: present ? value : "" }]
    })
  )
  const allTemplates = [
    spec.url,
    ...Object.entries(spec.headers ?? {}).flat(),
    spec.body ?? "",
  ].join("\n")
  const secrets = await loadGlobalSecrets(db, secretNamesIn(allTemplates))
  const used = new Set<string>()
  try {
    const url = dropOmittedFromUrl(
      render(spec.url, "url", "url", fills, secrets, used).text
    )
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(spec.headers ?? {})) {
      const key = render(name, "header", "header", fills, secrets, used).text
      const text = render(value, "header", "header", fills, secrets, used).text
      if (key.includes(OMIT) || text.includes(OMIT)) continue
      headers[key] = text
    }
    const jsonBody = isJsonBody(spec.body)
    let body: string | undefined
    if (spec.method !== "GET" && spec.body !== undefined) {
      const rendered = render(
        spec.body,
        "body",
        jsonBody ? "json" : "raw",
        fills,
        secrets,
        used
      )
      body = rendered.text
      if (jsonBody) {
        let parsed: unknown
        try {
          parsed = JSON.parse(body)
        } catch (error) {
          throw new BodyError(jsonBodyError(rendered, error as Error))
        }
        // 只有去掉了字段才重新生成（否则原样发，保留模板的格式）
        if (rendered.omitted) body = JSON.stringify(stripOmitted(parsed))
      } else if (rendered.omitted) body = body.split(OMIT).join("")
    }
    if (
      body !== undefined &&
      jsonBody &&
      !Object.keys(headers).some(
        (name) => name.toLowerCase() === "content-type"
      )
    )
      headers["content-type"] = "application/json"
    const res = await fetch(url, {
      method: spec.method,
      headers,
      body,
      redirect: "follow",
      signal: AbortSignal.timeout(runtime.httpTimeoutMs),
    })
    const { text, truncated } = await readCapped(res, runtime.httpMaxBytes)
    const all = [...secrets.values()]
    const output = redactSecrets(
      `HTTP ${res.status}${truncated ? `（返回超过 ${runtime.httpMaxBytes} 字节，后面的截掉了）` : ""}\n${text}`,
      all
    )
    // 返回的是 JSON：解析过的对象放进 data（固化脚本的 ha.tool 优先拿它，docs/dev/solidify.md 4.4）；截断了的不完整，不给
    const data = truncated ? undefined : jsonData(text, all)
    return { output, isError: res.status >= 400, secrets: all, ...(data !== undefined ? { data } : {}) }
  } catch (error) {
    const message =
      error instanceof MissingSecretError || error instanceof BodyError
        ? error.message
        : (error as Error).name === "TimeoutError"
          ? `请求超时（${runtime.httpTimeoutMs / 1000} 秒）`
          : `请求失败：${(error as Error).message}`
    return {
      output: redactSecrets(message, used),
      isError: true,
      secrets: [...used],
    }
  }
}

/** 返回体是 JSON 就解析（先把密钥原文换成 [已隐藏]，和 output 一样不带密钥）；不是 JSON 返回 undefined */
function jsonData(text: string, secrets: string[]): unknown {
  const trimmed = text.trim()
  if (!trimmed || !"{[".includes(trimmed[0]!)) return undefined
  try {
    return JSON.parse(redactSecrets(trimmed, secrets)) as unknown
  } catch {
    return undefined
  }
}

/** 填好参数的 URL（规则查白名单用）：密钥不换，可选参数没传的去掉；input 的键是给模型的键（httpParamKeys） */
export function httpUrlOf(spec: HttpSpec, input: Record<string, unknown>) {
  const fills = new Map(
    httpParamKeys(spec).map(({ param, key }): [string, Fill] => {
      const value = input[key]
      const present = value !== undefined && value !== null
      return [param.name, { param, present, value: present ? value : "" }]
    })
  )
  const kept = scanTemplate(spec.url, "url")
    .filter((each) => each.kind === "secret")
    .map((each): [string, string] => [each.name, `{{${each.name}}}`])
  return dropOmittedFromUrl(
    render(spec.url, "url", "url", fills, new Map(kept), new Set()).text
  )
}
