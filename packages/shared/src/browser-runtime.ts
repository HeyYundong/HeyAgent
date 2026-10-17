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

export const browserKindSchema = z.enum(["session", "login"])
export const browserStateSchema = z.enum(["queued", "starting", "running", "held", "closing"])

export const liveBrowserSchema = z.object({
  browserId: z.string(),
  /** session = 某次运行在用；login = 人在浏览器页「打开 Chrome 登录」开的 */
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
  /** session 选用的 Chrome 配置（agent 调过 browser.use，或者任务只允许一个） */
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
