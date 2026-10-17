// API 密钥：外部系统调 HeyAgent 的接口用（目前是图库的 HTTP 接口和 MCP），放在 Authorization: Bearer <密钥> 里。
// 只有主管能建、能删；库里只存 sha256，原文只在新建时返回一次。用密钥做的事算在创建人头上（权限也按创建人现在的角色算），创建人被停用后密钥跟着失效。
import { createHash, randomBytes } from "node:crypto"

import { apiKeyId, type ApiKey, type ApiKeyCreated } from "@heyagent/shared"
import { asc, eq, sql } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { assertCan, audit, nextNo, notFound, type WriteCtx } from "./common.js"

/** 密钥长这样：hk_ + 32 个 base64url 字符（24 字节随机数） */
const KEY_PREFIX = "hk_"
/** 「最近用过」最多每分钟写一次库 */
const TOUCH_MS = 60_000

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex")

export async function listApiKeys(ctx: WriteCtx): Promise<ApiKey[]> {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能看 API 密钥")
  const rows = await ctx.db.select().from(t.apiKeys).orderBy(asc(t.apiKeys.createdAt))
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    hint: row.hint,
    createdAt: row.createdAt.toISOString(),
    createdById: row.createdById,
    ...(row.lastUsedAt ? { lastUsedAt: row.lastUsedAt.toISOString() } : {}),
  }))
}

export async function createApiKey(ctx: WriteCtx, input: { name: string }): Promise<ApiKeyCreated> {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能建 API 密钥")
  const key = `${KEY_PREFIX}${randomBytes(24).toString("base64url")}`
  return ctx.db.transaction(async (tx) => {
    const id = apiKeyId(await nextNo(tx, "api_key_no_seq"))
    await tx.insert(t.apiKeys).values({ id, name: input.name, hint: key.slice(-4), sha256: sha256(key), createdById: ctx.actor.id })
    await audit(tx, ctx.actor.id, "api_key.create", "api_keys", id, { name: input.name, hint: key.slice(-4) })
    return { id, name: input.name, key }
  })
}

/** 删掉就立刻失效；用它传过的图留着（记录里的密钥 id 清空） */
export async function deleteApiKey(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能删 API 密钥")
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.delete(t.apiKeys).where(eq(t.apiKeys.id, input.id)).returning()
    if (!row) throw notFound("API 密钥", input.id)
    await audit(tx, ctx.actor.id, "api_key.delete", "api_keys", input.id, { name: row.name, hint: row.hint })
    return { id: input.id }
  })
}

export interface ApiKeyUser {
  apiKeyId: string
  user: { id: string; name: string; email: string; isAdmin: boolean }
}

/** 认密钥：对得上、创建人没被停用才算数 */
export async function verifyApiKey(db: Db, key: string): Promise<ApiKeyUser | undefined> {
  if (!key.startsWith(KEY_PREFIX)) return undefined
  const [row] = await db
    .select({ id: t.apiKeys.id, lastUsedAt: t.apiKeys.lastUsedAt, user: t.users })
    .from(t.apiKeys)
    .innerJoin(t.users, eq(t.users.id, t.apiKeys.createdById))
    .where(eq(t.apiKeys.sha256, sha256(key)))
  if (!row || row.user.banned) return undefined
  if (!row.lastUsedAt || Date.now() - row.lastUsedAt.getTime() > TOUCH_MS) {
    await db.update(t.apiKeys).set({ lastUsedAt: sql`now()` }).where(eq(t.apiKeys.id, row.id))
  }
  return { apiKeyId: row.id, user: { id: row.user.id, name: row.user.name, email: row.user.email, isAdmin: row.user.role === "admin" } }
}
