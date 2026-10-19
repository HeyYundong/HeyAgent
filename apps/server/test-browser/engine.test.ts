// 真浏览器 + 假模型走完整的引擎：账号租约排队和释放、验证码 → 等人 → 处理完在同一个 Chrome 里继续、白名单拦截、文件上传、截图存档。
import { and, eq } from "drizzle-orm"
import { describeCompiledRule, type CompiledRule } from "@heyagent/shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { BrowserManager } from "../src/browser/manager.js"
import * as t from "../src/db/schema.js"
import { saveFile } from "../src/files/service.js"
import { call, createTask, eventsOf, Script, sessionRow, setupEngine, step, text, useScript, waitFor, waitStatus, type CallOptions, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate, query } from "../test/helpers.js"
import { createAccount, createProfile, startSite, TEXTCAP_CODE, type TestSite } from "./fixtures.js"

let ctx: EngineTestContext
let site: TestSite
let manager: BrowserManager
let wang: string
let profileId: string

async function browserTask(modelId: string, extra: { allowedDomains?: string[] } = {}) {
  const taskId = await createTask(ctx.db, { modelId, toolIds: ["browser"], ownerId: "u-wang" })
  await ctx.db
    .update(t.tasks)
    .set({ browserProfileIds: [profileId], allowedDomains: extra.allowedDomains ?? [] })
    .where(eq(t.tasks.id, taskId))
  return taskId
}

async function runNow(taskId: string, extra: Record<string, unknown> = {}) {
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId, ...extra })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  return res.data.sessionId as string
}

/** 这个文件里「遇到验证码先自己试着过」默认关着（验证码转人工的测试照旧）；「自动过验证码」一组自己打开 */
const BROWSER_SETTINGS = { maxPerWorker: 4, visionCheck: false, visionModel: "openrouter/qwen/qwen3.8-flash", captchaSolve: false, humanHoldMinutes: 30 }
async function browserSettings(patch: Partial<typeof BROWSER_SETTINGS> = {}) {
  const res = await mutate(ctx.app, "settings.updateBrowser", await login(ctx.app, "linzhou@heyagent.local"), { ...BROWSER_SETTINGS, ...patch })
  if (res.error) throw new Error(JSON.stringify(res.error))
}

beforeAll(async () => {
  ctx = await setupEngine()
  manager = ctx.worker.browser!
  site = await startSite()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  profileId = await createProfile(ctx.db, ctx.keyring)
  await browserSettings()
})

afterAll(async () => {
  await ctx?.stop()
  await site?.close()
})

describe("账号租约", () => {
  it("同一个账号上限 1：第二个 session 打开平台网址时被拦下、挂起「等待浏览器」；第一个结束释放后叫醒它，接着做完", async () => {
    const domain = "lease.localhost"
    const accountId = await createAccount(ctx.db, { profileId, domain, maxConcurrent: 1 })
    let releaseFirst!: () => void
    const firstMayFinish = new Promise<void>((resolve) => (releaseFirst = resolve))
    useScript(
      "test/lease-a",
      new Script([
        step([call("browser.navigate", { url: site.url(domain, "/") })]),
        async () => {
          await firstMayFinish
          return step([text("A 做完了")])
        },
      ])
    )
    const scriptB = useScript(
      "test/lease-b",
      new Script([
        step([call("browser.navigate", { url: site.url(domain, "/") })]),
        step([call("browser.navigate", { url: site.url(domain, "/hello") })]),
        step([text("B 做完了")]),
      ])
    )
    const a = await runNow(await browserTask("test/lease-a"))
    await waitFor(async () => (await ctx.db.select().from(t.accountLeases).where(and(eq(t.accountLeases.accountId, accountId), eq(t.accountLeases.sessionId, a))))[0], { what: "A 拿到租约", timeout: 60_000 })
    const b = await runNow(await browserTask("test/lease-b"))
    const waiting = await waitStatus(ctx.db, b, "waiting", 60_000)
    expect(waiting.status).toBe("waiting")
    const run = await query(ctx.app, "sessions.get", wang, { id: b })
    expect(run.data.waiting.what).toContain("等待浏览器")
    expect(scriptB.promptText(1)).toBe("[]")
    const usage = await query(ctx.app, "browser.accountStatus", wang)
    expect(usage.data.find((each: { accountId: string }) => each.accountId === accountId)).toMatchObject({ used: 1, max: 1, sessionIds: [a], waiting: 1 })
    // B 挂起时关掉了自己的 Chrome
    await waitFor(async () => !manager.forSession(b), { what: "B 的 Chrome 关掉" })
    releaseFirst()
    await waitStatus(ctx.db, a, "done", 60_000)
    await waitStatus(ctx.db, b, "done", 90_000)
    expect(scriptB.promptText(1)).toContain("等到浏览器了")
    const events = await eventsOf(ctx.db, b)
    expect(events.some((event) => event.kind === "resume" && event.title.includes("等到浏览器"))).toBe(true)
    // M3 起先关资源（写回、关 Chrome、释放租约）再写「已完成」：读到「已完成」时租约已经都释放了
    const leases = await ctx.db.select().from(t.accountLeases).where(eq(t.accountLeases.accountId, accountId))
    expect(leases.every((lease) => lease.releasedAt)).toBe(true)
    expect(leases.map((lease) => lease.sessionId).sort()).toEqual([a, b].sort())
  })
})

describe("验证码", () => {
  it("没开「先自己试着过」：命中 → 截图、生成「登录」类要人办的事、等人处理，Chrome 保留；人处理好点「已处理好了」→ 同一个 Chrome 接着做", async () => {
    const seen: (string | undefined)[] = []
    let sessionId = ""
    const script = useScript(
      "test/captcha",
      new Script([
        step([call("browser.navigate", { url: site.url("cap.localhost", "/captcha") })]),
        () => {
          seen.push(manager.forSession(sessionId)?.id)
          return step([call("browser.snapshot", { depth: 6 })])
        },
        step([text("拿到暗号了")]),
      ])
    )
    sessionId = await runNow(await browserTask("test/captcha"))
    await waitStatus(ctx.db, sessionId, "needs_human", 60_000)
    const [item] = await ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open")))
    expect(item).toMatchObject({ kind: "login", assigneeId: "u-wang" })
    const detail = item!.detail
    expect(detail.browser).toMatchObject({ sessionId, profileId, url: site.url("cap.localhost", "/captcha") })
    expect(detail.browser!.reason).toMatch(/验证/)
    expect(detail.browser!.screenshotFileId).toMatch(/^f-/)
    const browserId = detail.browser!.browserId
    // Chrome 保留着：状态 held，远程画面能找到它
    await waitFor(async () => (await ctx.db.select().from(t.browserInstances).where(eq(t.browserInstances.id, browserId)))[0]?.state === "held", { what: "Chrome 保留" })
    const sb = await query(ctx.app, "browser.sessionBrowser", wang, { sessionId })
    expect(sb.data).toMatchObject({ open: true, browserId, state: "held", canControl: true })
    const li = await login(ctx.app, "lijing@heyagent.local")
    expect((await query(ctx.app, "browser.sessionBrowser", li, { sessionId })).data.canControl).toBe(false)
    const toolEvent = (await eventsOf(ctx.db, sessionId)).find((event) => event.toolId === "browser.navigate")
    expect(toolEvent?.output).toContain("检测到验证码")
    // 「遇到验证码先自己试着过」关着：不试，直接交给人
    expect((await eventsOf(ctx.db, sessionId)).some((event) => event.title.includes("自动过验证码"))).toBe(false)
    expect(detail.sections[0]!.text).not.toContain("自动过验证码")
    const shots = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "screenshot")))
    expect(shots.length).toBeGreaterThanOrEqual(1)

    // 人在远程画面里点了按钮（这里直接用编排器连接点；远程画面的输入在 viewer.test.ts 测）
    const instance = manager.get(browserId)!
    const page = instance.currentPage()!
    await Promise.all([page.waitForURL(/\/secret/), page.click("#human")])
    const resolved = await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item!.id, how: "done", note: "点过了" })
    expect(resolved.data).toMatchObject({ resumedSessionId: sessionId })
    await waitStatus(ctx.db, sessionId, "done", 60_000)
    expect(seen).toEqual([browserId])
    expect(script.promptText(1)).toContain("检测到验证码")
    expect(script.promptText(2)).toContain("暗号：蓝色海豚")
    // 结束后 Chrome 关掉、登记删掉
    await waitFor(async () => (await ctx.db.select().from(t.browserInstances).where(eq(t.browserInstances.id, browserId))).length === 0, { what: "登记删掉" })
    expect(manager.get(browserId)).toBeUndefined()
  })
})

describe("白名单、文件上传、截图", () => {
  it("调工具前拦下白名单外的导航；点链接跳到白名单外也在浏览器层拦下；上传 session 文件；截图存成文件", async () => {
    const blockedUrl = site.url("blocked.localhost", "/")
    const upload = await saveFile(ctx.db, { data: Buffer.from("hello-upload"), name: "note.txt", kind: "upload" })
    const script = useScript(
      "test/allow",
      new Script([
        step([call("browser.navigate", { url: blockedUrl })]),
        step([call("browser.navigate", { url: site.url("127.0.0.1", `/links?bad=${encodeURIComponent(blockedUrl)}`) })]),
        step([call("browser.click", { element: "外站链接", target: "#bad" })]),
        step([call("browser.navigate", { url: site.url("127.0.0.1", "/upload") })]),
        step([call("browser.click", { element: "选文件", target: "#file" })]),
        step([call("browser.file_upload", { fileIds: [upload.id] })]),
        step([call("browser.take_screenshot", {})]),
        step([call("browser.snapshot", { depth: 4 })]),
        step([text("做完了")]),
      ])
    )
    const sessionId = await runNow(await browserTask("test/allow", { allowedDomains: ["127.0.0.1"] }), { attachmentFileIds: [upload.id] })
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    expect(script.promptText(1)).toContain("blocked.localhost 不在本任务的网址白名单里")
    expect(script.promptText(2)).toContain("已自动截图存档")
    expect(script.promptText(3)).toContain("被拦下：blocked.localhost 不在本任务的网址白名单里")
    expect(site.requests.some((request) => request.host === "blocked.localhost")).toBe(false)
    expect(script.promptText(7)).toMatch(/截图已存为这次运行的文件 f-/)
    expect(script.promptText(8)).toContain("选了 note.txt 内容 hello-upload")
    const shots = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "screenshot")))
    expect(shots.length).toBeGreaterThanOrEqual(3)
    const row = await sessionRow(ctx.db, sessionId)
    expect(row?.browserProfileId).toBe(profileId)
    // M3 起先关 Chrome、写好过程记录，再写「已完成」：读到「已完成」时「关掉了 Chrome」已经在，而且在完成事件前面
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.some((event) => event.title.startsWith("打开了 Chrome"))).toBe(true)
    const closedAt = events.findIndex((event) => event.title.startsWith("关掉了 Chrome"))
    expect(closedAt).toBeGreaterThan(0)
    expect(closedAt).toBeLessThan(events.findIndex((event) => event.kind === "done"))
  })
})

describe("保留时间到了、worker 的 Chrome 满了", () => {
  it("等人处理超过保留时间：写回、关掉 Chrome，session 继续等人；人处理好后继续时新起一个 Chrome", async () => {
    let sessionId = ""
    const seen: (string | undefined)[] = []
    useScript(
      "test/hold-expire",
      new Script([
        step([call("browser.navigate", { url: site.url("hold.localhost", "/captcha") })]),
        () => {
          seen.push(manager.forSession(sessionId)?.id)
          return step([call("browser.navigate", { url: site.url("hold.localhost", "/hello") })])
        },
        step([text("好了")]),
      ])
    )
    sessionId = await runNow(await browserTask("test/hold-expire"))
    await waitStatus(ctx.db, sessionId, "needs_human", 60_000)
    const held = await waitFor(async () => {
      const instance = manager.forSession(sessionId)
      return instance?.state === "held" && instance
    }, { what: "Chrome 保留" })
    const firstId = held.id
    // 模拟保留时间到了
    held.holdUntil = new Date(Date.now() - 1000)
    await manager.sweep()
    expect(manager.get(firstId)).toBeUndefined()
    expect((await sessionRow(ctx.db, sessionId))?.status).toBe("needs_human")
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.some((event) => event.title.includes("保留时间到了"))).toBe(true)
    expect((await query(ctx.app, "browser.sessionBrowser", wang, { sessionId })).data.open).toBe(false)
    const [item] = await ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open")))
    await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item!.id, how: "done" })
    await waitStatus(ctx.db, sessionId, "done", 60_000)
    expect(seen).toEqual([undefined])
  })

  it("每个 worker 最多 N 个 Chrome：满了排队（「等待浏览器」），空出来后接着起", async () => {
    await browserSettings({ maxPerWorker: 1 })
    const opened = await mutate(ctx.app, "browser.openForLogin", wang, { profileId })
    expect(opened.error).toBeUndefined()
    // 满了：再开一个登录 Chrome 直接报满
    expect((await mutate(ctx.app, "browser.openForLogin", wang, { profileId })).error?.data?.code).toBe("CONFLICT")
    useScript(
      "test/slots",
      new Script([step([call("browser.navigate", { url: site.url("127.0.0.1", "/hello") })]), step([text("排到了")])])
    )
    const sessionId = await runNow(await browserTask("test/slots"))
    await waitFor(async () => (await eventsOf(ctx.db, sessionId)).some((event) => event.title === "等待浏览器"), { what: "排队事件", timeout: 60_000 })
    const live = await query(ctx.app, "browser.live", wang)
    expect(live.data.find((each: { sessionId?: string }) => each.sessionId === sessionId)).toMatchObject({ state: "queued" })
    await mutate(ctx.app, "browser.close", wang, { browserId: opened.data.browserId })
    await waitStatus(ctx.db, sessionId, "done", 60_000)
    await browserSettings()
  })
})

describe("视觉判断", () => {
  it("规则拿不准（只有密码框）时：打开了 visionCheck 就让视觉模型看截图，判断是登录页就转人工；花费算进这次运行", async () => {
    await browserSettings({ visionCheck: true })
    const vision = useScript("openrouter/qwen/qwen3.8-flash", new Script([step([text('{"captcha": false, "login": true, "reason": "页面要求输入密码"}')], 0.0002)]))
    useScript("test/vision", new Script([step([call("browser.navigate", { url: site.url("127.0.0.1", "/pw") })])]))
    const sessionId = await runNow(await browserTask("test/vision"))
    await waitStatus(ctx.db, sessionId, "needs_human", 60_000)
    expect(vision.prompts).toHaveLength(1)
    expect(vision.promptText(0)).toContain("image/jpeg")
    const [item] = await ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open")))
    expect(item!.detail.browser!.reason).toContain("视觉模型判断是登录页")
    expect((await sessionRow(ctx.db, sessionId))!.costUsd).toBeCloseTo(0.0012, 6)
    await mutate(ctx.app, "engine.cancel", wang, { sessionId })
    await browserSettings()
    // 取消后保留着的 Chrome 在清扫时关掉
    await manager.sweep()
    expect(manager.forSession(sessionId)).toBeUndefined()
  })
})

describe("M3 规则（真浏览器）", () => {
  it("打开网页后自动记访问检查点；遇到验证码：内置转人工照常，规则另外截图、通知别人", async () => {
    useScript(
      "test/m3-browser",
      new Script([
        step([call("browser.navigate", { url: site.url("127.0.0.1", "/upload") })]),
        step([call("browser.navigate", { url: site.url("127.0.0.1", "/links?bad=x") })]),
        // 换一个域名：cap.localhost 在前面的验证码测试里已经过了验证（cookie 写回了保险箱）
        step([call("browser.navigate", { url: site.url("cap-m3.localhost", "/captcha") })]),
        step([text("做完了")]),
      ])
    )
    const taskId = await browserTask("test/m3-browser")
    await ctx.db.update(t.tasks).set({ steps: [{ id: "s1", text: "看两个页面", wait: false, checkpoint: "访问 2 个页面" }] }).where(eq(t.tasks.id, taskId))
    const rules: [string, Pick<CompiledRule, "trigger" | "actions">][] = [
      ["rl-m3b-sync", { trigger: { type: "after_tool", toolIds: [], anyTool: true }, actions: [{ type: "sync_checkpoint" }] }],
      ["rl-m3b-page", { trigger: { type: "page_needs_human" }, actions: [{ type: "screenshot" }, { type: "notify", recipient: { to: "user", userId: "u-li" } }] }],
    ]
    for (const [position, [id, shape]] of rules.entries()) {
      await ctx.db.insert(t.rules).values({ id, name: id, trigger: "测试", action: "测试", compiledTrigger: { v: 1, ...shape, understood: describeCompiledRule(shape) } })
      await ctx.db.insert(t.taskRules).values({ taskId, refId: id, position })
    }
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "needs_human", 90_000)
    const run = (await query(ctx.app, "sessions.get", wang, { id: sessionId })).data
    // 打开了 3 个不同的网页（验证码页也算打开过），目标 2 个，自动标完成
    expect(run.checkpoints[0]).toMatchObject({ kind: "visit", target: 2, progress: 3, status: "done" })
    expect(run.checkpoints[0].records.every((record: { synced: boolean }) => record.synced)).toBe(true)
    expect(run.checkpoints[0].records[0].text).toContain("/upload")
    const titles = run.events.map((event: { title: string }) => event.title)
    expect(titles).toEqual(expect.arrayContaining(["规则「rl-m3b-page」：页面出现验证码或登录页", "规则「rl-m3b-page」：截图存证", "规则「rl-m3b-page」：通知李静"]))
    const [item] = await ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open")))
    expect(item).toMatchObject({ kind: "login", assigneeId: "u-wang" })
    const notes = await ctx.db.select().from(t.notifications).where(and(eq(t.notifications.sessionId, sessionId), eq(t.notifications.userId, "u-li")))
    expect(notes).toHaveLength(1)
    await mutate(ctx.app, "engine.cancel", wang, { sessionId })
    await manager.sweep()
  })
})

describe("自动过验证码", () => {
  const VISION = "openrouter/test/captcha-vision"

  /** 假视觉模型：从提示里的元素列表找验证码输入框和提交按钮（click：找「我不是机器人」按钮），照 answer 回答 */
  const reply = (answer: string, costUsd = 0.0003) => (options: CallOptions) => {
    const prompt = JSON.stringify(options.prompt)
    if (answer === "click") return step([text(JSON.stringify({ type: "click", target: Number(/#(\d+) 按钮 <button> 「我不是机器人/.exec(prompt)?.[1]) }))], costUsd)
    if (answer === "other") return step([text('{"type": "other", "reason": "要拖滑块"}')], costUsd)
    const input = Number(/#(\d+) 输入框 <input> 「验证码/.exec(prompt)?.[1])
    const submit = Number(/#(\d+) 按钮 <button> 「提交/.exec(prompt)?.[1])
    return step([text(JSON.stringify({ type: "text", image: 1, input, answer, submit }))], costUsd)
  }
  const tries = async (sessionId: string) => (await eventsOf(ctx.db, sessionId)).filter((event) => event.title.includes("自动过验证码"))
  const openItems = (sessionId: string) => ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open")))

  beforeAll(async () => {
    await ctx.db.insert(t.models).values({ id: VISION, providerId: "openrouter", name: "测试视觉模型", contextK: 128, vision: true }).onConflictDoNothing()
    await browserSettings({ captchaSolve: true, visionModel: VISION })
  })
  afterAll(async () => {
    await browserSettings()
  })

  it("图片字符：视觉模型认出来、填好提交，第一次就过了 → 不交给人，接着做；记一条过程，花费算进运行", async () => {
    const vision = useScript(VISION, new Script([reply(TEXTCAP_CODE)]))
    const script = useScript(
      "test/cap-text",
      new Script([step([call("browser.navigate", { url: site.url("tcap.localhost", "/textcap") })]), step([call("browser.snapshot", { depth: 6 })]), step([text("拿到暗号了")])])
    )
    const sessionId = await runNow(await browserTask("test/cap-text"))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    expect(vision.prompts).toHaveLength(1)
    // 页面截图 + 验证码小图的放大图
    expect(vision.promptText(0)).toContain("image/jpeg")
    expect(vision.promptText(0)).toContain("image/png")
    expect(script.promptText(1)).toContain("已自动过了")
    expect(script.promptText(1)).toContain(TEXTCAP_CODE)
    expect(script.promptText(2)).toContain("暗号：蓝色海豚")
    expect(await openItems(sessionId)).toHaveLength(0)
    const events = await tries(sessionId)
    expect(events.map((event) => event.title)).toEqual(["自动过验证码（第 1 次）：过了"])
    expect(events[0]!.detail).toContain(`认出验证码 ${TEXTCAP_CODE}`)
    expect(events[0]!.output).toContain("0.000300")
    expect((await sessionRow(ctx.db, sessionId))!.costUsd).toBeGreaterThanOrEqual(0.0033 - 1e-9)
  })

  it("「我不是机器人」按钮：点一下就过了", async () => {
    const vision = useScript(VISION, new Script([reply("click")]))
    const script = useScript(
      "test/cap-click",
      new Script([step([call("browser.navigate", { url: site.url("ccap.localhost", "/captcha") })]), step([call("browser.snapshot", { depth: 6 })]), step([text("好了")])])
    )
    const sessionId = await runNow(await browserTask("test/cap-click"))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    expect(vision.prompts).toHaveLength(1)
    expect(script.promptText(1)).toContain("已自动过了")
    expect(script.promptText(2)).toContain("暗号：蓝色海豚")
    const events = await tries(sessionId)
    expect(events.map((event) => event.title)).toEqual(["自动过验证码（第 1 次）：过了"])
    expect(events[0]!.detail).toContain("我不是机器人")
  })

  it("认错 3 次 → 照旧交给人（卡片上写自动过验证码没成功），花费都算进运行", async () => {
    const vision = useScript(VISION, new Script([reply("0000"), reply("0000"), reply("0000")]))
    useScript("test/cap-wrong", new Script([step([call("browser.navigate", { url: site.url("wcap.localhost", "/textcap") })])]))
    const sessionId = await runNow(await browserTask("test/cap-wrong"))
    await waitStatus(ctx.db, sessionId, "needs_human", 90_000)
    expect(vision.prompts).toHaveLength(3)
    expect((await tries(sessionId)).map((event) => event.title)).toEqual(["自动过验证码（第 1 次）：没过", "自动过验证码（第 2 次）：没过", "自动过验证码（第 3 次）：没过"])
    const [item] = await openItems(sessionId)
    expect(item).toMatchObject({ kind: "login", assigneeId: "u-wang" })
    expect(item!.detail.sections[0]!.text).toContain("自动过验证码没成功")
    expect(item!.detail.sections[0]!.text).toContain("系统过不了这个验证码")
    expect((await sessionRow(ctx.db, sessionId))!.costUsd).toBeGreaterThanOrEqual(0.001 + 0.0009 - 1e-9)
    await mutate(ctx.app, "engine.cancel", wang, { sessionId })
    await manager.sweep()
  })

  it("不是简单验证码（模型说要拖滑块）：试一次就交给人", async () => {
    const vision = useScript(VISION, new Script([reply("other")]))
    useScript("test/cap-other", new Script([step([call("browser.navigate", { url: site.url("ocap.localhost", "/captcha") })])]))
    const sessionId = await runNow(await browserTask("test/cap-other"))
    await waitStatus(ctx.db, sessionId, "needs_human", 90_000)
    expect(vision.prompts).toHaveLength(1)
    const [item] = await openItems(sessionId)
    expect(item!.detail.sections[0]!.text).toContain("要拖滑块")
    await mutate(ctx.app, "engine.cancel", wang, { sessionId })
    await manager.sweep()
  })

  it("验证码在表单里：不自己提交，让 agent 先填别的，再调 browser_fill_captcha 填验证码、自己提交", async () => {
    const vision = useScript(VISION, new Script([reply(TEXTCAP_CODE)]))
    const script = useScript(
      "test/cap-form",
      new Script([
        step([call("browser.navigate", { url: site.url("fcap.localhost", "/query") })]),
        step([call("browser.type", { element: "单号", target: "#q", text: "A123" })]),
        step([call("browser.fill_captcha", {})]),
        step([call("browser.click", { element: "提交", target: "#submit" })]),
        step([call("browser.snapshot", { depth: 6 })]),
        step([text("查到了")]),
      ])
    )
    const sessionId = await runNow(await browserTask("test/cap-form"))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    expect(script.promptText(1)).toContain("browser_fill_captcha")
    // 填别的项时不问模型、不交给人
    expect(script.promptText(2)).not.toContain("已交给负责人")
    expect(script.promptText(3)).toContain(`认出验证码 ${TEXTCAP_CODE}`)
    expect(script.promptText(5)).toContain("查询结果：A123")
    expect(vision.prompts).toHaveLength(1)
    expect((await tries(sessionId)).map((event) => event.title)).toEqual(["自动过验证码（第 1 次）：填好了"])
    expect(await openItems(sessionId)).toHaveLength(0)
  })
})
