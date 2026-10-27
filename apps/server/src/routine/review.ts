// 固化流程的审核和回到旧版本（docs/dev/solidify.md 5.7、第 7 节）。
// 骨架：内容由固化的开发包（docs/dev/solidify.md 第 15 节 B 包）写。
import { badRequest, type WriteCtx } from "../data/config/common.js"

/**
 * 审核一版（待审核的才行；负责人和主管）：启用 = 这一版 approved、routines.active_version 指向它、状态回到试用期、两个计数清零，
 * 任务第一次启用时把开关打开（先跑流程）；不用 = rejected，记理由。同时把那件「审核固化流程」处理掉
 */
export async function reviewRoutineVersion(
  _ctx: WriteCtx,
  _input: { versionId: string; approve: boolean; reason?: string }
): Promise<{ versionId: string; status: "approved" | "rejected" }> {
  throw badRequest("固化还没做完")
}

/** 回到以前启用过的某一版（进试用期）：负责人和主管 */
export async function restoreRoutineVersion(
  _ctx: WriteCtx,
  _input: { routineId: string; version: number }
): Promise<{ routineId: string; activeVersion: number }> {
  throw badRequest("固化还没做完")
}
