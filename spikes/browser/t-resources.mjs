// 资源实测：同时开 1 / 3 / 5 个有界面 Chrome（各带一个 Xvfb），打开维基百科长页面，量内存（PSS、cgroup）和 CPU。
// 用法（容器内）：node t-resources.mjs [1,3,5]
import { chromium } from "playwright-core"
import { startXvfb, startChrome, stopChrome, killGroup, groupPids, pssOf, cpuPct, cgroup, cgroupCpuPct, shmUsedMB, sleep, r1 } from "./lib/browser.mjs"

const NS = (process.argv[2] || "1,3,5").split(",").map(Number)
const URLS = [
  "https://en.wikipedia.org/wiki/History_of_China",
  "https://zh.wikipedia.org/wiki/%E4%B8%AD%E5%9B%BD%E5%8E%86%E5%8F%B2",
  "https://en.wikipedia.org/wiki/World_War_II",
  "https://zh.wikipedia.org/wiki/%E7%AC%AC%E4%BA%8C%E6%AC%A1%E4%B8%96%E7%95%8C%E5%A4%A7%E6%88%98",
  "https://en.wikipedia.org/wiki/United_States",
]
const out = { baseline: cgroup(), runs: [] }

for (const n of NS) {
  const base = cgroup()
  const xs = [], ss = []
  for (let i = 0; i < n; i++) { const x = await startXvfb(); xs.push(x); ss.push(await startChrome({ display: x.display })) }
  const bs = await Promise.all(ss.map((s) => chromium.connectOverCDP(s.ws, { noDefaults: true })))
  const pages = await Promise.all(bs.map(async (b) => b.contexts()[0].pages()[0] || b.contexts()[0].newPage()))
  await sleep(1500)
  const startup = cgroup()
  // 加载阶段：10 秒窗口内同时导航
  const loadCpuP = Promise.all([
    Promise.all(ss.map((s) => cpuPct(() => groupPids(s.proc.pid), 10000))),
    cgroupCpuPct(10000),
  ])
  const t0 = Date.now()
  const loads = await Promise.all(pages.map((p, i) => p.goto(URLS[i % URLS.length], { waitUntil: "load", timeout: 45000 }).then(() => Date.now() - t0).catch((e) => "ERR " + e.message.slice(0, 60))))
  const [perChromeLoad, containerLoad] = await loadCpuP
  await sleep(5000)
  const mem = ss.map((s) => pssOf(groupPids(s.proc.pid)))
  const xvfbMem = xs.map((x) => pssOf([x.proc.pid]).mb)
  const cg = cgroup()
  const shm = shmUsedMB()
  const [perChromeIdle, containerIdle] = await Promise.all([
    Promise.all(ss.map((s) => cpuPct(() => groupPids(s.proc.pid), 10000))),
    cgroupCpuPct(10000),
  ])
  const r = {
    n,
    loadMs: loads,
    pssPerChromeMB: mem.map((m) => r1(m.mb)),
    pssUnreadableProcs: mem.map((m) => `${m.unreadable}/${m.n}`),
    pssTotalChromeMB: r1(mem.reduce((a, m) => a + m.mb, 0)),
    pssPerXvfbMB: xvfbMem.map(r1),
    cgroupMemDeltaMB: { afterStartup: r1(startup.memCurrentMB - base.memCurrentMB), afterLoad: r1(cg.memCurrentMB - base.memCurrentMB), anonDelta: r1(cg.anonMB - base.anonMB), shmem: r1(cg.shmemMB), file: r1(cg.fileMB) },
    devShmUsedMB: shm == null ? null : r1(shm),
    cpuLoad10sPct: { perChrome: perChromeLoad.map(r1), container: r1(containerLoad) },
    cpuIdle10sPct: { perChrome: perChromeIdle.map(r1), container: r1(containerIdle) },
  }
  out.runs.push(r); console.error(JSON.stringify(r))
  for (const b of bs) await b.close().catch(() => {})
  for (const s of ss) await stopChrome(s)
  for (const x of xs) await killGroup(x.proc)
  await sleep(3000)
}
console.log(JSON.stringify(out, null, 1))
