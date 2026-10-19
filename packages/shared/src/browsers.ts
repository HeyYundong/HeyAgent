// 浏览器页的纯函数（原型 browsers/data.ts）。
import type { BrowserProfile, BrowserProxy, BrowserSite, SessionRun, TaskDef } from "./schemas.js"
import { findById } from "./domain.js"
import { TIME_ZONE } from "./time.js"

/** Chrome 配置没填时区、语言时按这两个启动（服务端 browser/chrome.ts 里同样的默认值） */
export const DEFAULT_BROWSER_TIMEZONE = TIME_ZONE
export const DEFAULT_BROWSER_LOCALE = "zh-CN"

/** IANA 时区的规范写法（例如 asia/shanghai → Asia/Shanghai）；不认识的返回 undefined */
export function canonicalTimeZone(value: string): string | undefined {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value }).resolvedOptions().timeZone
  } catch {
    return undefined
  }
}

/** 语言代码的规范写法（例如 en-us → en-US）；不是 BCP 47 写法的返回 undefined。逗号、分号之类的拼不进 --accept-lang */
export function canonicalLocale(value: string): string | undefined {
  if (!/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(value)) return undefined
  try {
    return Intl.getCanonicalLocales(value)[0]
  } catch {
    return undefined
  }
}

/** 一个网站 = 平台 × 账号 */
export const siteKey = (site: Pick<BrowserSite, "platformId" | "account">) => `${site.platformId}|${site.account}`

/** 「登录过的网站」每行的并发说明 */
export function limitText(site: Pick<BrowserSite, "maxConcurrent" | "running">) {
  const text = `同时最多 ${site.maxConcurrent} 个 · 现在 ${site.running} 个在用`
  return site.running >= site.maxConcurrent ? `${text} · 满了，后面的排队` : text
}

export function proxyText(proxy: BrowserProxy) {
  return proxy.kind === "socks5" ? `SOCKS5 · ${proxy.host}:${proxy.port}` : "不用代理"
}

/** 有几个网站需要人去登录（失效或验证码） */
export function problemCount(profile: Pick<BrowserProfile, "sites">) {
  return profile.sites.filter((site) => site.status !== "ok").length
}

/**
 * 最近用了这个 Chrome 配置的运行：系统分配 Chrome 时记的「打开了 Chrome」过程（详情以「Chrome 配置 br-xx；」开头），
 * 或者工具调用的输入带着它的 id：browser.use 的 {"profileId": "br-xx"}；更早的数据是 {"browser": "br-xx"}（冒号前后有没有空格都行）
 */
export function recentRunsUsing(profileId: string, runs: readonly SessionRun[], tasks: readonly TaskDef[]) {
  const id = profileId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`"(profileId|browser)"\\s*:\\s*"${id}"`)
  const opened = `Chrome 配置 ${profileId}；`
  return runs
    .filter((run) => run.events.some((event) => (event.input && pattern.test(event.input)) || (event.kind === "plan" && event.detail?.startsWith(opened))))
    .slice(0, 3)
    .map((run) => ({ run, task: findById(tasks, run.taskId) }))
}
