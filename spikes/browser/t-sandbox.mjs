// sandbox 实测：不加 --no-sandbox 起有界面 Chrome，读 chrome://sandbox，看各层 sandbox 是否生效、页面能否正常渲染。
// 用法（容器内）：node t-sandbox.mjs [--no-sandbox]
import { chromium } from "playwright-core"
import fs from "node:fs"
import { startXvfb, startChrome, stopChrome, killGroup, listeners } from "./lib/browser.mjs"
import { startSite } from "./lib/site.mjs"

const noSandbox = process.argv.includes("--no-sandbox")
const out = { noSandbox, uid: process.getuid(), shm: null }
try { const st = fs.statfsSync("/dev/shm"); out.shm = Math.round(st.blocks * st.bsize / 1048576) + "MB" } catch {}
try { out.chromeSandboxMode = (fs.statSync("/opt/google/chrome/chrome-sandbox").mode & 0o7777).toString(8) } catch (e) { out.chromeSandboxMode = String(e.code) }
out.pid1 = fs.readFileSync("/proc/1/cmdline", "utf8").split("\0").filter(Boolean).join(" ")

const site = await startSite()
const x = await startXvfb()
let s
try {
  s = await startChrome({ display: x.display, sandbox: !noSandbox })
  out.started = true
  out.cdpListen = listeners().filter((l) => l.endsWith(":" + new URL(s.ws).port))
  const b = await chromium.connectOverCDP(s.ws, { noDefaults: true })
  const ctx = b.contexts()[0]
  const p = ctx.pages()[0] || (await ctx.newPage())
  await p.goto("chrome://sandbox")
  await p.waitForTimeout(500)
  out.sandboxPage = (await p.textContent("body")).replace(/\s+\n/g, "\n").replace(/[ \t]+/g, " ").trim().split("\n").filter(Boolean)
  await p.goto(site.base + "/index.html")
  out.renderOk = (await p.title()) === "HeyAgent 远程画面测试页"
  out.stderrWarnings = s.stderr.join("").split("\n").filter((l) => /sandbox|seccomp|namespace|zygote|FATAL/i.test(l)).slice(0, 10)
  await b.close()
} catch (e) {
  out.started = false
  out.error = String(e.message).split("\n").slice(0, 15)
} finally {
  if (s) await stopChrome(s)
  await killGroup(x.proc)
  await site.close()
}
// 关掉 Chrome 后看有没有僵尸进程（没有 --init 时 PID 1 是 node，不会回收被过继过来的孙进程）
await new Promise((r) => setTimeout(r, 1000))
out.zombiesAfterClose = fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map((d) => { try { const st = fs.readFileSync(`/proc/${d}/stat`, "utf8"); return { comm: st.slice(st.indexOf("(") + 1, st.lastIndexOf(")")), state: st.slice(st.lastIndexOf(")") + 2).split(" ")[0] } } catch { return null } }).filter((p) => p && p.state === "Z").map((p) => p.comm)
console.log(JSON.stringify(out, null, 1))
