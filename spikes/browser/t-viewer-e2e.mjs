// 远程画面试用页的端到端自测：在 viewer 容器里再起一个有界面 Chrome 当「用户的浏览器」，打开 http://127.0.0.1:5190/，
// 在 canvas 上点、拖、打字、用输入法（CDP Input.imeSetComposition 模拟组字）、粘贴、处理弹框、跟随新标签页，
// 再连远端 Chrome 的 CDP 核对页面状态。另外量「用户按键 → 收到新画面」的延迟（容器内回环，不含真实网络）。
// 用法：./run-viewer.sh start 之后，podman exec heyagent-browser-viewer node /opt/browser/spike/t-viewer-e2e.mjs
import { chromium } from "playwright-core"
import fs from "node:fs"
import { startXvfb, startChrome, stopChrome, killGroup, sleep, stats, r1 } from "./lib/browser.mjs"

const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.error((ok ? "PASS " : "FAIL ") + name + " " + JSON.stringify(detail ?? "")) }

// 远端（被看的 Chrome）：只用来核对状态。挂空的 dialog 监听，避免 Playwright 自动关掉弹框
const remote = await chromium.connectOverCDP(fs.readFileSync("/tmp/viewer-cdp.txt", "utf8").trim(), { noDefaults: true })
const rctx = remote.contexts()[0]
const hold = (p) => p.on("dialog", () => {})
rctx.pages().forEach(hold); rctx.on("page", hold)
const rpage = () => rctx.pages().find((p) => p.url().includes("/index.html"))

// 本地（用户的浏览器）
const x = await startXvfb({ width: 1600, height: 1000 })
const s = await startChrome({ display: x.display, width: 1600, height: 1000 })
const b = await chromium.connectOverCDP(s.ws, { noDefaults: true })
const ctx = b.contexts()[0]
const v = ctx.pages()[0]
await v.goto("http://127.0.0.1:5190/")
await v.waitForFunction(() => document.getElementById("stats").textContent.includes("帧/秒"), null, { timeout: 10000 })
await sleep(1500)
const vcdp = await ctx.newCDPSession(v)

// 远端页面坐标 → 本地 canvas 上的屏幕坐标
async function toCanvas(sel) {
  const r = await rpage().evaluate((s) => { const e = document.querySelector(s).getBoundingClientRect(); return { x: e.x + e.width / 2, y: e.y + e.height / 2, w: e.width, left: e.left, right: e.right } }, sel)
  const c = await v.evaluate(() => { const b = document.getElementById("screen").getBoundingClientRect(); return { left: b.left, top: b.top, w: b.width, h: b.height, mw: meta.w, mh: meta.h } })
  const k = c.w / c.mw
  return { x: c.left + r.x * k, y: c.top + r.y * (c.h / c.mh), left: c.left + r.left * k, right: c.left + r.right * k, k }
}

// 1. 点输入框 + 英文键入
let t = await toCanvas("#text")
await v.mouse.click(t.x, t.y)
await v.keyboard.type("hello")
await sleep(300)
check("canvas 点击 + 键盘键入", (await rpage().$eval("#text", (e) => e.value)) === "hello", await rpage().$eval("#text", (e) => e.value))

// 2. Backspace、组合键
await v.keyboard.press("Backspace"); await v.keyboard.press("Control+a"); await v.keyboard.press("Backspace")
await sleep(300)
check("Backspace / Ctrl+A 转发", (await rpage().$eval("#text", (e) => e.value)) === "")

// 3. 输入法：模拟拼音组字过程（compositionstart / update / end），最后上屏「中文输入」
await vcdp.send("Input.imeSetComposition", { text: "zhong", selectionStart: 5, selectionEnd: 5 })
await vcdp.send("Input.imeSetComposition", { text: "中文", selectionStart: 2, selectionEnd: 2 })
await vcdp.send("Input.insertText", { text: "中文输入" })
await sleep(400)
check("输入法组字（compositionend → Input.insertText）", (await rpage().$eval("#text", (e) => e.value)) === "中文输入", await rpage().$eval("#text", (e) => e.value))

// 4. 粘贴（本机剪贴板 → 远端）
await v.evaluate(() => { const dt = new DataTransfer(); dt.setData("text/plain", " 粘贴的密码P@ss"); document.getElementById("ime").dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true })) })
await sleep(400)
check("粘贴", (await rpage().$eval("#text", (e) => e.value)) === "中文输入 粘贴的密码P@ss", await rpage().$eval("#text", (e) => e.value))

// 5. 滚轮
await v.mouse.move(t.x, t.y + 200); await v.mouse.wheel(0, 600); await sleep(600)
const sy = await rpage().evaluate(() => scrollY)
check("滚轮", sy > 200, { scrollY: sy })
await v.mouse.wheel(0, -3000); await sleep(600)

// 6. 拖动滑块：人手式拖动（40 步、带抖动）
const k = await toCanvas("#knob"), tr = await toCanvas("#track")
await v.mouse.move(k.x, k.y); await v.mouse.down()
for (let i = 1; i <= 40; i++) { await v.mouse.move(k.x + (tr.right - k.x + 10) * i / 40, k.y + Math.sin(i) * 2); await sleep(12) }
await v.mouse.up(); await sleep(300)
const sl = await rpage().evaluate(() => window.__slider)
check("拖动滑块", sl.done, sl)

// 7. alert / confirm / prompt：远端弹框显示成本页对话框，点按钮回传
for (const [sel, act, expect] of [["#alertBtn", "ok", "alert 已关闭"], ["#confirmBtn", "ok", "confirm=true"], ["#promptBtn", "prompt", "prompt=远程填写"]]) {
  const b2 = await toCanvas(sel)
  await v.mouse.click(b2.x, b2.y)
  await v.waitForFunction(() => document.getElementById("dialog").style.display === "flex", null, { timeout: 5000 }).catch(() => {})
  const shown = await v.evaluate(() => document.getElementById("dlgMsg").textContent)
  if (act === "prompt") { await v.fill("#dlgInput", "远程填写") }
  await v.click("#dlgOk")
  await sleep(500)
  check(`弹框 ${sel}（对话框显示「${shown}」）`, (await rpage().textContent("#dialogResult")) === expect, await rpage().textContent("#dialogResult"))
}

// 8. 新标签页：点链接后画面切到新标签页，标签栏出现两个
const nl = await toCanvas("#newTabLink")
await v.mouse.click(nl.x, nl.y)
await v.waitForFunction(() => document.querySelectorAll("#tabs .tab").length === 2 && document.querySelector("#tabs .tab.active span").textContent === "新标签页", null, { timeout: 5000 }).catch(() => {})
const tabs = await v.$$eval("#tabs .tab", (els) => els.map((e) => (e.classList.contains("active") ? "*" : "") + e.querySelector("span").textContent))
check("新标签页自动跟随", tabs.length === 2 && tabs.some((x) => x === "*新标签页"), tabs)
await v.click("#tabs .tab.active b") // 关掉新标签页
await sleep(800)

// 9. 延迟：用户按键 → 收到下一帧（latency.html 平时静止，按键切换整页颜色）
await v.fill("#url", "http://127.0.0.1:8090/latency.html"); await v.click("#go"); await sleep(1500)
await v.mouse.click(400, 300); await sleep(500)
await v.evaluate(() => { window.__frames = []; const orig = window.draw; window.draw = (blob) => { window.__frames.push(performance.now()); return orig(blob) } })
const lat = []
for (let i = 0; i < 30; i++) {
  await sleep(300)
  const t0 = await v.evaluate(() => performance.now())
  await v.keyboard.press("a")
  const got = await v.waitForFunction((t0) => window.__frames.find((f) => f > t0), t0, { timeout: 2000 }).then((h) => h.jsonValue()).catch(() => null)
  if (got) lat.push(got - t0)
}
const st = stats(lat)
check("按键 → 新画面延迟（容器内回环）", st.n >= 25, { n: st.n, p50: r1(st.p50), p95: r1(st.p95), max: r1(st.max) })

await b.close(); await stopChrome(s); await killGroup(x.proc)
// 恢复远端到测试页，方便接着手动试
await rctx.pages()[0].goto("http://127.0.0.1:8090/index.html").catch(() => {})
await remote.close()
console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, total: results.length, results }, null, 1))
