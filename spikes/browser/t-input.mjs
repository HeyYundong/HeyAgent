// 输入转发实测：全部用远程画面会用的原始 CDP 命令（Input.dispatchMouseEvent / dispatchKeyEvent / insertText），
// 再用 Playwright 读页面状态核对。覆盖：点击、悬停、滚轮、键盘、组合键、中文 insertText、拖动滑块、新标签页跟随、JS 弹框。
// 用法（容器内）：node t-input.mjs
import { chromium } from "playwright-core"
import { startXvfb, startChrome, stopChrome, killGroup, sleep } from "./lib/browser.mjs"
import { startSite } from "./lib/site.mjs"

const site = await startSite()
const x = await startXvfb()
const s = await startChrome({ display: x.display })
const b = await chromium.connectOverCDP(s.ws, { noDefaults: true })
const ctx = b.contexts()[0]
const page = ctx.pages()[0] || (await ctx.newPage())
await page.goto(site.base + "/index.html")
let cdp = await ctx.newCDPSession(page)
const results = []
const check = (name, ok, detail) => { results.push({ name, ok: !!ok, detail }); console.error((ok ? "PASS " : "FAIL ") + name + " " + JSON.stringify(detail ?? "")) }

const box = (sel) => page.evaluate((s) => { const r = document.querySelector(s).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: r.left, right: r.right, w: r.width, h: r.height } }, sel)
const mouse = (type, x, y, extra = {}) => cdp.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, ...extra })
const click = async (x, y) => { await mouse("mouseMoved", x, y, { button: "none" }); await mouse("mousePressed", x, y, { buttons: 1 }); await mouse("mouseReleased", x, y) }
// 远程画面里的按键：keydown 带 text 才会产生字符输入（和浏览器里 keypress 的语义一致）
const key = async (k, code, vk, { text, modifiers = 0 } = {}) => {
  await cdp.send("Input.dispatchKeyEvent", { type: text ? "keyDown" : "rawKeyDown", key: k, code, windowsVirtualKeyCode: vk, text, unmodifiedText: text, modifiers })
  await cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: k, code, windowsVirtualKeyCode: vk, modifiers })
}
const val = () => page.$eval("#text", (e) => e.value)

// 1. 点击输入框 + ASCII 按键
{ const r = await box("#text"); await click(r.x, r.y) }
for (const ch of "abc") await key(ch, "Key" + ch.toUpperCase(), ch.toUpperCase().charCodeAt(0), { text: ch })
check("点击输入框后键入 abc", (await val()) === "abc", await val())

// 2. 组合键 Ctrl+A 后 Backspace
await key("a", "KeyA", 65, { modifiers: 2 })
await key("Backspace", "Backspace", 8)
check("Ctrl+A + Backspace 清空", (await val()) === "", await val())

// 3. 中文（insertText，等同输入法 compositionend / 粘贴后发过去的文字）
const zh = "亚马逊 买家 账号 😀 第二行"
await cdp.send("Input.insertText", { text: zh })
check("Input.insertText 中文 + emoji", (await val()) === zh, await val())
check("insertText 触发 input 事件（页面显示同步）", (await page.textContent("#textValue")) === zh)

// 4. 悬停
{ const r = await box("#hover"); await mouse("mouseMoved", r.x, r.y, { button: "none" }) }
await sleep(100)
check("mouseMoved 触发 :hover", (await page.$eval("#hover", (e) => getComputedStyle(e).backgroundColor)) === "rgb(51, 170, 51)")

// 5. 点击按钮 3 次
{ const r = await box("#clickBtn"); for (let i = 0; i < 3; i++) await click(r.x, r.y) }
check("点击按钮 3 次", (await page.textContent("#clicks")) === "3")

// 6. 滚轮
await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 400, deltaX: 0, deltaY: 800 })
await sleep(500)
const sy = await page.evaluate(() => scrollY)
check("mouseWheel 滚动页面", sy > 300, { scrollY: sy })
await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 400, deltaX: 0, deltaY: -5000 })
await sleep(500)

// 7. Tab 切焦点 + Enter 触发按钮
await page.focus("#alertBtn") // 起点
await key("Tab", "Tab", 9)
const focused = await page.evaluate(() => document.activeElement?.id)
check("Tab 键移动焦点", focused === "confirmBtn", { focused })
await page.focus("#clickBtn")
await key("Enter", "Enter", 13, { text: "\r" })
check("Enter 键触发按钮", (await page.textContent("#clicks")) === "4")

// 8. 拖动滑块：按住 → 连续 mousemove（buttons=1）→ 松开
{
  const k = await box("#knob"); const t = await box("#track")
  const endX = t.right - k.w / 2 + 5
  await mouse("mouseMoved", k.x, k.y, { button: "none" })
  await mouse("mousePressed", k.x, k.y, { buttons: 1 })
  const steps = 30
  for (let i = 1; i <= steps; i++) {
    await mouse("mouseMoved", k.x + (endX - k.x) * i / steps, k.y + Math.sin(i / 3) * 2, { buttons: 1 })
    await sleep(16)
  }
  await mouse("mouseReleased", endX, k.y)
  const st = await page.evaluate(() => window.__slider)
  check("自写拖动滑块拖到头", st.done, st)
}
{
  const r = await box("#range")
  await mouse("mouseMoved", r.left + 4, r.y, { button: "none" })
  await mouse("mousePressed", r.left + 4, r.y, { buttons: 1 })
  for (let i = 1; i <= 10; i++) await mouse("mouseMoved", r.left + 4 + (r.w - 8) * i / 10, r.y, { buttons: 1 })
  await mouse("mouseReleased", r.right - 4, r.y)
  const v = await page.$eval("#range", (e) => e.value)
  check("原生 range 滑块拖到头", Number(v) >= 98, { value: v })
}

// 9. 新标签页跟随：context.on("page") 拿到新页 → bringToFront → 对新页开 screencast
async function framesFrom(p, ms = 1500) {
  const c = await ctx.newCDPSession(p); let n = 0, size = null
  c.on("Page.screencastFrame", (f) => { n++; size = `${f.metadata.deviceWidth}x${f.metadata.deviceHeight}`; c.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}) })
  await c.send("Page.startScreencast", { format: "jpeg", quality: 60 })
  await sleep(ms); await c.send("Page.stopScreencast").catch(() => {}); await c.detach().catch(() => {})
  return { n, size }
}
for (const [sel, label] of [["#newTabLink", "target=_blank 链接"], ["#openWin", "window.open"]]) {
  const r = await box(sel)
  const got = ctx.waitForEvent("page", { timeout: 5000 })
  await click(r.x, r.y)
  const np = await got.catch(() => null)
  if (!np) { check(`新标签页（${label}）触发 context.on("page")`, false); continue }
  await np.waitForLoadState()
  check(`新标签页（${label}）触发 context.on("page")`, np.url().includes("/newtab.html"), np.url())
  await np.bringToFront()
  const f = await framesFrom(np)
  check(`切到新标签页后 screencast 有帧（${label}）`, f.n > 0, f)
  if (label === "window.open") {
    // 后台标签页：给原页面加一个持续动画，在它处于后台时开 screencast，看出不出帧、页面自己认为可不可见；再切到前台对比
    await page.evaluate(() => { const d = document.createElement("div"); d.id = "spin"; d.style.cssText = "position:fixed;top:0;left:0;width:50px;height:50px;background:#c33"; document.body.append(d); let a = 0; setInterval(() => (d.style.left = (a = (a + 7) % 600) + "px"), 16) })
    const visBefore = await page.evaluate(() => document.visibilityState)
    const bg = await framesFrom(page, 1500)
    await page.bringToFront()
    const fg = await framesFrom(page, 1500)
    const visAfter = await page.evaluate(() => document.visibilityState)
    // 只记录现象，不判对错：结论写进报告
    check("后台标签页开 screencast 的表现（记录）", true, { visibilityBefore: visBefore, backgroundFrames: bg, foregroundFrames: fg, visibilityAfterBringToFront: visAfter })
    await page.evaluate(() => document.getElementById("spin").remove())
  }
  await np.close()
  await page.bringToFront()
}

// 10. JS 弹框：编排器的 page.on("dialog") 收到后，转给远程画面显示，由人选择接受 / 取消
const dialogs = []
const answers = { alert: (d) => d.accept(), confirm: (d) => d.dismiss(), prompt: (d) => d.accept("人工填写的备注") }
page.on("dialog", async (d) => { dialogs.push({ type: d.type(), message: d.message(), defaultValue: d.defaultValue() }); await sleep(300); await answers[d.type()](d) })
cdp = await ctx.newCDPSession(page)
for (const [sel, expect] of [["#alertBtn", "alert 已关闭"], ["#confirmBtn", "confirm=false"], ["#promptBtn", "prompt=人工填写的备注"]]) {
  const r = await box(sel)
  // 注意：弹框打开期间 renderer 被阻塞，mouseReleased 的 CDP 调用要等弹框关掉才返回，所以这里不 await
  mouse("mouseMoved", r.x, r.y, { button: "none" }); mouse("mousePressed", r.x, r.y, { buttons: 1 }); mouse("mouseReleased", r.x, r.y)
  await page.waitForFunction((e) => document.getElementById("dialogResult").textContent === e, expect, { timeout: 5000 }).catch(() => {})
  check(`JS 弹框 ${sel.slice(1, -3)}`, (await page.textContent("#dialogResult")) === expect, { result: await page.textContent("#dialogResult"), dialog: dialogs.at(-1) })
}

await b.close()
await stopChrome(s)
await killGroup(x.proc)
await site.close()
console.log(JSON.stringify({ passed: results.filter((r) => r.ok).length, total: results.length, results }, null, 1))
