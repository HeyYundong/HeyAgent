// 工具网关：给模型的工具定义不带执行函数，模型提出调用后都到这里。
// 依次做：调工具前的钩子（范围、参数校验、M3 的规则）→ 执行（内置 / HTTP / MCP）→ 截断大块输出（全文存文件）→ 落库 → 调工具后的钩子。
// 模型没有任何绕过的路径。browser.batch（连着做几步，docs/dev/browser-speed.md A）在这里展开：每一步都当成一次普通调用走 call()。
// 固化脚本（docs/dev/solidify.md 第 4 节）也一样：工具桥（routine/runtime/bridge.ts）把脚本的每次调用交给 call()，带上 routineStep。
// 浏览器动作录下的代码、前后网址存进过程记录的 trace（3.2）。
import { jsonSchema, tool, type ToolSet } from "ai"
import {
  BROWSER_TOOL_ID,
  COMPARE_TOOL_ID,
  DESKTOP_TOOL_ID,
  GALLERY_TOOL_ID,
  builtinToolInputs,
  type EventTrace,
  type Risk,
  type SessionSnapshot,
  type SnapshotTool,
} from "@heyagent/shared"
import { eq, inArray } from "drizzle-orm"
import { z } from "zod"

import { stripPageSections } from "../browser/page-brief.js"
import { recordBrowserTiming } from "../browser/timing.js"
import {
  BATCH_SNAPSHOT_DEPTH,
  BATCH_TOOL,
  batchable,
  batchToolId,
  BrowserTools,
} from "../browser/tools.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { saveFile, spacePathOf } from "../files/service.js"
import { compareToolEntries } from "../compare/tools.js"
import { DesktopTools } from "../desktop/tools.js"
import { galleryToolEntries } from "../gallery/tools.js"
import {
  runAfterToolHooks,
  runBeforeToolHooks,
  type ToolCallContext,
} from "./hooks.js"
import { isCheckpointToolHidden } from "./prompt.js"
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

/** 过程记录的 trace：录下的代码（隐藏密钥）、前后网址、脚本的第几步；什么都没有返回 undefined */
function traceOf(outcome: ToolOutcome, secrets: string[], routineStep?: number): EventTrace | undefined {
  const trace: EventTrace = {
    ...(outcome.code ? { code: redactSecrets(maskSecretFields(outcome.code), secrets) } : {}),
    ...(outcome.trace?.urlBefore ? { urlBefore: outcome.trace.urlBefore } : {}),
    ...(outcome.trace?.urlAfter ? { urlAfter: outcome.trace.urlAfter } : {}),
    ...(outcome.trace?.title ? { title: outcome.trace.title } : {}),
    ...(routineStep ? { routineStep } : {}),
  }
  return Object.keys(trace).length ? trace : undefined
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

interface BatchInput {
  actions: { tool: string; input?: Record<string, unknown> }[]
  snapshot?: false | { depth?: number }
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`

/** 批里一步的说明：工具短名 + 元素描述（「click「提交」」）；不取要填的内容 */
function stepLabel(toolId: string, input: Record<string, unknown>) {
  const short = toolId.replace(/^browser\./, "")
  const str = (value: unknown) => (typeof value === "string" ? value.trim() : "")
  let detail = str(input.element) || str(input.startElement)
  if (Array.isArray(input.fields))
    detail = input.fields
      .map((field) => str((field as { name?: unknown } | null)?.name))
      .filter(Boolean)
      .join("、")
  detail ||= str(input.key) || str(input.url) || str(input.target)
  if (detail.length > 40) detail = `${detail.slice(0, 39)}…`
  return detail ? `${short}「${detail}」` : short
}

/** 批里一步的输出去掉和页面概况重复的段、段标题，只留要紧的（下载的文件、脚本结果、自动关弹窗……） */
function stepNote(output: string) {
  const text = stripPageSections(output)
    .split("\n")
    .filter((line) => !/^### /.test(line) && line.trim() !== "（已自动截图存档）")
    .join("\n")
    .trim()
  return text.length > 600 ? `${text.slice(0, 600)}…` : text
}

const indent = (text: string) =>
  text
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n")

/**
 * HTTP 工具用库里现在的模板和参数清单，不用快照里冻住的：主管给模板加了 {speaker}，之前建的运行下次跑起来（开始 / 继续）就认。
 * 工具删了或不再是 HTTP 工具就还用快照里的。规则查白名单也看这份（同一个 snapshot 对象）
 */
async function withCurrentHttpSpecs(
  db: Db,
  snapshot: SessionSnapshot
): Promise<SessionSnapshot> {
  const ids = snapshot.tools
    .filter((tool) => tool.source === "http")
    .map((tool) => tool.id)
  if (ids.length === 0) return snapshot
  const rows = await db
    .select({ id: t.tools.id, source: t.tools.source, http: t.tools.http })
    .from(t.tools)
    .where(inArray(t.tools.id, ids))
  const current = new Map(
    rows.flatMap((row) =>
      row.source === "http" && row.http ? [[row.id, row.http] as const] : []
    )
  )
  if (current.size === 0) return snapshot
  return {
    ...snapshot,
    tools: snapshot.tools.map((tool) =>
      tool.source === "http" && current.has(tool.id)
        ? { ...tool, http: current.get(tool.id)! }
        : tool
    ),
  }
}

export class ToolGateway {
  private readonly entries: ToolEntry[] = []
  private readonly mcp: McpPool
  /** 任务选了「浏览器」时的整组浏览器工具（M2） */
  private browser?: BrowserTools
  /** 任务选了「桌面」时的整组桌面工具（docs/dev/desktop.md） */
  private desktop?: DesktopTools
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
    const gateway = new ToolGateway({
      db,
      session,
      snapshot: await withCurrentHttpSpecs(db, snapshot),
    })
    await gateway.build()
    return gateway
  }

  private async build() {
    const { db } = this.ctx
    const taken = new Set<string>()
    for (const def of this.ctx.snapshot.tools) {
      // 任务没写检查点（清单是空的）：不给 agent「勾检查点」，免得它去调、被拒以后还在总结里写「清单为空」。
      // 快照的 tools 不改（规则页、任务页照样显示它是自带的）
      if (isCheckpointToolHidden(this.ctx.snapshot, def.id)) continue
      if (def.id === BROWSER_TOOL_ID && def.source === "builtin") {
        await this.buildBrowser(taken)
        continue
      }
      if (def.id === DESKTOP_TOOL_ID && def.source === "builtin") {
        await this.buildDesktop(taken)
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
          def: this.adjustBuiltin(def),
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
            executeHttpTool(db, spec, input as Record<string, unknown>),
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
        execute: async () => ({
          output: `浏览器现在不可用：${reason}`,
          isError: true,
        }),
      })
    }
  }

  /**
   * 有「桌面」工具组的运行：通用的「问人」说明里写明，要人在桌面上动手的事走 desktop_ask_human
   * （模型分不清时会用通用的问人：没有截图、不保留桌面、人打不开远程画面）
   */
  private adjustBuiltin(def: SnapshotTool): SnapshotTool {
    if (def.id !== "ask.human" || !this.ctx.snapshot.desktop) return def
    return {
      ...def,
      summary: `${def.summary}（要人在桌面上动手的事用 desktop_ask_human）`,
      description: `只用来问问题、请人批准或拍板。要人在桌面上动手做的事（扫码、登录、点一下、处理弹框、在软件里操作）不要用它，用 desktop_ask_human：那个会截图、把桌面保留给你、让人打开远程画面。${def.description}`,
    }
  }

  /** 「桌面」展开成一组：desktop.use + Windows-MCP 白名单工具 + look / send_file / fetch_file / ask_human（建不起来时给一个说明原因的占位工具） */
  private async buildDesktop(taken: Set<string>) {
    try {
      this.desktop = await DesktopTools.create(this.ctx)
      for (const entry of this.desktop.entries())
        this.entries.push({ ...entry, name: safeName(entry.id, taken) })
    } catch (error) {
      const reason = (error as Error).message
      const def: SnapshotTool = {
        id: "desktop.use",
        name: "桌面",
        summary: "桌面（现在不可用）",
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
        execute: async () => ({
          output: `桌面现在不可用：${reason}`,
          isError: true,
        }),
      })
    }
  }

  /** 浏览器工具组（系统提示里写浏览器用法时用） */
  hasBrowser() {
    return Boolean(this.browser)
  }

  /** 工具的 id 和风险（固化试跑判断「会不会对外发送、改东西」用）；本任务没有这个工具返回 undefined */
  toolInfo(toolName: string): { id: string; risk?: Risk } | undefined {
    const entry = this.entryFor(toolName)
    return entry ? { id: entry.id, risk: entry.def.risk } : undefined
  }

  /** 现在的页面概况（标题网址、弹窗；交给 agent 的那段话用）；没开浏览器返回空 */
  async pageLines(): Promise<string[]> {
    return (await this.browser?.briefLines().catch(() => [])) ?? []
  }

  /** 规则「截图存证」：这次运行开着 Chrome 时截当前页面；没有 Chrome、占着桌面时截桌面 */
  async screenshot(): Promise<{ fileId: string } | undefined> {
    return (await this.browser?.evidenceScreenshot()) ?? (await this.desktop?.evidenceScreenshot())
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
    options: {
      approvedRuleIds?: readonly string[]
      /** browser.batch 里的第几步（从 1 开始）：要人审批时不发起审批，批停在这一步之前 */
      batchStep?: number
      /** 固化脚本的第几次工具调用（从 1 开始）：过程记录写进 trace.routineStep；要人审批时不发起审批，脚本停在这一步之前 */
      routineStep?: number
    } = {}
  ): Promise<GatewayResult> {
    const entry = this.entryFor(call.toolName)
    if (entry?.id === BATCH_TOOL && this.browser)
      return this.callBatch(call, entry, this.browser)
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
    const beforeMs = Date.now() - started
    const routineTrace: EventTrace | undefined = options.routineStep ? { routineStep: options.routineStep } : undefined
    if (decision.action === "ask_human") {
      await appendEvent(this.ctx.db, this.ctx.session.id, {
        kind: "rule",
        title: options.routineStep
          ? `规则「${decision.ruleName}」：脚本的第 ${options.routineStep} 步 ${toolName} 要人审批，没做，交给 agent`
          : options.batchStep
            ? `规则「${decision.ruleName}」：批里的第 ${options.batchStep} 步 ${toolName} 要人审批，没做`
            : `规则「${decision.ruleName}」：拦下 ${toolName}，交给人审批`,
        detail: options.routineStep
          ? `${decision.reason}固化脚本不发起审批：停在这一步之前，交给 agent 单独调用这一步（照常交给人审批）。`
          : options.batchStep
            ? `${decision.reason}批里不做要审批的动作，已让 agent 单独调用这一步。`
            : decision.reason,
        toolId,
        input: redactSecrets(maskSecretFields(inputText), []),
        trace: routineTrace,
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
          input:
            entry?.validator.safeParse(call.input ?? {}).data ?? call.input,
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
        trace: routineTrace,
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
    const executeStarted = Date.now()
    try {
      outcome = await entry!.execute(decision.input)
    } catch (error) {
      outcome = {
        output: `工具出错：${(error as Error).message}`,
        isError: true,
      }
    }
    const executeMs = Date.now() - executeStarted
    const secrets = outcome.secrets ?? []
    const output = await this.clipOutput(
      redactSecrets(outcome.output, secrets),
      outcome,
      toolId,
      call.toolCallId
    )
    await appendEvent(this.ctx.db, this.ctx.session.id, {
      kind: "tool",
      title: outcome.isError ? `${toolName}（出错）` : toolName,
      toolId,
      input: redactSecrets(JSON.stringify(decision.input ?? {}), secrets),
      output,
      ms: Date.now() - started,
      trace: traceOf(outcome, secrets, options.routineStep),
    })
    await runAfterToolHooks({ ...hookCtx, input: decision.input, outcome })
    // 浏览器动作的分段用时：规则钩子、工具里面各段（MCP、扫页面、检测……）、落库和调工具后的钩子
    if (outcome.timings) {
      const totalMs = Date.now() - started
      recordBrowserTiming({
        at: started,
        sessionId: this.ctx.session.id,
        toolId,
        totalMs,
        phases: {
          before: beforeMs,
          ...outcome.timings,
          other: Math.max(
            0,
            executeMs -
              Object.values(outcome.timings).reduce((sum, ms) => sum + ms, 0)
          ),
          after: totalMs - beforeMs - executeMs,
        },
      })
    }
    return { toolId, toolName, outcome, output, denied: false }
  }

  /** 太长的输出：给模型开头一段，全文存成文件 */
  private async clipOutput(
    output: string,
    outcome: ToolOutcome,
    toolId: string,
    toolCallId: string
  ) {
    const max = runtime.toolOutputMaxChars
    if (output.length <= max || outcome.keepFull) return output
    const file = await saveFile(this.ctx.db, {
      data: Buffer.from(output, "utf8"),
      name: `${toolId}-${toolCallId}.txt`.replace(/[^A-Za-z0-9_.-]/g, "_"),
      mime: "text/plain",
      kind: "tool_output",
      sessionId: this.ctx.session.id,
    })
    return `${output.slice(0, max)}\n…（输出共 ${output.length} 字，这里只给了开头 ${max} 字；全文已存为文件 ${file.id}（${spacePathOf(file)}），需要时用 file.read 读）`
  }

  /**
   * browser.batch：按顺序把每一步当成一次普通调用走 call()（规则的前后钩子、白名单、验证码 / 登录页检测、过程记录都和单独调一样），
   * 哪一步出错、被拦下就停；要人审批的停在那一步之前（审批只支持单次调用）；要挂起的停下，批的结果带上 suspend、signals、facts，
   * 引擎照常挂起。没挂起时最后附上页面概况和快照。批本身不过规则（每一步都过了），只查参数、落一条总的过程记录
   */
  private async callBatch(
    call: ModelToolCall,
    entry: ToolEntry,
    browser: BrowserTools
  ): Promise<GatewayResult> {
    const started = Date.now()
    const toolId = entry.id
    const toolName = entry.def.name
    const deny = async (reason: string) => {
      const output = `被拦下：${reason}`
      await appendEvent(this.ctx.db, this.ctx.session.id, {
        kind: "rule",
        title: `拦下：${toolName}`,
        detail: reason,
        toolId,
        input:
          typeof call.input === "string"
            ? call.input
            : JSON.stringify(call.input ?? {}),
      })
      return {
        toolId,
        toolName,
        outcome: { output, isError: true },
        output,
        denied: true,
      }
    }
    const parsed = entry.validator.safeParse(call.input ?? {})
    if (call.invalid || !parsed.success)
      return deny(
        `参数不对：${
          parsed.error?.issues
            .slice(0, 5)
            .map(
              (issue) => `${issue.path.join(".") || "参数"}：${issue.message}`
            )
            .join("；") ?? "不是合法的 JSON"
        }`
      )
    const input = parsed.data as BatchInput
    // 先认出每一步的工具：有一步不能放就整批不做
    const steps = input.actions.map((action) => ({
      id: batchToolId(action.tool),
      tool: action.tool,
      input: action.input ?? {},
    }))
    const allowed = this.entries.filter((each) => batchable(each.id))
    for (const [index, step] of steps.entries())
      if (!allowed.some((each) => each.id === step.id))
        return deny(
          `第 ${index + 1} 步的 tool「${step.tool}」不能放进批里（${
            this.entries.some((each) => each.id === step.id)
              ? "只读的看页面工具不能放，最后的页面由 snapshot 参数给"
              : "本任务没有这个浏览器工具"
          }）。能放的：${allowed.map((each) => each.id.replace(/^browser\./, "")).join("、")}`
        )

    const lines: string[] = []
    const images: NonNullable<ToolOutcome["images"]> = []
    let failed = false
    let suspended: ToolOutcome | undefined
    let lastOutput = ""
    const skipped = (from: number) =>
      from < steps.length ? [`（后面 ${steps.length - from} 步没做）`] : []
    browser.setBatching(true)
    try {
      for (const [index, step] of steps.entries()) {
        const n = index + 1
        // 每一步之前看一眼：运行被取消了就不再做
        if (index > 0 && !(await this.stillRunning())) {
          lines.push(`（运行停下了，后面 ${steps.length - index} 步没做）`)
          failed = true
          break
        }
        const stepEntry = this.entries.find((each) => each.id === step.id)!
        const label = stepLabel(step.id, step.input)
        const stepStarted = Date.now()
        const done = await this.call(
          {
            toolCallId: `${call.toolCallId}-${n}`,
            toolName: stepEntry.name,
            input: step.input,
          },
          { batchStep: n }
        )
        lastOutput = done.output
        if (done.approval) {
          lines.push(
            `${n}. ${label} 没做：规则「${done.approval.ruleName}」要求这一步先交给人审批，批里不做要审批的动作。单独调用这一步（${stepEntry.name}）。`,
            ...skipped(n)
          )
          failed = true
          break
        }
        if (done.outcome.suspend && !done.denied) {
          lines.push(`${n}. ${label}：${stepNote(done.output)}`, ...skipped(n))
          suspended = done.outcome
          break
        }
        if (done.outcome.isError) {
          lines.push(
            `${n}. ✗ ${label}：${stepNote(done.output) || "出错了"}`,
            ...skipped(n)
          )
          failed = true
          break
        }
        lines.push(`${n}. ${label} ✓（${seconds(Date.now() - stepStarted)}）`)
        const note = stepNote(done.output)
        if (note) lines.push(indent(note))
        if (done.outcome.images) images.push(...done.outcome.images)
      }
    } finally {
      browser.setBatching(false)
    }
    // 没挂起：附上页面概况和快照（挂起的话继续后页面多半变了，不用看）
    if (!suspended) {
      const brief = await browser.briefLines(lastOutput)
      if (brief.length) lines.push("", ...brief)
      if (input.snapshot !== false) {
        const snapshot = await browser.batchSnapshot(
          input.snapshot?.depth ?? BATCH_SNAPSHOT_DEPTH
        )
        if (snapshot) lines.push("", "页面快照：", snapshot)
      }
    }
    const outcome: ToolOutcome = {
      output: lines.join("\n"),
      isError: failed,
      ...(suspended
        ? {
            suspend: suspended.suspend,
            ...(suspended.signals ? { signals: suspended.signals } : {}),
            ...(suspended.facts ? { facts: suspended.facts } : {}),
          }
        : {}),
      ...(images.length ? { images } : {}),
    }
    const output = await this.clipOutput(
      outcome.output,
      outcome,
      toolId,
      call.toolCallId
    )
    await appendEvent(this.ctx.db, this.ctx.session.id, {
      kind: "tool",
      title: failed ? `${toolName}（出错）` : toolName,
      toolId,
      input: redactSecrets(maskSecretFields(JSON.stringify(input)), []),
      output,
      ms: Date.now() - started,
    })
    return { toolId, toolName, outcome, output, denied: false }
  }

  /** 运行还在跑（批里每一步之前、固化脚本每次调用之前看一眼，被取消了就停） */
  async stillRunning() {
    const [row] = await this.ctx.db
      .select({ status: t.sessions.status })
      .from(t.sessions)
      .where(eq(t.sessions.id, this.ctx.session.id))
    return row?.status === "running"
  }

  async close() {
    await this.mcp.closeAll()
    await this.browser?.close()
    await this.desktop?.close()
  }
}
