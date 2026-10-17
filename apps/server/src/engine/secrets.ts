// 密钥：执行时才解密，模型永远只看到 {{名字}}；工具返回里出现原文就换成 [已隐藏]。
import { and, eq, inArray, isNull } from "drizzle-orm"

import * as t from "../db/schema.js"
import { decryptText } from "../lib/crypto.js"
import type { DbLike } from "./records.js"
import { getKeyring } from "./runtime.js"

export const HIDDEN = "[已隐藏]"

/** 模板里的 {{名字}}（名字里不能有花括号和空白） */
const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g

export function secretNamesIn(text: string): string[] {
  return [...text.matchAll(PLACEHOLDER)].map((match) => match[1]!)
}

function decryptRow(row: typeof t.secrets.$inferSelect): string {
  return decryptText(getKeyring(), row.enc, {
    table: "secrets",
    id: row.id,
    version: row.version,
  })
}

/** 全局密钥（HTTP 工具、通知渠道、{{名字}} 引用的都在这里：scope = http_tool，ref_id 为空） */
export async function loadGlobalSecrets(
  db: DbLike,
  names: string[]
): Promise<Map<string, string>> {
  const unique = [...new Set(names)]
  if (unique.length === 0) return new Map()
  const rows = await db
    .select()
    .from(t.secrets)
    .where(
      and(
        eq(t.secrets.scope, "http_tool"),
        isNull(t.secrets.refId),
        inArray(t.secrets.name, unique)
      )
    )
  return new Map(rows.map((row) => [row.name, decryptRow(row)]))
}

/** 某个对象自己的密钥，例如 MCP 服务器的环境变量（scope = mcp_env，ref_id = 服务器 id） */
export async function loadScopedSecrets(
  db: DbLike,
  scope: (typeof t.secretScopeEnum.enumValues)[number],
  refId: string
): Promise<Map<string, string>> {
  const rows = await db
    .select()
    .from(t.secrets)
    .where(and(eq(t.secrets.scope, scope), eq(t.secrets.refId, refId)))
  return new Map(rows.map((row) => [row.name, decryptRow(row)]))
}

export async function loadSecretById(
  db: DbLike,
  id: string
): Promise<string | undefined> {
  const [row] = await db.select().from(t.secrets).where(eq(t.secrets.id, id))
  return row ? decryptRow(row) : undefined
}

export class MissingSecretError extends Error {}

/** 把 {{名字}} 换成密钥原文；用到了没存的密钥就报错（不把占位符原样发出去） */
export function fillSecrets(
  template: string,
  values: Map<string, string>,
  used?: Set<string>
): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const value = values.get(name)
    if (value === undefined)
      throw new MissingSecretError(
        `密钥 ${name} 还没有存，请先在「工具」页保存`
      )
    used?.add(value)
    return value
  })
}

/** 把文本里出现的密钥原文（包括 URL 编码、base64 的写法）换成 [已隐藏] */
export function redactSecrets(text: string, values: Iterable<string>): string {
  let result = text
  for (const value of values) {
    if (value.length < 4) continue
    const forms = new Set([
      value,
      encodeURIComponent(value),
      Buffer.from(value).toString("base64"),
      JSON.stringify(value).slice(1, -1),
    ])
    for (const form of forms)
      if (form.length >= 4) result = result.split(form).join(HIDDEN)
  }
  return result
}
