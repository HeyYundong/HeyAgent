// 浏览器页留在前端的东西：并发上限选项、详情里几张卡的行、开着的 Chrome 的状态文字。
// Chrome 配置来自 browsers.list，平台来自 platforms.list，账号使用情况来自 browser.accountStatus，开着的 Chrome 来自 browser.live。
import { findById, fmtDateTime, type AccountUsage, type BrowserProfile, type LiveBrowser } from "@heyagent/shared"
import { useQuery } from "@tanstack/react-query"

import { usePlatformsQuery } from "@/lib/data"
import { trpc } from "@/lib/trpc"

export { problemCount, proxyText, recentRunsUsing, siteKey } from "@heyagent/shared"

/** 页面里的 Chrome = 接口返回的 BrowserProfile */
export type Chrome = BrowserProfile

export const useLiveBrowsersQuery = () => useQuery(trpc.browser.live.queryOptions())
export const useAccountStatusQuery = () => useQuery(trpc.browser.accountStatus.queryOptions())

/** 按 id 显示平台名（不在平台表里的，直接显示 id） */
export function usePlatformName() {
  const platforms = usePlatformsQuery().data ?? []
  return (id: string) => findById(platforms, id)?.name ?? id
}

/** 「这个账号同时最多几个 session」的选项 */
export const MAX_ITEMS = ["1", "2", "3", "4", "5"]

/** 「登录过的网站」每行的并发说明（用实时的账号使用情况） */
export function usageText(usage: Pick<AccountUsage, "used" | "max" | "waiting">) {
  const parts = [`同时最多 ${usage.max} 个 · 现在 ${usage.used} 个在用`]
  if (usage.waiting > 0) parts.push(`${usage.waiting} 个在排队`)
  else if (usage.used >= usage.max) parts.push("满了，后面的排队")
  return parts.join(" · ")
}

/** 开着的 Chrome 的状态 */
export const LIVE_STATE: Record<LiveBrowser["state"], string> = {
  queued: "排队等空位",
  starting: "正在启动",
  running: "开着",
  held: "保留着，等人处理",
  closing: "正在关闭",
}

/** 详情「代理和登录态」卡的几行 */
export function profileRows(profile: Chrome): [string, string][] {
  const { proxy } = profile
  const proxyRows: [string, string][] =
    proxy.kind === "socks5"
      ? [["代理", `SOCKS5 · ${proxy.host}:${proxy.port}`], ["代理用户名", proxy.username ?? "不需要"]]
      : [["代理", "不用代理，直接出网"]]
  return [
    ...proxyRows,
    ["出口 IP", profile.exitIp],
    ["保险箱", `v${profile.vaultVersion} · ${profile.cookieCount} 个 cookie`],
    ["更新时间", fmtDateTime(profile.updatedAt)],
    ...(profile.timezone || profile.locale ? [["时区 / 语言", [profile.timezone, profile.locale].filter(Boolean).join(" · ")] as [string, string]] : []),
  ]
}
