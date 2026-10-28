// 固化流程的读和简单的写（docs/dev/solidify.md 第 8 节）：任务详情的「固化流程」区块、一版的全部内容、开关、停用 / 重新启用。
// 固化（routine.compile）在 compile.ts，审核和回到旧版本在 review.ts。
import { and, desc, eq, inArray, isNotNull, isNull } from "drizzle-orm"
import type { RoutineMode, RoutineSummary, RoutineVersion } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { assertCan, audit, badRequest, notFound, type DbOrTx, type WriteCtx } from "../data/config/common.js"

/** 统计看最近几次运行 */
const RECENT_RUNS = 20

const iso = (value: Date | null) => (value ? value.toISOString() : null)

/** 任务的固化流程（没有就是 null）：状态、开关、最近 20 次的成绩、所有版本 */
export async function getTaskRoutine(db: Db, taskId: string): Promise<RoutineSummary | null> {
  const [row] = await db
    .select({ routine: t.routines, mode: t.tasks.routineMode })
    .from(t.routines)
    .innerJoin(t.tasks, eq(t.tasks.id, t.routines.taskId))
    .where(eq(t.routines.taskId, taskId))
  if (!row) return null
  const { routine, mode } = row
  const versions = await db
    .select({
      id: t.routineVersions.id,
      version: t.routineVersions.version,
      status: t.routineVersions.status,
      name: t.routineVersions.name,
      sourceSessionId: t.routineVersions.sourceSessionId,
      auto: t.routineVersions.auto,
      createdAt: t.routineVersions.createdAt,
    })
    .from(t.routineVersions)
    .where(eq(t.routineVersions.routineId, routine.id))
    .orderBy(desc(t.routineVersions.version))
  const active = versions.find((version) => version.version === routine.activeVersion)
  return {
    id: routine.id,
    taskId,
    status: routine.status,
    mode,
    activeVersion: routine.activeVersion,
    name: active?.name ?? versions[0]?.name ?? "",
    directStreak: routine.directStreak,
    fallbackStreak: routine.fallbackStreak,
    pausedReason: routine.pausedReason,
    recent: await recentStats(db, taskId),
    versions: versions.map((version) => ({ ...version, createdAt: version.createdAt.toISOString() })),
  }
}

/** 最近 20 次跑过脚本的普通运行：直接办成 / 交给 agent / 平均用时；agent 的平均用时：同任务最近 20 次没跑脚本、办成的普通运行 */
async function recentStats(db: Db, taskId: string): Promise<RoutineSummary["recent"]> {
  const ran = await db
    .select({ routine: t.sessions.routine, outcome: t.sessions.outcome, startedAt: t.sessions.startedAt, endedAt: t.sessions.endedAt })
    .from(t.sessions)
    .where(and(eq(t.sessions.taskId, taskId), eq(t.sessions.kind, "run"), isNotNull(t.sessions.routine), isNotNull(t.sessions.endedAt)))
    .orderBy(desc(t.sessions.startedAt))
    .limit(RECENT_RUNS)
  const agent = await db
    .select({ startedAt: t.sessions.startedAt, endedAt: t.sessions.endedAt })
    .from(t.sessions)
    .where(
      and(
        eq(t.sessions.taskId, taskId),
        eq(t.sessions.kind, "run"),
        isNull(t.sessions.routine),
        eq(t.sessions.outcome, "achieved"),
        isNotNull(t.sessions.endedAt)
      )
    )
    .orderBy(desc(t.sessions.startedAt))
    .limit(RECENT_RUNS)
  const avg = (rows: { startedAt: Date; endedAt: Date | null }[]) =>
    rows.length ? Math.round(rows.reduce((sum, row) => sum + (row.endedAt!.getTime() - row.startedAt.getTime()), 0) / rows.length) : null
  const direct = ran.filter((row) => row.routine?.state === "finished" && row.outcome === "achieved")
  return {
    runs: ran.length,
    direct: direct.length,
    fellBack: ran.filter((row) => row.routine?.state === "fell_back").length,
    avgMs: avg(direct),
    agentAvgMs: avg(agent),
  }
}

/** 一版脚本的全部内容（审核卡、看脚本、版本记录） */
export async function getRoutineVersion(db: Db, versionId: string): Promise<RoutineVersion> {
  const [row] = await db
    .select({ version: t.routineVersions, taskId: t.routines.taskId })
    .from(t.routineVersions)
    .innerJoin(t.routines, eq(t.routines.id, t.routineVersions.routineId))
    .where(eq(t.routineVersions.id, versionId))
  if (!row) throw notFound("固化流程的版本", versionId)
  const { version } = row
  const userIds = [version.createdById, version.approvedById].filter((id): id is string => Boolean(id))
  const people = userIds.length ? await db.select({ id: t.users.id, name: t.users.name }).from(t.users).where(inArray(t.users.id, userIds)) : []
  const person = (id: string | null) => (id ? (people.find((each) => each.id === id) ?? { id, name: id }) : null)
  const [item] = await db
    .select({ id: t.humanItems.id })
    .from(t.humanItems)
    .where(and(eq(t.humanItems.routineVersionId, version.id), eq(t.humanItems.status, "open")))
    .limit(1)
  return {
    id: version.id,
    routineId: version.routineId,
    taskId: row.taskId,
    version: version.version,
    status: version.status,
    name: version.name,
    description: version.description,
    code: version.code,
    inputSchema: version.inputSchema,
    outputSchema: version.outputSchema,
    commits: version.commits,
    assumptions: version.assumptions,
    failReason: version.failReason,
    sourceSessionId: version.sourceSessionId,
    baseVersion: version.baseVersion,
    round: version.round,
    skipTest: version.skipTest,
    auto: version.auto,
    testReport: version.testReport ?? null,
    modelId: version.modelId,
    costUsd: version.costUsd,
    rejectReason: version.rejectReason,
    createdBy: person(version.createdById),
    approvedBy: person(version.approvedById),
    approvedAt: iso(version.approvedAt),
    createdAt: version.createdAt.toISOString(),
    humanItemId: item?.id ?? null,
  }
}

/** 固化流程所属的任务（改之前查权限用） */
export async function loadRoutineTask(db: DbOrTx, routineId: string) {
  const [row] = await db
    .select({ routine: t.routines, ownerId: t.tasks.ownerId, title: t.tasks.title })
    .from(t.routines)
    .innerJoin(t.tasks, eq(t.tasks.id, t.routines.taskId))
    .where(eq(t.routines.id, routineId))
  if (!row) throw notFound("固化流程", routineId)
  return row
}

/** 任务上的开关「固化流程」：负责人和主管。打开要有启用的版本 */
export async function setRoutineMode(ctx: WriteCtx, input: { taskId: string; mode: RoutineMode }) {
  return ctx.db.transaction(async (tx) => {
    const [task] = await tx.select({ id: t.tasks.id, ownerId: t.tasks.ownerId, mode: t.tasks.routineMode }).from(t.tasks).where(eq(t.tasks.id, input.taskId))
    if (!task) throw notFound("任务", input.taskId)
    assertCan(ctx.actor, "task.manage", { ownerId: task.ownerId }, "只有任务负责人和主管能改固化流程的开关")
    if (input.mode === "first") {
      const [routine] = await tx.select({ activeVersion: t.routines.activeVersion }).from(t.routines).where(eq(t.routines.taskId, input.taskId))
      if (routine?.activeVersion == null) throw badRequest("这个任务还没有启用的固化流程：先在一次办成的运行上「固化成流程」，审核启用后才能打开")
    }
    if (task.mode === input.mode) return { taskId: task.id, mode: input.mode }
    await tx.update(t.tasks).set({ routineMode: input.mode }).where(eq(t.tasks.id, task.id))
    await audit(tx, ctx.actor.id, "routine.set_mode", "tasks", task.id, { before: task.mode, after: input.mode })
    return { taskId: task.id, mode: input.mode }
  })
}

/** 停用 / 重新启用：负责人和主管。重新启用回到试用期（两个计数清零） */
export async function setRoutinePaused(ctx: WriteCtx, input: { routineId: string; paused: boolean }) {
  return ctx.db.transaction(async (tx) => {
    const { routine, ownerId } = await loadRoutineTask(tx, input.routineId)
    assertCan(ctx.actor, "task.manage", { ownerId }, "只有任务负责人和主管能停用、启用固化流程")
    if (input.paused) {
      if (routine.status === "paused") return { id: routine.id, status: routine.status }
      const [actor] = await tx.select({ name: t.users.name }).from(t.users).where(eq(t.users.id, ctx.actor.id))
      await tx
        .update(t.routines)
        .set({ status: "paused", pausedReason: `${actor?.name ?? "负责人"}停用了` })
        .where(eq(t.routines.id, routine.id))
      await audit(tx, ctx.actor.id, "routine.pause", "routines", routine.id)
      return { id: routine.id, status: "paused" as const }
    }
    if (routine.activeVersion == null) throw badRequest("还没有启用过的版本，不能启用")
    if (routine.status !== "paused") return { id: routine.id, status: routine.status }
    await tx
      .update(t.routines)
      .set({ status: "trial", pausedReason: null, directStreak: 0, fallbackStreak: 0 })
      .where(eq(t.routines.id, routine.id))
    await audit(tx, ctx.actor.id, "routine.resume", "routines", routine.id)
    return { id: routine.id, status: "trial" as const }
  })
}
