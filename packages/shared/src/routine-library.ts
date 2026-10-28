// 流程库（docs/dev/routine-library.md）：在来源任务上转过正式的固化流程，主管发布进库，变成一个工具 routine.<短名>，
// 别的任务选用后 agent 当工具调（一次工具调用跑完整段脚本），脚本里 ha.routine("短名", 输入) 调。
// 这里是前后端共用的约定：登记、要的工具、快照里冻住的那一版、交回值、调用记录、工具桥协议、接口的输入输出，
// 以及几个纯函数（工具参数怎么从 inputSchema 转、模型给的参数怎么转回脚本的输入、两版之间的不兼容改动）。
// 登记状态（routineLibraryStatusSchema）和过程记录的 trace.library 在 routine.ts。
import { z } from "zod"

import {
  routineLibraryStatusSchema,
  routineStopKindSchema,
  routineStopSchema,
  type RoutineStopKind,
} from "./routine.js"
import { riskSchema } from "./schemas.js"

const isoTime = z.string()
const jsonSchemaObject = z.record(z.string(), z.unknown())
const person = z.object({ id: z.string(), name: z.string() })

// ---------- 上限 ----------

/** 最多几层：调用方 → 库流程 A → 库流程 B，B 里不能再调（5.8） */
export const MAX_LIBRARY_DEPTH = 2
/** 连续几次跑不通自动停用（6.6） */
export const LIBRARY_PAUSE_AFTER_FAILS = 3
/** 详情页的成绩看最近几次调用（6.5） */
export const LIBRARY_STATS_WINDOW = 50
/** 详情页列最近几次停下的 */
export const LIBRARY_RECENT_STOPS = 5
/** 给模型的说明里「做什么」最多几行（4.2） */
export const LIBRARY_DESCRIPTION_STEPS = 15
/** 调用记录一页几条（routineLibrary.calls） */
export const LIBRARY_CALLS_PAGE = 50

// ---------- 工具 id、短名 ----------

/** 库流程在 tools 表里的 id：routine.<短名>（给模型的名字由网关的 safeName 换成 routine_<短名>） */
export const ROUTINE_TOOL_PREFIX = "routine."

/** 短名：英文小写字母开头，小写字母、数字、下划线，2～40 个字。发布后不能改：它就是工具 id，任务、规则、脚本都按它引用 */
export const routineSlugSchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_]{1,39}$/, "短名只能用英文小写字母、数字、下划线，字母开头，2～40 个字（例如 order_status）")

export const routineToolId = (slug: string) => `${ROUTINE_TOOL_PREFIX}${slug}`
export const isRoutineToolId = (toolId: string) => toolId.startsWith(ROUTINE_TOOL_PREFIX)
/** routine.<短名> → 短名；不是库流程的工具 id 返回 undefined */
export function routineSlugOfToolId(toolId: string): string | undefined {
  if (!isRoutineToolId(toolId)) return undefined
  const slug = toolId.slice(ROUTINE_TOOL_PREFIX.length)
  return routineSlugSchema.safeParse(slug).success ? slug : undefined
}

/** 发布弹窗里短名的默认值：名字里的英文、数字转成小写加下划线；转不出来（中文名）用 rt<n>（RT-12 → rt12） */
export function defaultRoutineSlug(name: string, routineId: string): string {
  const fromName = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "")
  if (routineSlugSchema.safeParse(fromName).success) return fromName
  const number = /(\d+)$/.exec(routineId)?.[1]
  return number ? `rt${number}` : "rt"
}

/** 库流程的代码在沙箱代码目录里的位置（相对代码目录；调用方自己的脚本是 routine.mjs） */
export const libraryModulePath = (slug: string) => `routines/${slug}.mjs`

// ---------- 要的工具（4.4） ----------

/**
 * 发布时用 checks.ts 的分析算出来，存进登记（routine_library.requires）和发布记录。任务弹窗自动勾工具、开始运行时判断用不用得了都看它。
 * toolIds：任务里要选的工具 id（ha.browser.* → 组 id "browser"；ha.tool("x") → "x"；ha.file.* 不算）。
 * 已经把调的库流程要的一并算进来（传递）；不含 routine.* 本身（调的库流程不用调用方任务选，跟着冻进快照）
 */
export const routineRequiresSchema = z.object({
  toolIds: z.array(z.string()),
  /** 浏览器的开关：fetch = 要「允许直接调网站接口」（用了 ha.browser.fetch）；vision = 要「允许看画面」（按坐标的工具、copyImage 写坐标） */
  browser: z.object({ fetch: z.boolean().optional(), vision: z.boolean().optional() }),
  /** 脚本里 ha.routine 直接调的库流程（短名） */
  routines: z.array(z.string()),
})
export type RoutineRequires = z.infer<typeof routineRequiresSchema>

export const emptyRoutineRequires = (): RoutineRequires => ({ toolIds: [], browser: {}, routines: [] })

const union = (a: readonly string[], b: readonly string[]) => [...new Set([...a, ...b])]

/** 合并两份（算传递的时候用）：工具、调的流程取并集，开关有一个要就要 */
export function mergeRoutineRequires(a: RoutineRequires, b: RoutineRequires): RoutineRequires {
  const fetch = Boolean(a.browser.fetch || b.browser.fetch)
  const vision = Boolean(a.browser.vision || b.browser.vision)
  return {
    toolIds: union(a.toolIds, b.toolIds),
    browser: { ...(fetch ? { fetch } : {}), ...(vision ? { vision } : {}) },
    routines: union(a.routines, b.routines),
  }
}

/** 用它的任务缺什么（任务弹窗的提示、开始运行时的 unavailable）：没选的工具、没打开的开关 */
export function missingRoutineRequires(
  requires: RoutineRequires,
  task: { toolIds: readonly string[]; allowBrowserFetch: boolean; allowBrowserVision: boolean }
): { toolIds: string[]; browser: ("fetch" | "vision")[] } {
  const chosen = new Set(task.toolIds)
  const browser: ("fetch" | "vision")[] = []
  if (requires.browser.fetch && !task.allowBrowserFetch) browser.push("fetch")
  if (requires.browser.vision && !task.allowBrowserVision) browser.push("vision")
  return { toolIds: requires.toolIds.filter((id) => !chosen.has(id)), browser }
}

/** 开关的中文（「流程『查订单状态』要：浏览器（已帮你选上）；还要打开『允许直接调网站接口』」） */
export const routineBrowserFlagLabel: Record<"fetch" | "vision", string> = {
  fetch: "允许直接调网站接口",
  vision: "允许看画面",
}

// ---------- 工具参数（第 3 节） ----------

/** 给模型的工具参数里，脚本输入的 $attachments、$note 换成的名字 */
export const ROUTINE_ATTACHMENTS_PARAM = "attachments"
export const ROUTINE_NOTE_PARAM = "note"

/**
 * 给模型的参数名能直接用的写法（同 HTTP 工具的 httpParamKeys）：几家模型的工具参数名只认英文、数字、下划线。
 * 别的（中文、带 $ 的）换成 p1、p2……（按 inputSchema 里的顺序），说明里写原来的名字
 */
const MODEL_PARAM_NAME = /^[A-Za-z0-9_]{1,64}$/

/** 一个工具参数：key = 给模型的参数名；name = inputSchema 里的名字（$attachments、$note、单号……） */
export interface RoutineToolParam {
  key: string
  name: string
  required: boolean
}

/** 整理过的对象 schema：空串、{}、有 properties 没写 type 都当成对象（同固化的程序检查） */
export interface RoutineObjectSchema {
  properties: Record<string, Record<string, unknown>>
  required: string[]
}

/** inputSchema / outputSchema 整理成对象的样子（属性不是对象的当成没写类型） */
export function routineObjectSchema(schema: unknown): RoutineObjectSchema {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { properties: {}, required: [] }
  const record = schema as Record<string, unknown>
  const raw = record.properties && typeof record.properties === "object" && !Array.isArray(record.properties) ? (record.properties as Record<string, unknown>) : {}
  const properties: Record<string, Record<string, unknown>> = {}
  for (const [name, value] of Object.entries(raw))
    properties[name] = value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
  const required = Array.isArray(record.required) ? record.required.filter((name): name is string => typeof name === "string" && name in properties) : []
  return { properties, required: [...new Set(required)] }
}

const ATTACHMENTS_DESCRIPTION = "要交给流程的文件：这次运行能读的文件 id（附件、产物）的数组"
const NOTE_DESCRIPTION = "给流程的一句附加说明"

/**
 * 库流程给模型的工具参数（JSON Schema），由这一版的 inputSchema 转（第 3 节）：
 * - 普通参数原样（类型、说明、必填）；名字不是英文、数字、下划线的换成 p<n>，说明前面写「参数名：单号」；
 * - $attachments → attachments：文件 id 的字符串数组（执行前按调用方能读的文件展开，见 inputOfToolArgs）；
 * - $note → note：一句话；
 * - 必填照 inputSchema；没声明输入的流程是空对象（「把这段固定操作做一遍」）。
 * params 记着给模型的名字和 inputSchema 里的名字怎么对应，inputOfToolArgs 按它转回去
 */
export function toolSchemaOf(inputSchema: unknown): { jsonSchema: Record<string, unknown>; params: RoutineToolParam[] } {
  const { properties, required } = routineObjectSchema(inputSchema)
  const names = Object.keys(properties)
  // 先占住能原样用的名字，换名的再挑没被占的
  const taken = new Set(names.filter((name) => MODEL_PARAM_NAME.test(name)))
  const pick = (base: string) => {
    let key = base
    for (let k = 2; taken.has(key); k++) key = `${base}_${k}`
    taken.add(key)
    return key
  }
  const params: RoutineToolParam[] = []
  const out: Record<string, Record<string, unknown>> = {}
  names.forEach((name, index) => {
    const source = properties[name]!
    const description = typeof source.description === "string" ? source.description.trim() : ""
    const isRequired = required.includes(name)
    let key: string
    let property: Record<string, unknown>
    if (name === "$attachments") {
      key = pick(ROUTINE_ATTACHMENTS_PARAM)
      property = { type: "array", items: { type: "string" }, description: [ATTACHMENTS_DESCRIPTION, description].filter(Boolean).join("。") }
    } else if (name === "$note") {
      key = pick(ROUTINE_NOTE_PARAM)
      property = { type: "string", description: [NOTE_DESCRIPTION, description].filter(Boolean).join("。") }
    } else if (MODEL_PARAM_NAME.test(name)) {
      key = name
      property = { ...source }
    } else {
      key = pick(`p${index + 1}`)
      property = { ...source, description: [`参数名：${name}`, description].filter(Boolean).join("。") }
    }
    delete property.$schema
    out[key] = property
    params.push({ key, name, required: isRequired })
  })
  return {
    jsonSchema: {
      type: "object",
      properties: out,
      required: params.filter((param) => param.required).map((param) => param.key),
      additionalProperties: false,
    },
    params,
  }
}

/** 调用方这次运行能读的一个文件（快照的附件、空间里的产物） */
export interface RoutineCallerFile {
  id: string
  name: string
  mime: string
}

/**
 * 模型给的工具参数 → 脚本的输入（ha.input）：参数名换回 inputSchema 里的名字；attachments 的文件 id 按调用方能读的文件
 * 展开成 { id, name, mime }（也认 { id } 对象）；没给、给了 null 的不放。不在 params 里的参数丢掉（网关已经按 JSON Schema 拦过）。
 * 文件 id 不是调用方能读的 → 出错（流程不起沙箱）。之后还要按 inputSchema 校验一次（服务器的 schemaProblems）
 */
export function inputOfToolArgs(
  args: Record<string, unknown>,
  params: readonly RoutineToolParam[],
  files: readonly RoutineCallerFile[]
): { ok: true; input: Record<string, unknown> } | { ok: false; error: string } {
  const input: Record<string, unknown> = {}
  for (const param of params) {
    const value = args[param.key]
    if (value === undefined || value === null) continue
    if (param.name !== "$attachments") {
      input[param.name] = value
      continue
    }
    const list = Array.isArray(value) ? value : [value]
    const expanded: RoutineCallerFile[] = []
    for (const each of list) {
      const id = typeof each === "string" ? each.trim() : each && typeof each === "object" && typeof (each as { id?: unknown }).id === "string" ? (each as { id: string }).id.trim() : ""
      if (!id) return { ok: false, error: `${param.key} 要写文件 id 的数组` }
      const file = files.find((candidate) => candidate.id === id)
      if (!file) return { ok: false, error: `文件 ${id} 不是这次运行能读的文件（只能给附件、这次运行的产物）` }
      expanded.push({ id: file.id, name: file.name, mime: file.mime })
    }
    input[param.name] = expanded
  }
  return { ok: true, input }
}

// ---------- 两版之间的不兼容改动（2.3） ----------

export const routineCompatKindSchema = z.enum([
  /** 新加了必填的参数 */
  "input_added_required",
  /** 原来可选的参数变成必填 */
  "input_now_required",
  /** 去掉了参数 */
  "input_removed",
  /** 参数类型变了（原来能传的现在不行了） */
  "input_type_changed",
  /** 旧版交回的字段新版没有 */
  "output_removed",
  /** 交回字段的类型变了 */
  "output_type_changed",
  /** 要的工具、开关多了（哪些任务因此用不了，由服务器按任务算，写在 preview 的 affected 里） */
  "requires_added",
])
export type RoutineCompatKind = z.infer<typeof routineCompatKindSchema>

export const routineCompatIssueSchema = z.object({
  kind: routineCompatKindSchema,
  /** 参数 / 交回字段的名字（inputSchema、outputSchema 里的）；requires_added 是工具 id、开关、短名 */
  field: z.string(),
  /** 给人看的一句话 */
  text: z.string(),
})
export type RoutineCompatIssue = z.infer<typeof routineCompatIssueSchema>

/** 属性声明的类型（没写 = undefined，表示什么都行） */
function typesOf(property: Record<string, unknown> | undefined): string[] | undefined {
  const type = property?.type
  if (typeof type === "string") return [type]
  if (Array.isArray(type)) {
    const list = type.filter((each): each is string => typeof each === "string")
    return list.length ? list : undefined
  }
  return undefined
}

/** to 能接受 from 的每一种值吗（integer 算 number 的一种；to 没写类型 = 什么都接受） */
function accepts(to: string[] | undefined, from: string[] | undefined): boolean {
  if (!to) return true
  if (!from) return false
  return from.every((type) => to.includes(type) || (type === "integer" && to.includes("number")))
}

const typeText = (types: string[] | undefined) => (types ? types.join(" | ") : "不限")

/**
 * 比两版的输入、交回格式（纯函数，前后端共用）：发布新版本、回到以前的版本前列出来，有的话要勾「我知道这些任务会受影响」。
 * 输入：新加必填、可选变必填、去掉、类型收紧算不兼容（加可选的参数、放宽类型不算）；
 * 交回：去掉字段、类型变了算不兼容（多交回字段不算）
 */
export function compareRoutineSchemas(
  before: { inputSchema: unknown; outputSchema: unknown },
  after: { inputSchema: unknown; outputSchema: unknown }
): RoutineCompatIssue[] {
  const issues: RoutineCompatIssue[] = []
  const oldIn = routineObjectSchema(before.inputSchema)
  const newIn = routineObjectSchema(after.inputSchema)
  for (const [name, property] of Object.entries(newIn.properties)) {
    const old = oldIn.properties[name]
    const required = newIn.required.includes(name)
    if (!old) {
      if (required) issues.push({ kind: "input_added_required", field: name, text: `新加了必填的参数「${name}」` })
      continue
    }
    if (required && !oldIn.required.includes(name)) issues.push({ kind: "input_now_required", field: name, text: `参数「${name}」原来可以不填，现在必填` })
    const [from, to] = [typesOf(old), typesOf(property)]
    if (!accepts(to, from)) issues.push({ kind: "input_type_changed", field: name, text: `参数「${name}」的类型从 ${typeText(from)} 改成了 ${typeText(to)}` })
  }
  for (const name of Object.keys(oldIn.properties))
    if (!(name in newIn.properties)) issues.push({ kind: "input_removed", field: name, text: `去掉了参数「${name}」` })
  const oldOut = routineObjectSchema(before.outputSchema)
  const newOut = routineObjectSchema(after.outputSchema)
  for (const [name, old] of Object.entries(oldOut.properties)) {
    const property = newOut.properties[name]
    if (!property) {
      issues.push({ kind: "output_removed", field: name, text: `不再交回「${name}」` })
      continue
    }
    const [from, to] = [typesOf(old), typesOf(property)]
    if (!accepts(from, to)) issues.push({ kind: "output_type_changed", field: name, text: `交回的「${name}」类型从 ${typeText(from)} 改成了 ${typeText(to)}` })
  }
  return issues
}

/** 新版比旧版多要了什么（工具、开关、调的库流程）：「要的工具多了」，哪些任务因此用不了由服务器按任务算 */
export function routineRequiresAdded(before: RoutineRequires, after: RoutineRequires): RoutineCompatIssue[] {
  const issues: RoutineCompatIssue[] = []
  for (const id of after.toolIds) if (!before.toolIds.includes(id)) issues.push({ kind: "requires_added", field: id, text: `多要了工具 ${id}` })
  for (const flag of ["fetch", "vision"] as const)
    if (after.browser[flag] && !before.browser[flag]) issues.push({ kind: "requires_added", field: flag, text: `要打开「${routineBrowserFlagLabel[flag]}」` })
  for (const slug of after.routines) if (!before.routines.includes(slug)) issues.push({ kind: "requires_added", field: slug, text: `多调了库流程 ${routineToolId(slug)}` })
  return issues
}

// ---------- 交回值（第 3 节） ----------

/** work.report 收来的数据 */
const reportData = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]))

/**
 * 库流程报了结果（ha.finish）时的交回值：agent 在工具结果的文字和 data 里看到，脚本里 ha.routine 的返回值。
 * not_achieved（例如查不到）不算出错
 */
export const routineReturnSchema = z.object({
  /** 短名 */
  routine: z.string(),
  /** 库里的名字 */
  name: z.string(),
  version: z.number().int(),
  outcome: z.enum(["achieved", "not_achieved"]),
  summary: z.string(),
  evidence: z.string().optional(),
  reason: z.string().optional(),
  /** 库流程里 ha.work.report({ data }) 收来的（不写调用方的结果） */
  data: reportData,
})
export type RoutineReturn = z.infer<typeof routineReturnSchema>

/** agent 调的库流程跑不通（5.5）：工具结果出错，文字是交接的话，data 给界面和固化材料用 */
export const routineToolStopDataSchema = z.object({
  routine: z.string(),
  name: z.string(),
  version: z.number().int(),
  /** 这次调用里做了几步 */
  steps: z.number().int().min(0),
  stoppedAt: routineStopSchema,
  /** 库流程里走过的 ha.commit（同 sessions.routine.commits） */
  commits: z.array(z.object({ step: z.number().int().min(0), label: z.string(), verified: z.string().optional() })),
})
export type RoutineToolStopData = z.infer<typeof routineToolStopDataSchema>

// ---------- 快照（6.2） ----------

/**
 * 开始运行时冻进 snapshot.libraryRoutines：任务选了的库流程取发布的那一版，连同它们调的库流程（传递）。
 * 运行中途发布新版不影响这次。这次用不了的也冻进来，带 unavailable（网关不给工具，系统提示写一行原因）
 */
export const libraryRoutineSnapshotSchema = z.object({
  routineId: z.string(),
  slug: z.string(),
  /** routine.<短名> */
  toolId: z.string(),
  /** 库里的名字 */
  name: z.string(),
  /** 「什么时候用」 */
  summary: z.string(),
  /** 发布的那一版 */
  version: z.number().int(),
  versionId: z.string(),
  /** 步骤说明，一步一行 */
  description: z.string(),
  code: z.string(),
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
  commits: z.array(z.string()),
  requires: routineRequiresSchema,
  risk: riskSchema,
  /** true = 任务选了它（网关给工具，脚本也能调）；false = 只因为被选了的库流程调，跟着冻进来（只在 ha.routine 里用） */
  selected: z.boolean(),
  /** 这次用不了的原因（停用、撤下、缺工具「任务没选『浏览器』」、缺开关、它调的流程用不了）；用得了没有这一项 */
  unavailable: z.string().optional(),
})
export type LibraryRoutineSnapshot = z.infer<typeof libraryRoutineSnapshotSchema>

// ---------- 调用记录（6.5，routine_calls） ----------

/** 怎么调的：tool = agent 调（工具 routine.<短名>）；script = 脚本里 ha.routine */
export const routineCallViaSchema = z.enum(["tool", "script"])
export type RoutineCallVia = z.infer<typeof routineCallViaSchema>
export const routineCallViaLabel: Record<RoutineCallVia, string> = { tool: "agent 调", script: "脚本调" }

/** 结局：报了结果（办成 / 没办成）、输入不对（参数不合 inputSchema、ha.fail("input")）、停下了（stop_kind 写原因） */
export const routineCallResultSchema = z.enum(["achieved", "not_achieved", "bad_input", "stopped"])
export type RoutineCallResult = z.infer<typeof routineCallResultSchema>
export const routineCallResultLabel: Record<RoutineCallResult, string> = {
  achieved: "办成",
  not_achieved: "没办成",
  bad_input: "输入不对",
  stopped: "停下",
}

/** 算「跑不通」的停下原因（6.6）：多半是页面变了或脚本的毛病。被拦下、要审批、挂起、取消、输入不对不算（是调用方的配置、输入） */
export const LIBRARY_FAIL_STOP_KINDS: readonly RoutineStopKind[] = ["step_error", "page", "script_error", "timeout", "limit"]

/** 一次调用对 fail_streak 的影响：fail +1；reset 清零（报了结果，办成没办成都算）；keep 不动 */
export function libraryStreakChange(result: RoutineCallResult, stopKind?: RoutineStopKind | null): "fail" | "reset" | "keep" {
  if (result === "achieved" || result === "not_achieved") return "reset"
  if (result === "stopped" && stopKind && LIBRARY_FAIL_STOP_KINDS.includes(stopKind)) return "fail"
  return "keep"
}

export const routineCallSchema = z.object({
  id: z.number().int(),
  routineId: z.string(),
  version: z.number().int(),
  /** 调用方的运行、任务 */
  sessionId: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  /** agent 调 = 模型的工具调用 id；脚本调 = 进入那一步的调用 id（同 trace.library.callId） */
  callId: z.string(),
  via: routineCallViaSchema,
  depth: z.number().int().positive(),
  result: routineCallResultSchema,
  /** 停下 / 输入不对时：原因、停在库流程的第几步、说明 */
  stopKind: routineStopKindSchema.nullable(),
  stopStep: z.number().int().nullable(),
  stopReason: z.string().nullable(),
  /** 库流程里做了几步、用了多久 */
  steps: z.number().int().min(0),
  ms: z.number().int().min(0),
  at: isoTime,
})
export type RoutineCall = z.infer<typeof routineCallSchema>

// ---------- 工具桥协议（5.6；SDK sandbox-sdk/heyagent/index.js ↔ routine/runtime/bridge.ts） ----------

/**
 * 嵌套的路径：SDK 在库流程的上下文里发的每个请求都带 via（从外到里的短名，例如 ["login_view", "order_status"]），
 * 工具桥按它记 trace.library、查层数和环。调用方自己的脚本发的没有 via（或空数组）。
 * agent 调库流程（工具桥 mode = tool）时，最外层就是那个库流程，顶层请求的 via 也是空的，由工具桥补上
 */
export const bridgeViaSchema = z.array(z.string()).max(MAX_LIBRARY_DEPTH)

/**
 * 进入：SDK 发 { op: "tool", tool: "routine.<短名>", input, via }，工具桥过规则、按 inputSchema 校验、记一步和重放日志后回 ok，
 * data 是这个。SDK 再载入代码目录里的 module，在嵌套的上下文里调它的 run(input)
 */
export const libraryEnterReplySchema = z.object({
  slug: z.string(),
  name: z.string(),
  version: z.number().int(),
  /** 相对代码目录：routines/<短名>.mjs（libraryModulePath） */
  module: z.string(),
  /** 这次是第几层（1 = 调用方脚本直接调的） */
  depth: z.number().int().positive(),
  /** 校验过的输入（attachments 已经是 { id, name, mime }） */
  input: z.record(z.string(), z.unknown()),
})
export type LibraryEnterReply = z.infer<typeof libraryEnterReplySchema>

/**
 * 出来：SDK 发 { op: "routine_end", …这个 }。工具桥记一条过程「流程『…』跑完：7 步 · 交回 …」、写调用记录，也记进重放日志（标记）。
 * end：finished = 报了结果（result）；failed = ha.fail（kind）；error = 抛了没接住的错（error、name）或没报结果就返回了
 */
export const routineEndRequestSchema = z.object({
  slug: z.string(),
  depth: z.number().int().positive(),
  end: z.enum(["finished", "failed", "error"]),
  /** 库流程里做了几步（SDK 数的这一层的工具调用；工具桥以自己数的为准） */
  steps: z.number().int().min(0),
  result: routineReturnSchema.optional(),
  kind: z.enum(["input", "page"]).optional(),
  error: z.string().optional(),
  /** 抛出来的错的名字：StepError / Denied / RoutineStop / 别的 */
  name: z.string().optional(),
  via: bridgeViaSchema.optional(),
})
export type RoutineEndRequest = z.infer<typeof routineEndRequestSchema>

// ---------- 接口的输出（tRPC routineLibrary.*，10.3） ----------

/** 列表的一项（左边） */
export const routineLibraryItemSchema = z.object({
  routineId: z.string(),
  slug: z.string(),
  toolId: z.string(),
  title: z.string(),
  status: routineLibraryStatusSchema,
  publishedVersion: z.number().int(),
  /** 选用它的任务有几个 */
  taskCount: z.number().int().min(0),
  /** 来源任务上有转过正式、比发布的新的版本：最新的那个版本号；没有 = null */
  newerVersion: z.number().int().nullable(),
  failStreak: z.number().int().min(0),
})
export type RoutineLibraryItem = z.infer<typeof routineLibraryItemSchema>

/** 发布的那一版（不带脚本；看脚本用 routine.version） */
const publishedVersionSchema = z.object({
  versionId: z.string(),
  version: z.number().int(),
  name: z.string(),
  description: z.string(),
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
  commits: z.array(z.string()),
  provenAt: isoTime.nullable(),
})

/** 详情（右边） */
export const routineLibraryDetailSchema = z.object({
  routineId: z.string(),
  slug: z.string(),
  toolId: z.string(),
  title: z.string(),
  /** 「什么时候用」 */
  summary: z.string(),
  status: routineLibraryStatusSchema,
  publishedVersion: z.number().int(),
  requires: routineRequiresSchema,
  risk: riskSchema,
  failStreak: z.number().int().min(0),
  pausedReason: z.string().nullable(),
  publishedBy: person.nullable(),
  publishedAt: isoTime,
  createdAt: isoTime,
  /** 来源任务 */
  source: z.object({ taskId: z.string(), title: z.string(), ownerId: z.string() }),
  version: publishedVersionSchema,
  /** 转过正式、比发布的新的版本号（新的在前）：Alert「来源任务上第 4 版已转正式」 */
  newerVersions: z.array(z.number().int()),
  /** 发布记录（新的在前）：版本记录弹窗 */
  publishes: z.array(
    z.object({
      version: z.number().int(),
      publishedBy: person.nullable(),
      publishedAt: isoTime,
      /** 当时在用几个任务 */
      taskCount: z.number().int().min(0),
      compat: z.array(routineCompatIssueSchema),
    })
  ),
  /** 谁在用：选了它的任务（最近一次调用）、调它的库流程 */
  usedBy: z.object({
    tasks: z.array(
      z.object({
        taskId: z.string(),
        title: z.string(),
        lastCall: z.object({ at: isoTime, result: routineCallResultSchema }).nullable(),
      })
    ),
    routines: z.array(z.object({ routineId: z.string(), slug: z.string(), title: z.string() })),
  }),
  /** 最近 LIBRARY_STATS_WINDOW 次调用的成绩 */
  stats: z.object({
    calls: z.number().int(),
    achieved: z.number().int(),
    notAchieved: z.number().int(),
    badInput: z.number().int(),
    stopped: z.number().int(),
    /** 报了结果的平均用时；没有 = null */
    avgMs: z.number().nullable(),
    byTask: z.array(
      z.object({
        taskId: z.string(),
        title: z.string(),
        calls: z.number().int(),
        achieved: z.number().int(),
        notAchieved: z.number().int(),
        stopped: z.number().int(),
        avgMs: z.number().nullable(),
      })
    ),
    /** 最近 LIBRARY_RECENT_STOPS 次停下的 */
    recentStops: z.array(routineCallSchema),
  }),
})
export type RoutineLibraryDetail = z.infer<typeof routineLibraryDetailSchema>

/** 能发布的（发布弹窗第一步：只列有转过正式版本的任务） */
export const routineLibraryCandidateSchema = z.object({
  taskId: z.string(),
  taskTitle: z.string(),
  routineId: z.string(),
  /** 启用版本的名字（发布弹窗「名字」的默认值） */
  name: z.string(),
  /** 已经在库里的：登记（撤下的也算，短名不能改） */
  library: z.object({ slug: z.string(), status: routineLibraryStatusSchema, publishedVersion: z.number().int() }).nullable(),
  /** 转过正式的版本（新的在前） */
  versions: z.array(z.object({ version: z.number().int(), name: z.string(), provenAt: isoTime })),
})
export type RoutineLibraryCandidate = z.infer<typeof routineLibraryCandidateSchema>

/** 发布前看一眼（发布弹窗下面只读的那些） */
export const routineLibraryPreviewSchema = z.object({
  routineId: z.string(),
  version: z.number().int(),
  requires: routineRequiresSchema,
  risk: riskSchema,
  /** 会改东西的步骤（这一版的 commits） */
  commits: z.array(z.string()),
  /** 生成的给模型的说明（4.2，发布后存 tools.description） */
  toolDescription: z.string(),
  /** 程序检查没过的（没转正式、有环、层数超了、短名格式不对或重了、调的库流程不在库里）：有就不能发，按钮置灰 */
  problems: z.array(z.string()),
  /** 和现在发布的版本比的不兼容改动（第一次发布是空的） */
  compat: z.array(routineCompatIssueSchema),
  /** 受影响的：选了它的任务（缺什么：按新版的 requires 算）、脚本里调它的固化流程和库流程 */
  affected: z.object({
    tasks: z.array(z.object({ taskId: z.string(), title: z.string(), missing: z.array(z.string()) })),
    routines: z.array(z.object({ routineId: z.string(), taskId: z.string(), title: z.string(), version: z.number().int() })),
  }),
})
export type RoutineLibraryPreview = z.infer<typeof routineLibraryPreviewSchema>

export const routineCallsPageSchema = z.object({
  items: z.array(routineCallSchema),
  /** 下一页从哪儿接（调用记录的 id）；没有了 = null */
  nextCursor: z.number().int().nullable(),
})
export type RoutineCallsPage = z.infer<typeof routineCallsPageSchema>

// ---------- 接口的输入 ----------

const routineIdInput = z.string().min(1)
const titleInput = z.string().trim().min(1, "写一个名字").max(60, "名字最多 60 个字")
const summaryInput = z.string().trim().min(1, "写一句什么时候用").max(500, "最多 500 个字")

export const routineLibraryGetInputSchema = z.object({ routineId: routineIdInput })
/** 发布前看一眼。slug：第一次发布时弹窗里正在填的短名（查格式、和别的撞没撞；不认格式的写进 problems，不报错） */
export const routineLibraryPreviewInputSchema = z.object({ routineId: routineIdInput, version: z.number().int().positive(), slug: z.string().optional() })
/**
 * 发布（第一次）、发布新版本、回到以前的版本，都是它。第一次发布要 slug（之后传了也不认，不能改）；
 * 和现在发布的版本比有不兼容改动时要 acceptBreaking
 */
export const routineLibraryPublishInputSchema = z.object({
  routineId: routineIdInput,
  version: z.number().int().positive(),
  slug: routineSlugSchema.optional(),
  title: titleInput,
  summary: summaryInput,
  acceptBreaking: z.boolean().optional(),
})
export type RoutineLibraryPublishInput = z.infer<typeof routineLibraryPublishInputSchema>
/** 改名字和「什么时候用」（重写 tools 那一行，下一次运行生效） */
export const routineLibraryUpdateInputSchema = z.object({ routineId: routineIdInput, title: titleInput, summary: summaryInput })
/** 停用 / 重新启用（重新启用清零 fail_streak） */
export const routineLibraryPauseInputSchema = z.object({ routineId: routineIdInput, paused: z.boolean() })
/** 撤下：有任务选用或别的库流程调它时 CONFLICT */
export const routineLibraryWithdrawInputSchema = z.object({ routineId: routineIdInput })
export const routineLibraryCallsInputSchema = z.object({
  routineId: routineIdInput,
  /** 上一页最后一条的 id（从新到旧翻） */
  cursor: z.number().int().positive().optional(),
  /** 只看某个调用方任务的 */
  taskId: z.string().min(1).optional(),
})
