// 流程库的 tRPC 接口（docs/dev/routine-library.md 10.3）：流程页（列表、详情、发布弹窗、版本记录、调用记录）。
// 读：list、get、calls（登录即可）；主管：candidates、preview、publish、update、setPaused、withdraw（service.ts 里查 config.manage）。
// 现在 service.ts 是空壳，一律回 NOT_IMPLEMENTED「流程库还没做好」；B 包实现。
import {
  routineCallsPageSchema,
  routineLibraryCallsInputSchema,
  routineLibraryCandidateSchema,
  routineLibraryDetailSchema,
  routineLibraryGetInputSchema,
  routineLibraryItemSchema,
  routineLibraryPauseInputSchema,
  routineLibraryPreviewInputSchema,
  routineLibraryPreviewSchema,
  routineLibraryPublishInputSchema,
  routineLibraryStatusSchema,
  routineLibraryUpdateInputSchema,
  routineLibraryWithdrawInputSchema,
} from "@heyagent/shared"
import { z } from "zod"

import type { WriteCtx } from "../data/config/common.js"
import {
  getLibraryEntry,
  libraryCandidates,
  listLibrary,
  listLibraryCalls,
  previewPublish,
  publishRoutine,
  setLibraryPaused,
  updateLibraryEntry,
  withdrawLibraryEntry,
} from "../routine/library/service.js"
import { protectedProcedure, router, type Context, type SessionUser } from "./init.js"

const w = (ctx: Context & { user: SessionUser }): WriteCtx => ({ db: ctx.db, actor: ctx.user, keyring: ctx.keyring })

export const routineLibraryRouter = router({
  /** 列表：在库里的、停用的、撤下的 */
  list: protectedProcedure.output(z.array(routineLibraryItemSchema)).query(({ ctx }) => listLibrary(ctx.db)),
  /** 详情：登记、发布的那一版（不带脚本）、发布记录、谁在用、最近 50 次成绩、最近 5 次停下的 */
  get: protectedProcedure
    .input(routineLibraryGetInputSchema)
    .output(routineLibraryDetailSchema)
    .query(({ ctx, input }) => getLibraryEntry(ctx.db, input.routineId)),
  /** 能发布的（主管）：有转过正式版本的固化流程 */
  candidates: protectedProcedure.output(z.array(routineLibraryCandidateSchema)).query(({ ctx }) => libraryCandidates(ctx.db, ctx.user)),
  /** 发布前看一眼（主管）：要的工具、风险、程序检查、不兼容改动、受影响的 */
  preview: protectedProcedure
    .input(routineLibraryPreviewInputSchema)
    .output(routineLibraryPreviewSchema)
    .query(({ ctx, input }) => previewPublish(ctx.db, ctx.user, input)),
  /** 发布（第一次、新版本、回到以前的版本） */
  publish: protectedProcedure
    .input(routineLibraryPublishInputSchema)
    .output(z.object({ routineId: z.string(), version: z.number().int() }))
    .mutation(({ ctx, input }) => publishRoutine(w(ctx), input)),
  /** 改名字和「什么时候用」 */
  update: protectedProcedure
    .input(routineLibraryUpdateInputSchema)
    .output(z.object({ routineId: z.string() }))
    .mutation(({ ctx, input }) => updateLibraryEntry(w(ctx), input)),
  /** 停用 / 重新启用 */
  setPaused: protectedProcedure
    .input(routineLibraryPauseInputSchema)
    .output(z.object({ routineId: z.string(), status: routineLibraryStatusSchema }))
    .mutation(({ ctx, input }) => setLibraryPaused(w(ctx), input)),
  /** 撤下：有任务选用、别的库流程调它时 CONFLICT */
  withdraw: protectedProcedure
    .input(routineLibraryWithdrawInputSchema)
    .output(z.object({ routineId: z.string(), status: z.literal("withdrawn") }))
    .mutation(({ ctx, input }) => withdrawLibraryEntry(w(ctx), input)),
  /** 调用记录分页（新的在前） */
  calls: protectedProcedure
    .input(routineLibraryCallsInputSchema)
    .output(routineCallsPageSchema)
    .query(({ ctx, input }) => listLibraryCalls(ctx.db, input)),
})
