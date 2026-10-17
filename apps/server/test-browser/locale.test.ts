// 真浏览器：Chrome 按配置里的时区（环境变量 TZ）和语言（--lang、--accept-lang）启动；没填时用上海时区、中文。
// 容器本身是 TZ=Asia/Shanghai（scripts/browser-test.sh），所以测一个别的时区才能看出配置生效了。
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { afterAll, beforeAll, describe, expect, it } from "vitest"

import type { BrowserManager } from "../src/browser/manager.js"
import * as t from "../src/db/schema.js"
import { createTask, setupEngine, type EngineTestContext } from "../test/engine-helpers.js"
import { createProfile } from "./fixtures.js"

let ctx: EngineTestContext
let manager: BrowserManager
let taskId: string
let server: Server
let port: number
/** 测试站点收到的 Accept-Language（按路径记） */
const acceptLanguage = new Map<string, string>()

async function session(id: string) {
  await ctx.db.insert(t.sessions).values({ id, taskId, status: "running", modelId: "test/none", startedAt: new Date() })
  return id
}

beforeAll(async () => {
  ctx = await setupEngine()
  manager = ctx.worker.browser!
  taskId = await createTask(ctx.db, { modelId: "test/none" })
  server = createServer((req, res) => {
    acceptLanguage.set(req.url ?? "/", String(req.headers["accept-language"] ?? ""))
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end("<!doctype html><title>ok</title><p>ok</p>")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await ctx?.stop()
  await new Promise((resolve) => server?.close(resolve))
})

async function probe(sessionId: string, profileId: string, path: string) {
  const instance = await manager.acquireForSession({ sessionId: await session(sessionId), profileId, allowedDomains: [] })
  const page = instance.currentPage()!
  await page.goto(`http://127.0.0.1:${port}${path}`, { timeout: 30_000 })
  const seen = await page.evaluate(() => ({
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    language: navigator.language,
    languages: [...navigator.languages],
    // 2026-01-15 12:00 UTC 在这个时区的小时数（纽约冬令时是 7 点）
    hour: new Date(Date.UTC(2026, 0, 15, 12)).getHours(),
  }))
  await manager.releaseSession(sessionId, { reason: "测试" })
  return { ...seen, acceptLanguage: acceptLanguage.get(path) }
}

describe("时区和语言", () => {
  it("填了：Chrome 用配置里的时区和语言，网站收到对应的 Accept-Language", async () => {
    const profileId = await createProfile(ctx.db, ctx.keyring, { timezone: "America/New_York", locale: "en-US" })
    const seen = await probe("R-L-1", profileId, "/en")
    expect(seen.timeZone).toBe("America/New_York")
    expect(seen.hour).toBe(7)
    expect(seen.language).toBe("en-US")
    expect(seen.languages[0]).toBe("en-US")
    expect(seen.acceptLanguage).toMatch(/^en-US,en/)
  })

  it("没填：用上海时区、中文", async () => {
    const profileId = await createProfile(ctx.db, ctx.keyring, { timezone: null, locale: null })
    const seen = await probe("R-L-2", profileId, "/zh")
    expect(seen.timeZone).toBe("Asia/Shanghai")
    expect(seen.hour).toBe(20)
    expect(seen.language).toBe("zh-CN")
    expect(seen.acceptLanguage).toMatch(/^zh-CN,zh/)
  })
})
