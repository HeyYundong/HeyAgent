// 用存的账号密码自动登录：一个只会登录的小 agent。浏览器页「立刻登录」和运行中遇到登录页都用它。
// - 模型只看到 {{username}}、{{password}} 两个占位符，调工具填进网页时才换成真的；工具返回里出现密码原文换成 [已隐藏]；
// - 密码只填到这个账号的平台域名、登录网址所在的网站上，别的网站一律拒绝（防止被引到别处把密码填出去）；
// - 遇到验证码、短信码、扫码等要人的，模型调 login_need_human，或者检测到验证码页，就停下交给人；步数用完算失败。
import { and, eq } from "drizzle-orm"
import { hostMatches, hostOf } from "@heyagent/shared"
import { jsonSchema, tool, type ModelMessage, type ToolResultPart, type ToolSet } from "ai"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { callModel, resolveModel } from "../engine/model.js"
import type { ToolOutcome } from "../engine/tools/builtin.js"
import { executeMcpTool, type McpConnection } from "../engine/tools/mcp.js"
import { decryptText, type Keyring } from "../lib/crypto.js"
import type { BrowserInstance } from "./instance.js"
import type { PlatformAccount } from "./leases.js"
import { listBrowserMcpTools } from "./mcp.js"

/** 登录用得到的浏览器工具（Playwright MCP 的名字） */
const LOGIN_TOOLS = new Set([
  "browser_snapshot",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_press_key",
  "browser_select_option",
  "browser_hover",
  "browser_wait_for",
  "browser_navigate",
  "browser_navigate_back",
  "browser_handle_dialog",
])
/** 只读、不改页面的：调完不用查验证码 */
const READ_ONLY = new Set(["browser_snapshot", "browser_wait_for"])
const DONE_TOOL = "login_done"
const HUMAN_TOOL = "login_need_human"
export const AUTO_LOGIN_MAX_STEPS = 15
/** 模型没调工具、只回了话：提醒几次 */
const MAX_NUDGES = 2
const USERNAME = /\{\{\s*username\s*\}\}/g
const PASSWORD = /\{\{\s*password\s*\}\}/g

export interface AutoLoginResult {
  ok: boolean
  /** 要人处理（验证码、短信码、扫码、账号密码不对……），detail 写原因 */
  needHuman: boolean
  detail: string
  steps: number
  tokensIn: number
  tokensOut: number
  costUsd: number
}

/** 账号存的登录密码（解密）；没存返回 undefined */
export async function loadAccountPassword(db: Db, keyring: Keyring, accountId: string): Promise<string | undefined> {
  const [row] = await db
    .select()
    .from(t.secrets)
    .where(and(eq(t.secrets.scope, "browser_account"), eq(t.secrets.refId, accountId), eq(t.secrets.name, "password")))
  return row ? decryptText(keyring, row.enc, { table: "secrets", id: row.id, version: row.version }) : undefined
}

/** 自动登录用哪个模型：「模型」页的默认执行模型 */
export async function loginModelId(db: Db): Promise<string | undefined> {
  const [row] = await db.select({ modelId: t.modelDefaults.modelId }).from(t.modelDefaults).where(eq(t.modelDefaults.role, "run"))
  return row?.modelId
}

/** 密码能填到哪些网站：平台域名 + 登录网址的主机名；都没有时，就是开始登录时页面所在的网站 */
export function passwordHosts(account: Pick<PlatformAccount, "domains" | "probeUrl">, startUrl: string): string[] {
  const hosts = [...account.domains]
  const login = account.probeUrl ? hostOf(account.probeUrl) : undefined
  if (login) hosts.push(login)
  if (hosts.length === 0) {
    const start = hostOf(startUrl)
    if (start) hosts.push(start)
  }
  return hosts
}

/** 把参数里的占位符换成真的（深度遍历）；返回有没有用到密码 */
export function fillCredentials(value: unknown, credentials: { username: string; password: string }): { value: unknown; usedPassword: boolean } {
  let usedPassword = false
  const walk = (each: unknown): unknown => {
    if (typeof each === "string") {
      if (each.search(PASSWORD) >= 0) usedPassword = true
      return each.replace(USERNAME, () => credentials.username).replace(PASSWORD, () => credentials.password)
    }
    if (Array.isArray(each)) return each.map(walk)
    if (each && typeof each === "object") return Object.fromEntries(Object.entries(each).map(([key, item]) => [key, walk(item)]))
    return each
  }
  return { value: walk(value), usedPassword }
}

const system = (account: PlatformAccount, hosts: string[]) =>
  [
    `你是登录助手，只负责用给定的账号密码登录「${account.platformName}」，不做别的事。`,
    "- 账号写 {{username}}，密码写 {{password}}：在 browser_type 的 text、browser_fill_form 的 value 里原样写这两个占位符，系统填进网页时换成真的。你看不到真的密码，也不要猜。",
    "- 先用 browser_snapshot 看页面，找到账号输入框、密码输入框和登录按钮。有的网站先填账号点「下一步」，再填密码；有的要先点「登录」或「密码登录」才出现输入框。",
    "- 动作类工具不返回页面内容，做完一步要看页面就再调 browser_snapshot。",
    `- 密码只能填到这些网站：${hosts.join("、") || "（没有）"}。不要打开别的网站。`,
    "- 不要点「忘记密码」「注册」，不要改任何设置；有「记住我」「保持登录」可以勾上。",
    `- 遇到验证码、滑块、短信或邮箱验证码、扫码、人机验证、要在别的设备上确认，或者页面说账号密码不对、账号被锁，调用 ${HUMAN_TOOL} 写清原因。`,
    `- 登录成功（已经离开登录页，看得到登录后的页面）就调用 ${DONE_TOOL}。`,
    `- 最多 ${AUTO_LOGIN_MAX_STEPS} 步。`,
  ].join("\n")

const toolResult = (toolCallId: string, toolName: string, output: string, isError?: boolean): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      output: isError ? { type: "error-text", value: output } : { type: "text", value: output },
    } satisfies ToolResultPart,
  ],
})

async function toolSet(): Promise<ToolSet> {
  const mcpTools = (await listBrowserMcpTools()).filter((each) => LOGIN_TOOLS.has(each.name))
  const tools: ToolSet = {}
  for (const each of mcpTools) {
    const schema = structuredClone(each.inputSchema) as { properties?: Record<string, unknown>; $schema?: unknown }
    // 存文件的参数去掉：agent 读不到 MCP 的目录
    delete schema.$schema
    if (schema.properties) delete schema.properties.filename
    tools[each.name] = tool({ description: each.description, inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]) })
  }
  tools[DONE_TOOL] = tool({
    description: "已经登录成功（离开了登录页，看得到登录后的页面）时调用",
    inputSchema: jsonSchema({ type: "object", properties: { note: { type: "string", description: "一句话说明看到了什么" } }, additionalProperties: false }),
  })
  tools[HUMAN_TOOL] = tool({
    description: "需要人处理时调用：验证码、滑块、短信 / 邮箱验证码、扫码、人机验证、账号密码不对、账号被锁等",
    inputSchema: jsonSchema({ type: "object", properties: { reason: { type: "string", description: "原因，给人看的" } }, required: ["reason"], additionalProperties: false }),
  })
  return tools
}

export interface AutoLoginInput {
  db: Db
  instance: BrowserInstance
  account: PlatformAccount
  credentials: { username: string; password: string }
  modelId: string
  /** 先打开账号的登录网址（「立刻登录」开的 Chrome 已经在那了，运行中遇到的登录页就在当前页面，都不用） */
  open?: boolean
  signal?: AbortSignal
}

export async function autoLogin(input: AutoLoginInput): Promise<AutoLoginResult> {
  const { db, instance, account, credentials } = input
  const result: AutoLoginResult = { ok: false, needHuman: false, detail: "", steps: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }
  const finish = (ok: boolean, needHuman: boolean, detail: string) => Object.assign(result, { ok, needHuman, detail })
  const mcp = await instance.ensureMcp()
  const connection: McpConnection = {
    serverId: `browser:${instance.id}`,
    serverName: "Playwright MCP",
    client: mcp.client,
    // 工具返回里出现密码原文就换成 [已隐藏]
    secrets: [credentials.password],
    tools: await listBrowserMcpTools(),
  }
  if (input.open && account.probeUrl) await executeMcpTool(connection, "browser_navigate", { url: account.probeUrl })
  const startUrl = instance.currentPage()?.url() ?? account.probeUrl ?? ""
  const hosts = passwordHosts(account, startUrl)
  const resolved = await resolveModel(db, input.modelId)
  const tools = await toolSet()
  const messages: ModelMessage[] = [
    {
      role: "user",
      content: [
        `要登录：「${account.platformName}」的账号 {{username}}，密码 {{password}}。`,
        `登录网址：${account.probeUrl || "（没填）"}`,
        `现在的页面：${startUrl || "（空白）"}`,
        "先用 browser_snapshot 看页面。",
      ].join("\n"),
    },
  ]
  let nudges = 0
  let stillLogin = 0
  while (result.steps < AUTO_LOGIN_MAX_STEPS) {
    if (input.signal?.aborted) return finish(false, false, "被取消了")
    result.steps++
    instance.touch()
    const reply = await callModel(resolved, { system: system(account, hosts), messages, tools, abortSignal: input.signal })
    result.tokensIn += reply.tokensIn
    result.tokensOut += reply.tokensOut
    result.costUsd += reply.costUsd
    if (reply.assistant) messages.push(reply.assistant)
    if (reply.toolCalls.length === 0) {
      if (++nudges > MAX_NUDGES) return finish(false, false, `模型没有接着操作：${reply.text.slice(0, 200) || "（没回话）"}`)
      messages.push({ role: "user", content: `请调用工具接着操作，或者用 ${DONE_TOOL} / ${HUMAN_TOOL} 结束。` })
      continue
    }
    for (const call of reply.toolCalls) {
      const args = (call.input ?? {}) as Record<string, unknown>
      if (call.invalid) {
        messages.push(toolResult(call.toolCallId, call.toolName, `参数不对：${call.error ?? ""}`, true))
        continue
      }
      if (call.toolName === HUMAN_TOOL) return finish(false, true, String(args.reason ?? "要人处理"))
      if (call.toolName === DONE_TOOL) {
        // 确认一下：还像登录页就让它接着弄（最多两次），验证码页交给人
        const found = await instance.detect()
        if (found?.verdict.kind === "captcha") return finish(false, true, `遇到验证码：${found.verdict.reason}`)
        if (found?.verdict.kind === "login" && ++stillLogin <= 2) {
          messages.push(toolResult(call.toolCallId, call.toolName, `看起来还在登录页（${found.verdict.reason}），先用 browser_snapshot 看看页面。`, true))
          continue
        }
        if (found?.verdict.kind === "login") return finish(false, false, `登录后还在登录页：${found.verdict.reason}`)
        return finish(true, false, String(args.note ?? "已登录"))
      }
      if (!LOGIN_TOOLS.has(call.toolName)) {
        messages.push(toolResult(call.toolCallId, call.toolName, `登录时不能用 ${call.toolName}`, true))
        continue
      }
      const outcome = await runTool(connection, instance, call.toolName, args, credentials, hosts)
      messages.push(toolResult(call.toolCallId, call.toolName, outcome.output, outcome.isError))
      if (!READ_ONLY.has(call.toolName)) {
        const found = await instance.detect()
        if (found?.verdict.kind === "captcha") return finish(false, true, `遇到验证码：${found.verdict.reason}`)
      }
    }
  }
  return finish(false, false, `${AUTO_LOGIN_MAX_STEPS} 步还没登录上`)
}

async function runTool(
  connection: McpConnection,
  instance: BrowserInstance,
  name: string,
  args: Record<string, unknown>,
  credentials: { username: string; password: string },
  hosts: string[]
): Promise<ToolOutcome> {
  const allowed = (url: string) => {
    const host = hostOf(url)
    return Boolean(host && hosts.some((each) => hostMatches(host, each)))
  }
  if (name === "browser_navigate" && typeof args.url === "string" && !allowed(args.url))
    return { output: `登录时只能打开这些网站：${hosts.join("、")}`, isError: true }
  const filled = fillCredentials(args, credentials)
  if (filled.usedPassword) {
    const here = instance.currentPage()?.url() ?? ""
    if (!allowed(here)) return { output: `密码只能填到 ${hosts.join("、")} 上的页面，现在的页面是 ${here || "空白页"}`, isError: true }
  }
  return executeMcpTool(connection, name, filled.value as Record<string, unknown>)
}
