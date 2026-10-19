// 「平台 × 账号」租约（m2.md 第 4 条）：同一个账号同时最多 N 个 session 在用（浏览器页配，默认 1）。
// - session 第一次打开某个平台域名下的网址时，用这个 Chrome 配置在该平台的账号申请租约；
// - 满了：这次导航先拦下，session 挂起「等待浏览器」（等事件 browser.lease:<账号 id>）；有人释放租约时叫醒最早的那个；
// - 租约带过期时间，持有的 worker 每 30 秒续一次；worker 死掉后过期的租约不再算数，定时清扫顺便叫醒排队的。
// 另外每个 Chrome 配置同一时间只给一个运行用（按开着的 session Chrome 算）。运行用浏览器时系统从任务允许的里挑空闲的；
// 允许的全被占着，session 挂起等事件 browser.profile:any（agent 指定了某一个的，等 browser.profile:<配置 id>），
// 有 session 的 Chrome 关掉时按挂起的先后叫醒一个。
import { and, asc, count, eq, gt, inArray, isNull, lte, ne, or, sql } from "drizzle-orm"
import { ANY_PROFILE_EVENT, hostMatches, leaseEventName, profileEventName } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import type { DbLike } from "../engine/records.js"
import { resume } from "../engine/waits.js"

export const LEASE_TTL_MS = Number(process.env.HEYAGENT_LEASE_TTL_MS) > 0 ? Number(process.env.HEYAGENT_LEASE_TTL_MS) : 120_000

export interface PlatformAccount {
  accountId: string
  platformId: string
  platformName: string
  account: string
  domains: string[]
  maxConcurrent: number
  probeUrl: string | null
  saveIndexedDb: boolean
  status: string
}

/** 这个 Chrome 配置在各平台的账号（带平台域名） */
export async function profileAccounts(db: DbLike, profileId: string): Promise<PlatformAccount[]> {
  const rows = await db
    .select({ account: t.browserAccounts, platform: t.platforms })
    .from(t.browserAccounts)
    .innerJoin(t.platforms, eq(t.platforms.id, t.browserAccounts.platformId))
    .where(eq(t.browserAccounts.profileId, profileId))
    .orderBy(asc(t.browserAccounts.position), asc(t.browserAccounts.createdAt))
  return rows.map(({ account, platform }) => ({
    accountId: account.id,
    platformId: platform.id,
    platformName: platform.name,
    account: account.account,
    domains: platform.domains,
    maxConcurrent: account.maxConcurrent,
    probeUrl: account.probeUrl,
    saveIndexedDb: account.saveIndexedDb,
    status: account.status,
  }))
}

/** 主机名属于哪个账号的平台（最长的域名优先：shop.example.com 比 example.com 更具体） */
export function accountForHost(accounts: readonly PlatformAccount[], host: string): PlatformAccount | undefined {
  let best: { account: PlatformAccount; length: number } | undefined
  for (const account of accounts)
    for (const domain of account.domains)
      if (hostMatches(host, domain) && (!best || domain.length > best.length)) best = { account, length: domain.length }
  return best?.account
}

export type LeaseResult = { ok: true } | { ok: false; used: number; max: number }

/**
 * 申请租约（同一个 session 已经有就续期）。在事务里锁住账号行，数完再插，并发申请不会超出上限。
 * 过期没释放的租约（worker 死了）先标成已释放，不再占位。
 */
export async function acquireLease(db: Db, accountId: string, sessionId: string): Promise<LeaseResult> {
  return db.transaction(async (tx) => {
    const locked = await tx.execute<{ max_concurrent: number }>(sql`select max_concurrent from browser_accounts where id = ${accountId} for update`)
    const max = locked.rows[0]?.max_concurrent
    if (max === undefined) return { ok: true } as const
    const now = new Date()
    await tx
      .update(t.accountLeases)
      .set({ releasedAt: now })
      .where(and(eq(t.accountLeases.accountId, accountId), isNull(t.accountLeases.releasedAt), lte(t.accountLeases.expiresAt, now)))
    const expiresAt = new Date(now.getTime() + LEASE_TTL_MS)
    const mine = await tx
      .update(t.accountLeases)
      .set({ expiresAt })
      .where(and(eq(t.accountLeases.accountId, accountId), eq(t.accountLeases.sessionId, sessionId), isNull(t.accountLeases.releasedAt)))
      .returning({ id: t.accountLeases.id })
    if (mine.length) return { ok: true } as const
    const [row] = await tx
      .select({ n: count() })
      .from(t.accountLeases)
      .where(and(eq(t.accountLeases.accountId, accountId), isNull(t.accountLeases.releasedAt)))
    const used = row?.n ?? 0
    if (used >= max) return { ok: false, used, max } as const
    await tx.insert(t.accountLeases).values({ accountId, sessionId, acquiredAt: now, expiresAt })
    return { ok: true } as const
  })
}

/** 续期这个 session 的全部租约（心跳；不推送实时变化，免得页面每 30 秒刷新一次） */
export async function heartbeatLeases(db: Db, sessionId: string) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`set local heyagent.skip_notify = 'on'`)
    await tx
      .update(t.accountLeases)
      .set({ expiresAt: new Date(Date.now() + LEASE_TTL_MS) })
      .where(and(eq(t.accountLeases.sessionId, sessionId), isNull(t.accountLeases.releasedAt), gt(t.accountLeases.expiresAt, new Date())))
  })
}

/** 释放这个 session 的全部租约，并叫醒排队等这些账号的 session */
export async function releaseLeases(db: Db, sessionId: string, accountIds?: string[]): Promise<string[]> {
  const released = await db
    .update(t.accountLeases)
    .set({ releasedAt: new Date() })
    .where(
      and(
        eq(t.accountLeases.sessionId, sessionId),
        isNull(t.accountLeases.releasedAt),
        accountIds?.length ? inArray(t.accountLeases.accountId, accountIds) : undefined
      )
    )
    .returning({ accountId: t.accountLeases.accountId })
  const accounts = [...new Set(released.map((row) => row.accountId))]
  for (const accountId of accounts) await wakeLeaseWaiters(db, accountId).catch((error) => console.warn(`[browser] 叫醒排队的 session 失败：${(error as Error).message}`))
  return accounts
}

async function activeCount(db: DbLike, accountId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(t.accountLeases)
    .where(and(eq(t.accountLeases.accountId, accountId), isNull(t.accountLeases.releasedAt), gt(t.accountLeases.expiresAt, new Date())))
  return row?.n ?? 0
}

/** 账号有空位时，按挂起的先后叫醒排队的 session（空几个叫几个；叫醒后它会重新申请，抢不到就再排队） */
export async function wakeLeaseWaiters(db: Db, accountId: string): Promise<string[]> {
  const [account] = await db.select({ max: t.browserAccounts.maxConcurrent }).from(t.browserAccounts).where(eq(t.browserAccounts.id, accountId))
  if (!account) return []
  let free = account.max - (await activeCount(db, accountId))
  if (free <= 0) return []
  const waits = await db
    .select({ id: t.sessionWaits.id, what: t.sessionWaits.what })
    .from(t.sessionWaits)
    .where(and(eq(t.sessionWaits.status, "waiting"), eq(t.sessionWaits.event, leaseEventName(accountId)), isNull(t.sessionWaits.humanItemId)))
    .orderBy(asc(t.sessionWaits.createdAt), asc(t.sessionWaits.id))
  const woken: string[] = []
  for (const wait of waits) {
    if (free <= 0) break
    const resumed = await resume(db, {
      waitId: wait.id,
      cause: "event",
      title: "等到浏览器了：账号空出来了",
      message: `等到浏览器了：之前被占用的账号现在空出来了（之前在等：${wait.what}）。刚才被拦下的网页没有打开，需要的话重新打开。`,
    })
    if (resumed) {
      woken.push(resumed)
      free--
    }
  }
  return woken
}

/** 开着 session Chrome 的条件：不算正在关的、心跳超时的 worker 上的 */
const liveSessionInstance = () =>
  and(eq(t.browserInstances.kind, "session"), ne(t.browserInstances.state, "closing"), gt(t.browserWorkers.heartbeatAt, new Date(Date.now() - 60_000)))

/** 这个 Chrome 配置现在开着几个 session 的 Chrome（每个 Chrome 同时只给一个运行用，正常是 0 或 1） */
export async function profileSessionCount(db: DbLike, profileId: string) {
  const [row] = await db
    .select({ n: count() })
    .from(t.browserInstances)
    .innerJoin(t.browserWorkers, eq(t.browserWorkers.id, t.browserInstances.workerId))
    .where(and(eq(t.browserInstances.profileId, profileId), liveSessionInstance()))
  return row?.n ?? 0
}

/** 这些 Chrome 配置里，现在正被运行占着的（挑空闲的用；登记时还会锁行再查一次） */
export async function busyProfileIds(db: DbLike, profileIds: string[]): Promise<Set<string>> {
  if (profileIds.length === 0) return new Set()
  const rows = await db
    .selectDistinct({ id: t.browserInstances.profileId })
    .from(t.browserInstances)
    .innerJoin(t.browserWorkers, eq(t.browserWorkers.id, t.browserInstances.workerId))
    .where(and(inArray(t.browserInstances.profileId, profileIds), liveSessionInstance()))
  return new Set(rows.map((row) => row.id))
}

/**
 * Chrome 配置空出来时，叫醒一个排队的 session：等这个 Chrome 的、和等「任一允许的 Chrome」且快照里允许这个的，
 * 合在一起按挂起的先后叫醒最早的那个（一个 Chrome 只给一个运行用，所以只叫一个）。
 * 等「任一」的（还没分到 Chrome）叫醒后重新挑空闲的，抢不到就再排队。
 */
export async function wakeProfileWaiters(db: Db, profileId: string): Promise<string[]> {
  const [profile] = await db.select({ name: t.browserProfiles.name }).from(t.browserProfiles).where(eq(t.browserProfiles.id, profileId))
  if (!profile) return []
  if ((await profileSessionCount(db, profileId)) > 0) return []
  const waits = await db
    .select({ id: t.sessionWaits.id, event: t.sessionWaits.event })
    .from(t.sessionWaits)
    .innerJoin(t.sessions, eq(t.sessions.id, t.sessionWaits.sessionId))
    .where(
      and(
        eq(t.sessionWaits.status, "waiting"),
        isNull(t.sessionWaits.humanItemId),
        or(
          eq(t.sessionWaits.event, profileEventName(profileId)),
          and(eq(t.sessionWaits.event, ANY_PROFILE_EVENT), sql`${t.sessions.snapshot} -> 'browser' -> 'profiles' @> ${JSON.stringify([{ id: profileId }])}::jsonb`)
        )
      )
    )
    .orderBy(asc(t.sessionWaits.createdAt), asc(t.sessionWaits.id))
  for (const wait of waits) {
    const resumed = await resume(db, {
      waitId: wait.id,
      cause: "event",
      title: `等到浏览器了：Chrome「${profile.name}」空出来了`,
      message: `等到浏览器了：Chrome「${profile.name}」空出来了。之前没打开的网页需要重新打开。`,
    })
    if (resumed) return [resumed]
  }
  return []
}

/** 定时清扫：过期没释放的租约标成已释放；有空位的账号叫醒排队的（释放时没叫到的、worker 死掉留下的） */
export async function sweepLeases(db: Db) {
  const now = new Date()
  await db
    .update(t.accountLeases)
    .set({ releasedAt: now })
    .where(and(isNull(t.accountLeases.releasedAt), lte(t.accountLeases.expiresAt, now)))
  const waiting = await db
    .selectDistinct({ event: t.sessionWaits.event })
    .from(t.sessionWaits)
    .where(and(eq(t.sessionWaits.status, "waiting"), sql`${t.sessionWaits.event} like 'browser.lease:%'`))
  for (const row of waiting) {
    const accountId = row.event?.slice("browser.lease:".length)
    if (accountId) await wakeLeaseWaiters(db, accountId).catch(() => {})
  }
  // 等 Chrome 的：worker 死掉没叫到的、叫醒后没抢到又空着的。有等「任一」的就把每个 Chrome 都看一遍（配置不多）
  const profileWaits = await db
    .selectDistinct({ event: t.sessionWaits.event })
    .from(t.sessionWaits)
    .where(and(eq(t.sessionWaits.status, "waiting"), sql`${t.sessionWaits.event} like 'browser.profile:%'`))
  const profileIds = new Set<string>()
  for (const row of profileWaits) if (row.event && row.event !== ANY_PROFILE_EVENT) profileIds.add(row.event.slice("browser.profile:".length))
  if (profileWaits.some((row) => row.event === ANY_PROFILE_EVENT)) {
    const all = await db.select({ id: t.browserProfiles.id }).from(t.browserProfiles).orderBy(asc(t.browserProfiles.position), asc(t.browserProfiles.createdAt))
    for (const row of all) profileIds.add(row.id)
  }
  for (const profileId of profileIds) await wakeProfileWaiters(db, profileId).catch(() => {})
}
