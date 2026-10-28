// 过程里和脚本有关的几样怎么拆（docs/dev/solidify.md 第 18 节，界面在 run-detail.tsx）：
// - agent 用 code.run（tools）写的脚本做的步骤（trace.scriptCallId，工具调用还有 scriptStep）：先记步骤、code.run 跑完才记它自己，
//   那条 code.run 的 trace 也写了同一个 scriptCallId，按 id 把步骤收在它下面；还没等到 code.run 的（脚本还在跑、中途被打断）单独成组；
// - 判断事件：kind = plan、标题「流程判断：问题 → 答案（理由）」，拆成问题、答案、理由；
// - code.run 输出末尾「--- 脚本调的工具 ---」那一段（服务端 sandbox/code-run.ts 的 formatScriptTools）拆成几段。
import type { RunEvent } from "@heyagent/shared"

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
