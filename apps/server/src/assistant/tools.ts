// 右下角助手能用的工具（docs/dev/copilot.md 第 3 节、9.3 节）。
// - 查的（read）：模型调用后直接执行，结果交回模型；
// - 改的（write）：不执行。prepare 先校验输入、按 can() 查权限、读出改前的值，拼成确认卡上的一项；人点「应用」后 apply 才调 data/config 里现成的函数。
// 全部以当前登录的人的身份（WriteCtx.actor）调用，权限、事务、审计都由 data/config 负责，这里不绕过。
// 模型看到的名字用 snake_case，label 是 Trace 上显示的中文。
import {
  can,
  hasPlainSecret,
  httpParamsOf,
  httpToolInputSchema,
  idInput,
  mcpServerInputSchema,
  memoryInputSchema,
  moveSecrets,
  reviewInputSchema,
  ruleInputSchema,
  secretNameSchema,
  skillInputSchema,
  skillSetStatusSchema,
  syncHttpParams,
  taskInputSchema,
  taskMemoryAddSchema,
  taskMemoryDeleteSchema,
  taskMemoryUpdateSchema,
  taskSetEnabledSchema,
  templatePlaceholders,
  todoInputSchema,
  type Action,
  type ActionResources,
  type AssistantLink,
  type HttpParam,
  type RuleCompileResult,
  type TaskDef,
} from "@heyagent/shared"
import { TRPCError } from "@trpc/server"
import { and, count, desc, eq } from "drizzle-orm"
import { z } from "zod"

import * as load from "../data/loaders.js"
import { assertCan, findSecret, type WriteCtx } from "../data/config/common.js"
import { listDesktops } from "../data/config/desktops.js"
import * as memories from "../data/config/memories.js"
import { confirmRuleInTx, insertRule, updateRule, deleteRule } from "../data/config/rules.js"
import * as skills from "../data/config/skills.js"
import * as taskMemory from "../data/config/task-memory.js"
import { createTask, defaultReviewModelId, deleteTask, setTaskEnabled, tasksUsingRef, updateTask, usedByText, type TaskInput } from "../data/config/tasks.js"
import * as todos from "../data/config/todos.js"
import * as toolsConfig from "../data/config/tools.js"
import { attachableFiles, attachFilesToTask, ATTACH_FORBIDDEN } from "../data/config/task-files.js"
import * as t from "../db/schema.js"
import { compileRuleText } from "../engine/rule-compile.js"
import { isImageMime, listSessionFiles } from "../files/service.js"
import { viewableImage } from "./images.js"
import { isTextFile, READ_FILE_LIMIT, readFilePart, type TextLoader } from "./texts.js"
import { clip, changedFields, DIFF_MAX, Names, riskText, scheduleText, skillStatusText, stepsText, stepText, triggerText, yesNo, type FieldChange } from "./describe.js"

/** 工具执行的上下文：谁在做（当前登录的人）、库、主密钥 */
/** texts：这次请求读文件的缓存（read_file 接着读同一个 PDF 时不再解析），run.ts 给 */
export type ToolCtx = WriteCtx & { texts?: TextLoader }

/** 给模型看的错误（没有权限、找不到、字段不对）：原样作为 tool-result 交回模型 */
export class ToolError extends Error {}

export const errorText = (error: unknown) => {
  if (error instanceof ToolError || error instanceof TRPCError) return error.message
  return (error as Error)?.message || String(error)
}

/** 出卡前查权限：没有权限的不进卡，告诉模型「你没有权限：……」 */
function need<A extends Action>(ctx: ToolCtx, action: A, resource: ActionResources[A], message: string) {
  if (!can(ctx.actor, action, resource)) throw new ToolError(`你没有权限：${message}`)
}

/** 卡上一项 */
export interface Prepared {
  title: string
  fields: FieldChange[]
  /** 出卡时算好、应用时照用的（规则的翻译结果） */
  prepared?: unknown
  /** 出卡时花的钱（翻译规则），算进这次请求 */
  costUsd?: number
}

export interface Applied {
  /** 给人看，例如「已建好 T-12」 */
  message: string
  link?: AssistantLink
  /** 交回模型的结果（新建出来的编号等） */
  output?: Record<string, unknown>
}

interface ReadDef {
  kind: "read"
  description: string
  input: z.ZodType
  label: (input: Record<string, unknown>) => string
  run: (ctx: ToolCtx, input: never) => Promise<unknown>
}

interface WriteDef {
  kind: "write"
  description: string
  input: z.ZodType
  label: (input: Record<string, unknown>) => string
  /** 删除、归档、拒绝：卡上「应用」按钮变 destructive */
  destructive?: boolean
  prepare: (ctx: ToolCtx, input: never, given: Set<string>) => Promise<Prepared>
  apply: (ctx: ToolCtx, input: never, given: Set<string>, prepared: unknown) => Promise<Applied>
}

export type ToolDef = ReadDef | WriteDef

// 用这两个函数定义工具，输入的类型从 schema 推出来
const read = <S extends z.ZodType>(def: { description: string; input: S; label: (input: Partial<z.output<S>>) => string; run: (ctx: ToolCtx, input: z.output<S>) => Promise<unknown> }): ReadDef => ({
  kind: "read",
  ...def,
  label: def.label as ReadDef["label"],
  run: def.run as ReadDef["run"],
})

const write = <S extends z.ZodType>(def: {
  description: string
  input: S
  label: (input: Partial<z.output<S>>) => string
  destructive?: boolean
  prepare: (ctx: ToolCtx, input: z.output<S>, given: Set<string>) => Promise<Prepared>
  apply: (ctx: ToolCtx, input: z.output<S>, given: Set<string>, prepared: unknown) => Promise<Applied>
}): WriteDef => ({
  kind: "write",
  ...def,
  label: def.label as WriteDef["label"],
  prepare: def.prepare as WriteDef["prepare"],
  apply: def.apply as WriteDef["apply"],
})

const str = (value: unknown) => (typeof value === "string" || typeof value === "number" ? String(value) : "")
const contains = (query: string | undefined, ...values: (string | undefined | null)[]) => !query || values.some((value) => value?.toLowerCase().includes(query.toLowerCase()))
/** list_run_files 最多列几个 */
const RUN_FILES_MAX = 100
const queryInput = z.object({ query: z.string().max(100).optional().describe("可选：按文字筛选（编号、名字、内容里包含它的）") })

// ---------- 读出现在的样子（修改时合并、卡上显示改前） ----------

async function loadTask(ctx: ToolCtx, id: string): Promise<TaskDef> {
  const [task] = await load.listTasks(ctx.db, [id])
  if (!task) throw new ToolError(`找不到任务 ${id}，先用 list_tasks 查编号`)
  return task
}

/** 任务现在的样子 → 完整的 TaskInput（update_task 只给要改的字段，应用时合并成完整的再调 updateTask） */
const taskInputOf = (task: TaskDef): TaskInput => ({
  title: task.title,
  goal: task.goal,
  steps: task.steps.map((step) => ({ id: step.id, text: step.text, wait: step.wait, ...(step.checkpoint ? { checkpoint: step.checkpoint } : {}) })),
  modelId: task.modelId,
  ownerId: task.ownerId,
  schedule: task.schedule ? { cron: task.schedule.cron, text: task.schedule.text } : null,
  enabled: task.enabled,
  memoryIds: task.memoryIds,
  skillIds: task.skillIds,
  toolIds: task.toolIds,
  ruleIds: task.ruleIds,
  browserProfileIds: task.browserProfileIds,
  allowedDomains: task.allowedDomains,
  allowBrowserEvaluate: task.allowBrowserEvaluate,
  allowBrowserVision: task.allowBrowserVision,
  desktopIds: task.desktopIds,
  allowDesktopVision: task.allowDesktopVision,
  verifyModelId: task.verifyModelId,
  // 2026-10-20 以前建的任务可能没选复核模型：先空着，withReviewModel 补默认的
  reviewModelId: task.reviewModelId ?? "",
  dispatch: task.dispatch ? { ...task.dispatch, results: task.dispatch.results ?? [] } : null,
  dispatchFrom: task.dispatchFrom ?? [],
  cronSkipIfRunning: task.cronSkipIfRunning ?? true,
  autoSolidify: task.autoSolidify ?? null,
  routineSkipTest: task.routineSkipTest ?? false,
})

async function loadTodoRow(ctx: ToolCtx, id: string) {
  const [row] = await ctx.db.select().from(t.humanTodos).where(eq(t.humanTodos.id, id))
  if (!row || row.status !== "active") throw new ToolError(`找不到待办 ${id}，先用 list_todos 查编号`)
  return row
}

/** 待办现在的「什么时候」→ 输入的写法 */
function todoTriggerOf(row: typeof t.humanTodos.$inferSelect): TodoTrigger {
  switch (row.triggerKind) {
    case "time":
      return { kind: "time", at: row.at!.toISOString() }
    case "cron":
      return { kind: "cron", cron: row.cron!, text: row.cronText ?? undefined }
    case "event":
      return { kind: "event", event: row.event!, fallbackDays: row.fallbackDays ?? 7 }
    case "time_or_event":
      return { kind: "time_or_event", at: row.at!.toISOString(), event: row.event! }
  }
}

async function loadMemory(ctx: ToolCtx, id: string) {
  const [row] = await ctx.db.select().from(t.memories).where(eq(t.memories.id, id))
  if (!row) throw new ToolError(`找不到记忆 ${id}，先用 list_memories 查编号`)
  return row
}

async function loadSkill(ctx: ToolCtx, id: string) {
  const skill = (await load.listSkills(ctx.db)).find((each) => each.id === id)
  if (!skill) throw new ToolError(`找不到技能 ${id}，先用 list_skills 查编号`)
  return skill
}

async function pendingSuggestion(ctx: ToolCtx, skillId: string) {
  const [row] = await ctx.db
    .select()
    .from(t.skillSuggestions)
    .where(and(eq(t.skillSuggestions.skillId, skillId), eq(t.skillSuggestions.status, "pending")))
    .orderBy(desc(t.skillSuggestions.createdAt))
    .limit(1)
  if (!row) throw new ToolError(`技能 ${skillId} 现在没有待审核的修改建议`)
  return row
}

async function loadRule(ctx: ToolCtx, id: string) {
  const rule = (await load.listRules(ctx.db)).find((each) => each.id === id)
  if (!rule) throw new ToolError(`找不到规则 ${id}，先用 list_rules 查编号`)
  return rule
}

async function loadHttpTool(ctx: ToolCtx, id: string) {
  const tool = (await load.listTools(ctx.db)).tools.find((each) => each.id === id)
  if (!tool) throw new ToolError(`找不到工具 ${id}，先用 list_tools 查编号`)
  if (tool.source !== "http" || !tool.http) throw new ToolError(tool.source === "builtin" ? "内置工具由系统提供，不能改" : "这是 MCP 服务器里的工具，要改它所在的服务器（update_mcp_server）")
  return tool
}

/** 规则翻译（出卡时调「规划」模型）：结果写进卡，人点「应用」就算确认 */
async function compile(ctx: ToolCtx, rule: { trigger: string; action: string; toolIds: string[] }): Promise<{ result: RuleCompileResult; costUsd: number }> {
  try {
    return await compileRuleText(ctx.db, rule)
  } catch (error) {
    throw new ToolError(`规则翻译失败，这条规则没有进确认卡：${errorText(error)}`)
  }
}

/** 模板里引用了、但服务器上还没有值的全局密钥 */
async function missingSecrets(ctx: ToolCtx, names: string[]) {
  const missing: string[] = []
  for (const name of names) if (!(await findSecret(ctx.db, { scope: "http_tool", refId: null, name }))) missing.push(name)
  return missing
}

const secretsHint = (missing: string[]) => (missing.length ? `；到「工具」页填密钥${missing.map((name) => `「${name}」`).join("")}` : "")

const pick = <T extends Record<string, unknown>>(value: T, given: Set<string>): Partial<T> => Object.fromEntries(Object.entries(value).filter(([key]) => given.has(key))) as Partial<T>

/** 合并后的完整输入再按 schema 校验一遍（字段不对就不进卡） */
function check<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw new ToolError(`字段不对：${issuesText(parsed.error)}`)
  return parsed.data
}

export const issuesText = (error: z.ZodError) =>
  error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "输入"}：${issue.message}`)
    .join("；")

// ---------- 写工具的输入 ----------

/** 派活的设置（参数声明、名额）比较复杂，先不让助手改；修改时保留原样 */
// 复核模型（必填）助手可以不给：不给就用默认复核模型（withReviewModel）
const taskFields = taskInputSchema.omit({ dispatch: true, dispatchFrom: true }).extend({ reviewModelId: z.string().trim().optional() })

/** 复核模型：没给（或者旧任务没选）就用默认复核模型；没有默认的要人选（2026-10-20 起任务必须有复核模型） */
async function withReviewModel<T extends { reviewModelId?: string | undefined }>(ctx: ToolCtx, input: T): Promise<T & { reviewModelId: string }> {
  const reviewModelId = input.reviewModelId?.trim() || (await defaultReviewModelId(ctx.db))
  if (!reviewModelId) throw new ToolError("任务要有复核模型，现在也没有默认复核模型：给 reviewModelId 填一个聊天模型（用 list_models 查编号），或者请主管先在「模型」页设默认复核模型")
  return { ...input, reviewModelId }
}
const withId = { id: z.string().min(1) }
type TodoTrigger = z.output<typeof todoInputSchema>["trigger"]

const httpFields = httpToolInputSchema.omit({ secrets: true })
const httpUpdate = httpToolInputSchema.omit({ secrets: true, id: true }).partial().extend(withId)

/** MCP 的环境变量 / 请求头：助手不碰密钥值，只能引用已存的全局密钥（值写成 {{名字}}，运行时替换） */
const mcpEnvRef = z.object({ name: z.string().trim().min(1).max(200), secret: secretNameSchema.describe("引用的全局密钥名字，值存成 {{名字}}") })
const mcpCreate = z.object({
  name: z.string().trim().min(1).max(100),
  transport: z.enum(["stdio", "http"]),
  command: z.string().trim().max(2000).optional(),
  url: z.string().trim().max(2000).optional(),
  note: z.string().trim().max(300).default(""),
  env: z.array(mcpEnvRef).max(50).default([]),
})
const mcpUpdate = mcpCreate
  .omit({ env: true })
  .partial()
  .extend({ ...withId, env: z.array(mcpEnvRef.partial({ secret: true })).max(50).optional() })

const TASK_LABELS: Partial<Record<keyof TaskInput, string>> = {
  title: "标题",
  goal: "完成标准",
  steps: "步骤",
  schedule: "定时",
  modelId: "执行模型",
  verifyModelId: "验收模型",
  reviewModelId: "复核模型",
  ownerId: "负责人",
  enabled: "启用",
  skillIds: "技能",
  memoryIds: "记忆",
  toolIds: "工具",
  ruleIds: "规则",
  browserProfileIds: "Chrome",
  allowedDomains: "网址白名单",
  allowBrowserEvaluate: "允许在网页里执行脚本",
  allowBrowserVision: "允许看画面",
  desktopIds: "桌面",
  allowDesktopVision: "允许看桌面画面",
  cronSkipIfRunning: "上一次没跑完就跳过这次",
  autoSolidify: "办成后自动固化",
  routineSkipTest: "固化时不试跑",
}

function taskFormatter(names: Names) {
  return async (key: string, value: unknown): Promise<string> => {
    switch (key) {
      case "steps":
        return stepsText((value as TaskInput["steps"]) ?? [])
      case "schedule":
        return scheduleText(value as TaskInput["schedule"])
      case "modelId":
        return names.one("model", value as string, "默认执行模型")
      case "verifyModelId":
        return names.one("model", value as string, "默认验收模型")
      case "reviewModelId":
        return names.one("model", value as string, "默认复核模型")
      case "ownerId":
        return names.one("user", value as string, "自己")
      case "skillIds":
        return names.list("skill", (value as string[]) ?? [])
      case "memoryIds":
        return names.list("memory", (value as string[]) ?? [])
      case "toolIds":
        return names.list("tool", (value as string[]) ?? [])
      case "ruleIds":
        return names.list("rule", (value as string[]) ?? [])
      case "browserProfileIds":
        return (value as string[])?.length ? names.list("browser", value as string[]) : "全部 Chrome 配置"
      case "desktopIds":
        return (value as string[])?.length ? names.list("desktop", value as string[]) : "全部桌面"
      case "allowedDomains":
        return (value as string[])?.length ? (value as string[]).join("、") : "不限"
      case "enabled":
      case "allowBrowserEvaluate":
      case "allowBrowserVision":
      case "allowDesktopVision":
      case "cronSkipIfRunning":
      case "routineSkipTest":
        return yesNo(Boolean(value))
      case "autoSolidify":
        return value === null || value === undefined ? "按默认（被派的、定时的任务开，别的关）" : yesNo(Boolean(value))
      default:
        return str(value)
    }
  }
}

const taskTitle = (id: string, title: string) => `${id}「${clip(title, 40)}」`
const taskLink = (id: string): AssistantLink => ({ page: "tasks", params: { id } })

// ---------- 工具表 ----------

export const TOOLS: Record<string, ToolDef> = {
  // ===== 查 =====
  list_tasks: read({
    description: "列任务（编号、标题、启用、负责人、定时、模型）。要看步骤和挂的东西用 get_task",
    input: queryInput,
    label: (input) => (input.query ? `查任务「${input.query}」` : "查任务列表"),
    run: async (ctx, input) => {
      const [tasks, staff] = await Promise.all([load.listTasks(ctx.db), load.listStaff(ctx.db)])
      const owner = new Map(staff.map((user) => [user.id, user.name]))
      const rows = tasks.filter((task) => contains(input.query, task.id, task.title, task.goal))
      return {
        total: rows.length,
        tasks: rows.slice(0, 100).map((task) => ({
          id: task.id,
          title: task.title,
          enabled: task.enabled,
          owner: `${owner.get(task.ownerId) ?? task.ownerId}（${task.ownerId}）`,
          schedule: task.schedule ? scheduleText(task.schedule) : null,
          nextRunAt: task.nextRunAt,
          modelId: task.modelId,
        })),
      }
    },
  }),
  get_task: read({
    description: "看一个任务的全部配置：步骤（检查点）、定时、模型、负责人，挂的记忆 / 技能 / 工具 / 规则、Chrome、网址白名单",
    input: z.object(withId),
    label: (input) => `看任务 ${str(input.id)}`,
    run: async (ctx, input) => {
      const task = await loadTask(ctx, input.id)
      const names = new Names(ctx.db)
      const [memoryCount] = await ctx.db.select({ n: count() }).from(t.taskMemoryEntries).where(eq(t.taskMemoryEntries.taskId, task.id))
      return {
        ...task,
        scheduleText: task.schedule ? scheduleText(task.schedule) : "不定时（手动运行）",
        names: {
          owner: await names.one("user", task.ownerId),
          model: await names.one("model", task.modelId),
          verifyModel: await names.one("model", task.verifyModelId, "默认验收模型"),
          reviewModel: await names.one("model", task.reviewModelId, "默认复核模型"),
          memories: await names.list("memory", task.memoryIds),
          skills: await names.list("skill", task.skillIds),
          tools: await names.list("tool", task.toolIds),
          rules: await names.list("rule", task.ruleIds),
          browsers: task.browserProfileIds.length ? await names.list("browser", task.browserProfileIds) : "全部 Chrome 配置",
          desktops: task.desktopIds.length ? await names.list("desktop", task.desktopIds) : "全部桌面",
        },
        taskMemoryCount: memoryCount?.n ?? 0,
      }
    },
  }),
  list_task_memory: read({
    description: "看一个任务自己的记忆（任务记忆，每次运行开始时全部给 agent）",
    input: z.object({ taskId: z.string().min(1) }),
    label: (input) => `看任务 ${str(input.taskId)} 的记忆`,
    run: async (ctx, input) => {
      await loadTask(ctx, input.taskId)
      const rows = await load.listTaskMemory(ctx.db, input.taskId)
      return { taskId: input.taskId, entries: rows.map((row) => ({ id: row.id, content: row.content, createdAt: row.createdAt })) }
    },
  }),
  list_todos: read({
    description: "看人加的待办（到点 / 等事件让 agent 去做，挂在任务的「什么时候跑」里），和还没处理的「要人办的事」（只读，在「会话」的「等人处理」里）",
    input: z.object({}),
    label: () => "查待办",
    run: async (ctx) => {
      const [humanTodos, humanItems] = await Promise.all([load.listActiveTodos(ctx.db), load.listOpenHumanItems(ctx.db)])
      return {
        todos: humanTodos.map((todo) => ({ id: todo.id, taskId: todo.taskId, title: todo.title, trigger: todo.trigger, createdById: todo.createdById })),
        humanItems: humanItems.map((item) => ({ id: item.id, kind: item.kind, title: item.title, assigneeId: item.assigneeId, taskId: item.taskId, memoryId: item.memoryId, skillId: item.skillId })),
      }
    },
  }),
  list_memories: read({
    description: "列全局记忆（编号、内容、适用于、状态：active 生效 / pending 待审核 / rejected / archived）",
    input: queryInput.extend({ status: z.enum(["active", "pending", "rejected", "archived"]).optional().describe("可选：只看这个状态的") }),
    label: (input) => (input.query ? `查记忆「${input.query}」` : "查记忆"),
    run: async (ctx, input) => {
      const rows = (await load.listMemories(ctx.db)).filter((memory) => (!input.status || memory.status === input.status) && contains(input.query, memory.id, memory.content, memory.appliesTo))
      return { total: rows.length, memories: rows.slice(0, 200).map((memory) => ({ id: memory.id, content: memory.content, appliesTo: memory.appliesTo, status: memory.status, reviewerId: memory.reviewerId })) }
    },
  }),
  list_skills: read({
    description: "列技能（编号、名字、岗位、说明、状态、版本、有没有待审核的修改建议）。要看 SKILL.md 正文用 get_skill",
    input: queryInput,
    label: (input) => (input.query ? `查技能「${input.query}」` : "查技能列表"),
    run: async (ctx, input) => {
      const rows = (await load.listSkills(ctx.db)).filter((skill) => contains(input.query, skill.id, skill.name, skill.description, skill.dept))
      return {
        total: rows.length,
        skills: rows.slice(0, 200).map((skill) => ({
          id: skill.id,
          name: skill.name,
          dept: skill.dept,
          description: skill.description,
          status: skill.status,
          version: skill.version,
          toolIds: skill.toolIds,
          bodyChars: skill.body?.length ?? 0,
          suggestion: skill.suggestion ? { summary: skill.suggestion.summary, reviewerId: skill.suggestion.reviewerId } : undefined,
        })),
      }
    },
  }),
  get_skill: read({
    description: "看一个技能：SKILL.md 全文、工具、待审核的修改建议（改动的行）",
    input: z.object(withId),
    label: (input) => `看技能 ${str(input.id)}`,
    run: async (ctx, input) => {
      const skill = await loadSkill(ctx, input.id)
      const [suggestion] = await ctx.db
        .select()
        .from(t.skillSuggestions)
        .where(and(eq(t.skillSuggestions.skillId, skill.id), eq(t.skillSuggestions.status, "pending")))
        .orderBy(desc(t.skillSuggestions.createdAt))
        .limit(1)
      return {
        ...skill,
        body: clip(skill.body ?? "", 30_000),
        suggestion: suggestion ? { summary: suggestion.summary, reviewerId: suggestion.reviewerId, diff: (suggestion.diff ?? []).slice(0, 200) } : undefined,
      }
    },
  }),
  list_rules: read({
    description: "列规则（编号、名字、触发条件、命中后怎么办、生效状态和「系统理解为」）",
    input: queryInput,
    label: (input) => (input.query ? `查规则「${input.query}」` : "查规则"),
    run: async (ctx, input) => {
      const rows = (await load.listRules(ctx.db)).filter((rule) => contains(input.query, rule.id, rule.name, rule.trigger, rule.action))
      return { rules: rows.map((rule) => ({ id: rule.id, name: rule.name, trigger: rule.trigger, action: rule.action, toolIds: rule.toolIds, status: rule.compile?.status, understood: rule.compile?.understood })) }
    },
  }),
  list_tools: read({
    description: "列工具（内置 / HTTP 接口 / MCP）、MCP 服务器、已存的全局密钥名字（没有值）",
    input: queryInput,
    label: (input) => (input.query ? `查工具「${input.query}」` : "查工具"),
    run: async (ctx, input) => {
      const { tools, mcpServers, savedSecrets } = await load.listTools(ctx.db)
      return {
        tools: tools
          .filter((tool) => contains(input.query, tool.id, tool.name, tool.summary))
          .map((tool) => ({ id: tool.id, name: tool.name, summary: tool.summary, source: tool.source, risk: tool.risk, serverId: tool.serverId, http: tool.http, alwaysOn: tool.alwaysOn })),
        mcpServers: mcpServers.map((server) => ({ id: server.id, name: server.name, transport: server.transport, command: server.command, url: server.url, status: server.status, note: server.note, env: server.env })),
        secretNames: Object.keys(savedSecrets),
      }
    },
  }),
  list_models: read({
    description: "列模型（编号、名字、价格：每百万 token 美元）和各角色的默认模型（run 执行、plan 规划、verify 验收、embed 图库、assistant 助手，后两个可能没配）。只读",
    input: queryInput,
    label: (input) => (input.query ? `查模型「${input.query}」` : "查模型"),
    run: async (ctx, input) => {
      const { providers, defaults } = await load.loadModels(ctx.db)
      const models = providers.flatMap((provider) => provider.models.map((model) => ({ id: model.id, name: model.name, provider: provider.name, priceIn: model.priceIn, priceOut: model.priceOut, vision: model.vision })))
      const rows = models.filter((model) => contains(input.query, model.id, model.name))
      return { defaults, total: rows.length, models: rows.slice(0, 80), more: rows.length > 80 ? "太多了，带 query 筛一下" : undefined }
    },
  }),
  list_browsers: read({
    description: "列 Chrome 配置（编号、名字、说明、登录了哪些网站账号）。只读",
    input: z.object({}),
    label: () => "查 Chrome 配置",
    run: async (ctx) => {
      const rows = await load.listBrowsers(ctx.db)
      return { browsers: rows.map((profile) => ({ id: profile.id, name: profile.name, description: profile.description, sites: profile.sites.map((site) => ({ platformId: site.platformId, account: site.account, status: site.status })) })) }
    },
  }),
  list_desktops: read({
    description: "列桌面（编号、名字、给 agent 看的说明、现在空着还是被运行占着；系统开的桌面带开着没有）。模板不能给任务用，不列。只读",
    input: z.object({}),
    label: () => "查桌面",
    run: async (ctx) => {
      const rows = (await listDesktops(ctx.db)).filter((desktop) => desktop.kind !== "template")
      return {
        desktops: rows.map((desktop) => ({ id: desktop.id, name: desktop.name, description: desktop.description, use: desktop.use.state, ...(desktop.vm ? { vmState: desktop.vm.state } : {}) })),
      }
    },
  }),
  list_sessions: read({
    description: "最近 20 次运行（编号、任务、状态、开始结束时间、花费），可以按任务筛。只读",
    input: z.object({ taskId: z.string().optional().describe("可选：只看这个任务的") }),
    label: (input) => (input.taskId ? `查任务 ${input.taskId} 的运行` : "查最近的运行"),
    run: async (ctx, input) => {
      const rows = await ctx.db
        .select({ id: t.sessions.id, taskId: t.sessions.taskId, status: t.sessions.status, triggeredBy: t.sessions.triggeredBy, startedAt: t.sessions.startedAt, endedAt: t.sessions.endedAt, costUsd: t.sessions.costUsd })
        .from(t.sessions)
        // 固化试跑不算「运行」（不进会话列表，docs/dev/solidify.md 15.3 第 5 条）
        .where(and(eq(t.sessions.kind, "run"), input.taskId ? eq(t.sessions.taskId, input.taskId) : undefined))
        .orderBy(desc(t.sessions.startedAt))
        .limit(20)
      return { sessions: rows.map((row) => ({ ...row, startedAt: row.startedAt.toISOString(), endedAt: row.endedAt?.toISOString() })) }
    },
  }),
  list_run_files: read({
    description: "列一次运行的文件（截图、产物、浏览器下载、附件、工具输出全文）：编号、路径（空间里的位置，例如 state/progress.json、attachments/报价.xlsx）、类型、大小。image = true 的可以用 view_image 看，text = true 的可以用 read_file 读",
    input: z.object({
      runId: z.string().min(1).describe("运行编号（R-…），用 list_sessions 查"),
      kind: z.enum(["screenshot", "artifact", "download", "attachment", "upload", "tool_output"]).optional().describe("可选：只看这一类（screenshot 截图）"),
    }),
    label: (input) => `查运行 ${str(input.runId)} 的文件`,
    run: async (ctx, input) => {
      // 和运行详情的「空间文件」一样：登录的人都能看
      const [session] = await ctx.db.select({ id: t.sessions.id, taskId: t.sessions.taskId, snapshot: t.sessions.snapshot }).from(t.sessions).where(eq(t.sessions.id, input.runId))
      if (!session) throw new ToolError(`找不到运行 ${input.runId}，先用 list_sessions 查编号`)
      const all = await listSessionFiles(ctx.db, session.id, session.snapshot?.attachments.map((file) => file.id) ?? [])
      const rows = all.filter((file) => !input.kind || file.kind === input.kind)
      // 太多时留最后的（截图越往后越接近结果）
      const shown = rows.slice(-RUN_FILES_MAX)
      return {
        runId: session.id,
        taskId: session.taskId,
        total: rows.length,
        files: shown.map((file) => ({ id: file.id, path: file.path, kind: file.kind, mime: file.mime, size: file.size, updatedAt: file.updatedAt, image: isImageMime(file.mime), text: isTextFile(file) })),
        more: rows.length > shown.length ? `只列了最后 ${RUN_FILES_MAX} 个，带 kind 筛一下` : undefined,
      }
    },
  }),
  view_image: read({
    description: "看一张图：运行的截图 / 产物（fileId，用 list_run_files 查）、人发的图（fileId，消息里「附图」后面的编号）、图库的图（galleryImageId，img-…）。两个只给一个。图在工具结果后面的下一条消息里",
    input: z
      .object({
        fileId: z.string().min(1).max(64).optional().describe("文件编号 f-…"),
        galleryImageId: z.string().min(1).max(64).optional().describe("图库编号 img-…"),
      })
      .refine((input) => Boolean(input.fileId) !== Boolean(input.galleryImageId), { message: "fileId 和 galleryImageId 只给一个" }),
    label: (input) => `看图 ${str(input.galleryImageId ?? input.fileId)}`,
    // 只查出是哪个文件；读图、缩图、接在工具结果后面由 run.ts 做（它知道当前模型能不能看图）
    run: async (ctx, input) => {
      const { row, from } = await viewableImage(ctx.db, input)
      return { fileId: row.id, name: row.name, mime: row.mime, size: row.size, from }
    },
  }),
  read_file: read({
    description: `读一个文本文件（md、txt、html、csv、json、代码、PDF、Word……）的内容：人发的文件（消息里「附件」后面的编号，没放全的从提示的 offset 接着读）、运行的文件（用 list_run_files 查，text = true 的）。一次给 ${READ_FILE_LIMIT} 字，后面还有会提示下一个 offset；HTML 去掉了 script、style、svg 和注释，PDF、Word 是抽出来的文字（PDF 每页前有「--- 第 N 页 ---」）`,
    input: z.object({
      fileId: z.string().min(1).max(64).describe("文件编号 f-…"),
      offset: z.number().int().min(0).optional().describe("从第几个字开始读，默认 0"),
    }),
    label: (input) => `读文件 ${str(input.fileId)}${input.offset ? `（从第 ${input.offset} 字）` : ""}`,
    // 结果是一段文字（不是对象），run.ts 原样交回模型
    run: (ctx, input) => readFilePart(ctx.db, input.fileId, input.offset, ctx.texts),
  }),
  list_staff: read({
    description: "列全部的人（编号、名字、职位、是不是主管）：指派负责人、审核人时用",
    input: z.object({}),
    label: () => "查人员",
    run: async (ctx) => ({ staff: await load.listStaff(ctx.db) }),
  }),

  // ===== 任务 =====
  create_task: write({
    description: "新建任务（只有主管能建）。字段见系统提示「任务的字段」",
    input: taskFields,
    label: (input) => `新建任务「${clip(str(input.title), 30)}」`,
    prepare: async (ctx, input) => {
      need(ctx, "task.create", {}, "新建任务只有主管能做")
      const names = new Names(ctx.db)
      const format = taskFormatter(names)
      const full: TaskInput = { ...(await withReviewModel(ctx, input)), dispatch: null, dispatchFrom: [] }
      const fields: FieldChange[] = []
      for (const [key, label] of Object.entries(TASK_LABELS) as [keyof TaskInput, string][]) {
        const value = full[key]
        // 没填、空的、默认值不列，卡上只放人关心的
        if (key !== "title" && key !== "goal" && key !== "steps" && key !== "schedule" && key !== "modelId") {
          if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) continue
          if (key === "enabled" && value === true) continue
          if (key === "allowBrowserEvaluate" && value === false) continue
          if (key === "allowBrowserVision" && value === false) continue
          if (key === "allowDesktopVision" && value === false) continue
          if (key === "cronSkipIfRunning" && value === true) continue
          if (key === "autoSolidify" && value === null) continue
          if (key === "routineSkipTest" && value === false) continue
        }
        fields.push({ label, after: clip(await format(key, value)) })
      }
      return { title: `新建任务「${clip(input.title, 40)}」`, fields }
    },
    apply: async (ctx, input) => {
      const { id } = await createTask(ctx, { ...(await withReviewModel(ctx, input)), dispatch: null, dispatchFrom: [] })
      return { message: `已建好任务 ${id}`, link: taskLink(id), output: { id } }
    },
  }),
  update_task: write({
    description: "修改任务：只传要改的字段（数组字段传完整的新列表），没传的保持不变",
    input: taskFields.partial().extend(withId),
    label: (input) => `修改任务 ${str(input.id)}`,
    prepare: async (ctx, input, given) => {
      const task = await loadTask(ctx, input.id)
      need(ctx, "task.manage", { ownerId: task.ownerId }, "只有负责人和主管能改这个任务")
      if (given.has("ownerId") && input.ownerId && input.ownerId !== task.ownerId && !ctx.actor.isAdmin) throw new ToolError("你没有权限：员工不能把任务转给别人")
      const before = taskInputOf(task)
      const after = check(taskInputSchema, await withReviewModel(ctx, { ...before, ...pick(input, given) }))
      const fields = await changedFields(before, after, given, TASK_LABELS, taskFormatter(new Names(ctx.db)), (key, value) =>
        key === "steps" ? ((value as TaskInput["steps"]) ?? []).map(stepText) : undefined
      )
      if (fields.length === 0) throw new ToolError("给的字段和现在一样，没有要改的")
      return { title: `修改任务 ${taskTitle(task.id, task.title)}`, fields }
    },
    apply: async (ctx, input, given) => {
      // 应用时重新读一遍：出卡以后别人可能改过别的字段，只覆盖这次给的
      const task = await loadTask(ctx, input.id)
      const merged = check(taskInputSchema, await withReviewModel(ctx, { ...taskInputOf(task), ...pick(input, given) }))
      await updateTask(ctx, { ...merged, id: task.id })
      return { message: `已改好任务 ${task.id}`, link: taskLink(task.id), output: { id: task.id } }
    },
  }),
  set_task_enabled: write({
    description: "启用或停用任务（停用后定时不再触发）",
    input: taskSetEnabledSchema,
    label: (input) => `${input.enabled ? "启用" : "停用"}任务 ${str(input.id)}`,
    prepare: async (ctx, input) => {
      const task = await loadTask(ctx, input.id)
      need(ctx, "task.manage", { ownerId: task.ownerId }, "只有负责人和主管能启停这个任务")
      if (task.enabled === input.enabled) throw new ToolError(`任务 ${task.id} 已经是${input.enabled ? "启用" : "停用"}的了`)
      return { title: `${input.enabled ? "启用" : "停用"}任务 ${taskTitle(task.id, task.title)}`, fields: [{ label: "启用", before: yesNo(task.enabled), after: yesNo(input.enabled) }] }
    },
    apply: async (ctx, input) => {
      await setTaskEnabled(ctx, input)
      return { message: `已${input.enabled ? "启用" : "停用"}任务 ${input.id}`, link: taskLink(input.id), output: { id: input.id, enabled: input.enabled } }
    },
  }),
  delete_task: write({
    description: "删除任务。有运行记录或派活单的不能删，只能停用（set_task_enabled）",
    input: idInput,
    label: (input) => `删除任务 ${str(input.id)}`,
    destructive: true,
    prepare: async (ctx, input) => {
      const task = await loadTask(ctx, input.id)
      need(ctx, "task.manage", { ownerId: task.ownerId }, "只有负责人和主管能删这个任务")
      const [runs] = await ctx.db.select({ n: count() }).from(t.sessions).where(eq(t.sessions.taskId, task.id))
      if ((runs?.n ?? 0) > 0) throw new ToolError(`任务 ${task.id} 已经有 ${runs!.n} 次运行记录，不能删除（记录要留着查），只能停用`)
      const [items] = await ctx.db.select({ n: count() }).from(t.workItems).where(eq(t.workItems.taskId, task.id))
      if ((items?.n ?? 0) > 0) throw new ToolError(`任务 ${task.id} 有派活单，不能删除，只能停用`)
      return { title: `删除任务 ${taskTitle(task.id, task.title)}`, fields: [{ label: "任务", before: `${task.title}（${task.id}）` }] }
    },
    apply: async (ctx, input) => {
      await deleteTask(ctx, input)
      return { message: `已删除任务 ${input.id}`, output: { id: input.id } }
    },
  }),

  attach_files_to_task: write({
    description: "把人随消息发的图、文件（上传的文件）放进任务的附件，任务每次运行都能读到。只收人刚上传、还没用在别处的文件",
    input: z.object({ taskId: z.string().min(1), fileIds: z.array(z.string().min(1).max(64)).min(1).max(20).describe("文件编号 f-…（消息里「附图」「附件」后面的）") }),
    label: (input) => `给任务 ${str(input.taskId)} 加附件`,
    prepare: async (ctx, input) => {
      const task = await loadTask(ctx, input.taskId)
      need(ctx, "task.manage", { ownerId: task.ownerId }, ATTACH_FORBIDDEN)
      const files = await attachableFiles(ctx.db, task.id, input.fileIds)
      const fresh = files.filter((each) => !each.already)
      if (fresh.length === 0) throw new ToolError(`这些文件已经是任务 ${task.id} 的附件了`)
      return {
        title: `给任务 ${taskTitle(task.id, task.title)} 加 ${fresh.length} 个附件`,
        fields: fresh.map((each, index) => ({ label: fresh.length > 1 ? `附件 ${index + 1}` : "附件", after: `${each.file.name}（${each.file.id}）` })),
      }
    },
    apply: async (ctx, input) => {
      const files = await attachFilesToTask(ctx, input)
      return { message: `已把 ${files.length} 个文件加到任务 ${input.taskId} 的附件`, link: taskLink(input.taskId), output: { taskId: input.taskId, fileIds: files.map((file) => file.id) } }
    },
  }),

  // ===== 任务记忆 =====
  add_task_memory: write({
    description: "给任务加一条任务记忆（这个任务每次运行都会读到的经验）",
    input: taskMemoryAddSchema,
    label: (input) => `给任务 ${str(input.taskId)} 加记忆`,
    prepare: async (ctx, input) => {
      const task = await loadTask(ctx, input.taskId)
      need(ctx, "task.manage", { ownerId: task.ownerId }, "只有任务负责人和主管能改任务记忆")
      return { title: `给任务 ${taskTitle(task.id, task.title)} 加一条记忆`, fields: [{ label: "内容", after: clip(input.content) }] }
    },
    apply: async (ctx, input) => {
      const { id } = await taskMemory.addTaskMemory(ctx, input)
      return { message: `已加到任务 ${input.taskId} 的记忆（第 ${id} 条）`, link: taskLink(input.taskId), output: { id } }
    },
  }),
  update_task_memory: write({
    description: "改一条任务记忆的内容（id 是 list_task_memory 里的数字编号）",
    input: taskMemoryUpdateSchema,
    label: (input) => `改任务记忆 ${str(input.id)}`,
    prepare: async (ctx, input) => {
      const entry = await loadTaskMemoryEntry(ctx, input.id)
      const task = await loadTask(ctx, entry.taskId)
      need(ctx, "task.manage", { ownerId: task.ownerId }, "只有任务负责人和主管能改任务记忆")
      if (entry.content === input.content) throw new ToolError("内容和现在一样，没有要改的")
      return { title: `改任务 ${taskTitle(task.id, task.title)} 的一条记忆`, fields: [{ label: "内容", before: clip(entry.content, DIFF_MAX), after: clip(input.content, DIFF_MAX) }] }
    },
    apply: async (ctx, input) => {
      const entry = await loadTaskMemoryEntry(ctx, input.id)
      await taskMemory.updateTaskMemory(ctx, input)
      return { message: `已改好任务 ${entry.taskId} 的记忆`, link: taskLink(entry.taskId), output: { id: input.id } }
    },
  }),
  delete_task_memory: write({
    description: "删一条任务记忆",
    input: taskMemoryDeleteSchema,
    label: (input) => `删任务记忆 ${str(input.id)}`,
    destructive: true,
    prepare: async (ctx, input) => {
      const entry = await loadTaskMemoryEntry(ctx, input.id)
      const task = await loadTask(ctx, entry.taskId)
      need(ctx, "task.manage", { ownerId: task.ownerId }, "只有任务负责人和主管能改任务记忆")
      return { title: `删除任务 ${taskTitle(task.id, task.title)} 的一条记忆`, fields: [{ label: "内容", before: clip(entry.content) }] }
    },
    apply: async (ctx, input) => {
      const entry = await loadTaskMemoryEntry(ctx, input.id)
      await taskMemory.deleteTaskMemory(ctx, input)
      return { message: `已删除任务 ${entry.taskId} 的一条记忆`, link: taskLink(entry.taskId), output: { id: input.id } }
    },
  }),

  // ===== 待办 =====
  create_todo: write({
    description: "新建待办：到点（或按 cron、等事件）让某个任务的 agent 去做一件事。只能给自己负责的任务加（主管都能加）",
    input: todoInputSchema,
    label: (input) => `新建待办「${clip(str(input.title), 30)}」`,
    prepare: async (ctx, input) => {
      const task = await loadTask(ctx, input.taskId)
      need(ctx, "todo.create", { taskOwnerId: task.ownerId }, "只能给自己负责的任务加待办")
      return {
        title: `新建待办「${clip(input.title, 40)}」`,
        fields: [
          { label: "任务", after: taskTitle(task.id, task.title) },
          { label: "要做的事", after: clip(input.title) },
          { label: "什么时候", after: triggerText(input.trigger) },
        ],
      }
    },
    apply: async (ctx, input) => {
      const { id } = await todos.createTodo(ctx, input)
      // 人加的待办在任务详情的「什么时候跑」里
      return { message: `已建好待办 ${id}`, link: { page: "tasks", params: { id: input.taskId } }, output: { id } }
    },
  }),
  update_todo: write({
    description: "修改待办：只传要改的字段（taskId 换任务、title 要做的事、trigger 什么时候），没传的保持不变",
    input: todoInputSchema.partial().extend(withId),
    label: (input) => `修改待办 ${str(input.id)}`,
    prepare: async (ctx, input, given) => {
      const row = await loadTodoRow(ctx, input.id)
      need(ctx, "todo.manage", { createdById: row.createdById }, "只有加这条待办的人和主管能改")
      const before = { taskId: row.taskId, title: row.title, trigger: todoTriggerOf(row) }
      const after = check(todoInputSchema, { ...before, ...pick(input, given) })
      if (after.taskId !== row.taskId) {
        const task = await loadTask(ctx, after.taskId)
        need(ctx, "todo.create", { taskOwnerId: task.ownerId }, "只能挪到自己负责的任务下")
      }
      const names = new Names(ctx.db)
      const fields = await changedFields(before, after, given, { taskId: "任务", title: "要做的事", trigger: "什么时候" }, async (key, value) =>
        key === "trigger" ? triggerText(value as TodoTrigger) : key === "taskId" ? names.one("task", value as string) : str(value)
      )
      if (fields.length === 0) throw new ToolError("给的字段和现在一样，没有要改的")
      return { title: `修改待办 ${row.id}「${clip(row.title, 40)}」`, fields }
    },
    apply: async (ctx, input, given) => {
      const row = await loadTodoRow(ctx, input.id)
      const merged = check(todoInputSchema, { taskId: row.taskId, title: row.title, trigger: todoTriggerOf(row), ...pick(input, given) })
      await todos.updateTodo(ctx, { ...merged, id: row.id })
      return { message: `已改好待办 ${row.id}`, link: { page: "tasks", params: { id: merged.taskId } }, output: { id: row.id } }
    },
  }),
  delete_todo: write({
    description: "删除待办",
    input: idInput,
    label: (input) => `删除待办 ${str(input.id)}`,
    destructive: true,
    prepare: async (ctx, input) => {
      const row = await loadTodoRow(ctx, input.id)
      need(ctx, "todo.manage", { createdById: row.createdById }, "只有加这条待办的人和主管能删")
      return { title: `删除待办 ${row.id}「${clip(row.title, 40)}」`, fields: [{ label: "要做的事", before: clip(row.title) }, { label: "什么时候", before: triggerText(todoTriggerOf(row)) }] }
    },
    apply: async (ctx, input) => {
      await todos.deleteTodo(ctx, input)
      return { message: `已删除待办 ${input.id}`, output: { id: input.id } }
    },
  }),

  // ===== 全局记忆 =====
  create_memory: write({
    description: "新建一条全局记忆（只有主管能建；人建的直接生效）。要让任务读到，还要用 update_task 把它加进任务的 memoryIds",
    input: memoryInputSchema,
    label: () => "新建记忆",
    prepare: async (ctx, input) => {
      need(ctx, "config.manage", {}, "新建记忆只有主管能做")
      return { title: "新建记忆", fields: [{ label: "内容", after: clip(input.content) }, { label: "适用于", after: input.appliesTo }] }
    },
    apply: async (ctx, input) => {
      const { id } = await memories.createMemory(ctx, input)
      return { message: `已建好记忆 ${id}`, link: { page: "memory", params: { id } }, output: { id } }
    },
  }),
  update_memory: write({
    description: "修改全局记忆：只传要改的字段（content、appliesTo）",
    input: memoryInputSchema.partial().extend(withId),
    label: (input) => `修改记忆 ${str(input.id)}`,
    prepare: async (ctx, input, given) => {
      need(ctx, "config.manage", {}, "修改记忆只有主管能做")
      const row = await loadMemory(ctx, input.id)
      if (row.status === "pending") throw new ToolError("这条记忆还在等审核，先批准（approve_memory）或拒绝（reject_memory）")
      const before = { content: row.content, appliesTo: row.appliesTo }
      const after = check(memoryInputSchema, { ...before, ...pick(input, given) })
      const fields = await changedFields(before, after, given, { content: "内容", appliesTo: "适用于" }, (_, value) => str(value))
      if (fields.length === 0) throw new ToolError("给的字段和现在一样，没有要改的")
      return { title: `修改记忆 ${row.id}`, fields }
    },
    apply: async (ctx, input, given) => {
      const row = await loadMemory(ctx, input.id)
      const merged = check(memoryInputSchema, { content: row.content, appliesTo: row.appliesTo, ...pick(input, given) })
      await memories.updateMemory(ctx, { ...merged, id: row.id })
      return { message: `已改好记忆 ${row.id}`, link: { page: "memory", params: { id: row.id } }, output: { id: row.id } }
    },
  }),
  approve_memory: write({
    description: "批准 agent 提议的记忆（待审核的，只有分给你审核的或主管能批）",
    input: idInput,
    label: (input) => `批准记忆 ${str(input.id)}`,
    prepare: async (ctx, input) => {
      const row = await reviewableMemory(ctx, input.id)
      return { title: `批准记忆 ${row.id}`, fields: [{ label: "内容", after: clip(row.content) }, { label: "适用于", after: row.appliesTo }] }
    },
    apply: async (ctx, input) => {
      await memories.approveMemory(ctx, input)
      return { message: `已批准记忆 ${input.id}，现在生效了`, link: { page: "memory", params: { id: input.id } }, output: { id: input.id } }
    },
  }),
  reject_memory: write({
    description: "驳回 agent 提议的记忆（待审核的），可以写原因 reason",
    input: reviewInputSchema,
    label: (input) => `驳回记忆 ${str(input.id)}`,
    destructive: true,
    prepare: async (ctx, input) => {
      const row = await reviewableMemory(ctx, input.id)
      return { title: `驳回记忆 ${row.id}`, fields: [{ label: "内容", before: clip(row.content) }, ...(input.reason ? [{ label: "原因", after: input.reason }] : [])] }
    },
    apply: async (ctx, input) => {
      await memories.rejectMemory(ctx, input)
      return { message: `已驳回记忆 ${input.id}`, output: { id: input.id } }
    },
  }),
  archive_memory: write({
    description: "归档全局记忆：不再给任务用，但留着记录",
    input: idInput,
    label: (input) => `归档记忆 ${str(input.id)}`,
    destructive: true,
    prepare: async (ctx, input) => {
      need(ctx, "config.manage", {}, "归档记忆只有主管能做")
      const row = await loadMemory(ctx, input.id)
      if (row.status === "pending") throw new ToolError("这条记忆还在等审核，先批准或拒绝")
      if (row.status === "archived") throw new ToolError(`记忆 ${row.id} 已经归档了`)
      const used = await tasksUsingRef(ctx.db, t.taskMemories, [row.id])
      return {
        title: `归档记忆 ${row.id}`,
        fields: [{ label: "内容", before: clip(row.content) }, ...(used.length ? [{ label: "选用它的任务（下一次运行就读不到了）", before: usedByText(used) }] : [])],
      }
    },
    apply: async (ctx, input) => {
      await memories.archiveMemory(ctx, input)
      return { message: `已归档记忆 ${input.id}`, link: { page: "memory", params: { id: input.id } }, output: { id: input.id } }
    },
  }),
  delete_memory: write({
    description: "删除全局记忆。被任务选用着的不能删（先从任务里去掉，或者改用归档）",
    input: idInput,
    label: (input) => `删除记忆 ${str(input.id)}`,
    destructive: true,
    prepare: async (ctx, input) => {
      need(ctx, "config.manage", {}, "删除记忆只有主管能做")
      const row = await loadMemory(ctx, input.id)
      const used = await tasksUsingRef(ctx.db, t.taskMemories, [row.id])
      if (used.length) throw new ToolError(`这条记忆正被 ${used.length} 个任务选用：${usedByText(used)}。先在这些任务里去掉它，或者改成归档`)
      return { title: `删除记忆 ${row.id}`, fields: [{ label: "内容", before: clip(row.content) }] }
    },
    apply: async (ctx, input) => {
      await memories.deleteMemory(ctx, input)
      return { message: `已删除记忆 ${input.id}`, output: { id: input.id } }
    },
  }),

  // ===== 技能 =====
  create_skill: write({
    description: "新建技能（只有主管能建；建好是草稿，要任务能选用还要 set_skill_status 发布）。body 是 SKILL.md 正文（Markdown）",
    input: skillInputSchema,
    label: (input) => `新建技能「${clip(str(input.name), 30)}」`,
    prepare: async (ctx, input) => {
      need(ctx, "config.manage", {}, "新建技能只有主管能做")
      const names = new Names(ctx.db)
      return {
        title: `新建技能「${clip(input.name, 40)}」（草稿）`,
        fields: [
          { label: "名字", after: input.name },
          { label: "岗位", after: input.dept },
          { label: "什么时候用", after: clip(input.description) },
          { label: "正文", after: clip(input.body) || "（空）" },
          ...(input.toolIds.length ? [{ label: "工具", after: await names.list("tool", input.toolIds) }] : []),
        ],
      }
    },
    apply: async (ctx, input) => {
      const { id } = await skills.createSkill(ctx, input)
      return { message: `已建好技能 ${id}（草稿）`, link: { page: "skills", params: { id } }, output: { id, status: "draft" } }
    },
  }),
  update_skill: write({
    description: "修改技能（存成新一版）：只传要改的字段（name、dept、description、body 全文、toolIds）",
    input: skillInputSchema.partial().extend(withId),
    label: (input) => `修改技能 ${str(input.id)}`,
    prepare: async (ctx, input, given) => {
      need(ctx, "config.manage", {}, "修改技能只有主管能做")
      const skill = await loadSkill(ctx, input.id)
      const before = { name: skill.name, dept: skill.dept, description: skill.description, body: skill.body ?? "", toolIds: skill.toolIds }
      const after = check(skillInputSchema, { ...before, ...pick(input, given) })
      const names = new Names(ctx.db)
      const fields = await changedFields(before, after, given, { name: "名字", dept: "岗位", description: "什么时候用", body: "正文", toolIds: "工具" }, (key, value) =>
        key === "toolIds" ? names.list("tool", value as string[]) : str(value)
      )
      if (fields.length === 0) throw new ToolError("给的字段和现在一样，没有要改的")
      return { title: `修改技能 ${skill.id}「${clip(skill.name, 40)}」（存成第 ${skill.version + 1} 版）`, fields }
    },
    apply: async (ctx, input, given) => {
      const skill = await loadSkill(ctx, input.id)
      const merged = check(skillInputSchema, { name: skill.name, dept: skill.dept, description: skill.description, body: skill.body ?? "", toolIds: skill.toolIds, ...pick(input, given) })
      const { version } = await skills.updateSkill(ctx, { ...merged, id: skill.id })
      return { message: `已改好技能 ${skill.id}（第 ${version} 版）`, link: { page: "skills", params: { id: skill.id } }, output: { id: skill.id, version } }
    },
  }),
  set_skill_status: write({
    description: "发布（published）/ 停用（disabled）/ 改回草稿（draft）技能。被任务选用着的不能停用",
    input: skillSetStatusSchema,
    label: (input) => `改技能 ${str(input.id)} 的状态`,
    prepare: async (ctx, input) => {
      need(ctx, "config.manage", {}, "发布或停用技能只有主管能做")
      const skill = await loadSkill(ctx, input.id)
      if (skill.status === input.status) throw new ToolError(`技能 ${skill.id} 已经是「${skillStatusText(input.status)}」了`)
      if (input.status !== "published") {
        const used = await tasksUsingRef(ctx.db, t.taskSkills, [skill.id])
        if (used.length) throw new ToolError(`这个技能正被 ${used.length} 个任务选用：${usedByText(used)}。先在这些任务里去掉它，再停用`)
      }
      return { title: `技能 ${skill.id}「${clip(skill.name, 40)}」改成${skillStatusText(input.status)}`, fields: [{ label: "状态", before: skillStatusText(skill.status), after: skillStatusText(input.status) }] }
    },
    apply: async (ctx, input) => {
      await skills.setSkillStatus(ctx, input)
      return { message: `技能 ${input.id} 已改成${skillStatusText(input.status)}`, link: { page: "skills", params: { id: input.id } }, output: { id: input.id, status: input.status } }
    },
  }),
  accept_skill_suggestion: write({
    description: "采纳 agent 对技能提的修改建议（合并成新一版）。id 是技能编号",
    input: idInput,
    label: (input) => `采纳技能 ${str(input.id)} 的修改建议`,
    prepare: async (ctx, input) => {
      const skill = await loadSkill(ctx, input.id)
      const suggestion = await pendingSuggestion(ctx, skill.id)
      need(ctx, "humanItem.resolve", { assigneeId: suggestion.reviewerId }, "这条修改建议不是分给你审核的")
      return { title: `采纳技能 ${skill.id}「${clip(skill.name, 40)}」的修改建议`, fields: [{ label: "建议", after: clip(suggestion.summary) }] }
    },
    apply: async (ctx, input) => {
      const { version } = await skills.acceptSkillSuggestion(ctx, input)
      return { message: `已采纳，技能 ${input.id} 存成第 ${version} 版`, link: { page: "skills", params: { id: input.id } }, output: { id: input.id, version } }
    },
  }),
  reject_skill_suggestion: write({
    description: "拒绝 agent 对技能提的修改建议，可以写原因 reason。id 是技能编号",
    input: reviewInputSchema,
    label: (input) => `拒绝技能 ${str(input.id)} 的修改建议`,
    destructive: true,
    prepare: async (ctx, input) => {
      const skill = await loadSkill(ctx, input.id)
      const suggestion = await pendingSuggestion(ctx, skill.id)
      need(ctx, "humanItem.resolve", { assigneeId: suggestion.reviewerId }, "这条修改建议不是分给你审核的")
      return { title: `拒绝技能 ${skill.id}「${clip(skill.name, 40)}」的修改建议`, fields: [{ label: "建议", before: clip(suggestion.summary) }, ...(input.reason ? [{ label: "原因", after: input.reason }] : [])] }
    },
    apply: async (ctx, input) => {
      await skills.rejectSkillSuggestion(ctx, input)
      return { message: `已拒绝技能 ${input.id} 的修改建议`, output: { id: input.id } }
    },
  }),

  // ===== 规则 =====
  create_rule: write({
    description: "新建规则（只有主管能建）。出卡前系统会先翻译成「系统理解为……」写在卡上，人点「应用」就算确认，规则马上生效",
    input: ruleInputSchema,
    label: (input) => `新建规则「${clip(str(input.name), 30)}」`,
    prepare: async (ctx, input) => {
      need(ctx, "config.manage", {}, "新建规则只有主管能做")
      const { result, costUsd } = await compile(ctx, input)
      const names = new Names(ctx.db)
      return {
        title: `新建规则「${clip(input.name, 40)}」`,
        fields: [
          { label: "名字", after: input.name },
          { label: "触发条件", after: clip(input.trigger) },
          { label: "命中后怎么办", after: clip(input.action) },
          ...(input.toolIds.length ? [{ label: "会调用的工具", after: await names.list("tool", input.toolIds) }] : []),
          { label: "系统理解为", after: result.understood },
        ],
        prepared: { compile: result },
        costUsd,
      }
    },
    apply: async (ctx, input, _given, prepared) => {
      assertCan(ctx.actor, "config.manage", {}, "只有主管能新建规则")
      const compiled = (prepared as { compile?: RuleCompileResult } | undefined)?.compile
      const { id, confirmed } = await ctx.db.transaction(async (tx) => {
        const { id } = await insertRule(tx, ctx.actor, { ...input, compileDraft: compiled })
        // 人在卡上看过「系统理解为」并点了「应用」，就算确认
        if (compiled?.supported) {
          await confirmRuleInTx(tx, ctx.actor, { id })
          return { id, confirmed: true }
        }
        return { id, confirmed: false }
      })
      return {
        message: confirmed ? `已建好规则 ${id}，已生效` : `已建好规则 ${id}，但还没生效：${compiled?.reason ?? "没有翻译结果"}`,
        link: { page: "rules", params: { id } },
        output: { id, active: confirmed },
      }
    },
  }),
  update_rule: write({
    description: "修改规则：只传要改的字段（name、trigger、action、toolIds）。改了触发条件或动作会重新翻译，人点「应用」就算确认",
    input: ruleInputSchema.partial().extend(withId),
    label: (input) => `修改规则 ${str(input.id)}`,
    prepare: async (ctx, input, given) => {
      need(ctx, "config.manage", {}, "修改规则只有主管能做")
      const rule = await loadRule(ctx, input.id)
      const before = { name: rule.name, trigger: rule.trigger, action: rule.action, toolIds: rule.toolIds }
      const after = check(ruleInputSchema, { ...before, ...pick(input, given) })
      const names = new Names(ctx.db)
      const fields = await changedFields(before, after, given, { name: "名字", trigger: "触发条件", action: "命中后怎么办", toolIds: "会调用的工具" }, (key, value) =>
        key === "toolIds" ? names.list("tool", value as string[]) : str(value)
      )
      if (fields.length === 0) throw new ToolError("给的字段和现在一样，没有要改的")
      const textChanged = after.trigger !== rule.trigger || after.action !== rule.action
      if (!textChanged) return { title: `修改规则 ${rule.id}「${clip(rule.name, 40)}」`, fields }
      const { result, costUsd } = await compile(ctx, after)
      return {
        title: `修改规则 ${rule.id}「${clip(rule.name, 40)}」`,
        fields: [...fields, { label: "系统理解为", before: rule.compile?.understood, after: result.understood }],
        prepared: { compile: result },
        costUsd,
      }
    },
    apply: async (ctx, input, given, prepared) => {
      const rule = await loadRule(ctx, input.id)
      const merged = check(ruleInputSchema, { name: rule.name, trigger: rule.trigger, action: rule.action, toolIds: rule.toolIds, ...pick(input, given) })
      await updateRule(ctx, { ...merged, id: rule.id })
      const compiled = (prepared as { compile?: RuleCompileResult } | undefined)?.compile
      let active = rule.compile?.status === "active"
      if (compiled && compiled.trigger === merged.trigger && compiled.action === merged.action) {
        active = await ctx.db.transaction(async (tx) => {
          await tx.update(t.rules).set({ compileDraft: compiled }).where(and(eq(t.rules.id, rule.id), eq(t.rules.trigger, merged.trigger), eq(t.rules.action, merged.action)))
          if (!compiled.supported) return false
          await confirmRuleInTx(tx, ctx.actor, { id: rule.id })
          return true
        })
      }
      return {
        message: active ? `已改好规则 ${rule.id}，已生效` : `已改好规则 ${rule.id}，但新的文字还没生效${compiled && !compiled.supported ? `：${compiled.reason ?? ""}` : ""}`,
        link: { page: "rules", params: { id: rule.id } },
        output: { id: rule.id, active },
      }
    },
  }),
  delete_rule: write({
    description: "删除规则。被任务选用着的不能删",
    input: idInput,
    label: (input) => `删除规则 ${str(input.id)}`,
    destructive: true,
    prepare: async (ctx, input) => {
      need(ctx, "config.manage", {}, "删除规则只有主管能做")
      const rule = await loadRule(ctx, input.id)
      const used = await tasksUsingRef(ctx.db, t.taskRules, [rule.id])
      if (used.length) throw new ToolError(`规则「${rule.name}」正被 ${used.length} 个任务选用：${usedByText(used)}。先在这些任务里去掉它，再删除`)
      return { title: `删除规则 ${rule.id}「${clip(rule.name, 40)}」`, fields: [{ label: "触发条件", before: clip(rule.trigger) }, { label: "命中后怎么办", before: clip(rule.action) }] }
    },
    apply: async (ctx, input) => {
      await deleteRule(ctx, input)
      return { message: `已删除规则 ${input.id}`, output: { id: input.id } }
    },
  }),

  // ===== 工具配置 =====
  create_http_tool: write({
    description:
      "新建 HTTP 接口工具（只有主管能建）。模板里的密钥只写 {{名字}}，不要写真正的值；{参数} 由 agent 调用时填。JSON 请求体里写在引号外面的 {参数}（\"items\": {items}）按 JSON 原样填（数组、对象），引号里面的按文字填。http.params 可不传（按模板推：引号外面的是 json，都必填）；传就要和模板里的 {名字} 一一对应，可以设 required = false、omitIfAbsent = true（没传就去掉这个字段 / 查询参数 / 请求头）",
    input: httpFields,
    label: (input) => `新建工具「${clip(str(input.name), 30)}」`,
    prepare: async (ctx, input) => {
      need(ctx, "config.manage", {}, "新建工具只有主管能做")
      const { http, missing } = await checkHttp(ctx, input.http)
      return {
        title: `新建 HTTP 工具「${clip(input.name, 40)}」`,
        fields: [
          { label: "名字", after: input.name },
          { label: "说明", after: clip(input.description) },
          { label: "请求", after: `${http.method} ${http.url}` },
          ...(Object.keys(http.headers).length ? [{ label: "请求头", after: Object.keys(http.headers).join("、") }] : []),
          ...(http.body ? [{ label: "请求体", after: clip(http.body) }] : []),
          ...(http.params.length ? [{ label: "参数", after: paramsText(http.params) }] : []),
          { label: "风险", after: riskText(input.risk) },
          ...(missing.length ? [{ label: "还要到工具页填的密钥", after: missing.join("、") }] : []),
        ],
      }
    },
    apply: async (ctx, input) => {
      assertCan(ctx.actor, "config.manage", {}, "只有主管能新建工具")
      const { id, missing } = await ctx.db.transaction((tx) => toolsConfig.insertHttpTool(tx, ctx, { ...input, secrets: {} }, { allowMissingSecrets: true }))
      return { message: `已建好工具 ${id}${secretsHint(missing)}`, link: { page: "tools", params: { id } }, output: { id, missingSecrets: missing } }
    },
  }),
  update_http_tool: write({
    description:
      "修改 HTTP 接口工具：只传要改的字段（name、description、summary、http 整个请求、risk）。改了模板没传 http.params 时，原来同名参数的设置沿用、新参数按模板推；传了就要和模板里的 {名字} 一一对应",
    input: httpUpdate,
    label: (input) => `修改工具 ${str(input.id)}`,
    prepare: async (ctx, input, given) => {
      need(ctx, "config.manage", {}, "修改工具只有主管能做")
      const tool = await loadHttpTool(ctx, input.id)
      const { before, merged: after } = mergeHttpUpdate(tool, input, given)
      const { missing } = await checkHttp(ctx, after.http)
      const fields = await changedFields(before, after, given, { name: "名字", description: "说明", summary: "一句话", http: "请求", risk: "风险" }, (key, value) => {
        if (key === "risk") return riskText(value as typeof tool.risk)
        if (key === "http") {
          const http = value as typeof before.http
          return [`${http.method} ${http.url}`, ...Object.entries(http.headers ?? {}).map(([name, header]) => `${name}: ${header}`), http.body ? `请求体：${http.body}` : "", http.params?.length ? `参数：${paramsText(http.params)}` : ""].filter(Boolean).join("\n")
        }
        return str(value)
      })
      if (fields.length === 0) throw new ToolError("给的字段和现在一样，没有要改的")
      if (missing.length) fields.push({ label: "还要到工具页填的密钥", after: missing.join("、") })
      return { title: `修改 HTTP 工具 ${tool.id}「${clip(tool.name, 40)}」`, fields }
    },
    apply: async (ctx, input, given) => {
      const tool = await loadHttpTool(ctx, input.id)
      const { merged } = mergeHttpUpdate(tool, input, given)
      const { missing } = await toolsConfig.updateHttpTool(ctx, { ...merged, id: tool.id, secrets: {} }, { allowMissingSecrets: true })
      return { message: `已改好工具 ${tool.id}${secretsHint(missing)}`, link: { page: "tools", params: { id: tool.id } }, output: { id: tool.id, missingSecrets: missing } }
    },
  }),
  create_mcp_server: write({
    description: "新建 MCP 服务器（只有主管能建）。env 是环境变量（stdio）或请求头（http），值只能引用已存的全局密钥名字；建好后要人到工具页「连接并读取工具」",
    input: mcpCreate,
    label: (input) => `新建 MCP 服务器「${clip(str(input.name), 30)}」`,
    prepare: async (ctx, input) => {
      need(ctx, "config.manage", {}, "新建 MCP 服务器只有主管能做")
      const fields = checkMcp(input)
      const missing = await missingSecrets(ctx, input.env.map((each) => each.secret))
      return {
        title: `新建 MCP 服务器「${clip(input.name, 40)}」`,
        fields: [
          { label: "名字", after: input.name },
          { label: "连接方式", after: input.transport === "stdio" ? "本机启动（stdio）" : "HTTP" },
          { label: input.transport === "stdio" ? "启动命令" : "地址", after: fields.target },
          ...(input.env.length ? [{ label: input.transport === "stdio" ? "环境变量" : "请求头", after: input.env.map((each) => `${each.name} = {{${each.secret}}}`).join("\n") }] : []),
          ...(input.note ? [{ label: "备注", after: input.note }] : []),
          ...(missing.length ? [{ label: "还要到工具页填的密钥", after: missing.join("、") }] : []),
        ],
      }
    },
    apply: async (ctx, input) => {
      checkMcp(input)
      const missing = await missingSecrets(ctx, input.env.map((each) => each.secret))
      const { id } = await toolsConfig.createMcpServer(ctx, { ...input, env: input.env.map((each) => ({ name: each.name, value: `{{${each.secret}}}` })) })
      return { message: `已建好 MCP 服务器 ${id}，到「工具」页连接并勾选要用的工具${secretsHint(missing)}`, link: { page: "tools", params: { id } }, output: { id, missingSecrets: missing } }
    },
  }),
  update_mcp_server: write({
    description: "修改 MCP 服务器：只传要改的字段。env 给了就是完整的新列表：每项不带 secret 表示保留已存的值，带 secret 表示改成引用这个全局密钥",
    input: mcpUpdate,
    label: (input) => `修改 MCP 服务器 ${str(input.id)}`,
    prepare: async (ctx, input, given) => {
      need(ctx, "config.manage", {}, "修改 MCP 服务器只有主管能做")
      const { before, after } = await mergeMcp(ctx, input, given)
      const fields = await changedFields(
        { ...before, env: before.env.map((each) => each.name).join("、") },
        { ...after, env: given.has("env") ? (input.env ?? []).map((each) => (each.secret ? `${each.name} = {{${each.secret}}}` : `${each.name}（保留原来的值）`)).join("、") : before.env.map((each) => each.name).join("、") },
        given,
        { name: "名字", transport: "连接方式", command: "启动命令", url: "地址", note: "备注", env: "环境变量 / 请求头" },
        (_, value) => str(value)
      )
      if (fields.length === 0) throw new ToolError("给的字段和现在一样，没有要改的")
      const missing = await missingSecrets(ctx, (input.env ?? []).flatMap((each) => (each.secret ? [each.secret] : [])))
      if (missing.length) fields.push({ label: "还要到工具页填的密钥", after: missing.join("、") })
      return { title: `修改 MCP 服务器 ${before.id}「${clip(before.name, 40)}」`, fields }
    },
    apply: async (ctx, input, given) => {
      const { after } = await mergeMcp(ctx, input, given)
      await toolsConfig.updateMcpServer(ctx, after)
      const missing = await missingSecrets(ctx, (input.env ?? []).flatMap((each) => (each.secret ? [each.secret] : [])))
      return { message: `已改好 MCP 服务器 ${after.id}${secretsHint(missing)}`, link: { page: "tools", params: { id: after.id } }, output: { id: after.id, missingSecrets: missing } }
    },
  }),
}

async function loadTaskMemoryEntry(ctx: ToolCtx, id: number) {
  const [row] = await ctx.db.select().from(t.taskMemoryEntries).where(eq(t.taskMemoryEntries.id, id))
  if (!row) throw new ToolError(`找不到任务记忆 ${id}，先用 list_task_memory 查编号`)
  return row
}

async function reviewableMemory(ctx: ToolCtx, id: string) {
  const row = await loadMemory(ctx, id)
  if (row.status !== "pending") throw new ToolError(`记忆 ${row.id} 不是待审核的（现在是 ${row.status}）`)
  need(ctx, "humanItem.resolve", { assigneeId: row.reviewerId ?? "" }, "这条记忆不是分给你审核的")
  return row
}

type HttpTool = Awaited<ReturnType<typeof loadHttpTool>>

/**
 * 改 HTTP 工具：改前的值 + 合进这次给的字段。改了模板但没给参数清单，就拿原来的清单当底子按新模板重建
 * （同名参数的类型、必填、说明沿用，新参数按模板推），交给保存的是一份和模板对得上的清单
 */
function mergeHttpUpdate(tool: HttpTool, input: z.output<typeof httpUpdate>, given: Set<string>) {
  const spec = tool.http!
  const before = { name: tool.name, description: tool.description, summary: tool.summary, http: { method: spec.method, url: spec.url, headers: spec.headers ?? {}, body: spec.body, params: httpParamsOf(spec) }, risk: tool.risk }
  const merged = check(httpFields, { ...before, ...pick(input, given) })
  if (given.has("http") && !input.http?.params) merged.http.params = syncHttpParams(merged.http, before.http.params).params
  return { before, merged }
}

/** 参数清单给人看：名字（类型、选填、没传就去掉） */
const paramsText = (params: HttpParam[]) =>
  params.map((param) => `${param.name}（${[param.type === "json" ? "JSON" : "文本", param.required ? "" : param.omitIfAbsent ? "可不填，没传就去掉" : "可不填"].filter(Boolean).join("，")}）`).join("、")

/** HTTP 模板：有明文密钥不进卡；参数清单对不上模板、JSON 请求体模板不对的也不进卡；引用了还没存值的密钥照建，提醒人去填 */
async function checkHttp(ctx: ToolCtx, http: z.output<typeof httpFields>["http"]) {
  const headers = Object.entries(http.headers ?? {})
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")
  if (moveSecrets({ url: http.url, headers, body: http.body ?? "" }).moved.length)
    throw new ToolError("模板里有明文密钥，不能写进去。改成 {{名字}}，让人到「工具」页填值")
  const { secrets } = templatePlaceholders(`${http.url} ${headers} ${http.body ?? ""}`)
  const invalid = secrets.filter((name) => !secretNameSchema.safeParse(name).success)
  if (invalid.length) throw new ToolError(`密钥名只能用大写字母、数字和下划线（NOTIFY_ 开头的留给通知渠道）：${invalid.join("、")}（模型填的参数用一层花括号 {名字}，两层 {{名字}} 是密钥）`)
  const headersMap = http.headers ?? {}
  const params = toolsConfig.httpParamsFor({ ...http, headers: headersMap })
  return { http: { ...http, headers: headersMap, params }, missing: await missingSecrets(ctx, secrets) }
}

function checkMcp(input: { transport: "stdio" | "http"; command?: string; url?: string; name: string; note?: string; env: { name: string; secret?: string }[] }) {
  const parsed = mcpServerInputSchema.safeParse({ ...input, env: input.env.map((each) => ({ name: each.name, value: each.secret ? `{{${each.secret}}}` : undefined })) })
  if (!parsed.success) throw new ToolError(`字段不对：${issuesText(parsed.error)}`)
  const target = (input.transport === "stdio" ? input.command : input.url) ?? ""
  if (hasPlainSecret(target)) throw new ToolError(`${input.transport === "stdio" ? "启动命令" : "地址"}里有明文密钥，不能直接写。放进 env 引用全局密钥`)
  return { target }
}

/** MCP 服务器现在的样子 + 这次给的 → updateMcpServer 的完整输入 */
async function mergeMcp(ctx: ToolCtx, input: z.output<typeof mcpUpdate>, given: Set<string>) {
  const [row] = await ctx.db.select().from(t.mcpServers).where(eq(t.mcpServers.id, input.id))
  if (!row) throw new ToolError(`找不到 MCP 服务器 ${input.id}，先用 list_tools 查编号`)
  const before = { id: row.id, name: row.name, transport: row.transport, command: row.command ?? undefined, url: row.url ?? undefined, note: row.note, env: row.envKeys.map((name) => ({ name })) }
  const next = { ...before, ...pick(input, given) }
  const transportChanged = next.transport !== row.transport
  let env: { name: string; value?: string }[]
  if (given.has("env")) env = (input.env ?? []).map((each) => ({ name: each.name, ...(each.secret ? { value: `{{${each.secret}}}` } : {}) }))
  else env = before.env
  // 换了连接方式，原来存的值对不上了（data/config 会删掉），每项都要重新引用密钥
  const keep = env.filter((each) => !each.value)
  if (keep.some((each) => transportChanged || !row.envKeys.includes(each.name)))
    throw new ToolError(`这些${next.transport === "stdio" ? "环境变量" : "请求头"}没有已存的值，要带 secret 引用一个全局密钥：${keep.filter((each) => transportChanged || !row.envKeys.includes(each.name)).map((each) => each.name).join("、")}`)
  checkMcp({ ...next, env: env.map((each) => ({ name: each.name, secret: each.value ? each.value.slice(2, -2) : undefined })) })
  const after = { id: row.id, name: next.name, transport: next.transport, command: next.transport === "stdio" ? next.command : undefined, url: next.transport === "http" ? next.url : undefined, note: next.note ?? "", env }
  return { before, after }
}

// ---------- 给 run.ts / store.ts 用 ----------

export const isReadTool = (name: string) => TOOLS[name]?.kind === "read"

/** 看图的工具：结果里的图由 run.ts 读出来，接在工具结果后面发给模型 */
export const VIEW_IMAGE = "view_image"
/** 读文本文件的工具：结果是分好段的文字，run.ts 不再按 JSON 截 */
export const READ_FILE = "read_file"

/** Trace 上显示的中文；不认识的工具照原名 */
export function toolLabel(name: string, input: unknown): string {
  const def = TOOLS[name]
  if (!def) return name
  try {
    return def.label((input && typeof input === "object" ? input : {}) as Record<string, unknown>)
  } catch {
    return name
  }
}

/** 模型给的输入：zod 校验 + 记下给了哪些字段（update_* 只改给了的） */
export function parseToolInput(def: ToolDef, raw: unknown): { ok: true; input: unknown; given: Set<string> } | { ok: false; error: string } {
  const parsed = def.input.safeParse(raw ?? {})
  if (!parsed.success) return { ok: false, error: `参数不对：${issuesText(parsed.error)}` }
  const given = new Set(raw && typeof raw === "object" ? Object.keys(raw).filter((key) => (raw as Record<string, unknown>)[key] !== undefined) : [])
  return { ok: true, input: parsed.data, given }
}
