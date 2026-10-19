// 一个开着的 Chrome（m2.md 第 2 条）：独立的 Xvfb + 有界面 Chrome + 编排器自己的一条 CDP 连接（+ session 用的 Playwright MCP）。
// 编排器这条连接负责：装登录态、导出登录态、拦截不在白名单里的主文档、按平台域名申请账号租约、挂弹框监听（不处理）、
// 检测验证码、截图、远程画面。agent 通过 MCP 操作同一个 Chrome，手里没有导出 cookie 的工具；
// MCP 经 cdp-tap 连 Chrome，远程画面靠它知道 agent 的鼠标在哪。
import { randomBytes } from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { eq, inArray, sql } from "drizzle-orm"
import { hostOf, urlAllowed } from "@heyagent/shared"
import { chromium, type Browser, type BrowserContext, type CDPSession, type Dialog, type Page } from "playwright-core"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { loadSecretById } from "../engine/secrets.js"
import type { Keyring } from "../lib/crypto.js"
import { startCdpTap, type CdpTap } from "./cdp-tap.js"
import { BrowserUnavailableError, CHROME_BIN, chromeAvailable, killGroup, startChrome, startXvfb, type ChromeHandle, type XvfbHandle } from "./chrome.js"
import { judgePage, probeLooksLoggedIn, type PageFacts } from "./detect.js"
import { startDownloadCapture, type DownloadCapture } from "./downloads.js"
import type { GostPool } from "./gost.js"
import { accountForHost, acquireLease, profileAccounts, profileSessionCount, releaseLeases, type PlatformAccount } from "./leases.js"
import { startBrowserMcp, type BrowserMcp } from "./mcp.js"
import { emptyState, loadVault, writeBackMerged, type StorageState } from "./vault.js"
import { ViewerHub } from "./viewer.js"

export type InstanceKind = "session" | "login"
export type InstanceState = "queued" | "starting" | "running" | "held" | "closing"

export interface InstanceDeps {
  db: Db
  keyring: () => Keyring
  gost: GostPool
  workerId: string
}

export interface InstanceInit {
  kind: InstanceKind
  profileId: string
  sessionId?: string
  accountId?: string
  openedById?: string
  /** session：任务的网址白名单（空 = 不限制）；login：不限制 */
  allowedDomains: string[]
}

/** 被编排器拦下的导航（每次调完工具取走，告诉 agent） */
export type BlockedNavigation =
  | { kind: "allowlist"; url: string; reason: string }
  | { kind: "lease"; url: string; account: PlatformAccount; used: number; max: number }
  | { kind: "error"; url: string; reason: string }

export interface ProbeResult {
  accountId: string
  ok: boolean
  detail: string
}

/** 这个 Chrome 配置同时在用的运行满了 */
export class ProfileFullError extends Error {
  readonly profileName: string
  readonly used: number
  readonly max: number

  constructor(profileName: string, used: number, max: number) {
    super(`Chrome「${profileName}」同时最多 ${max} 个运行在用，现在已经 ${used} 个`)
    this.profileName = profileName
    this.used = used
    this.max = max
  }
}

export interface CloseSummary {
  /** 写回后的保险箱版本；没写回为空 */
  vaultVersion?: number
  /** 写回时的 cookie 个数（登录 Chrome 关闭时给人看） */
  cookieCount?: number
  probes: ProbeResult[]
  /** 没写回的原因 */
  skipped?: string
}

/** 页面里读标题、正文开头、有没有看得见的密码框 */
const PAGE_FACTS_SCRIPT = `(() => {
  const visible = (el) => el.offsetParent !== null || el.getClientRects().length > 0
  return {
    title: document.title,
    text: (document.body ? document.body.innerText : "").slice(0, 6000),
    hasPasswordInput: [...document.querySelectorAll('input[type="password"]')].some(visible),
  }
})()`

export const newBrowserId = () => `bw-${randomBytes(5).toString("hex")}`

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T) =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])

export class BrowserInstance {
  readonly id = newBrowserId()
  readonly kind: InstanceKind
  readonly profileId: string
  readonly sessionId?: string
  readonly accountId?: string
  readonly openedById?: string
  readonly allowedDomains: string[]
  readonly viewer: ViewerHub
  state: InstanceState = "starting"
  holdUntil?: Date
  lastActiveAt = Date.now()
  /** 账号：这个 Chrome 配置在各平台的账号（起的时候读一次） */
  accounts: PlatformAccount[] = []
  /** 这个 session 拿到了租约的账号 */
  readonly leased = new Set<string>()
  /** 打开过平台页面的账号（写回前要探测这些账号） */
  readonly touched = new Set<string>()
  blocked: BlockedNavigation[] = []
  context?: BrowserContext
  /** 运行的 Chrome：下载的文件存成这次运行的文件（browser/downloads.ts） */
  downloads?: DownloadCapture

  private readonly deps: InstanceDeps
  private dir?: string
  private xvfb?: XvfbHandle
  private chrome?: ChromeHandle
  private browser?: Browser
  private mcp?: BrowserMcp
  private mcpStarting?: Promise<BrowserMcp>
  private tap?: CdpTap
  private base: StorageState = emptyState()
  private saveIndexedDb = false
  private readonly pageIds = new WeakMap<Page, number>()
  /** 页面 → Chrome 的 target id（cdp-tap 记下的 agent 输入按它对上页面） */
  private readonly targetIds = new WeakMap<Page, string>()
  private nextPageId = 1
  readonly dialogs = new Map<Page, Dialog>()
  private lastNavigated?: Page
  private closing?: Promise<CloseSummary>
  private readonly closedListeners: ((summary: CloseSummary) => void)[] = []
  private urlWrite?: ReturnType<typeof setTimeout>

  constructor(deps: InstanceDeps, init: InstanceInit) {
    this.deps = deps
    this.kind = init.kind
    this.profileId = init.profileId
    this.sessionId = init.sessionId
    this.accountId = init.accountId
    this.openedById = init.openedById
    this.allowedDomains = init.allowedDomains
    this.viewer = new ViewerHub(this)
  }

  get db() {
    return this.deps.db
  }

  /** 先登记（排队的时候也要让页面看得到「等待浏览器」） */
  /**
   * 登记到 browser_instances。session 的 Chrome 同时占这个配置的一个名额：锁住配置行再数，并发登记也不会超过 max_sessions；
   * 满了抛 ProfileFullError（session 挂起排队）。人「打开 Chrome」开的不占名额。
   */
  async register(state: InstanceState) {
    this.state = state
    const values = {
      id: this.id,
      workerId: this.deps.workerId,
      kind: this.kind,
      profileId: this.profileId,
      sessionId: this.sessionId ?? null,
      accountId: this.accountId ?? null,
      openedById: this.openedById ?? null,
      state,
    }
    if (this.kind !== "session") {
      await this.db.insert(t.browserInstances).values(values)
      return
    }
    await this.db.transaction(async (tx) => {
      const locked = await tx.execute<{ max_sessions: number; name: string }>(sql`select max_sessions, name from browser_profiles where id = ${this.profileId} for update`)
      const profile = locked.rows[0]
      if (profile) {
        const used = await profileSessionCount(tx, this.profileId)
        if (used >= profile.max_sessions) throw new ProfileFullError(profile.name, used, profile.max_sessions)
      }
      await tx.insert(t.browserInstances).values(values)
    })
  }

  async setState(state: InstanceState, extra: { holdUntil?: Date | null } = {}) {
    this.state = state
    if (extra.holdUntil !== undefined) this.holdUntil = extra.holdUntil ?? undefined
    await this.db
      .update(t.browserInstances)
      .set({ state, ...(extra.holdUntil !== undefined ? { holdUntil: extra.holdUntil } : {}), lastActiveAt: new Date() })
      .where(eq(t.browserInstances.id, this.id))
      .catch(() => {})
  }

  touch() {
    this.lastActiveAt = Date.now()
  }

  /** 起 Xvfb + Chrome，连上编排器的 CDP，装登录态 */
  async start() {
    if (!chromeAvailable()) throw new BrowserUnavailableError(`这台机器上没有 Chrome（${CHROME_BIN}），浏览器只能在 worker 镜像里用`)
    const { db } = this.deps
    const [profile] = await db.select().from(t.browserProfiles).where(eq(t.browserProfiles.id, this.profileId))
    if (!profile) throw new Error(`找不到 Chrome 配置 ${this.profileId}`)
    this.accounts = await profileAccounts(db, this.profileId)
    this.saveIndexedDb = this.accounts.some((account) => account.saveIndexedDb)

    let proxyServer: string | undefined
    let proxyHost: string | undefined
    if (profile.proxyKind === "socks5" && profile.proxyHost && profile.proxyPort) {
      const password = profile.proxyPasswordSecretId ? await loadSecretById(db, profile.proxyPasswordSecretId) : undefined
      if (profile.proxyUsername && password) {
        // 带认证：本地 gost 转发（密码在 0600 的配置文件里）
        const port = await this.deps.gost.ensure(this.profileId, { host: profile.proxyHost, port: profile.proxyPort, username: profile.proxyUsername, password })
        proxyServer = `socks5://127.0.0.1:${port}`
        proxyHost = "127.0.0.1"
      } else {
        proxyServer = `socks5://${profile.proxyHost}:${profile.proxyPort}`
        proxyHost = profile.proxyHost
      }
    }

    const vault = await loadVault(db, this.deps.keyring(), this.profileId)
    this.base = vault.state

    this.dir = mkdtempSync(join(tmpdir(), `heyagent-${this.id}-`))
    const userDataDir = join(this.dir, "profile")
    mkdirSync(userDataDir, { recursive: true })
    mkdirSync(this.workDir, { recursive: true })
    mkdirSync(this.outputDir, { recursive: true })
    mkdirSync(join(this.dir, "tmp"), { recursive: true })
    this.xvfb = await startXvfb()
    this.chrome = await startChrome({
      userDataDir,
      display: this.xvfb.display,
      locale: profile.locale ?? undefined,
      timezone: profile.timezone ?? undefined,
      proxyServer,
      proxyHost,
      tmpDir: join(this.dir, "tmp"),
    })
    // noDefaults：不让 Playwright 给已有页面开 focus emulation，后台标签页的可见性和真人使用时一样（实测）
    this.browser = await chromium.connectOverCDP(this.chrome.wsEndpoint, { noDefaults: true })
    const context = this.browser.contexts()[0]
    if (!context) throw new Error("Chrome 没有默认 context")
    this.context = context
    context.on("page", (page) => void this.watchPage(page, true))
    const startup = context.pages()
    for (const page of startup) await this.watchPage(page, false)
    // 隐藏自动化标记的参数会让启动标签页多一条提示条（页面矮 56 像素）：新开一个，关掉启动的那个
    await context.newPage()
    for (const page of startup) await page.close().catch(() => {})
    if (vault.state.cookies.length || vault.state.origins.length) await context.setStorageState(vault.state as Parameters<BrowserContext["setStorageState"]>[0])
    if (this.kind === "session" && this.sessionId) this.downloads = await startDownloadCapture(this.browser, { db, sessionId: this.sessionId, dir: join(this.dir, "downloads") })
    this.browser.on("disconnected", () => {
      if (this.state !== "closing") void this.close({ writeBack: false, reason: "Chrome 意外退出了" })
    })
  }

  get workDir() {
    return join(this.dir ?? tmpdir(), "work")
  }

  get outputDir() {
    return join(this.dir ?? tmpdir(), "work", "output")
  }

  get cdpEndpoint() {
    return this.chrome?.wsEndpoint
  }

  pageId(page: Page) {
    let id = this.pageIds.get(page)
    if (!id) {
      id = this.nextPageId++
      this.pageIds.set(page, id)
    }
    return id
  }

  targetIdOf(page: Page): string | undefined {
    return this.targetIds.get(page)
  }

  pages(): Page[] {
    return this.context?.pages() ?? []
  }

  /** agent 最近操作的页面（最后一次主 frame 导航的），没有就取最后一个 */
  currentPage(): Page | undefined {
    const pages = this.pages()
    if (this.lastNavigated && pages.includes(this.lastNavigated)) return this.lastNavigated
    return pages.at(-1)
  }

  /** 每个页面：挂弹框监听（不处理，留给 agent 或人）、拦截主文档请求（白名单、账号租约） */
  private async watchPage(page: Page, follow: boolean) {
    this.pageId(page)
    page.on("dialog", (dialog) => {
      // 什么都不做：编排器的连接不挂监听的话，Playwright 会自动关掉弹框，MCP 的 browser_handle_dialog 就失效了（实测）
      this.dialogs.set(page, dialog)
      this.viewer.onDialog(page, dialog)
    })
    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return
      this.lastNavigated = page
      this.viewer.onNavigated(page)
      this.scheduleUrlWrite(page)
    })
    page.on("close", () => {
      this.dialogs.delete(page)
      this.viewer.onPageClosed(page)
    })
    let session: CDPSession | undefined
    try {
      session = await this.context!.newCDPSession(page)
      const info = (await session.send("Target.getTargetInfo")) as { targetInfo: { targetId: string } }
      this.targetIds.set(page, info.targetInfo.targetId)
      const frameTree = (await session.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } }
      const mainFrameId = frameTree.frameTree.frame.id
      session.on("Fetch.requestPaused", (event) => void this.onRequestPaused(session!, mainFrameId, event as RequestPaused))
      session.on("Page.javascriptDialogClosed", () => {
        this.dialogs.delete(page)
        this.viewer.onDialogClosed(page)
      })
      await session.send("Page.enable")
      await session.send("Fetch.enable", { patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }] })
    } catch {
      // 页面刚开就关了
    }
    if (follow) this.viewer.onPageAdded(page)
  }

  private async onRequestPaused(session: CDPSession, mainFrameId: string, event: RequestPaused) {
    if (event.frameId !== mainFrameId) {
      await session.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {})
      return
    }
    const verdict = await this.checkNavigation(event.request.url)
    if (verdict) {
      this.blocked.push(verdict)
      await session.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" }).catch(() => {})
    } else {
      await session.send("Fetch.continueRequest", { requestId: event.requestId }).catch(() => {})
    }
  }

  /**
   * 主文档要打开这个网址：白名单（只管 session 的）+ 平台账号租约（session 第一次打开平台域名下的网址时申请）。
   * 放行返回 undefined；拦下返回原因。关 Chrome 前的登录探测不受限制。
   */
  async checkNavigation(url: string): Promise<BlockedNavigation | undefined> {
    if (this.state === "closing") return undefined
    if (this.kind === "session") {
      const allowed = urlAllowed(url, this.allowedDomains)
      if (!allowed.ok) return { kind: "allowlist", url, reason: allowed.reason }
    }
    const host = hostOf(url)
    if (!host) return undefined
    const account = accountForHost(this.accounts, host)
    if (!account) return undefined
    this.touched.add(account.accountId)
    if (this.kind !== "session" || !this.sessionId || this.leased.has(account.accountId)) return undefined
    try {
      const lease = await acquireLease(this.db, account.accountId, this.sessionId)
      if (!lease.ok) return { kind: "lease", url, account, used: lease.used, max: lease.max }
      this.leased.add(account.accountId)
      return undefined
    } catch (error) {
      return { kind: "error", url, reason: `申请账号租约失败：${(error as Error).message}` }
    }
  }

  /** 取走拦下的导航 */
  drainBlocked(): BlockedNavigation[] {
    const out = this.blocked
    this.blocked = []
    return out
  }

  /** 兜底：新开的标签页第一次导航可能早于拦截挂上，调完工具再看一遍所有页面，不该开的换成空白页 */
  async sweepPages() {
    for (const page of this.pages()) {
      const url = page.url()
      // 只看 http(s)：about:blank、被拦下后的 chrome-error 页不用管（file: 这类 MCP 本来就不让开）
      if (!/^https?:/i.test(url)) continue
      const verdict = await this.checkNavigation(url)
      if (verdict) {
        this.blocked.push(verdict)
        await page.goto("about:blank").catch(() => {})
      }
    }
  }

  private scheduleUrlWrite(page: Page) {
    if (this.urlWrite) clearTimeout(this.urlWrite)
    this.urlWrite = setTimeout(() => {
      this.urlWrite = undefined
      void (async () => {
        const title = await withTimeout(page.title().catch(() => ""), 2000, "")
        await this.db
          .update(t.browserInstances)
          .set({ url: page.url().slice(0, 2000), title: title.slice(0, 300), lastActiveAt: new Date() })
          .where(eq(t.browserInstances.id, this.id))
          .catch(() => {})
      })()
    }, 500)
  }

  /** 页面的地址、iframe、标题、正文开头、有没有密码框（弹框开着时拿不到，返回 undefined） */
  async pageFacts(page: Page): Promise<PageFacts | undefined> {
    if (this.dialogs.has(page)) return undefined
    const facts = await withTimeout(
      page
        // 在页面里跑的函数（浏览器环境，不是 Node），用字符串免得类型检查要求 DOM 库
        .evaluate(PAGE_FACTS_SCRIPT)
        .then((value) => value as { title: string; text: string; hasPasswordInput: boolean })
        .catch(() => undefined),
      4000,
      undefined
    )
    if (!facts) return undefined
    return { url: page.url(), frameUrls: page.frames().map((frame) => frame.url()), ...facts }
  }

  /** 看一遍所有页面，找验证码或登录页（找到第一个就返回） */
  async detect(): Promise<{ page: Page; facts: PageFacts; verdict: ReturnType<typeof judgePage> } | undefined> {
    let uncertain: { page: Page; facts: PageFacts; verdict: ReturnType<typeof judgePage> } | undefined
    for (const page of this.pages()) {
      const url = page.url()
      if (!url || url === "about:blank") continue
      const facts = await this.pageFacts(page)
      if (!facts) continue
      const verdict = judgePage(facts)
      if (verdict.kind === "captcha" || verdict.kind === "login") return { page, facts, verdict }
      if (verdict.kind === "uncertain" && !uncertain) uncertain = { page, facts, verdict }
    }
    return uncertain
  }

  async screenshot(page = this.currentPage()): Promise<Buffer | undefined> {
    if (!page || this.dialogs.has(page)) return undefined
    return withTimeout(
      page.screenshot({ type: "jpeg", quality: 70, timeout: 10_000 }).catch(() => undefined),
      12_000,
      undefined
    )
  }

  /** session 用的 Playwright MCP（第一次调浏览器工具时起） */
  async ensureMcp(): Promise<BrowserMcp> {
    if (this.mcp) return this.mcp
    if (!this.chrome) throw new Error("Chrome 还没起来")
    const wsEndpoint = this.chrome.wsEndpoint
    this.mcpStarting ??= (async () => {
      this.tap ??= await startCdpTap(wsEndpoint, {
        onInput: (input) => this.viewer.onAgentInput(input),
        shouldDelay: () => this.viewer.clients.size > 0,
      })
      return startBrowserMcp(this.tap.url, this.workDir, this.outputDir)
    })()
    try {
      this.mcp = await this.mcpStarting
      return this.mcp
    } finally {
      this.mcpStarting = undefined
    }
  }

  async exportState(): Promise<StorageState> {
    if (!this.context) return emptyState()
    const state = await this.context.storageState({ indexedDB: this.saveIndexedDb })
    return state as unknown as StorageState
  }

  /** 登录探测：打开账号的探测网址，最终地址不像登录页、页面上也没有密码框，就算还在登录状态 */
  async probe(account: PlatformAccount): Promise<ProbeResult> {
    if (!account.probeUrl || !this.context) return { accountId: account.accountId, ok: true, detail: "没配探测网址，跳过" }
    const page = await this.context.newPage()
    try {
      await page.goto(account.probeUrl, { waitUntil: "domcontentloaded", timeout: 30_000 })
      await page.waitForLoadState("load", { timeout: 10_000 }).catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 1000))
      const facts = await this.pageFacts(page)
      if (!facts) return { accountId: account.accountId, ok: false, detail: "探测网址打开后读不了页面（可能有弹框）" }
      return { accountId: account.accountId, ...probeLooksLoggedIn(facts, account.probeUrl) }
    } catch (error) {
      return { accountId: account.accountId, ok: false, detail: `探测网址打不开：${(error as Error).message.split("\n")[0]}` }
    } finally {
      await page.close().catch(() => {})
    }
  }

  async setAccountStatus(accountIds: string[], status: "ok" | "expired" | "captcha", extra: { loggedInById?: string } = {}) {
    if (!accountIds.length) return
    await this.db
      .update(t.browserAccounts)
      .set({ status, ...(extra.loggedInById ? { lastLoginAt: new Date(), loggedInById: extra.loggedInById } : {}) })
      .where(inArray(t.browserAccounts.id, accountIds))
  }

  onClosed(listener: (summary: CloseSummary) => void) {
    this.closedListeners.push(listener)
  }

  /**
   * 关掉。登录 Chrome（人开的）：关的时候总是写回——三方合并，人改过的覆盖库里的（谁最后写谁的算），再探测账号、更新状态。
   * 运行的 Chrome：（要写回时）先探测用过的账号，都还在登录状态才三方合并写回；探测失败就不写回，把账号标成「要登录」。
   * 然后关 MCP、断开编排器连接、按进程组杀 Chrome 和 Xvfb、删临时目录、释放租约、删登记。
   */
  close(options: { writeBack: boolean; reason: string }): Promise<CloseSummary> {
    this.closing ??= this.closeInner(options)
    return this.closing
  }

  private async closeInner(options: { writeBack: boolean; reason: string }): Promise<CloseSummary> {
    const previous = this.state
    this.state = "closing"
    await this.db.update(t.browserInstances).set({ state: "closing" }).where(eq(t.browserInstances.id, this.id)).catch(() => {})
    const summary: CloseSummary = { probes: [] }
    if (options.writeBack && this.kind === "login" && this.context && this.browser?.isConnected() && previous !== "queued") {
      try {
        const mine = await this.exportState()
        summary.vaultVersion = await writeBackMerged(this.db, this.deps.keyring(), this.profileId, this.base, mine, { userId: this.openedById ?? null })
        summary.cookieCount = mine.cookies.length
        const targets = this.accountId ? this.accounts.filter((account) => account.accountId === this.accountId) : this.accounts.filter((account) => account.probeUrl)
        for (const account of targets) summary.probes.push(await this.probe(account))
        await this.setAccountStatus(
          summary.probes.filter((probe) => probe.ok).map((probe) => probe.accountId),
          "ok",
          this.openedById ? { loggedInById: this.openedById } : {}
        )
      } catch (error) {
        summary.skipped = `写回登录态出错：${(error as Error).message}`
      }
    } else if (options.writeBack && this.context && this.browser?.isConnected() && previous !== "queued") {
      try {
        const used = this.accounts.filter((account) => this.touched.has(account.accountId) && account.probeUrl)
        for (const account of used) summary.probes.push(await this.probe(account))
        const failed = summary.probes.filter((probe) => !probe.ok)
        if (failed.length) {
          summary.skipped = `登录探测没通过（${failed.map((probe) => probe.detail).join("；")}），没有写回保险箱`
          await this.setAccountStatus(
            failed.map((probe) => probe.accountId),
            "expired"
          )
        } else {
          const mine = await this.exportState()
          summary.vaultVersion = await writeBackMerged(this.db, this.deps.keyring(), this.profileId, this.base, mine, { sessionId: this.sessionId ?? null })
          await this.setAccountStatus(
            summary.probes.filter((probe) => probe.ok && probe.detail !== "没配探测网址，跳过").map((probe) => probe.accountId),
            "ok"
          )
        }
      } catch (error) {
        summary.skipped = `写回登录态出错：${(error as Error).message}`
      }
    }
    this.viewer.close(options.reason)
    if (this.urlWrite) clearTimeout(this.urlWrite)
    await this.downloads?.close()
    await this.mcp?.close()
    this.mcp = undefined
    await this.tap?.close()
    this.tap = undefined
    await this.browser?.close().catch(() => {})
    await killGroup(this.chrome?.proc)
    await killGroup(this.xvfb?.proc, 2000)
    if (this.dir) rmSync(this.dir, { recursive: true, force: true })
    if (this.sessionId && this.kind === "session") await releaseLeases(this.db, this.sessionId).catch(() => {})
    this.leased.clear()
    await this.db.delete(t.browserInstances).where(eq(t.browserInstances.id, this.id)).catch(() => {})
    for (const listener of this.closedListeners) listener(summary)
    return summary
  }
}

interface RequestPaused {
  requestId: string
  frameId: string
  resourceType: string
  request: { url: string }
}
