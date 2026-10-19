// 真浏览器：远程画面经 API 转发（GET /api/browser/view/:browserId）：帧、鼠标键盘、中文、弹框、权限（没权限的输入被丢弃）、关闭；
// agent（经 MCP）操作时的虚拟光标：位置、按下前的停顿、打字跟到输入框、换标签页、人自己的操作不算、网页里什么都没插。
import type { Server } from "node:http"

import { serve } from "@hono/node-server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"

import type { BrowserManager } from "../src/browser/manager.js"
import { PRESS_DELAY_MS } from "../src/browser/cdp-tap.js"
import { attachBrowserViewRelay } from "../src/browser/view-relay.js"
import { setupEngine, waitFor, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate, query } from "../test/helpers.js"
import { createProfile, startSite, type TestSite } from "./fixtures.js"

interface Client {
  ws: WebSocket
  json: Record<string, unknown>[]
  frames: Buffer[]
  send(message: unknown): void
}

let ctx: EngineTestContext
let site: TestSite
let manager: BrowserManager
let server: Server
let port: number

async function connect(browserId: string, cookie: string): Promise<Client> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/browser/view/${browserId}`, { headers: { cookie } })
  const client: Client = { ws, json: [], frames: [], send: (message) => ws.send(JSON.stringify(message)) }
  ws.on("message", (data, isBinary) => {
    if (isBinary) client.frames.push(data as Buffer)
    else client.json.push(JSON.parse(String(data)) as Record<string, unknown>)
  })
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve())
    ws.once("error", reject)
    ws.once("unexpected-response", (_req, res) => reject(new Error(`升级失败 ${res.statusCode}`)))
  })
  return client
}

beforeAll(async () => {
  ctx = await setupEngine()
  manager = ctx.worker.browser!
  site = await startSite()
  server = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server
  await new Promise((resolve) => server.once("listening", resolve))
  attachBrowserViewRelay(server, { db: ctx.db, auth: ctx.auth, keyring: () => ctx.keyring, trustedOrigins: [] })
  port = (server.address() as { port: number }).port
})

afterAll(async () => {
  await new Promise((resolve) => server?.close(resolve))
  await ctx?.stop()
  await site?.close()
})

describe("远程画面", () => {
  it("帧、输入（鼠标、键盘、中文）、弹框、权限、关闭", async () => {
    const wang = await login(ctx.app, "wangyue@heyagent.local")
    const li = await login(ctx.app, "lijing@heyagent.local")
    const profileId = await createProfile(ctx.db, ctx.keyring)
    const opened = await mutate(ctx.app, "browser.openForLogin", wang, { profileId })
    expect(opened.error).toBeUndefined()
    const browserId = opened.data.browserId as string
    const instance = manager.get(browserId)!

    const owner = await connect(browserId, wang)
    const viewer = await connect(browserId, li)
    const meta = (client: Client) => client.json.filter((message) => message.t === "meta").at(-1)
    await waitFor(async () => meta(owner) && meta(viewer), { what: "收到 meta" })
    expect(meta(owner)).toMatchObject({ canControl: true })
    expect(meta(viewer)).toMatchObject({ canControl: false })

    // 导航（goto）
    owner.send({ t: "nav", action: "goto", url: site.url("127.0.0.1", "/hello") })
    await waitFor(async () => instance.currentPage()?.url().endsWith("/hello"), { what: "打开 /hello" })
    await waitFor(async () => (meta(owner)?.url as string | undefined)?.endsWith("/hello"), { what: "meta 里的地址更新" })
    const m = meta(owner) as { width: number; height: number; tabs: { id: number; active: boolean }[] }
    expect(m.width).toBeGreaterThan(1000)
    expect(m.tabs.filter((tab) => tab.active)).toHaveLength(1)

    // 画面帧：两个人都收到 JPEG
    await waitFor(async () => owner.frames.length > 0 && viewer.frames.length > 0, { what: "收到画面帧" })
    expect(owner.frames[0]!.subarray(0, 2).toString("hex")).toBe("ffd8")

    // 点输入框、键入 abc、中文（insertText）
    const click = (x: number, y: number) => {
      owner.send({ t: "mouse", type: "mouseMoved", x, y })
      owner.send({ t: "mouse", type: "mousePressed", x, y, button: "left", buttons: 1, clickCount: 1 })
      owner.send({ t: "mouse", type: "mouseReleased", x, y, button: "left", buttons: 0, clickCount: 1 })
    }
    click(220, 120)
    for (const key of ["a", "b", "c"]) {
      owner.send({ t: "key", type: "keyDown", key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0), text: key })
      owner.send({ t: "key", type: "keyUp", key, code: `Key${key.toUpperCase()}`, keyCode: key.toUpperCase().charCodeAt(0) })
    }
    owner.send({ t: "text", text: "中文输入" })
    const page = instance.currentPage()!
    await waitFor(async () => (await page.inputValue("#box")) === "abc中文输入", { what: "输入框里是 abc中文输入" })

    // 没权限的人发的输入一律丢掉
    viewer.send({ t: "text", text: "坏" })
    viewer.send({ t: "nav", action: "goto", url: site.url("127.0.0.1", "/") })
    await new Promise((resolve) => setTimeout(resolve, 800))
    expect(await page.inputValue("#box")).toBe("abc中文输入")
    expect(page.url()).toMatch(/\/hello$/)

    // 谁在看
    const live = await query(ctx.app, "browser.live", wang)
    const row = live.data.find((each: { browserId: string }) => each.browserId === browserId)
    expect(row.viewers.map((each: { userId: string }) => each.userId).sort()).toEqual(["u-li", "u-wang"].sort())
    expect(row).toMatchObject({ kind: "login", state: "running", openedById: "u-wang" })

    // 弹框：两边都收到，有权限的人点确定
    click(120, 220)
    await waitFor(async () => owner.json.some((message) => message.t === "dialog") && viewer.json.some((message) => message.t === "dialog"), { what: "收到弹框" })
    expect(owner.json.find((message) => message.t === "dialog")).toMatchObject({ kind: "alert", message: "弹框来了" })
    viewer.send({ t: "dialog", accept: true })
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(owner.json.some((message) => message.t === "dialogClosed")).toBe(false)
    owner.send({ t: "dialog", accept: true })
    await waitFor(async () => owner.json.some((message) => message.t === "dialogClosed"), { what: "弹框关掉" })

    // 关掉：观看端收到 closed
    expect((await mutate(ctx.app, "browser.close", li, { browserId })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "browser.close", wang, { browserId })).error).toBeUndefined()
    await waitFor(async () => owner.json.some((message) => message.t === "closed") && viewer.json.some((message) => message.t === "closed"), { what: "收到 closed" })
    await waitFor(async () => owner.ws.readyState === WebSocket.CLOSED, { what: "连接关掉" })
  })

  it("agent 的虚拟光标", async () => {
    const wang = await login(ctx.app, "wangyue@heyagent.local")
    const profileId = await createProfile(ctx.db, ctx.keyring)
    const opened = await mutate(ctx.app, "browser.openForLogin", wang, { profileId })
    expect(opened.error).toBeUndefined()
    const browserId = opened.data.browserId as string
    const instance = manager.get(browserId)!
    const owner = await connect(browserId, wang)
    // 每条 JSON 消息到的时间
    const arrived: { at: number; message: Record<string, unknown> }[] = []
    owner.ws.on("message", (data, isBinary) => {
      if (!isBinary) arrived.push({ at: performance.now(), message: JSON.parse(String(data)) as Record<string, unknown> })
    })
    const cursors = () => arrived.filter((each) => each.message.t === "cursor" || each.message.t === "cursorHidden")
    const lastCursor = () => cursors().at(-1)?.message

    owner.send({ t: "nav", action: "goto", url: site.url("127.0.0.1", "/hello") })
    await waitFor(async () => instance.currentPage()?.url().endsWith("/hello"), { what: "打开 /hello" })
    const page = instance.currentPage()!
    const childrenBefore = await page.evaluate("document.documentElement.querySelectorAll('*').length")
    const mcp = await instance.ensureMcp()
    const tool = (name: string, args: Record<string, unknown>) => mcp.client.callTool({ name, arguments: args })
    // 元素框的中心（Playwright 点的就是这里；输入框有默认边框和内边距，比样式里写的大一点）
    const center = async (selector: string) => {
      const box = (await page.locator(selector).boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }
    const boxCenter = await center("#box")
    const alertCenter = await center("#alert")
    const near = (message: Record<string, unknown> | undefined, at: { x: number; y: number }) =>
      message?.t === "cursor" && Math.abs((message.x as number) - at.x) < 1 && Math.abs((message.y as number) - at.y) < 1

    // 点输入框：光标先移到中心，过 PRESS_DELAY_MS 才按下
    const before = cursors().length
    await tool("browser_click", { target: "#box", element: "输入框" })
    await waitFor(async () => cursors().some((each, index) => index >= before && each.message.kind === "press"), { what: "收到按下" })
    const fresh = cursors().slice(before)
    const moved = fresh.find((each) => each.message.kind === "move")!
    const pressed = fresh.find((each) => each.message.kind === "press")!
    expect(near(moved.message, boxCenter)).toBe(true)
    expect(near(pressed.message, boxCenter)).toBe(true)
    expect(pressed.at - moved.at).toBeGreaterThanOrEqual(PRESS_DELAY_MS - 50)

    // 悬停：只移动
    await tool("browser_hover", { target: "#alert", element: "弹框按钮" })
    await waitFor(async () => near(lastCursor(), alertCenter), { what: "光标移到弹框按钮" })
    expect(lastCursor()).toMatchObject({ kind: "move" })

    // 打字（agent 的「输入」不点输入框）：光标跟到有焦点的输入框
    await tool("browser_type", { target: "#box", element: "输入框", text: "hi" })
    await waitFor(async () => near(lastCursor(), boxCenter), { what: "光标跟到输入框" })
    expect(await page.inputValue("#box")).toBe("hi")

    // 动作说明
    instance.viewer.announce("Click · 输入框")
    await waitFor(async () => arrived.some((each) => each.message.t === "agentAction" && each.message.label === "Click · 输入框"), { what: "收到动作说明" })

    // 人自己在画面里点：不算 agent 的
    const human = cursors().length
    owner.send({ t: "mouse", type: "mousePressed", x: 300, y: 300, button: "left", buttons: 1, clickCount: 1 })
    owner.send({ t: "mouse", type: "mouseReleased", x: 300, y: 300, button: "left", buttons: 0, clickCount: 1 })
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(cursors().length).toBe(human)

    // 网页里什么都没插（Playwright 自带的 showActions 会插 x-pw-glass）
    expect(await page.evaluate("document.documentElement.querySelectorAll('*').length")).toBe(childrenBefore)
    expect(await page.evaluate("Boolean(document.querySelector('x-pw-glass'))")).toBe(false)

    // 新标签页：画面跟过去，那里 agent 还没动过鼠标；切回来光标还在原处
    await tool("browser_tabs", { action: "new", url: site.url("127.0.0.1", "/hello") })
    await waitFor(async () => lastCursor()?.t === "cursorHidden", { what: "新标签页上光标隐藏" })
    const first = instance.pageId(page)
    const activeTab = () => (owner.json.filter((message) => message.t === "meta").at(-1) as { tabs: { id: number; active: boolean }[] }).tabs.find((tab) => tab.active)?.id
    await waitFor(async () => activeTab() !== first, { what: "画面跟到新标签页" })
    owner.send({ t: "tab", id: first })
    await waitFor(async () => near(lastCursor(), boxCenter), { what: "切回来光标还在" })

    // agent 在没显示的标签页上动了（它的当前标签页还是新开的那个）：画面跟过去
    const second = instance.pageId(instance.pages().find((each) => each !== page)!)
    await tool("browser_navigate", { url: site.url("127.0.0.1", "/hello?again") })
    await waitFor(async () => activeTab() === second, { what: "画面跟到 agent 打开网址的标签页" })
    // agent 自己切回第一个标签页：画面也跟过去
    await tool("browser_tabs", { action: "select", index: 0 })
    await waitFor(async () => activeTab() === first, { what: "画面跟到 agent 切过去的标签页" })

    expect((await mutate(ctx.app, "browser.close", wang, { browserId })).error).toBeUndefined()
    await waitFor(async () => owner.json.some((message) => message.t === "closed"), { what: "收到 closed" })
  })
})
