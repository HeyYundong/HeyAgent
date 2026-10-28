// 记忆按内容自动挑选（docs/dev/memory-retrieval.md 第 3、5 节）：约定的空壳，后端开发者照设计实现。
// 开始运行的事务里（engine/sessions.ts 的 buildSnapshot）只在快照里写 autoMemory = { status: "pending", limit }，不调模型；
// worker 进这次运行时（engine/loop.ts 的 runSession，建系统提示之前）调 resolveAutoMemory：算查询文字的向量、挑、写回快照。
import type { AutoMemorySnapshot, RunMemoryUse, SessionSnapshot } from "@heyagent/shared"

import type { Db } from "../db/client.js"

const notYet = (what: string): never => {
  throw new Error(`自动挑选记忆：${what} 还没实现（docs/dev/memory-retrieval.md）`)
}

/** 一条挑中的记忆：相似度从高到低 */
export interface PickedMemory {
  id: string
  appliesTo: string
  content: string
  /** 余弦相似度，四舍五入到 4 位小数 */
  score: number
}

export interface AutoMemoryResult {
  /** 写回快照的 autoMemory（status 不会是 pending） */
  autoMemory: AutoMemorySnapshot
  picked: PickedMemory[]
}

/**
 * 拿来挑记忆的文字（设计 3.1）：任务标题、目标、步骤、这次的说明（note）、派活的标题 / 说明 / 参数，
 * 一项一行，截到 AUTO_MEMORY_QUERY_MAX_CHARS。纯函数，单元测试直接测
 */
export function autoMemoryQueryText(_snapshot: SessionSnapshot): string {
  return notYet("autoMemoryQueryText")
}

/**
 * 挑（设计 3.2～3.4）：候选 = 生效、不是手选的、不是 web_unverified（来自网页没核实）的、向量按现在的内容算好了的记忆；顺手补算没算好的（最多 AUTO_MEMORY_INLINE_EMBED_MAX 条）；
 * 按余弦相似度从高到低取 ≥ 门槛的前 limit 条。不写库（除了补算的向量），出错不抛：返回 failed / skipped
 */
export async function pickMemories(_db: Db, _snapshot: SessionSnapshot): Promise<AutoMemoryResult> {
  return notYet("pickMemories")
}

/**
 * worker 用（设计 5.1）：快照的 autoMemory 是 pending 时挑一次，在一个事务里写回 sessions.snapshot
 * （memories 追加挑中的、autoMemory 换成结果；条件是 snapshot->'autoMemory'->>'status' = 'pending'，不会挑两次）、
 * 写一条 plan 过程、给挑中的记忆写 lastUsedAt。返回更新后的快照（不是 pending 时原样返回，不调模型）
 */
export async function resolveAutoMemory(_db: Db, _sessionId: string, snapshot: SessionSnapshot): Promise<SessionSnapshot> {
  if (snapshot.autoMemory?.status !== "pending") return snapshot
  return notYet("resolveAutoMemory")
}

/** 运行详情（sessions.get 的 memoryUse）：从快照里取，手选的在前、自动挑的在后 */
export function runMemoryUseOf(_snapshot: SessionSnapshot): RunMemoryUse {
  return notYet("runMemoryUseOf")
}
