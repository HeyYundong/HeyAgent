// 桌面的接口（docs/dev/desktop.md 第 7 节），挂在 appRouter 的 desktops（配置）和 desktop（运行时）下。
// 远程画面不是 tRPC：GET /api/desktop/view/:desktopId（WebSocket，desktop/view-relay.ts）。
import { TRPCError } from "@trpc/server"
import { eq } from "drizzle-orm"
import {
  desktopCreateSchema,
  desktopHealthSchema,
  desktopSchema,
  desktopUpdateSchema,
  sessionDesktopSchema,
  sessionIdInputSchema,
} from "@heyagent/shared"
import { z } from "zod"

import { canControlSession } from "../browser/access.js"
import { assertCan, type WriteCtx } from "../data/config/common.js"
import * as desktops from "../data/config/desktops.js"
import * as t from "../db/schema.js"
import { forceReleaseDesktop, sessionLease } from "../desktop/leases.js"
import { appendEvent, writeAudit } from "../engine/records.js"
import { protectedProcedure, router, type Context, type SessionUser } from "./init.js"

const idInput = z.object({ id: z.string().min(1) })
const w = (ctx: Context & { user: SessionUser }): WriteCtx => ({ db: ctx.db, actor: ctx.user, keyring: ctx.keyring })

export const desktopsRouter = router({
  /** 全部桌面（密钥只给掩码）和现在的占用情况 */
  list: protectedProcedure.output(z.array(desktopSchema)).query(({ ctx }) => desktops.listDesktops(ctx.db)),
  create: protectedProcedure
    .input(desktopCreateSchema)
    .output(z.object({ id: z.string() }))
    .mutation(({ ctx, input }) => desktops.createDesktop(w(ctx), input)),
  /** 密钥不填 = 不改 */
  update: protectedProcedure.input(desktopUpdateSchema).mutation(({ ctx, input }) => desktops.updateDesktop(w(ctx), input)),
  /** 被运行占着的不能删（CONFLICT） */
  delete: protectedProcedure.input(idInput).mutation(({ ctx, input }) => desktops.deleteDesktop(w(ctx), input)),
  /** 测试连接：两个服务分开报（各自最多 10 秒），不改任何东西 */
  test: protectedProcedure
    .input(idInput)
    .output(desktopHealthSchema)
    .mutation(({ ctx, input }) => desktops.testDesktopConnection(w(ctx), input)),
})

export const desktopRouter = router({
  /** 这个运行有没有占着桌面（running / held），当前用户能不能操作远程画面 */
  sessionDesktop: protectedProcedure
    .input(sessionIdInputSchema)
    .output(sessionDesktopSchema)
    .query(async ({ ctx, input }) => {
      const [session] = await ctx.db.select({ id: t.sessions.id, desktopId: t.sessions.desktopId }).from(t.sessions).where(eq(t.sessions.id, input.sessionId))
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: `找不到 session ${input.sessionId}` })
      const lease = await sessionLease(ctx.db, input.sessionId)
      const desktopId = lease?.desktopId ?? session.desktopId ?? undefined
      const [desktop] = desktopId ? await ctx.db.select({ name: t.desktops.name }).from(t.desktops).where(eq(t.desktops.id, desktopId)) : []
      return {
        open: Boolean(lease),
        ...(desktopId ? { desktopId } : {}),
        ...(desktop ? { desktopName: desktop.name } : {}),
        ...(lease ? { state: lease.state } : {}),
        canControl: await canControlSession(ctx.db, ctx.user, input.sessionId),
      }
    }),

  /** 管理员强制放开：删掉占用、叫醒等它的；正在用它的运行下一次调桌面工具时重新占（占不到就等） */
  release: protectedProcedure.input(z.object({ desktopId: z.string().min(1) })).mutation(async ({ ctx, input }) => {
    assertCan(ctx.user, "config.manage", {}, "只有主管能放开桌面")
    const [desktop] = await ctx.db.select({ name: t.desktops.name }).from(t.desktops).where(eq(t.desktops.id, input.desktopId))
    if (!desktop) throw new TRPCError({ code: "NOT_FOUND", message: `找不到桌面 ${input.desktopId}` })
    const released = await forceReleaseDesktop(ctx.db, input.desktopId)
    await writeAudit(ctx.db, {
      actorId: ctx.user.id,
      action: "desktop.release",
      targetTable: "desktops",
      targetId: input.desktopId,
      detail: released ? { sessionId: released.sessionId, state: released.state } : { wasFree: true },
    })
    if (released)
      await appendEvent(ctx.db, released.sessionId, {
        kind: "wait",
        title: `桌面「${desktop.name}」被主管放开了`,
        detail: `桌面 ${input.desktopId}；下一次调桌面工具时重新占这台桌面（被占着就等它）`,
      }).catch(() => {})
  }),
})
