// 派活（2026-10-18，第一期）：一个任务的 agent（或人）把一件件事派给另一个任务，一件事一张「派活单」，
// 平台按被派任务的名额一张单开一次运行，办完把结果写回单上。同一个任务下同一个去重键只办一次。
// 方案：docs/dev/dispatch.md（用户 2026-10-18 确认，第 15 节全部按建议）；开发说明：docs/dev/dispatch-p1.md；
// 设计稿：design/BRIEF-dispatch.md（本地）。平台通用：这里不出现任何业务。
import { z } from "zod"

import { isoTime, runOutcomeSchema, runStatusSchema, type RunOutcome } from "./schemas.js"

/** 内置工具「派活」的 id（模型看到的名字是 work_dispatch） */
export const WORK_DISPATCH_TOOL_ID = "work.dispatch"

/** 内置工具「查派过的活」「报结果」的 id（第二期）：前者跟着「派活」自动带上，后者在被派来的运行里自动带上 */
export const WORK_LIST_TOOL_ID = "work.list"
export const WORK_REPORT_TOOL_ID = "work.report"

/** 派活方等结果的事件名：单最终结束（办完 / 没办成 / 不办了）时叫醒等它的运行（第二期） */
export const workDoneEvent = (itemId: string) => `work.done:${itemId}`
export const WORK_DONE_EVENT_PREFIX = "work.done:"

/** 自动重试的默认间隔（分钟） */
export const WORK_RETRY_DELAY_DEFAULT = 10

/** 一次 work.dispatch 最多派几张 */
export const WORK_DISPATCH_BATCH_MAX = 50

/** 派活页默认只列最近几天派的（再往前翻页或搜索） */
export const WORK_LIST_DEFAULT_DAYS = 7

// ---------- 被派任务上的配置（tasks.dispatch） ----------

export const taskDispatchParamSchema = z.object({
  /** 参数名，中文也行，例如「单号」 */
  name: z.string().trim().min(1, "写参数名，例如「单号」").max(40, "参数名最多 40 个字"),
  /** 给派活的 agent / 人看：填什么 */
  description: z.string().trim().max(200, "说明最多 200 个字").default(""),
  required: z.boolean().default(false),
  /** 参与去重键：标了的参数按声明顺序取值，用「|」连起来 */
  dedupe: z.boolean().default(false),
})
export type TaskDispatchParam = z.infer<typeof taskDispatchParamSchema>

/** 要交回的结果（run-outcome 6.1）：被派来的运行用 work.report 交；必填的没交，单记没办成（missing_result） */
export const taskDispatchResultSchema = z.object({
  name: z.string().trim().min(1, "写结果名，例如「价格」").max(40, "结果名最多 40 个字"),
  description: z.string().trim().max(200, "说明最多 200 个字").default(""),
  required: z.boolean().default(true),
})
export type TaskDispatchResult = z.infer<typeof taskDispatchResultSchema>

export const taskDispatchSchema = z
  .object({
    params: z.array(taskDispatchParamSchema).max(20, "最多 20 个参数"),
    /** 要交回的结果；旧数据没有 = 不要求 */
    results: z.array(taskDispatchResultSchema).max(20, "最多 20 个结果").default([]),
    /** 同时最多几个在跑（名额）：执行中、验收中、等浏览器的占名额；agent 自己挂起、等人处理不占 */
    maxRunning: z.number().int().min(1, "至少 1 个").max(20, "最多 20 个").default(1),
    /** 没办成自动重试几次（第二期）：只对运行出错重试，人取消、人选不继续、agent 报办不成、规则让它失败的不重试。不写 = 0（旧数据没有） */
    retries: z.number().int().min(0).max(5, "最多重试 5 次").optional(),
    /** 隔多久再试（分钟）；不写 = WORK_RETRY_DELAY_DEFAULT */
    retryDelayMinutes: z.number().int().min(1).max(1440, "最多隔 24 小时").optional(),
  })
  .superRefine((value, ctx) => {
    const seen = new Set<string>()
    value.params.forEach((param, index) => {
      if (seen.has(param.name)) ctx.addIssue({ code: "custom", path: ["params", index, "name"], message: `参数「${param.name}」重复了` })
      seen.add(param.name)
    })
    const results = new Set<string>()
    value.results.forEach((result, index) => {
      if (results.has(result.name)) ctx.addIssue({ code: "custom", path: ["results", index, "name"], message: `结果「${result.name}」重复了` })
      results.add(result.name)
    })
  })
export type TaskDispatch = z.infer<typeof taskDispatchSchema>

// ---------- 派活单 ----------

export const workItemStatusSchema = z.enum(["queued", "running", "done", "failed", "cancelled"])
export type WorkItemStatus = z.infer<typeof workItemStatusSchema>
export const workItemStatusLabel: Record<WorkItemStatus, string> = {
  queued: "排队",
  running: "在办",
  done: "办完",
  failed: "没办成",
  cancelled: "不办了",
}

/**
 * 单的结果（派活页按它分「办成」「没办成」）：结束了的单按单上记的结果（负责人改过结果的，状态不变、结果跟着改）；
 * 旧单没记结果的，办完算办成、没办成和不办了算没办成；排队、在办的还没有结果。和 work/service.ts 里的 SQL 一致
 */
export function workItemOutcome(item: { status: WorkItemStatus; outcome?: RunOutcome | null }): RunOutcome | null {
  if (item.status === "queued" || item.status === "running") return null
  return item.outcome ?? (item.status === "done" ? "achieved" : "not_achieved")
}

/** 谁派的：agent（哪个任务的哪次运行）、人（派活页「派一张」）。第三期加 api */
export const workViaSchema = z.enum(["agent", "human"])
export type WorkVia = z.infer<typeof workViaSchema>

/** 单上的处理记录（派进来、开运行、重办、改参数、不办了），按时间先后 */
export const workLogEntrySchema = z.object({
  at: isoTime,
  /** retry_scheduled：运行出错、排队等自动重试（第二期）；reported：被派的运行用 work.report 报了结果（第二期，同一次运行只记第一次） */
  kind: z.enum(["created", "run_started", "run_ended", "redo", "params_changed", "cancelled", "retry_scheduled", "reported"]),
  /** 人做的：谁 */
  byId: z.string().optional(),
  /** run_started / run_ended：哪次运行 */
  sessionId: z.string().optional(),
  /** 补充：不办了的原因、运行结束的结果（done / failed）、重试的原因等 */
  note: z.string().optional(),
  /** retry_scheduled：这是第几次自动重试（从 1 开始）、什么时候再试 */
  retry: z.number().int().optional(),
  notBefore: isoTime.optional(),
})
export type WorkLogEntry = z.infer<typeof workLogEntrySchema>

/** work.report 的一个值：文字、数字或是 / 否 */
export const workReportValueSchema = z.union([z.string().max(1000), z.number(), z.boolean()])
export type WorkReportValue = z.infer<typeof workReportValueSchema>
/** work.report 一张单最多几个字段 */
export const WORK_REPORT_MAX_FIELDS = 20

/**
 * 没办成的种类（第二期）：error = 运行出错（自动重试用完了，或者不重试的那几种）；
 * not_done = 运行正常结束但没办成（agent 报的、检查点没达成、复核判的）；cancelled_run = 人取消了运行、人选了不继续、人判验收失败；
 * run-outcome 加：missing_result = 必交的结果没交；partial = 部分办成（2026-10-20 起不再写入：部分办成算没办成，记 not_done，枚举值留着给旧数据）。这几种都不重试
 */
export const workFailKindSchema = z.enum(["error", "not_done", "cancelled_run", "partial", "missing_result"])
export type WorkFailKind = z.infer<typeof workFailKindSchema>

/** 结构化结果压成一行：「源商品数=3，后台已回填=是」 */
export function workReportLine(data: Record<string, WorkReportValue> | undefined): string {
  if (!data) return ""
  return Object.entries(data)
    .map(([name, value]) => `${name}=${typeof value === "boolean" ? (value ? "是" : "否") : String(value)}`)
    .join("，")
}

export const workResultSchema = z.object({
  /** agent 最后那段总结（前 2000 字） */
  summary: z.string(),
  /** 有三方验收的：一句话结论 */
  verification: z.string().optional(),
  /** 这次运行存下的产物（session 的文件 id） */
  fileIds: z.array(z.string()),
  /** 被派的运行用 work.report 写的结构化结果（第二期）：字段名 → 值 */
  data: z.record(z.string(), workReportValueSchema).optional(),
})
export type WorkResult = z.infer<typeof workResultSchema>

export const workItemSchema = z.object({
  /** W-<序号> */
  id: z.string(),
  /** 被派的任务 */
  taskId: z.string(),
  taskTitle: z.string(),
  /** 去重键 */
  key: z.string(),
  /** 一句话，给人看的，例如「工单 A-1018-0012」 */
  title: z.string(),
  params: z.record(z.string(), z.string()),
  note: z.string(),
  status: workItemStatusSchema,
  /** 当前（最近一次）在办的运行 */
  sessionId: z.string().nullable(),
  /** 在办时：那次运行此刻的状态（执行中 / 挂起等待 / 等人处理 / 验收中），列表徽章直接写它 */
  sessionStatus: runStatusSchema.nullable(),
  /** 开过几次运行（重办会加 1） */
  attempts: z.number().int(),
  via: workViaSchema,
  fromTaskId: z.string().nullable(),
  fromTaskTitle: z.string().nullable(),
  fromSessionId: z.string().nullable(),
  fromUserId: z.string().nullable(),
  /** 派活的层数（防无限递归） */
  depth: z.number().int(),
  result: workResultSchema.nullable(),
  /** 没办成的原因 / 不办了的原因（给人看）；排队等重试时是上一次出错的原因 */
  error: z.string().nullable(),
  /** 没办成的种类（第二期）；不是没办成为 null */
  failKind: workFailKindSchema.nullable(),
  /** 结果（run-outcome 6.2，跟着最后那次运行的结果）：单结束了才有。办完 = 办成；没办成的单结果也是没办成 */
  outcome: runOutcomeSchema.nullable(),
  outcomeReason: z.string().nullable(),
  /** 排队等自动重试：到这个时间才会领（第二期）；不等为 null */
  notBefore: isoTime.nullable(),
  /** 这一轮已经自动重试了几次（人点重办清零） */
  autoRetries: z.number().int(),
  /** 排队时：在这个任务里排第几位（从 1 开始）；不排队为 null */
  queuePosition: z.number().int().nullable(),
  createdAt: isoTime,
  startedAt: isoTime.nullable(),
  finishedAt: isoTime.nullable(),
  updatedAt: isoTime,
})
export type WorkItem = z.infer<typeof workItemSchema>

/** 详情里的一次运行（处理记录） */
export const workRunSchema = z.object({
  sessionId: z.string(),
  status: runStatusSchema,
  outcome: runOutcomeSchema.nullable(),
  startedAt: isoTime,
  endedAt: isoTime.nullable(),
  costUsd: z.number(),
  checkpointsDone: z.number().int(),
  checkpointsTotal: z.number().int(),
  /** 挂起时在等什么 */
  waitingWhat: z.string().nullable(),
  error: z.string().nullable(),
})
export type WorkRun = z.infer<typeof workRunSchema>

export const workItemDetailSchema = workItemSchema.extend({
  log: z.array(workLogEntrySchema),
  /** 每次运行一行，按先后 */
  runs: z.array(workRunSchema),
  /** 被派任务的参数声明（详情里标「去重」、改参数弹窗用）；任务关了被派活时为 null */
  taskDispatch: taskDispatchSchema.nullable(),
  taskEnabled: z.boolean(),
  taskOwnerId: z.string(),
})
export type WorkItemDetail = z.infer<typeof workItemDetailSchema>

// ---------- 接口（tRPC work.*）的输入输出 ----------

export const workListViewSchema = z.enum(["open", "achieved", "not_achieved"])
export type WorkListView = z.infer<typeof workListViewSchema>

export const workListInputSchema = z.object({
  q: z.string().trim().max(200).optional(),
  /** 不填 = 全部；可以给几种（派活页「没办成」= 没办成 + 不办了） */
  status: z.union([workItemStatusSchema, z.array(workItemStatusSchema).min(1)]).optional(),
  /** 结果筛选（run-outcome）：办成 / 没办成，可以给几种 */
  outcome: z.union([runOutcomeSchema, z.array(runOutcomeSchema).min(1)]).optional(),
  /** 派活页的三个标签：没结束（排队 + 在办）、办成、没办成（含出错、不办了）。按单的结果分，见 workItemOutcome */
  view: workListViewSchema.optional(),
  /** 被派的任务 */
  taskId: z.string().optional(),
  /** 派活的任务 / 运行（任务抽屉、运行详情的「派出去的活」） */
  fromTaskId: z.string().optional(),
  fromSessionId: z.string().optional(),
  /** 只列最近几天派的；0 = 不限。搜索（q）时不限天数 */
  days: z.number().int().min(0).max(3650).default(WORK_LIST_DEFAULT_DAYS),
  /** 翻页：上一页最后一张的 id */
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(200).default(50),
})
export type WorkListInput = z.input<typeof workListInputSchema>

export const workCountsSchema = z.object({
  all: z.number().int(),
  queued: z.number().int(),
  running: z.number().int(),
  done: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
  /** 派活页三个标签上的数字（workListViewSchema） */
  open: z.number().int(),
  achieved: z.number().int(),
  notAchieved: z.number().int(),
})

export const workPageSchema = z.object({
  /** 新派的在前 */
  items: z.array(workItemSchema),
  nextCursor: z.string().nullable(),
  /** 同样的筛选条件（不算 status）下各状态有几张，筛选按钮上的数字 */
  counts: workCountsSchema,
})
export type WorkPage = z.infer<typeof workPageSchema>

/** 被派任务的一行数字（任务抽屉、派活页选了任务时列表上面那行） */
export const workTaskStatsSchema = z.object({
  taskId: z.string(),
  queued: z.number().int(),
  running: z.number().int(),
  /** 现在占着名额的运行数（可能超过 maxRunning：被叫醒继续的不卡名额） */
  occupied: z.number().int(),
  maxRunning: z.number().int(),
  doneToday: z.number().int(),
  failed: z.number().int(),
})
export type WorkTaskStats = z.infer<typeof workTaskStatsSchema>

/** 人在派活页「派一张」 */
export const workDispatchInputSchema = z.object({
  taskId: z.string().min(1, "选一个任务"),
  params: z.record(z.string(), z.string().trim().max(2000)),
  /** 不写就用「参数名 值」（第一个去重参数，没有就第一个参数） */
  title: z.string().trim().max(120).optional(),
  note: z.string().trim().max(1000).optional(),
})
export type WorkDispatchInput = z.infer<typeof workDispatchInputSchema>

/** 派一张的结果：新建的单，或者同一件事已经有的那张（existing = true，不会重开） */
export const workDispatchResultSchema = z.object({ item: workItemSchema, existing: z.boolean() })

/** 「派一张」弹窗里填参数时先查：同一件事已经有单了吗 */
export const workLookupInputSchema = z.object({ taskId: z.string().min(1), params: z.record(z.string(), z.string()) })

export const workUpdateParamsInputSchema = z.object({
  id: z.string().min(1),
  /** 只有排队的单能改；去重的参数不能改 */
  params: z.record(z.string(), z.string().trim().max(2000)),
  title: z.string().trim().min(1).max(120).optional(),
  note: z.string().trim().max(1000).optional(),
})
export const workCancelInputSchema = z.object({ id: z.string().min(1), reason: z.string().trim().max(500).optional() })
export const workRedoInputSchema = z.object({ id: z.string().min(1) })

// ---------- 纯函数（前后端共用） ----------

/** 去重键：标了去重的参数按声明顺序取值，用「|」连起来，去掉首尾空白；一个都没标时返回 null（要另给 key） */
export function workDedupeKey(dispatch: Pick<TaskDispatch, "params">, params: Record<string, string>): string | null {
  const keys = dispatch.params.filter((param) => param.dedupe)
  if (keys.length === 0) return null
  return keys.map((param) => (params[param.name] ?? "").trim()).join("|")
}

/** 按声明检查参数：缺必填的、多出没声明的。返回给人 / agent 看的错误；没问题返回 null */
export function workParamsProblem(dispatch: Pick<TaskDispatch, "params">, params: Record<string, string>): string | null {
  const declared = new Set(dispatch.params.map((param) => param.name))
  const extra = Object.keys(params).filter((name) => !declared.has(name))
  if (extra.length) return `对方任务没有参数「${extra.join("」「")}」，要的是：${dispatch.params.map((param) => param.name).join("、") || "（没有参数）"}`
  const missing = dispatch.params.filter((param) => param.required && !(params[param.name] ?? "").trim())
  if (missing.length) return `缺少必填参数「${missing.map((param) => param.name).join("」「")}」`
  return null
}

/** 没写标题时的默认标题：「单号 PSS-…」（第一个去重参数，没有就第一个有值的参数） */
export function workDefaultTitle(dispatch: Pick<TaskDispatch, "params">, params: Record<string, string>): string {
  const pick = dispatch.params.find((param) => param.dedupe && params[param.name]?.trim()) ?? dispatch.params.find((param) => params[param.name]?.trim())
  return pick ? `${pick.name} ${params[pick.name]!.trim()}`.slice(0, 120) : "派活单"
}
