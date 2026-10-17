// 配置写操作共用的小工具：权限、报错、审计、密钥加密存储、编号。
// 写操作都在一个事务里做完「改数据 + 记审计」，任何一步失败整个回滚。
import { randomBytes } from "node:crypto"

import { TRPCError } from "@trpc/server"
import { and, eq, isNull, sql } from "drizzle-orm"
import { can, type Action, type ActionResources, type Actor } from "@heyagent/shared"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { encrypt, mask, type Keyring } from "../../lib/crypto.js"

export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]
export type DbOrTx = Db | Tx

/** 写操作要的上下文：谁在做、库、主密钥 */
export interface WriteCtx {
  db: Db
  actor: Actor
  keyring: () => Keyring
}

// ---------- 报错 ----------

export const forbidden = (message = "你没有权限做这个操作") => new TRPCError({ code: "FORBIDDEN", message })
export const notFound = (what: string, id: string) => new TRPCError({ code: "NOT_FOUND", message: `找不到${what} ${id}` })
export const badRequest = (message: string) => new TRPCError({ code: "BAD_REQUEST", message })
/** 被别的东西用着、状态不对：前端把 message 原样显示给人看 */
export const conflict = (message: string) => new TRPCError({ code: "CONFLICT", message })

export function assertCan<A extends Action>(actor: Actor, action: A, resource: ActionResources[A], message?: string) {
  if (!can(actor, action, resource)) throw forbidden(message)
}

// ---------- 审计 ----------

/** 记一条审计：谁、做了什么、对哪一行；detail 里不放密钥原文 */
export async function audit(tx: DbOrTx, actorId: string | null, action: string, targetTable: string, targetId: string, detail: Record<string, unknown> = {}) {
  await tx.insert(t.auditEvents).values({ actorId, action, targetTable, targetId, detail })
}

// ---------- 编号 ----------

type SeqName = "task_no_seq" | "memory_no_seq" | "skill_no_seq" | "rule_no_seq" | "human_item_no_seq" | "todo_no_seq"

export async function nextNo(tx: DbOrTx, seq: SeqName): Promise<number> {
  const result = await tx.execute<{ n: string }>(sql`select nextval(${seq}) as n`)
  return Number(result.rows[0]!.n)
}

/** 英文短名：只留小写字母、数字和 -；全是中文时返回空字符串 */
export const slugOf = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)

/** base 已经被占用时依次试 base-2、base-3…… */
export async function freeId(exists: (id: string) => Promise<boolean>, base: string): Promise<string> {
  if (!(await exists(base))) return base
  for (let n = 2; n < 1000; n++) {
    const id = `${base}-${n}`
    if (!(await exists(id))) return id
  }
  throw conflict(`编号 ${base} 用完了，换个名字再试`)
}

// ---------- 密钥 ----------

type Scope = (typeof t.secretScopeEnum.enumValues)[number]

export interface SecretRef {
  scope: Scope
  /** 属于哪个对象；HTTP 工具和通知渠道的密钥全局共用、按名字引用，这里为 null */
  refId: string | null
  name: string
}

const refCondition = (ref: SecretRef) =>
  and(eq(t.secrets.scope, ref.scope), ref.refId === null ? isNull(t.secrets.refId) : eq(t.secrets.refId, ref.refId), eq(t.secrets.name, ref.name))

export async function findSecret(tx: DbOrTx, ref: SecretRef) {
  const [row] = await tx.select({ id: t.secrets.id, version: t.secrets.version, masked: t.secrets.masked }).from(t.secrets).where(refCondition(ref))
  return row
}

/**
 * 存一个密钥：没有就新建，有就换值（版本号 +1，AAD 跟着变，旧密文作废）。返回 secrets.id。
 * 原文只在这里经过一次，加密后就丢掉；任何接口都不返回原文。
 */
export async function putSecret(tx: DbOrTx, keyring: Keyring, ref: SecretRef, value: string, actorId: string | null, keepStart?: number): Promise<string> {
  const existing = await findSecret(tx, ref)
  const masked = mask(value, keepStart)
  const now = new Date()
  if (existing) {
    const version = existing.version + 1
    await tx
      .update(t.secrets)
      .set({ version, enc: encrypt(keyring, value, { table: "secrets", id: existing.id, version }), masked, createdById: actorId, createdAt: now, updatedAt: now })
      .where(eq(t.secrets.id, existing.id))
    return existing.id
  }
  const id = `sec-${ref.scope.replace(/_/g, "-")}-${randomBytes(6).toString("hex")}`
  await tx.insert(t.secrets).values({
    id,
    scope: ref.scope,
    refId: ref.refId,
    name: ref.name,
    version: 1,
    enc: encrypt(keyring, value, { table: "secrets", id, version: 1 }),
    masked,
    createdById: actorId,
    createdAt: now,
    updatedAt: now,
  })
  return id
}

export async function deleteSecret(tx: DbOrTx, ref: SecretRef) {
  await tx.delete(t.secrets).where(refCondition(ref))
}

/** 审计里记「改了哪些字段」：密钥类字段只记名字 */
export function changedFields<T extends Record<string, unknown>>(before: T, after: Partial<T>): string[] {
  return Object.keys(after).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
}
