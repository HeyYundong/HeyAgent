// 直接调网站的接口（docs/dev/solidify.md 第 19 节）：任务打开「允许直接调网站接口」后，
// - 运行时记下网页自己发的 XHR / fetch 请求，存成这次运行的文件 network/requests.jsonl（只读目录），给固化员看；
// - agent 和固化脚本多一个工具 browser.fetch：在当前页面里带着浏览器的登录态调网站的接口。
// 这里是前后端共用的约定：工具 id、上限、输入和给脚本的结果、jsonl 每一行的格式、打码的字段名。
// 平台通用：只有通用的概念（接口、请求、登录态），不出现任何具体网站。
import { z } from "zod"

/** 工具 id（属于「浏览器」这一组，任务打开 allowBrowserFetch 才有） */
export const BROWSER_FETCH_TOOL = "browser.fetch"

// ---------- browser.fetch ----------

/** 只读的方法：不用 ha.commit；别的方法算「会改东西」 */
export const FETCH_READ_METHODS = ["GET", "HEAD"] as const
export const fetchMethodSchema = z.enum(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"])
export type FetchMethod = z.infer<typeof fetchMethodSchema>
export const isWriteMethod = (method: string | undefined) => !(FETCH_READ_METHODS as readonly string[]).includes((method ?? "GET").toUpperCase())

/** 一次请求最多等多久、返回体最多读多少（超过就停，算出错） */
export const FETCH_TIMEOUT_MS = 30_000
export const FETCH_MAX_BYTES = 5 * 1024 * 1024
/**
 * 给模型的输出里，返回体（JSON 排好版、文本）最多放多少字。网关照常只给模型开头 toolOutputMaxChars（8000）字，
 * 多的存成「工具输出全文」（tool-outputs/）；再多的这里就截掉，写明一共多少字节
 */
export const FETCH_OUTPUT_MAX_CHARS = 200_000

/**
 * 不许脚本、agent 自己设的请求头（小写）：登录态只能是浏览器自己带的 cookie；Proxy-* 和 Sec-* 也不行。
 * 浏览器本来就不让页面设的（Origin、Referer、Content-Length……）设了也没用，工具直接报错，免得以为设上了
 */
export const FETCH_FORBIDDEN_HEADERS = ["cookie", "cookie2", "authorization", "host", "origin", "referer", "content-length", "connection"] as const
export const FETCH_FORBIDDEN_HEADER_PREFIXES = ["proxy-", "sec-"] as const
export function fetchHeaderForbidden(name: string): boolean {
  const lower = name.trim().toLowerCase()
  return (FETCH_FORBIDDEN_HEADERS as readonly string[]).includes(lower) || FETCH_FORBIDDEN_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix))
}

/**
 * CSRF：工具在页面里读出 token 填进请求头，token 的值不经过模型、脚本，也不进过程记录。
 * from = meta：<meta name="名字" content="…">；from = cookie：不是 HttpOnly 的 cookie（名字）
 */
export const fetchCsrfSchema = z.object({
  header: z.string().trim().min(1).max(100),
  from: z.enum(["meta", "cookie"]),
  name: z.string().trim().min(1).max(200),
})
export type FetchCsrf = z.infer<typeof fetchCsrfSchema>

/**
 * browser.fetch 的输入。url 必须是完整的 http(s) 网址（规则、白名单看得到真正的目标）；
 * body：字符串原样发；对象按 JSON 发（没写 content-type 时补 application/json）。GET、HEAD 不能带 body。
 * as：怎么读返回体，auto = content-type 带 json 的按 JSON 解析，别的按文本
 */
export const browserFetchInputSchema = z
  .object({
    url: z.string().trim().min(1).max(4000),
    method: fetchMethodSchema.default("GET"),
    headers: z.record(z.string().min(1).max(100), z.string().max(4000)).optional(),
    body: z.union([z.string().max(FETCH_MAX_BYTES), z.record(z.string(), z.unknown()), z.array(z.unknown())]).optional(),
    as: z.enum(["auto", "json", "text"]).default("auto"),
    csrf: fetchCsrfSchema.optional(),
  })
  .refine((value) => value.body === undefined || isWriteMethod(value.method), { message: "GET、HEAD 不能带 body", path: ["body"] })
  .refine((value) => !Object.keys(value.headers ?? {}).some(fetchHeaderForbidden), {
    message: "不能自己设 Cookie、Authorization、Host、Origin、Referer、Proxy-*、Sec-* 这类请求头：登录态由浏览器自己带",
    path: ["headers"],
  })
export type BrowserFetchInput = z.infer<typeof browserFetchInputSchema>

/**
 * 给脚本的结果（ToolOutcome.data，SDK 的 ha.browser.fetch 返回它）。
 * 4xx、5xx 不算出错（脚本按 status 走不同的路）；连不上、超时、跨域被拦、接口要跳转（多半登录过期）、返回体太大才算出错（StepError）。
 * 返回体按 SITE_SECRET_KEYS 打码
 */
export const browserFetchDataSchema = z.object({
  status: z.number().int(),
  /** 2xx */
  ok: z.boolean(),
  contentType: z.string(),
  /** 返回体的字节数 */
  bytes: z.number().int().min(0),
  /** 按 JSON 解析出来的（as = json，或 auto 且是 JSON） */
  json: z.unknown().optional(),
  /** 文本（不是 JSON 的文字）；不是文字的（图片、文件）两样都没有，只有 bytes */
  text: z.string().optional(),
})
export type BrowserFetchData = z.infer<typeof browserFetchDataSchema>

// ---------- 打码 ----------

/**
 * 记接口、给模型的输出、给脚本的 data：字段名（JSON 的键、查询参数、表单参数）去掉 _ - 后、不分大小写，
 * 正好是下面这些的，值换成 ••••。只认整个名字：nextPageToken、tokenCount 这类不打码（翻页要用）。
 * 请求头的值一律不记（只记名字）
 */
export const SITE_SECRET_KEYS = [
  "password",
  "passwd",
  "pwd",
  "secret",
  "clientsecret",
  "token",
  "accesstoken",
  "refreshtoken",
  "idtoken",
  "authtoken",
  "apikey",
  "accesskey",
  "secretkey",
  "privatekey",
  "authorization",
  "cookie",
  "sessionid",
  "sid",
  "csrftoken",
  "xsrftoken",
  "csrf",
] as const
export const SITE_SECRET_MASK = "••••"
export function siteSecretKey(name: string): boolean {
  return (SITE_SECRET_KEYS as readonly string[]).includes(name.replace(/[_-]/g, "").toLowerCase())
}

// ---------- 记接口：network/requests.jsonl ----------

/** 这次运行空间里的只读目录和文件名（files.kind = network） */
export const NETWORK_SPACE_DIR = "network"
export const NETWORK_LOG_NAME = "requests.jsonl"
export const NETWORK_LOG_PATH = `${NETWORK_SPACE_DIR}/${NETWORK_LOG_NAME}`

/** 上限：一次运行最多记几个请求、文件最大多少；同一个方法 + 网址（含参数）最多记几次（轮询的接口别把名额占满） */
export const NETWORK_LOG_MAX_REQUESTS = 500
export const NETWORK_LOG_MAX_BYTES = 2 * 1024 * 1024
export const NETWORK_LOG_SAME_URL_MAX = 3
/** 请求体、返回体各记开头多少字节 */
export const NETWORK_REQUEST_BODY_BYTES = 2 * 1024
export const NETWORK_RESPONSE_BODY_BYTES = 20 * 1024

/**
 * 一个请求一行。只记：XHR / fetch；目标按 browser.fetch 同一条规矩能调的（同源，或和页面落在同一条白名单里）；
 * GET、HEAD 只记返回 JSON 的（content-type 带 json，或 text/plain 但解析得了），别的方法全记（会改东西的请求，固化员最要看）。
 * browser.fetch 自己发的不记（过程记录里有）。
 */
export const networkRequestLineSchema = z.object({
  /** 这次运行里的第几个（从 1 开始，网页发出时编；最后没记下的请求号码空着）；过程记录的 trace.network 按它对上 */
  seq: z.number().int().positive(),
  /** 发出的时间（ISO，带毫秒） */
  at: z.string(),
  type: z.enum(["xhr", "fetch"]),
  method: z.string(),
  /** 完整网址，查询参数按 SITE_SECRET_KEYS 打码 */
  url: z.string(),
  /** 发请求时页面的网址（打码同上） */
  page: z.string().optional(),
  /** 网页设的请求头的名字（小写、排好序），值不记 */
  headers: z.array(z.string()),
  /**
   * 认证方式：带没带 cookie；像认证的请求头名字（authorization、x-api-key、x-auth-token……，csrf 的不算）；
   * schemes：认证头的值的方案名（名字 → 值里第一个空格前的词：Bearer、Basic、Token……），值里没有空格（整个就是密钥）记 ""，
   * 第一个词不像方案名（不全是字母）的不记。密钥本身不记。以前记的行没有 schemes
   */
  auth: z.object({ cookie: z.boolean(), headers: z.array(z.string()), schemes: z.record(z.string(), z.string()).optional() }),
  /** 请求头里有 csrf 类的（名字含 csrf、xsrf），而且认出了值从哪来（页面的 meta、不是 HttpOnly 的 cookie）：照抄给 browser.fetch 的 csrf */
  csrf: fetchCsrfSchema.optional(),
  /** 请求体的 content-type、开头 NETWORK_REQUEST_BODY_BYTES（打码）、后面没记的字节数 */
  requestType: z.string().optional(),
  requestBody: z.string().optional(),
  requestOmitted: z.number().int().positive().optional(),
  /** 状态码；没拿到返回（连不上、被取消）是 0，原因写在 error */
  status: z.number().int().min(0),
  error: z.string().optional(),
  responseType: z.string().optional(),
  /** 返回体的字节数 */
  bytes: z.number().int().min(0).optional(),
  /**
   * 返回 JSON 的字段结构，像 TypeScript 的写法：{ code: number, data: { list: [{ id: number, name: string, … }], total: number } }。
   * 数组只看第一项；最多 6 层、每层 40 个键，多的写 …
   */
  shape: z.string().optional(),
  /** 返回体开头 NETWORK_RESPONSE_BODY_BYTES（打码）、后面没记的字节数 */
  responseBody: z.string().optional(),
  responseOmitted: z.number().int().positive().optional(),
  /** 从发出到收完的毫秒数 */
  ms: z.number().int().min(0).optional(),
})
export type NetworkRequestLine = z.infer<typeof networkRequestLineSchema>

/** 到了上限以后的最后一行：后面还有几个请求没记、为什么 */
export const networkLogEndLineSchema = z.object({ end: z.literal(true), skipped: z.number().int().min(0), reason: z.string() })
export type NetworkLogEndLine = z.infer<typeof networkLogEndLineSchema>

export const networkLogLineSchema = z.union([networkRequestLineSchema, networkLogEndLineSchema])
export type NetworkLogLine = z.infer<typeof networkLogLineSchema>
