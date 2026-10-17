// 浏览器页留在前端的东西：远程画面默认打开的网址、新建时的空白 Chrome、详情里几张卡的行（docs/dev/m0-api.md 2.6）。
// Chrome 本身来自 browsers.list，平台名来自 platforms.list；siteKey、limitText 等纯函数在 shared。
import { findById, fmtDateTime, type BrowserProfile, type Platform } from "@heyagent/shared"

import { usePlatformsQuery } from "@/lib/data"

export { limitText, problemCount, proxyText, recentRunsUsing, siteKey } from "@heyagent/shared"

/** 页面里的 Chrome = 接口返回的 BrowserProfile */
export type Chrome = BrowserProfile

/** 远程画面默认打开的网址。「去登录」时打开这个账号配置的登录探测网址（BrowserSite.probeUrl），没配就打开这个 */
export const HOME_URL = "https://www.google.com"

/** 按 id 显示平台名（不在平台表里的，直接显示 id） */
export function usePlatformName() {
  const platforms = usePlatformsQuery().data ?? []
  return (id: string) => findById(platforms, id)?.name ?? id
}

/** 员工在远程画面里登录新网站时填的网站名 → platformId（不在平台表里的，直接用名字当 id） */
export function platformIdOf(platforms: Platform[], name: string) {
  return platforms.find((platform) => platform.name === name)?.id ?? name
}

/** 新建时的空白 Chrome */
export function blankProfile(): Chrome {
  return {
    id: `br-new-${Date.now()}`,
    name: "",
    description: "",
    proxy: { kind: "none" },
    exitIp: "第一次打开时检测",
    running: 0,
    sites: [],
    cookieCount: 0,
    vaultVersion: 1,
    updatedAt: new Date().toISOString(),
  }
}

/** 「这个账号同时最多几个 session」的选项 */
export const MAX_ITEMS = ["1", "2", "3", "4", "5"]

/** 详情「代理」卡的几行；不用代理时返回空 */
export function proxyRows(profile: Chrome): [string, string][] {
  const { proxy } = profile
  if (proxy.kind !== "socks5") return []
  return [
    ["类型", "SOCKS5"],
    ["主机:端口", `${proxy.host}:${proxy.port}`],
    ["用户名", proxy.username ?? "不需要"],
    ["出口 IP", profile.exitIp],
  ]
}

/** 详情「登录态保险箱」卡的几行 */
export function vaultRows(profile: Chrome): [string, string][] {
  return [
    ["cookie", `${profile.cookieCount} 个`],
    ["版本", `v${profile.vaultVersion}`],
    ["更新时间", fmtDateTime(profile.updatedAt)],
    ["现在开着", profile.running ? `${profile.running} 个 session` : "没有（空闲）"],
  ]
}
