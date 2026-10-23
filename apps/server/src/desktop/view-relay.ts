// GET /api/desktop/view/:desktopId[?viewOnly=1]（WebSocket 升级，要求登录）：把控制台和桌面服务的远程画面接起来（docs/dev/desktop.md 第 5 节）。
// - 能看、能操作：主管；系统开的桌面建的人；或者这台桌面正被某个运行占着（running / held），该运行的任务负责人、该运行开着的要人办的事的处理人。其他人 403；
//   ?viewOnly=1 有权限也只能看；
// - 上游：桌面服务的 /view（ws / wss），带 Authorization: Bearer <密钥>（密钥只在 API 里解密，不给控制台）；
// - 下行：画面帧照转（跟不上就丢），JSON 照转，但 meta.canControl 按这个人改写；
// - 上行：只有能操作才转，按 desktopViewerClientMessageSchema 校验，不认识的丢掉；
// - 桌面服务密钥不对时是先接受再用 4401 关：转成 { t: "closed", reason } 再用 4401 关控制台那边（控制台不再重连）。
// 认人、查来源、转发、丢帧和浏览器共用（lib/ws-relay.ts）。
import type { IncomingMessage, Server } from "node:http"
import type { Duplex } from "node:stream"

import { can, desktopViewerClientMessageSchema, type DesktopViewerServerMessage } from "@heyagent/shared"
import { eq } from "drizzle-orm"
import { WebSocket, WebSocketServer } from "ws"

import { canControlSession } from "../browser/access.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import type { Keyring } from "../lib/crypto.js"
import { addUpgradeHandler, authenticateUpgrade, refuse, relay, type RelayAuthDeps } from "../lib/ws-relay.js"
import { desktopViewUrl, loadDesktopTarget } from "./client.js"
import { desktopLease } from "./leases.js"

const PATH = /^\/api\/desktop\/view\/([A-Za-z0-9_-]+)$/

export interface DesktopViewRelayDeps extends RelayAuthDeps {
  db: Db
  keyring: () => Keyring
}

/** 下行的 JSON：meta 的 canControl 换成这个人的；解析不了的原样转 */
export function rewriteMeta(text: string, canControl: boolean): string {
  try {
    const message = JSON.parse(text) as { t?: unknown }
    if (message && typeof message === "object" && message.t === "meta") return JSON.stringify({ ...message, canControl })
  } catch {
    // 不是 JSON：照转
  }
  return text
}

/** 上行的消息：校验过的才转（重新序列化，去掉多余字段） */
export function filterInput(text: string): string | undefined {
  let message: unknown
  try {
    message = JSON.parse(text)
  } catch {
    return undefined
  }
  const parsed = desktopViewerClientMessageSchema.safeParse(message)
  return parsed.success ? JSON.stringify(parsed.data) : undefined
}

/** 桌面服务密钥不对时先接受再用 4401 关掉（apps/desktop-agent 的 app.py）：告诉控制台原因，控制台不再重连 */
export const WS_CLOSE_UNAUTHORIZED = 4401

export function upstreamClosed(code: number): { message: string; code: number } | undefined {
  if (code !== WS_CLOSE_UNAUTHORIZED) return undefined
  const message: DesktopViewerServerMessage = { t: "closed", reason: "桌面服务拒绝了连接：密钥不对（请在「桌面」页检查密钥）" }
  return { message: JSON.stringify(message), code: WS_CLOSE_UNAUTHORIZED }
}

export async function handleDesktopViewUpgrade(deps: DesktopViewRelayDeps, wss: WebSocketServer, req: IncomingMessage, socket: Duplex, head: Buffer): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://api")
  const match = PATH.exec(url.pathname)
  if (!match) return false
  const user = await authenticateUpgrade(deps, req, socket)
  if (!user) return true
  const target = await loadDesktopTarget(deps.db, deps.keyring(), match[1]!)
  if (!target) {
    refuse(socket, 404, "Not Found")
    return true
  }
  let allowed = user.isAdmin
  // 系统开的桌面：建的人能看能操作（新建后要在远程画面里扫码登录软件，docs/dev/desktop-vm.md）
  if (!allowed) {
    const [desktop] = await deps.db.select({ kind: t.desktops.kind, createdById: t.desktops.createdById }).from(t.desktops).where(eq(t.desktops.id, target.id))
    allowed = desktop?.kind === "vm" && can(user, "desktop.manage", { createdById: desktop.createdById ?? "" })
  }
  if (!allowed) {
    const lease = await desktopLease(deps.db, target.id)
    allowed = Boolean(lease && (await canControlSession(deps.db, user, lease.sessionId)))
  }
  if (!allowed) {
    refuse(socket, 403, "Forbidden")
    return true
  }
  const canControl = url.searchParams.get("viewOnly") !== "1"
  const upstream = new WebSocket(desktopViewUrl(target), { headers: { Authorization: `Bearer ${target.key}` }, maxPayload: 8 * 1024 * 1024, handshakeTimeout: 10_000 })
  relay(wss, req, socket, head, {
    upstream,
    canControl,
    mapDown: (text) => rewriteMeta(text, canControl),
    mapUp: filterInput,
    onUpstreamClose: upstreamClosed,
  })
  return true
}

/** 挂到 API 的 HTTP 服务器上（和浏览器的远程画面共用一个 upgrade 监听） */
export function attachDesktopViewRelay(server: Server, deps: DesktopViewRelayDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })
  addUpgradeHandler(server, (req, socket, head) => handleDesktopViewUpgrade(deps, wss, req, socket, head))
  return wss
}
