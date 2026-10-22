// 远程画面转发的公共部分（浏览器 browser/view-relay.ts、桌面 desktop/view-relay.ts 共用）：
// - 一个 HTTP 服务器只挂一个 upgrade 监听，按顺序问各个处理函数，都不认的路径回 404；
// - 带 Origin 头的（浏览器发起的）必须是受信任的来源，防跨站 WebSocket 劫持；要 better-auth 登录；
// - 上游连上以后才和控制台握手；画面帧（二进制）在控制台跟不上时丢掉（缓冲超过 1MB 就不转），不堆积；
// - 文字消息两个方向都可以改写或丢弃（mapDown / mapUp 返回 undefined = 不转）。
import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"

import type { WebSocket, WebSocketServer } from "ws"

import type { Auth } from "../auth.js"

export const MAX_BUFFERED = 1 << 20

export function refuse(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

export function toHeaders(req: IncomingMessage) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const each of value) headers.append(key, each)
    else if (value !== undefined) headers.set(key, value)
  }
  return headers
}

export interface RelayAuthDeps {
  auth: Auth
  /** 允许的 Origin（TRUSTED_ORIGINS + 控制台地址） */
  trustedOrigins: string[]
}

/** 查来源、认人。不通过时已经回了 403 / 401，返回 undefined */
export async function authenticateUpgrade(deps: RelayAuthDeps, req: IncomingMessage, socket: Duplex): Promise<{ id: string; isAdmin: boolean } | undefined> {
  const origin = req.headers.origin
  if (origin && !deps.trustedOrigins.includes(origin)) {
    refuse(socket, 403, "Forbidden")
    return undefined
  }
  const session = await deps.auth.api.getSession({ headers: toHeaders(req) }).catch(() => null)
  if (!session?.user) {
    refuse(socket, 401, "Unauthorized")
    return undefined
  }
  return { id: session.user.id, isAdmin: (session.user as { role?: string }).role === "admin" }
}

export interface RelayOptions {
  upstream: WebSocket
  /** 能不能操作：不能的连接，控制台发来的消息一律丢弃 */
  canControl: boolean
  /** 上游 → 控制台的文字消息：改写或丢弃（返回 undefined）。不给 = 原样转 */
  mapDown?: (text: string) => string | undefined
  /** 控制台 → 上游的文字消息（只在能操作时才会走到这里）：改写或丢弃。不给 = 原样转 */
  mapUp?: (text: string) => string | undefined
  /**
   * 上游关掉时：返回一条要先发给控制台的文字消息，以及给控制台的关闭码（例如桌面服务密钥不对时先接受再用 4401 关，
   * 这里换成 { t: "closed", reason } 让控制台不再重连）。不给 / 返回 undefined = 照常用 1000 关
   */
  onUpstreamClose?: (code: number, reason: string) => { message?: string; code?: number } | undefined
}

/** 上游连上了再和控制台握手，之后两边对接；上游连不上回 502 */
export function relay(wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer, options: RelayOptions) {
  const { upstream, canControl, mapDown, mapUp, onUpstreamClose } = options
  upstream.once("unexpected-response", () => refuse(socket, 502, "Bad Gateway"))
  upstream.once("error", () => {
    if (!socket.destroyed) refuse(socket, 502, "Bad Gateway")
  })
  upstream.once("open", () => {
    wss.handleUpgrade(req, socket, head, (client) => {
      upstream.on("message", (data, isBinary) => {
        if (client.readyState !== client.OPEN) return
        // 画面帧：跟不上就丢；JSON 消息（meta、弹框、关闭）都转
        if (isBinary) {
          if (client.bufferedAmount >= MAX_BUFFERED) return
          client.send(data, { binary: true })
          return
        }
        const text = mapDown ? mapDown(String(data)) : String(data)
        if (text !== undefined) client.send(text)
      })
      client.on("message", (data, isBinary) => {
        // 没权限的连接：输入一律丢弃（上游那边也会再挡一次）
        if (!canControl || isBinary || upstream.readyState !== upstream.OPEN) return
        const text = mapUp ? mapUp(String(data)) : String(data)
        if (text !== undefined) upstream.send(text)
      })
      const closeBoth = (code = 1000) => {
        if (client.readyState === client.OPEN) client.close(code)
        if (upstream.readyState === upstream.OPEN) upstream.close(1000)
      }
      upstream.on("close", (code: number, reason: Buffer) => {
        const last = onUpstreamClose?.(code, String(reason))
        if (last?.message && client.readyState === client.OPEN) client.send(last.message)
        closeBoth(last?.code ?? 1000)
      })
      client.on("close", () => closeBoth())
      upstream.on("error", () => closeBoth())
      client.on("error", () => closeBoth())
    })
  })
}

/** 处理一次升级请求；不是自己的路径返回 false（交给下一个） */
export type UpgradeHandler = (req: IncomingMessage, socket: Duplex, head: Buffer) => Promise<boolean>

const handlersByServer = new WeakMap<Server, UpgradeHandler[]>()

/** 挂一个升级处理函数。同一个服务器只注册一个 upgrade 监听，按挂的顺序问；都不认回 404，出错回 500 */
export function addUpgradeHandler(server: Server, handler: UpgradeHandler) {
  let handlers = handlersByServer.get(server)
  if (!handlers) {
    const list: UpgradeHandler[] = []
    handlers = list
    handlersByServer.set(server, list)
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      void (async () => {
        for (const each of list) if (await each(req, socket, head)) return
        refuse(socket, 404, "Not Found")
      })().catch(() => {
        if (!socket.destroyed) refuse(socket, 500, "Internal Server Error")
      })
    })
  }
  handlers.push(handler)
}
