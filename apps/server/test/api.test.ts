import { summarizeEvents, type SessionRun, type SessionSummary } from "@heyagent/shared"
import { eq, inArray, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { decryptText } from "../src/lib/crypto.js"
import { SEED_COOKIE_PREFIX, SEED_SECRET_VALUES, seedDemo } from "../src/seed/seed.js"
import { PASSWORD, login, query, setupApp, TEST_REVIEW_MODEL, type TestApp } from "./helpers.js"

const QUERIES = [
  "me.get", "staff.list", "platforms.list", "tasks.list", "sessions.list", "todos.board",
  "memories.list", "skills.list", "rules.list", "tools.list", "browsers.list", "models.overview",
]

let ctx: TestApp
let lin: string
let wang: string

beforeAll(async () => {
  ctx = await setupApp()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
})
afterAll(async () => {
  await ctx?.close()
})

describe("登录和权限", () => {
  it("不登录调用任何查询都返回 401", async () => {
    for (const path of [...QUERIES, "tasks.get", "sessions.get"]) {
      const res = await query(ctx.app, path, undefined, path.endsWith(".get") && path !== "me.get" ? { id: "T-1024" } : undefined)
      expect(res.status, path).toBe(401)
      expect(res.error?.data?.code).toBe("UNAUTHORIZED")
    }
  })

  it("错的密码登录不了", async () => {
    await expect(login(ctx.app, "linzhou@heyagent.local", "wrong-password")).rejects.toThrow(/登录失败/)
  })

  it("关闭了公开注册", async () => {
    const res = await ctx.app.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "new@heyagent.local", password: PASSWORD, name: "新人" }),
    })
    expect(res.status).toBeGreaterThanOrEqual(400)
    const [row] = await ctx.db.select().from(t.users).where(eq(t.users.email, "new@heyagent.local"))
    expect(row).toBeUndefined()
  })

  it("林舟是主管，王悦是员工；待办数字主管算全部、员工只算分给自己的", async () => {
    const me1 = await query(ctx.app, "me.get", lin)
    expect(me1.data).toMatchObject({ id: "u-lin", name: "林舟", title: "运营主管", isAdmin: true, needsMeCount: 9 })
    const me2 = await query(ctx.app, "me.get", wang)
    expect(me2.data).toMatchObject({ id: "u-wang", name: "王悦", isAdmin: false, needsMeCount: 5 })
  })

  it("员工也能看全部（只读）", async () => {
    const tasks = await query(ctx.app, "tasks.list", wang)
    expect(tasks.data).toHaveLength(8)
    const runs = await query(ctx.app, "sessions.list", wang)
    expect(runs.data).toHaveLength(12)
  })
})

describe("数据和原型 mock 一致", () => {
  it("任务、session、记忆、技能、规则、工具的数量", async () => {
    const counts = {
      tasks: (await query(ctx.app, "tasks.list", lin)).data.length,
      sessions: (await query(ctx.app, "sessions.list", lin)).data.length,
      memories: (await query(ctx.app, "memories.list", lin)).data.length,
      skills: (await query(ctx.app, "skills.list", lin)).data.length,
      rules: (await query(ctx.app, "rules.list", lin)).data.length,
      tools: (await query(ctx.app, "tools.list", lin)).data.tools.length,
    }
    expect(counts).toEqual({ tasks: 8, sessions: 12, memories: 10, skills: 9, rules: 9, tools: 16 })
    const board = await query(ctx.app, "todos.board", lin)
    expect(board.data.humanItems).toHaveLength(9)
    expect(board.data.humanTodos).toHaveLength(2)
  })

  it("一次运行带检查点、过程、在等什么", async () => {
    const run = (await query(ctx.app, "sessions.get", lin, { id: "R-1024-1" })).data
    expect(run.status).toBe("needs_human")
    expect(run.checkpoints).toHaveLength(5)
    expect(run.events).toHaveLength(18)
    expect(run.events.map((e: { seq: number }) => e.seq)).toEqual(Array.from({ length: 18 }, (_, i) => i + 1))
    expect(run.waiting).toMatchObject({ what: "等王悦处理亚马逊验证码；等 Emily 确认发给客户的摘要", trigger: { kind: "event", event: "两件事都处理完", fallbackDays: 7 } })
    // 时间保持原型的相对关系：开始 09:12，挂起 11:45，相差 2 小时 33 分
    expect(Date.parse(run.waiting.since) - Date.parse(run.startedAt)).toBe((2 * 60 + 33) * 60_000)
    expect(run.checkpoints[1]).toMatchObject({ title: "访问 3 个平台", kind: "visit", target: 3, progress: 2, status: "open" })
  })

  it("模型按 B 路线：Ollama 未配置；验收默认 Gemini，和执行不同家", async () => {
    const { providers, defaults } = (await query(ctx.app, "models.overview", lin)).data
    const ollama = providers.find((p: { id: string }) => p.id === "ollama")
    expect(ollama).toMatchObject({ status: "unconfigured", baseUrl: "", models: [] })
    expect(ollama.checkedAt).toBeUndefined()
    const openrouter = providers.find((p: { id: string }) => p.id === "openrouter")
    // 测试库另外加的复核模型（helpers.ts 的 TEST_REVIEW_MODEL）不是原型里的
    expect(openrouter.models.map((m: { id: string }) => m.id).filter((id: string) => id !== TEST_REVIEW_MODEL)).toEqual([
      "openrouter/anthropic/claude-opus-5.5",
      "openrouter/anthropic/claude-sonnet-5.5",
      "openrouter/anthropic/claude-haiku-5.5",
      "openrouter/google/gemini-3.8-flash",
      "openrouter/qwen/qwen3.8-flash",
    ])
    expect(defaults).toEqual({
      run: "openrouter/anthropic/claude-sonnet-5.5",
      plan: "openrouter/anthropic/claude-opus-5.5",
      verify: "openrouter/google/gemini-3.8-flash",
      review: TEST_REVIEW_MODEL,
    })
  })

  it("浏览器：并发数来自账号租约", async () => {
    const browsers = (await query(ctx.app, "browsers.list", lin)).data
    const us = browsers.find((b: { id: string }) => b.id === "br-us")
    expect(us.running).toBe(1)
    expect(us.sites.find((s: { platformId: string }) => s.platformId === "temu").running).toBe(1)
    expect(us.vaultVersion).toBe(31)
    expect(us.cookieCount).toBe(88)
  })

  it("找不到的返回 404", async () => {
    const res = await query(ctx.app, "tasks.get", lin, { id: "T-9999" })
    expect(res.status).toBe(404)
  })
})

describe("密钥只给掩码，登录态只给状态", () => {
  it("所有接口的返回里都没有密钥原文和 cookie 内容", async () => {
    const plaintexts = Object.values(SEED_SECRET_VALUES)
    for (const cookie of [lin, wang]) {
      for (const path of QUERIES) {
        const res = await query(ctx.app, path, cookie)
        expect(res.status, path).toBe(200)
        const text = JSON.stringify(res.data)
        for (const secret of plaintexts) expect(text, `${path} 泄露了密钥`).not.toContain(secret)
        expect(text, `${path} 泄露了登录态`).not.toContain(SEED_COOKIE_PREFIX)
        // 密文也不该出现在接口里
        expect(text).not.toMatch(/"(enc|dek|ct|tag|iv)":/)
      }
    }
  })

  it("给的是掩码", async () => {
    const { providers } = (await query(ctx.app, "models.overview", lin)).data
    expect(providers.find((p: { id: string }) => p.id === "openrouter").apiKeyMasked).toBe("sk-or-v1-••••••••3f2a")
    const tools = (await query(ctx.app, "tools.list", lin)).data
    expect(Object.keys(tools.savedSecrets).sort()).toEqual(["ALI1688_TOKEN", "WHATSAPP_TOKEN"])
    expect(tools.savedSecrets.WHATSAPP_TOKEN).toMatchObject({ by: "林舟", byId: "u-lin" })
    // HTTP 模板里只有 {{名字}}
    const wa = tools.tools.find((tool: { id: string }) => tool.id === "whatsapp.send")
    expect(wa.http.headers.Authorization).toBe("Bearer {{WHATSAPP_TOKEN}}")
  })

  it("库里存的是密文，用主密钥能解回原文", async () => {
    const rows = await ctx.db.select().from(t.secrets)
    expect(rows).toHaveLength(4)
    for (const row of rows) {
      expect(JSON.stringify(row.enc)).not.toContain(decryptText(ctx.keyring, row.enc, { table: "secrets", id: row.id, version: row.version }))
    }
    const wa = rows.find((row) => row.name === "WHATSAPP_TOKEN")!
    expect(decryptText(ctx.keyring, wa.enc, { table: "secrets", id: wa.id, version: wa.version })).toBe(SEED_SECRET_VALUES.WHATSAPP_TOKEN)
    const [vault] = await ctx.db.select().from(t.browserVaults).where(eq(t.browserVaults.profileId, "br-us"))
    const state = JSON.parse(decryptText(ctx.keyring, vault!.enc, { table: "browser_vaults", id: "br-us", version: vault!.version }))
    expect(state.cookies).toHaveLength(88)
  })
})

describe("表结构约束", () => {
  it("session_events 只能追加，不能修改", async () => {
    await expect(ctx.db.execute(sql`update session_events set title = 'x' where session_id = 'R-1024-1' and seq = 1`)).rejects.toThrow()
  })

  it("一个 session 同时只能有一条 waiting 的等待记录", async () => {
    await expect(ctx.db.insert(t.sessionWaits).values({ sessionId: "R-1024-1", what: "再等一件事", triggerKind: "event", event: "x" })).rejects.toThrow()
  })

  it("新 id 的序列已经推到现有最大值之后", async () => {
    const result = await ctx.db.execute<{ n: string }>(sql`select nextval('task_no_seq') as n`)
    expect(Number(result.rows[0]!.n)).toBe(1042)
  })
})

describe("sessions.list 只给摘要，sessions.get 给全部过程", () => {
  it("列表不带过程；摘要里的几样和按全部过程算的一致（shared 的 summarizeEvents）", async () => {
    const list: SessionSummary[] = (await query(ctx.app, "sessions.list", lin)).data
    expect(list).toHaveLength(12)
    let withBrowser = 0
    let withPause = 0
    for (const summary of list) {
      expect(summary).not.toHaveProperty("events")
      const full: SessionRun = (await query(ctx.app, "sessions.get", lin, { id: summary.id })).data
      const { events, ...rest } = full
      expect(rest, summary.id).toEqual(summary)
      expect({ ...summarizeEvents(events) }, summary.id).toEqual({
        eventCount: summary.eventCount,
        lastEvent: summary.lastEvent,
        lastError: summary.lastError,
        doneDetail: summary.doneDetail,
        pausedMs: summary.pausedMs,
        browserIds: summary.browserIds,
      })
      if (summary.browserIds.length) withBrowser++
      if (summary.pausedMs) withPause++
    }
    // 种子里有用过 Chrome 的、挂起后继续过的，两样都对上了才算数
    expect(withBrowser).toBeGreaterThan(0)
    expect(withPause).toBeGreaterThan(0)
    const run = list.find((each) => each.id === "R-1024-1")!
    expect(run.eventCount).toBe(18)
    expect(run.lastEvent?.kind).toBe("wait")
  })

  it("过程的边角：连着两个挂起、没有挂起的继续、多条出错、工具输入和「打开了 Chrome」过程里的 Chrome；按任务筛", async () => {
    const [task] = await ctx.db.select().from(t.tasks).where(eq(t.tasks.id, "T-1024"))
    const id = "R-SUMMARY-1"
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 1, minute, 0, 123))
    await ctx.db.insert(t.sessions).values([
      { id, taskId: task!.id, status: "failed", modelId: "m", startedAt: at(0) },
      { id: `${id}-empty`, taskId: task!.id, status: "running", modelId: "m", startedAt: at(1) },
    ])
    const events: { kind: SessionRun["events"][number]["kind"]; detail?: string; input?: string }[] = [
      { kind: "plan", detail: "Chrome 配置 br-x；浏览器 b-1；网址白名单：a.com" },
      { kind: "wait" },
      { kind: "wait" },
      { kind: "resume" },
      { kind: "resume" },
      { kind: "error" },
      { kind: "tool", input: '{"profileId" : "br-us", "url": "https://a.com"}' },
      { kind: "tool", input: '{"browser":"br-old"} {"browser":"br-us"} {"profileId":""}' },
      { kind: "plan", detail: "用 Chrome 配置 br-no；" },
      { kind: "error" },
      { kind: "think", input: "不是 JSON" },
    ]
    await ctx.db.insert(t.sessionEvents).values(events.map((event, index) => ({ sessionId: id, seq: index + 1, at: at(index * 10), title: `${event.kind}-${index + 1}`, ...event })))
    try {
      const list: SessionSummary[] = (await query(ctx.app, "sessions.list", lin, { taskId: "T-1024" })).data
      expect(list.every((each) => each.taskId === "T-1024")).toBe(true)
      const summary = list.find((each) => each.id === id)!
      expect(summary).toMatchObject({
        eventCount: 11,
        lastEvent: { at: at(100).toISOString(), kind: "think", title: "think-11" },
        lastError: { at: at(90).toISOString(), title: "error-10" },
        // 第二个挂起（20 分）到第一个继续（30 分）
        pausedMs: 10 * 60_000,
        browserIds: ["br-old", "br-us", "br-x"],
      })
      const full: SessionRun = (await query(ctx.app, "sessions.get", lin, { id })).data
      expect(full.events).toHaveLength(11)
      expect(full.events[6]!.input).toContain("br-us")
      const { eventCount, lastEvent, lastError, doneDetail, pausedMs, browserIds } = summary
      expect(summarizeEvents(full.events)).toEqual({ eventCount, lastEvent, lastError, doneDetail, pausedMs, browserIds })
      // 还没有过程的 session
      const empty = list.find((each) => each.id === `${id}-empty`)!
      expect(empty).toMatchObject({ eventCount: 0, pausedMs: 0, browserIds: [] })
      expect(empty).not.toHaveProperty("lastEvent")
      expect(empty).not.toHaveProperty("lastError")
      expect((await query(ctx.app, "sessions.list", lin, { taskId: "T-nobody" })).data).toEqual([])
    } finally {
      await ctx.db.delete(t.sessions).where(inArray(t.sessions.id, [id, `${id}-empty`]))
    }
  })
})

describe("种子可以重复执行", () => {
  it("再灌一次数量不变，已登录的会话还有效", async () => {
    await seedDemo(ctx.db, ctx.keyring, { password: PASSWORD })
    expect((await query(ctx.app, "tasks.list", lin)).data).toHaveLength(8)
    expect((await query(ctx.app, "sessions.list", wang)).data).toHaveLength(12)
  })
})
