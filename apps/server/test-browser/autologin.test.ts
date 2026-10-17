// 用存的密码自动登录（真浏览器 + 假模型）：「立刻登录」成功写回保险箱、密码不对交给人（Chrome 留着）、
// 运行中遇到登录页自己登录接着做。模型从头到尾只见过 {{username}} / {{password}} 占位符。
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { BrowserManager } from "../src/browser/manager.js"
import { loadVault } from "../src/browser/vault.js"
import * as t from "../src/db/schema.js"
import { call, createTask, eventsOf, Script, setupEngine, step, text, useScript, waitFor, waitStatus, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate } from "../test/helpers.js"
import { createAccount, createProfile, LOGIN2, setAccountPassword, startSite, type TestSite } from "./fixtures.js"

let ctx: EngineTestContext
let site: TestSite
let manager: BrowserManager
let wang: string
let profileId: string
/** 登录小 agent 用「模型」页的默认执行模型：剧本挂在它的 id 上 */
let loginModel: string

/** 登录小 agent 的剧本：看页面 → 填账号密码（占位符） → 点登录 → 结束（finish 决定怎么结束） */
const loginScript = (finish: ReturnType<typeof call>) =>
  new Script([
    step([call("browser_snapshot", {})]),
    step([
      call("browser_fill_form", {
        fields: [
          { name: "账号", type: "textbox", target: "#user", value: "{{username}}" },
          { name: "密码", type: "textbox", target: "#pw", value: "{{password}}" },
        ],
      }),
    ]),
    step([call("browser_click", { target: "#go", element: "登录按钮" })]),
    step([finish]),
  ])

async function passwordAccount(domain: string, password: string) {
  const accountId = await createAccount(ctx.db, { profileId, domain, probeUrl: site.url(domain, "/login2"), account: LOGIN2.user })
  await setAccountPassword(ctx.db, ctx.keyring, accountId, password)
  return accountId
}

const accountRow = async (accountId: string) => (await ctx.db.select().from(t.browserAccounts).where(eq(t.browserAccounts.id, accountId)))[0]!

beforeAll(async () => {
  ctx = await setupEngine()
  manager = ctx.worker.browser!
  site = await startSite()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  profileId = await createProfile(ctx.db, ctx.keyring)
  const [row] = await ctx.db.select().from(t.modelDefaults).where(eq(t.modelDefaults.role, "run"))
  loginModel = row!.modelId
})

afterAll(async () => {
  await ctx?.stop()
  await site?.close()
})

describe("立刻登录", () => {
  it("用存的密码登录成功：写回保险箱、账号变成正常、Chrome 关掉；模型没见过密码", async () => {
    const accountId = await passwordAccount("auth.localhost", LOGIN2.password)
    const script = useScript(loginModel, loginScript(call("login_done", { note: "进了我的账号" })))
    const res = await mutate(ctx.app, "browser.autoLogin", wang, { accountId })
    expect(res.error).toBeUndefined()
    expect(res.data).toMatchObject({ ok: true, needHuman: false, accounts: [{ accountId, ok: true }] })
    expect(res.data.vaultVersion).toBeGreaterThanOrEqual(1)
    expect(res.data.browserId).toBeUndefined()
    const prompts = JSON.stringify(script.prompts)
    expect(prompts).toContain("{{password}}")
    expect(prompts).not.toContain(LOGIN2.password)
    const vault = await loadVault(ctx.db, ctx.keyring, profileId)
    expect(vault.state.cookies.some((cookie) => cookie.name === "sid" && cookie.domain.includes("auth.localhost"))).toBe(true)
    expect(await accountRow(accountId)).toMatchObject({ status: "ok", loggedInById: "u-wang" })
    await waitFor(async () => manager.list().every((each) => each.kind !== "login"), { what: "登录用的 Chrome 关掉" })
    const actions = await ctx.db.select().from(t.browserActions).where(and(eq(t.browserActions.profileId, profileId), eq(t.browserActions.action, "Login")))
    expect(actions.some((each) => !each.failed)).toBe(true)
    const audit = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.action, "browser.auto_login"), eq(t.auditEvents.targetId, accountId)))
    expect(JSON.stringify(audit)).not.toContain(LOGIN2.password)
  })

  it("密码不对：模型说要人处理 → 不写回，Chrome 留着给人（返回 browserId），关掉照常保存", async () => {
    const accountId = await passwordAccount("auth-bad.localhost", "wrong-password")
    useScript(loginModel, loginScript(call("login_need_human", { reason: "页面说账号或密码不对" })))
    const before = (await loadVault(ctx.db, ctx.keyring, profileId)).version
    const res = await mutate(ctx.app, "browser.autoLogin", wang, { accountId })
    expect(res.data).toMatchObject({ ok: false, needHuman: true, detail: "页面说账号或密码不对" })
    const browserId = res.data.browserId as string
    expect(manager.get(browserId)?.kind).toBe("login")
    expect((await loadVault(ctx.db, ctx.keyring, profileId)).version).toBe(before)
    expect((await accountRow(accountId)).status).toBe("expired")
    // 人在远程画面里登录好（这里直接用编排器连接），关掉 = 保存
    const page = manager.get(browserId)!.currentPage()!
    await page.fill("#user", LOGIN2.user)
    await page.fill("#pw", LOGIN2.password)
    await Promise.all([page.waitForURL(/\/me2/), page.click("#go")])
    const closed = await mutate(ctx.app, "browser.close", wang, { browserId })
    expect(closed.data.saved.vaultVersion).toBeGreaterThan(before)
  })

  it("没存密码、别的网站：立刻登录报原因；密码不会填到账号网站以外的页面", async () => {
    const accountId = await createAccount(ctx.db, { profileId, domain: "nopw.localhost", probeUrl: site.url("nopw.localhost", "/login2") })
    const res = await mutate(ctx.app, "browser.autoLogin", wang, { accountId })
    expect(res.error?.message).toContain("没存密码")
    // 模型想把密码填到别的网站：被拒绝，没填进去
    const other = await passwordAccount("guard.localhost", LOGIN2.password)
    const script = useScript(
      loginModel,
      new Script([
        step([call("browser_navigate", { url: site.url("evil.localhost", "/login2") })]),
        step([call("browser_type", { target: "#pw", text: "{{password}}" })]),
        step([call("login_need_human", { reason: "放弃" })]),
      ])
    )
    const guarded = await mutate(ctx.app, "browser.autoLogin", wang, { accountId: other })
    expect(guarded.data).toMatchObject({ ok: false, needHuman: true })
    expect(script.promptText(1)).toContain("登录时只能打开这些网站")
    await mutate(ctx.app, "browser.close", wang, { browserId: guarded.data.browserId })
  })
})

describe("运行中遇到登录页", () => {
  it("账号存了密码：自动登录、接着做完，不生成要人办的事；花费算进这次运行", async () => {
    const domain = "auth-run.localhost"
    const accountId = await passwordAccount(domain, LOGIN2.password)
    const loginAgent = useScript(loginModel, loginScript(call("login_done", { note: "好了" })))
    const runScript = useScript(
      "test/autologin-run",
      new Script([
        step([call("browser.navigate", { url: site.url(domain, "/me2") })]),
        step([call("browser.navigate", { url: site.url(domain, "/me2") })]),
        step([call("browser.snapshot", {})]),
        step([text("拿到暗号了")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/autologin-run", toolIds: ["browser"], ownerId: "u-wang" })
    await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId] }).where(eq(t.tasks.id, taskId))
    const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
    const sessionId = res.data.sessionId as string
    await waitStatus(ctx.db, sessionId, "done", 120_000)
    expect(runScript.promptText(1)).toContain("已用")
    expect(runScript.promptText(1)).toContain("自动登录")
    expect(runScript.promptText(3)).toContain("暗号：金色海豚")
    expect(JSON.stringify(runScript.prompts)).not.toContain(LOGIN2.password)
    expect(JSON.stringify(loginAgent.prompts)).not.toContain(LOGIN2.password)
    const items = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.sessionId, sessionId))
    expect(items).toEqual([])
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.some((event) => event.title.includes("自动登录了"))).toBe(true)
    expect((await accountRow(accountId)).status).toBe("ok")
  })
})
