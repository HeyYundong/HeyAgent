// 子 agent：按名额放行排队的子运行（docs/dev/sub-agents.md 6.2，队列 subagent.pump，全系统一个）。
// 事务里 pg_advisory_xact_lock(hashtext('subagent.pump'))；全局空位 = maxRunningGlobal − 全系统占名额的子运行数；
// 有排队子运行、父运行还没结束的父运行按最早排队的时间排，每个放 min(maxParallel − 它占名额的, 全局空位) 个（按 n），
// 放行 = resumeInTx(waitId, cause "resume_now", message "", title "轮到了，开始")；父运行已经结束的，排队的子运行一起取消（settle.ts）。
// 占名额：执行中、验收中、挂起等浏览器 / 等桌面（shared 的 holdsSubagentSlot）；等人处理、排队不占。
import { isRunEnded, parseSubSessionId, RESOURCE_WAIT_EVENT_PREFIXES, SUBAGENT_QUEUE_EVENT_PREFIX } from "@heyagent/shared"
import { and, asc, eq, like, sql, type SQL } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import type { Db } from "../../db/client.js"
import { readSubagentSettings } from "../../data/config/settings.js"
import * as t from "../../db/schema.js"
import type { Tx } from "../queue.js"
import { resumeInTx } from "../waits.js"
import { stopSubRunInTx } from "./settle.js"

export interface SubagentPumpResult {
  /** 放行的子运行编号 */
  released: string[]
  /** 父运行已经结束、跟着取消的排队子运行 */
  cancelled: string[]
}

/** 子运行占着名额（6.2 的表）：执行中、验收中，或者挂起等浏览器、等桌面 */
export function subagentSlotSql(): SQL {
  const resource = sql.join(
    RESOURCE_WAIT_EVENT_PREFIXES.map((prefix) => sql`w.event like ${`${prefix}%`}`),
    sql` or `
  )
  return sql`(${t.sessions.status} in ('running', 'verifying') or (${t.sessions.status} = 'waiting' and exists (
    select 1 from ${t.sessionWaits} w where w.session_id = ${t.sessions.id} and w.status = 'waiting' and (${resource})
  )))`
}

/** 全系统、按父运行数占着名额的子运行 */
async function occupied(tx: Tx): Promise<Map<string, number>> {
  const rows = await tx
    .select({ parentId: t.sessions.parentSessionId, n: sql<number>`count(*)::int` })
    .from(t.sessions)
    .where(and(eq(t.sessions.kind, "sub"), subagentSlotSql()))
    .groupBy(t.sessions.parentSessionId)
  return new Map(rows.map((row) => [row.parentId ?? "", row.n]))
}

/** subagent.pump 的处理函数（worker-runtime.ts 注册） */
export async function pumpSubagents(db: Db): Promise<SubagentPumpResult> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('subagent.pump'))`)
    const settings = await readSubagentSettings(tx)
    const parent = alias(t.sessions, "parent")
    // 排队的子运行：挂起等 subagent.queue:<父>，按排队的先后
    const queued = await tx
      .select({
        id: t.sessions.id,
        parentId: t.sessions.parentSessionId,
        parentStatus: parent.status,
        waitId: t.sessionWaits.id,
      })
      .from(t.sessions)
      .innerJoin(t.sessionWaits, and(eq(t.sessionWaits.sessionId, t.sessions.id), eq(t.sessionWaits.status, "waiting")))
      .leftJoin(parent, eq(parent.id, t.sessions.parentSessionId))
      .where(and(eq(t.sessions.kind, "sub"), eq(t.sessions.status, "waiting"), like(t.sessionWaits.event, `${SUBAGENT_QUEUE_EVENT_PREFIX}%`)))
      .orderBy(asc(t.sessionWaits.createdAt), asc(t.sessionWaits.id))
    const result: SubagentPumpResult = { released: [], cancelled: [] }
    if (!queued.length) return result

    // 父运行已经结束（或者没了）的：排队的跟着取消
    const live: typeof queued = []
    for (const row of queued) {
      if (!row.parentId || !row.parentStatus || isRunEnded(row.parentStatus)) {
        if (await stopSubRunInTx(db, tx, row.id, `父运行 ${row.parentId ?? "（已删除）"} 已经结束，排队的子 agent 跟着取消了`)) result.cancelled.push(row.id)
      } else live.push(row)
    }

    const held = await occupied(tx)
    let globalFree = settings.maxRunningGlobal - [...held.values()].reduce((sum, n) => sum + n, 0)
    // 父运行按最早排队的子运行排（queued 已经按排队先后排好，第一次出现的顺序就是）；同一个父运行里按 n
    const parents = [...new Set(live.map((row) => row.parentId!))]
    for (const parentId of parents) {
      if (globalFree <= 0) break
      const free = Math.min(settings.maxParallel - (held.get(parentId) ?? 0), globalFree)
      if (free <= 0) continue
      const mine = live
        .filter((row) => row.parentId === parentId)
        .sort((a, b) => (parseSubSessionId(a.id)?.n ?? 0) - (parseSubSessionId(b.id)?.n ?? 0))
        .slice(0, free)
      for (const row of mine) {
        const resumed = await resumeInTx(db, tx, { waitId: row.waitId, cause: "resume_now", message: "", title: "轮到了，开始" })
        if (resumed) {
          result.released.push(row.id)
          globalFree--
        }
      }
    }
    return result
  })
}
