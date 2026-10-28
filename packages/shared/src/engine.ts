// 引擎相关的共享类型（M1 包 P1 负责）：session 快照、内置工具的输入、通知、文件、引擎接口的输入输出。
// 平台通用：这里只有通用的概念（任务、检查点、等待、问人、文件），不出现任何业务。
import { z } from "zod"

import { sessionDesktopSnapshotSchema } from "./desktop.js"
import { autoMemorySnapshotSchema, snapshotMemoryAutoSchema } from "./memory-retrieval.js"
import { routineSnapshotSchema } from "./routine.js"
import {
  checkpointKindSchema,
  httpSpecSchema,
  isoTime,
  riskSchema,
  runOutcomeSchema,
  taskStepSchema,
  toolSourceSchema,
} from "./schemas.js"

// ---------- 设置 ----------
// settings 表的键（SETTING_KEYS）、默认值（SETTINGS_DEFAULTS）、通知渠道（notifyChannelSchema）、
// 外部事件令牌（eventTokenRecordSchema）只有一份，定义在 config.ts，引擎和设置页都引用那里。

// ---------- session 快照：开始运行时把任务当时的配置冻结下来，任务以后再改不影响这次运行 ----------

export const snapshotToolSchema = z.object({
  id: z.string(),
  name: z.string(),
  summary: z.string(),
  description: z.string(),
  source: toolSourceSchema,
  risk: riskSchema,
  alwaysOn: z.boolean().optional(),
  serverId: z.string().optional(),
  http: httpSpecSchema.optional(),
})
export type SnapshotTool = z.infer<typeof snapshotToolSchema>

export const sessionSnapshotSchema = z.object({
  /** 快照格式版本 */
  v: z.literal(1),
  task: z.object({
    id: z.string(),
    title: z.string(),
    goal: z.string(),
    ownerId: z.string(),
    steps: z.array(taskStepSchema),
  }),
  modelId: z.string(),
  /** M3：任务自己选的验收模型（没有就在验收时取默认验收模型） */
  verifyModelId: z.string().optional(),
  /**
   * run-outcome：复核模型（没有就在复核时取默认复核模型）。运行结束后一定复核（三方验收通过的除外）。
   * 2026-10-20 以前的快照里还可能有 reviewEnabled（复核开关，已经去掉），读的时候忽略
   */
  reviewModelId: z.string().optional(),
  /**
   * 给 agent 的记忆：手选的（建任务时选的）在前；自动挑的（docs/dev/memory-retrieval.md）在后、带 auto（相似度）。
   * 自动挑的不是开始运行的那个事务里写的：worker 进这次运行时挑好，追加到这里，同时把 autoMemory 改成 done / skipped / failed
   */
  memories: z.array(
    z.object({ id: z.string(), content: z.string(), appliesTo: z.string(), auto: snapshotMemoryAutoSchema.optional() })
  ),
  /** 自动挑选记忆：任务开着才有（固化试跑不挑）。pending = 还没挑；加这个字段之前开始的运行没有 */
  autoMemory: autoMemorySnapshotSchema.optional(),
  /** 任务记忆：这个任务自己积累的经验（加这个字段之前开始的运行没有） */
  taskMemory: z.array(z.string()).optional(),
  skills: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string(),
      version: z.number().int(),
      body: z.string(),
    })
  ),
  tools: z.array(snapshotToolSchema),
  rules: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      trigger: z.string(),
      action: z.string(),
      toolIds: z.array(z.string()),
      compiledTrigger: z.record(z.string(), z.unknown()).optional(),
    })
  ),
  checkpoints: z.array(
    z.object({
      title: z.string(),
      kind: checkpointKindSchema,
      target: z.number().int().optional(),
      stepId: z.string().optional(),
    })
  ),
  /** 这次运行能读的附件：任务附件 + 这次运行带的附件 */
  attachments: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      mime: z.string(),
      size: z.number(),
    })
  ),
  /** 额外的一句话（例如人加的待办的标题） */
  note: z.string().optional(),
  source: z.enum(["manual", "cron", "todo", "event", "dispatch"]),
  /** 派活：这次运行是被派来办一件事的（派活单、参数、谁派的）。参数在第一条消息里交给 agent */
  dispatch: z
    .object({
      itemId: z.string(),
      key: z.string(),
      title: z.string(),
      note: z.string().optional(),
      params: z.record(z.string(), z.string()),
      depth: z.number().int(),
      from: z.object({ taskId: z.string(), taskTitle: z.string(), sessionId: z.string() }).optional(),
      /** 人在派活页派的：谁（第一条消息里写「某某手动派的」） */
      fromUser: z.object({ id: z.string(), name: z.string() }).optional(),
      /** run-outcome 6.1：被派任务声明的要交回的结果（开始运行时冻进来）；必填的没用 work.report 交，结果记没办成。加这个字段之前开始的运行没有 = 不要求 */
      results: z.array(z.object({ name: z.string(), description: z.string(), required: z.boolean() })).optional(),
    })
    .optional(),
  /** 派活：选了内置工具「派活」时，能派给哪些任务、各要什么参数（开始运行时算好冻进来） */
  dispatchTargets: z
    .array(
      z.object({
        taskId: z.string(),
        title: z.string(),
        enabled: z.boolean(),
        params: z.array(z.object({ name: z.string(), description: z.string(), required: z.boolean(), dedupe: z.boolean() })),
      })
    )
    .optional(),
  /** M2：任务选了「浏览器」工具时才有：允许的 Chrome 配置（含给 agent 看的说明）、网址白名单、是否允许执行脚本、是否允许看画面、是否允许直接调接口 */
  browser: z
    .object({
      profiles: z.array(
        z.object({ id: z.string(), name: z.string(), description: z.string() })
      ),
      allowedDomains: z.array(z.string()),
      allowEvaluate: z.boolean(),
      /** 允许看画面（browser.look + 坐标工具）；老快照没有这一项 = 不允许 */
      allowVision: z.boolean().default(false),
      /** 允许直接调网站的接口（browser.fetch）、记网页发的请求（docs/dev/solidify.md 第 19 节）；老快照没有这一项 = 不允许 */
      allowFetch: z.boolean().default(false),
    })
    .optional(),
  /** 任务选了「桌面」工具时才有：允许的桌面（含给 agent 看的说明）、是否允许看画面 */
  desktop: sessionDesktopSnapshotSchema.optional(),
  /** 固化（docs/dev/solidify.md 6.2）：这次运行先跑的那一版脚本；固化试跑冻的是要试的那一版 */
  routine: routineSnapshotSchema.optional(),
})
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>

/** 系统自带的「浏览器」工具（来源 builtin）：任务选了它，就开放整组浏览器工具（browser.use + Playwright MCP 的工具） */
export const BROWSER_TOOL_ID = "browser"

// ---------- 内置工具的输入（模型看到的 JSON Schema 由这些 zod schema 生成） ----------

export const builtinToolInputs = {
  "checkpoint.mark": z.object({
    checkpoint: z
      .number()
      .int()
      .min(1)
      .describe("检查点编号（系统提示里检查点清单的序号，从 1 开始）"),
    status: z
      .enum(["done", "skipped", "doing"])
      .describe(
        "done = 完成；skipped = 跳过（必须写理由）；doing = 我现在在做这一个（同类型的检查点有好几个时，系统自动记录会记到它上面）"
      ),
    record: z
      .string()
      .max(4000)
      .optional()
      .describe("这次的结果或证据，一两句话"),
    progress: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("有目标数的检查点：现在做到了多少"),
    reason: z
      .string()
      .max(2000)
      .optional()
      .describe("跳过的理由（status = skipped 时必填）"),
  }),
  "session.wait": z.object({
    what: z.string().min(1).max(500).describe("一句话：在等什么"),
    until: z
      .string()
      .optional()
      .describe(
        "等到什么时候继续：ISO 8601 时间，带时区，例如 2026-10-17T15:00:00+08:00"
      ),
    afterMinutes: z
      .number()
      .positive()
      .max(60 * 24 * 90)
      .optional()
      .describe("或者：多少分钟后继续（和 until 二选一）"),
    event: z
      .string()
      .min(1)
      .max(200)
      .optional()
      .describe(
        "等哪个事件（事件名）。只等事件时系统会加兜底期限，到期提醒负责人"
      ),
  }),
  "ask.human": z.object({
    question: z
      .string()
      .min(1)
      .max(4000)
      .describe("要问的问题或要人拍板的事，写清楚背景"),
    kind: z
      .enum(["approval", "login"])
      .optional()
      .describe(
        "approval = 请人批准或回答（默认）；login = 请人去浏览器里登录或过验证码"
      ),
    assignee: z
      .string()
      .optional()
      .describe("交给谁：员工 id 或邮箱；不填就交给任务负责人"),
    options: z
      .array(z.string().min(1).max(100))
      .max(4)
      .optional()
      .describe('可选的回答，例如 ["批准", "不批准"]'),
  }),
  "skill.load": z.object({
    skill: z
      .string()
      .min(1)
      .describe("技能的 id 或名字（见系统提示里的技能目录）"),
  }),
  "memory.propose": z.object({
    content: z.string().min(1).max(2000).describe("要记住的一件事，一两句话"),
    appliesTo: z
      .string()
      .min(1)
      .max(200)
      .describe("适用于什么：「分类 · 对象」或只写分类"),
    evidence: z
      .enum(["chat", "web", "result"])
      .describe(
        "根据什么提议的：chat = 聊天记录，web = 网页内容，result = 任务结果"
      ),
    excerpt: z.string().max(2000).optional().describe("证据摘录"),
  }),
  "skill.propose": z.object({
    skill: z.string().min(1).describe("要改的技能 id 或名字"),
    summary: z.string().min(1).max(500).describe("一句话：改了什么、为什么"),
    newBody: z
      .string()
      .min(1)
      .max(100_000)
      .describe("改完以后的 SKILL.md 正文全文"),
  }),
  "notify.staff": z.object({
    title: z.string().min(1).max(200),
    body: z.string().max(4000).optional(),
    to: z
      .array(z.string())
      .max(20)
      .optional()
      .describe("通知谁：员工 id 或邮箱；不填就通知任务负责人"),
  }),
  "file.save": z.object({
    path: z
      .string()
      .min(1)
      .max(300)
      .describe(
        "在这次运行空间里的路径，带扩展名，例如 result.csv、state/progress.json、scripts/clean.py、报表.xlsx。同一路径再存就是覆盖（文件 id 不变）。不能以 attachments/ downloads/ screenshots/ tool-outputs/ clipboard/ 开头。文本和代码都能存（csv、md、json、txt、py、js、sh 等）；Excel 用 .xlsx 或 .xls（要给 sheets）"
      ),
    content: z
      .string()
      .max(5_000_000)
      .optional()
      .describe("文件内容（文本）。存 Excel 时不用给，给 sheets"),
    sheets: z
      .array(
        z.object({
          name: z
            .string()
            .describe("工作表名：最多 31 个字，不能有 [ ] : * ? / \\，不能重名"),
          rows: z
            .array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])))
            .describe("每行一个数组，第一行一般是表头；日期写成文字，例如 2026-01-02"),
        })
      )
      .min(1)
      .max(100)
      .optional()
      .describe("存 Excel：一个工作表一项。给了它就按 Excel 存，content 不用给"),
    format: z
      .enum(["xlsx", "xls"])
      .optional()
      .describe("Excel 格式：xlsx（默认）或 xls（老版本 Excel，最多 65536 行、256 列）"),
  }),
  "file.read": z.object({
    fileId: z
      .string()
      .min(1)
      .optional()
      .describe(
        "附件或文件的 id（见系统提示里的附件清单、file.list，或工具输出里给的文件 id）。和 path 二选一"
      ),
    path: z
      .string()
      .min(1)
      .max(300)
      .optional()
      .describe("空间里的路径（file.list 列出的，例如 state/progress.json、attachments/报价.xlsx）。和 fileId 二选一"),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("文本文件从第几个字符开始读（默认 0，长文件分段读）。csv / tsv 给了它就按原文读，不按表格读"),
    sheet: z
      .union([z.string(), z.number().int().min(1)])
      .optional()
      .describe("表格文件（xlsx、xls、csv 等）：读哪个工作表，名字或序号（从 1 开始）"),
    startRow: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe("表格文件：从第几行开始读（按表里的行号，从 1 开始）"),
    rows: z
      .number()
      .int()
      .min(1)
      .max(500)
      .optional()
      .describe("表格文件：读多少行（默认 200，最多 500）"),
  }),
  // Session 空间（docs/dev/session-space.md）：列出、按原文改、删 agent 写的文件
  "file.list": z.object({
    prefix: z
      .string()
      .max(300)
      .optional()
      .describe("只列这个目录下的，例如 state/、attachments/；不填列全部"),
  }),
  "file.edit": z.object({
    path: z.string().min(1).max(300).describe("要改的文件路径（agent 写的文本或代码文件）"),
    edits: z
      .array(
        z.object({
          old: z.string().min(1).describe("要换掉的原文，必须在文件里正好出现一次（多带几行上下文让它唯一）"),
          new: z.string().describe("换成什么；空字符串 = 删掉这段"),
        })
      )
      .min(1)
      .max(50)
      .describe("按顺序替换；有一段找不到或不唯一，整次都不改"),
  }),
  "file.delete": z.object({
    path: z.string().min(1).max(300).describe("要删的文件路径；只能删 agent 写的文件"),
  }),
  // 运行代码：在沙箱里跑，空间文件挂在 /workspace，跑完新增、改动、删掉的文件同步回空间
  "code.run": z.object({
    language: z.enum(["python", "node", "bash"]).describe("python（Python 3.12）、node（Node.js 24）或 bash"),
    file: z
      .string()
      .max(300)
      .optional()
      .describe("空间里的脚本路径，例如 scripts/clean.py。和 code 二选一"),
    code: z
      .string()
      .max(200_000)
      .optional()
      .describe("直接给代码（不存成文件）。和 file 二选一；要反复改的代码先用 file.save 存成文件"),
    args: z.array(z.string().max(1000)).max(50).optional().describe("命令行参数"),
    stdin: z.string().max(1_000_000).optional().describe("标准输入"),
    timeout: z
      .number()
      .int()
      .min(1)
      .max(600)
      .optional()
      .describe("最多跑几秒，默认 60，最多 600；到时间整组进程被杀掉"),
    tools: z
      .boolean()
      .optional()
      .describe(
        "true = 脚本里能调这次运行的工具（只认 node）：import ha from \"heyagent\"，用 ha.browser.click(...)、ha.tool(id, input) 这些，每一步照样过规则、白名单、审批、记录；不能上网。要重复做很多次同样的操作时用"
      ),
  }),
  "work.dispatch": z.object({
    task: z.string().min(1).describe("派给哪个任务：任务 id，见系统提示里「可以派活给」"),
    items: z
      .array(
        z.object({
          title: z.string().min(1).max(120).describe("一句话：这件事是什么，给人看的"),
          params: z.record(z.string(), z.string()).describe("参数，按对方任务要求的填"),
          key: z
            .string()
            .max(200)
            .optional()
            .describe("去重键：对方任务没有标「去重」的参数时必填，同一件事每次都填同一个值"),
          note: z.string().max(1000).optional(),
        })
      )
      .min(1)
      .max(50)
      .describe("要派的事，一件一张，一次最多 50 张"),
    ifExists: z
      .enum(["skip", "update"])
      .optional()
      .describe("同一件事已经派过：skip = 不动（默认）；update = 还在排队的话用这次的参数覆盖"),
  }),
  // 第二期：派活方查自己任务派出去的单（选了「派活」自动带上）
  "work.list": z.object({
    items: z.array(z.string()).max(50).optional().describe('按单号查，例如 ["W-57"]'),
    status: z
      .enum(["queued", "running", "done", "failed", "cancelled", "open"])
      .optional()
      .describe("只看某种状态；open = 还没结束的（排队 + 在办）"),
    thisRun: z.boolean().optional().describe("只看这次运行派的（默认看这个任务派过的全部）"),
    limit: z.number().int().min(1).max(50).optional().describe("最多列几张，默认 20"),
  }),
  // 第二期：被派来的运行写结构化结果（被派来的运行自动带上）
  "work.report": z.object({
    data: z
      .record(z.string().min(1).max(40), z.union([z.string().max(1000), z.number(), z.boolean()]))
      .optional()
      .describe('结果的几个字段，例如 {"件数": 3, "已回填": true}；最多 20 个。可以调多次，同名字段以后一次为准'),
    outcome: z
      .enum(["done", "not_done"])
      .optional()
      .describe("not_done = 这件事办不成（例如找不到、对方拒绝），写了这张单就记「没办成」，不会重试"),
    reason: z.string().max(1000).optional().describe("outcome = not_done 时必填：为什么办不成"),
  }),
  // 报结果（每个任务都自带，run-outcome 第 3 节）：结束时调用，运行到此结束；结果按 docs/dev/run-outcome.md 第 4、5 节再核
  // outcome 只有两种（2026-10-20 简化）；运行中途的模型可能还按旧说明传 partial（部分办成），照收，当没办成
  "run.finish": z.object({
    outcome: z
      .preprocess((value) => (value === "partial" ? "not_achieved" : value), z.enum(["achieved", "not_achieved"]))
      .describe("只看任务目标要的东西拿没拿到：achieved = 办成（都拿到了）；not_achieved = 没办成（没拿到、只拿到一部分、确认「没有」都算）"),
    summary: z.string().min(1).max(4000).describe("做了什么、结果在哪（给人看的总结）"),
    evidence: z.string().min(1).max(4000).describe("对照目标逐条写依据：拿到了什么、在哪能看到；没拿到的写清楚"),
    reason: z.string().max(2000).optional().describe("not_achieved 必填：拿到了什么、缺了什么、为什么"),
  }),
  // 报没完成（2026-10-19 起每个任务都自带，2026-10-20 起被 run.finish 取代）：只为旧运行快照保留，等价于 run.finish outcome = not_achieved
  "run.not_done": z.object({
    reason: z.string().min(1).max(2000).describe("为什么没做成：卡在哪、试过哪些办法、还差什么"),
  }),
  "plan.set": z.object({
    steps: z
      .array(z.string().min(1).max(300))
      .min(1)
      .max(30)
      .describe("你打算怎么做：按顺序写下每一步，一句话一步"),
  }),
} as const

export type BuiltinToolId = keyof typeof builtinToolInputs

/** 「报没完成」（旧）：调用后运行结束，结果记没办成。新运行不再带它，用 run.finish */
export const RUN_NOT_DONE_TOOL_ID = "run.not_done" satisfies BuiltinToolId

/** 「报结果」：结束时调用，运行到此结束 */
export const RUN_FINISH_TOOL_ID = "run.finish" satisfies BuiltinToolId

/** 每个任务都自带的内置工具 */
export const ALWAYS_ON_BUILTIN_TOOLS: readonly BuiltinToolId[] = [
  "checkpoint.mark",
  "session.wait",
  "ask.human",
  "plan.set",
  RUN_FINISH_TOOL_ID,
]

// ---------- 引擎接口（engine-router）的输入输出 ----------

/** 人改结果（run-outcome 第 8 节，tRPC sessions.setOutcome）：只有负责人和管理员能改；只改结果列，不重开运行；被派的单跟着改结果、不改单的状态 */
export const setOutcomeInputSchema = z.object({
  id: z.string().min(1),
  outcome: runOutcomeSchema,
  reason: z.string().trim().min(1, "写一句理由：为什么改成这个结果").max(500, "理由最多 500 个字"),
})
export type SetOutcomeInput = z.infer<typeof setOutcomeInputSchema>

export const runNowInputSchema = z.object({
  taskId: z.string().min(1),
  attachmentFileIds: z.array(z.string().min(1)).max(20).optional(),
  note: z.string().max(2000).optional(),
})
export const sessionIdInputSchema = z.object({ sessionId: z.string().min(1) })
export const cancelInputSchema = sessionIdInputSchema.extend({
  reason: z.string().max(500).optional(),
})

/** 处理要人办的事：approve = 批准，reject = 拒绝，done = 已处理 */
export const humanResolutionSchema = z.enum(["approve", "reject", "done"])
export type HumanResolution = z.infer<typeof humanResolutionSchema>
export const resolveHumanItemInputSchema = z.object({
  itemId: z.string().min(1),
  how: humanResolutionSchema,
  note: z.string().max(4000).optional(),
})

export const fireEventInputSchema = z.object({
  event: z.string().min(1).max(200),
  data: z.record(z.string(), z.unknown()).optional(),
})
export const fireEventResultSchema = z.object({
  resumedSessionIds: z.array(z.string()),
  firedTodoIds: z.array(z.string()),
})
export type FireEventResult = z.infer<typeof fireEventResultSchema>

export const attachInputSchema = z.object({
  taskId: z.string().min(1),
  fileId: z.string().min(1),
})

/** session 里的文件：附件（任务的、这次运行的）和产物 */
export const sessionFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  /** attachment = 附件；artifact = agent 写的文件（file.save / file.edit / code.run 产生的）；tool_output = 太长的工具输出全文；screenshot = 截图；download = 在浏览器里下载的文件；clipboard = 浏览器剪贴板工具存的（复制的图片、读到的剪贴板内容）；network = 记下的网页请求（network/requests.jsonl，docs/dev/solidify.md 19.3） */
  kind: z.enum([
    "attachment",
    "artifact",
    "tool_output",
    "screenshot",
    "upload",
    "download",
    "clipboard",
    "network",
  ]),
  /** 任务附件（跨运行一直有效）还是只属于这次运行 */
  scope: z.enum(["task", "session"]),
  /**
   * 在空间里的路径（docs/dev/session-space.md 2.3）：agent 写的是它给的路径（例如 state/progress.json）；
   * 别的来源放在固定目录下：attachments/ downloads/ screenshots/ tool-outputs/ clipboard/ network/（同名加 -2 -3）。
   */
  path: z.string(),
  createdAt: isoTime,
  /** 最后一次覆盖的时间；没覆盖过 = createdAt */
  updatedAt: isoTime,
  /** 下载地址（要求登录） */
  url: z.string(),
})
export type SessionFile = z.infer<typeof sessionFileSchema>

/** 表格文件（xlsx、xls、csv 等）的预览：GET /api/files/:id/sheet，每个工作表只给前 rowLimit 行 */
export const sheetPreviewSchema = z.object({
  rowLimit: z.number(),
  sheets: z.array(
    z.object({
      name: z.string(),
      hidden: z.boolean(),
      /** 第一行的行号（从 1 开始，和 Excel 里一样） */
      firstRow: z.number(),
      /** 列名：A、B、C… */
      columns: z.array(z.string()),
      /** 单元格都转成文字；每行的长度可能比 columns 短（后面是空格子） */
      rows: z.array(z.array(z.string())),
      totalRows: z.number(),
      totalCols: z.number(),
      /** 合并单元格的个数（值只在左上角那格） */
      merged: z.number(),
    })
  ),
})
export type SheetPreview = z.infer<typeof sheetPreviewSchema>

export const uploadedFileSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  url: z.string(),
})
export type UploadedFile = z.infer<typeof uploadedFileSchema>

export const mcpToolInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.string(), z.unknown()),
})
export type McpToolInfo = z.infer<typeof mcpToolInfoSchema>
export const listMcpServerToolsResultSchema = z.object({
  ok: z.boolean(),
  tools: z.array(mcpToolInfoSchema),
  error: z.string().optional(),
  serverName: z.string().optional(),
})

export const notificationSchema = z.object({
  id: z.number().int(),
  title: z.string(),
  body: z.string(),
  link: z.string().optional(),
  taskId: z.string().optional(),
  sessionId: z.string().optional(),
  createdAt: isoTime,
  readAt: isoTime.optional(),
})
export type AppNotification = z.infer<typeof notificationSchema>
export const notificationListSchema = z.object({
  items: z.array(notificationSchema),
  unread: z.number().int(),
})

// ---------- M3：存为任务步骤、验收争议 ----------

/** 把一次运行里 agent 写下的步骤（plan.set）存成任务的步骤，覆盖原来的步骤 */
export const saveStepsFromSessionInputSchema = z.object({
  sessionId: z.string().min(1),
})

/** 验收争议的三种处理：算通过 / 算失败 / 补充说明后继续 */
export const verifyDisputeHowSchema = z.enum(["pass", "fail", "continue"])
export type VerifyDisputeHow = z.infer<typeof verifyDisputeHowSchema>
export const resolveVerifyDisputeInputSchema = z.object({
  itemId: z.string().min(1),
  how: verifyDisputeHowSchema,
  /** 「补充说明后继续」时交给 agent 的说明；另外两种是备注 */
  note: z.string().max(4000).optional(),
})
