// 工具桥（docs/dev/solidify.md 4.1、4.6、15.2 第 4 条）：固化脚本在沙箱里（不能上网）通过 SDK 发请求，
// 经一个 unix socket（目录只读挂到沙箱的 /tmp/.tools）到这里，再交给这次运行的工具网关 gateway.call()——
// 规则、白名单、审批、验证码 / 登录页检测、过程记录都和 agent 自己调一样。
// 协议：一行一个 JSON。请求 { id, op, … }，op = tool（tool、input）/ commit（label）/ verified（note）/ log（text）/
// fail（kind: input | page、reason）/ now / done（ok、error?、name?）；回复 { id, ok, text?, data?, error?, code? }，
// code = step_error（工具出错）/ denied（被规则拦下）/ stop（脚本要停下了）。
// 一次只处理一个请求（和引擎处理模型的调用一样按顺序）；每次调工具前看一眼运行还在不在跑。
// 停下以后（要审批、要挂起、ha.fail、超过次数、试跑走到提交前……）所有请求一律回 stop。
// 试跑（mode = test）：ha.commit 就停；work.report / run.finish / checkpoint.mark 只记下来、不生效；
// 会对外发送、改东西的非浏览器工具停在它前面。试用期（trial）：每个 ha.commit 先截图存证。
import { rmSync } from "node:fs"
import net from "node:net"

import {
  builtinToolInputs,
  routineStopKindLabel,
  type EventTrace,
  type Risk,
  type RoutineRecorded,
  type RoutineStop,
  type RoutineStopKind,
  type SessionRoutineState,
} from "@heyagent/shared"

import type { GatewayResult, ModelToolCall } from "../../engine/gateway.js"
import type { AgentClaim } from "../../engine/outcome.js"
import type { EventInput } from "../../engine/records.js"
import type { SuspendPlan } from "../../engine/tools/builtin.js"

/** 工具桥要用的网关的几个方法（测试里换成假的） */
export interface BridgeGateway {
  call(call: ModelToolCall, options: { routineStep?: number }): Promise<GatewayResult>
  stillRunning(): Promise<boolean>
  toolInfo(toolName: string): { id: string; risk?: Risk } | undefined
  screenshot(): Promise<{ fileId: string } | undefined>
}

export interface BridgeOptions {
  sessionId: string
  gateway: BridgeGateway
  /** 这次的脚本状态（工具桥就地改它，每次请求后 save） */
  state: SessionRoutineState
  /** run = 普通运行先跑脚本；test = 固化试跑 */
  mode: "run" | "test"
  /** 试用期：每个 ha.commit 先截图存证 */
  trial: boolean
  /** 一次运行最多调几次工具 */
  maxCalls: number
  /** 存脚本状态（sessions.routine） */
  save: (state: SessionRoutineState) => Promise<void>
  /** 记一条过程（ha.log、提交前截图、试跑记下的调用） */
  event: (event: EventInput) => Promise<void>
  /** 停下了：调用方过一会儿杀掉沙箱（脚本接住 RoutineStop 还不退出的话） */
  onStop?: (kind: RoutineStopKind) => void
}

/** 脚本报的 done */
export interface BridgeDone {
  ok: boolean
  error?: string
  /** 抛出来的错的名字：StepError / Denied / RoutineStop / 别的（脚本自己的错） */
  name?: string
  stack?: string
}

interface Request {
  id?: unknown
  op?: unknown
  tool?: unknown
  input?: unknown
  label?: unknown
  note?: unknown
  text?: unknown
  kind?: unknown
  reason?: unknown
  ok?: unknown
  error?: unknown
  name?: unknown
  stack?: unknown
}

interface Reply {
  ok: boolean
  text?: string
  data?: unknown
  error?: string
  code?: "step_error" | "denied" | "stop"
}

/** 试跑时只记下来、不真调的工具 */
const RECORDED_IN_TEST = new Set(["work.report", "run.finish", "checkpoint.mark"])
/** 脚本里不能调的：批由网关展开（每一步要各自带 routineStep），脚本一步一步调就行；旧的报没完成用 ha.finish */
const NOT_FOR_SCRIPTS = new Set(["browser.batch", "run.not_done"])
/** ha.log 最多记几条 */
const MAX_LOGS = 50

const str = (value: unknown) => (typeof value === "string" ? value : value === undefined || value === null ? "" : String(value))
const firstLine = (text: string, max = 300) => {
  const line = text.split("\n").find((each) => each.trim())?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** 一步的说明：工具短名 + 元素描述（「click「查询」」），不取要填的内容 */
export function stepLabel(toolId: string, input: unknown): string {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  const short = toolId.replace(/^browser\./, "")
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
  let detail = text(args.element) || text(args.startElement)
  if (Array.isArray(args.fields))
    detail = args.fields
      .map((field) => text((field as { name?: unknown } | null)?.name))
      .filter(Boolean)
      .join("、")
  else if (args.fields && typeof args.fields === "object") detail = Object.keys(args.fields).join("、")
  if (args.outcomes && typeof args.outcomes === "object") detail = Object.keys(args.outcomes).join(" / ")
  detail ||= text(args.key) || text(args.url) || text(args.target) || text(args.path) || text(args.fileId)
  if (detail.length > 40) detail = `${detail.slice(0, 39)}…`
  return detail ? `${short}「${detail}」` : short
}

/** 上海时间的 ISO 写法（ha.now） */
export function shanghaiNow(now = new Date()): string {
  return new Date(now.getTime() + 8 * 60 * 60 * 1000).toISOString().replace("Z", "+08:00")
}

export class ToolBridge {
  private readonly server: net.Server
  private readonly options: BridgeOptions
  private chain: Promise<unknown> = Promise.resolve()
  private readonly sockets = new Set<net.Socket>()
  /** 停下的原因（有了以后一律回 stop） */
  stopped?: RoutineStop
  /** 脚本报的结果（普通运行：run.finish 真调了；试跑记在 state.recorded.finish） */
  finish?: AgentClaim
  /** 要挂起：交回引擎，和交接的话一起落库 */
  suspend?: { plan: SuspendPlan; output: string }
  /** 最后一次没成功的调用（脚本没接住时，按它记停在哪） */
  lastFailure?: RoutineStop
  done?: BridgeDone

  private constructor(options: BridgeOptions) {
    this.options = options
    this.server = net.createServer((socket) => this.accept(socket))
  }

  /** 在 socketPath 上听（目录要已经建好；同名的旧 socket 先删掉） */
  static async listen(socketPath: string, options: BridgeOptions): Promise<ToolBridge> {
    rmSync(socketPath, { force: true })
    const bridge = new ToolBridge(options)
    await new Promise<void>((resolve, reject) => {
      bridge.server.once("error", reject)
      bridge.server.listen(socketPath, () => {
        bridge.server.off("error", reject)
        resolve()
      })
    })
    bridge.socketPath = socketPath
    return bridge
  }

  private socketPath?: string

  get state() {
    return this.options.state
  }

  async close() {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    if (this.socketPath) rmSync(this.socketPath, { force: true })
  }

  private accept(socket: net.Socket) {
    this.sockets.add(socket)
    socket.setEncoding("utf8")
    let buffer = ""
    socket.on("data", (chunk: string) => {
      buffer += chunk
      for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
        const line = buffer.slice(0, at)
        buffer = buffer.slice(at + 1)
        if (!line.trim()) continue
        // 按顺序一个一个处理（脚本同时发好几个也一样）
        this.chain = this.chain.then(() => this.onLine(socket, line))
      }
    })
    socket.on("error", () => {})
    socket.on("close", () => this.sockets.delete(socket))
  }

  private async onLine(socket: net.Socket, line: string) {
    let request: Request
    try {
      request = JSON.parse(line) as Request
    } catch {
      return
    }
    let reply: Reply
    try {
      reply = await this.handle(request)
    } catch (error) {
      reply = { ok: false, code: "step_error", error: `工具桥出错：${(error as Error).message}` }
    }
    if (!socket.destroyed) socket.write(`${JSON.stringify({ id: request.id, ...reply })}\n`)
  }

  private stopReply(): Reply {
    return { ok: false, code: "stop", error: this.stopped ? `脚本停下了：${this.stopped.reason}` : "脚本停下了" }
  }

  /** 停下：记在状态上，之后一律回 stop。已经停了就不改 */
  async stopWith(kind: RoutineStopKind, reason: string, extra: { step?: number; tool?: string; label?: string } = {}): Promise<Reply> {
    if (!this.stopped) {
      this.stopped = {
        step: extra.step ?? this.state.steps,
        kind,
        ...(extra.tool ? { tool: extra.tool } : {}),
        ...(extra.label ? { label: extra.label } : {}),
        reason: reason || routineStopKindLabel[kind],
      }
      this.state.stoppedAt = this.stopped
      await this.options.save(this.state)
      this.options.onStop?.(kind)
    }
    return this.stopReply()
  }

  /** 等手上的请求都处理完（沙箱被杀时可能正在等一个工具） */
  async idle() {
    let current: Promise<unknown>
    do {
      current = this.chain
      await current.catch(() => {})
    } while (current !== this.chain)
  }

  private async handle(request: Request): Promise<Reply> {
    const op = str(request.op)
    if (op === "done") {
      this.done = {
        ok: request.ok === true,
        ...(request.error !== undefined ? { error: str(request.error) } : {}),
        ...(request.name !== undefined ? { name: str(request.name) } : {}),
        ...(request.stack !== undefined ? { stack: str(request.stack) } : {}),
      }
      return { ok: true }
    }
    if (this.stopped || this.done) return this.stopReply()
    switch (op) {
      case "tool":
        return this.tool(str(request.tool), request.input ?? {})
      case "commit":
        return this.commit(str(request.label).trim() || "（没写说明）")
      case "verified": {
        const note = str(request.note).trim() || "核对过了"
        const open = [...this.state.commits].reverse().find((commit) => commit.verified === undefined)
        if (open) open.verified = note
        await this.options.save(this.state)
        return { ok: true }
      }
      case "log": {
        const text = str(request.text).trim().slice(0, 500)
        if (text) {
          const logs = (this.state.logs ??= [])
          if (logs.length < MAX_LOGS) logs.push(text)
          await this.options.save(this.state)
          await this.options.event({ kind: "plan", title: `流程记录：${text.slice(0, 200)}`, ...(text.length > 200 ? { detail: text } : {}) })
        }
        return { ok: true }
      }
      case "fail": {
        const kind = str(request.kind) === "input" ? "input" : "page"
        return this.stopWith(kind, str(request.reason).trim().slice(0, 1000) || routineStopKindLabel[kind])
      }
      case "now":
        return { ok: true, data: shanghaiNow() }
      default:
        return { ok: false, code: "step_error", error: `不认识的请求 ${op || "（空）"}` }
    }
  }

  private async tool(toolName: string, input: unknown): Promise<Reply> {
    const { gateway, maxCalls, mode, sessionId } = this.options
    if (!toolName) return { ok: false, code: "step_error", error: "要写工具 id" }
    // 报了结果就结束了：后面的调用不做（结果照算，不算停下）
    if (this.finish || this.state.recorded?.finish) return { ok: false, code: "stop", error: "已经报了结果（ha.finish），后面的调用不再做" }
    if (this.state.steps >= maxCalls) return this.stopWith("limit", `一次最多调 ${maxCalls} 次工具，到上限了`)
    // 每次调之前看一眼：运行被取消了就停
    if (!(await gateway.stillRunning())) return this.stopWith("cancelled", "运行被取消了")
    const info = gateway.toolInfo(toolName)
    const toolId = info?.id ?? toolName
    if (NOT_FOR_SCRIPTS.has(toolId))
      return { ok: false, code: "step_error", error: toolId === "browser.batch" ? "脚本里不用 browser.batch：一步一步调就行" : "用 ha.finish 报结果" }
    const step = this.state.steps + 1
    const label = stepLabel(toolId, input)
    const where = { step, tool: toolId, label }
    const trace: EventTrace = { routineStep: step }

    if (mode === "test") {
      // 试跑：会让结果生效的几个工具只记下来
      if (RECORDED_IN_TEST.has(toolId)) return this.record(toolId, input, step, label, trace)
      // 不是浏览器、不是文件、风险也不是只读的（会对外发送、改东西）：停在它前面，不做
      if (info && !toolId.startsWith("browser.") && !toolId.startsWith("file.") && info.risk !== "read")
        return this.stopWith("test_blocked", `下一步 ${label} 会对外发送或改东西，试跑不做`, where)
    }

    this.state.steps = step
    const result = await gateway.call({ toolCallId: `${sessionId}-r${step}`, toolName, input }, { routineStep: step })
    if (result.approval) {
      // 没做：这一步不算调过
      this.state.steps = step - 1
      return this.stopWith("approval", `${label} 要人审批（规则「${result.approval.ruleName}」：${result.approval.reason}）`, where)
    }
    if (result.outcome.suspend && !result.denied) {
      this.suspend = { plan: result.outcome.suspend, output: result.output }
      return this.stopWith("suspend", firstLine(result.output) || routineStopKindLabel.suspend, where)
    }
    if (result.denied) {
      this.lastFailure = { ...where, kind: "denied", reason: firstLine(result.output.replace(/^被拦下：/, "")) }
      await this.options.save(this.state)
      return { ok: false, code: "denied", error: result.output }
    }
    if (result.outcome.isError) {
      this.lastFailure = { ...where, kind: "step_error", reason: firstLine(result.output.replace(/^工具出错：/, "")) }
      await this.options.save(this.state)
      return { ok: false, code: "step_error", error: result.output }
    }
    if (result.outcome.finish) this.finish = result.outcome.finish
    await this.options.save(this.state)
    return { ok: true, text: result.output, ...(result.outcome.data !== undefined ? { data: result.outcome.data } : {}) }
  }

  /** 试跑：work.report、run.finish、checkpoint.mark 按参数格式查过以后只记下来，不生效 */
  private async record(toolId: string, input: unknown, step: number, label: string, trace: EventTrace): Promise<Reply> {
    const parsed = builtinToolInputs[toolId as "work.report" | "run.finish" | "checkpoint.mark"].safeParse(input)
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`)
        .join("；")
      this.state.steps = step
      this.lastFailure = { step, tool: toolId, label, kind: "step_error", reason: `参数不对：${issues}` }
      await this.options.save(this.state)
      return { ok: false, code: "step_error", error: `参数不对：${issues}` }
    }
    const recorded: RoutineRecorded = (this.state.recorded ??= {})
    let note: string
    if (toolId === "run.finish") {
      const value = parsed.data as { outcome: "achieved" | "not_achieved"; summary: string; evidence: string; reason?: string }
      if (value.outcome !== "achieved" && !value.reason?.trim()) {
        this.state.steps = step
        this.lastFailure = { step, tool: toolId, label, kind: "step_error", reason: "outcome = not_achieved 时要写 reason" }
        await this.options.save(this.state)
        return { ok: false, code: "step_error", error: "outcome = not_achieved 时要写 reason：拿到了什么、缺了什么、为什么" }
      }
      recorded.finish = { outcome: value.outcome, summary: value.summary, evidence: value.evidence, ...(value.reason ? { reason: value.reason } : {}) }
      note = `结果：${value.outcome === "achieved" ? "办成" : "没办成"}。${value.summary}`
    } else if (toolId === "work.report") {
      const value = parsed.data as { data?: Record<string, string | number | boolean> }
      recorded.report = { ...(recorded.report ?? {}), ...(value.data ?? {}) }
      note = `交回的结果：${JSON.stringify(value.data ?? {})}`
    } else {
      const value = parsed.data as { checkpoint: number; status: string; record?: string }
      ;(recorded.checkpoints ??= []).push({ checkpoint: value.checkpoint, status: value.status, ...(value.record ? { record: value.record } : {}) })
      note = `第 ${value.checkpoint} 个检查点：${value.status}`
    }
    this.state.steps = step
    await this.options.save(this.state)
    await this.options.event({
      kind: "plan",
      title: `固化试跑：记下 ${label}（没生效）`,
      detail: note.slice(0, 2000),
      toolId,
      input: JSON.stringify(parsed.data),
      trace,
    })
    return { ok: true, text: `试跑：${toolId} 只记下来，没有生效。` }
  }

  private async commit(label: string): Promise<Reply> {
    const { mode, trial, gateway } = this.options
    if (mode === "test") return this.stopWith("test_commit", `走到第一次提交前（${label}），试跑停在这里，没做`, { step: this.state.steps, label })
    if (trial) {
      // 试用期：提交前截图存证
      const shot = await gateway.screenshot().catch(() => undefined)
      await this.options.event({
        kind: "plan",
        title: `提交前截图：${label.slice(0, 200)}`,
        detail: shot ? `固化流程试用期，提交前自动截图存证：文件 ${shot.fileId}` : "固化流程试用期，提交前要截图存证，但现在没开浏览器、截不了",
        ...(shot ? { output: shot.fileId } : {}),
        ...(this.state.steps ? { trace: { routineStep: this.state.steps } } : {}),
      })
    }
    this.state.commits.push({ step: this.state.steps, label })
    await this.options.save(this.state)
    return { ok: true }
  }
}
