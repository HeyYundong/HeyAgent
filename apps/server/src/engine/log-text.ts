// 把过程记录写成给模型看的文字（复核、固化员共用的一些小工具）：
// - clip / oneLine / clipBlocks / isToolError：固化员的材料（routine/material.ts）和复核都用；
// - describeToolInput：工具参数写成人看得懂的样子（browser.batch 逐个动作列出来、浏览器动作给元素 / 定位 / 网址 / 填的值），
//   别的工具照旧截 JSON；
// - reviewLog：复核（engine/review.ts）和三方验收（engine/verify.ts）看的过程记录：整次运行都覆盖到，最近几条详细，
//   更早的每条压成一行，总字数有上限；读数据的工具（readsData）结果多给字数（合计另有上限）；
//   库流程里的步骤（trace.library，docs/dev/routine-library.md 5.7）每次调用只留最近几步，前面的压成一行（同批的写法）。
import { isRoutineToolId, type SessionSnapshot } from "@heyagent/shared"

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

/** 一个浏览器动作的参数：元素 / 定位 / 网址 / 按键 / 填的值，别的参数 key=值（填的值每个最多 valueMax 字，默认 40） */
export function describeBrowserArgs(input: Record<string, unknown>, valueMax = VALUE_MAX): string {
  const parts: string[] = []
  const element = short(input.element) || short(input.startElement)
  if (element) parts.push(`「${element}」`)
  else if (str(input.target)) parts.push(`定位 ${short(input.target, 80)}`)
  if (str(input.endElement)) parts.push(`→「${short(input.endElement)}」`)
  if (str(input.url)) parts.push(short(input.url, 120))
  if (str(input.key)) parts.push(`按键 ${short(input.key)}`)
  if (str(input.text)) parts.push(`填「${short(input.text, valueMax)}」`)
  if (Array.isArray(input.values)) parts.push(`选「${input.values.map((value) => short(value, valueMax)).join("、")}」`)
  if (Array.isArray(input.fields))
    parts.push(
      input.fields
        .map((field) => {
          const each = (field ?? {}) as Record<string, unknown>
          const name = short(each.name) || short(each.target) || "（没写名字）"
          return `${name}=${"value" in each ? short(each.value, valueMax) : "（没填值）"}`
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
export function describeBatch(input: Record<string, unknown>, valueMax = VALUE_MAX): string {
  const actions = Array.isArray(input.actions) ? (input.actions as { tool?: unknown; input?: unknown }[]) : []
  if (!actions.length) return "（没有动作）"
  return actions
    .map((action, index) => {
      const tool = batchActionToolId(str(action?.tool) || "?").replace(/^browser\./, "")
      const args = action?.input && typeof action.input === "object" ? describeBrowserArgs(action.input as Record<string, unknown>, valueMax) : ""
      return `${index + 1}. ${tool}${!args || args.startsWith("「") ? args : ` ${args}`}`
    })
    .join(" ")
}

/**
 * 一次工具调用的参数写成文字：browser.batch 逐个动作列出来；别的浏览器动作给元素 / 定位 / 网址 / 填的值；
 * 其它工具（和解析不了的：存的时候截断了）照旧截 JSON。max：最多多少字；valueMax：填的值每个最多多少字
 */
export function describeToolInput(toolId: string | null, input: string | null, max: number, valueMax = VALUE_MAX): string {
  if (!input) return "{}"
  if (toolId?.startsWith("browser.")) {
    let parsed: unknown
    try {
      parsed = JSON.parse(input)
    } catch {
      parsed = undefined
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const text = toolId === "browser.batch" ? describeBatch(parsed as Record<string, unknown>, valueMax) : describeBrowserArgs(parsed as Record<string, unknown>, valueMax)
      return clip(text, max) || "（没有参数）"
    }
  }
  return oneLine(clip(input, max))
}

/** 批的结果里逐步的 ✓ / ✗ 那几行（后面的页面概况不要；快照另由 batchSnapshotText 压过再给） */
export function batchResultLines(output: string | null): string {
  if (!output) return ""
  const lines: string[] = []
  for (const line of output.split("\n")) {
    if (line === "") break
    if (/^\d+\. /.test(line) || /^（/.test(line)) lines.push(line.trim())
  }
  return lines.join(" ")
}

/**
 * 结果里排好版的 JSON（JSON.stringify(x, null, 2)：一行只有 { 或 [ 开头）从那一行起压成一行（去掉换行和缩进）。
 * 截断过的半截 JSON 也照样压（JSON 的字符串里不会有原样的换行）；JSON 前面的说明行照旧
 */
export function compactJsonOutput(output: string): string {
  const start = /(^|\n)[[{]\n[ \t]/.exec(output)
  if (!start) return output
  const at = start.index + start[1]!.length
  return `${output.slice(0, at)}${output.slice(at).replace(/\n[ \t]*/g, "")}`
}

/**
 * 读数据的内置工具（复核、三方验收要核对读到的每一条）：结果多给字数（总量在 reviewLog 里另有上限）。
 * browser.snapshot 的快照先压成文字行（compactSnapshot），code.run 取退出码和 stdout（describeCodeRunOutput），排好版的 JSON 先压成一行。
 * 另外还有：库流程（routine.<短名>，交回的值）、任务里的 HTTP 工具和 MCP 工具（id 是配置的，从快照里取，见 dataToolIdsOf）。
 * 不算的：subagent.wait（子 agent 交回的字段另有「子 agent」一节）、skill.load（是做法说明，不是数据）
 */
export const DATA_TOOLS = new Set([
  "browser.fetch",
  "browser.extract",
  "browser.snapshot",
  "browser.find",
  "browser.clipboard_read",
  "browser.network_request",
  "code.run",
  "file.read",
  "work.list",
  "desktop.snapshot",
  "desktop.clipboard",
  "gallery.search",
  "gallery.get",
  "gallery.compare",
  "compare.images",
  "compare.get",
  "compare.list",
])

/** 任务里配置的、会带回数据的工具：HTTP 工具、MCP 工具（id 是主管起的，只能从快照里认） */
export function dataToolIdsOf(snapshot: Pick<SessionSnapshot, "tools"> | null | undefined): Set<string> {
  return new Set((snapshot?.tools ?? []).filter((tool) => tool.source === "http" || tool.source === "mcp").map((tool) => tool.id))
}

/** 这个工具是不是读数据的：内置的读数据工具、库流程，或者 extra 里的（任务配置的 HTTP / MCP 工具） */
export const isDataTool = (toolId: string | null, extra?: ReadonlySet<string>) =>
  !!toolId && (DATA_TOOLS.has(toolId) || isRoutineToolId(toolId) || !!extra?.has(toolId))

/** 批的结果里附的页面快照从这一行起（gateway.ts 的 runBatch：「页面快照：」单独一行） */
const BATCH_SNAPSHOT_MARK = "\n页面快照：\n"

/** 批带了页面快照（agent 多半靠它读数据，docs/dev/sub-agents.md 21.6.5 第 4 条）：算进读数据的工具 */
export const batchHasSnapshot = (output: string | null | undefined) => Boolean(output?.includes(BATCH_SNAPSHOT_MARK))

/** 这条记录是不是读数据的（复核时结果多给字数）：读数据的工具（isDataTool），或带了页面快照的批 */
export const readsData = (event: { toolId: string | null; output: string | null }, extra?: ReadonlySet<string>) =>
  isDataTool(event.toolId, extra) || (event.toolId === "browser.batch" && batchHasSnapshot(event.output))

/** 快照里不要的标记：ref、鼠标样式、焦点、标题级别 */
const SNAPSHOT_NOISE = /\s*\[(?:ref|cursor|level)=[^\]]*\]|\s*\[active\]/g
/** 输入类的角色：写成「名字=值」（填进去的值；勾选的带 [checked]）。只是容器、自己没有文字的（「- generic:」）整行不要 */
const SNAPSHOT_FORM_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "checkbox", "radio", "switch", "slider"])

/**
 * Playwright MCP 的页面快照（YAML 那种缩进的树）压成给复核看的文字行：去掉 ### Page 段、代码块标记、ref 等标记和只是容器的行，
 * 每个元素只留文字（名字、值；输入框写「名字=值」），表格的一行（row）把各格用 | 连成一行。行之间用 ⏎ 连
 */
export function compactSnapshot(text: string): string {
  const at = text.indexOf("### Snapshot")
  const body = at >= 0 ? text.slice(at + "### Snapshot".length) : text
  const nodes: { indent: number; role: string; text: string }[] = []
  for (const raw of body.split("\n")) {
    if (/^\s*```/.test(raw) || /^### /.test(raw) || !raw.trim()) continue
    const match = /^(\s*)- (.*)$/.exec(raw)
    const indent = match ? match[1]!.length : raw.length - raw.trimStart().length
    const content = (match ? match[2]! : raw.trim()).replace(SNAPSHOT_NOISE, "")
    if (content.startsWith("/url:") || /^- Page (URL|Title):/.test(raw.trim())) continue
    const parts = /^([\w-]+)(?: "((?:[^"\\]|\\.)*)")?(.*)$/.exec(content)
    if (!match || !parts) {
      nodes.push({ indent, role: "text", text: content.replace(/^"|"$/g, "") })
      continue
    }
    const role = parts[1]!
    const name = (parts[2] ?? "").replace(/\\"/g, '"')
    const rest = parts[3]!.trim()
    const flags = rest.match(/\[[^\]]+\]/g)?.join("") ?? ""
    const value = rest.replace(/\[[^\]]+\]/g, "").replace(/^:/, "").trim().replace(/^"|"$/g, "")
    const words = SNAPSHOT_FORM_ROLES.has(role) ? `${name || role}=${value}${flags}` : [name, value].filter(Boolean).join(" ")
    nodes.push({ indent, role, text: words })
  }
  const lines: string[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    if (node.role === "row") {
      const cells: string[] = []
      let j = i + 1
      for (; j < nodes.length && nodes[j]!.indent > node.indent; j++) if (nodes[j]!.text) cells.push(nodes[j]!.text)
      const row = cells.length ? cells.join(" | ") : node.text
      if (row) lines.push(row)
      i = j - 1
      continue
    }
    if (node.text) lines.push(node.text)
  }
  return lines.join(" ⏎ ")
}

/** 批的结果里附的页面快照，压成文字行（没有快照返回空串） */
export function batchSnapshotText(output: string | null | undefined): string {
  if (!output) return ""
  const at = output.indexOf(BATCH_SNAPSHOT_MARK)
  return at < 0 ? "" : compactSnapshot(output.slice(at + BATCH_SNAPSHOT_MARK.length))
}

/** 太长时留开头 1/3、结尾 2/3，中间写省略了几字（脚本的输出：开头是在做什么，结尾多半是结果） */
export function clipMiddle(value: string, max: number): string {
  if (value.length <= max) return value
  const head = Math.floor(max / 3)
  const tail = Math.max(0, max - head)
  return `${value.slice(0, head)}…（中间省略 ${value.length - head - tail} 字）…${value.slice(value.length - tail)}`
}

/** code.run 输出里各段的标题行（sandbox/code-run.ts 的 formatCodeRunOutput、formatScriptTools） */
const CODE_RUN_PARTS = ["stdout", "stderr", "脚本调的工具"] as const

/**
 * code.run 的结果写成文字：退出码那几行（写回了哪些文件、访问了哪些主机）、stdout（脚本算出、打印的数据，排好版的 JSON 先压成一行）、
 * stderr、脚本调的工具。总共大约 max 字：别的几段各最多 300 字（max 的 1/4），剩下的都给 stdout，太长的留开头和结尾
 */
export function describeCodeRunOutput(output: string, max: number): string {
  const marks = CODE_RUN_PARTS.map((label) => ({ label, at: output.indexOf(`\n--- ${label} ---\n`) }))
    .filter((each) => each.at >= 0)
    .sort((a, b) => a.at - b.at)
  const head = oneLine(output.slice(0, marks[0]?.at ?? output.length).trim())
  const parts = new Map<string, string>()
  marks.forEach((mark, index) => {
    const start = mark.at + `\n--- ${mark.label} ---\n`.length
    parts.set(mark.label, output.slice(start, marks[index + 1]?.at ?? output.length).trim())
  })
  const stdout = parts.get("stdout")
  const stderr = parts.get("stderr")
  const tools = parts.get("脚本调的工具")
  const sideMax = Math.min(300, Math.max(60, Math.floor(max / 4)))
  const side = [
    clip(head, sideMax),
    stderr ? `stderr：${oneLine(clipMiddle(stderr, sideMax))}` : "",
    tools ? `脚本调的工具：${oneLine(clip(tools, sideMax))}` : "",
  ]
  const room = Math.max(100, max - side.reduce((sum, part) => sum + part.length + 1, 0) - 10)
  const out = stdout ? `stdout：${oneLine(clipMiddle(compactJsonOutput(stdout), room))}` : ""
  return [side[0], out, side[1], side[2]].filter(Boolean).join(" ")
}

/**
 * 一次工具调用的结果写成文字：批给逐步的 ✓ / ✗，带了页面快照的再附压过的快照（最多 dataMax 字，agent 多半是从这里读到数据的）；
 * browser.snapshot 的快照先压成文字行；code.run 给退出码和 stdout（describeCodeRunOutput）；别的给开头 max 字（排好版的 JSON 先压成一行再截）
 */
export function describeToolOutput(toolId: string | null, output: string | null, max: number, dataMax = max): string {
  if (toolId === "browser.batch") {
    const steps = batchResultLines(output)
    if (steps) {
      const snapshot = batchSnapshotText(output)
      return `${clip(steps, Math.max(max, 1200))}${snapshot ? ` 最后的页面快照：${clip(snapshot, dataMax)}` : ""}`
    }
  }
  if (toolId === "browser.snapshot" && output) return clip(compactSnapshot(output), max)
  if (toolId === "code.run" && output) return describeCodeRunOutput(output, max)
  return oneLine(clip(output ? compactJsonOutput(output) : output, max))
}

// ---------- 复核看的过程记录 ----------

/** 复核、三方验收的系统提示里讲过程记录怎么读的几条（两边一样） */
export const LOG_FORMAT_NOTES = [
  "- 过程记录覆盖整次运行：较早的每条压成一行，最近的详细；工具调用的 #k 是整次运行里的序号。标「流程第 n 步」的是固化流程（脚本）做的，和 agent 做的一样算数。",
  "- 一次 browser_batch（过程记录里的 browser.batch）连着做好几步，每步做没做看结果里的 ✓ / ✗；几步填的值不同就是做了几件不同的事，不是重复。批里每一步在它前面也单独记了一条（标「第 b 批第 n 步」），批那条是汇总，不是又做了一遍。批的结果后面「最后的页面快照」是批做完时页面上的文字（压过：一行用 ⏎ 隔开，表格的一行各格用 | 连），和 browser.snapshot 的结果一样是页面上真有的内容，agent 多半是从这里读到数据的。",
  "- 读数据的工具（网站接口、HTTP 工具、code.run、file.read 等）的结果是工具真拿到的内容，agent 多半从这里拿到数据：排好版的 JSON 压成了一行，code.run 给退出码和 stdout；太长的截过，截掉的部分看不到。",
]

/**
 * 详细的几条里，读数据的工具结果合计最多多少字、每条最少 / 最多多少字。
 * 2026-10-29 从 8000 / 2000 放宽到 12000 / 4000：HTTP 工具、code.run、file.read 等也算读数据了，大家分同一个份额；
 * 一条 HTTP / 接口的返回（几十条记录的 JSON）压成一行常有三四千字。份额按需分（shareBudget）：短的拿多少用多少，省下的给长的，
 * 所以合计放宽了、短的多了也不浪费。最近 30 条全是读数据的时每条正好 400 字（不比原来的 300 字少），合计不超过 12000 字
 */
export const DATA_OUTPUT_BUDGET = 12_000
export const DATA_OUTPUT_MIN = 300
export const DATA_OUTPUT_MAX = 4000

/**
 * 复核、三方验收看的过程记录：最近 30 条详细，更早的每条压成一行、合计最多 1.2 万字（读数据的另有 DATA_OUTPUT_BUDGET）。
 * 整段过程记录最多大约：较早的 1.2 万 + 最近 30 条（参数最多 600 字、结果 300 字，批的参数 2000 字）+ 读数据的 1.2 万，
 * 一般远少于这些
 */
export const REVIEW_LOG: ReviewLogOptions = { recent: 30, budget: 12_000 }

/**
 * 复核、三方验收的输入（一整段文字）最多多少字，超了从中间截掉（开头是目标、检查点和报告，末尾是最近的过程记录）。
 * 2026-10-29 从 6 万（只有复核有上限）放宽到 8 万，三方验收也用：读数据的工具多了，份额从 8000 放到 12000。
 * 8 万字大约 5～8 万 token：复核用的便宜模型（deepseek-v4.1-flash 等）和验收模型上下文都在 12.8 万以上；一般的运行远少于这些
 */
export const EVIDENCE_PROMPT_MAX = 80_000

/** 输入太长时从中间截掉：留开头 6 成、结尾 4 成 */
export const clipPrompt = (prompt: string, max = EVIDENCE_PROMPT_MAX) =>
  prompt.length > max ? `${prompt.slice(0, max * 0.6)}\n…（中间太长，省略）…\n${prompt.slice(-max * 0.4)}` : prompt

export interface ReviewLogOptions {
  /** 最近几条照详细的写（参数、结果各 300 字；读数据的工具结果多给，见 DATA_OUTPUT_BUDGET） */
  recent: number
  /** 更早的（每条压成一行）合计最多多少字：超了留最早的一段和较近的一段，中间写省略了几条 */
  budget: number
  /** 任务里配置的、会带回数据的工具 id（HTTP、MCP 工具，dataToolIdsOf） */
  dataTools?: ReadonlySet<string>
}

/**
 * 一个份额按需分给几条：从要得少的分起，每条最多拿「剩下的 ÷ 还没分的条数」（不少于 min、不多于 max），用不完的留给后面要得多的。
 * 返回每条的上限（和 needs 同顺序）。条数 × min 超过 budget 时每条照样给 min
 */
export function shareBudget(needs: number[], budget: number, min: number, max: number): number[] {
  const order = needs.map((need, index) => ({ need, index })).sort((a, b) => a.need - b.need)
  const caps = new Array<number>(needs.length).fill(min)
  let left = budget
  order.forEach(({ need, index }, n) => {
    const share = Math.floor(left / (order.length - n))
    const cap = Math.min(max, Math.max(min, share))
    caps[index] = cap
    left -= Math.min(need, cap)
  })
  return caps
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

/** 一次库流程调用里留几步（最近的），前面的压成一行 */
const LIBRARY_KEEP_STEPS = 3

type LogItem = EventRow | { placeholder: string }

/**
 * 库流程里的步骤（trace.library，按 callId 归成一次调用）：每次调用只留最近 LIBRARY_KEEP_STEPS 条，前面的换成一行
 * 「流程 RT-n 第 v 版（这次调用）前 k 步省略」，放在省掉的第一条的位置。调库流程那一条（agent 调的工具、脚本里进入那一步）照常列出
 */
function foldLibrarySteps(events: EventRow[]): LogItem[] {
  const groups = new Map<string, EventRow[]>()
  for (const event of events) {
    const library = event.trace?.library
    if (!library) continue
    const group = groups.get(library.callId) ?? []
    group.push(event)
    groups.set(library.callId, group)
  }
  const dropped = new Set<number>()
  const placeholders = new Map<number, string>()
  for (const group of groups.values()) {
    if (group.length <= LIBRARY_KEEP_STEPS) continue
    const cut = group.slice(0, group.length - LIBRARY_KEEP_STEPS)
    for (const event of cut) dropped.add(event.seq)
    const library = group[0]!.trace!.library!
    const steps = new Set(cut.map((event) => event.trace!.library!.step)).size
    placeholders.set(
      cut[0]!.seq,
      `- 库流程 ${library.routineId} 第 ${library.version} 版（这次调用 ${library.callId}）：前 ${steps} 步（${cut.length} 条记录）省略，下面是最近的几步，跑完的结果见调用它的那一条`
    )
  }
  if (dropped.size === 0) return events
  return events.flatMap((event): LogItem[] => {
    const placeholder = placeholders.get(event.seq)
    if (placeholder) return [{ placeholder }]
    return dropped.has(event.seq) ? [] : [event]
  })
}

/**
 * 复核、三方验收看的过程记录（工具调用、规则、人的处理），整次运行都覆盖到：
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
    if (event.trace?.library) out.push(`库流程 ${event.trace.library.routineId} 第 ${event.trace.library.step} 步`)
    if (event.trace?.libraryCall && event.toolId?.startsWith("routine.")) out.push("调库流程")
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

  // 库流程里的步骤每次调用只留最近几步
  const items = foldLibrarySteps(events)
  const cut = Math.max(0, items.length - options.recent)
  // 详细的几条：填的值给全（例如提交的汇总有好几行），参数、结果各 300 字（批的参数 2000 字）。
  // 读数据的工具（readsData：browser.fetch、browser.extract、HTTP 工具、code.run、file.read 等）的结果合计 DATA_OUTPUT_BUDGET 字，
  // 按需分（shareBudget），每条 300～4000 字
  // （基准 E：接口读的 5 页只看得到每页第一条，复核把对的运行判成没办成）
  // 带了页面快照的批、browser.snapshot、browser.find、browser.clipboard_read 也算（S5：agent 从批的快照里读到电话、评分，复核看不到，判成没办成）
  const extra = options.dataTools
  const isData = (event: EventRow) => event.kind === "tool" && readsData(event, extra)
  const dataEvents = items.slice(cut).filter((item): item is EventRow => !("placeholder" in item) && isData(item))
  const need = (event: EventRow) =>
    event.toolId === "browser.batch"
      ? batchSnapshotText(event.output).length
      : describeToolOutput(event.toolId, event.output, DATA_OUTPUT_MAX + 1).length
  const caps = shareBudget(dataEvents.map(need), DATA_OUTPUT_BUDGET, DATA_OUTPUT_MIN, DATA_OUTPUT_MAX)
  const dataCap = new Map(dataEvents.map((event, index) => [event.seq, caps[index]!]))
  const detailed = (event: EventRow) => {
    if (event.kind !== "tool")
      return `- ${event.kind === "rule" ? "规则" : "人"}：${event.title}${tags(event)}${event.detail ? `（${clip(event.detail, 200)}）` : ""}`
    const cap = dataCap.get(event.seq)
    // 批：逐步的 ✓ / ✗ 照旧，附的页面快照用份额；别的读数据的工具整条结果用份额
    const resultMax = cap !== undefined && event.toolId !== "browser.batch" ? cap : 300
    return `- #${toolNo.get(event.seq)} 调用 ${event.title}（${event.toolId ?? ""}）${tags(event)}：参数 ${describeToolInput(event.toolId, event.input, event.toolId === "browser.batch" ? 2000 : 600, 300)} → 结果 ${describeToolOutput(event.toolId, event.output, resultMax, cap ?? 300) || "（没有输出）"}`
  }
  // 更早的每条压成一行：较早的条数少时每行多给些（读到的电话、提交的内容别被截掉），多时少给，合计按 budget；
  // 读数据的工具结果给两倍（还在 budget 里）
  const perLine = Math.min(900, Math.max(160, Math.floor(options.budget / Math.max(1, cut))))
  const inputMax = Math.min(500, Math.max(120, Math.floor(perLine * 0.55)))
  const outputMax = Math.min(400, Math.max(60, Math.floor(perLine * 0.45)))
  const valueMax = Math.min(120, Math.max(VALUE_MAX, Math.floor(perLine / 8)))
  const compact = (event: EventRow) =>
    event.kind === "tool"
      ? `- #${toolNo.get(event.seq)} ${event.toolId ?? event.title} ${mark(event)}${tags(event)} ${describeToolInput(event.toolId, event.input, event.toolId === "browser.batch" ? Math.max(600, perLine) : inputMax, valueMax)} → ${describeToolOutput(event.toolId, event.output, isDataTool(event.toolId, extra) ? outputMax * 2 : outputMax, outputMax * 2) || "（没有输出）"}`
      : `- ${event.kind === "rule" ? "规则" : "人"}：${event.title}${tags(event)}${event.detail ? `（${oneLine(clip(event.detail, 80))}）` : ""}`

  const line = (each: (event: EventRow) => string) => (item: LogItem) => ("placeholder" in item ? item.placeholder : each(item))
  const earlier = clipBlocks(items.slice(0, cut).map(line(compact)), options.budget)
  const recent = items.slice(cut).map(line(detailed))
  const lines = cut
    ? [`（以下第 1～${cut} 条是较早的记录，每条压成一行）`, ...earlier, `（以下是最近的 ${recent.length} 条，详细）`, ...recent]
    : recent
  return { lines, total: events.length, tools, recent: recent.length, earlier: cut }
}
