// 右下角助手（docs/dev/copilot.md 9.3）：连真实的测试库，模型用 AI SDK 的假模型（流式按剧本回复），不花钱。
// 覆盖：查的工具直接执行；写的工具出卡、不改库；应用后库变了、审计带 via、模型拿到结果接着说；不要；新消息让旧卡过期；
// 员工新建任务不进卡；update_task 只改给的字段；规则出卡时翻译、应用后已确认；超步数 / 超钱停下；get 拼出的记录和流里一致；只看得到自己的对话。
// 第 10 节：选模型的顺序（本对话设的 → 助手默认 → plan 默认）；本对话的设置（只能改自己的、上限盖过全局、新对话第一句带上）；defaults 接口。
// 第 11 节（看图、上传图片）：带图的消息库里只存编号、模型收到图；模型看不了图时不收；view_image 看运行截图和图库的图；
// 换成看不了图的模型 / 图被删了，历史里的图换成一句话；attach_files_to_task 出卡、应用后挂到任务附件。
import type { AssistantEntry, AssistantStreamEvent } from "@heyagent/shared"
import { SETTING_KEYS } from "@heyagent/shared"
import { convertArrayToReadableStream, MockLanguageModelV4 } from "ai/test"
import { and, desc, eq, inArray } from "drizzle-orm"
import sharp from "sharp"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

import * as t from "../src/db/schema.js"
import { configureEngine } from "../src/engine/runtime.js"
import { saveFile } from "../src/files/service.js"
import { login, mutate, query, setupApp, type TestApp } from "./helpers.js"

// 引擎的对接函数（定时、待办调度）这里不测，换成空的
const engine = vi.hoisted(() => ({ syncTaskSchedule: vi.fn(async () => {}), syncTodo: vi.fn(async () => {}) }))
vi.mock("../src/engine/api.js", () => ({ ...engine, startSession: vi.fn() }))

const MODEL = "openrouter/test-assistant"
const MODEL_B = "openrouter/test-assistant-b"
const MODEL_C = "openrouter/test-assistant-c"
/** 能看图的模型（别的几个 vision = false） */
const MODEL_V = "openrouter/test-assistant-vision"
/** resolveModel 每次拿的模型编号（假模型不管编号，按这个看用的是哪个） */
const usedModels: string[] = []

type DoStream = Extract<NonNullable<ConstructorParameters<typeof MockLanguageModelV4>[0]>["doStream"], (...args: never[]) => unknown>
type LanguageModelV4CallOptions = Parameters<DoStream>[0]
type LanguageModelV4StreamPart = Awaited<ReturnType<DoStream>>["stream"] extends ReadableStream<infer P> ? P : never

// ---------- 假模型：流式一步一步按剧本回复 ----------

type Part = { type: "text"; text: string } | { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }
/** "hang"：一直不回，直到请求被中止（测断线） */
type Turn = { parts: Part[]; costUsd?: number } | Error | "hang"

let callNo = 0
const say = (value: string): Part => ({ type: "text", text: value })
const use = (toolName: string, input: unknown): Part => ({ type: "tool-call", toolCallId: `c${++callNo}`, toolName, input })

class Script {
  readonly prompts: LanguageModelV4CallOptions[] = []
  /** 规则翻译走 doGenerate（结构化输出），按顺序给 */
  readonly generated: unknown[] = []
  readonly turns: Turn[]
  /** 走到 "hang" 那一步时调一下，测试知道模型调用已经开始了 */
  hung?: () => void
  constructor(turns: Turn[]) {
    this.turns = turns
  }

  promptText(index: number) {
    return JSON.stringify(this.prompts[index]?.prompt ?? [])
  }

  readonly model = new MockLanguageModelV4({
    provider: "test",
    modelId: "assistant",
    doStream: async (options) => {
      const index = this.prompts.length
      this.prompts.push(options)
      const turn = this.turns[index] ?? { parts: [say(`（剧本没有第 ${index + 1} 步）`)] }
      if (turn instanceof Error) throw turn
      if (turn === "hang") {
        this.hung?.()
        await new Promise((resolve) => options.abortSignal?.addEventListener("abort", resolve, { once: true }))
        throw new DOMException("aborted", "AbortError")
      }
      const chunks: LanguageModelV4StreamPart[] = [{ type: "stream-start", warnings: [] }]
      for (const [n, part] of turn.parts.entries()) {
        if (part.type === "text") {
          const id = `txt-${n}`
          chunks.push({ type: "text-start", id })
          // 拆成两段，验证 delta 一段段接上
          const half = Math.ceil(part.text.length / 2)
          chunks.push({ type: "text-delta", id, delta: part.text.slice(0, half) })
          if (part.text.length > half) chunks.push({ type: "text-delta", id, delta: part.text.slice(half) })
          chunks.push({ type: "text-end", id })
        } else chunks.push({ type: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: JSON.stringify(part.input) })
      }
      const hasCalls = turn.parts.some((part) => part.type === "tool-call")
      chunks.push({
        type: "finish",
        finishReason: { unified: hasCalls ? "tool-calls" : "stop", raw: hasCalls ? "tool_calls" : "stop" },
        usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 20, text: 20, reasoning: 0 } },
        providerMetadata: { openrouter: { usage: { cost: turn.costUsd ?? 0.001 } } },
      })
      return { stream: convertArrayToReadableStream(chunks) }
    },
    doGenerate: async () => {
      const value = this.generated.shift()
      if (value === undefined) throw new Error("剧本没有准备结构化输出")
      return {
        content: [{ type: "text", text: JSON.stringify(value) }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: { inputTokens: { total: 50, noCache: 50, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } },
        providerMetadata: { openrouter: { usage: { cost: 0.002 } } },
        warnings: [],
      }
    },
  })
}

let script = new Script([])
const useScript = (turns: Turn[]) => (script = new Script(turns))

// ---------- 调接口 ----------

let ctx: TestApp
let lin: string
let wang: string

async function sse(path: string, cookie: string | undefined, body: unknown) {
  const res = await ctx.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body) })
  const raw = await res.text()
  const events = raw
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantStreamEvent)
  return { status: res.status, events, raw }
}
const send = (cookie: string, body: Record<string, unknown>) => sse("/api/assistant/chat", cookie, body)
const decide = (cookie: string, body: Record<string, unknown>) => sse("/api/assistant/apply", cookie, body)

const of = <K extends AssistantStreamEvent["type"]>(events: AssistantStreamEvent[], type: K) => events.filter((event): event is Extract<AssistantStreamEvent, { type: K }> => event.type === type)
const doneOf = (events: AssistantStreamEvent[]) => of(events, "done")[0]
const chatIdOf = (events: AssistantStreamEvent[]) => of(events, "chat")[0]!.chatId

/** 把流里的事件按前端的做法拼成面板记录：entry 追加、delta 接文字、update 整条替换 */
function replay(events: AssistantStreamEvent[]) {
  const list: AssistantEntry[] = []
  for (const event of events) {
    if (event.type === "entry") list.push(structuredClone(event.entry))
    else if (event.type === "delta") {
      const entry = list.find((each) => each.id === event.id)
      if (entry?.kind === "assistant") entry.text += event.text
    } else if (event.type === "update") {
      const index = list.findIndex((each) => each.id === event.entry.id)
      if (index >= 0) list[index] = structuredClone(event.entry)
    }
  }
  return list
}
const withoutAt = (entries: AssistantEntry[]) => entries.map(({ at: _at, ...rest }) => rest)

let taskNo = 9100
async function makeTask(input: { ownerId?: string; title?: string; skillIds?: string[]; memoryIds?: string[] } = {}) {
  const id = `T-${++taskNo}`
  await ctx.db.insert(t.tasks).values({ id, title: input.title ?? `助手测试任务 ${id}`, goal: "按步骤做完", steps: [{ id: "s1", text: "第一步", wait: false }], ownerId: input.ownerId ?? "u-lin", modelId: MODEL, enabled: true })
  for (const [position, refId] of (input.skillIds ?? []).entries()) await ctx.db.insert(t.taskSkills).values({ taskId: id, refId, position })
  for (const [position, refId] of (input.memoryIds ?? []).entries()) await ctx.db.insert(t.taskMemories).values({ taskId: id, refId, position })
  return id
}

async function setSetting(key: string, value: unknown) {
  await ctx.db.insert(t.settings).values({ key, value }).onConflictDoUpdate({ target: t.settings.key, set: { value } })
}

beforeAll(async () => {
  ctx = await setupApp()
  configureEngine({
    keyring: ctx.keyring,
    modelRetryBaseMs: 1,
    modelFactory: ({ modelId }) => {
      usedModels.push(modelId)
      return script.model
    },
  })
  await ctx.db.insert(t.models).values([
    { id: MODEL, providerId: "openrouter", name: "助手测试模型", contextK: 128 },
    { id: MODEL_B, providerId: "openrouter", name: "助手测试模型 B", contextK: 128 },
    { id: MODEL_C, providerId: "openrouter", name: "助手测试模型 C", contextK: 128 },
    { id: MODEL_V, providerId: "openrouter", name: "助手看图模型", contextK: 128, vision: true },
  ])
  await ctx.db.update(t.modelDefaults).set({ modelId: MODEL }).where(eq(t.modelDefaults.role, "plan"))
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
})
afterAll(async () => {
  configureEngine({ modelFactory: undefined })
  await ctx?.close()
})
beforeEach(async () => {
  await setSetting(SETTING_KEYS.assistantMaxSteps, 20)
  await setSetting(SETTING_KEYS.assistantMaxCostUsd, 0.2)
})

describe("右下角助手", () => {
  it("没登录：401", async () => {
    const res = await sse("/api/assistant/chat", undefined, { message: "你好" })
    expect(res.status).toBe(401)
  })

  it("查的工具直接执行；写的出卡不改库；应用后库变了、审计带 via、模型拿到结果接着说；update_task 只改给的字段；get 和流一致", async () => {
    const [skill] = await ctx.db.select({ id: t.skills.id }).from(t.skills).where(eq(t.skills.status, "published")).limit(1)
    const [memory] = await ctx.db.select({ id: t.memories.id }).from(t.memories).where(eq(t.memories.status, "active")).limit(1)
    const id = await makeTask({ title: "每日巡检", skillIds: [skill!.id], memoryIds: [memory!.id] })
    useScript([
      { parts: [use("list_tasks", { query: "巡检" })] },
      { parts: [say("找到了，改成每天 9 点。"), use("update_task", { id, schedule: { cron: "0 9 * * *", text: "每天 9 点" } }), use("get_task", { id })] },
      { parts: [say("改好了：每天 09:00 跑。")] },
    ])

    const first = await send(lin, { message: "把每日巡检改成每天早上 9 点", context: { page: "tasks", params: { id } } })
    expect(first.status).toBe(200)
    const types = first.events.map((event) => event.type)
    expect(types[0]).toBe("chat")
    expect(first.events[1]).toMatchObject({ type: "entry", entry: { kind: "user", text: "把每日巡检改成每天早上 9 点" } })
    expect(types.at(-1)).toBe("done")
    // 系统提示里带了人在看哪一页、选中了哪个任务
    expect(script.prompts[0]!.prompt[0]).toMatchObject({ role: "system" })
    expect(JSON.stringify(script.prompts[0]!.prompt[0])).toContain(`选中的是任务 ${id}「每日巡检」`)
    // 工具定义都发给了模型（不带 execute）；记一下大小，免得越写越长
    const toolDefs = script.prompts[0]!.tools ?? []
    expect(toolDefs.map((each) => each.name)).toContain("update_task")
    const toolChars = JSON.stringify(toolDefs).length
    console.info(`[assistant test] ${toolDefs.length} 个工具定义，共 ${toolChars} 字符；系统提示 ${JSON.stringify(script.prompts[0]!.prompt[0]).length} 字符`)
    expect(toolChars).toBeLessThan(80_000)
    // 查的工具执行了：结果交回模型
    expect(script.promptText(1)).toContain("每日巡检")
    const tools = replay(first.events).filter((entry) => entry.kind === "tool")
    expect(tools.map((entry) => [entry.kind === "tool" && entry.label, entry.kind === "tool" && entry.status])).toEqual([
      ["查任务「巡检」", "done"],
      [`看任务 ${id}`, "done"],
    ])
    // 改的出卡，没改库
    const proposal = of(first.events, "entry").find((event) => event.entry.kind === "proposal")!.entry as Extract<AssistantEntry, { kind: "proposal" }>
    expect(proposal.proposal.status).toBe("pending")
    expect(proposal.proposal.changes).toHaveLength(1)
    expect(proposal.proposal.changes[0]).toMatchObject({ tool: "update_task", destructive: false, title: `修改任务 ${id}「每日巡检」` })
    expect(proposal.proposal.changes[0]!.fields).toEqual([{ label: "定时", before: "不定时（手动运行）", after: "每天 09:00（0 9 * * *）" }])
    expect(doneOf(first.events)).toMatchObject({ pendingProposalId: proposal.id })
    expect(doneOf(first.events)!.costUsd).toBeCloseTo(0.002)
    const [before] = await ctx.db.select().from(t.tasks).where(eq(t.tasks.id, id))
    expect(before!.scheduleCron).toBeNull()
    expect(script.prompts).toHaveLength(2)

    // 应用
    const applied = await decide(lin, { proposalId: proposal.id, accept: true })
    expect(applied.events[0]).toMatchObject({ type: "chat", chatId: chatIdOf(first.events) })
    const update = of(applied.events, "update").find((event) => event.entry.kind === "proposal")!.entry as Extract<AssistantEntry, { kind: "proposal" }>
    expect(update.proposal.status).toBe("applied")
    expect(update.proposal.changes[0]!.result).toEqual({ ok: true, message: `已改好任务 ${id}`, link: { page: "tasks", params: { id } } })
    const [after] = await ctx.db.select().from(t.tasks).where(eq(t.tasks.id, id))
    expect(after!.scheduleCron).toBe("0 9 * * *")
    // 只改给的字段：标题、步骤、挂的技能和记忆都还在
    expect(after!.title).toBe("每日巡检")
    expect(after!.steps).toEqual(before!.steps)
    expect((await ctx.db.select().from(t.taskSkills).where(eq(t.taskSkills.taskId, id))).map((row) => row.refId)).toEqual([skill!.id])
    expect((await ctx.db.select().from(t.taskMemories).where(eq(t.taskMemories.taskId, id))).map((row) => row.refId)).toEqual([memory!.id])
    // 审计看得出是助手改的
    const [audit] = await ctx.db
      .select()
      .from(t.auditEvents)
      .where(and(eq(t.auditEvents.action, "task.update"), eq(t.auditEvents.targetId, id)))
      .orderBy(desc(t.auditEvents.id))
      .limit(1)
    expect(audit!.actorId).toBe("u-lin")
    expect(audit!.detail).toMatchObject({ via: "assistant", chatId: chatIdOf(first.events) })
    // 模型拿到结果接着说
    expect(script.promptText(2)).toContain(`已改好任务 ${id}`)
    expect(replay(applied.events).find((entry) => entry.kind === "assistant")).toMatchObject({ text: "改好了：每天 09:00 跑。" })
    expect(doneOf(applied.events)).toMatchObject({ pendingProposalId: null })

    // get 拼出来的和流里发的一致
    const got = await query(ctx.app, "assistant.get", lin, { id: chatIdOf(first.events) })
    expect(got.error).toBeUndefined()
    expect(withoutAt(got.data.entries)).toEqual(withoutAt(replay([...first.events, ...applied.events])))
    expect(got.data.pendingProposalId).toBeNull()
    // 用的模型不记进对话：没在本对话设置里选过就是 null（跟默认走）
    expect(got.data.modelId).toBeNull()
    expect(usedModels.at(-1)).toBe(MODEL)
    expect(got.data.costUsd).toBeCloseTo(0.003)
    expect(got.data.title).toBe("把每日巡检改成每天早上 9 点")

    // 同一张卡不能再点一次
    const again = await decide(lin, { proposalId: proposal.id, accept: true })
    expect(of(again.events, "error")[0]?.message).toContain("已经处理过了")
  })

  it("不要：库没变，模型拿到 rejected 和人说的原因", async () => {
    const id = await makeTask({ title: "要停用的任务" })
    useScript([{ parts: [use("set_task_enabled", { id, enabled: false })] }, { parts: [say("好的，那要怎么改？")] }])
    const first = await send(lin, { message: "停用它" })
    const proposalId = doneOf(first.events)!.pendingProposalId!
    expect(proposalId).toBeTruthy()
    const rejected = await decide(lin, { proposalId, accept: false, note: "先别停" })
    const update = of(rejected.events, "update")[0]!.entry as Extract<AssistantEntry, { kind: "proposal" }>
    expect(update.proposal.status).toBe("rejected")
    const [row] = await ctx.db.select().from(t.tasks).where(eq(t.tasks.id, id))
    expect(row!.enabled).toBe(true)
    expect(script.promptText(1)).toContain("rejected")
    expect(script.promptText(1)).toContain("先别停")
    expect(doneOf(rejected.events)).toMatchObject({ pendingProposalId: null })
  })

  it("有卡没处理又发了新消息：旧卡过期，调用回 expired，接着处理新消息；过期的卡不能再应用", async () => {
    const id = await makeTask({ title: "过期测试" })
    useScript([{ parts: [use("delete_task", { id })] }, { parts: [say("那就不删了。")] }])
    const first = await send(lin, { message: "删掉过期测试" })
    const chatId = chatIdOf(first.events)
    const proposalId = doneOf(first.events)!.pendingProposalId!
    const card = of(first.events, "entry").find((event) => event.entry.kind === "proposal")!.entry as Extract<AssistantEntry, { kind: "proposal" }>
    expect(card.proposal.changes[0]).toMatchObject({ destructive: true, title: `删除任务 ${id}「过期测试」` })

    const second = await send(lin, { chatId, message: "算了不删了" })
    expect(second.events.map((event) => event.type).slice(0, 3)).toEqual(["chat", "entry", "update"])
    expect(of(second.events, "update")[0]).toMatchObject({ entry: { kind: "proposal", id: proposalId, proposal: { status: "expired" } } })
    const [proposal] = await ctx.db.select().from(t.assistantProposals).where(eq(t.assistantProposals.id, proposalId))
    expect(proposal!.status).toBe("expired")
    expect(script.promptText(1)).toContain("expired")
    expect((await ctx.db.select().from(t.tasks).where(eq(t.tasks.id, id))).length).toBe(1)
    const late = await decide(lin, { proposalId, accept: true })
    expect(of(late.events, "error")[0]?.message).toContain("过期")
    const got = await query(ctx.app, "assistant.get", lin, { id: chatId })
    expect(withoutAt(got.data.entries)).toEqual(withoutAt(replay([...first.events, ...second.events])))
  })

  it("员工新建任务不进卡：没权限交回模型；员工能改自己负责的任务", async () => {
    const own = await makeTask({ ownerId: "u-wang", title: "王悦的任务" })
    const others = await makeTask({ ownerId: "u-lin", title: "林舟的任务" })
    useScript([
      { parts: [use("create_task", { title: "新任务", goal: "做完", steps: [], schedule: null }), use("update_task", { id: others, title: "改别人的" }), use("update_task", { id: own, title: "王悦改过的任务" })] },
      { parts: [say("新建任务要主管来做；你的任务我列好了。")] },
    ])
    const res = await send(wang, { message: "建个任务，再把两个任务改个名" })
    const errors = replay(res.events).filter((entry) => entry.kind === "tool" && entry.status === "error")
    expect(errors).toHaveLength(2)
    expect(errors[0]).toMatchObject({ tool: "create_task" })
    expect(errors.map((entry) => entry.kind === "tool" && entry.detail).join()).toContain("你没有权限")
    const card = of(res.events, "entry").find((event) => event.entry.kind === "proposal")!.entry as Extract<AssistantEntry, { kind: "proposal" }>
    expect(card.proposal.changes.map((change) => change.title)).toEqual([`修改任务 ${own}「王悦的任务」`])
    // 出卡就停了：第二步要等人处理卡
    expect(script.prompts).toHaveLength(1)
    const applied = await decide(wang, { proposalId: card.id, accept: true })
    expect(of(applied.events, "update")[0]).toMatchObject({ entry: { proposal: { changes: [{ result: { ok: true } }] } } })
    // 处理完卡，模型拿到全部结果：没权限的两项、改好的一项
    expect(script.promptText(1)).toContain("新建任务只有主管能做")
    expect(script.promptText(1)).toContain("只有负责人和主管能改这个任务")
    expect(script.promptText(1)).toContain(`已改好任务 ${own}`)
    expect((await ctx.db.select().from(t.tasks).where(eq(t.tasks.id, own)))[0]!.title).toBe("王悦改过的任务")
    expect((await ctx.db.select().from(t.tasks).where(eq(t.tasks.id, others)))[0]!.title).toBe("林舟的任务")
  })

  it("一张卡上每项单独成败：一项失败不影响别的", async () => {
    const id = await makeTask({ title: "单独成败" })
    useScript([{ parts: [use("add_task_memory", { taskId: id, content: "价格都含税" }), use("delete_task", { id })] }, { parts: [say("记好了，删除没成。")] }])
    const first = await send(lin, { message: "记一条，然后删掉任务" })
    const proposalId = doneOf(first.events)!.pendingProposalId!
    // 出卡以后这个任务有了运行记录：删除失败，前面加记忆照样成功
    await ctx.db.insert(t.sessions).values({ id: `R-${id.slice(2)}-1`, taskId: id, status: "done", modelId: MODEL, startedAt: new Date() })
    const applied = await decide(lin, { proposalId, accept: true })
    // 每做完一项发一次 update
    expect(of(applied.events, "update")).toHaveLength(2)
    const changes = (of(applied.events, "update").at(-1)!.entry as Extract<AssistantEntry, { kind: "proposal" }>).proposal.changes
    expect(changes[0]!.result).toMatchObject({ ok: true })
    expect(changes[1]!.result).toMatchObject({ ok: false })
    expect(changes[1]!.result!.message).toContain("运行记录")
    expect((await ctx.db.select().from(t.taskMemoryEntries).where(eq(t.taskMemoryEntries.taskId, id))).map((row) => row.content)).toEqual(["价格都含税"])
    expect((await ctx.db.select().from(t.tasks).where(eq(t.tasks.id, id))).length).toBe(1)
    expect(script.promptText(1)).toContain("没做成")
  })

  it("规则：出卡时翻译（花的钱算进这次请求），应用后建好并已确认", async () => {
    useScript([{ parts: [use("create_rule", { name: "花钱前问主管", trigger: "要花钱之前", action: "先问主管", toolIds: [] })] }, { parts: [say("规则建好了，已经生效。")] }])
    script.generated.push({
      supported: true,
      reason: "",
      trigger: { type: "before_tool", toolIds: [], risks: ["money"], anyTool: false, domains: [], usd: 0, proposes: [] },
      actions: [{ type: "ask_human", to: "admin", userId: "", reason: "" }],
    })
    const first = await send(lin, { message: "建一条规则：花钱前先问主管" })
    const card = of(first.events, "entry").find((event) => event.entry.kind === "proposal")!.entry as Extract<AssistantEntry, { kind: "proposal" }>
    const understood = card.proposal.changes[0]!.fields.find((field) => field.label === "系统理解为")
    expect(understood?.after).toContain("拦下交给主管审批")
    // 1 步对话 0.001 + 翻译 0.002
    expect(doneOf(first.events)!.costUsd).toBeCloseTo(0.003)
    expect(await ctx.db.select().from(t.rules).where(eq(t.rules.name, "花钱前问主管"))).toHaveLength(0)

    const applied = await decide(lin, { proposalId: card.id, accept: true })
    const result = (of(applied.events, "update")[0]!.entry as Extract<AssistantEntry, { kind: "proposal" }>).proposal.changes[0]!.result!
    expect(result.ok).toBe(true)
    expect(result.message).toContain("已生效")
    const [rule] = await ctx.db.select().from(t.rules).where(eq(t.rules.name, "花钱前问主管"))
    expect(rule!.confirmedById).toBe("u-lin")
    expect(rule!.compiledTrigger).toMatchObject({ trigger: { type: "before_tool" } })
    const audits = await ctx.db.select().from(t.auditEvents).where(eq(t.auditEvents.targetId, rule!.id))
    expect(audits.map((row) => row.action).sort()).toEqual(["rule.confirm", "rule.create"])
    expect(audits.every((row) => (row.detail as { via?: string }).via === "assistant")).toBe(true)
  })

  it("规则翻译失败：这项不进卡，错误交回模型", async () => {
    useScript([{ parts: [use("create_rule", { name: "翻译不了", trigger: "某种情况", action: "某种做法", toolIds: [] })] }, { parts: [say("翻译失败了。")] }])
    // 不准备结构化输出：翻译时模型报错
    const res = await send(lin, { message: "建条规则" })
    expect(doneOf(res.events)!.pendingProposalId).toBeNull()
    expect(script.promptText(1)).toContain("规则翻译失败")
  })

  it("引用了库里没有的编号（模型编的工具编号）：这项不进卡，「找不到」交回模型", async () => {
    useScript([
      { parts: [use("create_skill", { name: "编号不存在", dept: "通用", description: "试试", body: "# 试试", toolIds: ["mcp-made-up"] })] },
      { parts: [use("create_skill", { name: "编号不存在", dept: "通用", description: "试试", body: "# 试试", toolIds: [] })] },
    ])
    const res = await send(lin, { message: "建个技能" })
    expect(script.promptText(1)).toContain("找不到：工具 mcp-made-up")
    const cards = of(res.events, "entry").filter((event) => event.entry.kind === "proposal")
    expect(cards).toHaveLength(1)
    expect((cards[0]!.entry as Extract<AssistantEntry, { kind: "proposal" }>).proposal.changes[0]!.title).toContain("编号不存在")
  })

  it("参数不对的写调用不进卡，错误交回模型让它改了重调", async () => {
    const id = await makeTask()
    useScript([{ parts: [use("update_task", { id, steps: "不是数组" })] }, { parts: [use("update_task", { id, goal: "改好的完成标准" })] }])
    const res = await send(lin, { message: "改一下完成标准" })
    expect(script.promptText(1)).toContain("参数不对")
    const card = of(res.events, "entry").find((event) => event.entry.kind === "proposal")!.entry as Extract<AssistantEntry, { kind: "proposal" }>
    expect(card.proposal.changes[0]!.fields).toEqual([{ label: "完成标准", before: "按步骤做完", after: "改好的完成标准" }])
  })

  it("超步数、超花费都停下，发提示", async () => {
    await setSetting(SETTING_KEYS.assistantMaxSteps, 2)
    useScript([{ parts: [use("list_tasks", {})] }, { parts: [use("list_rules", {})] }, { parts: [say("不该走到这里")] }])
    const steps = await send(lin, { message: "查一圈" })
    expect(script.prompts).toHaveLength(2)
    const notice = replay(steps.events).find((entry) => entry.kind === "notice")
    expect(notice).toMatchObject({ tone: "info" })
    expect(notice?.kind === "notice" && notice.text).toContain("2 步")

    await setSetting(SETTING_KEYS.assistantMaxSteps, 20)
    await setSetting(SETTING_KEYS.assistantMaxCostUsd, 0.01)
    useScript([{ parts: [use("list_tasks", {})], costUsd: 0.02 }, { parts: [say("不该走到这里")] }])
    const cost = await send(lin, { message: "再查一圈" })
    expect(script.prompts).toHaveLength(1)
    const costNotice = replay(cost.events).find((entry) => entry.kind === "notice")
    expect(costNotice?.kind === "notice" && costNotice.text).toContain("$0.0200")
    expect(doneOf(cost.events)!.costUsd).toBeCloseTo(0.02)
    // 提示存下来了，刷新后还在
    const got = await query(ctx.app, "assistant.get", lin, { id: chatIdOf(cost.events) })
    expect(withoutAt(got.data.entries)).toEqual(withoutAt(replay(cost.events)))
  })

  it("模型出错：可重试的重试，重试完还不行发 error 提示", async () => {
    useScript([new Error("网络断了"), { parts: [say("好了")] }])
    const ok = await send(lin, { message: "你好" })
    expect(replay(ok.events).find((entry) => entry.kind === "assistant")).toMatchObject({ text: "好了" })

    useScript([new Error("一"), new Error("二"), new Error("三"), new Error("四")])
    const failed = await send(lin, { message: "你好" })
    const notice = replay(failed.events).find((entry) => entry.kind === "notice")
    expect(notice).toMatchObject({ tone: "error" })
    expect(notice?.kind === "notice" && notice.text).toContain("模型调用失败")
    expect(doneOf(failed.events)).toBeTruthy()
  })

  it("没配模型：发提示「先到『模型』页设助手的默认模型」", async () => {
    const [plan] = await ctx.db.select().from(t.modelDefaults).where(eq(t.modelDefaults.role, "plan"))
    await ctx.db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "plan"))
    try {
      const res = await send(wang, { message: "你好" })
      expect(replay(res.events).find((entry) => entry.kind === "notice")).toMatchObject({ text: "还没有配模型，先到「模型」页设助手的默认模型（或规划的默认模型）", tone: "error" })
      expect((await query(ctx.app, "assistant.defaults", wang)).data).toMatchObject({ modelId: null, modelName: null })
      // 新对话第一句带上的模型不存在：不建对话，发 error
      const before = (await ctx.db.select().from(t.assistantChats).where(eq(t.assistantChats.userId, "u-wang"))).length
      const bad = await send(wang, { message: "你好", settings: { modelId: "nope/none", maxSteps: null, maxCostUsd: null } })
      expect(of(bad.events, "error")[0]?.message).toContain("本对话设的模型用不了")
      expect((await ctx.db.select().from(t.assistantChats).where(eq(t.assistantChats.userId, "u-wang"))).length).toBe(before)
    } finally {
      await ctx.db.insert(t.modelDefaults).values(plan!)
    }
  })

  it("选模型：本对话设的 → 「模型」页的助手默认 → plan 默认；defaults 接口跟着变", async () => {
    // 员工也能读默认值
    expect((await query(ctx.app, "assistant.defaults", wang)).data).toEqual({ modelId: MODEL, modelName: "助手测试模型", maxSteps: 20, maxCostUsd: 0.2 })
    useScript([{ parts: [say("一")] }, { parts: [say("二")] }, { parts: [say("三")] }, { parts: [say("四")] }])
    const first = await send(lin, { message: "用哪个模型" })
    const chatId = chatIdOf(first.events)
    expect(usedModels.at(-1)).toBe(MODEL)

    await ctx.db.insert(t.modelDefaults).values({ role: "assistant", modelId: MODEL_B })
    try {
      expect((await query(ctx.app, "assistant.defaults", wang)).data).toMatchObject({ modelId: MODEL_B, modelName: "助手测试模型 B" })
      // 没单独设过的对话跟着默认走
      await send(lin, { chatId, message: "再说一句" })
      expect(usedModels.at(-1)).toBe(MODEL_B)

      const set = await mutate(ctx.app, "assistant.updateSettings", lin, { id: chatId, modelId: MODEL_C, maxSteps: null, maxCostUsd: null })
      expect(set.error).toBeUndefined()
      expect(set.data).toMatchObject({ id: chatId, modelId: MODEL_C, maxSteps: null, maxCostUsd: null })
      await send(lin, { chatId, message: "换了模型" })
      expect(usedModels.at(-1)).toBe(MODEL_C)
      // 用过以后也不改本对话的设置
      expect((await query(ctx.app, "assistant.get", lin, { id: chatId })).data.modelId).toBe(MODEL_C)

      // 本对话设的模型下架了：不偷偷换，提示去设置里换
      await ctx.db.update(t.models).set({ kind: "embedding" }).where(eq(t.models.id, MODEL_C))
      const gone = await send(lin, { chatId, message: "模型没了" })
      expect(replay(gone.events).find((entry) => entry.kind === "notice")).toMatchObject({ tone: "error", text: expect.stringContaining("本对话设的模型用不了") })
      await ctx.db.update(t.models).set({ kind: "chat" }).where(eq(t.models.id, MODEL_C))

      // 改回跟默认走
      await mutate(ctx.app, "assistant.updateSettings", lin, { id: chatId, modelId: null, maxSteps: null, maxCostUsd: null })
      await send(lin, { chatId, message: "跟默认走" })
      expect(usedModels.at(-1)).toBe(MODEL_B)
    } finally {
      await ctx.db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "assistant"))
    }
  })

  it("本对话的设置：只能改自己的；模型要是库里的聊天模型；上限在全局的范围内", async () => {
    useScript([{ parts: [say("好")] }])
    const chatId = chatIdOf((await send(lin, { message: "设置测试" })).events)
    const [before] = await ctx.db.select().from(t.assistantChats).where(eq(t.assistantChats.id, chatId))
    const settings = { id: chatId, modelId: null, maxSteps: 5, maxCostUsd: 0.5 }
    expect((await mutate(ctx.app, "assistant.updateSettings", wang, settings)).error?.data?.code).toBe("NOT_FOUND")
    expect((await mutate(ctx.app, "assistant.updateSettings", lin, { ...settings, modelId: "nope/none" })).error?.data?.code).toBe("BAD_REQUEST")
    expect((await mutate(ctx.app, "assistant.updateSettings", lin, { ...settings, maxSteps: 101 })).error?.data?.code).toBe("BAD_REQUEST")
    expect((await mutate(ctx.app, "assistant.updateSettings", lin, { ...settings, maxCostUsd: 11 })).error?.data?.code).toBe("BAD_REQUEST")
    const [untouched] = await ctx.db.select().from(t.assistantChats).where(eq(t.assistantChats.id, chatId))
    expect(untouched).toMatchObject({ modelId: null, maxSteps: null, maxCostUsd: null })

    const ok = await mutate(ctx.app, "assistant.updateSettings", lin, settings)
    expect(ok.data).toMatchObject({ maxSteps: 5, maxCostUsd: 0.5 })
    const [after] = await ctx.db.select().from(t.assistantChats).where(eq(t.assistantChats.id, chatId))
    // 改设置不算聊过：以前的对话里不往前挪
    expect(after!.updatedAt.toISOString()).toBe(before!.updatedAt.toISOString())
    expect((await query(ctx.app, "assistant.chats", lin)).data.find((chat: { id: string }) => chat.id === chatId)).toMatchObject({ maxSteps: 5, maxCostUsd: 0.5 })
  })

  it("本对话的上限盖过全局的", async () => {
    useScript([{ parts: [say("好")] }])
    const chatId = chatIdOf((await send(lin, { message: "上限测试" })).events)
    await mutate(ctx.app, "assistant.updateSettings", lin, { id: chatId, modelId: null, maxSteps: 2, maxCostUsd: null })
    useScript([{ parts: [use("list_tasks", {})] }, { parts: [use("list_rules", {})] }, { parts: [say("不该走到这里")] }])
    const steps = await send(lin, { chatId, message: "查一圈" })
    expect(script.prompts).toHaveLength(2)
    expect(replay(steps.events).find((entry) => entry.kind === "notice")).toMatchObject({ text: expect.stringContaining("2 步") })

    // 全局更紧时，本对话设的更宽也照本对话的
    await setSetting(SETTING_KEYS.assistantMaxCostUsd, 0.01)
    await mutate(ctx.app, "assistant.updateSettings", lin, { id: chatId, modelId: null, maxSteps: null, maxCostUsd: 1 })
    useScript([{ parts: [use("list_tasks", {})], costUsd: 0.02 }, { parts: [say("到这里了")] }])
    const cost = await send(lin, { chatId, message: "再查一圈" })
    expect(script.prompts).toHaveLength(2)
    expect(replay(cost.events).find((entry) => entry.kind === "notice")).toBeUndefined()
  })

  it("新对话第一句带上设置：建对话时一起存，这次请求就按它跑", async () => {
    useScript([{ parts: [use("list_tasks", {})] }, { parts: [say("不该走到这里")] }])
    const res = await send(lin, { message: "带设置的新对话", settings: { modelId: MODEL_B, maxSteps: 1, maxCostUsd: 0.5 } })
    const chatId = chatIdOf(res.events)
    expect(usedModels.at(-1)).toBe(MODEL_B)
    expect(script.prompts).toHaveLength(1)
    expect(replay(res.events).find((entry) => entry.kind === "notice")).toMatchObject({ text: expect.stringContaining("1 步") })
    expect((await query(ctx.app, "assistant.get", lin, { id: chatId })).data).toMatchObject({ modelId: MODEL_B, maxSteps: 1, maxCostUsd: 0.5 })
    // 已有的对话再带 settings 不管用（改设置走 updateSettings）
    useScript([{ parts: [say("好")] }])
    await send(lin, { chatId, message: "再来", settings: { modelId: MODEL_C, maxSteps: 3, maxCostUsd: null } })
    expect(usedModels.at(-1)).toBe(MODEL_B)
    expect((await query(ctx.app, "assistant.get", lin, { id: chatId })).data).toMatchObject({ modelId: MODEL_B, maxSteps: 1 })
  })

  it("只看得到自己的对话；删对话", async () => {
    useScript([{ parts: [use("delete_task", { id: await makeTask() })] }])
    const mine = await send(lin, { message: "林舟的对话" })
    const chatId = chatIdOf(mine.events)
    const proposalId = doneOf(mine.events)!.pendingProposalId!

    const wangChats = await query(ctx.app, "assistant.chats", wang)
    expect(wangChats.data.some((chat: { id: string }) => chat.id === chatId)).toBe(false)
    const linChats = await query(ctx.app, "assistant.chats", lin)
    expect(linChats.data[0]).toMatchObject({ id: chatId, title: "林舟的对话" })
    expect((await query(ctx.app, "assistant.get", wang, { id: chatId })).error?.data?.code).toBe("NOT_FOUND")
    expect(of((await decide(wang, { proposalId, accept: true })).events, "error")[0]?.message).toBe("找不到这张确认卡")
    expect(of((await send(wang, { chatId, message: "插一句" })).events, "error")[0]?.message).toContain("找不到这段对话")
    expect((await mutate(ctx.app, "assistant.delete", wang, { id: chatId })).error?.data?.code).toBe("NOT_FOUND")

    expect((await mutate(ctx.app, "assistant.delete", lin, { id: chatId })).data).toEqual({ id: chatId })
    expect((await query(ctx.app, "assistant.get", lin, { id: chatId })).error?.data?.code).toBe("NOT_FOUND")
  })

  it("断线：停掉模型调用，已经存下的照常保留，不发 done", async () => {
    useScript([{ parts: [use("list_tasks", {})] }, "hang"])
    const started = new Promise<void>((resolve) => (script.hung = resolve))
    const abort = new AbortController()
    const res = await ctx.app.request("/api/assistant/chat", { method: "POST", headers: { "content-type": "application/json", cookie: lin }, body: JSON.stringify({ message: "查一下就断" }), signal: abort.signal })
    const reader = res.body!.getReader()
    const chunks: string[] = []
    const reading = (async () => {
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          chunks.push(new TextDecoder().decode(value))
        }
      } catch {
        // 中止后读流会报错
      }
    })()
    await started
    abort.abort()
    await reading
    const events = chunks
      .join("")
      .split("\n\n")
      .filter((chunk) => chunk.startsWith("data: "))
      .map((chunk) => JSON.parse(chunk.slice(6)) as AssistantStreamEvent)
    expect(of(events, "done")).toHaveLength(0)
    const chatId = chatIdOf(events)
    // 第一步（查任务）存下了；花掉的钱也记上了
    const rows = await ctx.db.select().from(t.assistantMessages).where(eq(t.assistantMessages.chatId, chatId)).orderBy(t.assistantMessages.seq)
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "tool"])
    await expect.poll(async () => (await ctx.db.select().from(t.assistantChats).where(eq(t.assistantChats.id, chatId)))[0]!.costUsd).toBeCloseTo(0.001)
  })

  it("每人只留最近 50 段对话", async () => {
    const old = new Date("2026-01-01T00:00:00Z")
    await ctx.db.insert(t.assistantChats).values(Array.from({ length: 55 }, (_, n) => ({ id: `ac-old-${n}`, userId: "u-wang", title: `旧对话 ${n}`, createdAt: old, updatedAt: old })))
    useScript([{ parts: [say("你好")] }])
    const res = await send(wang, { message: "新的一段" })
    const chats = await ctx.db.select().from(t.assistantChats).where(eq(t.assistantChats.userId, "u-wang"))
    expect(chats).toHaveLength(50)
    expect(chats.some((chat) => chat.id === chatIdOf(res.events))).toBe(true)
  })

  it("请求不对：发 error 事件", async () => {
    const res = await send(lin, { message: "" })
    expect(res.status).toBe(200)
    expect(of(res.events, "error")[0]?.message).toContain("请求不对")
  })
})

// ---------- 第 11 节：看图、上传图片 ----------

const pngOf = (color: string) => sharp({ create: { width: 40, height: 30, channels: 3, background: color } }).png().toBuffer()

/** 照前端的做法：先 POST /api/files 上传拿编号 */
async function uploadFile(cookie: string, name: string, data: Buffer | string, type: string) {
  const form = new FormData()
  form.append("file", new File([typeof data === "string" ? data : new Uint8Array(data)], name, { type }))
  const res = await ctx.app.request("/api/files", { method: "POST", body: form, headers: { cookie } })
  return (await res.json()) as { id: string; name: string; mime: string; size: number; url: string }
}
const uploadImage = async (cookie: string, name: string, color = "#f00") => uploadFile(cookie, name, await pngOf(color), "image/png")

type PromptPart = { type: string; text?: string; mediaType?: string; data?: unknown; filename?: string }
/** 第 index 次调模型时，发过去的所有消息里的图（file part） */
const filePartsOf = (index: number) =>
  script.prompts[index]!.prompt.flatMap((message) => (Array.isArray(message.content) ? (message.content as PromptPart[]) : [])).filter((part) => part.type === "file")

const visionSettings = { modelId: MODEL_V, maxSteps: null, maxCostUsd: null }
const chatCount = async (userId: string) => (await ctx.db.select().from(t.assistantChats).where(eq(t.assistantChats.userId, userId))).length

describe("右下角助手：看图、上传图片", () => {
  it("带图发消息：库里只存编号，模型收到缩过的图和「附图」一句，记录里有图；只发图的标题是「图片」；换成看不了图的模型 / 图删了，历史里换成一句话", async () => {
    const a = await uploadImage(lin, "a.png", "#f00")
    const b = await uploadImage(lin, "b.png", "#00f")
    useScript([{ parts: [say("左边红的，右边蓝的。")] }])
    const first = await send(lin, { message: "看看这两张", images: [a.id, b.id], settings: visionSettings })
    const chatId = chatIdOf(first.events)
    const user = replay(first.events).find((entry) => entry.kind === "user")!
    expect(user).toMatchObject({ text: "看看这两张", images: [{ id: a.id, name: "a.png", mime: "image/png", size: a.size, url: `/api/files/${a.id}` }, { id: b.id, name: "b.png" }] })
    // 库里不存图片内容，只存编号
    const [row] = await ctx.db.select().from(t.assistantMessages).where(and(eq(t.assistantMessages.chatId, chatId), eq(t.assistantMessages.role, "user")))
    expect(row!.message).toEqual({ role: "user", content: [{ type: "text", text: "看看这两张" }], files: [a.id, b.id] })
    // 模型收到：文字 + 附图的编号 + 两张 JPEG
    expect(script.promptText(0)).toContain(`（附图：${a.id} a.png、${b.id} b.png）`)
    expect(script.promptText(0)).not.toContain('"files"')
    const parts = filePartsOf(0)
    expect(parts).toHaveLength(2)
    expect(parts.every((part) => part.mediaType === "image/jpeg")).toBe(true)
    // get 拼出来的和流里一致
    const got = await query(ctx.app, "assistant.get", lin, { id: chatId })
    expect(withoutAt(got.data.entries)).toEqual(withoutAt(replay(first.events)))

    // 换成看不了图的模型：再说一句（不带图）照常能聊，历史里的图换成一句话
    await mutate(ctx.app, "assistant.updateSettings", lin, { id: chatId, modelId: MODEL, maxSteps: null, maxCostUsd: null })
    useScript([{ parts: [say("好")] }])
    await send(lin, { chatId, message: "接着说" })
    expect(filePartsOf(0)).toHaveLength(0)
    expect(script.promptText(0)).toContain(`[图片 ${a.id}（a.png）：当前模型看不了图]`)

    // 一张图被删了：换回能看图的模型，删了的那张换成一句话，另一张照发；记录里只列还在的
    await ctx.db.delete(t.files).where(eq(t.files.id, b.id))
    await mutate(ctx.app, "assistant.updateSettings", lin, { id: chatId, modelId: MODEL_V, maxSteps: null, maxCostUsd: null })
    useScript([{ parts: [say("好")] }])
    await send(lin, { chatId, message: "再看看" })
    expect(filePartsOf(0)).toHaveLength(1)
    expect(script.promptText(0)).toContain(`[图片 ${b.id} 已经删了]`)
    const after = await query(ctx.app, "assistant.get", lin, { id: chatId })
    expect(after.data.entries.find((entry: AssistantEntry) => entry.kind === "user").images.map((image: { id: string }) => image.id)).toEqual([a.id])

    // 只发图：标题是「图片」
    const c = await uploadImage(lin, "c.png")
    useScript([{ parts: [say("一张红的图。")] }])
    const only = await send(lin, { images: [c.id], settings: visionSettings })
    expect(of(only.events, "chat")[0]!.title).toBe("图片")
    expect(replay(only.events).find((entry) => entry.kind === "user")).toMatchObject({ text: "", images: [{ id: c.id }] })
    expect(script.promptText(0)).toContain(`（附图：${c.id} c.png）`)
  })

  it("发图被拒：模型看不了图、不是图片、找不到；什么都不存，对话不建、不多一条消息", async () => {
    const image = await uploadImage(wang, "x.png")
    const text = await uploadFile(wang, "x.txt", "hello", "text/plain")
    const before = await chatCount("u-wang")
    // 默认模型（plan）看不了图
    const rejected = await send(wang, { message: "看图", images: [image.id] })
    expect(of(rejected.events, "error")[0]?.message).toBe("本对话用的模型 助手测试模型 看不了图，在「本对话的设置」里换一个能看图的模型")
    expect(of(rejected.events, "chat")).toHaveLength(0)
    expect(await chatCount("u-wang")).toBe(before)

    const notImage = await send(wang, { message: "看图", images: [text.id], settings: visionSettings })
    expect(of(notImage.events, "error")[0]?.message).toContain("不是图片")
    const missing = await send(wang, { message: "看图", images: ["f-nope"], settings: visionSettings })
    expect(of(missing.events, "error")[0]?.message).toContain("找不到图片 f-nope")
    expect(await chatCount("u-wang")).toBe(before)

    // 已有的对话：不插消息
    useScript([{ parts: [say("你好")] }])
    const chatId = chatIdOf((await send(wang, { message: "你好" })).events)
    const rows = async () => (await ctx.db.select().from(t.assistantMessages).where(eq(t.assistantMessages.chatId, chatId))).length
    const count = await rows()
    const again = await send(wang, { chatId, message: "看图", images: [image.id] })
    expect(of(again.events, "error")[0]?.message).toContain("看不了图")
    expect(await rows()).toBe(count)
    // 什么都没说也没带图：请求不对
    expect(of((await send(wang, { chatId, images: [] })).events, "error")[0]?.message).toContain("请求不对")
  })

  it("view_image：查运行的文件、看截图和图库的图；图接在工具结果后面发给模型、存成 image 行；记录里工具那条带图；看不了图的模型报错", async () => {
    const taskId = await makeTask({ title: "截图任务" })
    const runId = `R-${taskId.slice(2)}-7`
    await ctx.db.insert(t.sessions).values({ id: runId, taskId, status: "done", modelId: MODEL, startedAt: new Date() })
    const shot = await saveFile(ctx.db, { data: await pngOf("#0f0"), name: "screenshot.png", kind: "screenshot", sessionId: runId })
    const log = await saveFile(ctx.db, { data: Buffer.from("日志"), name: "out.txt", kind: "tool_output", sessionId: runId })
    const original = await saveFile(ctx.db, { data: await pngOf("#ff0"), name: "gallery.png", kind: "gallery" })
    const thumb = await saveFile(ctx.db, { data: await pngOf("#ff0"), name: "thumb.webp", kind: "gallery_thumb" })
    await ctx.db.insert(t.galleryImages).values({ id: "img-9901", fileId: original.id, thumbFileId: thumb.id, sha256: original.sha256, name: "gallery.png", mime: "image/png", size: original.size, width: 40, height: 30, via: "web" })

    useScript([
      { parts: [use("list_run_files", { runId })] },
      { parts: [say("看一下截图。"), use("view_image", { fileId: shot.id }), use("view_image", { galleryImageId: "img-9901" }), use("view_image", { fileId: log.id }), use("view_image", { galleryImageId: "img-nope" })] },
      { parts: [say("截图是绿的，图库那张是黄的。")] },
    ])
    const res = await send(lin, { message: "看看运行的截图", settings: visionSettings })
    const chatId = chatIdOf(res.events)
    // list_run_files 列出了截图，标了能看
    expect(script.promptText(1)).toContain(shot.id)
    expect(script.promptText(1)).toContain('\\"image\\":true')
    // 第三次调模型：工具结果说图在下一条消息里，后面一条 user 消息带两张图
    const third = script.prompts[2]!.prompt
    const toolIndex = third.findLastIndex((message) => message.role === "tool")
    expect(JSON.stringify(third[toolIndex])).toContain("图片在下一条消息里")
    expect(third[toolIndex + 1]).toMatchObject({ role: "user" })
    expect(JSON.stringify(third[toolIndex + 1])).toContain(`view_image 看的图（${shot.id} screenshot.png、${original.id} gallery.png）`)
    expect(filePartsOf(2)).toHaveLength(2)
    // 不是图片的、图库里没有的：报错交回模型
    expect(JSON.stringify(third[toolIndex])).toContain("不是图片")
    expect(JSON.stringify(third[toolIndex])).toContain("图库里没有 img-nope")

    // 存库：image 行紧跟在 tool 行后面，只存编号
    const rows = await ctx.db.select().from(t.assistantMessages).where(eq(t.assistantMessages.chatId, chatId)).orderBy(t.assistantMessages.seq)
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "tool", "assistant", "tool", "image", "assistant"])
    const calls = (rows[3]!.message as { content: { type: string; toolCallId?: string }[] }).content.filter((part) => part.type === "tool-call").map((part) => part.toolCallId)
    expect(rows[5]!.message).toEqual({ images: [{ callId: calls[0], fileId: shot.id }, { callId: calls[1], fileId: original.id }] })
    expect(rows.map((row) => row.seq)).toEqual(rows.map((_, index) => rows[0]!.seq + index))

    // 记录：view_image 那条带图；和 get 一致
    const tools = replay(res.events).filter((entry) => entry.kind === "tool")
    expect(tools.map((entry) => entry.kind === "tool" && [entry.label, entry.status, entry.images?.map((image) => image.id)])).toEqual([
      [`查运行 ${runId} 的文件`, "done", undefined],
      [`看图 ${shot.id}`, "done", [shot.id]],
      ["看图 img-9901", "done", [original.id]],
      [`看图 ${log.id}`, "error", undefined],
      ["看图 img-nope", "error", undefined],
    ])
    const got = await query(ctx.app, "assistant.get", lin, { id: chatId })
    expect(withoutAt(got.data.entries)).toEqual(withoutAt(replay(res.events)))

    // 接着聊：历史里的 image 行照样带图发给模型
    useScript([{ parts: [say("好")] }])
    await send(lin, { chatId, message: "嗯" })
    expect(filePartsOf(0)).toHaveLength(2)

    // 看不了图的模型：view_image 报错，不存 image 行
    useScript([{ parts: [use("view_image", { fileId: shot.id })] }, { parts: [say("看不了")] }])
    const blind = await send(lin, { message: "看截图" })
    expect(script.promptText(1)).toContain("当前模型看不了图")
    expect(filePartsOf(1)).toHaveLength(0)
    const blindRows = await ctx.db.select().from(t.assistantMessages).where(eq(t.assistantMessages.chatId, chatIdOf(blind.events)))
    expect(blindRows.some((row) => row.role === "image")).toBe(false)
  })

  it("一步里有 view_image 又有卡：image 行在 tool 行后面，卡的结果照样并进 tool 行", async () => {
    const id = await makeTask({ title: "看图再改" })
    const image = await uploadImage(lin, "ref.png")
    useScript([{ parts: [use("view_image", { fileId: image.id }), use("set_task_enabled", { id, enabled: false })] }, { parts: [say("停好了")] }])
    const first = await send(lin, { message: "看图，然后停用任务", settings: visionSettings })
    const proposalId = doneOf(first.events)!.pendingProposalId!
    expect(proposalId).toBeTruthy()
    await decide(lin, { proposalId, accept: true })
    const rows = await ctx.db.select().from(t.assistantMessages).where(eq(t.assistantMessages.chatId, chatIdOf(first.events))).orderBy(t.assistantMessages.seq)
    expect(rows.map((row) => row.role)).toEqual(["user", "assistant", "tool", "image", "assistant"])
    expect(JSON.stringify(rows[2]!.message)).toContain(`已停用任务 ${id}`)
    // 应用后再调模型：工具结果齐了，图在后面
    const prompt = script.prompts[1]!.prompt
    const toolIndex = prompt.findLastIndex((message) => message.role === "tool")
    expect((prompt[toolIndex]!.content as unknown[]).length).toBe(2)
    expect(filePartsOf(1)).toHaveLength(1)
  })

  it("attach_files_to_task：出卡不改库；应用后图成了任务附件、审计带 via；别处的文件不进卡；engine.attachToTask 同一套规矩", async () => {
    const id = await makeTask({ title: "要附件的任务" })
    const a = await uploadImage(lin, "样图.png")
    const b = await uploadImage(lin, "样图2.png")
    const runId = `R-${id.slice(2)}-1`
    await ctx.db.insert(t.sessions).values({ id: runId, taskId: id, status: "done", modelId: MODEL, startedAt: new Date() })
    const shot = await saveFile(ctx.db, { data: await pngOf("#0f0"), name: "screenshot.png", kind: "screenshot", sessionId: runId })
    useScript([
      { parts: [use("attach_files_to_task", { taskId: id, fileIds: [shot.id] }), use("attach_files_to_task", { taskId: id, fileIds: [a.id, b.id] })] },
      { parts: [say("挂好了")] },
    ])
    const first = await send(lin, { message: "把这两张放进任务附件", images: [a.id, b.id], settings: visionSettings })
    const card = of(first.events, "entry").find((event) => event.entry.kind === "proposal")!.entry as Extract<AssistantEntry, { kind: "proposal" }>
    expect(card.proposal.changes).toHaveLength(1)
    expect(card.proposal.changes[0]).toMatchObject({ tool: "attach_files_to_task", destructive: false, title: `给任务 ${id}「要附件的任务」 加 2 个附件` })
    expect(card.proposal.changes[0]!.fields).toEqual([
      { label: "附件 1", after: `样图.png（${a.id}）` },
      { label: "附件 2", after: `样图2.png（${b.id}）` },
    ])
    const error = replay(first.events).find((entry) => entry.kind === "tool" && entry.status === "error")
    expect(error?.kind === "tool" && error.detail).toContain("已经用在别处")
    expect((await ctx.db.select().from(t.files).where(eq(t.files.id, a.id)))[0]).toMatchObject({ kind: "upload", taskId: null })

    const applied = await decide(lin, { proposalId: card.id, accept: true })
    expect(of(applied.events, "update")[0]).toMatchObject({ entry: { proposal: { changes: [{ result: { ok: true, message: `已把 2 个文件加到任务 ${id} 的附件`, link: { page: "tasks", params: { id } } } }] } } })
    const files = await ctx.db.select().from(t.files).where(inArray(t.files.id, [a.id, b.id]))
    expect(files.every((file) => file.taskId === id && file.kind === "attachment" && file.sessionId === null)).toBe(true)
    const audits = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.action, "task.attach"), eq(t.auditEvents.targetId, id)))
    expect(audits).toHaveLength(2)
    expect(audits.every((audit) => (audit.detail as { via?: string }).via === "assistant")).toBe(true)
    // 挂成附件以后，对话里的图照样能看
    const got = await query(ctx.app, "assistant.get", lin, { id: chatIdOf(first.events) })
    expect(got.data.entries.find((entry: AssistantEntry) => entry.kind === "user").images).toHaveLength(2)

    // 员工不能给别人的任务挂附件：不进卡
    const c = await uploadImage(wang, "c.png")
    useScript([{ parts: [use("attach_files_to_task", { taskId: id, fileIds: [c.id] })] }, { parts: [say("没权限")] }])
    await send(wang, { message: "挂上", images: [c.id], settings: visionSettings })
    expect(script.promptText(1)).toContain("只有任务负责人和主管能改任务附件")

    // tRPC 的 attachToTask 走同一个函数：已经是附件的照样返回；别人的任务 FORBIDDEN；用在别处的 BAD_REQUEST
    expect((await mutate(ctx.app, "engine.attachToTask", lin, { taskId: id, fileId: a.id })).data).toMatchObject({ id: a.id, scope: "task", kind: "attachment" })
    expect((await mutate(ctx.app, "engine.attachToTask", wang, { taskId: id, fileId: c.id })).error?.data?.code).toBe("FORBIDDEN")
    const badRequest = await mutate(ctx.app, "engine.attachToTask", lin, { taskId: id, fileId: shot.id })
    expect(badRequest.error?.data?.code).toBe("BAD_REQUEST")
    expect(badRequest.error?.message).toBe("这个文件已经用在别处，请重新上传")
  })
})
