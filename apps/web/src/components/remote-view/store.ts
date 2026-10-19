// 打开着的远程画面（按 browserId 一个）。弹窗、小窗和连接都由挂在应用根部的 RemoteViewHost 渲染，
// 打开它的组件（抽屉、页面）只是登记：组件没了（例如关掉 session 详情的抽屉）时，缩成小窗的留着接着看，大弹窗跟着关。
import * as React from "react"

export interface RemoteViewEntryProps {
  browserId: string
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

const find = (browserId: string) => entries.find((entry) => entry.props.browserId === browserId)
const replace = (browserId: string, change: (entry: RemoteViewEntry) => RemoteViewEntry) =>
  commit(entries.map((entry) => (entry.props.browserId === browserId ? change(entry) : entry)))

export const remoteViews = {
  subscribe(listener: () => void) {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  },
  snapshot: () => entries,
  /** 打开；同一个 Chrome 已经有小窗时接过来、放大，不重连 */
  register(owner: symbol, props: RemoteViewEntryProps) {
    if (find(props.browserId)) replace(props.browserId, () => ({ props, owner, minimized: false }))
    else commit([...entries, { props, owner, minimized: false }])
  },
  /** 打开它的组件重新渲染了：标题、底部按钮等跟着变 */
  update(owner: symbol, props: RemoteViewEntryProps) {
    const entry = find(props.browserId)
    if (entry?.owner === owner && entry.props !== props) replace(props.browserId, (each) => ({ ...each, props }))
  },
  /** 打开它的组件没了：小窗留着，大弹窗关掉 */
  release(owner: symbol, browserId: string) {
    const entry = find(browserId)
    if (entry?.owner !== owner) return
    if (entry.minimized) replace(browserId, (each) => ({ ...each, owner: null }))
    else remoteViews.remove(browserId)
  },
  remove(browserId: string) {
    if (find(browserId)) commit(entries.filter((entry) => entry.props.browserId !== browserId))
  },
  setMinimized(browserId: string, minimized: boolean) {
    replace(browserId, (each) => ({ ...each, minimized }))
  },
}
