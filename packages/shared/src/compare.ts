// 比图（2026-10-18）：两张图交给视觉模型，按「比对标准」逐项打分、写出差异，判断是不是同款；每次比对都存档。
// 替代原来本机的 Lens MCP。四种入口共用这一份：页面（tRPC compare.*）、agent（内置工具组「比图」）、HTTP 接口、MCP。
// 设计稿：design/BRIEF-compare.md（本地）；开发说明：docs/dev/compare.md。
import { z } from "zod"

import { galleryImageRefSchema } from "./gallery.js"
import { isoTime } from "./schemas.js"

/** 内置工具组「比图」的 id：任务选了它，agent 就能比图、查比对、搜历史 */
export const COMPARE_TOOL_ID = "compare"

/** 同样的两张图 + 同样的要求 + 同一个模型，多久以内重复比直接返回上次的结果（不重复花钱） */
export const COMPARE_REUSE_MINUTES = 10

// ---------- 比对标准 ----------

export const compareStandardSchema = z.object({
  /** std-<序号>；初始自带的是 std-same-item */
  id: z.string(),
  name: z.string(),
  /** 打分要求：什么算像、看哪些方面（每一项单独打分）、哪些差异不算 */
  prompt: z.string(),
  /** 合格线：总分到这里算达标 */
  passScore: z.number().int().min(0).max(100),
  /** 用哪个视觉模型（models.id） */
  modelId: z.string(),
  /** 没指定标准时用它；只有一个 */
  isDefault: z.boolean(),
  createdById: z.string().nullable(),
  updatedAt: isoTime,
})
export type CompareStandard = z.infer<typeof compareStandardSchema>

export const compareStandardInputSchema = z.object({
  name: z.string().trim().min(1, "给标准起个名字，例如「同款判断」").max(50),
  prompt: z.string().trim().min(1, "写清楚什么算像、看哪些方面").max(4000),
  passScore: z.number().int().min(0, "0～100").max(100, "0～100"),
  modelId: z.string().min(1, "选一个视觉模型"),
})
export type CompareStandardInput = z.infer<typeof compareStandardInputSchema>
export const compareStandardUpdateSchema = compareStandardInputSchema.extend({ id: z.string().min(1) })

// ---------- 一次比对 ----------

export const compareStatusSchema = z.enum(["running", "done", "failed"])
export type CompareStatus = z.infer<typeof compareStatusSchema>

export const compareConfidenceSchema = z.enum(["high", "medium", "low"])
export const compareConfidenceLabel = { high: "高", medium: "中", low: "低" } as const

export const compareDimensionSchema = z.object({
  name: z.string(),
  score: z.number().min(0).max(100),
  note: z.string(),
})

/** 谁发起的：人（页面）、agent（哪次运行）、外部系统（HTTP 接口或 MCP，哪个 API 密钥） */
export const compareViaSchema = z.enum(["web", "agent", "api", "mcp"])
export type CompareVia = z.infer<typeof compareViaSchema>

/** 比对里的一张图（存成文件，和图库共用文件存储） */
export const compareImageSchema = z.object({
  fileId: z.string(),
  /** 原图（GET /api/files/:id 或 /api/compare/files/:id，要登录或 API 密钥） */
  url: z.string(),
  /** 说明，例如「原商品」「候选 1 号」；没写是空字符串 */
  label: z.string(),
  /** 从哪来的，给人看：「图库 img-12」「网址 https://…」「上传」「运行 R-… 的截图」 */
  from: z.string(),
})

export const comparisonSchema = z.object({
  /** cmp-<序号> */
  id: z.string(),
  title: z.string(),
  status: compareStatusSchema,
  imageA: compareImageSchema,
  imageB: compareImageSchema,
  /** 用的标准；这次自己写要求的为 null */
  standardId: z.string().nullable(),
  standardName: z.string().nullable(),
  /** 这次实际用的打分要求、合格线、模型（标准以后改了，这里还是当时的） */
  prompt: z.string(),
  passScore: z.number(),
  modelId: z.string(),
  /** 总分 0～100；证据不足（看不清、不是同类东西）时为 null。比对中、没比成时也是 null */
  score: z.number().nullable(),
  /** 达标：score ≥ passScore；没有分数时为 null */
  passed: z.boolean().nullable(),
  confidence: compareConfidenceSchema.nullable(),
  /** 一句话结论 */
  verdict: z.string(),
  reasons: z.array(z.string()),
  dimensions: z.array(compareDimensionSchema),
  differences: z.array(z.string()),
  /** 没比成的原因 */
  error: z.string().nullable(),
  costUsd: z.number(),
  via: compareViaSchema,
  /** 人发起的、API 密钥的创建人 */
  createdById: z.string().nullable(),
  /** agent 发起的：哪次运行、哪个任务 */
  sessionId: z.string().nullable(),
  taskId: z.string().nullable(),
  apiKeyId: z.string().nullable(),
  /** 重复调用直接返回了这一条（COMPARE_REUSE_MINUTES 内同图同要求同模型） */
  reused: z.boolean().optional(),
  createdAt: isoTime,
  finishedAt: isoTime.nullable(),
})
export type Comparison = z.infer<typeof comparisonSchema>

// ---------- 接口输入 ----------

/** 新比对：两张图（图库 id、文件 id、网址、base64），标准或者这次自己写的要求（都不给用默认标准） */
export const compareCreateSchema = z
  .object({
    imageA: galleryImageRefSchema,
    imageB: galleryImageRefSchema,
    labelA: z.string().trim().max(100).optional(),
    labelB: z.string().trim().max(100).optional(),
    /** 标准的 id 或名字 */
    standard: z.string().trim().max(100).optional(),
    /** 这次自己写的要求（和 standard 二选一） */
    prompt: z.string().trim().max(4000).optional(),
    /** 合格线：覆盖标准的；自己写要求时不填就用默认标准的 */
    passScore: z.number().int().min(0).max(100).optional(),
    /** 换模型（不填用标准的模型） */
    modelId: z.string().optional(),
    title: z.string().trim().max(200).optional(),
  })
  .refine((value) => !(value.standard && value.prompt), { message: "标准和自己写的要求只能给一个", path: ["prompt"] })
export type CompareCreateInput = z.infer<typeof compareCreateSchema>

export const compareListInputSchema = z.object({
  /** 搜标题、编号、要求、模型 */
  query: z.string().trim().max(200).optional(),
  status: compareStatusSchema.optional(),
  /** 只看某次运行的 */
  sessionId: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  /** 上一页最后一条的 id */
  cursor: z.string().optional(),
})
export type CompareListInput = z.input<typeof compareListInputSchema>

export const comparePageSchema = z.object({
  items: z.array(comparisonSchema),
  nextCursor: z.string().nullable(),
})
export type ComparePage = z.infer<typeof comparePageSchema>

/** 能比图的视觉模型（models 里 vision = true、能出文字的），价格是每百万 token 的美元 */
export const compareModelSchema = z.object({
  id: z.string(),
  name: z.string(),
  priceIn: z.number(),
  priceOut: z.number(),
})
export type CompareModel = z.infer<typeof compareModelSchema>
