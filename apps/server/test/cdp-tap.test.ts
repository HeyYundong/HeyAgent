// cdp-tap（虚拟光标的数据来源）：用一个假的 Chrome（WebSocket 服务端）测转发、记 agent 输入、按下前停顿时顺序不乱。
import type { AddressInfo } from "node:net"

import { afterEach, describe, expect, it } from "vitest"
import WebSocket, { WebSocketServer } from "ws"

import { parseAgentInput, PRESS_DELAY_MS, startCdpTap, type AgentInput, type CdpTap } from "../src/browser/cdp-tap.js"

interface FakeChrome {
  url: string
  received: { at: number; message: Record<string, unknown> }[]
  /** Chrome 这头的连接（MCP 连上转发层之后才有） */
  socket: () => WebSocket | undefined
  close(): Promise<void>
}

async function fakeChrome(): Promise<FakeChrome> {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" })
  await new Promise((resolve) => wss.once("listening", resolve))
  const received: FakeChrome["received"] = []
  let socket: WebSocket | undefined
  wss.on("connection", (ws) => {
    socket = ws
    ws.on("message", (data) => received.push({ at: performance.now(), message: JSON.parse(String(data)) as Record<string, unknown> }))
  })
  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}/devtools/browser/fake`,
    received,
    socket: () => socket,
    close: () => new Promise((resolve) => wss.close(() => resolve())),
  }
}

async function connect(url: string) {
  const ws = new WebSocket(url)
  const messages: Record<string, unknown>[] = []
  ws.on("message", (data) => messages.push(JSON.parse(String(data)) as Record<string, unknown>))
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve())
    ws.once("error", reject)
  })
  return { ws, messages, send: (message: unknown) => ws.send(JSON.stringify(message)) }
}

async function until(check: () => boolean, what: string) {
  const deadline = Date.now() + 3000
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`等不到：${what}`)
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

const attached = (sessionId: string, targetId: string) => ({ method: "Target.attachedToTarget", params: { sessionId, targetInfo: { targetId, type: "page" }, waitingForDebugger: false } })
const mouse = (id: number, type: string, x: number, y: number, sessionId = "S1") => ({ id, method: "Input.dispatchMouseEvent", sessionId, params: { type, x, y, button: "left", buttons: 1, clickCount: 1 } })

let chrome: FakeChrome | undefined
let tap: CdpTap | undefined

afterEach(async () => {
  await tap?.close()
  await chrome?.close()
  tap = undefined
  chrome = undefined
})

describe("parseAgentInput", () => {
  const targets = new Map([["S1", "T1"]])
  it("鼠标、拖放、打字；对不上页面的、别的指令不算", () => {
    expect(parseAgentInput(JSON.stringify(mouse(1, "mousePressed", 10.5, 20)), targets)).toEqual({ kind: "mouse", targetId: "T1", type: "mousePressed", x: 10.5, y: 20 })
    expect(parseAgentInput(JSON.stringify({ id: 2, method: "Input.dispatchDragEvent", sessionId: "S1", params: { type: "dragOver", x: 5, y: 6, data: { items: [], dragOperationsMask: 1 } } }), targets)).toMatchObject({ type: "mouseMoved", x: 5, y: 6 })
    expect(parseAgentInput(JSON.stringify({ id: 3, method: "Input.insertText", sessionId: "S1", params: { text: "你好" } }), targets)).toEqual({ kind: "key", targetId: "T1" })
    expect(parseAgentInput(JSON.stringify({ id: 4, method: "Input.dispatchKeyEvent", sessionId: "S1", params: { type: "keyDown", key: "a" } }), targets)).toEqual({ kind: "key", targetId: "T1" })
    expect(parseAgentInput(JSON.stringify({ id: 5, method: "Input.dispatchKeyEvent", sessionId: "S1", params: { type: "keyUp", key: "a" } }), targets)).toBeUndefined()
    expect(parseAgentInput(JSON.stringify(mouse(6, "mousePressed", 1, 1, "S9")), targets)).toBeUndefined()
    expect(parseAgentInput(JSON.stringify({ id: 7, method: "Runtime.evaluate", sessionId: "S1", params: { expression: "'Input.'" } }), targets)).toBeUndefined()
    expect(parseAgentInput("不是 JSON", targets)).toBeUndefined()
  })
  it("agent 切标签页、打开网址：远程画面跟过去", () => {
    expect(parseAgentInput(JSON.stringify({ id: 8, method: "Page.bringToFront", sessionId: "S1" }), targets)).toEqual({ kind: "focus", targetId: "T1" })
    expect(parseAgentInput(JSON.stringify({ id: 9, method: "Page.navigate", sessionId: "S1", params: { url: "https://example.com" } }), targets)).toEqual({ kind: "focus", targetId: "T1" })
    expect(parseAgentInput(JSON.stringify({ id: 10, method: "Page.navigateToHistoryEntry", sessionId: "S1", params: { entryId: 1 } }), targets)).toEqual({ kind: "focus", targetId: "T1" })
    expect(parseAgentInput(JSON.stringify({ id: 11, method: "Page.bringToFront", sessionId: "S9" }), targets)).toBeUndefined()
  })
})

describe("startCdpTap", () => {
  it("双向原样转发，记下 agent 的输入并对上页面；页面没了也告诉", async () => {
    chrome = await fakeChrome()
    const inputs: AgentInput[] = []
    tap = await startCdpTap(chrome.url, { onInput: (input) => inputs.push(input), shouldDelay: () => false })
    expect(tap.url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\/[0-9a-f]{24}$/)
    const mcp = await connect(tap.url)
    await until(() => Boolean(chrome!.socket()), "转发层连上 Chrome")

    // Chrome → MCP：照转；attachedToTarget 记下 session → target
    chrome.socket()!.send(JSON.stringify(attached("S1", "T1")))
    chrome.socket()!.send(JSON.stringify({ id: 1, result: { product: "Chrome" } }))
    await until(() => mcp.messages.length === 2, "MCP 收到两条")
    expect(mcp.messages[0]).toEqual(attached("S1", "T1"))

    // MCP → Chrome：照转；输入指令记下来
    mcp.send({ id: 2, method: "Browser.getVersion" })
    mcp.send(mouse(3, "mouseMoved", 100, 200))
    mcp.send(mouse(4, "mousePressed", 100, 200))
    mcp.send({ id: 5, method: "Input.insertText", sessionId: "S1", params: { text: "abc" } })
    await until(() => chrome!.received.length === 4, "Chrome 收到四条")
    expect(chrome.received.map((each) => each.message.id)).toEqual([2, 3, 4, 5])
    expect(chrome.received[1]!.message).toEqual(mouse(3, "mouseMoved", 100, 200))
    expect(inputs).toEqual([
      { kind: "mouse", targetId: "T1", type: "mouseMoved", x: 100, y: 200 },
      { kind: "mouse", targetId: "T1", type: "mousePressed", x: 100, y: 200 },
      { kind: "key", targetId: "T1" },
    ])

    chrome.socket()!.send(JSON.stringify({ method: "Target.detachedFromTarget", params: { sessionId: "S1", targetId: "T1" } }))
    await until(() => inputs.length === 4, "收到 detached")
    expect(inputs[3]).toEqual({ kind: "detached", targetId: "T1" })

    // Chrome 那头断了，MCP 这头也断
    chrome.socket()!.close()
    await until(() => mcp.ws.readyState === WebSocket.CLOSED, "MCP 的连接关掉")
  })

  it("有人看时按下前停一下，后面的消息排在它后面；没人看不停", async () => {
    chrome = await fakeChrome()
    let watching = true
    const inputs: AgentInput[] = []
    tap = await startCdpTap(chrome.url, { onInput: (input) => inputs.push(input), shouldDelay: () => watching })
    const mcp = await connect(tap.url)
    await until(() => Boolean(chrome!.socket()), "转发层连上 Chrome")
    chrome.socket()!.send(JSON.stringify(attached("S1", "T1")))
    await until(() => mcp.messages.length === 1, "MCP 收到 attached")

    mcp.send(mouse(1, "mouseMoved", 10, 10))
    mcp.send(mouse(2, "mousePressed", 10, 10))
    mcp.send(mouse(3, "mouseReleased", 10, 10))
    mcp.send({ id: 4, method: "Runtime.evaluate", sessionId: "S1", params: { expression: "1" } })
    await until(() => chrome!.received.length === 4, "Chrome 收到四条")
    expect(chrome.received.map((each) => each.message.id)).toEqual([1, 2, 3, 4])
    const [moved, pressed] = chrome.received
    expect(pressed!.at - moved!.at).toBeGreaterThanOrEqual(PRESS_DELAY_MS - 20)
    expect(inputs.map((each) => (each.kind === "mouse" ? each.type : each.kind))).toEqual(["mouseMoved", "mousePressed", "mouseReleased"])

    watching = false
    const before = chrome.received.length
    const start = performance.now()
    mcp.send(mouse(5, "mousePressed", 20, 20))
    mcp.send(mouse(6, "mouseReleased", 20, 20))
    await until(() => chrome!.received.length === before + 2, "Chrome 收到两条")
    expect(chrome.received.at(-1)!.at - start).toBeLessThan(PRESS_DELAY_MS - 50)
  })

  it("路径不对的拒绝；Chrome 连不上时 MCP 也连不上", async () => {
    chrome = await fakeChrome()
    tap = await startCdpTap(chrome.url, { onInput: () => {}, shouldDelay: () => false })
    await expect(connect(tap.url.replace(/[0-9a-f]{24}$/, "wrong"))).rejects.toThrow()
    await tap.close()
    tap = await startCdpTap("ws://127.0.0.1:9/devtools/browser/none", { onInput: () => {}, shouldDelay: () => false })
    await expect(connect(tap.url)).rejects.toThrow()
  })
})
