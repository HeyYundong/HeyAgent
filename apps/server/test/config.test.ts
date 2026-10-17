// M1 P2：配置写接口的集成测试（连真实的测试库，灌演示数据，林舟是主管、王悦是员工）。
// 覆盖：每个写接口能用；权限（员工改不了别人的任务、管不了用户）；审计记录；明文密钥被拒；同一家族的模型被拒；被使用的东西删不了。
import { and, desc, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

import * as t from "../src/db/schema.js"
import { decryptText } from "../src/lib/crypto.js"
import { login, mutate, query, setupApp, PASSWORD, type TestApp } from "./helpers.js"

// 引擎的两个对接函数：确认配置写完会调到（P1 实现真的逻辑）
const engine = vi.hoisted(() => ({ syncTaskSchedule: vi.fn(async () => {}), syncTodo: vi.fn(async () => {}) }))
vi.mock("../src/engine/api.js", () => ({ ...engine, startSession: vi.fn() }))

let ctx: TestApp
let lin: string
let wang: string

/** 模型服务的假接口：/models 返回 3 个能调工具的模型 + 1 个不能调工具的；/key 只认 sk-or-v1-good… */
const FAKE_MODELS = {
  data: [
    { id: "acme/alpha-1", name: "Acme: Alpha 1", context_length: 200_000, pricing: { prompt: "0.000001", completion: "0.000005" }, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools"] },
    { id: "zeta/beta-2", name: "Zeta: Beta 2", context_length: 128_000, pricing: { prompt: "0.0000005", completion: "0.000002" }, architecture: { input_modalities: ["text"] }, supported_parameters: ["tools", "tool_choice"] },
    { id: "zeta/beta-mini", name: "Zeta: Beta Mini", context_length: 64_000, pricing: { prompt: "0.0000001", completion: "0.0000004" }, supported_parameters: ["tools"] },
    { id: "acme/no-tools", name: "Acme: No Tools", context_length: 8_000, pricing: { prompt: "0", completion: "0" }, supported_parameters: ["temperature"] },
  ],
}
/** 直连 Claude 的假接口：GET /models 要对的 key；还有一个 OpenRouter 公开目录里查不到价格的模型 */
const FAKE_CLAUDE_KEY = "sk-ant-good-2222222222222"
const FAKE_CLAUDE_MODELS = {
  data: [
    { type: "model", id: "claude-sonnet-5-5", display_name: "Claude Sonnet 5.5", created_at: "2026-09-28T00:00:00Z", max_input_tokens: 1_000_000, max_tokens: 128_000, capabilities: { image_input: { supported: true } } },
    { type: "model", id: "claude-nova-9", display_name: "Claude Nova 9", created_at: "2026-09-01T00:00:00Z", max_input_tokens: 2_000_000, max_tokens: 128_000, capabilities: { image_input: { supported: false } } },
  ],
  has_more: false,
  first_id: "claude-sonnet-5-5",
  last_id: "claude-nova-9",
}
/** OpenRouter 公开目录（直连时查价格用） */
const FAKE_REFERENCE = {
  data: [{ id: "anthropic/claude-sonnet-5.5", name: "Anthropic: Claude Sonnet 5.5", context_length: 1_000_000, pricing: { prompt: "0.000002", completion: "0.00001" }, architecture: { input_modalities: ["text", "image"] }, supported_parameters: ["tools"] }],
}
const realFetch = globalThis.fetch
function fakeFetch(input: string | URL | Request, init?: RequestInit) {
  const url = String(input instanceof Request ? input.url : input)
  if (url === "https://openrouter.ai/api/v1/models") return Promise.resolve(Response.json(FAKE_REFERENCE))
  if (url.startsWith("https://claude.example/v1/models?")) {
    const headers = new Headers(init?.headers)
    const good = headers.get("x-api-key") === FAKE_CLAUDE_KEY && headers.get("anthropic-version") === "2023-06-01"
    return Promise.resolve(good ? Response.json(FAKE_CLAUDE_MODELS) : new Response("no", { status: 401 }))
  }
  if (url.startsWith("https://models.example/")) {
    if (url.endsWith("/models")) return Promise.resolve(Response.json(FAKE_MODELS))
    if (url.endsWith("/key")) {
      const auth = new Headers(init?.headers).get("authorization") ?? ""
      return Promise.resolve(auth.startsWith("Bearer sk-or-v1-good") ? Response.json({ data: { label: "x" } }) : new Response("no", { status: 401 }))
    }
    return Promise.resolve(new Response("not found", { status: 404 }))
  }
  return realFetch(input, init)
}

beforeAll(async () => {
  ctx = await setupApp()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  vi.stubGlobal("fetch", fakeFetch)
})
afterAll(async () => {
  vi.unstubAllGlobals()
  await ctx?.close()
})

/** 最近一条审计 */
async function lastAudit(action: string) {
  const [row] = await ctx.db.select().from(t.auditEvents).where(eq(t.auditEvents.action, action)).orderBy(desc(t.auditEvents.id)).limit(1)
  return row
}

const NEW_TASK = { title: "整理每周报表", goal: "报表发到群里", steps: [{ text: "读数据", wait: false }, { text: "等确认", wait: true, checkpoint: "收到确认" }], schedule: null, memoryIds: [], skillIds: [], toolIds: [], ruleIds: [] }

describe("没登录、没权限", () => {
  it("没登录调写接口返回 401", async () => {
    const res = await mutate(ctx.app, "memories.create", undefined, { content: "x", appliesTo: "y" })
    expect(res.status).toBe(401)
  })

  it("员工不能新建任务、不能改配置、不能管用户和设置", async () => {
    const cases: [string, unknown][] = [
      ["tasks.create", NEW_TASK],
      ["memories.create", { content: "一条经验", appliesTo: "公司经验" }],
      ["rules.create", { name: "规则", trigger: "什么时候", action: "怎么办" }],
      ["skills.create", { name: "技能", dept: "通用", description: "什么时候用", body: "# 手册" }],
      ["tools.createSecret", { name: "SOME_TOKEN", value: "v" }],
      ["users.create", { email: "x@heyagent.local", name: "某人", title: "", role: "user", password: "password-123" }],
      ["users.setDisabled", { id: "u-li", disabled: true }],
      ["settings.updateLimits", { maxCostUsd: 5, maxSteps: 10, eventFallbackDays: 3 }],
      ["models.setDefaults", { run: "a", plan: "b", verify: "c" }],
    ]
    for (const [path, input] of cases) {
      const res = await mutate(ctx.app, path, wang, input)
      expect(res.error?.data?.code, path).toBe("FORBIDDEN")
    }
    expect((await query(ctx.app, "users.list", wang)).error?.data?.code).toBe("FORBIDDEN")
    expect((await query(ctx.app, "settings.get", wang)).error?.data?.code).toBe("FORBIDDEN")
  })

  it("员工改不了别人负责的任务，能改自己负责的", async () => {
    const other = (await query(ctx.app, "tasks.get", wang, { id: "T-1031" })).data // 陈强负责
    const res = await mutate(ctx.app, "tasks.update", wang, { ...other, schedule: other.schedule ?? null, title: "改一下" })
    expect(res.error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "tasks.setEnabled", wang, { id: "T-1031", enabled: false })).error?.data?.code).toBe("FORBIDDEN")
    const own = (await query(ctx.app, "tasks.get", wang, { id: "T-1012" })).data // 王悦负责
    const ok = await mutate(ctx.app, "tasks.setEnabled", wang, { id: own.id, enabled: !own.enabled })
    expect(ok.error).toBeUndefined()
    await mutate(ctx.app, "tasks.setEnabled", wang, { id: own.id, enabled: own.enabled })
  })
})

describe("任务", () => {
  it("新建、修改、启停、删除；都记审计、都调 syncTaskSchedule", async () => {
    engine.syncTaskSchedule.mockClear()
    // M3：还没生效的规则（种子里白名单那条没翻译）建任务时选不了
    const inactive = await mutate(ctx.app, "tasks.create", lin, { ...NEW_TASK, ruleIds: ["rl-whitelist"] })
    expect(inactive.error?.message).toContain("还没生效")
    const created = await mutate(ctx.app, "tasks.create", lin, { ...NEW_TASK, schedule: { cron: "0 9 * * 1", text: "每周一 09:00" }, ruleIds: ["rl-verify"] })
    expect(created.error).toBeUndefined()
    const id = created.data.id as string
    expect(id).toMatch(/^T-\d+$/)
    const task = (await query(ctx.app, "tasks.get", lin, { id })).data
    expect(task).toMatchObject({ title: "整理每周报表", ownerId: "u-lin", modelId: "openrouter/anthropic/claude-sonnet-5.5", schedule: { cron: "0 9 * * 1" }, ruleIds: ["rl-verify"] })
    expect(task.steps).toEqual([
      { id: "s1", text: "读数据", wait: false },
      { id: "s2", text: "等确认", wait: true, checkpoint: "收到确认" },
    ])
    expect(task.nextRunAt).toBeDefined()
    expect(await lastAudit("task.create")).toMatchObject({ actorId: "u-lin", targetId: id })

    const updated = await mutate(ctx.app, "tasks.update", lin, { ...NEW_TASK, id, title: "整理每周报表（新）", schedule: null })
    expect(updated.error).toBeUndefined()
    expect((await query(ctx.app, "tasks.get", lin, { id })).data).toMatchObject({ title: "整理每周报表（新）", ruleIds: [] })
    expect((await lastAudit("task.update"))?.detail).toMatchObject({ changed: expect.arrayContaining(["title", "scheduleCron"]) })

    expect((await mutate(ctx.app, "tasks.setEnabled", lin, { id, enabled: false })).error).toBeUndefined()
    expect((await query(ctx.app, "tasks.get", lin, { id })).data.enabled).toBe(false)
    expect(await lastAudit("task.disable")).toMatchObject({ targetId: id })

    expect((await mutate(ctx.app, "tasks.delete", lin, { id })).error).toBeUndefined()
    expect((await query(ctx.app, "tasks.get", lin, { id })).status).toBe(404)
    expect(engine.syncTaskSchedule.mock.calls.map((call) => (call as unknown[])[1])).toEqual([id, id, id, id])
  })

  it("目标必填", async () => {
    const res = await mutate(ctx.app, "tasks.create", lin, { ...NEW_TASK, goal: "  " })
    expect(res.error?.data?.code).toBe("BAD_REQUEST")
  })

  it("执行模型和验收模型同一家：拒绝（没单独选模型时按默认模型判断）", async () => {
    const same = await mutate(ctx.app, "tasks.create", lin, { ...NEW_TASK, modelId: "openrouter/google/gemini-3.8-flash" })
    expect(same.error?.data?.code).toBe("BAD_REQUEST")
    expect(same.error?.message).toContain("同一家")
    const defaults = await mutate(ctx.app, "models.setDefaults", lin, { run: "openrouter/anthropic/claude-sonnet-5.5", plan: "openrouter/anthropic/claude-opus-5.5", verify: "openrouter/anthropic/claude-haiku-5.5" })
    expect(defaults.error?.data?.code).toBe("BAD_REQUEST")
    expect(defaults.error?.message).toContain("同一家")
  })

  it("有运行记录的任务不能删，提示只能停用", async () => {
    const res = await mutate(ctx.app, "tasks.delete", lin, { id: "T-1024" })
    expect(res.error?.data?.code).toBe("CONFLICT")
    expect(res.error?.message).toContain("停用")
  })
})

describe("记忆", () => {
  it("新建、修改、归档、删除", async () => {
    const created = await mutate(ctx.app, "memories.create", lin, { content: "周报用表格", appliesTo: "公司经验" })
    const id = created.data.id as string
    expect(id).toMatch(/^m-\d{3}$/)
    const memory = (await query(ctx.app, "memories.list", lin)).data.find((m: { id: string }) => m.id === id)
    expect(memory).toMatchObject({ status: "active", source: { kind: "human", byId: "u-lin" } })
    expect(await lastAudit("memory.create")).toMatchObject({ actorId: "u-lin", targetId: id })
    await mutate(ctx.app, "memories.update", lin, { id, content: "周报用表格，按周排", appliesTo: "公司经验" })
    expect(await lastAudit("memory.update")).toMatchObject({ targetId: id, detail: { changed: ["content"] } })
    await mutate(ctx.app, "memories.archive", lin, { id })
    expect((await query(ctx.app, "memories.list", lin)).data.find((m: { id: string }) => m.id === id).status).toBe("archived")
    expect((await mutate(ctx.app, "memories.delete", lin, { id })).error).toBeUndefined()
    expect(await lastAudit("memory.delete")).toMatchObject({ targetId: id })
  })

  it("被任务选用的记忆删不了", async () => {
    const used = (await query(ctx.app, "tasks.list", lin)).data.find((task: { memoryIds: string[] }) => task.memoryIds.length > 0)
    const res = await mutate(ctx.app, "memories.delete", lin, { id: used.memoryIds[0] })
    expect(res.error?.data?.code).toBe("CONFLICT")
    expect(res.error?.message).toContain(used.id)
  })

  it("待审核的记忆：只有审核人（或主管）能批，批了待办里那件事也处理掉", async () => {
    // m-007 分给 Emily 审核，王悦批不了
    expect((await mutate(ctx.app, "memories.approve", wang, { id: "m-007" })).error?.data?.code).toBe("FORBIDDEN")
    // m-008 分给王悦
    expect((await mutate(ctx.app, "memories.approve", wang, { id: "m-008" })).error).toBeUndefined()
    const [item] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.memoryId, "m-008"))
    expect(item).toMatchObject({ status: "resolved", resolvedById: "u-wang" })
    expect(await lastAudit("memory.approve")).toMatchObject({ actorId: "u-wang", targetId: "m-008" })
    expect((await mutate(ctx.app, "memories.reject", wang, { id: "m-009", reason: "网页来源，没核实" })).error).toBeUndefined()
    const [rejected] = await ctx.db.select().from(t.memories).where(eq(t.memories.id, "m-009"))
    expect(rejected!.status).toBe("rejected")
    expect((await mutate(ctx.app, "memories.approve", wang, { id: "m-008" })).error?.data?.code).toBe("CONFLICT")
  })
})

describe("技能", () => {
  it("新建是草稿；每次保存出新版本；发布、停用", async () => {
    const created = await mutate(ctx.app, "skills.create", lin, { name: "Weekly report", dept: "通用", description: "写周报时用", body: "## 步骤\n1. 汇总", toolIds: ["ask.human"] })
    const id = created.data.id as string
    expect(id).toBe("sk-weekly-report")
    let skill = (await query(ctx.app, "skills.list", lin)).data.find((s: { id: string }) => s.id === id)
    expect(skill).toMatchObject({ status: "draft", version: 1, toolIds: ["ask.human"] })
    await mutate(ctx.app, "skills.update", lin, { id, name: "Weekly report", dept: "通用", description: "写周报时用", body: "## 步骤\n1. 汇总\n2. 发出", toolIds: [] })
    skill = (await query(ctx.app, "skills.list", lin)).data.find((s: { id: string }) => s.id === id)
    expect(skill).toMatchObject({ version: 2, toolIds: [] })
    const versions = await ctx.db.select().from(t.skillVersions).where(eq(t.skillVersions.skillId, id))
    expect(versions.map((v) => v.version).sort()).toEqual([1, 2])
    expect(versions.find((v) => v.version === 1)!.body).toBe("## 步骤\n1. 汇总")
    await mutate(ctx.app, "skills.setStatus", lin, { id, status: "published" })
    expect(await lastAudit("skill.publish")).toMatchObject({ targetId: id })
    await mutate(ctx.app, "skills.setStatus", lin, { id, status: "disabled" })
    expect(await lastAudit("skill.disable")).toMatchObject({ targetId: id })
  })

  it("被任务选用的技能不能停用", async () => {
    const used = (await query(ctx.app, "tasks.list", lin)).data.find((task: { skillIds: string[] }) => task.skillIds.length > 0)
    const res = await mutate(ctx.app, "skills.setStatus", lin, { id: used.skillIds[0], status: "disabled" })
    expect(res.error?.data?.code).toBe("CONFLICT")
  })

  it("agent 的修改建议：批准时合并成新一版，拒绝时技能不变", async () => {
    const created = await mutate(ctx.app, "skills.create", lin, { name: "Merge check", dept: "通用", description: "测试", body: "## 步骤\n1. 第一步\n2. 第二步\n\n## 常见坑\n- 旧的坑", toolIds: [] })
    const id = created.data.id as string
    await ctx.db.insert(t.humanItems).values({ id: "ss-90", kind: "skill", title: "改技能", summary: "agent 提议", assigneeId: "u-wang", skillId: id, detail: { sections: [], primary: "通过", secondary: "拒绝" } })
    await ctx.db.insert(t.skillSuggestions).values({
      skillId: id,
      summary: "补一步",
      reviewerId: "u-wang",
      humanItemId: "ss-90",
      diff: [
        { variant: "default", text: "1. 第一步" },
        { variant: "added", text: "   先检查站点设置。" },
        { variant: "removed", text: "- 旧的坑" },
        { variant: "added", text: "- 新的坑" },
      ],
    })
    expect((await mutate(ctx.app, "skills.acceptSuggestion", lin, { id })).error).toBeUndefined()
    const [skill] = await ctx.db.select().from(t.skills).where(eq(t.skills.id, id))
    expect(skill!.version).toBe(2)
    expect(skill!.body).toBe("## 步骤\n1. 第一步\n   先检查站点设置。\n2. 第二步\n\n## 常见坑\n- 新的坑")
    const [item] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.id, "ss-90"))
    expect(item!.status).toBe("resolved")
    expect(await lastAudit("skill.suggestion.accept")).toMatchObject({ targetId: id })
    // 种子里的建议分给王悦：林舟（主管）也能拒绝
    expect((await mutate(ctx.app, "skills.rejectSuggestion", lin, { id: "sk-find-same", reason: "先不改" })).error).toBeUndefined()
    expect((await query(ctx.app, "skills.list", lin)).data.find((s: { id: string }) => s.id === "sk-find-same").suggestion).toBeUndefined()
  })
})

describe("规则", () => {
  it("新建、修改、没人用的删除和撤销", async () => {
    const created = await mutate(ctx.app, "rules.create", lin, { name: "Confirm before send", trigger: "要对外发消息时", action: "先让负责人确认", toolIds: ["ask.human"] })
    const id = created.data.id as string
    expect(id).toBe("rl-confirm-before-send")
    await mutate(ctx.app, "rules.update", lin, { id, name: "Confirm before send", trigger: "要对外发任何消息时", action: "先让负责人确认", toolIds: [] })
    expect((await query(ctx.app, "rules.list", lin)).data.find((r: { id: string }) => r.id === id)).toMatchObject({ trigger: "要对外发任何消息时", toolIds: [] })
    const removed = await mutate(ctx.app, "rules.delete", lin, { id })
    expect(removed.data).toMatchObject({ id, name: "Confirm before send" })
    expect(await lastAudit("rule.delete")).toMatchObject({ targetId: id })
    expect((await mutate(ctx.app, "rules.restore", lin, removed.data)).error).toBeUndefined()
    expect((await query(ctx.app, "rules.list", lin)).data.some((r: { id: string }) => r.id === id)).toBe(true)
  })

  it("被任务选用的规则删不了，提示被哪些任务用着", async () => {
    const res = await mutate(ctx.app, "rules.delete", lin, { id: "rl-verify" })
    expect(res.error?.data?.code).toBe("CONFLICT")
    expect(res.error?.message).toContain("T-1024")
  })
})

describe("工具和密钥", () => {
  const httpTool = {
    name: "查报价",
    description: "传入重量，返回报价。只在报价时用。",
    http: { method: "POST", url: "https://api.quotes.example/v1/quotes", headers: { "Content-Type": "application/json", Authorization: "Bearer {{QUOTES_TOKEN}}" }, body: '{"weight": "{weight}"}' },
    risk: "read",
    secrets: { QUOTES_TOKEN: "qt-secret-value-0001" },
  }

  it("URL、请求头、请求体里的明文密钥都被拒", async () => {
    const leaks = [
      { ...httpTool, http: { ...httpTool.http, headers: { Authorization: "Bearer sk_live_abcdefgh12345678" } }, secrets: {} },
      { ...httpTool, http: { ...httpTool.http, url: "https://api.quotes.example/v1/quotes?api_key=abcd1234efgh" }, secrets: {} },
      { ...httpTool, http: { ...httpTool.http, body: '{"token": "plain-token-value"}' } },
    ]
    for (const input of leaks) {
      const res = await mutate(ctx.app, "tools.createHttp", lin, input)
      expect(res.error?.data?.code).toBe("BAD_REQUEST")
      expect(res.error?.message).toContain("明文密钥")
    }
  })

  it("模板引用的密钥没填值：拒绝", async () => {
    const res = await mutate(ctx.app, "tools.createHttp", lin, { ...httpTool, secrets: {} })
    expect(res.error?.message).toContain("QUOTES_TOKEN")
  })

  it("新建 HTTP 工具：密钥只加密存，接口不返回原文；修改、删除、撤销", async () => {
    const created = await mutate(ctx.app, "tools.createHttp", lin, httpTool)
    expect(created.error).toBeUndefined()
    const id = created.data.id as string
    expect(id).toBe("http.quotes")
    const list = await query(ctx.app, "tools.list", lin)
    expect(JSON.stringify(list.data)).not.toContain("qt-secret-value-0001")
    expect(list.data.savedSecrets.QUOTES_TOKEN).toMatchObject({ byId: "u-lin" })
    const [row] = await ctx.db.select().from(t.secrets).where(and(eq(t.secrets.scope, "http_tool"), eq(t.secrets.name, "QUOTES_TOKEN")))
    expect(JSON.stringify(row)).not.toContain("qt-secret-value-0001")
    expect(decryptText(ctx.keyring, row!.enc, { table: "secrets", id: row!.id, version: row!.version })).toBe("qt-secret-value-0001")
    expect((await lastAudit("tool.create"))?.detail).toMatchObject({ secretsSet: ["QUOTES_TOKEN"] })
    expect(JSON.stringify((await lastAudit("tool.create"))?.detail)).not.toContain("qt-secret")

    // 改说明，不重新填密钥（用已存的）
    const updated = await mutate(ctx.app, "tools.updateHttp", lin, { ...httpTool, id, description: "新的说明。", secrets: {} })
    expect(updated.error).toBeUndefined()
    // 换密钥值：版本号 +1
    await mutate(ctx.app, "tools.updateSecret", lin, { name: "QUOTES_TOKEN", value: "qt-secret-value-0002" })
    const [after] = await ctx.db.select().from(t.secrets).where(eq(t.secrets.id, row!.id))
    expect(after!.version).toBe(2)
    expect(decryptText(ctx.keyring, after!.enc, { table: "secrets", id: after!.id, version: 2 })).toBe("qt-secret-value-0002")
    // 工具还在用这个密钥：密钥删不了
    expect((await mutate(ctx.app, "tools.deleteSecret", lin, { name: "QUOTES_TOKEN" })).error?.data?.code).toBe("CONFLICT")

    const removed = await mutate(ctx.app, "tools.deleteHttp", lin, { id })
    expect(removed.data).toMatchObject({ id, source: "http" })
    expect((await mutate(ctx.app, "tools.restoreHttp", lin, removed.data)).error).toBeUndefined()
    await mutate(ctx.app, "tools.deleteHttp", lin, { id })
    expect((await mutate(ctx.app, "tools.deleteSecret", lin, { name: "QUOTES_TOKEN" })).error).toBeUndefined()
    expect(await lastAudit("secret.delete")).toMatchObject({ targetId: "QUOTES_TOKEN" })
  })

  it("被任务选用的工具删不了；内置工具不能改", async () => {
    const used = (await query(ctx.app, "tasks.list", lin)).data.flatMap((task: { toolIds: string[] }) => task.toolIds)
    const tools = (await query(ctx.app, "tools.list", lin)).data.tools as { id: string; source: string }[]
    const httpUsed = tools.find((tool) => tool.source === "http" && used.includes(tool.id))!
    const res = await mutate(ctx.app, "tools.deleteHttp", lin, { id: httpUsed.id })
    expect(res.error?.data?.code).toBe("CONFLICT")
    expect(res.error?.message).toContain("任务")
    const builtin = tools.find((tool) => tool.source === "builtin")!
    expect((await mutate(ctx.app, "tools.deleteHttp", lin, { id: builtin.id })).error?.data?.code).toBe("BAD_REQUEST")
  })

  it("MCP 服务器：命令里有明文密钥被拒；环境变量加密存；编辑时不填值就保留；删除时密文一起删", async () => {
    const leak = await mutate(ctx.app, "tools.createMcpServer", lin, { name: "Files", transport: "stdio", command: "npx files-mcp --token sk_live_abcdefgh12345678", env: [] })
    expect(leak.error?.message).toContain("明文密钥")
    const created = await mutate(ctx.app, "tools.createMcpServer", lin, {
      name: "Files",
      transport: "stdio",
      command: "npx -y files-mcp",
      env: [{ name: "FILES_TOKEN", value: "files-secret-1" }],
      tools: [{ id: "files.read", name: "读文件", summary: "读一个文件", risk: "read" }],
    })
    expect(created.error).toBeUndefined()
    const id = created.data.id as string
    const list = (await query(ctx.app, "tools.list", lin)).data
    expect(list.mcpServers.find((s: { id: string }) => s.id === id)).toMatchObject({ env: "FILES_TOKEN=••••", command: "npx -y files-mcp" })
    expect(list.tools.find((tool: { id: string }) => tool.id === "files.read")).toMatchObject({ source: "mcp", serverId: id })
    expect(JSON.stringify(list)).not.toContain("files-secret-1")
    // 不填值：保留；去掉 tools 里的工具：删掉
    expect((await mutate(ctx.app, "tools.updateMcpServer", lin, { id, name: "Files", transport: "stdio", command: "npx -y files-mcp", env: [{ name: "FILES_TOKEN" }], tools: [] })).error).toBeUndefined()
    const secrets = await ctx.db.select().from(t.secrets).where(and(eq(t.secrets.scope, "mcp_env"), eq(t.secrets.refId, id)))
    expect(secrets).toHaveLength(1)
    expect((await query(ctx.app, "tools.list", lin)).data.tools.some((tool: { id: string }) => tool.id === "files.read")).toBe(false)
    expect((await mutate(ctx.app, "tools.deleteMcpServer", lin, { id })).error).toBeUndefined()
    expect(await ctx.db.select().from(t.secrets).where(and(eq(t.secrets.scope, "mcp_env"), eq(t.secrets.refId, id)))).toHaveLength(0)
    expect(await lastAudit("mcp_server.delete")).toMatchObject({ targetId: id })
  })
})

describe("浏览器", () => {
  it("Chrome（代理密码进 secrets）、平台、账号的增删改", async () => {
    const created = await mutate(ctx.app, "browsers.create", lin, { name: "Office Chrome", description: "办公室出口", proxy: { kind: "socks5", host: "10.0.0.8", port: 1080, username: "u", password: "proxy-pass-1" } })
    expect(created.error).toBeUndefined()
    const id = created.data.id as string
    let profile = (await query(ctx.app, "browsers.list", lin)).data.find((b: { id: string }) => b.id === id)
    expect(profile.proxy).toMatchObject({ kind: "socks5", host: "10.0.0.8", port: 1080, username: "u", hasPassword: true })
    expect(JSON.stringify(profile)).not.toContain("proxy-pass-1")
    const platform = await mutate(ctx.app, "platforms.create", lin, { name: "Example Shop" })
    expect(platform.data.id).toBe("example-shop")
    const account = await mutate(ctx.app, "browsers.createAccount", lin, { profileId: id, platformId: "example-shop", account: "ops@example.com", maxConcurrent: 2 })
    expect(account.error).toBeUndefined()
    await mutate(ctx.app, "browsers.updateAccount", lin, { id: account.data.id, maxConcurrent: 1 })
    profile = (await query(ctx.app, "browsers.list", lin)).data.find((b: { id: string }) => b.id === id)
    expect(profile.sites).toEqual([expect.objectContaining({ platformId: "example-shop", account: "ops@example.com", maxConcurrent: 1, status: "expired" })])
    // 平台下还有账号：删不了
    expect((await mutate(ctx.app, "platforms.delete", lin, { id: "example-shop" })).error?.data?.code).toBe("CONFLICT")
    // 不用代理了：密码一起删
    await mutate(ctx.app, "browsers.update", lin, { id, name: "Office Chrome", description: "办公室出口", proxy: { kind: "none" } })
    expect(await ctx.db.select().from(t.secrets).where(and(eq(t.secrets.scope, "browser_proxy"), eq(t.secrets.refId, id)))).toHaveLength(0)
    await mutate(ctx.app, "browsers.deleteAccount", lin, { id: account.data.id })
    expect((await mutate(ctx.app, "platforms.delete", lin, { id: "example-shop" })).error).toBeUndefined()
    expect((await mutate(ctx.app, "browsers.delete", lin, { id })).error).toBeUndefined()
    expect(await lastAudit("browser_profile.delete")).toMatchObject({ targetId: id })
  })

  it("出口地、时区、语言：没填出口地就空着；时区、语言存规范写法，写错拦下", async () => {
    const plain = await mutate(ctx.app, "browsers.create", lin, { name: "Plain Chrome", proxy: { kind: "none" } })
    const list = async () => (await query(ctx.app, "browsers.list", lin)).data as { id: string; exitIp: string; timezone?: string; locale?: string }[]
    expect((await list()).find((b) => b.id === plain.data.id)).toMatchObject({ exitIp: "" })
    expect((await list()).find((b) => b.id === plain.data.id)?.timezone).toBeUndefined()

    const created = await mutate(ctx.app, "browsers.create", lin, { name: "London Chrome", proxy: { kind: "none" }, exitIp: "英国 · 伦敦", timezone: "europe/london", locale: "en-gb" })
    expect(created.error).toBeUndefined()
    const id = created.data.id as string
    expect((await list()).find((b) => b.id === id)).toMatchObject({ exitIp: "英国 · 伦敦", timezone: "Europe/London", locale: "en-GB" })
    expect((await mutate(ctx.app, "browsers.update", lin, { id, name: "London Chrome", proxy: { kind: "none" }, timezone: "Mars/Olympus" })).error?.data?.code).toBe("BAD_REQUEST")
    expect((await mutate(ctx.app, "browsers.update", lin, { id, name: "London Chrome", proxy: { kind: "none" }, locale: "en-GB,en" })).error?.data?.code).toBe("BAD_REQUEST")
    // 不传出口地 = 不改；传空 = 清掉
    await mutate(ctx.app, "browsers.update", lin, { id, name: "London Chrome", proxy: { kind: "none" }, timezone: "Europe/London", locale: "en-GB" })
    expect((await list()).find((b) => b.id === id)).toMatchObject({ exitIp: "英国 · 伦敦" })
    await mutate(ctx.app, "browsers.update", lin, { id, name: "London Chrome", proxy: { kind: "none" }, exitIp: "" })
    expect((await list()).find((b) => b.id === id)).toMatchObject({ exitIp: "" })
    await mutate(ctx.app, "browsers.delete", lin, { id })
    await mutate(ctx.app, "browsers.delete", lin, { id: plain.data.id })
  })

  it("有 session 正在用它的账号时，Chrome 删不了", async () => {
    const res = await mutate(ctx.app, "browsers.delete", lin, { id: "br-us" })
    expect(res.error?.data?.code).toBe("CONFLICT")
  })
})

describe("模型", () => {
  it("加服务：先连一次，key 不对就不存；连上了读出能调工具的模型，key 只存密文", async () => {
    const bad = await mutate(ctx.app, "models.createProvider", lin, { kind: "openrouter", baseUrl: "https://models.example/api/v1", apiKey: "sk-or-v1-wrong-0000000000" })
    expect(bad.error?.message).toContain("API Key 不对")
    const created = await mutate(ctx.app, "models.createProvider", lin, { kind: "openrouter", baseUrl: "https://models.example/api/v1", apiKey: "sk-or-v1-good-1111111111111" })
    expect(created.error).toBeUndefined()
    const id = created.data.id as string
    expect(id).toBe("openrouter-2")
    const overview = (await query(ctx.app, "models.overview", lin)).data
    const provider = overview.providers.find((p: { id: string }) => p.id === id)
    expect(provider.models.map((m: { id: string }) => m.id)).toEqual([`${id}/acme/alpha-1`, `${id}/zeta/beta-2`, `${id}/zeta/beta-mini`])
    expect(provider.models[0]).toMatchObject({ name: "Alpha 1", contextK: 200, priceIn: 1, priceOut: 5, vision: true })
    expect(provider.apiKeyMasked).toBe("sk-or-v1-••••••••1111")
    expect(JSON.stringify(overview)).not.toContain("sk-or-v1-good-1111111111111")

    expect((await mutate(ctx.app, "models.testProvider", lin, { id })).data).toMatchObject({ ok: true })
    expect((await mutate(ctx.app, "models.refreshProvider", lin, { id })).data).toMatchObject({ ok: true, models: 3 })

    const defaults = { run: `${id}/acme/alpha-1`, plan: `${id}/zeta/beta-2`, verify: `${id}/zeta/beta-mini` }
    expect((await mutate(ctx.app, "models.setDefaults", lin, defaults)).error).toBeUndefined()
    expect((await query(ctx.app, "models.overview", lin)).data.defaults).toEqual(defaults)
    expect(await lastAudit("model_defaults.update")).toMatchObject({ actorId: "u-lin" })

    // 默认设置在用它的模型：删除时换成别家的
    const removed = await mutate(ctx.app, "models.deleteProvider", lin, { id })
    expect(removed.error).toBeUndefined()
    const after = (await query(ctx.app, "models.overview", lin)).data.defaults
    expect(after.run.startsWith(`${id}/`)).toBe(false)
  })

  it("直连 Claude：列模型要带 key（不对就不存），价格到 OpenRouter 公开目录查，查不到的给提醒；刷新也带 key", async () => {
    const noKey = await mutate(ctx.app, "models.createProvider", lin, { kind: "anthropic", baseUrl: "https://claude.example/v1" })
    expect(noKey.error?.message).toContain("填 Claude 的 API Key")
    const bad = await mutate(ctx.app, "models.createProvider", lin, { kind: "anthropic", baseUrl: "https://claude.example/v1", apiKey: "sk-ant-wrong-0000000000" })
    expect(bad.error?.message).toContain("API Key 不对（Claude 返回 401）")
    const created = await mutate(ctx.app, "models.createProvider", lin, { kind: "anthropic", baseUrl: "https://claude.example/v1/", apiKey: FAKE_CLAUDE_KEY })
    expect(created.error).toBeUndefined()
    expect(created.data).toMatchObject({ id: "anthropic", check: { ok: true, models: 2, note: expect.stringContaining("1 个模型") } })

    const overview = (await query(ctx.app, "models.overview", lin)).data
    const provider = overview.providers.find((p: { id: string }) => p.id === "anthropic")
    expect(provider).toMatchObject({ kind: "anthropic", name: "Claude", baseUrl: "https://claude.example/v1", status: "ok" })
    expect(provider.models).toMatchObject([
      { id: "anthropic/claude-sonnet-5-5", name: "Claude Sonnet 5.5", contextK: 1000, priceIn: 2, priceOut: 10, vision: true },
      { id: "anthropic/claude-nova-9", name: "Claude Nova 9", contextK: 2000, priceIn: 0, priceOut: 0, vision: false },
    ])
    expect(JSON.stringify(overview)).not.toContain(FAKE_CLAUDE_KEY)

    // 刷新、测试连接都用存着的 key（假接口没 key 会回 401）
    expect((await mutate(ctx.app, "models.refreshProvider", lin, { id: "anthropic" })).data).toMatchObject({ ok: true, models: 2 })
    expect((await mutate(ctx.app, "models.testProvider", lin, { id: "anthropic" })).data).toMatchObject({ ok: true })

    // 直连的 Claude 和 OpenRouter 上的 Claude 是同一家：不能一个执行一个验收
    const same = await mutate(ctx.app, "models.setDefaults", lin, { run: "anthropic/claude-sonnet-5-5", plan: "anthropic/claude-sonnet-5-5", verify: "openrouter/anthropic/claude-haiku-5.5" })
    expect(same.error?.message).toContain("同一家（Anthropic）")
    expect((await mutate(ctx.app, "models.deleteProvider", lin, { id: "anthropic" })).error).toBeUndefined()
  })

  it("有任务在用它的模型：服务删不了", async () => {
    const res = await mutate(ctx.app, "models.deleteProvider", lin, { id: "openrouter" })
    expect(res.error?.data?.code).toBe("CONFLICT")
  })
})

describe("人加的待办", () => {
  it("新建、修改、删除；调 syncTodo；只有加的人能改", async () => {
    engine.syncTodo.mockClear()
    const created = await mutate(ctx.app, "todos.create", wang, { taskId: "T-1012", title: "明早看一眼回复", trigger: { kind: "time", at: "2026-10-18T10:00" } })
    expect(created.error).toBeUndefined()
    const id = created.data.id as string
    let todo = (await query(ctx.app, "todos.board", wang)).data.humanTodos.find((each: { id: string }) => each.id === id)
    expect(todo).toMatchObject({ taskId: "T-1012", createdById: "u-wang", trigger: { kind: "time", at: "2026-10-18T02:00:00.000Z" } })
    // 员工不能给别人的任务加待办
    expect((await mutate(ctx.app, "todos.create", wang, { taskId: "T-1031", title: "x", trigger: { kind: "event", event: "收到回复", fallbackDays: 7 } })).error?.data?.code).toBe("FORBIDDEN")
    await mutate(ctx.app, "todos.update", wang, { id, taskId: "T-1012", title: "每个工作日看一眼", trigger: { kind: "cron", cron: "0 10 * * 1-5", text: "每个工作日 10:00" } })
    todo = (await query(ctx.app, "todos.board", wang)).data.humanTodos.find((each: { id: string }) => each.id === id)
    expect(todo.trigger).toMatchObject({ kind: "cron", cron: "0 10 * * 1-5", text: "每个工作日 10:00" })
    // 李静不是加这条的人：改不了
    const li = await login(ctx.app, "lijing@heyagent.local")
    expect((await mutate(ctx.app, "todos.delete", li, { id })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "todos.delete", wang, { id })).error).toBeUndefined()
    expect(engine.syncTodo.mock.calls.map((call) => (call as unknown[])[1])).toEqual([id, id, id])
    expect(await lastAudit("todo.delete")).toMatchObject({ actorId: "u-wang", targetId: id })
  })

  it("cron 写错：拒绝", async () => {
    const res = await mutate(ctx.app, "todos.create", wang, { taskId: "T-1012", title: "x", trigger: { kind: "cron", cron: "every day" } })
    expect(res.error?.data?.code).toBe("BAD_REQUEST")
  })
})

describe("用户", () => {
  it("主管建账号，新用户能登录；改资料；停用后登录不了，启用后又能登录；重置密码", async () => {
    const created = await mutate(ctx.app, "users.create", lin, { email: "New.Person@heyagent.local", name: "新同事", title: "助理", role: "user", password: "first-password-1" })
    expect(created.error).toBeUndefined()
    const id = created.data.id as string
    const list = (await query(ctx.app, "users.list", lin)).data
    expect(list.find((u: { id: string }) => u.id === id)).toMatchObject({ email: "new.person@heyagent.local", name: "新同事", title: "助理", isAdmin: false, disabled: false })
    expect(await lastAudit("user.create")).toMatchObject({ actorId: "u-lin", targetId: id })
    const cookie = await login(ctx.app, "new.person@heyagent.local", "first-password-1")
    expect((await query(ctx.app, "me.get", cookie)).data).toMatchObject({ name: "新同事", title: "助理", isAdmin: false })
    // 邮箱重复
    expect((await mutate(ctx.app, "users.create", lin, { email: "new.person@heyagent.local", name: "x", title: "", role: "user", password: "first-password-1" })).error?.message).toContain("已经有账号")

    await mutate(ctx.app, "users.update", lin, { id, name: "新同事", title: "专员", role: "user" })
    expect((await query(ctx.app, "users.list", lin)).data.find((u: { id: string }) => u.id === id).title).toBe("专员")

    expect((await mutate(ctx.app, "users.setDisabled", lin, { id, disabled: true })).error).toBeUndefined()
    await expect(login(ctx.app, "new.person@heyagent.local", "first-password-1")).rejects.toThrow()
    expect((await query(ctx.app, "me.get", cookie)).status).toBe(401)
    await mutate(ctx.app, "users.setDisabled", lin, { id, disabled: false })
    await login(ctx.app, "new.person@heyagent.local", "first-password-1")

    expect((await mutate(ctx.app, "users.resetPassword", lin, { id, password: "second-password-2" })).error).toBeUndefined()
    await expect(login(ctx.app, "new.person@heyagent.local", "first-password-1")).rejects.toThrow()
    await login(ctx.app, "new.person@heyagent.local", "second-password-2")
    expect(await lastAudit("user.reset_password")).toMatchObject({ targetId: id })
  })

  it("主管不能停用自己、不能取消自己的主管身份", async () => {
    expect((await mutate(ctx.app, "users.setDisabled", lin, { id: "u-lin", disabled: true })).error?.data?.code).toBe("BAD_REQUEST")
    expect((await mutate(ctx.app, "users.update", lin, { id: "u-lin", name: "林舟", title: "运营主管", role: "user" })).error?.data?.code).toBe("BAD_REQUEST")
  })

  it("改自己的密码：现在的密码不对就不改；改了以后用新密码登录，当前会话还在", async () => {
    const chen = await login(ctx.app, "chenqiang@heyagent.local")
    expect((await mutate(ctx.app, "me.changePassword", chen, { currentPassword: "wrong-password", newPassword: "chen-new-password" })).error?.message).toContain("现在的密码不对")
    expect((await mutate(ctx.app, "me.changePassword", chen, { currentPassword: PASSWORD, newPassword: "chen-new-password" })).error).toBeUndefined()
    expect((await query(ctx.app, "me.get", chen)).status).toBe(200)
    await expect(login(ctx.app, "chenqiang@heyagent.local")).rejects.toThrow()
    await login(ctx.app, "chenqiang@heyagent.local", "chen-new-password")
    expect(await lastAudit("user.change_password")).toMatchObject({ actorId: "u-chen" })
  })
})

describe("全局设置", () => {
  it("上限、外部事件令牌（只存 sha256）、通知渠道（地址进 secrets）", async () => {
    let view = (await query(ctx.app, "settings.get", lin)).data
    expect(view).toMatchObject({ maxCostUsd: 2, maxSteps: 100, eventFallbackDays: 7, channels: [] })
    await mutate(ctx.app, "settings.updateLimits", lin, { maxCostUsd: 5, maxSteps: 50, eventFallbackDays: 3 })
    const [cost] = await ctx.db.select().from(t.settings).where(eq(t.settings.key, "session.maxCostUsd"))
    expect(cost!.value).toBe(5)
    expect(await lastAudit("settings.update")).toMatchObject({ actorId: "u-lin" })

    const token = (await mutate(ctx.app, "settings.regenerateEventToken", lin)).data
    expect(token.token).toMatch(/^hae_/)
    const [stored] = await ctx.db.select().from(t.settings).where(eq(t.settings.key, "events.token"))
    expect(JSON.stringify(stored!.value)).not.toContain(token.token)
    view = (await query(ctx.app, "settings.get", lin)).data
    expect(view.eventToken.hint).toBe(token.token.slice(-4))
    expect(JSON.stringify(view)).not.toContain(token.token)

    const channel = await mutate(ctx.app, "settings.saveChannel", lin, { name: "运营群", kind: "feishu", url: "https://hooks.example/hook/abcdef0123456789", enabled: true })
    expect(channel.error).toBeUndefined()
    view = (await query(ctx.app, "settings.get", lin)).data
    expect(view.channels).toEqual([expect.objectContaining({ name: "运营群", kind: "feishu", enabled: true, urlSecretName: expect.stringMatching(/^NOTIFY_CH_[A-F0-9]+_URL$/) })])
    expect(JSON.stringify(view)).not.toContain("abcdef0123456789")
    // 通知渠道的地址不出现在工具页的密钥里
    expect(Object.keys((await query(ctx.app, "tools.list", lin)).data.savedSecrets).some((name) => name.startsWith("NOTIFY_"))).toBe(false)
    await mutate(ctx.app, "settings.deleteChannel", lin, { id: channel.data.id })
    expect((await query(ctx.app, "settings.get", lin)).data.channels).toEqual([])
  })
})
