// 派活页上人的操作（tRPC work.*）：查有没有单、派一张、改参数、重办、不办了。报错用 WorkError（work-router 换成 tRPC 错误码），文字给人看。
import {
  can,
  isRunEnded,
  workDedupeKey,
  workDefaultTitle,
  workParamsProblem,
  type Actor,
  type WorkDispatchInput,
  type WorkItem,
} from "@heyagent/shared"
import { and, eq } from "drizzle-orm"
import type { z } from "zod"
import type { workUpdateParamsInputSchema } from "@heyagent/shared"

import { readDispatchSettings } from "../../data/config/settings.js"
import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { toWorkItems, WorkError } from "../../work/service.js"
import { cancelSessionInTx } from "../control.js"
import type { Tx } from "../queue.js"
import { writeAudit } from "../records.js"
import { createItemsInTx, itemKey, loadTarget, normalizeParams, notifyDayLimitOnce, type DispatchTarget } from "./dispatch.js"
import { sendWorkDoneInTx } from "./notify.js"
import { appendLog } from "./settle.js"
import { sendPumpInTx } from "./signal.js"

export interface WorkActor extends Actor {
  name: string
}

type WorkItemRow = typeof t.workItems.$inferSelect

const one = async (db: Db | Tx, row: WorkItemRow): Promise<WorkItem> => (await toWorkItems(db, [row]))[0]!

/** 「派一张」弹窗填参数时：同一件事已经有单了吗。参数不全（算不出去重键）、任务没有去重参数时返回 null */
export async function lookupWorkItem(db: Db, input: { taskId: string; params: Record<string, string> }): Promise<WorkItem | null> {
  const task = await loadTarget(db, input.taskId)
  if (!task?.dispatch) return null
  const params = normalizeParams(input.params)
  const key = itemKey(task.dispatch, params, undefined, false)
  if ("problem" in key || !key.key) return null
  const [row] = await db.select().from(t.workItems).where(and(eq(t.workItems.taskId, task.id), eq(t.workItems.key, key.key)))
  return row ? one(db, row) : null
}

/** 人派一张：被派任务的 task.manage；不要求 dispatchFrom；受「每天最多被派」「最多排队」约束；已经有单时返回那张 */
export async function dispatchByHuman(db: Db, actor: WorkActor, input: WorkDispatchInput): Promise<{ item: WorkItem; existing: boolean }> {
  const task = await loadTarget(db, input.taskId)
  if (!task) throw new WorkError("NOT_FOUND", `没有任务 ${input.taskId}`)
  if (!can(actor, "task.manage", { ownerId: task.ownerId })) throw new WorkError("FORBIDDEN", "只有这个任务的负责人和主管能派活给它")
  if (!task.dispatch) throw new WorkError("BAD_REQUEST", "这个任务没有打开「可以被派活」，先在任务设置里打开")
  const target: DispatchTarget = { ...task, dispatch: task.dispatch }
  const params = normalizeParams(input.params)
  const problem = workParamsProblem(task.dispatch, params)
  if (problem) throw new WorkError("BAD_REQUEST", problem)
  const limits = await readDispatchSettings(db)
  const title = input.title?.trim() || workDefaultTitle(task.dispatch, params)
  const { result, dayLimitHit } = await db.transaction(async (tx) => {
    const { outcomes, dayLimitHit } = await createItemsInTx(db, tx, target, [{ title, params, ...(input.note ? { note: input.note } : {}) }], {
      via: "human",
      fromUserId: actor.id,
      depth: 1,
      ifExists: "skip",
      maxPerTaskPerDay: limits.maxPerTaskPerDay,
      maxQueued: limits.maxQueued,
      requireKey: false,
    })
    const outcome = outcomes[0]!
    // 撞了上限：事务里什么都没写（锁随事务释放），把原因交给页面；当天第一次撞到每天上限的通知照发
    if (outcome.kind === "rejected") return { result: outcome, dayLimitHit }
    await writeAudit(tx, {
      actorId: actor.id,
      action: outcome.kind === "created" ? "work.dispatch" : "work.dispatch.existing",
      targetTable: "work_items",
      targetId: outcome.row.id,
      detail: { taskId: task.id, params },
    })
    return { result: { item: await one(tx, outcome.row), existing: outcome.kind === "existing" }, dayLimitHit }
  })
  if (dayLimitHit) await notifyDayLimitOnce(db, target, limits.maxPerTaskPerDay).catch((error) => console.warn("[work] 通知负责人失败", error))
  if ("reason" in result) throw new WorkError("BAD_REQUEST", result.reason)
  return result
}

/** 锁住一张单，并检查 work.manage（被派任务的负责人或主管） */
async function lockItem(tx: Tx, actor: Actor, id: string) {
  const [item] = await tx.select().from(t.workItems).where(eq(t.workItems.id, id)).for("update")
  if (!item) throw new WorkError("NOT_FOUND", `没有派活单 ${id}`)
  const [task] = await tx.select({ ownerId: t.tasks.ownerId, dispatch: t.tasks.dispatch }).from(t.tasks).where(eq(t.tasks.id, item.taskId))
  if (!can(actor, "work.manage", { taskOwnerId: task?.ownerId ?? "" })) throw new WorkError("FORBIDDEN", "只有被派任务的负责人和主管能改这张单")
  return { item, dispatch: task?.dispatch ?? null }
}

/** 改参数：只有排队的单；去重的参数不能改 */
export async function updateWorkParams(db: Db, actor: WorkActor, input: z.infer<typeof workUpdateParamsInputSchema>): Promise<WorkItem> {
  return db.transaction(async (tx) => {
    const { item, dispatch } = await lockItem(tx, actor, input.id)
    if (item.status !== "queued") throw new WorkError("CONFLICT", "只有排队的单能改参数（已经开始办的，参数已经交给运行了）")
    if (!dispatch) throw new WorkError("BAD_REQUEST", "任务关了被派活，先在任务设置里打开再改参数")
    const params = normalizeParams(input.params)
    const problem = workParamsProblem(dispatch, params)
    if (problem) throw new WorkError("BAD_REQUEST", problem)
    const key = workDedupeKey(dispatch, params)
    if (key !== null && key !== item.key) throw new WorkError("BAD_REQUEST", "去重的参数不能改，要办另一件事就再派一张")
    const now = new Date()
    const [row] = await tx
      .update(t.workItems)
      .set({
        params,
        ...(input.title ? { title: input.title } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        updatedAt: now,
        log: appendLog({ at: now.toISOString(), kind: "params_changed", byId: actor.id }),
      })
      .where(eq(t.workItems.id, item.id))
      .returning()
    await writeAudit(tx, { actorId: actor.id, action: "work.update_params", targetTable: "work_items", targetId: item.id, detail: { before: item.params, after: params } })
    return one(tx, row!)
  })
}

/** 重办：办完、没办成、不办了的单再排一次队（attempts 在开运行时 +1；result 留着直到新的运行结束）。自动重试的次数清零，又有完整的 N 次 */
export async function redoWorkItem(db: Db, actor: WorkActor, input: { id: string }): Promise<WorkItem> {
  return db.transaction(async (tx) => {
    const { item } = await lockItem(tx, actor, input.id)
    if (item.status === "queued" || item.status === "running") throw new WorkError("CONFLICT", item.status === "queued" ? "这张单已经在排队了" : "这张单正在办，办完再说")
    const now = new Date()
    const [row] = await tx
      .update(t.workItems)
      .set({
        status: "queued",
        error: null,
        failKind: null,
        notBefore: null,
        autoRetries: 0,
        finishedAt: null,
        updatedAt: now,
        log: appendLog({ at: now.toISOString(), kind: "redo", byId: actor.id }),
      })
      .where(eq(t.workItems.id, item.id))
      .returning()
    await writeAudit(tx, { actorId: actor.id, action: "work.redo", targetTable: "work_items", targetId: item.id, detail: { from: item.status } })
    await sendPumpInTx(db, tx, item.taskId)
    return one(tx, row!)
  })
}

/** 不办了：排队的（包括等自动重试的）直接结束；在办的先取消正在跑的运行，单记「不办了」（不会被结束回写改成没办成）。已经结束的报错。叫醒等结果的派活方 */
export async function cancelWorkItem(db: Db, actor: WorkActor, input: { id: string; reason?: string }): Promise<WorkItem> {
  return db.transaction(async (tx) => {
    const { item } = await lockItem(tx, actor, input.id)
    if (item.status !== "queued" && item.status !== "running") throw new WorkError("CONFLICT", "这张单已经结束了，不用再点不办了")
    const reason = `${actor.name}点了不办了${input.reason ? `：${input.reason}` : ""}`
    const now = new Date()
    const [row] = await tx
      .update(t.workItems)
      .set({
        status: "cancelled",
        error: reason,
        failKind: null,
        notBefore: null,
        finishedAt: now,
        updatedAt: now,
        log: appendLog({ at: now.toISOString(), kind: "cancelled", byId: actor.id, ...(input.reason ? { note: input.reason } : {}) }),
      })
      .where(eq(t.workItems.id, item.id))
      .returning()
    if (item.status === "running" && item.sessionId) {
      const [session] = await tx.select({ status: t.sessions.status }).from(t.sessions).where(eq(t.sessions.id, item.sessionId))
      // 单已经先改成不办了，取消运行时的结束回写看到它不在办，不会再改
      if (session && !isRunEnded(session.status))
        await cancelSessionInTx(db, tx, { sessionId: item.sessionId, actorId: actor.id, actorName: actor.name, reason: `在派活单 ${item.id} 上点了不办了${input.reason ? `：${input.reason}` : ""}` })
      await sendPumpInTx(db, tx, item.taskId)
    }
    await sendWorkDoneInTx(db, tx, item.id)
    await writeAudit(tx, { actorId: actor.id, action: "work.cancel", targetTable: "work_items", targetId: item.id, detail: { from: item.status, reason: input.reason } })
    return one(tx, row!)
  })
}
