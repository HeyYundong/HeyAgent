// GET /api/browser/view/:browserId（WebSocket 升级，要求登录）：把控制台和 worker 的远程画面接起来（m2.md 第 8 条）。
// - 看：任何登录用户都能看；
// - 操作：只有 session 的负责人、被分配处理的人、主管（登录 Chrome 是打开它的人）能做；没权限的连接，输入一律丢弃；
//   带 ?viewOnly=1 的连接有权限也只能看（浏览器页「当前的 session」里的「查看」）；
// - 画面帧：控制台跟不上时丢帧（缓冲超过 1MB 就不转），不堆积；
// - 带 Origin 头的（浏览器发起的）必须是受信任的来源，防跨站 WebSocket 劫持。
// 认人、查来源、转发、丢帧这些和桌面共用（lib/ws-relay.ts）。
import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"

import { WebSocket, WebSocketServer } from "ws"

import type { Db } from "../db/client.js"
import type { Keyring } from "../lib/crypto.js"
import { addUpgradeHandler, authenticateUpgrade, refuse, relay, type RelayAuthDeps } from "../lib/ws-relay.js"
import { canControlBrowser, instanceRow, workerUrl } from "./access.js"
import { INTERNAL_HEADER, internalToken } from "./token.js"

const PATH = /^\/api\/browser\/view\/([A-Za-z0-9_-]+)$/

export interface ViewRelayDeps extends RelayAuthDeps {
  db: Db
  keyring: () => Keyring
}

/** 处理一次升级请求；不是远程画面的路径返回 false（交给别人或关掉） */
export async function handleViewUpgrade(deps: ViewRelayDeps, wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://api")
  const match = PATH.exec(url.pathname)
  if (!match) return false
  const user = await authenticateUpgrade(deps, req, socket)
  if (!user) return true
  const row = await instanceRow(deps.db, match[1]!)
  if (!row) {
    refuse(socket, 404, "Not Found")
    return true
  }
  const canControl = url.searchParams.get("viewOnly") !== "1" && (await canControlBrowser(deps.db, user, row))
  const controlUrl = await workerUrl(deps.db, row.workerId)
  if (!controlUrl) {
    refuse(socket, 502, "Bad Gateway")
    return true
  }
  const target = `${controlUrl.replace(/^http/, "ws")}/browsers/${encodeURIComponent(row.id)}/view?userId=${encodeURIComponent(user.id)}&canControl=${canControl ? 1 : 0}`
  const upstream = new WebSocket(target, { headers: { [INTERNAL_HEADER]: internalToken(deps.keyring()) }, maxPayload: 8 * 1024 * 1024 })
  relay(wss, req, socket, head, { upstream, canControl })
  return true
}

/** 挂到 API 的 HTTP 服务器上（和桌面的远程画面共用一个 upgrade 监听，lib/ws-relay.ts） */
export function attachBrowserViewRelay(server: Server, deps: ViewRelayDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  addUpgradeHandler(server, (req, socket, head) => handleViewUpgrade(deps, wss, req, socket, head))
  return wss
}
