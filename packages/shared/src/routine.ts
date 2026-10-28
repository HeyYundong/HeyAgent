// 固化（docs/dev/solidify.md）：办成过一次的运行写成脚本「固化流程」，以后的运行先在沙箱里跑脚本，
// 每一步经工具桥走同一个工具网关；跑不通停在第 k 步，交给 agent 接着做。
// 这里是前后端共用的类型：表里的状态、快照里冻住的那一版、运行上记的脚本状态、过程记录的录制信息、接口的输入输出。
import { z } from "zod"

// 不从 schemas.ts 引：schemas.ts 的运行摘要要引这里的类型，互相引用会在模块初始化时拿到未定义的值
const isoTime = z.string()
const runOutcomeSchema = z.enum(["achieved", "not_achieved"])

// ---------- 状态 ----------

/** 固化流程：试用（新启用的版本；连着 3 次脚本直接办成转正式）/ 正式 / 停用（人停的，或连续 3 次跑不通自动停） */
export const routineStatusSchema = z.enum(["trial", "active", "paused"])
export type RoutineStatus = z.infer<typeof routineStatusSchema>
export const routineStatusLabel: Record<RoutineStatus, string> = { trial: "试用", active: "正式", paused: "停用" }

/** 试用期连着几次脚本直接办成就转正式；连着几次交给 agent 就自动停用 */
export const ROUTINE_TRIAL_RUNS = 3
export const ROUTINE_PAUSE_AFTER_FALLBACKS = 3
/** 一次固化最多几轮（写一次算一轮，试跑不过再改一次 +1） */
export const ROUTINE_MAX_ROUNDS = 3

/**
 * 一版脚本：drafting 写脚本 → testing 试跑 →（不过再写、再试跑）→ review 待审核 / failed 没成功；
 * 审核：approved 启用过（routines.active_version 指着的是现在启用的那一版）/ rejected 不用
 */
export const routineVersionStatusSchema = z.enum(["drafting", "testing", "review", "failed", "approved", "rejected"])
export type RoutineVersionStatus = z.infer<typeof routineVersionStatusSchema>
export const routineVersionStatusLabel: Record<RoutineVersionStatus, string> = {
  drafting: "写脚本中",
  testing: "试跑中",
  review: "待审核",
  failed: "没成功",
  approved: "启用过",
  rejected: "不用",
}

/** 任务上的开关「固化流程」：off = 不用；first = 先跑流程（第一次启用时自动打开）。给 agent 当工具是第二期 */
export const routineModeSchema = z.enum(["off", "first"])
export type RoutineMode = z.infer<typeof routineModeSchema>
export const routineModeLabel: Record<RoutineMode, string> = { off: "不用", first: "先跑流程" }

/**
 * 运行的种类：run = 普通运行；routine_test = 固化试跑（只跑脚本、不叫 agent、不复核；不进会话列表、不算统计）；
 * sub = 父运行拆出来的子运行（docs/dev/sub-agents.md：不进会话列表、不上看板，花费算进今天的花费）
 */
export const sessionKindSchema = z.enum(["run", "routine_test", "sub"])
export type SessionKind = z.infer<typeof sessionKindSchema>

/**
 * 流程库里的登记状态（docs/dev/routine-library.md 2.4）：listed 在库里 / paused 停用（主管停的，或连续 3 次跑不通自动停）/
 * withdrawn 撤下（没有任务选用、也没有别的库流程调它时才能撤）。流程库的其余类型在 routine-library.ts；
 * 这个放这里是因为任务详情的「固化流程」区块（routineSummarySchema.library）要用，routine-library.ts 又要引这个文件
 */
export const routineLibraryStatusSchema = z.enum(["listed", "paused", "withdrawn"])
export type RoutineLibraryStatus = z.infer<typeof routineLibraryStatusSchema>
export const routineLibraryStatusLabel: Record<RoutineLibraryStatus, string> = { listed: "在库里", paused: "停用", withdrawn: "撤下" }

// ---------- 录：过程记录上的录制信息（session_events.trace） ----------

/**
 * 库流程里的一步（docs/dev/routine-library.md 5.7）：agent 调的（工具 routine.<短名>）、脚本里 ha.routine 调的，
 * 里面每一步的过程记录都带它。脚本里调的同时还有 routineStep（或 scriptStep）：调用方脚本的第几步、库流程的第几步都看得到。
 * 进入库流程的那一步本身（脚本里的 ha.routine）是调用方的一步，不带它；两层嵌套时，B 的进入是 A 的一步，带 A 的 library
 */
export const libraryTraceSchema = z.object({
  /** 库流程的编号 RT-<n> */
  routineId: z.string(),
  version: z.number().int(),
  /** 这个库流程里的第几步（从 1 开始；这次调用自己数） */
  step: z.number().int().positive(),
  /** 这次调用：agent 调 = 模型的工具调用 id；脚本调 = 进入那一步的调用 id（gateway.call 的 toolCallId）。界面、交接的话按它归步骤 */
  callId: z.string(),
  /** 1 = 直接调的；2 = 库流程里再调的（最多 MAX_LIBRARY_DEPTH） */
  depth: z.number().int().positive(),
})
export type LibraryTrace = z.infer<typeof libraryTraceSchema>

export const eventTraceSchema = z.object({
  /** Playwright MCP 输出的 `### Ran Playwright code`（快照 ref 已换成稳定定位，例如 getByRole('button', { name: '查询' })） */
  code: z.string().optional(),
  /** 动作前后的网址、做完后的标题（读不到就没有） */
  urlBefore: z.string().optional(),
  urlAfter: z.string().optional(),
  title: z.string().optional(),
  /** 固化脚本做的：工具桥的第几次调用（从 1 开始）；agent 做的没有 */
  routineStep: z.number().int().positive().optional(),
  /** agent 用 code.run（tools）写的脚本做的（第 18.1 节）：脚本里第几次调用、哪一次 code.run（模型的工具调用 id） */
  scriptStep: z.number().int().positive().optional(),
  scriptCallId: z.string().optional(),
  /**
   * 这一步做的时候网页发了哪几个请求（docs/dev/solidify.md 19.3）：network/requests.jsonl 里 seq 从 first 到 last。
   * 只有任务打开「允许直接调网站接口」、这一步里确实记了请求才有；固化员的材料按它把接口对上步骤
   */
  network: z.object({ first: z.number().int().positive(), last: z.number().int().positive() }).optional(),
  /** 库流程里的一步（docs/dev/routine-library.md 5.7）：哪个库流程、第几版、里面第几步、哪次调用、第几层 */
  library: libraryTraceSchema.optional(),
})
export type EventTrace = z.infer<typeof eventTraceSchema>

// ---------- 跑：快照里冻住的那一版（snapshot.routine） ----------

const jsonSchemaObject = z.record(z.string(), z.unknown())

/**
 * 开始运行时冻进快照：普通运行冻任务启用的那一版（任务开着「先跑流程」、流程没停用时才有）；固化试跑冻要试的那一版。
 * 运行中途批准了新版本，不影响这次
 */
export const routineSnapshotSchema = z.object({
  id: z.string(),
  versionId: z.string(),
  version: z.number().int(),
  name: z.string(),
  /** 普通运行：trial / active；固化试跑：test */
  status: z.enum(["trial", "active", "test"]),
  code: z.string(),
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
  commits: z.array(z.string()),
})
export type RoutineSnapshot = z.infer<typeof routineSnapshotSchema>

/** 脚本为什么停下（sessions.routine.stoppedAt.kind） */
export const routineStopKindSchema = z.enum([
  /** 工具出错（定位找不到、超时……），脚本没接住 */
  "step_error",
  /** 被规则拦下 */
  "denied",
  /** 规则要人审批：停在这一步之前，没做（同 browser.batch），交给 agent 单独调用 */
  "approval",
  /** 要挂起：验证码、登录页、等浏览器 */
  "suspend",
  /** ha.fail("input")：输入本身有问题（记没办成，不交 agent） */
  "input",
  /** ha.fail("page")：页面和预期不一样 */
  "page",
  /** 脚本自己出错：语法错、抛了没接住的错、没调 ha.finish 就结束了 */
  "script_error",
  /** 超时 */
  "timeout",
  /** 工具调用次数到了上限 */
  "limit",
  /** 运行被取消 */
  "cancelled",
  /** 沙箱没起来 */
  "sandbox",
  /** 进程重启，脚本中断（不确定最后一步做没做） */
  "interrupted",
  /** 输入不符合 inputSchema */
  "bad_input",
  /** 运行本身出错、被标失败（引擎出错、执行模型解析不了……）：脚本没跑完。固化试跑据此判这一轮没过 */
  "run_failed",
  /** 试跑：走到第一个 ha.commit，停在它前面（试跑通过的正常结局之一） */
  "test_commit",
  /** 试跑：下一步是会对外发送、改东西的非浏览器工具，停在它前面 */
  "test_blocked",
  /** 接着跑（第 17.2 节）：重放时脚本走了和日志不一样的路 */
  "replay_mismatch",
  /** 接着跑：日志里有浏览器动作，但这次运行的 Chrome 已经不在了 */
  "resume_lost",
  /** 接着跑：这一步要人审批，被拒绝了 */
  "rejected",
])
export type RoutineStopKind = z.infer<typeof routineStopKindSchema>
export const routineStopKindLabel: Record<RoutineStopKind, string> = {
  step_error: "这一步出错",
  denied: "被规则拦下",
  approval: "这一步要人审批",
  suspend: "要人处理（验证码、登录页、等浏览器）",
  input: "输入有问题",
  page: "页面和预期不一样",
  script_error: "脚本出错",
  timeout: "超时",
  limit: "调用次数到了上限",
  cancelled: "运行被取消",
  sandbox: "沙箱没起来",
  interrupted: "中断了",
  bad_input: "输入不对",
  run_failed: "运行出错",
  test_commit: "试跑停在提交前",
  test_blocked: "试跑停在对外发送前",
  replay_mismatch: "接着跑时对不上",
  resume_lost: "浏览器已经关了",
  rejected: "审批被拒绝",
}

export const routineStopSchema = z.object({
  /** 停在第几次工具调用（还没开始调就停的是 0） */
  step: z.number().int().min(0),
  kind: routineStopKindSchema,
  /** 这一步的工具 id、给人看的说明（click「查询」） */
  tool: z.string().optional(),
  label: z.string().optional(),
  reason: z.string(),
})
export type RoutineStop = z.infer<typeof routineStopSchema>

/** 试跑时记下、没生效的：work.report 的数据、run.finish 的结果、勾的检查点 */
export const routineRecordedSchema = z.object({
  report: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
  finish: z
    .object({ outcome: runOutcomeSchema, summary: z.string(), evidence: z.string().optional(), reason: z.string().optional() })
    .optional(),
  checkpoints: z.array(z.object({ checkpoint: z.number().int(), status: z.string(), record: z.string().optional() })).optional(),
})
export type RoutineRecorded = z.infer<typeof routineRecordedSchema>

/**
 * 运行上记的脚本状态（sessions.routine）。普通运行跑过脚本、固化试跑才有。
 * - running：脚本在跑；
 * - finished：脚本报了结果（ha.finish），按 run.finish 照常收尾；
 * - fell_back：交给 agent 了（stoppedAt 写着停在哪、为什么）；
 * - stopped：没交给 agent 就停了：试跑停下（看 stoppedAt.kind）、运行被取消、输入有问题直接记没办成；
 * - suspended：停下等人（验证码、登录页、等浏览器、审批），处理完按日志重放、接着跑（第 17.2 节）
 */
export const sessionRoutineStateSchema = z.object({
  routineId: z.string(),
  versionId: z.string(),
  version: z.number().int(),
  mode: z.enum(["run", "test"]),
  state: z.enum(["running", "finished", "fell_back", "stopped", "suspended"]),
  startedAt: isoTime,
  endedAt: isoTime.optional(),
  ms: z.number().int().optional(),
  /** 工具桥调了几次工具 */
  steps: z.number().int().min(0),
  stoppedAt: routineStopSchema.optional(),
  /** 走过的 ha.commit（verified：之后 ha.verified 写的核对说明） */
  commits: z.array(z.object({ step: z.number().int().min(0), label: z.string(), verified: z.string().optional() })),
  /** 这次的输入（试跑用原来那次运行的输入） */
  input: z.record(z.string(), z.unknown()).optional(),
  recorded: routineRecordedSchema.optional(),
  /** ha.log 记的几句话（最多 50 条） */
  logs: z.array(z.string()).optional(),
  /** 脚本报了办成、三方验收反问、agent 接着做的（第 17.3 节）：不算直接办成，也不算交给 agent */
  agentAfter: z.boolean().optional(),
  /** 停下等人后接着跑了几次（第 17.2 节） */
  resumes: z.number().int().optional(),
  /** 最近一次接着跑时，按日志跳过了几步（工具调用；ha.commit、ha.log、ha.now 这些标记不算） */
  replayed: z.number().int().optional(),
  /** 固化试跑停下、跑完时截的图（试跑报告「停下时的截图」用）；普通运行没有 */
  screenshotFileId: z.string().optional(),
})
export type SessionRoutineState = z.infer<typeof sessionRoutineStateSchema>

// ---------- 固化：一版脚本的试跑报告（routine_versions.test_report） ----------

export const routineTestRoundSchema = z.object({
  round: z.number().int().positive(),
  sessionId: z.string(),
  passed: z.boolean(),
  stoppedAt: routineStopSchema.optional(),
  steps: z.number().int().min(0),
  /** 试跑读到、要交回的结果 */
  data: z.record(z.string(), z.unknown()).optional(),
  /** 和原来那次运行比：要交回的结果一项一项对 */
  compare: z.array(z.object({ field: z.string(), expected: z.string(), actual: z.string(), same: z.boolean() })).optional(),
  /** 停下时的截图 */
  screenshotFileId: z.string().optional(),
  /** 没通过的原因（给固化员改、给人看） */
  error: z.string().optional(),
})
export type RoutineTestRound = z.infer<typeof routineTestRoundSchema>

/** 固化员写的一轮没到试跑就没过（程序检查没过、固化员出错、没给合格的 JSON）：原因留着，没成功的版本查得到每一轮为什么没过 */
export const routineDraftRoundSchema = z.object({
  round: z.number().int().positive(),
  error: z.string(),
})
export type RoutineDraftRound = z.infer<typeof routineDraftRoundSchema>

export const routineTestReportSchema = z.object({
  rounds: z.array(routineTestRoundSchema),
  /** 没到试跑就没过的几轮（按轮次排）；以前的版本没有 */
  drafts: z.array(routineDraftRoundSchema).optional(),
})
export type RoutineTestReport = z.infer<typeof routineTestReportSchema>

// ---------- 固化员建议建的 HTTP 工具（routine_versions.http_suggestions，docs/dev/solidify.md 19.5） ----------

/**
 * 一条建议：记下的接口用 token 认证（请求头里有 Authorization、X-API-Key 这类，不靠 cookie），browser.fetch 调不了，
 * 主管可以在工具页照这个建一个 HTTP 工具，密钥写成 {{名字}}。只是建议，系统不自动建。
 * http 和工具页的 HTTP 工具同一个形状（schemas.ts 的 httpSpecSchema；这里不引 schemas.ts，免得互相引用），参数都是 string
 */
export const httpToolSuggestionSchema = z.object({
  /** 工具名（「查询订单详情」这类，十个字左右） */
  name: z.string(),
  /** 给模型看的一句话：做什么、什么时候用 */
  summary: z.string(),
  /** 为什么建议：哪个接口、为什么 browser.fetch 调不了、建了有什么用 */
  reason: z.string(),
  http: z.object({
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
    /** 网址模板：{参数} 由模型填，{{密钥名}} 是密钥的占位符 */
    url: z.string(),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.string().optional(),
    params: z.array(z.object({ name: z.string(), type: z.literal("string"), required: z.boolean(), description: z.string().optional() })),
  }),
  /** 要主管准备的密钥名字（模板里 {{名字}} 的那些） */
  secrets: z.array(z.string()),
  /** 依据：network/requests.jsonl 里哪几个请求（seq） */
  requestSeqs: z.array(z.number().int().positive()),
})
export type HttpToolSuggestion = z.infer<typeof httpToolSuggestionSchema>
/** 一版最多几条建议 */
export const HTTP_TOOL_SUGGESTIONS_MAX = 5

// ---------- 接口的输出 ----------

const person = z.object({ id: z.string(), name: z.string() })

/** 一版脚本的全部内容（审核卡、看脚本、版本记录用） */
export const routineVersionSchema = z.object({
  id: z.string(),
  routineId: z.string(),
  taskId: z.string(),
  version: z.number().int(),
  status: routineVersionStatusSchema,
  name: z.string(),
  /** 给人看的步骤说明，一步一行 */
  description: z.string(),
  code: z.string(),
  inputSchema: jsonSchemaObject,
  outputSchema: jsonSchemaObject,
  commits: z.array(z.string()),
  assumptions: z.array(z.string()),
  /** 固化员建议建的 HTTP 工具（19.5）；没有是空数组 */
  httpToolSuggestions: z.array(httpToolSuggestionSchema),
  /** 没成功的原因（不适合固化、程序检查没过、试跑 3 轮都没过） */
  failReason: z.string().nullable(),
  sourceSessionId: z.string().nullable(),
  /** 修的版本：改的是哪一版 */
  baseVersion: z.number().int().nullable(),
  round: z.number().int(),
  /** 点「固化成流程」时选了不试跑 */
  skipTest: z.boolean(),
  /** 运行办成后系统自动固化的（第 17.1 节）；人点的是 false */
  auto: z.boolean(),
  testReport: routineTestReportSchema.nullable(),
  modelId: z.string().nullable(),
  costUsd: z.number(),
  rejectReason: z.string().nullable(),
  createdBy: person.nullable(),
  approvedBy: person.nullable(),
  approvedAt: isoTime.nullable(),
  /** 转正式的时间（试用期连着 3 次脚本直接办成；docs/dev/routine-library.md 2.2）：只有转过正式的版本能发布进流程库 */
  provenAt: isoTime.nullable(),
  createdAt: isoTime,
  /** 待审核时的那件要人办的事 */
  humanItemId: z.string().nullable(),
})
export type RoutineVersion = z.infer<typeof routineVersionSchema>

/** 任务详情「固化流程」区块：一个任务一个（第一期） */
export const routineSummarySchema = z.object({
  id: z.string(),
  taskId: z.string(),
  status: routineStatusSchema,
  /** 任务上的开关 */
  mode: routineModeSchema,
  /** 启用的那一版（还没启用过 = null）和它的名字 */
  activeVersion: z.number().int().nullable(),
  name: z.string(),
  directStreak: z.number().int(),
  fallbackStreak: z.number().int(),
  pausedReason: z.string().nullable(),
  /** 最近 20 次跑过脚本的运行：脚本直接办成几次、交给 agent 几次、平均用时；agent 的平均用时（同任务最近 20 次没跑脚本、办成的运行） */
  recent: z.object({
    runs: z.number().int(),
    direct: z.number().int(),
    fellBack: z.number().int(),
    avgMs: z.number().nullable(),
    agentAvgMs: z.number().nullable(),
  }),
  /** 所有版本，新的在前（不带脚本正文） */
  versions: z.array(
    z.object({
      id: z.string(),
      version: z.number().int(),
      status: routineVersionStatusSchema,
      name: z.string(),
      sourceSessionId: z.string().nullable(),
      /** 运行办成后系统自动固化的（第 17.1 节），版本记录上标「自动固化」 */
      auto: z.boolean(),
      /** 这一版有几条 HTTP 工具建议（19.5；内容在 routine.version 里） */
      httpToolSuggestions: z.number().int().min(0),
      /** 转正式的时间（没转过 = null）：版本记录上标「转过正式」，只有这样的版本能发布进流程库 */
      provenAt: isoTime.nullable(),
      createdAt: isoTime,
    })
  ),
  /**
   * 流程库（docs/dev/routine-library.md 9.2）：发布进库过的（撤下了也有）= 登记的样子；没发布过 = null。
   * 区块里写「在流程库里：routine.<短名> 第 3 版 · 6 个任务在用」，点了去流程页
   */
  library: z
    .object({
      slug: z.string(),
      /** routine.<短名> */
      toolId: z.string(),
      title: z.string(),
      publishedVersion: z.number().int(),
      status: routineLibraryStatusSchema,
      /** 选用它的任务有几个 */
      taskCount: z.number().int().min(0),
    })
    .nullable(),
  /** 转过正式、比库里发布的新（没发布过就是所有转过正式的）版本号，新的在前：主管看到「⋯ → 发布到流程库」，负责人看到「可以请主管发布」 */
  publishable: z.array(z.number().int()),
})
export type RoutineSummary = z.infer<typeof routineSummarySchema>

// ---------- 接口的输入 ----------

/**
 * 运行详情「⋯ → 固化成流程」：已结束、办成的普通运行才行；任务负责人和主管。
 * skipTest：不试跑（会自动存草稿的网站；docs/dev/solidify.md 第 14 节问题 4），写好、程序检查过了直接交给人审核
 */
export const routineCompileInputSchema = z.object({ sessionId: z.string().min(1), skipTest: z.boolean().optional() })
/** 审核一版：启用（进试用期）/ 不用（要写理由） */
export const routineReviewInputSchema = z
  .object({ versionId: z.string().min(1), approve: z.boolean(), reason: z.string().trim().max(1000).optional() })
  .refine((value) => value.approve || Boolean(value.reason), { message: "不用的话要写理由", path: ["reason"] })
export const routineSetModeInputSchema = z.object({ taskId: z.string().min(1), mode: routineModeSchema })
/** 停用 / 重新启用（启用回到试用期） */
export const routinePauseInputSchema = z.object({ routineId: z.string().min(1), paused: z.boolean() })
/** 回到以前启用过的某一版（进试用期） */
export const routineRestoreInputSchema = z.object({ routineId: z.string().min(1), version: z.number().int().positive() })

// ---------- 脚本的输入 ----------

/**
 * 脚本的输入（ha.input，docs/dev/solidify.md 4.4）：派活参数原样放；这次运行能读的附件放 $attachments（id、名字、类型）；
 * 附加说明放 $note。固化员写 inputSchema、跑脚本前校验输入、试跑取原来那次运行的输入，都按这一份
 */
export function routineInputOf(snapshot: {
  dispatch?: { params: Record<string, string> }
  attachments: { id: string; name: string; mime: string }[]
  note?: string
}): Record<string, unknown> {
  return {
    ...(snapshot.dispatch?.params ?? {}),
    ...(snapshot.attachments.length
      ? { $attachments: snapshot.attachments.map(({ id, name, mime }) => ({ id, name, mime })) }
      : {}),
    ...(snapshot.note ? { $note: snapshot.note } : {}),
  }
}

// ---------- 自动固化（第 17.1 节） ----------

/** 任务的「办成后自动固化」没单独设（null）时按什么来：被派的任务、定时任务开，别的关 */
export function autoSolidifyDefault(task: { dispatch?: unknown; schedule?: unknown }): boolean {
  return Boolean(task.dispatch) || Boolean(task.schedule)
}
