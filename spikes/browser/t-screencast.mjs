// 远程画面实测（重点）：有界面 Chrome + Xvfb 下 CDP screencast 的帧率、单帧大小、CPU，以及「输入 → 出帧」的本机延迟。
// 用法（容器内）：node t-screencast.mjs
import { chromium } from "playwright-core"
import { startXvfb, startChrome, stopChrome, killGroup, groupPids, cpuPct, cgroupCpuPct, sleep, stats, r1, dropStartupTab } from "./lib/browser.mjs"
import { startSite } from "./lib/site.mjs"

const DUR = Number(process.env.DUR_MS || 10000)
const WIKI = "https://en.wikipedia.org/wiki/History_of_China"

const site = await startSite()
const x = await startXvfb()
const s = await startChrome({ display: x.display })
const b = await chromium.connectOverCDP(s.ws, { noDefaults: true })
const ctx = b.contexts()[0]
const page = await dropStartupTab(ctx)
const cdp = await ctx.newCDPSession(page)
await sleep(5000) // Chrome 刚启动的几秒有后台任务（组件、配置初始化），等它们过去再量
const out = { chrome: b.version(), durationMs: DUR, runs: [] }

// 同时量三份 CPU：Chrome 整个进程组、Xvfb、本 node 进程（解码 / 转发 screencast 的一方），再加容器 cgroup 总数
async function measureCpu(ms) {
  const n0 = process.cpuUsage()
  const [chrome, xvfb, total] = await Promise.all([
    cpuPct(() => groupPids(s.proc.pid), ms),
    cpuPct(() => [x.proc.pid], ms),
    cgroupCpuPct(ms),
  ])
  const n = process.cpuUsage(n0)
  return { chrome: r1(chrome), xvfb: r1(xvfb), node: r1((n.user + n.system) / 1000 / ms * 100), container: r1(total) }
}

// 从 JPEG 的 SOF 段读真实宽高（metadata.deviceWidth 是页面尺寸，缩放后图片尺寸要看图本身）
function jpegSize(b) {
  for (let i = 2; i < b.length - 9;) {
    if (b[i] !== 0xff) { i++; continue }
    const m = b[i + 1]
    if (m >= 0xc0 && m <= 0xc3) return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`
    i += 2 + b.readUInt16BE(i + 2)
  }
  return null
}

async function screencast({ label, quality = 60, ackDelay = 0, everyNthFrame = 1, maxWidth, maxHeight, during }) {
  const frames = []
  const onFrame = (f) => {
    frames.push({ t: performance.now(), bytes: Math.floor(f.data.length * 3 / 4), img: frames.length % 50 === 0 ? jpegSize(Buffer.from(f.data, "base64")) : null })
    const ack = () => cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {})
    ackDelay ? setTimeout(ack, ackDelay) : ack()
  }
  cdp.on("Page.screencastFrame", onFrame)
  await cdp.send("Page.startScreencast", { format: "jpeg", quality, everyNthFrame, ...(maxWidth ? { maxWidth, maxHeight } : {}) })
  await sleep(500) // 跳过首帧突发
  const t0 = performance.now(); const n0 = frames.length
  const stop = { v: false }
  const bg = during ? during(stop) : null
  const cpu = await measureCpu(DUR)
  stop.v = true; await bg
  const win = frames.slice(n0).filter((f) => f.t >= t0)
  await cdp.send("Page.stopScreencast")
  cdp.off("Page.screencastFrame", onFrame)
  const sz = stats(win.map((f) => f.bytes / 1024))
  const r = { label, quality, ackDelayMs: ackDelay, everyNthFrame, fps: r1(win.length / (DUR / 1000)), frameKB: { avg: r1(sz.avg || 0), p95: r1(sz.p95 || 0), max: r1(sz.max || 0) }, kbps: r1(win.reduce((a, f) => a + f.bytes, 0) * 8 / 1024 / (DUR / 1000)), imageSize: win.find((f) => f.img)?.img ?? null, cpu }
  out.runs.push(r); console.error(JSON.stringify(r))
}

async function baseline(label, during) {
  const stop = { v: false }; const bg = during ? during(stop) : null
  const cpu = await measureCpu(DUR); stop.v = true; await bg
  const r = { label, screencast: false, cpu }
  out.runs.push(r); console.error(JSON.stringify(r))
}

const wheel = async (stop) => {
  let dir = 1, n = 0
  while (!stop.v) {
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: 600, y: 400, deltaX: 0, deltaY: 200 * dir })
    if (++n % 40 === 0) dir = -dir
    await sleep(100)
  }
}

// 1) 静态页
await page.goto(site.base + "/index.html"); await sleep(1000)
await baseline("静态页，空闲")
await screencast({ label: "静态页（内容不变）" })

// 2) 持续动画（上限帧率）
await page.goto(site.base + "/anim.html"); await sleep(1000)
await baseline("动画页，不开 screencast")
await screencast({ label: "动画页 q60" })
await screencast({ label: "动画页 q80", quality: 80 })
await screencast({ label: "动画页 q60，ack 延迟 50ms（模拟按观看端 RTT 确认）", ackDelay: 50 })
await screencast({ label: "动画页 q60，ack 延迟 100ms", ackDelay: 100 })
await screencast({ label: "动画页 q60，everyNthFrame=2", everyNthFrame: 2 })
await screencast({ label: "动画页 q60，缩到 960x540 以内", maxWidth: 960, maxHeight: 540 })

// 3) 维基百科长页面 + 滚轮
try {
  await page.goto(WIKI, { waitUntil: "load", timeout: 45000 }); await sleep(2000)
  await baseline("维基长页面滚动，不开 screencast", wheel)
  await screencast({ label: "维基长页面滚动 q60（每 100ms 一次滚轮）", during: wheel })
  await screencast({ label: "维基长页面滚动 q40", quality: 40, during: wheel })
  await screencast({ label: "维基长页面滚动 q60，缩到 960x540 以内", maxWidth: 960, maxHeight: 540, during: wheel })
} catch (e) { out.wikiError = e.message.split("\n")[0] }

// 4) 输入 → 出帧延迟（容器内，本机，不含网络）
await page.goto(site.base + "/latency.html"); await sleep(800)
{
  let waiter = null
  const onFrame = (f) => { cdp.send("Page.screencastFrameAck", { sessionId: f.sessionId }).catch(() => {}); if (waiter) { const w = waiter; waiter = null; w(performance.now()) } }
  cdp.on("Page.screencastFrame", onFrame)
  await cdp.send("Page.startScreencast", { format: "jpeg", quality: 60 })
  await sleep(1000)
  const lat = { key: [], mouse: [] }
  for (let i = 0; i < 30; i++) {
    for (const kind of ["key", "mouse"]) {
      await sleep(250)
      const got = new Promise((r) => (waiter = r))
      const t0 = performance.now()
      if (kind === "key") {
        cdp.send("Input.dispatchKeyEvent", { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65, text: "a" })
        cdp.send("Input.dispatchKeyEvent", { type: "keyUp", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 })
      } else {
        cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: 300, y: 300, button: "left", clickCount: 1 })
        cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: 300, y: 300, button: "left", clickCount: 1 })
      }
      const t1 = await Promise.race([got, sleep(2000).then(() => null)])
      if (t1) lat[kind].push(t1 - t0)
    }
  }
  await cdp.send("Page.stopScreencast"); cdp.off("Page.screencastFrame", onFrame)
  const f = (a) => { const st = stats(a); return { n: st.n, p50: r1(st.p50), p95: r1(st.p95), max: r1(st.max) } }
  out.latencyMs = { key: f(lat.key), mouse: f(lat.mouse) }
  console.error(JSON.stringify(out.latencyMs))
}

await b.close()
await stopChrome(s)
await killGroup(x.proc)
await site.close()
console.log(JSON.stringify(out, null, 1))
