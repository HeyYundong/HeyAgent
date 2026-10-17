// MCP 工具：用 @ai-sdk/mcp 连配置好的服务器（stdio 命令，或 HTTP 地址 + 请求头）。
// - 环境变量 / 请求头的值加密存在 secrets（scope = mcp_env，ref_id = 服务器 id，名字 = 变量名或请求头名），
//   值里还可以写 {{名字}}，执行时再从全局密钥（scope = http_tool）替换；
// - session 内复用连接，挂起和结束时断开；
// - 返回里出现密钥原文换成 [已隐藏]。
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp"
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio"
import { eq } from "drizzle-orm"
import type { McpToolInfo } from "@heyagent/shared"

import * as t from "../../db/schema.js"
import type { DbLike } from "../records.js"
import {
  fillSecrets,
  loadGlobalSecrets,
  loadScopedSecrets,
  redactSecrets,
  secretNamesIn,
} from "../secrets.js"
import type { ToolOutcome } from "./builtin.js"

const CONNECT_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000

/** 把一行命令拆成程序和参数（支持单双引号，不经过 shell） */
export function splitCommand(command: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: string | null = null
  let has = false
  for (const ch of command.trim()) {
    if (quote) {
      if (ch === quote) quote = null
      else current += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has || current) out.push(current)
      current = ""
      has = false
    } else {
      current += ch
    }
  }
  if (has || current) out.push(current)
  return out
}

export interface McpConnection {
  serverId: string
  serverName: string
  client: MCPClient
  /** 连接用到的密钥原文（用来隐藏返回里的原文） */
  secrets: string[]
  tools: McpToolInfo[]
}

export async function connectMcpServer(
  db: DbLike,
  serverId: string
): Promise<McpConnection> {
  const [server] = await db
    .select()
    .from(t.mcpServers)
    .where(eq(t.mcpServers.id, serverId))
  if (!server) throw new Error(`找不到 MCP 服务器 ${serverId}`)
  const scoped = await loadScopedSecrets(db, "mcp_env", serverId)
  const globalNames = [...scoped.values()].flatMap((value) =>
    secretNamesIn(value)
  )
  const globals = await loadGlobalSecrets(db, globalNames)
  const used = new Set<string>()
  const values: Record<string, string> = {}
  for (const key of server.envKeys) {
    const raw = scoped.get(key)
    if (raw === undefined) continue
    values[key] = fillSecrets(raw, globals, used)
    used.add(values[key])
  }

  let transport
  if (server.transport === "stdio") {
    const argv = splitCommand(server.command ?? "")
    if (argv.length === 0)
      throw new Error(`MCP 服务器「${server.name}」没有写启动命令`)
    transport = new Experimental_StdioMCPTransport({
      command: argv[0]!,
      args: argv.slice(1),
      env: values,
      stderr: "ignore",
    })
  } else {
    if (!server.url) throw new Error(`MCP 服务器「${server.name}」没有写地址`)
    transport = {
      type: "http" as const,
      url: server.url,
      headers: values,
      redirect: "error" as const,
    }
  }
  const client = await createMCPClient({
    transport,
    clientName: "heyagent",
    initializationOptions: { timeout: CONNECT_TIMEOUT_MS },
  })
  try {
    const tools: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const result = await client.listTools({
        params: cursor ? { cursor } : undefined,
        options: { timeout: CONNECT_TIMEOUT_MS },
      })
      for (const tool of result.tools)
        tools.push({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: (tool.inputSchema ?? { type: "object" }) as Record<
            string,
            unknown
          >,
        })
      cursor = (result as { nextCursor?: string }).nextCursor
      if (!cursor) break
    }
    return {
      serverId,
      serverName: server.name,
      client,
      secrets: [...used],
      tools,
    }
  } catch (error) {
    await client.close().catch(() => {})
    throw error
  }
}

/** 一个 session 里的 MCP 连接：同一个服务器只连一次，session 挂起或结束时全部断开 */
export class McpPool {
  private readonly connections = new Map<string, Promise<McpConnection>>()
  private readonly db: DbLike

  constructor(db: DbLike) {
    this.db = db
  }

  get(serverId: string): Promise<McpConnection> {
    let connection = this.connections.get(serverId)
    if (!connection) {
      connection = connectMcpServer(this.db, serverId)
      this.connections.set(serverId, connection)
      connection.catch(() => this.connections.delete(serverId))
    }
    return connection
  }

  async closeAll() {
    const all = [...this.connections.values()]
    this.connections.clear()
    await Promise.all(
      all.map(async (connection) =>
        (await connection.catch(() => null))?.client.close().catch(() => {})
      )
    )
  }
}

/** 本地工具 id 对应服务器上的哪个工具：先找同名的，再试去掉「前缀.」的 */
export function mcpToolName(
  connection: McpConnection,
  toolId: string
): string | undefined {
  if (connection.tools.some((tool) => tool.name === toolId)) return toolId
  const suffix = toolId.includes(".")
    ? toolId.slice(toolId.indexOf(".") + 1)
    : undefined
  if (suffix && connection.tools.some((tool) => tool.name === suffix))
    return suffix
  return undefined
}

export async function executeMcpTool(
  connection: McpConnection,
  name: string,
  input: Record<string, unknown>
): Promise<ToolOutcome> {
  try {
    const result = await connection.client.callTool({
      name,
      arguments: input,
      options: { timeout: CALL_TIMEOUT_MS },
    })
    const parts: string[] = []
    const content = (result as { content?: unknown[] }).content
    if (Array.isArray(content)) {
      for (const item of content as {
        type: string
        text?: string
        mimeType?: string
        resource?: { text?: string; uri?: string }
      }[]) {
        if (item.type === "text") parts.push(item.text ?? "")
        else if (item.type === "resource")
          parts.push(
            item.resource?.text ?? `[资源 ${item.resource?.uri ?? ""}]`
          )
        else
          parts.push(
            `[${item.type}${item.mimeType ? ` ${item.mimeType}` : ""}]`
          )
      }
    } else if ("toolResult" in (result as object)) {
      parts.push(JSON.stringify((result as { toolResult: unknown }).toolResult))
    }
    const structured = (result as { structuredContent?: unknown })
      .structuredContent
    if (parts.length === 0 && structured !== undefined)
      parts.push(JSON.stringify(structured))
    const isError = Boolean((result as { isError?: boolean }).isError)
    return {
      output: redactSecrets(
        parts.join("\n") || "（没有返回内容）",
        connection.secrets
      ),
      isError,
      secrets: connection.secrets,
    }
  } catch (error) {
    return {
      output: redactSecrets(
        `MCP 调用失败：${(error as Error).message}`,
        connection.secrets
      ),
      isError: true,
      secrets: connection.secrets,
    }
  }
}

/** 工具页的「连接并读取工具」：连一次、读出工具清单、断开，顺便更新服务器状态 */
export async function listMcpServerToolsImpl(
  db: DbLike,
  serverId: string
): Promise<{
  ok: boolean
  tools: McpToolInfo[]
  error?: string
  serverName?: string
}> {
  const [server] = await db
    .select({ name: t.mcpServers.name })
    .from(t.mcpServers)
    .where(eq(t.mcpServers.id, serverId))
  if (!server)
    return { ok: false, tools: [], error: `找不到 MCP 服务器 ${serverId}` }
  try {
    const connection = await connectMcpServer(db, serverId)
    await connection.client.close().catch(() => {})
    await db
      .update(t.mcpServers)
      .set({ status: "connected" })
      .where(eq(t.mcpServers.id, serverId))
    return { ok: true, tools: connection.tools, serverName: server.name }
  } catch (error) {
    await db
      .update(t.mcpServers)
      .set({ status: "error" })
      .where(eq(t.mcpServers.id, serverId))
    return {
      ok: false,
      tools: [],
      error: (error as Error).message,
      serverName: server.name,
    }
  }
}
