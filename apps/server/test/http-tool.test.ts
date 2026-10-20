// HTTP 工具的模板填法：JSON 请求体里引号外面的 {参数} 原样填 JSON（数组、对象），引号里面的转义成文字；
// 可选参数、没传就去掉；参数清单和模板对不上、JSON 请求体模板不对的不让存；执行时填出来不是合法 JSON 就不发、报清楚；
// 运行用库里现在的模板（不是快照里冻住的）。起一个本地 HTTP 服务器收请求，连真实的测试库。
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import type { HttpSpec, SessionSnapshot } from "@heyagent/shared"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { ToolGateway } from "../src/engine/gateway.js"
import { urlsOf } from "../src/engine/rules.js"
import { configureEngine } from "../src/engine/runtime.js"
import type { SessionRow } from "../src/engine/tools/builtin.js"
import { executeHttpTool, httpInputSchema } from "../src/engine/tools/http.js"
import { login, mutate, setupApp, type TestApp } from "./helpers.js"

let ctx: TestApp
let lin: string
let server: Server
let base = ""
const SECRET = "tok-secret-value-7788"
const received: { method: string; url: string; headers: Record<string, string | string[] | undefined>; body: string }[] = []

beforeAll(async () => {
  ctx = await setupApp()
  configureEngine({ keyring: ctx.keyring })
  lin = await login(ctx.app, "linzhou@heyagent.local")
  server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => {
      received.push({ method: req.method ?? "", url: req.url ?? "", headers: req.headers, body: Buffer.concat(chunks).toString("utf8") })
      res.setHeader("content-type", "application/json")
      res.end('{"ok":true}')
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}, 120_000)

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await ctx?.close()
})

/** 经接口建一个 HTTP 工具，返回库里存的 spec */
async function createTool(name: string, http: Record<string, unknown>, secrets: Record<string, string> = {}) {
  const res = await mutate(ctx.app, "tools.createHttp", lin, { name, description: `${name}。测试用`, http: { headers: {}, ...http }, risk: "read", secrets })
  if (res.error) throw new Error(res.error.message)
  return { id: res.data.id as string, spec: await specOf(res.data.id as string) }
}

async function specOf(id: string): Promise<HttpSpec> {
  const [row] = await ctx.db.select().from(t.tools).where(eq(t.tools.id, id))
  return row!.http!
}

/** 像网关一样：先按参数 schema 校验，再执行；返回结果和服务器这次收到的请求 */
async function run(spec: HttpSpec, input: Record<string, unknown>) {
  const before = received.length
  const parsed = httpInputSchema(spec).validator.parse(input) as Record<string, unknown>
  const outcome = await executeHttpTool(ctx.db, spec, parsed)
  return { outcome, request: received.length > before ? received.at(-1) : undefined }
}

describe("JSON 请求体：引号外面的参数原样填 JSON", () => {
  const body = '{"status":"{status}","candidates":{candidates},"note":"{freeText}"}'
  let spec: HttpSpec

  beforeAll(async () => {
    ;({ spec } = await createTool("回写结果", { method: "POST", url: `${base}/result`, body }))
  })

  it("没传清单按模板推：引号外面的是 json，都必填", () => {
    expect(spec.params).toEqual([
      { name: "status", type: "string", required: true },
      { name: "candidates", type: "json", required: true },
      { name: "freeText", type: "string", required: true },
    ])
    const { jsonSchema } = httpInputSchema(spec)
    expect(jsonSchema.required).toEqual(["status", "candidates", "freeText"])
    expect(jsonSchema.properties.candidates).not.toHaveProperty("type")
    expect(jsonSchema.properties.candidates.description).toContain("直接传 JSON 值")
    expect(jsonSchema.properties.status).toMatchObject({ type: "string" })
  })

  it("数组原样放进去（直接传或写成 JSON 字符串都行），文字转义", async () => {
    const expected = '{"status":"FAILED","candidates":[{"id":"a\\"b","score":90}],"note":"带\\"引号\\"和多行\\n文本"}'
    for (const candidates of [[{ id: 'a"b', score: 90 }], '[{"id":"a\\"b","score":90}]']) {
      const { outcome, request } = await run(spec, { status: "FAILED", candidates, freeText: '带"引号"和多行\n文本' })
      expect(outcome.isError).toBe(false)
      expect(request!.body).toBe(expected)
      expect(request!.headers["content-type"]).toBe("application/json")
      expect(JSON.parse(request!.body)).toEqual({ status: "FAILED", candidates: [{ id: 'a"b', score: 90 }], note: '带"引号"和多行\n文本' })
    }
  })

  it("空数组和非空数组一样；文字里的 {}、[]、中文照原样", async () => {
    const freeText = '空对象 {} 和空数组 [] 还有 {status} 和 "引号"\n第二行'
    for (const candidates of [[], [1, 2], [{ id: "x" }]]) {
      const { outcome, request } = await run(spec, { status: "OK", candidates, freeText })
      expect(outcome.isError).toBe(false)
      expect(JSON.parse(request!.body)).toEqual({ status: "OK", candidates, note: freeText })
    }
  })

  it("像 JSON 却解析不了的字符串：参数校验就拒绝", () => {
    const result = httpInputSchema(spec).validator.safeParse({ status: "OK", candidates: "[{bad", freeText: "x" })
    expect(result.success).toBe(false)
    expect(result.error!.issues[0]!.message).toContain("不是合法 JSON")
  })
})

describe("参数清单", () => {
  const http = { method: "POST", url: "", body: '{"text":"{text}","items":{items}}' }

  it("给模板加 {speaker}（不传清单）：清单和给模型的参数里都有它，原来的设置沿用", async () => {
    const { id } = await createTool("说话", {
      ...http,
      url: `${base}/say`,
      params: [
        { name: "text", type: "string", required: true, description: "要说的话" },
        { name: "items", type: "json", required: false },
      ],
    })
    const res = await mutate(ctx.app, "tools.updateHttp", lin, {
      id,
      name: "说话",
      description: "说话。测试用",
      http: { ...http, url: `${base}/say`, headers: {}, body: '{"text":"{text}","items":{items},"speaker":"{ speaker }"}' },
      risk: "read",
      secrets: {},
    })
    expect(res.error).toBeUndefined()
    const spec = await specOf(id)
    expect(spec.params).toEqual([
      { name: "text", type: "string", required: true, description: "要说的话" },
      { name: "items", type: "json", required: false },
      { name: "speaker", type: "string", required: true },
    ])
    const { jsonSchema } = httpInputSchema(spec)
    expect(Object.keys(jsonSchema.properties)).toEqual(["text", "items", "speaker"])
    expect(jsonSchema.required).toEqual(["text", "speaker"])
    // 可选的 json 参数没传：填 null
    const { request } = await run(spec, { text: "你好", speaker: "小牧" })
    expect(JSON.parse(request!.body)).toEqual({ text: "你好", items: null, speaker: "小牧" })
  })

  it("传了清单就要和模板一一对应：少了、多了都不让存，说出名字", async () => {
    const base_ = { name: "对不上", description: "测试用", risk: "read", secrets: {} }
    const missing = await mutate(ctx.app, "tools.createHttp", lin, { ...base_, http: { ...http, url: `${base}/x`, headers: {}, body: '{"text":"{text}","speaker":"{speaker}"}', params: [{ name: "text", type: "string" }] } })
    expect(missing.error?.data?.code).toBe("BAD_REQUEST")
    expect(missing.error?.message).toContain("模板里的 {speaker} 不在参数清单里")
    const extra = await mutate(ctx.app, "tools.createHttp", lin, { ...base_, http: { ...http, url: `${base}/x`, headers: {}, body: '{"text":"{text}"}', params: [{ name: "text", type: "string" }, { name: "foo", type: "string" }] } })
    expect(extra.error?.data?.code).toBe("BAD_REQUEST")
    expect(extra.error?.message).toContain("参数清单里的 foo 模板里没有")
  })

  it("「没传就去掉」不能在 URL 路径里；JSON 请求体模板不对的不让存", async () => {
    const base_ = { name: "不对", description: "测试用", risk: "read", secrets: {} }
    const inPath = await mutate(ctx.app, "tools.createHttp", lin, { ...base_, http: { method: "GET", url: `${base}/items/{id}`, headers: {}, params: [{ name: "id", type: "string", required: false, omitIfAbsent: true }] } })
    expect(inPath.error?.message).toContain("{id} 在 URL 路径里")
    const broken = await mutate(ctx.app, "tools.createHttp", lin, { ...base_, http: { method: "POST", url: `${base}/x`, headers: {}, body: '{"a":{a} "b":"{b}"}' } })
    expect(broken.error?.data?.code).toBe("BAD_REQUEST")
    expect(broken.error?.message).toContain("请求体模板填上参数以后不是合法 JSON")
    expect(broken.error?.message).toContain("{a}")
    const badSecret = await mutate(ctx.app, "tools.createHttp", lin, { ...base_, http: { method: "GET", url: `${base}/x?q={{query}}`, headers: {} } })
    expect(badSecret.error?.message).toContain("两层 {{名字}} 是密钥")
  })
})

describe("可选参数：没传就去掉", () => {
  let spec: HttpSpec

  beforeAll(async () => {
    ;({ spec } = await createTool("报结果", {
      method: "POST",
      url: `${base}/report?run={runId}&reason={reason}&lang=zh`,
      headers: { "X-Trace": "{trace}" },
      body: '{"result":"{result}","failReason":"{failReason}","sourceSpuId":{sourceSpuId},"tags":["固定","{tag}"]}',
      params: [
        { name: "runId", type: "string" },
        { name: "reason", type: "string", required: false, omitIfAbsent: true },
        { name: "trace", type: "string", required: false, omitIfAbsent: true },
        { name: "result", type: "string" },
        { name: "failReason", type: "string", required: false, omitIfAbsent: true },
        { name: "sourceSpuId", type: "json", required: false, omitIfAbsent: true },
        { name: "tag", type: "string", required: false, omitIfAbsent: true },
      ],
    }))
  })

  it("办成没给 failReason、没办成没给 sourceSpuId：那个字段不在请求体里；查询参数、请求头也去掉", async () => {
    const ok = await run(spec, { runId: "R-1", result: "SUCCESS", sourceSpuId: 12345 })
    expect(JSON.parse(ok.request!.body)).toEqual({ result: "SUCCESS", sourceSpuId: 12345, tags: ["固定"] })
    expect(ok.request!.url).toBe("/report?run=R-1&lang=zh")
    expect(ok.request!.headers["x-trace"]).toBeUndefined()

    // 可选参数传 null 也算没传
    const failed = await run(spec, { runId: "R 2", result: "FAILED", failReason: "缺货", reason: "a&b", trace: "t-1", tag: "急", sourceSpuId: null })
    expect(JSON.parse(failed.request!.body)).toEqual({ result: "FAILED", failReason: "缺货", tags: ["固定", "急"] })
    expect(failed.request!.url).toBe("/report?run=R%202&reason=a%26b&lang=zh")
    expect(failed.request!.headers["x-trace"]).toBe("t-1")
  })

  it("必填的没传：参数校验拒绝", () => {
    const result = httpInputSchema(spec).validator.safeParse({ runId: "R-1" })
    expect(result.success).toBe(false)
    expect(httpInputSchema(spec).jsonSchema.required).toEqual(["runId", "result"])
  })
})

describe("老行为不变", () => {
  let spec: HttpSpec

  beforeAll(async () => {
    ;({ spec } = await createTool(
      "查订单",
      {
        method: "POST",
        url: `${base}/orders/{orderId}/notes?q={q}`,
        headers: { Authorization: "Bearer {{HTTP_TOOL_TOKEN}}" },
        body: '{"text":"{text}","key":"{{HTTP_TOOL_TOKEN}}"}',
      },
      { HTTP_TOOL_TOKEN: SECRET }
    ))
  })

  it("文本参数、URL 路径参数编码、请求头里的密钥；模型填的 {{名字}} 不会换成密钥", async () => {
    const { outcome, request } = await run(spec, { orderId: "A/1 中", q: 7, text: "看 {{HTTP_TOOL_TOKEN}}" })
    expect(outcome.isError).toBe(false)
    expect(request!.url).toBe(`/orders/${encodeURIComponent("A/1 中")}/notes?q=7`)
    expect(request!.headers.authorization).toBe(`Bearer ${SECRET}`)
    expect(JSON.parse(request!.body)).toEqual({ text: "看 {{HTTP_TOOL_TOKEN}}", key: SECRET })
    expect(outcome.secrets).toContain(SECRET)
  })

  it("库里已经存着的、请求体模板不是合法 JSON 的旧工具：照样能跑，填出来不合法就不发，说清哪个参数、贴出那一段，密钥隐藏", async () => {
    // 绕过保存时的检查，模拟以前存进来的工具
    await ctx.db.insert(t.tools).values({
      id: "http.legacy-broken",
      name: "旧工具",
      summary: "测试用",
      description: "测试用",
      source: "http",
      risk: "read",
      http: { method: "POST", url: `${base}/legacy`, body: '{"key":"{{HTTP_TOOL_TOKEN}}","items":{items} "more":1}' },
    })
    const legacy = await specOf("http.legacy-broken")
    const before = received.length
    const { outcome } = await run(legacy, { items: [1, 2] })
    expect(received.length).toBe(before)
    expect(outcome.isError).toBe(true)
    expect(outcome.output).toContain("不是合法 JSON，没有发出去")
    expect(outcome.output).toContain("{items}")
    expect(outcome.output).toContain('"items":[1,2] "more"')
    expect(outcome.output).toContain("[已隐藏]")
    expect(outcome.output).not.toContain(SECRET)
    expect(outcome.output).not.toContain(SECRET.slice(4))
  })
})

describe("运行用库里现在的模板", () => {
  it("快照里冻住的是旧模板：网关按库里的新模板给参数、发请求；规则查白名单也按它", async () => {
    const { id, spec: old } = await createTool("广播", { method: "POST", url: `${base}/broadcast`, body: '{"text":"{text}"}' })
    const res = await mutate(ctx.app, "tools.updateHttp", lin, {
      id,
      name: "广播",
      description: "广播。测试用",
      http: { method: "POST", url: `${base}/broadcast?by={speaker}`, headers: {}, body: '{"text":"{text}","speaker":"{speaker}"}' },
      risk: "read",
      secrets: {},
    })
    expect(res.error).toBeUndefined()
    const snapshot = {
      tools: [{ id, name: "广播", summary: "广播", description: "广播", source: "http", risk: "read", http: old }],
      checkpoints: [],
    } as unknown as SessionSnapshot
    const gateway = await ToolGateway.create(ctx.db, { id: "s-http-test" } as SessionRow, snapshot)
    try {
      const entry = (gateway as unknown as { entries: { id: string; jsonSchema: { properties: Record<string, unknown> }; validator: { parse(v: unknown): unknown }; execute(v: unknown): Promise<{ isError?: boolean }> }[] }).entries.find((each) => each.id === id)!
      expect(Object.keys(entry.jsonSchema.properties)).toEqual(["speaker", "text"])
      const outcome = await entry.execute(entry.validator.parse({ text: "开会", speaker: "小牧" }))
      expect(outcome.isError).toBe(false)
      expect(JSON.parse(received.at(-1)!.body)).toEqual({ text: "开会", speaker: "小牧" })
      // 规则钩子拿到的 snapshot 也是换过的（urlsOf 按它算网址）
      const current = (gateway as unknown as { ctx: { snapshot: SessionSnapshot } }).ctx.snapshot
      expect(urlsOf(current, id, { text: "开会", speaker: "小牧" })).toEqual([`${base}/broadcast?by=${encodeURIComponent("小牧")}`])
    } finally {
      await gateway.close()
    }
  })

  it("规则的网址：按给模型的键取参数（中文参数名换成 p1…）", () => {
    const snapshot = { tools: [{ id: "http.cn", source: "http", http: { method: "GET", url: "https://api.example.com/x/{编号}?q={q}&opt={opt}&k={{KEY}}", params: [{ name: "编号", type: "string", required: true }, { name: "q", type: "string", required: true }, { name: "opt", type: "string", required: false, omitIfAbsent: true }] } }] } as unknown as SessionSnapshot
    expect(urlsOf(snapshot, "http.cn", { p1: "a b", q: "z" })).toEqual(["https://api.example.com/x/a%20b?q=z&k={{KEY}}"])
  })
})
