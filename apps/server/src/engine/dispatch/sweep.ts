// 派活：每分钟清扫（work.sweep，pg-boss 的 schedule）。思路同 browser/leases.ts 的 sweepLeases：
// 1. 「在办」的单，运行已经结束了（某处结束时漏写）或者运行没了 → 补写；
// 2. 有到点的排队单（不在等自动重试，或者已经到点）、开着被派活、启用了的任务 → 各发一个 work.pump
//    （漏发的、worker 重启丢的、刚调大名额的、等重试到点的：延迟的 work.pump 丢了也有它兜底）。
// 补写算「运行出错」：自动重试还没用完的回到排队；运行是「没完成」的记没办成（agent 判断办不成），不重试。
import { ENDED_RUN_STATUSES, isRunEnded } from "@heyagent/shared"
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { writeSettled } from "./settle.js"
import { sendPump } from "./signal.js"

export async function sweepWork(db: Db): Promise<{ settled: string[]; pumped: string[] }> {
  const stale = await db
    .select({ id: t.workItems.id })
    .from(t.workItems)
    .leftJoin(t.sessions, eq(t.sessions.id, t.workItems.sessionId))
    .where(and(eq(t.workItems.status, "running"), or(isNull(t.workItems.sessionId), isNull(t.sessions.id), inArray(t.sessions.status, [...ENDED_RUN_STATUSES]))))
  const settled: string[] = []
  for (const { id } of stale) {
    const done = await db.transaction(async (tx) => {
      // 锁住再看一遍：这期间可能已经被正常的结束回写写过了
      const [item] = await tx.select().from(t.workItems).where(eq(t.workItems.id, id)).for("update")
      if (!item || item.status !== "running") return false
      const [session] = item.sessionId
        ? await tx
            .select({ id: t.sessions.id, status: t.sessions.status, error: t.sessions.error, verification: t.sessions.verification })
            .from(t.sessions)
            .where(eq(t.sessions.id, item.sessionId))
        : []
      if (session && !isRunEnded(session.status)) return false
      await writeSettled(
        db,
        tx,
        item,
        session ?? null,
        session?.status === "done"
          ? { status: "done" }
          : session?.status === "incomplete"
            ? { status: "failed", retryable: false, failKind: "not_done" }
            : { status: "failed", retryable: true, ...(session ? {} : { error: "运行记录没了，没法知道办得怎么样" }) }
      )
      return true
    })
    if (done) settled.push(id)
  }

  const tasks = await db
    .selectDistinct({ id: t.tasks.id })
    .from(t.workItems)
    .innerJoin(t.tasks, eq(t.tasks.id, t.workItems.taskId))
    .where(
      and(
        eq(t.workItems.status, "queued"),
        or(isNull(t.workItems.notBefore), lte(t.workItems.notBefore, sql`now()`)),
        eq(t.tasks.enabled, true),
        isNotNull(t.tasks.dispatch),
        sql`${t.tasks.dispatch} <> 'null'::jsonb`
      )
    )
  for (const task of tasks) await sendPump(db, task.id)
  if (settled.length) console.log(`[work] 清扫：补写了 ${settled.length} 张单的结束（${settled.join("、")}）`)
  return { settled, pumped: tasks.map((task) => task.id) }
}
