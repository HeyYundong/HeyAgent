// M3 的集成测试：规则（翻译、4 个阶段的执行）、检查点自动记录、三方验收、上下文压缩、存为任务步骤。
// 真实的测试库 + 进程内 worker + 假模型（执行、验收、翻译都按 model id 找剧本），不花钱、不连外网。
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { and, asc, eq } from "drizzle-orm"
import { describeCompiledRule, type CompiledRule } from "@heyagent/shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { recordsFor } from "../src/engine/checkpoint-sync.js"
import { ruleHook, urlsOf } from "../src/engine/rules.js"
import { normalizeRuleOutput } from "../src/engine/rule-compile.js"
import { maskSecretFields } from "../src/engine/secrets.js"
import { login, query } from "./helpers.js"
import {
  call,
  createTask,
  eventsOf,
  messagesOf,
  mutate,
  Script,
  sessionRow,
  setSetting,
  setupEngine,
  step,
  text,
  useScript,
  waitFor,
  waitStatus,
  type EngineTestContext,
} from "./engine-helpers.js"

let ctx: EngineTestContext
let lin: string // 主管
let wang: string // 员工，测试任务的负责人
let li: string // 另一个员工

let server: Server
let port = 0
const received: string[] = []

beforeAll(async () => {
  ctx = await setupEngine()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  li = await login(ctx.app, "lijing@heyagent.local")
  server = createServer((req, res) => {
    let body = ""
    req.on("data", (chunk) => (body += chunk))
    req.on("end", () => {
      received.push(`${req.method} ${req.url} ${body}`)
      const url = new URL(req.url ?? "/", "http://localhost")
      if (url.pathname === "/page") return res.end("页面内容 ".repeat(1500))
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ ok: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
  await ctx.db.insert(t.tools).values([
    {
      id: "http.send",
      name: "发消息接口",
      summary: "测试用：对外发消息",
      description: "给外部联系人发一条消息",
      source: "http",
      risk: "external",
      http: { method: "POST", url: `http://127.0.0.1:${port}/send`, body: '{"to":"{to}","text":"{text}"}' },
    },
    {
      id: "http.page",
      name: "读页面接口",
      summary: "测试用：返回很长的页面",
      description: "返回一段很长的内容",
      source: "http",
      risk: "read",
      http: { method: "GET", url: `http://127.0.0.1:${port}/page` },
    },
  ])
}, 120_000)

afterAll(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()))
  await ctx?.stop()
})

async function runNow(taskId: string, cookie = wang) {
  const res = await mutate(ctx.app, "engine.runNow", cookie, { taskId })
  if (!res.data) throw new Error(`runNow 失败：${JSON.stringify(res.error)}`)
  return res.data.sessionId as string
}

let ruleCounter = 0
/** 直接在库里建一条人确认过的规则（跳过翻译），挂到任务上 */
async function addRule(taskId: string, shape: Pick<CompiledRule, "trigger" | "actions">, name = `测试规则 ${++ruleCounter}`) {
  const id = `rl-test-${++ruleCounter}`
  const compiled: CompiledRule = { v: 1, ...shape, understood: describeCompiledRule(shape) }
  await ctx.db.insert(t.rules).values({
    id,
    name,
    trigger: "测试",
    action: "测试",
    compiledTrigger: compiled,
    compiledText: JSON.stringify({ trigger: "测试", action: "测试" }),
    confirmedById: "u-lin",
    confirmedAt: new Date(),
  })
  const position = (await ctx.db.select().from(t.taskRules).where(eq(t.taskRules.taskId, taskId))).length
  await ctx.db.insert(t.taskRules).values({ taskId, refId: id, position })
  return id
}

async function itemsOf(sessionId: string) {
  return ctx.db.select().from(t.humanItems).where(eq(t.humanItems.sessionId, sessionId)).orderBy(asc(t.humanItems.createdAt))
}

const verifyJson = (value: unknown) => step([text(JSON.stringify(value))], 0.002)

// ---------- 1. 规则翻译 ----------

describe("规则翻译：保存时翻译，人确认后才生效", () => {
  const PLAN = "test/plan-m3"
  beforeAll(async () => {
    await ctx.db.insert(t.models).values({ id: PLAN, providerId: "openrouter", name: "测试规划模型", contextK: 128 })
    await ctx.db.update(t.modelDefaults).set({ modelId: PLAN }).where(eq(t.modelDefaults.role, "plan"))
  })

  it("支持的：翻译 → 待确认 → 确认后生效、建任务能选；文字改了旧版本继续执行，直到重新确认", async () => {
    const script = useScript(
      PLAN,
      new Script([
        verifyJson({
          supported: true,
          reason: "",
          trigger: { type: "before_tool", toolIds: ["notify.staff"], risks: ["money"], anyTool: false, domains: [], usd: 0, proposes: [] },
          actions: [{ type: "ask_human", to: "admin", userId: "", reason: "" }],
        }),
        verifyJson({
          supported: true,
          reason: "",
          trigger: { type: "before_tool", toolIds: ["notify.staff"], risks: [], anyTool: false, domains: [], usd: 0, proposes: [] },
          actions: [{ type: "deny", to: "none", userId: "", reason: "不许发通知" }],
        }),
      ])
    )
    const created = await mutate(ctx.app, "rules.create", lin, { name: "发通知前主管审批", trigger: "agent 要发站内通知或花钱之前", action: "拦下交给主管审批", toolIds: [] })
    const id = created.data.id as string
    // 员工不能翻译（要花钱）
    expect((await mutate(ctx.app, "rules.compile", wang, { id })).error?.data?.code).toBe("FORBIDDEN")
    // 还没翻译：未生效，确认不了
    let rule = (await query(ctx.app, "rules.list", lin)).data.find((each: { id: string }) => each.id === id)
    expect(rule.compile).toMatchObject({ status: "untranslated", effective: false })
    expect((await mutate(ctx.app, "rules.confirm", lin, { id })).error?.data?.code).toBe("BAD_REQUEST")

    const compiled = await mutate(ctx.app, "rules.compile", lin, { id })
    expect(compiled.error).toBeUndefined()
    expect(compiled.data).toMatchObject({ supported: true, modelId: PLAN })
    expect(compiled.data.understood).toBe("调用 「通知员工」（notify.staff），或者 任何风险等级为「涉及金钱」的工具 之前，拦下交给主管审批，批准才执行")
    // 翻译的提示里带了工具清单和员工清单
    expect(script.promptText(0)).toContain("notify.staff")
    expect(script.promptText(0)).toContain("u-wang")
    rule = (await query(ctx.app, "rules.list", lin)).data.find((each: { id: string }) => each.id === id)
    expect(rule.compile).toMatchObject({ status: "pending", effective: false, understood: compiled.data.understood })

    // 没确认：建任务时选不了
    const task = { title: "测试", goal: "测试", steps: [], schedule: null, ruleIds: [id], modelId: "openrouter/anthropic/claude-haiku-5.5" }
    expect((await mutate(ctx.app, "tasks.create", lin, task)).error?.message).toContain("还没生效")
    const confirmed = await mutate(ctx.app, "rules.confirm", lin, { id })
    expect(confirmed.data).toEqual({ id, understood: compiled.data.understood })
    rule = (await query(ctx.app, "rules.list", lin)).data.find((each: { id: string }) => each.id === id)
    expect(rule.compile).toMatchObject({ status: "active", effective: true, enforced: { understood: compiled.data.understood, confirmedById: "u-lin" } })
    expect(rule.compiledTrigger).toMatchObject({ v: 1, trigger: { type: "before_tool" }, actions: [{ type: "ask_human", recipient: { to: "admin" } }] })
    const taskRes = await mutate(ctx.app, "tasks.create", lin, task)
    expect(taskRes.error).toBeUndefined()

    // 改文字：待确认的翻译作废，旧版本继续执行（outdated）；重新翻译确认后换成新版本
    await mutate(ctx.app, "rules.update", lin, { id, name: "发通知前主管审批", trigger: "agent 要发站内通知之前", action: "拦下，不许发", toolIds: [] })
    rule = (await query(ctx.app, "rules.list", lin)).data.find((each: { id: string }) => each.id === id)
    expect(rule.compile).toMatchObject({ status: "untranslated", effective: true, outdated: true, enforced: { trigger: "agent 要发站内通知或花钱之前" } })
    // 原来就选着的规则，改任务时不受「新选的必须已生效」限制
    const update = await mutate(ctx.app, "tasks.update", lin, { ...task, id: taskRes.data.id, title: "测试（改）" })
    expect(update.error).toBeUndefined()
    await mutate(ctx.app, "rules.compile", lin, { id })
    await mutate(ctx.app, "rules.confirm", lin, { id })
    rule = (await query(ctx.app, "rules.list", lin)).data.find((each: { id: string }) => each.id === id)
    expect(rule.compile).toMatchObject({ status: "active", effective: true })
    expect(rule.compile.outdated).toBeUndefined()
    expect(rule.compiledTrigger.actions).toEqual([{ type: "deny", reason: "不许发通知" }])
    const audits = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.targetId, id)))
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(["rule.create", "rule.compile", "rule.confirm", "rule.update"]))
  })

  it("不支持的：模型说不支持、引用了不存在的工具、组合不合法，都标「未生效（v1 还不支持）」，确认不了、选不了", async () => {
    useScript(
      PLAN,
      new Script([
        verifyJson({
          supported: false,
          reason: "「内容可疑」要理解内容才能判断",
          trigger: { type: "before_tool", toolIds: [], risks: [], anyTool: false, domains: [], usd: 0, proposes: [] },
          actions: [],
        }),
        verifyJson({
          supported: true,
          reason: "",
          trigger: { type: "before_tool", toolIds: ["nonexistent.tool"], risks: [], anyTool: false, domains: [], usd: 0, proposes: [] },
          actions: [{ type: "deny", to: "none", userId: "", reason: "" }],
        }),
      ])
    )
    const created = await mutate(ctx.app, "rules.create", lin, { name: "内容可疑就拦下", trigger: "agent 发的内容可疑时", action: "拦下", toolIds: [] })
    const id = created.data.id as string
    const result = await mutate(ctx.app, "rules.compile", lin, { id })
    expect(result.data).toMatchObject({ supported: false, reason: "「内容可疑」要理解内容才能判断" })
    expect(result.data.understood).toContain("v1 还不支持")
    const rule = (await query(ctx.app, "rules.list", lin)).data.find((each: { id: string }) => each.id === id)
    expect(rule.compile).toMatchObject({ status: "unsupported", effective: false, reason: "「内容可疑」要理解内容才能判断" })
    expect((await mutate(ctx.app, "rules.confirm", lin, { id })).error?.message).toContain("不支持")
    expect(
      (await mutate(ctx.app, "tasks.create", lin, { title: "测试", goal: "测试", steps: [], schedule: null, ruleIds: [id], modelId: "openrouter/anthropic/claude-haiku-5.5" })).error?.message
    ).toContain("v1 还不支持")

    // 只给文字：预览，不存
    const preview = await mutate(ctx.app, "rules.compile", lin, { trigger: "调用不存在的工具前", action: "拦下" })
    expect(preview.data).toMatchObject({ supported: false })
    expect(preview.data.reason).toContain("nonexistent.tool")

    // 组合不合法、白名单没写域名：程序校验拦下
    const known = { toolIds: new Set(["notify.staff"]), userIds: new Set(["u-wang"]), toolName: () => undefined, userName: () => undefined }
    const base = { toolIds: [], risks: [], anyTool: false, domains: [], usd: 0, proposes: [] }
    expect(
      normalizeRuleOutput({ supported: true, reason: "", trigger: { ...base, type: "after_tool", anyTool: true }, actions: [{ type: "deny", to: "none", userId: "", reason: "" }] }, known)
    ).toMatchObject({ supported: false, reason: expect.stringContaining("v1 还不支持在「调用工具之后」时「拦下」") })
    expect(normalizeRuleOutput({ supported: true, reason: "", trigger: { ...base, type: "url_not_allowed", domains: ["不是域名"] }, actions: [{ type: "deny", to: "none", userId: "", reason: "" }] }, known)).toMatchObject({
      supported: false,
    })
    expect(
      normalizeRuleOutput({ supported: true, reason: "", trigger: { ...base, type: "before_tool", toolIds: ["notify.staff"] }, actions: [{ type: "ask_human", to: "user", userId: "u-nobody", reason: "" }] }, known)
    ).toMatchObject({ supported: false, reason: expect.stringContaining("u-nobody") })
    const ok = normalizeRuleOutput({ supported: true, reason: "", trigger: { ...base, type: "url_not_allowed", domains: ["https://Shop.Example.com/x"] }, actions: [{ type: "deny", to: "none", userId: "", reason: "换一个网站" }] }, known)
    expect(ok).toMatchObject({ supported: true, compiled: { trigger: { type: "url_not_allowed", domains: ["shop.example.com"] } } })
  })
})

// ---------- 2. 规则的 4 个阶段 ----------

describe("规则执行：调工具前拦下、审批（批准后执行、拒绝后告诉 agent）", () => {
  it("拦下：工具不执行，理由交给 agent，写 rule 事件；agent 提议记忆也能拦", async () => {
    const script = useScript(
      "test/m3-deny",
      new Script([step([call("notify.staff", { title: "你好" }), call("memory.propose", { content: "记住这个", appliesTo: "测试", evidence: "chat" })]), step([text("好的，不发了")])])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/m3-deny", toolIds: ["notify.staff", "memory.propose"] })
    await addRule(taskId, { trigger: { type: "before_tool", toolIds: ["notify.staff"], risks: [] }, actions: [{ type: "deny", reason: "这个任务不许发通知" }] }, "不许发通知")
    await addRule(taskId, { trigger: { type: "agent_proposes", what: ["memory"] }, actions: [{ type: "deny", reason: "这个任务不收记忆" }] }, "不收记忆")
    const before = await ctx.db.select().from(t.notifications)
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "done")
    expect(script.promptText(1)).toContain("这个任务不许发通知")
    expect(script.promptText(1)).toContain("这个任务不收记忆")
    const events = await eventsOf(ctx.db, sessionId)
    const ruleEvents = events.filter((event) => event.kind === "rule")
    expect(ruleEvents.map((event) => event.title)).toEqual(expect.arrayContaining(["拦下：通知员工", "拦下：提议记忆"]))
    expect(ruleEvents.find((event) => event.title === "拦下：通知员工")!.detail).toContain("规则「不许发通知」")
    // 没有发出通知（只有完成通知）、没有生成记忆
    const after = await ctx.db.select().from(t.notifications)
    expect(after.filter((row) => !before.some((old) => old.id === row.id)).map((row) => row.title)).toEqual([expect.stringContaining("运行完成")])
    expect(await ctx.db.select().from(t.memories).where(eq(t.memories.sourceSessionId, sessionId))).toEqual([])
    // 系统提示里写的是「系统理解为」
    expect(JSON.stringify(script.prompts[0]!.prompt)).toContain("拦下，告诉 agent「这个任务不许发通知」")
  })

  it("网址不在白名单：HTTP 工具的地址按模板算出来，不在名单里就拦下，不发请求", async () => {
    useScript("test/m3-url", new Script([step([call("http.send", { to: "a", text: "b" })]), step([text("不发了")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/m3-url", toolIds: ["http.send"] })
    await addRule(taskId, { trigger: { type: "url_not_allowed", domains: ["example.com"] }, actions: [{ type: "deny", reason: "换一个网站" }] }, "白名单")
    const count = received.length
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "done")
    expect(received.length).toBe(count)
    const denied = (await eventsOf(ctx.db, sessionId)).find((event) => event.kind === "rule")
    expect(denied!.detail).toContain("127.0.0.1 不在白名单（example.com）里")
    // 参数里的 url 字段也认；白名单里的子域名放行
    const snapshot = { tools: [] } as unknown as Parameters<typeof urlsOf>[0]
    expect(urlsOf(snapshot, "browser.navigate", { url: "https://a.example.com/x" })).toEqual(["https://a.example.com/x"])
  })

  it("审批：同一步两个调用，第一个要审批 → 等人处理；批准后执行它和后面的调用，备注交给 agent", async () => {
    const script = useScript(
      "test/m3-approve",
      new Script([
        step([call("http.send", { to: "客户甲", text: "报价 100 元" }), call("checkpoint.mark", { checkpoint: 1, status: "done", record: "发了" })]),
        step([text("发完了")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/m3-approve", toolIds: ["http.send"], steps: [{ id: "s1", text: "发消息", wait: false, checkpoint: "发消息已确认" }] })
    const ruleId = await addRule(taskId, { trigger: { type: "before_tool", toolIds: [], risks: ["external"] }, actions: [{ type: "ask_human", recipient: { to: "owner" } }] }, "外发前确认")
    const count = received.length
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "needs_human")
    expect(received.length).toBe(count)
    const [item] = await itemsOf(sessionId)
    expect(item).toMatchObject({ kind: "approval", assigneeId: "u-wang", ruleId, status: "open" })
    expect(item!.detail.toolCall).toMatchObject({ toolId: "http.send", toolName: "发消息接口", ruleId, ruleName: "外发前确认", risk: "external" })
    expect(item!.detail.toolCall!.input).toContain("报价 100 元")
    expect(item!.detail.primary).toBe("批准")
    // 这时 tool 消息还没写（这次调用先存着）
    expect((await messagesOf(ctx.db, sessionId)).map((row) => row.role)).toEqual(["user", "assistant"])
    // 审批工具调用不能「已处理」
    expect((await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item!.id, how: "done" })).error?.data?.code).toBe("BAD_REQUEST")
    const resolved = await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item!.id, how: "approve", note: "可以发" })
    expect(resolved.data).toEqual({ resumedSessionId: sessionId })
    await waitStatus(ctx.db, sessionId, "done")
    expect(received.length).toBe(count + 1)
    expect(received.at(-1)).toContain("报价 100 元")
    const roles = (await messagesOf(ctx.db, sessionId)).map((row) => row.role)
    expect(roles).toEqual(["user", "assistant", "tool", "tool", "assistant"])
    expect(script.promptText(1)).toContain("批准了这次调用，备注：可以发")
    expect(script.promptText(1)).toContain("已勾上第 1 个检查点")
    const titles = (await eventsOf(ctx.db, sessionId)).map((event) => event.title)
    expect(titles).toEqual(expect.arrayContaining(["规则「外发前确认」：拦下 发消息接口，交给人审批", "王悦批准了，执行这次调用"]))
  })

  it("审批被拒绝：不执行，把「被拒绝：理由」作为工具结果交给 agent，接着跑", async () => {
    const script = useScript("test/m3-reject", new Script([step([call("http.send", { to: "客户乙", text: "降价" })]), step([text("明白，不发了")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/m3-reject", toolIds: ["http.send"] })
    await addRule(taskId, { trigger: { type: "before_tool", toolIds: ["http.send"], risks: [] }, actions: [{ type: "ask_human", recipient: { to: "admin" } }] }, "发消息要主管批")
    const count = received.length
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "needs_human")
    const [item] = await itemsOf(sessionId)
    // 交给主管（第一位主管）；员工不是被分配的人，处理不了
    expect(item!.assigneeId).toBe("u-lin")
    expect((await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item!.id, how: "reject" })).error?.data?.code).toBe("FORBIDDEN")
    await mutate(ctx.app, "engine.resolveHumanItem", lin, { itemId: item!.id, how: "reject", note: "价格不能再降" })
    await waitStatus(ctx.db, sessionId, "done")
    expect(received.length).toBe(count)
    expect(script.promptText(1)).toContain("被拒绝：林舟拒绝了这次调用")
    expect(script.promptText(1)).toContain("价格不能再降")
  })
})

describe("规则执行：调模型前、调工具后、说做完了", () => {
  it("花费超过 X → 交给负责人决定；同意就继续（只触发一次），截图没有浏览器时写清楚，调工具后通知", async () => {
    useScript(
      "test/m3-cost",
      new Script([step([call("checkpoint.mark", { checkpoint: 1, status: "doing" })], 0.4), step([call("notify.staff", { title: "进度" })], 0.4), step([text("完成")], 0.4)])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/m3-cost", toolIds: ["notify.staff"], steps: [{ id: "s1", text: "做", wait: false, checkpoint: "做完了" }] })
    await addRule(taskId, { trigger: { type: "cost_over", usd: 0.5 }, actions: [{ type: "ask_human", recipient: { to: "owner" } }] }, "花费超过 0.5 美元")
    await addRule(taskId, { trigger: { type: "after_tool", toolIds: ["notify.staff"], anyTool: false }, actions: [{ type: "screenshot" }, { type: "notify", recipient: { to: "admin" } }] }, "发通知后留证")
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "needs_human")
    const [item] = await itemsOf(sessionId)
    expect(item).toMatchObject({ kind: "approval", title: "花费超过 0.5 美元，要不要继续" })
    expect(item!.detail.pay).toBeDefined()
    await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item!.id, how: "approve" })
    // 检查点只标了在做、没勾就说完成：记「没完成」
    const done = await waitStatus(ctx.db, sessionId, "incomplete")
    expect(done.ruleState).toMatchObject({ costFired: [expect.any(String)] })
    // 同意后没有再问第二次
    expect(await itemsOf(sessionId)).toHaveLength(1)
    const titles = (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "rule").map((event) => event.title)
    expect(titles).toEqual(
      expect.arrayContaining([
        "规则「花费超过 0.5 美元」：花费超过 0.5 美元",
        "规则「发通知后留证」：要截图，但这次运行没有开着的浏览器，没截",
        "规则「发通知后留证」：通知林舟",
      ])
    )
    const notes = await ctx.db.select().from(t.notifications).where(and(eq(t.notifications.userId, "u-lin"), eq(t.notifications.sessionId, sessionId)))
    expect(notes.some((row) => row.title.includes("发通知后留证"))).toBe(true)
  })

  it("花费超过 X → 不同意就结束运行", async () => {
    useScript("test/m3-cost-no", new Script([step([call("checkpoint.mark", { checkpoint: 1, status: "doing" })], 0.6), step([text("完成")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/m3-cost-no", steps: [{ id: "s1", text: "做", wait: false, checkpoint: "做完了" }] })
    await addRule(taskId, { trigger: { type: "cost_over", usd: 0.5 }, actions: [{ type: "ask_human", recipient: { to: "owner" } }] }, "花费上限")
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "needs_human")
    const [item] = await itemsOf(sessionId)
    const res = await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item!.id, how: "reject" })
    expect(res.data).toEqual({ endedSessionId: sessionId })
    const row = await sessionRow(ctx.db, sessionId)
    expect(row).toMatchObject({ status: "failed" })
    expect(row!.error).toContain("决定不继续")
  })

  it("验证码或登录页（page_needs_human）：内置转人工照常，规则只加动作；没确认过的规则不执行并写清楚", async () => {
    const taskId = await createTask(ctx.db, { modelId: "test/m3-page" })
    await addRule(taskId, { trigger: { type: "page_needs_human" }, actions: [{ type: "notify", recipient: { to: "user", userId: "u-li" } }] }, "验证码通知李静")
    await ctx.db.insert(t.rules).values({ id: "rl-test-inactive", name: "还没确认的", trigger: "x", action: "y" })
    await ctx.db.insert(t.taskRules).values({ taskId, refId: "rl-test-inactive", position: 9 })
    useScript("test/m3-page", new Script([step([text("完成")])]))
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "done")
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.find((event) => event.kind === "rule")!.title).toBe("1 条规则还没生效，这次运行不执行")
    // 直接调钩子：浏览器工具返回 page_needs_human 信号时，规则加通知
    const session = (await sessionRow(ctx.db, sessionId))!
    await ruleHook.afterTool!({
      db: ctx.db,
      session,
      snapshot: session.snapshot!,
      toolId: "browser.navigate",
      toolName: "浏览器：navigate",
      input: { url: "https://x.example.com" },
      allowedToolIds: new Set(),
      outcome: { output: "检测到验证码", signals: ["page_needs_human"], suspend: { kind: "wait", input: { what: "x", triggerKind: "event" } } },
    })
    const notes = await ctx.db.select().from(t.notifications).where(and(eq(t.notifications.userId, "u-li"), eq(t.notifications.sessionId, sessionId)))
    expect(notes).toHaveLength(1)
    const after = await eventsOf(ctx.db, sessionId)
    expect(after.map((event) => event.title)).toEqual(expect.arrayContaining(["规则「验证码通知李静」：页面出现验证码或登录页", "规则「验证码通知李静」：通知李静"]))
  })
})

// ---------- 3. 检查点自动记录 ----------

describe("检查点自动记录（sync_checkpoint）", () => {
  it("存文件记产物、外发工具记发给谁和原文，标「自动」；同类型多个时记到 agent 指定在做的那个", async () => {
    useScript(
      "test/m3-sync",
      new Script([
        step([call("checkpoint.mark", { checkpoint: 2, status: "doing" })]),
        step([call("file.save", { name: "b.csv", content: "a,b\n1,2" })]),
        step([call("http.send", { to: "联系人甲", text: "你好，请报价" }), call("http.send", { to: "联系人乙", text: "你好，请报价" })]),
        step([text("完成")]),
      ])
    )
    const taskId = await createTask(ctx.db, {
      modelId: "test/m3-sync",
      toolIds: ["http.send", "file.save"],
      steps: [
        { id: "s1", text: "存表", wait: false, checkpoint: "表 A 已保存；表 B 已保存" },
        { id: "s2", text: "发消息", wait: false, checkpoint: "给 2 个联系人发消息" },
      ],
    })
    await addRule(taskId, { trigger: { type: "after_tool", toolIds: [], anyTool: true }, actions: [{ type: "sync_checkpoint" }] }, "同步检查点")
    const sessionId = await runNow(taskId)
    // 「表 A 已保存」没达成：记「没完成」
    await waitStatus(ctx.db, sessionId, "incomplete")
    const run = (await query(ctx.app, "sessions.get", wang, { id: sessionId })).data
    expect(run.checkpoints.map((cp: { title: string; kind: string; status: string }) => [cp.title, cp.kind, cp.status])).toEqual([
      ["表 A 已保存", "artifact", "open"],
      ["表 B 已保存", "artifact", "done"],
      ["给 2 个联系人发消息", "message", "done"],
    ])
    expect(run.checkpoints[1].records).toEqual([{ at: expect.any(String), text: expect.stringMatching(/^b\.csv · \/api\/files\/f-[0-9a-f]+$/), synced: true }])
    expect(run.checkpoints[2].progress).toBe(2)
    expect(run.checkpoints[2].records.map((record: { text: string; synced: boolean }) => [record.text, record.synced])).toEqual([
      ["发消息接口：发给 联系人甲：你好，请报价", true],
      ["发消息接口：发给 联系人乙：你好，请报价", true],
    ])
    const titles = run.events.filter((event: { kind: string }) => event.kind === "checkpoint").map((event: { title: string }) => event.title)
    expect(titles).toEqual(expect.arrayContaining(["「表 B 已保存」已完成", "「给 2 个联系人发消息」1/2", "「给 2 个联系人发消息」2/2"]))
    // 访问：浏览器打开网页后按网址和标题记
    expect(recordsFor({ toolId: "browser.navigate", risk: "external", input: {} }, { output: "", facts: { url: "https://a.example.com/x", title: "页面 A" } })).toEqual([{ kind: "visit", text: "页面 A · https://a.example.com/x" }])
  })
})

// ---------- 4. 三方验收 ----------

const CP_STEP = [{ id: "s1", text: "做完并汇报", wait: false, checkpoint: "汇总表已保存" }]

async function verifyTask(modelId: string, verifyModelId: string) {
  const taskId = await createTask(ctx.db, { modelId, steps: CP_STEP, toolIds: ["file.save"] })
  await ctx.db.update(t.tasks).set({ verifyModelId }).where(eq(t.tasks.id, taskId))
  await addRule(taskId, { trigger: { type: "agent_done" }, actions: [{ type: "verify" }] }, "三方验收")
  return taskId
}

describe("三方验收", () => {
  it("通过：验收模型逐条给结论，存进 sessions.verification，运行完成", async () => {
    useScript("test/claude-v-pass", new Script([step([call("file.save", { name: "sum.csv", content: "x,y\n1,2" })]), step([call("checkpoint.mark", { checkpoint: 1, status: "done", record: "存了 sum.csv" })]), step([text("做完了，表是 sum.csv")])]))
    const verifier = useScript("test/gemini-v-pass", new Script([verifyJson({ items: [{ index: 1, verdict: "pass", reason: "有 sum.csv 文件" }], verdict: "pass", headline: "1 个检查点全部完成", question: "" })]))
    const taskId = await verifyTask("test/claude-v-pass", "test/gemini-v-pass")
    const sessionId = await runNow(taskId)
    const done = await waitStatus(ctx.db, sessionId, "done")
    expect(done.verification).toMatchObject({ status: "passed", round: 1, modelId: "test/gemini-v-pass", verdict: "pass", items: [{ index: 1, title: "汇总表已保存", verdict: "pass", reason: "有 sum.csv 文件" }] })
    // 验收的输入：目标、检查点和记录、最终答复、产物摘录
    const prompt = verifier.promptText(0)
    expect(prompt).toContain("汇总表已保存")
    expect(prompt).toContain("存了 sum.csv")
    expect(prompt).toContain("做完了，表是 sum.csv")
    expect(prompt).toContain("x,y")
    const kinds = (await eventsOf(ctx.db, sessionId)).map((event) => [event.kind, event.title])
    expect(kinds.at(-1)).toEqual(["done", "验收通过，运行完成"])
    expect(kinds.filter(([kind]) => kind === "verify").map(([, title]) => title)).toEqual(["agent 说做完了，三方 AI（test/gemini-v-pass）开始验收", "验收通过：1 个检查点全部完成"])
    // 验收的花费也算进这次运行
    expect(done.costUsd).toBeCloseTo(0.003 + 0.002, 6)
  })

  it("反问后补做通过：问题清单交给执行 agent，补做后再验收通过", async () => {
    const executor = useScript(
      "test/claude-v-ask",
      new Script([
        step([text("做完了")]),
        step([call("file.save", { name: "sum.csv", content: "补上的表" }), call("checkpoint.mark", { checkpoint: 1, status: "done", record: "补存了 sum.csv" })]),
        step([text("刚才漏了存表，已经补上 sum.csv")]),
      ])
    )
    useScript(
      "test/gemini-v-ask",
      new Script([
        verifyJson({ items: [{ index: 1, verdict: "fail", reason: "没有任何记录和文件" }], verdict: "fail", headline: "汇总表没保存", question: "表在哪里？" }),
        verifyJson({ items: [{ index: 1, verdict: "pass", reason: "有补存的 sum.csv" }], verdict: "pass", headline: "补做后通过", question: "" }),
      ])
    )
    const taskId = await verifyTask("test/claude-v-ask", "test/gemini-v-ask")
    const sessionId = await runNow(taskId)
    const done = await waitStatus(ctx.db, sessionId, "done")
    expect(executor.promptText(1)).toContain("【三方验收】")
    expect(executor.promptText(1)).toContain("没有任何记录和文件")
    expect(executor.promptText(1)).toContain("表在哪里？")
    expect(done.verification).toMatchObject({ status: "passed", round: 2, headline: "补做后通过" })
    expect(done.verification!.notes.map((note) => note.by)).toEqual(["verifier", "executor", "verifier"])
    expect(done.verification!.notes[1]!.text).toContain("已经补上")
    const titles = (await eventsOf(ctx.db, sessionId)).map((event) => event.title)
    expect(titles).toEqual(expect.arrayContaining(["三方 AI 反问：汇总表没保存", "agent 说做完了，三方 AI（test/gemini-v-ask）开始验收（第 2 轮）"]))
  })

  it("仍有争议交给人：生成验收争议附报告；补充说明后继续 → 再验收仍有争议 → 算通过；另一次算失败", async () => {
    const executor = useScript(
      "test/claude-v-dispute",
      new Script([step([text("做完了")]), step([text("页面打不开，只能这样")]), step([text("按说明重新确认过了")]), step([text("还是只能这样")])])
    )
    const fail = { items: [{ index: 1, verdict: "unsure", reason: "看不到文件" }], verdict: "unsure", headline: "汇总表存疑", question: "为什么没有文件？" }
    useScript("test/gemini-v-dispute", new Script([verifyJson(fail), verifyJson(fail), verifyJson(fail), verifyJson(fail)]))
    const taskId = await verifyTask("test/claude-v-dispute", "test/gemini-v-dispute")
    // 验收最多 2 轮（默认）：第 1 轮反问，第 2 轮还说不清就交给负责人
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "needs_human")
    const [item] = await itemsOf(sessionId)
    expect(item).toMatchObject({ kind: "verify", assigneeId: "u-wang", status: "open" })
    expect(item!.detail.verification).toMatchObject({ status: "disputed", round: 2, items: [{ verdict: "unsure" }] })
    expect(item!.detail.primary).toBe("算通过")
    let row = await sessionRow(ctx.db, sessionId)
    expect(row!.verification).toMatchObject({ status: "disputed" })
    const board = await query(ctx.app, "todos.board", wang)
    expect(board.data.humanItems.find((each: { id: string }) => each.id === item!.id).detail.verification.status).toBe("disputed")

    // 补充说明后继续：说明必填，同一个 session 接着干；再说做完了从第 1 轮重新验收
    expect((await mutate(ctx.app, "engine.resolveVerifyDispute", wang, { itemId: item!.id, how: "continue" })).error?.data?.code).toBe("BAD_REQUEST")
    const cont = await mutate(ctx.app, "engine.resolveVerifyDispute", wang, { itemId: item!.id, how: "continue", note: "文件在共享盘，你确认一下再回复" })
    expect(cont.data).toEqual({ resumedSessionId: sessionId })
    await waitFor(async () => (await itemsOf(sessionId)).length === 2, { what: "第二件验收争议" })
    expect(executor.promptText(2)).toContain("文件在共享盘")
    row = await sessionRow(ctx.db, sessionId)
    expect(row).toMatchObject({ status: "needs_human" })
    // 负责人说明后从第 1 轮重新数：第 1 轮又反问一次，第 2 轮还说不清才再交给人
    expect(executor.promptText(3)).toContain("【三方验收】")
    expect(row!.verification).toMatchObject({ status: "disputed", round: 2 })
    expect(row!.verification!.notes.filter((note) => note.by === "executor").length).toBe(3)
    const second = (await itemsOf(sessionId))[1]!
    const pass = await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: second.id, how: "approve", note: "我核对过了" })
    expect(pass.data).toEqual({ endedSessionId: sessionId })
    row = await sessionRow(ctx.db, sessionId)
    expect(row).toMatchObject({ status: "done" })
    expect(row!.verification).toMatchObject({ status: "passed", resolution: { how: "pass", byId: "u-wang", note: "我核对过了" } })
    const last = (await eventsOf(ctx.db, sessionId)).at(-1)!
    expect(last).toMatchObject({ kind: "done", title: "王悦判定验收通过，运行完成" })

    // 另一次：算失败
    useScript("test/claude-v-dispute2", new Script([step([text("做完了")]), step([text("没法补")])]))
    useScript("test/gemini-v-dispute2", new Script([verifyJson(fail), verifyJson(fail)]))
    const task2 = await verifyTask("test/claude-v-dispute2", "test/gemini-v-dispute2")
    const session2 = await runNow(task2)
    await waitStatus(ctx.db, session2, "needs_human")
    const [item2] = await itemsOf(session2)
    const failed = await mutate(ctx.app, "engine.resolveVerifyDispute", lin, { itemId: item2!.id, how: "fail", note: "确实没做" })
    expect(failed.data).toEqual({ endedSessionId: session2 })
    const row2 = await sessionRow(ctx.db, session2)
    expect(row2).toMatchObject({ status: "failed" })
    expect(row2!.error).toContain("林舟判定失败")
  })

  it("验收模型和执行模型同一家：直接失败并写清原因", async () => {
    useScript("test/claude-v-same", new Script([step([text("做完了")])]))
    const taskId = await verifyTask("test/claude-v-same", "test/claude-verify")
    const sessionId = await runNow(taskId)
    const row = await waitStatus(ctx.db, sessionId, "failed")
    expect(row.error).toContain("是同一家（Anthropic）")
    const last = (await eventsOf(ctx.db, sessionId)).at(-1)!
    expect(last).toMatchObject({ kind: "error", title: "运行失败" })
  })

  it("没选验收规则：说做完了直接完成", async () => {
    useScript("test/claude-v-none", new Script([step([text("做完了")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/claude-v-none" })
    const sessionId = await runNow(taskId)
    const row = await waitStatus(ctx.db, sessionId, "done")
    expect(row.verification).toBeNull()
  })
})

// ---------- 5. 压缩 ----------

describe("长 session 压缩上下文", () => {
  it("历史超过上限：较早的大块工具输出换成摘要 + 文件引用；库里原文还在，写一条事件", async () => {
    await setSetting(ctx.db, "context.compactMaxTokens", 1500)
    try {
      const script = useScript(
        "test/m3-compact",
        new Script([
          step([call("http.page", {})]),
          step([call("checkpoint.mark", { checkpoint: 1, status: "doing" })]),
          step([call("checkpoint.mark", { checkpoint: 1, status: "doing", record: "看过页面" })]),
          step([call("checkpoint.mark", { checkpoint: 1, status: "done", record: "完成" })]),
          step([text("完成")]),
        ])
      )
      const taskId = await createTask(ctx.db, { modelId: "test/m3-compact", toolIds: ["http.page"], steps: [{ id: "s1", text: "读页面", wait: false, checkpoint: "读完页面" }] })
      const sessionId = await runNow(taskId)
      await waitStatus(ctx.db, sessionId, "done")
      const rows = await messagesOf(ctx.db, sessionId)
      const compacted = rows.filter((row) => row.compacted)
      expect(compacted).toHaveLength(1)
      expect(JSON.stringify(compacted[0]!.content)).toContain("页面内容")
      const summary = JSON.stringify(compacted[0]!.summary)
      expect(summary).toContain("【已压缩】")
      expect(summary).toMatch(/全文是文件 f-[0-9a-f]+/)
      // 压缩之后发给模型的历史里没有原文；检查点的结果保留原文
      const last = script.promptText(4)
      expect(last).toContain("【已压缩】")
      expect(last.split("页面内容").length).toBeLessThan(400)
      expect(last).toContain("已勾上第 1 个检查点")
      const event = (await eventsOf(ctx.db, sessionId)).find((each) => each.title.startsWith("上下文压缩"))
      expect(event).toMatchObject({ kind: "plan", title: "上下文压缩：1 条较早的大块内容换成了摘要" })
      expect(event!.detail).toContain("上限 1500 token")
    } finally {
      await setSetting(ctx.db, "context.compactMaxTokens", 0)
    }
  })
})

// ---------- 6. 探索出的步骤 ----------

describe("plan.set 和存为任务步骤", () => {
  it("agent 写下步骤（plan 事件、exploredSteps）；负责人存为任务步骤，记审计；别人不行", async () => {
    useScript(
      "test/m3-plan",
      new Script([step([call("plan.set", { steps: ["读数据", "整理表格"] })]), step([call("plan.set", { steps: ["读数据", "整理表格", "发给负责人"] })]), step([text("完成")])])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/m3-plan" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "done")
    const run = (await query(ctx.app, "sessions.get", wang, { id: sessionId })).data
    expect(run.exploredSteps).toEqual(["读数据", "整理表格", "发给负责人"])
    const plans = run.events.filter((event: { kind: string; toolId?: string }) => event.kind === "plan" && event.toolId === "plan.set")
    expect(plans.map((event: { title: string }) => event.title)).toEqual(["agent 定了 2 步", "agent 更新了步骤（3 步）"])
    expect(plans[1].detail).toBe("1. 读数据\n2. 整理表格\n3. 发给负责人")

    expect((await mutate(ctx.app, "tasks.saveStepsFromSession", li, { sessionId })).error?.data?.code).toBe("FORBIDDEN")
    const saved = await mutate(ctx.app, "tasks.saveStepsFromSession", wang, { sessionId })
    expect(saved.data).toEqual({
      id: taskId,
      steps: [
        { id: "s1", text: "读数据", wait: false },
        { id: "s2", text: "整理表格", wait: false },
        { id: "s3", text: "发给负责人", wait: false },
      ],
    })
    const task = (await query(ctx.app, "tasks.get", wang, { id: taskId })).data
    expect(task.steps.map((each: { text: string }) => each.text)).toEqual(["读数据", "整理表格", "发给负责人"])
    const [audit] = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.action, "task.save_steps"), eq(t.auditEvents.targetId, taskId)))
    expect(audit).toMatchObject({ actorId: "u-wang", detail: { sessionId } })

    // 没写步骤的运行：没有可存的
    useScript("test/m3-plan-none", new Script([step([text("完成")])]))
    const other = await createTask(ctx.db, { modelId: "test/m3-plan-none" })
    const session2 = await runNow(other)
    await waitStatus(ctx.db, session2, "done")
    expect((await mutate(ctx.app, "tasks.saveStepsFromSession", wang, { sessionId: session2 })).error?.data?.code).toBe("BAD_REQUEST")
  })
})

describe("其他", () => {
  it("审批单上隐藏密钥类字段；设置里能改验收轮数和压缩上限", async () => {
    expect(JSON.parse(maskSecretFields(JSON.stringify({ to: "a", password: "p", nested: { apiKey: "k", list: [{ token: "t" }] } })))).toEqual({
      to: "a",
      password: "••••",
      nested: { apiKey: "••••", list: [{ token: "••••" }] },
    })
    expect((await mutate(ctx.app, "settings.updateAgent", wang, { verifyMaxRounds: 3, compactMaxTokens: 0 })).error?.data?.code).toBe("FORBIDDEN")
    const res = await mutate(ctx.app, "settings.updateAgent", lin, { verifyMaxRounds: 3, compactMaxTokens: 50_000 })
    expect(res.error).toBeUndefined()
    const view = await query(ctx.app, "settings.get", lin)
    expect(view.data.agent).toEqual({ verifyMaxRounds: 3, compactMaxTokens: 50_000 })
    await mutate(ctx.app, "settings.updateAgent", lin, { verifyMaxRounds: 2, compactMaxTokens: 0 })
  })
})
