// 浏览器配置的写操作：Chrome（代理，密码进 secrets）、平台（网站）、平台账号（并发上限、登录探测网址）。
// M2 才真正启动 Chrome；这里只管配置。正在被 session 占用（有没释放的账号租约）的不能删。
import { and, count, eq, inArray, isNull } from "drizzle-orm"
import { browserAccountId, browserProfileId } from "@heyagent/shared"

import * as t from "../../db/schema.js"
import { assertCan, audit, badRequest, conflict, deleteSecret, freeId, notFound, putSecret, slugOf, type DbOrTx, type WriteCtx } from "./common.js"

type Proxy = { kind: "none" } | { kind: "socks5"; host: string; port: number; username?: string; password?: string; clearPassword?: boolean }

export interface BrowserProfileFields {
  name: string
  description: string
  proxy: Proxy
  exitIp?: string
  timezone?: string
  locale?: string
  maxSessions?: number
}

async function activeLeases(db: DbOrTx, accountIds: string[]) {
  if (accountIds.length === 0) return 0
  const [row] = await db
    .select({ n: count() })
    .from(t.accountLeases)
    .where(and(inArray(t.accountLeases.accountId, accountIds), isNull(t.accountLeases.releasedAt)))
  return row?.n ?? 0
}

/** 代理密码：填了就加密存（换值），勾了「去掉密码」或不用代理就删掉 */
async function saveProxyPassword(tx: DbOrTx, ctx: WriteCtx, profileId: string, proxy: Proxy, currentSecretId: string | null) {
  const ref = { scope: "browser_proxy" as const, refId: profileId, name: "password" }
  if (proxy.kind === "socks5" && proxy.password) return putSecret(tx, ctx.keyring(), ref, proxy.password, ctx.actor.id)
  if (proxy.kind === "none" || (proxy.kind === "socks5" && proxy.clearPassword)) {
    await deleteSecret(tx, ref)
    return null
  }
  return currentSecretId
}

const proxyColumns = (proxy: Proxy) =>
  proxy.kind === "socks5"
    ? { proxyKind: "socks5" as const, proxyHost: proxy.host, proxyPort: proxy.port, proxyUsername: proxy.username || null }
    : { proxyKind: "none" as const, proxyHost: null, proxyPort: null, proxyUsername: null }

export async function createBrowserProfile(ctx: WriteCtx, input: BrowserProfileFields) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能新建 Chrome")
  return ctx.db.transaction(async (tx) => {
    const id = await freeId(async (each) => (await tx.select({ id: t.browserProfiles.id }).from(t.browserProfiles).where(eq(t.browserProfiles.id, each))).length > 0, browserProfileId(slugOf(input.name) || "chrome"))
    await tx.insert(t.browserProfiles).values({
      id,
      name: input.name,
      description: input.description,
      ...proxyColumns(input.proxy),
      // 出口地只是给人看的一句话，系统不检测；没填就空着
      exitIp: input.exitIp ?? "",
      timezone: input.timezone || null,
      locale: input.locale || null,
      ...(input.maxSessions ? { maxSessions: input.maxSessions } : {}),
    })
    const secretId = await saveProxyPassword(tx, ctx, id, input.proxy, null)
    if (secretId) await tx.update(t.browserProfiles).set({ proxyPasswordSecretId: secretId }).where(eq(t.browserProfiles.id, id))
    await audit(tx, ctx.actor.id, "browser_profile.create", "browser_profiles", id, { name: input.name, proxy: input.proxy.kind, passwordSet: Boolean(secretId) })
    return { id }
  })
}

export async function updateBrowserProfile(ctx: WriteCtx, input: BrowserProfileFields & { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能修改 Chrome")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.browserProfiles).where(eq(t.browserProfiles.id, input.id))
    if (!before) throw notFound("Chrome", input.id)
    const secretId = await saveProxyPassword(tx, ctx, input.id, input.proxy, before.proxyPasswordSecretId)
    await tx
      .update(t.browserProfiles)
      .set({
        name: input.name,
        description: input.description,
        ...proxyColumns(input.proxy),
        proxyPasswordSecretId: secretId,
        // 不传 = 不改；传空 = 清掉
        ...(input.exitIp !== undefined ? { exitIp: input.exitIp } : {}),
        timezone: input.timezone || null,
        locale: input.locale || null,
        ...(input.maxSessions ? { maxSessions: input.maxSessions } : {}),
      })
      .where(eq(t.browserProfiles.id, input.id))
    const passwordChange = input.proxy.kind === "socks5" && input.proxy.password ? "set" : secretId === null && before.proxyPasswordSecretId ? "cleared" : "kept"
    await audit(tx, ctx.actor.id, "browser_profile.update", "browser_profiles", input.id, { proxy: input.proxy.kind, password: passwordChange, ...(input.maxSessions ? { maxSessions: input.maxSessions } : {}) })
    return { id: input.id }
  })
}

/** 删除 Chrome：保险箱和账号一起删；有 session 正在用它的账号时不能删 */
export async function deleteBrowserProfile(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能删除 Chrome")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.browserProfiles).where(eq(t.browserProfiles.id, input.id))
    if (!before) throw notFound("Chrome", input.id)
    const accounts = (await tx.select({ id: t.browserAccounts.id }).from(t.browserAccounts).where(eq(t.browserAccounts.profileId, input.id))).map((row) => row.id)
    const busy = await activeLeases(tx, accounts)
    if (busy) throw conflict(`「${before.name}」现在有 ${busy} 个 session 在用，等它们用完再删。`)
    await tx.delete(t.browserProfiles).where(eq(t.browserProfiles.id, input.id))
    await deleteSecret(tx, { scope: "browser_proxy", refId: input.id, name: "password" })
    await audit(tx, ctx.actor.id, "browser_profile.delete", "browser_profiles", input.id, { name: before.name, accounts })
    return { id: input.id }
  })
}

// ---------- 平台（网站） ----------

export async function createPlatform(ctx: WriteCtx, input: { name: string; id?: string; domains?: string[] }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能加平台")
  return ctx.db.transaction(async (tx) => {
    const [sameName] = await tx.select({ id: t.platforms.id }).from(t.platforms).where(eq(t.platforms.name, input.name))
    if (sameName) throw conflict(`已经有叫「${input.name}」的平台了`)
    const exists = async (each: string) => (await tx.select({ id: t.platforms.id }).from(t.platforms).where(eq(t.platforms.id, each))).length > 0
    if (input.id && (await exists(input.id))) throw conflict(`英文短名 ${input.id} 已经被用了`)
    const id = input.id ?? (await freeId(exists, slugOf(input.name) || "site"))
    const [last] = await tx.select({ n: count() }).from(t.platforms)
    const domains = [...new Set(input.domains ?? [])]
    await tx.insert(t.platforms).values({ id, name: input.name, domains, position: last?.n ?? 0 })
    await audit(tx, ctx.actor.id, "platform.create", "platforms", id, { name: input.name, domains })
    return { id }
  })
}

/** 改平台的名字和域名（M2：域名决定 session 打开哪些网址时要申请账号租约） */
export async function updatePlatform(ctx: WriteCtx, input: { id: string; name: string; domains: string[] }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能改平台")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.platforms).where(eq(t.platforms.id, input.id))
    if (!before) throw notFound("平台", input.id)
    const [sameName] = await tx.select({ id: t.platforms.id }).from(t.platforms).where(eq(t.platforms.name, input.name))
    if (sameName && sameName.id !== input.id) throw conflict(`已经有叫「${input.name}」的平台了`)
    const domains = [...new Set(input.domains)]
    await tx.update(t.platforms).set({ name: input.name, domains }).where(eq(t.platforms.id, input.id))
    await audit(tx, ctx.actor.id, "platform.update", "platforms", input.id, { name: input.name, domains, before: { name: before.name, domains: before.domains } })
    return { id: input.id }
  })
}

export async function deletePlatform(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能删平台")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.platforms).where(eq(t.platforms.id, input.id))
    if (!before) throw notFound("平台", input.id)
    const [used] = await tx.select({ n: count() }).from(t.browserAccounts).where(eq(t.browserAccounts.platformId, input.id))
    if ((used?.n ?? 0) > 0) throw conflict(`平台「${before.name}」下还有 ${used!.n} 个账号，先删掉这些账号。`)
    await tx.delete(t.platforms).where(eq(t.platforms.id, input.id))
    await audit(tx, ctx.actor.id, "platform.delete", "platforms", input.id, { name: before.name })
    return { id: input.id }
  })
}

// ---------- 平台账号 ----------

export async function createBrowserAccount(ctx: WriteCtx, input: { profileId: string; platformId: string; account: string; maxConcurrent: number; probeUrl?: string; saveIndexedDb: boolean }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能加账号")
  return ctx.db.transaction(async (tx) => {
    const [profile] = await tx.select({ id: t.browserProfiles.id }).from(t.browserProfiles).where(eq(t.browserProfiles.id, input.profileId))
    if (!profile) throw notFound("Chrome", input.profileId)
    const [platform] = await tx.select({ id: t.platforms.id }).from(t.platforms).where(eq(t.platforms.id, input.platformId))
    if (!platform) throw badRequest(`平台 ${input.platformId} 不存在，先加平台`)
    const [same] = await tx
      .select({ id: t.browserAccounts.id })
      .from(t.browserAccounts)
      .where(and(eq(t.browserAccounts.profileId, input.profileId), eq(t.browserAccounts.platformId, input.platformId), eq(t.browserAccounts.account, input.account)))
    if (same) throw conflict("这个 Chrome 里已经有这个平台的这个账号了")
    let id = browserAccountId(input.profileId, input.platformId)
    for (let k = 2; (await tx.select({ id: t.browserAccounts.id }).from(t.browserAccounts).where(eq(t.browserAccounts.id, id))).length > 0; k++) {
      id = browserAccountId(input.profileId, input.platformId, k)
    }
    // 新账号还没人登录过：状态是「要登录」，等人在远程画面里登录（M2）
    await tx.insert(t.browserAccounts).values({
      id,
      profileId: input.profileId,
      platformId: input.platformId,
      account: input.account,
      status: "expired",
      maxConcurrent: input.maxConcurrent,
      probeUrl: input.probeUrl || null,
      saveIndexedDb: input.saveIndexedDb,
    })
    await audit(tx, ctx.actor.id, "browser_account.create", "browser_accounts", id, { profileId: input.profileId, platformId: input.platformId, maxConcurrent: input.maxConcurrent })
    return { id }
  })
}

export async function updateBrowserAccount(ctx: WriteCtx, input: { id: string; account?: string; maxConcurrent?: number; probeUrl?: string; saveIndexedDb?: boolean }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能改账号")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.browserAccounts).where(eq(t.browserAccounts.id, input.id))
    if (!before) throw notFound("账号", input.id)
    const next = {
      ...(input.account !== undefined ? { account: input.account } : {}),
      ...(input.maxConcurrent !== undefined ? { maxConcurrent: input.maxConcurrent } : {}),
      ...(input.probeUrl !== undefined ? { probeUrl: input.probeUrl || null } : {}),
      ...(input.saveIndexedDb !== undefined ? { saveIndexedDb: input.saveIndexedDb } : {}),
    }
    if (Object.keys(next).length === 0) return { id: input.id }
    await tx.update(t.browserAccounts).set(next).where(eq(t.browserAccounts.id, input.id))
    await audit(tx, ctx.actor.id, "browser_account.update", "browser_accounts", input.id, { changed: Object.keys(next), ...(input.maxConcurrent !== undefined ? { maxConcurrent: input.maxConcurrent } : {}) })
    return { id: input.id }
  })
}

export async function deleteBrowserAccount(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能删账号")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.browserAccounts).where(eq(t.browserAccounts.id, input.id))
    if (!before) throw notFound("账号", input.id)
    const busy = await activeLeases(tx, [input.id])
    if (busy) throw conflict(`这个账号现在有 ${busy} 个 session 在用，等它们用完再删。`)
    await tx.delete(t.browserAccounts).where(eq(t.browserAccounts.id, input.id))
    await audit(tx, ctx.actor.id, "browser_account.delete", "browser_accounts", input.id, { profileId: before.profileId, platformId: before.platformId })
    return { id: input.id }
  })
}
