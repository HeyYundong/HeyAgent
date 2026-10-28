// 真浏览器 + 假模型：直接调网站的接口（docs/dev/solidify.md 19.11 A4 的浏览器测试）。
// 本地站点（按 Host 分）：
// - localhost:<端口>：/items 页面给登录 cookie（HttpOnly）、带 CSRF 的 meta；页面自己用 XHR 读第 1 页、POST 带密码的 JSON、
//   发一个第三方统计请求；页面把 window.fetch 和 XHR 换成会上报的版本（看工具发的请求页面看不看得到）；
//   /api/items?page=n 分页 JSON（30 页，要 cookie）；POST /api/items 要 CSRF；/api/old 302 到登录页；
// - api.localhost:<端口>：/v1/ping（CORS 允许 localhost），Chrome 把 *.localhost 解析到本机；
// - 127.0.0.1:<端口>：第三方（统计）。
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { networkLogLineSchema, type NetworkLogLine, type NetworkRequestLine } from "@heyagent/shared"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { configureEngine, runtime } from "../src/engine/runtime.js"
import { readFileData } from "../src/files/service.js"
import { setRoutineSandboxDeps } from "../src/routine/runtime/run.js"
import { sandboxUnavailable } from "../src/sandbox/runner.js"
import { call, createTask, eventsOf, finishWith, Script, sessionRow, step, useScript, waitFor, setupEngine, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate } from "../test/helpers.js"
import { createRoutine, directNodeRunner, routineCode } from "../test/routine-helpers.js"
import { createProfile } from "./fixtures.js"

let ctx: EngineTestContext
let wang: string
let profileId: string
let server: Server
let port = 0
let base = ""
const sandboxDir = mkdtempSync(join(tmpdir(), "heyagent-site-api-"))

const CSRF = "tok-SECRET-123"
const PAGES = 30
/** 页面换过的 fetch / XHR 看到的网址（工具在隔离环境里发的不该出现） */
const seen: string[] = []
/** 第三方统计请求、建了的东西 */
let collects = 0
const created: string[] = []

const html = (title: string, head: string, body: string) =>
  `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title>${head}</head><body>${body}</body></html>`

const itemsPage = () =>
  html(
    "商品",
    `<meta name="csrf-token" content="${CSRF}">`,
    `<h1>商品</h1><pre id="list"></pre>
<script>
const origFetch = window.fetch
const origOpen = XMLHttpRequest.prototype.open
const report = (u) => { const img = new Image(); img.src = '/seen?u=' + encodeURIComponent(String(u)) }
window.fetch = function (input) { report(input && input.url || input); return origFetch.apply(this, arguments) }
XMLHttpRequest.prototype.open = function (method, url) { report(url); return origOpen.apply(this, arguments) }
const xhr = new XMLHttpRequest()
origOpen.call(xhr, 'GET', '/api/items?page=1&size=2')
xhr.setRequestHeader('X-Requested-With', 'XMLHttpRequest')
xhr.onload = () => { document.getElementById('list').textContent = xhr.responseText }
xhr.send()
origFetch('/api/session', { method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': document.querySelector('meta[name=csrf-token]').content }, body: JSON.stringify({ user: 'demo', password: 'pw-SECRET-9' }) }).then((res) => res.json())
origFetch('http://127.0.0.1:${port}/collect?e=view', { mode: 'no-cors' })
window.fetch('/api/hello').then((res) => res.json())
// 不读返回体：Chrome 不会报收完，记接口过一会儿照拿到的记下
origFetch('/api/unread')
</script>`
  )

const readBody = (req: IncomingMessage) =>
  new Promise<string>((resolve) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => resolve(body))
  })

beforeAll(async () => {
  ctx = await setupEngine()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  profileId = await createProfile(ctx.db, ctx.keyring)
  const res = await mutate(ctx.app, "settings.updateBrowser", await login(ctx.app, "linzhou@heyagent.local"), {
    maxPerWorker: 4,
    visionCheck: false,
    visionModel: "openrouter/qwen/qwen3.8-flash",
    captchaSolve: false,
    humanHoldMinutes: 30,
  })
  if (res.error) throw new Error(JSON.stringify(res.error))
  configureEngine({ sandbox: { ...runtime.sandbox, dir: sandboxDir } })
  const unavailable = await sandboxUnavailable(runtime.sandbox)
  if (unavailable) setRoutineSandboxDeps({ runner: directNodeRunner, unavailable: async () => undefined })
  console.log(`[site-api] 跑脚本用：${unavailable ? `直接跑 node（${unavailable}）` : "bwrap 沙箱"}`)

  server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://x")
      const host = (req.headers.host ?? "").replace(/:\d+$/, "")
      const json = (status: number, value: unknown, headers: Record<string, string> = {}) =>
        res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers }).end(JSON.stringify(value))
      if (host === "127.0.0.1") {
        if (url.pathname === "/collect") collects++
        return res.writeHead(204).end()
      }
      if (host === "api.localhost") {
        if (url.pathname === "/v1/ping")
          return json(200, { pong: true }, { "access-control-allow-origin": `http://localhost:${port}`, "access-control-allow-credentials": "true" })
        return res.writeHead(404).end()
      }
      const loggedIn = /(?:^|;\s*)sid=s1(?:;|$)/.test(req.headers.cookie ?? "")
      if (url.pathname === "/seen") {
        seen.push(url.searchParams.get("u") ?? "")
        return res.writeHead(204).end()
      }
      if (url.pathname === "/items")
        return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "set-cookie": "sid=s1; Path=/; HttpOnly; SameSite=Lax" }).end(itemsPage())
      if (url.pathname === "/login") return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html("登录", "", `<input type="password" aria-label="密码">`))
      if (url.pathname === "/api/old") return res.writeHead(302, { location: "/login" }).end()
      if (url.pathname === "/api/hello") return json(200, { hello: "world" })
      if (url.pathname === "/api/unread") return json(200, { unread: true })
      if (url.pathname === "/api/session" && req.method === "POST") {
        await readBody(req)
        return json(200, { ok: true, token: "t-RESP-77", nextPageToken: "np-1" })
      }
      if (url.pathname === "/api/items" && req.method === "GET") {
        if (!loggedIn) return json(401, { code: 401, message: "要登录" })
        const page = Number(url.searchParams.get("page") ?? "1")
        const size = Number(url.searchParams.get("size") ?? "2")
        const list = page >= 1 && page <= PAGES ? Array.from({ length: size }, (_, k) => ({ id: page * 100 + k, name: `商品-${page}-${k + 1}` })) : []
        return json(200, { code: 0, data: { list, page, total: PAGES * size } })
      }
      if (url.pathname === "/api/items" && req.method === "POST") {
        const body = await readBody(req)
        if (!loggedIn || req.headers["x-csrf-token"] !== CSRF) return json(403, { code: 403, message: "CSRF 不对" })
        const name = (JSON.parse(body) as { name: string }).name
        created.push(name)
        return json(201, { id: created.length, name })
      }
      res.writeHead(404).end()
    })()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
  base = `http://localhost:${port}`
})

afterAll(async () => {
  setRoutineSandboxDeps(undefined)
  await ctx?.stop()
  await new Promise((resolve) => server?.close(resolve))
  await rm(sandboxDir, { recursive: true, force: true })
})

async function fetchTask(modelId: string, allowedDomains: string[] = []) {
  const taskId = await createTask(ctx.db, { modelId, toolIds: ["browser"], ownerId: "u-wang" })
  await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], allowedDomains, allowBrowserFetch: true }).where(eq(t.tasks.id, taskId))
  return taskId
}

async function runNow(taskId: string) {
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  return res.data.sessionId as string
}

async function waitOutcome(sessionId: string, timeout = 110_000) {
  return waitFor(
    async () => {
      const row = await sessionRow(ctx.db, sessionId)
      return row && ["done", "failed"].includes(row.status) && row.outcome ? row : undefined
    },
    { timeout, what: `${sessionId} 结束、结果定了` }
  )
}

async function networkLines(sessionId: string): Promise<NetworkLogLine[]> {
  const [row] = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "network")))
  if (!row) return []
  expect(row.name).toBe("requests.jsonl")
  return (await readFileData(row))
    .toString("utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => networkLogLineSchema.parse(JSON.parse(line)))
}

const toolEvents = async (sessionId: string) => (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "tool" || event.kind === "rule")

describe("agent 用 browser.fetch（真 Chrome）", () => {
  it("navigate 后读 30 页每页对得上；页面看不到工具的请求；CSRF 的 POST 成功且 token 不落地；跳转、跨域、第三方、Authorization 都不行；记下网页自己的接口", async () => {
    seen.length = 0
    collects = 0
    const pages = Array.from({ length: PAGES }, (_, k) => call("browser.fetch", { url: `${base}/api/items?page=${k + 1}&size=2`, headers: { "x-requested-with": "XMLHttpRequest" } }))
    useScript(
      "test/site-api-agent",
      new Script([
        step([call("browser.navigate", { url: `${base}/items` })]),
        step(pages),
        step([
          call("browser.fetch", { url: `${base}/api/items`, method: "POST", body: { name: "新商品" }, csrf: { header: "x-csrf-token", from: "meta", name: "csrf-token" } }),
          call("browser.fetch", { url: `${base}/api/items`, method: "POST", body: { name: "没带 CSRF" } }),
          call("browser.fetch", { url: `${base}/api/old` }),
          call("browser.fetch", { url: `http://api.localhost:${port}/v1/ping` }),
          call("browser.fetch", { url: `http://127.0.0.1:${port}/collect` }),
          call("browser.fetch", { url: `${base}/api/items?page=1`, headers: { Authorization: "Bearer x" } }),
          call("browser.fetch", { url: "/api/items?page=1" }),
          call("browser.fetch", { url: `${base}/api/items`, csrf: { header: "x-csrf-token", from: "meta", name: "no-such-meta" } }),
        ]),
        step(finishWith("读完了")),
      ])
    )
    const sessionId = await runNow(await fetchTask("test/site-api-agent"))
    await waitOutcome(sessionId)
    const events = await toolEvents(sessionId)
    const fetches = events.filter((event) => event.toolId === "browser.fetch")
    const why = JSON.stringify(events.map((event) => [event.toolId, event.title, event.ms, event.output?.slice(0, 200)]))
    expect(fetches, why).toHaveLength(PAGES + 8)

    // 30 页：第一行是固定格式，返回体里有这一页的商品
    for (let page = 1; page <= PAGES; page++) {
      const event = fetches[page - 1]!
      expect(event.output, `第 ${page} 页`).toMatch(new RegExp(`^GET ${base}/api/items\\?page=${page}&size=2 → 200 application/json; charset=utf-8（[\\d.]+ (B|KB)，\\d+ 毫秒）`))
      expect(event.output).toContain(`"name": "商品-${page}-1"`)
      expect(event.output).toContain(`"name": "商品-${page}-2"`)
      expect(event.trace).toMatchObject({ urlBefore: `${base}/items` })
      expect(event.trace?.code).toBeUndefined()
    }
    const [post, noCsrf, redirect, cors, third, auth, relative, noMeta] = fetches.slice(PAGES)
    expect(post!.output).toContain("→ 201")
    expect(created).toContain("新商品")
    expect(noCsrf!.output).toContain("→ 403")
    expect(noCsrf!.title).not.toContain("出错")
    expect(redirect!.output).toContain("接口要跳转（多半登录过期了）：先用 browser.navigate 打开网站的页面看看")
    expect(redirect!.title).toContain("出错")
    expect(cors!.output).toContain("只能调和当前页面同源的接口")
    expect(third!.output).toContain("只能调和当前页面同源的接口")
    expect(collects).toBe(1)
    // 参数校验没过：网关拦下（rule 记录，原因在 detail）
    expect(`${auth!.output ?? ""}${auth!.detail ?? ""}`).toContain("不能自己设 Cookie、Authorization")
    expect(relative!.output).toContain("完整的 http(s) 网址")
    expect(noMeta!.output).toContain("CSRF 读不到")
    // CSRF 的值不进过程记录
    for (const event of events) expect(JSON.stringify(event)).not.toContain(CSRF)

    // 页面换过的 fetch / XHR 只看到页面自己调的那一个
    await waitFor(async () => seen.length > 0, { what: "页面上报" })
    expect(seen).toEqual(["/api/hello"])

    // network/requests.jsonl：记了页面自己的接口，密码、token 打了码，统计请求和工具自己发的没记，CSRF 认出来了
    const lines = await networkLines(sessionId)
    const requests = lines.filter((line): line is NetworkRequestLine => "seq" in line)
    expect(requests.map((line) => `${line.method} ${line.url.replace(base, "")}`).sort()).toEqual(["GET /api/hello", "GET /api/items?page=1&size=2", "GET /api/unread", "POST /api/session"])
    // 网页没读返回体的：照拿到的记（状态码、类型），可能没有返回体
    expect(requests.find((line) => line.url.endsWith("/api/unread"))).toMatchObject({ status: 200, responseType: "application/json; charset=utf-8" })
    const raw = JSON.stringify(lines)
    expect(raw).not.toContain(CSRF)
    expect(raw).not.toContain("pw-SECRET-9")
    expect(raw).not.toContain("t-RESP-77")
    expect(raw).toContain("np-1")
    const list = requests.find((line) => line.url.includes("/api/items"))!
    expect(list).toMatchObject({ type: "xhr", status: 200, headers: ["x-requested-with"], auth: { cookie: true, headers: [] }, page: `${base}/items` })
    expect(list.shape).toBe("{ code: number, data: { list: [{ id: number, name: string }], page: number, total: number } }")
    const session = requests.find((line) => line.url.endsWith("/api/session"))!
    expect(session).toMatchObject({ type: "fetch", csrf: { header: "x-csrf-token", from: "meta", name: "csrf-token" }, requestBody: '{"user":"demo","password":"••••"}' })
    // 过程记录的 trace.network 对得上：页面自己的请求是打开页面那一步发的
    const navigate = events.find((event) => event.toolId === "browser.navigate")!
    expect(navigate.trace?.network, JSON.stringify(navigate.trace)).toBeDefined()
    for (const line of requests.filter((each) => !each.url.endsWith("/api/unread"))) {
      expect(line.seq).toBeGreaterThanOrEqual(navigate.trace!.network!.first)
      expect(line.seq).toBeLessThanOrEqual(navigate.trace!.network!.last)
    }
    for (const event of fetches) expect(event.trace?.network).toBeUndefined()
  })

  it("白名单 localhost：从 localhost 调 api.localhost 可以；第三方主机不行", async () => {
    useScript(
      "test/site-api-allow",
      new Script([
        step([call("browser.navigate", { url: `${base}/items` })]),
        step([call("browser.fetch", { url: `http://api.localhost:${port}/v1/ping` }), call("browser.fetch", { url: `http://127.0.0.1:${port}/collect` })]),
        step(finishWith("好了")),
      ])
    )
    const sessionId = await runNow(await fetchTask("test/site-api-allow", ["localhost"]))
    await waitOutcome(sessionId)
    const fetches = (await toolEvents(sessionId)).filter((event) => event.toolId === "browser.fetch")
    expect(fetches[0]!.output, fetches[0]!.output ?? "").toContain("→ 200")
    expect(fetches[0]!.output).toContain('"pong": true')
    expect(fetches[1]!.output).toContain("不在本任务的网址白名单里")
  })
})

describe("固化脚本用 ha.browser.fetch（真 Chrome）", () => {
  it("读 30 页跑通：执行模型一次都没调", { timeout: 330_000 }, async () => {
    const script = useScript("test/site-api-routine", new Script([]))
    const taskId = await fetchTask("test/site-api-routine")
    await createRoutine(ctx.db, taskId, {
      name: "读全部商品",
      code: routineCode(`
  await ha.browser.navigate({ url: ${JSON.stringify(`${base}/items`)} })
  const names = []
  for (let page = 1; page <= ${PAGES}; page++) {
    const got = await ha.browser.fetch({ url: ${JSON.stringify(`${base}/api/items?size=2&page=`)} + page, headers: { "x-requested-with": "XMLHttpRequest" } })
    if (!got.ok) return ha.fail("page", "第 " + page + " 页：" + got.status)
    names.push(...got.json.data.list.map((item) => item.name))
  }
  return ha.finish({ outcome: "achieved", summary: "读到 " + names.length + " 个", evidence: names[0] + " … " + names[names.length - 1] })`),
    })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId, 300_000).catch(async (error: unknown) => {
      const events = await eventsOf(ctx.db, sessionId)
      console.log(`[site-api] 脚本的过程：${JSON.stringify(events.map((event) => [event.toolId, event.title, event.ms, event.output?.slice(0, 150)])).slice(0, 6000)}`)
      throw error
    })
    const why = JSON.stringify(row.routine)
    expect(script.prompts, why).toHaveLength(0)
    expect(row.outcome, why).toBe("achieved")
    expect(row.routine).toMatchObject({ state: "finished", steps: PAGES + 2 })
    const finish = (await eventsOf(ctx.db, sessionId)).find((event) => event.toolId === "run.finish")
    expect(finish?.input).toContain(`读到 ${PAGES * 2} 个`)
    expect(finish?.input).toContain(`商品-${PAGES}-2`)
    console.log(`[site-api] 脚本读 ${PAGES} 页用了 ${row.routine?.ms} 毫秒`)
  })

  it("POST 前没有 ha.commit：不发、脚本停下交给 agent", async () => {
    const script = useScript("test/site-api-nocommit", new Script([step(finishWith("没建，交回来了", "not_achieved", "脚本停下了"))]))
    const taskId = await fetchTask("test/site-api-nocommit")
    await createRoutine(ctx.db, taskId, {
      name: "建商品",
      code: routineCode(`
  await ha.browser.navigate({ url: ${JSON.stringify(`${base}/items`)} })
  try {
    await ha.browser.fetch({ url: ${JSON.stringify(`${base}/api/items`)}, method: "POST", body: { name: "不该建" }, csrf: { header: "x-csrf-token", from: "meta", name: "csrf-token" } })
  } catch (error) {
    await ha.log("接住了：" + error.name)
  }
  return ha.finish({ outcome: "achieved", summary: "建好了", evidence: "-" })`),
    })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row.routine).toMatchObject({ state: "fell_back", steps: 1, stoppedAt: { step: 2, kind: "script_error", tool: "browser.fetch" } })
    expect(row.routine?.stoppedAt?.reason).toContain("会改东西的接口请求前面要有自己的 ha.commit，没做")
    expect(created).not.toContain("不该建")
    expect(script.promptText(0)).toContain("会改东西的接口请求前面要有自己的 ha.commit")
  })
})
