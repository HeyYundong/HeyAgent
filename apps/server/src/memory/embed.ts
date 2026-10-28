// 记忆的向量（docs/dev/memory-retrieval.md 第 2 节）：约定的空壳，后端开发者照设计实现。
// - 用的模型 = 图库的 embedding 模型（model_defaults 的 embed，gallery/embed.ts 的 currentEmbedModel），向量 1024 维，调 gallery/embed.ts 的 embed()（文字输入）；
// - 只算「生效」的记忆；向量按 (memory_id, model_id) 存在 memory_embeddings，content_hash = md5(shared 的 memoryEmbedText)；
// - 「要算」= 当前模型下没有行，或者行里的 content_hash 和记忆现在的内容对不上（改过）。判断全在 SQL 里：
//   md5(applies_to || E'\n' || content)，所以谁改了记忆（记忆页、助手、导入、审核通过）都不用另外通知，后台自己会发现；
// - 后台循环在 API 进程（index.ts 里和图库的并列启动），一批 32 条，失败的隔 10 分钟再试，多进程用事务级 advisory lock；
//   当前模型一条不落都算完了才删别的模型的行（同图库）。
import type { MemoryEmbedInfo } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import type { DbLike } from "../engine/records.js"

const notYet = (what: string): never => {
  throw new Error(`记忆向量：${what} 还没实现（docs/dev/memory-retrieval.md）`)
}

/**
 * 记忆新建、修改、审核通过、换了 embedding 模型以后调用：后台循环在跑就马上叫醒它（没在跑就什么也不做）。
 * 不调也行，后台每分钟自己看一次
 */
export function kickMemoryEmbeddings(): void {
  // 空壳：实现时照 gallery/background.ts 的 kickGalleryEmbeddings
}

/** 处理一批要算的记忆，返回处理了几条；没设 embedding 模型返回 0；拿不到锁（别的进程在算）返回 0 */
export async function embedPendingMemoriesOnce(_db: Db, _batch = 32): Promise<number> {
  return notYet("embedPendingMemoriesOnce")
}

/** 启动后台循环，返回停止函数（关机时调用）。写法同 gallery/background.ts 的 startGalleryEmbeddings */
export function startMemoryEmbeddings(_db: Db): () => void {
  return notYet("startMemoryEmbeddings")
}

/**
 * 记忆列表要的：每条「生效」记忆在当前 embedding 模型下算没算好（memories.list 的 MemoryRef.embed）。
 * 没设 embedding 模型时返回空 Map（页面显示「没设 embedding 模型」）
 */
export async function memoryEmbedInfos(_db: DbLike): Promise<Map<string, MemoryEmbedInfo>> {
  return notYet("memoryEmbedInfos")
}
