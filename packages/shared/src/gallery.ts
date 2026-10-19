// 图库：一张图 = 图片 + 文本（必须是 JSON 对象）+ 标签（必须是字符串数组）。
// 页面（tRPC）、HTTP 接口、MCP、agent 的内置工具共用这里的 schema，校验规则只有一份。
// 检索：标签、JSON 条件先筛，再按向量相似度排（传了图或一句描述时）；没传就按上传时间倒序。
import { z } from "zod"

import { isoTime } from "./schemas.js"

/** 系统自带的「图库」工具（来源 builtin）：任务选了它，就开放整组图库工具（gallery.search 等，不含删除） */
export const GALLERY_TOOL_ID = "gallery"

/**
 * 向量统一 1024 维：换 embedding 模型时表结构不变，HNSW 索引也不用重建。
 * OpenRouter 上能处理图片的 3 个 embedding 模型（gemini-embedding-2、voyage-multimodal-3.5、nemotron-embed-vl）都支持 dimensions=1024（2026-10-17 实测）。
 */
export const GALLERY_EMBED_DIMENSIONS = 1024

/**
 * 比对时相似度到多少算「同一张 / 同款」（余弦相似度，-1～1）。没标定过的模型用它；调用时可以自己传 threshold。
 * 各模型分数分布差很多（docs/dev/gallery.md 第 4 节，2026-10-17 用 15 张真实照片标定）：
 * gemini-embedding-2 同一张图改大小、裁边、调亮 ≥ 0.945，同类不同图平均 0.80，完全不同平均 0.69；
 * voyage-multimodal-3.5 同一张缩到三分之一最低 0.72，完全不同最高 0.64。
 */
export const GALLERY_SAME_THRESHOLD = 0.9

const SAME_THRESHOLDS: Record<string, number> = {
  "google/gemini-embedding-2": 0.9,
  "google/gemini-embedding-2-preview": 0.9,
  "voyageai/voyage-multimodal-3.5": 0.8,
}

/** 某个 embedding 模型（服务 id/模型名）默认的「同一张 / 同款」阈值 */
export function gallerySameThreshold(modelId: string) {
  const known = Object.keys(SAME_THRESHOLDS).find((slug) => modelId === slug || modelId.endsWith(`/${slug}`))
  return known ? SAME_THRESHOLDS[known]! : GALLERY_SAME_THRESHOLD
}

export const GALLERY_TEXT_MAX_BYTES = 64 * 1024
export const GALLERY_TAGS_MAX = 50
export const GALLERY_TAG_MAX_CHARS = 64
/** 能存的图片格式（GIF 只取第一帧算向量、做缩略图） */
export const GALLERY_IMAGE_MIMES = ["image/jpeg", "image/png", "image/webp", "image/gif"] as const

/** JSON 序列化后的 UTF-8 字节数（shared 不依赖 DOM / Node 的类型，所以自己数） */
function jsonBytes(value: unknown) {
  let bytes = 0
  for (const char of JSON.stringify(value) ?? "") {
    const code = char.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/** 文本：必须是 JSON 对象（数组、字符串、数字、null 都不行） */
export const galleryTextSchema = z
  .record(z.string(), z.unknown(), { error: "text 必须是 JSON 对象，例如 {\"名称\": \"…\"}" })
  .refine((value) => jsonBytes(value) <= GALLERY_TEXT_MAX_BYTES, `text 太大，最多 ${GALLERY_TEXT_MAX_BYTES / 1024} KB`)

/** 标签：必须是字符串数组；前后空格会去掉，重复的只留一个（normalizeTags） */
export const galleryTagsSchema = z
  .array(z.string({ error: "标签必须是字符串" }).trim().min(1, "标签不能是空的").max(GALLERY_TAG_MAX_CHARS, `每个标签最多 ${GALLERY_TAG_MAX_CHARS} 个字`), {
    error: "tags 必须是字符串数组，例如 [\"红色\", \"杯子\"]",
  })
  .max(GALLERY_TAGS_MAX, `最多 ${GALLERY_TAGS_MAX} 个标签`)

export function normalizeTags(tags: readonly string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))]
}

/** 一张图从哪来：页面上传、HTTP 接口、MCP、agent 的工具 */
export const galleryViaSchema = z.enum(["web", "api", "mcp", "agent"])
export type GalleryVia = z.infer<typeof galleryViaSchema>

export const galleryViaLabel: Record<GalleryVia, string> = { web: "页面上传", api: "HTTP 接口", mcp: "MCP", agent: "agent" }

/**
 * 指一张图片：图库里已有的（imageId，比对、找相似时直接用存好的向量）、HeyAgent 的文件（fileId）、网址（url，服务器去下载）、
 * 或者直接给内容（base64）。上传时不能用 imageId。
 */
export const galleryImageRefSchema = z.union([
  z.object({ imageId: z.string().min(1).describe("图库里已有图片的 id，例如 img-12") }),
  z.object({ fileId: z.string().min(1).describe("HeyAgent 的文件 id，例如 f-…（截图、附件）") }),
  z.object({ url: z.string().regex(/^https?:\/\/\S+$/, "url 要以 http:// 或 https:// 开头").describe("图片网址，服务器去下载") }),
  z.object({
    base64: z.string().min(1).describe("图片内容的 base64（可以带 data:image/...;base64, 前缀）"),
    mime: z.string().optional().describe("图片类型，例如 image/png；不填就按内容判断"),
  }),
])
export type GalleryImageRef = z.infer<typeof galleryImageRefSchema>

export const galleryConditionOpSchema = z.enum(["eq", "ne", "gt", "gte", "lt", "lte", "contains", "exists"])
export type GalleryConditionOp = z.infer<typeof galleryConditionOpSchema>

/**
 * 按 JSON 字段加条件：path 是字段路径（"a.b.c"，或数组 ["a", "b.c", 0] 用于键里有点或取数组下标）。
 * eq / ne：等于、不等于（值是任意 JSON）；gt / gte / lt / lte：数字按大小、字符串按字典序（日期写成 2026-10-17 这种就能比）；
 * contains：字符串包含（不分大小写）或数组里有这个值；exists：有这个字段。
 */
export const galleryConditionSchema = z
  .object({
    path: z.union([z.string().trim().min(1), z.array(z.union([z.string(), z.number().int().min(0)])).min(1).max(20)]),
    op: galleryConditionOpSchema,
    value: z.unknown().optional(),
  })
  .superRefine((cond, issue) => {
    const value = cond.value
    if (cond.op === "exists") return
    if (value === undefined) issue.addIssue({ code: "custom", message: `条件 ${cond.op} 要给 value`, path: ["value"] })
    else if (["gt", "gte", "lt", "lte"].includes(cond.op) && typeof value !== "number" && typeof value !== "string")
      issue.addIssue({ code: "custom", message: `条件 ${cond.op} 的 value 要是数字或字符串`, path: ["value"] })
    else if (cond.op === "contains" && !["string", "number", "boolean"].includes(typeof value))
      issue.addIssue({ code: "custom", message: "条件 contains 的 value 要是字符串、数字或布尔值", path: ["value"] })
  })
export type GalleryCondition = z.infer<typeof galleryConditionSchema>

/** 字段路径拆成一段一段：「a.b.0」→ ["a", "b", "0"] */
export function conditionPath(path: GalleryCondition["path"]): string[] {
  return typeof path === "string" ? path.split(".").filter(Boolean) : path.map(String)
}

/** 筛选条件：都可以不填，填了的同时满足 */
export const galleryFilterSchema = z.object({
  /** 这些标签都要有 */
  tags: galleryTagsSchema.optional(),
  /** 这些标签有一个就行 */
  anyTags: galleryTagsSchema.optional(),
  /** JSON 包含匹配：text 里包含这段 JSON（值要完全相等） */
  text: galleryTextSchema.optional(),
  /** 按字段加条件 */
  where: z.array(galleryConditionSchema).max(20).optional(),
  /** 关键词：在 text 的所有值里找（不分大小写，不找键名） */
  keyword: z.string().trim().min(1).max(200).optional(),
})
export type GalleryFilter = z.infer<typeof galleryFilterSchema>

const limitSchema = z.number().int().min(1).max(200).optional()

/** 检索（HTTP / MCP）：传 image 就是以图搜图，传 query 就是用一句描述找图（两个不能同时传） */
export const gallerySearchSchema = galleryFilterSchema.extend({
  image: galleryImageRefSchema.optional(),
  query: z.string().trim().min(1).max(2000).optional(),
  /** 只要相似度不低于这个值的（-1～1，只在传了 image / query 时有用） */
  minScore: z.number().min(-1).max(1).optional(),
  limit: limitSchema,
  /** 翻页（只在没传 image / query 时有用）：上一页返回的 nextCursor */
  cursor: z.string().optional(),
})
export type GallerySearchInput = z.infer<typeof gallerySearchSchema>

/** 页面列表（tRPC）：和检索一样，只是「以图搜图」只能指图库里已有的图（找相似）；上传一张图来搜走 HTTP 接口 */
export const galleryListInputSchema = galleryFilterSchema.extend({
  similarTo: z.string().min(1).optional(),
  query: z.string().trim().min(1).max(2000).optional(),
  limit: limitSchema,
  cursor: z.string().optional(),
})
export type GalleryListInput = z.infer<typeof galleryListInputSchema>

export const galleryUploadSchema = z.object({
  image: galleryImageRefSchema,
  text: galleryTextSchema.optional(),
  tags: galleryTagsSchema.optional(),
})
export type GalleryUploadInput = z.infer<typeof galleryUploadSchema>

export const galleryCompareSchema = z.object({
  a: galleryImageRefSchema,
  b: galleryImageRefSchema,
  /** 相似度到多少算同一张 / 同款，不填用 GALLERY_SAME_THRESHOLD */
  threshold: z.number().min(-1).max(1).optional(),
})
export type GalleryCompareInput = z.infer<typeof galleryCompareSchema>

/** 改文本、标签：text / tags 是整体替换；addTags / removeTags 是在现有标签上加减 */
export const galleryUpdateSchema = z.object({
  id: z.string().min(1),
  text: galleryTextSchema.optional(),
  tags: galleryTagsSchema.optional(),
  addTags: galleryTagsSchema.optional(),
  removeTags: galleryTagsSchema.optional(),
})
export type GalleryUpdateInput = z.infer<typeof galleryUpdateSchema>

export const galleryImageSchema = z.object({
  id: z.string(),
  /** 原图（GET，要登录或 API 密钥） */
  url: z.string(),
  /** 缩略图（长边 512 的 webp） */
  thumbUrl: z.string(),
  text: z.record(z.string(), z.unknown()),
  tags: z.array(z.string()),
  /** 上传时的文件名 */
  name: z.string(),
  mime: z.string(),
  size: z.number(),
  width: z.number(),
  height: z.number(),
  sha256: z.string(),
  via: galleryViaSchema,
  createdAt: isoTime,
  updatedAt: isoTime,
  /** 谁传的（agent 传的没有）；API 密钥传的算密钥的创建人 */
  createdById: z.string().optional(),
  /** agent 传的：哪次运行 */
  sessionId: z.string().optional(),
  /** 当前的 embedding 模型有没有算过它的向量（没算过的搜图时搜不到） */
  embedded: z.boolean(),
  /** 检索时的相似度（余弦，-1～1）；没传图 / 描述时没有 */
  score: z.number().optional(),
})
export type GalleryImage = z.infer<typeof galleryImageSchema>

/** 一张图在当前 embedding 模型下的向量（图库抽屉最下面显示，能复制整个数组）；当前模型没算过时接口返回 null */
export const galleryEmbeddingSchema = z.object({
  model: z.object({ id: z.string(), name: z.string() }),
  vector: z.array(z.number()),
})
export type GalleryEmbedding = z.infer<typeof galleryEmbeddingSchema>

export const galleryPageSchema = z.object({
  items: z.array(galleryImageSchema),
  /** 还有下一页时给（只在按时间排时有） */
  nextCursor: z.string().optional(),
  /** 这次检索用的 embedding 模型（以图搜图 / 按描述找时有） */
  model: z.string().optional(),
})
export type GalleryPage = z.infer<typeof galleryPageSchema>

export const galleryUploadResultSchema = z.object({
  image: galleryImageSchema,
  /** 一模一样的文件已经在图库里了：返回已有的那条，不新建，也不改它的文本和标签 */
  duplicate: z.boolean(),
})
export type GalleryUploadResult = z.infer<typeof galleryUploadResultSchema>

export const galleryCompareResultSchema = z.object({
  score: z.number(),
  same: z.boolean(),
  threshold: z.number(),
  model: z.string(),
})
export type GalleryCompareResult = z.infer<typeof galleryCompareResultSchema>

export const galleryStatsSchema = z.object({
  total: z.number(),
  /** 当前默认的 embedding 模型；没配时没有（以图搜图、按描述找都用不了） */
  embedModel: z.object({ id: z.string(), name: z.string() }).optional(),
  /** 当前模型还没算向量的图（刚换模型时后台在重算） */
  pending: z.number(),
  /** 最近一次算向量失败的原因 */
  lastError: z.string().optional(),
})
export type GalleryStats = z.infer<typeof galleryStatsSchema>

export const galleryTagCountSchema = z.object({ tag: z.string(), count: z.number() })
export type GalleryTagCount = z.infer<typeof galleryTagCountSchema>

/** 页面的传图、编辑表单：文本在表单里是一段 JSON 文字（可以空着），提交时用 galleryFormText 转成对象 */
export const galleryFormSchema = z.object({
  tags: galleryTagsSchema,
  text: z.string().superRefine((value, issue) => {
    if (!value.trim()) return
    let parsed: unknown
    try {
      parsed = JSON.parse(value)
    } catch {
      issue.addIssue({ code: "custom", message: "不是合法的 JSON：检查引号、逗号和括号" })
      return
    }
    const checked = galleryTextSchema.safeParse(parsed)
    if (!checked.success) issue.addIssue({ code: "custom", message: checked.error.issues[0]?.message ?? "text 必须是 JSON 对象" })
  }),
})
export type GalleryForm = z.input<typeof galleryFormSchema>

export const galleryFormText = (text: string): Record<string, unknown> => (text.trim() ? (JSON.parse(text) as Record<string, unknown>) : {})

// ---------- API 密钥（外部系统调 HeyAgent 的接口用，目前是图库的 HTTP 接口和 MCP） ----------

export const apiKeySchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 只给尾号 */
  hint: z.string(),
  createdAt: isoTime,
  /** 用这个密钥做的事都算在这个人头上（只有主管能建密钥） */
  createdById: z.string(),
  lastUsedAt: isoTime.optional(),
})
export type ApiKey = z.infer<typeof apiKeySchema>

export const apiKeyCreateSchema = z.object({ name: z.string().trim().min(1, "给密钥起个名字，例如「ERP 同步」").max(60) })
export type ApiKeyCreateInput = z.input<typeof apiKeyCreateSchema>

/** 新建时只返回这一次原文 */
export const apiKeyCreatedSchema = z.object({ id: z.string(), name: z.string(), key: z.string() })
export type ApiKeyCreated = z.infer<typeof apiKeyCreatedSchema>
