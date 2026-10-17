// API ⇄ worker 内部接口的令牌：由主密钥派生（HMAC），两边都有主密钥，不用另外存。
// 为什么要令牌：worker 的内部端口只绑 127.0.0.1，但同一台机器上 Chrome 里打开的网页也能连 127.0.0.1。
// 网页发不了自定义请求头（WebSocket 不行，fetch 带自定义头要先过 CORS 预检，我们不应答），所以令牌放在请求头里。
import { createHmac, timingSafeEqual } from "node:crypto"

import type { Keyring } from "../lib/crypto.js"

export const INTERNAL_HEADER = "x-heyagent-internal"

export function internalToken(keyring: Keyring): string {
  const key = keyring.keys.get(keyring.current)!
  return createHmac("sha256", key).update("heyagent-browser-internal-v1").digest("hex")
}

export function tokenMatches(given: string | string[] | undefined, expected: string) {
  if (typeof given !== "string" || given.length !== expected.length) return false
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected))
}
