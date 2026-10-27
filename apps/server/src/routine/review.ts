// 固化流程的审核和回到旧版本（docs/dev/solidify.md 5.7、第 7 节、15.3 第 6 条）。
// 每一版都要人点启用：启用 = 这一版 approved、routines.active_version 指向它、回到试用期；不用 = rejected，理由下次固化时给固化员看。
// 两种都把那件「审核固化流程」处理掉（通用的 resolveHumanItem 不处理这种事，见 engine/humans.ts）。
import { and, eq } from "drizzle-orm"

import * as t from "../db/schema.js"
import { assertCan, audit, conflict, notFound, type DbOrTx, type WriteCtx } from "../data/config/common.js"
import { loadRoutineTask } from "./service.js"

/** 启用一版：指向它、回到试用期（停用着的也重新启用）、两个计数清零 */
async function activate(tx: DbOrTx, routineId: string, version: number) {
  await tx
    .update(t.routines)
    .set({ activeVersion: version, status: "trial", directStreak: 0, fallbackStreak: 0, pausedReason: null })
    .where(eq(t.routines.id, routineId))
}

/**
 * 审核一版（待审核的才行；负责人和主管）：启用 = 这一版 approved、routines.active_version 指向它、状态回到试用期、两个计数清零，
 * 任务的开关是 off 的打开成 first；不用 = rejected，记理由。同时把那件「审核固化流程」处理掉
 */
export async function reviewRoutineVersion(
  ctx: WriteCtx,
  input: { versionId: string; approve: boolean; reason?: string }
): Promise<{ versionId: string; status: "approved" | "rejected" }> {
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx
      .select({ version: t.routineVersions, taskId: t.routines.taskId, ownerId: t.tasks.ownerId, mode: t.tasks.routineMode })
      .from(t.routineVersions)
      .innerJoin(t.routines, eq(t.routines.id, t.routineVersions.routineId))
      .innerJoin(t.tasks, eq(t.tasks.id, t.routines.taskId))
      .where(eq(t.routineVersions.id, input.versionId))
      .for("update", { of: t.routineVersions })
    if (!row) throw notFound("固化流程的版本", input.versionId)
    const { version } = row
    assertCan(ctx.actor, "task.manage", { ownerId: row.ownerId }, "只有任务负责人和主管能审核固化流程")
    if (version.status !== "review") throw conflict(`这一版现在不是待审核（${version.status}），不能审核`)
    const reason = input.reason?.trim() || undefined
    const now = new Date()
    const status = input.approve ? ("approved" as const) : ("rejected" as const)
    await tx
      .update(t.routineVersions)
      .set(input.approve ? { status, approvedById: ctx.actor.id, approvedAt: now } : { status, rejectReason: reason ?? null })
      .where(eq(t.routineVersions.id, version.id))
    if (input.approve) {
      await activate(tx, version.routineId, version.version)
      if (row.mode === "off") {
        await tx.update(t.tasks).set({ routineMode: "first" }).where(eq(t.tasks.id, row.taskId))
        await audit(tx, ctx.actor.id, "routine.set_mode", "tasks", row.taskId, { before: "off", after: "first", via: "review" })
      }
    }
    const items = await tx
      .update(t.humanItems)
      .set({
        status: "resolved",
        resolution: { how: input.approve ? "primary" : "reject", ...(reason ? { reason } : {}) },
        resolvedById: ctx.actor.id,
        resolvedAt: now,
      })
      .where(and(eq(t.humanItems.routineVersionId, version.id), eq(t.humanItems.status, "open")))
      .returning({ id: t.humanItems.id })
    await audit(tx, ctx.actor.id, input.approve ? "routine.approve" : "routine.reject", "routine_versions", version.id, {
      humanItemIds: items.map((item) => item.id),
      ...(reason ? { reason } : {}),
    })
    return { versionId: version.id, status }
  })
}

/**
 * 回到以前启用过的某一版（进试用期）：负责人和主管。停用着的流程也一起重新启用（回到哪一版就是要用哪一版）；
 * 任务的开关不动（开关是人另外拨的）
 */
export async function restoreRoutineVersion(
  ctx: WriteCtx,
  input: { routineId: string; version: number }
): Promise<{ routineId: string; activeVersion: number }> {
  return ctx.db.transaction(async (tx) => {
    const { routine, ownerId } = await loadRoutineTask(tx, input.routineId)
    assertCan(ctx.actor, "task.manage", { ownerId }, "只有任务负责人和主管能回到以前的版本")
    const [version] = await tx
      .select({ id: t.routineVersions.id, status: t.routineVersions.status })
      .from(t.routineVersions)
      .where(and(eq(t.routineVersions.routineId, routine.id), eq(t.routineVersions.version, input.version)))
    if (!version) throw notFound("固化流程的版本", `${routine.id} 第 ${input.version} 版`)
    if (version.status !== "approved") throw conflict(`第 ${input.version} 版没有启用过，只能回到启用过的版本`)
    await activate(tx, routine.id, input.version)
    await audit(tx, ctx.actor.id, "routine.restore", "routines", routine.id, {
      before: routine.activeVersion,
      after: input.version,
      ...(routine.status === "paused" ? { resumed: true } : {}),
    })
    return { routineId: routine.id, activeVersion: input.version }
  })
}
