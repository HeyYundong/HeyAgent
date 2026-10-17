// 首次设置：一个账号都没有时，控制台先显示「设置管理员」页，由第一个打开的人自己定管理员的名字、邮箱和密码。
// 不再自动建默认管理员、不再生成随机初始密码（2026-10-17 用户要求）。
// GET  /api/setup → { needed }：还没有任何账号时 needed = true
// POST /api/setup { name, email, password } → 建管理员（主管，职位「管理员」）；之后前端用这个邮箱和密码正常登录。
//   已经有账号了回 409。两个人同时提交时用事务级 advisory lock 排队，只有第一个能建成。
//   浏览器发来的（带 Origin 头）必须是受信任的来源，和登录用同一份名单：免得别的网站借内网同事的浏览器抢先建管理员。
import { setupAdminSchema, type SetupStatus } from "@heyagent/shared"
import { isAPIError } from "better-auth/api"
import { count, eq, sql } from "drizzle-orm"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"

import type { Auth } from "../auth.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"

export async function setupNeeded(db: Db) {
  const [row] = await db.select({ n: count() }).from(t.users)
  return (row?.n ?? 0) === 0
}

/** 建第一个管理员；已经有账号了返回 null */
export async function createFirstAdmin(db: Db, auth: Auth, input: { name: string; email: string; password: string }) {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext('heyagent:first-admin'))`)
    const [row] = await tx.select({ n: count() }).from(t.users)
    if ((row?.n ?? 0) > 0) return null
    // 服务端直接调（不带请求头）：admin 插件允许系统自己建账号。它用自己的连接、自己提交，锁要等这个事务结束才放，
    // 所以排在后面的请求再数一遍时能看到这个账号
    const { user } = await auth.api.createUser({ body: { email: input.email, password: input.password, name: input.name, role: "admin", data: { title: "管理员", emailVerified: true } } })
    // createUser 的 data 不一定写入自定义字段（职位），这里再确认一遍
    await tx.update(t.users).set({ title: "管理员" }).where(eq(t.users.id, user.id))
    await tx.insert(t.auditEvents).values({ actorId: null, action: "user.create", targetTable: "users", targetId: user.id, detail: { email: input.email, role: "admin", by: "setup" } })
    return { id: user.id }
  })
}

export function registerSetupRoutes(app: Hono, deps: { db: Db; auth: Auth }) {
  app.get("/api/setup", async (c) => c.json({ needed: await setupNeeded(deps.db) } satisfies SetupStatus))

  app.post(
    "/api/setup",
    bodyLimit({ maxSize: 16 * 1024, onError: (c) => c.json({ error: "内容太大" }, 413) }),
    async (c) => {
      const origin = c.req.header("origin")
      if (origin && !(await deps.auth.$context).isTrustedOrigin(origin)) return c.json({ error: "这个地址不在允许登录的名单里，请联系管理员" }, 403)
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: "内容要是 JSON：{ name, email, password }" }, 400)
      }
      const parsed = setupAdminSchema.safeParse(body)
      if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? "填的内容不对" }, 400)
      try {
        const created = await createFirstAdmin(deps.db, deps.auth, parsed.data)
        if (!created) return c.json({ error: "已经设置过管理员了，请直接登录" }, 409)
        return c.json({ ok: true })
      } catch (error) {
        if (isAPIError(error)) return c.json({ error: (error.body as { message?: string } | undefined)?.message ?? "建管理员失败" }, 400)
        throw error
      }
    }
  )
}
