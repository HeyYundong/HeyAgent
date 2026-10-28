// M2 浏览器：不需要 Chrome 的部分（开发机上跑）。真浏览器的测试在 test-browser/，在 worker 镜像的容器里跑（scripts/browser-test.sh）。
import type { Server } from "node:http"

import { serve } from "@hono/node-server"
import { and, eq, inArray, isNull } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import WebSocket from "ws"
import { ANY_PROFILE_EVENT, leaseEventName, profileEventName, SETTING_KEYS } from "@heyagent/shared"

import { adaptSchema, browserToolId } from "../src/browser/tools.js"
import { BrowserUnavailableError, ChromeStartAbortedError, chromeArgs } from "../src/browser/chrome.js"
import { judgePage, parseVisionAnswer, probeLooksLoggedIn, type PageFacts } from "../src/browser/detect.js"
import { gostConfig } from "../src/browser/gost.js"
import type { GostPool } from "../src/browser/gost.js"
import { BrowserInstance, ProfileFullError } from "../src/browser/instance.js"
import { accountForHost, acquireLease, profileSessionCount, releaseLeases, sweepLeases, wakeLeaseWaiters, wakeProfileWaiters } from "../src/browser/leases.js"
import { fillCredentials, loadAccountPassword, passwordHosts } from "../src/browser/auto-login.js"
import { captchaPrompt, parseCaptchaPlan } from "../src/browser/captcha.js"
import { getBrowserManager } from "../src/browser/manager.js"
import { listBrowserMcpTools } from "../src/browser/mcp.js"
import { attachBrowserViewRelay } from "../src/browser/view-relay.js"
import { casWrite, loadVault, mergeStates, writeBackMerged, type StorageState, type StoredCookie } from "../src/browser/vault.js"
import * as t from "../src/db/schema.js"
import { cancelSessionImpl } from "../src/engine/control.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { suspendInTx } from "../src/engine/waits.js"
import { call, createTask, Script, sessionRow, setupEngine, step, text, useScript, waitFor, waitStatus, eventsOf, type EngineTestContext } from "./engine-helpers.js"
import { login, mutate, query, TEST_REVIEW_MODEL } from "./helpers.js"

const cookie = (name: string, value: string, extra: Partial<StoredCookie> = {}): StoredCookie => ({
  name,
  value,
  domain: "shop.test",
  path: "/",
  expires: -1,
  httpOnly: true,
  secure: false,
  sameSite: "Lax",
  ...extra,
})
const state = (cookies: StoredCookie[], origins: StorageState["origins"] = []): StorageState => ({ cookies, origins })
const facts = (extra: Partial<PageFacts>): PageFacts => ({ url: "https://site.test/", title: "", frameUrls: [], text: "", hasPasswordInput: false, ...extra })

describe("纯函数", () => {
  it("三方合并：只写本 session 改过的项，保留别人的改动", () => {
    const base = state([cookie("sid", "s1"), cookie("pref", "a"), cookie("gone", "x")], [{ origin: "https://shop.test", localStorage: [{ name: "k", value: "1" }, { name: "del", value: "d" }] }])
    // 本 session：sid 轮换、pref 不动、gone 删掉、新增 cart；localStorage 改 k、删 del、加 n
    const mine = state([cookie("sid", "s2"), cookie("pref", "a"), cookie("cart", "c")], [{ origin: "https://shop.test", localStorage: [{ name: "k", value: "2" }, { name: "n", value: "new" }] }])
    // 别人在这期间：pref 改了、加了 other、gone 还在、localStorage 加了 theirs
    const theirs = state([cookie("sid", "s1"), cookie("pref", "b"), cookie("gone", "x"), cookie("other", "o")], [{ origin: "https://shop.test", localStorage: [{ name: "k", value: "1" }, { name: "del", value: "d" }, { name: "theirs", value: "t" }] }])
    const merged = mergeStates(base, mine, theirs)
    const values = Object.fromEntries(merged.cookies.map((each) => [each.name, each.value]))
    expect(values).toEqual({ sid: "s2", pref: "b", other: "o", cart: "c" })
    const items = Object.fromEntries(merged.origins[0]!.localStorage.map((each) => [each.name, each.value]))
    expect(items).toEqual({ k: "2", n: "new", theirs: "t" })
  })

  it("验证码和登录页检测：通用规则", () => {
    expect(judgePage(facts({ frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=1"] }))).toMatchObject({ kind: "captcha", provider: "reCAPTCHA" })
    expect(judgePage(facts({ frameUrls: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/x"] }))).toMatchObject({ kind: "captcha", provider: "Cloudflare Turnstile" })
    // 页面自己的验证码（标题、正文）不算第三方，会先自己试着过
    expect(judgePage(facts({ title: "安全验证" }))).not.toHaveProperty("provider")
    expect(judgePage(facts({ frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/x"] })).kind).toBe("captcha")
    expect(judgePage(facts({ title: "Robot Check" })).kind).toBe("captcha")
    expect(judgePage(facts({ title: "安全验证" })).kind).toBe("captcha")
    expect(judgePage(facts({ text: "请拖动下方滑块完成拼图" })).kind).toBe("captcha")
    expect(judgePage(facts({ url: "https://site.test/account/login?next=/", hasPasswordInput: true })).kind).toBe("login")
    expect(judgePage(facts({ title: "Sign in", hasPasswordInput: true })).kind).toBe("login")
    expect(judgePage(facts({ hasPasswordInput: true })).kind).toBe("uncertain")
    // 讲验证码的文章只算拿不准
    expect(judgePage(facts({ title: "CAPTCHA - Wikipedia".replace("CAPTCHA", "Turing test"), text: "A CAPTCHA is a type of challenge" })).kind).toBe("uncertain")
    expect(judgePage(facts({ title: "Example Domain", text: "This domain is for use in documentation examples" })).kind).toBe("none")
  })

  it("登录探测、视觉模型的回答", () => {
    expect(probeLooksLoggedIn({ url: "https://site.test/me", hasPasswordInput: false }).ok).toBe(true)
    expect(probeLooksLoggedIn({ url: "https://site.test/login?next=/me", hasPasswordInput: false }).ok).toBe(false)
    expect(probeLooksLoggedIn({ url: "https://site.test/me", hasPasswordInput: true }).ok).toBe(false)
    // 登录网址本身就是登录页、打开后没跳走：看不出来，按已登录算；跳到了别的登录页才算掉登录
    expect(probeLooksLoggedIn({ url: "https://site.test/login?x=1", hasPasswordInput: true }, "https://site.test/login").ok).toBe(true)
    expect(probeLooksLoggedIn({ url: "https://site.test/login?next=/me", hasPasswordInput: true }, "https://site.test/me").ok).toBe(false)
    expect(parseVisionAnswer('好的：{"captcha": true, "login": false, "reason": "滑块"}')).toEqual({ captcha: true, login: false, reason: "滑块" })
    expect(parseVisionAnswer("不知道")).toBeUndefined()
  })

  it("自动过验证码：给模型的元素列表、模型回答的解析", () => {
    const prompt = captchaPrompt(
      [
        { id: 1, role: "image", tag: "img", text: "captcha.png", hint: true, x: 10, y: 20, w: 100, h: 40 },
        { id: 2, role: "input", tag: "input", text: "验证码", hint: true, filled: false, x: 10, y: 70, w: 200, h: 30 },
        { id: 3, role: "button", tag: "button", text: "提交", hint: false, x: 10, y: 110, w: 80, h: 30 },
      ],
      true
    )
    expect(prompt).toContain("#1 图片 <img> 「captcha.png」")
    expect(prompt).toContain("#2 输入框 <input> 「验证码」（空）")
    expect(prompt).toContain('"submit"')
    expect(captchaPrompt([], false)).not.toContain('"submit"')
    expect(parseCaptchaPlan('好的 {"type": "text", "image": 1, "input": "#2", "answer": " x7K2 ", "submit": 3}')).toEqual({ type: "text", image: 1, input: 2, answer: "x7K2", submit: 3 })
    expect(parseCaptchaPlan('{"type": "text", "input": 2, "answer": 42, "submit": null}')).toEqual({ type: "text", input: 2, answer: "42", image: undefined, submit: undefined })
    expect(parseCaptchaPlan('{"type": "click", "target": 5}')).toEqual({ type: "click", target: 5 })
    expect(parseCaptchaPlan('{"type": "other", "reason": "滑块拼图"}')).toEqual({ type: "other", reason: "滑块拼图" })
    // 缺输入框、答案太长、格式不对：看不懂
    expect(parseCaptchaPlan('{"type": "text", "answer": "abcd"}')).toBeUndefined()
    expect(parseCaptchaPlan(`{"type": "text", "input": 2, "answer": "${"a".repeat(17)}"}`)).toBeUndefined()
    expect(parseCaptchaPlan("看不清")).toBeUndefined()
  })

  it("Chrome 参数：有代理时防 DNS 泄漏，不关 sandbox、不加自动化标记", () => {
    const args = chromeArgs({ userDataDir: "/tmp/x", display: 1, proxyServer: "socks5://127.0.0.1:1080", locale: "en-US" })
    expect(args).toContain("--proxy-server=socks5://127.0.0.1:1080")
    expect(args).toContain("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1")
    expect(args).toContain("--accept-lang=en-US,en")
    expect(args).toContain("--disable-background-networking")
    expect(args).toContain("--remote-debugging-address=127.0.0.1")
    expect(args.some((arg) => /no-sandbox|headless|enable-automation/.test(arg))).toBe(false)
    expect(chromeArgs({ userDataDir: "/tmp/x", display: 1 }).some((arg) => arg.startsWith("--proxy-server"))).toBe(false)
  })

  it("gost 配置文件：密码转义，不出现在命令行", () => {
    const yaml = gostConfig(11080, { host: "10.0.0.1", port: 1080, username: "u", password: 'p@ss:w0rd/测试"' })
    expect(yaml).toContain("addr: 127.0.0.1:11080")
    expect(yaml).toContain(JSON.stringify('p@ss:w0rd/测试"'))
  })

  it("账号按平台域名匹配（最具体的域名优先）", () => {
    const accounts = [
      { accountId: "a1", platformId: "p1", platformName: "P1", account: "x", domains: ["example.com"], maxConcurrent: 1, probeUrl: null, saveIndexedDb: false, status: "ok" },
      { accountId: "a2", platformId: "p2", platformName: "P2", account: "y", domains: ["shop.example.com"], maxConcurrent: 1, probeUrl: null, saveIndexedDb: false, status: "ok" },
    ]
    expect(accountForHost(accounts, "www.example.com")?.accountId).toBe("a1")
    expect(accountForHost(accounts, "a.shop.example.com")?.accountId).toBe("a2")
    expect(accountForHost(accounts, "other.test")).toBeUndefined()
  })

  it("Playwright MCP 的工具：不连浏览器也能列出来；上传改成文件 id，去掉存文件参数", async () => {
    const tools = await listBrowserMcpTools()
    const names = tools.map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(["browser_navigate", "browser_snapshot", "browser_click", "browser_run_code_unsafe", "browser_evaluate", "browser_file_upload"]))
    const upload = adaptSchema(tools.find((tool) => tool.name === "browser_file_upload")!) as { properties: Record<string, unknown> }
    expect(Object.keys(upload.properties)).toEqual(["fileIds"])
    const snapshot = adaptSchema(tools.find((tool) => tool.name === "browser_snapshot")!) as { properties: Record<string, unknown> }
    expect(snapshot.properties.filename).toBeUndefined()
    expect(snapshot.properties.depth).toBeDefined()
    expect(browserToolId("browser_navigate")).toBe("browser.navigate")
  })
})

let ctx: EngineTestContext
let lin: string
let wang: string

beforeAll(async () => {
  ctx = await setupEngine()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
})

afterAll(async () => {
  await ctx?.stop()
})

describe("配置：新字段的读写和快照", () => {
  it("平台域名、任务的 Chrome 配置 / 白名单 / 执行脚本、浏览器设置", async () => {
    const created = await mutate(ctx.app, "platforms.create", lin, { name: "测试平台", domains: ["https://Shop.Localhost/x", "*.other.test"] })
    expect(created.error).toBeUndefined()
    const platformId = created.data.id as string
    let platforms = await query(ctx.app, "platforms.list", wang)
    expect(platforms.data.find((each: { id: string }) => each.id === platformId).domains).toEqual(["shop.localhost", "other.test"])
    expect((await mutate(ctx.app, "platforms.update", wang, { id: platformId, name: "x", domains: [] })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "platforms.update", lin, { id: platformId, name: "测试平台", domains: ["shop.localhost"] })).error).toBeUndefined()
    platforms = await query(ctx.app, "platforms.list", wang)
    expect(platforms.data.find((each: { id: string }) => each.id === platformId).domains).toEqual(["shop.localhost"])
    expect((await mutate(ctx.app, "platforms.create", lin, { name: "坏", domains: ["not a domain"] })).error?.data?.code).toBe("BAD_REQUEST")

    const models = await query(ctx.app, "models.overview", lin)
    const modelId = models.data.defaults.run as string
    const task = await mutate(ctx.app, "tasks.create", lin, {
      title: "看网页",
      goal: "读出标题",
      reviewModelId: TEST_REVIEW_MODEL,
      steps: [],
      schedule: null,
      modelId,
      toolIds: ["browser"],
      browserProfileIds: ["br-us"],
      allowedDomains: ["Example.com"],
      allowBrowserEvaluate: true,
      allowBrowserVision: true,
    })
    expect(task.error).toBeUndefined()
    const got = await query(ctx.app, "tasks.get", wang, { id: task.data.id })
    expect(got.data).toMatchObject({ toolIds: ["browser"], browserProfileIds: ["br-us"], allowedDomains: ["example.com"], allowBrowserEvaluate: true, allowBrowserVision: true })
    expect((await mutate(ctx.app, "tasks.create", lin, { title: "x", goal: "y", steps: [], schedule: null, modelId, reviewModelId: TEST_REVIEW_MODEL, browserProfileIds: ["br-nope"] })).error?.message).toContain("br-nope")

    const snapshot = await buildSnapshot(ctx.db, task.data.id, { source: "manual", runAttachments: [] })
    expect(snapshot.tools.map((tool) => tool.id)).toContain("browser")
    expect(snapshot.browser).toMatchObject({ allowedDomains: ["example.com"], allowEvaluate: true, allowVision: true })
    expect(snapshot.browser!.profiles.map((profile) => profile.id)).toEqual(["br-us"])

    const defaults = { maxPerWorker: 4, visionCheck: false, visionModel: "openrouter/qwen/qwen3.8-flash", captchaSolve: true, humanHoldMinutes: 30 }
    const settings = await query(ctx.app, "settings.get", lin)
    expect(settings.data.browser).toEqual(defaults)
    const changed = { maxPerWorker: 2, visionCheck: true, visionModel: "openrouter/google/gemini-3.8-flash", captchaSolve: false, humanHoldMinutes: 5 }
    expect((await mutate(ctx.app, "settings.updateBrowser", lin, changed)).error).toBeUndefined()
    expect((await query(ctx.app, "settings.get", lin)).data.browser).toEqual(changed)
    expect((await mutate(ctx.app, "settings.updateBrowser", wang, changed)).error?.data?.code).toBe("FORBIDDEN")
    await mutate(ctx.app, "settings.updateBrowser", lin, defaults)
    const [row] = await ctx.db.select().from(t.settings).where(eq(t.settings.key, SETTING_KEYS.browserMaxPerWorker))
    expect(row?.value).toBe(4)
  })

  it("浏览器的视觉模型：换的时候要是库里能看图的聊天模型；没换不查（默认模型还没刷新进库也能存别的设置）", async () => {
    const lin = await login(ctx.app, "linzhou@heyagent.local")
    const base = { maxPerWorker: 4, visionCheck: false, visionModel: "openrouter/qwen/qwen3.8-flash", captchaSolve: true, humanHoldMinutes: 30 }
    await ctx.db.insert(t.models).values([
      { id: "openrouter/test/text-only", providerId: "openrouter", name: "只能读字", contextK: 128, vision: false },
      { id: "openrouter/test/embed-img", providerId: "openrouter", name: "图片向量", contextK: 8, vision: true, kind: "embedding" },
    ])
    const bad = async (visionModel: string) => (await mutate(ctx.app, "settings.updateBrowser", lin, { ...base, visionModel })).error
    expect((await bad("openrouter/test/text-only"))?.message).toContain("不能看图")
    expect((await bad("openrouter/test/embed-img"))?.message).toContain("不能看图")
    expect((await bad("openrouter/nope/missing"))?.message).toContain("不在模型列表里")
    expect((await bad(""))?.data?.code).toBe("BAD_REQUEST")
    expect((await query(ctx.app, "settings.get", lin)).data.browser.visionModel).toBe("openrouter/qwen/qwen3.8-flash")
    // 列表里的就是能选的
    const listed = (await query(ctx.app, "compare.models", lin)).data.map((model: { id: string }) => model.id)
    expect(listed).toContain("openrouter/qwen/qwen3.8-flash")
    expect(listed).not.toContain("openrouter/test/text-only")
    expect(listed).not.toContain("openrouter/test/embed-img")
    // 存着的模型不在库里（还没刷新）：没换模型照样能存别的
    await ctx.db.insert(t.settings).values({ key: SETTING_KEYS.browserVisionModel, value: "openrouter/later/vision" }).onConflictDoUpdate({ target: t.settings.key, set: { value: "openrouter/later/vision" } })
    expect((await mutate(ctx.app, "settings.updateBrowser", lin, { ...base, visionModel: "openrouter/later/vision", maxPerWorker: 3 })).error).toBeUndefined()
    await mutate(ctx.app, "settings.updateBrowser", lin, base)
    await ctx.db.delete(t.models).where(inArray(t.models.id, ["openrouter/test/text-only", "openrouter/test/embed-img"]))
  })
})

describe("账号密码", () => {
  it("只进不出：列表只有 hasPassword、掩码一个字不留；编辑留空不改，勾「去掉」才删；删账号连密码一起删；员工不能改", async () => {
    const secret = "Very-Secret-Pass-123"
    const [profile] = await ctx.db.select().from(t.browserProfiles).limit(1)
    const [platform] = await ctx.db.select().from(t.platforms).limit(1)
    const created = await mutate(ctx.app, "browsers.createAccount", lin, {
      profileId: profile!.id, platformId: platform!.id, account: "pw-user@example.com", password: secret, maxConcurrent: 1, probeUrl: "https://example.com/login",
    })
    expect(created.error).toBeUndefined()
    const id = created.data.id as string
    const list = await query(ctx.app, "browsers.list", wang)
    expect(JSON.stringify(list.data)).not.toContain(secret)
    const site = list.data.find((each: { id: string }) => each.id === profile!.id).sites.find((each: { accountId: string }) => each.accountId === id)
    expect(site).toMatchObject({ account: "pw-user@example.com", hasPassword: true })
    const rows = () => ctx.db.select().from(t.secrets).where(and(eq(t.secrets.scope, "browser_account"), eq(t.secrets.refId, id)))
    const [row] = await rows()
    expect(row!.masked).toBe("••••••••")
    expect(JSON.stringify(row!.enc)).not.toContain(secret)
    expect(await loadAccountPassword(ctx.db, ctx.keyring, id)).toBe(secret)
    // 编辑不填密码 = 不改
    expect((await mutate(ctx.app, "browsers.updateAccount", lin, { id, maxConcurrent: 2 })).error).toBeUndefined()
    expect(await loadAccountPassword(ctx.db, ctx.keyring, id)).toBe(secret)
    expect((await mutate(ctx.app, "browsers.updateAccount", wang, { id, password: "x" })).error?.data?.code).toBe("FORBIDDEN")
    await mutate(ctx.app, "browsers.updateAccount", lin, { id, clearPassword: true })
    expect(await loadAccountPassword(ctx.db, ctx.keyring, id)).toBeUndefined()
    await mutate(ctx.app, "browsers.updateAccount", lin, { id, password: "Another-Pass-456" })
    expect(await loadAccountPassword(ctx.db, ctx.keyring, id)).toBe("Another-Pass-456")
    const audits = await ctx.db.select().from(t.auditEvents).where(eq(t.auditEvents.targetId, id))
    expect(JSON.stringify(audits)).not.toMatch(/Very-Secret|Another-Pass/)
    expect((await mutate(ctx.app, "browsers.deleteAccount", lin, { id })).error).toBeUndefined()
    expect(await rows()).toEqual([])
  })

  it("占位符：只换 {{username}} / {{password}}；密码能填的网站 = 平台域名 + 登录网址", () => {
    const filled = fillCredentials({ fields: [{ value: "{{username}}" }, { value: "{{ password }}" }], other: "{{name}}" }, { username: "alice", password: "p@ss" })
    expect(filled).toEqual({ value: { fields: [{ value: "alice" }, { value: "p@ss" }], other: "{{name}}" }, usedPassword: true })
    expect(fillCredentials({ text: "{{username}}" }, { username: "a", password: "b" }).usedPassword).toBe(false)
    expect(passwordHosts({ domains: ["shop.test"], probeUrl: "https://sso.shop-login.test/in" }, "https://x.test/")).toEqual(["shop.test", "sso.shop-login.test"])
    expect(passwordHosts({ domains: [], probeUrl: null }, "https://start.test/login")).toEqual(["start.test"])
  })
})

describe("保险箱", () => {
  it("CAS：版本号对不上不写；合并写回保留别人的改动；整份替换", async () => {
    const keyring = ctx.keyring
    const profileId = "br-de"
    await ctx.db.delete(t.browserVaults).where(eq(t.browserVaults.profileId, profileId))
    expect((await loadVault(ctx.db, keyring, profileId)).version).toBe(0)
    expect(await casWrite(ctx.db, keyring, profileId, 0, state([cookie("sid", "s1")]), {})).toBe(1)
    expect(await casWrite(ctx.db, keyring, profileId, 0, state([]), {})).toBe(false)
    const base = (await loadVault(ctx.db, keyring, profileId)).state
    // 别的 session 先写回了 v2（加了 other）
    expect(await writeBackMerged(ctx.db, keyring, profileId, base, state([cookie("sid", "s1"), cookie("other", "o")]), {})).toBe(2)
    // 本 session 基于 v1 轮换了 sid：写回 v3，other 保留
    expect(await writeBackMerged(ctx.db, keyring, profileId, base, state([cookie("sid", "s2")]), {})).toBe(3)
    const now = await loadVault(ctx.db, keyring, profileId)
    expect(now.version).toBe(3)
    expect(Object.fromEntries(now.state.cookies.map((each) => [each.name, each.value]))).toEqual({ sid: "s2", other: "o" })
    // 人在登录 Chrome 里退出重登（删了 sid、other，加了 fresh）：同样合并写回
    expect(await writeBackMerged(ctx.db, keyring, profileId, now.state, state([cookie("fresh", "f")]), { userId: "u-lin" })).toBe(4)
    expect((await loadVault(ctx.db, keyring, profileId)).state.cookies.map((each) => each.name)).toEqual(["fresh"])
    // 密文绑定 Chrome id 和版本号：库里看不到原文
    const [row] = await ctx.db.select().from(t.browserVaults).where(eq(t.browserVaults.profileId, profileId))
    expect(JSON.stringify(row!.enc)).not.toContain("fresh")
  })
})

describe("账号租约", () => {
  it("满了就排队；释放时叫醒最早排队的；过期的不算", async () => {
    const [account] = await ctx.db.select().from(t.browserAccounts).limit(1)
    await ctx.db.update(t.browserAccounts).set({ maxConcurrent: 1 }).where(eq(t.browserAccounts.id, account!.id))
    await ctx.db.update(t.accountLeases).set({ releasedAt: new Date() }).where(and(eq(t.accountLeases.accountId, account!.id), isNull(t.accountLeases.releasedAt)))
    const taskId = await createTask(ctx.db, { modelId: "test/lease" })
    const ids = ["R-L-1", "R-L-2", "R-L-3"]
    for (const id of ids)
      await ctx.db.insert(t.sessions).values({ id, taskId, status: "running", modelId: "test/lease", startedAt: new Date() })
    expect(await acquireLease(ctx.db, account!.id, "R-L-1")).toEqual({ ok: true })
    expect(await acquireLease(ctx.db, account!.id, "R-L-1")).toEqual({ ok: true })
    expect(await acquireLease(ctx.db, account!.id, "R-L-2")).toMatchObject({ ok: false, used: 1, max: 1 })
    // R-L-2、R-L-3 挂起等这个账号（R-L-2 先排）
    for (const id of ["R-L-2", "R-L-3"])
      await ctx.db.transaction((tx) =>
        suspendInTx(ctx.db, tx, { sessionId: id, status: "waiting", what: "等待浏览器", triggerKind: "event", event: leaseEventName(account!.id) })
      )
    const status = await query(ctx.app, "browser.accountStatus", wang)
    expect(status.data.find((each: { accountId: string }) => each.accountId === account!.id)).toMatchObject({ used: 1, max: 1, sessionIds: ["R-L-1"], waiting: 2 })
    expect(await releaseLeases(ctx.db, "R-L-1")).toEqual([account!.id])
    expect((await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, "R-L-2")))[0]!.status).toBe("running")
    expect((await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, "R-L-3")))[0]!.status).toBe("waiting")
    // R-L-2 抢到；之后过期（worker 死了）→ 清扫时释放并叫醒 R-L-3
    expect(await acquireLease(ctx.db, account!.id, "R-L-2")).toEqual({ ok: true })
    expect(await wakeLeaseWaiters(ctx.db, account!.id)).toEqual([])
    await ctx.db.update(t.accountLeases).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(t.accountLeases.sessionId, "R-L-2"))
    await sweepLeases(ctx.db)
    expect((await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, "R-L-3")))[0]!.status).toBe("running")
    await ctx.db.update(t.sessions).set({ status: "failed" }).where(eq(t.sessions.taskId, taskId))
  })
})

describe("每个 Chrome 同一时间只给一个运行用", () => {
  it("已经有运行在用：登记时抛 ProfileFullError；人开的不占；关掉后叫醒排队的", async () => {
    const workerId = "w-slot-test"
    await ctx.db.insert(t.browserWorkers).values({ id: workerId, controlUrl: "http://127.0.0.1:9", maxBrowsers: 4 })
    await ctx.db.insert(t.browserProfiles).values({ id: "br-slot", name: "名额测试" })
    const taskId = await createTask(ctx.db, { modelId: "test/slot" })
    for (const id of ["R-S-1", "R-S-2"]) await ctx.db.insert(t.sessions).values({ id, taskId, status: "running", modelId: "test/slot", startedAt: new Date() })
    const deps = { db: ctx.db, keyring: () => ctx.keyring, gost: {} as GostPool, workerId }
    const open = (sessionId?: string) =>
      new BrowserInstance(deps, sessionId ? { kind: "session", profileId: "br-slot", sessionId, allowedDomains: [] } : { kind: "login", profileId: "br-slot", openedById: "u-wang", allowedDomains: [] })
    const first = open("R-S-1")
    await first.register("starting")
    // 人「打开 Chrome」开的不占
    await open().register("starting")
    expect(await profileSessionCount(ctx.db, "br-slot")).toBe(1)
    const error = await open("R-S-2").register("starting").catch((each: unknown) => each)
    expect(error).toBeInstanceOf(ProfileFullError)
    expect(error).toMatchObject({ profileName: "名额测试", message: "Chrome「名额测试」正在被别的运行用" })
    await ctx.db.transaction((tx) => suspendInTx(ctx.db, tx, { sessionId: "R-S-2", status: "waiting", what: "等待浏览器", triggerKind: "event", event: profileEventName("br-slot") }))
    // 占着时叫不醒
    expect(await wakeProfileWaiters(ctx.db, "br-slot")).toEqual([])
    // R-S-1 的 Chrome 关了（登记删掉）：R-S-2 被叫醒
    await ctx.db.delete(t.browserInstances).where(eq(t.browserInstances.id, first.id))
    expect(await wakeProfileWaiters(ctx.db, "br-slot")).toEqual(["R-S-2"])
    expect((await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, "R-S-2")))[0]!.status).toBe("running")
    await ctx.db.update(t.sessions).set({ status: "failed" }).where(eq(t.sessions.taskId, taskId))
    await ctx.db.delete(t.browserWorkers).where(eq(t.browserWorkers.id, workerId))
    await ctx.db.delete(t.browserProfiles).where(eq(t.browserProfiles.id, "br-slot"))
  })

  it("运行自动挑空闲的 Chrome，打开过就绝不换；全被占着挂起等任一个，空出来叫醒；browser.use 指定被占的就等那一个，分到后不能再换", async () => {
    // 这台机器没有 Chrome：挑中、登记成功后起 Chrome 会失败（「浏览器起不来」），够看出挑的是哪个。
    // 「打开过」的要 Chrome 起来过：1) 里把 BrowserInstance.start 换成什么都不做（之后连 MCP 时报「Chrome 还没起来」，Chrome 登记还开着）
    const workerId = "w-auto-test"
    await ctx.db.insert(t.browserWorkers).values({ id: workerId, controlUrl: "http://127.0.0.1:9", maxBrowsers: 4 })
    await ctx.db.insert(t.browserProfiles).values([
      { id: "br-auto-1", name: "自动一", position: 1 },
      { id: "br-auto-2", name: "自动二", position: 2 },
      { id: "br-auto-3", name: "不在任务里", position: 3 },
    ])
    const holderTask = await createTask(ctx.db, { modelId: "test/auto-holder" })
    for (const id of ["R-H-1", "R-H-2", "R-H-3", "R-H-4"]) await ctx.db.insert(t.sessions).values({ id, taskId: holderTask, status: "running", modelId: "test/auto-holder", startedAt: new Date() })
    // 别的运行占着某个 Chrome（直接登记一行，像别的 worker 上开着的）
    const occupy = async (id: string, profileId: string, sessionId: string) =>
      ctx.db.insert(t.browserInstances).values({ id, workerId, kind: "session", profileId, sessionId, state: "running" })
    const release = async (id: string) => ctx.db.delete(t.browserInstances).where(eq(t.browserInstances.id, id))
    const newTask = async (modelId: string) => {
      const taskId = await createTask(ctx.db, { modelId, toolIds: ["browser"] })
      await ctx.db.update(t.tasks).set({ browserProfileIds: ["br-auto-1", "br-auto-2"], allowedDomains: [] }).where(eq(t.tasks.id, taskId))
      return taskId
    }
    const run = async (taskId: string) => (await mutate(ctx.app, "engine.runNow", wang, { taskId })).data.sessionId as string
    const waitOf = async (sessionId: string) =>
      (await ctx.db.select().from(t.sessionWaits).where(and(eq(t.sessionWaits.sessionId, sessionId), eq(t.sessionWaits.status, "waiting"))))[0]

    // 1) 自动一被占着：运行 B 自动挑到自动二，不挂起；Chrome 起来了（MCP 没连上）
    const start = vi.spyOn(BrowserInstance.prototype, "start").mockResolvedValue(undefined)
    let b = ""
    await occupy("bw-auto-a", "br-auto-1", "R-H-1")
    const scriptB = useScript(
      "test/auto-b",
      new Script([
        step([call("browser.navigate", { url: "https://example.com/" })]),
        // B 已经打开过自动二。这时 Chrome 断了、自动一空出来、自动二被别的运行占了：B 不换，挂起等自动二
        async () => {
          await getBrowserManager()!.forSession(b)?.close({ writeBack: false, reason: "测试：Chrome 断了" })
          await release("bw-auto-a")
          await occupy("bw-auto-x", "br-auto-2", "R-H-4")
          return step([call("browser.navigate", { url: "https://example.com/" })])
        },
        step([text("结束")]),
      ])
    )
    b = await run(await newTask("test/auto-b"))
    await waitStatus(ctx.db, b, "waiting", 60_000)
    start.mockRestore()
    expect(scriptB.promptText(1)).toMatch(/浏览器起不来：Chrome 还没起来/)
    expect((await sessionRow(ctx.db, b))!.browserProfileId).toBe("br-auto-2")
    expect((await eventsOf(ctx.db, b)).filter((event) => event.title.includes("等待浏览器"))).toHaveLength(1)
    expect(await waitOf(b)).toMatchObject({ event: profileEventName("br-auto-2"), what: "等待浏览器：Chrome「自动二」正在被别的运行用" })
    // 自动一空着也叫不醒 B
    expect(await wakeProfileWaiters(ctx.db, "br-auto-1")).toEqual([])
    await release("bw-auto-x")
    await wakeProfileWaiters(ctx.db, "br-auto-2")
    await waitStatus(ctx.db, b, "done", 60_000)
    expect(scriptB.promptText(2)).toContain("Chrome「自动二」空出来了")
    expect((await sessionRow(ctx.db, b))!.browserProfileId).toBe("br-auto-2")
    // 系统提示：不再要求先 browser_use
    const systemB = JSON.stringify(scriptB.prompts[0]!.prompt[0])
    expect(systemB).toContain("自动分配一个空闲的")
    expect(systemB).not.toContain("先用 browser_use")

    // 2) 两个都被占着：运行 C 挂起等任一个
    await occupy("bw-auto-a", "br-auto-1", "R-H-1")
    await occupy("bw-auto-b", "br-auto-2", "R-H-2")
    const scriptC = useScript(
      "test/auto-c",
      new Script([step([call("browser.navigate", { url: "https://example.com/" })]), step([call("browser.navigate", { url: "https://example.com/" })]), step([text("结束")])])
    )
    const c = await run(await newTask("test/auto-c"))
    await waitStatus(ctx.db, c, "waiting", 60_000)
    expect(await waitOf(c)).toMatchObject({ event: ANY_PROFILE_EVENT, what: "等待浏览器：本任务允许的 2 个 Chrome 都在被别的运行用" })
    // 空出来的 Chrome 不在 C 允许的里面：不叫醒
    expect(await wakeProfileWaiters(ctx.db, "br-auto-3")).toEqual([])
    expect((await sessionRow(ctx.db, c))!.status).toBe("waiting")
    // 自动一空出来（A 的 Chrome 关了）：清扫时叫醒 C，C 先试空出来的自动一
    await release("bw-auto-a")
    await sweepLeases(ctx.db)
    await waitStatus(ctx.db, c, "done", 60_000)
    // 挂起前的工具结果和叫醒的消息在继续后的第一次调用里
    expect(scriptC.promptText(1)).toContain("都在被别的运行用")
    expect(scriptC.promptText(1)).toContain("Chrome「自动一」空出来了")
    expect(scriptC.promptText(2)).toMatch(/浏览器起不来/)
    // 自动一一次都没起来：不钉住（21.3 第 2 条），下次照第一次那样挑
    expect((await sessionRow(ctx.db, c))!.browserProfileId).toBeNull()

    // 3) agent 指定被占着的自动一：挂起只等它，自动二空着也不换；分到以后再指定别的被拒绝
    await release("bw-auto-b")
    await occupy("bw-auto-c", "br-auto-1", "R-H-3")
    const scriptD = useScript(
      "test/auto-d",
      new Script([
        step([call("browser.use", { profileId: "br-auto-1" })]),
        step([call("browser.navigate", { url: "https://example.com/" })]),
        step([call("browser.navigate", { url: "https://example.com/" })]),
        step([call("browser.use", { profileId: "br-auto-2" })]),
        step([call("browser.use", { profileId: "br-auto-1" })]),
        step([text("结束")]),
      ])
    )
    const d = await run(await newTask("test/auto-d"))
    await waitStatus(ctx.db, d, "waiting", 60_000)
    expect(await waitOf(d)).toMatchObject({ event: profileEventName("br-auto-1"), what: "等待浏览器：Chrome「自动一」正在被别的运行用" })
    expect((await sessionRow(ctx.db, d))!.browserProfileId).toBe("br-auto-1")
    expect(await wakeProfileWaiters(ctx.db, "br-auto-2")).toEqual([])
    await release("bw-auto-c")
    await wakeProfileWaiters(ctx.db, "br-auto-1")
    await waitStatus(ctx.db, d, "done", 60_000)
    expect(scriptD.promptText(2)).toContain("Chrome「自动一」空出来了")
    expect(scriptD.promptText(3)).toMatch(/浏览器起不来/)
    expect(scriptD.promptText(4)).toContain("一次运行只能用一个 Chrome：这次运行已经在用 Chrome「自动一」（br-auto-1），不能换成 br-auto-2")
    expect(scriptD.promptText(5)).toContain("这次运行已经在用 Chrome「自动一」")
    expect((await sessionRow(ctx.db, d))!.browserProfileId).toBe("br-auto-1")

    await ctx.db.update(t.sessions).set({ status: "failed" }).where(eq(t.sessions.taskId, holderTask))
    await ctx.db.delete(t.browserWorkers).where(eq(t.browserWorkers.id, workerId))
  })

  it("取消运行时正在起的 Chrome 马上停：起 Chrome 收到中止信号，不等启动超时；「已取消」后面没有工具结果", async () => {
    // 21.3 第 4 条：以前要等 30 秒启动超时，停掉以后还记一条「浏览器起不来」
    await ctx.db.insert(t.browserProfiles).values({ id: "br-stop-1", name: "停一" })
    let startSignal: AbortSignal | undefined
    let abortedAt = 0
    const start = vi.spyOn(BrowserInstance.prototype, "start").mockImplementation(async (signal?: AbortSignal) => {
      startSignal = signal
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 30_000)
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer)
            abortedAt = Date.now()
            reject(new ChromeStartAbortedError())
          },
          { once: true }
        )
      })
    })
    try {
      useScript("test/stop-chrome", new Script([step([call("browser.navigate", { url: "https://example.com/" })]), step([text("结束")])]))
      const taskId = await createTask(ctx.db, { modelId: "test/stop-chrome", toolIds: ["browser"] })
      await ctx.db.update(t.tasks).set({ browserProfileIds: ["br-stop-1"], allowedDomains: [] }).where(eq(t.tasks.id, taskId))
      const id = (await mutate(ctx.app, "engine.runNow", wang, { taskId })).data.sessionId as string
      await waitFor(async () => startSignal, { what: "开始起 Chrome", timeout: 60_000 })
      const cancelledAt = Date.now()
      await cancelSessionImpl(ctx.db, { sessionId: id, actorId: "u-wang", actorName: "王悦" })
      await waitFor(async () => abortedAt, { what: "起 Chrome 被中止", timeout: 5000 })
      expect(abortedAt - cancelledAt).toBeLessThan(3000)
      await waitFor(async () => !getBrowserManager()!.forSession(id), { what: "Chrome 登记关掉" })
      await new Promise((resolve) => setTimeout(resolve, 500))
      const events = await eventsOf(ctx.db, id)
      const cancelled = events.findIndex((event) => event.title === "已取消")
      expect(cancelled).toBeGreaterThan(-1)
      expect(events.slice(cancelled + 1).map((event) => event.title)).toEqual([])
      expect(events.some((event) => event.toolId === "browser.navigate")).toBe(false)
    } finally {
      start.mockRestore()
    }
  })

  it("Chrome 一次都没起来的不钉住：第一个起失败、被别的运行拿走，下次用另一个空闲的（不排队等它）", async () => {
    // 21.3 第 2 条：以前起失败也算分到了，第一个被别的运行拿走后这次运行一直等它，另一个空着也不用
    const workerId = "w-pick-test"
    await ctx.db.insert(t.browserWorkers).values({ id: workerId, controlUrl: "http://127.0.0.1:9", maxBrowsers: 4 })
    await ctx.db.insert(t.browserProfiles).values([
      { id: "br-pick-1", name: "挑一", position: 1 },
      { id: "br-pick-2", name: "挑二", position: 2 },
    ])
    const holderTask = await createTask(ctx.db, { modelId: "test/pick-holder" })
    await ctx.db.insert(t.sessions).values({ id: "R-P-1", taskId: holderTask, status: "running", modelId: "test/pick-holder", startedAt: new Date() })
    // 第一次起 Chrome 超时；之后的「起来了」（不起真 Chrome，连 MCP 时报「Chrome 还没起来」，算打开过）
    const tried: string[] = []
    const start = vi.spyOn(BrowserInstance.prototype, "start").mockImplementation(async function (this: BrowserInstance) {
      tried.push(this.profileId)
      if (tried.length === 1) throw new BrowserUnavailableError("Chrome 启动超时（30 秒，试了 2 次）：测试")
    })
    try {
      const script = useScript(
        "test/pick-e",
        new Script([
          step([call("browser.navigate", { url: "https://example.com/" })]),
          // 挑一起失败以后被别的运行拿走
          async () => {
            await ctx.db.insert(t.browserInstances).values({ id: "bw-pick-a", workerId, kind: "session", profileId: "br-pick-1", sessionId: "R-P-1", state: "running" })
            return step([call("browser.navigate", { url: "https://example.com/" })])
          },
          step([text("结束")]),
        ])
      )
      const taskId = await createTask(ctx.db, { modelId: "test/pick-e", toolIds: ["browser"] })
      await ctx.db.update(t.tasks).set({ browserProfileIds: ["br-pick-1", "br-pick-2"], allowedDomains: [] }).where(eq(t.tasks.id, taskId))
      const id = (await mutate(ctx.app, "engine.runNow", wang, { taskId })).data.sessionId as string
      await waitStatus(ctx.db, id, "done", 60_000)
      expect(script.promptText(1)).toContain("浏览器起不来：Chrome 启动超时")
      // 第二次没去等挑一，直接用空着的挑二
      expect(tried).toEqual(["br-pick-1", "br-pick-2"])
      expect(script.promptText(2)).not.toContain("正在被别的运行用")
      expect((await eventsOf(ctx.db, id)).some((event) => event.title.includes("等待浏览器"))).toBe(false)
      expect((await sessionRow(ctx.db, id))!.browserProfileId).toBe("br-pick-2")
    } finally {
      start.mockRestore()
      await ctx.db.update(t.sessions).set({ status: "failed" }).where(eq(t.sessions.taskId, holderTask))
      await ctx.db.delete(t.browserInstances).where(eq(t.browserInstances.id, "bw-pick-a"))
      await ctx.db.delete(t.browserWorkers).where(eq(t.browserWorkers.id, workerId))
    }
  })
})

describe("browser-router（没有 Chrome 时）", () => {
  it("live / sessionBrowser / openForLogin", async () => {
    const live = await query(ctx.app, "browser.live", wang)
    expect(live.data).toEqual([])
    const [session] = await ctx.db.select({ id: t.sessions.id }).from(t.sessions).limit(1)
    const sb = await query(ctx.app, "browser.sessionBrowser", wang, { sessionId: session!.id })
    expect(sb.data).toMatchObject({ open: false })
    // 测试里的 worker 登记了（随机端口），但这台机器没有 Chrome：打开登录报原因
    const opened = await mutate(ctx.app, "browser.openForLogin", wang, { profileId: "br-us" })
    expect(opened.error?.message).toMatch(/Chrome|Xvfb/)
    expect((await mutate(ctx.app, "browser.openForLogin", wang, { profileId: "br-nope" })).error?.data?.code).toBe("NOT_FOUND")
    expect((await mutate(ctx.app, "browser.close", wang, { browserId: "bw-nope" })).data).toEqual({})
    expect((await query(ctx.app, "browser.live")).status).toBe(401)
  })

  it("远程画面的 WebSocket：要登录，找不到的 Chrome 回 404，不信任的来源回 403", async () => {
    const server = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server
    await new Promise((resolve) => server.once("listening", resolve))
    attachBrowserViewRelay(server, { db: ctx.db, auth: ctx.auth, keyring: () => ctx.keyring, trustedOrigins: ["http://localhost:5180"] })
    const port = (server.address() as { port: number }).port
    const status = (headers: Record<string, string>, path = "/api/browser/view/bw-nope") =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0))
        ws.on("open", () => {
          ws.close()
          resolve(101)
        })
        ws.on("error", () => resolve(-1))
      })
    expect(await status({})).toBe(401)
    expect(await status({ cookie: wang })).toBe(404)
    expect(await status({ cookie: wang, origin: "http://evil.test" })).toBe(403)
    expect(await status({ cookie: wang }, "/api/other")).toBe(404)
    await new Promise((resolve) => server.close(resolve))
  })
})

describe("工具网关：浏览器工具组", () => {
  it("选了「浏览器」就开放 browser.use + MCP 工具；屏蔽 run_code_unsafe；evaluate 看任务设置；没有 Chrome 时报原因", async () => {
    const script = useScript(
      "test/browser-tools",
      new Script([
        step([call("browser.use", { profileId: "br-nope" })]),
        step([call("browser.navigate", { url: "https://blocked.test/" })]),
        step([call("browser.navigate", { url: "https://example.com/" })]),
        step([text("浏览器用不了，结束")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/browser-tools", toolIds: ["browser"] })
    await ctx.db.update(t.tasks).set({ browserProfileIds: ["br-us"], allowedDomains: ["example.com"] }).where(eq(t.tasks.id, taskId))
    const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
    const sessionId = res.data.sessionId as string
    await waitStatus(ctx.db, sessionId, "done", 60_000)
    const names = (script.prompts[0]!.tools ?? []).map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(["browser_use", "browser_fill_captcha", "browser_navigate", "browser_snapshot", "browser_click", "browser_file_upload"]))
    expect(names).not.toContain("browser_run_code_unsafe")
    expect(names).not.toContain("browser_evaluate")
    // 剪贴板工具选了浏览器就有；看画面（browser_look + 坐标工具）要开关
    expect(names).toEqual(expect.arrayContaining(["browser_copy_image", "browser_clipboard_read", "browser_clipboard_paste"]))
    for (const name of ["browser_look", "browser_mouse_click_xy", "browser_mouse_move_xy", "browser_mouse_drag_xy", "browser_mouse_down", "browser_mouse_up", "browser_mouse_wheel"])
      expect(names).not.toContain(name)
    const copySchema = JSON.stringify(script.prompts[0]!.tools!.find((tool) => tool.name === "browser_copy_image"))
    expect(copySchema).toContain("target")
    expect(copySchema).not.toContain('"x"')
    const system = JSON.stringify(script.prompts[0]!.prompt[0])
    expect(system).toContain("browser_clipboard_read（copy: true）")
    expect(system).toContain("browser_copy_image")
    expect(system).not.toContain("browser_look")
    expect(system).toContain("## 浏览器")
    expect(system).toContain("depth")
    expect(system).toContain("example.com")
    expect(system).toContain("browser_fill_captcha")
    expect(script.promptText(1)).toContain("不允许用 Chrome 配置 br-nope")
    // 只允许一个 Chrome 配置：自动选上；白名单在调工具前就拦下
    expect(script.promptText(2)).toContain("blocked.test 不在本任务的网址白名单里")
    // 这台机器没有 Chrome：报原因，不崩
    expect(script.promptText(3)).toMatch(/浏览器起不来：.*(Chrome|Xvfb)/)
    // Chrome 一次都没起来：不算分到（21.3 第 2 条）
    const [session] = await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, sessionId))
    expect(session!.browserProfileId).toBeNull()
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.some((event) => event.toolId === "browser.navigate")).toBe(true)

    await ctx.db.update(t.tasks).set({ allowBrowserEvaluate: true, allowBrowserVision: true }).where(eq(t.tasks.id, taskId))
    const script2 = useScript("test/browser-tools2", new Script([step([text("好")])]))
    await ctx.db.update(t.tasks).set({ modelId: "test/browser-tools2" }).where(eq(t.tasks.id, taskId))
    // 关掉「遇到验证码先自己试着过」：没有填验证码的工具，系统提示里也不提
    const lin = await login(ctx.app, "linzhou@heyagent.local")
    const browserSettings = { maxPerWorker: 4, visionCheck: false, visionModel: "openrouter/qwen/qwen3.8-flash", humanHoldMinutes: 30 }
    expect((await mutate(ctx.app, "settings.updateBrowser", lin, { ...browserSettings, captchaSolve: false })).error).toBeUndefined()
    const res2 = await mutate(ctx.app, "engine.runNow", wang, { taskId })
    await waitStatus(ctx.db, res2.data.sessionId, "done", 60_000)
    await mutate(ctx.app, "settings.updateBrowser", lin, { ...browserSettings, captchaSolve: true })
    const names2 = (script2.prompts[0]!.tools ?? []).map((tool) => tool.name)
    expect(names2).toContain("browser_evaluate")
    expect(names2).toContain("browser_use")
    expect(names2).not.toContain("browser_fill_captcha")
    expect(JSON.stringify(script2.prompts[0]!.prompt[0])).not.toContain("fill_captcha")
    // 开了看画面：browser_look、坐标工具；复制图片可以给坐标；系统提示说什么时候看
    expect(names2).toEqual(expect.arrayContaining(["browser_look", "browser_mouse_click_xy", "browser_mouse_drag_xy", "browser_mouse_wheel", "browser_copy_image"]))
    expect(JSON.stringify(script2.prompts[0]!.tools!.find((tool) => tool.name === "browser_copy_image"))).toContain('"x"')
    expect(JSON.stringify(script2.prompts[0]!.prompt[0])).toContain("browser_look 截当前画面")
  })
})
