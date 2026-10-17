// 浏览器相关的接口（M2，见 docs/dev/m2.md 第 9 条）：打开 Chrome、关闭（关就是保存登录状态）、开着的 Chrome、session 的 Chrome、账号使用情况。
// 已经挂在 appRouter 的 browser 下。Chrome 跑在 worker 里：打开 / 关闭经 worker 的内部控制接口（browser/access.ts），
// 列表类直接读 browser_instances、account_leases（worker 起关 Chrome、申请释放租约时写）。
// 远程画面不是 tRPC：GET /api/browser/view/:browserId（WebSocket，browser/view-relay.ts）。
import { TRPCError } from "@trpc/server"
import { and, asc, count, desc, eq, inArray, isNull, gt, sql } from "drizzle-orm"
import {
  accountUsageSchema,
  autoLoginResultSchema,
  browserHistoryRowSchema,
  browserIdInputSchema,
  can,
  groupBrowserActions,
  leaseEventName,
  liveBrowserSchema,
  openForLoginInputSchema,
  saveLoginResultSchema,
  sessionBrowserSchema,
  sessionIdInputSchema,
  type LiveBrowser,
} from "@heyagent/shared"
import { z } from "zod"

import { callWorker, canControlBrowser, canControlSession, instanceRow, pickWorker, WorkerCallError, workerUrl } from "../browser/access.js"
import * as t from "../db/schema.js"
import { writeAudit } from "../engine/records.js"
import { protectedProcedure, router } from "./init.js"

const forbidden = (message: string) => new TRPCError({ code: "FORBIDDEN", message })

function fromWorker(error: unknown): never {
  if (error instanceof WorkerCallError) {
    const code = error.status === 404 ? "NOT_FOUND" : error.status === 409 ? "CONFLICT" : error.status === 400 ? "BAD_REQUEST" : error.status === 403 ? "FORBIDDEN" : "INTERNAL_SERVER_ERROR"
    // 503（没有 Chrome、代理起不来）也给前端看得懂的原因
    throw new TRPCError({ code: error.status === 503 ? "PRECONDITION_FAILED" : code, message: error.message })
  }
  throw error
}

const iso = (value: Date) => value.toISOString()

export const browserRouter = router({
  /** 浏览器页「打开 Chrome」：起一个不挂 session 的 Chrome，装上这个配置的登录态，打开账号的探测网址或平台首页 */
  openForLogin: protectedProcedure
    .input(openForLoginInputSchema)
    .output(z.object({ browserId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      if (!can(ctx.user, "browser.login", {})) throw forbidden("你不能打开 Chrome")
      const [profile] = await ctx.db.select({ id: t.browserProfiles.id }).from(t.browserProfiles).where(eq(t.browserProfiles.id, input.profileId))
      if (!profile) throw new TRPCError({ code: "NOT_FOUND", message: `找不到 Chrome 配置 ${input.profileId}` })
      if (input.accountId) {
        const [account] = await ctx.db.select({ profileId: t.browserAccounts.profileId }).from(t.browserAccounts).where(eq(t.browserAccounts.id, input.accountId))
        if (!account || account.profileId !== input.profileId) throw new TRPCError({ code: "BAD_REQUEST", message: `账号 ${input.accountId} 不在这个 Chrome 配置里` })
      }
      const worker = await pickWorker(ctx.db)
      if (!worker) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "没有带 Chrome 的 worker 在线，开不了浏览器" })
      const result = await callWorker<{ browserId: string }>(ctx.keyring(), worker.controlUrl, "/browsers/login", { ...input, userId: ctx.user.id }).catch(fromWorker)
      await writeAudit(ctx.db, { actorId: ctx.user.id, action: "browser.open_for_login", targetTable: "browser_profiles", targetId: input.profileId, detail: { browserId: result.browserId, accountId: input.accountId } })
      return { browserId: result.browserId }
    }),

  /**
   * 「立刻登录」：worker 开一个 Chrome，登录小 agent 用账号存的密码登录（模型只看到占位符）。
   * 成功就写回保险箱；没成功时 Chrome 留着，返回 browserId，前端打开远程画面让人接着登录。
   */
  autoLogin: protectedProcedure
    .input(z.object({ accountId: z.string().min(1) }))
    .output(autoLoginResultSchema)
    .mutation(async ({ ctx, input }) => {
      if (!can(ctx.user, "browser.login", {})) throw forbidden("你不能登录 Chrome 里的账号")
      const [account] = await ctx.db.select({ profileId: t.browserAccounts.profileId }).from(t.browserAccounts).where(eq(t.browserAccounts.id, input.accountId))
      if (!account) throw new TRPCError({ code: "NOT_FOUND", message: `找不到账号 ${input.accountId}` })
      const worker = await pickWorker(ctx.db)
      if (!worker) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "没有带 Chrome 的 worker 在线，开不了浏览器" })
      // 登录小 agent 最多十几步，每步一次模型调用：等久一点
      const result = await callWorker<z.infer<typeof autoLoginResultSchema>>(ctx.keyring(), worker.controlUrl, "/browsers/autologin", { profileId: account.profileId, accountId: input.accountId, userId: ctx.user.id }, 300_000).catch(fromWorker)
      await writeAudit(ctx.db, {
        actorId: ctx.user.id,
        action: "browser.auto_login",
        targetTable: "browser_accounts",
        targetId: input.accountId,
        detail: { ok: result.ok, needHuman: result.needHuman, detail: result.detail.slice(0, 300), steps: result.steps, costUsd: result.costUsd, ...(result.vaultVersion ? { vaultVersion: result.vaultVersion } : {}) },
      })
      return result
    }),

  /** 关掉「打开 Chrome」的 Chrome：关就是保存——登录态合并进保险箱（谁最后写谁的算），再探测账号。已经关了返回 saved 为空 */
  close: protectedProcedure
    .input(browserIdInputSchema)
    .output(z.object({ saved: saveLoginResultSchema.optional() }))
    .mutation(async ({ ctx, input }) => {
      const row = await instanceRow(ctx.db, input.browserId)
      if (!row) return {}
      if (row.kind !== "login") throw new TRPCError({ code: "BAD_REQUEST", message: "运行中的 Chrome 由运行自己关，要停就取消这次运行" })
      if (!(await canControlBrowser(ctx.db, ctx.user, row))) throw forbidden("只有打开这个 Chrome 的人和主管能关")
      const url = await workerUrl(ctx.db, row.workerId)
      if (!url) return {}
      const saved = await callWorker<z.infer<typeof saveLoginResultSchema>>(ctx.keyring(), url, `/browsers/${encodeURIComponent(row.id)}/close`, {}).catch((error) =>
        error instanceof WorkerCallError && error.status === 404 ? undefined : fromWorker(error)
      )
      // 审计里不放登录态内容，只有版本号和 cookie 个数
      await writeAudit(ctx.db, {
        actorId: ctx.user.id,
        action: "browser.close",
        targetTable: "browser_vaults",
        targetId: row.profileId,
        detail: { browserId: row.id, ...(saved ? { vaultVersion: saved.vaultVersion, cookieCount: saved.cookieCount, accounts: saved.accounts.map(({ accountId, ok }) => ({ accountId, ok })) } : {}) },
      })
      return saved ? { saved } : {}
    }),

  /** 现在开着的 Chrome：哪个配置、哪个 session、谁在看 */
  live: protectedProcedure.output(z.array(liveBrowserSchema)).query(async ({ ctx }) => {
    const rows = await ctx.db
      .select({ instance: t.browserInstances, profileName: t.browserProfiles.name, taskId: t.sessions.taskId })
      .from(t.browserInstances)
      .innerJoin(t.browserProfiles, eq(t.browserProfiles.id, t.browserInstances.profileId))
      .leftJoin(t.sessions, eq(t.sessions.id, t.browserInstances.sessionId))
      .innerJoin(t.browserWorkers, eq(t.browserWorkers.id, t.browserInstances.workerId))
      .where(gt(t.browserWorkers.heartbeatAt, new Date(Date.now() - 60_000)))
      .orderBy(asc(t.browserInstances.startedAt))
    return rows.map(({ instance, profileName, taskId }): LiveBrowser => ({
      browserId: instance.id,
      kind: instance.kind,
      state: instance.state,
      profileId: instance.profileId,
      profileName,
      ...(instance.sessionId ? { sessionId: instance.sessionId } : {}),
      ...(taskId ? { taskId } : {}),
      ...(instance.accountId ? { accountId: instance.accountId } : {}),
      ...(instance.openedById ? { openedById: instance.openedById } : {}),
      url: instance.url,
      title: instance.title,
      viewers: instance.viewers,
      startedAt: iso(instance.startedAt),
      lastActiveAt: iso(instance.lastActiveAt),
      ...(instance.holdUntil ? { holdUntil: iso(instance.holdUntil) } : {}),
    }))
  }),

  /** 这个 session 现在有没有开着的 Chrome（有就给 browserId，远程画面用），以及当前的人能不能操作 */
  sessionBrowser: protectedProcedure
    .input(sessionIdInputSchema)
    .output(sessionBrowserSchema)
    .query(async ({ ctx, input }) => {
      const [session] = await ctx.db.select({ id: t.sessions.id, profileId: t.sessions.browserProfileId }).from(t.sessions).where(eq(t.sessions.id, input.sessionId))
      if (!session) throw new TRPCError({ code: "NOT_FOUND", message: `找不到 session ${input.sessionId}` })
      const [row] = await ctx.db
        .select({ id: t.browserInstances.id, state: t.browserInstances.state, profileId: t.browserInstances.profileId })
        .from(t.browserInstances)
        .innerJoin(t.browserWorkers, eq(t.browserWorkers.id, t.browserInstances.workerId))
        .where(and(eq(t.browserInstances.sessionId, input.sessionId), eq(t.browserInstances.kind, "session"), gt(t.browserWorkers.heartbeatAt, new Date(Date.now() - 60_000))))
      const canControl = await canControlSession(ctx.db, ctx.user, input.sessionId)
      const profileId = row?.profileId ?? session.profileId ?? undefined
      return {
        open: Boolean(row && row.state !== "closing"),
        ...(row ? { browserId: row.id, state: row.state } : {}),
        ...(profileId ? { profileId } : {}),
        canControl,
      }
    }),

  /** 各「平台 × 账号」的使用数 / 上限、状态、排队数 */
  accountStatus: protectedProcedure.output(z.array(accountUsageSchema)).query(async ({ ctx }) => {
    const accounts = await ctx.db.select().from(t.browserAccounts).orderBy(asc(t.browserAccounts.position), asc(t.browserAccounts.createdAt))
    if (!accounts.length) return []
    const ids = accounts.map((account) => account.id)
    const leases = await ctx.db
      .select({ accountId: t.accountLeases.accountId, sessionId: t.accountLeases.sessionId })
      .from(t.accountLeases)
      .where(and(inArray(t.accountLeases.accountId, ids), isNull(t.accountLeases.releasedAt), gt(t.accountLeases.expiresAt, new Date())))
    const waits = await ctx.db
      .select({ event: t.sessionWaits.event, n: count() })
      .from(t.sessionWaits)
      .where(and(eq(t.sessionWaits.status, "waiting"), sql`${t.sessionWaits.event} like 'browser.lease:%'`))
      .groupBy(t.sessionWaits.event)
    return accounts.map((account) => {
      const mine = leases.filter((lease) => lease.accountId === account.id)
      return {
        accountId: account.id,
        profileId: account.profileId,
        platformId: account.platformId,
        account: account.account,
        status: account.status,
        used: mine.length,
        max: account.maxConcurrent,
        sessionIds: mine.map((lease) => lease.sessionId),
        waiting: waits.find((row) => row.event === leaseEventName(account.id))?.n ?? 0,
      }
    })
  }),

  /** 浏览器页「操作历史」：这个 Chrome 最近的动作，同一次运行在同一个网址上连着做的合成一行（最近 500 个动作） */
  history: protectedProcedure
    .input(z.object({ profileId: z.string() }))
    .output(z.array(browserHistoryRowSchema))
    .query(async ({ ctx, input }) => {
      const rows = await ctx.db
        .select()
        .from(t.browserActions)
        .where(eq(t.browserActions.profileId, input.profileId))
        .orderBy(desc(t.browserActions.at), desc(t.browserActions.id))
        .limit(500)
      return groupBrowserActions(rows.map((row) => ({ ...row, at: iso(row.at) })))
    }),
})
