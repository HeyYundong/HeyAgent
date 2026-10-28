// 子 agent（docs/dev/sub-agents.md）：一次运行把几件互相独立的事拆给几个子 agent 同时做。
// 每个子 agent 是同一个任务下的一次子运行（sessions.kind = sub、parent_session_id = 父运行），照父运行冻好的快照做，
// 换成自己的子目标，跑完把结果交回父运行。只一层：子 agent 不能再拆。
// 这里是前后端共用的约定：三个内置工具的输入、快照里的 sub、子运行交回的结果、事件名、名额的判断、运行详情要的数据、从父快照派生子快照。
// 平台通用：只有「运行」「子目标」「结果」这些通用概念，不出现任何业务。
import { z } from "zod"

import type { SessionSnapshot, SnapshotTool } from "./engine.js"
import type { RunOutcomeBy } from "./schemas.js"

// 不从 schemas.ts / engine.ts 引运行时的值：它们要引这里的 schema，互相引用会在模块初始化时拿到未定义的值（同 routine.ts）
const isoTime = z.string()
const runOutcomeSchema = z.enum(["achieved", "not_achieved"])
const runOutcomeBySchema = z.enum(["agent", "rule", "review", "verify", "human"]) satisfies z.ZodType<RunOutcomeBy>

// ---------- 工具 ----------

/** 三个内置工具：「拆给子 agent」在任务里选；「等子 agent」「停掉子 agent」跟着它自动带上（implied） */
export const SUBAGENT_START_TOOL_ID = "subagent.start"
export const SUBAGENT_WAIT_TOOL_ID = "subagent.wait"
export const SUBAGENT_CANCEL_TOOL_ID = "subagent.cancel"
export const SUBAGENT_TOOL_IDS = [SUBAGENT_START_TOOL_ID, SUBAGENT_WAIT_TOOL_ID, SUBAGENT_CANCEL_TOOL_ID] as const

/**
 * 子快照里去掉的工具（5.1）：不能再拆、不能派活（派活归父）、不等很久的事（报没办成交给父决定）、检查点由父 agent 勾。
 * 「派活」「查派过的活」直接写 id（不从 dispatch.ts 引，理由同上）
 */
export const SUBAGENT_DROPPED_TOOL_IDS: readonly string[] = [...SUBAGENT_TOOL_IDS, "work.dispatch", "work.list", "session.wait", "checkpoint.mark"]

/** 子快照里去掉的规则触发（5.1）：「agent 说做完了」（含三方验收）是对整个任务的；「花费超过 X」父按合计算，子 agent 另有上限 */
export const SUBAGENT_DROPPED_RULE_TRIGGERS: readonly string[] = ["agent_done", "cost_over"]

// ---------- 上限（工具输入）和交回文字的长度 ----------

/** 一次 subagent.start 最多拆几个（总数另有设置 subagent.maxPerRun） */
export const SUBAGENT_ITEMS_PER_CALL_MAX = 10
export const SUBAGENT_TITLE_MAX = 80
export const SUBAGENT_GOAL_MAX = 4000
/** input：最多几项、名字和值各多长 */
export const SUBAGENT_INPUT_FIELDS_MAX = 20
export const SUBAGENT_INPUT_NAME_MAX = 40
export const SUBAGENT_INPUT_VALUE_MAX = 4000
/** 给它读的文件最多几个 */
export const SUBAGENT_FILES_MAX = 20
/** 要它交回的字段最多几个、名字多长（和 work.report 的字段名一样最多 40 字） */
export const SUBAGENT_RESULTS_MAX = 10
export const SUBAGENT_RESULT_NAME_MAX = 40
/** subagent.cancel 一次最多停几个、理由多长 */
export const SUBAGENT_CANCEL_IDS_MAX = 20
export const SUBAGENT_CANCEL_REASON_MAX = 500

/** 交回给父的文字（7.3）：每个子 agent 的 summary、evidence 截到多少字，列出它写的前几个文件 */
export const SUBAGENT_SUMMARY_CHARS = 1500
export const SUBAGENT_EVIDENCE_CHARS = 1000
export const SUBAGENT_FILES_LISTED = 20
/** 复核、三方验收的输入里每个子 agent 最多多少字（9.2；总长照复核现在的上限） */
export const SUBAGENT_REVIEW_ITEM_CHARS = 1500

// ---------- 三个工具的输入（engine.ts 的 builtinToolInputs 引这里） ----------

export const subagentItemInputSchema = z.object({
  title: z.string().min(1).max(SUBAGENT_TITLE_MAX).describe("一句话：这个子 agent 做什么（给人看的）"),
  goal: z
    .string()
    .min(1)
    .max(SUBAGENT_GOAL_MAX)
    .describe("要做到什么、怎么算做完、交回什么。子 agent 看不到你的对话和你读过的东西，要写全"),
  input: z
    .record(z.string().min(1).max(SUBAGENT_INPUT_NAME_MAX), z.string().max(SUBAGENT_INPUT_VALUE_MAX))
    .refine((value) => Object.keys(value).length <= SUBAGENT_INPUT_FIELDS_MAX, `input 最多 ${SUBAGENT_INPUT_FIELDS_MAX} 项`)
    .optional()
    .describe(`交给它的数据，例如 { "网址": "…", "关键词": "…" }；最多 ${SUBAGENT_INPUT_FIELDS_MAX} 项`),
  fileIds: z
    .array(z.string().min(1))
    .max(SUBAGENT_FILES_MAX)
    .optional()
    .describe("给它读的文件 id（这次运行空间里的文件、附件，file.list 能看到 id），在它那里只读"),
  results: z
    .array(z.string().min(1).max(SUBAGENT_RESULT_NAME_MAX))
    .max(SUBAGENT_RESULTS_MAX)
    .optional()
    .describe("要它用 work_report 交回的字段名，都算必填；没交的记没办成"),
})
export type SubagentItemInput = z.infer<typeof subagentItemInputSchema>

export const subagentStartInputSchema = z.object({
  items: z
    .array(subagentItemInputSchema)
    .min(1)
    .max(SUBAGENT_ITEMS_PER_CALL_MAX)
    .describe(`要拆出去的事，一件一个子 agent，一次最多 ${SUBAGENT_ITEMS_PER_CALL_MAX} 个`),
})

export const subagentWaitModeSchema = z.enum(["all", "any", "none"])
export type SubagentWaitMode = z.infer<typeof subagentWaitModeSchema>

export const subagentWaitInputSchema = z.object({
  mode: subagentWaitModeSchema
    .optional()
    .describe("all = 等这次运行拆出去的全部结束（默认）；any = 有一个结束就叫醒；none = 不等，只看现状"),
})

export const subagentCancelInputSchema = z.object({
  ids: z
    .array(z.string().min(1))
    .min(1)
    .max(SUBAGENT_CANCEL_IDS_MAX)
    .describe("子运行编号，例如 R-12-3.2"),
  reason: z.string().min(1).max(SUBAGENT_CANCEL_REASON_MAX).describe("为什么停掉（写进子运行的结果原因）"),
})

// ---------- 快照里的 sub（子运行才有） ----------

export const snapshotSubSchema = z.object({
  /** 父运行编号 */
  parentSessionId: z.string(),
  /** 第几个（这次运行里从 1 往上数，补拆的接着数）；编号 = <父运行编号>.<n> */
  n: z.number().int().min(1),
  title: z.string(),
  goal: z.string(),
  input: z.record(z.string(), z.string()),
  /** 要交回的字段名（都必填）；没交的结果记没办成（outcome.ts 的 missing_result，照派活 results 的判断） */
  results: z.array(z.string()),
  /** 拆的时候给它读的文件 id（父运行空间里的、附件）；已经并进快照的 attachments（只读、不挪） */
  fileIds: z.array(z.string()),
})
export type SnapshotSub = z.infer<typeof snapshotSubSchema>

// ---------- 子运行交回的结果（sessions.sub_result） ----------

/** work.report 交的值（同 dispatch.ts 的 WorkReportValue） */
export const subResultValueSchema = z.union([z.string(), z.number(), z.boolean()])
export type SubResultValue = z.infer<typeof subResultValueSchema>

export const subResultSchema = z.object({
  /** run.finish 的 summary（收尾时写） */
  summary: z.string().optional(),
  /** run.finish 的 evidence（收尾时写） */
  evidence: z.string().optional(),
  /** work.report 在子运行里交的字段（合并规则同派活：同名字段以后一次为准） */
  data: z.record(z.string(), subResultValueSchema).optional(),
  /** 交给父运行的时间（叫醒父运行、subagent.wait 直接返回时写）；any 模式下以后再交只写一行「前面给过」 */
  deliveredAt: isoTime.optional(),
})
export type SubResult = z.infer<typeof subResultSchema>

// ---------- 事件名 ----------

/** 子 agent 用的事件名都以它开头；外部事件和控制台不能发（RESERVED_EVENT_PREFIXES 已经有它，派活第三期做的） */
export const SUBAGENT_EVENT_PREFIX = "subagent."
/** 子运行排队：挂起等 subagent.queue:<父运行编号>，subagent.pump 按名额放行（resumeInTx） */
export const SUBAGENT_QUEUE_EVENT_PREFIX = "subagent.queue:"
export const subagentQueueEvent = (parentSessionId: string) => `${SUBAGENT_QUEUE_EVENT_PREFIX}${parentSessionId}`
/** 父运行等子 agent：subagent.all:<父> / subagent.any:<父>，subagent.notify 按 mode 判断条件后叫醒 */
export const subagentWaitEvent = (parentSessionId: string, mode: Exclude<SubagentWaitMode, "none">) => `${SUBAGENT_EVENT_PREFIX}${mode}:${parentSessionId}`
export const SUBAGENT_WAIT_EVENT_PREFIXES = ["subagent.all:", "subagent.any:"] as const

export const isSubagentQueueEvent = (event: string | null | undefined) => Boolean(event?.startsWith(SUBAGENT_QUEUE_EVENT_PREFIX))
export const isSubagentWaitEvent = (event: string | null | undefined) => Boolean(event && SUBAGENT_WAIT_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix)))

/** 父运行编号 + mode（从等待的事件名取回来）；不是父运行等子 agent 的事件返回 null */
export function parseSubagentWaitEvent(event: string | null | undefined): { parentSessionId: string; mode: Exclude<SubagentWaitMode, "none"> } | null {
  for (const mode of ["all", "any"] as const) {
    const prefix = `${SUBAGENT_EVENT_PREFIX}${mode}:`
    if (event?.startsWith(prefix) && event.length > prefix.length) return { parentSessionId: event.slice(prefix.length), mode }
  }
  return null
}

// ---------- 名额：挂起时还占不占 ----------

/** 等资源（Chrome、桌面）的事件前缀：挂起等它们照样占名额，派活和子 agent 都这样算 */
export const RESOURCE_WAIT_EVENT_PREFIXES = ["browser.", "desktop:"] as const
export const isResourceWaitEvent = (event: string | null | undefined) => Boolean(event && RESOURCE_WAIT_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix)))

/**
 * 被派的运行挂起等这个事件时，还占不占派活名额（第 12 节第 4 条）：等浏览器、等桌面、等子 agent 都占。
 * waits.ts 的 suspendInTx（占着就不发 work.pump）和 work/service.ts 的 occupiesSlotSql 都按这一份（SQL 那边按 DISPATCH_SLOT_EVENT_PREFIXES 写 like）
 */
export const DISPATCH_SLOT_EVENT_PREFIXES = [...RESOURCE_WAIT_EVENT_PREFIXES, ...SUBAGENT_WAIT_EVENT_PREFIXES] as const
export const holdsDispatchSlot = (event: string | null | undefined) => Boolean(event && DISPATCH_SLOT_EVENT_PREFIXES.some((prefix) => event.startsWith(prefix)))

/** 子运行挂起等这个事件时，还占不占子 agent 名额（6.2）：只有等浏览器、等桌面占；等人处理、排队不占 */
export const holdsSubagentSlot = isResourceWaitEvent

// ---------- 运行详情要的数据 ----------

/** 子运行现在的样子（第 3 节的表）：排队 / 在跑 / 等资源（等待浏览器、等待桌面） / 等人处理 / 结束 */
export const subagentStateSchema = z.enum(["queued", "running", "waiting", "needs_human", "ended"])
export type SubagentState = z.infer<typeof subagentStateSchema>

/** SessionSummary.sub：子运行才有（父运行编号用现成的 parentSessionId） */
export const sessionSubSchema = z.object({ n: z.number().int(), title: z.string() })
export type SessionSub = z.infer<typeof sessionSubSchema>

/** SessionSummary.subagents：拆过子 agent 的父运行才有，一次分组查询算出来 */
export const subagentStatsSchema = z.object({
  total: z.number().int(),
  queued: z.number().int(),
  /** 在跑（含等浏览器、等桌面） */
  running: z.number().int(),
  needsHuman: z.number().int(),
  ended: z.number().int(),
  /** 结束的里面办成的 */
  achieved: z.number().int(),
  /** 全部子运行的花费合计（不含父运行自己的；页面显示「花费 $父+子（含子 agent $子）」） */
  costUsd: z.number(),
})
export type SubagentStats = z.infer<typeof subagentStatsSchema>

/** 父运行详情「子 agent」区块的一行（tRPC sessions.subagents，按 n 排） */
export const subagentRowSchema = z.object({
  /** 子运行编号，例如 R-12-3.2 */
  id: z.string(),
  n: z.number().int(),
  title: z.string(),
  /** 子目标全文（页面显示第一行） */
  goal: z.string(),
  state: subagentStateSchema,
  /** 结束了才有 */
  outcome: runOutcomeSchema.optional(),
  outcomeReason: z.string().optional(),
  outcomeBy: runOutcomeBySchema.optional(),
  costUsd: z.number(),
  startedAt: isoTime,
  endedAt: isoTime.optional(),
  /** 挂起时在等什么（排队、等待浏览器、等人处理的那句话） */
  waitingWhat: z.string().optional(),
  /** 结果已经交给父运行 */
  delivered: z.boolean(),
})
export type SubagentRow = z.infer<typeof subagentRowSchema>

export const subagentListInputSchema = z.object({ parentId: z.string().min(1) })

/** 子运行详情「子目标」区块（SessionRun.subGoal，只在 sessions.get） */
export const subagentFileSchema = z.object({ id: z.string(), name: z.string(), mime: z.string(), size: z.number(), url: z.string() })
export const subagentGoalViewSchema = z.object({
  n: z.number().int(),
  title: z.string(),
  goal: z.string(),
  input: z.record(z.string(), z.string()),
  /** 要交回的字段：交了的带 value */
  results: z.array(z.object({ name: z.string(), value: subResultValueSchema.optional() })),
  /** 拆的时候给它读的文件（只读） */
  files: z.array(subagentFileSchema),
})
export type SubagentGoalView = z.infer<typeof subagentGoalViewSchema>

// ---------- 从父快照派生子快照（5.1） ----------

export interface DeriveSubSnapshotInput {
  /** 父运行编号 */
  parentSessionId: string
  n: number
  item: SubagentItemInput
  /** item.fileIds 对应的文件（调用方查好、确认父运行能读）；和父的附件合并，只读、不挪 */
  files: SessionSnapshot["attachments"]
  /** 内置工具的快照写法（server 的 builtinSnapshotTool）：加 work.report、file.read、file.list 用 */
  builtinTool: (id: "work.report" | "file.read" | "file.list") => SnapshotTool
}

/**
 * 子快照：从父运行冻好的快照派生，不重新读任务配置（5.1）。
 * - 任务目标留着当背景，步骤、检查点清空（系统提示按 snapshot.sub 写「父任务的目标（背景）」，不写步骤）；
 * - 模型用父快照的 subagentModelId，没有用父的执行模型；
 * - 记忆、任务记忆、技能、浏览器（含 allowVision、allowFetch）、桌面、复核模型同父；自动挑选记忆沿用父挑好的，不重挑
 *   （父的 autoMemory 是 pending 时不带：子运行不挑，只用手选的）；
 * - 工具去掉 SUBAGENT_DROPPED_TOOL_IDS，加 work.report；带了文件却没有 file.read 的加上 file.read、file.list；
 * - 规则去掉 SUBAGENT_DROPPED_RULE_TRIGGERS；
 * - 库流程（snapshot.libraryRoutines，docs/dev/routine-library.md 6.2）和它们的工具一起抄（流程库设计 16.2 第 15 条）；
 *   要用子 agent 没有的工具（SUBAGENT_DROPPED_TOOL_IDS）的，和调了它们的（传递），标 unavailable（subLibraryRoutines）；
 * - 没有派活、派活目标、这个任务自己的固化流程（routine）、附加说明；source = sub。
 */
export function deriveSubSnapshot(parent: SessionSnapshot, input: DeriveSubSnapshotInput): SessionSnapshot {
  const tools = parent.tools.filter((tool) => !SUBAGENT_DROPPED_TOOL_IDS.includes(tool.id))
  const attachments = [...parent.attachments]
  for (const file of input.files) if (!attachments.some((each) => each.id === file.id)) attachments.push(file)
  const has = (id: string) => tools.some((tool) => tool.id === id)
  const add: ("work.report" | "file.read" | "file.list")[] = ["work.report"]
  if (attachments.length && !has("file.read")) add.push("file.read")
  if (attachments.length && !has("file.list")) add.push("file.list")
  for (const id of add) if (!has(id)) tools.push(input.builtinTool(id))
  const triggerType = (rule: SessionSnapshot["rules"][number]) => {
    const trigger = (rule.compiledTrigger as { trigger?: { type?: unknown } } | undefined)?.trigger
    return typeof trigger?.type === "string" ? trigger.type : undefined
  }
  const autoMemory = parent.autoMemory?.status === "pending" ? undefined : parent.autoMemory
  const libraryRoutines = parent.libraryRoutines && subLibraryRoutines(parent.libraryRoutines)
  const {
    dispatch: _dispatch,
    dispatchTargets: _dispatchTargets,
    routine: _routine,
    note: _note,
    subagentModelId,
    autoMemory: _autoMemory,
    sub: _sub,
    libraryRoutines: _libraryRoutines,
    ...rest
  } = parent
  return {
    ...rest,
    task: { ...parent.task, steps: [] },
    modelId: subagentModelId || parent.modelId,
    tools,
    rules: parent.rules.filter((rule) => !SUBAGENT_DROPPED_RULE_TRIGGERS.includes(triggerType(rule) ?? "")),
    checkpoints: [],
    attachments,
    source: "sub",
    ...(autoMemory ? { autoMemory } : {}),
    ...(libraryRoutines ? { libraryRoutines } : {}),
    sub: {
      parentSessionId: input.parentSessionId,
      n: input.n,
      title: input.item.title.trim(),
      goal: input.item.goal.trim(),
      input: input.item.input ?? {},
      results: [...new Set((input.item.results ?? []).map((name) => name.trim()).filter(Boolean))],
      fileIds: input.files.map((file) => file.id),
    },
  }
}

/**
 * 子快照里的库流程：从父快照抄。requires.toolIds 里有子 agent 没有的工具（SUBAGENT_DROPPED_TOOL_IDS）的标 unavailable，
 * 调了用不了的库流程的（requires.routines，按短名，传递）也标；原来就用不了的不动
 */
export function subLibraryRoutines(routines: NonNullable<SessionSnapshot["libraryRoutines"]>): NonNullable<SessionSnapshot["libraryRoutines"]> {
  const next = routines.map((routine) => {
    if (routine.unavailable) return routine
    const dropped = routine.requires.toolIds.filter((id) => SUBAGENT_DROPPED_TOOL_IDS.includes(id))
    return dropped.length ? { ...routine, unavailable: `子 agent 不能用要的工具「${dropped.join("」「")}」` } : routine
  })
  for (let changed = true; changed; ) {
    changed = false
    for (const [index, routine] of next.entries()) {
      if (routine.unavailable) continue
      const broken = next.find((other) => other.unavailable && routine.requires.routines.includes(other.slug))
      if (broken) {
        next[index] = { ...routine, unavailable: `它调的「${broken.name}」用不了：${broken.unavailable}` }
        changed = true
      }
    }
  }
  return next
}
