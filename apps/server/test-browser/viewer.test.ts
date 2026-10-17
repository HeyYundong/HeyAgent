// 真浏览器：远程画面经 API 转发（GET /api/browser/view/:browserId）：帧、鼠标键盘、中文、弹框、权限（没权限的输入被丢弃）、关闭。
import type { Server } from "node:http"

import { serve } from "@hono/node-server"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"

import type { BrowserManager } from "../src/browser/manager.js"
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
})
