// 记忆按内容自动挑选（docs/dev/memory-retrieval.md）：运行开始时，按这次要办的事从记忆库里挑出相关的几条，和手选的一起给 agent。
// 这里是前后端共用的约定：任务上的设置、记忆向量算没算好、快照里记的挑选结果、运行详情里「这次用了哪些记忆」。
// 平台通用：只有「记忆」「任务」「相似度」这些通用概念，不出现任何业务。
import { z } from "zod"

// 不从 schemas.ts 引：schemas.ts 的记忆、运行详情要引这里的类型，互相引用会在模块初始化时拿到未定义的值（同 routine.ts）
const isoTime = z.string()

// ---------- 向量 ----------

/**
 * 记忆的向量维数。和图库一样统一 1024 维（GALLERY_EMBED_DIMENSIONS）：两边用同一个 embedding 模型（模型页「默认设置」里的 embed），
 * 换模型时表结构不变。不从 gallery.ts 引常量：gallery.ts 引 schemas.ts，会绕成环
 */
export const MEMORY_EMBED_DIMENSIONS = 1024

/**
 * 一条记忆拿去算向量的文字：「适用于」一行 + 内容。服务端用 md5(这段文字) 判断向量是不是按现在的内容算的，
 * SQL 里写成 md5(applies_to || E'\n' || content)，两边必须一致（改这里要同时改 server/src/memory/ 里的 SQL，并有测试对上）
 */
export function memoryEmbedText(memory: { appliesTo: string; content: string }) {
  return `${memory.appliesTo}\n${memory.content}`
}

/** 一条记忆在当前 embedding 模型下的向量：算好了 / 还没算（刚建、刚改、刚换模型）/ 算失败（隔 10 分钟自动重试） */
export const memoryEmbedStateSchema = z.enum(["ready", "pending", "failed"])
export type MemoryEmbedState = z.infer<typeof memoryEmbedStateSchema>
export const memoryEmbedStateLabel: Record<MemoryEmbedState, string> = { ready: "算好了", pending: "还在算", failed: "算失败" }

/** 记忆列表（memories.list）里每条记忆的向量情况；没设 embedding 模型、或者记忆不是「生效」时没有 */
export const memoryEmbedInfoSchema = z.object({
  state: memoryEmbedStateSchema,
  /** 算失败的原因（state = failed 时有） */
  error: z.string().optional(),
})
export type MemoryEmbedInfo = z.infer<typeof memoryEmbedInfoSchema>

// ---------- 任务上的设置 ----------

/** 新建任务时「自动挑选记忆」默认开（已有的任务迁移时是关的，见设计第 4 节） */
export const AUTO_MEMORY_DEFAULT = true
/** 自动挑的最多几条：默认 5，能选 1～20 */
export const AUTO_MEMORY_LIMIT_DEFAULT = 5
export const AUTO_MEMORY_LIMIT_MAX = 20
/** 任务弹窗里「最多几条」的选项 */
export const AUTO_MEMORY_LIMIT_OPTIONS = [3, 5, 10, 20] as const

// ---------- 挑选 ----------

/** 拿来挑记忆的文字最多多少字（任务标题、目标、步骤、这次的说明、派活参数拼起来，超出的截掉） */
export const AUTO_MEMORY_QUERY_MAX_CHARS = 2000
/** 运行开始时顺手补算的记忆最多几条（多出来的等后台算，这次不参与挑选） */
export const AUTO_MEMORY_INLINE_EMBED_MAX = 64
/** 挑选整体最多等多久（毫秒）：超时就不挑，运行照常开始 */
export const AUTO_MEMORY_TIMEOUT_MS = 20_000

/**
 * 相似度门槛（余弦相似度）：低于它的不挑。各模型分数分布不一样，按模型给；没标定过的用 AUTO_MEMORY_MIN_SCORE（0.6，占位值）。
 * 标定见设计第 9.3 节（2026-10-28，spikes/memory-retrieval/2026-10-28/）
 */
export const AUTO_MEMORY_MIN_SCORE = 0.6

const MIN_SCORES: Record<string, number> = {
  // 2026-10-28 标定：该挑的 0.64～0.83（平均 0.77），不该挑的 0.55～0.79（平均 0.65）；0.70 留住 89% 该挑的、挡掉 88% 不该挑的（别的类的挡掉 94%）
  "google/gemini-embedding-2": 0.7,
}

/** 某个 embedding 模型（服务 id/模型名）挑记忆的相似度门槛 */
export function autoMemoryMinScore(modelId: string) {
  const known = Object.keys(MIN_SCORES).find((slug) => modelId === slug || modelId.endsWith(`/${slug}`))
  return known ? MIN_SCORES[known]! : AUTO_MEMORY_MIN_SCORE
}

/**
 * 这次运行的自动挑选（冻在快照的 autoMemory 里）：
 * - pending：开始运行时任务开着「自动挑选记忆」，还没挑（worker 进这次运行时先挑，挑完改成别的，不会再挑第二次）；
 * - done：挑过了（可能一条也没挑到：没有够像的）；
 * - skipped：没挑，原因见 reason（没设 embedding 模型、没有可挑的记忆）；
 * - failed：调 embedding 模型出错或超时，原因见 reason。运行照常，只是没有自动挑的记忆
 */
export const autoMemoryStatusSchema = z.enum(["pending", "done", "skipped", "failed"])
export type AutoMemoryStatus = z.infer<typeof autoMemoryStatusSchema>

export const autoMemorySnapshotSchema = z.object({
  status: autoMemoryStatusSchema,
  /** 最多挑几条（开始运行时任务上的设置） */
  limit: z.number().int(),
  /** 挑完的时间 */
  at: isoTime.optional(),
  /** 用的 embedding 模型 */
  modelId: z.string().optional(),
  /** 相似度门槛 */
  minScore: z.number().optional(),
  /** 参与挑选的记忆有几条（生效的、不是手选的、不是来自网页没核实的、向量按现在的内容算好了的） */
  candidates: z.number().int().optional(),
  /** 生效但向量还没算好、这次没参与的有几条 */
  notReady: z.number().int().optional(),
  /** 拿来挑的文字（截到 AUTO_MEMORY_QUERY_MAX_CHARS） */
  query: z.string().optional(),
  /** skipped / failed 的原因（给人看的一句话）；done 但一条都没过门槛时写最像的那条，例如「最像的是 m-007（0.52），没到门槛 0.70」 */
  reason: z.string().optional(),
})
export type AutoMemorySnapshot = z.infer<typeof autoMemorySnapshotSchema>

/** 快照里一条记忆是自动挑的：相似度（0～1，4 位小数）。手选的没有这一项 */
export const snapshotMemoryAutoSchema = z.object({ score: z.number() })

// ---------- 运行详情：这次用了哪些记忆（sessions.get） ----------

export const runMemoryUseSchema = z.object({
  /** 手选的在前（建任务时的顺序），自动挑的在后（相似度从高到低） */
  items: z.array(
    z.object({
      id: z.string(),
      appliesTo: z.string(),
      content: z.string(),
      /** 自动挑的才有 */
      auto: snapshotMemoryAutoSchema.optional(),
    })
  ),
  /** 任务开着「自动挑选记忆」时才有（加这个功能以前的运行没有） */
  auto: autoMemorySnapshotSchema.optional(),
  /** 任务记忆（只属于这个任务的经验）有几条，全部给了 agent */
  taskMemoryCount: z.number().int(),
})
export type RunMemoryUse = z.infer<typeof runMemoryUseSchema>
