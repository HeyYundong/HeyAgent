// 「桌面」工具组（docs/dev/desktop.md 第 2～4 节）：任务选了系统自带的「桌面」工具，工具网关就开放这一组：
// - desktop.use：可选，还没分到桌面时指定用哪台；
// - Windows-MCP 白名单里的 12 个工具（desktop/mcp-tools.ts，参数写死，不用连上桌面就能建工具组）；
// - desktop.look（要「允许看画面」）、send_file、fetch_file、ask_human。
// 懒分配：第一次调桌面工具（desktop.use 除外）才占桌面；分到以后（sessions.desktop_id）从头到尾只用它，被占着就等它。
// 占用记在数据库（desktop/leases.ts），挂起再继续落到别的 worker 也能接着用。桌面连不上：工具结果报错，不挂起。
import { setTimeout as sleep } from "node:timers/promises"

import type { MCPClient } from "@ai-sdk/mcp"
import { ANY_DESKTOP_EVENT, desktopEventName, type HumanDetail, type SessionSnapshot, type SnapshotTool } from "@heyagent/shared"
import { eq } from "drizzle-orm"
import { z } from "zod"

import { readBrowserSettings } from "../data/config/settings.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { appendEvent } from "../engine/records.js"
import { getKeyring } from "../engine/runtime.js"
import { loadEngineSettings } from "../engine/settings.js"
import type { SessionRow, ToolOutcome } from "../engine/tools/builtin.js"
import { CALL_TIMEOUT_MS, mcpResultOutcome } from "../engine/tools/mcp.js"
import { getFileRow, readFileData, saveFile, spacePathOf } from "../files/service.js"
import {
  agentDownload,
  agentScreenshot,
  agentType,
  agentUpload,
  connectDesktopMcp,
  DesktopUnreachableError,
  errorText,
  isConnectionError,
  loadDesktopTarget,
  type DesktopTarget,
} from "./client.js"
import { acquireDesktop, busyDesktopIds, DESKTOP_HEARTBEAT_MS, holdDesktop, releaseSessionDesktop, renewDesktopLease } from "./leases.js"
import { desktopControlRetry, HUMAN_BUSY_TEXT, parseControlBlock, retryable, retryDelayMs } from "./control.js"
import { DESKTOP_MCP_TOOL_DEFS } from "./mcp-tools.js"

export interface DesktopToolEntry {
  id: string
  def: SnapshotTool
  jsonSchema: Record<string, unknown>
  validator: z.ZodType
  execute: (input: unknown) => Promise<ToolOutcome>
}

interface Ctx {
  db: Db
  session: SessionRow
  snapshot: SessionSnapshot
}

const fail = (output: string): ToolOutcome => ({ output, isError: true })

/** 有 ASCII 以外的字（中文、全角标点、emoji…） */
const NON_ASCII = /[^\p{ASCII}]/u

interface TypeInput {
  text: string
  loc?: number[]
  label?: number
  clear?: boolean
  caret_position?: "start" | "idle" | "end"
  press_enter?: boolean
}

function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7", io: "input" }) as Record<string, unknown>
  delete json.$schema
  return json
}

const emptyObject = { type: "object", properties: {}, additionalProperties: false }

export class DesktopTools {
  private readonly ctx: Ctx
  /** 这次运行分到的桌面（系统挑的或 desktop.use 指定的）。分到以后从头到尾只用它 */
  private assigned?: string
  /** 这个工具网关里占着桌面（续约的定时器开着） */
  private holding = false
  private timer?: NodeJS.Timeout
  private target?: DesktopTarget
  private mcp?: Promise<MCPClient>
  /** 调过 desktop.ask_human：工具网关关闭时桌面转成 held，保留多少分钟 */
  private holdMinutes?: number

  private constructor(ctx: Ctx) {
    this.ctx = ctx
    this.assigned = ctx.session.desktopId ?? undefined
  }

  static async create(ctx: Ctx): Promise<DesktopTools> {
    const group = new DesktopTools(ctx)
    // 等人处理时保留着的（held）：运行继续了，改回 running 接着用同一台
    if (group.assigned) {
      const [held] = await ctx.db
        .select({ id: t.desktopLeases.desktopId })
        .from(t.desktopLeases)
        .where(eq(t.desktopLeases.sessionId, ctx.session.id))
      if (held && (await acquireDesktop(ctx.db, held.id, ctx.session.id)) !== "busy") group.startHolding()
    }
    return group
  }

  private get desktops() {
    return this.ctx.snapshot.desktop?.desktops ?? []
  }

  private get allowVision() {
    return Boolean(this.ctx.snapshot.desktop?.allowVision)
  }

  private desktopName(id: string) {
    return this.desktops.find((desktop) => desktop.id === id)?.name ?? id
  }

  private desktopList() {
    return this.desktops.map((desktop) => `${desktop.id}「${desktop.name}」${desktop.description ? `：${desktop.description}` : ""}`).join("；") || "无"
  }

  entries(): DesktopToolEntry[] {
    const ids = this.desktops.map((desktop) => desktop.id)
    const own = (
      id: string,
      name: string,
      summary: string,
      description: string,
      risk: SnapshotTool["risk"],
      schema: z.ZodObject,
      execute: (input: Record<string, unknown>) => Promise<ToolOutcome>
    ): DesktopToolEntry => ({
      id,
      def: { id, name, summary, description, source: "builtin", risk },
      jsonSchema: Object.keys(schema.shape).length ? toJsonSchema(schema) : emptyObject,
      validator: schema,
      execute: (input) => execute((input ?? {}) as Record<string, unknown>),
    })
    const entries: DesktopToolEntry[] = [
      {
        id: "desktop.use",
        def: {
          id: "desktop.use",
          name: "桌面：指定桌面",
          summary: "指定用哪台桌面（一般不用调，系统会自动分配一台空着的）",
          description: `一般不用调：第一次用桌面工具时，系统从本任务允许的桌面里自动分配一台空着的。只有任务要求用某一台时才调，而且必须在第一次用桌面工具之前调；它正被别的运行用着时会挂起，等它空出来。一次运行从头到尾只用一台桌面，分到以后不能再换。本任务允许的：${this.desktopList()}。`,
          source: "builtin",
          risk: "read",
        },
        jsonSchema: {
          type: "object",
          properties: { desktopId: { type: "string", ...(ids.length ? { enum: ids } : {}), description: `桌面的 id。可选：${this.desktopList()}` } },
          required: ["desktopId"],
          additionalProperties: false,
        },
        validator: z.object({ desktopId: z.string().min(1) }),
        execute: (input) => this.use((input as { desktopId: string }).desktopId),
      },
    ]
    for (const def of DESKTOP_MCP_TOOL_DEFS) {
      const schema = def.schema(this.allowVision)
      entries.push({
        id: def.id,
        def: { id: def.id, name: def.name, summary: def.summary, description: def.description, source: "builtin", risk: def.risk },
        jsonSchema: toJsonSchema(schema),
        validator: schema,
        execute: (input) => {
          const args = (input ?? {}) as Record<string, unknown>
          // 有中文等非 ASCII 字的输入不走 Windows-MCP 的 Type（0.8.8 报「打好了」但字没上屏），见 typeText
          if (def.id === "desktop.type" && typeof args.text === "string" && NON_ASCII.test(args.text)) return this.typeText(args as unknown as TypeInput)
          return this.callMcp(def.mcpName, def.toArgs ? def.toArgs(args, this.allowVision) : args)
        },
      })
    }
    if (this.allowVision)
      entries.push(
        own(
          "desktop.look",
          "桌面：看画面",
          "截桌面现在的画面作为图片发给你看（控件树里看不到的内容才用）",
          "截桌面现在的整个屏幕，作为图片发给你看，同时存成这次运行的文件。界面控件读不到的软件（desktop_snapshot 里看不到内容）、要确认画面上的结果时用；每看一次多一张图的费用，别每步都看。输出里写了屏幕坐标怎么换算。",
          "read",
          z.object({}),
          () => this.look()
        )
      )
    entries.push(
      own(
        "desktop.send_file",
        "桌面：传文件到桌面",
        "把这次运行的文件（附件、产物、下载的）传到桌面上，返回桌面上的路径",
        "把这次运行里的一个文件（fileId：附件、存的文件、下载的文件）传到桌面上（放在 C:\\HeyAgent\\files\\<日期>\\ 下），返回桌面上的完整路径，之后可以在软件里用「打开文件」或拖进去。",
        "external",
        z.object({ fileId: z.string().min(1).describe("这次运行里的文件 id") }),
        (input) => this.sendFile(String(input.fileId))
      ),
      own(
        "desktop.fetch_file",
        "桌面：取回桌面上的文件",
        "把桌面上的一个文件取回来，存成这次运行的文件（返回文件 id）",
        "把桌面上的文件（完整路径，只能是用户目录 %USERPROFILE% 或 C:\\HeyAgent\\files 下面的，最多 200 MB）取回来，存成这次运行的文件（空间的 downloads/ 下），返回文件 id，之后可以用 file.read 读。",
        "read",
        z.object({ path: z.string().min(1).max(1000).describe("桌面上的完整路径，例如 C:\\Users\\me\\Desktop\\报表.xlsx") }),
        (input) => this.fetchFile(String(input.path))
      ),
      own(
        "desktop.ask_human",
        "桌面：请人在桌面上操作",
        "要人在这台桌面上动手做的事（扫码、登录、点一下、处理弹框、输入只有人知道的东西）都用它，不要用 ask_human",
        "要人在这台桌面上动手做的事一律用它（不要用通用的 ask_human，那个没有截图、不保留桌面、人也打不开远程画面）：扫码登录、输入只有人知道的东西（验证码、密码）、点一下你点不了的地方、处理你处理不了的弹框、任务步骤要求请人在桌面上做的事。系统截图、交给任务负责人在远程画面里处理，这次运行先挂起，桌面保留给你；人处理好后叫你继续，接着用同一台桌面。reason 写清楚要人做什么。",
        "read",
        z.object({ reason: z.string().trim().min(1).max(500).describe("要人做什么、为什么（给人看）") }),
        (input) => this.askHuman(String(input.reason))
      )
    )
    return entries
  }

  private async use(desktopId: string): Promise<ToolOutcome> {
    if (!this.desktops.some((desktop) => desktop.id === desktopId))
      return fail(`本任务不允许用桌面 ${desktopId}。可选：${this.desktops.map((desktop) => desktop.id).join("、") || "无"}`)
    if (this.assigned === desktopId) return { output: `这次运行已经在用桌面「${this.desktopName(desktopId)}」（${desktopId}），不用再指定。` }
    if (this.assigned)
      return fail(`一次运行只能用一台桌面：这次运行已经在用桌面「${this.desktopName(this.assigned)}」（${this.assigned}），不能换成 ${desktopId}。接着用现在这台就行。`)
    await this.assign(desktopId)
    return { output: `已指定桌面「${this.desktopName(desktopId)}」（${desktopId}），这次运行之后都用它。下一次调桌面工具时占用；它正被别的运行用着的话会挂起等它。` }
  }

  private async assign(desktopId: string) {
    if (this.assigned === desktopId) return
    this.assigned = desktopId
    await this.ctx.db.update(t.sessions).set({ desktopId }).where(eq(t.sessions.id, this.ctx.session.id))
  }

  private startHolding() {
    this.holding = true
    if (this.timer) return
    this.timer = setInterval(() => {
      void renewDesktopLease(this.ctx.db, this.ctx.session.id).catch((error) => console.warn(`[desktop] 续约失败：${(error as Error).message}`))
    }, DESKTOP_HEARTBEAT_MS)
    this.timer.unref()
  }

  /** 占到以后：读配置和密钥（同一台只读一次） */
  private async targetOf(desktopId: string): Promise<DesktopTarget | undefined> {
    if (this.target?.id === desktopId) return this.target
    this.target = await loadDesktopTarget(this.ctx.db, getKeyring(), desktopId)
    return this.target
  }

  /** 占上一台：新占到的记一条过程（「桌面 <id>；」开头，桌面页「最近用它的运行」按这个认） */
  private async take(desktopId: string): Promise<"ok" | "busy"> {
    const result = await acquireDesktop(this.ctx.db, desktopId, this.ctx.session.id)
    if (result === "busy") return "busy"
    this.startHolding()
    if (result === "new")
      await appendEvent(this.ctx.db, this.ctx.session.id, {
        kind: "plan",
        title: `用桌面「${this.desktopName(desktopId)}」`,
        detail: `桌面 ${desktopId}；一次运行从头到尾只用这一台`,
      })
    return "ok"
  }

  /**
   * 每次调桌面工具前：分配 / 占用 / 续约。返回连接信息，或者要交给 agent 的结果（报错、挂起等桌面）。
   * 第一次分配时按顺序挑空着的、能连上的；连不上的放开换下一台。
   */
  private async ensure(): Promise<DesktopTarget | ToolOutcome> {
    if (!this.desktops.length) return fail("本任务没有可用的桌面（任务里允许的桌面都不在了），请让负责人检查任务设置")
    if (this.assigned) {
      const desktopId = this.assigned
      if ((await this.take(desktopId)) === "busy") {
        this.holding = false
        return this.busyOutcome(desktopId)
      }
      const target = await this.targetOf(desktopId)
      if (!target) return fail(`桌面 ${desktopId} 已经被删掉了，这次运行用不了桌面，请报告给负责人`)
      return target
    }
    const ids = this.desktops.map((desktop) => desktop.id)
    const busy = await busyDesktopIds(this.ctx.db, ids, this.ctx.session.id)
    const errors: string[] = []
    for (const desktopId of ids.filter((id) => !busy.has(id))) {
      if ((await this.take(desktopId)) === "busy") continue
      const target = await this.targetOf(desktopId)
      // 连不上的不分给这次运行：放开，换下一台
      const problem = target ? await this.connect(target).then(() => undefined, (error: unknown) => errorText(error)) : "已经被删掉了"
      if (problem) {
        errors.push(`「${this.desktopName(desktopId)}」：${problem}`)
        await this.dropConnection()
        await releaseSessionDesktop(this.ctx.db, this.ctx.session.id, { desktopId })
        this.holding = false
        continue
      }
      await this.assign(desktopId)
      return target!
    }
    if (errors.length) return fail(`桌面连不上：${errors.join("；")}。先不要反复重试，换一种做法或者停下来报告。`)
    return this.busyOutcome(ids.length === 1 ? ids[0] : undefined)
  }

  /** 桌面被别的运行占着：挂起等它空出来（指定了某台就只等它，否则等任一台） */
  private async busyOutcome(desktopId?: string): Promise<ToolOutcome> {
    const settings = await loadEngineSettings(this.ctx.db)
    const what = desktopId ? `桌面「${this.desktopName(desktopId)}」正在被别的运行用` : `本任务允许的 ${this.desktops.length} 台桌面都在被别的运行用`
    return {
      output: `${what}，已排队等它空出来。先挂起，轮到时会叫你继续。`,
      suspend: {
        kind: "wait",
        input: {
          what: `等待桌面：${what}`,
          triggerKind: "event",
          event: desktopId ? desktopEventName(desktopId) : ANY_DESKTOP_EVENT,
          fallbackDays: settings.eventFallbackDays,
          deadlineAt: new Date(Date.now() + settings.eventFallbackDays * 24 * 60 * 60 * 1000),
        },
      },
    }
  }

  private connect(target: DesktopTarget): Promise<MCPClient> {
    if (!this.mcp) {
      const connecting = connectDesktopMcp(target)
      this.mcp = connecting
      connecting.catch(() => {
        if (this.mcp === connecting) this.mcp = undefined
      })
    }
    return this.mcp
  }

  private async dropConnection() {
    const mcp = this.mcp
    this.mcp = undefined
    await (await mcp?.catch(() => undefined))?.close().catch(() => {})
  }

  private unreachable(target: DesktopTarget, error: unknown): ToolOutcome {
    const reason = error instanceof DesktopUnreachableError ? error.message : errorText(error)
    return fail(`桌面「${target.name}」连不上：${reason}。先不要反复重试，换一种做法或者停下来报告。`)
  }

  private async callMcp(name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const ready = await this.ensure()
    if (!("key" in ready)) return ready
    return this.mcpCall(ready, name, args)
  }

  /**
   * 调一次 Windows-MCP 的工具。有人正在操作这台桌面时 Windows-MCP 会拒绝（desktop/control.ts）：
   * 等它说的秒数再试，总共最多约 15 秒；还不行、或者做到一半被抢走了，报清楚的错误
   */
  private async mcpCall(target: DesktopTarget, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    const deadline = Date.now() + desktopControlRetry.maxWaitMs
    for (let attempt = 1; ; attempt++) {
      const outcome = await this.mcpCallOnce(target, name, args)
      const block = outcome.isError ? parseControlBlock(outcome.output) : undefined
      if (!block) return outcome
      if (!retryable(block))
        return fail(`操作做到一半被打断了：有人在操作这台桌面（远程画面里），已经做了 ${block.executedSteps} 步。先用 desktop_snapshot 看看现在的样子，再决定要不要重做，不要直接重来（Windows-MCP：${block.code}）`)
      const delay = retryDelayMs(block)
      if (Date.now() + delay > deadline) return fail(`${HUMAN_BUSY_TEXT}（等了 ${attempt} 次还是不行；Windows-MCP：${block.code}）`)
      await sleep(delay)
    }
  }

  private async mcpCallOnce(target: DesktopTarget, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
    let client: MCPClient
    try {
      client = await this.connect(target)
    } catch (error) {
      return this.unreachable(target, error)
    }
    try {
      const result = await client.callTool({ name, arguments: args, options: { timeout: CALL_TIMEOUT_MS } })
      return mcpResultOutcome(result, [target.key], { images: name === "Snapshot" && this.allowVision, imageName: "snapshot" })
    } catch (error) {
      if (isConnectionError(error)) {
        // 连接断了：下次重新连
        await this.dropConnection()
        return this.unreachable(target, error)
      }
      return fail(`桌面工具 ${name} 出错：${errorText(error).split(target.key).join("[已隐藏]")}`)
    }
  }

  /**
   * desktop.type 里有中文等非 ASCII 字：Windows-MCP 0.8.8 的 Type 报「打好了」但字没上屏（ASCII 照常走 Type）。改成：
   * 先用 Click 点到输入框（给了 label / loc 时）→ clear 时 ctrl+a、backspace → caret_position 是 start / end 时 ctrl+home / ctrl+end →
   * 文字交给桌面服务输入（POST /type，它自己处理换行和长文字）→ press_enter 时按 enter
   */
  private async typeText(input: TypeInput): Promise<ToolOutcome> {
    const ready = await this.ensure()
    if (!("key" in ready)) return ready
    const target = ready
    const step = async (name: string, args: Record<string, unknown>, what: string) => {
      const outcome = await this.mcpCall(target, name, args)
      return outcome.isError ? { ...outcome, output: `${what}没成功：${outcome.output}` } : undefined
    }
    const where = input.label !== undefined ? { label: input.label } : input.loc ? { loc: input.loc } : undefined
    const failed =
      (where && (await step("Click", { ...where, button: "left", clicks: 1 }, "点输入框"))) ||
      (input.clear && ((await step("Shortcut", { shortcut: "ctrl+a" }, "清空（全选）")) || (await step("Shortcut", { shortcut: "backspace" }, "清空（删除）")))) ||
      (input.caret_position === "start" && (await step("Shortcut", { shortcut: "ctrl+home" }, "把光标移到开头"))) ||
      (input.caret_position === "end" && (await step("Shortcut", { shortcut: "ctrl+end" }, "把光标移到结尾")))
    if (failed) return failed
    let chars: number
    try {
      chars = await agentType(target, input.text)
    } catch (error) {
      if (error instanceof DesktopUnreachableError) return this.unreachable(target, error)
      return fail(`输入文字没成功：${(error as Error).message}`)
    }
    if (input.press_enter) {
      const enter = await step("Shortcut", { shortcut: "enter" }, `文字已经输入了（${chars} 个字），按回车`)
      if (enter) return enter
    }
    return { output: `已输入 ${chars} 个字${where ? "（先点了输入框）" : "（输入到当前焦点）"}${input.clear ? "，原来的内容先清空了" : ""}${input.press_enter ? "，按了回车" : ""}。要确认结果再看一下界面。` }
  }

  /** desktop.look：截整个屏幕发给模型（只有这个工具发图），存成运行文件 */
  private async look(): Promise<ToolOutcome> {
    const ready = await this.ensure()
    if (!("key" in ready)) return ready
    const target = ready
    let shot
    try {
      shot = await agentScreenshot(target, { maxWidth: 1920, quality: 70 })
    } catch (error) {
      if (error instanceof DesktopUnreachableError) return this.unreachable(target, error)
      return fail(`截图没成功：${(error as Error).message}`)
    }
    const name = `look-${Date.now()}.jpg`
    const row = await saveFile(this.ctx.db, { data: shot.data, name, mime: "image/jpeg", kind: "screenshot", sessionId: this.ctx.session.id })
    const same = shot.width === shot.screenWidth && shot.height === shot.screenHeight
    const scale = shot.width ? shot.screenWidth / shot.width : 1
    return {
      output: same
        ? `桌面「${target.name}」现在的画面已作为下一条消息发给你：宽 ${shot.width}、高 ${shot.height}，和屏幕坐标一比一（原点在左上角，x 向右、y 向下），可以直接用作 loc。截图也存成了这次运行的文件 ${row.id}。`
        : `桌面「${target.name}」现在的画面已作为下一条消息发给你：图片宽 ${shot.width}、高 ${shot.height}，屏幕是 ${shot.screenWidth}×${shot.screenHeight}。图上的点 (x, y) 对应屏幕坐标 (x×${scale.toFixed(3)}, y×${scale.toFixed(3)})，用作 loc 前先换算。截图也存成了这次运行的文件 ${row.id}。`,
      images: [{ name, mime: "image/jpeg", base64: shot.data.toString("base64") }],
    }
  }

  private async sendFile(fileId: string): Promise<ToolOutcome> {
    const row = await getFileRow(this.ctx.db, fileId)
    const allowed = row && (row.sessionId === this.ctx.session.id || this.ctx.snapshot.attachments.some((file) => file.id === row.id))
    if (!row || !allowed) return fail(`这次运行里没有文件 ${fileId}`)
    const ready = await this.ensure()
    if (!("key" in ready)) return ready
    const target = ready
    try {
      const saved = await agentUpload(target, row.name, await readFileData(row))
      return { output: `已把文件 ${row.id}（${row.name}，${saved.size} 字节）传到桌面「${target.name}」：${saved.path}` }
    } catch (error) {
      if (error instanceof DesktopUnreachableError) return this.unreachable(target, error)
      return fail(`传文件没成功：${(error as Error).message}`)
    }
  }

  private async fetchFile(path: string): Promise<ToolOutcome> {
    const ready = await this.ensure()
    if (!("key" in ready)) return ready
    const target = ready
    try {
      const file = await agentDownload(target, path)
      const row = await saveFile(this.ctx.db, { data: file.data, name: file.name, kind: "download", sessionId: this.ctx.session.id })
      return {
        output: `已从桌面「${target.name}」取回 ${path}，存成这次运行的文件 ${row.id}（${row.name}，${row.size} 字节，空间路径 ${spacePathOf(row)}）。`,
        facts: { fileId: row.id, fileName: row.name },
      }
    } catch (error) {
      if (error instanceof DesktopUnreachableError) return this.unreachable(target, error)
      return fail(`取文件没成功：${(error as Error).message}`)
    }
  }

  /** desktop.ask_human：截图存证、生成「登录」类要人办的事给任务负责人、运行等人处理；工具网关关闭时桌面转成 held */
  private async askHuman(reason: string): Promise<ToolOutcome> {
    const ready = await this.ensure()
    if (!("key" in ready)) return ready
    const target = ready
    const { db, session, snapshot } = this.ctx
    const shot = await agentScreenshot(target, { maxWidth: 1280, quality: 70 }).catch(() => undefined)
    const file = shot ? await saveFile(db, { data: shot.data, name: `needs-human-${Date.now()}.jpg`, mime: "image/jpeg", kind: "screenshot", sessionId: session.id }) : undefined
    const settings = await readBrowserSettings(db)
    this.holdMinutes = settings.humanHoldMinutes
    const title = `在桌面上处理：${reason.length > 40 ? `${reason.slice(0, 40)}…` : reason}`
    const detail: HumanDetail = {
      sections: [
        { title: "要你做什么", text: reason },
        { title: "桌面", text: `「${target.name}」（${target.id}）` },
        {
          title: "怎么处理",
          text: `打开下面这台桌面的远程画面，在里面处理好，再点「已处理好了」，agent 会在同一台桌面上接着做。桌面保留 ${settings.humanHoldMinutes} 分钟；过了时间会放开给别的运行用，到时点「已处理好了」会重新占这台桌面（被占着就等它）。`,
        },
        { title: "来自", text: `任务「${snapshot.task.title}」的运行 ${session.id}` },
      ],
      primary: "已处理好了",
      secondary: "处理不了",
      link: { page: "desktops", id: target.id },
      desktop: { desktopId: target.id, sessionId: session.id, reason, ...(file ? { screenshotFileId: file.id } : {}) },
    }
    return {
      output: `已请人在桌面「${target.name}」上处理：${reason}。处理好后会叫你继续；继续后先用 desktop_snapshot 看一下现状再接着做。${file ? `截图：${file.id}` : ""}`,
      suspend: {
        kind: "human",
        item: {
          kind: "login",
          title,
          summary: `运行 ${session.id} 请人在桌面「${target.name}」上处理：${reason}。打开远程画面处理好后点「已处理好了」。桌面保留 ${settings.humanHoldMinutes} 分钟。`,
          assigneeId: snapshot.task.ownerId,
          taskId: snapshot.task.id,
          sessionId: session.id,
          urgency: 1,
          detail,
          what: `等人处理：${title}`,
        },
      },
    }
  }

  /** 规则要求「截图存证」：这次运行占着桌面时截一张，存成运行文件；没占着返回 undefined */
  async evidenceScreenshot(): Promise<{ fileId: string } | undefined> {
    if (!this.holding || !this.assigned) return undefined
    const target = await this.targetOf(this.assigned).catch(() => undefined)
    if (!target) return undefined
    const shot = await agentScreenshot(target, { maxWidth: 1280, quality: 70 }).catch(() => undefined)
    if (!shot) return undefined
    const row = await saveFile(this.ctx.db, { data: shot.data, name: `rule-${Date.now()}.jpg`, mime: "image/jpeg", kind: "screenshot", sessionId: this.ctx.session.id })
    return { fileId: row.id }
  }

  /** 工具网关关闭（运行结束、挂起、交接）：调过 ask_human 的转成 held 保留给这个运行；否则放开、叫醒等它的 */
  async close() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
    this.holding = false
    await this.dropConnection()
    const { db, session } = this.ctx
    const holdMinutes = this.holdMinutes
    this.holdMinutes = undefined
    try {
      if (holdMinutes) {
        // 转成 held 和记一条在同一个事务里：看到 held 就看得到这条
        await db.transaction(async (tx) => {
          const desktopId = await holdDesktop(tx, session.id, holdMinutes)
          if (desktopId)
            await appendEvent(tx, session.id, { kind: "wait", title: `桌面「${this.desktopName(desktopId)}」保留 ${holdMinutes} 分钟，等人在远程画面里处理` })
        })
        return
      }
      await releaseSessionDesktop(db, session.id)
    } catch (error) {
      console.warn(`[desktop] 放开 session ${session.id} 的桌面出错：${(error as Error).message}`)
    }
  }
}
