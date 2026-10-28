// 派活（docs/dev/dispatch-p1.md）：派活单的读取（列表、详情、任务的名额数字）。
// 监工写好的读取部分；派活、领单、结束回写、清扫、重办、不办了、改参数由包 A 写（engine/dispatch/ 和这里）。
import {
  TIME_ZONE,
  workPriorityOf,
  type RunOutcome,
  type TaskDispatch,
  type WorkItem,
  type WorkItemDetail,
  type WorkListInput,
  type WorkPage,
  type WorkQueueStats,
  type WorkRun,
  type WorkTaskStats,
  workListInputSchema,
} from "@heyagent/shared"
import { and, asc, count, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, lte, or, sql, type SQL } from "drizzle-orm"

import type { DbOrTx } from "../data/config/common.js"
import * as t from "../db/schema.js"

type WorkItemRow = typeof t.workItems.$inferSelect

/** 库里的派活配置 → 接口形状：run-outcome 以前存的没有 results（要交回的结果），当作空 */
export const normalizeDispatch = (dispatch: t.StoredTaskDispatch | null | undefined): TaskDispatch | null =>
  dispatch ? { ...dispatch, results: dispatch.results ?? [] } : null

export class WorkError extends Error {
  /** TOO_MANY_REQUESTS（第三期）：撞了「每天最多被派」「最多排队」（HTTP 接口回 429） */
  readonly code: "NOT_FOUND" | "BAD_REQUEST" | "FORBIDDEN" | "CONFLICT" | "TOO_MANY_REQUESTS"
  constructor(code: WorkError["code"], message: string) {
    super(message)
    this.code = code
  }
}

const iso = (value: Date) => value.toISOString()
const isoOrNull = (value: Date | null) => (value ? value.toISOString() : null)

/**
 * 占名额的运行（SQL 条件，用在 sessions 上）：派活触发的、执行中 / 验收中，或者挂起但等的是浏览器（browser.lease: / browser.profile:）、桌面（desktop:）。
 * agent 自己挂起（session.wait）、等人处理不占。领单（包 A）和页面上的数字都用它，口径一致
 */
export function occupiesSlotSql(): SQL {
  return sql`(${t.sessions.status} in ('running', 'verifying') or (${t.sessions.status} = 'waiting' and exists (
    select 1 from ${t.sessionWaits} w where w.session_id = ${t.sessions.id} and w.status = 'waiting' and (w.event like 'browser.%' or w.event like 'desktop:%')
  )))`
}

/** 某个任务现在占着名额的运行数 */
export async function occupiedSlots(db: DbOrTx, taskId: string): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(t.sessions)
    .where(and(eq(t.sessions.taskId, taskId), isNotNull(t.sessions.workItemId), occupiesSlotSql()))
  return row?.n ?? 0
}

/** 排队的单的领单顺序（第三期）：优先级高的先，同一级按派进来的先后。领单（pump.ts）和排队名次用同一个 */
export const QUEUE_ORDER = [desc(t.workItems.priority), asc(t.workItems.createdAt), asc(t.workItems.id)] as const

/**
 * 今天（上海时间 0 点以后开始的）被派来的运行一共花了多少美元，按任务（第三期每天花费上限）。
 * 含验收、复核的花费（本来就记在运行上）；跨过 0 点还在跑的算在开始那天。领单、taskStats、queueStats 用同一份
 */
export async function dispatchSpentToday(db: DbOrTx, taskIds: string[]): Promise<Map<string, number>> {
  if (!taskIds.length) return new Map()
  const rows = await db
    .select({ taskId: t.sessions.taskId, spent: sql<string>`coalesce(sum(${t.sessions.costUsd}), 0)` })
    .from(t.sessions)
    .where(and(inArray(t.sessions.taskId, taskIds), isNotNull(t.sessions.workItemId), gte(t.sessions.startedAt, startOfTodayShanghai())))
    .groupBy(t.sessions.taskId)
  return new Map(rows.map((row) => [row.taskId, Number(row.spent)]))
}

/** 每天花费上限到了没有（没设上限的永远没到） */
export const budgetReached = (spent: number, budget: number | null | undefined) => budget != null && spent >= budget

/** 行 → 接口形状。taskTitle 等关联字段由调用方一次查好传进来 */
function toWorkItem(
  row: WorkItemRow,
  extra: { taskTitles: Map<string, string>; sessionStatus: Map<string, WorkItem["sessionStatus"]>; queuePosition: Map<string, number>; apiKeyNames: Map<string, string> }
): WorkItem {
  return {
    id: row.id,
    taskId: row.taskId,
    taskTitle: extra.taskTitles.get(row.taskId) ?? row.taskId,
    key: row.key,
    title: row.title,
    params: row.params,
    note: row.note,
    status: row.status,
    sessionId: row.sessionId,
    sessionStatus: row.status === "running" && row.sessionId ? (extra.sessionStatus.get(row.sessionId) ?? null) : null,
    attempts: row.attempts,
    via: row.via,
    priority: workPriorityOf(row.priority),
    fromTaskId: row.fromTaskId,
    fromTaskTitle: row.fromTaskId ? (extra.taskTitles.get(row.fromTaskId) ?? row.fromTaskId) : null,
    fromSessionId: row.fromSessionId,
    fromUserId: row.fromUserId,
    apiKeyId: row.apiKeyId,
    apiKeyName: row.apiKeyId ? (extra.apiKeyNames.get(row.apiKeyId) ?? null) : null,
    fromEvent: row.fromEvent,
    depth: row.depth,
    result: row.result ?? null,
    error: row.error,
    failKind: row.status === "failed" ? (row.failKind ?? "error") : null,
    // 结果跟着最后那次运行（run-outcome 6.2）：单结束了才有；排队、在办的没有
    outcome: row.status === "queued" || row.status === "running" ? null : (row.outcome ?? null),
    outcomeReason: row.status === "queued" || row.status === "running" ? null : (row.outcomeReason ?? null),
    notBefore: row.status === "queued" ? isoOrNull(row.notBefore) : null,
    autoRetries: row.autoRetries,
    queuePosition: row.status === "queued" ? (extra.queuePosition.get(row.id) ?? null) : null,
    createdAt: iso(row.createdAt),
    startedAt: isoOrNull(row.startedAt),
    finishedAt: isoOrNull(row.finishedAt),
    updatedAt: iso(row.updatedAt),
  }
}

/** 一批行的关联字段：任务标题、在办运行的状态、排队位次（按任务、创建时间先后） */
async function enrich(db: DbOrTx, rows: WorkItemRow[]) {
  const taskIds = [...new Set(rows.flatMap((row) => [row.taskId, row.fromTaskId].filter((id): id is string => Boolean(id))))]
  const sessionIds = rows.filter((row) => row.status === "running" && row.sessionId).map((row) => row.sessionId!)
  const queuedTasks = [...new Set(rows.filter((row) => row.status === "queued").map((row) => row.taskId))]
  const apiKeyIds = [...new Set(rows.flatMap((row) => (row.apiKeyId ? [row.apiKeyId] : [])))]
  const [tasks, sessions, queued, apiKeys] = await Promise.all([
    taskIds.length ? db.select({ id: t.tasks.id, title: t.tasks.title }).from(t.tasks).where(inArray(t.tasks.id, taskIds)) : [],
    sessionIds.length ? db.select({ id: t.sessions.id, status: t.sessions.status }).from(t.sessions).where(inArray(t.sessions.id, sessionIds)) : [],
    queuedTasks.length
      ? db
          .select({ id: t.workItems.id, taskId: t.workItems.taskId })
          .from(t.workItems)
          // 排队等自动重试、「过多久再办」的（not_before 在将来）不算名次：到点才领。名次按领单的顺序（pump.ts 的 QUEUE_ORDER）
          .where(and(eq(t.workItems.status, "queued"), inArray(t.workItems.taskId, queuedTasks), or(isNull(t.workItems.notBefore), lte(t.workItems.notBefore, sql`now()`))))
          .orderBy(...QUEUE_ORDER)
      : [],
    apiKeyIds.length ? db.select({ id: t.apiKeys.id, name: t.apiKeys.name }).from(t.apiKeys).where(inArray(t.apiKeys.id, apiKeyIds)) : [],
  ])
  const queuePosition = new Map<string, number>()
  const seen = new Map<string, number>()
  for (const row of queued) {
    const n = (seen.get(row.taskId) ?? 0) + 1
    seen.set(row.taskId, n)
    queuePosition.set(row.id, n)
  }
  return {
    taskTitles: new Map(tasks.map((row) => [row.id, row.title])),
    sessionStatus: new Map(sessions.map((row) => [row.id, row.status])),
    queuePosition,
    apiKeyNames: new Map(apiKeys.map((row) => [row.id, row.name])),
  }
}

export async function toWorkItems(db: DbOrTx, rows: WorkItemRow[]): Promise<WorkItem[]> {
  const extra = await enrich(db, rows)
  return rows.map((row) => toWorkItem(row, extra))
}

/** 单的结果，和 @heyagent/shared 的 workItemOutcome 一样：没记结果的旧单，办完算办成、其余算没办成（排队、在办的不用它） */
const itemOutcome = sql<RunOutcome>`coalesce(${t.workItems.outcome}::text, case when ${t.workItems.status} = 'done' then 'achieved' else 'not_achieved' end)`

/** 派活单列表（任务详情「派来的活」、会话页「排队中」等）：新派的在前；同样的筛选（不算状态）下各状态、各标签的张数。翻页用 cursor 或 offset */
export async function listWorkItems(db: DbOrTx, rawInput: WorkListInput): Promise<WorkPage> {
  const input = workListInputSchema.parse(rawInput)
  const base: SQL[] = []
  if (input.taskId) base.push(eq(t.workItems.taskId, input.taskId))
  if (input.fromTaskId) base.push(eq(t.workItems.fromTaskId, input.fromTaskId))
  if (input.fromSessionId) base.push(eq(t.workItems.fromSessionId, input.fromSessionId))
  // 第三期：按去重键精确找（外部系统用自己的编号查）
  if (input.key) base.push(eq(t.workItems.key, input.key))
  if (input.q) {
    const like = `%${input.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    base.push(or(ilike(t.workItems.id, like), ilike(t.workItems.title, like), ilike(t.workItems.key, like), sql`${t.workItems.params}::text ilike ${like}`)!)
  } else if (input.days > 0) {
    base.push(gte(t.workItems.createdAt, new Date(Date.now() - input.days * 24 * 3600_000)))
  }

  const where: SQL[] = [...base]
  if (input.status) where.push(Array.isArray(input.status) ? inArray(t.workItems.status, input.status) : eq(t.workItems.status, input.status))
  // 结果筛选（run-outcome）：和状态筛选一样不算进各状态的张数
  if (input.outcome) where.push(Array.isArray(input.outcome) ? inArray(t.workItems.outcome, input.outcome) : eq(t.workItems.outcome, input.outcome))
  // 派活页的三个标签（没结束 / 办成 / 没办成），同样不算进张数
  if (input.view === "open") where.push(inArray(t.workItems.status, ["queued", "running"]))
  else if (input.view) where.push(and(inArray(t.workItems.status, ["done", "failed", "cancelled"]), eq(itemOutcome, input.view))!)
  if (input.cursor && input.offset === undefined) {
    const [cursor] = await db.select({ createdAt: t.workItems.createdAt, id: t.workItems.id }).from(t.workItems).where(eq(t.workItems.id, input.cursor))
    if (cursor) where.push(or(lt(t.workItems.createdAt, cursor.createdAt), and(eq(t.workItems.createdAt, cursor.createdAt), lt(t.workItems.id, cursor.id)))!)
  }

  const [rows, grouped] = await Promise.all([
    db
      .select()
      .from(t.workItems)
      .where(where.length ? and(...where) : undefined)
      .orderBy(desc(t.workItems.createdAt), desc(t.workItems.id))
      .limit(input.limit + 1)
      .offset(input.offset ?? 0),
    db
      .select({ status: t.workItems.status, outcome: itemOutcome, n: count() })
      .from(t.workItems)
      .where(base.length ? and(...base) : undefined)
      .groupBy(t.workItems.status, itemOutcome),
  ])
  const page = rows.slice(0, input.limit)
  const counts = { all: 0, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0, open: 0, achieved: 0, notAchieved: 0 }
  for (const row of grouped) {
    counts[row.status] += row.n
    counts.all += row.n
    if (row.status === "queued" || row.status === "running") counts.open += row.n
    else if (row.outcome === "achieved") counts.achieved += row.n
    else counts.notAchieved += row.n
  }
  return { items: await toWorkItems(db, page), nextCursor: rows.length > input.limit ? page[page.length - 1]!.id : null, counts }
}

/** 派活单详情：处理记录、每次运行、被派任务的参数声明 */
export async function getWorkItem(db: DbOrTx, id: string): Promise<WorkItemDetail> {
  const [row] = await db.select().from(t.workItems).where(eq(t.workItems.id, id))
  if (!row) throw new WorkError("NOT_FOUND", `没有派活单 ${id}`)
  const [[item], [task], sessions] = await Promise.all([
    toWorkItems(db, [row]),
    db.select({ dispatch: t.tasks.dispatch, enabled: t.tasks.enabled, ownerId: t.tasks.ownerId }).from(t.tasks).where(eq(t.tasks.id, row.taskId)),
    db
      .select({ id: t.sessions.id, status: t.sessions.status, outcome: t.sessions.outcome, startedAt: t.sessions.startedAt, endedAt: t.sessions.endedAt, costUsd: t.sessions.costUsd, error: t.sessions.error })
      .from(t.sessions)
      .where(eq(t.sessions.workItemId, id))
      .orderBy(asc(t.sessions.startedAt), asc(t.sessions.id)),
  ])
  const sessionIds = sessions.map((session) => session.id)
  const [checkpoints, waits] = sessionIds.length
    ? await Promise.all([
        db
          .select({ sessionId: t.checkpoints.sessionId, total: count(), done: sql<number>`count(*) filter (where ${t.checkpoints.status} = 'done')::int` })
          .from(t.checkpoints)
          .where(inArray(t.checkpoints.sessionId, sessionIds))
          .groupBy(t.checkpoints.sessionId),
        db
          .select({ sessionId: t.sessionWaits.sessionId, what: t.sessionWaits.what })
          .from(t.sessionWaits)
          .where(and(inArray(t.sessionWaits.sessionId, sessionIds), eq(t.sessionWaits.status, "waiting"))),
      ])
    : [[], []]
  const checkpointBy = new Map(checkpoints.map((cp) => [cp.sessionId, cp]))
  const waitBy = new Map(waits.map((wait) => [wait.sessionId, wait.what]))
  const runs: WorkRun[] = sessions.map((session) => ({
    sessionId: session.id,
    status: session.status,
    outcome: session.outcome,
    startedAt: iso(session.startedAt),
    endedAt: isoOrNull(session.endedAt),
    costUsd: session.costUsd,
    checkpointsDone: checkpointBy.get(session.id)?.done ?? 0,
    checkpointsTotal: checkpointBy.get(session.id)?.total ?? 0,
    waitingWhat: session.status === "waiting" ? (waitBy.get(session.id) ?? null) : null,
    error: session.error,
  }))
  return { ...item!, log: row.log, runs, taskDispatch: normalizeDispatch(task?.dispatch), taskEnabled: task?.enabled ?? false, taskOwnerId: task?.ownerId ?? "" }
}

/** 上海时间今天 0 点 */
export function startOfTodayShanghai(now = new Date()): Date {
  const day = new Intl.DateTimeFormat("en-CA", { timeZone: TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(now)
  return new Date(`${day}T00:00:00+08:00`)
}

/** 被派任务的一行数字：排队、在办、占名额、今天办完、没办成 */
export async function workTaskStats(db: DbOrTx, taskId: string): Promise<WorkTaskStats> {
  const [[task], grouped, [doneToday], occupied, spent] = await Promise.all([
    db.select({ dispatch: t.tasks.dispatch }).from(t.tasks).where(eq(t.tasks.id, taskId)),
    db.select({ status: t.workItems.status, n: count() }).from(t.workItems).where(eq(t.workItems.taskId, taskId)).groupBy(t.workItems.status),
    db
      .select({ n: count() })
      .from(t.workItems)
      .where(and(eq(t.workItems.taskId, taskId), eq(t.workItems.status, "done"), gte(t.workItems.finishedAt, startOfTodayShanghai()))),
    occupiedSlots(db, taskId),
    dispatchSpentToday(db, [taskId]),
  ])
  if (!task) throw new WorkError("NOT_FOUND", `没有任务 ${taskId}`)
  const by = new Map(grouped.map((row) => [row.status, row.n]))
  return {
    taskId,
    queued: by.get("queued") ?? 0,
    running: by.get("running") ?? 0,
    occupied,
    maxRunning: task.dispatch?.maxRunning ?? 0,
    doneToday: doneToday?.n ?? 0,
    failed: by.get("failed") ?? 0,
    // 今天被派来的运行花了多少，和领单时判断花费上限用同一份
    spentTodayUsd: spent.get(taskId) ?? 0,
    dailyBudgetUsd: task.dispatch?.dailyBudgetUsd ?? null,
  }
}

/**
 * 全部被派任务的名额和排队，一次给（work.queueStats）：能被派活的任务，加上还有排队、在办的单的任务（关了被派活的）。
 * 三条查询：任务、按任务和状态数没结束的单、占着名额的运行
 */
export async function workQueueStats(db: DbOrTx): Promise<WorkQueueStats[]> {
  const [grouped, holders] = await Promise.all([
    db
      .select({ taskId: t.workItems.taskId, status: t.workItems.status, n: count() })
      .from(t.workItems)
      .where(inArray(t.workItems.status, ["queued", "running"]))
      .groupBy(t.workItems.taskId, t.workItems.status),
    db
      .select({ taskId: t.sessions.taskId, id: t.sessions.id })
      .from(t.sessions)
      .where(and(isNotNull(t.sessions.workItemId), occupiesSlotSql()))
      .orderBy(asc(t.sessions.startedAt), asc(t.sessions.id)),
  ])
  const withItems = [...new Set(grouped.map((row) => row.taskId))]
  const tasks = await db
    .select({ id: t.tasks.id, enabled: t.tasks.enabled, dispatch: t.tasks.dispatch })
    .from(t.tasks)
    .where(withItems.length ? or(isNotNull(t.tasks.dispatch), inArray(t.tasks.id, withItems)) : isNotNull(t.tasks.dispatch))
    .orderBy(asc(t.tasks.id))
  // 只查设了花费上限的任务（没设的页面不显示花费）
  const spent = await dispatchSpentToday(
    db,
    tasks.filter((task) => task.dispatch?.dailyBudgetUsd != null).map((task) => task.id)
  )
  return tasks.map((task) => {
    const n = (status: "queued" | "running") => grouped.find((row) => row.taskId === task.id && row.status === status)?.n ?? 0
    const held = holders.filter((row) => row.taskId === task.id).map((row) => row.id)
    return {
      taskId: task.id,
      enabled: task.enabled,
      dispatchable: Boolean(task.dispatch),
      maxRunning: task.dispatch?.maxRunning ?? 0,
      queued: n("queued"),
      running: n("running"),
      occupied: held.length,
      holders: held,
      // 同 workTaskStats（一次查出设了上限的任务今天的花费；没设上限的写 0）
      spentTodayUsd: spent.get(task.id) ?? 0,
      dailyBudgetUsd: task.dispatch?.dailyBudgetUsd ?? null,
    }
  })
}
