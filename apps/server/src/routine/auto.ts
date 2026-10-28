// 办成后自动固化、跑不通后自动修（docs/dev/solidify.md 17.1）。运行结果定了以后（afterRunSettled）调一次。
// 前提：普通运行、已结束、办成、任务的「办成后自动固化」开着（tasks.auto_solidify，空 = autoSolidifyDefault：被派的、定时的开）。
// - 没有固化流程、或者流程还没有启用过的版本 → 固化第一版（baseVersion 空）；
// - 有启用的版本：这次脚本直接办成 → 不用；这次交给 agent、agent 办成（fell_back）→ 修那一版；
//   流程停用着、这次只有 agent（运行开始时没冻流程）→ 修启用的那一版；别的（「先跑流程」关着、脚本报了办成后 agent 接着做完）不固化。
// 跳过：有一版在写 / 试跑 / 待审核；24 小时内自动固化过；最近一版是「不用」或「没成功」，还不到 7 天（免得反复写、反复打扰负责人）。
// 这些条件在锁住固化流程那一行以后判断（compile.ts 的 compileFromSession），同一个任务几次运行同时结束也只建一版。
// 人点「固化成流程」不走这里，不受这些限制。
import { autoSolidifyDefault, isRunEnded } from "@heyagent/shared"
import { and, desc, eq, gt, sql } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { compileFromSession, type CompileDecide, type CompileFromSessionResult } from "./compile.js"

/** 自动固化最少隔多久（小时） */
export const AUTO_SOLIDIFY_COOLDOWN_HOURS = 24
/** 最近一版「不用」或「没成功」以后，多少天内不再自动固化 */
export const AUTO_SOLIDIFY_AFTER_REJECT_DAYS = 7

export type AutoSolidifyResult = CompileFromSessionResult

const skip = (reason: string): AutoSolidifyResult => ({ started: false, reason })

/** 锁住固化流程以后的判断：固化第一版、修哪一版，还是跳过 */
const decide: CompileDecide = async (tx, { routine, created, session }) => {
  if (!created) {
    const [recentAuto] = await tx
      .select({ version: t.routineVersions.version })
      .from(t.routineVersions)
      .where(
        and(
          eq(t.routineVersions.routineId, routine.id),
          eq(t.routineVersions.auto, true),
          gt(t.routineVersions.createdAt, sql`now() - make_interval(hours => ${AUTO_SOLIDIFY_COOLDOWN_HOURS})`)
        )
      )
      .orderBy(desc(t.routineVersions.version))
      .limit(1)
    if (recentAuto) return { skip: `${AUTO_SOLIDIFY_COOLDOWN_HOURS} 小时内已经自动固化过（第 ${recentAuto.version} 版）` }
    // 最近一版：「不用」、「没成功」以后状态不再变，updated_at 就是那个时候
    const [latest] = await tx
      .select({
        version: t.routineVersions.version,
        status: t.routineVersions.status,
        recent: sql<boolean>`${t.routineVersions.updatedAt} > now() - make_interval(days => ${AUTO_SOLIDIFY_AFTER_REJECT_DAYS})`,
      })
      .from(t.routineVersions)
      .where(eq(t.routineVersions.routineId, routine.id))
      .orderBy(desc(t.routineVersions.version))
      .limit(1)
    if (latest && (latest.status === "rejected" || latest.status === "failed") && latest.recent)
      return {
        skip: `最近一版（第 ${latest.version} 版）${latest.status === "rejected" ? "审核时选了不用" : "没成功"}，${AUTO_SOLIDIFY_AFTER_REJECT_DAYS} 天内不再自动固化`,
      }
  }
  if (routine.activeVersion === null) return { baseVersion: null }
  const ran = session.routine
  if (ran && ran.mode === "run" && ran.routineId === routine.id) {
    if (ran.state === "fell_back") return { baseVersion: ran.version }
    return { skip: ran.state === "finished" ? "脚本报了办成（验收反问后 agent 接着做完），不算跑不通" : "这次跑脚本没有交给 agent 办成" }
  }
  if (routine.status === "paused") return { baseVersion: routine.activeVersion }
  return { skip: "有启用的固化流程，这次运行没跑脚本（「先跑流程」关着，或者运行开始时还没启用）" }
}

/**
 * 运行结果定了以后调：按 17.1 决定要不要自动固化、固化第一版还是修。
 * 建了就是 auto = true、created_by_id 为空的一版，并发了 routine.compile；不试跑按任务的「固化时不试跑」。
 * 返回做了什么（不固化的写原因，测试和日志用）
 */
export async function maybeAutoSolidify(db: Db, sessionId: string): Promise<AutoSolidifyResult> {
  // 只取要看的几列（不取快照正文）：每次运行结束都会走这里，大多数什么都不做
  const [row] = await db
    .select({
      session: {
        kind: t.sessions.kind,
        status: t.sessions.status,
        outcome: t.sessions.outcome,
        routine: t.sessions.routine,
        hasSnapshot: sql<boolean>`${t.sessions.snapshot} is not null`,
      },
      autoSolidify: t.tasks.autoSolidify,
      dispatch: t.tasks.dispatch,
      scheduleCron: t.tasks.scheduleCron,
    })
    .from(t.sessions)
    .innerJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))
    .where(eq(t.sessions.id, sessionId))
  if (!row) return skip("运行不存在")
  const { session } = row
  if (session.kind !== "run") return skip("不是普通运行")
  if (!isRunEnded(session.status) || session.outcome !== "achieved") return skip("运行没办成")
  if (!session.hasSnapshot) return skip("运行没有快照")
  // 按任务现在的设置（不是运行开始时的快照）：负责人刚关掉的，马上就不再固化
  const enabled = row.autoSolidify ?? autoSolidifyDefault({ dispatch: row.dispatch, schedule: row.scheduleCron })
  if (!enabled) return skip("任务没开「办成后自动固化」")
  const ran = session.routine
  if (ran && ran.mode === "run" && ran.state === "finished" && !ran.agentAfter) return skip("脚本直接办成，不用再固化")
  return compileFromSession(db, { sessionId, createdById: null, auto: true, decide })
}
