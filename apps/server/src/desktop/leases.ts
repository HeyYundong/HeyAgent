// 桌面的占用（docs/dev/desktop.md 第 3 节）：一台桌面同一时间只给一个运行用，谁占着记在 desktop_leases（一台最多一行）。
// - running：运行在用，每次调工具、工具网关开着时每 30 秒续 expires_at；worker 死了没人续，过期后由巡查删掉；
// - held：转人工（desktop.ask_human）时保留给这个运行，到 hold_until 还没处理完就放掉；
// - 放开（删行）时叫醒等它的运行：等这一台的（desktop:<id>）、等「任一台」且快照里允许这台的（desktop:any），最早挂起的一个。
// 记在数据库里，所以任何 worker、API 都能接着用，不依赖进程内的状态。
import { and, asc, eq, inArray, lte, notInArray, or, sql } from "drizzle-orm"
import { ANY_DESKTOP_EVENT, desktopEventName } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { appendEvent, type DbLike } from "../engine/records.js"
import { resume } from "../engine/waits.js"

const num = (name: string, fallback: number) => (Number(process.env[name]) > 0 ? Number(process.env[name]) : fallback)

/** running 的续约期限（每次调工具、每 30 秒续一次） */
export const DESKTOP_LEASE_TTL_MS = num("HEYAGENT_DESKTOP_LEASE_TTL_MS", 120_000)
/** worker 巡查间隔 */
export const DESKTOP_SWEEP_MS = num("HEYAGENT_DESKTOP_SWEEP_MS", 30_000)
/** 工具网关开着时多久续一次：30 秒，期限设得很短时（测试）按期限的三分之一 */
export const DESKTOP_HEARTBEAT_MS = Math.max(200, Math.min(30_000, Math.floor(DESKTOP_LEASE_TTL_MS / 3)))

const expiry = () => new Date(Date.now() + DESKTOP_LEASE_TTL_MS)

/**
 * 占一台桌面：
 * - new：新占到（之前没人占，或者占着的运行过期没续）；
 * - mine：本来就是这个运行占着（续约；held 改回 running）；
 * - busy：别的运行占着。
 */
export async function acquireDesktop(db: Db, desktopId: string, sessionId: string): Promise<"new" | "mine" | "busy"> {
  // 自己 running 的：只续约，不推送实时变化（免得页面每次调工具都刷新）
  const renewed = await db.transaction(async (tx) => {
    await tx.execute(sql`set local heyagent.skip_notify = 'on'`)
    return tx
      .update(t.desktopLeases)
      .set({ expiresAt: expiry() })
      .where(and(eq(t.desktopLeases.desktopId, desktopId), eq(t.desktopLeases.sessionId, sessionId), eq(t.desktopLeases.state, "running")))
      .returning({ id: t.desktopLeases.desktopId })
  })
  if (renewed.length) return "mine"
  // 自己 held 的（等人处理完接着用）：改回 running
  const claimed = await db
    .update(t.desktopLeases)
    .set({ state: "running", expiresAt: expiry(), holdUntil: null })
    .where(and(eq(t.desktopLeases.desktopId, desktopId), eq(t.desktopLeases.sessionId, sessionId)))
    .returning({ id: t.desktopLeases.desktopId })
  if (claimed.length) return "mine"
  // 别的运行占着但过期没续（worker 死了）：清掉再占
  await db
    .delete(t.desktopLeases)
    .where(and(eq(t.desktopLeases.desktopId, desktopId), eq(t.desktopLeases.state, "running"), lte(t.desktopLeases.expiresAt, new Date())))
  const inserted = await db
    .insert(t.desktopLeases)
    .values({ desktopId, sessionId, state: "running", expiresAt: expiry() })
    .onConflictDoNothing()
    .returning({ id: t.desktopLeases.desktopId })
  return inserted.length ? "new" : "busy"
}

/** 续约（工具网关开着时每 30 秒）。返回还占着没有（被管理员放开、过期被清掉了返回 false） */
export async function renewDesktopLease(db: Db, sessionId: string): Promise<boolean> {
  const rows = await db.transaction(async (tx) => {
    await tx.execute(sql`set local heyagent.skip_notify = 'on'`)
    return tx
      .update(t.desktopLeases)
      .set({ expiresAt: expiry() })
      .where(and(eq(t.desktopLeases.sessionId, sessionId), eq(t.desktopLeases.state, "running")))
      .returning({ id: t.desktopLeases.desktopId })
  })
  return rows.length > 0
}

/** 转人工：这个运行占着的桌面改成 held，保留到 holdMinutes 分钟后。返回桌面 id（没占着返回 undefined） */
export async function holdDesktop(db: DbLike, sessionId: string, holdMinutes: number): Promise<string | undefined> {
  const [row] = await db
    .update(t.desktopLeases)
    .set({ state: "held", holdUntil: new Date(Date.now() + holdMinutes * 60_000) })
    .where(eq(t.desktopLeases.sessionId, sessionId))
    .returning({ id: t.desktopLeases.desktopId })
  return row?.id
}

/** 放开这个运行占着的桌面（不管 running 还是 held），并叫醒等它的。返回放开的桌面 id */
export async function releaseSessionDesktop(db: Db, sessionId: string, options: { desktopId?: string } = {}): Promise<string | undefined> {
  const [row] = await db
    .delete(t.desktopLeases)
    .where(and(eq(t.desktopLeases.sessionId, sessionId), options.desktopId ? eq(t.desktopLeases.desktopId, options.desktopId) : undefined))
    .returning({ id: t.desktopLeases.desktopId })
  if (!row) return undefined
  await wakeDesktopWaiters(db, row.id).catch((error) => console.warn(`[desktop] 叫醒等桌面的运行失败：${(error as Error).message}`))
  return row.id
}

/** 管理员「放开」：删掉这台桌面的占用（不管是谁），叫醒等它的。返回原来占着的运行 */
export async function forceReleaseDesktop(db: Db, desktopId: string): Promise<{ sessionId: string; state: string } | undefined> {
  const [row] = await db
    .delete(t.desktopLeases)
    .where(eq(t.desktopLeases.desktopId, desktopId))
    .returning({ sessionId: t.desktopLeases.sessionId, state: t.desktopLeases.state })
  await wakeDesktopWaiters(db, desktopId).catch((error) => console.warn(`[desktop] 叫醒等桌面的运行失败：${(error as Error).message}`))
  return row
}

/** 这些桌面里现在被别的运行占着的（过期没续的不算） */
export async function busyDesktopIds(db: DbLike, desktopIds: string[], exceptSessionId?: string): Promise<Set<string>> {
  if (desktopIds.length === 0) return new Set()
  const rows = await db
    .select({ id: t.desktopLeases.desktopId, state: t.desktopLeases.state, expiresAt: t.desktopLeases.expiresAt, sessionId: t.desktopLeases.sessionId })
    .from(t.desktopLeases)
    .where(inArray(t.desktopLeases.desktopId, desktopIds))
  const now = Date.now()
  return new Set(
    rows.filter((row) => row.sessionId !== exceptSessionId && (row.state === "held" || row.expiresAt.getTime() > now)).map((row) => row.id)
  )
}

/**
 * 桌面空着时叫醒一个等它的运行：等这一台的、和等「任一台」且快照里允许这台的，合在一起按挂起的先后叫醒最早的一个
 * （一台桌面只给一个运行用）。等「任一台」的叫醒后重新挑，抢不到就再排队。
 */
export async function wakeDesktopWaiters(db: Db, desktopId: string): Promise<string[]> {
  const [desktop] = await db.select({ name: t.desktops.name }).from(t.desktops).where(eq(t.desktops.id, desktopId))
  if (!desktop) return []
  const [lease] = await db.select({ id: t.desktopLeases.desktopId }).from(t.desktopLeases).where(eq(t.desktopLeases.desktopId, desktopId))
  if (lease) return []
  const waits = await db
    .select({ id: t.sessionWaits.id })
    .from(t.sessionWaits)
    .innerJoin(t.sessions, eq(t.sessions.id, t.sessionWaits.sessionId))
    .where(
      and(
        eq(t.sessionWaits.status, "waiting"),
        or(
          eq(t.sessionWaits.event, desktopEventName(desktopId)),
          and(eq(t.sessionWaits.event, ANY_DESKTOP_EVENT), sql`${t.sessions.snapshot} -> 'desktop' -> 'desktops' @> ${JSON.stringify([{ id: desktopId }])}::jsonb`)
        )
      )
    )
    .orderBy(asc(t.sessionWaits.createdAt), asc(t.sessionWaits.id))
  for (const wait of waits) {
    const resumed = await resume(db, {
      waitId: wait.id,
      cause: "event",
      title: `等到桌面了：「${desktop.name}」空出来了`,
      message: `等到桌面了：桌面「${desktop.name}」空出来了，接着做。等桌面之前调的那次桌面工具没有执行，要做的话重新调一次。桌面上的窗口可能被别人动过，先看一下现状。`,
    })
    if (resumed) return [resumed]
  }
  return []
}

/**
 * 巡查（worker 每 30 秒）：
 * - running 过期没续的删掉（worker 死了）；
 * - held 过了保留时间的删掉，在那个运行里记一条；运行已经不在等人处理（取消了、结束了）的也删掉；
 * - 删掉后叫醒等的；另外等桌面、但那台已经空着的再叫一次（防止叫醒时 worker 死了丢掉）。
 */
export async function sweepDesktops(db: Db) {
  const now = new Date()
  const freed = new Set<string>()
  const expired = await db
    .delete(t.desktopLeases)
    .where(and(eq(t.desktopLeases.state, "running"), lte(t.desktopLeases.expiresAt, now)))
    .returning({ id: t.desktopLeases.desktopId })
  for (const row of expired) freed.add(row.id)
  // 保留时间到了：放开和记一条在同一个事务里（看到桌面空了就一定看得到这条，几个 worker 同时巡查也只记一次）
  const holdOver = await db
    .select({ id: t.desktopLeases.desktopId, sessionId: t.desktopLeases.sessionId })
    .from(t.desktopLeases)
    .where(and(eq(t.desktopLeases.state, "held"), lte(t.desktopLeases.holdUntil, now)))
  for (const row of holdOver) {
    const deleted = await db.transaction(async (tx) => {
      const [gone] = await tx
        .delete(t.desktopLeases)
        .where(and(eq(t.desktopLeases.desktopId, row.id), eq(t.desktopLeases.sessionId, row.sessionId), eq(t.desktopLeases.state, "held"), lte(t.desktopLeases.holdUntil, now)))
        .returning({ id: t.desktopLeases.desktopId })
      if (!gone) return false
      await appendEvent(tx, row.sessionId, {
        kind: "wait",
        title: "桌面保留时间到了，已放开",
        detail: `桌面 ${row.id}；等人处理的保留时间到了，桌面已经放开给别的运行用。处理好以后点「已处理好了」，继续时重新占这台桌面（被占着就等它）。`,
      })
      return true
    })
    if (deleted) freed.add(row.id)
  }
  // held 但运行已经不在等人处理（被取消、已结束）：不用再保留
  const stale = await db
    .select({ id: t.desktopLeases.desktopId, sessionId: t.desktopLeases.sessionId })
    .from(t.desktopLeases)
    .innerJoin(t.sessions, eq(t.sessions.id, t.desktopLeases.sessionId))
    .where(and(eq(t.desktopLeases.state, "held"), notInArray(t.sessions.status, ["needs_human", "running"])))
  for (const row of stale) {
    const deleted = await db
      .delete(t.desktopLeases)
      .where(and(eq(t.desktopLeases.desktopId, row.id), eq(t.desktopLeases.sessionId, row.sessionId), eq(t.desktopLeases.state, "held")))
      .returning({ id: t.desktopLeases.desktopId })
    if (deleted.length) freed.add(row.id)
  }
  for (const desktopId of freed) await wakeDesktopWaiters(db, desktopId).catch(() => {})

  // 还在等桌面的：对应桌面空着就再叫一次。有等「任一台」的就把每台都看一遍（桌面不多）
  const waiting = await db
    .selectDistinct({ event: t.sessionWaits.event })
    .from(t.sessionWaits)
    .where(and(eq(t.sessionWaits.status, "waiting"), sql`${t.sessionWaits.event} like 'desktop:%'`))
  const ids = new Set<string>()
  for (const row of waiting) if (row.event && row.event !== ANY_DESKTOP_EVENT) ids.add(row.event.slice("desktop:".length))
  if (waiting.some((row) => row.event === ANY_DESKTOP_EVENT)) {
    const all = await db.select({ id: t.desktops.id }).from(t.desktops).orderBy(asc(t.desktops.position), asc(t.desktops.createdAt))
    for (const row of all) ids.add(row.id)
  }
  for (const id of freed) ids.delete(id)
  if (ids.size === 0) return
  const leased = await db.select({ id: t.desktopLeases.desktopId }).from(t.desktopLeases).where(inArray(t.desktopLeases.desktopId, [...ids]))
  for (const row of leased) ids.delete(row.id)
  for (const desktopId of ids) await wakeDesktopWaiters(db, desktopId).catch(() => {})
}

/** 这个运行现在占着的桌面（running / held） */
export async function sessionLease(db: DbLike, sessionId: string) {
  const [row] = await db.select().from(t.desktopLeases).where(eq(t.desktopLeases.sessionId, sessionId))
  return row
}

/** 某台桌面的占用 */
export async function desktopLease(db: DbLike, desktopId: string) {
  const [row] = await db.select().from(t.desktopLeases).where(eq(t.desktopLeases.desktopId, desktopId))
  return row
}
