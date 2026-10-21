// 派活：新建派活单（方案 4.1～4.3、8.3）。agent 调内置工具 work.dispatch、人在任务详情「派一张」都走 createItemsInTx：
// 每张单各自判断（参数、去重键、上限），一张不合格不影响别的；同一个任务下同一个去重键只有一张（唯一约束 + 先查），
// 已经有的单只返回现状（ifExists = update 只改排队的）；有新单就在同一个事务里发 work.pump。
import {
  fmtDateTime,
  fmtShort,
  runOutcomeLabel,
  runStatusLabel,
  WORK_DISPATCH_TOOL_ID,
  workDedupeKey,
  workItemId,
  workParamsProblem,
  workReportLine,
  type builtinToolInputs,
  type TaskDispatch,
  type WorkItem,
  type WorkVia,
} from "@heyagent/shared"
import { and, count, eq, gte, inArray, sql } from "drizzle-orm"
import type { z } from "zod"

import { readDispatchSettings } from "../../data/config/settings.js"
import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { normalizeDispatch, startOfTodayShanghai, toWorkItems } from "../../work/service.js"
import { notifyUsers } from "../notify.js"
import type { Tx } from "../queue.js"
import type { ToolContext, ToolOutcome } from "../tools/builtin.js"
import { lockTaskInTx } from "./pump.js"
import { appendLog } from "./settle.js"
import { sendPumpInTx } from "./signal.js"

type WorkItemRow = typeof t.workItems.$inferSelect

export interface DispatchTarget {
  id: string
  title: string
  ownerId: string
  enabled: boolean
  dispatch: TaskDispatch
}

export interface NewWorkItem {
  title: string
  params: Record<string, string>
  /** 对方任务没有标「去重」的参数时，agent 自己给的去重键 */
  key?: string
  note?: string
}

export type ItemOutcome =
  | { kind: "created"; row: WorkItemRow }
  | { kind: "existing"; row: WorkItemRow; updated: boolean }
  | { kind: "rejected"; title: string; reason: string }

export interface CreateOptions {
  via: WorkVia
  fromTaskId?: string | null
  fromSessionId?: string | null
  fromUserId?: string | null
  depth: number
  ifExists: "skip" | "update"
  /** agent 派的：一次运行最多派几张（按 from_session_id 数）；人派的不限 */
  maxPerSession?: number
  maxPerTaskPerDay: number
  maxQueued: number
  /** 没有去重参数、也没给 key 时：true = 拒掉这张（agent），false = 每次都算新的一件事（人派的） */
  requireKey: boolean
}

/** 参数值去掉首尾空白，空的当没填 */
export function normalizeParams(params: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(params)
      .map(([name, value]) => [name.trim(), String(value ?? "").trim()] as const)
      .filter(([name, value]) => name && value)
  )
}

/** 一张单的去重键；返回 { problem } 表示这张单不合格 */
export function itemKey(dispatch: TaskDispatch, params: Record<string, string>, key: string | undefined, requireKey: boolean): { key: string | null } | { problem: string } {
  const dedupe = dispatch.params.filter((param) => param.dedupe)
  if (dedupe.length) {
    const empty = dedupe.filter((param) => !params[param.name])
    if (empty.length) return { problem: `去重参数「${empty.map((param) => param.name).join("」「")}」要填（靠它判断是不是同一件事）` }
    return { key: workDedupeKey(dispatch, params)! }
  }
  const own = key?.trim()
  if (own) return { key: own }
  if (requireKey) return { problem: "对方任务没有标「去重」的参数，要自己填 key（同一件事每次都填同一个值）" }
  return { key: null }
}

/**
 * 在调用方的事务里新建一批派活单。按被派任务加一把事务级锁，上限的计数才准（并发派同一个任务排成一队）。
 * 返回每张的结果（顺序同输入）和「今天的上限有没有被撞到」（调用方事务提交后通知负责人一次）
 */
export async function createItemsInTx(db: Db, tx: Tx, task: DispatchTarget, items: NewWorkItem[], options: CreateOptions): Promise<{ outcomes: ItemOutcome[]; dayLimitHit: boolean }> {
  await lockTaskInTx(tx, "dispatch", task.id)
  const prepared = items.map((item) => {
    const params = normalizeParams(item.params)
    const title = item.title.trim().slice(0, 120)
    const problem = workParamsProblem(task.dispatch, params)
    if (problem) return { ok: false as const, title, problem }
    const key = itemKey(task.dispatch, params, item.key, options.requireKey)
    if ("problem" in key) return { ok: false as const, title, problem: key.problem }
    return { ok: true as const, title, params, key: key.key, note: item.note?.trim().slice(0, 1000) ?? "" }
  })
  const keys = [...new Set(prepared.flatMap((item) => (item.ok && item.key ? [item.key] : [])))]
  const existing = new Map<string, WorkItemRow>()
  if (keys.length) {
    const rows = await tx
      .select()
      .from(t.workItems)
      .where(and(eq(t.workItems.taskId, task.id), inArray(t.workItems.key, keys)))
    for (const row of rows) existing.set(row.key, row)
  }

  const counted = async (where: ReturnType<typeof and>) => (await tx.select({ n: count() }).from(t.workItems).where(where))[0]?.n ?? 0
  let queued = await counted(and(eq(t.workItems.taskId, task.id), eq(t.workItems.status, "queued")))
  let today = await counted(and(eq(t.workItems.taskId, task.id), gte(t.workItems.createdAt, startOfTodayShanghai())))
  let perSession = options.fromSessionId ? await counted(eq(t.workItems.fromSessionId, options.fromSessionId)) : 0

  const outcomes: ItemOutcome[] = []
  let dayLimitHit = false
  for (const item of prepared) {
    if (!item.ok) {
      outcomes.push({ kind: "rejected", title: item.title, reason: item.problem })
      continue
    }
    const found = item.key ? existing.get(item.key) : undefined
    if (found) {
      if (options.ifExists === "update" && found.status === "queued") {
        const now = new Date()
        const [row] = await tx
          .update(t.workItems)
          .set({
            title: item.title || found.title,
            params: item.params,
            note: item.note,
            updatedAt: now,
            log: appendLog({
              at: now.toISOString(),
              kind: "params_changed",
              ...(options.fromUserId ? { byId: options.fromUserId } : {}),
              ...(options.fromSessionId ? { sessionId: options.fromSessionId, note: `运行 ${options.fromSessionId} 再派时用新参数覆盖` } : {}),
            }),
          })
          .where(and(eq(t.workItems.id, found.id), eq(t.workItems.status, "queued")))
          .returning()
        if (row) {
          existing.set(row.key, row)
          outcomes.push({ kind: "existing", row, updated: true })
          continue
        }
      }
      outcomes.push({ kind: "existing", row: found, updated: false })
      continue
    }
    if (options.maxPerSession !== undefined && perSession >= options.maxPerSession) {
      outcomes.push({ kind: "rejected", title: item.title, reason: `这次运行已经派了 ${perSession} 张，到了上限（一次运行最多派 ${options.maxPerSession} 张）` })
      continue
    }
    if (today >= options.maxPerTaskPerDay) {
      dayLimitHit = true
      outcomes.push({ kind: "rejected", title: item.title, reason: `对方任务今天已经被派了 ${today} 张，到了上限（一个任务每天最多被派 ${options.maxPerTaskPerDay} 张）` })
      continue
    }
    if (queued >= options.maxQueued) {
      outcomes.push({ kind: "rejected", title: item.title, reason: `对方任务已经有 ${queued} 张在排队，到了上限（最多排队 ${options.maxQueued} 张）` })
      continue
    }
    const id = workItemId(Number((await tx.execute<{ n: string }>(sql`select nextval('work_item_no_seq') as n`)).rows[0]!.n))
    const now = new Date()
    const [row] = await tx
      .insert(t.workItems)
      .values({
        id,
        taskId: task.id,
        // 没有去重参数的人派单：每次都是新的一件事，用单号当去重键
        key: item.key ?? id,
        title: item.title,
        params: item.params,
        note: item.note,
        status: "queued",
        via: options.via,
        fromTaskId: options.fromTaskId ?? null,
        fromSessionId: options.fromSessionId ?? null,
        fromUserId: options.fromUserId ?? null,
        depth: options.depth,
        log: [{ at: now.toISOString(), kind: "created", ...(options.fromUserId ? { byId: options.fromUserId } : {}), ...(options.fromSessionId ? { sessionId: options.fromSessionId } : {}) }],
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing({ target: [t.workItems.taskId, t.workItems.key] })
      .returning()
    if (!row) {
      // 上了锁一般不会走到这里（别处绕过锁插了同一个键）：查出已有的那张
      const [other] = await tx
        .select()
        .from(t.workItems)
        .where(and(eq(t.workItems.taskId, task.id), eq(t.workItems.key, item.key ?? id)))
      if (other) outcomes.push({ kind: "existing", row: other, updated: false })
      continue
    }
    existing.set(row.key, row)
    outcomes.push({ kind: "created", row })
    queued++
    today++
    perSession++
  }
  if (outcomes.some((outcome) => outcome.kind === "created")) await sendPumpInTx(db, tx, task.id)
  return { outcomes, dayLimitHit }
}

/** 被派任务今天第一次撞到「每天最多被派几张」：通知它的负责人一次（按今天有没有发过同样的通知判断） */
export async function notifyDayLimitOnce(db: Db, task: DispatchTarget, limit: number) {
  const title = `${task.title}：今天被派的单到了上限`
  const [sent] = await db
    .select({ n: count() })
    .from(t.notifications)
    .where(and(eq(t.notifications.userId, task.ownerId), eq(t.notifications.taskId, task.id), eq(t.notifications.title, title), gte(t.notifications.createdAt, startOfTodayShanghai())))
  if ((sent?.n ?? 0) > 0) return
  await notifyUsers(db, {
    userIds: [task.ownerId],
    title,
    body: `今天已经被派了 ${limit} 张（设置里的「一个任务每天最多被派几张」），再派来的单都被拒了。要放宽就去设置页调大，或者看看派活的任务是不是派重了。`,
    link: `#/tasks?id=${encodeURIComponent(task.id)}`,
    taskId: task.id,
  })
}

/** 读被派任务（开着被派活才返回 dispatch） */
export async function loadTarget(db: Db | Tx, taskId: string): Promise<(Omit<DispatchTarget, "dispatch"> & { dispatch: TaskDispatch | null }) | undefined> {
  const [task] = await db
    .select({ id: t.tasks.id, title: t.tasks.title, ownerId: t.tasks.ownerId, enabled: t.tasks.enabled, dispatch: t.tasks.dispatch })
    .from(t.tasks)
    .where(eq(t.tasks.id, taskId))
  return task ? { ...task, dispatch: normalizeDispatch(task.dispatch) } : undefined
}

// ---------- 给模型的返回文字（方案 4.2） ----------

const clip = (value: string, max = 100) => {
  const line = value.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

/** 一张已有的单现在怎么样（一句话）；办完 / 没办成的带上 work.report 报的结果 */
export function describeItem(item: WorkItem): string {
  const data = workReportLine(item.result?.data)
  const tail = data ? ` · 结果：${data}` : ""
  switch (item.status) {
    case "queued":
      // 排队等自动重试（第二期）：到点才领，不算排队名次
      if (item.notBefore) return `排队（第 ${item.autoRetries} 次重试，${fmtShort(item.notBefore)} 以后）${item.error ? `，上次：${clip(item.error)}` : ""}`
      return item.queuePosition ? `排队第 ${item.queuePosition} 位` : "排队"
    case "running":
      return `在办（运行 ${item.sessionId ?? "—"}${item.sessionStatus ? `，${runStatusLabel[item.sessionStatus]}` : ""}）`
    case "done":
      // 办完的单结果是办成；2026-10-20 以前「没核实」的旧单（迁移后结果是没办成）标出来，派活方自己判断
      return `办完（${item.finishedAt ? fmtDateTime(item.finishedAt) : "—"}）${item.outcome === "not_achieved" ? `，结果${runOutcomeLabel.not_achieved}${item.outcomeReason ? `（${clip(item.outcomeReason)}）` : ""}` : ""}${item.result?.summary ? `：${clip(item.result.summary)}` : ""}${tail}`
    case "failed":
      // 运行正常结束、结果没办成的不用人处理（原因里写了缺什么）；运行出错的等人处理（partial 是旧数据）
      return `没办成${item.failKind === "not_done" || item.failKind === "partial" || item.failKind === "missing_result" ? "" : "，等人处理"}${item.error ? `（${clip(item.error)}）` : ""}${tail}`
    case "cancelled":
      return `不办了${item.error ? `（${clip(item.error)}）` : ""}`
  }
}

// ---------- 内置工具 work.dispatch ----------

type DispatchInput = z.infer<(typeof builtinToolInputs)["work.dispatch"]>

const fail = (output: string): ToolOutcome => ({ output, isError: true })

export async function dispatchFromAgent(ctx: ToolContext, input: DispatchInput): Promise<ToolOutcome> {
  const { db, session, snapshot } = ctx
  if (!snapshot.tools.some((tool) => tool.id === WORK_DISPATCH_TOOL_ID)) return fail("这个任务没有选「派活」工具，不能派活")
  const targets = snapshot.dispatchTargets ?? []
  const hint = targets.length ? `可以派给：${targets.map((target) => `${target.taskId}「${target.title}」`).join("、")}` : "现在没有任务允许你派活"
  const targetId = input.task.trim()
  // 按库里现在的配置查（不只看快照）：运行中途对方关了被派活、把你从「谁能派活给它」里去掉，马上生效
  const task = await loadTarget(db, targetId)
  if (!task) return fail(`没有任务 ${targetId}。${hint}`)
  if (!task.dispatch) return fail(`任务 ${task.id}「${task.title}」没有打开「可以被派活」，不能派活给它。${hint}`)
  const [allowed] = await db
    .select({ n: count() })
    .from(t.taskDispatchSources)
    .where(and(eq(t.taskDispatchSources.taskId, task.id), eq(t.taskDispatchSources.sourceTaskId, snapshot.task.id)))
  if (!allowed?.n) return fail(`任务 ${task.id}「${task.title}」没有允许这个任务派活给它（要对方的负责人在「谁能派活给它」里加上「${snapshot.task.title}」）。${hint}`)

  const limits = await readDispatchSettings(db)
  // 层数：这次运行是被派来的，就是那张单的层数 + 1；不是被派的运行派出去的算第 1 层
  let depth = 1
  if (session.workItemId) {
    const [own] = await db.select({ depth: t.workItems.depth }).from(t.workItems).where(eq(t.workItems.id, session.workItemId))
    depth = (own?.depth ?? 0) + 1
  }
  if (depth > limits.maxDepth) return fail(`派活最多 ${limits.maxDepth} 层：这次运行本身是第 ${depth - 1} 层派来的，不能再往下派。需要的话把要办的事写进总结，交给人处理`)

  const target: DispatchTarget = { ...task, dispatch: task.dispatch }
  const { items, dayLimitHit } = await db.transaction(async (tx) => {
    const { outcomes, dayLimitHit } = await createItemsInTx(db, tx, target, input.items, {
      via: "agent",
      fromTaskId: snapshot.task.id,
      fromSessionId: session.id,
      depth,
      ifExists: input.ifExists ?? "skip",
      maxPerSession: limits.maxPerSession,
      maxPerTaskPerDay: limits.maxPerTaskPerDay,
      maxQueued: limits.maxQueued,
      requireKey: true,
    })
    const rows = outcomes.flatMap((outcome) => (outcome.kind === "rejected" ? [] : [outcome.row]))
    const shaped = new Map((await toWorkItems(tx, rows)).map((item) => [item.id, item]))
    return { items: outcomes.map((outcome) => ({ outcome, item: outcome.kind === "rejected" ? undefined : shaped.get(outcome.row.id) })), dayLimitHit }
  })
  if (dayLimitHit) await notifyDayLimitOnce(db, target, limits.maxPerTaskPerDay).catch((error) => console.warn("[work] 通知负责人失败", error))

  const created = items.filter(({ outcome }) => outcome.kind === "created").length
  const existed = items.filter(({ outcome }) => outcome.kind === "existing").length
  const rejected = items.length - created - existed
  const lines = [`派给「${task.title}」：新建 ${created} 张，已有 ${existed} 张，被拒 ${rejected} 张。`]
  if (!task.enabled && created) lines.push("对方任务停用了，新建的单先排着，重新启用后自动开始办。")
  for (const { outcome, item } of items) {
    if (outcome.kind === "rejected") lines.push(`- 被拒「${outcome.title || "（没写标题）"}」：${outcome.reason}`)
    else if (outcome.kind === "created") lines.push(`- ${outcome.row.id} 新建，${item?.queuePosition ? `排队第 ${item.queuePosition} 位` : "排队"}`)
    else lines.push(`- ${outcome.row.id} 已经有了：${item ? describeItem(item) : outcome.row.status}${outcome.updated ? "（已用这次的参数更新）" : ""}`)
  }
  return { output: lines.join("\n"), ...(created + existed === 0 ? { isError: true } : {}) }
}
