// 直接调网站的接口（docs/dev/solidify.md 19.2、19.3、19.4）：browser.fetch 和记接口共用的几样东西。
// - fetchTargetAllowed：能调哪些网址（没设白名单只能同源；设了的话目标和当前页面要落在同一条白名单里）；
// - 打码：按整个字段名（SITE_SECRET_KEYS），JSON 的键、查询参数、表单参数；nextPageToken 这类留着（翻页要用）；
// - shape：返回 JSON 的字段结构，像 TypeScript 的写法，给固化员看；
// - sendInPage：在页面的隔离环境里发请求（Page.createIsolatedWorld + Runtime.callFunctionOn，同 clipboard.ts 的 callIsolated）。
//   页面脚本改不了隔离环境里的 fetch，也看不到参数和结果；origin 还是页面的 origin，cookie 由浏览器自己带。
// 平台通用：只有通用的概念（同源、白名单、接口），不出现任何具体网站。
import {
  FETCH_MAX_BYTES,
  FETCH_TIMEOUT_MS,
  hostMatches,
  SITE_SECRET_MASK,
  siteSecretKey,
  type FetchCsrf,
} from "@heyagent/shared"
import type { Page } from "playwright-core"

// ---------- 能调哪些网址 ----------

const isHttp = (url: URL) => url.protocol === "http:" || url.protocol === "https:"

function parseHttp(raw: string): URL | undefined {
  // 只认完整的网址：相对路径的话，规则、白名单、过程记录看到的都不是真正的目标
  if (!/^https?:\/\//i.test(raw.trim())) return undefined
  try {
    const url = new URL(raw.trim())
    return isHttp(url) && url.hostname ? url : undefined
  } catch {
    return undefined
  }
}

/** 页面不是 http(s)（空白页、出错页）时的说法 */
export const NEED_PAGE = "先用 browser.navigate 打开这个网站的页面（browser.fetch 在当前页面里发请求，登录态、同源都靠它）"

/**
 * browser.fetch 能不能调这个网址、记接口记不记它（同一条规矩）：
 * - 目标要是完整的 http(s) 网址，当前页面也要是 http(s) 的；
 * - 任务没设白名单：只能和当前页面同源（协议、主机、端口都一样）；
 * - 设了白名单：目标的主机和当前页面的主机落在同一条白名单里。不引入公共后缀表，白名单填多宽就放多宽。
 */
export function fetchTargetAllowed(target: string, pageUrl: string | undefined, allowedDomains: readonly string[]): { ok: true } | { ok: false; reason: string } {
  const to = parseHttp(target)
  if (!to) return { ok: false, reason: `要写完整的 http(s) 网址（https://…），不认相对路径：${target.slice(0, 200)}` }
  const page = pageUrl ? parseHttp(pageUrl) : undefined
  if (!page) return { ok: false, reason: NEED_PAGE }
  if (!allowedDomains.length) {
    if (to.origin === page.origin) return { ok: true }
    return { ok: false, reason: `只能调和当前页面同源的接口（${page.origin}），${to.origin} 不是。任务设了网址白名单的话，和页面落在同一条白名单里的也能调` }
  }
  const host = to.hostname.toLowerCase()
  const pageHost = page.hostname.toLowerCase()
  if (allowedDomains.some((domain) => hostMatches(host, domain) && hostMatches(pageHost, domain))) return { ok: true }
  return { ok: false, reason: `${host} 和当前页面 ${pageHost} 不在同一条网址白名单里（允许：${allowedDomains.join("、")}）` }
}

// ---------- 打码 ----------

/** JSON 里字段名是密钥类的，值换成 ••••（嵌套的对象、数组照样看） */
export function maskJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskJson)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, each] of Object.entries(value as Record<string, unknown>))
      out[key] = siteSecretKey(key) && each !== null && each !== undefined && each !== "" ? SITE_SECRET_MASK : maskJson(each)
    return out
  }
  return value
}

const decodeKey = (raw: string) => {
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "))
  } catch {
    return raw
  }
}

/** a=1&password=x 这样的参数串：密钥类参数的值换成 ••••，别的原样留着（不重新编码） */
export function maskParams(query: string): string {
  return query
    .split("&")
    .map((part) => {
      const at = part.indexOf("=")
      if (at < 0) return part
      return siteSecretKey(decodeKey(part.slice(0, at))) && part.length > at + 1 ? `${part.slice(0, at + 1)}${SITE_SECRET_MASK}` : part
    })
    .join("&")
}

/** 网址的查询参数打码（路径、片段原样） */
export function maskUrl(url: string): string {
  const q = url.indexOf("?")
  if (q < 0) return url
  const hash = url.indexOf("#", q)
  const query = hash < 0 ? url.slice(q + 1) : url.slice(q + 1, hash)
  return `${url.slice(0, q + 1)}${maskParams(query)}${hash < 0 ? "" : url.slice(hash)}`
}

/** 认不出格式的文字（HTML、半截 JSON）：按 "名字": "值"、名字=值 两种写法打码 */
export function maskText(text: string): string {
  return text
    .replace(/("([A-Za-z0-9_-]{2,40})"\s*:\s*)("(?:[^"\\]|\\.)*"|-?\d[\d.eE+-]*)/g, (all, head: string, key: string) => (siteSecretKey(key) ? `${head}"${SITE_SECRET_MASK}"` : all))
    .replace(/(^|[?&\s])([A-Za-z0-9_-]{2,40})=([^&\s"'<>]+)/g, (all, lead: string, key: string) => (siteSecretKey(key) ? `${lead}${key}=${SITE_SECRET_MASK}` : all))
}

// ---------- browser.fetch 拿到 401、403 时的说法 ----------

/**
 * 401、403 时给 agent 的一句（21.3 第 6 条）：browser.fetch 只带浏览器的 cookie、不能设 Authorization，
 * 网页调这个接口时用的是认证头不带 cookie（记接口里看得到）、返回头要 Bearer 这类认证时，不是登录过期，是这个接口要别的认证；
 * 请求没带 cookie（这个网址没有 cookie）时两种都可能（还没登录，或者要 token），都说；带了 cookie 的才说多半登录过期了
 */
export function fetchAuthHint(input: { authenticate?: string | undefined; cookies: number; tokenApi: boolean }): string {
  const other = "这个接口要别的认证（例如 token），browser.fetch 调不了（它只带浏览器的 cookie，不能设 Authorization），照页面点或建 HTTP 工具（密钥存在平台里）"
  if (input.tokenApi) return `${other}：网页调这个接口时带的是认证头、没带 cookie。`
  if (input.authenticate) return `${other}：接口的返回头要 ${input.authenticate} 认证。`
  if (input.cookies === 0) return `这次请求没带 cookie（这个网址没有 cookie）：要么还没登录（先用 browser.navigate 打开网站的页面看看要不要登录），要么${other}。`
  return "多半登录过期了，先用 browser.navigate 打开网站的页面看看要不要登录。"
}

// ---------- 请求头打码（Playwright MCP 的 browser_network_requests / browser_network_request 的输出） ----------

/**
 * 值要打码的请求头、返回头名字。和 SITE_SECRET_KEYS（只认整个字段名）不一样，这里按名字里带不带这些词认、宁多勿少：
 * - 请求头的名字五花八门（x-auth-token、x-goog-api-key、x-amz-security-token、x-session-id……），只认整个名字会漏；
 * - 字段名只认整个名字，是因为 nextPageToken 这类翻页要用；请求头的值 agent 用不上（browser.fetch 不许设
 *   Cookie、Authorization，登录态由浏览器自己带；要 token 的接口建 HTTP 工具，密钥存在平台里），多打了也不碍事；
 * - 和记接口（network-log.ts 的 authHeader）一样不记值，只是这里连 csrf、cookie、set-cookie 都打（记接口那边干脆不记这几个头）。
 * HTTP/2 的伪头（:authority 是主机名）不算
 */
const SECRET_HEADER_EXACT = new Set(["authorization", "proxy-authorization", "cookie", "cookie2", "set-cookie", "set-cookie2"])
const SECRET_HEADER_WORD = /token|secret|key|auth|cookie|session|passw|credential|csrf|xsrf|signature/
export function secretHeaderName(name: string): boolean {
  const lower = name.trim().toLowerCase()
  if (!lower || lower.startsWith(":")) return false
  return SECRET_HEADER_EXACT.has(lower) || SECRET_HEADER_WORD.test(lower)
}

/** 一行「名字: 值」（前面可以有缩进；HTTP/2 伪头带冒号开头） */
const HEADER_LINE = /^(\s*)(:?[A-Za-z0-9!#$%&'*+.^_`|~-]+):(\s*)(.*)$/
/** Playwright 输出里的段落标题、markdown 标题、代码块边界：不是上一个头的续行 */
const NOT_CONTINUATION = /^\s*$|^\s*(#|```)|^\s*(General|Request headers|Response headers|Request|Response)\s*$/

/**
 * 看网页请求的工具（MCP 的 browser_network_requests / browser_network_request）给模型的输出打码：
 * - 「名字: 值」的行，名字是 secretHeaderName 的，值换成 ••••，只留名字；
 *   多个 Set-Cookie 被 Playwright 用换行连成一个值，后面的续行（不是「名字: 值」、不是空行和段落标题）一并去掉；
 * - 别的行（网址、请求体、返回体）按 maskText：查询参数、"名字": "值"、名字=值 按 SITE_SECRET_KEYS 打码。
 * 这样 token、cookie 的原文不进模型上下文、过程记录和固化员的材料（docs/dev/solidify.md 21.3 第 4 条）
 */
export function maskNetworkOutput(output: string): string {
  const out: string[] = []
  let inSecret = false
  for (const line of output.split("\n")) {
    const header = HEADER_LINE.exec(line)
    if (header && !/^https?$/i.test(header[2]!)) {
      inSecret = secretHeaderName(header[2]!) && header[4] !== ""
      out.push(inSecret ? `${header[1]}${header[2]}:${header[3] || " "}${SITE_SECRET_MASK}` : maskText(line))
      continue
    }
    if (inSecret && !NOT_CONTINUATION.test(line)) continue
    inSecret = false
    out.push(maskText(line))
  }
  return out.join("\n")
}

/** 请求体、返回体打码：JSON 按键；表单参数按名字；别的按文字 */
export function maskBody(body: string, contentType = ""): { text: string; json?: unknown } {
  const trimmed = body.trim()
  if (/json/i.test(contentType) || /^[[{]/.test(trimmed)) {
    try {
      const json = maskJson(JSON.parse(trimmed))
      return { text: JSON.stringify(json), json }
    } catch {
      // 不是完整的 JSON：按文字
    }
  }
  if (/x-www-form-urlencoded/i.test(contentType) || /^[\w.%[\]-]+=[^\s]*(&[\w.%[\]-]+=[^\s]*)*$/.test(trimmed)) return { text: maskParams(body) }
  return { text: maskText(body) }
}

/** 按 UTF-8 字节截开头 max 字节（不截断半个字）：返回截下的和后面没要的字节数 */
export function clipBytes(text: string, max: number): { text: string; omitted: number } {
  const bytes = Buffer.byteLength(text)
  if (bytes <= max) return { text, omitted: 0 }
  let cut = Buffer.from(text).subarray(0, max).toString("utf8")
  // 最后一个字被截成两半时 toString 会留一个替换符：去掉
  if (cut.endsWith("�")) cut = cut.slice(0, -1)
  return { text: cut, omitted: bytes - Buffer.byteLength(cut) }
}

// ---------- shape ----------

export const SHAPE_MAX_DEPTH = 6
export const SHAPE_MAX_KEYS = 40

const keyText = (key: string) => (/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key))

/**
 * 返回 JSON 的字段结构：{ code: number, data: { list: [{ id: number, name: string, … }], total: number } }。
 * 数组只看第一项；最多 SHAPE_MAX_DEPTH 层、每层 SHAPE_MAX_KEYS 个键，多的写 …
 */
export function shapeOf(value: unknown, depth = 0): string {
  if (value === null) return "null"
  if (Array.isArray(value)) {
    if (!value.length) return "[]"
    if (depth >= SHAPE_MAX_DEPTH) return "[…]"
    return `[${shapeOf(value[0], depth + 1)}]`
  }
  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>)
    if (!keys.length) return "{}"
    if (depth >= SHAPE_MAX_DEPTH) return "{ … }"
    const parts = keys.slice(0, SHAPE_MAX_KEYS).map((key) => `${keyText(key)}: ${shapeOf((value as Record<string, unknown>)[key], depth + 1)}`)
    if (keys.length > SHAPE_MAX_KEYS) parts.push("…")
    return `{ ${parts.join(", ")} }`
  }
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return typeof value
  return "unknown"
}

// ---------- 在页面的隔离环境里发请求 ----------

/** 返回是不是文字（JSON、text/*、XML、JS、表单）：不是文字的只给大小 */
export const isTextType = (contentType: string) => !contentType || /json|^text\/|xml|javascript|x-www-form-urlencoded|ecmascript/i.test(contentType)

export interface PageFetchRequest {
  url: string
  method: string
  headers: Record<string, string>
  /** 已经序列化好的请求体 */
  body?: string
  csrf?: FetchCsrf
}

export type PageFetchResult =
  /** authenticate：返回头 WWW-Authenticate 的方案名（Bearer、Basic……），401 时看是不是要 token */
  | { ok: true; status: number; contentType: string; bytes: number; text?: string; ms: number; authenticate?: string }
  | { ok: false; error: "csrf" | "redirect" | "network" | "timeout" | "too_big"; message: string; ms: number }

/** 隔离环境的名字（和剪贴板的分开） */
const WORLD_NAME = "heyagent-fetch"

/**
 * 在页面里跑的函数（浏览器环境，用字符串免得类型检查要求 DOM 库）。
 * redirect: manual（要跳转算出错，不跟过去）；一边读一边数字节，超过上限就停；按 content-type 的 charset 解码文字。
 * CSRF 的值在这里读、直接填进请求头，不回传
 */
const PAGE_FETCH = `async function (req, timeoutMs, maxBytes) {
  const started = Date.now()
  const done = (value) => Object.assign(value, { ms: Date.now() - started })
  const headers = new Headers(req.headers || {})
  if (req.csrf) {
    let value = null
    if (req.csrf.from === "meta") {
      const el = [...document.querySelectorAll("meta[name]")].find((meta) => meta.getAttribute("name") === req.csrf.name)
      value = el ? el.getAttribute("content") : null
    } else {
      for (const part of document.cookie.split(";")) {
        const at = part.indexOf("=")
        if (at < 0) continue
        if (part.slice(0, at).trim() === req.csrf.name) {
          value = part.slice(at + 1).trim()
          try { value = decodeURIComponent(value) } catch (e) {}
          break
        }
      }
    }
    if (!value) return done({ ok: false, error: "csrf", message: req.csrf.from === "meta" ? "页面里没有 <meta name=\\"" + req.csrf.name + "\\">" : "页面的 cookie 里没有 " + req.csrf.name + "（或者它是 HttpOnly 的，页面读不到）" })
    headers.set(req.csrf.header, value)
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    let res
    try {
      res = await fetch(req.url, { method: req.method, headers, body: req.body === undefined ? undefined : req.body, credentials: "include", redirect: "manual", signal: controller.signal, cache: "no-store" })
    } catch (error) {
      if (controller.signal.aborted) return done({ ok: false, error: "timeout", message: "超时" })
      return done({ ok: false, error: "network", message: String(error && error.message || error) })
    }
    if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) return done({ ok: false, error: "redirect", message: "接口要跳转" })
    const contentType = res.headers.get("content-type") || ""
    const authenticate = (res.headers.get("www-authenticate") || "").trim().split(/[\\s,]/)[0] || undefined
    const chunks = []
    let bytes = 0
    if (res.body) {
      const reader = res.body.getReader()
      for (;;) {
        let part
        try { part = await reader.read() } catch (error) {
          if (controller.signal.aborted) return done({ ok: false, error: "timeout", message: "超时（返回体没读完）" })
          return done({ ok: false, error: "network", message: String(error && error.message || error) })
        }
        if (part.done) break
        bytes += part.value.byteLength
        if (bytes > maxBytes) {
          try { await reader.cancel() } catch (e) {}
          return done({ ok: false, error: "too_big", message: "返回体超过上限" })
        }
        chunks.push(part.value)
      }
    }
    const textual = !contentType || /json|^text\\/|xml|javascript|x-www-form-urlencoded|ecmascript/i.test(contentType)
    if (!textual) return done({ ok: true, status: res.status, contentType, bytes, authenticate })
    const all = new Uint8Array(bytes)
    let at = 0
    for (const chunk of chunks) { all.set(chunk, at); at += chunk.byteLength }
    const charset = (/charset=([^;\\s]+)/i.exec(contentType) || [])[1]
    let decoder
    try { decoder = new TextDecoder(charset ? charset.replace(/["']/g, "") : "utf-8") } catch (e) { decoder = new TextDecoder("utf-8") }
    return done({ ok: true, status: res.status, contentType, bytes, text: decoder.decode(all), authenticate })
  } finally {
    clearTimeout(timer)
  }
}`

/**
 * 在页面主 frame 的隔离环境里发一个请求。页面脚本改了 window.fetch 也不影响（隔离环境有自己的全局对象），
 * 页面也看不到参数和结果；请求的 origin 还是页面的，cookie 照常带
 */
export async function sendInPage(page: Page, request: PageFetchRequest, options: { timeoutMs?: number; maxBytes?: number } = {}): Promise<PageFetchResult> {
  const timeoutMs = options.timeoutMs ?? FETCH_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? FETCH_MAX_BYTES
  const started = Date.now()
  const cdp = await page.context().newCDPSession(page)
  try {
    const tree = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } }
    const world = (await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: WORLD_NAME })) as { executionContextId: number }
    // 页面里的 AbortController 管 30 秒；这边多等 5 秒兜底（页面卡死、callFunctionOn 回不来）
    let timer: ReturnType<typeof setTimeout> | undefined
    const result = (await Promise.race([
      cdp.send("Runtime.callFunctionOn", {
        functionDeclaration: PAGE_FETCH,
        executionContextId: world.executionContextId,
        arguments: [{ value: request }, { value: timeoutMs }, { value: maxBytes }],
        awaitPromise: true,
        returnByValue: true,
      }),
      new Promise<"timeout">((resolve) => (timer = setTimeout(() => resolve("timeout"), timeoutMs + 5000))),
    ]).finally(() => clearTimeout(timer))) as "timeout" | { result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
    if (result === "timeout") return { ok: false, error: "timeout", message: "超时（页面可能卡住了）", ms: Date.now() - started }
    if (result.exceptionDetails)
      return { ok: false, error: "network", message: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "出错了", ms: Date.now() - started }
    return result.result.value as PageFetchResult
  } finally {
    await cdp.detach().catch(() => {})
  }
}
