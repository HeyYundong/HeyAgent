// 固化流程的 tRPC 接口（docs/dev/solidify.md 第 8 节）：任务详情的「固化流程」区块、审核卡、运行详情的「⋯ → 固化成流程」。
// 读：get（任务的固化流程）、version（一版的全部内容）；写：compile、review、setMode、setPaused、restore（都要 task.manage）
import {
  routineCompileInputSchema,
  routineModeSchema,
  routinePauseInputSchema,
  routineRestoreInputSchema,
  routineReviewInputSchema,
  routineSetModeInputSchema,
  routineStatusSchema,
  routineSummarySchema,
  routineVersionSchema,
} from "@heyagent/shared"
import { z } from "zod"

import type { WriteCtx } from "../data/config/common.js"
import { startCompile } from "../routine/compile.js"
import { restoreRoutineVersion, reviewRoutineVersion } from "../routine/review.js"
import { getRoutineVersion, getTaskRoutine, setRoutineMode, setRoutinePaused } from "../routine/service.js"
import { protectedProcedure, router, type Context, type SessionUser } from "./init.js"

const w = (ctx: Context & { user: SessionUser }): WriteCtx => ({ db: ctx.db, actor: ctx.user, keyring: ctx.keyring })

export const routineRouter = router({
  /** 任务的固化流程（没有 = null）：状态、开关、最近 20 次的成绩、所有版本 */
  get: protectedProcedure
    .input(z.object({ taskId: z.string().min(1) }))
    .output(routineSummarySchema.nullable())
    .query(({ ctx, input }) => getTaskRoutine(ctx.db, input.taskId)),
  /** 一版脚本的全部内容：步骤说明、脚本、输入输出、试跑报告、审核结果 */
  version: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .output(routineVersionSchema)
    .query(({ ctx, input }) => getRoutineVersion(ctx.db, input.id)),
  /** 运行详情「⋯ → 固化成流程」：已结束、办成的普通运行 */
  compile: protectedProcedure
    .input(routineCompileInputSchema)
    .output(z.object({ routineId: z.string(), versionId: z.string() }))
    .mutation(({ ctx, input }) => startCompile(w(ctx), input)),
  /** 审核一版：启用（进试用期）/ 不用（写理由） */
  review: protectedProcedure
    .input(routineReviewInputSchema)
    .output(z.object({ versionId: z.string(), status: z.enum(["approved", "rejected"]) }))
    .mutation(({ ctx, input }) => reviewRoutineVersion(w(ctx), input)),
  /** 任务上的开关：不用 / 先跑流程 */
  setMode: protectedProcedure
    .input(routineSetModeInputSchema)
    .output(z.object({ taskId: z.string(), mode: routineModeSchema }))
    .mutation(({ ctx, input }) => setRoutineMode(w(ctx), input)),
  /** 停用 / 重新启用（重新启用回到试用期） */
  setPaused: protectedProcedure
    .input(routinePauseInputSchema)
    .output(z.object({ id: z.string(), status: routineStatusSchema }))
    .mutation(({ ctx, input }) => setRoutinePaused(w(ctx), input)),
  /** 回到以前启用过的某一版（进试用期） */
  restore: protectedProcedure
    .input(routineRestoreInputSchema)
    .output(z.object({ routineId: z.string(), activeVersion: z.number().int() }))
    .mutation(({ ctx, input }) => restoreRoutineVersion(w(ctx), input)),
})
