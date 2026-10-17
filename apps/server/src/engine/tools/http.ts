// HTTP 工具：照工具配置里的模板发请求。
// - {参数} 由模型填（URL 里做 URL 编码，JSON 请求体的字符串里做 JSON 转义）；
// - {{名字}} 执行时从 secrets 解密替换，模型永远看不到原文；返回里出现密钥原文换成 [已隐藏]；
// - 模板只扫一遍：模型填进来的值里就算写了 {{名字}} 也不会被替换成密钥。
import type { HttpSpec } from "@heyagent/shared"
import { z } from "zod"

import type { DbLike } from "../records.js"
import { runtime } from "../runtime.js"
import {
  loadGlobalSecrets,
  MissingSecretError,
  redactSecrets,
  secretNamesIn,
} from "../secrets.js"
import type { ToolOutcome } from "./builtin.js"

const TOKEN = /\{\{\s*([^{}\s]+)\s*\}\}|\{([^{}\s]+)\}/g

/** 模板里由模型填的参数名（按出现顺序去重） */
export function httpParams(spec: HttpSpec): string[] {
  const texts = [
    spec.url,
    ...Object.entries(spec.headers ?? {}).flat(),
    spec.body ?? "",
  ]
  const names: string[] = []
  for (const text of texts)
    for (const match of text.matchAll(TOKEN))
      if (match[2] && !names.includes(match[2])) names.push(match[2])
  return names
}

/** 参数名在 JSON Schema 里的键：模型厂商只认字母数字下划线，中文等名字换成 p1、p2，原名写进说明 */
export function httpParamKeys(spec: HttpSpec): { name: string; key: string }[] {
  return httpParams(spec).map((name, index) => ({
    name,
    key: /^[A-Za-z0-9_]{1,64}$/.test(name) ? name : `p${index + 1}`,
  }))
}

export function httpInputSchema(spec: HttpSpec) {
  const keys = httpParamKeys(spec)
  const jsonSchema = {
    type: "object",
    properties: Object.fromEntries(
      keys.map(({ name, key }) => [
        key,
        {
          type: "string",
          description:
            key === name
              ? `模板里的 {${name}}`
              : `模板里的 {${name}}（${name}）`,
        },
      ])
    ),
    required: keys.map(({ key }) => key),
    additionalProperties: false,
  }
  const validator = z
    .object(
      Object.fromEntries(
        keys.map(({ key }) => [
          key,
          z.union([z.string(), z.number(), z.boolean()]).transform(String),
        ])
      )
    )
    .strict()
  return { jsonSchema, validator }
}

type Encode = "url" | "json" | "raw"

function render(
  template: string,
  params: Map<string, string>,
  secrets: Map<string, string>,
  encode: Encode,
  used: Set<string>
): string {
  return template.replace(
    TOKEN,
    (whole, secretName: string | undefined, paramName: string | undefined) => {
      if (secretName) {
        const value = secrets.get(secretName)
        if (value === undefined)
          throw new MissingSecretError(
            `密钥 ${secretName} 还没有存，请先在「工具」页保存`
          )
        used.add(value)
        return value
      }
      const value = params.get(paramName!)
      if (value === undefined) return whole
      if (encode === "url") return encodeURIComponent(value)
      if (encode === "json") return JSON.stringify(value).slice(1, -1)
      return value
    }
  )
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

export async function executeHttpTool(
  db: DbLike,
  spec: HttpSpec,
  input: Record<string, string>
): Promise<ToolOutcome> {
  const keys = httpParamKeys(spec)
  const params = new Map(keys.map(({ name, key }) => [name, input[key] ?? ""]))
  const allTemplates = [
    spec.url,
    ...Object.entries(spec.headers ?? {}).flat(),
    spec.body ?? "",
  ].join("\n")
  const secrets = await loadGlobalSecrets(db, secretNamesIn(allTemplates))
  const used = new Set<string>()
  try {
    const url = render(spec.url, params, secrets, "url", used)
    const headers: Record<string, string> = {}
    for (const [name, value] of Object.entries(spec.headers ?? {}))
      headers[render(name, params, secrets, "raw", used)] = render(
        value,
        params,
        secrets,
        "raw",
        used
      )
    const jsonBody = spec.body !== undefined && /^\s*[[{]/.test(spec.body)
    const body =
      spec.method === "GET" || spec.body === undefined
        ? undefined
        : render(spec.body, params, secrets, jsonBody ? "json" : "raw", used)
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
    return { output, isError: res.status >= 400, secrets: all }
  } catch (error) {
    const message =
      error instanceof MissingSecretError
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
