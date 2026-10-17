// 远程画面的连接：WebSocket GET /api/browser/view/:browserId（同源，cookie 自动带上）。
// - 二进制消息是一帧 JPEG：只画最新的一帧，解码跟不上就丢掉中间的；
// - JSON 消息：meta（视口尺寸、标签页、地址、能不能操作）、dialog / dialogClosed（网页弹框）、closed（Chrome 关了）；
//   agent 的光标和动作说明（cursor / cursorHidden / agentAction）不进 state，交给订阅的人（虚拟光标）直接改 DOM；
// - 断线自动重连（服务端说 closed 的除外）；一直连不上就停下，告诉人「可能已经关了」。
import * as React from "react"
import type { ViewerClientMessage, ViewerServerMessage } from "@heyagent/shared"

export type Meta = Extract<ViewerServerMessage, { t: "meta" }>
export type PageDialog = Extract<ViewerServerMessage, { t: "dialog" }>
export type AgentMessage = Extract<ViewerServerMessage, { t: "cursor" | "cursorHidden" | "agentAction" }>

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

function viewUrl(browserId: string, viewOnly: boolean) {
  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:"
  return `${protocol}//${window.location.host}/api/browser/view/${encodeURIComponent(browserId)}${viewOnly ? "?viewOnly=1" : ""}`
}

/** viewOnly：只看不操作（有权限也不给操作，例如浏览器页「当前的 session」里的「查看」） */
export function useRemoteView(browserId: string, canvasRef: React.RefObject<HTMLCanvasElement | null>, viewOnly = false) {
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
      const ws = new WebSocket(viewUrl(browserId, viewOnly))
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
        let message: ViewerServerMessage
        try {
          message = JSON.parse(event.data) as ViewerServerMessage
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
          setState((prev) => ({ ...prev, status: "closed", dialog: undefined, reason: "连不上远程画面，这个 Chrome 可能已经关了" }))
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
      const ws = socketRef.current
      socketRef.current = null
      ws?.close(1000)
    }
  }, [browserId, canvasRef, viewOnly])

  const send = React.useCallback((message: ViewerClientMessage) => {
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
