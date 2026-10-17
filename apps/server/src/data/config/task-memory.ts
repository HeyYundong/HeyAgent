// 任务记忆的写操作：负责人和主管直接写、改、删；运行结束后让三方 AI 总结、提取候选（engine/digest.ts），
// 候选存在 sessions.digest 里，人审核通过的才记进 task_memory_entries。每次写都记审计。
import { count, eq, sql } from "drizzle-orm"
import { TASK_MEMORY_MAX, type DigestReviewInput, type SessionDigest } from "@heyagent/shared"
import { TRPCError } from "@trpc/server"

import * as t from "../../db/schema.js"
import { digestSession, normalizeCandidates } from "../../engine/digest.js"
import { EngineError } from "../../engine/sessions.js"
import { assertCan, audit, badRequest, conflict, notFound, type DbOrTx, type WriteCtx } from "./common.js"

const CANNOT = "只有任务负责人和主管能改任务记忆"
const clip = (value: string) => value.slice(0, 200)

function engineError(error: unknown): never {
  if (error instanceof EngineError) throw new TRPCError({ code: error.code, message: error.message })
  throw error
}

async function loadTask(db: DbOrTx, id: string) {
  const [row] = await db.select({ id: t.tasks.id, ownerId: t.tasks.ownerId }).from(t.tasks).where(eq(t.tasks.id, id))
  if (!row) throw notFound("任务", id)
  return row
}

async function loadEntry(db: DbOrTx, id: number) {
  const [row] = await db.select().from(t.taskMemoryEntries).where(eq(t.taskMemoryEntries.id, id))
  if (!row) throw notFound("任务记忆", String(id))
  return row
}

/** 一个任务最多 TASK_MEMORY_MAX 条：全部放进系统提示，太多了 agent 抓不住重点 */
async function assertRoom(db: DbOrTx, taskId: string, adding: number) {
  if (adding === 0) return
  const [row] = await db.select({ n: count() }).from(t.taskMemoryEntries).where(eq(t.taskMemoryEntries.taskId, taskId))
  const n = row?.n ?? 0
  if (n + adding > TASK_MEMORY_MAX) throw badRequest(`任务记忆最多 ${TASK_MEMORY_MAX} 条，现在已经有 ${n} 条。先删掉或合并几条旧的。`)
}

export async function addTaskMemory(ctx: WriteCtx, input: { taskId: string; content: string }) {
  return ctx.db.transaction(async (tx) => {
    const task = await loadTask(tx, input.taskId)
    assertCan(ctx.actor, "task.manage", { ownerId: task.ownerId }, CANNOT)
    await assertRoom(tx, task.id, 1)
    const [row] = await tx.insert(t.taskMemoryEntries).values({ taskId: task.id, content: input.content, createdById: ctx.actor.id }).returning({ id: t.taskMemoryEntries.id })
    await audit(tx, ctx.actor.id, "task_memory.add", "tasks", task.id, { entryId: row!.id, content: clip(input.content) })
    return { id: row!.id }
  })
}

export async function updateTaskMemory(ctx: WriteCtx, input: { id: number; content: string }) {
  return ctx.db.transaction(async (tx) => {
    const before = await loadEntry(tx, input.id)
    const task = await loadTask(tx, before.taskId)
    assertCan(ctx.actor, "task.manage", { ownerId: task.ownerId }, CANNOT)
    await tx.update(t.taskMemoryEntries).set({ content: input.content }).where(eq(t.taskMemoryEntries.id, input.id))
    await audit(tx, ctx.actor.id, "task_memory.update", "tasks", task.id, { entryId: input.id, before: clip(before.content), after: clip(input.content) })
    return { id: input.id }
  })
}

export async function deleteTaskMemory(ctx: WriteCtx, input: { id: number }) {
  return ctx.db.transaction(async (tx) => {
    const before = await loadEntry(tx, input.id)
    const task = await loadTask(tx, before.taskId)
    assertCan(ctx.actor, "task.manage", { ownerId: task.ownerId }, CANNOT)
    await tx.delete(t.taskMemoryEntries).where(eq(t.taskMemoryEntries.id, input.id))
    await audit(tx, ctx.actor.id, "task_memory.delete", "tasks", task.id, { entryId: input.id, content: clip(before.content) })
    return { id: input.id }
  })
}

/**
 * 让三方 AI 总结一次已结束的运行（完成或失败）、提取任务记忆候选。调模型（花钱），所以只有负责人和主管能点。
 * 结果存进 sessions.digest（再点一次就重新总结，没审核的旧候选作废；已经记进去的不受影响），花费记到这次运行上
 */
export async function summarizeSession(ctx: WriteCtx, input: { sessionId: string }): Promise<SessionDigest> {
  const [session] = await ctx.db.select({ id: t.sessions.id, taskId: t.sessions.taskId }).from(t.sessions).where(eq(t.sessions.id, input.sessionId))
  if (!session) throw notFound("运行", input.sessionId)
  const task = await loadTask(ctx.db, session.taskId)
  assertCan(ctx.actor, "task.manage", { ownerId: task.ownerId }, "只有任务负责人和主管能让三方 AI 总结运行")
  const result = await digestSession(ctx.db, session.id).catch(engineError)
  return ctx.db.transaction(async (tx) => {
    const existing = await tx.select({ content: t.taskMemoryEntries.content }).from(t.taskMemoryEntries).where(eq(t.taskMemoryEntries.taskId, task.id))
    const candidates = normalizeCandidates(
      result.output,
      existing.map((row) => row.content)
    )
    const digest: SessionDigest = {
      at: new Date().toISOString(),
      modelId: result.modelId,
      byId: ctx.actor.id,
      summary: result.output.summary.trim() || "（三方模型没有写总结）",
      candidates: candidates.map((candidate) => ({ ...candidate, status: "pending" as const })),
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      costUsd: result.costUsd,
    }
    await tx
      .update(t.sessions)
      .set({
        digest,
        tokensIn: sql`${t.sessions.tokensIn} + ${result.tokensIn}`,
        tokensOut: sql`${t.sessions.tokensOut} + ${result.tokensOut}`,
        costUsd: sql`${t.sessions.costUsd} + ${result.costUsd}`,
      })
      .where(eq(t.sessions.id, session.id))
    await audit(tx, ctx.actor.id, "session.digest", "sessions", session.id, { modelId: result.modelId, candidates: candidates.length, costUsd: result.costUsd })
    return digest
  })
}

/**
 * 审核候选：采用的（可以改过文字）记进任务记忆，不要的标为没采用。没提到的候选保持待审核。
 * 锁住这次运行那一行，两个人同时审核时后到的看得到先到的结果
 */
export async function reviewDigest(ctx: WriteCtx, input: DigestReviewInput) {
  return ctx.db.transaction(async (tx) => {
    const [session] = await tx.select({ id: t.sessions.id, taskId: t.sessions.taskId, digest: t.sessions.digest }).from(t.sessions).where(eq(t.sessions.id, input.sessionId)).for("update")
    if (!session) throw notFound("运行", input.sessionId)
    const task = await loadTask(tx, session.taskId)
    assertCan(ctx.actor, "task.manage", { ownerId: task.ownerId }, CANNOT)
    const digest = session.digest
    if (!digest) throw badRequest("这次运行还没让三方 AI 总结过")
    const candidates = digest.candidates.map((candidate) => ({ ...candidate }))
    const seen = new Set<number>()
    for (const item of input.items) {
      const candidate = candidates[item.index]
      if (!candidate) throw badRequest(`没有第 ${item.index + 1} 条候选`)
      if (seen.has(item.index)) throw badRequest(`第 ${item.index + 1} 条候选重复了`)
      seen.add(item.index)
      if (candidate.status !== "pending") throw conflict(`第 ${item.index + 1} 条候选已经审核过了，刷新一下再看`)
    }
    await assertRoom(tx, task.id, input.items.filter((item) => item.accept).length)
    const accepted: { entryId: number; edited: boolean }[] = []
    for (const item of input.items) {
      const candidate = candidates[item.index]!
      if (!item.accept) {
        candidates[item.index] = { ...candidate, status: "rejected" }
        continue
      }
      const [row] = await tx.insert(t.taskMemoryEntries).values({ taskId: task.id, content: item.text, sourceSessionId: session.id, createdById: ctx.actor.id }).returning({ id: t.taskMemoryEntries.id })
      candidates[item.index] = { ...candidate, text: item.text, status: "accepted", entryId: row!.id }
      accepted.push({ entryId: row!.id, edited: item.text !== candidate.text })
    }
    const done = candidates.every((candidate) => candidate.status !== "pending")
    const next: SessionDigest = { ...digest, candidates, ...(done ? { reviewedAt: new Date().toISOString(), reviewedById: ctx.actor.id } : {}) }
    await tx.update(t.sessions).set({ digest: next }).where(eq(t.sessions.id, session.id))
    const rejected = input.items.length - accepted.length
    await audit(tx, ctx.actor.id, "task_memory.review", "tasks", task.id, { sessionId: session.id, accepted, rejected })
    return { accepted: accepted.length, rejected }
  })
}
