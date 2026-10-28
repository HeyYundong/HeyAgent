// 固化的清扫（docs/dev/solidify.md 17.3），队列 routine.sweep 每 5 分钟一次（worker-runtime.ts 注册）。
// routine.compile 平时由点「固化成流程」、自动固化、试跑的运行结束时发；这里兜底两种卡住的情况：
// - 试跑中的版本，这一轮的试跑运行已经结束了（在别处被标失败、没经过引擎的收尾，没人发）→ 补发；
// - 写脚本中的版本，30 分钟没动静（队列任务丢了、重试用完了）→ 再发一次。
// 同一版排着、正在做的 routine.compile 已经有了就不发（stately + singletonKey 本来也只留一个，这里免得写脚本时又排一个）。
import { ENDED_RUN_STATUSES, routineTestSessionId } from "@heyagent/shared"
import { and, eq, inArray, lt, sql } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { QUEUES } from "../engine/queue.js"
import { sendRoutineCompile } from "./jobs.js"

/** 写脚本中多久没动静算卡住（一轮写脚本 + 程序检查远用不了这么久；也等于 routine.compile 的过期时间） */
export const DRAFTING_STALE_MS = 30 * 60_000

/** 这一版的 routine.compile 排着或者正在做 */
async function compileQueued(db: Db, versionId: string) {
  const rows = await db.execute(
    sql`select 1 from pgboss.job where name = ${QUEUES.routineCompile} and singleton_key = ${versionId} and state in ('created', 'retry', 'active') limit 1`
  )
  return rows.rows.length > 0
}

/** 返回补发了哪几版（测试、日志用） */
export async function sweepRoutines(db: Db, now = new Date()): Promise<string[]> {
  const sent: string[] = []
  const testing = await db
    .select({ id: t.routineVersions.id, round: t.routineVersions.round })
    .from(t.routineVersions)
    .where(eq(t.routineVersions.status, "testing"))
  if (testing.length) {
    const ids = testing.map((version) => routineTestSessionId(version.id, version.round))
    const ended = await db
      .select({ id: t.sessions.id })
      .from(t.sessions)
      .where(and(inArray(t.sessions.id, ids), inArray(t.sessions.status, [...ENDED_RUN_STATUSES])))
    const endedIds = new Set(ended.map((row) => row.id))
    for (const version of testing)
      if (endedIds.has(routineTestSessionId(version.id, version.round)) && !(await compileQueued(db, version.id))) {
        await sendRoutineCompile(db, undefined, { versionId: version.id })
        sent.push(version.id)
      }
  }
  const stale = await db
    .select({ id: t.routineVersions.id })
    .from(t.routineVersions)
    .where(and(eq(t.routineVersions.status, "drafting"), lt(t.routineVersions.updatedAt, new Date(now.getTime() - DRAFTING_STALE_MS))))
  for (const version of stale) {
    if (await compileQueued(db, version.id)) continue
    // 先碰一下 updated_at：这一次发的还没开始做时，下一次清扫不再发
    await db.update(t.routineVersions).set({ updatedAt: now }).where(eq(t.routineVersions.id, version.id))
    await sendRoutineCompile(db, undefined, { versionId: version.id })
    sent.push(version.id)
  }
  if (sent.length) console.warn(`[routine] 清扫补发了 routine.compile：${sent.join("、")}`)
  return sent
}
