// 把过程记录写成给模型看的文字（复核、固化员共用的一些小工具）：
// - clip / oneLine / clipBlocks / isToolError：固化员的材料（routine/material.ts）和复核都用；
// - describeToolInput：工具参数写成人看得懂的样子（browser.batch 逐个动作列出来、浏览器动作给元素 / 定位 / 网址 / 填的值），
//   别的工具照旧截 JSON；
// - reviewLog：复核看的过程记录（engine/review.ts）：整次运行都覆盖到，最近几条详细，更早的每条压成一行，总字数有上限。
import type * as t from "../db/schema.js"

type EventRow = typeof t.sessionEvents.$inferSelect

export const clip = (value: string | null | undefined, max: number) => (!value ? "" : value.length > max ? `${value.slice(0, max)}…` : value)
export const oneLine = (value: string) => value.replace(/\s*\n\s*/g, " ⏎ ")

/** 工具调用的结果是出错（网关落过程记录时标题加「（出错）」） */
export const isToolError = (event: Pick<EventRow, "title">) => event.title.endsWith("（出错）")

/** 一串段落，超出预算时留开头 2/5、结尾 3/5，中间写省略了几条 */
export function clipBlocks(blocks: string[], budget: number): string[] {
  const total = blocks.reduce((sum, block) => sum + block.length + 1, 0)
  if (total <= budget) return blocks
  const head: string[] = []
  const tail: string[] = []
  let used = 0
  for (const block of blocks) {
    if (used + block.length > (budget * 2) / 5) break
    head.push(block)
    used += block.length + 1
  }
  used = 0
  for (const block of blocks.slice(head.length).reverse()) {
    if (used + block.length > (budget * 3) / 5) break
    tail.unshift(block)
    used += block.length + 1
  }
  const skipped = blocks.length - head.length - tail.length
  return [...head, `……中间 ${skipped} 条省略……`, ...tail]
}

// ---------- 工具参数写成人看得懂的样子 ----------

/** 每个值最多给多少字 */
const VALUE_MAX = 40

const str = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : "")
const short = (value: unknown, max = VALUE_MAX) => oneLine(clip(str(value), max))

/** 批里的 tool 写法（click、browser_click、browser.click 都认）→ 工具 id（同 browser/tools.ts 的 batchToolId） */
export const batchActionToolId = (tool: string) => `browser.${tool.trim().replace(/^browser[._]/, "")}`

/** 写成文字时不给的参数：快照 ref（e12 这种，人看不懂）、批的 snapshot 选项 */
const SKIP_KEYS = new Set(["ref", "startRef", "endRef", "snapshot"])
/** 单独处理过的参数 */
const HANDLED_KEYS = new Set(["element", "startElement", "endElement", "target", "url", "key", "text", "values", "fields", "list", "outcomes"])

/** 一个浏览器动作的参数：元素 / 定位 / 网址 / 按键 / 填的值，别的参数 key=值（每个值截 40 字左右） */
export function describeBrowserArgs(input: Record<string, unknown>): string {
  const parts: string[] = []
  const element = short(input.element) || short(input.startElement)
  if (element) parts.push(`「${element}」`)
  else if (str(input.target)) parts.push(`定位 ${short(input.target, 80)}`)
  if (str(input.endElement)) parts.push(`→「${short(input.endElement)}」`)
  if (str(input.url)) parts.push(short(input.url, 120))
  if (str(input.key)) parts.push(`按键 ${short(input.key)}`)
  if (str(input.text)) parts.push(`填「${short(input.text)}」`)
  if (Array.isArray(input.values)) parts.push(`选「${input.values.map((value) => short(value)).join("、")}」`)
  if (Array.isArray(input.fields))
    parts.push(
      input.fields
        .map((field) => {
          const each = (field ?? {}) as Record<string, unknown>
          const name = short(each.name) || short(each.target) || "（没写名字）"
          return `${name}=${"value" in each ? short(each.value) : "（没填值）"}`
        })
        .join("、")
    )
  else if (input.fields && typeof input.fields === "object") parts.push(`字段 ${Object.keys(input.fields).join("、")}`)
  if (str(input.list)) parts.push(`每行 ${short(input.list, 80)}`)
  if (input.outcomes && typeof input.outcomes === "object") parts.push(`等 ${Object.keys(input.outcomes).join(" / ")}`)
  for (const [key, value] of Object.entries(input)) {
    if (SKIP_KEYS.has(key) || HANDLED_KEYS.has(key) || value === undefined || value === null) continue
    const text = typeof value === "object" ? short(JSON.stringify(value)) : short(value)
    if (text) parts.push(`${key}=${text}`)
  }
  return parts.join(" ")
}

/** browser.batch 的参数：逐个动作列出来「1. click「继续录入」 2. fill_form 编号=P-106、…」 */
export function describeBatch(input: Record<string, unknown>): string {
  const actions = Array.isArray(input.actions) ? (input.actions as { tool?: unknown; input?: unknown }[]) : []
  if (!actions.length) return "（没有动作）"
  return actions
    .map((action, index) => {
      const tool = batchActionToolId(str(action?.tool) || "?").replace(/^browser\./, "")
      const args = action?.input && typeof action.input === "object" ? describeBrowserArgs(action.input as Record<string, unknown>) : ""
      return `${index + 1}. ${tool}${!args || args.startsWith("「") ? args : ` ${args}`}`
    })
    .join(" ")
}

/**
 * 一次工具调用的参数写成文字：browser.batch 逐个动作列出来；别的浏览器动作给元素 / 定位 / 网址 / 填的值；
 * 其它工具（和解析不了的：存的时候截断了）照旧截 JSON。max：最多多少字
 */
export function describeToolInput(toolId: string | null, input: string | null, max: number): string {
  if (!input) return "{}"
  if (toolId?.startsWith("browser.")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(input)
    } catch {
      parsed = undefined
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const text = toolId === "browser.batch" ? describeBatch(parsed as Record<string, unknown>) : describeBrowserArgs(parsed as Record<string, unknown>)
      return clip(text, max) || "（没有参数）"
    }
  }
  return oneLine(clip(input, max))
}

/** 批的结果只留逐步的 ✓ / ✗ 那几行（后面的页面概况、快照不要） */
export function batchResultLines(output: string | null): string {
  if (!output) return ""
  const lines: string[] = []
  for (const line of output.split("\n")) {
    if (line === "") break
    if (/^\d+\. /.test(line) || /^（/.test(line)) lines.push(line.trim())
  }
  return lines.join(" ")
}

/** 一次工具调用的结果写成文字：批给逐步的 ✓ / ✗；别的给开头 max 字 */
export function describeToolOutput(toolId: string | null, output: string | null, max: number): string {
  if (toolId === "browser.batch") {
    const steps = batchResultLines(output)
    if (steps) return clip(steps, Math.max(max, 1200))
  }
  return oneLine(clip(output, max))
}

// ---------- 复核看的过程记录 ----------

export interface ReviewLogOptions {
  /** 最近几条照详细的写（参数、结果各 300 字） */
  recent: number
  /** 更早的（每条压成一行）合计最多多少字：超了留最早的一段和较近的一段，中间写省略了几条 */
  budget: number
}

/** 批里的每一步在网关里也单独记了一条（在批那条的前面）：认出来标「第 b 批第 n 步」，批那条是汇总 */
function batchMembers(events: EventRow[]) {
  const member = new Map<number, { batch: number; step: number }>()
  const batches = new Map<number, { batch: number; steps: number }>()
  let count = 0
  events.forEach((event, index) => {
    if (event.kind !== "tool" || event.toolId !== "browser.batch") return
    let actions: { tool?: unknown }[] = []
    try {
      const parsed = JSON.parse(event.input ?? "") as { actions?: unknown }
      if (Array.isArray(parsed.actions)) actions = parsed.actions as { tool?: unknown }[]
    } catch {
      // 参数存的时候截断了：认不出是哪几条
    }
    const batch = ++count
    const ids = actions.map((action) => batchActionToolId(str(action?.tool) || "?"))
    // 往前找工具调用（中间夹着的规则、人的记录跳过）：最后 k 条正好是批的前 k 步
    const before: EventRow[] = []
    for (let j = index - 1; j >= 0 && before.length < ids.length; j--) {
      const each = events[j]!
      if (each.kind !== "tool") continue
      if (each.toolId === "browser.batch" || member.has(each.seq)) break
      before.unshift(each)
    }
    let steps = 0
    for (let k = Math.min(ids.length, before.length); k > 0; k--) {
      const tail = before.slice(before.length - k)
      if (tail.every((each, n) => each.toolId === ids[n])) {
        tail.forEach((each, n) => member.set(each.seq, { batch, step: n + 1 }))
        steps = k
        break
      }
    }
    batches.set(event.seq, { batch, steps })
  })
  return { member, batches }
}

/**
 * 复核看的过程记录（工具调用、规则、人的处理），整次运行都覆盖到：
 * 最近 recent 条照原来的详细程度（参数、结果各 300 字，参数写成人看得懂的样子）；更早的每条压成一行（工具名 + 关键参数 + 结果开头），
 * 合计超过 budget 字时留最早的一段和较近的一段，中间写「中间 n 条省略」。
 * 工具调用带整次运行里的序号（#k）；固化流程做的标「流程第 n 步」；批里的步骤标「第 b 批第 n 步」
 */
export function reviewLog(events: EventRow[], options: ReviewLogOptions): { lines: string[]; total: number; tools: number; recent: number; earlier: number } {
  const { member, batches } = batchMembers(events)
  const toolNo = new Map<number, number>()
  let tools = 0
  for (const event of events) if (event.kind === "tool") toolNo.set(event.seq, ++tools)

  const tags = (event: EventRow) => {
    const out: string[] = []
    if (event.trace?.routineStep) out.push(`流程第 ${event.trace.routineStep} 步`)
    if (event.trace?.scriptStep) out.push(`agent 脚本第 ${event.trace.scriptStep} 步`)
    const inBatch = member.get(event.seq)
    if (inBatch) out.push(`第 ${inBatch.batch} 批第 ${inBatch.step} 步`)
    const batch = batches.get(event.seq)
    if (batch)
      out.push(
        batch.steps
          ? `第 ${batch.batch} 批的汇总：这一批的 ${batch.steps} 步上面已逐条记过，不是又做了一遍`
          : `第 ${batch.batch} 批的汇总`
      )
    return out.length ? `（${out.join("；")}）` : ""
  }
  const mark = (event: EventRow) => (isToolError(event) ? "✗ 出错" : "✓")

  const detailed = (event: EventRow) =>
    event.kind === "tool"
      ? `- #${toolNo.get(event.seq)} 调用 ${event.title}（${event.toolId ?? ""}）${tags(event)}：参数 ${describeToolInput(event.toolId, event.input, event.toolId === "browser.batch" ? 2000 : 300)} → 结果 ${describeToolOutput(event.toolId, event.output, 300) || "（没有输出）"}`
      : `- ${event.kind === "rule" ? "规则" : "人"}：${event.title}${tags(event)}${event.detail ? `（${clip(event.detail, 200)}）` : ""}`
  const compact = (event: EventRow) =>
    event.kind === "tool"
      ? `- #${toolNo.get(event.seq)} ${event.toolId ?? event.title} ${mark(event)}${tags(event)} ${describeToolInput(event.toolId, event.input, event.toolId === "browser.batch" ? 600 : 200)} → ${describeToolOutput(event.toolId, event.output, 60) || "（没有输出）"}`
      : `- ${event.kind === "rule" ? "规则" : "人"}：${event.title}${tags(event)}${event.detail ? `（${oneLine(clip(event.detail, 80))}）` : ""}`

  const cut = Math.max(0, events.length - options.recent)
  const earlier = clipBlocks(events.slice(0, cut).map(compact), options.budget)
  const recent = events.slice(cut).map(detailed)
  const lines = cut
    ? [`（以下第 1～${cut} 条是较早的记录，每条压成一行）`, ...earlier, `（以下是最近的 ${recent.length} 条，详细）`, ...recent]
    : recent
  return { lines, total: events.length, tools, recent: recent.length, earlier: cut }
}
