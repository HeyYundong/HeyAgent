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
// 重放日志（docs/dev/solidify.md 17.2）：普通运行把每个请求（tool、commit、verified、log、now）记进 routine_journal，
// 工具调用开始前先写一行（reply 为空）、做完补上，进程被杀时知道哪一步做到一半。停下等人（审批、验证码、登录页）
// 或者进程被杀以后，从头再跑一遍脚本：和日志对得上的请求直接回记下的结果，不真做、不再记过程；
// 到停下的那一步按规则决定真做还是停下交给 agent；对不上（脚本走了别的路）就停下交给 agent。
import { createHash } from "node:crypto"
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
  call(call: ModelToolCall, options: { routineStep?: number; approvedRuleIds?: readonly string[] }): Promise<GatewayResult>
  stillRunning(): Promise<boolean>
  toolInfo(toolName: string): { id: string; risk?: Risk } | undefined
  screenshot(): Promise<{ fileId: string } | undefined>
}

/** 日志里的请求种类（fail、done 不记：它们让脚本停下，接着跑时不会再走过去） */
export type JournalOp = "tool" | "commit" | "verified" | "log" | "now"
/**
 * 一步停下的样子：approval = 要审批，没做；approved = 人批准了、正在做（进程被杀时不确定做没做完）；
 * suspend = 做了，要人处理（验证码、登录页、等浏览器……）
 */
export type JournalStop = "approval" | "approved" | "suspend"

/** routine_journal 的一行 */
export interface JournalRow {
  seq: number
  op: JournalOp
  tool: string | null
  inputHash: string
  /** 回给脚本的；没做完（进程被杀）、停在审批前的为空。run.finish 的另外带 finish（脚本报的结果，接着跑时要用） */
  reply: Record<string, unknown> | null
  stop: JournalStop | null
  instanceId: string | null
}

export interface BridgeJournal {
  /** 上次记下的（按 seq 从 1 起连续）；第一次跑是空的 */
  rows: JournalRow[]
  /** 写一行（同一个 seq 再写就是改：做完补上 reply、停下记 stop） */
  write(row: JournalRow): Promise<void>
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
  /** 重放日志（普通运行才有；试跑每次从头跑，不记） */
  journal?: BridgeJournal
  /** 接着跑：停下的那一步要审批、人批准了，真做时带上这些规则（不再因为它们要审批） */
  approvedRuleIds?: readonly string[]
  /** 这次运行现在用的 Chrome（浏览器动作记进日志；接着跑时 Chrome 换了就不重放） */
  browserInstanceId?: () => string | undefined
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

/** 一步在哪：第几次工具调用、工具 id、给人看的说明 */
interface Where {
  step: number
  tool: string
  label: string
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

/** 稳定的 JSON（对象的键排好序）：同样的参数每次算出同样的 hash */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>
    const keys = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort()
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`
  }
  return JSON.stringify(value) ?? "null"
}

/** 请求参数的 sha256（tool 的 input、commit 的 label……）：接着跑时和日志对一下，对不上就是脚本走了别的路 */
export function journalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex")
}

const describeRequest = (op: string, tool: string | null) => (op === "tool" ? `调 ${tool ?? "?"}` : `ha.${op}()`)

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
  /** 要挂起：交回引擎（普通运行照常挂起，处理完接着跑） */
  suspend?: { plan: SuspendPlan; output: string }
  /** 要人审批（普通运行）：交回引擎生成「审批工具调用」；这一步没做 */
  approval?: { result: GatewayResult; step: number; approvedRuleIds: string[] }
  /** 最后一次没成功的调用（脚本没接住时，按它记停在哪） */
  lastFailure?: RoutineStop
  done?: BridgeDone
  /** 记进日志的第几个请求 */
  private seq = 0
  /** 接着跑：按日志跳过的部分走完了（「脚本接着跑」那条过程只记一次） */
  private replayEnded = false

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
      case "commit": {
        const label = str(request.label).trim() || "（没写说明）"
        return this.marker("commit", label, (replaying) => this.commit(label, replaying))
      }
      case "verified": {
        const note = str(request.note).trim() || "核对过了"
        return this.marker("verified", note, async (replaying) => {
          const open = [...this.state.commits].reverse().find((commit) => commit.verified === undefined)
          if (open) open.verified = note
          if (!replaying) await this.options.save(this.state)
          return { ok: true }
        })
      }
      case "log": {
        const text = str(request.text).trim().slice(0, 500)
        return this.marker("log", text, async (replaying) => {
          if (!text) return { ok: true }
          const logs = (this.state.logs ??= [])
          if (logs.length < MAX_LOGS) logs.push(text)
          // 接着跑时跳过的那几条：上次已经记过过程了
          if (replaying) return { ok: true }
          await this.options.save(this.state)
          await this.options.event({ kind: "plan", title: `流程记录：${text.slice(0, 200)}`, ...(text.length > 200 ? { detail: text } : {}) })
          return { ok: true }
        })
      }
      case "fail": {
        const kind = str(request.kind) === "input" ? "input" : "page"
        return this.stopWith(kind, str(request.reason).trim().slice(0, 1000) || routineStopKindLabel[kind])
      }
      case "now":
        // 接着跑时回记下的时间：脚本按时间走的路和上次一样
        return this.marker("now", "", async () => ({ ok: true, data: shanghaiNow() }))
      default:
        return { ok: false, code: "step_error", error: `不认识的请求 ${op || "（空）"}` }
    }
  }

  /** 日志里这个序号对不上：停下交给 agent。对得上返回 undefined */
  private async mismatch(prior: JournalRow, op: JournalOp, tool: string | null, hash: string, where: { step: number; tool?: string; label?: string }) {
    if (prior.op === op && (prior.tool ?? null) === tool && prior.inputHash === hash) return undefined
    const what =
      prior.op === op && (prior.tool ?? null) === tool
        ? `第 ${prior.seq} 个请求（${describeRequest(op, tool)}）的参数和上次不一样`
        : `第 ${prior.seq} 个请求上次是${describeRequest(prior.op, prior.tool)}，这次是${describeRequest(op, tool)}`
    return this.stopWith("replay_mismatch", `接着跑时脚本走了和上次不一样的路：${what}`, where)
  }

  /** 按日志跳过的部分走完了，开始真做：记一条过程（每次接着跑只记一次） */
  private async endReplay() {
    if (this.replayEnded) return
    this.replayEnded = true
    if (!this.options.journal?.rows.length) return
    // 「步」是工具调用（和过程里的 routineStep、界面上的 replayed 对得上）；ha.commit、ha.log、ha.now 这些标记也按记录处理，不算步
    const steps = this.state.steps
    await this.options.save(this.state)
    await this.options.event({
      kind: "plan",
      title: steps ? `脚本接着跑：前 ${steps} 步按记录跳过，从第 ${steps + 1} 步接着做` : "脚本接着跑：从第 1 步接着做",
      detail: `按重放日志跳过了 ${steps} 步（不真做、不再记过程）；中间的提交标记、记录、时间照上次的记录。`,
    })
  }

  /**
   * 不是工具的请求（commit、verified、log、now）：记进日志；接着跑时对上了就只改脚本状态（不截图、不记过程），回记下的结果。
   * apply(replaying) 做这个请求该做的事
   */
  private async marker(op: Exclude<JournalOp, "tool">, payload: string, apply: (replaying: boolean) => Promise<Reply>): Promise<Reply> {
    const journal = this.options.journal
    if (!journal) return apply(false)
    const seq = ++this.seq
    const hash = journalHash(payload)
    const prior = journal.rows[seq - 1]
    if (prior) {
      const mismatched = await this.mismatch(prior, op, null, hash, { step: this.state.steps })
      if (mismatched) return mismatched
      const reply = await apply(true)
      return (prior.reply as Reply | null) ?? reply
    }
    await this.endReplay()
    const reply = await apply(false)
    // 停下了（试跑走到提交前）的不记：接着跑时不会走到这里
    if (!this.stopped) await journal.write({ seq, op, tool: null, inputHash: hash, reply: { ...reply }, stop: null, instanceId: null })
    return reply
  }

  /** 按日志回一个做过的工具调用：不真做、不记过程，只改脚本状态（步数、报的结果、最后一次出错） */
  private replayTool(prior: JournalRow, where: Where): Reply {
    this.state.steps = where.step
    this.state.replayed = (this.state.replayed ?? 0) + 1
    const { finish, ...reply } = (prior.reply ?? { ok: false, code: "step_error", error: "日志里没有结果" }) as unknown as Reply & { finish?: AgentClaim }
    if (finish) this.finish = finish
    if (!reply.ok && (reply.code === "denied" || reply.code === "step_error"))
      this.lastFailure = { ...where, kind: reply.code, reason: firstLine(str(reply.error).replace(/^被拦下：|^工具出错：/, "")) }
    return reply
  }

  /**
   * 接着跑走到上次停下的那一步（docs/dev/solidify.md 17.2）：
   * - 要审批的：人批准了 → 带上批准的规则真做；没有批准（例如人点了「立即继续」）→ 照常做，要审批就再停；
   * - 批准后正在做时进程被杀：不确定做没做完，不重做，交给 agent；
   * - 非浏览器工具的挂起（session.wait 等）：等到了就算做完了，回记下的结果；
   * - 浏览器动作要人处理（验证码、登录页、等浏览器）、做到一半进程被杀：前面没有没核对的 ha.commit 就重做；
   *   有的话这一步可能就是提交，可能已经生效，不重做，交给 agent。
   * 返回 reply = 不真做（回这个）；否则返回真做时带的规则
   */
  private async atStop(prior: JournalRow, where: Where): Promise<{ reply: Reply } | { approvedRuleIds: string[] }> {
    if (prior.stop === "approval") return { approvedRuleIds: [...(this.options.approvedRuleIds ?? [])] }
    if (prior.stop === "suspend" && prior.reply && !where.tool.startsWith("browser.")) return { reply: this.replayTool(prior, where) }
    if (prior.stop === "approved") {
      this.state.steps = where.step
      return { reply: await this.stopWith("interrupted", "这一步是人批准后开始做的，没有重做", where) }
    }
    const open = [...this.state.commits].reverse().find((commit) => commit.verified === undefined)
    if (open) {
      this.state.steps = where.step
      const why = `过了提交点「${open.label}」还没核对，${where.label} 可能已经生效，没有重做`
      return { reply: await this.stopWith(prior.stop === "suspend" ? "suspend" : "interrupted", why, where) }
    }
    return { approvedRuleIds: [] }
  }

  private async tool(toolName: string, input: unknown): Promise<Reply> {
    const { gateway, maxCalls, mode, sessionId, journal } = this.options
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
    const where: Where = { step, tool: toolId, label }
    const trace: EventTrace = { routineStep: step }

    if (mode === "test") {
      // 试跑：会让结果生效的几个工具只记下来
      if (RECORDED_IN_TEST.has(toolId)) return this.record(toolId, input, step, label, trace)
      // 不是浏览器、不是文件、风险也不是只读的（会对外发送、改东西）：停在它前面，不做
      if (info && !toolId.startsWith("browser.") && !toolId.startsWith("file.") && info.risk !== "read")
        return this.stopWith("test_blocked", `下一步 ${label} 会对外发送或改东西，试跑不做`, where)
    }

    // 重放日志：对得上的回记下的结果；停下的那一步按规则定；之后的先写一行（reply 为空）再真做
    let approvedRuleIds: string[] = []
    let seq = 0
    let hash = ""
    if (journal) {
      seq = ++this.seq
      hash = journalHash(input)
      const prior = journal.rows[seq - 1]
      if (prior) {
        const mismatched = await this.mismatch(prior, "tool", toolId, hash, where)
        if (mismatched) return mismatched
        if (prior.reply && !prior.stop) return this.replayTool(prior, where)
        const decided = await this.atStop(prior, where)
        if ("reply" in decided) return decided.reply
        approvedRuleIds = decided.approvedRuleIds
      }
      await this.endReplay()
      await journal.write({ seq, op: "tool", tool: toolId, inputHash: hash, reply: null, stop: approvedRuleIds.length ? "approved" : null, instanceId: null })
    }
    const writeJournal = async (reply: Record<string, unknown> | null, stop: JournalStop | null) => {
      if (!journal) return
      const instanceId = toolId.startsWith("browser.") ? (this.options.browserInstanceId?.() ?? null) : null
      await journal.write({ seq, op: "tool", tool: toolId, inputHash: hash, reply, stop, instanceId })
    }

    this.state.steps = step
    const result = await gateway.call(
      { toolCallId: `${sessionId}-r${step}`, toolName, input },
      { routineStep: step, ...(approvedRuleIds.length ? { approvedRuleIds } : {}) }
    )
    if (result.approval) {
      // 没做：这一步不算调过。普通运行交回引擎生成「审批工具调用」，人处理完接着跑
      this.state.steps = step - 1
      this.approval = { result, step, approvedRuleIds }
      await writeJournal(null, "approval")
      return this.stopWith("approval", `${label} 要人审批（规则「${result.approval.ruleName}」：${result.approval.reason}）`, where)
    }
    if (result.outcome.suspend && !result.denied) {
      this.suspend = { plan: result.outcome.suspend, output: result.output }
      // 记下这次的输出：非浏览器工具（session.wait 等）等到了就算做完了，接着跑时回它
      await writeJournal({ ok: true, text: result.output }, "suspend")
      return this.stopWith("suspend", firstLine(result.output) || routineStopKindLabel.suspend, where)
    }
    if (result.denied) {
      this.lastFailure = { ...where, kind: "denied", reason: firstLine(result.output.replace(/^被拦下：/, "")) }
      await this.options.save(this.state)
      const reply: Reply = { ok: false, code: "denied", error: result.output }
      await writeJournal({ ...reply }, null)
      return reply
    }
    if (result.outcome.isError) {
      this.lastFailure = { ...where, kind: "step_error", reason: firstLine(result.output.replace(/^工具出错：/, "")) }
      await this.options.save(this.state)
      const reply: Reply = { ok: false, code: "step_error", error: result.output }
      await writeJournal({ ...reply }, null)
      return reply
    }
    if (result.outcome.finish) this.finish = result.outcome.finish
    await this.options.save(this.state)
    const reply: Reply = { ok: true, text: result.output, ...(result.outcome.data !== undefined ? { data: result.outcome.data } : {}) }
    await writeJournal({ ...reply, ...(result.outcome.finish ? { finish: result.outcome.finish } : {}) }, null)
    return reply
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

  /** ha.commit：replaying = 接着跑时按日志跳过的（上次已经截过图、记过过程，只记下走过了这个提交） */
  private async commit(label: string, replaying: boolean): Promise<Reply> {
    const { mode, trial, gateway } = this.options
    if (mode === "test") return this.stopWith("test_commit", `走到第一次提交前（${label}），试跑停在这里，没做`, { step: this.state.steps, label })
    if (trial && !replaying) {
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
    if (!replaying) await this.options.save(this.state)
    return { ok: true }
  }
}
