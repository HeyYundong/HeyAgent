// 右下角助手（2026-10-19）：用中文说要新建、修改、删除什么，助手查清楚、列成改动确认卡，人点「应用」后再做。
// 前后端共用这一份：发消息 / 应用改动的请求、流式事件、对话记录、改动确认卡、上限设置。
// 开发说明：docs/dev/copilot.md。
//
// 一轮怎么跑：POST /api/assistant/chat（SSE）→ 模型查（查的工具直接执行）→ 要改时不执行，存成一张改动确认卡（proposal）、这一轮停下
// → POST /api/assistant/apply（SSE）应用或不要 → 结果交回模型，模型接着做或总结。
import { z } from "zod"

import { isoTime } from "./schemas.js"

// ---------- 上限 ----------

/** 每个人保留最近多少段对话（多的删掉最旧的） */
export const ASSISTANT_MAX_CHATS = 50
/** 一条消息最长多少字 */
export const ASSISTANT_MAX_MESSAGE = 8000
/** 一条消息最多带几张图 */
export const ASSISTANT_MAX_IMAGES = 6

/** 设置页「助手」一组；默认值在 config.ts 的 SETTINGS_DEFAULTS（20 步、0.2 美元） */
export const settingsAssistantInputSchema = z.object({
  /** 一次请求（发一条消息或应用一张卡之后）最多几步模型调用 */
  maxSteps: z.number().int().min(1, "至少 1 步").max(100, "最多 100 步"),
  /** 一次请求最多花多少美元 */
  maxCostUsd: z.number().min(0.01, "至少 0.01 美元").max(10, "最多 10 美元"),
})
export type SettingsAssistantInput = z.infer<typeof settingsAssistantInputSchema>

/**
 * 一段对话自己的设置（面板「本对话的设置」）：都可以是 null = 跟默认走。
 * 模型 null = 「模型」页的助手默认模型，没配用 plan 默认模型；上限 null = 设置页「助手」一组的全局值。
 * 本对话的上限只能在设置页的范围内调（同 settingsAssistantInputSchema：1～100 步、0.01～10 美元）
 */
export const assistantChatSettingsSchema = z.object({
  modelId: z.string().trim().min(1).max(200).nullable(),
  maxSteps: z.number().int("填整数").min(1, "至少 1 步").max(100, "最多 100 步").nullable(),
  maxCostUsd: z.number().min(0.01, "至少 0.01 美元").max(10, "最多 10 美元").nullable(),
})
export type AssistantChatSettings = z.infer<typeof assistantChatSettingsSchema>

/** 数字框的文字：空着 = null（跟默认走），不然按 schema 校验 */
const blankOrNumber = (schema: z.ZodNumber) =>
  z
    .string()
    .trim()
    .transform((text, ctx) => {
      if (!text) return null
      const value = Number(text)
      const parsed = schema.safeParse(value)
      if (parsed.success) return parsed.data
      ctx.addIssue({ code: "custom", message: Number.isNaN(value) ? "填一个数字" : (parsed.error.issues[0]?.message ?? "不对") })
      return z.NEVER
    })

/** 面板「本对话的设置」的表单：模型空字符串、数字框空着 = 跟默认走；提交时转成 AssistantChatSettings */
export const assistantChatSettingsFormSchema = z
  .object({
    modelId: z.string().trim().max(200),
    maxSteps: blankOrNumber(assistantChatSettingsSchema.shape.maxSteps.unwrap()),
    maxCostUsd: blankOrNumber(assistantChatSettingsSchema.shape.maxCostUsd.unwrap()),
  })
  .transform((form): AssistantChatSettings => ({ modelId: form.modelId || null, maxSteps: form.maxSteps, maxCostUsd: form.maxCostUsd }))
export type AssistantChatSettingsForm = z.input<typeof assistantChatSettingsFormSchema>

/** assistant.updateSettings：改自己的一段对话的设置（整份替换） */
export const assistantUpdateSettingsInputSchema = assistantChatSettingsSchema.extend({ id: z.string().max(64) })
export type AssistantUpdateSettingsInput = z.infer<typeof assistantUpdateSettingsInputSchema>

/** assistant.defaults：本对话没单独设时实际会用的值（设置面板里「跟默认走（xxx）」和数字框的 placeholder） */
export const assistantDefaultsSchema = z.object({
  /** 「模型」页的助手默认模型，没配时是 plan 默认模型；都没配是 null */
  modelId: z.string().nullable(),
  modelName: z.string().nullable(),
  maxSteps: z.number(),
  maxCostUsd: z.number(),
})
export type AssistantDefaults = z.infer<typeof assistantDefaultsSchema>

// ---------- 请求 ----------

/** 发消息时带上人现在在哪一页、选中了哪一项（前端 useRoute() 的 page 和 params），助手才知道「这个任务」是哪个 */
export const assistantPageContextSchema = z.object({
  page: z.string().max(50),
  params: z.record(z.string(), z.string().max(200)).default({}),
})
export type AssistantPageContext = z.infer<typeof assistantPageContextSchema>

export const assistantChatInputSchema = z
  .object({
    /** 不填 = 开一段新对话 */
    chatId: z.string().max(64).optional(),
    /** 只发图时可以空着 */
    message: z.string().trim().max(ASSISTANT_MAX_MESSAGE, `最多 ${ASSISTANT_MAX_MESSAGE} 字`).default(""),
    /** 随这句话一起给助手看的图：先 POST /api/files 上传拿到的文件编号（只收 png / jpeg / gif / webp） */
    images: z.array(z.string().max(64)).max(ASSISTANT_MAX_IMAGES, `一次最多 ${ASSISTANT_MAX_IMAGES} 张图`).default([]),
    context: assistantPageContextSchema.optional(),
    /** 新对话在发第一句之前就设好的本对话设置；只在新建对话（不带 chatId）时用，已有的对话改设置走 assistant.updateSettings */
    settings: assistantChatSettingsSchema.optional(),
  })
  .refine((input) => input.message.length > 0 || input.images.length > 0, { message: "说点什么", path: ["message"] })
export type AssistantChatInput = z.infer<typeof assistantChatInputSchema>

export const assistantApplyInputSchema = z.object({
  proposalId: z.string().max(64),
  /** true = 应用；false = 不要 */
  accept: z.boolean(),
  /** 点「不要」时可以顺便说为什么 / 要怎么改，交给模型 */
  note: z.string().trim().max(2000).optional(),
  context: assistantPageContextSchema.optional(),
})
export type AssistantApplyInput = z.infer<typeof assistantApplyInputSchema>

// ---------- 改动确认卡 ----------

/** 卡上一项改动里的一个字段：改前 → 改后（新建只有 after，删除只有 before）。前端按句、按词对比两边，标出加了 / 删了什么 */
export const assistantFieldChangeSchema = z.object({
  label: z.string(),
  before: z.string().optional(),
  after: z.string().optional(),
  /** 按条对比的列表（任务步骤）：一条一个字符串，不带编号。有它时前端逐条对比、标第几步；老卡没有，退回按文字对比 */
  steps: z.object({ before: z.array(z.string()), after: z.array(z.string()) }).optional(),
})

/** 做完以后能跳过去看的地方（前端用 href(page, params)） */
export const assistantLinkSchema = z.object({ page: z.string(), params: z.record(z.string(), z.string()).default({}) })
export type AssistantLink = z.infer<typeof assistantLinkSchema>

export const assistantChangeSchema = z.object({
  /** 对应模型的那次工具调用 */
  callId: z.string(),
  /** 工具名，例如 create_task */
  tool: z.string(),
  /** 一句话，例如「新建任务「每日巡检」」「删除记忆 M12」 */
  title: z.string(),
  fields: z.array(assistantFieldChangeSchema),
  /** 删除、归档这类：卡上「应用」按钮变 destructive，写明「会删除 N 项」 */
  destructive: z.boolean(),
  /** 应用后才有 */
  result: z
    .object({
      ok: z.boolean(),
      /** 成功时例如「已建好 T12」；失败时是报错原文（例如没有权限） */
      message: z.string(),
      link: assistantLinkSchema.optional(),
    })
    .optional(),
})
export type AssistantChange = z.infer<typeof assistantChangeSchema>

/** pending 等人确认 → applied 已应用（各项成败看 result）/ rejected 人点了不要 / expired 人没理它又发了新消息 */
export const assistantProposalStatusSchema = z.enum(["pending", "applied", "rejected", "expired"])
export type AssistantProposalStatus = z.infer<typeof assistantProposalStatusSchema>

export const assistantProposalSchema = z.object({
  id: z.string(),
  status: assistantProposalStatusSchema,
  changes: z.array(assistantChangeSchema),
})
export type AssistantProposal = z.infer<typeof assistantProposalSchema>

// ---------- 对话记录（面板上显示的一条条） ----------

export const assistantToolStatusSchema = z.enum(["running", "done", "error"])

/** 记录里的一张图（人发的、助手用 view_image 看过的）：前端照 components/files 的 ShownFile 显示缩略图、点开看大图 */
export const assistantImageSchema = z.object({
  id: z.string(),
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  /** GET /api/files/:id */
  url: z.string(),
})
export type AssistantImage = z.infer<typeof assistantImageSchema>

export const assistantEntrySchema = z.discriminatedUnion("kind", [
  /** text 可能是空的（只发了图）；images 文件被删了的不列 */
  z.object({ kind: z.literal("user"), id: z.string(), text: z.string(), images: z.array(assistantImageSchema).optional(), at: isoTime }),
  z.object({ kind: z.literal("assistant"), id: z.string(), text: z.string(), at: isoTime }),
  /** 查了什么：一行 Trace，展开看输入输出摘要 */
  z.object({
    kind: z.literal("tool"),
    id: z.string(),
    tool: z.string(),
    /** 中文，例如「查任务列表」「看任务 T12」 */
    label: z.string(),
    status: assistantToolStatusSchema,
    /** 展开后显示的细节（输入、输出摘要或报错），已截短 */
    detail: z.string().optional(),
    /** view_image 看过的图，Trace 下面显示缩略图 */
    images: z.array(assistantImageSchema).optional(),
    at: isoTime,
  }),
  z.object({ kind: z.literal("proposal"), id: z.string(), proposal: assistantProposalSchema, at: isoTime }),
  /** 停下来的原因：到了上限、模型出错、没配模型 */
  z.object({ kind: z.literal("notice"), id: z.string(), text: z.string(), tone: z.enum(["info", "error"]), at: isoTime }),
])
export type AssistantEntry = z.infer<typeof assistantEntrySchema>

export const assistantChatSummarySchema = z.object({
  id: z.string(),
  title: z.string(),
  /** 本对话设的模型、上限；null = 跟默认走 */
  modelId: z.string().nullable(),
  maxSteps: z.number().nullable(),
  maxCostUsd: z.number().nullable(),
  costUsd: z.number(),
  updatedAt: isoTime,
})
export type AssistantChatSummary = z.infer<typeof assistantChatSummarySchema>

export const assistantChatSchema = assistantChatSummarySchema.extend({
  entries: z.array(assistantEntrySchema),
  /** 还在等人确认的卡（最多一张） */
  pendingProposalId: z.string().nullable(),
})
export type AssistantChat = z.infer<typeof assistantChatSchema>

// ---------- 流式事件（SSE 每个 data: 一个 JSON） ----------

export const assistantStreamEventSchema = z.discriminatedUnion("type", [
  /** 第一条：对话编号（新对话这时才有）和标题 */
  z.object({ type: z.literal("chat"), chatId: z.string(), title: z.string() }),
  /** 一条新的记录（user / tool / proposal / notice，以及开始写的 assistant，text 可能是空的） */
  z.object({ type: z.literal("entry"), entry: assistantEntrySchema }),
  /** assistant 记录的文字片段，接在 id 那条后面 */
  z.object({ type: z.literal("delta"), id: z.string(), text: z.string() }),
  /** 已有记录变了（tool 跑完、proposal 应用后带上 result），整条替换 */
  z.object({ type: z.literal("update"), entry: assistantEntrySchema }),
  /** 最后一条：这次请求花了多少；有 proposal 等确认时 pendingProposalId 不为空 */
  z.object({ type: z.literal("done"), costUsd: z.number(), pendingProposalId: z.string().nullable() }),
  /** 请求本身出错（没登录、对话不存在、卡已经处理过……）；流随后结束 */
  z.object({ type: z.literal("error"), message: z.string() }),
])
export type AssistantStreamEvent = z.infer<typeof assistantStreamEventSchema>
