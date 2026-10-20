// HTTP 工具模板里的占位符：{参数} 由模型填，{{密钥}} 执行时从服务器上的密钥换进去。
// 服务器（保存时校验、执行时填值）和页面（参数清单）都用这里的同一套认法，免得两边认出来的不一样。
import type { HttpParam, HttpSpec } from "./schemas.js"

/** {{密钥}} 或 {参数}。参数名只能是字母（含中文）、数字和 _ . -，所以 JSON 里的 {"a":1} 不会被当成参数 */
export const HTTP_PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}|\{\s*([\p{L}\p{N}_.-]+)\s*\}/gu

export type HttpTemplatePart = "url" | "header" | "body"

export interface HttpPlaceholder {
  kind: "param" | "secret"
  name: string
  part: HttpTemplatePart
  /** 在这段文字里的位置（url、某个请求头的名或值、body） */
  index: number
  length: number
  /** 请求头：哪一个（名字） */
  header?: string
  /** 只对 JSON 请求体有意义：在 JSON 字符串字面量里面（"…{x}…"）还是外面（"a":{x}） */
  inString: boolean
}

type Template = Pick<HttpSpec, "url" | "headers" | "body">

/** 请求体是不是 JSON：去掉开头空白后以 { 或 [ 开头 */
export const isJsonBody = (body: string | undefined): body is string => body !== undefined && /^\s*[[{]/.test(body)

/**
 * 扫一段模板文字里的占位符。json = true 时顺带记下每个占位符在不在 JSON 字符串里（按引号和反斜杠转义走一遍）。
 * 占位符本身不含引号，不影响字符串的进出
 */
export function scanTemplate(text: string, part: HttpTemplatePart, json = false, header?: string): HttpPlaceholder[] {
  const found: HttpPlaceholder[] = []
  const re = new RegExp(HTTP_PLACEHOLDER.source, "uy")
  let inString = false
  for (let i = 0; i < text.length; ) {
    re.lastIndex = i
    const match = re.exec(text)
    if (match) {
      found.push({
        kind: match[1] ? "secret" : "param",
        name: (match[1] ?? match[2])!,
        part,
        index: i,
        length: match[0].length,
        ...(header !== undefined ? { header } : {}),
        inString: json && inString,
      })
      i += match[0].length
      continue
    }
    const ch = text[i]
    if (json && inString && ch === "\\") i += 2
    else {
      if (json && ch === '"') inString = !inString
      i += 1
    }
  }
  return found
}

/** 整个工具模板（URL、请求头的名和值、请求体）里的占位符，按出现顺序 */
export function scanHttpTemplate(spec: Template): HttpPlaceholder[] {
  return [
    ...scanTemplate(spec.url, "url"),
    ...Object.entries(spec.headers ?? {}).flatMap(([name, value]) => [...scanTemplate(name, "header", false, name), ...scanTemplate(value, "header", false, name)]),
    ...(spec.body !== undefined ? scanTemplate(spec.body, "body", isJsonBody(spec.body)) : []),
  ]
}

/** 模板里的参数名（按出现顺序去重） */
export function httpParamNames(spec: Template): string[] {
  return [...new Set(scanHttpTemplate(spec).filter((each) => each.kind === "param").map((each) => each.name))]
}

/** 一个参数按模板推出来的默认设置：在 JSON 请求体的字符串外面出现过就是 json，否则 string；默认必填 */
export function defaultHttpParam(spec: Template, name: string): HttpParam {
  const json = isJsonBody(spec.body)
  const raw = scanHttpTemplate(spec).some((each) => each.kind === "param" && each.name === name && each.part === "body" && json && !each.inString)
  return { name, type: raw ? "json" : "string", required: true }
}

export interface HttpParamSync {
  /** 按模板重建好的清单（模板里的顺序；declared 里同名的设置沿用） */
  params: HttpParam[]
  /** 模板里有、declared 里没有 */
  missing: string[]
  /** declared 里有、模板里没有 */
  extra: string[]
}

/**
 * 按模板重建参数清单：模板里每个 {名字} 一项，declared 里同名的沿用它的类型、必填、说明；
 * 模板里没有的去掉。missing / extra 给保存时提示（页面、接口传了清单就要和模板一致）
 */
export function syncHttpParams(spec: Template, declared: readonly HttpParam[] = []): HttpParamSync {
  const names = httpParamNames(spec)
  const byName = new Map(declared.map((param) => [param.name, param]))
  return {
    params: names.map((name) => {
      const param = byName.get(name)
      if (!param) return defaultHttpParam(spec, name)
      const required = param.required ?? true
      const description = param.description?.trim()
      return { name, type: param.type, required, ...(!required && param.omitIfAbsent ? { omitIfAbsent: true } : {}), ...(description ? { description } : {}) }
    }),
    missing: names.filter((name) => !byName.has(name)),
    extra: [...new Set(declared.map((param) => param.name))].filter((name) => !names.includes(name)),
  }
}

/** 工具实际用的参数清单：存了就用存的（再按模板对一遍），旧数据没存就按模板推 */
export const httpParamsOf = (spec: HttpSpec): HttpParam[] => syncHttpParams(spec, spec.params ?? []).params
