// 子 agent：页面要的数据（docs/dev/sub-agents.md 10.2、11.1），以及交回、复核要的「一个子运行的事实」。
// - listSubagents：父运行详情「子 agent」区块（tRPC sessions.subagents），按 n 排；
// - subagentStatsOf：SessionSummary.subagents（data/loaders.ts 的 listSessions 一次分组查询带上）；
// - subGoalOf：子运行详情「子目标」区块（SessionRun.subGoal，data/loaders.ts 的 loadSession 带上）；
// - loadSubRunFacts：交回给父的文字、等的条件、复核一节都从它来（results.ts 的纯函数）。
import {
  ENDED_RUN_STATUSES,
  isRunEnded,
  isSubagentQueueEvent,
  SUBAGENT_FILES_LISTED,
  SUBAGENT_QUEUE_EVENT_PREFIX,
  type SessionSnapshot,
  type SnapshotSub,
  type SubagentGoalView,
  type SubagentRow,
  type SubagentState,
  type SubagentStats,
  type SubResult,
} from "@heyagent/shared"
import { and, asc, eq, inArray, sql } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { assignSpacePaths } from "../../files/service.js"
import type { DbLike } from "../records.js"
import type { SubRunFacts } from "./results.js"

/** 子运行现在的样子（第 3 节的表）：状态 + 正在等的事件 */
export function subagentStateOf(status: string, waitEvent: string | null | undefined): SubagentState {
  if (isRunEnded(status as Parameters<typeof isRunEnded>[0])) return "ended"
  if (status === "needs_human") return "needs_human"
  if (status === "waiting") {
    if (isSubagentQueueEvent(waitEvent)) return "queued"
    return "waiting"
  }
  return "running"
}

interface ChildRow {
  id: string
  status: string
  outcome: SubagentRow["outcome"] | null
  outcomeReason: string | null
  outcomeBy: SubagentRow["outcomeBy"] | null
  error: string | null
  subResult: SubResult | null
  sub: SnapshotSub | null
  costUsd: number
  startedAt: Date
  endedAt: Date | null
}

/** 父运行拆出去的子运行（kind = sub：被派的运行也写了 parent_session_id），按 n 排；带正在等的那条等待 */
async function childrenOf(db: DbLike, parentId: string) {
  const rows: ChildRow[] = await db
    .select({
      id: t.sessions.id,
      status: t.sessions.status,
      outcome: t.sessions.outcome,
      outcomeReason: t.sessions.outcomeReason,
      outcomeBy: t.sessions.outcomeBy,
      error: t.sessions.error,
      subResult: t.sessions.subResult,
      // 只取快照里的 sub（整个快照有技能全文，很大）
      sub: sql<SnapshotSub | null>`${t.sessions.snapshot}->'sub'`,
      costUsd: t.sessions.costUsd,
      startedAt: t.sessions.startedAt,
      endedAt: t.sessions.endedAt,
    })
    .from(t.sessions)
    .where(and(eq(t.sessions.parentSessionId, parentId), eq(t.sessions.kind, "sub")))
  const ids = rows.map((row) => row.id)
  const waits = ids.length
    ? await db
        .select({ sessionId: t.sessionWaits.sessionId, event: t.sessionWaits.event, what: t.sessionWaits.what })
        .from(t.sessionWaits)
        .where(and(inArray(t.sessionWaits.sessionId, ids), eq(t.sessionWaits.status, "waiting")))
    : []
  const waitOf = new Map(waits.map((wait) => [wait.sessionId, wait]))
  return rows
    .map((row) => ({ row, n: row.sub?.n ?? 0, wait: waitOf.get(row.id) }))
    .sort((a, b) => a.n - b.n || (a.row.id < b.row.id ? -1 : 1))
}

/** 每个子运行自己写的文件（agent 写的、浏览器下载的），路径照它在自己空间里的；父看到的是 subs/<n>/<路径> */
async function childFiles(db: DbLike, ids: string[]): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>()
  if (!ids.length) return result
  const rows = await db
    .select()
    .from(t.files)
    .where(and(inArray(t.files.sessionId, ids), inArray(t.files.kind, ["artifact", "download"])))
    .orderBy(asc(t.files.createdAt), asc(t.files.id))
  for (const id of ids) {
    const own = rows.filter((row) => row.sessionId === id)
    result.set(
      id,
      assignSpacePaths(own, id)
        .map((entry) => entry.path)
        .slice(0, SUBAGENT_FILES_LISTED + 1)
    )
  }
  return result
}

/** 交回、等的条件、复核要的事实（results.ts 用），按 n 排 */
export async function loadSubRunFacts(db: DbLike, parentId: string): Promise<SubRunFacts[]> {
  const children = await childrenOf(db, parentId)
  const files = await childFiles(
    db,
    children.filter(({ row }) => isRunEnded(row.status as Parameters<typeof isRunEnded>[0])).map(({ row }) => row.id)
  )
  return children.map(({ row, n, wait }) => ({
    id: row.id,
    n,
    title: row.sub?.title ?? row.id,
    goal: row.sub?.goal ?? "",
    results: row.sub?.results ?? [],
    status: row.status,
    outcome: row.outcome,
    outcomeReason: row.outcomeReason,
    outcomeBy: row.outcomeBy,
    error: row.error,
    subResult: row.subResult,
    files: files.get(row.id) ?? [],
    state: subagentStateOf(row.status, wait?.event),
    waitingWhat: wait?.what ?? null,
  }))
}

/**
 * 父运行拆出去的子运行（kind = sub、parent_session_id = parentId），按 n 排。
 * state：挂起等 subagent.queue: → queued；执行中、验收中 → running；挂起等 browser. / desktop: → waiting；等人处理 → needs_human；结束 → ended
 */
export async function listSubagents(db: Db, parentId: string): Promise<SubagentRow[]> {
  const children = await childrenOf(db, parentId)
  return children.map(({ row, n, wait }) => {
    const state = subagentStateOf(row.status, wait?.event)
    return {
      id: row.id,
      n,
      title: row.sub?.title ?? row.id,
      goal: row.sub?.goal ?? "",
      state,
      ...(state === "ended" && row.outcome ? { outcome: row.outcome } : {}),
      ...(state === "ended" && (row.outcomeReason ?? row.error) ? { outcomeReason: (row.outcomeReason ?? row.error)! } : {}),
      ...(state === "ended" && row.outcomeBy ? { outcomeBy: row.outcomeBy } : {}),
      costUsd: Number(row.costUsd),
      startedAt: row.startedAt.toISOString(),
      ...(row.endedAt ? { endedAt: row.endedAt.toISOString() } : {}),
      ...(wait?.what && state !== "ended" ? { waitingWhat: wait.what } : {}),
      delivered: Boolean(row.subResult?.deliveredAt),
    }
  })
}

/** 一批父运行各自的子 agent 统计（没拆过的不在 Map 里）：一次分组查询 */
export async function subagentStatsOf(db: Db, parentIds: string[]): Promise<Map<string, SubagentStats>> {
  const result = new Map<string, SubagentStats>()
  if (!parentIds.length) return result
  const queuedSql = sql`(${t.sessions.status} = 'waiting' and exists (select 1 from ${t.sessionWaits} w where w.session_id = "sessions"."id" and w.status = 'waiting' and w.event like ${`${SUBAGENT_QUEUE_EVENT_PREFIX}%`}))`
  const endedSql = inArray(t.sessions.status, [...ENDED_RUN_STATUSES])
  const rows = await db
    .select({
      parentId: t.sessions.parentSessionId,
      total: sql<number>`count(*)::int`,
      queued: sql<number>`count(*) filter (where ${queuedSql})::int`,
      needsHuman: sql<number>`count(*) filter (where ${t.sessions.status} = 'needs_human')::int`,
      ended: sql<number>`count(*) filter (where ${endedSql})::int`,
      achieved: sql<number>`count(*) filter (where ${endedSql} and ${t.sessions.status} = 'done' and ${t.sessions.outcome} = 'achieved')::int`,
      costUsd: sql<string>`coalesce(sum(${t.sessions.costUsd}), 0)`,
    })
    .from(t.sessions)
    .where(and(inArray(t.sessions.parentSessionId, parentIds), eq(t.sessions.kind, "sub")))
    .groupBy(t.sessions.parentSessionId)
  for (const row of rows) {
    if (!row.parentId) continue
    result.set(row.parentId, {
      total: row.total,
      queued: row.queued,
      // 在跑（含等浏览器、等桌面）= 其余没结束、不在等人处理、不在排队的
      running: row.total - row.queued - row.needsHuman - row.ended,
      needsHuman: row.needsHuman,
      ended: row.ended,
      achieved: row.achieved,
      costUsd: Number(row.costUsd),
    })
  }
  return result
}

/** 子运行的「子目标」：快照 sub + sub_result.data（交了的字段带 value）+ 给它的文件（url 由调用方给）。不是子运行返回 undefined */
export function subGoalOf(snapshot: SessionSnapshot, subResult: SubResult | null, files: SubagentGoalView["files"]): SubagentGoalView | undefined {
  const sub = snapshot.sub
  if (!sub) return undefined
  const data = subResult?.data ?? {}
  return {
    n: sub.n,
    title: sub.title,
    goal: sub.goal,
    input: sub.input,
    results: sub.results.map((name) => (name in data ? { name, value: data[name]! } : { name })),
    files,
  }
}
