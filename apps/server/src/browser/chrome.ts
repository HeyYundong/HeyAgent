// 起 Xvfb 和有界面的 Chrome、按进程组关掉。参数照 docs/research/m0-browser-spike.md 第 3 节（实测过）。
// 只在 worker 镜像里能真正跑起来（要 Xvfb 和 Google Chrome）；开发机上调用会报「没有 Chrome」。
import { spawn, type ChildProcess } from "node:child_process"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { setTimeout as sleep } from "node:timers/promises"

export const CHROME_BIN = process.env.CHROME_BIN || "/opt/google/chrome/chrome"
export const XVFB_BIN = process.env.XVFB_BIN || "Xvfb"

export const SCREEN = { width: 1366, height: 768 }

export class BrowserUnavailableError extends Error {}

/** 这台机器能不能起 Chrome（worker 镜像里能；开发机没有 Chrome 和 Xvfb） */
export function chromeAvailable() {
  return existsSync(CHROME_BIN)
}

export interface XvfbHandle {
  proc: ChildProcess
  display: number
}

/** Xvfb 用 -displayfd 自己挑空闲的显示号，同时起多个时不用自己分配 */
export async function startXvfb(): Promise<XvfbHandle> {
  const proc = spawn(XVFB_BIN, ["-displayfd", "3", "-screen", "0", `${SCREEN.width}x${SCREEN.height}x24`, "-nolisten", "tcp", "-noreset"], {
    stdio: ["ignore", "ignore", "pipe", "pipe"],
    detached: true,
  })
  let stderr = ""
  proc.stderr!.on("data", (chunk) => (stderr = (stderr + String(chunk)).slice(-4000)))
  const display = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrowserUnavailableError(`Xvfb 启动超时：${stderr}`)), 10_000)
    ;(proc.stdio[3] as NodeJS.ReadableStream).on("data", (chunk) => {
      clearTimeout(timer)
      resolve(Number(String(chunk).trim()))
    })
    proc.once("error", (error) => {
      clearTimeout(timer)
      reject(new BrowserUnavailableError(`起不了 Xvfb：${error.message}`))
    })
    proc.once("exit", (code) => {
      clearTimeout(timer)
      reject(new BrowserUnavailableError(`Xvfb 退出了（${code}）：${stderr}`))
    })
  })
  return { proc, display }
}

export interface ChromeOptions {
  userDataDir: string
  display: number
  /** 例如 zh-CN；不填用 zh-CN */
  locale?: string
  /** 例如 Asia/Shanghai；不填用 Asia/Shanghai */
  timezone?: string
  /** 例如 socks5://127.0.0.1:11080；不填 = 直连 */
  proxyServer?: string
  /** --host-resolver-rules 里 EXCLUDE 的主机（代理本身），默认 127.0.0.1 */
  proxyHost?: string
  /** Chrome 的 TMPDIR（默认用 userDataDir） */
  tmpDir?: string
}

/** Accept-Language：zh-CN → zh-CN,zh；en-US → en-US,en */
export function acceptLanguage(locale: string) {
  const base = locale.split("-")[0]!
  return base && base !== locale ? `${locale},${base}` : locale
}

/**
 * 推荐的启动参数（m0-browser-spike.md 3 节）+ 关掉 Chrome 自己的后台联网（实测新 profile 会经代理连十几个 Google 地址）。
 * 不加：--no-sandbox、--headless、--enable-automation、--disable-dev-shm-usage。
 */
export function chromeArgs(options: ChromeOptions): string[] {
  const locale = options.locale || "zh-CN"
  const args = [
    `--user-data-dir=${options.userDataDir}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    // 去掉就 navigator.webdriver = true；副作用是启动标签页有提示条，连上后换掉启动标签页
    "--disable-blink-features=AutomationControlled",
    `--lang=${locale}`,
    `--accept-lang=${acceptLanguage(locale)}`,
    `--window-size=${SCREEN.width},${SCREEN.height}`,
    "--window-position=0,0",
    "--no-first-run",
    "--no-default-browser-check",
    "--password-store=basic",
    // 后台联网：更新、同步、翻译、安全浏览的下载、域名可靠性上报、预取等（省代理流量，见 m2.md 第 2 条）
    "--disable-background-networking",
    "--disable-component-update",
    "--disable-sync",
    "--disable-domain-reliability",
    "--disable-client-side-phishing-detection",
    "--disable-default-apps",
    "--no-pings",
    "--disable-features=Translate,OptimizationHints,OptimizationGuideModelDownloading,MediaRouter,AutofillServerCommunication,InterestFeedContentSuggestions,CertificateTransparencyComponentUpdater",
    // 防 WebRTC 泄漏真实 IP（没有代理也加：服务器的内网地址也不该暴露给网站）
    "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
  ]
  if (options.proxyServer) {
    args.push(`--proxy-server=${options.proxyServer}`)
    // 防 DNS 泄漏：除了代理本身，所有域名都交给代理解析（实测不加也没有本地查询，这里兜底）
    args.push(`--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE ${options.proxyHost || "127.0.0.1"}`)
  }
  args.push("about:blank")
  return args
}

/**
 * 容器刚起的 1～2 秒里，网卡的 IPv6 链路本地地址还在做重复地址检测，检测结束时 Chrome 会把正在进行的请求都以
 * ERR_NETWORK_CHANGED 中断（实测）。第一次起 Chrome 前先等 /proc/net/if_inet6 里没有 tentative 标志的地址。
 */
let netSettled: Promise<void> | undefined
export function waitNetworkSettled(timeoutMs = 10_000) {
  netSettled ??= (async () => {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      let tentative: boolean
      try {
        tentative = readFileSync("/proc/net/if_inet6", "utf8")
          .trim()
          .split("\n")
          .some((line) => (parseInt(line.split(/\s+/)[4] ?? "0", 16) & 0x40) !== 0)
      } catch {
        return
      }
      if (!tentative) return
      await sleep(200)
    }
  })()
  return netSettled
}

export interface ChromeHandle {
  proc: ChildProcess
  wsEndpoint: string
}

/** Chrome 的 stderr 里有大量 dbus 报错，不影响功能，日志里过滤掉 */
const NOISE = /dbus|Failed to connect to the bus|org\.freedesktop|Fontconfig|gpu_init|viz_main/i

export async function startChrome(options: ChromeOptions): Promise<ChromeHandle> {
  if (!chromeAvailable()) throw new BrowserUnavailableError(`这台机器上没有 Chrome（${CHROME_BIN}），浏览器只能在 worker 镜像里用`)
  await waitNetworkSettled()
  const proc = spawn(CHROME_BIN, chromeArgs(options), {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: options.userDataDir,
      LANG: process.env.LANG ?? "C.UTF-8",
      DISPLAY: `:${options.display}`,
      TZ: options.timezone || "Asia/Shanghai",
      // Chrome 会在 TMPDIR 里留 SingletonSocket 之类的目录：放进这个 Chrome 自己的临时目录，关掉时一起删
      TMPDIR: options.tmpDir ?? options.userDataDir,
    },
    stdio: ["ignore", "ignore", "pipe"],
    // Chrome 自成一个进程组，关闭时整组杀掉，不留 zygote / renderer
    detached: true,
  })
  const tail: string[] = []
  const wsEndpoint = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new BrowserUnavailableError(`Chrome 启动超时：${tail.join("")}`)), 30_000)
    proc.stderr!.on("data", (chunk) => {
      const text = String(chunk)
      for (const line of text.split("\n")) if (line.trim() && !NOISE.test(line)) tail.push(`${line}\n`)
      tail.splice(0, Math.max(0, tail.length - 30))
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(text)
      if (match) {
        clearTimeout(timer)
        resolve(match[1]!)
      }
    })
    proc.once("error", (error) => {
      clearTimeout(timer)
      reject(new BrowserUnavailableError(`起不了 Chrome：${error.message}`))
    })
    proc.once("exit", (code, signal) => {
      clearTimeout(timer)
      reject(new BrowserUnavailableError(`Chrome 退出了（code=${code} signal=${signal}）：${tail.join("")}`))
    })
  })
  return { proc, wsEndpoint }
}

function groupPids(pgid: number) {
  const out: number[] = []
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const stat = readFileSync(`/proc/${entry}/stat`, "utf8")
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ")
      if (Number(rest[2]) === pgid) out.push(Number(entry))
    } catch {
      // 进程刚好退出了
    }
  }
  return out
}

/** 按进程组关掉（先 SIGTERM，等不到就 SIGKILL），再等组里的子进程都走完 */
export async function killGroup(proc: ChildProcess | undefined, waitMs = 5000) {
  if (!proc?.pid) return
  const pid = proc.pid
  const alive = proc.exitCode === null && proc.signalCode === null
  if (alive) {
    const exited = new Promise((resolve) => proc.once("exit", resolve))
    try {
      process.kill(-pid, "SIGTERM")
    } catch {
      // 已经没了
    }
    const outcome = await Promise.race([exited.then(() => "ok"), sleep(waitMs).then(() => "timeout")])
    if (outcome === "timeout") {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        // 已经没了
      }
      await Promise.race([exited, sleep(2000)])
    }
  }
  for (let i = 0; i < 30 && groupPids(pid).length; i++) {
    if (i === 20) {
      try {
        process.kill(-pid, "SIGKILL")
      } catch {
        // 已经没了
      }
    }
    await sleep(100)
  }
}
