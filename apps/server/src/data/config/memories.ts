// 记忆的写操作：主管新建、修改、归档、删除；agent 提议的记忆由审核人批准或拒绝（同时处理掉待办里那件事）。
import { and, eq } from "drizzle-orm"
import { memoryId, type Actor, type MemoryInput } from "@heyagent/shared"

import * as t from "../../db/schema.js"
import { assertCan, audit, conflict, nextNo, notFound, type DbOrTx, type Tx, type WriteCtx } from "./common.js"
import { tasksUsingRef, usedByText } from "./tasks.js"

async function loadMemory(db: DbOrTx, id: string) {
  const [row] = await db.select().from(t.memories).where(eq(t.memories.id, id))
  if (!row) throw notFound("记忆", id)
  return row
}

/** 在调用方的事务里新建记忆（人加的直接生效，来源是这个人）。导入时也用它 */
export async function insertMemory(tx: Tx, actor: Actor, input: MemoryInput, auditDetail: Record<string, unknown> = {}) {
  const id = memoryId(await nextNo(tx, "memory_no_seq"))
  // 人加的记忆直接生效
  await tx.insert(t.memories).values({ id, content: input.content, appliesTo: input.appliesTo, status: "active", sourceKind: "human", sourceById: actor.id })
  await audit(tx, actor.id, "memory.create", "memories", id, { appliesTo: input.appliesTo, ...auditDetail })
  return { id }
}

export async function createMemory(ctx: WriteCtx, input: MemoryInput) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能新建记忆")
  return ctx.db.transaction((tx) => insertMemory(tx, ctx.actor, input))
}

export async function updateMemory(ctx: WriteCtx, input: MemoryInput & { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能修改记忆")
  return ctx.db.transaction(async (tx) => {
    const before = await loadMemory(tx, input.id)
    if (before.status === "pending") throw conflict("这条记忆还在等审核，先在「待办」里批准或拒绝")
    await tx.update(t.memories).set({ content: input.content, appliesTo: input.appliesTo }).where(eq(t.memories.id, input.id))
    await audit(tx, ctx.actor.id, "memory.update", "memories", input.id, { changed: (["content", "appliesTo"] as const).filter((key) => before[key] !== input[key]) })
    return { id: input.id }
  })
}

/** 审核：只有审核人（或主管）能批；同时把待办里对应的那件事标成已处理 */
async function review(ctx: WriteCtx, input: { id: string; reason?: string }, approve: boolean) {
  return ctx.db.transaction(async (tx) => {
    const memory = await loadMemory(tx, input.id)
    assertCan(ctx.actor, "humanItem.resolve", { assigneeId: memory.reviewerId ?? "" }, "这条记忆不是分给你审核的")
    if (memory.status !== "pending") throw conflict("这条记忆已经审核过了")
    const now = new Date()
    await tx.update(t.memories).set({ status: approve ? "active" : "rejected", reviewerId: memory.reviewerId ?? ctx.actor.id }).where(eq(t.memories.id, input.id))
    const items = await tx
      .update(t.humanItems)
      .set({ status: "resolved", resolution: { how: approve ? "primary" : "reject", ...(input.reason ? { reason: input.reason } : {}) }, resolvedById: ctx.actor.id, resolvedAt: now })
      .where(and(eq(t.humanItems.memoryId, input.id), eq(t.humanItems.status, "open")))
      .returning({ id: t.humanItems.id })
    await audit(tx, ctx.actor.id, approve ? "memory.approve" : "memory.reject", "memories", input.id, { humanItemIds: items.map((item) => item.id), ...(input.reason ? { reason: input.reason } : {}) })
    return { id: input.id, status: approve ? ("active" as const) : ("rejected" as const) }
  })
}

export const approveMemory = (ctx: WriteCtx, input: { id: string }) => review(ctx, input, true)
export const rejectMemory = (ctx: WriteCtx, input: { id: string; reason?: string }) => review(ctx, input, false)

/** 归档：不再给任务用，但留着记录。选用了它的任务下一次运行就读不到了（页面上先确认） */
export async function archiveMemory(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能归档记忆")
  return ctx.db.transaction(async (tx) => {
    const before = await loadMemory(tx, input.id)
    if (before.status === "pending") throw conflict("这条记忆还在等审核，先在「待办」里批准或拒绝")
    await tx.update(t.memories).set({ status: "archived" }).where(eq(t.memories.id, input.id))
    await audit(tx, ctx.actor.id, "memory.archive", "memories", input.id)
    return { id: input.id }
  })
}

/** 删除：被任务选用着的不能删 */
export async function deleteMemory(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能删除记忆")
  return ctx.db.transaction(async (tx) => {
    const before = await loadMemory(tx, input.id)
    const used = await tasksUsingRef(tx, t.taskMemories, [input.id])
    if (used.length) throw conflict(`这条记忆正被 ${used.length} 个任务选用：${usedByText(used)}。先在这些任务里去掉它，或者改成归档。`)
    await tx.delete(t.memories).where(eq(t.memories.id, input.id))
    await audit(tx, ctx.actor.id, "memory.delete", "memories", input.id, { content: before.content.slice(0, 100) })
    return { id: input.id }
  })
}
