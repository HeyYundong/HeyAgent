// 固化试跑（docs/dev/solidify.md 5.6、15.3 第 5 条）：开一次 kind = routine_test 的运行，用任务现在的配置和原来那次运行的输入，
// 只跑脚本、走到第一个 ha.commit 就停（运行本身由引擎跑，见 15.2 第 5 条）。试跑的运行结束时引擎再发 routine.compile，
// 这里读它的 sessions.routine 判过没过，和原来那次交的结果一项一项对。
import { and, desc, eq } from "drizzle-orm"
import {
  isRunEnded,
  routineStopKindLabel,
  routineTestSessionId,
  sessionRoutineStateSchema,
  type RoutineStopKind,
  type RoutineTestRound,
  type SessionSnapshot,
} from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import type { Tx } from "../engine/queue.js"
import { startSessionInTx } from "../engine/sessions.js"

/** 试跑停在这里算过：走到了第一个提交前、停在对外发送的非浏览器工具前 */
const PASSING_STOPS: RoutineStopKind[] = ["test_commit", "test_blocked"]
/** 没过时交回固化员：试跑最后几条过程（里面有页面概况） */
const FEEDBACK_EVENTS = 6
const FEEDBACK_OUTPUT = 1500

const clip = (value: string | null | undefined, max: number) => (!value ? "" : value.length > max ? `${value.slice(0, max)}…` : value)

/** 开第 round 轮的试跑（在调用方的事务里：版本改成 testing 和开运行一起提交） */
export async function startTestRun(
  db: Db,
  tx: Tx,
  input: { taskId: string; versionId: string; round: number; scriptInput: Record<string, unknown>; attachments: SessionSnapshot["attachments"] }
) {
  return startSessionInTx(db, tx, {
    taskId: input.taskId,
    // 系统开的：算手动来源（任务停用了也能试跑；试跑的运行不进会话列表，来源不给人看）
    source: "manual",
    actorId: null,
    routineTest: { versionId: input.versionId, round: input.round, input: input.scriptInput, attachments: input.attachments },
  })
}

const display = (value: unknown) => (value === undefined || value === null ? "" : typeof value === "string" ? value : JSON.stringify(value))

/** 要交回的结果一项一项对：字段取两边的并集；数字和文字按显示出来的样子比 */
export function compareReports(expected: Record<string, unknown> | undefined, actual: Record<string, unknown> | undefined): RoutineTestRound["compare"] {
  if (!expected && !actual) return undefined
  const fields = [...new Set([...Object.keys(expected ?? {}), ...Object.keys(actual ?? {})])]
  return fields.map((field) => {
    const want = display(expected?.[field]).trim()
    const got = display(actual?.[field]).trim()
    return { field, expected: want, actual: got, same: want === got }
  })
}

export type TestRunVerdict = { state: "pending" } | { state: "missing" } | { state: "done"; round: RoutineTestRound }

/**
 * 看第 round 轮试跑的结果。还没结束 = pending（等引擎结束时再发 routine.compile）；
 * 结束了：test_commit、test_blocked 或者报了办成都算过；别的（出错、拦下、要审批、脚本自己报没办成……）不过，原因写进报告
 */
export async function evaluateTestRun(
  db: Db,
  input: { versionId: string; round: number; expectedReport?: Record<string, unknown> }
): Promise<TestRunVerdict> {
  const sessionId = routineTestSessionId(input.versionId, input.round)
  const [session] = await db.select().from(t.sessions).where(eq(t.sessions.id, sessionId))
  if (!session) return { state: "missing" }
  if (!isRunEnded(session.status)) return { state: "pending" }

  const parsed = session.routine ? sessionRoutineStateSchema.safeParse(session.routine) : undefined
  const routine = parsed?.success ? parsed.data : undefined
  const stop = routine?.stoppedAt
  const finish = routine?.recorded?.finish
  const passed = Boolean((stop && PASSING_STOPS.includes(stop.kind)) || finish?.outcome === "achieved")

  let error: string | undefined
  if (!passed) {
    if (finish?.outcome === "not_achieved") error = `脚本报了没办成：${finish.summary}${finish.reason ? `（${finish.reason}）` : ""}`
    else if (stop)
      error = `停在第 ${stop.step} 次调用（${routineStopKindLabel[stop.kind]}${stop.tool ? `，${stop.tool}` : ""}${stop.label ? `「${stop.label}」` : ""}）：${stop.reason}`
    else if (!routine) error = `试跑没跑脚本就结束了${session.error ? `：${session.error}` : ""}`
    else error = `试跑结束了，但脚本没有走到提交前、也没有报办成${session.error ? `：${session.error}` : ""}`
  }

  const [shot] = await db
    .select({ id: t.files.id })
    .from(t.files)
    .where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "screenshot")))
    .orderBy(desc(t.files.createdAt))
    .limit(1)
  const data = routine?.recorded?.report
  const compare = compareReports(input.expectedReport, data)
  const round: RoutineTestRound = {
    round: input.round,
    sessionId,
    passed,
    steps: routine?.steps ?? 0,
    ...(stop ? { stoppedAt: stop } : {}),
    ...(data ? { data } : {}),
    ...(compare ? { compare } : {}),
    ...(shot ? { screenshotFileId: shot.id } : {}),
    ...(error ? { error: clip(error, 2000) } : {}),
  }

  return { state: "done", round }
}

/** 没过的那一轮交回固化员的话：错误、脚本记的话、试跑最后几条过程（工具的输出里有页面概况和快照） */
export async function testFeedback(db: Db, round: RoutineTestRound): Promise<string> {
  const [session] = await db.select({ routine: t.sessions.routine }).from(t.sessions).where(eq(t.sessions.id, round.sessionId))
  const events = await db
    .select()
    .from(t.sessionEvents)
    .where(eq(t.sessionEvents.sessionId, round.sessionId))
    .orderBy(desc(t.sessionEvents.seq))
    .limit(FEEDBACK_EVENTS)
  const logs = session?.routine?.logs ?? []
  return [
    `第 ${round.round} 轮试跑（${round.sessionId}）没过：${round.error ?? "原因不明"}`,
    logs.length ? `脚本记的话：${logs.slice(-5).join("；")}` : "",
    "试跑最后几条过程（新的在后）：",
    ...events
      .reverse()
      .map((event) =>
        [
          `- ${event.kind === "tool" ? `调用 ${event.toolId ?? ""}` : event.kind}：${event.title}`,
          event.input ? `  参数：${clip(event.input, 500)}` : "",
          event.output || event.detail ? `  ${event.output ? "输出" : "说明"}：${clip(event.output ?? event.detail, FEEDBACK_OUTPUT)}` : "",
        ]
          .filter(Boolean)
          .join("\n")
      ),
  ]
    .filter(Boolean)
    .join("\n")
}

