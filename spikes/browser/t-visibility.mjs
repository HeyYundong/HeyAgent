// 标签页可见性实测：编排器用 Playwright connectOverCDP 连 Chrome 时，加不加 noDefaults 的区别。
// 不加时 Playwright 会对每个页面开 Emulation.setFocusEmulationEnabled，后台标签页也认为自己可见、有焦点，照样渲染出帧；
// 加 noDefaults（Playwright MCP 的 --cdp-endpoint 模式就是这么连的）时，后台页是 hidden，screencast 只出 1 帧。
// 用法（容器内）：node t-visibility.mjs
import { chromium } from "playwright-core"
import { startXvfb, startChrome, stopChrome, killGroup, sleep } from "./lib/browser.mjs"

const x = await startXvfb()
const out = []
for (const noDefaults of [false, true]) {
  const s = await startChrome({ display: x.display })
  const b = await chromium.connectOverCDP(s.ws, { noDefaults })
  const ctx = b.contexts()[0]
  const a = ctx.pages()[0]; await a.goto("data:text/html,<title>A</title>A")
  const bb = await ctx.newPage(); await bb.goto("data:text/html,<title>B</title>B")
  await bb.evaluate(() => { let i = 0; setInterval(() => (document.body.textContent = "B " + i++), 16) })
  await a.bringToFront(); await sleep(500)
  const v = (p) => p.evaluate(() => `${document.visibilityState}/${document.hasFocus() ? "focus" : "nofocus"}`)
  const frames = async (p) => {
    const c = await ctx.newCDPSession(p); let n = 0
    c.on("Page.screencastFrame", (f) => { n++; c.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}) })
    await c.send("Page.startScreencast", { format: "jpeg", quality: 60 }); await sleep(1500)
    await c.send("Page.stopScreencast"); await c.detach(); return n
  }
  const r = { noDefaults, A_front: await v(a), B_background: await v(bb), B_backgroundFrames_1_5s: await frames(bb) }
  await bb.bringToFront(); await sleep(300)
  r.B_afterBringToFront = await v(bb); r.B_frontFrames_1_5s = await frames(bb)
  out.push(r); console.error(JSON.stringify(r))
  await b.close(); await stopChrome(s)
}
await killGroup(x.proc)
console.log(JSON.stringify(out, null, 1))
