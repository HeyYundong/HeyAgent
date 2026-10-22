// 远程画面的连接：WebSocket GET /api/browser/view/:browserId 或 /api/desktop/view/:desktopId（同源，cookie 自动带上）。
// - 二进制消息是一帧 JPEG：只画最新的一帧，解码跟不上就丢掉中间的；
// - JSON 消息：meta（画面坐标的尺寸、能不能操作；Chrome 还有标签页、地址）、dialog / dialogClosed（网页弹框，只有 Chrome）、closed（关了）；
//   桌面的 meta 没有标签页和地址，尺寸是屏幕的物理像素（shared 的 DesktopViewerServerMessage）；
//   agent 的光标和动作说明（cursor / cursorHidden / agentAction）不进 state，交给订阅的人（虚拟光标）直接改 DOM；
// - 断线自动重连（服务端说 closed 的除外）；一直连不上就停下，告诉人「可能已经关了」。
import * as React from "react"
import type { DesktopViewerClientMessage, DesktopViewerServerMessage, ViewerClientMessage, ViewerServerMessage } from "@heyagent/shared"

import type { RemoteTarget } from "./store"

export type BrowserMeta = Extract<ViewerServerMessage, { t: "meta" }>
export type Meta = BrowserMeta | Extract<DesktopViewerServerMessage, { t: "meta" }>
export type PageDialog = Extract<ViewerServerMessage, { t: "dialog" }>
type ServerMessage = ViewerServerMessage | DesktopViewerServerMessage
export type AgentMessage = Extract<ServerMessage, { t: "cursor" | "cursorHidden" | "agentAction" }>
/** 发给服务端的消息：Chrome 那套，加上桌面的组合键 */
export type ClientMessage = ViewerClientMessage | DesktopViewerClientMessage

/** Chrome 的 meta 才有标签页和地址 */
export const browserMeta = (meta?: Meta): BrowserMeta | undefined => (meta && "tabs" in meta ? meta : undefined)

export type ViewStatus = "connecting" | "open" | "reconnecting" | "closed"

export interface RemoteViewState {
  status: ViewStatus
  meta?: Meta
  dialog?: PageDialog
  /** 已经收到过画面 */
  hasFrame: boolean
  /** closed 时的原因 */
  reason?: string
}

/** 连续失败几次（一次都没连上）就不再重连 */
const MAX_FAILURES = 5

function viewUrl(kind: RemoteTarget["kind"], id: string, viewOnly: boolean) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/api/${kind}/view/${encodeURIComponent(id)}${viewOnly ? "?viewOnly=1" : ""}`
}

/** 一直连不上时说的原因 */
const GONE: Record<RemoteTarget["kind"], string> = {
  browser: "连不上远程画面，这个 Chrome 可能已经关了",
  desktop: "连不上远程画面：桌面可能没开机、桌面服务没在运行，或者你没有看这台桌面的权限",
}

/** viewOnly：只看不操作（有权限也不给操作，例如浏览器页「当前的 session」里的「查看」） */
export function useRemoteView(target: Pick<RemoteTarget, "kind" | "id">, canvasRef: React.RefObject<HTMLCanvasElement | null>, viewOnly = false) {
  const { kind, id } = target
  const [state, setState] = React.useState<RemoteViewState>({ status: "connecting", hasFrame: false })
  const socketRef = React.useRef<WebSocket | null>(null)
  const agentListeners = React.useRef(new Set<(message: AgentMessage) => void>())

  React.useEffect(() => {
    let disposed = false
    let failures = 0
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    // 解码中时新来的帧先放这里，解码完只画最新的那一帧
    let decoding = false
    let pending: Blob | null = null
    let canvasTimer: ReturnType<typeof setTimeout> | undefined
    let gotFrame = false

    async function draw(blob: Blob) {
      if (decoding) {
        pending = blob
        return
      }
      decoding = true
      try {
        const bitmap = await createImageBitmap(blob)
        const canvas = canvasRef.current
        if (!canvas && !disposed) {
          // 画布还没挂上（弹窗刚打开）。桌面画面不变时不会马上来新帧，留着这一帧，等画布挂上再画
          bitmap.close()
          decoding = false
          pending = pending ?? blob
          clearTimeout(canvasTimer)
          canvasTimer = setTimeout(() => {
            const next = pending
            pending = null
            if (next) void draw(next)
          }, 100)
          return
        }
        if (canvas && !disposed) {
          if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
            canvas.width = bitmap.width
            canvas.height = bitmap.height
          }
          canvas.getContext("2d")?.drawImage(bitmap, 0, 0)
          if (!gotFrame) {
            gotFrame = true
            setState((prev) => ({ ...prev, hasFrame: true }))
          }
        }
        bitmap.close()
      } catch {
        // 坏帧直接跳过
      }
      decoding = false
      if (pending) {
        const next = pending
        pending = null
        void draw(next)
      }
    }

    function connect() {
      const ws = new WebSocket(viewUrl(kind, id, viewOnly))
      ws.binaryType = "blob"
      socketRef.current = ws
      let opened = false
      let closedByServer = false
      ws.onopen = () => {
        opened = true
        failures = 0
        setState((prev) => ({ ...prev, status: "open", reason: undefined }))
      }
      ws.onmessage = (event: MessageEvent<Blob | string>) => {
        if (typeof event.data !== "string") {
          void draw(event.data)
          return
        }
        let message: ServerMessage
        try {
          message = JSON.parse(event.data) as ServerMessage
        } catch {
          return
        }
        if (message.t === "cursor" || message.t === "cursorHidden" || message.t === "agentAction") {
          for (const listener of agentListeners.current) listener(message)
        } else if (message.t === "meta") setState((prev) => ({ ...prev, meta: message }))
        else if (message.t === "dialog") setState((prev) => ({ ...prev, dialog: message }))
        else if (message.t === "dialogClosed") setState((prev) => ({ ...prev, dialog: undefined }))
        else if (message.t === "closed") {
          closedByServer = true
          setState((prev) => ({ ...prev, status: "closed", dialog: undefined, reason: message.reason }))
        }
      }
      ws.onclose = () => {
        if (socketRef.current === ws) socketRef.current = null
        if (disposed || closedByServer) return
        if (!opened) failures += 1
        if (failures >= MAX_FAILURES) {
          setState((prev) => ({ ...prev, status: "closed", dialog: undefined, reason: GONE[kind] }))
          return
        }
        setState((prev) => ({ ...prev, status: "reconnecting", dialog: undefined }))
        retryTimer = setTimeout(connect, Math.min(1000 * 2 ** failures, 10_000))
      }
    }

    connect()
    return () => {
      disposed = true
      clearTimeout(retryTimer)
      clearTimeout(canvasTimer)
      const ws = socketRef.current
      socketRef.current = null
      ws?.close(1000)
    }
  }, [kind, id, canvasRef, viewOnly])

  const send = React.useCallback((message: ClientMessage) => {
    const ws = socketRef.current
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message))
  }, [])

  /** 本地先把弹框收起来（服务端处理完还会推 dialogClosed） */
  const dismissDialog = React.useCallback(() => setState((prev) => ({ ...prev, dialog: undefined })), [])

  /** 订阅 agent 的光标和动作说明，返回取消订阅 */
  const onAgent = React.useCallback((listener: (message: AgentMessage) => void) => {
    agentListeners.current.add(listener)
    return () => {
      agentListeners.current.delete(listener)
    }
  }, [])

  return { ...state, send, dismissDialog, onAgent }
}
