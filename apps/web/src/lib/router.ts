import { useMemo, useSyncExternalStore } from "react"

// 极简 hash 路由：#/<page>?<params>，例如 #/tasks?id=T-1024&run=R-1024-1
// 原型不引入路由库。

export type PageId =
  | "tasks"
  | "todos"
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

const PAGES: PageId[] = ["tasks", "todos", "sessions", "work", "gallery", "compare", "memory", "skills", "rules", "tools", "browsers", "models", "users", "settings", "imports", "learn"]

/** 旧地址兼容 */
const ALIASES: Record<string, PageId> = {
  overview: "learn",
  inbox: "todos",
  templates: "tasks",
  hooks: "rules",
}

type Params = Record<string, string | null | undefined>

function parse(hash: string) {
  const [path, query = ""] = hash.replace(/^#\/?/, "").split("?")
  const page = PAGES.includes(path as PageId) ? (path as PageId) : (ALIASES[path] ?? "tasks")
  return { page, params: new URLSearchParams(query) }
}

function subscribe(onChange: () => void) {
  window.addEventListener("hashchange", onChange)
  return () => window.removeEventListener("hashchange", onChange)
}

export function useRoute() {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  return useMemo(() => parse(hash), [hash])
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
