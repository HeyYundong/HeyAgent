// 工具网关：给模型的工具定义不带执行函数，模型提出调用后都到这里。
// 依次做：调工具前的钩子（范围、参数校验、M3 的规则）→ 执行（内置 / HTTP / MCP）→ 截断大块输出（全文存文件）→ 落库 → 调工具后的钩子。
// 模型没有任何绕过的路径。
import { jsonSchema, tool, type ToolSet } from "ai"
import {
  BROWSER_TOOL_ID,
  COMPARE_TOOL_ID,
  GALLERY_TOOL_ID,
  builtinToolInputs,
  type Risk,
  type SessionSnapshot,
  type SnapshotTool,
} from "@heyagent/shared"
import { z } from "zod"

import { BrowserTools } from "../browser/tools.js"
import type { Db } from "../db/client.js"
import { saveFile } from "../files/service.js"
import { compareToolEntries } from "../compare/tools.js"
import { galleryToolEntries } from "../gallery/tools.js"
import {
  runAfterToolHooks,
  runBeforeToolHooks,
  type ToolCallContext,
} from "./hooks.js"
import { appendEvent } from "./records.js"
import { runtime } from "./runtime.js"
import { maskSecretFields, redactSecrets } from "./secrets.js"
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
  /** M3：规则要求先审批，工具还没执行（调用方让 session 等人处理） */
  approval?: {
    ruleId: string
    ruleName: string
    assigneeId: string
    reason: string
    /** 校验过的参数（给人看之前要隐藏密钥类字段） */
    input: unknown
    risk?: Risk
  }
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
  /** 任务选了「浏览器」时的整组浏览器工具（M2） */
  private browser?: BrowserTools
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
      if (def.id === BROWSER_TOOL_ID && def.source === "builtin") {
        await this.buildBrowser(taken)
        continue
      }
      // 「图库」展开成一组：检索、比对、看一张、传图、改文本和标签（gallery/tools.ts）
      if (def.id === GALLERY_TOOL_ID && def.source === "builtin") {
        for (const entry of galleryToolEntries(this.ctx))
          this.entries.push({ ...entry, name: safeName(entry.id, taken) })
        continue
      }
      // 「比物」展开成一组：比两张图、看一条比对、比对记录、比对标准（compare/tools.ts）
      if (def.id === COMPARE_TOOL_ID && def.source === "builtin") {
        for (const entry of compareToolEntries(this.ctx))
          this.entries.push({ ...entry, name: safeName(entry.id, taken) })
        continue
      }
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

  /** 「浏览器」展开成一组：browser.use + Playwright MCP 的工具（列不出工具时给一个说明原因的占位工具） */
  private async buildBrowser(taken: Set<string>) {
    try {
      this.browser = await BrowserTools.create(this.ctx)
      for (const entry of this.browser.entries())
        this.entries.push({ ...entry, name: safeName(entry.id, taken) })
    } catch (error) {
      const reason = (error as Error).message
      const def: SnapshotTool = {
        id: "browser.use",
        name: "浏览器",
        summary: "浏览器（现在不可用）",
        description: `（现在不可用：${reason}）`,
        source: "builtin",
        risk: "external",
      }
      this.entries.push({
        id: def.id,
        name: safeName(def.id, taken),
        def,
        jsonSchema: { type: "object", additionalProperties: true },
        validator: z.record(z.string(), z.unknown()),
        execute: async () => ({ output: `浏览器现在不可用：${reason}`, isError: true }),
      })
    }
  }

  /** 浏览器工具组（系统提示里写浏览器用法时用） */
  hasBrowser() {
    return Boolean(this.browser)
  }

  /** 规则「截图存证」：这次运行开着 Chrome 时截当前页面 */
  async screenshot(): Promise<{ fileId: string } | undefined> {
    return this.browser?.evidenceScreenshot()
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

  /**
   * 处理模型提出的一次调用。approvedRuleIds：已经由人批准过的规则（审批通过后继续执行这次调用时传），
   * 这些规则不再要求审批，其他规则和内置检查照常。
   */
  async call(
    call: ModelToolCall,
    options: { approvedRuleIds?: readonly string[] } = {}
  ): Promise<GatewayResult> {
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
      screenshot: () => this.screenshot(),
      toolId,
      toolName,
      risk: entry?.def.risk ?? builtin?.risk,
      approvedRuleIds: options.approvedRuleIds,
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
    if (decision.action === "ask_human") {
      await appendEvent(this.ctx.db, this.ctx.session.id, {
        kind: "rule",
        title: `规则「${decision.ruleName}」：拦下 ${toolName}，交给人审批`,
        detail: decision.reason,
        toolId,
        input: redactSecrets(maskSecretFields(inputText), []),
      })
      return {
        toolId,
        toolName,
        outcome: { output: "", isError: true },
        output: "",
        denied: false,
        approval: {
          ruleId: decision.ruleId,
          ruleName: decision.ruleName,
          assigneeId: decision.assigneeId,
          reason: decision.reason,
          input: entry?.validator.safeParse(call.input ?? {}).data ?? call.input,
          risk: hookCtx.risk,
        },
      }
    }
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
    await this.browser?.close()
  }
}
