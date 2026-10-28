// 直接调网站的接口（docs/dev/solidify.md 19.2、19.3、19.11 A4 单元）：不连库、不开 Chrome。
// - fetchTargetAllowed：同源、不同端口、白名单同一条 / 不同条、页面是空白页；
// - fetchHeaderForbidden、输入校验；打码（SITE_SECRET_KEYS 打、nextPageToken 不打）；shape；
// - 记接口：假 CDP 连接发事件，只记 JSON 的 GET、写请求全记、自己发的不记、第三方不记、同一网址 3 次、
//   500 个 / 2 MB 上限和 end 行、seq 接着编（文件读写换成内存里的）。
import { EventEmitter } from "node:events"

import {
  browserFetchInputSchema,
  fetchHeaderForbidden,
  NETWORK_LOG_MAX_REQUESTS,
  networkLogLineSchema,
  SITE_SECRET_MASK,
  type NetworkRequestLine,
} from "@heyagent/shared"
import { beforeEach, describe, expect, it, vi } from "vitest"

const files = new Map<string, Buffer>()
vi.mock("../src/files/service.js", () => ({
  networkLogRow: async (_db: unknown, sessionId: string) => (files.has(sessionId) ? { id: sessionId } : undefined),
  readFileData: async (row: { id: string }) => files.get(row.id) ?? Buffer.alloc(0),
  writeNetworkLog: async (_db: unknown, sessionId: string, _name: string, data: Buffer) => {
    files.set(sessionId, data)
    return { id: sessionId }
  },
}))

const { NetworkLog } = await import("../src/browser/network-log.js")
const { clipBytes, fetchTargetAllowed, maskBody, maskJson, maskUrl, shapeOf } = await import("../src/browser/site-api.js")

const M = SITE_SECRET_MASK

describe("能调哪些网址（fetchTargetAllowed）", () => {
  const page = "https://www.example.com/items?page=1"
  it("没设白名单：只能同源（协议、主机、端口都一样）", () => {
    expect(fetchTargetAllowed("https://www.example.com/api/items?page=2", page, []).ok).toBe(true)
    expect(fetchTargetAllowed("https://www.example.com:8443/api", page, []).ok).toBe(false)
    expect(fetchTargetAllowed("http://www.example.com/api", page, []).ok).toBe(false)
    expect(fetchTargetAllowed("https://api.example.com/api", page, []).ok).toBe(false)
  })
  it("设了白名单：目标和页面落在同一条里", () => {
    expect(fetchTargetAllowed("https://api.example.com/api", page, ["example.com"]).ok).toBe(true)
    expect(fetchTargetAllowed("https://api.example.com/api", page, ["www.example.com"]).ok).toBe(false)
    // 两条白名单各管一个：不在同一条里
    expect(fetchTargetAllowed("https://api.other.com/x", page, ["example.com", "other.com"]).ok).toBe(false)
    expect(fetchTargetAllowed("https://evil.com/x", page, ["example.com"]).ok).toBe(false)
  })
  it("页面是空白页、出错页：先打开网站的页面；目标不是完整网址：不认", () => {
    const blank = fetchTargetAllowed("https://www.example.com/api", "about:blank", [])
    expect(blank).toMatchObject({ ok: false, reason: expect.stringContaining("browser.navigate") })
    expect(fetchTargetAllowed("https://www.example.com/api", "chrome-error://chromewebdata/", []).ok).toBe(false)
    expect(fetchTargetAllowed("/api/items", page, [])).toMatchObject({ ok: false, reason: expect.stringContaining("完整的 http(s) 网址") })
    expect(fetchTargetAllowed("file:///etc/passwd", page, []).ok).toBe(false)
  })
})

describe("输入校验、不许设的请求头", () => {
  it("Cookie、Authorization、Host、Origin、Referer、Proxy-*、Sec-* 不许设；content-type 这类可以", () => {
    for (const name of ["Cookie", "authorization", "Host", "Origin", "Referer", "Content-Length", "Connection", "Proxy-Authorization", "Sec-Fetch-Mode"])
      expect(fetchHeaderForbidden(name), name).toBe(true)
    for (const name of ["content-type", "x-requested-with", "accept", "x-csrf-token"]) expect(fetchHeaderForbidden(name), name).toBe(false)
    expect(browserFetchInputSchema.safeParse({ url: "https://a.com/x", headers: { Authorization: "Bearer x" } }).success).toBe(false)
  })
  it("GET、HEAD 不能带 body；默认 GET、auto", () => {
    expect(browserFetchInputSchema.safeParse({ url: "https://a.com/x", body: { a: 1 } }).success).toBe(false)
    expect(browserFetchInputSchema.safeParse({ url: "https://a.com/x", method: "HEAD", body: "x" }).success).toBe(false)
    expect(browserFetchInputSchema.parse({ url: "https://a.com/x", method: "POST", body: [1, 2] })).toMatchObject({ method: "POST", as: "auto" })
    expect(browserFetchInputSchema.parse({ url: "https://a.com/x" })).toMatchObject({ method: "GET", as: "auto" })
  })
})

describe("打码（按整个字段名）", () => {
  it("JSON 嵌套：password、token、access_token、session-id 打；nextPageToken、tokenCount、pageToken 不打", () => {
    const masked = maskJson({
      user: "张三",
      password: "p1",
      Access_Token: "t1",
      "session-id": 9,
      nextPageToken: "n1",
      data: { list: [{ token: "t2", tokenCount: 3, pageToken: "p2" }], csrf: "c1" },
      empty: { password: "" },
    })
    expect(masked).toEqual({
      user: "张三",
      password: M,
      Access_Token: M,
      "session-id": M,
      nextPageToken: "n1",
      data: { list: [{ token: M, tokenCount: 3, pageToken: "p2" }], csrf: M },
      empty: { password: "" },
    })
  })
  it("查询参数、表单参数：只换值，别的原样（不重新编码）", () => {
    expect(maskUrl("https://a.com/x?page=2&api_key=abc&q=%E4%B8%AD&nextPageToken=zz#top")).toBe(`https://a.com/x?page=2&api_key=${M}&q=%E4%B8%AD&nextPageToken=zz#top`)
    expect(maskBody("user=a&password=b%20c&remember=1", "application/x-www-form-urlencoded").text).toBe(`user=a&password=${M}&remember=1`)
    expect(maskBody('{"name":"一","secret":"s"}', "application/json").text).toBe(`{"name":"一","secret":"${M}"}`)
    // 认不出格式的文字（半截 JSON、HTML）
    expect(maskBody('{"a":1,"token":"x1","b":"…', "text/plain").text).toBe(`{"a":1,"token":"${M}","b":"…`)
  })
  it("按字节截开头，不截断半个字", () => {
    expect(clipBytes("中文字", 4)).toEqual({ text: "中", omitted: 6 })
    expect(clipBytes("abc", 10)).toEqual({ text: "abc", omitted: 0 })
  })
})

describe("shape", () => {
  it("数组只看第一项、嵌套像 TypeScript 的写法", () => {
    expect(shapeOf({ code: 0, data: { list: [{ id: 1, name: "a", tags: [] }], total: 3, next: null }, ok: true })).toBe(
      "{ code: number, data: { list: [{ id: number, name: string, tags: [] }], total: number, next: null }, ok: boolean }"
    )
    expect(shapeOf([])).toBe("[]")
    expect(shapeOf({ "a-b": 1 })).toBe('{ "a-b": number }')
  })
  it("最多 6 层、每层 40 个键", () => {
    const deep = { a: { b: { c: { d: { e: { f: { g: 1 } } } } } } }
    expect(shapeOf(deep)).toBe("{ a: { b: { c: { d: { e: { f: { … } } } } } } }")
    const wide = Object.fromEntries(Array.from({ length: 45 }, (_, k) => [`k${k}`, k]))
    const shape = shapeOf(wide)
    expect(shape).toContain("k39: number")
    expect(shape).not.toContain("k40")
    expect(shape.endsWith(", … }")).toBe(true)
  })
})

/** 假的 CDP 连接：测试发事件；send 回 getResponseBody、getCookies、隔离环境里读 meta */
class FakeSession extends EventEmitter {
  bodies = new Map<string, string>()
  metas: [string, string][] = []
  cookies: { name: string; value: string; httpOnly: boolean }[] = []
  async send(method: string, params: Record<string, unknown> = {}) {
    if (method === "Network.getResponseBody") {
      const body = this.bodies.get(String(params.requestId))
      if (body === undefined) throw new Error("No resource with given identifier found")
      return { body, base64Encoded: false }
    }
    if (method === "Page.createIsolatedWorld") return { executionContextId: 7 }
    if (method === "Runtime.evaluate") return { result: { value: this.metas } }
    if (method === "Network.getCookies") return { cookies: this.cookies }
    if (method === "Network.getRequestPostData") return { postData: "" }
    return {}
  }
}

let nextId = 1
/** 发一个请求：requestWillBeSent → (ExtraInfo) → responseReceived → loadingFinished */
function request(
  session: FakeSession,
  input: { url: string; method?: string; type?: string; headers?: Record<string, string>; postData?: string; status?: number; contentType?: string; body?: string; cookie?: boolean; fail?: string }
) {
  const requestId = `r${nextId++}`
  const now = Date.now() / 1000
  session.emit("Network.requestWillBeSent", {
    requestId,
    type: input.type ?? "Fetch",
    timestamp: 100,
    wallTime: now,
    request: { url: input.url, method: input.method ?? "GET", headers: input.headers ?? {}, ...(input.postData !== undefined ? { postData: input.postData, hasPostData: true } : {}) },
  })
  if (input.cookie) session.emit("Network.requestWillBeSentExtraInfo", { requestId, headers: { Cookie: "sid=x" } })
  if (input.fail) {
    session.emit("Network.loadingFailed", { requestId, timestamp: 100.5, errorText: input.fail })
    return requestId
  }
  if (input.body !== undefined) session.bodies.set(requestId, input.body)
  session.emit("Network.responseReceived", { requestId, response: { status: input.status ?? 200, headers: { "Content-Type": input.contentType ?? "application/json" } } })
  session.emit("Network.loadingFinished", { requestId, timestamp: 100.184 })
  return requestId
}

async function setup(sessionId = `S-${nextId++}`, allowedDomains: string[] = []) {
  const log = new NetworkLog({ db: {} as never, sessionId, allowedDomains })
  await log.load()
  const session = new FakeSession()
  const page = { url: () => "https://shop.example.com/items" }
  await log.attach(session as never, page as never, "frame-1")
  return { log, session, sessionId }
}

const lines = (log: InstanceType<typeof NetworkLog>) =>
  log
    .serialize()
    .split("\n")
    .filter(Boolean)
    .map((line) => networkLogLineSchema.parse(JSON.parse(line)))

describe("记接口（假 CDP 连接）", () => {
  beforeEach(() => files.clear())

  it("只记 JSON 的 GET、写请求全记；自己发的、第三方的、文档和预检不记；打码、shape、认证、CSRF", async () => {
    const { log, session } = await setup()
    session.metas = [["csrf-token", "tok-123"]]
    request(session, { url: "https://shop.example.com/api/items?page=1&token=t9", type: "XHR", headers: { Accept: "application/json", "X-Requested-With": "XMLHttpRequest", "User-Agent": "x", "sec-ch-ua": "y" }, body: '{"code":0,"data":{"list":[{"id":1,"name":"a"}],"total":30},"accessToken":"z"}', cookie: true })
    request(session, { url: "https://shop.example.com/api/page.html", contentType: "text/html", body: "<p>不是 JSON</p>" })
    request(session, { url: "https://shop.example.com/api/plain", contentType: "text/plain", body: '{"ok":true}' })
    request(session, { url: "https://shop.example.com/api/plain2", contentType: "text/plain", body: "not json" })
    request(session, { url: "https://stats.other.com/collect", body: "{}" })
    request(session, { url: "https://shop.example.com/api/items", method: "OPTIONS", body: "{}" })
    request(session, { url: "https://shop.example.com/next", type: "Document", contentType: "text/html", body: "<html>" })
    request(session, { url: "https://shop.example.com/api/session", method: "POST", headers: { "Content-Type": "application/json", "X-CSRF-Token": "tok-123" }, postData: '{"user":"a","password":"p"}', contentType: "text/html", body: "<b>ok</b>", cookie: true })
    request(session, { url: "https://shop.example.com/api/token-only", headers: { Authorization: "Bearer x" }, body: "{}" })
    const unexpect = log.expectOwn("get", "https://shop.example.com/api/items?page=2")
    request(session, { url: "https://shop.example.com/api/items?page=2", body: "{}" })
    unexpect()
    request(session, { url: "https://shop.example.com/api/save", method: "PUT", fail: "net::ERR_CONNECTION_RESET" })
    await log.drain(1000)

    // seq 按记下来（收完返回）的先后编；这里按网址排好再比
    const got = (lines(log) as NetworkRequestLine[]).sort((a, b) => a.url.localeCompare(b.url))
    expect(got.map((line) => line.seq).sort()).toEqual([1, 2, 3, 4, 5])
    expect(got.map((line) => [line.method, line.url])).toEqual([
      ["GET", `https://shop.example.com/api/items?page=1&token=${M}`],
      ["GET", "https://shop.example.com/api/plain"],
      ["PUT", "https://shop.example.com/api/save"],
      ["POST", "https://shop.example.com/api/session"],
      ["GET", "https://shop.example.com/api/token-only"],
    ])
    expect(got[0]).toMatchObject({
      type: "xhr",
      page: "https://shop.example.com/items",
      headers: ["accept", "x-requested-with"],
      auth: { cookie: true, headers: [] },
      status: 200,
      responseType: "application/json",
      shape: "{ code: number, data: { list: [{ id: number, name: string }], total: number }, accessToken: string }",
      responseBody: `{"code":0,"data":{"list":[{"id":1,"name":"a"}],"total":30},"accessToken":"${M}"}`,
      ms: 184,
    })
    expect(got[3]).toMatchObject({
      headers: ["content-type", "x-csrf-token"],
      csrf: { header: "x-csrf-token", from: "meta", name: "csrf-token" },
      requestType: "application/json",
      requestBody: `{"user":"a","password":"${M}"}`,
      responseBody: "<b>ok</b>",
      auth: { cookie: true, headers: [] },
    })
    expect(got[4]!.auth).toEqual({ cookie: false, headers: ["authorization"] })
    expect(got[2]).toMatchObject({ status: 0, error: "net::ERR_CONNECTION_RESET" })
    // token 的值哪儿都没有
    expect(log.serialize()).not.toContain("tok-123")
    expect(log.serialize()).not.toMatch(/"p"|t9|"z"/)
  })

  it("CSRF 从 cookie 来（双提交）：认出 cookie 的名字，HttpOnly 的不算", async () => {
    const { log, session } = await setup()
    session.cookies = [
      { name: "sid", value: "abc", httpOnly: true },
      { name: "XSRF-TOKEN", value: "x%2By", httpOnly: false },
    ]
    request(session, { url: "https://shop.example.com/api/a", method: "DELETE", headers: { "X-XSRF-TOKEN": "x+y" }, body: "" })
    request(session, { url: "https://shop.example.com/api/b", method: "DELETE", headers: { "X-CSRF-Token": "abc" }, body: "" })
    await log.drain(1000)
    const got = lines(log) as NetworkRequestLine[]
    expect(got[0]!.csrf).toEqual({ header: "x-xsrf-token", from: "cookie", name: "XSRF-TOKEN" })
    expect(got[1]!.csrf).toBeUndefined()
  })

  it("设了白名单：和页面落在同一条里的子域名也记", async () => {
    const { log, session } = await setup(undefined, ["example.com"])
    request(session, { url: "https://api.example.com/v1/items", body: "[]" })
    request(session, { url: "https://other.com/v1/items", body: "[]" })
    await log.drain(1000)
    expect(lines(log).map((line) => ("url" in line ? line.url : ""))).toEqual(["https://api.example.com/v1/items"])
  })

  it("同一个方法 + 网址最多记 3 次；请求体、返回体截到上限", async () => {
    const { log, session } = await setup()
    for (let k = 0; k < 5; k++) request(session, { url: "https://shop.example.com/api/poll", body: "{}" })
    request(session, { url: "https://shop.example.com/api/big", method: "POST", postData: "x".repeat(5000), contentType: "text/plain", body: JSON.stringify({ a: "y".repeat(30_000) }) })
    await log.drain(1000)
    const got = lines(log) as NetworkRequestLine[]
    expect(got.filter((line) => line.url.endsWith("/poll"))).toHaveLength(3)
    const big = got.at(-1)!
    expect(big.requestBody).toHaveLength(2048)
    expect(big.requestOmitted).toBe(5000 - 2048)
    expect(Buffer.byteLength(big.responseBody!)).toBe(20 * 1024)
    expect(big.responseOmitted).toBeGreaterThan(0)
  })

  it("500 个的上限：最后写 end 行，之后不再记，数着跳过了几个", async () => {
    const { log } = await setup()
    const base = { at: new Date().toISOString(), type: "fetch" as const, method: "GET", headers: [], auth: { cookie: false, headers: [] }, status: 200 }
    for (let k = 0; k < NETWORK_LOG_MAX_REQUESTS + 3; k++) log.push({ ...base, url: `https://shop.example.com/api/items?page=${k}` })
    const got = lines(log)
    expect(got).toHaveLength(NETWORK_LOG_MAX_REQUESTS + 1)
    expect(got.at(-1)).toEqual({ end: true, skipped: 3, reason: `一次运行最多记 ${NETWORK_LOG_MAX_REQUESTS} 个请求` })
  })

  it("2 MB 的上限：写 end 行", async () => {
    const { log } = await setup()
    const base = { at: new Date().toISOString(), type: "fetch" as const, method: "GET", headers: [], auth: { cookie: false, headers: [] }, status: 200, responseBody: "z".repeat(20_000) }
    for (let k = 0; k < 120; k++) log.push({ ...base, url: `https://shop.example.com/api/items?page=${k}` })
    const text = log.serialize()
    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(2 * 1024 * 1024)
    expect(lines(log).at(-1)).toMatchObject({ end: true, reason: "文件到了 2 MB 上限" })
  })

  it("写文件、进程重启以后接着记：seq 接着编，同一网址的次数接着数，到过上限的不再记", async () => {
    const first = await setup("S-resume")
    request(first.session, { url: "https://shop.example.com/api/items?page=1", body: "{}" })
    request(first.session, { url: "https://shop.example.com/api/items?page=1", body: "{}" })
    request(first.session, { url: "https://shop.example.com/api/items?page=2", body: "{}" })
    await first.log.drain(1000)
    await first.log.flush()
    expect(files.get("S-resume")!.toString().trim().split("\n")).toHaveLength(3)

    const again = await setup("S-resume")
    expect(again.log.seq).toBe(3)
    expect(again.log.loadedSeq).toBe(3)
    request(again.session, { url: "https://shop.example.com/api/items?page=1", body: "{}" })
    request(again.session, { url: "https://shop.example.com/api/items?page=1", body: "{}" })
    request(again.session, { url: "https://shop.example.com/api/items?page=3", body: "{}" })
    await again.log.drain(1000)
    await again.log.flush()
    const got = (lines(again.log) as NetworkRequestLine[]).map((line) => [line.seq, line.url.split("page=")[1]])
    expect(got).toEqual([
      [1, "1"],
      [2, "1"],
      [3, "2"],
      [4, "1"],
      [5, "3"],
    ])
  })
})
