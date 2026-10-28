// 固化脚本的 SDK（docs/dev/solidify.md 4.4）：脚本在沙箱里（不能上网）只能通过它做事。
// 每个函数都是一次请求：经 unix socket（环境变量 HEYAGENT_BRIDGE）发给 worker 里的工具桥（routine/runtime/bridge.ts），
// 工具桥交给 HeyAgent 的工具网关，规则、白名单、审批、验证码 / 登录页检测、过程记录和 agent 自己调用时一样。
// 协议：一行一个 JSON。请求 { id, op, … }；回复 { id, ok, text?, data?, error?, code? }（code：step_error / denied / stop）。
// 没有依赖，普通 ESM；跑脚本时拷进沙箱代码目录的 node_modules/heyagent/。
// agent 用 code.run（tools: true）写的脚本也用它（docs/dev/solidify.md 18.1，由 agent-launch.js 启动）：脚本是普通程序，跑完就退出，
// 所以连接只在有请求等回复时才拦着进程退出（ref / unref）。
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
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      connect().write(`${JSON.stringify({ id, op, ...payload })}\n`)
      holdOpen()
    } catch (error) {
      pending.delete(id)
      reject(error instanceof RoutineStop ? error : new RoutineStop(String(error?.message ?? error)))
    }
  })
}

const callTool = (tool, args) => request("tool", { tool, input: args ?? {} })
/** 有结构化结果给结构化结果，没有给文字 */
const valueOf = (result) => (result.data !== undefined ? result.data : result.text)
const act = (tool) => async (args) => valueOf(await callTool(tool, args))

const ha = {
  /** 这次的输入（按 inputSchema 校验过）：派活参数、$attachments（附件 id、名字、类型）、$note（附加说明） */
  get input() {
    return input
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
  },
  file: {
    read: act("file.read"),
    save: act("file.save"),
  },
  checkpoint: { mark: act("checkpoint.mark") },
  work: { report: act("work.report") },
  /** 任务里的任何别的工具（HTTP、MCP……）：{ text, data } */
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
    await request("fail", { kind, reason: String(reason ?? "") })
    throw new RoutineStop(String(reason ?? ""))
  },
  /** 结束：报结果（run.finish），照常按硬规则核、复核。之后的调用一律停 */
  async finish(result) {
    await callTool("run.finish", result)
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
  StepError,
  Denied,
  RoutineStop,
}

export default ha

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
