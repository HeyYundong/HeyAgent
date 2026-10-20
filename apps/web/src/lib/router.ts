import { useEffect, useMemo, useSyncExternalStore } from "react"

// 极简 hash 路由：#/<page>?<params>，例如 #/tasks?id=T-1024&run=R-1024-1
// 原型不引入路由库。

export type PageId =
  | "tasks"
  | "sessions"
  | "work"
  | "gallery"
  | "compare"
  | "memory"
  | "skills"
  | "rules"
  | "tools"
  | "browsers"
  | "models"
  | "users"
  | "settings"
  | "imports"
  | "learn"

const PAGES: PageId[] = ["tasks", "sessions", "work", "gallery", "compare", "memory", "skills", "rules", "tools", "browsers", "models", "users", "settings", "imports", "learn"]

/** 旧地址兼容 */
const ALIASES: Record<string, PageId> = {
  overview: "learn",
  templates: "tasks",
  hooks: "rules",
}

/** 去掉了的「待办」页（和更早的 inbox）：要人办的事在会话页「等人处理」里，?id= 照样带过去 */
const TO_HUMAN = new Set(["todos", "inbox"])

type Params = Record<string, string | null | undefined>

function parse(hash: string) {
  const [path = "", query = ""] = hash.replace(/^#\/?/, "").split("?")
  const params = new URLSearchParams(query)
  if (TO_HUMAN.has(path)) {
    if (!params.has("status")) params.set("status", "human")
    return { page: "sessions" as PageId, params, redirected: true }
  }
  const page = PAGES.includes(path as PageId) ? (path as PageId) : (ALIASES[path] ?? "tasks")
  return { page, params, redirected: false }
}

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange)
  return () => window.removeEventListener("hashchange", onChange)
}

export function useRoute() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  const route = useMemo(() => parse(hash), [hash])
  // 旧地址：地址栏也换成新的（不留历史记录）
  useEffect(() => {
    if (route.redirected) window.history.replaceState(null, "", href(route.page, Object.fromEntries(route.params.entries())))
  }, [route])
  return route
}

/** 生成链接地址，用在 <a href> 或 render={<a href={...} />} 上 */
export function href(page: PageId, params?: Params) {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value) query.set(key, value)
  }
  const search = query.toString()
  return `#/${page}${search ? `?${search}` : ""}`
}

export function navigate(page: PageId, params?: Params) {
  window.location.hash = href(page, params)
}

/** 只改当前页面的参数，比如选中 / 取消选中一条时同步 ?id= */
export function setParams(params: Params) {
  const { page, params: current } = parse(window.location.hash)
  const next: Params = Object.fromEntries(current.entries())
  Object.assign(next, params)
  window.location.hash = href(page, next)
}
