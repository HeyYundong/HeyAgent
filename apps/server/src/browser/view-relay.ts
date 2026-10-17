// GET /api/browser/view/:browserId（WebSocket 升级，要求登录）：把控制台和 worker 的远程画面接起来（m2.md 第 8 条）。
// - 看：任何登录用户都能看；
// - 操作：只有 session 的负责人、被分配处理的人、主管（登录 Chrome 是打开它的人）能做；没权限的连接，输入一律丢弃；
// - 画面帧：控制台跟不上时丢帧（缓冲超过 1MB 就不转），不堆积；
// - 带 Origin 头的（浏览器发起的）必须是受信任的来源，防跨站 WebSocket 劫持。
import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"

import { WebSocket, WebSocketServer } from "ws"

import type { Auth } from "../auth.js"
import type { Db } from "../db/client.js"
import type { Keyring } from "../lib/crypto.js"
import { canControlBrowser, instanceRow, workerUrl } from "./access.js"
import { INTERNAL_HEADER, internalToken } from "./token.js"

const PATH = /^\/api\/browser\/view\/([A-Za-z0-9_-]+)$/
const MAX_BUFFERED = 1 << 20

export interface ViewRelayDeps {
  db: Db
  auth: Auth
  keyring: () => Keyring
  /** 允许的 Origin（TRUSTED_ORIGINS + 控制台地址） */
  trustedOrigins: string[]
}

function refuse(socket: Duplex, status: number, text: string) {
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
  socket.destroy()
}

function toHeaders(req: IncomingMessage) {
  const headers = new Headers()
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) for (const each of value) headers.append(key, each)
    else if (value !== undefined) headers.set(key, value)
  }
  return headers
}

/** 处理一次升级请求；不是远程画面的路径返回 false（交给别人或关掉） */
export async function handleViewUpgrade(deps: ViewRelayDeps, wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://api")
  const match = PATH.exec(url.pathname)
  if (!match) return false
  const origin = req.headers.origin
  if (origin && !deps.trustedOrigins.includes(origin)) {
    refuse(socket, 403, "Forbidden")
    return true
  }
  const session = await deps.auth.api.getSession({ headers: toHeaders(req) }).catch(() => null)
  if (!session?.user) {
    refuse(socket, 401, "Unauthorized")
    return true
  }
  const user = { id: session.user.id, isAdmin: (session.user as { role?: string }).role === "admin" }
  const row = await instanceRow(deps.db, match[1]!)
  if (!row) {
    refuse(socket, 404, "Not Found")
    return true
  }
  const canControl = await canControlBrowser(deps.db, user, row)
  const controlUrl = await workerUrl(deps.db, row.workerId)
  if (!controlUrl) {
    refuse(socket, 502, "Bad Gateway")
    return true
  }
  const target = `${controlUrl.replace(/^http/, "ws")}/browsers/${encodeURIComponent(row.id)}/view?userId=${encodeURIComponent(user.id)}&canControl=${canControl ? 1 : 0}`
  const upstream = new WebSocket(target, { headers: { [INTERNAL_HEADER]: internalToken(deps.keyring()) }, maxPayload: 8 * 1024 * 1024 })
  upstream.once("unexpected-response", () => refuse(socket, 502, "Bad Gateway"))
  upstream.once("error", () => {
    if (!socket.destroyed) refuse(socket, 502, "Bad Gateway")
  })
  upstream.once("open", () => {
    wss.handleUpgrade(req, socket, head, (client) => {
      upstream.on("message", (data, isBinary) => {
        if (client.readyState !== client.OPEN) return
        // 画面帧：跟不上就丢；JSON 消息（meta、弹框、关闭）都转
        if (isBinary && client.bufferedAmount >= MAX_BUFFERED) return
        client.send(data, { binary: isBinary })
      })
      client.on("message", (data, isBinary) => {
        // 没权限的连接：输入一律丢弃（worker 那边也会再挡一次）
        if (!canControl || isBinary || upstream.readyState !== upstream.OPEN) return
        upstream.send(String(data))
      })
      const closeBoth = () => {
        if (client.readyState === client.OPEN) client.close(1000)
        if (upstream.readyState === upstream.OPEN) upstream.close(1000)
      }
      upstream.on("close", closeBoth)
      client.on("close", closeBoth)
      upstream.on("error", closeBoth)
      client.on("error", closeBoth)
    })
  })
  return true
}

/** 挂到 API 的 HTTP 服务器上 */
export function attachBrowserViewRelay(server: Server, deps: ViewRelayDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  server.on("upgrade", (req, socket, head) => {
    void handleViewUpgrade(deps, wss, req, socket, head)
      .then((handled) => {
        if (!handled) refuse(socket, 404, "Not Found")
      })
      .catch(() => refuse(socket, 500, "Internal Server Error"))
  })
  return wss
}
