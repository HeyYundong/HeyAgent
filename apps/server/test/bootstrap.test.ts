// M1 P2：空白正式环境的初始化。空库上跑 bootstrap：建出管理员（密码在文件里、权限 600、不打印），写默认设置，
// 按 .env 的 OpenRouter key 接入模型服务（只用公开的模型列表接口），不灌任何演示数据；再跑一次什么都不变。
import { mkdtempSync, readFileSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { count } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { createApp } from "../src/app.js"
import { createAuth } from "../src/auth.js"
import { ADMIN_EMAIL, bootstrap } from "../src/bootstrap/index.js"
import { createDb } from "../src/db/client.js"
import * as t from "../src/db/schema.js"
import { decryptText } from "../src/lib/crypto.js"
import { ChangeHub } from "../src/live/hub.js"
import { login, query, resetTestDatabase, tempKeyring, testDatabaseUrl } from "./helpers.js"

const FAKE_KEY = "sk-or-v1-bootstrap-test-key-0000000000"
const catalog = {
  data: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "google/gemini-3.8-flash", "qwen/qwen3.8-flash"].map((id) => ({
    id,
    name: id,
    context_length: 1_000_000,
    pricing: { prompt: "0.000001", completion: "0.000002" },
    supported_parameters: ["tools"],
  })),
}
const calls: string[] = []
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  calls.push(`${url} ${new Headers(init?.headers).has("authorization") ? "with-key" : "no-key"}`)
  if (url === "https://openrouter.ai/api/v1/models") return Response.json(catalog)
  return new Response("unexpected", { status: 500 })
})

const url = testDatabaseUrl()
const { db, pool } = createDb(url, 3)
const keyring = tempKeyring()
const auth = createAuth(db, { secret: "test-secret-test-secret-test-secret-0", baseURL: "http://localhost:3100", trustedOrigins: ["http://localhost:5180"] })
const passwordFile = join(mkdtempSync(join(tmpdir(), "heyagent-admin-")), "admin-password")
const logs: string[] = []

beforeAll(async () => {
  await resetTestDatabase(url)
  vi.stubGlobal("fetch", fakeFetch)
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await pool.end()
})

const run = () => bootstrap(db, { auth, keyring, adminPasswordFile: passwordFile, openrouterApiKey: FAKE_KEY, log: (message) => logs.push(message) })

describe("空白环境初始化", () => {
  it("建出管理员：密码写进文件（600），日志里没有密码", async () => {
    const result = await run()
    expect(result).toEqual({ adminCreated: true, openrouter: "created" })
    const password = readFileSync(passwordFile, "utf8").trim()
    expect(password.length).toBeGreaterThanOrEqual(20)
    expect(statSync(passwordFile).mode & 0o777).toBe(0o600)
    expect(logs.join("\n")).not.toContain(password)
    expect(logs.join("\n")).not.toContain(FAKE_KEY)
    const users = await db.select().from(t.users)
    expect(users).toHaveLength(1)
    expect(users[0]).toMatchObject({ email: ADMIN_EMAIL, role: "admin", banned: false })

    // 用文件里的密码能登录，是主管
    const hub = new ChangeHub(url)
    await hub.start()
    try {
      const app = createApp({ db, auth, hub, keyring })
      const cookie = await login(app, ADMIN_EMAIL, password)
      expect((await query(app, "me.get", cookie)).data).toMatchObject({ email: ADMIN_EMAIL, isAdmin: true })
      expect((await query(app, "settings.get", cookie)).data).toMatchObject({ maxCostUsd: 2, maxSteps: 100, eventFallbackDays: 7, channels: [] })
    } finally {
      await hub.stop()
    }
  })

  it("没有任何演示数据：任务、记忆、技能、规则、工具、MCP、浏览器、平台、待办、session 都是空的", async () => {
    const tables = { tasks: t.tasks, memories: t.memories, skills: t.skills, rules: t.rules, tools: t.tools, mcpServers: t.mcpServers, browserProfiles: t.browserProfiles, platforms: t.platforms, humanTodos: t.humanTodos, humanItems: t.humanItems, sessions: t.sessions }
    for (const [name, table] of Object.entries(tables)) {
      const [row] = await db.select({ n: count() }).from(table)
      expect(row!.n, name).toBe(0)
    }
  })

  it("按 .env 的 key 接入 OpenRouter：key 加密存，模型列表只用公开接口，三个默认模型设好", async () => {
    const providers = await db.select().from(t.modelProviders)
    expect(providers).toEqual([expect.objectContaining({ id: "openrouter", kind: "openrouter", status: "ok", baseUrl: "https://openrouter.ai/api/v1" })])
    const [secret] = await db.select().from(t.secrets)
    expect(JSON.stringify(secret)).not.toContain(FAKE_KEY)
    expect(decryptText(keyring, secret!.enc, { table: "secrets", id: secret!.id, version: secret!.version })).toBe(FAKE_KEY)
    const defaults = Object.fromEntries((await db.select().from(t.modelDefaults)).map((row) => [row.role, row.modelId]))
    expect(defaults).toEqual({ run: "openrouter/anthropic/claude-sonnet-5.5", plan: "openrouter/anthropic/claude-opus-5.5", verify: "openrouter/google/gemini-3.8-flash" })
    // 只调了公开的模型列表，没有带 key 调任何接口
    expect(calls).toEqual(["https://openrouter.ai/api/v1/models no-key"])
  })

  it("可以重复执行：第二次什么都不变", async () => {
    const before = readFileSync(passwordFile, "utf8")
    const result = await run()
    expect(result).toEqual({ adminCreated: false, openrouter: "exists" })
    expect(readFileSync(passwordFile, "utf8")).toBe(before)
    expect(await db.select().from(t.users)).toHaveLength(1)
    expect(await db.select().from(t.modelProviders)).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it("连不上外网也不挡住启动：OpenRouter 下次再试", async () => {
    await db.delete(t.modelDefaults)
    await db.delete(t.modelProviders)
    fakeFetch.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed")
    })
    const result = await run()
    expect(result.openrouter).toBe("failed")
    expect(await db.select().from(t.modelProviders)).toHaveLength(0)
  })
})
