// 记接口（docs/dev/solidify.md 19.3）：任务打开「允许直接调网站接口」时，编排器自己的 CDP 连接对每个页面再开 Network，
// 记下网页自己发的 XHR / fetch 请求，存成这次运行的文件 network/requests.jsonl（只读目录），给固化员看。
// - 只看 XHR、Fetch；目标按 browser.fetch 同一条规矩能调的才记（fetchTargetAllowed），第三方的统计、广告接口自然不记；
// - GET、HEAD 只记返回 JSON 的；别的方法（会改东西的）都记，返回不是 JSON 也记；
// - browser.fetch 自己发的不记（过程记录里有）：工具执行期间方法和网址对得上的那一个跳过；跟着跳转的只记最后一跳；
// - 上限：500 个、2 MB、同一个方法 + 网址 3 次；请求体 2 KB、返回体 20 KB；到了上限写一行 end，之后不再记；
// - 打码按整个字段名；请求头只记名字；cookie、Set-Cookie 不记；
// - seq 在一个请求记下来（收完返回）时编；行先攒在内存里，每次浏览器工具调用结束、网关关闭时有新行就整份覆盖写一次；
//   Chrome 换了、进程重启以后先读已有的文件，seq 接着编。
import {
  isWriteMethod,
  NETWORK_LOG_MAX_BYTES,
  NETWORK_LOG_MAX_REQUESTS,
  NETWORK_LOG_NAME,
  NETWORK_LOG_SAME_URL_MAX,
  NETWORK_REQUEST_BODY_BYTES,
  NETWORK_RESPONSE_BODY_BYTES,
  networkLogLineSchema,
  type FetchCsrf,
  type NetworkLogEndLine,
  type NetworkRequestLine,
} from "@heyagent/shared"
import type { CDPSession, Page } from "playwright-core"

import type { DbLike } from "../engine/records.js"
import { networkLogRow, readFileData, writeNetworkLog } from "../files/service.js"
import { clipBytes, fetchTargetAllowed, maskBody, maskUrl, shapeOf } from "./site-api.js"

/** Network.enable 的缓冲：返回体要在收完以后取（getResponseBody） */
export const NETWORK_BUFFER = { maxResourceBufferSize: 5 * 1024 * 1024, maxTotalBufferSize: 20 * 1024 * 1024 }
/** 发出去超过这么久还没收完的请求，工具调用结束时不再等它 */
const INFLIGHT_STALE_MS = 10_000
/** 拿到返回头以后，工具调用结束时最多再等它收完多久 */
const RESPONDED_WAIT_MS = 300
/**
 * 拿到返回头以后过这么久还没收完：照拿到的记下（网页用 fetch 却不读返回体时，Chrome 不会报收完）。
 * 这时多半取不到返回体，只记状态码、类型
 */
const UNFINISHED_RECORD_MS = 5000
/** 记一个请求时问 Chrome 的每一步最多等多久（页面关了、卡住时别让请求一直算「在路上」） */
const CDP_STEP_MS = 3000
const timed = <T>(promise: Promise<T>): Promise<T | undefined> =>
  Promise.race([promise.catch(() => undefined), new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), CDP_STEP_MS))])

/** end 那一行留的字节 */
const END_RESERVE = 512

/** 浏览器自己加的请求头（不是网页设的）：不记 */
const BROWSER_HEADERS = new Set(["user-agent", "referer", "origin", "accept-language", "accept-encoding", "cookie", "cookie2", "host", "content-length", "connection"])
const browserHeader = (name: string) => BROWSER_HEADERS.has(name) || name.startsWith("sec-") || name.startsWith("proxy-") || name.startsWith(":")
/** 像认证的请求头（csrf、xsrf 的不算） */
export const authHeader = (name: string) => !/csrf|xsrf/.test(name) && (/^(authorization|x-api-key|api-key|apikey)$/.test(name) || /token|auth/.test(name))

interface Sent {
  requestId: string
  type: "xhr" | "fetch"
  method: string
  url: string
  pageUrl: string
  headers: Record<string, string>
  postData?: string
  hasPostData: boolean
  /** 单调时钟（秒）和墙上时间（秒） */
  timestamp: number
  wallTime: number
  status?: number
  responseType?: string
}

interface WillBeSent {
  requestId: string
  type?: string
  timestamp: number
  wallTime: number
  request: { url: string; method: string; headers: Record<string, string>; postData?: string; hasPostData?: boolean }
}

export interface NetworkLogDeps {
  db: DbLike
  sessionId: string
  allowedDomains: readonly string[]
}

const lowerHeaders = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers ?? {}).map(([name, value]) => [name.toLowerCase(), String(value)]))

const normalUrl = (url: string) => {
  try {
    return new URL(url).href
  } catch {
    return url
  }
}

/** 页面里读所有 <meta name> 的值（认 CSRF 从哪来；在隔离环境里读） */
const META_SCRIPT = `[...document.querySelectorAll("meta[name]")].map((meta) => [meta.getAttribute("name"), meta.getAttribute("content") || ""])`

export class NetworkLog {
  private readonly deps: NetworkLogDeps
  /** 已经记下的行（序列化好的，不含 end 行） */
  private readonly lines: string[] = []
  private bytes = 0
  /** 最后一个编了号的 seq */
  seq = 0
  /** 读完已有文件时 seq 走到了哪（这个 Chrome 是在一次工具调用里开的：之后记的都算那一步） */
  loadedSeq = 0
  private ended?: NetworkLogEndLine
  private readonly sameUrl = new Map<string, number>()
  private dirty = false
  private writing: Promise<void> = Promise.resolve()
  /** 正在路上的请求（发出去了、还没记完）：工具调用结束时等一小会儿，让这一步触发的请求算进这一步 */
  private readonly inflight = new Map<string, { url: string; at: number; respondedAt?: number }>()
  /** browser.fetch 自己发的（方法 + 网址）：对上的那一个不记 */
  private readonly own: { method: string; url: string }[] = []
  private loaded = false

  constructor(deps: NetworkLogDeps) {
    this.deps = deps
  }

  /** 接着记：读这次运行已有的文件，seq 接着编、同一网址的次数接着数、到过上限的不再记 */
  async load() {
    if (this.loaded) return
    this.loaded = true
    const row = await networkLogRow(this.deps.db, this.deps.sessionId, NETWORK_LOG_NAME).catch(() => undefined)
    if (!row) return
    const text = (await readFileData(row).catch(() => Buffer.alloc(0))).toString("utf8")
    for (const raw of text.split("\n")) {
      if (!raw.trim()) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        continue
      }
      const line = networkLogLineSchema.safeParse(parsed)
      if (!line.success) continue
      if ("end" in line.data) {
        this.ended = line.data
        continue
      }
      this.lines.push(raw)
      this.bytes += Buffer.byteLength(raw) + 1
      this.seq = Math.max(this.seq, line.data.seq)
      const key = `${line.data.method} ${line.data.url}`
      this.sameUrl.set(key, (this.sameUrl.get(key) ?? 0) + 1)
    }
    this.loadedSeq = this.seq
  }

  /** 记了几行（不含 end） */
  get count() {
    return this.lines.length
  }

  /** 文件现在的内容（一行一个 JSON；到了上限最后一行是 end） */
  serialize(): string {
    const all = this.ended ? [...this.lines, JSON.stringify(this.ended)] : this.lines
    return all.length ? `${all.join("\n")}\n` : ""
  }

  /** browser.fetch 发请求前登记：工具执行期间方法和网址对得上的那一个不记。返回撤销登记的函数 */
  expectOwn(method: string, url: string): () => void {
    const entry = { method: method.toUpperCase(), url: normalUrl(url) }
    this.own.push(entry)
    return () => {
      const at = this.own.indexOf(entry)
      if (at >= 0) this.own.splice(at, 1)
    }
  }

  /** 等路上的请求记完（最多 ms 毫秒）：工具调用结束时调，这一步触发的请求编进这一步的 seq 范围 */
  async drain(ms: number) {
    const deadline = Date.now() + ms
    // 发出去很久还没收完的（长轮询、卡住的）不等；拿到返回头一会儿了还没收完的（网页没读返回体）也不等
    const waiting = () =>
      [...this.inflight.values()].some((each) => Date.now() - each.at < INFLIGHT_STALE_MS && !(each.respondedAt && Date.now() - each.respondedAt > RESPONDED_WAIT_MS))
    while (waiting() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
  }

  /** 有新行就整份覆盖写一次（按顺序写，不会两次写交错） */
  flush(): Promise<void> {
    if (!this.dirty) return this.writing
    this.dirty = false
    const data = Buffer.from(this.serialize(), "utf8")
    this.writing = this.writing
      .then(() => writeNetworkLog(this.deps.db, this.deps.sessionId, NETWORK_LOG_NAME, data))
      .then(
        () => {},
        (error: unknown) => {
          this.dirty = true
          console.warn(`[browser] 记下的网页请求没写上：${(error as Error).message}`)
        }
      )
    return this.writing
  }

  /** 到了上限：之后不再记，end 行写后面还有几个没记 */
  private end(reason: string) {
    this.ended ??= { end: true, skipped: 0, reason }
    this.ended.skipped++
    this.dirty = true
  }

  /** 记一行（编 seq、查上限）。测试也直接用它 */
  push(line: Omit<NetworkRequestLine, "seq">): NetworkRequestLine | undefined {
    if (this.ended) {
      this.ended.skipped++
      this.dirty = true
      return undefined
    }
    const key = `${line.method} ${line.url}`
    const same = this.sameUrl.get(key) ?? 0
    // 轮询的接口别把名额占满：同一个方法 + 网址（含参数）只记前几次
    if (same >= NETWORK_LOG_SAME_URL_MAX) return undefined
    if (this.lines.length >= NETWORK_LOG_MAX_REQUESTS) {
      this.end(`一次运行最多记 ${NETWORK_LOG_MAX_REQUESTS} 个请求`)
      return undefined
    }
    const full: NetworkRequestLine = { seq: this.seq + 1, ...line }
    const text = JSON.stringify(full)
    const size = Buffer.byteLength(text) + 1
    if (this.bytes + size > NETWORK_LOG_MAX_BYTES - END_RESERVE) {
      this.end(`文件到了 ${Math.round(NETWORK_LOG_MAX_BYTES / 1024 / 1024)} MB 上限`)
      return undefined
    }
    this.seq = full.seq
    this.lines.push(text)
    this.bytes += size
    this.sameUrl.set(key, same + 1)
    this.dirty = true
    return full
  }

  /** 页面开 Network、挂上事件（instance.watchPage 调）；mainFrameId 用来在隔离环境里读 meta */
  async attach(session: CDPSession, page: Page, mainFrameId: string) {
    const sent = new Map<string, Sent>()
    /** requestWillBeSentExtraInfo 的头里有没有 cookie（实际发出去的请求带没带） */
    const cookies = new Map<string, boolean>()
    const forget = (id: string) => {
      sent.delete(id)
      cookies.delete(id)
      this.inflight.delete(id)
    }
    session.on("Network.requestWillBeSent", (event) => {
      const e = event as unknown as WillBeSent
      const type = e.type === "XHR" ? "xhr" : e.type === "Fetch" ? "fetch" : undefined
      const method = e.request.method.toUpperCase()
      // 跟着跳转的：同一个 requestId 再来一次，只记最后一跳
      if (sent.has(e.requestId)) forget(e.requestId)
      if (!type || method === "OPTIONS") return
      const own = this.own.findIndex((each) => each.method === method && each.url === normalUrl(e.request.url))
      if (own >= 0) {
        this.own.splice(own, 1)
        return
      }
      const pageUrl = page.url()
      if (!fetchTargetAllowed(e.request.url, pageUrl, this.deps.allowedDomains).ok) return
      if (this.ended && isWriteMethod(method)) {
        // 到了上限：不用再取返回体，只数一个
        this.end(this.ended.reason)
        return
      }
      sent.set(e.requestId, {
        requestId: e.requestId,
        type,
        method,
        url: e.request.url,
        pageUrl,
        headers: lowerHeaders(e.request.headers),
        ...(e.request.postData !== undefined ? { postData: e.request.postData } : {}),
        hasPostData: Boolean(e.request.hasPostData),
        timestamp: e.timestamp,
        wallTime: e.wallTime,
      })
      this.inflight.set(e.requestId, { url: e.request.url, at: Date.now() })
    })
    session.on("Network.requestWillBeSentExtraInfo", (event) => {
      const e = event as { requestId: string; headers?: Record<string, string> }
      cookies.set(e.requestId, Object.keys(e.headers ?? {}).some((name) => name.toLowerCase() === "cookie"))
    })
    session.on("Network.responseReceived", (event) => {
      const e = event as { requestId: string; timestamp?: number; response: { status: number; mimeType?: string; headers?: Record<string, string> } }
      const item = sent.get(e.requestId)
      if (!item) return
      item.status = e.response.status
      item.responseType = lowerHeaders(e.response.headers ?? {})["content-type"] ?? e.response.mimeType ?? ""
      const flight = this.inflight.get(e.requestId)
      if (flight) flight.respondedAt = Date.now()
      const respondedAt = e.timestamp
      setTimeout(() => {
        if (sent.get(e.requestId) !== item) return
        sent.delete(e.requestId)
        const cookie = cookies.get(e.requestId) ?? false
        cookies.delete(e.requestId)
        void this.finish(session, mainFrameId, item, { cookie, endedAt: respondedAt ?? item.timestamp })
          .catch(() => {})
          .finally(() => this.inflight.delete(e.requestId))
      }, UNFINISHED_RECORD_MS).unref?.()
    })
    session.on("Network.loadingFinished", (event) => {
      const e = event as { requestId: string; timestamp: number }
      const item = sent.get(e.requestId)
      if (!item) return
      sent.delete(e.requestId)
      const cookie = cookies.get(e.requestId) ?? false
      cookies.delete(e.requestId)
      void this.finish(session, mainFrameId, item, { cookie, endedAt: e.timestamp })
        .catch((error: unknown) => console.warn(`[browser] 记网页请求出错：${(error as Error).message}`))
        .finally(() => this.inflight.delete(e.requestId))
    })
    session.on("Network.loadingFailed", (event) => {
      const e = event as { requestId: string; timestamp: number; errorText?: string; canceled?: boolean }
      const item = sent.get(e.requestId)
      if (!item) return
      const cookie = cookies.get(e.requestId) ?? false
      sent.delete(e.requestId)
      cookies.delete(e.requestId)
      // 没拿到返回的只读请求不记（多半是取消的轮询）；会改东西的照记，写清原因
      if (!isWriteMethod(item.method)) {
        this.inflight.delete(e.requestId)
        return
      }
      void this.finish(session, mainFrameId, item, { cookie, endedAt: e.timestamp, error: e.canceled ? "被取消了" : e.errorText || "没拿到返回" })
        .catch(() => {})
        .finally(() => this.inflight.delete(e.requestId))
    })
    await session.send("Network.enable", NETWORK_BUFFER)
  }

  /** 一个请求收完了（或出错了）：按规矩决定记不记、取请求体和返回体、打码、认 CSRF，编号记下 */
  private async finish(session: CDPSession, mainFrameId: string, item: Sent, end: { cookie: boolean; endedAt: number; error?: string }) {
    const write = isWriteMethod(item.method)
    const responseType = item.responseType ?? ""
    let body: string | undefined
    let bodyBytes: number | undefined
    let json: unknown
    let isJson = false
    if (!end.error) {
      const wantBody = write || /json/i.test(responseType) || /^text\/plain/i.test(responseType)
      if (!wantBody) return
      const got = (await timed(session.send("Network.getResponseBody", { requestId: item.requestId }))) as { body: string; base64Encoded: boolean } | undefined
      if (got) {
        const buffer = got.base64Encoded ? Buffer.from(got.body, "base64") : Buffer.from(got.body, "utf8")
        bodyBytes = buffer.length
        const textual = !got.base64Encoded || /json|^text\/|xml|javascript/i.test(responseType)
        if (textual) {
          body = buffer.toString("utf8")
          try {
            json = JSON.parse(body)
            isJson = true
          } catch {
            // 不是 JSON
          }
        }
      }
      // 只读的：只记返回 JSON 的（content-type 带 json，或者 text/plain 但解析得了）
      if (!write && !(/json/i.test(responseType) || isJson)) return
    }

    const pageHeaders = Object.keys(item.headers)
      .filter((name) => !browserHeader(name))
      .sort()
    const csrf = await timed(this.findCsrf(session, mainFrameId, item))

    let postData = item.postData
    if (postData === undefined && item.hasPostData)
      postData = ((await timed(session.send("Network.getRequestPostData", { requestId: item.requestId }))) as { postData?: string } | undefined)?.postData
    const requestType = item.headers["content-type"]
    const request = postData !== undefined && postData !== "" ? clipBytes(maskBody(postData, requestType).text, NETWORK_REQUEST_BODY_BYTES) : undefined

    let response: { text: string; omitted: number } | undefined
    if (body !== undefined && body !== "") response = clipBytes(isJson ? JSON.stringify(maskBody(body, "application/json").json) : maskBody(body, responseType).text, NETWORK_RESPONSE_BODY_BYTES)

    this.push({
      at: new Date(item.wallTime * 1000).toISOString(),
      type: item.type,
      method: item.method,
      url: maskUrl(item.url),
      page: maskUrl(item.pageUrl),
      headers: pageHeaders,
      auth: { cookie: end.cookie, headers: pageHeaders.filter(authHeader) },
      ...(csrf ? { csrf } : {}),
      ...(requestType ? { requestType } : {}),
      ...(request ? { requestBody: request.text, ...(request.omitted ? { requestOmitted: request.omitted } : {}) } : {}),
      status: end.error ? 0 : (item.status ?? 0),
      ...(end.error ? { error: end.error } : {}),
      ...(responseType ? { responseType } : {}),
      ...(bodyBytes !== undefined ? { bytes: bodyBytes } : {}),
      ...(isJson ? { shape: shapeOf(json) } : {}),
      ...(response ? { responseBody: response.text, ...(response.omitted ? { responseOmitted: response.omitted } : {}) } : {}),
      ms: Math.max(0, Math.round((end.endedAt - item.timestamp) * 1000)),
    })
  }

  /** 请求头里有 csrf、xsrf 类的：看它的值等于页面里哪个 <meta name> 的 content，或者哪个（不是 HttpOnly 的）cookie 的值。值不记 */
  private async findCsrf(session: CDPSession, mainFrameId: string, item: Sent): Promise<FetchCsrf | undefined> {
    const named = Object.entries(item.headers).filter(([name, value]) => /csrf|xsrf/.test(name) && value)
    if (!named.length) return undefined
    const world = (await session.send("Page.createIsolatedWorld", { frameId: mainFrameId, worldName: "heyagent-network" })) as { executionContextId: number }
    const metas = (((await session.send("Runtime.evaluate", { expression: META_SCRIPT, contextId: world.executionContextId, returnByValue: true })) as { result: { value?: unknown } }).result.value ??
      []) as [string, string][]
    for (const [header, value] of named) {
      const meta = metas.find(([, content]) => content === value)
      if (meta) return { header, from: "meta", name: meta[0] }
    }
    const { cookies } = (await session.send("Network.getCookies", { urls: [item.url] })) as { cookies: { name: string; value: string; httpOnly: boolean }[] }
    const decode = (value: string) => {
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
    for (const [header, value] of named) {
      const cookie = cookies.find((each) => !each.httpOnly && (each.value === value || decode(each.value) === value))
      if (cookie) return { header, from: "cookie", name: cookie.name }
    }
    return undefined
  }
}
