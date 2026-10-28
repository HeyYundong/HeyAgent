// 发布进流程库前的分析（docs/dev/routine-library.md 4.2、4.3、4.4、5.8、2.3）。
// - 要的工具（requires）：用 checks.ts 的 analyzeScript（同一套 AST 分析），ha.browser.* → "browser"，ha.tool("x") → "x"（组里的工具算组），
//   ha.file.*、ha.finish、ha.work.report、ha.checkpoint.mark 不算（读附件、存文件跟着自动带上的规矩走；后三个在库流程里只收进交回值）；
//   ha.browser.fetch → browser.fetch 开关；按坐标的工具（ha.tool("browser.mouse_click_xy") 这类、copyImage 写 x / y）→ vision 开关；
//   ha.routine("短名") → routines（第一个参数要是字面量，不是就算程序检查没过）。调的库流程要的工具一并算进来（传递，按它们登记的 requires）。
//   每个任务都自带的工具（alwaysOn）不放进 toolIds：任务里本来就不存它们。
// - 风险：没有 ha.commit、用到的非浏览器工具都是只读、调的库流程也都是只读 → read；否则取最高的：浏览器 external，
//   HTTP / MCP / 别的按 tools 表里的，调的库流程按它登记的。
// - 环和层数：按登记的 requires.routines 画图（这一个换成新版的），有环不让发；它自己、调它的流程最深超过 MAX_LIBRARY_DEPTH 不让发。
// - 不兼容改动：shared 的 compareRoutineSchemas + routineRequiresAdded（和现在发布的那一版比）。
// - 给模型的说明（4.2）：routineToolDescription，存 tools.description。
import {
  LIBRARY_DESCRIPTION_STEPS,
  MAX_LIBRARY_DEPTH,
  compareRoutineSchemas,
  mergeRoutineRequires,
  riskSchema,
  routineObjectSchema,
  routineRequiresAdded,
  routineRequiresSchema,
  toolSchemaOf,
  withDeclaredDescriptions,
  type Risk,
  type RoutineCompatIssue,
  type RoutineRequires,
} from "@heyagent/shared"
import { and, eq, inArray } from "drizzle-orm"

import type { DbOrTx } from "../../data/config/common.js"
import * as t from "../../db/schema.js"
import { analyzeScript, GROUP_TOOLS } from "../checks.js"

/** 一段脚本自己用到的（不算传递）：analyzeLibraryCode 的结果 */
export interface LibraryCodeAnalysis {
  /** 直接用到的工具 id（"browser" 是组；不含 routine.*） */
  toolIds: string[]
  browser: RoutineRequires["browser"]
  /** ha.routine 直接调的短名 */
  routines: string[]
  /** 有没有 ha.commit（没有、工具又都是只读的 = 只读） */
  usesCommit: boolean
  /** 分析不了的写法（ha.routine 的短名不是字面量……） */
  problems: string[]
}

/** 不算「要的工具」的：库流程里 ha.finish / ha.work.report 只收进交回值，ha.checkpoint.mark 不做，ha.file.* 跟着自动带上的规矩走 */
const NOT_REQUIRED = new Set(["run.finish", "work.report", "checkpoint.mark"])
const notRequired = (toolId: string) => NOT_REQUIRED.has(toolId) || toolId.startsWith("file.")

/** 工具 id 在任务里要选的是哪一个：组里的（browser.click、desktop.xxx）算组 */
function requiredToolId(toolId: string): string {
  const group = toolId.split(".")[0]!
  return GROUP_TOOLS.includes(group) ? group : toolId
}

/** 只看这一段脚本（纯函数，用 checks.ts 的 analyzeScript） */
export function analyzeLibraryCode(code: string): LibraryCodeAnalysis {
  const analysis = analyzeScript(code)
  const toolIds: string[] = []
  const routines: string[] = []
  const problems: string[] = []
  let fetch = false
  for (const item of analysis.items) {
    if ("problem" in item) problems.push(item.problem)
    else if ("routine" in item) {
      if (!routines.includes(item.routine)) routines.push(item.routine)
    } else {
      if (item.fetch || item.tool === "browser.fetch") fetch = true
      if (notRequired(item.tool)) continue
      const id = requiredToolId(item.tool)
      if (!toolIds.includes(id)) toolIds.push(id)
    }
  }
  return {
    toolIds,
    browser: { ...(fetch ? { fetch: true } : {}), ...(analysis.vision ? { vision: true } : {}) },
    routines,
    usesCommit: analysis.usesCommit,
    problems: [...new Set(problems)],
  }
}

const riskRank = (risk: Risk) => riskSchema.options.indexOf(risk)

/** 风险等级（4.3）：tools 是用到的非浏览器工具的风险，routines 是调的库流程登记的风险 */
export function libraryRisk(input: { usesCommit: boolean; usesBrowser: boolean; tools: Risk[]; routines: Risk[] }): Risk {
  const others = [...input.tools, ...input.routines]
  if (!input.usesCommit && others.every((risk) => risk === "read")) return "read"
  const all: Risk[] = [...(input.usesBrowser ? (["external"] as const) : []), ...others]
  return all.reduce<Risk>((max, risk) => (riskRank(risk) > riskRank(max) ? risk : max), "read")
}

/** 从 start 出发按 edges（短名 → 它调的短名）走，有环返回环上的短名（按顺序，首尾是同一个），没有返回 undefined */
export function findLibraryCycle(edges: ReadonlyMap<string, readonly string[]>, start: string): string[] | undefined {
  const path: string[] = []
  const onPath = new Set<string>()
  const done = new Set<string>()
  const visit = (node: string): string[] | undefined => {
    if (onPath.has(node)) return [...path.slice(path.indexOf(node)), node]
    if (done.has(node)) return undefined
    path.push(node)
    onPath.add(node)
    for (const next of edges.get(node) ?? []) {
      const cycle = visit(next)
      if (cycle) return cycle
    }
    path.pop()
    onPath.delete(node)
    done.add(node)
    return undefined
  }
  return visit(start)
}

/** 从 start 出发最深几层（start 自己算 1；有环时绕到走过的就不再往下） */
export function libraryDepthOf(edges: ReadonlyMap<string, readonly string[]>, start: string): number {
  const depth = (node: string, seen: ReadonlySet<string>): number => {
    const next = (edges.get(node) ?? []).filter((each) => !seen.has(each))
    if (!next.length) return 1
    const deeper = new Set([...seen, node])
    return 1 + Math.max(...next.map((each) => depth(each, deeper)))
  }
  return depth(start, new Set([start]))
}

/** 从 from 出发走得到 target 吗（from 自己不算） */
function reaches(edges: ReadonlyMap<string, readonly string[]>, from: string, target: string): boolean {
  const seen = new Set<string>()
  const stack = [...(edges.get(from) ?? [])]
  while (stack.length) {
    const node = stack.pop()!
    if (node === target) return true
    if (seen.has(node)) continue
    seen.add(node)
    stack.push(...(edges.get(node) ?? []))
  }
  return false
}

/** 库里的登记（画图、算传递用） */
async function libraryEntries(db: DbOrTx) {
  return db
    .select({
      routineId: t.routineLibrary.routineId,
      slug: t.routineLibrary.slug,
      title: t.routineLibrary.title,
      status: t.routineLibrary.status,
      requires: t.routineLibrary.requires,
      risk: t.routineLibrary.risk,
    })
    .from(t.routineLibrary)
}

/** 某个固化流程的某一版发布进库的话：要的工具（含传递）、风险、程序检查没过的地方 */
export async function analyzeForPublish(
  db: DbOrTx,
  input: { routineId: string; version: number; slug: string }
): Promise<{ requires: RoutineRequires; risk: Risk; commits: string[]; problems: string[] }> {
  const [row] = await db
    .select({ code: t.routineVersions.code, commits: t.routineVersions.commits, provenAt: t.routineVersions.provenAt })
    .from(t.routineVersions)
    .where(and(eq(t.routineVersions.routineId, input.routineId), eq(t.routineVersions.version, input.version)))
  if (!row) return { requires: { toolIds: [], browser: {}, routines: [] }, risk: "read", commits: [], problems: [`固化流程 ${input.routineId} 没有第 ${input.version} 版`] }
  const problems: string[] = []
  if (!row.provenAt) problems.push(`第 ${input.version} 版还没在来源任务上转正式（试用期连着 3 次脚本直接办成才转正式），不能发布`)
  const code = analyzeLibraryCode(row.code)
  problems.push(...code.problems.map((each) => `脚本：${each}`))

  // 用到的工具：每个任务都自带的不放进 requires；不存在的报出来
  const ids = code.toolIds
  const toolRows = ids.length
    ? await db.select({ id: t.tools.id, name: t.tools.name, risk: t.tools.risk, alwaysOn: t.tools.alwaysOn }).from(t.tools).where(inArray(t.tools.id, ids))
    : []
  const toolIds: string[] = []
  const toolRisks: Risk[] = []
  for (const id of ids) {
    const tool = toolRows.find((each) => each.id === id)
    if (!tool) {
      problems.push(`脚本要用的工具 ${id} 已经没有了`)
      continue
    }
    if (id !== "browser") toolRisks.push(tool.risk)
    if (!tool.alwaysOn) toolIds.push(id)
  }

  // 调的库流程：要在库里；要的工具、开关算进来（传递）
  const entries = await libraryEntries(db)
  let requires: RoutineRequires = { toolIds, browser: code.browser, routines: code.routines }
  const routineRisks: Risk[] = []
  for (const slug of code.routines) {
    const entry = entries.find((each) => each.slug === slug)
    if (!entry || entry.status === "withdrawn") {
      problems.push(`脚本调的库流程「${slug}」不在流程库里${entry ? "（撤下了）" : ""}`)
      continue
    }
    if (entry.routineId === input.routineId) continue
    routineRisks.push(entry.risk)
    const nested = routineRequiresSchema.safeParse(entry.requires)
    if (nested.success) requires = mergeRoutineRequires(requires, { ...nested.data, routines: [] })
  }

  // 环和层数：这一个的边换成新版调的
  const edges = new Map<string, string[]>()
  for (const entry of entries) {
    if (entry.routineId === input.routineId) continue
    const parsed = routineRequiresSchema.safeParse(entry.requires)
    edges.set(entry.slug, parsed.success ? parsed.data.routines : [])
  }
  edges.set(input.slug, code.routines)
  const cycle = findLibraryCycle(edges, input.slug)
  if (cycle) problems.push(`调用绕成了圈：${cycle.join(" → ")}（库流程不能互相调）`)
  else {
    const depth = libraryDepthOf(edges, input.slug)
    if (depth > MAX_LIBRARY_DEPTH) problems.push(`调了 ${depth} 层库流程（最多 ${MAX_LIBRARY_DEPTH} 层：库流程里还能调一层，再往下不行）`)
    for (const entry of entries) {
      if (entry.status === "withdrawn" || entry.slug === input.slug || !reaches(edges, entry.slug, input.slug)) continue
      const callerDepth = libraryDepthOf(edges, entry.slug)
      if (callerDepth > MAX_LIBRARY_DEPTH) problems.push(`库流程「${entry.title}」（${entry.slug}）调它，发布以后那边要 ${callerDepth} 层（最多 ${MAX_LIBRARY_DEPTH} 层）`)
    }
  }

  const risk = libraryRisk({ usesCommit: code.usesCommit, usesBrowser: ids.includes("browser"), tools: toolRisks, routines: routineRisks })
  return { requires, risk, commits: row.commits, problems: [...new Set(problems)] }
}

/** 和现在发布的版本比的不兼容改动（第一次发布是空的）：compareRoutineSchemas + routineRequiresAdded */
export async function compatWithPublished(db: DbOrTx, input: { routineId: string; version: number; requires: RoutineRequires }): Promise<RoutineCompatIssue[]> {
  const [entry] = await db
    .select({ publishedVersion: t.routineLibrary.publishedVersion, requires: t.routineLibrary.requires })
    .from(t.routineLibrary)
    .where(eq(t.routineLibrary.routineId, input.routineId))
  if (!entry) return []
  const rows = await db
    .select({ version: t.routineVersions.version, inputSchema: t.routineVersions.inputSchema, outputSchema: t.routineVersions.outputSchema })
    .from(t.routineVersions)
    .where(and(eq(t.routineVersions.routineId, input.routineId), inArray(t.routineVersions.version, [entry.publishedVersion, input.version])))
  const before = rows.find((row) => row.version === entry.publishedVersion)
  const after = rows.find((row) => row.version === input.version)
  const issues = before && after ? compareRoutineSchemas(before, after) : []
  const published = routineRequiresSchema.safeParse(entry.requires)
  return [...issues, ...routineRequiresAdded(published.success ? published.data : { toolIds: [], browser: {}, routines: [] }, input.requires)]
}

type Declared = readonly { name: string; description?: string | null }[]

/**
 * 这一版的输入、交回 schema 补上来源任务（被派的）声明的参数、结果的说明（4.2）：固化员写的 schema 常常只有 type，
 * 给别的任务看的工具说明、工具参数、流程页的输入 / 交回表都用补过的。来源任务不是被派的原样返回
 */
export function withSourceDeclared<V extends { inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> }>(
  version: V,
  dispatch: { params: Declared; results?: Declared } | null | undefined
): V {
  if (!dispatch) return version
  const inputSchema = withDeclaredDescriptions(version.inputSchema, dispatch.params)
  const outputSchema = withDeclaredDescriptions(version.outputSchema, dispatch.results ?? [])
  return inputSchema === version.inputSchema && outputSchema === version.outputSchema ? version : { ...version, inputSchema, outputSchema }
}

/** 来源任务的标题和派活配置（按固化流程 id 查） */
export async function routineSource(db: DbOrTx, routineId: string) {
  const [row] = await db
    .select({ title: t.tasks.title, dispatch: t.tasks.dispatch })
    .from(t.routines)
    .innerJoin(t.tasks, eq(t.tasks.id, t.routines.taskId))
    .where(eq(t.routines.id, routineId))
  return row
}

/** 报结果的说法：交回、报办成 / 没办成、ha.work.report、ha.finish（只对来源任务有意义，别的任务里只是收进交回值） */
const REPORTING = /work[_.]?report|\bfinish\b|交回|报(?:告)?(?:办成|没办成|结果)/

/**
 * 「做什么」的步骤（4.2）：步骤说明一行一步，去掉交回、报结果的那几行（一行里只有一半是的，去掉那一半），
 * 「派活的『X』」写成「输入的『X』」（选用它的任务没有派活），重新编号
 */
export function libraryDescriptionSteps(description: string): string[] {
  const kept: string[] = []
  for (const raw of description.split("\n")) {
    const line = raw.trim()
    if (!line) continue
    const numbered = /^(\d+)[.、)）]\s*/.exec(line)
    const body = numbered ? line.slice(numbered[0].length) : line
    // 按逗号、分号拆开，开头的「并、再、然后」去掉
    const parts = body
      .split(/[，,；;]/)
      .map((part) => part.trim().replace(/^(?:并且|并|再|然后)\s*/, ""))
      .filter(Boolean)
    const rest = parts.filter((part) => !REPORTING.test(part))
    if (!rest.length) continue
    const text = (rest.length === parts.length ? body : rest.join("，")).replace(/派活(?:单)?(?:里|中|给)?的「/g, "输入的「")
    kept.push(numbered ? `${kept.length + 1}. ${text}` : text)
  }
  return kept
}

const describe = (property: Record<string, unknown>) => (typeof property.description === "string" ? property.description.trim() : "")

/**
 * 给模型的说明（4.2 的模板）：固化好的流程（几秒做完）、什么时候用、做什么（libraryDescriptionSteps，最多 LIBRARY_DESCRIPTION_STEPS 行）、
 * 要的输入（按 toolSchemaOf 转过的参数名）、交回、会真的提交（commits，没有写「只读，不改东西」）、用的是你这次运行的浏览器、跑不通怎么办
 */
export function routineToolDescription(input: {
  summary: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema: Record<string, unknown>
  commits: string[]
  usesBrowser: boolean
}): string {
  const steps = libraryDescriptionSteps(input.description)
  const shown = steps.slice(0, LIBRARY_DESCRIPTION_STEPS)
  if (steps.length > shown.length) shown.push(`……还有 ${steps.length - shown.length} 步`)

  const { jsonSchema, params } = toolSchemaOf(input.inputSchema)
  const properties = jsonSchema.properties as Record<string, Record<string, unknown>>
  const inputs = params.map((param) => {
    const own = routineObjectSchema(input.inputSchema).properties[param.name] ?? {}
    const name = param.key === param.name ? param.key : `${param.key}（${param.name}）`
    // $attachments、$note 用转过的说明（文件 id 的数组、一句话）；别的用 inputSchema 里写的
    const text = param.name.startsWith("$") ? describe(properties[param.key] ?? {}) : describe(own)
    return `- ${name}${text ? `：${text}` : ""}${param.required ? "（必填）" : ""}`
  })
  const output = routineObjectSchema(input.outputSchema)
  const outputs = output.names.map((name) => {
    const property = output.properties[name] ?? {}
    return `- ${name}${describe(property) ? `：${describe(property)}` : ""}`
  })

  return [
    "固化好的流程（几秒做完，不用你一步步操作）。",
    `什么时候用：${input.summary.trim()}`,
    `做什么：\n${shown.join("\n") || "（没写步骤说明）"}`,
    `要的输入：${inputs.length ? `\n${inputs.join("\n")}` : "不用输入，调一次就把这段固定操作做一遍"}`,
    `交回：${outputs.length ? `\n${outputs.join("\n")}` : "结果说明（办成没办成、依据）"}`,
    `会真的提交：${input.commits.length ? input.commits.join("；") : "只读，不改东西"}`,
    ...(input.usesBrowser ? ["用的是你这次运行的浏览器：先不用登录、不用打开页面，流程自己会去。跑完停在最后一页。"] : []),
    "跑不通会告诉你做过哪几步、停在哪一页，你从那里接着做，前面做过的不要重复。",
  ].join("\n")
}
