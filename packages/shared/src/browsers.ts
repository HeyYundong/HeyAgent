// 浏览器页的纯函数（原型 browsers/data.ts）。
import type { BrowserProfile, BrowserProxy, BrowserSite, SessionRun, TaskDef } from "./schemas.js"
import { findById } from "./domain.js"

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
 * 最近选用了这个 Chrome 配置的运行：过程里工具调用的输入带着它的 id。
 * M2 起是 browser.use 的 {"profileId": "br-xx"}；更早的数据是 {"browser": "br-xx"}，两种都认（冒号前后有没有空格都行）
 */
export function recentRunsUsing(profileId: string, runs: readonly SessionRun[], tasks: readonly TaskDef[]) {
  const id = profileId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const pattern = new RegExp(`"(profileId|browser)"\\s*:\\s*"${id}"`)
  return runs
    .filter((run) => run.events.some((event) => event.input && pattern.test(event.input)))
    .slice(0, 3)
    .map((run) => ({ run, task: findById(tasks, run.taskId) }))
}
