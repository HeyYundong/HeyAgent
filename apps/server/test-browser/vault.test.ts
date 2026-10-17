// 真浏览器：登录、cookie 轮换、两个 session 交替时的合并写回、登录探测失败不写回（m2.md 验收）。
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { BrowserManager } from "../src/browser/manager.js"
import { loadVault } from "../src/browser/vault.js"
import * as t from "../src/db/schema.js"
import { createTask, setupEngine, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate } from "../test/helpers.js"
import { createAccount, createProfile, startSite, type TestSite } from "./fixtures.js"

let ctx: EngineTestContext
let site: TestSite
let manager: BrowserManager
let wang: string
let profileId: string
let accountId: string
let taskId: string

const SHOP = "shop.localhost"

async function newSession(id: string) {
  await ctx.db.insert(t.sessions).values({ id, taskId, status: "running", modelId: "test/none", startedAt: new Date() })
  return id
}

async function account() {
  const [row] = await ctx.db.select().from(t.browserAccounts).where(eq(t.browserAccounts.id, accountId))
  return row!
}

beforeAll(async () => {
  ctx = await setupEngine()
  manager = ctx.worker.browser!
  site = await startSite()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  profileId = await createProfile(ctx.db, ctx.keyring)
  accountId = await createAccount(ctx.db, { profileId, domain: SHOP, maxConcurrent: 3, probeUrl: site.url(SHOP, "/me") })
  taskId = await createTask(ctx.db, { modelId: "test/none" })
})

afterAll(async () => {
  await ctx?.stop()
  await site?.close()
})

describe("登录和保险箱", () => {
  it("打开 Chrome 登录 → 人登录 → 保存登录状态：整份写进保险箱，账号变成正常", async () => {
    const opened = await mutate(ctx.app, "browser.openForLogin", wang, { profileId, accountId })
    expect(opened.error).toBeUndefined()
    const browserId = opened.data.browserId as string
    const instance = manager.get(browserId)!
    // 打开的是账号的探测网址：没登录，跳到了登录页
    const page = instance.currentPage()!
    await page.waitForURL(/\/login/)
    // 人在页面上登录（这里直接用编排器的连接代替远程画面里的操作）
    await page.fill("#pw", "secret")
    await Promise.all([page.waitForURL(/\/me/), page.click("#go")])
    const saved = await mutate(ctx.app, "browser.saveLogin", wang, { browserId })
    expect(saved.error).toBeUndefined()
    expect(saved.data).toMatchObject({ vaultVersion: 1, accounts: [{ accountId, ok: true }] })
    expect(saved.data.cookieCount).toBeGreaterThanOrEqual(1)
    expect((await account()).status).toBe("ok")
    const vault = await loadVault(ctx.db, ctx.keyring, profileId)
    expect(vault.state.cookies.find((cookie) => cookie.name === "sid")).toBeTruthy()
    // 别人不能保存、不能关
    const li = await login(ctx.app, "lijing@heyagent.local")
    expect((await mutate(ctx.app, "browser.saveLogin", li, { browserId })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "browser.close", wang, { browserId })).error).toBeUndefined()
    expect(manager.get(browserId)).toBeUndefined()
    const rows = await ctx.db.select().from(t.browserInstances).where(eq(t.browserInstances.id, browserId))
    expect(rows).toEqual([])
  })

  it("两个 session 交替：A 轮换了 sid、B 加了偏好，先后写回，合并结果两样都在；新 session 用合并后的登录态", async () => {
    const before = await loadVault(ctx.db, ctx.keyring, profileId)
    const firstSid = before.state.cookies.find((cookie) => cookie.name === "sid")!.value
    const a = await manager.acquireForSession({ sessionId: await newSession("R-V-A"), profileId, allowedDomains: [] })
    const b = await manager.acquireForSession({ sessionId: await newSession("R-V-B"), profileId, allowedDomains: [] })
    const pageA = a.currentPage()!
    const pageB = b.currentPage()!
    await pageA.goto(site.url(SHOP, "/me"))
    expect(await pageA.textContent("#who")).toContain(`sid=${firstSid}`)
    await pageA.goto(site.url(SHOP, "/rotate"))
    await pageB.goto(site.url(SHOP, "/me"))
    expect(await pageB.textContent("#who")).toContain(`sid=${firstSid}`)
    await pageB.goto(site.url(SHOP, "/pref"))
    // 打开平台域名下的网址时拿到了租约
    expect(a.leased.has(accountId)).toBe(true)
    expect(b.leased.has(accountId)).toBe(true)
    const rotated = (await a.exportState()).cookies.find((cookie) => cookie.name === "sid")!.value
    expect(rotated).not.toBe(firstSid)

    const closedA = await manager.releaseSession("R-V-A", { reason: "测试" })
    expect(closedA.summary).toMatchObject({ vaultVersion: before.version + 1, probes: [{ accountId, ok: true }] })
    const closedB = await manager.releaseSession("R-V-B", { reason: "测试" })
    expect(closedB.summary?.vaultVersion).toBe(before.version + 2)
    const merged = await loadVault(ctx.db, ctx.keyring, profileId)
    const values = Object.fromEntries(merged.state.cookies.map((cookie) => [cookie.name, cookie.value]))
    expect(values.sid).toBe(rotated)
    expect(values.pref).toBe("dark")
    // 租约都释放了
    const leases = await ctx.db.select().from(t.accountLeases).where(eq(t.accountLeases.accountId, accountId))
    expect(leases.every((lease) => lease.releasedAt)).toBe(true)

    const c = await manager.acquireForSession({ sessionId: await newSession("R-V-C"), profileId, allowedDomains: [] })
    const pageC = c.currentPage()!
    await pageC.goto(site.url(SHOP, "/me"))
    expect(await pageC.textContent("#who")).toContain(`sid=${rotated}`)
    expect(await pageC.textContent("body")).toContain("pref=dark")
    await manager.releaseSession("R-V-C", { reason: "测试" })
  })

  it("登录探测失败（被登出了）：不写回，账号标成「要登录」", async () => {
    const before = await loadVault(ctx.db, ctx.keyring, profileId)
    const d = await manager.acquireForSession({ sessionId: await newSession("R-V-D"), profileId, allowedDomains: [] })
    const page = d.currentPage()!
    await page.goto(site.url(SHOP, "/logout"))
    const closed = await manager.releaseSession("R-V-D", { reason: "测试" })
    expect(closed.summary?.vaultVersion).toBeUndefined()
    expect(closed.summary?.skipped).toContain("登录探测没通过")
    expect(closed.summary?.probes[0]).toMatchObject({ accountId, ok: false })
    expect((await loadVault(ctx.db, ctx.keyring, profileId)).version).toBe(before.version)
    expect((await account()).status).toBe("expired")
  })
})
