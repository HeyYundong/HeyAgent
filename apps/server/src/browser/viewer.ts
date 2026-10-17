// 远程画面（m2.md 第 8 条）：每个开着的 Chrome 一个，worker 的内部 WebSocket 接进来的观看端都挂在这里。
// - 只在有人看的时候开 screencast，画面缩到 960 宽；收到帧立刻 ack，慢的观看端靠丢帧应对（缓冲超过 1MB 就不发）；
// - 新标签页自动跟随；切换标签页时先 bringToFront（后台标签页不出帧）；
// - 输入转发不 await：弹框打开期间 renderer 是阻塞的，CDP 调用要等弹框关掉才返回（实测）；
// - 没有操作权限的连接，输入一律丢弃（API 转发时已经丢过一次，这里再挡一次）；
// - agent 的鼠标（cdp-tap 记下的）推给观看端画虚拟光标：只推当前标签页的；agent 打字时把光标挪到有焦点的输入框
//   （在隔离环境里查，网页看不到），还推 agent 正在调的工具（光标旁边的说明）。
import { viewerClientMessageSchema, urlAllowed, type ViewerServerMessage } from "@heyagent/shared"
import type { CDPSession, Dialog, Page } from "playwright-core"
import type { WebSocket } from "ws"

import type { AgentInput } from "./cdp-tap.js"
import type { BrowserInstance } from "./instance.js"

export interface ViewerClient {
  ws: WebSocket
  userId: string
  canControl: boolean
}

const MAX_BUFFERED = 1 << 20
const FRAME = { maxWidth: 960, maxHeight: 960, quality: 60 }
/** 查焦点用的隔离环境（和网页自己的 JS 不通） */
const CURSOR_WORLD = "heyagent-cursor"
/** 有焦点的元素的中心（不在视口里、焦点在 body 上时给 null） */
const FOCUS_SCRIPT = `(() => {
  const el = document.activeElement
  if (!el || el === document.body || el === document.documentElement) return null
  const r = el.getBoundingClientRect()
  if (r.width <= 0 || r.height <= 0) return null
  const x = r.left + r.width / 2, y = r.top + r.height / 2
  if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return null
  return { x, y }
})()`

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T) =>
  Promise.race([promise.catch(() => fallback), new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])

export class ViewerHub {
  readonly clients = new Set<ViewerClient>()
  private readonly instance: BrowserInstance
  private active?: Page
  private cdp?: CDPSession
  private size = { width: 0, height: 0 }
  private activating?: Promise<void>
  private metaTimer?: ReturnType<typeof setTimeout>
  private closed = false
  /** agent 在各页面上的鼠标位置（target id → 页面视口的 CSS 像素） */
  private readonly agentCursor = new Map<string, { x: number; y: number }>()
  /** 查焦点的隔离环境（跟着 screencast 的 CDP session，导航后失效就重建） */
  private world?: { cdp: CDPSession; contextId: number }
  private focusing = false
  /** 观看的人变了（manager 用来更新 browser_instances.viewers） */
  onViewersChanged?: () => void

  constructor(instance: BrowserInstance) {
    this.instance = instance
  }

  viewers() {
    return [...this.clients].map((client) => ({ userId: client.userId, canControl: client.canControl }))
  }

  private send(client: ViewerClient, message: ViewerServerMessage) {
    if (client.ws.readyState === client.ws.OPEN) client.ws.send(JSON.stringify(message))
  }

  private broadcast(message: ViewerServerMessage) {
    for (const client of this.clients) this.send(client, message)
  }

  async add(client: ViewerClient) {
    if (this.closed) {
      this.send(client, { t: "closed", reason: "这个 Chrome 已经关了" })
      client.ws.close()
      return
    }
    this.clients.add(client)
    this.instance.touch()
    client.ws.on("message", (data, isBinary) => {
      if (isBinary) return
      this.onMessage(client, String(data))
    })
    client.ws.on("close", () => {
      this.clients.delete(client)
      this.onViewersChanged?.()
      if (this.clients.size === 0) void this.stopScreencast()
    })
    this.onViewersChanged?.()
    const page = this.active && this.instance.pages().includes(this.active) ? this.active : this.instance.currentPage()
    // 新连上的观看端要立刻有一帧：重开 screencast
    if (page) await this.activate(page, true)
    await this.sendMeta(client)
    const dialog = page ? this.instance.dialogs.get(page) : undefined
    if (dialog) this.send(client, { t: "dialog", kind: dialog.type(), message: dialog.message(), ...(dialog.defaultValue() ? { defaultValue: dialog.defaultValue() } : {}) })
  }

  private async meta(canControl: boolean): Promise<ViewerServerMessage> {
    const tabs = await Promise.all(
      this.instance.pages().map(async (page) => ({
        id: this.instance.pageId(page),
        title: await Promise.race([page.title().catch(() => ""), new Promise<string>((resolve) => setTimeout(() => resolve(""), 1000))]),
        url: page.url(),
        active: page === this.active,
      }))
    )
    return { t: "meta", width: this.size.width, height: this.size.height, tabs, url: this.active?.url() ?? "", canControl }
  }

  private async sendMeta(client: ViewerClient) {
    this.send(client, await this.meta(client.canControl))
  }

  /** 标签页、地址、尺寸变了：攒 100 毫秒再推一次 meta */
  private scheduleMeta() {
    if (this.clients.size === 0 || this.metaTimer) return
    this.metaTimer = setTimeout(() => {
      this.metaTimer = undefined
      for (const client of this.clients) void this.sendMeta(client)
    }, 100)
  }

  private async activate(page: Page, restart = false) {
    if (this.closed) return
    if (!restart && this.active === page && (this.cdp || this.clients.size === 0)) return
    const job = (this.activating ?? Promise.resolve()).then(() => this.activateInner(page))
    this.activating = job.catch(() => {})
    await this.activating
  }

  private async activateInner(page: Page) {
    await this.stopScreencast()
    this.active = page
    if (this.clients.size === 0 || this.closed || page.isClosed()) {
      this.scheduleMeta()
      return
    }
    // 后台标签页不出帧，必须先切到前台
    await page.bringToFront().catch(() => {})
    const context = this.instance.context
    if (!context) return
    const cdp = await context.newCDPSession(page).catch(() => undefined)
    if (!cdp) return
    this.cdp = cdp
    try {
      const metrics = (await cdp.send("Page.getLayoutMetrics")) as { cssLayoutViewport?: { clientWidth: number; clientHeight: number } }
      if (metrics.cssLayoutViewport) this.size = { width: metrics.cssLayoutViewport.clientWidth, height: metrics.cssLayoutViewport.clientHeight }
    } catch {
      // 拿不到就等第一帧的 metadata
    }
    cdp.on("Page.screencastFrame", (frame: { data: string; sessionId: number; metadata: { deviceWidth: number; deviceHeight: number } }) => {
      // 立刻 ack：等观看端确认再 ack 的话，RTT 一高帧率就掉（实测）
      cdp.send("Page.screencastFrameAck", { sessionId: frame.sessionId }).catch(() => {})
      if (cdp !== this.cdp) return
      const { deviceWidth, deviceHeight } = frame.metadata
      if (Math.round(deviceWidth) !== this.size.width || Math.round(deviceHeight) !== this.size.height) {
        this.size = { width: Math.round(deviceWidth), height: Math.round(deviceHeight) }
        this.scheduleMeta()
      }
      const buffer = Buffer.from(frame.data, "base64")
      for (const client of this.clients)
        if (client.ws.readyState === client.ws.OPEN && client.ws.bufferedAmount < MAX_BUFFERED) client.ws.send(buffer, { binary: true })
    })
    await cdp.send("Page.startScreencast", { format: "jpeg", quality: FRAME.quality, maxWidth: FRAME.maxWidth, maxHeight: FRAME.maxHeight, everyNthFrame: 1 }).catch(() => {})
    this.scheduleMeta()
    // 换了标签页（或新来了观看端）：光标跟着换成这个标签页上的
    const target = this.instance.targetIdOf(page)
    const at = target ? this.agentCursor.get(target) : undefined
    this.broadcast(at ? { t: "cursor", ...at, kind: "move" } : { t: "cursorHidden" })
  }

  private async stopScreencast() {
    const cdp = this.cdp
    this.cdp = undefined
    if (!cdp) return
    if (this.world?.cdp === cdp) this.world = undefined
    await cdp.send("Page.stopScreencast").catch(() => {})
    await cdp.detach().catch(() => {})
  }

  onPageAdded(page: Page) {
    // 新标签页自动跟随
    void this.activate(page)
    this.scheduleMeta()
  }

  onPageClosed(page: Page) {
    if (page === this.active) {
      this.active = undefined
      void this.stopScreencast().then(() => {
        const next = this.instance.pages().at(-1)
        if (next) void this.activate(next)
      })
    }
    this.scheduleMeta()
  }

  onNavigated(page: Page) {
    if (page === this.active) this.scheduleMeta()
  }

  onDialog(page: Page, dialog: Dialog) {
    if (page !== this.active && this.active) return
    this.broadcast({ t: "dialog", kind: dialog.type(), message: dialog.message(), ...(dialog.defaultValue() ? { defaultValue: dialog.defaultValue() } : {}) })
  }

  onDialogClosed(page: Page) {
    if (page === this.active || !this.active) this.broadcast({ t: "dialogClosed" })
  }

  /** cdp-tap 记下的 agent 输入（没人看也记位置，后来的观看端一连上就能看到光标在哪） */
  onAgentInput(input: AgentInput) {
    if (this.closed) return
    if (input.kind === "detached") {
      this.agentCursor.delete(input.targetId)
      return
    }
    const active = this.active ? this.instance.targetIdOf(this.active) : undefined
    if (input.kind === "key") {
      if (input.targetId === active) void this.followFocus(input.targetId)
      return
    }
    const at = { x: Math.round(input.x * 10) / 10, y: Math.round(input.y * 10) / 10 }
    this.agentCursor.set(input.targetId, at)
    // 松开和按下在同一个点，不用再推
    if (input.targetId !== active || input.type === "mouseReleased") return
    this.broadcast({ t: "cursor", ...at, kind: input.type === "mousePressed" ? "press" : "move" })
  }

  /** agent 要调的浏览器工具（光标旁边的说明） */
  announce(label: string) {
    if (!this.closed && this.clients.size) this.broadcast({ t: "agentAction", label })
  }

  /** agent 在打字：光标挪到有焦点的输入框（agent 的「输入」不会先点它）。没人看就不查 */
  private async followFocus(targetId: string) {
    const cdp = this.cdp
    const page = this.active
    if (this.focusing || !cdp || !page || this.clients.size === 0 || this.instance.dialogs.has(page)) return
    this.focusing = true
    try {
      // 弹框打开期间 renderer 是阻塞的，CDP 调用不返回：限时
      const at = await withTimeout(this.focusedPoint(cdp), 1500, undefined)
      if (!at || cdp !== this.cdp) return
      const point = { x: Math.round(at.x * 10) / 10, y: Math.round(at.y * 10) / 10 }
      const last = this.agentCursor.get(targetId)
      if (last && Math.abs(last.x - point.x) < 4 && Math.abs(last.y - point.y) < 4) return
      this.agentCursor.set(targetId, point)
      this.broadcast({ t: "cursor", ...point, kind: "move" })
    } finally {
      this.focusing = false
    }
  }

  private async focusedPoint(cdp: CDPSession): Promise<{ x: number; y: number } | undefined> {
    // 导航后旧的隔离环境没了：重建一次再试
    for (let attempt = 0; attempt < 2; attempt++) {
      if (this.world?.cdp !== cdp) {
        const tree = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } }
        const created = (await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: CURSOR_WORLD })) as { executionContextId: number }
        this.world = { cdp, contextId: created.executionContextId }
      }
      try {
        const evaluated = (await cdp.send("Runtime.evaluate", { expression: FOCUS_SCRIPT, contextId: this.world.contextId, returnByValue: true })) as {
          result: { value?: { x: number; y: number } | null }
        }
        return evaluated.result.value ?? undefined
      } catch {
        this.world = undefined
      }
    }
    return undefined
  }

  private onMessage(client: ViewerClient, raw: string) {
    if (!client.canControl) return
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }
    const result = viewerClientMessageSchema.safeParse(parsed)
    if (!result.success) return
    const message = result.data
    const cdp = this.cdp
    const page = this.active
    this.instance.touch()
    switch (message.t) {
      case "mouse":
        cdp
          ?.send("Input.dispatchMouseEvent", {
            type: message.type,
            x: message.x,
            y: message.y,
            button: message.button ?? "none",
            buttons: message.buttons ?? 0,
            clickCount: message.clickCount ?? 0,
            modifiers: message.modifiers ?? 0,
            deltaX: message.deltaX ?? 0,
            deltaY: message.deltaY ?? 0,
          })
          .catch(() => {})
        break
      case "key":
        cdp
          ?.send("Input.dispatchKeyEvent", {
            type: message.type,
            key: message.key,
            code: message.code,
            windowsVirtualKeyCode: message.keyCode,
            nativeVirtualKeyCode: message.keyCode,
            text: message.text,
            unmodifiedText: message.text,
            modifiers: message.modifiers ?? 0,
          })
          .catch(() => {})
        break
      case "text":
        // 中文输入法组好的字、粘贴
        cdp?.send("Input.insertText", { text: message.text }).catch(() => {})
        break
      case "nav":
        if (!page) break
        if (message.action === "back") void page.goBack().catch(() => {})
        else if (message.action === "forward") void page.goForward().catch(() => {})
        else if (message.action === "reload") void page.reload().catch(() => {})
        else if (message.url) {
          // goto 也受白名单限制（session 的 Chrome）；租约在主文档拦截里照样申请
          const allowed = this.instance.kind === "session" ? urlAllowed(message.url, this.instance.allowedDomains) : urlAllowed(message.url, [])
          if (allowed.ok) void page.goto(message.url).catch(() => {})
        }
        break
      case "tab": {
        const target = this.instance.pages().find((each) => this.instance.pageId(each) === message.id)
        if (target) void this.activate(target)
        break
      }
      case "closeTab": {
        const pages = this.instance.pages()
        const target = pages.find((each) => this.instance.pageId(each) === message.id)
        // 最后一个标签页不关（关了 Chrome 就退出了）
        if (target && pages.length > 1) void target.close().catch(() => {})
        break
      }
      case "dialog": {
        const dialog = page ? this.instance.dialogs.get(page) : undefined
        if (!dialog || !page) break
        this.instance.dialogs.delete(page)
        void (message.accept ? dialog.accept(message.promptText) : dialog.dismiss()).catch(() => {})
        break
      }
    }
  }

  close(reason: string) {
    if (this.closed) return
    this.closed = true
    if (this.metaTimer) clearTimeout(this.metaTimer)
    void this.stopScreencast()
    for (const client of this.clients) {
      this.send(client, { t: "closed", reason })
      client.ws.close(1000)
    }
    this.clients.clear()
  }
}
