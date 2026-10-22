// 打开着的远程画面（每个目标一个：服务器上的 Chrome 按 browserId、桌面按 desktopId，键是「kind:id」）。弹窗、小窗和连接都由挂在应用根部的 RemoteViewHost 渲染，
// 打开它的组件（抽屉、页面）只是登记：组件没了（例如关掉 session 详情的抽屉）时，缩成小窗的留着接着看，大弹窗跟着关。
import * as React from "react"

/** 远程画面看的是什么：服务器上的一个 Chrome（/api/browser/view/:id），或者一台桌面（/api/desktop/view/:id） */
export interface RemoteTarget {
  kind: "browser" | "desktop"
  id: string
  /** 桌面的名字：桌面模式的工具栏上显示 */
  name?: string
}

/** store 里的键：同一个目标只开一份 */
export const targetKey = (target: Pick<RemoteTarget, "kind" | "id">) => `${target.kind}:${target.id}`

export interface RemoteViewEntryProps {
  target: RemoteTarget
  title: React.ReactNode
  description?: React.ReactNode
  /** 底部按钮；不传就只有右上角的关闭 */
  footer?: React.ReactNode
  onOpenChange: (open: boolean) => void
  onClosed?: (reason: string) => void
  /** 只看不操作 */
  viewOnly?: boolean
}

export interface RemoteViewEntry {
  props: RemoteViewEntryProps
  /** 登记它的组件；null = 那个组件已经没了，只剩小窗 */
  owner: symbol | null
  minimized: boolean
}

let entries: RemoteViewEntry[] = []
const listeners = new Set<() => void>()

function commit(next: RemoteViewEntry[]) {
  entries = next
  listeners.forEach((listener) => listener())
}

const keyOf = (entry: RemoteViewEntry) => targetKey(entry.props.target)
const find = (key: string) => entries.find((entry) => keyOf(entry) === key)
const replace = (key: string, change: (entry: RemoteViewEntry) => RemoteViewEntry) =>
  commit(entries.map((entry) => (keyOf(entry) === key ? change(entry) : entry)))

export const remoteViews = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  },
  snapshot: () => entries,
  /** 打开；同一个目标已经有小窗时接过来、放大，不重连 */
  register(owner: symbol, props: RemoteViewEntryProps) {
    const key = targetKey(props.target)
    if (find(key)) replace(key, () => ({ props, owner, minimized: false }))
    else commit([...entries, { props, owner, minimized: false }])
  },
  /** 打开它的组件重新渲染了：标题、底部按钮等跟着变 */
  update(owner: symbol, props: RemoteViewEntryProps) {
    const key = targetKey(props.target)
    const entry = find(key)
    if (entry?.owner === owner && entry.props !== props) replace(key, (each) => ({ ...each, props }))
  },
  /** 打开它的组件没了：小窗留着，大弹窗关掉。key 是 targetKey(target) */
  release(owner: symbol, key: string) {
    const entry = find(key)
    if (entry?.owner !== owner) return
    if (entry.minimized) replace(key, (each) => ({ ...each, owner: null }))
    else remoteViews.remove(key)
  },
  remove(key: string) {
    if (find(key)) commit(entries.filter((entry) => keyOf(entry) !== key))
  },
  setMinimized(key: string, minimized: boolean) {
    replace(key, (each) => ({ ...each, minimized }))
  },
}
