// 派活（2026-10-18，第一期）：一个任务的 agent（或人）把一件件事派给另一个任务，一件事一张「派活单」，
// 平台按被派任务的名额一张单开一次运行，办完把结果写回单上。同一个任务下同一个去重键只办一次。
// 方案：docs/dev/dispatch.md（用户 2026-10-18 确认，第 15 节全部按建议）；开发说明：docs/dev/dispatch-p1.md；
// 设计稿：design/BRIEF-dispatch.md（本地）。平台通用：这里不出现任何业务。
// 第三期「对外」（docs/dev/dispatch-p3.md）：外部系统用 HTTP 接口派活（via = api）、外部事件自动派单（via = event）、
// 任务每天的花费上限、单的优先级、「过多久再办」（not_before）。
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

// ---------- 第三期：优先级、过多久再办 ----------

/** 单的优先级（第三期）：同一个任务排队的单，先领高的，同一级按派进来的先后。只影响这个任务自己的排队，不跨任务 */
export const workPrioritySchema = z.enum(["high", "normal", "low"])
export type WorkPriority = z.infer<typeof workPrioritySchema>
export const workPriorityLabel: Record<WorkPriority, string> = { high: "高", normal: "普通", low: "低" }
/** 库里存的数（work_items.priority）：领单按它从大到小 */
export const WORK_PRIORITY_RANK: Record<WorkPriority, number> = { high: 1, normal: 0, low: -1 }
export const workPriorityOf = (rank: number): WorkPriority => (rank > 0 ? "high" : rank < 0 ? "low" : "normal")

/** 「过多久再办」最长 30 天（分钟） */
export const WORK_DELAY_MAX_MINUTES = 30 * 24 * 60
/** 过多久再办（分钟）：0 = 马上 */
export const workDelayMinutesSchema = z.number().int().min(0).max(WORK_DELAY_MAX_MINUTES, "最多 30 天以后")

/** 到什么时候才领：给了 notBefore（带时区的时间）按它，给了 delayMinutes 按现在往后推；不晚于现在的返回 null（马上） */
export function workNotBefore(input: { notBefore?: string | null; delayMinutes?: number | null }, now = new Date()): Date | null {
  const at = input.notBefore ? new Date(input.notBefore) : input.delayMinutes ? new Date(now.getTime() + input.delayMinutes * 60_000) : null
  return at && Number.isFinite(at.getTime()) && at.getTime() > now.getTime() ? at : null
}

// ---------- 第三期：外部事件自动派单 ----------

/**
 * 平台自己用的事件名前缀：外部事件不能用（派活方等结果、等浏览器、等桌面、等子 agent，这些由系统自己叫醒，不经过外部事件接口）。
 * 任务上「收到事件就派一张」保存时拒；外部事件接口（POST /api/events）和控制台手动触发也拒（docs/dev/sub-agents.md 第 12 节第 2 条）
 */
export const RESERVED_EVENT_PREFIXES = ["work.done:", "browser.", "desktop:", "subagent."] as const

/** 每种保留前缀是平台拿来等什么的（拒绝时说清原因） */
export const reservedEventPurpose: Record<(typeof RESERVED_EVENT_PREFIXES)[number], string> = {
  "work.done:": "派活方等派出去的单结束",
  "browser.": "运行等浏览器空出来",
  "desktop:": "运行等桌面空出来",
  "subagent.": "运行等子 agent 办完",
}

/** 事件名用了哪个保留前缀；没用返回 null */
export const reservedEventPrefix = (name: string) => RESERVED_EVENT_PREFIXES.find((prefix) => name.startsWith(prefix)) ?? null

/**
 * 被派任务上的一条「收到事件就派一张」：外部系统 POST /api/events（或主管在控制台手动触发）的事件名完全一样（区分大小写）时，
 * 从事件数据里取参数派一张单（via = event）。例子：外部系统 X 每来一个订单号就发一次事件 order.created，数据 { "orderNo": "…" }
 */
export const taskDispatchEventSchema = z.object({
  event: z
    .string()
    .trim()
    .min(1, "写事件名")
    .max(200, "事件名最多 200 个字")
    .refine((name) => !RESERVED_EVENT_PREFIXES.some((prefix) => name.startsWith(prefix)), "这个前缀是平台自己用的，换个事件名"),
  /**
   * 参数从事件数据的哪里取：参数名 → 路径（"orderNo"、"order.id"、"items.0.sku"，数字取数组的第几个，从 0 开始）。
   * 没写（或写空）的参数取数据里和参数同名的顶层字段
   */
  params: z.record(z.string(), z.string().trim().max(200, "路径最多 200 个字")).optional(),
  /** 任务没有标「去重」的参数时：去重键取数据里的哪个字段（必填，同一件事每次一样）；有去重参数时按参数算，这一项不看 */
  keyPath: z.string().trim().max(200, "路径最多 200 个字").optional(),
  /** 这样派来的单的优先级；不写 = 普通 */
  priority: workPrioritySchema.optional(),
  /** 收到事件过多久再办（分钟）；不写 = 马上 */
  delayMinutes: workDelayMinutesSchema.optional(),
})
export type TaskDispatchEvent = z.infer<typeof taskDispatchEventSchema>

/** 一个任务最多配几条「收到事件就派一张」 */
export const WORK_EVENT_BINDINGS_MAX = 10

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
    /** 第三期：外部系统能用 API 密钥派活给它（POST /api/work-items）。不写 = 不能 */
    allowApi: z.boolean().optional(),
    /** 第三期：收到外部事件就派一张。不写 = 没有 */
    events: z.array(taskDispatchEventSchema).max(WORK_EVENT_BINDINGS_MAX, `最多 ${WORK_EVENT_BINDINGS_MAX} 个事件`).optional(),
    /**
     * 第三期：被派来的运行每天（上海时间）加起来最多花多少美元。到了就不再开新的运行，排队的单留到第二天 0 点以后接着办；
     * 已经在跑的不停（每次运行自己还有设置里的花费上限）。null / 不写 = 不限
     */
    dailyBudgetUsd: z.number().min(0.01, "最少 0.01 美元").max(10000, "最多 10000 美元").nullable().optional(),
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
    // 第三期：事件名不重复；参数映射只能写声明了的参数；没有去重参数时要写 keyPath
    const events = new Set<string>()
    const hasDedupe = value.params.some((param) => param.dedupe)
    value.events?.forEach((binding, index) => {
      if (events.has(binding.event)) ctx.addIssue({ code: "custom", path: ["events", index, "event"], message: `事件「${binding.event}」重复了` })
      events.add(binding.event)
      const unknown = Object.keys(binding.params ?? {}).filter((name) => !seen.has(name))
      if (unknown.length) ctx.addIssue({ code: "custom", path: ["events", index, "params"], message: `任务没有参数「${unknown.join("」「")}」` })
      if (!hasDedupe && !binding.keyPath) ctx.addIssue({ code: "custom", path: ["events", index, "keyPath"], message: "任务没有标「去重」的参数，要写去重键从事件数据的哪个字段取" })
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

/** 谁派的：agent（哪个任务的哪次运行）、人（任务详情「派一张」）、api（外部系统用 API 密钥，第三期）、event（外部事件，第三期） */
export const workViaSchema = z.enum(["agent", "human", "api", "event"])
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
  /** 优先级（第三期）：同一个任务排队的单先领高的 */
  priority: workPrioritySchema,
  fromTaskId: z.string().nullable(),
  fromTaskTitle: z.string().nullable(),
  fromSessionId: z.string().nullable(),
  /** 人派的：谁；API 密钥派的：密钥的创建人（权限、审计按他算） */
  fromUserId: z.string().nullable(),
  /** via = api（第三期）：哪把 API 密钥、叫什么；密钥删了以后都是 null */
  apiKeyId: z.string().nullable(),
  apiKeyName: z.string().nullable(),
  /** via = event（第三期）：哪个事件派来的 */
  fromEvent: z.string().nullable(),
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
  /**
   * 排队时到这个时间才会领；不等为 null。两种来源：等自动重试（第二期，autoRetries > 0）、
   * 派的时候说了「过多久再办」（第三期，autoRetries = 0），见 workWaitKind
   */
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
  /** 按页码翻（会话页「排队中」）：跳过前面几张；给了就不看 cursor */
  offset: z.number().int().min(0).optional(),
  /** 第三期：按去重键精确找（外部系统用自己的编号查单；一般和 taskId 一起给） */
  key: z.string().trim().max(200).optional(),
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
  /** 第三期：今天（上海时间）被派来的运行一共花了多少美元（按运行开始的日子算）、每天的上限（null = 不限） */
  spentTodayUsd: z.number(),
  dailyBudgetUsd: z.number().nullable(),
})
export type WorkTaskStats = z.infer<typeof workTaskStatsSchema>

/**
 * 被派任务的名额和排队（work.queueStats，一次给全部）：能被派活的任务，加上还有没结束的单的任务（关了被派活、单还留着的）。
 * 任务页卡片上的「排队 3 · 在办 2」、会话页「排队中」的「在等什么」用
 */
export const workQueueStatsSchema = z.object({
  taskId: z.string(),
  enabled: z.boolean(),
  /** 现在还开着「可以被派活」 */
  dispatchable: z.boolean(),
  /** 同时最多几个在跑；关了被派活的为 0 */
  maxRunning: z.number().int(),
  queued: z.number().int(),
  running: z.number().int(),
  /** 现在占着名额的运行数（同 work.taskStats） */
  occupied: z.number().int(),
  /** 占着名额的运行编号，先开始的在前 */
  holders: z.array(z.string()),
  /** 第三期：同 workTaskStatsSchema。spentTodayUsd >= dailyBudgetUsd 时今天不再开新的运行 */
  spentTodayUsd: z.number(),
  dailyBudgetUsd: z.number().nullable(),
})
export type WorkQueueStats = z.infer<typeof workQueueStatsSchema>

/** 人手动「派一张」（任务详情里） */
export const workDispatchInputSchema = z.object({
  taskId: z.string().min(1, "选一个任务"),
  params: z.record(z.string(), z.string().trim().max(2000)),
  /** 不写就用「参数名 值」（第一个去重参数，没有就第一个参数） */
  title: z.string().trim().max(120).optional(),
  note: z.string().trim().max(1000).optional(),
  /** 第三期：优先级（不写 = 普通）、过多久再办（分钟，不写或 0 = 马上） */
  priority: workPrioritySchema.optional(),
  delayMinutes: workDelayMinutesSchema.optional(),
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
  /** 第三期：改优先级；改「什么时候办」：从现在起过多久（分钟），0 = 马上；不写 = 不改。等自动重试的单不能改时间 */
  priority: workPrioritySchema.optional(),
  delayMinutes: workDelayMinutesSchema.optional(),
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

/**
 * 排队的单为什么还没领（第三期）：retry = 运行出错、等自动重试；scheduled = 派的时候说了过多久再办；
 * null = 没在等时间（notBefore 为空或已经到点）
 */
export function workWaitKind(item: Pick<WorkItem, "status" | "notBefore" | "autoRetries">, now = new Date()): "retry" | "scheduled" | null {
  if (item.status !== "queued" || !item.notBefore || Date.parse(item.notBefore) <= now.getTime()) return null
  return item.autoRetries > 0 ? "retry" : "scheduled"
}

// ---------- 第三期：外部事件 → 一张单（纯函数，后端派单、页面「试一下」共用） ----------

/** 按路径取事件数据里的值："a.b.c"，数字段取数组的第几个（从 0 开始）；取不到返回 undefined */
export function readEventPath(data: unknown, path: string): unknown {
  let current: unknown = data
  for (const part of path.split(".")) {
    if (part === "") return undefined
    if (Array.isArray(current)) {
      if (!/^\d+$/.test(part)) return undefined
      current = current[Number(part)]
    } else if (current && typeof current === "object" && Object.hasOwn(current, part)) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }
  return current
}

/** 一个参数值最多多少字（同人派、接口派） */
export const WORK_PARAM_MAX_CHARS = 2000

/** 事件数据（或接口传来）的值变成参数的文字：文字去首尾空白，数字、是否转成文字，对象、数组转成 JSON，null / 没有是空串。超长截断 */
export function eventValueText(value: unknown): string {
  if (value === null || value === undefined) return ""
  const text = typeof value === "string" ? value.trim() : typeof value === "number" || typeof value === "boolean" ? String(value) : JSON.stringify(value)
  return text.slice(0, WORK_PARAM_MAX_CHARS)
}

/**
 * 按「收到事件就派一张」的配置，从事件数据里取出一张单：参数（没写路径的取同名顶层字段）、去重键、默认标题。
 * 缺必填参数、去重参数是空的、没有去重参数时 keyPath 取不到值：返回 problem（给人看，会写进事件接口的返回和通知）
 */
export function workItemFromEvent(
  dispatch: Pick<TaskDispatch, "params">,
  binding: Pick<TaskDispatchEvent, "params" | "keyPath">,
  data: Record<string, unknown>
): { params: Record<string, string>; key: string; title: string } | { problem: string } {
  const pathOf = (name: string) => binding.params?.[name]?.trim() || name
  const params: Record<string, string> = {}
  for (const param of dispatch.params) {
    const value = eventValueText(readEventPath(data, pathOf(param.name)))
    if (value) params[param.name] = value
  }
  const missing = dispatch.params.filter((param) => (param.required || param.dedupe) && !params[param.name])
  if (missing.length) return { problem: missing.map((param) => `事件数据里没有「${pathOf(param.name)}」（参数「${param.name}」从这里取）`).join("；") }
  const dedupeKey = workDedupeKey(dispatch, params)
  const key = dedupeKey ?? (binding.keyPath ? eventValueText(readEventPath(data, binding.keyPath)) : "")
  if (!key) return { problem: binding.keyPath ? `事件数据里没有「${binding.keyPath}」（去重键从这里取）` : "任务没有标「去重」的参数，也没写去重键从事件数据的哪个字段取" }
  return { params, key: key.slice(0, 200), title: workDefaultTitle(dispatch, params) }
}

// ---------- 第三期：对外 HTTP 接口（/api/work-items，API 密钥或登录的 cookie） ----------

/** 外部系统传的参数值：文字、数字、是否都行（存成文字，见 eventValueText），null = 没填 */
export const workApiParamValueSchema = z.union([z.string().max(WORK_PARAM_MAX_CHARS), z.number(), z.boolean(), z.null()])

/** POST /api/work-items 的内容 */
export const workApiCreateInputSchema = z
  .object({
    /** 派给哪个任务（任务 id，例如 T-1042）。任务要开着「可以被派活」，用 API 密钥时还要开着「外部系统能派活」 */
    task: z.string().trim().min(1, "写任务 id，例如 T-1042"),
    params: z.record(z.string(), workApiParamValueSchema).default({}),
    /** 不写用默认标题（「参数名 值」） */
    title: z.string().trim().max(120).optional(),
    note: z.string().trim().max(1000).optional(),
    /** 去重键：任务没有标「去重」的参数时必填（也认请求头 Idempotency-Key），同一件事每次一样；有去重参数时按参数算，这一项不看 */
    key: z.string().trim().min(1).max(200).optional(),
    priority: workPrioritySchema.optional(),
    /** 什么时候以后才办：带时区的时间（例如 2026-10-28T18:00:00+08:00）；和 delayMinutes 只给一个 */
    notBefore: z.iso.datetime({ offset: true, message: "notBefore 要是带时区的时间，例如 2026-10-28T18:00:00+08:00" }).optional(),
    delayMinutes: workDelayMinutesSchema.optional(),
    /** 同一件事已经有单了：skip = 不动（默认）；update = 还在排队的话用这次的参数、标题、补充、优先级、时间覆盖 */
    ifExists: z.enum(["skip", "update"]).optional(),
  })
  .refine((value) => value.notBefore === undefined || value.delayMinutes === undefined, { message: "notBefore 和 delayMinutes 只给一个", path: ["delayMinutes"] })
export type WorkApiCreateInput = z.infer<typeof workApiCreateInputSchema>

/** POST /api/work-items 的返回：新建的 201（existing = false），同一件事已经有单的 200（existing = true，不会重开） */
export const workApiCreateResultSchema = z.object({
  item: workItemSchema,
  existing: z.boolean(),
  /** ifExists = update 时排队的单被改了 */
  updated: z.boolean(),
  /** 控制台里看这张单的完整地址（<base>/#/tasks?id=…&work=…） */
  link: z.string(),
  /** 一句提醒（没有就不写）：任务停用了先排着、今天的花费到了上限明天接着办、定在什么时候以后办 */
  notice: z.string().optional(),
})
export type WorkApiCreateResult = z.infer<typeof workApiCreateResultSchema>

/** GET /api/work-items 的查询串：按任务、去重键、状态找，新派的在前（不限天数） */
export const workApiListQuerySchema = z.object({
  task: z.string().trim().min(1).optional(),
  key: z.string().trim().min(1).max(200).optional(),
  status: workItemStatusSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  /** 上一页的 nextCursor */
  cursor: z.string().optional(),
})
export const workApiListResultSchema = z.object({ items: z.array(workItemSchema), nextCursor: z.string().nullable() })
export type WorkApiListResult = z.infer<typeof workApiListResultSchema>

/** POST /api/work-items/:id/cancel 的内容 */
export const workApiCancelInputSchema = z.object({ reason: z.string().trim().max(500).optional() })
