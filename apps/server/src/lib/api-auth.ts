// 对外 HTTP 接口和 MCP 共用的鉴权、地址、报错（图库、比物都用）。
// 鉴权二选一：Authorization: Bearer <API 密钥>（外部系统），或者登录的 cookie（控制台页面）。带了 Bearer 就只认密钥，不对就 401，不会退回去认 cookie。
import type { Actor } from "@heyagent/shared"
import type { z } from "zod"

import type { Auth } from "../auth.js"
import { verifyApiKey } from "../data/config/api-keys.js"
import type { Db } from "../db/client.js"

/** 认出来的调用方：密钥调用算密钥的创建人（apiKeyId、apiKeyName 有值），cookie 是登录的人。name 是人的名字（派活的处理记录、不办了的原因用） */
export interface ApiCaller {
  user: Actor & { name: string }
  apiKeyId?: string
  apiKeyName?: string
}

/** 认人：Bearer 密钥优先，没带才看 cookie。认不出时 reason 说清楚 */
export async function authenticateRequest(deps: { db: Db; auth: Auth }, req: Request): Promise<ApiCaller | { reason: string }> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (bearer) {
    const key = await verifyApiKey(deps.db, bearer)
    if (!key) return { reason: "API 密钥不对，或者已经删了（在「设置」→「API 密钥」里看）" }
    return { user: key.user, apiKeyId: key.apiKeyId, apiKeyName: key.apiKeyName }
  }
  const session = await deps.auth.api.getSession({ headers: req.headers })
  if (!session?.user) return { reason: "请先登录，或者在 Authorization: Bearer 里带上 API 密钥" }
  return { user: { id: session.user.id, isAdmin: session.user.role === "admin", name: session.user.name } }
}

/** 返回给外部的地址要完整（经过反向代理时看 X-Forwarded-*） */
export function publicBaseUrl(req: Request) {
  const url = new URL(req.url)
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "")
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host
  return `${proto}://${host}`
}

/** zod 的错误变成一句话：「tags.0：标签不能是空的」 */
export function zodMessage(error: z.ZodError) {
  return error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}：${issue.message}` : issue.message))
    .join("；")
}
