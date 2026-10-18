// M1 P2：空白正式环境的初始化。空库上跑 bootstrap：不建任何账号（管理员由第一个打开控制台的人设置，见 setup.test.ts），
// 写默认设置，按 .env 的 OpenRouter key 接入模型服务（只用公开的模型列表接口），不灌任何演示数据；再跑一次什么都不变。
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { count, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import { bootstrap, retryOpenRouterInBackground } from "../src/bootstrap/index.js"
import { createDb } from "../src/db/client.js"
import * as t from "../src/db/schema.js"
import { BUILTIN_TOOLS } from "../src/engine/tools/builtin-defs.js"
import { env } from "../src/env.js"
import { decryptText } from "../src/lib/crypto.js"
import { resetTestDatabase, tempKeyring, testDatabaseUrl } from "./helpers.js"

const FAKE_KEY = "sk-or-v1-bootstrap-test-key-0000000000"
const catalog = {
  data: ["anthropic/claude-sonnet-5.5", "anthropic/claude-opus-5.5", "google/gemini-3.8-flash", "qwen/qwen3.8-flash"].map((id) => ({
    id,
    name: id,
    context_length: 1_000_000,
    pricing: { prompt: "0.000001", completion: "0.000002" },
    supported_parameters: ["tools"],
    // 只有最后一个能看图：比图的默认标准用它
    ...(id === "qwen/qwen3.8-flash" ? { architecture: { input_modalities: ["text", "image"] } } : {}),
  })),
}
const embeddingCatalog = {
  data: [
    { id: "google/gemini-embedding-2", name: "Google: Gemini Embedding 2", context_length: 8192, pricing: { prompt: "0.0000002" }, architecture: { input_modalities: ["text", "image"] } },
    { id: "openai/text-embedding-3-small", name: "OpenAI: Text Embedding 3 Small", context_length: 8192, pricing: { prompt: "0.00000002" }, architecture: { input_modalities: ["text"] } },
  ],
}
const calls: string[] = []
const fakeFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input instanceof Request ? input.url : input)
  calls.push(`${url} ${new Headers(init?.headers).has("authorization") ? "with-key" : "no-key"}`)
  if (url === "https://openrouter.ai/api/v1/models") return Response.json(catalog)
  if (url === "https://openrouter.ai/api/v1/embeddings/models") return Response.json(embeddingCatalog)
  return new Response("unexpected", { status: 500 })
})

const url = testDatabaseUrl()
const { db, pool } = createDb(url, 3)
const keyring = tempKeyring()
const logs: string[] = []

beforeAll(async () => {
  await resetTestDatabase(url)
  vi.stubGlobal("fetch", fakeFetch)
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await pool.end()
})

const run = () => bootstrap(db, { keyring, openrouterApiKey: FAKE_KEY, log: (message) => logs.push(message) })

describe("空白环境初始化", () => {
  it("不建任何账号：等第一个打开控制台的人设置管理员；日志里提示去设置，没有 key", async () => {
    const result = await run()
    expect(result).toEqual({ setupNeeded: true, openrouter: "created" })
    expect(await db.select().from(t.users)).toHaveLength(0)
    expect(logs.some((message) => message.includes("设置管理员"))).toBe(true)
    expect(logs.join("\n")).not.toContain(FAKE_KEY)
  })

  it("没有任何演示数据：任务、记忆、技能、规则、工具（内置的除外）、MCP、浏览器、平台、待办、session 都是空的", async () => {
    // 内置工具由 bootstrap 同步进 tools 表（M1 P3）：worker 还没起时工具页也能看到
    const tools = await db.select({ id: t.tools.id, source: t.tools.source }).from(t.tools)
    // 另加 M2 的「浏览器」、图库的「图库」、比图的「比图」（选了它们就开放整组工具）
    expect(tools.map((tool) => tool.id).sort()).toEqual([...BUILTIN_TOOLS.map((tool) => tool.id), "browser", "gallery", "compare"].sort())
    expect(tools.every((tool) => tool.source === "builtin")).toBe(true)
    const tables = { tasks: t.tasks, memories: t.memories, skills: t.skills, rules: t.rules, mcpServers: t.mcpServers, browserProfiles: t.browserProfiles, platforms: t.platforms, humanTodos: t.humanTodos, humanItems: t.humanItems, sessions: t.sessions }
    for (const [name, table] of Object.entries(tables)) {
      const [row] = await db.select({ n: count() }).from(table)
      expect(row!.n, name).toBe(0)
    }
  })

  it("按 .env 的 key 接入 OpenRouter：key 加密存，模型列表只用公开接口，默认模型（含图库的 embedding 模型）设好", async () => {
    const providers = await db.select().from(t.modelProviders)
    expect(providers).toEqual([expect.objectContaining({ id: "openrouter", kind: "openrouter", status: "ok", baseUrl: "https://openrouter.ai/api/v1" })])
    const [secret] = await db.select().from(t.secrets)
    expect(JSON.stringify(secret)).not.toContain(FAKE_KEY)
    expect(decryptText(keyring, secret!.enc, { table: "secrets", id: secret!.id, version: secret!.version })).toBe(FAKE_KEY)
    const defaults = Object.fromEntries((await db.select().from(t.modelDefaults)).map((row) => [row.role, row.modelId]))
    expect(defaults).toEqual({
      run: "openrouter/anthropic/claude-sonnet-5.5",
      plan: "openrouter/anthropic/claude-opus-5.5",
      verify: "openrouter/google/gemini-3.8-flash",
      embed: "openrouter/google/gemini-embedding-2",
    })
    const embeddings = await db.select({ id: t.models.id, vision: t.models.vision }).from(t.models).where(eq(t.models.kind, "embedding"))
    expect(embeddings.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: "openrouter/google/gemini-embedding-2", vision: true },
      { id: "openrouter/openai/text-embedding-3-small", vision: false },
    ])
    // 比图的默认标准：模型是能看图的那个
    expect(await db.select({ id: t.compareStandards.id, modelId: t.compareStandards.modelId, isDefault: t.compareStandards.isDefault }).from(t.compareStandards)).toEqual([
      { id: "std-same-item", modelId: "openrouter/qwen/qwen3.8-flash", isDefault: true },
    ])
    // 只调了公开的模型列表（聊天模型、embedding 模型各一次），没有带 key 调任何接口
    expect(calls).toEqual(["https://openrouter.ai/api/v1/models no-key", "https://openrouter.ai/api/v1/embeddings/models no-key"])
  })

  it("可以重复执行：第二次什么都不变", async () => {
    const result = await run()
    expect(result).toEqual({ setupNeeded: true, openrouter: "exists" })
    expect(await db.select().from(t.users)).toHaveLength(0)
    expect(await db.select().from(t.modelProviders)).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(await db.select().from(t.tools)).toHaveLength(BUILTIN_TOOLS.length + 3)
    expect(await db.select().from(t.compareStandards)).toHaveLength(1)
  })

  it("升级前建的环境（没有 embedding 模型、没设图库的模型）：刷新一次列表，设上默认 embedding 模型；主管清空以后不再改回来", async () => {
    await db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "embed"))
    await db.delete(t.models).where(eq(t.models.kind, "embedding"))
    calls.length = 0
    await run()
    expect(calls).toEqual(["https://openrouter.ai/api/v1/models no-key", "https://openrouter.ai/api/v1/embeddings/models no-key"])
    const [embed] = await db.select().from(t.modelDefaults).where(eq(t.modelDefaults.role, "embed"))
    expect(embed?.modelId).toBe("openrouter/google/gemini-embedding-2")
    expect(logs.some((message) => message.includes("图库的 embedding 模型设成了"))).toBe(true)
    // 主管把它清空了：已经有 embedding 模型，重启不再动
    await db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "embed"))
    calls.length = 0
    await run()
    expect(calls).toEqual([])
    expect(await db.select().from(t.modelDefaults).where(eq(t.modelDefaults.role, "embed"))).toHaveLength(0)
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

  it("启动时没接上 OpenRouter：后台自动重试，接上为止，不用等下次重启", async () => {
    await db.delete(t.modelDefaults)
    await db.delete(t.modelProviders)
    // 前两次连不上，第三次才通
    fakeFetch.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed")
    })
    fakeFetch.mockImplementationOnce(async () => {
      throw new TypeError("fetch failed")
    })
    const options = { keyring, openrouterApiKey: FAKE_KEY, log: (message: string) => logs.push(message) }
    const result = await bootstrap(db, options)
    expect(result.openrouter).toBe("failed")
    const stop = retryOpenRouterInBackground(db, options, [20, 20])
    try {
      const deadline = Date.now() + 10_000
      let providers = await db.select().from(t.modelProviders)
      while (providers.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50))
        providers = await db.select().from(t.modelProviders)
      }
      expect(providers).toEqual([expect.objectContaining({ kind: "openrouter", status: "ok" })])
      expect(logs.some((message) => message.includes("稍后会自动重试"))).toBe(true)
    } finally {
      stop()
    }
  })
})

describe("OpenRouter 的 key 从文件读（OPENROUTER_API_KEY_FILE，整套 pod 里用）", () => {
  const saved = { file: process.env.OPENROUTER_API_KEY_FILE, key: process.env.OPENROUTER_API_KEY }
  afterAll(() => {
    for (const [name, value] of [["OPENROUTER_API_KEY_FILE", saved.file], ["OPENROUTER_API_KEY", saved.key]] as const) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
  })

  it("文件优先；文件读不到时退回 OPENROUTER_API_KEY", () => {
    const file = join(mkdtempSync(join(tmpdir(), "heyagent-or-")), "openrouter-key")
    writeFileSync(file, "sk-or-from-file\n", { mode: 0o400 })
    process.env.OPENROUTER_API_KEY = "sk-or-from-env"
    process.env.OPENROUTER_API_KEY_FILE = file
    expect(env.openrouterApiKey).toBe("sk-or-from-file")
    process.env.OPENROUTER_API_KEY_FILE = join(tmpdir(), "heyagent-no-such-key-file")
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {})
    expect(env.openrouterApiKey).toBe("sk-or-from-env")
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    delete process.env.OPENROUTER_API_KEY_FILE
    delete process.env.OPENROUTER_API_KEY
    expect(env.openrouterApiKey).toBeUndefined()
  })
})
