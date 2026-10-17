// 远程画面手动试用页（M0 实测用，不是产品代码）。
// 容器里起 Xvfb + 有界面 Chrome，打开本地测试页；0.0.0.0:5190 提供一个网页：canvas 显示 CDP screencast，
// 鼠标 / 滚轮 / 键盘转发回 Chrome，隐藏 textarea 接中文输入法和粘贴（Input.insertText），
// 新标签页自动跟随，JS 弹框转给网页里的对话框处理。
// 由 run-viewer.sh 在容器里启动。
import http from "node:http"
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"
import { WebSocketServer } from "ws"
import { startXvfb, startChrome, stopChrome, killGroup, dropStartupTab } from "../lib/browser.mjs"
import { startSite } from "../lib/site.mjs"

const PORT = Number(process.env.VIEWER_PORT || 5190)
const HERE = path.dirname(fileURLToPath(import.meta.url))
const W = 1366, H = 768

const site = await startSite({ port: 8090 })
const xvfb = await startXvfb({ width: W, height: H })
const chrome = await startChrome({ display: xvfb.display, width: W, height: H })
const browser = await chromium.connectOverCDP(chrome.ws, { noDefaults: true })
const ctx = browser.contexts()[0]
// 启动标签页顶上有「不受支持的命令行标记」提示条，换成新标签页
const first = await dropStartupTab(ctx)
await first.goto(site.base + "/index.html")
// 给 t-viewer-e2e.mjs 用：容器内核对远端页面状态（CDP 只在容器的 127.0.0.1 上）
fs.writeFileSync("/tmp/viewer-cdp.txt", chrome.ws)
console.log(`[viewer] Chrome ${browser.version()}，测试页 ${site.base}/index.html`)

const clients = new Set()
const send = (ws, obj) => ws.readyState === 1 && ws.send(JSON.stringify(obj))
const broadcast = (obj) => { for (const ws of clients) send(ws, obj) }

// ---------- 标签页与 screencast ----------
const ids = new WeakMap(); let nextId = 1
const idOf = (p) => { if (!ids.has(p)) ids.set(p, nextId++); return ids.get(p) }
let active = null, cdp = null, meta = { w: 0, h: 0 }, pendingDialog = null

async function tabs() {
  const list = []
  for (const p of ctx.pages()) list.push({ id: idOf(p), url: p.url(), title: await p.title().catch(() => ""), active: p === active })
  broadcast({ t: "tabs", list })
}

async function activate(p) {
  if (active === p && cdp) return
  if (cdp) { await cdp.send("Page.stopScreencast").catch(() => {}); await cdp.detach().catch(() => {}) }
  active = p
  // 后台标签页不出帧，必须先切到前台
  await p.bringToFront().catch(() => {})
  cdp = await ctx.newCDPSession(p)
  const mine = cdp
  cdp.on("Page.screencastFrame", (f) => {
    mine.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
    if (mine !== cdp) return
    const m = f.metadata
    if (m.deviceWidth !== meta.w || m.deviceHeight !== meta.h) { meta = { w: m.deviceWidth, h: m.deviceHeight }; broadcast({ t: "meta", ...meta }) }
    const buf = Buffer.from(f.data, "base64")
    // 观看端跟不上时直接丢帧，不堆积（ack 立即回，Chrome 不会因为慢观看端降帧）
    for (const ws of clients) if (ws.readyState === 1 && ws.bufferedAmount < 1 << 20) ws.send(buf)
  })
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, everyNthFrame: 1 })
  tabs()
}

function watch(p) {
  idOf(p)
  p.on("dialog", (d) => { pendingDialog = d; broadcast({ t: "dialog", type: d.type(), message: d.message(), defaultValue: d.defaultValue() }) })
  p.on("framenavigated", (f) => f === p.mainFrame() && tabs())
  p.on("load", () => tabs())
  p.on("close", () => { if (p === active) { active = null; const rest = ctx.pages(); if (rest.length) activate(rest.at(-1)) } tabs() })
}
ctx.on("page", (p) => { watch(p); activate(p) }) // 新标签页自动跟随
for (const p of ctx.pages()) watch(p)
await activate(ctx.pages()[0])

// ---------- 输入转发 ----------
function onMessage(ws, raw) {
  let m; try { m = JSON.parse(raw) } catch { return }
  if (!cdp) return
  // 不 await：弹框打开期间 renderer 被阻塞，鼠标 / 键盘的 CDP 调用要等弹框关掉才返回
  switch (m.t) {
    case "mouse":
      cdp.send("Input.dispatchMouseEvent", { type: m.type, x: m.x, y: m.y, button: m.button || "none", buttons: m.buttons || 0, clickCount: m.clickCount || 0, modifiers: m.modifiers || 0, deltaX: m.deltaX || 0, deltaY: m.deltaY || 0 }).catch(() => {})
      break
    case "key":
      cdp.send("Input.dispatchKeyEvent", { type: m.type, key: m.key, code: m.code, windowsVirtualKeyCode: m.keyCode, nativeVirtualKeyCode: m.keyCode, text: m.text, unmodifiedText: m.text, modifiers: m.modifiers || 0 }).catch(() => {})
      break
    case "text": // 中文输入法 compositionend / 粘贴
      if (m.text) cdp.send("Input.insertText", { text: m.text }).catch(() => {})
      break
    case "nav":
      if (m.action === "back") active?.goBack().catch(() => {})
      if (m.action === "forward") active?.goForward().catch(() => {})
      if (m.action === "reload") active?.reload().catch(() => {})
      if (m.action === "goto" && /^(https?:\/\/(127\.0\.0\.1:8090|example\.com|([a-z-]+\.)?wikipedia\.org)(\/|$))/.test(m.url)) active?.goto(m.url).catch(() => {})
      break
    case "tab": {
      const p = ctx.pages().find((x) => idOf(x) === m.id); if (p) activate(p)
      break
    }
    case "closeTab": {
      const p = ctx.pages().find((x) => idOf(x) === m.id); if (p && ctx.pages().length > 1) p.close().catch(() => {})
      break
    }
    case "dialog":
      if (pendingDialog) { const d = pendingDialog; pendingDialog = null; (m.accept ? d.accept(m.text ?? undefined) : d.dismiss()).catch(() => {}) }
      break
  }
}

// ---------- HTTP + WebSocket ----------
const server = http.createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    fs.createReadStream(path.join(HERE, "index.html")).pipe(res)
  } else { res.writeHead(404); res.end() }
})
const wss = new WebSocketServer({ server, path: "/ws" })
wss.on("connection", async (ws) => {
  clients.add(ws)
  ws.on("message", (d) => onMessage(ws, String(d)))
  ws.on("close", () => clients.delete(ws))
  if (meta.w) send(ws, { t: "meta", ...meta })
  tabs()
  // 新连上的观看端立刻要一帧：重启 screencast
  if (active) { const p = active; active = null; await activate(p) }
})
server.listen(PORT, "0.0.0.0", () => console.log(`[viewer] 远程画面：http://0.0.0.0:${PORT}/`))

const shutdown = async () => {
  console.log("[viewer] 关闭")
  for (const ws of clients) ws.close()
  server.close()
  await browser.close().catch(() => {})
  await stopChrome(chrome)
  await killGroup(xvfb.proc)
  await site.close()
  process.exit(0)
}
process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
