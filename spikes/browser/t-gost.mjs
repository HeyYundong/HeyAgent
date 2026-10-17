// gost 实测：Chrome → 本机无认证 SOCKS5（gost）→ 带认证的上游 SOCKS5（本地测试服务器）。
// 看：链路能通；上游收到的是域名（ATYP=DOMAIN）；容器里有没有走系统解析的 DNS 查询（DNS 记录器）；
// 密码错 / gost 挂掉时 Chrome 是报错还是偷偷直连；WebRTC 会暴露哪些候选地址。
// 要求容器参数：--dns=127.0.0.1 --sysctl net.ipv4.ip_unprivileged_port_start=0，环境变量 UPSTREAM_DNS=真实 DNS。
// 用法（容器内）：UPSTREAM_DNS=10.0.2.3 node t-gost.mjs
import { chromium } from "playwright-core"
import { spawn } from "node:child_process"
import fs from "node:fs"
import { startXvfb, startChrome, stopChrome, killGroup, sleep } from "./lib/browser.mjs"
import { startSite } from "./lib/site.mjs"
import { startSocks } from "./lib/socks.mjs"
import { startDnsLog } from "./lib/dnslog.mjs"

const UPSTREAM_DNS = process.env.UPSTREAM_DNS
if (!UPSTREAM_DNS) throw new Error("需要 UPSTREAM_DNS")
const USER = "heyagent", PASS = "p@ss:w0rd/测试" // 故意带 @ : / 和中文，验证转义
const GOST_PORT = 11080

const dnsLog = await startDnsLog({ upstream: UPSTREAM_DNS })
const upstream = await startSocks({ user: USER, pass: PASS, dnsServer: UPSTREAM_DNS })
const site = await startSite()
const x = await startXvfb()
const out = { upstreamPort: upstream.port, cases: [] }

function startGost(args) {
  const p = spawn("gost", args, { stdio: ["ignore", "pipe", "pipe"], detached: true })
  const logs = []
  p.stdout.on("data", (d) => logs.push(String(d))); p.stderr.on("data", (d) => logs.push(String(d)))
  return { p, logs }
}
const gostVersion = await new Promise((r) => { const p = spawn("gost", ["-V"]); let o = ""; p.stdout.on("data", (d) => (o += d)); p.on("exit", () => r(o.trim())) })
out.gostVersion = gostVersion

function yaml(pass) {
  // 推荐：密码写进 0600 的配置文件，不出现在任何进程的命令行里
  return `services:
- name: local
  addr: 127.0.0.1:${GOST_PORT}
  handler:
    type: socks5
    chain: upstream
  listener:
    type: tcp
chains:
- name: upstream
  hops:
  - name: hop-0
    nodes:
    - name: node-0
      addr: 127.0.0.1:${upstream.port}
      connector:
        type: socks5
        auth:
          username: ${JSON.stringify(USER)}
          password: ${JSON.stringify(pass)}
      dialer:
        type: tcp
log:
  level: info
  format: text
`
}

const URLS = ["http://example.com/", "https://example.com/", "https://en.wikipedia.org/wiki/Main_Page"]

async function runCase(name, { gostArgs, chromeOpts = {}, urls = URLS, settleMs = 3000, extra, direct = false }) {
  const g = gostArgs ? startGost(gostArgs) : null
  await sleep(800)
  upstream.log.length = 0; dnsLog.log.length = 0
  const s = await startChrome({ display: x.display, proxy: direct ? undefined : `socks5://127.0.0.1:${GOST_PORT}`, ...chromeOpts })
  const b = await chromium.connectOverCDP(s.ws, { noDefaults: true })
  const ctx = b.contexts()[0]
  const p = ctx.pages()[0] || (await ctx.newPage())
  const nav = []
  for (const u of urls) {
    try { const r = await p.goto(u, { waitUntil: "load", timeout: 25000 }); nav.push({ url: u, status: r?.status(), title: await p.title() }) }
    catch (e) { nav.push({ url: u, error: e.message.split("\n")[0].slice(0, 120) }) }
  }
  const res = { name, nav }
  if (extra) Object.assign(res, await extra(p))
  await sleep(settleMs) // 让后台请求（Chrome 自己的组件更新等）也跑一会儿
  const connects = upstream.log.filter((l) => l.ev === "connect")
  res.upstream = {
    auth: [...new Set(upstream.log.filter((l) => l.ev === "auth").map((l) => (l.ok ? "ok" : "FAIL")))],
    atyp: [...new Set(connects.map((l) => l.atyp))],
    hosts: [...new Set(connects.map((l) => `${l.host}:${l.port}`))],
  }
  res.localDnsQueries = [...new Set(dnsLog.log.map((q) => `${q.name} ${q.qtype}`))]
  if (g) res.gostLogTail = g.logs.join("").split("\n").filter((l) => /error|fail|resolve/i.test(l)).slice(-5)
  await b.close(); await stopChrome(s)
  if (g) await killGroup(g.p)
  out.cases.push(res); console.error(JSON.stringify(res))
}

// 0. 对照：不走代理直连，确认 DNS 记录器确实能记到 Chrome 的解析请求（否则后面的「0 条」不可信）
await runCase("对照：直连不走代理", { direct: true, urls: ["http://example.com/"], settleMs: 500 })
const encoded = encodeURIComponent(PASS)
// 1. 命令行写法（-L/-F），密码 URL 编码
await runCase("命令行 -L/-F，密码 URL 编码", { gostArgs: ["-L", `socks5://127.0.0.1:${GOST_PORT}`, "-F", `socks5://${USER}:${encoded}@127.0.0.1:${upstream.port}`] })
// 2. 配置文件写法（推荐）
fs.writeFileSync("/tmp/gost.yaml", yaml(PASS), { mode: 0o600 })
await runCase("配置文件 -C（推荐）", { gostArgs: ["-C", "/tmp/gost.yaml"] })
// 3. 不加 --host-resolver-rules，看 Chrome 会不会自己做本地解析
await runCase("同 2，但不加 --host-resolver-rules", { gostArgs: ["-C", "/tmp/gost.yaml"], chromeOpts: { hostResolverRules: false } })
// 3b. 关掉 Chrome 自己的后台联网（组件更新、各种 Google 服务），看经代理出去的请求少了多少
await runCase("同 2，加 --disable-background-networking --disable-component-update", { gostArgs: ["-C", "/tmp/gost.yaml"], chromeOpts: { extra: ["--disable-background-networking", "--disable-component-update"] } })
// 4. 密码错
fs.writeFileSync("/tmp/gost-bad.yaml", yaml("wrong-password"), { mode: 0o600 })
await runCase("上游密码错", { gostArgs: ["-C", "/tmp/gost-bad.yaml"], urls: ["http://example.com/"], settleMs: 500 })
// 5. gost 没起
await runCase("gost 没起（转发挂了）", { gostArgs: null, urls: ["http://example.com/"], settleMs: 500 })
// 6. WebRTC 候选地址：有 / 没有 --force-webrtc-ip-handling-policy
const webrtc = async (p) => { await p.goto(site.base + "/webrtc.html"); const c = await p.evaluate(() => window.__done); return { webrtcCandidates: c.map((l) => l.split(" ").slice(4, 8).join(" ")) } }
await runCase("WebRTC，带 disable_non_proxied_udp", { gostArgs: ["-C", "/tmp/gost.yaml"], urls: [], settleMs: 300, extra: webrtc })
await runCase("WebRTC，不带策略参数", { gostArgs: ["-C", "/tmp/gost.yaml"], urls: [], settleMs: 300, extra: webrtc, chromeOpts: { webrtcPolicy: false } })

for (const f of ["/tmp/gost.yaml", "/tmp/gost-bad.yaml"]) fs.rmSync(f, { force: true })
await killGroup(x.proc)
await site.close(); await upstream.close(); dnsLog.close()
console.log(JSON.stringify(out, null, 1))
