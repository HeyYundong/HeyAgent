// 真浏览器 + 假模型走完整的引擎：账号租约排队和释放、验证码 → 等人 → 处理完在同一个 Chrome 里继续、白名单拦截、文件上传、截图存档。
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { BrowserManager } from "../src/browser/manager.js"
import * as t from "../src/db/schema.js"
import { saveFile } from "../src/files/service.js"
import { call, createTask, eventsOf, Script, sessionRow, setupEngine, step, text, useScript, waitFor, waitStatus, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate, query } from "../test/helpers.js"
import { createAccount, createProfile, startSite, type TestSite } from "./fixtures.js"

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

beforeAll(async () => {
  ctx = await setupEngine()
  manager = ctx.worker.browser!
  site = await startSite()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  profileId = await createProfile(ctx.db, ctx.keyring)
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
    // 「已完成」之后 gateway 关闭时写回、关 Chrome、释放租约
    const leases = await waitFor(
      async () => {
        const rows = await ctx.db.select().from(t.accountLeases).where(eq(t.accountLeases.accountId, accountId))
        return rows.every((lease) => lease.releasedAt) && rows
      },
      { what: "租约都释放" }
    )
    expect(leases.map((lease) => lease.sessionId).sort()).toEqual([a, b].sort())
  })
})

describe("验证码", () => {
  it("命中 → 截图、生成「登录」类要人办的事、等人处理，Chrome 保留；人处理好点「已处理好了」→ 同一个 Chrome 接着做", async () => {
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
    // session 先标「已完成」，Chrome 是在引擎收尾（gateway.close）时才关的，「关掉了 Chrome」这条过程记录会晚一点写进来
    const events = await waitFor(
      async () => {
        const all = await eventsOf(ctx.db, sessionId)
        return all.some((event) => event.title.startsWith("关掉了 Chrome")) ? all : undefined
      },
      { what: "「关掉了 Chrome」的过程记录" }
    )
    expect(events.some((event) => event.title.startsWith("打开了 Chrome"))).toBe(true)
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
    await mutate(ctx.app, "settings.updateBrowser", await login(ctx.app, "linzhou@heyagent.local"), { maxPerWorker: 1, visionCheck: false, humanHoldMinutes: 30 })
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
    await mutate(ctx.app, "settings.updateBrowser", await login(ctx.app, "linzhou@heyagent.local"), { maxPerWorker: 4, visionCheck: false, humanHoldMinutes: 30 })
  })
})

describe("视觉判断", () => {
  it("规则拿不准（只有密码框）时：打开了 visionCheck 就让视觉模型看截图，判断是登录页就转人工；花费算进这次运行", async () => {
    const lin = await login(ctx.app, "linzhou@heyagent.local")
    await mutate(ctx.app, "settings.updateBrowser", lin, { maxPerWorker: 4, visionCheck: true, humanHoldMinutes: 30 })
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
    await mutate(ctx.app, "settings.updateBrowser", lin, { maxPerWorker: 4, visionCheck: false, humanHoldMinutes: 30 })
    // 取消后保留着的 Chrome 在清扫时关掉
    await manager.sweep()
    expect(manager.forSession(sessionId)).toBeUndefined()
  })
})
