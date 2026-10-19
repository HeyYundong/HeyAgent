// 浏览器运行时的共享类型（M2）：远程画面的消息格式、browser-router 的输入输出、网址白名单和平台域名的匹配。
// 平台通用：这里只有通用的概念（Chrome 配置、平台域名、账号租约），不出现任何具体网站。
import { z } from "zod"

import { accountStatusSchema, isoTime } from "./schemas.js"

// ---------- 域名：白名单、平台域名 ----------

/**
 * 把用户填的域名规整成小写主机名：去掉协议、路径、端口、开头的「*.」或「.」。
 * 例如 "https://Shop.Example.com/a" → "shop.example.com"，"*.example.com" → "example.com"。认不出返回 undefined。
 */
export function normalizeDomain(value: string): string | undefined {
  let text = value.trim().toLowerCase()
  if (!text) return undefined
  text = text.replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
  text = text.split(/[/?#]/)[0]!
  text = text.replace(/^\[|\]$/g, "")
  // 去掉端口（IPv6 不支持，内网用 IPv4 或域名）
  if (/^[^:]+:\d+$/.test(text)) text = text.slice(0, text.lastIndexOf(":"))
  text = text.replace(/^\*\./, "").replace(/^\.+/, "").replace(/\.+$/, "")
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/.test(text)) return undefined
  return text
}

/** 域名输入：规整后再存（不合法的给中文提示） */
export const domainSchema = z
  .string()
  .max(253, "域名太长了")
  .transform((value, ctx) => {
    const domain = normalizeDomain(value)
    if (!domain) {
      ctx.addIssue({ code: "custom", message: `「${value}」不是合法的域名，例如 example.com` })
      return z.NEVER
    }
    return domain
  })

/** 主机名是不是这个域名或它的子域名 */
export function hostMatches(host: string, domain: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, "")
  const d = domain.toLowerCase()
  return h === d || h.endsWith(`.${d}`)
}

/**
 * 拆出网址的协议和主机名（shared 要前后端都能用，不依赖 URL 全局对象）。
 * 例如 "https://user@Shop.Example.com:8443/a" → { scheme: "https:", host: "shop.example.com" }；认不出返回 undefined
 */
export function parseUrl(url: string): { scheme: string; host: string } | undefined {
  const match = /^([a-z][a-z0-9+.-]*):(?:\/\/([^/?#\\]*))?/i.exec(url.trim())
  if (!match) return undefined
  const scheme = `${match[1]!.toLowerCase()}:`
  let host = match[2] ?? ""
  host = host.slice(host.lastIndexOf("@") + 1)
  if (host.startsWith("[")) host = host.slice(1, host.indexOf("]") > 0 ? host.indexOf("]") : undefined)
  else host = host.replace(/:\d*$/, "")
  return { scheme, host: host.toLowerCase().replace(/\.$/, "") }
}

export function hostOf(url: string): string | undefined {
  return parseUrl(url)?.host || undefined
}

/**
 * 网址在不在白名单里。白名单为空 = 不限制。只管 http(s)；about:blank、data: 这类本地页面放行，
 * file:、chrome: 之类一律不放（白名单为空时也不放 file:）。
 */
export function urlAllowed(url: string, allowedDomains: readonly string[]): { ok: true } | { ok: false; reason: string } {
  const parsed = parseUrl(url)
  if (!parsed) return { ok: false, reason: `看不懂这个网址：${url}` }
  const { scheme, host } = parsed
  if (scheme === "about:" || scheme === "data:" || scheme === "blob:") return { ok: true }
  if (scheme !== "http:" && scheme !== "https:") return { ok: false, reason: `不允许打开 ${scheme} 开头的网址` }
  if (!host) return { ok: false, reason: `看不懂这个网址：${url}` }
  if (allowedDomains.length === 0) return { ok: true }
  if (allowedDomains.some((domain) => hostMatches(host, domain))) return { ok: true }
  return { ok: false, reason: `${host} 不在本任务的网址白名单里（允许：${allowedDomains.join("、")}）` }
}

/** 账号租约满了时 session 等的事件名（释放租约时叫醒最早的那个） */
export const leaseEventName = (accountId: string) => `browser.lease:${accountId}`
/** 等某一个 Chrome 配置空出来的事件（agent 指定的 Chrome、或任务只允许一个时，它被别的运行占着就挂起等这个） */
export const profileEventName = (profileId: string) => `browser.profile:${profileId}`
/**
 * 等「任务允许的任何一个 Chrome」空出来（允许的全都被别的运行占着时挂起等这个）。
 * 叫醒时看 session 快照里允许的 Chrome 有没有空出来的那个（配置 id 都是 br- 开头，不会和 any 撞）
 */
export const ANY_PROFILE_EVENT = "browser.profile:any"

// ---------- 远程画面的消息（worker ⇄ API ⇄ 控制台，格式两段相同） ----------

/** 服务端 → 浏览器的 JSON 消息；二进制消息 = 一帧 JPEG */
export type ViewerServerMessage =
  | {
      t: "meta"
      /** 页面视口的 CSS 像素尺寸（画面图片缩到 960 宽，坐标按这个尺寸换算） */
      width: number
      height: number
      tabs: { id: number; title: string; url: string; active: boolean }[]
      url: string
      /** 这条连接能不能操作（没权限的输入会被丢弃） */
      canControl: boolean
    }
  | { t: "dialog"; kind: string; message: string; defaultValue?: string }
  /** 弹框已经关掉了（被人或 agent 处理了） */
  | { t: "dialogClosed" }
  | { t: "closed"; reason: string }
  /** agent 的鼠标（画面上的虚拟光标）：页面视口的 CSS 像素；press = 在这里按下了（画一圈波纹） */
  | { t: "cursor"; x: number; y: number; kind: "move" | "press" }
  /** 当前标签页上 agent 还没动过鼠标（换了标签页） */
  | { t: "cursorHidden" }
  /** agent 正在调的浏览器工具（光标旁边显示一会儿），见 browserActionLabel */
  | { t: "agentAction"; label: string }

const modifiers = z.number().int().min(0).max(15).optional()

/** 浏览器 → 服务端的消息（JSON）。服务端按这个 schema 校验，不认识的丢弃 */
export const viewerClientMessageSchema = z.discriminatedUnion("t", [
  z.object({
    t: z.literal("mouse"),
    type: z.enum(["mousePressed", "mouseReleased", "mouseMoved", "mouseWheel"]),
    x: z.number(),
    y: z.number(),
    button: z.enum(["none", "left", "middle", "right", "back", "forward"]).optional(),
    buttons: z.number().int().min(0).max(31).optional(),
    clickCount: z.number().int().min(0).max(3).optional(),
    modifiers,
    deltaX: z.number().optional(),
    deltaY: z.number().optional(),
  }),
  z.object({
    t: z.literal("key"),
    type: z.enum(["keyDown", "keyUp", "rawKeyDown", "char"]),
    key: z.string().max(40).optional(),
    code: z.string().max(40).optional(),
    keyCode: z.number().int().min(0).max(1000).optional(),
    text: z.string().max(8).optional(),
    modifiers,
  }),
  z.object({ t: z.literal("text"), text: z.string().min(1).max(10_000) }),
  z.object({ t: z.literal("nav"), action: z.enum(["back", "forward", "reload", "goto"]), url: z.string().max(4000).optional() }),
  z.object({ t: z.literal("tab"), id: z.number().int() }),
  z.object({ t: z.literal("closeTab"), id: z.number().int() }),
  z.object({ t: z.literal("dialog"), accept: z.boolean(), promptText: z.string().max(10_000).optional() }),
])
export type ViewerClientMessage = z.infer<typeof viewerClientMessageSchema>

// ---------- browser-router 的输入输出 ----------

export const openForLoginInputSchema = z.object({
  profileId: z.string().min(1),
  /** 要登录哪个账号：打开它的登录探测网址；不填就打开第一个账号的探测网址或平台首页 */
  accountId: z.string().min(1).optional(),
})
export const browserIdInputSchema = z.object({ browserId: z.string().min(1) })

export const saveLoginResultSchema = z.object({
  browserId: z.string(),
  vaultVersion: z.number().int(),
  cookieCount: z.number().int(),
  /** 每个配了探测网址的账号的探测结果；通过的标成「正常」 */
  accounts: z.array(z.object({ accountId: z.string(), ok: z.boolean(), detail: z.string() })),
})
export type SaveLoginResult = z.infer<typeof saveLoginResultSchema>

/** 「立刻登录」的结果：成功就已经写回保险箱；没成功时 Chrome 留着（browserId），给人在远程画面里接着登录 */
export const autoLoginResultSchema = z.object({
  ok: z.boolean(),
  /** 要人处理（验证码、短信码、账号密码不对……） */
  needHuman: z.boolean(),
  detail: z.string(),
  steps: z.number().int(),
  costUsd: z.number(),
  /** 没成功时留着的 Chrome，前端打开远程画面让人接着登录；关掉照常保存 */
  browserId: z.string().optional(),
  vaultVersion: z.number().int().optional(),
  /** 登录后的账号探测 */
  accounts: z.array(z.object({ accountId: z.string(), ok: z.boolean(), detail: z.string() })).optional(),
})
export type AutoLoginResult = z.infer<typeof autoLoginResultSchema>

export const browserKindSchema = z.enum(["session", "login"])
export const browserStateSchema = z.enum(["queued", "starting", "running", "held", "closing"])

export const liveBrowserSchema = z.object({
  browserId: z.string(),
  /** session = 某次运行在用；login = 人在浏览器页「打开 Chrome」开的 */
  kind: browserKindSchema,
  /** queued 排队等空位；starting 正在起；running 开着；held 等人处理（验证码），保留到 holdUntil；closing 正在写回、关闭 */
  state: browserStateSchema,
  profileId: z.string(),
  profileName: z.string(),
  sessionId: z.string().optional(),
  taskId: z.string().optional(),
  accountId: z.string().optional(),
  openedById: z.string().optional(),
  url: z.string(),
  title: z.string(),
  /** 正在看远程画面的人 */
  viewers: z.array(z.object({ userId: z.string(), canControl: z.boolean() })),
  startedAt: isoTime,
  lastActiveAt: isoTime,
  holdUntil: isoTime.optional(),
})
export type LiveBrowser = z.infer<typeof liveBrowserSchema>

export const sessionBrowserSchema = z.object({
  /** 这个 session 现在有没有开着的 Chrome */
  open: z.boolean(),
  browserId: z.string().optional(),
  state: browserStateSchema.optional(),
  /** session 用的 Chrome 配置（系统自动挑的空闲的，或者 agent 调 browser.use 指定的） */
  profileId: z.string().optional(),
  /** 当前操作的人能不能在远程画面里操作（负责人、被分配处理的人、主管） */
  canControl: z.boolean(),
})
export type SessionBrowser = z.infer<typeof sessionBrowserSchema>

export const accountUsageSchema = z.object({
  accountId: z.string(),
  profileId: z.string(),
  platformId: z.string(),
  account: z.string(),
  status: accountStatusSchema,
  /** 现在占着租约的 session 数 / 上限 */
  used: z.number().int(),
  max: z.number().int(),
  /** 占着租约的 session */
  sessionIds: z.array(z.string()),
  /** 排队等这个账号的 session 数 */
  waiting: z.number().int(),
})
export type AccountUsage = z.infer<typeof accountUsageSchema>

// ---------- 操作历史（浏览器页） ----------

/** 浏览器工具（Playwright MCP 的工具名）→ 操作历史里的动作标签；不在表里的取工具名去掉 browser_ */
const ACTION_TAGS: Record<string, string> = {
  browser_navigate: "Open",
  browser_navigate_back: "Back",
  browser_snapshot: "View",
  browser_find: "View",
  browser_take_screenshot: "Screenshot",
  browser_click: "Click",
  browser_type: "Input",
  browser_fill_form: "Input",
  browser_press_key: "Key",
  browser_select_option: "Select",
  browser_hover: "Hover",
  browser_drag: "Drag",
  browser_drop: "Upload",
  browser_file_upload: "Upload",
  browser_handle_dialog: "Dialog",
  browser_tabs: "Tab",
  browser_wait_for: "Wait",
  browser_evaluate: "Script",
  browser_close: "Close",
  browser_resize: "Resize",
  browser_emulate_media: "Resize",
  /** 不是 MCP 工具：用存的密码自动登录（登录小 agent） */
  browser_login: "Login",
  /** 不是 MCP 工具：视觉模型认验证码、填进去（自动过验证码） */
  browser_captcha: "Captcha",
  browser_console_messages: "Inspect",
  browser_network_requests: "Inspect",
  browser_network_request: "Inspect",
}

export function browserActionTag(toolName: string): string {
  return ACTION_TAGS[toolName] ?? toolName.replace(/^browser_/, "")
}

const LABEL_DETAIL_MAX = 40

/**
 * 远程画面上光标旁边的动作说明：动作标签 + agent 给的元素描述（MCP 参数里的 element 等），例如「Click · 搜索按钮」。
 * 只取描述性的参数，不取要填的内容（text、value 里可能是密码）；打开网址只给域名。
 */
export function browserActionLabel(toolName: string, args: Record<string, unknown>): string {
  const str = (value: unknown) => (typeof value === "string" ? value.trim() : "")
  let detail = str(args.element)
  if (toolName === "browser_drag") detail = [str(args.startElement), str(args.endElement)].filter(Boolean).join(" → ")
  else if (toolName === "browser_fill_form" && Array.isArray(args.fields))
    detail = args.fields.map((field) => str((field as { name?: unknown } | null)?.name)).filter(Boolean).join("、")
  else if (toolName === "browser_press_key") detail = str(args.key)
  else if (toolName === "browser_navigate" || (toolName === "browser_tabs" && args.url)) detail = hostOf(str(args.url)) ?? ""
  if (detail.length > LABEL_DETAIL_MAX) detail = `${detail.slice(0, LABEL_DETAIL_MAX - 1)}…`
  const tag = browserActionTag(toolName)
  return detail ? `${tag} · ${detail}` : tag
}

/** 操作历史的一行：同一次运行在同一个网址上连着做的动作合成一行（动作去重、按第一次出现的顺序） */
export const browserHistoryRowSchema = z.object({
  /** 这一行第一个动作的时间 */
  at: isoTime,
  url: z.string(),
  sessionId: z.string().optional(),
  actions: z.array(z.object({ tag: z.string(), count: z.number().int(), failed: z.boolean() })),
})
export type BrowserHistoryRow = z.infer<typeof browserHistoryRowSchema>

/** 按时间倒序的原始动作 → 操作历史的行（也是倒序） */
export function groupBrowserActions(
  actions: { at: string; url: string; sessionId?: string | null; action: string; failed: boolean }[]
): BrowserHistoryRow[] {
  const rows: BrowserHistoryRow[] = []
  // 倒序进来：同一行里越往后的越早，at 取最早的那个，动作顺序最后再翻过来
  for (const each of actions) {
    const last = rows.at(-1)
    const sessionId = each.sessionId ?? undefined
    const row = last && last.url === each.url && last.sessionId === sessionId ? last : undefined
    const target = row ?? { at: each.at, url: each.url, ...(sessionId ? { sessionId } : {}), actions: [] }
    if (!row) rows.push(target)
    target.at = each.at
    const tag = target.actions.find((one) => one.tag === each.action)
    if (tag) {
      tag.count += 1
      tag.failed ||= each.failed
    } else target.actions.push({ tag: each.action, count: 1, failed: each.failed })
  }
  for (const row of rows) row.actions.reverse()
  return rows
}
