// 固化试跑不管怎么结束（跑完、脚本出错、运行失败、被取消）都要交给固化往下走（docs/dev/solidify.md 5.6）：
// 在结束运行的那个事务里，把还没定结局的 sessions.routine 写成 stopped（带上 stoppedAt 的 kind、reason），发 routine.compile。
// 固化那边（routine/compile.ts）收到时运行已经结束，看 sessions.routine 判这一轮过没过；没人发的话这一版会一直卡在「试跑中」。
import type { RoutineStopKind, SessionRoutineState } from "@heyagent/shared"
import { eq } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import type { Tx } from "../../engine/queue.js"
import { sendRoutineCompile } from "../jobs.js"

/** 不是固化试跑就什么都不做；已经定了结局（脚本跑完、停下）的不改，只发 routine.compile */
export async function endRoutineTestInTx(db: Db, tx: Tx | undefined, sessionId: string, stop: { kind: RoutineStopKind; reason: string }) {
  const runner = tx ?? db
  const [row] = await runner.select({ kind: t.sessions.kind, routine: t.sessions.routine, snapshot: t.sessions.snapshot }).from(t.sessions).where(eq(t.sessions.id, sessionId))
  if (!row || row.kind !== "routine_test") return
  const versionId = row.routine?.versionId ?? row.snapshot?.routine?.versionId
  if (!versionId) return
  const current = row.routine
  if (current && (current.state === "running" || !current.stoppedAt) && current.state !== "finished") {
    const now = new Date()
    const state: SessionRoutineState = {
      ...current,
      state: "stopped",
      stoppedAt: current.stoppedAt ?? { step: current.steps, kind: stop.kind, reason: stop.reason.slice(0, 1000) },
      endedAt: current.endedAt ?? now.toISOString(),
      ms: current.ms ?? Math.max(0, now.getTime() - Date.parse(current.startedAt)),
    }
    await runner.update(t.sessions).set({ routine: state }).where(eq(t.sessions.id, sessionId))
  }
  await sendRoutineCompile(db, tx, { versionId })
}
