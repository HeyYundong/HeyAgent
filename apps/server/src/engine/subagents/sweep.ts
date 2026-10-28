// 子 agent 的清扫（docs/dev/sub-agents.md 6.5）：并进每分钟的 work.sweep（dispatch/sweep.ts 的 sweepWork 末尾调它），不另开定时。
// 1. 有排队子运行 → 发 subagent.pump（名额有没有空由 pump 自己算）；
// 2. 父运行在等子 agent、条件已经满足（漏了叫醒）→ 发 subagent.notify；
// 3. 父运行已经结束、还有没结束的子运行 → 停掉（漏了跟着停的）。
import { ENDED_RUN_STATUSES, parseSubagentWaitEvent, SUBAGENT_QUEUE_EVENT_PREFIX, SUBAGENT_WAIT_EVENT_PREFIXES } from "@heyagent/shared"
import { and, eq, inArray, like, notInArray, or } from "drizzle-orm"
import { alias } from "drizzle-orm/pg-core"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { waitSatisfied } from "./results.js"
import { stopSubRunInTx } from "./settle.js"
import { sendSubagentNotify, sendSubagentPump } from "./signal.js"
import { loadSubRunFacts } from "./view.js"

export interface SubagentSweepResult {
  pumped: boolean
  notified: string[]
  stopped: string[]
}

export async function sweepSubagents(db: Db): Promise<SubagentSweepResult> {
  const result: SubagentSweepResult = { pumped: false, notified: [], stopped: [] }

  // 3. 父运行已经结束、子运行还没结束：跟着停（先做这个，下面的放行就不会再放它们）
  const parent = alias(t.sessions, "parent")
  const orphans = await db
    .select({ id: t.sessions.id, parentId: parent.id })
    .from(t.sessions)
    .innerJoin(parent, eq(parent.id, t.sessions.parentSessionId))
    .where(and(eq(t.sessions.kind, "sub"), notInArray(t.sessions.status, [...ENDED_RUN_STATUSES]), inArray(parent.status, [...ENDED_RUN_STATUSES])))
  for (const orphan of orphans) {
    const stopped = await db.transaction((tx) => stopSubRunInTx(db, tx, orphan.id, `父运行 ${orphan.parentId} 已经结束，跟着停了`))
    if (stopped) result.stopped.push(orphan.id)
  }

  // 1. 有排队的子运行
  const [queued] = await db
    .select({ id: t.sessionWaits.id })
    .from(t.sessionWaits)
    .where(and(eq(t.sessionWaits.status, "waiting"), like(t.sessionWaits.event, `${SUBAGENT_QUEUE_EVENT_PREFIX}%`)))
    .limit(1)
  if (queued) {
    await sendSubagentPump(db)
    result.pumped = true
  }

  // 2. 父运行在等子 agent、条件已经满足
  const waits = await db
    .select({ event: t.sessionWaits.event })
    .from(t.sessionWaits)
    .where(and(eq(t.sessionWaits.status, "waiting"), or(...SUBAGENT_WAIT_EVENT_PREFIXES.map((prefix) => like(t.sessionWaits.event, `${prefix}%`)))))
  for (const wait of waits) {
    const parsed = parseSubagentWaitEvent(wait.event)
    if (!parsed) continue
    if (waitSatisfied(await loadSubRunFacts(db, parsed.parentSessionId), parsed.mode)) {
      await sendSubagentNotify(db, parsed.parentSessionId)
      result.notified.push(parsed.parentSessionId)
    }
  }
  if (result.stopped.length || result.notified.length)
    console.log(`[subagent] 清扫：停掉 ${result.stopped.length} 个（${result.stopped.join("、")}），补发叫醒 ${result.notified.length} 个父运行（${result.notified.join("、")}）`)
  return result
}
