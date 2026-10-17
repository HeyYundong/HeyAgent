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

// ---------- 设置（settings 表的键；和包 P2 的 config.ts 里 SETTING_KEYS 是同一组字符串） ----------

/** 引擎读的 settings 键。值的格式见注释；读不到就用 ENGINE_SETTING_DEFAULTS */
export const ENGINE_SETTING_KEYS = {
  /** 单个 session 的花费上限（美元，数字） */
  maxCostUsd: "session.maxCostUsd",
  /** 单个 session 最多步数（模型调用次数，整数） */
  maxSteps: "session.maxSteps",
  /** 只等事件时的兜底天数（整数） */
  eventFallbackDays: "wait.eventFallbackDays",
  /** 外部事件令牌：{ sha256, hint, createdAt }，只存哈希 */
  eventToken: "events.token",
  /** 通知渠道：NotifyChannelConfig[] */
  notifyChannels: "notify.channels",
} as const

export const ENGINE_SETTING_DEFAULTS = {
  maxCostUsd: 2,
  maxSteps: 100,
  eventFallbackDays: 7,
} as const

export const notifyChannelConfigSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["feishu", "wecom", "webhook"]),
  /** webhook 地址存在 secrets 里（scope = http_tool，ref_id 为空）的名字 */
  urlSecretName: z.string(),
  enabled: z.boolean(),
})
export type NotifyChannelConfig = z.infer<typeof notifyChannelConfigSchema>

export const engineEventTokenSchema = z.object({
  sha256: z.string(),
  hint: z.string().optional(),
  createdAt: z.string().optional(),
})

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
  memories: z.array(
    z.object({ id: z.string(), content: z.string(), appliesTo: z.string() })
  ),
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
  source: z.enum(["manual", "cron", "todo", "event"]),
})
export type SessionSnapshot = z.infer<typeof sessionSnapshotSchema>

// ---------- 内置工具的输入（模型看到的 JSON Schema 由这些 zod schema 生成） ----------

export const builtinToolInputs = {
  "checkpoint.mark": z.object({
    checkpoint: z
      .number()
      .int()
      .min(1)
      .describe("检查点编号（系统提示里检查点清单的序号，从 1 开始）"),
    status: z
      .enum(["done", "skipped"])
      .describe("done = 完成；skipped = 跳过（必须写理由）"),
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
} as const

export type BuiltinToolId = keyof typeof builtinToolInputs

/** 每个任务都自带的内置工具 */
export const ALWAYS_ON_BUILTIN_TOOLS: readonly BuiltinToolId[] = [
  "checkpoint.mark",
  "session.wait",
  "ask.human",
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
