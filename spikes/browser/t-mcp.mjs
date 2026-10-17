// Playwright MCP 0.0.83 实测：用 --cdp-endpoint 连到我们自己起的同一个有界面 Chrome。
// 看：能导航、能拿快照、和编排器共用一个 context；默认工具里有没有 browser_run_code_unsafe；
// 编排器（Playwright）和 MCP 同时连着时 JS 弹框归谁处理；MCP 退出后 Chrome 是否还活着；MCP 进程内存。
// 用法（容器内）：node t-mcp.mjs
import { chromium } from "playwright-core"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import fs from "node:fs"
import { startXvfb, startChrome, stopChrome, killGroup, treePids, pssOf, sleep, r1 } from "./lib/browser.mjs"
import { startSite } from "./lib/site.mjs"

const site = await startSite()
const x = await startXvfb()
const s = await startChrome({ display: x.display })
const orch = await chromium.connectOverCDP(s.ws, { noDefaults: true }) // 编排器自己的连接
const ctx = orch.contexts()[0]
const out = {}
const txt = (r) => (r.content || []).filter((c) => c.type === "text").map((c) => c.text).join("\n")

const transport = new StdioClientTransport({ command: "playwright-mcp", args: ["--cdp-endpoint", s.ws, "--output-dir", "/tmp/mcp-out"], stderr: "pipe" })
const mcp = new Client({ name: "spike", version: "0" })
await mcp.connect(transport)
out.mcpVersion = mcp.getServerVersion()

const tools = (await mcp.listTools()).tools
out.toolCount = tools.length
out.tools = tools.map((t) => t.name)
const unsafe = tools.find((t) => t.name === "browser_run_code_unsafe")
out.runCodeUnsafe = unsafe ? { present: true, description: unsafe.description.slice(0, 300) } : { present: false }
out.toolsListChars = JSON.stringify(tools).length

const call = async (name, args = {}) => { const r = await mcp.callTool({ name, arguments: args }); return { text: txt(r), isError: !!r.isError } }

// 导航 + 快照
const nav = await call("browser_navigate", { url: site.base + "/index.html" })
out.navigate = { chars: nav.text.length, head: nav.text.slice(0, 300) }
const snapSchema = tools.find((t) => t.name === "browser_snapshot")?.inputSchema?.properties
out.snapshotParams = Object.keys(snapSchema || {})
out.clickParams = Object.keys(tools.find((t) => t.name === "browser_click")?.inputSchema?.properties || {})
const snap = await call("browser_snapshot", snapSchema?.depth ? { depth: 6 } : {})
out.snapshot = { chars: snap.text.length, hasInput: snap.text.includes("输入框"), hasButton: snap.text.includes("点我计数") }
const ref = (snap.text.match(/button "点我计数" \[ref=(\w+)\]/) || [])[1]
out.clickRef = ref
if (ref) {
  const c = await call("browser_click", { element: "点我计数 按钮", target: ref })
  const pg = ctx.pages().find((p) => p.url().includes("/index.html"))
  out.sharedContext = { mcpClickVisibleToOrchestrator: (await pg.textContent("#clicks")) === "1", orchestratorPages: ctx.pages().map((p) => p.url()) , clickResultChars: c.text.length }
}
const ex = await call("browser_navigate", { url: "https://example.com/" })
const exSnap = await call("browser_snapshot", {})
out.exampleCom = { ok: exSnap.text.includes("Example Domain"), navError: ex.isError }
const wd = await call("browser_evaluate", { function: "() => [navigator.webdriver, navigator.userAgent.includes('Headless')]" })
out.webdriverViaMcp = wd.text.match(/\[\s*(true|false),\s*(true|false)\s*\]/)?.[0] ?? wd.text.slice(0, 200)

// 弹框归属：编排器（Playwright 连接）没挂 dialog 监听时，Playwright 会自动关掉弹框
await call("browser_navigate", { url: site.base + "/index.html" })
const snap2 = await call("browser_snapshot", {})
const alertRef = (snap2.text.match(/button "弹 alert" \[ref=(\w+)\]/) || [])[1]
const pg = () => ctx.pages().find((p) => p.url().includes("/index.html"))
if (alertRef) {
  const r1c = await call("browser_click", { element: "弹 alert 按钮", target: alertRef })
  await sleep(500)
  out.dialogNoOrchListener = { mcpClickResult: r1c.text.slice(0, 400), pageResult: await pg().textContent("#dialogResult") }
  // 编排器挂一个「不处理」的监听（把弹框留给人或 agent），再让 agent 点一次
  await pg().evaluate(() => (document.getElementById("dialogResult").textContent = "无"))
  const held = []
  pg().on("dialog", (d) => held.push(d.message()))
  const r2c = await call("browser_click", { element: "弹 alert 按钮", target: alertRef })
  await sleep(500)
  const handleTool = tools.find((t) => t.name === "browser_handle_dialog")
  const h = handleTool ? await call("browser_handle_dialog", { accept: true }) : { text: "无 browser_handle_dialog 工具" }
  await sleep(300)
  out.dialogOrchHolds = { orchestratorSaw: held, mcpClickResult: r2c.text.slice(0, 400), handleDialog: h.text.slice(0, 300), pageResult: await pg().textContent("#dialogResult") }
}

// MCP 进程内存（含它 spawn 的子进程）
const mpid = transport.pid
if (mpid) { const m = pssOf(treePids(mpid)); out.mcpPssMB = r1(m.mb) }

await mcp.close()
await sleep(500)
// MCP 退出后 Chrome 是否还在、编排器连接是否可用
let alive = false
try { const p = await ctx.newPage(); await p.goto(site.base + "/newtab.html"); alive = (await p.title()) === "新标签页" } catch (e) { out.afterMcpCloseError = e.message.split("\n")[0] }
out.chromeAliveAfterMcpClose = alive && s.proc.exitCode === null
try { fs.rmSync("/tmp/mcp-out", { recursive: true, force: true }) } catch {}

await orch.close()
await stopChrome(s)
await killGroup(x.proc)
await site.close()
console.log(JSON.stringify(out, null, 1))
