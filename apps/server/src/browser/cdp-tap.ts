// agent 的鼠标在哪（远程画面上的虚拟光标）：Playwright MCP 不直接连 Chrome，连这里，这里原样转给 Chrome，
// 顺手记下 agent 发的输入指令（Input.dispatchMouseEvent 的坐标、Input.insertText / dispatchKeyEvent 打字）。
// - 网页什么都察觉不到：页面里不插东西，截图里也没有光标（Playwright 自带的 showActions 会往页面里插 x-pw-glass）；
// - 只有 MCP 走这里，人在远程画面里的操作走编排器自己的连接，所以记下的都是 agent 的；
// - 只解析含 "Input." 的消息（MCP → Chrome）和 Target.attachedToTarget / detachedFromTarget（Chrome → MCP），其余原样转；
// - 有人看画面时，按下鼠标前停 PRESS_DELAY_MS，让光标先移过去再点（之后的消息排在它后面，顺序不乱）；
// - 只监听 127.0.0.1，路径带随机串（和 Chrome 自己的调试端口一样只在本机）。
import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage } from "node:http"
import type { AddressInfo } from "node:net"
import type { Duplex } from "node:stream"

import { WebSocket, WebSocketServer, type RawData } from "ws"

/** agent 的一条输入。targetId 是 Chrome 的页面 target（编排器按它对上 Page） */
export type AgentInput =
  | { kind: "mouse"; targetId: string; type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel"; x: number; y: number }
  | { kind: "key"; targetId: string }
  /** 页面没了（关掉、换进程）：记的光标位置可以扔了 */
  | { kind: "detached"; targetId: string }

export interface CdpTapOptions {
  onInput: (input: AgentInput) => void
  /** 这次按下前要不要停一下（有人在看画面） */
  shouldDelay: () => boolean
}

export interface CdpTap {
  /** 给 MCP 的 --cdp-endpoint */
  url: string
  close(): Promise<void>
}

export const PRESS_DELAY_MS = 200
/** 和 Playwright 自己的 CDP 连接一样大 */
const MAX_PAYLOAD = 256 * 1024 * 1024
const MOUSE_TYPES = new Set(["mouseMoved", "mousePressed", "mouseReleased", "mouseWheel"])
const KEY_TYPES = new Set(["keyDown", "rawKeyDown"])

interface CdpCommand {
  method?: string
  sessionId?: string
  params?: { type?: string; x?: number; y?: number }
}

interface CdpEvent {
  method?: string
  params?: { sessionId?: string; targetInfo?: { targetId?: string } }
}

const text = (data: RawData) => (Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)).toString()
const includes = (data: RawData, needle: string) => (Buffer.isBuffer(data) ? data.includes(needle) : text(data).includes(needle))

/** 一条 MCP 发给 Chrome 的消息 → agent 的输入（不是输入指令、对不上页面的返回 undefined） */
export function parseAgentInput(raw: string, targets: ReadonlyMap<string, string>): AgentInput | undefined {
  let command: CdpCommand
  try {
    command = JSON.parse(raw) as CdpCommand
  } catch {
    return undefined
  }
  const targetId = command.sessionId ? targets.get(command.sessionId) : undefined
  if (!targetId) return undefined
  const params = command.params ?? {}
  if (command.method === "Input.dispatchMouseEvent" && MOUSE_TYPES.has(params.type ?? "") && typeof params.x === "number" && typeof params.y === "number")
    return { kind: "mouse", targetId, type: params.type as "mouseMoved", x: params.x, y: params.y }
  // 拖放（Playwright 拦下拖拽后用它）：当成移动
  if (command.method === "Input.dispatchDragEvent" && typeof params.x === "number" && typeof params.y === "number")
    return { kind: "mouse", targetId, type: "mouseMoved", x: params.x, y: params.y }
  if (command.method === "Input.insertText" || (command.method === "Input.dispatchKeyEvent" && KEY_TYPES.has(params.type ?? ""))) return { kind: "key", targetId }
  return undefined
}

/** 起一个转发层，连到 Chrome 的浏览器级 CDP 地址（ws://127.0.0.1:端口/devtools/browser/...） */
export async function startCdpTap(upstreamUrl: string, options: CdpTapOptions): Promise<CdpTap> {
  const path = `/devtools/browser/${randomBytes(12).toString("hex")}`
  const server = createServer((_req, res) => res.writeHead(404).end())
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false })
  const sockets = new Set<WebSocket>()

  const refuse = (socket: Duplex, status: number, reason: string) => {
    socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
    socket.destroy()
  }

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (req.url !== path) return refuse(socket, 404, "Not Found")
    // 先连上 Chrome 再接受 MCP 的连接：MCP 一连上就会发消息
    const upstream = new WebSocket(upstreamUrl, { maxPayload: MAX_PAYLOAD, perMessageDeflate: false })
    upstream.once("error", () => {
      if (!socket.destroyed) refuse(socket, 502, "Bad Gateway")
    })
    upstream.once("open", () => wss.handleUpgrade(req, socket, head, (client) => bridge(client, upstream)))
  })

  function bridge(client: WebSocket, upstream: WebSocket) {
    sockets.add(client)
    sockets.add(upstream)
    /** 这条连接上的 CDP session → 页面 target */
    const targets = new Map<string, string>()
    // 停顿期间来的消息排在后面
    let tail = Promise.resolve()
    let queued = 0

    const deliver = (data: RawData, isBinary: boolean, input: AgentInput | undefined) => {
      if (upstream.readyState !== upstream.OPEN) return
      upstream.send(data, { binary: isBinary })
      // 真正发给 Chrome 的时候才算（点击的波纹和页面的反应对得上）
      if (input) options.onInput(input)
    }

    client.on("message", (data, isBinary) => {
      const input = !isBinary && includes(data, '"Input.') ? parseAgentInput(text(data), targets) : undefined
      const delay = input?.kind === "mouse" && input.type === "mousePressed" && options.shouldDelay() ? PRESS_DELAY_MS : 0
      if (!delay && !queued) return deliver(data, isBinary, input)
      queued += 1
      tail = tail.then(async () => {
        if (delay) await new Promise((resolve) => setTimeout(resolve, delay))
        queued -= 1
        deliver(data, isBinary, input)
      })
    })

    upstream.on("message", (data, isBinary) => {
      if (!isBinary && (includes(data, '"Target.attachedToTarget"') || includes(data, '"Target.detachedFromTarget"'))) {
        try {
          const event = JSON.parse(text(data)) as CdpEvent
          const sessionId = event.params?.sessionId
          if (sessionId && event.method === "Target.attachedToTarget" && event.params?.targetInfo?.targetId) targets.set(sessionId, event.params.targetInfo.targetId)
          if (sessionId && event.method === "Target.detachedFromTarget") {
            const targetId = targets.get(sessionId)
            targets.delete(sessionId)
            if (targetId) options.onInput({ kind: "detached", targetId })
          }
        } catch {
          // 不是 JSON：照转
        }
      }
      if (client.readyState === client.OPEN) client.send(data, { binary: isBinary })
    })

    const closeBoth = () => {
      sockets.delete(client)
      sockets.delete(upstream)
      if (client.readyState === client.OPEN || client.readyState === client.CONNECTING) client.close()
      if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) upstream.close()
    }
    client.on("close", closeBoth)
    upstream.on("close", closeBoth)
    client.on("error", closeBoth)
    upstream.on("error", closeBoth)
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => resolve())
  })
  const { port } = server.address() as AddressInfo

  return {
    url: `ws://127.0.0.1:${port}${path}`,
    async close() {
      for (const socket of sockets) socket.terminate()
      sockets.clear()
      wss.close()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
