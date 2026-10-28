// 固化员看「网页调过的接口」（docs/dev/solidify.md 19.6、19.7）：材料里的接口一节、提示词的第 19–24 条、
// 程序检查的 allowFetch、HTTP 工具建议的规整和存进版本。真实的测试库；jsonl 和过程记录都是测试自己造的（不等 A4 的运行时）
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { z } from "zod"
import type { NetworkLogLine, NetworkRequestLine } from "@heyagent/shared"

import * as t from "../src/db/schema.js"
import { configureEngine } from "../src/engine/runtime.js"
import { bossFor, QUEUES, stopSenderBoss } from "../src/engine/queue.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { syncBuiltinTools } from "../src/engine/tools/builtin-defs.js"
import { saveFile } from "../src/files/service.js"
import { checkRoutine, FETCH_NOT_ALLOWED } from "../src/routine/checks.js"
import { handleCompileJob, normalizeHttpSuggestions } from "../src/routine/compile.js"
import { apiTemplate, buildMaterial, groupApis, isIdSegment, networkSection, parseNetworkLog, sdkCallOf } from "../src/routine/material.js"
import { compileOutputSchema, compileSystemPrompt, SDK_FALLBACK, SITE_API_RULES, type HttpSuggestionOutput } from "../src/routine/prompt.js"
import { createTask, Script, step, text } from "./engine-helpers.js"
import { login, mutate, query, setupApp, type TestApp } from "./helpers.js"

let ctx: TestApp
let wang: string

const SOLIDIFIER = "test/site-api-solidifier"
const scripts = new Map<string, Script>()
const useModel = (modelId: string, outputs: object[]) => {
  const script = new Script(outputs.map((each) => step([text(JSON.stringify(each))], 0.001)))
  scripts.set(modelId, script)
  return script
}

const DISPATCH = {
  params: [{ name: "关键词", description: "要搜的词", required: true, dedupe: true }],
  results: [{ name: "条数", description: "搜到几条", required: true }],
  maxRunning: 1,
}
const KEYWORD = "蓝色杯子"
const SHOP = "https://shop.example.com"
const T0 = Date.parse("2026-10-28T01:00:00.000Z")
const at = (second: number) => new Date(T0 + second * 1000)

/** 一行请求记录（照 networkRequestLineSchema） */
const req = (seq: number, second: number, patch: Partial<NetworkRequestLine>): NetworkRequestLine => ({
  seq,
  at: at(second).toISOString(),
  type: "fetch",
  method: "GET",
  url: `${SHOP}/api/x`,
  page: `${SHOP}/items`,
  headers: ["accept"],
  auth: { cookie: true, headers: [] },
  status: 200,
  responseType: "application/json",
  bytes: 100,
  ms: 50,
  ...patch,
})

const itemsUrl = (page: number) => `${SHOP}/api/items?size=20&page=${page}&kw=${encodeURIComponent(KEYWORD)}`
const LIST_SHAPE = "{ code: number, data: { list: [{ id: number, name: string, price: number }], total: number } }"

/** 一份记录：资料接口、列表接口（第 1 页记了两次、第 2 页）、轮询（两次调用之间）、带 CSRF 的写请求、token 认证的接口、end 行 */
const LOG: NetworkLogLine[] = [
  req(1, 1, { url: `${SHOP}/api/user/profile`, shape: "{ name: string }", responseBody: '{"name":"王越"}' }),
  req(2, 2, { url: itemsUrl(1), headers: ["accept", "x-requested-with"], shape: LIST_SHAPE, responseBody: '{"code":0,"data":{"list":[{"id":1001,"name":"蓝色杯子 A","price":12}],"total":23}}' }),
  req(3, 11, { url: itemsUrl(1), headers: ["accept", "x-requested-with"], shape: LIST_SHAPE }),
  req(4, 21, { url: itemsUrl(2), headers: ["accept", "x-requested-with"], shape: LIST_SHAPE }),
  req(5, 25, { url: `${SHOP}/api/notice/poll`, shape: "{ unread: number }" }),
  req(6, 31, {
    method: "POST",
    type: "xhr",
    url: `${SHOP}/api/items/1001/stock`,
    headers: ["content-type", "x-csrf-token"],
    csrf: { header: "x-csrf-token", from: "meta", name: "csrf-token" },
    requestType: "application/json",
    requestBody: JSON.stringify({ qty: 5, note: KEYWORD, password: "••••" }),
    status: 403,
    responseBody: '{"msg":"没有权限"}',
  }),
  req(7, 41, {
    url: "https://api.shop.example.com/v1/orders/9f8e7d6c5b4a39281706f5e4d3c2b1a0",
    headers: ["authorization"],
    auth: { cookie: false, headers: ["authorization"], schemes: { authorization: "Bearer" } },
    shape: "{ id: string, status: string }",
  }),
  { end: true, skipped: 12, reason: "同一个网址最多记 3 次" },
]
const jsonl = (lines: NetworkLogLine[]) => lines.map((line) => JSON.stringify(line)).join("\n") + "\n"

beforeAll(async () => {
  ctx = await setupApp()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  configureEngine({
    keyring: ctx.keyring,
    filesDir: mkdtempSync(join(tmpdir(), "heyagent-files-")),
    modelFactory: ({ modelId }) => {
      const script = scripts.get(modelId)
      if (!script) throw new Error(`测试没有给模型 ${modelId} 准备剧本`)
      return script.model
    },
  })
  await syncBuiltinTools(ctx.db)
  await ctx.db.insert(t.models).values([
    { id: SOLIDIFIER, providerId: "openrouter", name: "测试固化模型", contextK: 128 },
    { id: "test/site-api-exec", providerId: "openrouter", name: "测试执行模型", contextK: 128 },
  ])
  await ctx.db.insert(t.modelDefaults).values({ role: "solidify", modelId: SOLIDIFIER }).onConflictDoUpdate({ target: t.modelDefaults.role, set: { modelId: SOLIDIFIER } })
  const boss = await bossFor(ctx.db)
  await boss.createQueue(QUEUES.routineCompile, { policy: "stately" })
}, 120_000)

afterAll(async () => {
  await stopSenderBoss(ctx.db)
  await ctx?.close()
})

let runCounter = 0

/** 被派的任务（参数「关键词」）：浏览器工具，按需打开「允许直接调网站接口」 */
async function siteTask(allowFetch: boolean) {
  const taskId = await createTask(ctx.db, { modelId: "test/site-api-exec", toolIds: ["browser"], title: "搜商品", goal: "按关键词搜商品，交回条数" })
  await ctx.db.update(t.tasks).set({ dispatch: DISPATCH, allowBrowserFetch: allowFetch }).where(eq(t.tasks.id, taskId))
  return taskId
}

/** 办成的运行：过程（浏览器调用带 trace.network）、一次 browser.fetch、交回结果；记下的接口存成 network 文件 */
async function sourceRun(taskId: string, log: NetworkLogLine[] | null = LOG) {
  const snapshot = await buildSnapshot(ctx.db, taskId, {
    source: "dispatch",
    runAttachments: [],
    dispatch: { itemId: "W-1", key: KEYWORD, title: KEYWORD, params: { 关键词: KEYWORD }, depth: 1, results: DISPATCH.results },
  })
  const id = `R-site-${taskId}-${++runCounter}`
  await ctx.db.insert(t.sessions).values({
    id,
    taskId,
    status: "done",
    modelId: "test/site-api-exec",
    triggeredBy: "dispatch",
    startedAt: at(0),
    endedAt: at(60),
    snapshot,
    outcome: "achieved",
  })
  const events = [
    { second: 0, kind: "plan" as const, title: "运行开始" },
    { second: 3, kind: "tool" as const, title: "打开网页", toolId: "browser.navigate", input: { url: `${SHOP}/items` }, trace: { urlAfter: `${SHOP}/items`, network: { first: 1, last: 2 } } },
    { second: 12, kind: "tool" as const, title: "输入文字", toolId: "browser.type", input: { element: "搜索框", target: "getByRole('searchbox')", text: KEYWORD, submit: true }, trace: { network: { first: 3, last: 3 } } },
    { second: 22, kind: "tool" as const, title: "点击", toolId: "browser.click", input: { element: "下一页", target: "getByRole('button', { name: '下一页' })" }, trace: { network: { first: 4, last: 4 } } },
    { second: 32, kind: "tool" as const, title: "点击", toolId: "browser.click", input: { element: "保存库存", target: "getByRole('button', { name: '保存' })" }, trace: { network: { first: 6, last: 6 } } },
    { second: 42, kind: "tool" as const, title: "调网站接口", toolId: "browser.fetch", input: { url: `${SHOP}/api/items/1001` }, trace: { urlBefore: `${SHOP}/items`, network: { first: 7, last: 7 } } },
    { second: 50, kind: "tool" as const, title: "报结果", toolId: "work.report", input: { data: { 条数: "23" } } },
    { second: 51, kind: "tool" as const, title: "报结果", toolId: "run.finish", input: { outcome: "achieved", summary: "23 条", evidence: "列表" } },
  ]
  await ctx.db.insert(t.sessionEvents).values(
    events.map((event, index) => ({
      sessionId: id,
      seq: index + 1,
      at: at(event.second),
      kind: event.kind,
      title: event.title,
      toolId: "toolId" in event ? event.toolId : null,
      input: "input" in event ? JSON.stringify(event.input) : null,
      output: "toolId" in event ? "好" : null,
      trace: "trace" in event ? event.trace : null,
    }))
  )
  await ctx.db.update(t.sessions).set({ eventSeq: events.length }).where(eq(t.sessions.id, id))
  if (log) await saveFile(ctx.db, { data: Buffer.from(jsonl(log)), name: "requests.jsonl", mime: "application/x-ndjson", kind: "network", sessionId: id })
  return id
}

async function materialOf(sessionId: string, taskId: string) {
  const [routine] = await ctx.db.insert(t.routines).values({ id: `RT-site-${sessionId}`, taskId }).returning()
  return buildMaterial(ctx.db, { sourceSessionId: sessionId, routineId: routine!.id })
}

const versionRow = async (id: string) => (await ctx.db.select().from(t.routineVersions).where(eq(t.routineVersions.id, id)))[0]!

describe("材料：网页调过的接口", () => {
  it("路径模板：数字、UUID、长十六进制、又长又杂的段、等于输入的段换成 {id}；字词拼的长段不换；查询参数解码", () => {
    for (const each of ["1001", "2b1c7c6e-8f0a-4d7e-9a37-0c1d2e3f4a5b", "9f8e7d6c5b4a3928", "aZ3kQ9xV7bN2mL5pR8tW1"]) expect(isIdSegment(each), each).toBe(true)
    for (const each of ["items", "v2", "order-list-v2-2024-all", "abcdef012345"]) expect(isIdSegment(each), each).toBe(false)
    expect(apiTemplate(`${SHOP}/api/items/1001/stock?b=2&a=${encodeURIComponent("杯子")}`)).toEqual({
      origin: SHOP,
      path: "/api/items/{id}/stock",
      ids: ["1001"],
      query: [["b", "2"], ["a", "杯子"]],
    })
    expect(apiTemplate(`${SHOP}/api/search/${encodeURIComponent(KEYWORD)}`, [KEYWORD]).path).toBe("/api/search/{id}")
    expect(apiTemplate("不是网址").path).toBe("不是网址")
  })

  it("归类：方法 + 路径模板（不看查询参数），会改东西的在前，再按次数", () => {
    const { requests } = parseNetworkLog(jsonl(LOG))
    const groups = groupApis(requests)
    expect(groups.map((group) => `${group.method} ${group.origin}${group.path} ×${group.calls.length}`)).toEqual([
      `POST ${SHOP}/api/items/{id}/stock ×1`,
      `GET ${SHOP}/api/items ×3`,
      `GET ${SHOP}/api/user/profile ×1`,
      `GET ${SHOP}/api/notice/poll ×1`,
      "GET https://api.shop.example.com/v1/orders/{id} ×1",
    ])
    // 坏的行跳过，end 行单独给
    expect(parseNetworkLog(`{坏的\n${jsonl(LOG)}\n{"seq":"x"}`)).toMatchObject({ requests: { length: 7 }, end: { skipped: 12 } })
  })

  it("从库里拼：打开了开关、有记录才加这一节；参数固定 / 每次不一样、输入在这里、在哪一步（trace.network 和两次调用之间）、认证、CSRF、返回结构和样例、end 行", async () => {
    const taskId = await siteTask(true)
    const source = await sourceRun(taskId)
    const material = await materialOf(source, taskId)
    expect(material.allowFetch).toBe(true)
    expect(material.networkSeqs).toEqual([1, 2, 3, 4, 5, 6, 7])
    const text = material.text
    const section = text.slice(text.indexOf("## 网页调过的接口"))
    expect(section).toContain("## 网页调过的接口（network/requests.jsonl，记了 7 个请求，归成 5 个接口）")
    expect(section).toContain("记录到了上限：后面还有 12 个请求没记（同一个网址最多记 3 次）。")
    // 写请求排第一：在哪一步、请求体里的输入、CSRF
    expect(section).toContain(`### 接口 1：POST ${SHOP}/api/items/{id}/stock（会改东西）`)
    expect(section).toContain("- 调了 1 次（请求 seq 6），状态 403")
    expect(section).toContain("- 在哪一步：#4 browser.click")
    expect(section).toContain("  - 路径里第 1 个 {id}：1001")
    expect(section).toContain('- 请求体（application/json，seq 6，开头）：{"qty":5,"note":"蓝色杯子","password":"••••"}')
    expect(section).toContain("  输入在这里：note = input.关键词")
    expect(section).toContain('- 认证：带 cookie；CSRF 照抄：csrf: {"header":"x-csrf-token","from":"meta","name":"csrf-token"}')
    expect(section).toContain("- 网页设的请求头：content-type")
    // 列表接口：三次，参数按名字排好
    expect(section).toContain(`### 接口 2：GET ${SHOP}/api/items?kw=…&page=…&size=…`)
    expect(section).toContain("- 调了 3 次（请求 seq 2、3、4），状态 200 ×3")
    expect(section).toContain("- 在哪一步：#1 browser.navigate；#2 browser.type；#3 browser.click")
    expect(section).toContain(`  - 查询参数 kw：固定 ${KEYWORD}（输入在这里：= input.关键词）`)
    expect(section).toContain("  - 查询参数 page：每次不一样 1、2")
    expect(section).toContain("  - 查询参数 size：固定 20")
    expect(section).toContain(`- 返回结构：${LIST_SHAPE}`)
    expect(section).toContain('- 返回样例（seq 2，状态 200，开头）：{"code":0,"data":{"list":[{"id":1001,"name":"蓝色杯子 A","price":12}],"total":23}}')
    expect(section).toContain("- 网页设的请求头：accept、x-requested-with")
    // 两次调用之间的轮询
    expect(section).toMatch(/接口 4：GET https:\/\/shop\.example\.com\/api\/notice\/poll\n.*\n- 在哪一步：#3 之后、下一次调用之前（\d\d:\d\d:\d\d）/)
    // token 认证的
    expect(section).toContain("### 接口 5：GET https://api.shop.example.com/v1/orders/{id}")
    expect(section).toContain("- 认证：不带 cookie；认证头 authorization（值是「Bearer <密钥>」）（用 token 认证：browser.fetch 调不了，脚本里照页面点；见规矩第 24 条）")
    // 过程里的那一步也标了 seq；browser.fetch 在任务里的工具里写了调法
    expect(text).toContain("#1 browser.navigate ✓")
    expect(text).toContain("  这一步里网页发的请求：seq 1–2（见「网页调过的接口」）")
    expect(text).toContain("  这一步里网页发的请求：seq 3（见「网页调过的接口」）")
    expect(text).toContain("- browser.fetch（1 次）→ ha.browser.fetch(…)")
    expect(sdkCallOf("browser.fetch")).toBe("ha.browser.fetch(…)")
    // 接口一节在过程后面
    expect(text.indexOf("## 这次运行的过程")).toBeLessThan(text.indexOf("## 网页调过的接口"))
  })

  it("没打开开关（有记录也不给）、打开了但没有记录：都没有这一节", async () => {
    const off = await siteTask(false)
    const offSource = await sourceRun(off)
    const offMaterial = await materialOf(offSource, off)
    expect(offMaterial.allowFetch).toBe(false)
    expect(offMaterial.networkSeqs).toBeUndefined()
    expect(offMaterial.text).not.toContain("## 网页调过的接口")
    const on = await siteTask(true)
    const empty = await materialOf(await sourceRun(on, null), on)
    expect(empty).toMatchObject({ allowFetch: true })
    expect(empty.networkSeqs).toBeUndefined()
    expect(empty.text).not.toContain("## 网页调过的接口")
  })

  it("预算：最多 40 个接口、合计 1.2 万字，超了写还有几个没列；参数最多列 3 个值", () => {
    const many: NetworkRequestLine[] = Array.from({ length: 60 }, (_, index) =>
      req(index + 1, index, { url: `${SHOP}/api/res${index}?page=${index % 5}`, responseBody: "x".repeat(900), shape: "{ a: string }" })
    )
    const stepOf = () => "#1 browser.navigate"
    const full = networkSection({ requests: many }, [], stepOf)
    expect(full.match(/### 接口 /g)!.length).toBeLessThan(40)
    expect(full.length).toBeLessThan(13_500)
    expect(full).toMatch(/还有 \d+ 个接口没列（超出篇幅），没列的不要用。/)
    const small = many.slice(0, 50).map((line) => ({ ...line, responseBody: undefined, shape: undefined }))
    const capped = networkSection({ requests: small }, [], stepOf, 1_000_000)
    expect(capped.match(/### 接口 /g)!.length).toBe(40)
    expect(capped).toContain("还有 10 个接口没列")
    // 同一个接口 5 个不同的页码：列 3 个
    const pages = Array.from({ length: 5 }, (_, index) => req(index + 1, index, { url: `${SHOP}/api/items?page=${index + 1}` }))
    expect(networkSection({ requests: pages }, [], stepOf)).toContain("  - 查询参数 page：每次不一样 1、2、3，还有 2 个")
    expect(networkSection({ requests: [] }, [], stepOf)).toBe("")
  })
})

describe("提示词：有接口才放新规矩", () => {
  it("siteApi 时加第 19–24 条和例 6；没有时不加；输出格式里有 httpToolSuggestions", () => {
    const plain = compileSystemPrompt("SDK")
    const withApi = compileSystemPrompt("SDK", { siteApi: true })
    expect(plain).not.toContain("19. 读数据")
    expect(plain).not.toContain("例 6")
    expect(withApi).toContain(SITE_API_RULES)
    for (const each of ["19. 读数据（列表、翻页、搜索、详情）", "ha.browser.fetch", "20. 只调「网页调过的接口」里列出的接口", "每个请求前面各一个 await ha.commit", "不写 cookie、authorization", "csrf: { header, from, name }", "401、403", "httpToolSuggestions", "{{密钥名}}", "例 6"])
      expect(withApi).toContain(each)
    // 规矩在 SDK 说明前面，「只输出要求的 JSON」在规矩最后
    expect(withApi.indexOf("24. 用 token 认证的接口")).toBeLessThan(withApi.indexOf("只输出要求的 JSON。"))
    expect(withApi.indexOf("只输出要求的 JSON。")).toBeLessThan(withApi.indexOf("## SDK（heyagent）的说明"))
    expect(plain.indexOf("18. 读回核对")).toBeLessThan(plain.indexOf("只输出要求的 JSON。"))
    expect(SDK_FALLBACK).toContain("fetch(args: { url: string")
    // 读的是真的 index.d.ts：有 fetch 的说明
    expect(compileSystemPrompt()).toContain("fetch(args: FetchArgs): Promise<FetchResult>")
  })

  it("输出格式：httpToolSuggestions 在 JSON Schema 里是必填的；没给当空数组，格式不对的那几条丢掉", () => {
    const shape = z.toJSONSchema(compileOutputSchema) as { required: string[] }
    expect(shape.required).toContain("httpToolSuggestions")
    const base = { suitable: true, reason: "", name: "x", description: "", inputSchema: "{}", outputSchema: "{}", code: "", commits: [], assumptions: [] }
    expect(compileOutputSchema.parse(base).httpToolSuggestions).toEqual([])
    const good = suggestion()
    expect(compileOutputSchema.parse({ ...base, httpToolSuggestions: [good, { name: "坏的" }] }).httpToolSuggestions).toEqual([good])
    expect(compileOutputSchema.parse({ ...base, httpToolSuggestions: "没有" }).httpToolSuggestions).toEqual([])
  })
})

describe("程序检查：ha.browser.fetch 要 allowFetch", () => {
  const wrap = (body: string) => `import ha from "heyagent"\nexport default async function run(input) {\n${body}\n}`
  const code = wrap(`  await ha.browser.navigate({ url: "${SHOP}/items" })
  const res = await ha.browser.fetch({ url: "${SHOP}/api/items?page=1", headers: { accept: "application/json" } })
  if (!res.ok) return ha.fail("page", "接口返回 " + res.status)
  return ha.finish({ outcome: "achieved", summary: "好", evidence: "接口" })`)
  const check = (patch: Partial<Parameters<typeof checkRoutine>[0]>) => checkRoutine({ code, inputSchema: "{}", outputSchema: "{}", toolIds: ["browser", "run.finish"], ...patch })

  it("开着过；关着（或没传）不过，只报一次；ha.tool(\"browser.fetch\") 也算", () => {
    expect(check({ allowFetch: true }).problems).toEqual([])
    expect(check({ allowFetch: true }).usedTools).toEqual(["browser", "run.finish"])
    expect(check({ allowFetch: false }).problems).toEqual([FETCH_NOT_ALLOWED])
    expect(check({}).problems).toEqual([FETCH_NOT_ALLOWED])
    expect(FETCH_NOT_ALLOWED).toBe("任务没打开「允许直接调网站接口」，脚本里不能用 ha.browser.fetch")
    const twice = wrap(`await ha.browser.fetch({ url: "${SHOP}/a" }); await ha.tool("browser.fetch", { url: "${SHOP}/b" })`)
    expect(check({ code: twice }).problems).toEqual([FETCH_NOT_ALLOWED])
    expect(check({ code: twice, allowFetch: true }).problems).toEqual([])
    // 没有浏览器工具的任务照旧报没有 browser
    expect(check({ allowFetch: true, toolIds: ["run.finish"] }).problems.join()).toContain("ha.browser.navigate（browser.navigate） 要用工具 browser")
  })
})

/** 一条合格的建议（模型给的形状） */
function suggestion(patch: Partial<HttpSuggestionOutput> = {}): HttpSuggestionOutput {
  return {
    name: "查订单详情",
    summary: "按订单号查订单的状态",
    reason: "seq 7 的接口用 Authorization 认证，browser.fetch 调不了",
    method: "GET",
    url: "https://api.shop.example.com/v1/orders/{订单号}",
    headers: [
      { name: "Authorization", value: "Bearer {{SHOP_API_TOKEN}}" },
      { name: "accept", value: "application/json" },
    ],
    body: "",
    params: [{ name: "订单号", description: "订单的编号", required: true }],
    secrets: ["SHOP_API_TOKEN"],
    requestSeqs: [7],
    ...patch,
  }
}

describe("HTTP 工具建议的规整", () => {
  const known = [1, 2, 3, 7]

  it("请求头数组变对象、空 body 去掉、参数补 type: string 并和模板对齐、secrets 以模板为准", () => {
    const [one] = normalizeHttpSuggestions(
      [
        suggestion({
          method: "POST",
          url: "https://api.shop.example.com/v1/orders/{订单号}/notes?lang={语言}",
          body: '{"text":"{内容}"}',
          // 模板里没有的「多余」去掉，模板里有、清单里没有的「语言」「内容」补上；secrets 写错了以模板为准
          params: [
            { name: "订单号", description: "订单的编号", required: true },
            { name: "多余", description: "", required: false },
          ],
          secrets: ["WRONG"],
          requestSeqs: [7, 7, 99, 2],
        }),
      ],
      known
    )
    expect(one).toEqual({
      name: "查订单详情",
      summary: "按订单号查订单的状态",
      reason: "seq 7 的接口用 Authorization 认证，browser.fetch 调不了",
      http: {
        method: "POST",
        url: "https://api.shop.example.com/v1/orders/{订单号}/notes?lang={语言}",
        headers: { Authorization: "Bearer {{SHOP_API_TOKEN}}", accept: "application/json" },
        body: '{"text":"{内容}"}',
        params: [
          { name: "订单号", type: "string", required: true, description: "订单的编号" },
          { name: "语言", type: "string", required: true },
          { name: "内容", type: "string", required: true },
        ],
      },
      secrets: ["SHOP_API_TOKEN"],
      requestSeqs: [2, 7],
    })
    const [plain] = normalizeHttpSuggestions([suggestion({ headers: [], body: "  " })], known)
    expect(plain!.http).toEqual({ method: "GET", url: "https://api.shop.example.com/v1/orders/{订单号}", params: [{ name: "订单号", type: "string", required: true, description: "订单的编号" }] })
    expect(plain!.secrets).toEqual([])
  })

  it("去掉：网址不是 http(s)、有 ••••、有明文密钥、密钥名改不成合规的、依据不在记录里；能改的密钥名改成大写；同一个网址只留一条；最多 5 条；没有记录一条都不要", () => {
    const out = normalizeHttpSuggestions(
      [
        suggestion({ url: "/v1/orders/{订单号}" }),
        suggestion({ url: "ftp://api.shop.example.com/x" }),
        suggestion({ url: "https://api.shop.example.com/v1/a?key=••••" }),
        suggestion({ url: "https://api.shop.example.com/v1/b", headers: [{ name: "Authorization", value: "Bearer abcdef1234567890" }] }),
        suggestion({ url: "https://api.shop.example.com/v1/c", headers: [{ name: "Authorization", value: "Bearer {{接口令牌}}" }] }),
        suggestion({ url: "https://api.shop.example.com/v1/d", requestSeqs: [99] }),
        suggestion({ url: "https://api.shop.example.com/v1/e", headers: [{ name: "X-Api-Key", value: "{{ shop-api_key }}" }], secrets: ["shop-api_key"] }),
        suggestion({ url: "https://api.shop.example.com/v1/e", name: "重复" }),
      ],
      known
    )
    expect(out.map((each) => each.http.url)).toEqual(["https://api.shop.example.com/v1/e"])
    expect(out[0]!.http.headers).toEqual({ "X-Api-Key": "{{SHOP_API_KEY}}" })
    expect(out[0]!.secrets).toEqual(["SHOP_API_KEY"])

    const seven = Array.from({ length: 7 }, (_, index) => suggestion({ url: `https://api.shop.example.com/v1/r${index}` }))
    expect(normalizeHttpSuggestions(seven, known)).toHaveLength(5)
    expect(normalizeHttpSuggestions(seven, undefined)).toEqual([])
    expect(normalizeHttpSuggestions(seven, [])).toEqual([])
  })
})

describe("状态机：建议存进版本、routine.version 返回", () => {
  const fetchCode = `import ha from "heyagent"

export default async function run(input) {
  await ha.browser.navigate({ url: "${SHOP}/items" })
  let total = 0
  for (let page = 1; page <= 20; page++) {
    const res = await ha.browser.fetch({ url: "${SHOP}/api/items?kw=" + encodeURIComponent(input.关键词) + "&page=" + page + "&size=20", headers: { accept: "application/json" } })
    if (res.status === 401 || res.status === 403) return ha.fail("page", "接口返回 " + res.status + "，多半登录过期了")
    if (!res.ok) return ha.fail("page", "接口返回 " + res.status)
    const list = res.json?.data?.list ?? []
    total += list.length
    if (list.length < 20) break
  }
  await ha.work.report({ data: { 条数: String(total) } })
  return ha.finish({ outcome: "achieved", summary: "搜到 " + total + " 条", evidence: "接口 /api/items" })
}`
  const output = (patch: Record<string, unknown> = {}) => ({
    suitable: true,
    reason: "步骤固定",
    name: "按关键词搜商品",
    description: "1. 打开商品页\n2. 调列表接口翻页读完",
    inputSchema: JSON.stringify({ type: "object", properties: { 关键词: { type: "string" } }, required: ["关键词"] }),
    outputSchema: JSON.stringify({ type: "object", properties: { 条数: { type: "string" } } }),
    code: fetchCode,
    commits: [],
    assumptions: ["每页 20 条"],
    httpToolSuggestions: [suggestion(), suggestion({ url: "https://api.shop.example.com/v1/x?token=••••" }), suggestion({ url: "https://api.shop.example.com/v1/y", requestSeqs: [123] })],
    ...patch,
  })

  it("打开了开关：提示词有第 19–24 条、材料有接口；用 ha.browser.fetch 的脚本过了检查；合格的建议存进版本，routine.version / routine.get 带上", async () => {
    const taskId = await siteTask(true)
    const source = await sourceRun(taskId)
    const res = await mutate(ctx.app, "routine.compile", wang, { sessionId: source, skipTest: true })
    expect(res.error).toBeUndefined()
    const model = useModel(SOLIDIFIER, [output()])
    await handleCompileJob(ctx.db, { versionId: res.data.versionId })
    const version = await versionRow(res.data.versionId)
    expect(version).toMatchObject({ status: "review", round: 1, code: fetchCode })
    expect(version.httpSuggestions).toEqual([expect.objectContaining({ name: "查订单详情", requestSeqs: [7], secrets: ["SHOP_API_TOKEN"] })])
    expect(model.promptText(0)).toContain("19. 读数据（列表、翻页、搜索、详情）")
    expect(model.promptText(0)).toContain("## 网页调过的接口")
    const api = await query(ctx.app, "routine.version", wang, { id: res.data.versionId })
    expect(api.data.httpToolSuggestions).toEqual(version.httpSuggestions)
    expect(api.data.httpToolSuggestions[0].http).toMatchObject({ method: "GET", headers: { Authorization: "Bearer {{SHOP_API_TOKEN}}" } })
    const summary = await query(ctx.app, "routine.get", wang, { taskId })
    expect(summary.data.versions[0]).toMatchObject({ version: 1, httpToolSuggestions: 1 })
  })

  it("没打开开关：没有新规矩、没有接口一节；ha.browser.fetch 程序检查不过（交回固化员）；建议一条都不存", async () => {
    const taskId = await siteTask(false)
    const source = await sourceRun(taskId)
    const res = await mutate(ctx.app, "routine.compile", wang, { sessionId: source, skipTest: true })
    const model = useModel(SOLIDIFIER, [output(), output({ code: fetchCode.replace(/const res = await ha\.browser\.fetch\([^\n]*\n/, "const res = { ok: true, status: 200, json: {} }\n") })])
    await handleCompileJob(ctx.db, { versionId: res.data.versionId })
    expect(model.promptText(0)).not.toContain("19. 读数据")
    expect(model.promptText(0)).not.toContain("## 网页调过的接口")
    expect(model.promptText(1)).toContain(FETCH_NOT_ALLOWED)
    const version = await versionRow(res.data.versionId)
    expect(version).toMatchObject({ status: "review", round: 2, httpSuggestions: [] })
  })
})
