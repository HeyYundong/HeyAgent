// 真浏览器：登录、cookie 轮换、两个 Chrome 交替写回时的合并、登录探测失败不写回（m2.md 验收）。
// 每个 Chrome 配置同一时间只给一个运行用（2026-10-19 起）：同一个配置上能同时开着的是一个运行的 Chrome 和人「打开 Chrome」的那个，
// 合并写回就用这两个测。afterEach 关掉没关的 Chrome，一个用例失败不连累后面的。
import { eq } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

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

/** 收尾：还开着的 Chrome 都关掉（不写回），后面的用例能用这个 Chrome 配置 */
afterEach(async () => {
  for (const instance of manager.list()) {
    if (instance.kind === "session" && instance.sessionId) await manager.releaseSession(instance.sessionId, { reason: "测试收尾" }).catch(() => {})
    else await instance.close({ writeBack: false, reason: "测试收尾" }).catch(() => {})
  }
})

describe("登录和保险箱", () => {
  it("打开 Chrome 登录 → 人登录 → 关闭：登录态合并进保险箱，账号变成正常", async () => {
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
    // 别人不能关
    const li = await login(ctx.app, "lijing@heyagent.local")
    expect((await mutate(ctx.app, "browser.close", li, { browserId })).error?.data?.code).toBe("FORBIDDEN")
    const closed = await mutate(ctx.app, "browser.close", wang, { browserId })
    expect(closed.error).toBeUndefined()
    expect(closed.data.saved).toMatchObject({ vaultVersion: 1, accounts: [{ accountId, ok: true }] })
    expect(closed.data.saved.cookieCount).toBeGreaterThanOrEqual(1)
    expect((await account()).status).toBe("ok")
    const vault = await loadVault(ctx.db, ctx.keyring, profileId)
    expect(vault.state.cookies.find((cookie) => cookie.name === "sid")).toBeTruthy()
    expect(manager.get(browserId)).toBeUndefined()
    const rows = await ctx.db.select().from(t.browserInstances).where(eq(t.browserInstances.id, browserId))
    expect(rows).toEqual([])
  })

  it("运行的 Chrome 和人打开的 Chrome 交替：A 轮换了 sid、B 加了偏好，先后写回，合并结果两样都在；新 session 用合并后的登录态", async () => {
    const before = await loadVault(ctx.db, ctx.keyring, profileId)
    const firstSid = before.state.cookies.find((cookie) => cookie.name === "sid")!.value
    const a = await manager.acquireForSession({ sessionId: await newSession("R-V-A"), profileId, allowedDomains: [] })
    // 同一个配置不能再给第二个运行：登记时就拒绝（每个 Chrome 同一时间只给一个运行用）
    await expect(manager.acquireForSession({ sessionId: await newSession("R-V-B"), profileId, allowedDomains: [] })).rejects.toThrow("正在被别的运行用")
    // 人在浏览器页「打开 Chrome」：不挂运行，可以和运行的 Chrome 同时开着
    const opened = await mutate(ctx.app, "browser.openForLogin", wang, { profileId, accountId })
    expect(opened.error).toBeUndefined()
    const b = manager.get(opened.data.browserId as string)!
    const pageA = a.currentPage()!
    const pageB = b.currentPage()!
    await pageA.goto(site.url(SHOP, "/me"))
    expect(await pageA.textContent("#who")).toContain(`sid=${firstSid}`)
    await pageA.goto(site.url(SHOP, "/rotate"))
    await pageB.goto(site.url(SHOP, "/me"))
    expect(await pageB.textContent("#who")).toContain(`sid=${firstSid}`)
    await pageB.goto(site.url(SHOP, "/pref"))
    // 运行打开平台域名下的网址时拿到了租约
    expect(a.leased.has(accountId)).toBe(true)
    const rotated = (await a.exportState()).cookies.find((cookie) => cookie.name === "sid")!.value
    expect(rotated).not.toBe(firstSid)

    const closedA = await manager.releaseSession("R-V-A", { reason: "测试" })
    expect(closedA.summary).toMatchObject({ vaultVersion: before.version + 1, probes: [{ accountId, ok: true }] })
    const closedB = await mutate(ctx.app, "browser.close", wang, { browserId: b.id })
    expect(closedB.error).toBeUndefined()
    expect(closedB.data.saved.vaultVersion).toBe(before.version + 2)
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
