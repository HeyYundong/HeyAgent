// 派活的 tRPC 接口（派活页、任务抽屉、运行详情用）。agent 用内置工具「派活」（work.dispatch），不走这里。
// 读：list / get / taskStats（work/service.ts）；写：lookup / dispatch / updateParams / redo / cancel（engine/dispatch/manage.ts）。
import {
  workCancelInputSchema,
  workDispatchInputSchema,
  workDispatchResultSchema,
  workItemDetailSchema,
  workItemSchema,
  workListInputSchema,
  workLookupInputSchema,
  workPageSchema,
  workRedoInputSchema,
  workTaskStatsSchema,
  workUpdateParamsInputSchema,
} from "@heyagent/shared"
import { TRPCError } from "@trpc/server"
import { z } from "zod"

import { cancelWorkItem, dispatchByHuman, lookupWorkItem, redoWorkItem, updateWorkParams } from "../engine/dispatch/manage.js"
import { EngineError } from "../engine/sessions.js"
import { getWorkItem, listWorkItems, WorkError, workTaskStats } from "../work/service.js"
import { protectedProcedure, router } from "./init.js"

/** 派活的错误换成 tRPC 的错误码（message 原样给页面看） */
async function translate<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof WorkError) throw new TRPCError({ code: error.code, message: error.message })
    // 不办了时取消运行的报错（例如运行刚好结束了）
    if (error instanceof EngineError) throw new TRPCError({ code: error.code, message: error.message })
    throw error
  }
}

export const workRouter = router({
  /** 派活页左边：新派的在前，默认最近 7 天，能搜、按状态 / 被派的任务 / 来源筛，翻页 */
  list: protectedProcedure
    .input(workListInputSchema)
    .output(workPageSchema)
    .query(({ ctx, input }) => listWorkItems(ctx.db, input)),
  get: protectedProcedure
    .input(z.object({ id: z.string().min(1) }))
    .output(workItemDetailSchema)
    .query(({ ctx, input }) => translate(() => getWorkItem(ctx.db, input.id))),
  /** 被派任务的一行数字：排队、在办、占名额 / 名额、今天办完、没办成 */
  taskStats: protectedProcedure
    .input(z.object({ taskId: z.string().min(1) }))
    .output(workTaskStatsSchema)
    .query(({ ctx, input }) => translate(() => workTaskStats(ctx.db, input.taskId))),
  /** 「派一张」弹窗填参数时：同一件事已经有单了吗（没有返回 null） */
  lookup: protectedProcedure
    .input(workLookupInputSchema)
    .output(workItemSchema.nullable())
    .query(({ ctx, input }) => translate(() => lookupWorkItem(ctx.db, input))),
  /** 人派一张：要有被派任务的 task.manage；同一件事已经有单时返回那张（existing = true），不重开 */
  dispatch: protectedProcedure
    .input(workDispatchInputSchema)
    .output(workDispatchResultSchema)
    .mutation(({ ctx, input }) => translate(() => dispatchByHuman(ctx.db, ctx.user, input))),
  /** 改参数：只有排队的单；去重的参数不能改。work.manage */
  updateParams: protectedProcedure
    .input(workUpdateParamsInputSchema)
    .output(workItemSchema)
    .mutation(({ ctx, input }) => translate(() => updateWorkParams(ctx.db, ctx.user, input))),
  /** 重办：办完 / 没办成 / 不办了的单再排一次队（attempts 在开运行时 +1）。work.manage */
  redo: protectedProcedure
    .input(workRedoInputSchema)
    .output(workItemSchema)
    .mutation(({ ctx, input }) => translate(() => redoWorkItem(ctx.db, ctx.user, input))),
  /** 不办了：排队的直接结束；在办的取消正在跑的运行。work.manage */
  cancel: protectedProcedure
    .input(workCancelInputSchema)
    .output(workItemSchema)
    .mutation(({ ctx, input }) => translate(() => cancelWorkItem(ctx.db, ctx.user, input))),
})
