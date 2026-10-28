// 库流程的调用记录、连续跑不通的计数、自动停用（docs/dev/routine-library.md 6.5、6.6）。
// 每次调用（agent 调、脚本调都算；两层嵌套时每一层各一行）结束时调一次 recordRoutineCall：
// - 写一行 routine_calls。同一次调用（同一个运行、同一个调用 id）再记就是覆盖：脚本停下等人（审批、挂起）时记过一行「停下了」，
//   接着跑以后按日志重放、跑完了再记一次；
// - 按 shared 的 libraryStreakChange 改登记的 fail_streak（fail +1 / reset 清零 / keep 不动）。只算调的是现在发布的那一版：
//   运行开始时冻的是旧版、中途发布了新版的，旧版的结果不算到新版上（同 runtime/stats.ts）；
// - fail_streak 满 LIBRARY_PAUSE_AFTER_FAILS 而且还在库里 → 自动停用：status = paused，paused_reason 写清最近三次停在哪
//   （库流程第几步、原因、哪次运行），审计 routine.library.auto_pause，通知来源任务负责人和最近一次发布的主管。
// 调用方的运行：这次调用算一次工具调用，执行模型的步数不加；脚本里的判断题花费记在调用方（同 ha.judge）。
// 来源任务「固化流程」区块的成绩不变，只算来源任务自己的运行（runtime/stats.ts）。
import {
  LIBRARY_FAIL_STOP_KINDS,
  LIBRARY_PAUSE_AFTER_FAILS,
  libraryStreakChange,
  routineStopKindLabel,
  type RoutineCallResult,
  type RoutineCallVia,
  type RoutineStopKind,
} from "@heyagent/shared"
import { and, desc, eq, inArray } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { notifyUsers } from "../../engine/notify.js"
import { writeAudit } from "../../engine/records.js"

/** 一次调用（routine_calls 的一行） */
export interface NewRoutineCall {
  routineId: string
  version: number
  /** 调用方的运行、任务 */
  sessionId: string
  taskId: string
  /** agent 调 = 模型的工具调用 id；脚本调 = 进入那一步的调用 id（同 trace.library.callId） */
  callId: string
  via: RoutineCallVia
  depth: number
  result: RoutineCallResult
  stopKind?: RoutineStopKind
  /** 停在库流程的第几步 */
  stopStep?: number
  stopReason?: string
  steps: number
  ms: number
}

/** 流程页的链接（详情） */
export const libraryLink = (routineId: string) => `#/routines?id=${encodeURIComponent(routineId)}`

const oneLine = (text: string, max = 120) => {
  const line = text.replace(/\s*\n\s*/g, " ").trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/** 记一次调用，改计数，满了自动停用、通知。返回这次有没有把它自动停用 */
export async function recordRoutineCall(db: Db, call: NewRoutineCall): Promise<{ autoPaused: boolean }> {
  const paused = await db.transaction(async (tx) => {
    // 同一次调用接着跑以后再记：覆盖上次的那一行
    await tx
      .delete(t.routineCalls)
      .where(and(eq(t.routineCalls.sessionId, call.sessionId), eq(t.routineCalls.callId, call.callId), eq(t.routineCalls.routineId, call.routineId)))
    await tx.insert(t.routineCalls).values({
      routineId: call.routineId,
      version: call.version,
      sessionId: call.sessionId,
      taskId: call.taskId,
      callId: call.callId,
      via: call.via,
      depth: call.depth,
      result: call.result,
      stopKind: call.stopKind ?? null,
      stopStep: call.stopStep ?? null,
      stopReason: call.stopReason?.slice(0, 2000) ?? null,
      steps: Math.max(0, Math.round(call.steps)),
      ms: Math.max(0, Math.round(call.ms)),
    })
    const change = libraryStreakChange(call.result, call.stopKind)
    if (change === "keep") return undefined
    const [entry] = await tx.select().from(t.routineLibrary).where(eq(t.routineLibrary.routineId, call.routineId)).for("update")
    // 没登记了（撤下后删了登记的不会有）、调的不是现在发布的那一版：不动计数
    if (!entry || entry.publishedVersion !== call.version) return undefined
    if (change === "reset") {
      if (entry.failStreak) await tx.update(t.routineLibrary).set({ failStreak: 0 }).where(eq(t.routineLibrary.routineId, entry.routineId))
      return undefined
    }
    const failStreak = entry.failStreak + 1
    const pause = entry.status === "listed" && failStreak >= LIBRARY_PAUSE_AFTER_FAILS
    let reason: string | undefined
    if (pause) {
      // 最近几次跑不通的（含这一次）：停在第几步、原因、哪次运行
      const recent = await tx
        .select({ sessionId: t.routineCalls.sessionId, stopKind: t.routineCalls.stopKind, stopStep: t.routineCalls.stopStep, stopReason: t.routineCalls.stopReason })
        .from(t.routineCalls)
        .where(
          and(
            eq(t.routineCalls.routineId, entry.routineId),
            eq(t.routineCalls.version, entry.publishedVersion),
            eq(t.routineCalls.result, "stopped"),
            inArray(t.routineCalls.stopKind, [...LIBRARY_FAIL_STOP_KINDS])
          )
        )
        .orderBy(desc(t.routineCalls.id))
        .limit(LIBRARY_PAUSE_AFTER_FAILS)
      const lines = recent.map(
        (row) =>
          `${row.stopStep ? `停在第 ${row.stopStep} 步` : "没开始"}（${routineStopKindLabel[row.stopKind ?? "script_error"]}）：${oneLine(row.stopReason ?? "")}（运行 ${row.sessionId}）`
      )
      reason = `自动停用：第 ${entry.publishedVersion} 版连续 ${failStreak} 次跑不通。最近几次：${lines.join("；")}`
    }
    await tx
      .update(t.routineLibrary)
      .set({ failStreak, ...(pause ? { status: "paused" as const, pausedReason: reason ?? null } : {}) })
      .where(eq(t.routineLibrary.routineId, entry.routineId))
    if (!pause) return undefined
    await writeAudit(tx, {
      action: "routine.library.auto_pause",
      targetTable: "routine_library",
      targetId: entry.routineId,
      detail: { version: entry.publishedVersion, failStreak, sessionId: call.sessionId, callId: call.callId },
    })
    return { entry, reason: reason! }
  })
  if (!paused) return { autoPaused: false }

  // 通知来源任务负责人和最近一次发布的主管
  const { entry, reason } = paused
  const [source] = await db
    .select({ ownerId: t.tasks.ownerId, title: t.tasks.title, taskId: t.tasks.id })
    .from(t.routines)
    .innerJoin(t.tasks, eq(t.tasks.id, t.routines.taskId))
    .where(eq(t.routines.id, entry.routineId))
  const userIds = [source?.ownerId, entry.publishedById].filter((id): id is string => Boolean(id))
  if (userIds.length)
    await notifyUsers(db, {
      userIds,
      title: `流程库：「${entry.title}」自动停用了`,
      body: `${reason}。用它的任务之后的运行不再给 agent 这个流程、脚本里也调不了。修还是在来源任务${source ? `「${source.title}」` : ""}上修：新版转正式以后发布新版本、重新启用。`,
      link: libraryLink(entry.routineId),
      ...(source ? { taskId: source.taskId } : {}),
    })
  return { autoPaused: true }
}
