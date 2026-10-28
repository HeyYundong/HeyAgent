// 试用、正式、自动停用（docs/dev/solidify.md 6.5、6.6、15.2 第 6 条）：跑过脚本的普通运行结果定了以后（收尾复核完、标失败）调一次。
// - 脚本报了结果而且办成：连着直接办成 +1、连着交给 agent 清零；试用期连着满 3 次转正式，记审计、通知负责人；
// - 交给 agent：连着交给 agent +1、连着直接办成清零；满 3 次自动停用（写清楚原因），通知负责人；
// - 别的（脚本报了没办成、输入有问题、取消）不动计数；
// - 脚本报了办成、三方验收反问、agent 接着做的（agentAfter，docs/dev/solidify.md 17.3）：不算直接办成，也不算交给 agent，不动计数。
// 试用期的运行每次结束都通知负责人结果（办成也发）。只算运行开始时冻的那一版还是启用版本的情况：中途换了版本，旧版的结果不算到新版上。
import { ROUTINE_PAUSE_AFTER_FALLBACKS, ROUTINE_TRIAL_RUNS, routineStopKindLabel, runOutcomeLabel } from "@heyagent/shared"
import { eq } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { notifyUsers, sessionLink } from "../../engine/notify.js"
import { writeAudit } from "../../engine/records.js"

const seconds = (ms: number | undefined) => `${((ms ?? 0) / 1000).toFixed(1)} 秒`

export async function settleRoutineRun(db: Db, sessionId: string): Promise<void> {
  const [session] = await db
    .select({
      id: t.sessions.id,
      taskId: t.sessions.taskId,
      kind: t.sessions.kind,
      routine: t.sessions.routine,
      outcome: t.sessions.outcome,
      outcomeReason: t.sessions.outcomeReason,
      snapshot: t.sessions.snapshot,
    })
    .from(t.sessions)
    .where(eq(t.sessions.id, sessionId))
  const state = session?.routine
  if (!session || session.kind !== "run" || !state || state.mode !== "run" || state.state === "running") return
  const task = session.snapshot?.task
  const wasTrial = session.snapshot?.routine?.status === "trial"
  const direct = state.state === "finished" && session.outcome === "achieved" && !state.agentAfter
  const fellBack = state.state === "fell_back"

  const change = await db.transaction(async (tx) => {
    const [routine] = await tx.select().from(t.routines).where(eq(t.routines.id, state.routineId)).for("update")
    if (!routine || routine.activeVersion !== state.version || (!direct && !fellBack)) return undefined
    if (direct) {
      const directStreak = routine.directStreak + 1
      const promote = routine.status === "trial" && directStreak >= ROUTINE_TRIAL_RUNS
      await tx
        .update(t.routines)
        .set({ directStreak, fallbackStreak: 0, ...(promote ? { status: "active" as const } : {}) })
        .where(eq(t.routines.id, routine.id))
      if (promote)
        await writeAudit(tx, {
          action: "routine.promote",
          targetTable: "routines",
          targetId: routine.id,
          detail: { version: state.version, directStreak, sessionId },
        })
      return promote ? ("promoted" as const) : undefined
    }
    const fallbackStreak = routine.fallbackStreak + 1
    const pause = routine.status !== "paused" && fallbackStreak >= ROUTINE_PAUSE_AFTER_FALLBACKS
    await tx
      .update(t.routines)
      .set({
        fallbackStreak,
        directStreak: 0,
        ...(pause
          ? { status: "paused" as const, pausedReason: `停用：连续 ${fallbackStreak} 次跑不通（最近一次停在第 ${state.stoppedAt?.step ?? state.steps} 步：${state.stoppedAt?.reason ?? "原因不明"}）` }
          : {}),
      })
      .where(eq(t.routines.id, routine.id))
    if (pause)
      await writeAudit(tx, {
        action: "routine.auto_pause",
        targetTable: "routines",
        targetId: routine.id,
        detail: { version: state.version, fallbackStreak, sessionId },
      })
    return pause ? ("paused" as const) : undefined
  })

  if (!task) return
  const base = { userIds: [task.ownerId], link: sessionLink(session.taskId, session.id), taskId: session.taskId, sessionId: session.id }
  const name = session.snapshot?.routine?.name ?? state.routineId
  if (change === "promoted")
    await notifyUsers(db, {
      ...base,
      title: `${task.title}：固化流程「${name}」转正式`,
      body: `第 ${state.version} 版试用期连着 ${ROUTINE_TRIAL_RUNS} 次脚本直接办成，转为正式。以后只在没办成、交给 agent 时通知你。`,
      push: false,
    })
  if (change === "paused")
    await notifyUsers(db, {
      ...base,
      title: `${task.title}：固化流程「${name}」自动停用了`,
      body: `第 ${state.version} 版连续 ${ROUTINE_PAUSE_AFTER_FALLBACKS} 次跑不通、交给 agent，已经自动停用，之后的运行只用 agent。最近一次停在第 ${state.stoppedAt?.step ?? state.steps} 步：${state.stoppedAt?.reason ?? "原因不明"}。可以在一次办成的运行上重新固化。`,
    })
  // 试用期：每次都通知结果（办成也发）
  if (wasTrial && change !== "promoted") {
    const result = session.outcome ? runOutcomeLabel[session.outcome] : "没有结果"
    const body = direct
      ? `脚本直接办成：${state.steps} 步 · ${seconds(state.ms)}。`
      : fellBack
        ? `脚本停在第 ${state.stoppedAt?.step ?? state.steps} 步（${routineStopKindLabel[state.stoppedAt?.kind ?? "script_error"]}：${state.stoppedAt?.reason ?? ""}），交给 agent 接着做；结果：${result}${session.outcomeReason ? `（${session.outcomeReason}）` : ""}。`
        : state.agentAfter
          ? `脚本报了办成，验收反问以后 agent 接着做；结果：${result}${session.outcomeReason ? `（${session.outcomeReason}）` : ""}。`
          : `脚本${state.state === "finished" ? "跑完了" : "停下了"}，结果：${result}${session.outcomeReason ? `（${session.outcomeReason}）` : ""}。`
    await notifyUsers(db, { ...base, title: `${task.title}：固化流程「${name}」试用中的一次运行`, body, push: false })
  }
}
