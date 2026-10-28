// 过程里和脚本有关的几样怎么拆（docs/dev/solidify.md 第 18 节，界面在 run-detail.tsx）：
// - agent 用 code.run（tools）写的脚本做的步骤（trace.scriptCallId，工具调用还有 scriptStep）：先记步骤、code.run 跑完才记它自己，
//   那条 code.run 的 trace 也写了同一个 scriptCallId，按 id 把步骤收在它下面；还没等到 code.run 的（脚本还在跑、中途被打断）单独成组；
// - 判断事件：kind = plan、标题「流程判断：问题 → 答案（理由）」，拆成问题、答案、理由；
// - code.run 输出末尾「--- 脚本调的工具 ---」那一段（服务端 sandbox/code-run.ts 的 formatScriptTools）拆成几段；
// - browser.fetch 那一行的方法、网址、状态码（第 19 节）；
// - 库流程（docs/dev/routine-library.md 5.7、9.3）：里面的步骤带 trace.library，按 callId 收到调它的那一行下面（两层的再套一层）；
//   脚本里 ha.routine 调的，后面那条「流程『…』跑完 / 停下」按 callId 并进进入那一行（group.end），照 agent 调的写法显示结局。
import { BROWSER_FETCH_TOOL, isRoutineToolId, routineReturnSchema, routineToolId, routineToolStopDataSchema } from "@heyagent/shared"
import type { RoutineToolStopData, RunEvent } from "@heyagent/shared"

export const CODE_RUN_TOOL_ID = "code.run"

/** 过程里的一项：一条事件（code.run 的带上它的脚本步骤），或一组还没认领的脚本步骤 */
export type EventItem = { kind: "event"; event: RunEvent; script?: RunEvent[] } | { kind: "script"; steps: RunEvent[] }

/** 那次 code.run 自己（它的 trace.scriptCallId 是自己的调用 id，不是脚本的一步） */
const isCodeRun = (event: RunEvent) => event.kind === "tool" && event.toolId === CODE_RUN_TOOL_ID

export function groupScriptEvents(events: RunEvent[]): EventItem[] {
  const groups = new Map<string, RunEvent[]>()
  for (const event of events) {
    const callId = event.trace?.scriptCallId
    if (!callId || isCodeRun(event)) continue
    const list = groups.get(callId)
    if (list) list.push(event)
    else groups.set(callId, [event])
  }
  // 第一遍：每次 code.run 按 id 认它的步骤
  const owner = new Map<number, RunEvent[]>()
  const claimed = new Set<string>()
  for (const event of events) {
    const callId = event.trace?.scriptCallId
    const steps = callId && isCodeRun(event) ? groups.get(callId) : undefined
    if (!steps || claimed.has(callId!)) continue
    claimed.add(callId!)
    owner.set(event.seq, steps)
  }
  // 第二遍：认领了的步骤不单独列；没认领的在第一步的位置成一组
  const items: EventItem[] = []
  const placed = new Set<string>()
  for (const event of events) {
    const callId = event.trace?.scriptCallId
    if (callId && !isCodeRun(event)) {
      if (claimed.has(callId) || placed.has(callId)) continue
      placed.add(callId)
      items.push({ kind: "script", steps: groups.get(callId)! })
      continue
    }
    items.push({ kind: "event", event, script: owner.get(event.seq) })
  }
  return items
}

/** 工具调用出错（网关记的标题是「工具名（出错）」） */
export const isErrorStep = (event: RunEvent) => event.kind === "error" || /（出错）$|· 出错$/.test(event.title)

// ---------- 库流程（docs/dev/routine-library.md 5.7、9.3） ----------

/** 一次库流程调用做的步骤（trace.library.callId 相同的），里面再调的库流程套在 steps 里 */
export interface LibraryGroup {
  callId: string
  routineId: string
  version: number
  depth: number
  /** agent 调的（工具 routine.<短名>，步骤先记、工具那一行跑完才记，在步骤后面）；脚本里 ha.routine 调的（进入那一步在步骤前面） */
  via: "tool" | "script"
  steps: LibraryNode<RunEvent>[]
  /**
   * 脚本里 ha.routine 调的：工具桥出来时记的那条「流程『…』跑完 / 自己停下了 / 没跑完」（kind = plan，trace.libraryCall.callId 相同）。
   * 并进进入那一行显示结局，不再单独占一行（18.3 第 4 条）
   */
  end?: RunEvent
}

/** 过程里的一项：原来的一项（带上它的库流程步骤），或一组没认到「进入」那一行的库流程步骤 */
export type LibraryNode<T> = { kind: "item"; item: T; library?: LibraryGroup } | { kind: "library"; group: LibraryGroup }

const isRoutineCall = (event: RunEvent | undefined) => event?.kind === "tool" && isRoutineToolId(event.toolId ?? "")

/**
 * 按 trace.library 把库流程里的步骤收到调它的那一行下面（这一层是第 depth 层）：
 * - 这一层的步骤按 callId 分组；更深一层的（库流程里再调的）跟着它所在的那组走，下一层再分；
 * - 组的主人：这一层里 trace.libraryCall.callId 等于组的 callId 的那一行 routine.* 工具调用（agent 调的工具那一行、
 *   脚本里 ha.routine 进入那一步；「流程『…』跑完」那一条也带 libraryCall，但不是工具调用，照普通一项放在后面）；
 * - 没有 libraryCall 的老数据按位置认：脚本调的（步骤同时带 routineStep / scriptStep，或者第 2 层）是第一步前面最近的一行
 *   routine.* 工具调用，agent 调的是最后一步后面第一行（工具调用跑完才记）。slugOf：知道库流程编号对应的短名时，只认工具 id 对得上的那一行。
 * 认不到的组单独成一项（没等到结果、中途断了）。
 * 「跑完」那一条（不是工具调用、trace.libraryCall.callId 对得上这一层认到主人的一次调用）并进那一组的 end，不单独成一项；
 * 一步都没做的调用（没有组）有「跑完」那一条时也给它一个空组，好把结局并进去
 */
export function nestLibrary<T>(items: T[], eventOf: (item: T) => RunEvent | undefined, depth = 1, slugOf?: (routineId: string) => string | undefined): LibraryNode<T>[] {
  const groups = new Map<string, { group: Omit<LibraryGroup, "steps">; events: RunEvent[]; first: number; last: number }>()
  const member = new Map<number, string>()
  let current: string | undefined
  items.forEach((item, index) => {
    const library = eventOf(item)?.trace?.library
    if (!library || library.depth < depth) {
      current = undefined
      return
    }
    const key = library.depth === depth ? library.callId : current
    if (!key) return
    current = key
    const event = eventOf(item)!
    const found = groups.get(key)
    if (found) {
      found.events.push(event)
      found.last = index
    } else {
      const scripted = depth > 1 || event.trace?.routineStep !== undefined || event.trace?.scriptStep !== undefined
      groups.set(key, { group: { callId: key, routineId: library.routineId, version: library.version, depth, via: scripted ? "script" : "tool" }, events: [event], first: index, last: index })
    }
    member.set(index, key)
  })
  // 认主人：先按 libraryCall.callId 对上
  const owner = new Map<number, string>()
  const claimed = new Set<number>()
  const byCall = new Map<string, number>()
  items.forEach((item, index) => {
    const event = eventOf(item)
    const callId = event?.trace?.libraryCall?.callId
    if (callId && isRoutineCall(event) && !member.has(index) && !byCall.has(callId)) byCall.set(callId, index)
  })
  for (const key of groups.keys()) {
    const found = byCall.get(key)
    if (found === undefined) continue
    owner.set(found, key)
    claimed.add(found)
  }
  // 「跑完」那一条：这一层里不是工具调用、带 libraryCall 的（不在任何一组里）
  const ends = new Map<string, number>()
  items.forEach((item, index) => {
    const event = eventOf(item)
    const callId = event?.trace?.libraryCall?.callId
    if (callId && !isRoutineCall(event) && !member.has(index) && !ends.has(callId)) ends.set(callId, index)
  })
  // 一步都没做的调用：没有组，进入那一行和「跑完」那一条都在，给它一个空组
  for (const [callId, index] of byCall) {
    if (groups.has(callId) || !ends.has(callId)) continue
    const library = eventOf(items[index]!)!.trace!.libraryCall!
    groups.set(callId, { group: { callId, routineId: library.routineId, version: library.version, depth, via: "script" }, events: [], first: index, last: index })
    owner.set(index, callId)
    claimed.add(index)
  }
  // 老数据（没有 libraryCall）按位置认；带 libraryCall 的那一行是别的调用的，不抢
  const fits = (index: number, routineId: string) => {
    const event = eventOf(items[index]!)
    if (!isRoutineCall(event) || event!.trace?.libraryCall || member.has(index) || claimed.has(index)) return false
    const slug = slugOf?.(routineId)
    return !slug || event!.toolId === routineToolId(slug)
  }
  const ownedKeys = new Set(owner.values())
  for (const [key, entry] of groups) {
    if (ownedKeys.has(key)) continue
    let found: number | undefined
    if (entry.group.via === "script") {
      for (let at = entry.first - 1; at >= 0 && found === undefined; at--) if (fits(at, entry.group.routineId)) found = at
    } else {
      for (let at = entry.last + 1; at < items.length && found === undefined; at++) if (fits(at, entry.group.routineId)) found = at
    }
    if (found !== undefined) {
      owner.set(found, key)
      claimed.add(found)
    }
  }
  // 认到主人的组才并「跑完」那一条（没认到的组照旧单独成一项，「跑完」也照旧一行）
  const owned = new Set(owner.values())
  const merged = new Map<number, string>()
  for (const [callId, index] of ends) if (owned.has(callId)) merged.set(index, callId)
  const endOf = new Map([...merged].map(([index, callId]) => [callId, eventOf(items[index]!)!]))
  const build = (key: string): LibraryGroup => {
    const entry = groups.get(key)!
    const end = endOf.get(key)
    return { ...entry.group, steps: nestLibrary(entry.events, (event) => event, depth + 1, slugOf), ...(end ? { end } : {}) }
  }
  const out: LibraryNode<T>[] = []
  const placed = new Set<string>()
  items.forEach((item, index) => {
    if (merged.has(index)) return
    const key = member.get(index)
    if (key) {
      if (owned.has(key) || placed.has(key)) return
      placed.add(key)
      out.push({ kind: "library", group: build(key) })
      return
    }
    const mine = owner.get(index)
    out.push({ kind: "item", item, ...(mine ? { library: build(mine) } : {}) })
  })
  return out
}

/** 一组库流程步骤一共几步（不算里面再调的库流程的步骤） */
export const libraryStepCount = (group: LibraryGroup) =>
  group.steps.filter((node) => node.kind === "item" && node.item.kind === "tool").length

/** 库流程工具那一行（agent 调的）的结局：工具结果里有交回值（routineReturnSchema）或停下的 data（routineToolStopDataSchema）就按它写，不然看出没出错 */
export function libraryResultText(event: RunEvent, steps: number, stopText: (stop: RoutineToolStopData["stoppedAt"]) => string): { text: string; failed: boolean } {
  const took = [`${steps} 步`, event.ms !== undefined ? (event.ms >= 1000 ? `${(event.ms / 1000).toFixed(1)} 秒` : `${event.ms} 毫秒`) : ""].filter(Boolean).join(" · ")
  const json = jsonIn(event.output)
  const returned = routineReturnSchema.safeParse(json)
  if (returned.success) {
    const data = Object.entries(returned.data.data).slice(0, 3).map(([key, value]) => `${key}=${value}`).join("、")
    const outcome = returned.data.outcome === "achieved" ? "" : ` · 没办成${returned.data.reason ? `（${returned.data.reason}）` : ""}`
    return { text: `跑完${outcome} · ${took}${data ? ` · 交回 ${data}` : ""}`, failed: false }
  }
  const stopped = routineToolStopDataSchema.safeParse(json)
  if (stopped.success) return { text: `停在第 ${stopped.data.stoppedAt.step} 步：${stopText(stopped.data.stoppedAt)}，交回 agent`, failed: true }
  if (isErrorStep(event)) {
    const first = event.output?.split("\n").find((line) => line.trim()) ?? ""
    return { text: `停下了，交回 agent${first ? `：${first.replace(/^出错[：:]\s*/, "")}` : ""}`, failed: true }
  }
  return { text: `跑完 · ${took}`, failed: false }
}

/**
 * 脚本里 ha.routine 调的那一行的结局：按并进来的「跑完」那一条（group.end）写，照 agent 调的写法（跑完 · 几步 · 用时 · 交回 / 停在哪）。
 * 用时取那一条标题里写的（工具桥算的整次调用），没写的（停下的）按两条的时间差；ms 给那一行的用时显示。没有「跑完」那一条返回 undefined
 */
export function libraryEndResult(enter: RunEvent, group: LibraryGroup): { text: string; failed: boolean; ms?: number; detail?: string } | undefined {
  const end = group.end
  if (!end) return undefined
  const gap = Date.parse(end.at) - Date.parse(enter.at)
  const body = end.title.replace(/^流程「.*?」(?=跑完|自己停下了|没跑完)/, "")
  const done = /^跑完：(\d+) 步(?: · ([\d.]+) 秒)?(.*)$/.exec(body)
  const ms = done?.[2] ? Math.round(Number(done[2]) * 1000) : Number.isFinite(gap) && gap >= 0 ? gap : undefined
  const took = ms === undefined ? "" : ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${ms} 毫秒`
  const detail = end.detail || undefined
  if (done) return { text: [`跑完`, `${done[1]} 步`, took].filter(Boolean).join(" · ") + done[3]!, failed: false, ...(ms !== undefined ? { ms } : {}) }
  const stop = body.replace(/^没跑完，/, "")
  // 停下的：同 agent 调的，只写停在哪（用时在那一行上）
  return { text: stop, failed: true, ...(ms !== undefined ? { ms } : {}), ...(detail ? { detail } : {}) }
}

/** 输出里的 JSON：整段是 JSON，或者最后一行 / 第一个「{」到最后一个「}」是 JSON */
function jsonIn(text: string | undefined): unknown {
  if (!text) return undefined
  const tries = [text, text.split("\n").at(-1) ?? "", text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]
  for (const each of tries) {
    if (!each.trim().startsWith("{")) continue
    try {
      return JSON.parse(each)
    } catch {
      // 换下一种
    }
  }
  return undefined
}

// ---------- 判断事件 ----------

const JUDGE_PREFIX = "流程判断："

export interface Judgement {
  question: string
  answer?: string
  reason?: string
}

/** 「流程判断：问题 → 答案（理由）」；不是判断事件返回 undefined。没有箭头的整段当问题 */
export function judgeOf(event: RunEvent): Judgement | undefined {
  if (event.kind !== "plan" || !event.title.startsWith(JUDGE_PREFIX)) return undefined
  const body = event.title.slice(JUDGE_PREFIX.length).trim()
  const arrow = /\s*→\s*/.exec(body)
  if (!arrow) return { question: body }
  const question = body.slice(0, arrow.index)
  let rest = body.slice(arrow.index + arrow[0].length)
  let reason: string | undefined
  // 末尾的（理由）：从后往前配对全角括号，理由里也可能有括号
  if (rest.endsWith("）")) {
    let depth = 0
    for (let at = rest.length - 1; at >= 0; at--) {
      const char = rest[at]
      if (char === "）") depth++
      else if (char === "（" && --depth === 0) {
        if (at > 0) {
          reason = rest.slice(at + 1, -1)
          rest = rest.slice(0, at)
        }
        break
      }
    }
  }
  return { question, answer: rest.trim() || undefined, reason: reason?.trim() || undefined }
}

// ---------- code.run 的工具汇总 ----------

/** 带工具的 code.run：输出最后一段从这一行起 */
export const TOOLS_MARK = "--- 脚本调的工具 ---"

export interface ToolsSummary {
  /** 「脚本调了 6 次工具（出错 1 次）」，或者「脚本没有调工具」 */
  head: string
  /** 每个工具几次（「browser.navigate 3 次」「browser.extract 3 次（出错 1 次）」） */
  counts: string[]
  /** 停下的说明：「停在第 k 步」「停在第 k 步（接着跑时对不上）」「脚本自己停下了（ha.fail）」和后面的原因 */
  stops: { head: string; rest: string }[]
  /** 别的行（「最后一次出错：……」），原样 */
  others: string[]
}

/** 拆「--- 脚本调的工具 ---」后面那几行 */
export function parseToolsSummary(text: string): ToolsSummary {
  const summary: ToolsSummary = { head: "", counts: [], stops: [], others: [] }
  for (const line of text.split("\n").map((each) => each.trim()).filter(Boolean)) {
    const head = /^(脚本调了 \d+ 次工具(?:（出错 \d+ 次）)?)[：:]\s*(.*)$/.exec(line)
    if (head) {
      summary.head = head[1]!
      summary.counts.push(...head[2]!.split("、").map((each) => each.trim()).filter(Boolean))
      continue
    }
    if (line.startsWith("脚本没有调工具")) {
      summary.head = "脚本没有调工具"
      continue
    }
    const stop = /^(停在第 \d+ 步|停下了|脚本自己停下了)((?:（[^）]*）)?)[：:]\s*(.*)$/.exec(line)
    if (stop) summary.stops.push({ head: `${stop[1]}${stop[2]}`, rest: stop[3]! })
    else summary.others.push(line)
  }
  return summary
}

// ---------- browser.fetch（docs/dev/solidify.md 19.4、19.8） ----------

export interface FetchCall {
  method: string
  /** 完整网址（悬停看全文） */
  url: string
  /** 只显示路径和参数 */
  path: string
  /** 状态码：从输出第一行的「→ 200」取；出错（没拿到返回）没有 */
  status?: number
}

/** 网址只留路径和参数；解析不了原样返回 */
export function urlPath(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

/**
 * browser.fetch 那一行要的：方法、网址从输入（JSON）取，取不到再看输出第一行
 * 「GET https://… → 200 application/json（17.9 KB，184 毫秒）」；状态码只看输出第一行。不是这个工具返回 undefined
 */
export function fetchCallOf(event: RunEvent): FetchCall | undefined {
  if (event.kind !== "tool" || event.toolId !== BROWSER_FETCH_TOOL) return undefined
  let input: { url?: unknown; method?: unknown } = {}
  try {
    const parsed: unknown = JSON.parse(event.input ?? "")
    if (parsed && typeof parsed === "object") input = parsed as typeof input
  } catch {
    // 输入不是 JSON：只看输出
  }
  const head = /^([A-Z]+) (\S+) → (\d{3})\b/.exec(event.output?.split("\n", 1)[0] ?? "")
  const url = typeof input.url === "string" ? input.url : head?.[2]
  if (!url) return undefined
  const method = typeof input.method === "string" ? input.method.toUpperCase() : head?.[1] ?? "GET"
  return { method, url, path: urlPath(url), status: head ? Number(head[3]) : undefined }
}
