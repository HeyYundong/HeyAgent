// 比物的 tRPC 接口（页面用）。图片先走 POST /api/files 上传拿到文件 id（或者用图库 id、网址），再调 compare.create。
// 外部系统用 HTTP 接口 /api/compare/*（compare/routes.ts）和 MCP /api/compare/mcp；agent 用内置工具组「比物」。
import { compareCreateSchema, compareListInputSchema, compareModelSchema, comparePageSchema, compareStandardInputSchema, compareStandardSchema, compareStandardUpdateSchema, comparisonSchema } from "@heyagent/shared"
import { z } from "zod"

import { CompareError } from "../compare/errors.js"
import {
  compareAgain,
  createComparison,
  createStandard,
  deleteComparison,
  deleteStandard,
  getComparison,
  listComparisons,
  listStandards,
  listVisionModels,
  setDefaultStandard,
  updateStandard,
  type CompareActor,
} from "../compare/service.js"
import { protectedProcedure, router, type Context, type SessionUser } from "./init.js"

const idInput = z.object({ id: z.string().min(1) })

type AuthedContext = Context & { user: SessionUser }

const actorOf = (ctx: AuthedContext): CompareActor => ({ user: ctx.user, via: "web" })

/** 比物的错误换成 tRPC 的错误码（message 原样给页面看） */
async function translate<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof CompareError) throw error.toTRPC()
    throw error
  }
}

export const compareRouter = router({
  /** 左边的比对记录，新的在前，能搜，翻页 */
  list: protectedProcedure
    .input(compareListInputSchema)
    .output(comparePageSchema)
    .query(({ ctx, input }) => listComparisons(ctx.db, input)),
  get: protectedProcedure
    .input(idInput)
    .output(comparisonSchema)
    .query(({ ctx, input }) => translate(() => getComparison(ctx.db, input.id))),
  /** 新比对：马上返回「比对中」的记录，比完实时推送刷新；重复调用（同图同要求同模型）直接返回上次的结果（reused = true） */
  create: protectedProcedure
    .input(compareCreateSchema)
    .output(comparisonSchema)
    .mutation(({ ctx, input }) => translate(() => createComparison(ctx.db, actorOf(ctx), input))),
  /** 同样的两张图和要求再比一次（不复用上次的结果） */
  again: protectedProcedure
    .input(idInput)
    .output(comparisonSchema)
    .mutation(({ ctx, input }) => translate(() => compareAgain(ctx.db, actorOf(ctx), input.id))),
  /** 删除记录：发起的人和主管 */
  delete: protectedProcedure.input(idInput).mutation(({ ctx, input }) => translate(() => deleteComparison(ctx.db, actorOf(ctx), input.id))),
  /** 能比物的视觉模型（便宜的在前） */
  models: protectedProcedure.output(z.array(compareModelSchema)).query(({ ctx }) => listVisionModels(ctx.db)),
  /** 比对标准（默认的排第一） */
  standards: protectedProcedure.output(z.array(compareStandardSchema)).query(({ ctx }) => listStandards(ctx.db)),
  /** 新建、修改、删除标准，设为默认：只有主管 */
  createStandard: protectedProcedure
    .input(compareStandardInputSchema)
    .output(compareStandardSchema)
    .mutation(({ ctx, input }) => translate(() => createStandard(ctx.db, actorOf(ctx), input))),
  updateStandard: protectedProcedure
    .input(compareStandardUpdateSchema)
    .output(compareStandardSchema)
    .mutation(({ ctx, input }) => translate(() => updateStandard(ctx.db, actorOf(ctx), input))),
  deleteStandard: protectedProcedure.input(idInput).mutation(({ ctx, input }) => translate(() => deleteStandard(ctx.db, actorOf(ctx), input.id))),
  setDefaultStandard: protectedProcedure.input(idInput).mutation(({ ctx, input }) => translate(() => setDefaultStandard(ctx.db, actorOf(ctx), input.id))),
})
