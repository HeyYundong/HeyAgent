// worker 里的浏览器管理（m2.md 第 2、5、8 条）：一个进程一个。
// - 每个 worker 同时最多开 browser.maxPerWorker 个 Chrome（设置，默认 4），满了排队；
// - session 的 Chrome：懒启动，session 结束或挂起时写回、关掉；遇到验证码等人处理时保留 browser.humanHoldMinutes 分钟；
// - 「打开 Chrome」的 Chrome：不挂 session，空闲 30 分钟自动关；
// - 登记在 browser_workers / browser_instances，API 按这里找 worker 的内部控制地址；
// - 心跳：续 worker 的心跳和账号租约；清扫：过期租约、保留到期的 Chrome、死掉的 worker 留下的登记。
import { randomBytes } from "node:crypto"
import { hostname } from "node:os"

import { and, eq, lt } from "drizzle-orm"
import { browserActionTag } from "@heyagent/shared"

import { readBrowserSettings } from "../data/config/settings.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { appendEvent } from "../engine/records.js"
import type { Keyring } from "../lib/crypto.js"
import { BrowserUnavailableError } from "./chrome.js"
import { GostPool } from "./gost.js"
import { autoLogin, loadAccountPassword, loginModelId, type AutoLoginResult } from "./auto-login.js"
import { BrowserInstance, type CloseSummary, type ProbeResult } from "./instance.js"
import { heartbeatLeases, sweepLeases, wakeProfileWaiters } from "./leases.js"

export const LOGIN_IDLE_MS = 30 * 60_000
const QUEUE_TIMEOUT_MS = Number(process.env.HEYAGENT_BROWSER_QUEUE_TIMEOUT_MS) > 0 ? Number(process.env.HEYAGENT_BROWSER_QUEUE_TIMEOUT_MS) : 10 * 60_000
const HEARTBEAT_MS = 15_000
const SWEEP_MS = Number(process.env.HEYAGENT_BROWSER_SWEEP_MS) > 0 ? Number(process.env.HEYAGENT_BROWSER_SWEEP_MS) : 30_000
/** worker 心跳超过这么久没更新，就当它死了，清掉它的登记 */
const WORKER_STALE_MS = 2 * 60_000

export class BrowserBusyError extends Error {}
/** 自动登录用不了（没存密码、没设模型） */
export class AutoLoginUnavailableError extends Error {}

export interface ManagerOptions {
  db: Db
  keyring: () => Keyring
  workerId?: string
}

export class BrowserManager {
  readonly db: Db
  readonly keyring: () => Keyring
  readonly workerId: string
  readonly gost = new GostPool()
  private readonly instances = new Map<string, BrowserInstance>()
  private readonly bySession = new Map<string, BrowserInstance>()
  private readonly slotWaiters: (() => void)[] = []
  private timers: ReturnType<typeof setInterval>[] = []
  private registered = false
  private stopping = false
  controlUrl = ""

  constructor(options: ManagerOptions) {
    this.db = options.db
    this.keyring = options.keyring
    this.workerId = options.workerId ?? `${hostname()}-${process.pid}-${randomBytes(3).toString("hex")}`
  }

  /** 登记 worker（有了内部控制地址之后），开始心跳和清扫 */
  async start(controlUrl: string) {
    this.controlUrl = controlUrl
    const settings = await readBrowserSettings(this.db)
    await this.db
      .insert(t.browserWorkers)
      .values({ id: this.workerId, controlUrl, maxBrowsers: settings.maxPerWorker })
      .onConflictDoUpdate({ target: t.browserWorkers.id, set: { controlUrl, heartbeatAt: new Date() } })
    this.registered = true
    this.timers.push(setInterval(() => void this.heartbeat(), HEARTBEAT_MS))
    this.timers.push(setInterval(() => void this.sweep(), SWEEP_MS))
    for (const timer of this.timers) timer.unref()
  }

  get(id: string) {
    return this.instances.get(id)
  }

  forSession(sessionId: string) {
    const instance = this.bySession.get(sessionId)
    return instance && instance.state !== "closing" ? instance : undefined
  }

  list() {
    return [...this.instances.values()]
  }

  private used() {
    return [...this.instances.values()].filter((instance) => instance.state !== "queued").length
  }

  private async maxPerWorker() {
    return (await readBrowserSettings(this.db)).maxPerWorker
  }

  private track(instance: BrowserInstance) {
    this.instances.set(instance.id, instance)
    if (instance.sessionId) this.bySession.set(instance.sessionId, instance)
    instance.viewer.onViewersChanged = () => {
      void this.db
        .update(t.browserInstances)
        .set({ viewers: instance.viewer.viewers(), lastActiveAt: new Date() })
        .where(eq(t.browserInstances.id, instance.id))
        .catch(() => {})
    }
    instance.onClosed(() => {
      this.instances.delete(instance.id)
      if (instance.sessionId && this.bySession.get(instance.sessionId) === instance) this.bySession.delete(instance.sessionId)
      // session 的 Chrome 关了：这个配置空出一个名额，叫醒排队的
      if (instance.kind === "session") void wakeProfileWaiters(this.db, instance.profileId).catch((error) => console.warn(`[browser] 叫醒等 Chrome 名额的 session 失败：${(error as Error).message}`))
      this.pumpSlots()
    })
  }

  private pumpSlots() {
    const next = this.slotWaiters.shift()
    next?.()
  }

  /** 等一个空位（FIFO）。超时抛错 */
  private async waitSlot(instance: BrowserInstance) {
    const deadline = Date.now() + QUEUE_TIMEOUT_MS
    while (this.used() >= (await this.maxPerWorker())) {
      if (this.stopping) throw new BrowserBusyError("worker 正在退出")
      const remaining = deadline - Date.now()
      if (remaining <= 0) throw new BrowserBusyError(`这台 worker 的 Chrome 一直是满的，排了 ${Math.round(QUEUE_TIMEOUT_MS / 60_000)} 分钟没排上`)
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, Math.min(remaining, 15_000))
        this.slotWaiters.push(() => {
          clearTimeout(timer)
          resolve()
        })
      })
      if (instance.state === "closing") throw new BrowserBusyError("排队时被取消了")
    }
  }

  /**
   * session 要用 Chrome：已经有（包括等人处理时保留着的）就接着用；没有就起一个（满了排队）。
   * onQueued：要排队时调一次（给 session 写一条「等待浏览器」的过程事件）。
   */
  async acquireForSession(input: { sessionId: string; profileId: string; allowedDomains: string[]; onQueued?: (used: number, max: number) => Promise<void> }): Promise<BrowserInstance> {
    const existing = this.forSession(input.sessionId)
    if (existing && existing.profileId === input.profileId) {
      if (existing.state === "held") await this.claim(existing)
      return existing
    }
    if (existing) await existing.close({ writeBack: true, reason: "换了 Chrome 配置" })
    const instance = new BrowserInstance(
      { db: this.db, keyring: this.keyring, gost: this.gost, workerId: this.workerId },
      { kind: "session", profileId: input.profileId, sessionId: input.sessionId, allowedDomains: input.allowedDomains }
    )
    this.track(instance)
    const max = await this.maxPerWorker()
    const full = this.used() >= max
    try {
      // 这个 Chrome 配置同时在用的运行满了：抛 ProfileFullError，session 挂起排队（不占这台 worker 的空位）
      await instance.register(full ? "queued" : "starting")
    } catch (error) {
      await instance.close({ writeBack: false, reason: (error as Error).message })
      throw error
    }
    try {
      if (full) {
        await input.onQueued?.(this.used(), max)
        await this.waitSlot(instance)
        await instance.setState("starting")
      }
      await instance.start()
      await instance.setState("running")
      return instance
    } catch (error) {
      await instance.close({ writeBack: false, reason: `Chrome 没起来：${(error as Error).message}` })
      throw error
    }
  }

  /** 保留着的 Chrome（等人处理验证码）被 session 接着用：取消保留 */
  async claim(instance: BrowserInstance) {
    await instance.setState("running", { holdUntil: null })
  }

  /** session 不用 Chrome 了（结束、挂起、交接）：要保留就保留（等人处理验证码），否则写回、关掉 */
  async releaseSession(sessionId: string, options: { holdMinutes?: number; reason: string }): Promise<{ held: boolean; summary?: CloseSummary }> {
    const instance = this.forSession(sessionId)
    if (!instance) return { held: false }
    if (options.holdMinutes && options.holdMinutes > 0 && !this.stopping) {
      await instance.setState("held", { holdUntil: new Date(Date.now() + options.holdMinutes * 60_000) })
      return { held: true }
    }
    const summary = await instance.close({ writeBack: true, reason: options.reason })
    return { held: false, summary }
  }

  /** 浏览器页「打开 Chrome」：不挂 session，装上这个配置的登录态，打开账号的探测网址或平台首页 */
  async openForLogin(input: { profileId: string; accountId?: string; userId: string }): Promise<BrowserInstance> {
    const max = await this.maxPerWorker()
    if (this.used() >= max) throw new BrowserBusyError(`这台 worker 已经开了 ${this.used()} 个 Chrome（上限 ${max}），稍后再试`)
    const instance = new BrowserInstance(
      { db: this.db, keyring: this.keyring, gost: this.gost, workerId: this.workerId },
      { kind: "login", profileId: input.profileId, accountId: input.accountId, openedById: input.userId, allowedDomains: [] }
    )
    this.track(instance)
    await instance.register("starting")
    try {
      await instance.start()
      const target = (input.accountId ? instance.accounts.find((account) => account.accountId === input.accountId) : instance.accounts[0]) ?? undefined
      if (input.accountId && !target) throw new Error(`账号 ${input.accountId} 不在这个 Chrome 配置里`)
      const url = target?.probeUrl || (target?.domains[0] ? `https://${target.domains[0]}/` : undefined)
      const page = instance.currentPage()
      if (url && page) await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => {})
      await instance.setState("running")
      return instance
    } catch (error) {
      await instance.close({ writeBack: false, reason: `Chrome 没起来：${(error as Error).message}` })
      throw error instanceof BrowserUnavailableError ? error : new Error((error as Error).message)
    }
  }

  /**
   * 「立刻登录」：开一个登录用的 Chrome（打开账号的登录网址），让登录小 agent 用存的账号密码登录。
   * 成功：关掉 Chrome，登录态合并进保险箱，探测账号；没成功：Chrome 留着给人接着登录（返回 browserId）。
   */
  async autoLogin(input: { profileId: string; accountId: string; userId: string }): Promise<AutoLoginResult & { browserId?: string; vaultVersion?: number; accounts?: ProbeResult[] }> {
    const password = await loadAccountPassword(this.db, this.keyring(), input.accountId)
    if (!password) throw new AutoLoginUnavailableError("这个账号没存密码，只能人工登录。主管可以在账号的「⋯ → 编辑账号」里存密码")
    const modelId = await loginModelId(this.db)
    if (!modelId) throw new AutoLoginUnavailableError("还没设默认的执行模型，先在「模型」页设好")
    const instance = await this.openForLogin(input)
    const account = instance.accounts.find((each) => each.accountId === input.accountId)!
    // 设置里开了「遇到验证码先自己试着过」：登录表单里的简单验证码也自己填（花费算在结果里）
    const settings = await readBrowserSettings(this.db)
    const captcha = settings.captchaSolve ? { modelId: settings.visionModel } : undefined
    let result: AutoLoginResult
    try {
      result = await autoLogin({ db: this.db, instance, account, credentials: { username: account.account, password }, modelId, captcha })
    } catch (error) {
      result = { ok: false, needHuman: false, detail: `自动登录出错：${(error as Error).message}`, steps: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 }
    }
    // 操作历史记一行（「立刻登录」不属于哪次运行）
    const url = instance.currentPage()?.url()
    if (url && url !== "about:blank")
      await this.db.insert(t.browserActions).values({ profileId: input.profileId, url, action: browserActionTag("browser_login"), failed: !result.ok }).catch(() => {})
    if (!result.ok) return { ...result, browserId: instance.id }
    const summary = await instance.close({ writeBack: true, reason: "自动登录好了，登录态已保存" })
    const probe = summary.probes.find((each) => each.accountId === input.accountId)
    return {
      ...result,
      ok: summary.vaultVersion !== undefined && probe?.ok !== false,
      detail: summary.vaultVersion === undefined ? (summary.skipped ?? "登录态没保存上") : probe && !probe.ok ? `登录后检查没通过：${probe.detail}` : result.detail,
      vaultVersion: summary.vaultVersion,
      accounts: summary.probes,
    }
  }

  private async heartbeat() {
    if (!this.registered) return
    try {
      await this.db.update(t.browserWorkers).set({ heartbeatAt: new Date() }).where(eq(t.browserWorkers.id, this.workerId))
      for (const instance of this.instances.values())
        if (instance.sessionId && instance.leased.size && instance.state !== "closing") await heartbeatLeases(this.db, instance.sessionId)
    } catch (error) {
      console.warn(`[browser] 心跳失败：${(error as Error).message}`)
    }
  }

  /** 清扫：保留到期 / session 已经不等了的 Chrome、空闲太久的登录 Chrome、过期租约、死掉的 worker */
  async sweep() {
    try {
      for (const instance of [...this.instances.values()]) {
        if (instance.state === "held" && instance.sessionId) {
          const [session] = await this.db.select({ status: t.sessions.status }).from(t.sessions).where(eq(t.sessions.id, instance.sessionId))
          const status = session?.status
          if (status === "running") continue
          if (status !== "needs_human") {
            await instance.close({ writeBack: true, reason: "运行已经不在等人处理了" })
          } else if (instance.holdUntil && instance.holdUntil.getTime() <= Date.now()) {
            const summary = await instance.close({ writeBack: true, reason: "等人处理的保留时间到了，Chrome 已关闭" })
            await appendEvent(this.db, instance.sessionId, {
              kind: "wait",
              title: "等人处理的保留时间到了，已写回登录态并关掉 Chrome",
              detail: `${summary.skipped ?? (summary.vaultVersion ? `保险箱已更新到 v${summary.vaultVersion}` : "")}。人处理时请在浏览器页「打开 Chrome」处理，再回来点「已处理好了」，继续时会新起一个 Chrome。`,
            }).catch(() => {})
          }
        } else if (instance.kind === "login" && instance.viewer.clients.size === 0 && Date.now() - instance.lastActiveAt > LOGIN_IDLE_MS) {
          await instance.close({ writeBack: true, reason: "空闲 30 分钟，自动关闭（登录态已保存）" })
        }
      }
      await sweepLeases(this.db)
      const stale = new Date(Date.now() - WORKER_STALE_MS)
      await this.db.delete(t.browserWorkers).where(and(lt(t.browserWorkers.heartbeatAt, stale)))
    } catch (error) {
      console.warn(`[browser] 清扫失败：${(error as Error).message}`)
    }
  }

  /** worker 退出：session 的 Chrome 写回再关，登录 Chrome 不保存直接关，删掉登记 */
  async stop() {
    this.stopping = true
    for (const timer of this.timers) clearInterval(timer)
    this.timers = []
    for (const waiter of this.slotWaiters.splice(0)) waiter()
    await Promise.all(
      [...this.instances.values()].map((instance) => instance.close({ writeBack: true, reason: "worker 正在退出" }).catch(() => undefined))
    )
    await this.gost.stopAll()
    if (this.registered) await this.db.delete(t.browserWorkers).where(eq(t.browserWorkers.id, this.workerId)).catch(() => {})
    this.registered = false
  }
}

let current: BrowserManager | undefined

/** 这个进程的浏览器管理（worker 启动时设置；没设置时用到浏览器会报错） */
export function setBrowserManager(manager: BrowserManager | undefined) {
  current = manager
}

export function getBrowserManager(): BrowserManager | undefined {
  return current
}
