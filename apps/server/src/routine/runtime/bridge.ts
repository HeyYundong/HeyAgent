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
// agent 写的脚本（mode = agent，docs/dev/solidify.md 18.1）：code.run 带 tools 时也走这里。每次调用照常过网关，过程记录的
// trace 记 scriptStep、scriptCallId；要审批 → 停在它前面、不发起审批（同 browser.batch）；要挂起 → 停，code.run 的结果带上 suspend；
// ha.finish、code.run 不许用；不记重放日志（code.run 不接着跑）。
// 判断题（op = judge，18.2）：交给调用方给的 judge（用这次运行的执行模型），结果记进重放日志，接着跑时回记下的答案。
// 重放日志（docs/dev/solidify.md 17.2）：普通运行把每个请求（tool、commit、verified、log、now）记进 routine_journal，
// 工具调用开始前先写一行（reply 为空）、做完补上，进程被杀时知道哪一步做到一半。停下等人（审批、验证码、登录页）
// 或者进程被杀以后，从头再跑一遍脚本：和日志对得上的请求直接回记下的结果，不真做、不再记过程；
// 到停下的那一步按规则决定真做还是停下交给 agent；对不上（脚本走了别的路）就停下交给 agent。
// 直接调网站的接口（browser.fetch，docs/dev/solidify.md 19.5）：固化脚本（run、test）里会改东西的请求（不是 GET、HEAD）
// 前面要有自己的 ha.commit（从上一个会改东西的请求以来新走过一个），不然不做、脚本停下（script_error，脚本接不住）；
// 方法可以是变量，所以在这里判，不靠程序检查。agent 的脚本不要求。结果太大的（超过 256 KB）日志里只记开头，
// 接着跑到这一步时只读的真做一次，会改东西的不重做、交给 agent。
// 流程库（docs/dev/routine-library.md 5.2、5.6）：
// - ha.routine 的进入是一次 tool 请求（tool = routine.<短名>，routine: true）：查快照里有没有、用不用得了、层数、环、按 inputSchema 校验，
//   再像普通的一步一样走 gateway.call()（inline：不真执行，只记一条「开始跑流程」），记进重放日志；回复 libraryEnterReplySchema；
// - 库流程里发的请求带 via（从外到里的短名），过程记录的 trace 带 library（哪个库流程、第几版、里面第几步、哪次调用、第几层）；
// - 出来是 routine_end（标记，记进重放日志）：记一条过程「流程『…』跑完」、写一行调用记录（recordCall）；
// - mode = tool（agent 调库流程，routine/library/tool.ts）：最外层就是那个库流程，顶层请求的 via 是空的，这里补上；不记重放日志；
// - 脚本里不能 ha.tool("routine.x")；库流程里不能 ha.tool 调 run.finish / work.report / checkpoint.mark（SDK 已经替它收下）；
// - 库流程里（带 via）、mode = tool 的会改东西的 browser.fetch 也要自己的 ha.commit（库流程都是固化脚本）；commits 不分层。
import { createHash } from "node:crypto"
import { rmSync } from "node:fs"
import net from "node:net"

import {
  BROWSER_FETCH_TOOL,
  bridgeViaSchema,
  builtinToolInputs,
  isRoutineToolId,
  isWriteMethod,
  libraryModulePath,
  MAX_LIBRARY_DEPTH,
  routineReturnSchema,
  routineSlugOfToolId,
  routineStopKindLabel,
  SUBAGENT_TOOL_IDS,
  type EventTrace,
  type LibraryEnterReply,
  type LibraryRoutineSnapshot,
  type LibraryTrace,
  type Risk,
  type RoutineCallResult,
  type RoutineRecorded,
  type RoutineStop,
  type RoutineStopKind,
  type SessionRoutineState,
} from "@heyagent/shared"
import { z } from "zod"

import type { GatewayResult, ModelToolCall } from "../../engine/gateway.js"
import type { AgentClaim } from "../../engine/outcome.js"
import type { EventInput } from "../../engine/records.js"
import type { SuspendPlan, ToolOutcome } from "../../engine/tools/builtin.js"
import { maskUrl } from "../../browser/site-api.js"
import type { NewRoutineCall } from "../library/stats.js"

/** 工具桥要用的网关的几个方法（测试里换成假的） */
export interface BridgeGateway {
  call(
    call: ModelToolCall,
    options: {
      routineStep?: number
      scriptStep?: number
      scriptCallId?: string
      approvedRuleIds?: readonly string[]
      /** 库流程里的一步：过程记录的 trace.library */
      library?: LibraryTrace
      /** 进入库流程（ha.routine）：过规则、记一步，不真执行 */
      inline?: boolean
    }
  ): Promise<GatewayResult>
  stillRunning(): Promise<boolean>
  toolInfo(toolName: string): { id: string; risk?: Risk } | undefined
  screenshot(): Promise<{ fileId: string } | undefined>
}

/** 日志里的请求种类（fail、done 不记：它们让脚本停下，接着跑时不会再走过去） */
export type JournalOp = "tool" | "commit" | "verified" | "log" | "now" | "judge" | "routine_end"
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

/** ha.judge 的请求（SDK 原样传来的，judge 自己查格式） */
export interface JudgeRequest {
  question: string
  data?: unknown
  choices?: string[]
}

/** 判断的结果：ok = 答出来了（有选项时答案一定在选项里）；花费、过程记录由 judge 自己记 */
export type JudgeOutcome = { ok: true; answer: string; reason: string } | { ok: false; error: string }

/** 判断要记的过程（工具桥按 mode 加 trace） */
export type JudgeFn = (request: JudgeRequest, trace: EventTrace | undefined) => Promise<JudgeOutcome>

export interface BridgeOptions {
  sessionId: string
  gateway: BridgeGateway
  /** 这次的脚本状态（工具桥就地改它，每次请求后 save） */
  state: SessionRoutineState
  /** run = 普通运行先跑脚本；test = 固化试跑；agent = agent 用 code.run（tools）跑的脚本；tool = agent 调库流程（routine/library/tool.ts） */
  mode: "run" | "test" | "agent" | "tool"
  /** mode = agent：这次 code.run 的模型工具调用 id（过程记录的 trace.scriptCallId，脚本里调用的 id 前缀） */
  scriptCallId?: string
  /** ha.judge：用这次运行的执行模型判断（没给 = 不支持） */
  judge?: JudgeFn
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
  /**
   * 流程库（docs/dev/routine-library.md 5.6）：这次快照里冻的库流程（ha.routine 能调的）。
   * mode = tool：root 是 agent 调的那个库流程，callId 是模型的工具调用 id（最外层，顶层请求的 via 由这里补上）
   */
  library?: { routines: readonly LibraryRoutineSnapshot[]; root?: { routine: LibraryRoutineSnapshot; callId: string } }
  /** 一次库流程调用结束（脚本里 ha.routine 调的，每一层各一次）：写调用记录（routine_calls）。agent 调的那一层由 tool.ts 记 */
  recordCall?: (call: BridgeRoutineCall) => Promise<void>
}

/** 工具桥记的一次库流程调用（调用方的运行、任务由调用方补上） */
export type BridgeRoutineCall = Omit<NewRoutineCall, "sessionId" | "taskId">

/** mode = tool 时 done 里带的库流程结局（launch.js 报的） */
export interface BridgeLibraryEnd {
  end: "finished" | "failed" | "error"
  finish?: { outcome: "achieved" | "not_achieved"; summary: string; evidence?: string; reason?: string }
  data?: Record<string, string | number | boolean>
  kind?: "input" | "page"
  error?: string
  name?: string
  steps?: number
}

/** 正在跑的一层库流程 */
interface LibraryFrame {
  routine: LibraryRoutineSnapshot
  /** 从外到里的短名（含自己） */
  path: string[]
  /** 这次调用的 id（trace.library.callId） */
  callId: string
  depth: number
  /** 这一层里做了几步（工具调用；进入下一层也算这一层的一步） */
  steps: number
  /** 正在做的那一步（停下时记停在第几步） */
  attempt: number
  /** 这一层里最近一次没成功的（没接住时按它记停在哪） */
  failure?: { step: number; kind: RoutineStopKind; reason: string }
  started: number
}

/** 脚本报的 done */
export interface BridgeDone {
  ok: boolean
  error?: string
  /** 抛出来的错的名字：StepError / Denied / RoutineStop / 别的（脚本自己的错） */
  name?: string
  stack?: string
  /** mode = tool：库流程的结局 */
  routine?: BridgeLibraryEnd
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
  question?: unknown
  data?: unknown
  choices?: unknown
  via?: unknown
  routine?: unknown
  slug?: unknown
  end?: unknown
  result?: unknown
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
/** 库流程里不能用 ha.tool 调的：SDK 的 ha.finish、ha.work.report、ha.checkpoint.mark 在库流程里只收进交回值 */
const NOT_IN_LIBRARY = new Set(["run.finish", "work.report", "checkpoint.mark"])
/** agent 的脚本（code.run 带 tools）另外不能调的：怎么收尾由 agent 定；脚本里再开沙箱会占着同一个目录的锁（死锁） */
const NOT_FOR_AGENT_SCRIPTS: Record<string, string> = {
  "run.finish": "code.run 的脚本里不能用 ha.finish：脚本跑完由你决定怎么收尾（看脚本的输出，再自己调 run.finish）",
  "code.run": "code.run 的脚本里不能再调 code.run",
}
/** ha.log 最多记几条 */
const MAX_LOGS = 50
/** browser.fetch 的结果序列化后超过这么大，重放日志里只记开头（一页 5 MB 的列表别把日志表撑大） */
export const JOURNAL_REPLY_MAX = 256 * 1024
/** 只记开头时留多少字 */
const JOURNAL_TEXT_HEAD = 2000

/** browser.fetch 的方法（大写，没写是 GET）和打了码的网址 */
function fetchTarget(input: unknown): { method: string; url: string } {
  const args = (input && typeof input === "object" ? input : {}) as Record<string, unknown>
  return { method: typeof args.method === "string" && args.method.trim() ? args.method.trim().toUpperCase() : "GET", url: maskUrl(typeof args.url === "string" ? args.url.trim() : "") }
}

const str = (value: unknown) => (typeof value === "string" ? value : value === undefined || value === null ? "" : String(value))
const firstLine = (text: string, max = 300) => {
  const line = text.split("\n").find((each) => each.trim())?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`

/** 库流程交回的数据写成一行（「状态=已发货，件数=3」） */
export function returnDataText(data: Record<string, unknown> | undefined, max = 120): string {
  const text = Object.entries(data ?? {})
    .map(([key, value]) => `${key}=${String(value)}`)
    .join("，")
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

/** 输入按 inputSchema 校验：不合格返回原因；schema 是空的、写得解析不了（程序检查管）就不校验 */
export function checkRoutineInput(schema: Record<string, unknown>, input: Record<string, unknown>): string | undefined {
  if (Object.keys(schema).length === 0) return undefined
  let validator: z.ZodType
  try {
    validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
  } catch {
    return undefined
  }
  const parsed = validator.safeParse(input)
  if (parsed.success) return undefined
  return parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "输入"}：${issue.message}`)
    .join("；")
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
  // 进入库流程：短名
  if (isRoutineToolId(toolId)) return `流程「${routineSlugOfToolId(toolId) ?? toolId}」`
  const short = toolId.replace(/^browser\./, "")
  const text = (value: unknown) => (typeof value === "string" ? value.trim() : "")
  const clipped = (value: string) => (value.length > 40 ? `${value.slice(0, 39)}…` : value)
  // 调接口：方法 + 路径和参数（主机名太长，看不出是哪个接口）
  if (toolId === BROWSER_FETCH_TOOL) {
    const { method, url } = fetchTarget(args)
    const path = url.replace(/^https?:\/\/[^/?#]*/i, "") || "/"
    return `fetch「${clipped(`${method} ${path}`)}」`
  }
  // 剪贴板的三个工具：短名看不懂，写成人话；粘贴的内容不写进来（同上，不取要填的内容），只写是什么、多少
  if (toolId === "browser.copy_image") {
    const what = text(args.element) || text(args.target) || (typeof args.x === "number" && typeof args.y === "number" ? `坐标 (${args.x}, ${args.y})` : "")
    return what ? `复制图片「${clipped(what)}」` : "复制图片"
  }
  if (toolId === "browser.clipboard_read") return args.copy === true ? "复制并读剪贴板" : "读剪贴板"
  if (toolId === "browser.clipboard_paste") {
    if (typeof args.fileId === "string") return "粘贴图片"
    if (Array.isArray(args.table)) return `粘贴表格（${args.table.length} 行）`
    if (typeof args.text === "string") return `粘贴文字（${args.text.length} 字）`
    return "粘贴"
  }
  let detail = text(args.element) || text(args.startElement)
  if (Array.isArray(args.fields))
    detail = args.fields
      .map((field) => text((field as { name?: unknown } | null)?.name))
      .filter(Boolean)
      .join("、")
  else if (args.fields && typeof args.fields === "object") detail = Object.keys(args.fields).join("、")
  if (args.outcomes && typeof args.outcomes === "object") detail = Object.keys(args.outcomes).join(" / ")
  detail ||= text(args.key) || text(args.url) || text(args.target) || text(args.path) || text(args.fileId)
  detail = clipped(detail)
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
  /** 要挂起：交回引擎（普通运行照常挂起，处理完接着跑）。signals、facts 是那一步的（agent 的脚本带出给 code.run 的结果） */
  suspend?: { plan: SuspendPlan; output: string; signals?: ToolOutcome["signals"]; facts?: ToolOutcome["facts"] }
  /** 要人审批（普通运行）：交回引擎生成「审批工具调用」；这一步没做 */
  approval?: {
    result: GatewayResult
    step: number
    approvedRuleIds: string[]
    /** 这一步在脚本调的库流程里：哪个流程的第几步（审批卡上写「（流程『…』第 j 步）」） */
    library?: { name: string; step: number }
  }
  /** 最后一次没成功的调用（脚本没接住时，按它记停在哪） */
  lastFailure?: RoutineStop
  done?: BridgeDone
  /** 记进日志的第几个请求 */
  private seq = 0
  /** 接着跑：按日志跳过的部分走完了（「脚本接着跑」那条过程只记一次） */
  private replayEnded = false
  /** 会改东西的 browser.fetch 已经用掉了几个 ha.commit（每个请求要自己的提交点） */
  private fetchCommitsUsed = 0
  /** 每个工具调了几次、出错几次（code.run 的输出里汇总；没过网关就被拒的也算出错） */
  readonly toolStats = new Map<string, { calls: number; errors: number }>()
  /** 正在跑的库流程（按路径「a/b」） */
  private readonly frames = new Map<string, LibraryFrame>()
  /** mode = tool：agent 调的那个库流程（最外层） */
  readonly rootFrame?: LibraryFrame

  private constructor(options: BridgeOptions) {
    this.options = options
    this.server = net.createServer((socket) => this.accept(socket))
    const root = options.mode === "tool" ? options.library?.root : undefined
    if (root) {
      this.rootFrame = { routine: root.routine, path: [root.routine.slug], callId: root.callId, depth: 1, steps: 0, attempt: 0, started: Date.now() }
      this.frames.set(root.routine.slug, this.rootFrame)
    }
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

  /** 停下时默认记的「第几步」：mode = tool 记库流程自己的第几步，别的记调用方脚本的第几步 */
  private currentStep() {
    return this.rootFrame ? this.rootFrame.steps : this.state.steps
  }

  /** 停下：记在状态上，之后一律回 stop。已经停了就不改 */
  async stopWith(kind: RoutineStopKind, reason: string, extra: { step?: number; tool?: string; label?: string } = {}): Promise<Reply> {
    if (!this.stopped) {
      this.stopped = {
        step: extra.step ?? this.currentStep(),
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
        ...(request.routine && typeof request.routine === "object" ? { routine: request.routine as BridgeLibraryEnd } : {}),
      }
      return { ok: true }
    }
    if (this.stopped || this.done) return this.stopReply()
    // 嵌套的路径（库流程里发的请求带 via）：mode = tool 时最外层是 agent 调的那个库流程，补在前面
    const via = bridgeViaSchema.safeParse(request.via ?? [])
    if (!via.success) return { ok: false, code: "step_error", error: `via 不对：最多 ${MAX_LIBRARY_DEPTH} 层的短名数组` }
    const path = this.rootFrame ? [this.rootFrame.routine.slug, ...via.data] : via.data
    if (path.length && !this.frames.has(path.join("/")))
      return { ok: false, code: "step_error", error: `流程「${path.at(-1)}」已经结束了（或者没有进入过），不能再在它里面调用` }
    switch (op) {
      case "tool":
        return this.tool(str(request.tool), request.input ?? {}, path, request.routine === true)
      case "routine_end":
        return this.routineEnd(request, path)
      case "commit": {
        const raw = str(request.label).trim() || "（没写说明）"
        // 库流程里的提交也算进调用方的 commits，标签前面写是哪个流程
        const frame = this.labeledFrame(path)
        const label = frame ? `流程「${frame.routine.name}」：${raw}` : raw
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
          const trace = this.markerTrace(path)
          await this.options.event({
            kind: "plan",
            title: `${this.options.mode === "agent" && !path.length ? "脚本记录" : "流程记录"}：${text.slice(0, 200)}`,
            ...(text.length > 200 ? { detail: text } : {}),
            ...(trace ? { trace } : {}),
          })
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
      case "judge":
        return this.judge(request, path)
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

  /**
   * 一次工具调用。path：从外到里的库流程短名（调用方脚本自己的是空的）；enter：ha.routine 的进入（tool = routine.<短名>）
   */
  private async tool(toolName: string, input: unknown, path: string[] = [], enter = false): Promise<Reply> {
    const { gateway, maxCalls, mode, sessionId, journal } = this.options
    if (!toolName) return { ok: false, code: "step_error", error: "要写工具 id" }
    // 报了结果就结束了：后面的调用不做（结果照算，不算停下）
    if (this.finish || this.state.recorded?.finish) return { ok: false, code: "stop", error: "已经报了结果（ha.finish），后面的调用不再做" }
    if (this.state.steps >= maxCalls) return this.stopWith("limit", `一次最多调 ${maxCalls} 次工具，到上限了`)
    // 每次调之前看一眼：运行被取消了就停
    if (!(await gateway.stillRunning())) return this.stopWith("cancelled", "运行被取消了")
    const info = gateway.toolInfo(toolName)
    const toolId = info?.id ?? toolName
    if (NOT_FOR_SCRIPTS.has(toolId)) {
      this.count(toolId, true)
      return {
        ok: false,
        code: "step_error",
        error:
          toolId === "browser.batch"
            ? "脚本里不用 browser.batch：一步一步调就行"
            : mode === "agent"
              ? NOT_FOR_AGENT_SCRIPTS["run.finish"]!
              : "用 ha.finish 报结果",
      }
    }
    // 子 agent（docs/dev/sub-agents.md 第 15 节）：拆、等、停只能由 agent 自己调，固化脚本和 code.run 的脚本里都不行
    if ((SUBAGENT_TOOL_IDS as readonly string[]).includes(toolId)) {
      this.count(toolId, true)
      return { ok: false, code: "step_error", error: "脚本里不能拆子 agent：subagent_start / subagent_wait / subagent_cancel 只能由 agent 自己调" }
    }
    // 库里的流程只能用 ha.routine 调（进入要校验输入、层数、环，里面的步骤要记 trace.library）
    if (isRoutineToolId(toolId) !== enter) {
      this.count(toolId, true)
      return {
        ok: false,
        code: "step_error",
        error: enter
          ? `ha.routine 只能调流程库里的流程（工具 id routine.<短名>），${toolId} 不是`
          : `脚本里不能用 ha.tool 调流程库里的流程：用 ha.routine("${routineSlugOfToolId(toolId) ?? toolId.replace(/^routine\./, "")}", 输入)`,
      }
    }
    // 库流程里：报结果、交回、检查点由 SDK 收进交回值，不许绕过去直接调
    if (path.length && NOT_IN_LIBRARY.has(toolId)) {
      this.count(toolId, true)
      return { ok: false, code: "step_error", error: `库流程里不能用 ha.tool 调 ${toolId}：用 ha.finish / ha.work.report，它们只收进这次调用的交回值` }
    }
    if (mode === "agent" && NOT_FOR_AGENT_SCRIPTS[toolId]) {
      this.count(toolId, true)
      return { ok: false, code: "step_error", error: NOT_FOR_AGENT_SCRIPTS[toolId] }
    }
    // 固化脚本自己就能调工具：不再套一层带工具的 code.run（两层工具桥，过程记录和接着跑都对不上）
    if (mode !== "agent" && toolId === "code.run" && typeof input === "object" && input !== null && (input as { tools?: unknown }).tools === true) {
      this.count(toolId, true)
      return { ok: false, code: "step_error", error: "固化脚本里不能用带工具的 code.run：脚本本身就能调工具" }
    }
    // 进入库流程：快照里有没有、用不用得了、层数、环、输入（都不算一步，不记日志：接着跑时同样的输入照样过不了）
    let target: LibraryRoutineSnapshot | undefined
    if (enter) {
      const checked = await this.checkEnter(routineSlugOfToolId(toolId), input, path)
      if ("error" in checked) {
        this.count(toolId, true)
        return { ok: false, code: "step_error", error: checked.error }
      }
      target = checked.routine
    }
    const step = this.state.steps + 1
    const frame = path.length ? this.frames.get(path.join("/")) : undefined
    const libStep = frame ? frame.steps + 1 : undefined
    const labeled = this.labeledFrame(path)
    const label = `${target ? `流程「${target.name}」` : stepLabel(toolId, input)}${labeled ? `（流程「${labeled.routine.name}」第 ${libStep} 步）` : ""}`
    // 「第几步」：mode = tool 记库流程自己的（里面再调的一层记进入它的那一步），别的记调用方脚本的
    const shown = this.rootFrame ? (path.length <= 1 ? libStep! : this.rootFrame.steps) : step
    const where: Where = { step: shown, tool: toolId, label }
    const libraryTrace: LibraryTrace | undefined = frame
      ? { routineId: frame.routine.routineId, version: frame.routine.version, step: libStep!, callId: frame.callId, depth: frame.depth }
      : undefined
    const trace: EventTrace = { ...this.stepTrace(step), ...(libraryTrace ? { library: libraryTrace } : {}) }
    const callId = this.callIdOf(step)
    /** 这一步算做过了（真做或者按日志跳过）：库流程这一层的步数；进入成功的压一层 */
    const settled = (reply: Reply) => {
      if (frame) frame.steps = libStep!
      if (target && reply.ok) this.pushFrame(target, path, callId)
      return reply
    }
    if (frame) frame.attempt = libStep!

    if (mode === "test") {
      // 试跑：会让结果生效的几个工具只记下来
      if (RECORDED_IN_TEST.has(toolId)) return settled(await this.record(toolId, input, step, label, trace))
      // 不是浏览器、不是文件、风险也不是只读的（会对外发送、改东西）：停在它前面，不做。进入库流程放行（里面每一步再各自判断）
      if (!target && info && !toolId.startsWith("browser.") && !toolId.startsWith("file.") && info.risk !== "read")
        return this.stopWith("test_blocked", `下一步 ${label} 会对外发送或改东西，试跑不做`, where)
    }

    // 会改东西的接口请求要有自己的 ha.commit（固化脚本、库流程；接着跑时提交标记也按日志重放，算法一样）。agent 自己写的那一层不要求
    const fetchWrite = toolId === BROWSER_FETCH_TOOL && isWriteMethod(fetchTarget(input).method)
    if (fetchWrite && (mode !== "agent" || path.length > 0)) {
      if (this.state.commits.length <= this.fetchCommitsUsed) {
        this.count(toolId, true)
        const { method, url } = fetchTarget(input)
        return this.stopWith("script_error", `第 ${shown} 步 ${method} ${url}：会改东西的接口请求前面要有自己的 ha.commit，没做`, where)
      }
      this.fetchCommitsUsed = this.state.commits.length
    }

    // 重放日志：对得上的回记下的结果；停下的那一步按规则定；之后的先写一行（reply 为空）再真做
    let approvedRuleIds: string[] = []
    let seq = 0
    let hash = ""
    /** 日志里只记了开头的只读请求：接着跑时真做一次（不算接着跑的起点，后面的照样按日志跳过） */
    let redo = false
    if (journal) {
      seq = ++this.seq
      hash = journalHash(input)
      const prior = journal.rows[seq - 1]
      if (prior) {
        const mismatched = await this.mismatch(prior, "tool", toolId, hash, where)
        if (mismatched) return mismatched
        if (prior.reply && !prior.stop) {
          if (!prior.reply.dataOmitted) return settled(this.replayTool(prior, where))
          if (fetchWrite) {
            this.state.steps = step
            return this.stopWith("interrupted", `${label} 的结果太大，没记进重放日志；它是会改东西的请求，接着跑时不重做`, where)
          }
          redo = true
        } else {
          const decided = await this.atStop(prior, where)
          if ("reply" in decided) return decided.reply.ok ? settled(decided.reply) : decided.reply
          approvedRuleIds = decided.approvedRuleIds
        }
      }
      if (!redo) {
        await this.endReplay()
        await journal.write({ seq, op: "tool", tool: toolId, inputHash: hash, reply: null, stop: approvedRuleIds.length ? "approved" : null, instanceId: null })
      }
    }
    const writeJournal = async (reply: Record<string, unknown> | null, stop: JournalStop | null) => {
      if (!journal) return
      const instanceId = toolId.startsWith("browser.") ? (this.options.browserInstanceId?.() ?? null) : null
      // 调接口的结果太大：只记开头（重放到这一步时只读的真做一次）
      if (toolId === BROWSER_FETCH_TOOL && reply && reply.ok && JSON.stringify(reply).length > JOURNAL_REPLY_MAX)
        reply = { ok: true, text: String(reply.text ?? "").slice(0, JOURNAL_TEXT_HEAD), dataOmitted: true }
      await journal.write({ seq, op: "tool", tool: toolId, inputHash: hash, reply, stop, instanceId })
    }

    this.state.steps = step
    const scriptCallId = this.options.scriptCallId ?? sessionId
    const result = await gateway.call(
      { toolCallId: callId, toolName, input },
      {
        ...(mode === "agent" ? { scriptStep: step, scriptCallId } : mode === "tool" ? {} : { routineStep: step }),
        ...(libraryTrace ? { library: libraryTrace } : {}),
        ...(target ? { inline: true } : {}),
        ...(approvedRuleIds.length ? { approvedRuleIds } : {}),
      }
    )
    // 要审批的没做，不算调过；别的（含挂起）都算一次
    if (!result.approval) this.count(toolId, Boolean(result.denied || (result.outcome.isError && !result.outcome.suspend)))
    if (result.approval) {
      // 没做：这一步不算调过。普通运行交回引擎生成「审批工具调用」，人处理完接着跑
      this.state.steps = step - 1
      this.approval = { result, step, approvedRuleIds, ...(labeled ? { library: { name: labeled.routine.name, step: libStep! } } : {}) }
      await writeJournal(null, "approval")
      return this.stopWith("approval", `${label} 要人审批（规则「${result.approval.ruleName}」：${result.approval.reason}）`, where)
    }
    if (result.outcome.suspend && !result.denied) {
      settled({ ok: false })
      this.suspend = {
        plan: result.outcome.suspend,
        output: result.output,
        ...(result.outcome.signals ? { signals: result.outcome.signals } : {}),
        ...(result.outcome.facts ? { facts: result.outcome.facts } : {}),
      }
      // 记下这次的输出：非浏览器工具（session.wait 等）等到了就算做完了，接着跑时回它
      await writeJournal({ ok: true, text: result.output }, "suspend")
      return this.stopWith("suspend", firstLine(result.output) || routineStopKindLabel.suspend, where)
    }
    if (result.denied) {
      settled({ ok: false })
      this.lastFailure = { ...where, kind: "denied", reason: firstLine(result.output.replace(/^被拦下：/, "")) }
      if (frame) frame.failure = { step: libStep!, kind: "denied", reason: this.lastFailure.reason }
      await this.options.save(this.state)
      const reply: Reply = { ok: false, code: "denied", error: result.output }
      await writeJournal({ ...reply }, null)
      return reply
    }
    if (result.outcome.isError) {
      settled({ ok: false })
      this.lastFailure = { ...where, kind: "step_error", reason: firstLine(result.output.replace(/^工具出错：/, "")) }
      if (frame) frame.failure = { step: libStep!, kind: "step_error", reason: this.lastFailure.reason }
      await this.options.save(this.state)
      const reply: Reply = { ok: false, code: "step_error", error: result.output }
      await writeJournal({ ...reply }, null)
      return reply
    }
    if (result.outcome.finish) this.finish = result.outcome.finish
    await this.options.save(this.state)
    const reply: Reply = {
      ok: true,
      text: result.output,
      ...(target ? { data: this.enterReply(target, path, input) } : result.outcome.data !== undefined ? { data: result.outcome.data } : {}),
    }
    await writeJournal({ ...reply, ...(result.outcome.finish ? { finish: result.outcome.finish } : {}) }, null)
    return settled(reply)
  }

  // ---------- 流程库 ----------

  /** 第 step 次工具调用的调用 id：固化脚本 <运行号>-r<步>；agent 的脚本 <code.run 的调用 id>-s<步>；agent 调库流程 <这次的调用 id>-l<步> */
  private callIdOf(step: number) {
    const { mode, sessionId } = this.options
    if (mode === "agent") return `${this.options.scriptCallId ?? sessionId}-s${step}`
    return this.rootFrame ? `${this.rootFrame.callId}-l${step}` : `${sessionId}-r${step}`
  }

  /** 进入前查一遍：返回要进的库流程，或者回给脚本的错（输入不对的记一行调用记录） */
  private async checkEnter(slug: string | undefined, input: unknown, path: string[]): Promise<{ routine: LibraryRoutineSnapshot } | { error: string }> {
    if (!slug) return { error: "流程的短名不对（英文小写字母开头，小写字母、数字、下划线）" }
    const routine = this.options.library?.routines.find((each) => each.slug === slug)
    // 调用方自己的脚本（最外层）只能调任务选了的；库流程里调的跟着冻进来了（selected = false）
    if (!routine || (path.length === 0 && !routine.selected))
      return { error: `任务没选流程「routine.${slug}」：库里的流程要在任务的「流程」里选上才能调` }
    if (routine.unavailable) return { error: `流程「${routine.name}」这次用不了：${routine.unavailable}` }
    if (path.includes(slug)) return { error: `不许绕圈：流程「${routine.name}」已经在调用的路上了（${[...path, slug].join(" → ")}）` }
    const depth = path.length + 1
    if (depth > MAX_LIBRARY_DEPTH)
      return { error: `最多 ${MAX_LIBRARY_DEPTH} 层：库流程里还能调一层库流程，再往下不行（${[...path, slug].join(" → ")}）` }
    const args = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : undefined
    const bad = args ? checkRoutineInput(routine.inputSchema, args) : "输入要是一个对象"
    if (bad) {
      await this.recordCall({
        routineId: routine.routineId,
        version: routine.version,
        callId: this.callIdOf(this.state.steps + 1),
        via: "script",
        depth,
        result: "bad_input",
        stopKind: "bad_input",
        stopStep: 0,
        stopReason: bad,
        steps: 0,
        ms: 0,
      })
      return { error: `输入不符合流程「${routine.name}」的要求：${bad}` }
    }
    return { routine }
  }

  /** 进入的回复（SDK 按 module 载入代码目录里的库流程） */
  private enterReply(routine: LibraryRoutineSnapshot, path: string[], input: unknown): LibraryEnterReply {
    return {
      slug: routine.slug,
      name: routine.name,
      version: routine.version,
      module: libraryModulePath(routine.slug),
      depth: path.length + 1,
      input: input && typeof input === "object" ? (input as Record<string, unknown>) : {},
    }
  }

  private pushFrame(routine: LibraryRoutineSnapshot, parent: string[], callId: string) {
    const path = [...parent, routine.slug]
    this.frames.set(path.join("/"), { routine, path, callId, depth: path.length, steps: 0, attempt: 0, started: Date.now() })
  }

  /** 要在说明里写「流程『…』第 k 步」的那一层：脚本调的库流程；mode = tool 时最外层就是它自己，不写 */
  private labeledFrame(path: string[]): LibraryFrame | undefined {
    if (path.length === 0 || (this.rootFrame && path.length === 1)) return undefined
    return this.frames.get(path.join("/"))
  }

  /** 写一行调用记录（试跑不记；出错不影响脚本） */
  private async recordCall(call: BridgeRoutineCall) {
    if (this.options.mode === "test" || !this.options.recordCall) return
    await this.options.recordCall(call).catch((error: unknown) => console.warn("[routine] 写调用记录出错", error))
  }

  /**
   * 出来（routine_end）：标记，记进重放日志。不是重放的：记一条过程「流程『…』跑完 …」、写一行调用记录（步数以这里数的为准）
   */
  private async routineEnd(request: Request, path: string[]): Promise<Reply> {
    const slug = str(request.slug)
    const key = [...path, slug].join("/")
    const frame = this.frames.get(key)
    if (!frame) return { ok: false, code: "step_error", error: `没有正在跑的流程「${slug}」` }
    const end = ["finished", "failed", "error"].includes(str(request.end)) ? (str(request.end) as "finished" | "failed" | "error") : "error"
    return this.marker("routine_end", JSON.stringify({ slug, end }), async (replaying) => {
      this.frames.delete(key)
      if (replaying) return { ok: true }
      const routine = frame.routine
      const ms = Date.now() - frame.started
      const parsed = end === "finished" ? routineReturnSchema.safeParse(request.result) : undefined
      let result: RoutineCallResult
      let stop: { kind: RoutineStopKind; step: number; reason: string } | undefined
      let title: string
      if (parsed?.success) {
        const value = parsed.data
        result = value.outcome
        const data = returnDataText(value.data)
        title = `流程「${routine.name}」跑完：${frame.steps} 步 · ${seconds(ms)}${value.outcome === "achieved" ? "" : ` · 没办成：${value.reason ?? value.summary}`}${data ? ` · 交回 ${data}` : ""}`
      } else if (end === "failed") {
        const kind = str(request.kind) === "input" ? "input" : "page"
        result = kind === "input" ? "bad_input" : "stopped"
        stop = { kind, step: frame.steps, reason: str(request.error).slice(0, 1000) || routineStopKindLabel[kind] }
        title = `流程「${routine.name}」自己停下了（${routineStopKindLabel[kind]}）：${firstLine(stop.reason)}`
      } else {
        const name = str(request.name)
        const kind: RoutineStopKind =
          name === "StepError" || name === "Denied" ? (frame.failure?.kind ?? (name === "Denied" ? "denied" : "step_error")) : name === "RoutineFailed" ? "step_error" : "script_error"
        result = "stopped"
        const reason = parsed && !parsed.success ? "报的结果格式不对" : str(request.error).slice(0, 1000) || routineStopKindLabel[kind]
        stop = { kind, step: kind === "script_error" ? frame.steps : (frame.failure?.step ?? frame.steps), reason }
        title = `流程「${routine.name}」没跑完，停在第 ${stop.step} 步：${firstLine(reason)}`
      }
      const parent = path.length ? this.frames.get(path.join("/")) : undefined
      await this.options.event({
        kind: "plan",
        title,
        ...(stop && stop.reason.length > 200 ? { detail: stop.reason } : {}),
        trace: {
          ...this.markerTrace([]),
          ...(parent && parent.steps
            ? { library: { routineId: parent.routine.routineId, version: parent.routine.version, step: parent.steps, callId: parent.callId, depth: parent.depth } }
            : {}),
          libraryCall: { callId: frame.callId, routineId: routine.routineId, version: routine.version },
        },
      })
      await this.recordCall({
        routineId: routine.routineId,
        version: routine.version,
        callId: frame.callId,
        via: "script",
        depth: frame.depth,
        result,
        ...(stop ? { stopKind: stop.kind, stopStep: stop.step, stopReason: stop.reason } : {}),
        steps: frame.steps,
        ms,
      })
      return { ok: true }
    })
  }

  /**
   * 脚本跑完（或停下、被杀）以后还没出来的库流程（脚本调的那几层，不含 mode = tool 的最外层）：各记一行「停下了」。
   * 停下等人（审批、挂起）接着跑时同一次调用会再记一次，覆盖这一行（recordRoutineCall 按调用 id）
   */
  async settleFrames() {
    const open = [...this.frames.values()].filter((frame) => frame !== this.rootFrame).sort((a, b) => b.depth - a.depth)
    for (const frame of open) {
      this.frames.delete(frame.path.join("/"))
      const kind: RoutineStopKind = this.stopped?.kind ?? frame.failure?.kind ?? "script_error"
      const reason = this.stopped?.reason ?? frame.failure?.reason ?? (this.done?.error ? `脚本出错：${this.done.error}` : "脚本没跑完就结束了")
      await this.recordCall({
        routineId: frame.routine.routineId,
        version: frame.routine.version,
        callId: frame.callId,
        via: "script",
        depth: frame.depth,
        result: kind === "input" ? "bad_input" : "stopped",
        stopKind: kind,
        stopStep: this.stopped ? frame.attempt || frame.steps : (frame.failure?.step ?? frame.steps),
        stopReason: reason.slice(0, 1000),
        steps: frame.steps,
        ms: Date.now() - frame.started,
      })
    }
  }

  /** 记一次工具调用（code.run 的输出里汇总） */
  private count(toolId: string, error: boolean) {
    const stat = this.toolStats.get(toolId) ?? { calls: 0, errors: 0 }
    stat.calls++
    if (error) stat.errors++
    this.toolStats.set(toolId, stat)
  }

  /** 第 step 步的 trace：固化脚本记 routineStep；agent 的脚本记 scriptStep 和这次 code.run 的调用 id */
  private stepTrace(step: number): EventTrace {
    const { mode } = this.options
    // agent 调的库流程：只有 trace.library（调用方没有脚本）
    if (mode === "tool") return {}
    return mode === "agent" ? { scriptStep: step, scriptCallId: this.options.scriptCallId ?? this.options.sessionId } : { routineStep: step }
  }

  /** 不是工具的那几条过程（ha.log、ha.judge）的 trace：agent 的脚本带上调用 id（和前一步的序号），固化脚本没有 */
  private markerTrace(path: string[] = []): EventTrace | undefined {
    const frame = path.length ? this.frames.get(path.join("/")) : undefined
    // 库流程里的：带上那一层的 trace.library（第几步按它最近做的那一步）
    const library: EventTrace | undefined =
      frame && frame.steps
        ? { library: { routineId: frame.routine.routineId, version: frame.routine.version, step: frame.steps, callId: frame.callId, depth: frame.depth } }
        : undefined
    if (this.options.mode !== "agent") return library
    return { ...(this.state.steps ? { scriptStep: this.state.steps } : {}), scriptCallId: this.options.scriptCallId ?? this.options.sessionId, ...library }
  }

  /**
   * ha.judge（docs/dev/solidify.md 18.2）：用这次运行的执行模型判断。普通运行记进重放日志（op = judge，hash 是问题、数据、选项），
   * 接着跑时对得上就回记下的答案，不再调模型；试跑、agent 的脚本照常调模型
   */
  private async judge(request: Request, path: string[] = []): Promise<Reply> {
    const question = str(request.question).trim()
    if (!question) return { ok: false, code: "step_error", error: "ha.judge 要写 question（要判断的问题）" }
    let choices: string[] | undefined
    if (request.choices !== undefined && request.choices !== null) {
      if (!Array.isArray(request.choices) || request.choices.length === 0 || request.choices.some((each) => typeof each !== "string" || !each.trim()))
        return { ok: false, code: "step_error", error: "ha.judge 的 choices 要是非空的文字数组（例如 [\"是\", \"否\"]）" }
      choices = [...new Set((request.choices as string[]).map((each) => each.trim()))]
    }
    const judgeRequest: JudgeRequest = { question, ...(request.data !== undefined ? { data: request.data } : {}), ...(choices ? { choices } : {}) }
    const journal = this.options.journal
    let seq = 0
    const hash = journalHash(judgeRequest)
    if (journal) {
      seq = ++this.seq
      const prior = journal.rows[seq - 1]
      if (prior) {
        const mismatched = await this.mismatch(prior, "judge", null, hash, { step: this.state.steps })
        if (mismatched) return mismatched
        // 上次判断过：回记下的答案（不再调模型、不再记过程）
        if (prior.reply) return prior.reply as unknown as Reply
      }
      await this.endReplay()
    }
    let reply: Reply
    if (!this.options.judge) reply = { ok: false, code: "step_error", error: "这里不支持 ha.judge" }
    else {
      const outcome = await this.options.judge(judgeRequest, this.markerTrace(path))
      reply = outcome.ok ? { ok: true, data: { answer: outcome.answer, reason: outcome.reason } } : { ok: false, code: "step_error", error: outcome.error }
    }
    if (journal && !this.stopped) await journal.write({ seq, op: "judge", tool: null, inputHash: hash, reply: { ...reply }, stop: null, instanceId: null })
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
