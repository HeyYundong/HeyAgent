// 工具网关：给模型的工具定义不带执行函数，模型提出调用后都到这里。
// 依次做：调工具前的钩子（范围、参数校验、M3 的规则）→ 执行（内置 / HTTP / MCP）→ 截断大块输出（全文存文件）→ 落库 → 调工具后的钩子。
// 模型没有任何绕过的路径。
import { jsonSchema, tool, type ToolSet } from "ai"
import {
  builtinToolInputs,
  type SessionSnapshot,
  type SnapshotTool,
} from "@heyagent/shared"
import { z } from "zod"

import type { Db } from "../db/client.js"
import { saveFile } from "../files/service.js"
import {
  runAfterToolHooks,
  runBeforeToolHooks,
  type ToolCallContext,
} from "./hooks.js"
import { appendEvent } from "./records.js"
import { runtime } from "./runtime.js"
import { redactSecrets } from "./secrets.js"
import {
  executeBuiltin,
  type SessionRow,
  type ToolOutcome,
} from "./tools/builtin.js"
import {
  BUILTIN_TOOLS,
  builtinJsonSchema,
  isBuiltinTool,
} from "./tools/builtin-defs.js"
import { executeHttpTool, httpInputSchema } from "./tools/http.js"
import { executeMcpTool, McpPool, mcpToolName } from "./tools/mcp.js"

interface ToolEntry {
  id: string
  /** 给模型的名字：厂商只认字母数字下划线横线，id 里的点换成下划线 */
  name: string
  def: SnapshotTool
  jsonSchema: Record<string, unknown>
  validator: z.ZodType
  execute: (input: unknown) => Promise<ToolOutcome>
}

export interface ModelToolCall {
  toolCallId: string
  toolName: string
  input: unknown
  invalid?: boolean
  error?: string
}

export interface GatewayResult {
  toolId: string
  toolName: string
  outcome: ToolOutcome
  /** 交给模型的文字（截断、隐藏密钥之后） */
  output: string
  denied: boolean
}

function safeName(id: string, taken: Set<string>) {
  const base = id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 60) || "tool"
  let name = base
  for (let k = 2; taken.has(name); k++) name = `${base}_${k}`
  taken.add(name)
  return name
}

function zodFromJsonSchema(schema: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
  } catch {
    return z.record(z.string(), z.unknown())
  }
}

export class ToolGateway {
  private readonly entries: ToolEntry[] = []
  private readonly mcp: McpPool
  private readonly ctx: {
    db: Db
    session: SessionRow
    snapshot: SessionSnapshot
  }

  private constructor(ctx: {
    db: Db
    session: SessionRow
    snapshot: SessionSnapshot
  }) {
    this.ctx = ctx
    this.mcp = new McpPool(ctx.db)
  }

  static async create(
    db: Db,
    session: SessionRow,
    snapshot: SessionSnapshot
  ): Promise<ToolGateway> {
    const gateway = new ToolGateway({ db, session, snapshot })
    await gateway.build()
    return gateway
  }

  private async build() {
    const { db } = this.ctx
    const taken = new Set<string>()
    for (const def of this.ctx.snapshot.tools) {
      const name = safeName(def.id, taken)
      if (def.source === "builtin") {
        if (!isBuiltinTool(def.id)) continue
        const id = def.id
        this.entries.push({
          id,
          name,
          def,
          jsonSchema: builtinJsonSchema(id),
          validator: builtinToolInputs[id],
          execute: (input) => executeBuiltin(this.ctx, id, input),
        })
      } else if (def.source === "http" && def.http) {
        const spec = def.http
        const { jsonSchema: schema, validator } = httpInputSchema(spec)
        this.entries.push({
          id: def.id,
          name,
          def,
          jsonSchema: schema,
          validator,
          execute: (input) =>
            executeHttpTool(db, spec, input as Record<string, string>),
        })
      } else if (def.source === "mcp" && def.serverId) {
        const serverId = def.serverId
        try {
          const connection = await this.mcp.get(serverId)
          const remote = mcpToolName(connection, def.id)
          const info = connection.tools.find((each) => each.name === remote)
          if (!remote || !info)
            throw new Error(
              `服务器「${connection.serverName}」上没有工具 ${def.id}`
            )
          const schema = { ...info.inputSchema }
          delete schema.$schema
          this.entries.push({
            id: def.id,
            name,
            def: { ...def, description: def.description || info.description },
            jsonSchema: schema,
            validator: zodFromJsonSchema(schema),
            execute: (input) =>
              executeMcpTool(
                connection,
                remote,
                input as Record<string, unknown>
              ),
          })
        } catch (error) {
          // 连不上也把工具给模型（说明里写清楚），调用时返回错误，模型可以换别的办法
          const reason = (error as Error).message
          this.entries.push({
            id: def.id,
            name,
            def: {
              ...def,
              description: `（现在不可用：${reason}）${def.description}`,
            },
            jsonSchema: { type: "object", additionalProperties: true },
            validator: z.record(z.string(), z.unknown()),
            execute: async () => ({
              output: `MCP 服务器连不上：${reason}`,
              isError: true,
            }),
          })
        }
      }
    }
  }

  /** 给 AI SDK 的工具定义（不带 execute） */
  toolSet(): ToolSet {
    return Object.fromEntries(
      this.entries.map((entry) => [
        entry.name,
        tool({
          description: `${entry.def.name}：${entry.def.description || entry.def.summary}`,
          inputSchema: jsonSchema(entry.jsonSchema),
        }),
      ])
    )
  }

  /** 工具 id → 给模型的名字（系统提示里用） */
  names(): Map<string, string> {
    return new Map(this.entries.map((entry) => [entry.id, entry.name]))
  }

  private entryFor(toolName: string) {
    return (
      this.entries.find((entry) => entry.name === toolName) ??
      this.entries.find((entry) => entry.id === toolName)
    )
  }

  /** 给人看的工具名（过程里显示） */
  label(toolName: string): string {
    const entry = this.entryFor(toolName)
    if (entry) return entry.def.name
    return (
      BUILTIN_TOOLS.find(
        (def) => def.id.replace(/[^A-Za-z0-9_-]/g, "_") === toolName
      )?.name ?? toolName
    )
  }

  async call(call: ModelToolCall): Promise<GatewayResult> {
    const entry = this.entryFor(call.toolName)
    // 不在本任务里的内置工具：也换回原来的 id，过程里好认
    const builtin = entry
      ? undefined
      : BUILTIN_TOOLS.find(
          (def) => def.id.replace(/[^A-Za-z0-9_-]/g, "_") === call.toolName
        )
    const toolId = entry?.id ?? builtin?.id ?? call.toolName
    const toolName = entry?.def.name ?? builtin?.name ?? call.toolName
    const started = Date.now()
    const hookCtx: ToolCallContext = {
      ...this.ctx,
      toolId,
      input:
        call.invalid && typeof call.input === "string"
          ? { __raw: call.input }
          : call.input,
      allowedToolIds: new Set(this.entries.map((each) => each.id)),
      inputSchema: entry?.validator,
    }
    const inputText =
      typeof call.input === "string"
        ? call.input
        : JSON.stringify(call.input ?? {})
    const decision = await runBeforeToolHooks(hookCtx)
    if (decision.action === "deny") {
      const output = `被拦下：${decision.reason}`
      await appendEvent(this.ctx.db, this.ctx.session.id, {
        kind: "rule",
        title: `拦下：${toolName}`,
        detail: decision.ruleName
          ? `规则「${decision.ruleName}」：${decision.reason}`
          : decision.reason,
        toolId,
        input: inputText,
      })
      return {
        toolId,
        toolName,
        outcome: { output, isError: true },
        output,
        denied: true,
      }
    }

    let outcome: ToolOutcome
    try {
      outcome = await entry!.execute(decision.input)
    } catch (error) {
      outcome = {
        output: `工具出错：${(error as Error).message}`,
        isError: true,
      }
    }
    const secrets = outcome.secrets ?? []
    let output = redactSecrets(outcome.output, secrets)
    const max = runtime.toolOutputMaxChars
    if (output.length > max) {
      const file = await saveFile(this.ctx.db, {
        data: Buffer.from(output, "utf8"),
        name: `${toolId}-${call.toolCallId}.txt`.replace(
          /[^A-Za-z0-9_.-]/g,
          "_"
        ),
        mime: "text/plain",
        kind: "tool_output",
        sessionId: this.ctx.session.id,
      })
      output = `${output.slice(0, max)}\n…（输出共 ${output.length} 字，这里只给了开头 ${max} 字；全文已存为文件 ${file.id}，需要时用 file.read 读）`
    }
    await appendEvent(this.ctx.db, this.ctx.session.id, {
      kind: "tool",
      title: outcome.isError ? `${toolName}（出错）` : toolName,
      toolId,
      input: redactSecrets(JSON.stringify(decision.input ?? {}), secrets),
      output,
      ms: Date.now() - started,
    })
    await runAfterToolHooks({ ...hookCtx, input: decision.input, outcome })
    return { toolId, toolName, outcome, output, denied: false }
  }

  async close() {
    await this.mcp.closeAll()
  }
}
