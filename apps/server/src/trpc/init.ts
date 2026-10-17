import { initTRPC, TRPCError } from "@trpc/server"
import type { Actor } from "@heyagent/shared"

import type { Auth } from "../auth.js"
import type { Db } from "../db/client.js"
import type { Keyring } from "../lib/crypto.js"
import type { ChangeHub } from "../live/hub.js"

export interface SessionUser extends Actor {
  name: string
  email: string
}

export interface Context {
  db: Db
  hub: ChangeHub
  /** 没登录时为 null */
  user: SessionUser | null
  /** better-auth：用户管理（admin 插件）、改密码要用（M1 P2） */
  auth: Auth
  /** 这次请求的请求头：调 better-auth 的接口时带上，它按 cookie 认人 */
  headers: Headers
  /** 主密钥：写密钥时加密用（第一次用到时才读 KEK 文件） */
  keyring: () => Keyring
}

const t = initTRPC.context<Context>().create({
  // 出错时不把服务端的调用栈发给前端
  isDev: false,
  sse: {
    // 每 15 秒发一次心跳，免得反向代理把空闲的 SSE 连接断掉
    ping: { enabled: true, intervalMs: 15_000 },
    client: { reconnectAfterInactivityMs: 30_000 },
  },
})

export const router = t.router

/** 全部接口都要求登录（m0：全部只读，都要求登录）。没登录返回 401 */
export const protectedProcedure = t.procedure.use(({ ctx, next }) => {
  if (!ctx.user) throw new TRPCError({ code: "UNAUTHORIZED", message: "请先登录" })
  return next({ ctx: { ...ctx, user: ctx.user } })
})
