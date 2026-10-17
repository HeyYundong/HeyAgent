// 登录态保险箱（m2.md 第 4 条）：每个 Chrome 配置一份加密的 storageState（cookie + localStorage，可选 IndexedDB），带版本号。
// - session 开始时整份装进 Chrome（记下当时的版本作为 base）；
// - 写回时做三方合并：只写本 session 改过的项（新增、修改、删除），别的 session 在这期间写进去的保留；再用版本号 CAS，冲突重读重试；
// - 人在远程画面里登录：关 Chrome 时同样三方合并写回，人改过的覆盖库里的（谁最后写谁的算）。
// 密文的 AAD 绑定「browser_vaults:Chrome id:版本号」，挪到别的配置或版本号对不上都解不开。
import { and, eq, sql } from "drizzle-orm"

import * as t from "../db/schema.js"
import type { DbLike } from "../engine/records.js"
import { decryptText, encrypt, type Keyring } from "../lib/crypto.js"

export interface StoredCookie {
  name: string
  value: string
  domain: string
  path: string
  expires: number
  httpOnly: boolean
  secure: boolean
  sameSite: "Strict" | "Lax" | "None"
}

export interface StoredOrigin {
  origin: string
  localStorage: { name: string; value: string }[]
  indexedDB?: unknown[]
}

export interface StorageState {
  cookies: StoredCookie[]
  origins: StoredOrigin[]
}

export const emptyState = (): StorageState => ({ cookies: [], origins: [] })

export interface VaultSnapshot {
  /** 0 = 还没有保险箱 */
  version: number
  state: StorageState
}

const aad = (profileId: string, version: number) => ({ table: "browser_vaults", id: profileId, version })

export async function loadVault(db: DbLike, keyring: Keyring, profileId: string): Promise<VaultSnapshot> {
  const [row] = await db.select().from(t.browserVaults).where(eq(t.browserVaults.profileId, profileId))
  if (!row) return { version: 0, state: emptyState() }
  try {
    const state = JSON.parse(decryptText(keyring, row.enc, aad(profileId, row.version))) as StorageState
    return { version: row.version, state: { cookies: state.cookies ?? [], origins: state.origins ?? [] } }
  } catch (error) {
    // 解不开（主密钥换了、或者是种子里的假数据）：当作空的，下次写回时整份覆盖
    console.warn(`[browser] Chrome ${profileId} 的保险箱 v${row.version} 解不开：${(error as Error).message}，按空的处理`)
    return { version: row.version, state: emptyState() }
  }
}

/** 版本号 CAS：保险箱还是 expected 版本才写（写成 expected + 1）。没有保险箱时 expected = 0 */
export async function casWrite(
  db: DbLike,
  keyring: Keyring,
  profileId: string,
  expected: number,
  state: StorageState,
  by: { sessionId?: string | null; userId?: string | null }
): Promise<number | false> {
  const next = expected + 1
  const enc = encrypt(keyring, JSON.stringify(state), aad(profileId, next))
  const values = {
    version: next,
    enc,
    cookieCount: state.cookies.length,
    updatedBySessionId: by.sessionId ?? null,
    updatedById: by.userId ?? null,
    updatedAt: new Date(),
  }
  if (expected === 0) {
    const inserted = await db
      .insert(t.browserVaults)
      .values({ profileId, ...values })
      .onConflictDoNothing()
      .returning({ version: t.browserVaults.version })
    return inserted.length ? next : false
  }
  const updated = await db
    .update(t.browserVaults)
    .set(values)
    .where(and(eq(t.browserVaults.profileId, profileId), eq(t.browserVaults.version, expected)))
    .returning({ version: t.browserVaults.version })
  return updated.length ? next : false
}

const cookieKey = (cookie: Pick<StoredCookie, "name" | "domain" | "path">) => `${cookie.name}|${cookie.domain}|${cookie.path}`
const sameCookie = (a: StoredCookie, b: StoredCookie) =>
  a.value === b.value && a.expires === b.expires && a.httpOnly === b.httpOnly && a.secure === b.secure && a.sameSite === b.sameSite

/**
 * 三方合并：base = session 开始时装进去的版本，mine = session 结束时导出的，theirs = 现在库里的。
 * - cookie 以 name|domain|path 为键：本 session 新增或改动的覆盖 theirs，本 session 删掉的从 theirs 删掉，其余保持 theirs；
 * - localStorage 按 origin + key 同样处理；
 * - IndexedDB 某个 origin 有变化就整份覆盖该 origin（v1 简化，见 browser-stack-2026-10.md 第 5 节）。
 */
export function mergeStates(base: StorageState, mine: StorageState, theirs: StorageState): StorageState {
  const baseCookies = new Map(base.cookies.map((cookie) => [cookieKey(cookie), cookie]))
  const mineCookies = new Map(mine.cookies.map((cookie) => [cookieKey(cookie), cookie]))
  const result = new Map(theirs.cookies.map((cookie) => [cookieKey(cookie), cookie]))
  for (const [key, cookie] of mineCookies) {
    const before = baseCookies.get(key)
    if (!before || !sameCookie(before, cookie)) result.set(key, cookie)
  }
  for (const key of baseCookies.keys()) if (!mineCookies.has(key)) result.delete(key)

  const origins = new Map(theirs.origins.map((origin) => [origin.origin, structuredClone(origin)]))
  const baseOrigins = new Map(base.origins.map((origin) => [origin.origin, origin]))
  const mineOrigins = new Map(mine.origins.map((origin) => [origin.origin, origin]))
  const allOrigins = new Set([...baseOrigins.keys(), ...mineOrigins.keys()])
  for (const name of allOrigins) {
    const before = baseOrigins.get(name)
    const after = mineOrigins.get(name)
    const target: StoredOrigin = origins.get(name) ?? { origin: name, localStorage: [] }
    const beforeItems = new Map((before?.localStorage ?? []).map((item) => [item.name, item.value]))
    const afterItems = new Map((after?.localStorage ?? []).map((item) => [item.name, item.value]))
    const items = new Map(target.localStorage.map((item) => [item.name, item.value]))
    for (const [key, value] of afterItems) if (beforeItems.get(key) !== value) items.set(key, value)
    for (const key of beforeItems.keys()) if (!afterItems.has(key)) items.delete(key)
    target.localStorage = [...items].map(([key, value]) => ({ name: key, value }))
    if (JSON.stringify(after?.indexedDB ?? null) !== JSON.stringify(before?.indexedDB ?? null)) {
      if (after?.indexedDB) target.indexedDB = after.indexedDB
      else delete target.indexedDB
    }
    if (target.localStorage.length || target.indexedDB) origins.set(name, target)
    else origins.delete(name)
  }
  return { cookies: [...result.values()], origins: [...origins.values()] }
}

/** session 结束时写回：三方合并 + CAS，冲突重读重试。返回新版本号 */
export async function writeBackMerged(
  db: DbLike,
  keyring: Keyring,
  profileId: string,
  base: StorageState,
  mine: StorageState,
  by: { sessionId?: string | null; userId?: string | null }
): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const current = await loadVault(db, keyring, profileId)
    const merged = mergeStates(base, mine, current.state)
    const written = await casWrite(db, keyring, profileId, current.version, merged, by)
    if (written !== false) return written
  }
  throw new Error(`保险箱一直在被别人改，写回 Chrome ${profileId} 的登录态失败`)
}


/** 测试和排查用：当前版本号 */
export async function vaultVersion(db: DbLike, profileId: string) {
  const rows = await db.execute<{ version: number }>(sql`select version from browser_vaults where profile_id = ${profileId}`)
  return rows.rows[0]?.version ?? 0
}
