// 工具的写操作：HTTP 接口（可从 cURL 导入）、全局密钥、MCP 服务器。
// 安全：模板（URL、请求头、请求体）、MCP 的命令和地址里出现明文密钥就拒绝保存，要求改成 {{名字}}；
// 密钥值只加密存进 secrets，任何接口都不返回原文。内置工具由引擎在启动时同步，这里不能改、不能删。
import { and, eq, inArray, sql } from "drizzle-orm"
import { hasPlainSecret, moveSecrets, secretNameSchema, notifyChannelSchema, SETTING_KEYS, templatePlaceholders, type HttpSpec, type Risk, type Tool } from "@heyagent/shared"
import { z } from "zod"

import * as t from "../../db/schema.js"
import { assertCan, audit, badRequest, conflict, deleteSecret, findSecret, freeId, notFound, putSecret, slugOf, type DbOrTx, type Tx, type WriteCtx } from "./common.js"
import { usedByText } from "./tasks.js"

// ---------- 被谁用着 ----------

/** 工具被哪些任务、规则、技能用着（删除前检查） */
export async function toolUsage(db: DbOrTx, toolIds: string[]) {
  if (toolIds.length === 0) return { tasks: [], rules: [], skills: [] }
  const [tasks, rules, skills] = await Promise.all([
    db.selectDistinct({ id: t.tasks.id, title: t.tasks.title }).from(t.taskTools).innerJoin(t.tasks, eq(t.tasks.id, t.taskTools.taskId)).where(inArray(t.taskTools.refId, toolIds)),
    db.selectDistinct({ id: t.rules.id, name: t.rules.name }).from(t.ruleTools).innerJoin(t.rules, eq(t.rules.id, t.ruleTools.ruleId)).where(inArray(t.ruleTools.toolId, toolIds)),
    db.selectDistinct({ id: t.skills.id, name: t.skills.name }).from(t.skillTools).innerJoin(t.skills, eq(t.skills.id, t.skillTools.skillId)).where(inArray(t.skillTools.toolId, toolIds)),
  ])
  return { tasks, rules, skills }
}

function usageText(usage: Awaited<ReturnType<typeof toolUsage>>) {
  const parts = [
    usage.tasks.length ? `${usage.tasks.length} 个任务选用了它：${usedByText(usage.tasks)}` : "",
    usage.rules.length ? `规则${usage.rules.map((rule) => `「${rule.name}」`).join("")}命中后会调用它` : "",
    usage.skills.length ? `技能${usage.skills.map((skill) => `「${skill.name}」`).join("")}用到了它` : "",
  ].filter(Boolean)
  return parts.join("；")
}

const inUse = (usage: Awaited<ReturnType<typeof toolUsage>>) => usage.tasks.length + usage.rules.length + usage.skills.length > 0

// ---------- HTTP 接口 ----------

export interface HttpToolFields {
  id?: string
  name: string
  description: string
  summary?: string
  http: { method: HttpSpec["method"]; url: string; headers: Record<string, string>; body?: string }
  risk: Risk
  /** 这次新填的密钥值 */
  secrets: Record<string, string>
}

const headerLines = (headers: Record<string, string>) =>
  Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")
const WHERE_LABEL = { url: "URL", headers: "请求头", body: "请求体" } as const

/** 模板里有明文密钥就拒绝；模板引用的 {{名字}} 要么已经存在服务器上，要么这次填了值 */
async function checkHttpTemplate(db: DbOrTx, input: HttpToolFields) {
  const template = { url: input.http.url, headers: headerLines(input.http.headers), body: input.http.body ?? "" }
  const leaks = moveSecrets(template).moved
  if (leaks.length) {
    const where = [...new Set(leaks.map((leak) => WHERE_LABEL[leak.where]))].join("、")
    throw badRequest(`${where}里有明文密钥（${leaks.map((leak) => `${leak.value.slice(0, 4)}…`).join("、")}），不能直接写在模板里。改成 {{名字}}，值填到「密钥」里。`)
  }
  const { secrets } = templatePlaceholders(`${template.url} ${template.headers} ${template.body}`)
  const invalid = secrets.filter((name) => !secretNameSchema.safeParse(name).success)
  if (invalid.length) throw badRequest(`密钥名只能用大写字母、数字和下划线（NOTIFY_ 开头的留给通知渠道）：${invalid.join("、")}`)
  const missing: string[] = []
  for (const name of secrets) {
    if (input.secrets[name]) continue
    if (!(await findSecret(db, { scope: "http_tool", refId: null, name }))) missing.push(name)
  }
  if (missing.length) throw badRequest(`还没填值：${missing.join("、")}`)
  return secrets
}

function toolSpec(input: HttpToolFields): HttpSpec {
  const headers = Object.keys(input.http.headers).length ? input.http.headers : undefined
  const body = input.http.body?.trim() ? input.http.body : undefined
  return { method: input.http.method, url: input.http.url, ...(headers ? { headers } : {}), ...(body ? { body } : {}) }
}

const summaryOf = (input: HttpToolFields) => input.summary?.trim() || input.description.split(/[。.\n]/)[0]!.slice(0, 200) || input.name

const toolExists = (db: DbOrTx) => async (id: string) => (await db.select({ id: t.tools.id }).from(t.tools).where(eq(t.tools.id, id))).length > 0

async function saveHttpSecrets(tx: Tx, ctx: WriteCtx, used: string[], values: Record<string, string>) {
  const saved: string[] = []
  for (const name of used) {
    const value = values[name]
    if (!value) continue
    await putSecret(tx, ctx.keyring(), { scope: "http_tool", refId: null, name }, value, ctx.actor.id)
    saved.push(name)
  }
  return saved
}

export async function createHttpTool(ctx: WriteCtx, input: HttpToolFields) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能新建工具")
  return ctx.db.transaction(async (tx) => {
    const used = await checkHttpTemplate(tx, input)
    // 模型里的名字：没给就按 URL 路径最后一段生成，例如 …/v2/quotes → http.quotes
    const slug =
      input.http.url
        .split("?")[0]!
        .split("/")
        .slice(3)
        .filter((seg) => /^[\w-]+$/.test(seg))
        .pop()
        ?.toLowerCase() ?? "api"
    const id = await freeId(toolExists(tx), input.id ?? `http.${slug}`)
    await tx.insert(t.tools).values({ id, name: input.name, summary: summaryOf(input), description: input.description, source: "http", http: toolSpec(input), risk: input.risk })
    const secrets = await saveHttpSecrets(tx, ctx, used, input.secrets)
    await audit(tx, ctx.actor.id, "tool.create", "tools", id, { source: "http", name: input.name, secretsSet: secrets })
    return { id }
  })
}

export async function updateHttpTool(ctx: WriteCtx, input: HttpToolFields & { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能修改工具")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.tools).where(eq(t.tools.id, input.id))
    if (!before) throw notFound("工具", input.id)
    if (before.source !== "http") throw badRequest(before.source === "builtin" ? "内置工具由系统提供，不能改" : "MCP 工具要编辑它所在的服务器")
    const used = await checkHttpTemplate(tx, input)
    const http = toolSpec(input)
    await tx.update(t.tools).set({ name: input.name, summary: summaryOf(input), description: input.description, http, risk: input.risk }).where(eq(t.tools.id, input.id))
    const secrets = await saveHttpSecrets(tx, ctx, used, input.secrets)
    const changed = [
      ...(before.name !== input.name ? ["name"] : []),
      ...(before.description !== input.description ? ["description"] : []),
      ...(JSON.stringify(before.http) !== JSON.stringify(http) ? ["http"] : []),
      ...(before.risk !== input.risk ? ["risk"] : []),
    ]
    await audit(tx, ctx.actor.id, "tool.update", "tools", input.id, { changed, secretsSet: secrets })
    return { id: input.id }
  })
}

/** 删除 HTTP 工具：被任务、规则、技能用着的不能删。返回删掉的工具，页面上「撤销」时原样建回来（密钥是全局的，不跟着删） */
export async function deleteHttpTool(ctx: WriteCtx, input: { id: string }): Promise<Tool> {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能删除工具")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.tools).where(eq(t.tools.id, input.id))
    if (!before) throw notFound("工具", input.id)
    if (before.source !== "http") throw badRequest(before.source === "builtin" ? "内置工具由系统提供，不能删" : "MCP 工具要删除它所在的服务器，或者在服务器里取消勾选")
    const usage = await toolUsage(tx, [input.id])
    if (inUse(usage)) throw conflict(`工具「${before.name}」正在被使用：${usageText(usage)}。先去掉这些引用，再删除。`)
    await tx.delete(t.tools).where(eq(t.tools.id, input.id))
    await audit(tx, ctx.actor.id, "tool.delete", "tools", input.id, { name: before.name, source: "http" })
    return { id: before.id, name: before.name, summary: before.summary, description: before.description, source: "http", http: before.http!, risk: before.risk }
  })
}

/** 撤销删除 HTTP 工具 */
export async function restoreHttpTool(ctx: WriteCtx, input: { id: string; name: string; summary: string; description: string; http: HttpSpec; risk: Risk }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能恢复工具")
  return ctx.db.transaction(async (tx) => {
    if (await toolExists(tx)(input.id)) throw conflict(`工具 ${input.id} 已经存在`)
    await tx.insert(t.tools).values({ id: input.id, name: input.name, summary: input.summary, description: input.description, source: "http", http: input.http, risk: input.risk })
    await audit(tx, ctx.actor.id, "tool.restore", "tools", input.id, { name: input.name })
    return { id: input.id }
  })
}

// ---------- 全局密钥（HTTP 模板里的 {{名字}}） ----------

async function secretUsers(db: DbOrTx, name: string) {
  const tools = await db
    .select({ id: t.tools.id, name: t.tools.name })
    .from(t.tools)
    .where(and(eq(t.tools.source, "http"), sql`${t.tools.http}::text like ${`%{{${name}}}%`}`))
  const [setting] = await db.select({ value: t.settings.value }).from(t.settings).where(eq(t.settings.key, SETTING_KEYS.notifyChannels))
  const channels = z.array(notifyChannelSchema).safeParse(setting?.value ?? []).data ?? []
  return { tools, channels: channels.filter((channel) => channel.urlSecretName === name) }
}

export async function createSecret(ctx: WriteCtx, input: { name: string; value: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能管理密钥")
  return ctx.db.transaction(async (tx) => {
    if (await findSecret(tx, { scope: "http_tool", refId: null, name: input.name })) throw conflict(`已经有叫 ${input.name} 的密钥了，要换值请点「改值」`)
    await putSecret(tx, ctx.keyring(), { scope: "http_tool", refId: null, name: input.name }, input.value, ctx.actor.id)
    await audit(tx, ctx.actor.id, "secret.create", "secrets", input.name)
    return { name: input.name }
  })
}

export async function updateSecretValue(ctx: WriteCtx, input: { name: string; value: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能管理密钥")
  return ctx.db.transaction(async (tx) => {
    if (!(await findSecret(tx, { scope: "http_tool", refId: null, name: input.name }))) throw notFound("密钥", input.name)
    await putSecret(tx, ctx.keyring(), { scope: "http_tool", refId: null, name: input.name }, input.value, ctx.actor.id)
    await audit(tx, ctx.actor.id, "secret.update", "secrets", input.name)
    return { name: input.name }
  })
}

/** 删除密钥：还有工具模板或通知渠道引用它时不能删 */
export async function removeSecret(ctx: WriteCtx, input: { name: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能管理密钥")
  return ctx.db.transaction(async (tx) => {
    if (!(await findSecret(tx, { scope: "http_tool", refId: null, name: input.name }))) throw notFound("密钥", input.name)
    const users = await secretUsers(tx, input.name)
    const parts = [
      users.tools.length ? `工具${users.tools.map((tool) => `「${tool.name}」`).join("")}的模板里用了 {{${input.name}}}` : "",
      users.channels.length ? `通知渠道${users.channels.map((channel) => `「${channel.name}」`).join("")}的地址存在这里` : "",
    ].filter(Boolean)
    if (parts.length) throw conflict(`密钥 ${input.name} 正在被使用：${parts.join("；")}。先改掉这些引用，再删除。`)
    await deleteSecret(tx, { scope: "http_tool", refId: null, name: input.name })
    await audit(tx, ctx.actor.id, "secret.delete", "secrets", input.name)
    return { name: input.name }
  })
}

// ---------- MCP 服务器 ----------

export interface McpServerFields {
  name: string
  transport: "stdio" | "http"
  command?: string
  url?: string
  note: string
  env: { name: string; value?: string }[]
  tools?: { id: string; name: string; summary: string; description?: string; risk: Risk }[]
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[A-Za-z0-9-]+$/

function checkMcpFields(input: McpServerFields) {
  const target = input.transport === "stdio" ? input.command : input.url
  if (!target) throw badRequest(input.transport === "stdio" ? "填启动命令" : "填服务地址")
  if (hasPlainSecret(target)) throw badRequest(`${input.transport === "stdio" ? "启动命令" : "服务地址"}里有明文密钥，不能直接写。放进${input.transport === "stdio" ? "环境变量" : "请求头"}，或者写成 {{名字}}。`)
  const pattern = input.transport === "stdio" ? ENV_NAME : HEADER_NAME
  const names = input.env.map((each) => each.name)
  const bad = names.filter((name) => !pattern.test(name))
  if (bad.length) throw badRequest(`${input.transport === "stdio" ? "环境变量名" : "请求头名"}不对：${bad.join("、")}`)
  const dup = names.filter((name, index) => names.indexOf(name) !== index)
  if (dup.length) throw badRequest(`重复了：${[...new Set(dup)].join("、")}`)
  return target
}

/** 环境变量 / 请求头的值：没填的保留已存的值；去掉的行连同密文一起删 */
async function saveMcpEnv(tx: Tx, ctx: WriteCtx, serverId: string, env: McpServerFields["env"], previous: string[]) {
  for (const each of env) {
    const ref = { scope: "mcp_env" as const, refId: serverId, name: each.name }
    if (each.value) await putSecret(tx, ctx.keyring(), ref, each.value, ctx.actor.id)
    else if (!(await findSecret(tx, ref))) throw badRequest(`填 ${each.name} 的值`)
  }
  for (const name of previous) {
    if (!env.some((each) => each.name === name)) await deleteSecret(tx, { scope: "mcp_env", refId: serverId, name })
  }
}

/** 换掉服务器上加入的工具：去掉的工具要没人用才行 */
async function saveMcpTools(tx: Tx, serverId: string, tools: NonNullable<McpServerFields["tools"]>) {
  const ids = tools.map((tool) => tool.id)
  if (new Set(ids).size !== ids.length) throw badRequest("工具名重复了")
  if (ids.length) {
    const taken = await tx
      .select({ id: t.tools.id })
      .from(t.tools)
      .where(and(inArray(t.tools.id, ids), sql`${t.tools.serverId} is distinct from ${serverId}`))
    if (taken.length) throw conflict(`这些工具名已经被别的工具用了：${taken.map((row) => row.id).join("、")}`)
  }
  const existing = (await tx.select({ id: t.tools.id }).from(t.tools).where(eq(t.tools.serverId, serverId))).map((row) => row.id)
  const removed = existing.filter((id) => !ids.includes(id))
  const usage = await toolUsage(tx, removed)
  if (inUse(usage)) throw conflict(`取消勾选的工具还在被使用：${usageText(usage)}。先去掉这些引用。`)
  if (removed.length) await tx.delete(t.tools).where(inArray(t.tools.id, removed))
  for (const [position, tool] of tools.entries()) {
    const values = { name: tool.name, summary: tool.summary || tool.name, description: tool.description || tool.summary || tool.name, risk: tool.risk, position }
    if (existing.includes(tool.id)) await tx.update(t.tools).set(values).where(eq(t.tools.id, tool.id))
    else await tx.insert(t.tools).values({ id: tool.id, ...values, source: "mcp", serverId })
  }
}

export async function createMcpServer(ctx: WriteCtx, input: McpServerFields) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能新建 MCP 服务器")
  return ctx.db.transaction(async (tx) => {
    const target = checkMcpFields(input)
    const id = await freeId(async (each) => (await tx.select({ id: t.mcpServers.id }).from(t.mcpServers).where(eq(t.mcpServers.id, each))).length > 0, `mcp-${slugOf(input.name) || "server"}`)
    await tx.insert(t.mcpServers).values({
      id,
      name: input.name,
      transport: input.transport,
      command: input.transport === "stdio" ? target : null,
      url: input.transport === "http" ? target : null,
      // 还没连过：等「连接并读取工具」（P3 接引擎接口）连上以后改成 connected
      status: "error",
      note: input.note,
      envKeys: input.env.map((each) => each.name),
    })
    await saveMcpEnv(tx, ctx, id, input.env, [])
    if (input.tools) await saveMcpTools(tx, id, input.tools)
    await audit(tx, ctx.actor.id, "mcp_server.create", "mcp_servers", id, { name: input.name, transport: input.transport, env: input.env.map((each) => each.name), tools: input.tools?.map((tool) => tool.id) })
    return { id }
  })
}

export async function updateMcpServer(ctx: WriteCtx, input: McpServerFields & { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能修改 MCP 服务器")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.mcpServers).where(eq(t.mcpServers.id, input.id))
    if (!before) throw notFound("MCP 服务器", input.id)
    const target = checkMcpFields(input)
    // 换了连接方式，之前存的环境变量 / 请求头就对不上了，全部要重新填
    const previous = before.transport === input.transport ? before.envKeys : []
    if (before.transport !== input.transport) {
      for (const name of before.envKeys) await deleteSecret(tx, { scope: "mcp_env", refId: input.id, name })
    }
    await tx
      .update(t.mcpServers)
      .set({
        name: input.name,
        transport: input.transport,
        command: input.transport === "stdio" ? target : null,
        url: input.transport === "http" ? target : null,
        note: input.note,
        envKeys: input.env.map((each) => each.name),
      })
      .where(eq(t.mcpServers.id, input.id))
    await saveMcpEnv(tx, ctx, input.id, input.env, previous)
    if (input.tools) await saveMcpTools(tx, input.id, input.tools)
    await audit(tx, ctx.actor.id, "mcp_server.update", "mcp_servers", input.id, { env: input.env.map((each) => ({ name: each.name, changed: Boolean(each.value) })), tools: input.tools?.map((tool) => tool.id) })
    return { id: input.id }
  })
}

/** 删除 MCP 服务器：它的工具被用着就不能删；删除时连同环境变量的密文一起删 */
export async function deleteMcpServer(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能删除 MCP 服务器")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.mcpServers).where(eq(t.mcpServers.id, input.id))
    if (!before) throw notFound("MCP 服务器", input.id)
    const toolIds = (await tx.select({ id: t.tools.id }).from(t.tools).where(eq(t.tools.serverId, input.id))).map((row) => row.id)
    const usage = await toolUsage(tx, toolIds)
    if (inUse(usage)) throw conflict(`服务器「${before.name}」的工具正在被使用：${usageText(usage)}。先去掉这些引用，再删除。`)
    await tx.delete(t.secrets).where(and(eq(t.secrets.scope, "mcp_env"), eq(t.secrets.refId, input.id)))
    await tx.delete(t.mcpServers).where(eq(t.mcpServers.id, input.id))
    await audit(tx, ctx.actor.id, "mcp_server.delete", "mcp_servers", input.id, { name: before.name, tools: toolIds })
    return { id: input.id }
  })
}
