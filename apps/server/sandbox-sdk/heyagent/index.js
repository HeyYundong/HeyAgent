// 固化脚本的 SDK（docs/dev/solidify.md 4.4）：脚本在沙箱里（不能上网）只能通过它做事。
// 每个函数都是一次请求：经 unix socket（环境变量 HEYAGENT_BRIDGE）发给 worker 里的工具桥（routine/runtime/bridge.ts），
// 工具桥交给 HeyAgent 的工具网关，规则、白名单、审批、验证码 / 登录页检测、过程记录和 agent 自己调用时一样。
// 协议：一行一个 JSON。请求 { id, op, … }；回复 { id, ok, text?, data?, error?, code? }（code：step_error / denied / stop）。
// 没有依赖，普通 ESM；跑脚本时拷进沙箱代码目录的 node_modules/heyagent/。
// agent 用 code.run（tools: true）写的脚本也用它（docs/dev/solidify.md 18.1，由 agent-launch.js 启动）：脚本是普通程序，跑完就退出，
// 所以连接只在有请求等回复时才拦着进程退出（ref / unref）。
// 流程库（docs/dev/routine-library.md 5.6）：ha.routine("短名", 输入) 调库里的流程。进入是一次 tool 请求（routine: true），
// 工具桥回 { slug, name, version, module, depth, input }；SDK 载入代码目录里的 module，在 AsyncLocalStorage 的嵌套上下文里调它的 run(input)。
// 上下文里：ha.input 是传进去的输入；ha.finish、ha.work.report 只收进交回值；ha.checkpoint.mark 不做（记一句）；ha.fail 变成抛给调用方的
// RoutineFailed；其余请求照常发，带上嵌套的路径 via（从外到里的短名）。跑完发 routine_end。
// agent 调库流程（工具桥 mode = tool，launch.js 的 stdin 带 library）：顶层就在一个「根」上下文里跑（via 是空的，工具桥补上），
// 报结果、交回、ha.fail 一样只收下来，跑完由 launch.js 报给 done。
import { AsyncLocalStorage } from "node:async_hooks"
import { createConnection } from "node:net"

/** 工具出错（定位找不到、超时……）：脚本可以自己接住，比如可有可无的弹窗；没接住就交给 agent */
export class StepError extends Error {
  constructor(message) {
    super(message)
    this.name = "StepError"
  }
}

/** 被规则拦下 */
export class Denied extends Error {
  constructor(message) {
    super(message)
    this.name = "Denied"
  }
}

/** 脚本要停下了（要审批、要挂起、ha.fail、报了结果、试跑走到提交前、运行被取消……）：接住也没用，之后的调用一律再抛它 */
export class RoutineStop extends Error {
  constructor(message) {
    super(message)
    this.name = "RoutineStop"
  }
}

/** 库流程主动停了（它调了 ha.fail）：input = 给的输入有问题；page = 页面和它预期的不一样。调用方可以接住 */
export class RoutineFailed extends Error {
  constructor(message, kind, routine) {
    super(message)
    this.name = "RoutineFailed"
    this.kind = kind
    this.routine = routine
  }
}

/** 库流程的嵌套上下文：{ slug, name, version, depth, path, input, report, finish?, checkpointNoted?, root? } */
const scope = new AsyncLocalStorage()
/** RoutineFailed 是哪一层抛的（同一个短名的两层不会同时在，按对象认） */
const failedFrame = new WeakMap()

let socket
let buffer = ""
let nextId = 1
const pending = new Map()
/** 停下的原因：有了以后所有调用都直接抛 RoutineStop */
let stopped
let input = {}

function lost(reason) {
  stopped ??= reason
  for (const waiter of pending.values()) waiter.reject(new RoutineStop(reason))
  pending.clear()
}

function connect() {
  if (socket) return socket
  const path = process.env.HEYAGENT_BRIDGE
  if (!path) throw new RoutineStop("没有工具桥（环境变量 HEYAGENT_BRIDGE）")
  socket = createConnection(path)
  socket.setEncoding("utf8")
  socket.on("data", (chunk) => {
    buffer += chunk
    for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n")) {
      const line = buffer.slice(0, at)
      buffer = buffer.slice(at + 1)
      if (line.trim()) onReply(JSON.parse(line))
    }
  })
  socket.on("error", () => lost("工具桥断开了"))
  socket.on("close", () => lost("工具桥断开了"))
  // 没有等回复的请求时不拦着进程退出（agent 的脚本跑完最后一行就该退出；固化脚本由 launch.js 报完 done 后退出）
  socket.unref()
  return socket
}

/** 有请求等回复时拦着进程退出，没有了就放开 */
function holdOpen() {
  if (!socket) return
  if (pending.size) socket.ref()
  else socket.unref()
}

function onReply(reply) {
  const waiter = pending.get(reply.id)
  if (!waiter) return
  pending.delete(reply.id)
  holdOpen()
  if (reply.ok) return waiter.resolve({ text: reply.text ?? "", data: reply.data })
  const message = reply.error || "出错了"
  if (reply.code === "denied") return waiter.reject(new Denied(message))
  if (reply.code === "stop") {
    stopped ??= message
    return waiter.reject(new RoutineStop(message))
  }
  return waiter.reject(new StepError(message))
}

function request(op, payload = {}, force = false) {
  if (stopped && !force) return Promise.reject(new RoutineStop(stopped))
  const frame = scope.getStore()
  // 库流程报了结果以后，它里面再调的不做（同顶层 ha.finish 以后）
  if (frame?.finish && !force) return Promise.reject(new StepError(`库流程「${frame.name ?? frame.slug}」已经报了结果（ha.finish），后面的调用不再做`))
  // 嵌套的路径：库流程里发的请求都带上（payload 里写了的以它为准，routine_end 要写上一层的）
  const via = frame?.path?.length ? { via: frame.path } : {}
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      connect().write(`${JSON.stringify({ id, op, ...via, ...payload })}\n`)
      holdOpen()
    } catch (error) {
      pending.delete(id)
      reject(error instanceof RoutineStop ? error : new RoutineStop(String(error?.message ?? error)))
    }
  })
}

const callTool = (tool, args) => {
  const frame = scope.getStore()
  if (frame) frame.steps++
  return request("tool", { tool, input: args ?? {} })
}
/** 有结构化结果给结构化结果，没有给文字 */
const valueOf = (result) => (result.data !== undefined ? result.data : result.text)
const act = (tool) => async (args) => valueOf(await callTool(tool, args))

const ha = {
  /** 这次的输入（按 inputSchema 校验过）：派活参数、$attachments（附件 id、名字、类型）、$note（附加说明） */
  get input() {
    return scope.getStore()?.input ?? input
  },
  browser: {
    navigate: act("browser.navigate"),
    click: act("browser.click"),
    type: act("browser.type"),
    fillForm: act("browser.fill_form"),
    select: act("browser.select_option"),
    press: act("browser.press_key"),
    pressSequentially: act("browser.press_sequentially"),
    hover: act("browser.hover"),
    check: act("browser.check"),
    uncheck: act("browser.uncheck"),
    drag: act("browser.drag"),
    upload: act("browser.file_upload"),
    tabs: act("browser.tabs"),
    waitFor: act("browser.wait_for"),
    handleDialog: act("browser.handle_dialog"),
    /** 等页面出现其中一个，返回是哪个（名字） */
    async waitAny(outcomes, options = {}) {
      const result = await callTool("browser.wait_any", { outcomes, ...(options.timeout !== undefined ? { timeout: options.timeout } : {}) })
      return result.data?.matched
    },
    /** 按定位读页面上的字：{ rows, total } */
    async extract(args) {
      const result = await callTool("browser.extract", args)
      return result.data ?? { rows: [], total: 0 }
    },
    /** 复制图片（右键 → 复制图片）：{ fileId, width, height }，图片同时在剪贴板里、存成了这次运行的文件 */
    async copyImage(args = {}) {
      const { element, ...rest } = args
      // 工具要一个给人看的名字：没写就用定位代替
      const name = typeof element === "string" && element.trim() ? element : typeof rest.target === "string" && rest.target ? rest.target : "图片"
      const result = await callTool("browser.copy_image", { element: name, ...rest })
      return result.data
    },
    /** 读剪贴板（copy: true 先按一次 Ctrl+C）：{ text?, table?, fileId? } */
    async clipboardRead(args = {}) {
      const result = await callTool("browser.clipboard_read", args)
      return result.data ?? {}
    },
    /** 把文字 / 表格 / 这次运行里的图片写进剪贴板，在当前焦点处按 Ctrl+V */
    clipboardPaste: act("browser.clipboard_paste"),
    /**
     * 直接调网站的接口（任务打开「允许直接调网站接口」才有）：{ status, ok, contentType, bytes, json?, text? }。
     * 4xx、5xx 不抛错，看 status；会改东西的请求（不是 GET、HEAD）前面要有自己的 ha.commit，不然脚本停下
     */
    async fetch(args) {
      const result = await callTool("browser.fetch", args)
      return result.data
    },
  },
  file: {
    read: act("file.read"),
    save: act("file.save"),
  },
  checkpoint: {
    async mark(args) {
      const frame = scope.getStore()
      if (!frame) return valueOf(await callTool("checkpoint.mark", args))
      // 库流程的检查点是来源任务的，调用方那里不认：不做，第一次记一句
      if (!frame.checkpointNoted) {
        frame.checkpointNoted = true
        await request("log", { text: `流程「${frame.name ?? frame.slug}」里的检查点不算（只在来源任务上算）` })
      }
      return "库流程里的检查点不算，没有勾"
    },
  },
  work: {
    async report(args) {
      const frame = scope.getStore()
      if (!frame) return valueOf(await callTool("work.report", args))
      // 库流程交回的数据收进这次调用的交回值，不写调用方的结果
      const data = args?.data && typeof args.data === "object" ? args.data : {}
      for (const [key, value] of Object.entries(data))
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") frame.report[key] = value
      return "已收进库流程的交回值"
    },
  },
  /** 任务里的任何别的工具（HTTP、MCP、比物、图库、SDK 没有包装的浏览器工具 browser.xxx……）：{ text, data } */
  async tool(id, args) {
    const result = await callTool(id, args)
    return { text: result.text, data: result.data }
  },
  /** 标记：下一步会真的改东西（提交、保存、发送）。试跑停在这里；试用期在这里截图存证 */
  async commit(label) {
    await request("commit", { label: String(label ?? "") })
  },
  /** 标记：写完读回来核对过了 */
  async verified(note) {
    await request("verified", { note: String(note ?? "") })
  },
  /** 主动停：input = 输入本身有问题（记没办成，不交 agent）；page = 页面和预期不一样（交给 agent） */
  async fail(kind, reason) {
    const frame = scope.getStore()
    if (frame) {
      // 库流程里：不让整个脚本停，抛给调用方（可以接住）
      const error = new RoutineFailed(String(reason ?? ""), kind === "input" ? "input" : "page", frame.slug)
      failedFrame.set(error, frame)
      throw error
    }
    await request("fail", { kind, reason: String(reason ?? "") })
    throw new RoutineStop(String(reason ?? ""))
  },
  /** 结束：报结果（run.finish），照常按硬规则核、复核。之后的调用一律停。库流程里只收进交回值 */
  async finish(result) {
    const frame = scope.getStore()
    if (!frame) {
      await callTool("run.finish", result)
      return
    }
    if (frame.finish) throw new StepError(`库流程「${frame.name ?? frame.slug}」已经报了结果（ha.finish）`)
    const { outcome, summary, evidence, reason } = result ?? {}
    if (outcome !== "achieved" && outcome !== "not_achieved") throw new StepError("ha.finish 的 outcome 要写 achieved 或 not_achieved")
    if (typeof summary !== "string" || !summary.trim()) throw new StepError("ha.finish 要写 summary（做了什么、结果是什么）")
    if (outcome === "not_achieved" && !(typeof reason === "string" && reason.trim()))
      throw new StepError("outcome = not_achieved 时要写 reason：拿到了什么、缺了什么、为什么")
    frame.finish = {
      outcome,
      summary: summary.trim(),
      ...(typeof evidence === "string" && evidence.trim() ? { evidence: evidence.trim() } : {}),
      ...(typeof reason === "string" && reason.trim() ? { reason: reason.trim() } : {}),
    }
  },
  /** 记一条过程给人看 */
  async log(text) {
    await request("log", { text: String(text ?? "") })
  },
  /** 现在的时间（上海时间，ISO 格式，例如 2026-10-27T09:30:00.000+08:00） */
  async now() {
    return (await request("now")).data
  },
  /** 判断题：交给这次运行的执行模型判断，返回 { answer, reason }；给了 choices，answer 一定是其中之一 */
  async judge(args) {
    const { question, data, choices } = args ?? {}
    const result = await request("judge", {
      question: String(question ?? ""),
      ...(data !== undefined ? { data } : {}),
      ...(choices !== undefined ? { choices } : {}),
    })
    return result.data
  },
  /** 调流程库里的流程（docs/dev/routine-library.md 5.6），返回 { routine, name, version, outcome, summary, evidence?, reason?, data } */
  async routine(slug, args) {
    const parent = scope.getStore()
    const parentPath = parent?.path ?? []
    if (parent) parent.steps++
    const entered = await request("tool", { tool: `routine.${String(slug ?? "")}`, input: args ?? {}, routine: true })
    const info = entered.data ?? {}
    const frame = {
      slug: String(info.slug ?? slug),
      name: String(info.name ?? slug),
      version: Number(info.version ?? 0),
      depth: Number(info.depth ?? parentPath.length + 1),
      path: [...parentPath, String(info.slug ?? slug)],
      input: info.input && typeof info.input === "object" ? info.input : {},
      report: {},
      steps: 0,
    }
    const end = async (payload) => {
      try {
        await request("routine_end", { slug: frame.slug, depth: frame.depth, steps: frame.steps, ...payload, via: parentPath }, true)
      } catch {
        // 工具桥已经停了：停下的那一层由工具桥自己记
      }
    }
    let run
    try {
      const module = await import(new URL(`../../${String(info.module ?? "")}`, import.meta.url).href)
      run = module.default
      if (typeof run !== "function") throw new Error("库流程的脚本没有 export default async function run(input)")
    } catch (error) {
      await end({ end: "error", error: String(error?.message ?? error).slice(0, 2000), name: "Error" })
      throw new StepError(`载入不了流程「${frame.name}」：${error?.message ?? error}`)
    }
    try {
      await scope.run(frame, () => run(frame.input))
    } catch (error) {
      if (error instanceof RoutineFailed && failedFrame.get(error) === frame) {
        await end({ end: "failed", kind: error.kind, error: error.message.slice(0, 2000) })
        throw error
      }
      await end({ end: "error", error: String(error?.message ?? error).slice(0, 2000), name: String(error?.name ?? "Error") })
      throw error
    }
    if (!frame.finish) {
      await end({ end: "error", error: "库流程没报结果（没调 ha.finish）就结束了", name: "NoFinish" })
      throw new StepError(`流程「${frame.name}」没报结果（没调 ha.finish）就结束了`)
    }
    const result = { routine: frame.slug, name: frame.name, version: frame.version, ...frame.finish, data: { ...frame.report } }
    await end({ end: "finished", result })
    return result
  },
  StepError,
  Denied,
  RoutineStop,
  RoutineFailed,
}

export default ha

/**
 * launch.js 用（agent 调库流程，工具桥 mode = tool）：在「根」上下文里跑库流程，收下它报的结果、交回的数据、ha.fail。
 * 返回给 done 的 routine：{ end: finished | failed | error, finish?, data, kind?, error?, name?, steps }
 */
export async function __runLibraryRoot(slug, fn) {
  const frame = { slug: String(slug ?? ""), depth: 1, path: [], input, report: {}, steps: 0, root: true }
  try {
    await scope.run(frame, () => fn(frame.input))
  } catch (error) {
    if (error instanceof RoutineFailed && failedFrame.get(error) === frame)
      return { end: "failed", kind: error.kind, error: error.message.slice(0, 2000), data: { ...frame.report }, steps: frame.steps }
    return {
      end: "error",
      error: String(error?.message ?? error).slice(0, 2000),
      name: String(error?.name ?? "Error"),
      ...(error?.stack ? { stack: String(error.stack).slice(0, 4000) } : {}),
      data: { ...frame.report },
      steps: frame.steps,
    }
  }
  if (!frame.finish) return { end: "error", error: "库流程没报结果（没调 ha.finish）就结束了", name: "NoFinish", data: { ...frame.report }, steps: frame.steps }
  return { end: "finished", finish: frame.finish, data: { ...frame.report }, steps: frame.steps }
}

/** launch.js 用：设好输入 */
export function __start(value) {
  input = value && typeof value === "object" ? value : {}
}

/** launch.js 用：报 done（脚本跑完了或者抛了错），然后断开 */
export async function __finish(result) {
  try {
    await request("done", result, true)
  } catch {
    // 工具桥已经断开了：照样退出
  }
  socket?.end()
}
