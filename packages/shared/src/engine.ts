// 引擎相关的共享类型（M1 包 P1 负责）：session 快照、内置工具的输入、通知、文件、引擎接口的输入输出。
// 平台通用：这里只有通用的概念（任务、检查点、等待、问人、文件），不出现任何业务。
import { z } from "zod"

import {
  checkpointKindSchema,
  httpSpecSchema,
  isoTime,
  riskSchema,
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
  memories: z.array(
    z.object({ id: z.string(), content: z.string(), appliesTo: z.string() })
  ),
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
      /** 人在派活页派的：谁（第一条消息里写「某某在派活页派的」） */
      fromUser: z.object({ id: z.string(), name: z.string() }).optional(),
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
  /** M2：任务选了「浏览器」工具时才有：允许的 Chrome 配置（含给 agent 看的说明）、网址白名单、是否允许执行脚本 */
  browser: z
    .object({
      profiles: z.array(
        z.object({ id: z.string(), name: z.string(), description: z.string() })
      ),
      allowedDomains: z.array(z.string()),
      allowEvaluate: z.boolean(),
    })
    .optional(),
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
    name: z
      .string()
      .min(1)
      .max(200)
      .describe(
        "文件名，带扩展名，例如 result.csv。支持 csv、tsv、md、json、txt、html、xml、yaml"
      ),
    content: z.string().max(5_000_000).describe("文件内容（文本）"),
  }),
  "file.read": z.object({
    fileId: z
      .string()
      .min(1)
      .describe(
        "附件或文件的 id（见系统提示里的附件清单，或工具输出里给的文件 id）"
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe("文本文件从第几个字符开始读（默认 0，长文件分段读）"),
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
  "plan.set": z.object({
    steps: z
      .array(z.string().min(1).max(300))
      .min(1)
      .max(30)
      .describe("你打算怎么做：按顺序写下每一步，一句话一步"),
  }),
} as const

export type BuiltinToolId = keyof typeof builtinToolInputs

/** 每个任务都自带的内置工具 */
export const ALWAYS_ON_BUILTIN_TOOLS: readonly BuiltinToolId[] = [
  "checkpoint.mark",
  "session.wait",
  "ask.human",
  "plan.set",
]

// ---------- 引擎接口（engine-router）的输入输出 ----------

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
  /** attachment = 附件；artifact = agent 产出的文件；tool_output = 太长的工具输出全文；screenshot = 截图 */
  kind: z.enum([
    "attachment",
    "artifact",
    "tool_output",
    "screenshot",
    "upload",
  ]),
  /** 任务附件（跨运行一直有效）还是只属于这次运行 */
  scope: z.enum(["task", "session"]),
  createdAt: isoTime,
  /** 下载地址（要求登录） */
  url: z.string(),
})
export type SessionFile = z.infer<typeof sessionFileSchema>

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
