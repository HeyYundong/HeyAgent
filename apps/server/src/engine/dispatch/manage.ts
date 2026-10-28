// 派活页上人的操作（tRPC work.*）：查有没有单、派一张、改参数、重办、不办了。报错用 WorkError（work-router 换成 tRPC 错误码），文字给人看。
// 第三期：优先级、过多久再办；对外 HTTP 接口（work/routes.ts）用的 dispatchByApi、cancelWorkItemByApi。
import {
  can,
  eventValueText,
  fmtShort,
  isRunEnded,
  WORK_PRIORITY_RANK,
  workDedupeKey,
  workDefaultTitle,
  workNotBefore,
  workParamsProblem,
  workPriorityLabel,
  workWaitKind,
  type Actor,
  type WorkApiCreateInput,
  type WorkApiCreateResult,
  type WorkDispatchInput,
  type WorkItem,
} from "@heyagent/shared"
import { and, eq } from "drizzle-orm"
import type { z } from "zod"
import type { workUpdateParamsInputSchema } from "@heyagent/shared"

import { readDispatchSettings } from "../../data/config/settings.js"
import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { budgetReached, dispatchSpentToday, toWorkItems, WorkError } from "../../work/service.js"
import { cancelSessionInTx } from "../control.js"
import type { Tx } from "../queue.js"
import { writeAudit } from "../records.js"
import { createItemsInTx, itemKey, loadTarget, normalizeParams, notifyDayLimitOnce, type DispatchTarget, type NewWorkItem } from "./dispatch.js"
import { sendWorkDoneInTx } from "./notify.js"
import { appendLog } from "./settle.js"
import { sendPumpAtInTx, sendPumpInTx } from "./signal.js"

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
    const item: NewWorkItem = {
      title,
      params,
      ...(input.note ? { note: input.note } : {}),
      // 第三期：优先级、过多久再办
      ...(input.priority ? { priority: input.priority } : {}),
      ...(input.delayMinutes ? { notBefore: workNotBefore({ delayMinutes: input.delayMinutes }) } : {}),
    }
    const { outcomes, dayLimitHit } = await createItemsInTx(db, tx, target, [item], {
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

/** 锁住一张单，并检查 work.manage（被派任务的负责人或主管）。viaApi：外部系统用 API 密钥调的，被派任务还要开着「外部系统能派活」 */
async function lockItem(tx: Tx, actor: Actor, id: string, viaApi = false) {
  const [item] = await tx.select().from(t.workItems).where(eq(t.workItems.id, id)).for("update")
  if (!item) throw new WorkError("NOT_FOUND", `没有派活单 ${id}`)
  const [task] = await tx.select({ ownerId: t.tasks.ownerId, dispatch: t.tasks.dispatch }).from(t.tasks).where(eq(t.tasks.id, item.taskId))
  if (viaApi && !task?.dispatch?.allowApi) throw new WorkError("FORBIDDEN", `任务 ${item.taskId} 没有打开「外部系统能派活」，外部系统不能改它的单`)
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
    // 第三期：改「什么时候办」。等自动重试的单不能改（保持「重试」的含义），要马上办就「不办了」再「重办」
    const retime = input.delayMinutes !== undefined
    if (retime && item.autoRetries > 0)
      throw new WorkError("CONFLICT", "这张单在等自动重试，不能改什么时候办；要马上办就先「不办了」再「重办」")
    const notBefore = retime ? workNotBefore({ delayMinutes: input.delayMinutes }) : undefined
    const priority = input.priority && WORK_PRIORITY_RANK[input.priority] !== item.priority ? input.priority : undefined
    const changes = [
      ...(priority ? [`优先级改成${workPriorityLabel[priority]}`] : []),
      ...(retime ? [notBefore ? `定在 ${fmtShort(notBefore)} 以后办` : "改成马上办"] : []),
    ]
    const now = new Date()
    const [row] = await tx
      .update(t.workItems)
      .set({
        params,
        ...(input.title ? { title: input.title } : {}),
        ...(input.note !== undefined ? { note: input.note } : {}),
        ...(priority ? { priority: WORK_PRIORITY_RANK[priority] } : {}),
        ...(retime ? { notBefore } : {}),
        updatedAt: now,
        log: appendLog({ at: now.toISOString(), kind: "params_changed", byId: actor.id, ...(changes.length ? { note: changes.join("；") } : {}) }),
      })
      .where(eq(t.workItems.id, item.id))
      .returning()
    // 改了时间：到点的马上领，定在以后的到点再领
    if (retime) {
      if (notBefore) await sendPumpAtInTx(db, tx, item.taskId, notBefore)
      else await sendPumpInTx(db, tx, item.taskId)
    }
    await writeAudit(tx, {
      actorId: actor.id,
      action: "work.update_params",
      targetTable: "work_items",
      targetId: item.id,
      detail: { before: item.params, after: params, ...(priority ? { priority } : {}), ...(retime ? { notBefore: notBefore?.toISOString() ?? null } : {}) },
    })
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
        outcome: null,
        outcomeReason: null,
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
export async function cancelWorkItem(db: Db, actor: WorkActor, input: { id: string; reason?: string }, options: { viaApi?: boolean } = {}): Promise<WorkItem> {
  return db.transaction(async (tx) => {
    const { item } = await lockItem(tx, actor, input.id, options.viaApi)
    if (item.status !== "queued" && item.status !== "running") throw new WorkError("CONFLICT", "这张单已经结束了，不用再点不办了")
    const reason = `${actor.name}点了不办了${input.reason ? `：${input.reason}` : ""}`
    const now = new Date()
    const [row] = await tx
      .update(t.workItems)
      .set({
        status: "cancelled",
        error: reason,
        failKind: null,
        // 不办了：结果记没办成（同迁移 0024 补旧数据的口径）
        outcome: "not_achieved",
        outcomeReason: reason,
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
    await writeAudit(tx, { actorId: actor.id, action: "work.cancel", targetTable: "work_items", targetId: item.id, detail: { from: item.status, reason: input.reason, ...(options.viaApi ? { via: "api" } : {}) } })
    return one(tx, row!)
  })
}

// ---------- 第三期：对外 HTTP 接口（work/routes.ts） ----------

/** 接口的调用方：密钥调用（apiKeyId 有值，权限按密钥创建人现在的角色算）或登录的人 */
export interface WorkApiCaller {
  user: Actor & { name: string }
  apiKeyId?: string
  apiKeyName?: string
}

/** 处理记录、不办了的原因里写的「谁」：密钥调用写「外部系统（密钥「名字」）」 */
const callerName = (caller: WorkApiCaller) => (caller.apiKeyId ? `外部系统（密钥「${caller.apiKeyName ?? caller.apiKeyId}」）` : caller.user.name)

/** 单在控制台里的完整地址 */
export const workItemLink = (baseUrl: string, item: Pick<WorkItem, "id" | "taskId">) => `${baseUrl}/#/tasks?id=${encodeURIComponent(item.taskId)}&work=${encodeURIComponent(item.id)}`

/**
 * POST /api/work-items：派一张（docs/dev/dispatch-p3.md 2.2）。密钥调用 via = api（要被派任务开着「外部系统能派活」），cookie 调用 via = human（同控制台「派一张」）。
 * 两种都要被派任务的 task.manage，都要能算出去重键（任务的去重参数，或者 key / Idempotency-Key），重复提交才不会办两次。
 * 新建 201；同一件事已经有单 200（不重开）；撞了上限抛 TOO_MANY_REQUESTS（429），别的被拒 BAD_REQUEST
 */
export async function dispatchByApi(
  db: Db,
  caller: WorkApiCaller,
  input: WorkApiCreateInput,
  options: { idempotencyKey?: string; baseUrl: string }
): Promise<{ status: 200 | 201; body: WorkApiCreateResult }> {
  const viaApi = Boolean(caller.apiKeyId)
  const task = await loadTarget(db, input.task)
  if (!task) throw new WorkError("NOT_FOUND", `没有任务 ${input.task}`)
  if (!task.dispatch) throw new WorkError("CONFLICT", `任务 ${task.id} 没有打开「可以被派活」`)
  if (viaApi && !task.dispatch.allowApi) throw new WorkError("FORBIDDEN", `任务 ${task.id} 没有打开「外部系统能派活」（在任务设置的「被派活」里打开）`)
  if (!can(caller.user, "task.manage", { ownerId: task.ownerId }))
    throw new WorkError("FORBIDDEN", viaApi ? `密钥的创建人现在没有任务 ${task.id} 的管理权限（只有任务的负责人和主管能派活给它）` : "只有这个任务的负责人和主管能派活给它")
  const target: DispatchTarget = { ...task, dispatch: task.dispatch }
  // 值可以是文字、数字、是否，null = 没填（存成文字）
  const params = normalizeParams(Object.fromEntries(Object.entries(input.params).map(([name, value]) => [name, eventValueText(value)])))
  const problem = workParamsProblem(task.dispatch, params)
  if (problem) throw new WorkError("BAD_REQUEST", problem)
  const hasDedupe = task.dispatch.params.some((param) => param.dedupe)
  const key = input.key ?? options.idempotencyKey?.trim().slice(0, 200)
  if (!hasDedupe && !key) throw new WorkError("BAD_REQUEST", "这个任务没有标「去重」的参数，要填 key（同一件事每次填同一个值），重复提交才不会办两次")
  const timed = input.notBefore !== undefined || input.delayMinutes !== undefined
  const item: NewWorkItem = {
    title: input.title?.trim() || workDefaultTitle(task.dispatch, params),
    params,
    ...(input.note !== undefined ? { note: input.note } : {}),
    ...(hasDedupe ? {} : { key: key! }),
    ...(input.priority ? { priority: input.priority } : {}),
    // 没给时间：新建的马上办，ifExists = update 时不改
    ...(timed ? { notBefore: workNotBefore({ notBefore: input.notBefore, delayMinutes: input.delayMinutes }) } : {}),
  }
  const limits = await readDispatchSettings(db)
  const { result, dayLimitHit } = await db.transaction(async (tx) => {
    const { outcomes, dayLimitHit } = await createItemsInTx(db, tx, target, [item], {
      via: viaApi ? "api" : "human",
      fromUserId: caller.user.id,
      apiKeyId: caller.apiKeyId ?? null,
      apiKeyName: caller.apiKeyName ?? null,
      depth: 1,
      ifExists: input.ifExists ?? "skip",
      maxPerTaskPerDay: limits.maxPerTaskPerDay,
      maxQueued: limits.maxQueued,
      requireKey: true,
    })
    const outcome = outcomes[0]!
    if (outcome.kind === "rejected") return { result: outcome, dayLimitHit }
    await writeAudit(tx, {
      actorId: caller.user.id,
      action: outcome.kind === "created" ? "work.dispatch" : "work.dispatch.existing",
      targetTable: "work_items",
      targetId: outcome.row.id,
      detail: { via: viaApi ? "api" : "human", ...(caller.apiKeyId ? { apiKeyId: caller.apiKeyId } : {}), taskId: task.id, params },
    })
    return { result: { item: await one(tx, outcome.row), existing: outcome.kind === "existing", updated: outcome.kind === "existing" && outcome.updated }, dayLimitHit }
  })
  if (dayLimitHit) await notifyDayLimitOnce(db, target, limits.maxPerTaskPerDay).catch((error) => console.warn("[work] 通知负责人失败", error))
  if ("reason" in result) throw new WorkError(result.limit ? "TOO_MANY_REQUESTS" : "BAD_REQUEST", result.reason)
  const notice = await queuedNotice(db, target, result.item)
  return {
    status: result.existing ? 200 : 201,
    body: { ...result, link: workItemLink(options.baseUrl, result.item), ...(notice ? { notice } : {}) },
  }
}

/** 排队的单为什么不会马上办（接口返回的 notice）：任务停用了、定了时间、今天的花费到了上限 */
async function queuedNotice(db: Db, task: DispatchTarget, item: WorkItem): Promise<string | undefined> {
  if (item.status !== "queued") return undefined
  const notes: string[] = []
  if (!task.enabled) notes.push("任务停用了，单先排着，重新启用后自动开始办")
  if (workWaitKind(item) === "scheduled") notes.push(`定在 ${fmtShort(item.notBefore!)} 以后办`)
  const budget = task.dispatch.dailyBudgetUsd
  if (budget != null && budgetReached((await dispatchSpentToday(db, [task.id])).get(task.id) ?? 0, budget)) notes.push("今天的花费到了上限，单留到明天 0 点以后办")
  return notes.length ? notes.join("；") : undefined
}

/** POST /api/work-items/:id/cancel：同控制台「不办了」。密钥调用要被派任务开着「外部系统能派活」，人名写「外部系统（密钥「名字」）」 */
export async function cancelWorkItemByApi(db: Db, caller: WorkApiCaller, input: { id: string; reason?: string }): Promise<WorkItem> {
  return cancelWorkItem(db, { ...caller.user, name: callerName(caller) }, input, { viaApi: Boolean(caller.apiKeyId) })
}
