import { sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { login, setupApp, type TestApp } from "./helpers.js"

let ctx: TestApp
let cookie: string

beforeAll(async () => {
  ctx = await setupApp()
  cookie = await login(ctx.app, "wangyue@heyagent.local")
})
afterAll(async () => {
  await ctx?.close()
})

/** 读 SSE 流，直到拿到满足条件的 data 事件 */
async function readUntil(res: Response, match: (event: { id?: string; data: any }) => boolean, timeoutMs = 5000) {
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("SSE 超时")), deadline - Date.now())),
      ])
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index: number
      while ((index = buffer.indexOf("\n\n")) >= 0) {
        const block = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const id = /^id: ?(.*)$/m.exec(block)?.[1]
        const data = /^data: ?(.*)$/m.exec(block)?.[1]
        // 第一条是 tRPC 的 connected 事件（客户端选项），跳过
        if (!data || /^event: ?connected$/m.test(block)) continue
        const event = { id, data: JSON.parse(data) }
        if (match(event)) return event
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  throw new Error("没等到想要的事件")
}

const subscribe = (lastEventId?: string) =>
  ctx.app.request(`/api/trpc/live.onChange?input=${encodeURIComponent(JSON.stringify(lastEventId ? { lastEventId } : {}))}`, {
    headers: { cookie, accept: "text/event-stream" },
  })

describe("实时推送（LISTEN/NOTIFY → SSE）", () => {
  it("不登录不能订阅", async () => {
    const res = await ctx.app.request("/api/trpc/live.onChange", { headers: { accept: "text/event-stream" } })
    expect(res.status).toBe(401)
  })

  it("改库里 session 的状态，订阅的人收到 { table, id }", async () => {
    const res = await subscribe()
    expect(res.headers.get("content-type")).toContain("text/event-stream")
    // drizzle 的查询要 then 才会执行
    setTimeout(() => ctx.db.execute(sql`update sessions set status = 'running' where id = 'R-1035-1'`).then(() => {}), 300)
    const event = await readUntil(res, (e) => e.data?.table === "sessions")
    expect(event.data).toEqual({ table: "sessions", id: "R-1035-1" })
    expect(event.id).toMatch(/^[0-9a-f]+:\d+$/)
  })

  it("pnpm dev:notify 那样直接 pg_notify 也能收到", async () => {
    const res = await subscribe()
    setTimeout(() => ctx.db.execute(sql`select pg_notify('heyagent_changes', '{"table":"tasks","id":"T-1024"}')`).then(() => {}), 300)
    const event = await readUntil(res, (e) => e.data?.table === "tasks")
    expect(event.data).toEqual({ table: "tasks", id: "T-1024" })
  })

  it("断线续传：带上最后收到的 id 重连，补发漏掉的", async () => {
    ctx.hub.publish({ table: "memories", id: "m-001" })
    const lastId = ctx.hub.latestId
    ctx.hub.publish({ table: "skills", id: "sk-find-same" })
    ctx.hub.publish({ table: "rules", id: "rl-verify" })
    const res = await subscribe(lastId)
    const first = await readUntil(res, () => true)
    expect(first.data).toEqual({ table: "skills", id: "sk-find-same" })
  })

  it("补不齐（id 不认识）时发一条 table = * 让前端全部重新拉", async () => {
    const res = await subscribe("unknown-boot:5")
    const first = await readUntil(res, () => true)
    expect(first.data).toEqual({ table: "*", id: null })
  })
})
