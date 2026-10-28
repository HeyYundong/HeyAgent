// 给固化员的材料（docs/dev/solidify.md 5.3、3.3、15.3 第 2 条）：从一次办成的运行里拼出精简的过程。
// - 每次工具调用一段：序号、工具、参数、录下的定位代码、前后网址、成功还是出错、输出开头 300 字；太长时留开头和结尾；
// - 系统按 routineInputOf(源快照) 在参数里找输入出现的位置，标出来：不让模型自己猜哪些字是输入、哪些是页面上固定的；
// - 修的版本（源运行先跑过脚本、停下后 agent 接着办成）再给旧脚本和停在哪、为什么；
// - agent 运行中用 code.run（tools）写的脚本（18.1）：原文完整给（每个最多 2 万字），它做的步骤标「脚本 k 第 n 步」。
// 模型的思考过程不给（只看做了什么）；网页、文件、工具输出里写给 AI 的话一律当数据，提示词里交代（prompt.ts）。
import { and, asc, desc, eq, inArray } from "drizzle-orm"
import {
  checkpointKindLabel,
  routineInputOf,
  routineStopKindLabel,
  type SessionRoutineState,
  type SessionSnapshot,
  type TaskDispatch,
} from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { readFileData } from "../files/service.js"

/** 过程记录最多给多少字（超出时留开头 2/5、结尾 3/5：开头是怎么进的页面，结尾离结果近） */
export const MATERIAL_LOG_BUDGET = 60_000
/** 每次工具调用的输出只给开头这么多字 */
export const OUTPUT_HEAD = 300
const INPUT_MAX = 800
const CODE_MAX = 600

const clip = (value: string | null | undefined, max: number) => (!value ? "" : value.length > max ? `${value.slice(0, max)}…` : value)
const oneLine = (value: string) => value.replace(/\s*\n\s*/g, " ⏎ ")

/** 脚本里怎么取这个输入：input.单号；名字不是合法的标识符就写 input["名字"] */
export function inputAccessor(key: string) {
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(key) ? `input.${key}` : `input[${JSON.stringify(key)}]`
}

/** 输入里可以在参数里找的值：派活参数、附件的 id 和名字、附加说明。值太短（一个字）的只认整个参数相等，免得到处命中 */
export function inputValues(input: Record<string, unknown>): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = []
  for (const [key, value] of Object.entries(input)) {
    if (key === "$attachments" && Array.isArray(value)) {
      value.forEach((file: { id?: unknown; name?: unknown }, index) => {
        if (typeof file.id === "string") out.push({ label: `input.$attachments[${index}].id`, value: file.id })
        if (typeof file.name === "string") out.push({ label: `input.$attachments[${index}].name`, value: file.name })
      })
      continue
    }
    if (typeof value === "string" && value.trim()) out.push({ label: inputAccessor(key), value: value.trim() })
    else if (typeof value === "number" || typeof value === "boolean") out.push({ label: inputAccessor(key), value: String(value) })
  }
  // 长的先找：「上海仓 A」和「A」都是输入时，参数里的「上海仓 A」算前一个
  return out.sort((a, b) => b.value.length - a.value.length)
}

/** 参数（JSON）里每个叶子的路径和值 */
function leaves(value: unknown, path = ""): { path: string; value: string }[] {
  if (value === null || value === undefined) return []
  if (typeof value === "string") return [{ path, value }]
  if (typeof value === "number" || typeof value === "boolean") return [{ path, value: String(value) }]
  if (Array.isArray(value)) return value.flatMap((each, index) => leaves(each, `${path}[${index}]`))
  if (typeof value === "object")
    return Object.entries(value as Record<string, unknown>).flatMap(([key, each]) => leaves(each, path ? `${path}.${key}` : key))
  return []
}

/**
 * 输入出现在这次调用的参数里的哪些位置（3.3）：「text = input.单号」（整个参数就是这个输入）、
 * 「url 里有 input.单号」（参数里包含它）。参数不是 JSON 的不找
 */
export function inputMarks(inputJson: string | null | undefined, values: { label: string; value: string }[]): string[] {
  if (!inputJson || !values.length) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(inputJson)
  } catch {
    return []
  }
  const marks: string[] = []
  for (const leaf of leaves(parsed)) {
    const where = leaf.path || "（参数）"
    const exact = values.find((each) => each.value === leaf.value.trim())
    if (exact) {
      marks.push(`${where} = ${exact.label}`)
      continue
    }
    const inside = values.filter((each) => each.value.length >= 2 && leaf.value.includes(each.value))
    // 同一个叶子里有好几个输入：长的先算，短的被长的盖住就不重复报
    const reported: string[] = []
    for (const each of inside) if (!reported.some((longer) => longer.includes(each.value))) reported.push(each.value)
    for (const value of reported) marks.push(`${where} 里有 ${inside.find((each) => each.value === value)!.label}`)
  }
  return marks
}

/** 一串段落，超出预算时留开头 2/5、结尾 3/5，中间写省略了几条 */
export function clipBlocks(blocks: string[], budget = MATERIAL_LOG_BUDGET): string[] {
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

type EventRow = typeof t.sessionEvents.$inferSelect

/** 过程记录里要给固化员的几种：工具调用、规则拦下、挂起和继续、人做的事、出错 */
const CONTEXT_KINDS = new Set(["rule", "wait", "resume", "human", "error"])
const contextLabel: Record<string, string> = { rule: "规则", wait: "挂起", resume: "继续", human: "人", error: "出错", plan: "过程" }

/** 工具调用的结果是出错（网关落过程记录时标题加「（出错）」） */
export const isToolError = (event: Pick<EventRow, "title">) => event.title.endsWith("（出错）")

// ---------- agent 运行中写的脚本（code.run 带 tools，18.1） ----------

/** 每个 agent 脚本最多给这么多字（不截到 300 字：固化员要照它的循环写） */
export const AGENT_SCRIPT_MAX = 20_000
/** 所有 agent 脚本合计最多这么多字：超出时留后面的（越往后越接近跑通的那一版） */
export const AGENT_SCRIPTS_BUDGET = 40_000

/** agent 用 code.run（tools）写的一个脚本，和它做的步骤（过程里 trace 带 scriptStep 的） */
export interface AgentScript {
  /** 第几个脚本（从 1 开始，按过程的顺序） */
  no: number
  /** 那次 code.run 的过程记录；没有 = 只找到脚本做的步骤（进程中途被杀、记录丢了） */
  event?: EventRow
  /** 脚本原文：code 参数；用 file 跑的由 resolveAgentScripts 补上 */
  code?: string
  /** 用空间里的文件跑的 */
  file?: string
  /** 原文从哪来的、不完整的说明（参数存的时候截断了、取的是运行结束时的文件……） */
  note?: string
  /** 和前面第几个脚本一字不差 */
  sameAs?: number
  steps: EventRow[]
}

/** 截断了的 JSON 里某个字符串字段的开头（code.run 的参数超过 5 万字时存的时候截断了，整个 JSON 解析不了） */
export function jsonStringPrefix(raw: string, key: string): string | undefined {
  const match = new RegExp(`"${key}"\\s*:\\s*"`).exec(raw)
  if (!match) return undefined
  let index = match.index + match[0].length
  let body = ""
  while (index < raw.length) {
    const char = raw[index]!
    // 引号 = 字段完了；JSON 里不会有原样的换行，有就是截断时加的「⏎…（已截断）」
    if (char === '"' || char < " ") break
    if (char === "\\") {
      // 转义被截在半中间：丢掉
      const size = raw[index + 1] === "u" ? 6 : 2
      const escape = raw.slice(index, index + size)
      if (escape.length < size) break
      body += escape
      index += size
      continue
    }
    body += char
    index++
  }
  try {
    return JSON.parse(`"${body}"`) as string
  } catch {
    return undefined
  }
}

interface CodeRunInput {
  tools?: unknown
  code?: unknown
  file?: unknown
}

/** 这次 code.run 的参数：解析得了就是对象；截断了的只取得到 code 的开头和有没有写 tools */
function codeRunInput(event: EventRow): { parsed?: CodeRunInput; codePrefix?: string; toolsFlag: boolean } {
  const raw = event.input ?? ""
  try {
    const parsed = JSON.parse(raw) as CodeRunInput
    return { parsed, toolsFlag: parsed?.tools === true }
  } catch {
    const codePrefix = jsonStringPrefix(raw, "code")
    return { ...(codePrefix !== undefined ? { codePrefix } : {}), toolsFlag: /"tools"\s*:\s*true/.test(raw) }
  }
}

/** 一字不差的：后面的指向前面的，不重复给 */
function markSame(scripts: AgentScript[]) {
  for (const script of scripts) {
    delete script.sameAs
    const same = script.code ? scripts.find((each) => each.no < script.no && each.code === script.code && !each.sameAs) : undefined
    if (same) script.sameAs = same.no
  }
}

/**
 * 从过程里找出 agent 写的脚本：code.run 的参数里 tools = true，或者它前面有还没归属的「脚本做的步骤」。
 * 网关是工具做完才落 code.run 那条记录的，所以脚本做的步骤（trace.scriptStep）都在它前面：
 * 步骤按 scriptCallId 分组，归到后面第一个 code.run（它的 trace 写了 scriptCallId 的按 id 对）。最后剩下没归属的另算一个脚本
 */
export function collectAgentScripts(events: EventRow[]): AgentScript[] {
  const scripts: AgentScript[] = []
  /** 还没归属的步骤：scriptCallId → 步骤（Map 按第一次出现的顺序） */
  const pending = new Map<string, EventRow[]>()
  for (const event of events) {
    if (event.trace?.scriptStep) {
      const id = event.trace.scriptCallId ?? ""
      pending.set(id, [...(pending.get(id) ?? []), event])
      continue
    }
    if (event.kind !== "tool" || event.toolId !== "code.run") continue
    const input = codeRunInput(event)
    // 参数解析得了、没写 tools：普通的 code.run，不是 agent 的工具脚本
    if (input.parsed && !input.toolsFlag) continue
    const own = event.trace?.scriptCallId
    const claimed = own !== undefined ? own : (pending.keys().next().value as string | undefined)
    const steps = claimed !== undefined ? (pending.get(claimed) ?? []) : []
    if (!input.toolsFlag && !steps.length) continue
    if (claimed !== undefined) pending.delete(claimed)
    const code = typeof input.parsed?.code === "string" ? input.parsed.code : input.codePrefix
    const file = typeof input.parsed?.file === "string" ? input.parsed.file : undefined
    scripts.push({
      no: scripts.length + 1,
      event,
      ...(code !== undefined ? { code } : {}),
      ...(file ? { file } : {}),
      ...(input.codePrefix !== undefined ? { note: "参数存的时候截断了，只有开头" } : {}),
      steps,
    })
  }
  for (const steps of pending.values()) scripts.push({ no: scripts.length + 1, note: "找不到那次 code.run 的记录（可能中途被打断），只有它做的步骤", steps })
  markSame(scripts)
  return scripts
}

const normalizePath = (path: string) => path.trim().replace(/^\/?workspace\//, "").replace(/^\.\//, "")

/**
 * 用 file 跑的脚本补上原文：按过程里那次 code.run 之前的 file.save（content）和之后的 file.edit 推出当时的内容；
 * 推不出来（参数截断了、文件是别的办法写的）就读运行结束时空间里的这个文件
 */
export async function resolveAgentScripts(
  scripts: AgentScript[],
  events: EventRow[],
  readStored: (path: string) => Promise<string | undefined>
): Promise<void> {
  for (const script of scripts) {
    if (script.code !== undefined || !script.file || !script.event) continue
    const path = normalizePath(script.file)
    let content: string | undefined
    let broken = false
    for (const event of events) {
      if (event.seq >= script.event.seq) break
      if (event.kind !== "tool" || isToolError(event) || (event.toolId !== "file.save" && event.toolId !== "file.edit")) continue
      let input: { path?: unknown; content?: unknown; edits?: { old?: unknown; new?: unknown }[] }
      try {
        input = JSON.parse(event.input ?? "") as typeof input
      } catch {
        // 参数截断了：是这个文件的话，推出来的就不准了
        if ((event.input ?? "").includes(JSON.stringify(path).slice(1, -1))) broken = true
        continue
      }
      if (typeof input.path !== "string" || normalizePath(input.path) !== path) continue
      if (event.toolId === "file.save") {
        content = typeof input.content === "string" ? input.content : undefined
        broken = content === undefined
        continue
      }
      if (content === undefined) continue
      for (const edit of input.edits ?? []) {
        const from = edit.old
        const to = edit.new
        if (typeof from !== "string" || typeof to !== "string" || !content.includes(from)) {
          broken = true
          break
        }
        content = content.replace(from, () => to)
      }
    }
    if (content !== undefined && !broken) {
      script.code = content
      continue
    }
    const stored = await readStored(path).catch(() => undefined)
    if (stored !== undefined) {
      script.code = stored
      script.note = "过程里推不出当时的内容，这是运行结束时空间里的这个文件（之后可能又改过）"
    } else script.note = "过程里推不出当时的内容，空间里也找不到这个文件"
  }
  markSame(scripts)
}

/** 「agent 运行中写的脚本」一节：原文完整给（每个最多 AGENT_SCRIPT_MAX 字），合计超出预算时留后面的 */
export function agentScriptsSection(scripts: AgentScript[], budget = AGENT_SCRIPTS_BUDGET): string {
  if (!scripts.length) return ""
  const parts: string[] = []
  let used = 0
  for (const script of [...scripts].reverse()) {
    const ran = script.event ? (isToolError(script.event) ? "，code.run 报了出错" : "，code.run 跑完了") : ""
    const head = `### 脚本 ${script.no}${script.file ? `（空间文件 ${script.file}）` : ""}：调了 ${script.steps.filter((step) => step.kind === "tool").length} 次工具${ran}`
    let body: string
    if (script.sameAs) body = `和脚本 ${script.sameAs} 一字不差。`
    else if (script.code === undefined) body = `（没有原文：${script.note ?? "参数里没有 code"}）`
    else {
      const code = script.code.length > AGENT_SCRIPT_MAX ? `${script.code.slice(0, AGENT_SCRIPT_MAX)}\n// ……后面 ${script.code.length - AGENT_SCRIPT_MAX} 字省略` : script.code
      if (used + code.length > budget) body = "（原文省略：agent 的脚本太多太长，只给后面的几个）"
      else {
        used += code.length
        body = [script.note ? `（${script.note}）` : "", "```js", code, "```"].filter(Boolean).join("\n")
      }
    }
    parts.unshift(`${head}\n${body}`)
  }
  return [
    "## agent 运行中写的脚本（code.run 带 tools）",
    "agent 在这次运行里自己写的循环脚本，原文如下；过程里标「脚本 k 第 n 步」的是它做的（每一步照常过规则、记过程）。可以照它的写法写循环，但要换成规矩第 14 条说的写法（ha.commit、ha.verified、waitAny、ha.finish）。",
    ...parts,
  ].join("\n\n")
}

/** 一次工具调用的段落 */
function toolBlock(event: EventRow, n: number, values: { label: string; value: string }[], tag = "") {
  const trace = event.trace ?? undefined
  const lines = [
    `#${n} ${event.toolId ?? event.title} ${isToolError(event) ? "✗ 出错" : "✓"}${tag}${trace?.routineStep ? `（固化脚本做的，第 ${trace.routineStep} 次调用）` : ""}`,
    `  参数：${oneLine(clip(event.input, INPUT_MAX)) || "{}"}`,
  ]
  const marks = inputMarks(event.input, values)
  if (marks.length) lines.push(`  输入在这里：${marks.join("；")}`)
  if (trace?.code) lines.push(`  录下的代码：${oneLine(clip(trace.code, CODE_MAX))}`)
  if (trace?.urlBefore || trace?.urlAfter) {
    const moved = trace.urlBefore && trace.urlAfter && trace.urlBefore !== trace.urlAfter
    lines.push(`  网址：${moved ? `${trace.urlBefore} → ${trace.urlAfter}` : (trace.urlAfter ?? trace.urlBefore)}${trace.title ? `「${trace.title}」` : ""}`)
  }
  if (event.output) lines.push(`  输出开头：${oneLine(clip(event.output, OUTPUT_HEAD))}`)
  return lines.join("\n")
}

/** agent 脚本那次 code.run 的段落：参数里不带原文（原文在「agent 运行中写的脚本」一节），输出给开头和结尾（结尾是工具汇总） */
function agentScriptBlock(script: AgentScript, n: number) {
  const event = script.event
  const head = event ? `code.run ${isToolError(event) ? "✗ 出错" : "✓"}` : "code.run（找不到记录）"
  const lines = [`#${n} ${head}：agent 运行中写的循环脚本（脚本 ${script.no}，原文见「agent 运行中写的脚本」），下面标「脚本 ${script.no} 第 n 步」的是它做的`]
  if (event) {
    const { parsed } = codeRunInput(event)
    if (parsed && typeof parsed === "object") {
      const rest = Object.fromEntries(Object.entries(parsed).filter(([key]) => key !== "code" && key !== "stdin"))
      lines.push(`  参数（不含原文）：${oneLine(clip(JSON.stringify(rest), INPUT_MAX))}`)
    }
    const output = event.output ?? ""
    if (output.length > OUTPUT_HEAD * 2) lines.push(`  输出开头：${oneLine(clip(output, OUTPUT_HEAD))}`, `  输出结尾：…${oneLine(output.slice(-OUTPUT_HEAD))}`)
    else if (output) lines.push(`  输出：${oneLine(output)}`)
  }
  return lines.join("\n")
}

/** 别的几种（规则、挂起、人……、脚本里的判断）一行 */
const contextLine = (event: EventRow, tag = "") =>
  `- ${tag || contextLabel[event.kind] || event.kind}：${event.title}${event.detail ? `（${oneLine(clip(event.detail, 300))}）` : ""}`

/** 过程压成一段段：工具调用带序号；别的几种一行；agent 的脚本放在它那次 code.run 的位置，后面跟它做的步骤 */
export function compactLog(events: EventRow[], values: { label: string; value: string }[], scripts: AgentScript[] = collectAgentScripts(events)): string[] {
  const blocks: string[] = []
  // 脚本放在哪：有 code.run 记录的放在那一条，没有的放在它第一步的位置
  const at = new Map<number, AgentScript>()
  for (const script of scripts) {
    const where = script.event ?? script.steps[0]
    if (where) at.set(where.seq, script)
  }
  let n = 0
  for (const event of events) {
    const script = at.get(event.seq)
    if (script) {
      blocks.push(agentScriptBlock(script, ++n))
      for (const step of script.steps) {
        const tag = `脚本 ${script.no} 第 ${step.trace?.scriptStep} 步`
        if (step.kind === "tool") blocks.push(toolBlock(step, ++n, values, `（${tag}）`))
        else blocks.push(contextLine(step, tag))
      }
      if (script.event) continue
    }
    if (event.trace?.scriptStep) continue
    if (event.kind === "tool") {
      blocks.push(toolBlock(event, ++n, values))
      continue
    }
    // 固化脚本里的判断（「流程判断：……」）也给：看得出那一步是怎么选的
    if (CONTEXT_KINDS.has(event.kind) || event.trace?.routineStep || event.title.startsWith("流程判断")) blocks.push(contextLine(event))
  }
  return blocks
}

/** work.report 交的结果：这次运行里每次成功的调用按顺序合并（同名字段以后一次为准，和派活单上的一样） */
export function reportedData(events: Pick<EventRow, "kind" | "toolId" | "title" | "input">[]): Record<string, string | number | boolean> | undefined {
  let merged: Record<string, string | number | boolean> | undefined
  for (const event of events) {
    if (event.kind !== "tool" || event.toolId !== "work.report" || isToolError(event) || !event.input) continue
    try {
      const data = (JSON.parse(event.input) as { data?: Record<string, string | number | boolean> }).data
      if (data && typeof data === "object") merged = { ...(merged ?? {}), ...data }
    } catch {
      // 参数存的时候截断了：这次的不算
    }
  }
  return merged
}

/** run.finish 报的结果（最后一次成功的） */
function finishOf(events: EventRow[]): { outcome?: string; summary?: string; evidence?: string } | undefined {
  for (const event of [...events].reverse()) {
    if (event.kind !== "tool" || event.toolId !== "run.finish" || isToolError(event) || !event.input) continue
    try {
      return JSON.parse(event.input) as { outcome?: string; summary?: string; evidence?: string }
    } catch {
      return { summary: clip(event.input, 1000) }
    }
  }
  return undefined
}

export interface CompileMaterial {
  /** 给固化员的那条消息（不含这一轮的反馈） */
  text: string
  /** 脚本的输入（routineInputOf(源快照)）：试跑用它，程序检查拿它对 inputSchema */
  input: Record<string, unknown>
  /** 源运行能读的附件：试跑也给它读 */
  attachments: SessionSnapshot["attachments"]
  /** 任务的工具（源快照里的 id） */
  toolIds: string[]
  /** 被派的任务：声明的参数和要交回的结果 */
  dispatch?: { params: TaskDispatch["params"]; results: TaskDispatch["results"] }
  /** 源运行用 work.report 交的结果：试跑读到的要和它一项一项对 */
  report?: Record<string, string | number | boolean>
}

/** 修的版本才有：改的是哪一版、那一版的脚本 */
export interface MaterialBase {
  version: number
  code: string
  description: string
}

/**
 * 拼材料：任务（目标、步骤、检查点、派活的参数和结果）、这次运行（输入、精简的过程、run.finish、work.report、存下的文件、检查点）、
 * 修的版本再给旧脚本和停下的原因、以前被人「不用」的理由
 */
export async function buildMaterial(
  db: Db,
  input: { sourceSessionId: string; routineId: string; base?: MaterialBase }
): Promise<CompileMaterial> {
  const [session] = await db.select().from(t.sessions).where(eq(t.sessions.id, input.sourceSessionId))
  if (!session?.snapshot) throw new Error(`找不到原来那次运行 ${input.sourceSessionId}（或者它没有快照）`)
  const snapshot = session.snapshot
  const [task] = await db.select({ dispatch: t.tasks.dispatch }).from(t.tasks).where(eq(t.tasks.id, session.taskId))
  const [events, checkpoints, files, rejected] = await Promise.all([
    db.select().from(t.sessionEvents).where(eq(t.sessionEvents.sessionId, session.id)).orderBy(asc(t.sessionEvents.seq)),
    db.select().from(t.checkpoints).where(eq(t.checkpoints.sessionId, session.id)).orderBy(asc(t.checkpoints.position)),
    db
      .select({ id: t.files.id, name: t.files.name, mime: t.files.mime, path: t.files.path, size: t.files.size })
      .from(t.files)
      .where(eq(t.files.sessionId, session.id))
      .orderBy(asc(t.files.createdAt)),
    db
      .select({ version: t.routineVersions.version, reason: t.routineVersions.rejectReason })
      .from(t.routineVersions)
      .where(eq(t.routineVersions.routineId, input.routineId))
      .orderBy(desc(t.routineVersions.version)),
  ])
  const records = checkpoints.length
    ? await db
        .select()
        .from(t.checkpointRecords)
        .where(inArray(t.checkpointRecords.checkpointId, checkpoints.map((cp) => cp.id)))
        .orderBy(asc(t.checkpointRecords.at), asc(t.checkpointRecords.id))
    : []

  const scriptInput = routineInputOf(snapshot)
  const values = inputValues(scriptInput)
  const declared = task?.dispatch ?? undefined
  const dispatch = declared
    ? { params: declared.params, results: declared.results ?? snapshot.dispatch?.results ?? [] }
    : snapshot.dispatch?.results
      ? { params: Object.keys(snapshot.dispatch.params).map((name) => ({ name, description: "", required: true, dedupe: false })), results: snapshot.dispatch.results }
      : undefined
  const report = reportedData(events)
  const finish = finishOf(events)
  const scripts = collectAgentScripts(events)
  await resolveAgentScripts(scripts, events, async (path) => {
    const [row] = await db.select().from(t.files).where(and(eq(t.files.sessionId, session.id), eq(t.files.path, path))).limit(1)
    return row ? (await readFileData(row)).toString("utf8") : undefined
  })

  const parts: string[] = []
  const steps = snapshot.task.steps
  parts.push(
    [
      `## 任务 ${snapshot.task.id}：${snapshot.task.title}`,
      `目标：${snapshot.task.goal}`,
      steps.length ? `任务步骤：\n${steps.map((step, index) => `${index + 1}. ${step.text}`).join("\n")}` : "",
      snapshot.checkpoints.length
        ? `检查点：\n${snapshot.checkpoints.map((cp, index) => `${index + 1}. ${cp.title}（${checkpointKindLabel[cp.kind]}${cp.target ? `，目标 ${cp.target}` : ""}）`).join("\n")}`
        : "",
    ]
      .filter(Boolean)
      .join("\n")
  )
  if (dispatch)
    parts.push(
      [
        "## 这是一个被派的任务",
        `声明的参数（脚本的输入 = 这些参数，都是字符串）：\n${dispatch.params.map((param) => `- ${param.name}${param.required ? "（必填）" : "（可选）"}${param.description ? `：${param.description}` : ""}`).join("\n") || "（没有参数）"}`,
        `要交回的结果（用 ha.work.report 交，outputSchema = 这些字段）：\n${dispatch.results.map((result) => `- ${result.name}${result.required ? "（必交）" : "（可选）"}${result.description ? `：${result.description}` : ""}`).join("\n") || "（没有声明）"}`,
      ].join("\n")
    )
  const tools = snapshot.tools.map((tool) => `- ${tool.id}：${tool.name}（风险 ${tool.risk}）${tool.summary ? ` ${clip(tool.summary, 120)}` : ""}`)
  parts.push(`## 任务里的工具（脚本只能用这些）\n${tools.join("\n")}`)
  if (snapshot.browser)
    parts.push(
      `## 浏览器\n能用的 Chrome 配置：${snapshot.browser.profiles.map((profile) => `${profile.id}（${profile.name}）`).join("、") || "（没有）"}\n网址白名单：${snapshot.browser.allowedDomains.join("、") || "（不限）"}`
    )

  parts.push(
    [
      `## 这次运行（${session.id}，办成了）的输入`,
      "脚本里用 input（= ha.input）读，内容如下：",
      "```json",
      JSON.stringify(scriptInput, null, 2),
      "```",
    ].join("\n")
  )
  if (scripts.length) parts.push(agentScriptsSection(scripts))
  parts.push(
    `## 这次运行的过程（按时间顺序；「输入在这里」是系统标出来的，脚本里这些位置要用输入，不要写死）\n${clipBlocks(compactLog(events, values, scripts)).join("\n") || "（没有记录）"}`
  )
  const result: string[] = []
  if (finish) result.push(`run.finish：${finish.outcome ?? ""} ${clip(finish.summary, 1000)}${finish.evidence ? `\n依据：${clip(finish.evidence, 1000)}` : ""}`)
  if (report) result.push(`work.report 交的结果：${JSON.stringify(report)}`)
  if (checkpoints.length)
    result.push(
      `检查点：\n${checkpoints
        .map((cp, index) => {
          const own = records.filter((record) => record.checkpointId === cp.id).map((record) => `   - ${clip(record.text, 200)}`)
          return [`${index + 1}. ${cp.title}：${cp.status === "done" ? "完成" : cp.status === "skipped" ? "跳过" : "没完成"}`, ...own].join("\n")
        })
        .join("\n")}`
    )
  const saved = files.filter((file) => file.path)
  if (saved.length) result.push(`存下的文件：${saved.map((file) => `${file.path}（${file.mime}）`).join("、")}`)
  if (result.length) parts.push(`## 这次运行的结果\n${result.join("\n")}`)

  if (input.base) {
    const ran: SessionRoutineState | null = session.routine
    const stop = ran?.stoppedAt
    parts.push(
      [
        `## 要修的旧版本（第 ${input.base.version} 版）`,
        ran
          ? `这次运行先跑了第 ${ran.version} 版脚本，做了 ${ran.steps} 次调用${stop ? `，停在第 ${stop.step} 次调用（${routineStopKindLabel[stop.kind]}${stop.tool ? `，${stop.tool}` : ""}${stop.label ? `「${stop.label}」` : ""}）：${clip(stop.reason, 800)}` : ""}。之后 agent 接着办成了：上面过程里没有「固化脚本做的」标记的就是 agent 做的。`
          : "",
        ran?.commits.length ? `脚本走过的提交：${ran.commits.map((commit) => `第 ${commit.step} 次调用前「${commit.label}」${commit.verified ? `（核对过：${commit.verified}）` : ""}`).join("；")}` : "",
        "旧版的步骤说明：",
        input.base.description || "（没有）",
        "旧版的脚本：",
        "```js",
        input.base.code,
        "```",
        "照 agent 接手后的做法改：网站改了的地方换定位或步骤，没改的部分尽量保持原样。",
      ]
        .filter(Boolean)
        .join("\n")
    )
  }
  const reasons = rejected.filter((row) => row.reason).slice(0, 3)
  if (reasons.length)
    parts.push(`## 以前的版本被负责人「不用」的理由（这次要避开）\n${reasons.map((row) => `- 第 ${row.version} 版：${clip(row.reason, 500)}`).join("\n")}`)

  return {
    text: parts.join("\n\n"),
    input: scriptInput,
    attachments: snapshot.attachments,
    toolIds: snapshot.tools.map((tool) => tool.id),
    ...(dispatch ? { dispatch: { params: dispatch.params, results: dispatch.results } } : {}),
    ...(report ? { report } : {}),
  }
}
