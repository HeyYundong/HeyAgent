// 首次设置管理员（/api/setup）：空库上 GET 说要设置；不受信任的来源回 403、填错回 400；
// 几个人同时提交只建成一个管理员；建好后能用自己定的邮箱密码登录、是主管；之后再提交回 409。
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { createApp } from "../src/app.js"
import { createAuth } from "../src/auth.js"
import { bootstrap } from "../src/bootstrap/index.js"
import { createDb } from "../src/db/client.js"
import * as t from "../src/db/schema.js"
import { ChangeHub } from "../src/live/hub.js"
import { login, query, resetTestDatabase, tempKeyring, testDatabaseUrl } from "./helpers.js"

const url = testDatabaseUrl()
const { db, pool } = createDb(url, 10)
const keyring = tempKeyring()
const auth = createAuth(db, { secret: "test-secret-test-secret-test-secret-0", baseURL: "http://localhost:3100", trustedOrigins: ["http://localhost:5180"] })
const hub = new ChangeHub(url)
const app = createApp({ db, auth, hub, keyring })

const status = async () => (await (await app.request("/api/setup")).json()) as { needed: boolean }
const submit = async (body: unknown, origin?: string) => {
  const res = await app.request("/api/setup", {
    method: "POST",
    headers: { "content-type": "application/json", ...(origin ? { origin } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
  return { status: res.status, body: (await res.json()) as { ok?: boolean; error?: string } }
}

beforeAll(async () => {
  await resetTestDatabase(url)
  await bootstrap(db, { keyring })
  await hub.start()
})
afterAll(async () => {
  await hub.stop()
  await pool.end()
})

describe("首次设置管理员", () => {
  it("空库：要先设置，登录页之前显示设置页", async () => {
    expect(await status()).toEqual({ needed: true })
  })

  it("别的网站发来的（Origin 不在名单里）不建", async () => {
    const result = await submit({ name: "坏人", email: "evil@example.com", password: "evil-password" }, "http://evil.example")
    expect(result.status).toBe(403)
    expect(await db.select().from(t.users)).toHaveLength(0)
  })

  it("填错了回 400 和中文说明，不建", async () => {
    expect((await submit({ name: "管理员", email: "boss@example.com", password: "short" })).body.error).toContain("至少 8 位")
    expect((await submit({ name: "管理员", email: "not-an-email", password: "long-enough-1" })).body.error).toBe("邮箱格式不对")
    expect((await submit({ name: "", email: "boss@example.com", password: "long-enough-1" })).body.error).toBe("填名字")
    expect((await submit("not json")).status).toBe(400)
    expect(await db.select().from(t.users)).toHaveLength(0)
  })

  it("几个人同时提交：只建成一个管理员，其余回 409", async () => {
    const origins = ["http://localhost:5180", "http://localhost:3100", undefined]
    const results = await Promise.all(
      Array.from({ length: 6 }, (_, i) => submit({ name: `老板${i}`, email: `Boss${i}@Example.com`, password: `boss-password-${i}` }, origins[i % origins.length]))
    )
    expect(results.filter((each) => each.status === 200)).toHaveLength(1)
    expect(results.filter((each) => each.status === 409)).toHaveLength(5)
    expect(results.find((each) => each.status === 409)?.body.error).toBe("已经设置过管理员了，请直接登录")

    const users = await db.select().from(t.users)
    expect(users).toHaveLength(1)
    const winner = Number(users[0]!.email.match(/^boss(\d)@example\.com$/)![1])
    expect(users[0]).toMatchObject({ name: `老板${winner}`, role: "admin", title: "管理员", banned: false, emailVerified: true })
    const audits = await db.select().from(t.auditEvents)
    expect(audits).toEqual([expect.objectContaining({ actorId: null, action: "user.create", targetId: users[0]!.id, detail: { email: users[0]!.email, role: "admin", by: "setup" } })])

    // 用自己定的邮箱（大小写不敏感）和密码登录，是主管，默认设置都在
    const cookie = await login(app, `BOSS${winner}@example.com`, `boss-password-${winner}`)
    expect((await query(app, "me.get", cookie)).data).toMatchObject({ email: `boss${winner}@example.com`, isAdmin: true })
    expect((await query(app, "settings.get", cookie)).data).toMatchObject({ maxCostUsd: 2, maxSteps: 100, eventFallbackDays: 7, channels: [] })
  })

  it("设置过以后：不再显示设置页，再提交回 409，账号不变", async () => {
    expect(await status()).toEqual({ needed: false })
    const again = await submit({ name: "后来的人", email: "late@example.com", password: "late-password" })
    expect(again.status).toBe(409)
    expect(await db.select().from(t.users)).toHaveLength(1)
    // 重启（再跑一次初始化）也不会提示设置
    expect((await bootstrap(db, { keyring })).setupNeeded).toBe(false)
  })
})
