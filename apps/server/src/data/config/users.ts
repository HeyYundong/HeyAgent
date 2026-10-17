// 用户管理（只有主管）和改自己的密码。账号相关的写操作都走 better-auth admin 插件的服务端接口
// （createUser / adminUpdateUser / banUser / unbanUser / setUserPassword / changePassword），它按请求头里的 cookie 认人、做权限检查。
import { TRPCError } from "@trpc/server"
import { isAPIError } from "better-auth/api"
import { and, asc, count, eq, ne } from "drizzle-orm"
import type { UserAccount } from "@heyagent/shared"

import type { Auth } from "../../auth.js"
import * as t from "../../db/schema.js"
import { assertCan, audit, badRequest, notFound, type WriteCtx } from "./common.js"

export interface AuthCtx extends WriteCtx {
  auth: Auth
  headers: Headers
}

/** better-auth 的报错换成中文 */
const MESSAGES: Record<string, string> = {
  USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL: "这个邮箱已经有账号了，换一个",
  USER_ALREADY_EXISTS: "这个邮箱已经有账号了，换一个",
  INVALID_EMAIL: "邮箱格式不对",
  INVALID_PASSWORD: "现在的密码不对",
  PASSWORD_TOO_SHORT: "密码太短了",
  PASSWORD_TOO_LONG: "密码太长了",
  YOU_CANNOT_BAN_YOURSELF: "不能停用自己",
  USER_NOT_FOUND: "找不到这个用户",
}

async function call<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isAPIError(error)) {
      const code = (error.body as { code?: string } | undefined)?.code ?? ""
      const message = MESSAGES[code] ?? (error.body as { message?: string } | undefined)?.message ?? "账号操作失败"
      if (error.status === "UNAUTHORIZED") throw new TRPCError({ code: "UNAUTHORIZED", message: "请先登录" })
      if (error.status === "FORBIDDEN") throw new TRPCError({ code: "FORBIDDEN", message })
      throw badRequest(message)
    }
    throw error
  }
}

const toAccount = (row: typeof t.users.$inferSelect): UserAccount => ({
  id: row.id,
  name: row.name,
  email: row.email,
  title: row.title,
  isAdmin: row.role === "admin",
  disabled: Boolean(row.banned),
  createdAt: row.createdAt.toISOString(),
})

export async function listUsers(ctx: WriteCtx): Promise<UserAccount[]> {
  assertCan(ctx.actor, "user.manage", {}, "只有主管能管理用户")
  const rows = await ctx.db.select().from(t.users).orderBy(asc(t.users.createdAt), asc(t.users.id))
  return rows.map(toAccount)
}

async function loadUser(ctx: WriteCtx, id: string) {
  const [row] = await ctx.db.select().from(t.users).where(eq(t.users.id, id))
  if (!row) throw notFound("用户", id)
  return row
}

/** 至少留一个能登录的主管，免得没人能管 */
async function assertOtherAdmin(ctx: WriteCtx, exceptId: string, message: string) {
  const [row] = await ctx.db
    .select({ n: count() })
    .from(t.users)
    .where(and(eq(t.users.role, "admin"), ne(t.users.id, exceptId), eq(t.users.banned, false)))
  if ((row?.n ?? 0) === 0) throw badRequest(message)
}

export async function createUser(ctx: AuthCtx, input: { email: string; name: string; title: string; role: "admin" | "user"; password: string }) {
  assertCan(ctx.actor, "user.manage", {}, "只有主管能建账号")
  const result = await call(() =>
    ctx.auth.api.createUser({ body: { email: input.email, password: input.password, name: input.name, role: input.role, data: { title: input.title, emailVerified: true } }, headers: ctx.headers })
  )
  const id = result.user.id
  // createUser 的 data 不一定写入自定义字段（职位），这里再确认一遍
  await ctx.db.update(t.users).set({ title: input.title }).where(eq(t.users.id, id))
  await audit(ctx.db, ctx.actor.id, "user.create", "users", id, { email: input.email, role: input.role })
  return { id }
}

export async function updateUser(ctx: AuthCtx, input: { id: string; name: string; title: string; role: "admin" | "user" }) {
  assertCan(ctx.actor, "user.manage", {}, "只有主管能改账号")
  const before = await loadUser(ctx, input.id)
  if (before.role === "admin" && input.role !== "admin") {
    if (input.id === ctx.actor.id) throw badRequest("不能取消自己的主管身份：请另一位主管来改")
    await assertOtherAdmin(ctx, input.id, "这是最后一位主管，不能改成员工")
  }
  await call(() => ctx.auth.api.adminUpdateUser({ body: { userId: input.id, data: { name: input.name, title: input.title, role: input.role } }, headers: ctx.headers }))
  const changed = (["name", "title"] as const).filter((key) => before[key] !== input[key])
  if ((before.role === "admin") !== (input.role === "admin")) changed.push("role" as never)
  await audit(ctx.db, ctx.actor.id, "user.update", "users", input.id, { changed, role: input.role })
  return { id: input.id }
}

/** 停用 = better-auth 的 ban（登录不了，已登录的会话立刻失效）；启用 = unban */
export async function setUserDisabled(ctx: AuthCtx, input: { id: string; disabled: boolean }) {
  assertCan(ctx.actor, "user.manage", {}, "只有主管能停用账号")
  const before = await loadUser(ctx, input.id)
  if (input.disabled) {
    if (input.id === ctx.actor.id) throw badRequest("不能停用自己")
    if (before.role === "admin") await assertOtherAdmin(ctx, input.id, "这是最后一位主管，不能停用")
    await call(() => ctx.auth.api.banUser({ body: { userId: input.id, banReason: "管理员停用" }, headers: ctx.headers }))
  } else {
    await call(() => ctx.auth.api.unbanUser({ body: { userId: input.id }, headers: ctx.headers }))
  }
  await audit(ctx.db, ctx.actor.id, input.disabled ? "user.disable" : "user.enable", "users", input.id, { email: before.email })
  return { id: input.id, disabled: input.disabled }
}

/** 主管重置别人的密码：新密码交给本人，旧的登录会话全部失效 */
export async function resetUserPassword(ctx: AuthCtx, input: { id: string; password: string }) {
  assertCan(ctx.actor, "user.manage", {}, "只有主管能重置密码")
  const before = await loadUser(ctx, input.id)
  await call(() => ctx.auth.api.setUserPassword({ body: { userId: input.id, newPassword: input.password }, headers: ctx.headers }))
  if (input.id !== ctx.actor.id) await call(() => ctx.auth.api.revokeUserSessions({ body: { userId: input.id }, headers: ctx.headers }))
  await audit(ctx.db, ctx.actor.id, "user.reset_password", "users", input.id, { email: before.email })
  return { id: input.id }
}

/** 改自己的密码：要先输对现在的密码；其他设备上的登录会话失效 */
export async function changeOwnPassword(ctx: AuthCtx, input: { currentPassword: string; newPassword: string }) {
  if (input.currentPassword === input.newPassword) throw badRequest("新密码和现在的一样")
  // 不用 better-auth 的 revokeOtherSessions：它会连当前会话一起换掉，新 cookie 在服务端调用里带不回浏览器，人会被登出
  await call(() => ctx.auth.api.changePassword({ body: { currentPassword: input.currentPassword, newPassword: input.newPassword }, headers: ctx.headers }))
  const current = await ctx.auth.api.getSession({ headers: ctx.headers })
  if (current) await ctx.db.delete(t.authSessions).where(and(eq(t.authSessions.userId, ctx.actor.id), ne(t.authSessions.id, current.session.id)))
  await audit(ctx.db, ctx.actor.id, "user.change_password", "users", ctx.actor.id)
  return { ok: true }
}
