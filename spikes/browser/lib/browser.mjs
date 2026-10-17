// 实测用的公共函数：起 Xvfb、起有界面 Chrome、按进程组关闭、读 /proc 和 cgroup 的资源数据。
// 只在 browser-base 容器里跑（node 24），playwright-core 从镜像的 /opt/browser/node_modules 解析。
import { spawn } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const CHROME_BIN = process.env.CHROME_BIN || "/opt/google/chrome/chrome"
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Xvfb 用 -displayfd 自己挑空闲的显示号，runner 并发起多个时不用自己分配。
export async function startXvfb({ width = 1366, height = 768 } = {}) {
  const proc = spawn("Xvfb", ["-displayfd", "3", "-screen", "0", `${width}x${height}x24`, "-nolisten", "tcp", "-noreset"], {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
    detached: true,
  })
  let err = ""
  proc.stderr.on("data", (d) => (err += d))
  const display = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Xvfb 启动超时：" + err)), 10000)
    proc.stdio[3].on("data", (d) => {
      clearTimeout(t)
      resolve(Number(String(d).trim()))
    })
    proc.once("exit", (c) => reject(new Error(`Xvfb 退出 ${c}：${err}`)))
  })
  return { proc, display }
}

// 推荐的启动参数（报告里的「推荐 Chrome 启动参数」以这里为准）。
export function chromeArgs({ udd, lang = "zh-CN", acceptLang = "zh-CN,zh", width = 1366, height = 768, proxy, hostResolverRules = true, webrtcPolicy = true, sandbox = true, extra = [] }) {
  const a = [
    `--user-data-dir=${udd}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    "--disable-blink-features=AutomationControlled",
    `--lang=${lang}`,
    `--accept-lang=${acceptLang}`,
    `--window-size=${width},${height}`,
    "--window-position=0,0",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    "--disable-features=Translate",
  ]
  if (proxy) {
    a.push(`--proxy-server=${proxy}`)
    if (hostResolverRules) a.push("--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1")
  }
  if (webrtcPolicy) a.push("--force-webrtc-ip-handling-policy=disable_non_proxied_udp")
  if (!sandbox) a.push("--no-sandbox")
  return [...a, ...extra]
}

// 容器刚起的 1～2 秒内，网卡的 IPv6 链路本地地址还在做重复地址检测（/proc/net/if_inet6 里带 tentative 标志），
// 检测结束时地址状态一变，Chrome 会认为「网络变了」，把正在进行的请求全部以 ERR_NETWORK_CHANGED 中断（实测）。
// 所以第一次起 Chrome 前先等地址稳定。runner 常驻时只影响容器刚启动的那一下。
let netSettled = null
export function waitNetworkSettled(timeoutMs = 10000) {
  netSettled ??= (async () => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      let tentative = false
      try { tentative = fs.readFileSync("/proc/net/if_inet6", "utf8").trim().split("\n").some((l) => (parseInt(l.split(/\s+/)[4], 16) & 0x40) !== 0) } catch {}
      if (!tentative) return Date.now() - t0
      await sleep(200)
    }
    return -1
  })()
  return netSettled
}

export async function startChrome({ display, tz = "Asia/Shanghai", url = "about:blank", ...opts } = {}) {
  await waitNetworkSettled()
  const udd = fs.mkdtempSync(path.join(os.tmpdir(), "sess-"))
  const args = [...chromeArgs({ udd, ...opts }), url]
  // detached：Chrome 自成一个进程组，关闭时整组杀掉，不留 zygote / renderer。
  const proc = spawn(CHROME_BIN, args, {
    env: { ...process.env, DISPLAY: `:${display}`, TZ: tz },
    stdio: ["ignore", "ignore", "pipe"],
    detached: true,
  })
  const stderr = []
  const ws = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("Chrome 启动超时：\n" + stderr.join(""))), 20000)
    proc.stderr.on("data", (d) => {
      stderr.push(String(d))
      const m = String(d).match(/DevTools listening on (ws:\S+)/)
      if (m) {
        clearTimeout(t)
        resolve(m[1])
      }
    })
    proc.once("exit", (c, s) => reject(new Error(`Chrome 退出 code=${c} signal=${s}\n${stderr.join("")}`)))
  })
  return { proc, udd, ws, args, stderr }
}

export async function killGroup(proc, ms = 5000) {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return
  const done = new Promise((r) => proc.once("exit", r))
  try { process.kill(-proc.pid, "SIGTERM") } catch {}
  const t = await Promise.race([done.then(() => "ok"), sleep(ms).then(() => "timeout")])
  if (t === "timeout") { try { process.kill(-proc.pid, "SIGKILL") } catch {} ; await done }
}

export async function stopChrome(s) {
  await killGroup(s.proc)
  // 进程组里的子进程可能比主进程晚退出一点，等它们走完再删目录
  for (let i = 0; i < 20 && groupPids(s.proc.pid).length; i++) await sleep(100)
  fs.rmSync(s.udd, { recursive: true, force: true })
}

// ---------- /proc 读数 ----------
function readStat(pid) {
  try {
    const s = fs.readFileSync(`/proc/${pid}/stat`, "utf8")
    const rest = s.slice(s.lastIndexOf(")") + 2).split(" ")
    return { pid: Number(pid), ppid: Number(rest[1]), pgrp: Number(rest[2]), utime: Number(rest[11]), stime: Number(rest[12]), comm: s.slice(s.indexOf("(") + 1, s.lastIndexOf(")")) }
  } catch { return null }
}
export const allProcs = () => fs.readdirSync("/proc").filter((d) => /^\d+$/.test(d)).map(readStat).filter(Boolean)
export const groupPids = (pgid) => allProcs().filter((p) => p.pgrp === pgid).map((p) => p.pid)
export function treePids(root) {
  const ps = allProcs(); const out = [root]
  for (let i = 0; i < out.length; i++) for (const p of ps) if (p.ppid === out[i]) out.push(p.pid)
  return out
}
// PSS：读 smaps_rollup。sandbox 里的 renderer 被设成不可 dump，读不到时记在 unreadable 里，不悄悄算成 0。
export function pssOf(pids) {
  let kb = 0, unreadable = 0
  for (const p of pids) {
    try { kb += Number(fs.readFileSync(`/proc/${p}/smaps_rollup`, "utf8").match(/^Pss:\s+(\d+)/m)[1]) } catch { unreadable++ }
  }
  return { mb: kb / 1024, unreadable, n: pids.length }
}
export const ticksOf = (pids) => pids.reduce((s, p) => { const st = readStat(p); return st ? s + st.utime + st.stime : s }, 0)
const HZ = 100
// 采样期间的 CPU（单核 = 100%）。pidsFn 每次重新取，覆盖采样期间新起的 renderer。
export async function cpuPct(pidsFn, ms) {
  const before = new Map(pidsFn().map((p) => [p, ticksOf([p])]))
  await sleep(ms)
  let d = 0
  for (const p of pidsFn()) d += ticksOf([p]) - (before.get(p) ?? 0)
  return (d / HZ) / (ms / 1000) * 100
}

// ---------- cgroup（容器整体）----------
export function cgroup() {
  const r = (f) => { try { return fs.readFileSync(`/sys/fs/cgroup/${f}`, "utf8") } catch { return null } }
  const stat = r("memory.stat") || ""
  const g = (k) => Number((stat.match(new RegExp(`^${k} (\\d+)`, "m")) || [])[1] || 0) / 1048576
  const usage = Number(((r("cpu.stat") || "").match(/usage_usec (\d+)/) || [])[1] || 0)
  return { memCurrentMB: Number(r("memory.current") || 0) / 1048576, anonMB: g("anon"), fileMB: g("file"), shmemMB: g("shmem"), cpuUsec: usage }
}
export async function cgroupCpuPct(ms) {
  const a = cgroup().cpuUsec; await sleep(ms); const b = cgroup().cpuUsec
  return ((b - a) / 1000) / ms * 100
}
export function shmUsedMB() {
  try { const st = fs.statfsSync("/dev/shm"); return ((st.blocks - st.bfree) * st.bsize) / 1048576 } catch { return null }
}

// CDP 只绑 127.0.0.1：从 /proc/net/tcp 找 LISTEN 的端口和地址
export function listeners() {
  const out = []
  for (const f of ["/proc/net/tcp", "/proc/net/tcp6"]) {
    let t = ""; try { t = fs.readFileSync(f, "utf8") } catch { continue }
    for (const line of t.trim().split("\n").slice(1)) {
      const c = line.trim().split(/\s+/)
      if (c[3] !== "0A") continue
      const [ah, ph] = c[1].split(":")
      const addr = ah.length === 8 ? ah.match(/../g).reverse().map((h) => parseInt(h, 16)).join(".") : (ah === "00000000000000000000000000000000" ? "::" : ah)
      out.push(`${addr}:${parseInt(ph, 16)}`)
    }
  }
  return out
}

export const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b); const n = s.length
  if (!n) return { n: 0 }
  const q = (p) => s[Math.min(n - 1, Math.floor(p * n))]
  return { n, min: s[0], p50: q(0.5), p95: q(0.95), max: s[n - 1], avg: s.reduce((a, b) => a + b, 0) / n }
}
export const r1 = (x) => Math.round(x * 10) / 10

// --disable-blink-features=AutomationControlled 会让 Chrome 在启动时的第一个标签页顶上显示
// 「不受支持的命令行标记」提示条（实测 Chrome 155：视口高度少 56px，只出现在启动标签页）。
// 编排器连上后新开一个标签页、关掉启动标签页，之后的页面就没有这个提示条。
export async function dropStartupTab(ctx) {
  const startup = ctx.pages()
  const p = await ctx.newPage()
  for (const s of startup) await s.close().catch(() => {})
  return p
}
