// 会话页的一页（sessions.page）：标签（状态分组）、只看等我处理、来源、任务、结果、搜索、数数、翻页都在库里做，
// 只给这一页的 id 用 listSessions 拼完整摘要（和 sessions.list 一样的形状），保持顺序。
// 排序：默认开始时间新的在前；也能按结束时间、正序（sort / dir），空的（没结束的）总在最后，同一时间按编号同方向排（稳定）。
// 各标签个数、已结束的办成 / 没办成：同样的来源、任务、结果、搜索，不算标签和「只看等我处理」。
import { and, count, eq, exists, ilike, inArray, isNull, or, sql, type SQL } from "drizzle-orm"
import { sessionPageInputSchema, statusesOfGroup, type RunStatus, type SessionCounts, type SessionPage, type SessionPageInput } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { startOfTodayShanghai } from "../work/service.js"
import { listSessions } from "./loaders.js"

/** 挡住运行的几种事（会话页把它们算在运行那一行里） */
const BLOCKING_KINDS = ["approval", "verify", "login"] as const

export async function pageSessions(db: Db, rawInput: SessionPageInput, actor: { id: string; isAdmin: boolean }): Promise<SessionPage> {
  const input = sessionPageInputSchema.parse(rawInput)
  // 固化试跑不进会话页、不算个数和办成率（docs/dev/solidify.md 15.3 第 5 条）：所有查询都从这里起
  const base: SQL[] = [eq(t.sessions.kind, "run")]
  if (input.source) base.push(eq(t.sessions.triggeredBy, input.source))
  if (input.taskId) base.push(eq(t.sessions.taskId, input.taskId))
  // 结果和 shared 的 outcomeOf 一样：没记结果的老数据，没完成、出错的算没办成
  if (input.outcome === "achieved") base.push(eq(t.sessions.outcome, "achieved"))
  if (input.outcome === "not_achieved")
    base.push(or(eq(t.sessions.outcome, "not_achieved"), and(isNull(t.sessions.outcome), inArray(t.sessions.status, ["incomplete", "failed"])))!)
  if (input.q) {
    const like = `%${input.q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
    base.push(or(ilike(t.sessions.id, like), ilike(t.sessions.taskId, like), ilike(t.tasks.title, like), ilike(t.sessions.workItemId, like))!)
  }

  // 只看等我处理：和侧边栏数字同一个算法（loaders.ts 的 loadMe）——主管算全部没处理的事，员工只算分给自己的；这里只算挡住运行的那几种
  const mine = and(
    eq(t.sessions.status, "needs_human"),
    exists(
      db
        .select({ one: sql`1` })
        .from(t.humanItems)
        .where(
          and(
            eq(t.humanItems.sessionId, t.sessions.id),
            eq(t.humanItems.status, "open"),
            inArray(t.humanItems.kind, [...BLOCKING_KINDS]),
            actor.isAdmin ? undefined : eq(t.humanItems.assigneeId, actor.id)
          )
        )
    )
  )!
  const where = and(...base, input.mine ? mine : inArray(t.sessions.status, statusesOfGroup(input.group)))
  const from = () => db.select({ id: t.sessions.id }).from(t.sessions).leftJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))

  // 和 shared 的 outcomeOf 一样：没记结果的没完成、出错算没办成；已结束、还没结果的（复核中）两边都不算
  const ended = inArray(t.sessions.status, statusesOfGroup("ended"))
  const achievedSql = and(ended, eq(t.sessions.outcome, "achieved"))!
  const notAchievedSql = and(ended, or(eq(t.sessions.outcome, "not_achieved"), and(isNull(t.sessions.outcome), inArray(t.sessions.status, ["incomplete", "failed"]))))!

  const [[totalRow], byStatus, [spent], [outcomes]] = await Promise.all([
    db.select({ n: count() }).from(t.sessions).leftJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId)).where(where),
    db
      .select({ status: t.sessions.status, n: count() })
      .from(t.sessions)
      .leftJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))
      .where(and(...base))
      .groupBy(t.sessions.status),
    // 今天花了：普通运行和子运行（子 agent 的钱也是这次运行花的，docs/dev/sub-agents.md 6.4）；试跑不调执行模型，固化员的花费记在版本上
    db
      .select({ usd: sql<number>`coalesce(sum(${t.sessions.costUsd}), 0)::float8` })
      .from(t.sessions)
      .where(and(inArray(t.sessions.kind, ["run", "sub"]), sql`${t.sessions.startedAt} >= ${startOfTodayShanghai()}`)),
    db
      .select({ achieved: sql<number>`count(*) filter (where ${achievedSql})::int`, notAchieved: sql<number>`count(*) filter (where ${notAchievedSql})::int` })
      .from(t.sessions)
      .leftJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))
      .where(and(...base)),
  ])
  const total = totalRow?.n ?? 0
  const page = Math.min(input.page, Math.max(1, Math.ceil(total / input.pageSize)))
  const column = input.sort === "ended" ? t.sessions.endedAt : t.sessions.startedAt
  const dir = input.dir === "asc" ? sql`asc` : sql`desc`
  const ids = total
    ? (
        await from()
          .where(where)
          .orderBy(sql`${column} ${dir} nulls last`, sql`${t.sessions.id} ${dir}`)
          .limit(input.pageSize)
          .offset((page - 1) * input.pageSize)
      ).map((row) => row.id)
    : []
  const summaries = ids.length ? await listSessions(db, { ids }) : []
  const byId = new Map(summaries.map((run) => [run.id, run]))

  const counts: SessionCounts = { running: 0, human: 0, waiting: 0, verifying: 0, ended: 0 }
  for (const group of Object.keys(counts) as (keyof SessionCounts)[]) {
    const statuses: RunStatus[] = statusesOfGroup(group)
    counts[group] = byStatus.filter((row) => statuses.includes(row.status)).reduce((sum, row) => sum + row.n, 0)
  }
  return {
    items: ids.flatMap((id) => byId.get(id) ?? []),
    total,
    page,
    pageSize: input.pageSize,
    counts,
    spentToday: Number(spent?.usd ?? 0),
    endedOutcome: { achieved: outcomes?.achieved ?? 0, notAchieved: outcomes?.notAchieved ?? 0 },
  }
}
