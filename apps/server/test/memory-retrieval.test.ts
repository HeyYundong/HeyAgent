// 记忆按内容自动挑选（docs/dev/memory-retrieval.md 第 9.1、9.2 节）：记忆的向量（后台算、改了重算、失败隔 10 分钟、换模型）、
// 运行开始时挑（手选的一定在、来自网页 / 归档 / 待审核的不挑、门槛、条数、顺手补算、没模型、出错、超时、不挑两次）、任务设置、运行详情。
// 真实的测试库 + 进程内 worker + 假模型，不花钱、不连外网。
// 假 embedding：把文字按字切开（去掉空白和标点），每个字 hash 到 1024 维里的一格再归一化，字重合多的相似度高，结果可预期。
import { createHash } from "node:crypto"

import { autoMemoryMinScore, type SessionSnapshot } from "@heyagent/shared"
import { and, eq, inArray, like, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { parseToolInput, TOOLS, type ToolCtx } from "../src/assistant/tools.js"
import * as t from "../src/db/schema.js"
import { buildSystemPrompt } from "../src/engine/prompt.js"
import { configureEngine, runtime } from "../src/engine/runtime.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import type { EmbedInput } from "../src/gallery/embed.js"
import { cosine } from "../src/gallery/embed.js"
import { embedPendingMemoriesOnce, memoryContentHash, retryMemoryEmbeddingsNow } from "../src/memory/embed.js"
import { autoMemoryQueryText, resolveAutoMemory, runMemoryUseOf } from "../src/memory/retrieval.js"
import { login, query } from "./helpers.js"
import {
  createTask,
  eventsOf,
  finishWith,
  mutate,
  Script,
  sessionRow,
  setupEngine,
  step,
  useScript,
  waitFor,
  waitStatus,
  type EngineTestContext,
} from "./engine-helpers.js"
import { createRoutine, routineCode } from "./routine-helpers.js"

// ---------- 9.1 单元 ----------

const baseSnapshot = (patch: Partial<SessionSnapshot> = {}): SessionSnapshot => ({
  v: 1,
  task: { id: "T-1", title: "标题一", goal: "目标一", ownerId: "u-wang", steps: [] },
  modelId: "test/x",
  memories: [],
  skills: [],
  tools: [],
  rules: [],
  checkpoints: [],
  attachments: [],
  source: "manual",
  ...patch,
})

describe("单元：查询文字、系统提示、门槛、运行详情", () => {
  it("查询文字：标题、目标、步骤、说明、派活的标题 / 说明 / 参数，一项一行；空的跳过；截到 2000 字", () => {
    const snapshot = baseSnapshot({
      task: {
        id: "T-1",
        title: "  整理文档 ",
        goal: "文档归档",
        ownerId: "u-wang",
        steps: [
          { id: "s1", text: "打开目录", wait: false, checkpoint: "目录打开了" },
          { id: "s2", text: "  ", wait: false },
          { id: "s3", text: "逐个归档", wait: true },
        ],
      },
      note: "这次只要上个月的",
      dispatch: { itemId: "w-1", key: "k", title: "单子一", note: "加急", params: { 编号: "A-1", 空的: " ", 类别: "甲" }, depth: 1 },
      // 任务记忆、技能、附件不进查询
      taskMemory: ["不该出现的任务记忆"],
      attachments: [{ id: "f-1", name: "不该出现.txt", mime: "text/plain", size: 1 }],
    })
    expect(autoMemoryQueryText(snapshot)).toBe(["整理文档", "文档归档", "打开目录", "逐个归档", "这次只要上个月的", "单子一", "加急", "编号：A-1", "类别：甲"].join("\n"))
    expect(autoMemoryQueryText(baseSnapshot())).toBe("标题一\n目标一")
    const long = autoMemoryQueryText(baseSnapshot({ task: { id: "T-1", title: "标题", goal: "长".repeat(3000), ownerId: "u", steps: [] } }))
    expect(long).toHaveLength(2000)
    expect(long.startsWith("标题\n长")).toBe(true)
  })

  it("系统提示：手选的在「记忆（必须遵守）」，自动挑的另起「可能相关的记忆」、按相似度排、不带分数；没有就不写那段", () => {
    const manual = { id: "m-1", appliesTo: "甲", content: "手选的一条" }
    const autoLow = { id: "m-2", appliesTo: "乙", content: "自动挑的低分", auto: { score: 0.61 } }
    const autoHigh = { id: "m-3", appliesTo: "丙", content: "自动挑的高分", auto: { score: 0.8123 } }
    const both = buildSystemPrompt(baseSnapshot({ memories: [manual, autoLow, autoHigh] }), new Map())
    expect(both).toContain("## 记忆（人审核过的，必须遵守）\n- [甲] 手选的一条\n\n")
    expect(both).toContain("## 可能相关的记忆（系统按这次要办的事从记忆库里自动挑的，人审核过；和这次的事有关就照做，无关的忽略）\n- [丙] 自动挑的高分\n- [乙] 自动挑的低分")
    expect(both).not.toContain("0.81")
    expect(both).not.toContain("0.61")

    const onlyManual = buildSystemPrompt(baseSnapshot({ memories: [manual] }), new Map())
    expect(onlyManual).toContain("## 记忆（人审核过的，必须遵守）")
    expect(onlyManual).not.toContain("## 可能相关的记忆")
    const onlyAuto = buildSystemPrompt(baseSnapshot({ memories: [autoHigh] }), new Map())
    expect(onlyAuto).not.toContain("## 记忆（人审核过的")
    expect(onlyAuto).toContain("## 可能相关的记忆")
    const none = buildSystemPrompt(baseSnapshot(), new Map())
    expect(none).not.toContain("## 记忆（")
    expect(none).not.toContain("## 可能相关的记忆")
  })

  it("门槛：带服务前缀的模型 id 也认得出；没标定的用默认值", () => {
    expect(autoMemoryMinScore("openrouter/google/gemini-embedding-2")).toBe(autoMemoryMinScore("google/gemini-embedding-2"))
    expect(autoMemoryMinScore("my-proxy/google/gemini-embedding-2")).toBe(autoMemoryMinScore("google/gemini-embedding-2"))
    expect(autoMemoryMinScore("openrouter/acme/unknown")).toBe(0.6)
  })

  it("运行详情：手选的在前，自动挑的在后按分数排；旧快照（没有 auto、没有 autoMemory）也能读", () => {
    const use = runMemoryUseOf(
      baseSnapshot({
        memories: [
          { id: "m-2", appliesTo: "乙", content: "低", auto: { score: 0.6 } },
          { id: "m-1", appliesTo: "甲", content: "手选" },
          { id: "m-3", appliesTo: "丙", content: "高", auto: { score: 0.9 } },
        ],
        autoMemory: { status: "done", limit: 5, candidates: 3 },
        taskMemory: ["a", "b"],
      })
    )
    expect(use.items.map((item) => item.id)).toEqual(["m-1", "m-3", "m-2"])
    expect(use.items[0]).toEqual({ id: "m-1", appliesTo: "甲", content: "手选" })
    expect(use.items[1]!.auto).toEqual({ score: 0.9 })
    expect(use.auto).toMatchObject({ status: "done", candidates: 3 })
    expect(use.taskMemoryCount).toBe(2)

    const old = runMemoryUseOf(baseSnapshot({ memories: [{ id: "m-1", appliesTo: "甲", content: "手选" }] }))
    expect(old).toEqual({ items: [{ id: "m-1", appliesTo: "甲", content: "手选" }], taskMemoryCount: 0 })
  })
})

// ---------- 9.2 集成 ----------

let ctx: EngineTestContext
let lin: string // 主管
let wang: string // 员工，测试任务的负责人
const savedFactory = runtime.embedFactory

const EXEC = "test/qwen-mr-exec"
const EMBED = "openrouter/acme/embed-mem"
const EMBED_2 = "openrouter/acme/embed-mem-2"

function charVector(text: string) {
  const vector = new Array<number>(1024).fill(0)
  for (const ch of text) {
    if (/[\s\p{P}\p{S}]/u.test(ch)) continue
    vector[createHash("md5").update(ch).digest().readUInt16BE(0) % 1024]! += 1
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1
  return vector.map((x) => x / norm)
}

let embedCalls = 0
let embedBroken = false
let embedDelayMs = 0
const embedInputs: string[][] = []
async function fakeEmbed({ inputs }: { modelId: string; inputs: EmbedInput[] }) {
  embedCalls += 1
  embedInputs.push(inputs.map((input) => ("text" in input ? input.text : "<image>")))
  if (embedDelayMs) await new Promise((resolve) => setTimeout(resolve, embedDelayMs))
  if (embedBroken) throw new Error("模型挂了")
  return inputs.map((input) => charVector("text" in input ? input.text : "图"))
}

const setEmbedModel = (modelId: string | null) =>
  modelId
    ? ctx.db.insert(t.modelDefaults).values({ role: "embed", modelId }).onConflictDoUpdate({ target: t.modelDefaults.role, set: { modelId } })
    : ctx.db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "embed"))

async function newMemory(content: string, appliesTo: string) {
  const res = await mutate(ctx.app, "memories.create", lin, { content, appliesTo })
  if (!res.data) throw new Error(`新建记忆失败：${JSON.stringify(res.error)}`)
  return res.data.id as string
}

const embeddingRows = (ids: string[]) => ctx.db.select().from(t.memoryEmbeddings).where(inArray(t.memoryEmbeddings.memoryId, ids))
const memoryRow = async (id: string) => (await ctx.db.select().from(t.memories).where(eq(t.memories.id, id)))[0]!
const embedOf = async (id: string) => ((await query(ctx.app, "memories.list", lin)).data as { id: string; embed?: unknown }[]).find((memory) => memory.id === id)!.embed

async function drainEmbeddings() {
  for (let i = 0; i < 50; i++) if ((await embedPendingMemoriesOnce(ctx.db)) === 0) return
}

async function autoTask(input: { title: string; goal: string; memoryIds?: string[]; limit?: number }) {
  const taskId = await createTask(ctx.db, { modelId: EXEC, title: input.title, goal: input.goal, memoryIds: input.memoryIds })
  await ctx.db.update(t.tasks).set({ autoMemory: true, autoMemoryLimit: input.limit ?? 5 }).where(eq(t.tasks.id, taskId))
  return taskId
}

async function runToDone(taskId: string) {
  const script = useScript(EXEC, new Script([step(finishWith("做完了"))]))
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(`runNow 失败：${JSON.stringify(res.error)}`)
  const sessionId = res.data.sessionId as string
  await waitStatus(ctx.db, sessionId, "done")
  return { sessionId, script, system: JSON.stringify(script.prompts[0]!.prompt[0]) }
}

const autoEvent = async (sessionId: string) => {
  const events = await eventsOf(ctx.db, sessionId)
  expect(events[0]!.title).toBe("运行开始")
  return events[1]!
}

beforeAll(async () => {
  ctx = await setupEngine()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  configureEngine({ embedFactory: fakeEmbed })
  await ctx.db.insert(t.models).values([
    { id: EXEC, providerId: "openrouter", name: "测试执行模型", contextK: 128 },
    { id: EMBED, providerId: "openrouter", name: "Embed Mem", note: "", contextK: 8, priceIn: 0.2, priceOut: 0, vision: true, kind: "embedding" },
    { id: EMBED_2, providerId: "openrouter", name: "Embed Mem 2", note: "", contextK: 8, priceIn: 0.1, priceOut: 0, vision: true, kind: "embedding" },
  ])
  // 种子里的记忆不参与（归档），测试只看自己建的
  await ctx.db.update(t.memories).set({ status: "archived" })
  await setEmbedModel(EMBED)
}, 120_000)

afterAll(async () => {
  configureEngine({ embedFactory: savedFactory, autoMemoryTimeoutMs: undefined })
  await ctx?.stop()
})

describe("记忆的向量", () => {
  it("JS 算的 content_hash 和 SQL 的 md5(applies_to || E'\\n' || content) 一样（中文、emoji、换行）", async () => {
    const id = await newMemory("第一行 😀 表情\n第二行：全角标点。", "分类 · 对象🙂")
    const [row] = (await ctx.db.execute<{ h: string; applies_to: string; content: string }>(sql`select md5(applies_to || E'\\n' || content) as h, applies_to, content from memories where id = ${id}`)).rows
    expect(row!.h).toBe(memoryContentHash({ appliesTo: row!.applies_to, content: row!.content }))
    await mutate(ctx.app, "memories.archive", lin, { id })
  })

  it("后台：新建的算好、hash 对；改了内容变成要算、重算；归档、待审核的不算；memories.list 的 embed 跟着变；没设模型时没有 embed", async () => {
    const a = await newMemory("向量测试一号", "向量")
    const b = await newMemory("向量测试二号", "向量")
    await ctx.db.insert(t.memories).values({ id: "m-7001", content: "待审核的", appliesTo: "向量", status: "pending", sourceKind: "human", sourceById: "u-lin" })
    expect(await embedOf(a)).toEqual({ state: "pending" })
    const updatedBefore = (await memoryRow(b)).updatedAt

    await drainEmbeddings()
    // 算向量不动 updated_at（那是人改记忆的时间）
    expect((await memoryRow(b)).updatedAt).toEqual(updatedBefore)
    expect((await memoryRow(b)).embedTriedAt).toBeTruthy()
    const rows = await embeddingRows([a, b, "m-7001"])
    expect(rows.map((row) => row.memoryId).sort()).toEqual([a, b].sort())
    expect(rows.every((row) => row.modelId === EMBED)).toBe(true)
    expect(rows.find((row) => row.memoryId === a)!.contentHash).toBe(memoryContentHash({ appliesTo: "向量", content: "向量测试一号" }))
    expect(await embedOf(a)).toEqual({ state: "ready" })
    expect(await embedOf("m-7001")).toBeUndefined()

    await mutate(ctx.app, "memories.update", lin, { id: a, content: "向量测试一号改过", appliesTo: "向量" })
    expect(await embedOf(a)).toEqual({ state: "pending" })
    const before = embedCalls
    expect(await embedPendingMemoriesOnce(ctx.db)).toBe(1)
    expect(embedCalls).toBe(before + 1)
    expect(embedInputs.at(-1)).toEqual(["向量\n向量测试一号改过"])
    expect((await embeddingRows([a]))[0]!.contentHash).toBe(memoryContentHash({ appliesTo: "向量", content: "向量测试一号改过" }))
    expect(await embedOf(a)).toEqual({ state: "ready" })

    // 归档的不算（已有的向量留着）
    await mutate(ctx.app, "memories.archive", lin, { id: b })
    await mutate(ctx.app, "memories.archive", lin, { id: a })
    expect(await embedPendingMemoriesOnce(ctx.db)).toBe(0)
    expect(await embeddingRows([a, b])).toHaveLength(2)
    expect(await embedOf(b)).toBeUndefined()

    // 没设 embedding 模型：后台什么也不算，列表里没有 embed
    const c = await newMemory("向量测试三号", "向量")
    await setEmbedModel(null)
    expect(await embedPendingMemoriesOnce(ctx.db)).toBe(0)
    expect(await embedOf(c)).toBeUndefined()
    await setEmbedModel(EMBED)
    expect(await embedOf(c)).toEqual({ state: "pending" })
    await drainEmbeddings()
    await mutate(ctx.app, "memories.archive", lin, { id: c })
    await ctx.db.delete(t.memories).where(eq(t.memories.id, "m-7001"))
  })

  it("算失败：记下原因，10 分钟内不再试，过了再试；算成了清掉", async () => {
    const id = await newMemory("失败测试", "向量")
    embedBroken = true
    await expect(embedPendingMemoriesOnce(ctx.db)).rejects.toThrow("模型挂了")
    embedBroken = false
    const failed = await memoryRow(id)
    expect(failed.embedError).toContain("模型挂了")
    expect(failed.embedTriedAt).toBeTruthy()
    expect(await embedOf(id)).toEqual({ state: "failed", error: failed.embedError })

    const calls = embedCalls
    expect(await embedPendingMemoriesOnce(ctx.db)).toBe(0)
    expect(embedCalls).toBe(calls)

    await ctx.db.update(t.memories).set({ embedTriedAt: sql`now() - interval '11 minutes'` }).where(eq(t.memories.id, id))
    expect(await embedPendingMemoriesOnce(ctx.db)).toBe(1)
    const fixed = await memoryRow(id)
    expect(fixed.embedError).toBeNull()
    expect(await embedOf(id)).toEqual({ state: "ready" })
    await mutate(ctx.app, "memories.archive", lin, { id })
  })

  it("模型服务换了 key、从出错变好（retryMemoryEmbeddingsNow）：之前算失败的不用等 10 分钟；之后再失败的照旧隔 10 分钟", async () => {
    const id = await newMemory("换 key 测试", "向量")
    embedBroken = true
    await expect(embedPendingMemoriesOnce(ctx.db)).rejects.toThrow("模型挂了")
    embedBroken = false
    expect(await embedPendingMemoriesOnce(ctx.db)).toBe(0)

    retryMemoryEmbeddingsNow()
    expect(await embedPendingMemoriesOnce(ctx.db)).toBe(1)
    expect(await embedOf(id)).toEqual({ state: "ready" })

    // 修好以后才失败的：还是隔 10 分钟
    await mutate(ctx.app, "memories.update", lin, { id, content: "换 key 测试改过", appliesTo: "向量" })
    embedBroken = true
    await expect(embedPendingMemoriesOnce(ctx.db)).rejects.toThrow("模型挂了")
    embedBroken = false
    expect(await embedPendingMemoriesOnce(ctx.db)).toBe(0)
    await ctx.db.update(t.memories).set({ embedTriedAt: sql`now() - interval '11 minutes'` }).where(eq(t.memories.id, id))
    expect(await embedPendingMemoriesOnce(ctx.db)).toBe(1)
    await mutate(ctx.app, "memories.archive", lin, { id })
  })

  it("换模型：新旧并存，新模型把所有生效的都算完才删旧的", async () => {
    const ids = [await newMemory("换模型一", "向量"), await newMemory("换模型二", "向量")]
    await drainEmbeddings()
    await setEmbedModel(EMBED_2)
    expect(await embedOf(ids[0]!)).toEqual({ state: "pending" })
    expect(await embedPendingMemoriesOnce(ctx.db, 1)).toBe(1)
    const mid = await embeddingRows(ids)
    expect(mid.filter((row) => row.modelId === EMBED)).toHaveLength(2)
    expect(mid.filter((row) => row.modelId === EMBED_2)).toHaveLength(1)
    await drainEmbeddings()
    const after = await ctx.db.select().from(t.memoryEmbeddings)
    expect(after.length).toBeGreaterThan(0)
    expect(after.every((row) => row.modelId === EMBED_2)).toBe(true)
    await setEmbedModel(EMBED)
    for (const id of ids) await mutate(ctx.app, "memories.archive", lin, { id })
  })
})

describe("运行开始时挑记忆", () => {
  // 查询（任务标题 + 目标）：「整理月度报表」「导出月度报表并存档」
  const TITLE = "整理月度报表"
  const GOAL = "导出月度报表并存档"
  const QUERY = `${TITLE}\n${GOAL}`
  let high: string // 最像
  let mid: string // 也够像
  let low: string // 不够像
  let far: string // 完全不像
  let web: string // 来自网页没核实：不挑
  let archived: string // 归档：不挑
  let manual: string // 手选的：在「必须遵守」那段，不重复
  const pending = "m-7101" // 待审核：不挑

  beforeAll(async () => {
    high = await newMemory("月度报表存档要按月份", "报表")
    mid = await newMemory("月度报表导出前先刷新", "报表")
    low = await newMemory("报表导出后核对合计", "报表")
    far = await newMemory("下雨记得带伞", "天气")
    web = await newMemory("月度报表存档要按月份整理", "报表")
    await ctx.db.update(t.memories).set({ webUnverified: true }).where(eq(t.memories.id, web))
    archived = await newMemory("月度报表导出", "报表")
    await mutate(ctx.app, "memories.archive", lin, { id: archived })
    manual = await newMemory("月度报表导出要用新模板", "报表")
    await ctx.db.insert(t.memories).values({ id: pending, content: "月度报表导出", appliesTo: "报表", status: "pending", sourceKind: "human", sourceById: "u-lin" })
    // 前提：假向量下的相似度（不依赖门槛的具体值，只要求它在 low 和 mid 之间）
    const score = (memoryText: string) => cosine(charVector(QUERY), charVector(memoryText))
    const minScore = autoMemoryMinScore(EMBED)
    expect(score("报表\n月度报表存档要按月份")).toBeGreaterThan(score("报表\n月度报表导出前先刷新"))
    expect(score("报表\n月度报表导出前先刷新")).toBeGreaterThanOrEqual(minScore)
    expect(score("报表\n报表导出后核对合计")).toBeLessThan(minScore)
  })

  it("挑中够像的：手选的一定在、不重复；来自网页、归档、待审核的不挑；顺手补算没算好的；过程、快照、lastUsedAt、sessions.get 都对", async () => {
    const taskId = await autoTask({ title: TITLE, goal: GOAL, memoryIds: [manual] })
    const { sessionId, system } = await runToDone(taskId)
    const snapshot = (await sessionRow(ctx.db, sessionId))!.snapshot!
    expect(snapshot.memories.map((memory) => memory.id)).toEqual([manual, high, mid])
    expect(snapshot.memories[0]!.auto).toBeUndefined()
    expect(snapshot.memories[1]!.auto!.score).toBeGreaterThan(snapshot.memories[2]!.auto!.score)
    expect(snapshot.autoMemory).toMatchObject({ status: "done", limit: 5, modelId: EMBED, minScore: autoMemoryMinScore(EMBED), notReady: 0, query: QUERY })
    // 能挑的：high mid low far（web、archived、pending、manual 不算）
    expect(snapshot.autoMemory!.candidates).toBe(4)
    expect(snapshot.autoMemory!.reason).toBeUndefined()

    expect(system).toContain(`## 记忆（人审核过的，必须遵守）\\n- [报表] 月度报表导出要用新模板`)
    expect(system).toContain("## 可能相关的记忆（系统按这次要办的事从记忆库里自动挑的，人审核过；和这次的事有关就照做，无关的忽略）\\n- [报表] 月度报表存档要按月份\\n- [报表] 月度报表导出前先刷新")
    expect(system).not.toContain("月度报表存档要按月份整理")
    expect(system).not.toContain("核对合计")
    expect(system.match(/月度报表导出要用新模板/g)).toHaveLength(1)

    // 顺手补算：挑之前没跑过后台，能挑的都在这次算好了
    expect((await embeddingRows([high, mid, low, far])).filter((row) => row.modelId === EMBED)).toHaveLength(4)

    const event = await autoEvent(sessionId)
    expect(event.kind).toBe("plan")
    expect(event.title).toBe("自动挑了 2 条记忆")
    const highScore = snapshot.memories[1]!.auto!.score.toFixed(2)
    expect(event.detail).toContain(`${high} [报表] 月度报表存档要按月份 · 相似度 ${highScore}`)
    expect(event.detail).toContain(`参与挑选 4 条，门槛 ${autoMemoryMinScore(EMBED).toFixed(2)}`)

    expect((await memoryRow(high)).lastUsedSessionId).toBe(sessionId)
    expect((await memoryRow(manual)).lastUsedSessionId).toBe(sessionId)
    expect((await memoryRow(low)).lastUsedSessionId).toBeNull()

    const got = await query(ctx.app, "sessions.get", wang, { id: sessionId })
    expect(got.data.memoryUse.items.map((item: { id: string }) => item.id)).toEqual([manual, high, mid])
    expect(got.data.memoryUse.items[0].auto).toBeUndefined()
    expect(got.data.memoryUse.auto).toMatchObject({ status: "done", candidates: 4 })
    expect(got.data.memoryUse.taskMemoryCount).toBe(0)
  })

  it("条数：最多几条只管自动挑的", async () => {
    const taskId = await autoTask({ title: TITLE, goal: GOAL, memoryIds: [manual], limit: 1 })
    const { sessionId } = await runToDone(taskId)
    const snapshot = (await sessionRow(ctx.db, sessionId))!.snapshot!
    expect(snapshot.memories.map((memory) => memory.id)).toEqual([manual, high])
    expect((await autoEvent(sessionId)).title).toBe("自动挑了 1 条记忆")
  })

  it("一条都不够像：挑到 0 条，过程写门槛和最像的一条", async () => {
    const taskId = await autoTask({ title: "核对合计", goal: "统计访客" })
    const { sessionId, system } = await runToDone(taskId)
    const snapshot = (await sessionRow(ctx.db, sessionId))!.snapshot!
    expect(snapshot.memories).toEqual([])
    expect(snapshot.autoMemory!.status).toBe("done")
    // 最像的一条写进 reason（运行详情显示在「没有够像的记忆（…）」里）
    expect(snapshot.autoMemory!.reason).toMatch(new RegExp(`^最像的是 ${low}（0\\.\\d\\d），没到门槛 ${autoMemoryMinScore(EMBED).toFixed(2).replace(".", "\\.")}$`))
    expect(system).not.toContain("## 可能相关的记忆")
    const event = await autoEvent(sessionId)
    expect(event.title).toBe("没有够像的记忆")
    expect(event.detail).toContain(`门槛 ${autoMemoryMinScore(EMBED).toFixed(2)}，最像的是 ${low}（`)
  })

  it("没算好的超过 64 条：补算 64 条，多的计入 notReady、这次不参与", async () => {
    await drainEmbeddings()
    const extra = Array.from({ length: 70 }, (_, i) => ({ id: `m-75${String(i).padStart(2, "0")}`, content: `无关内容${i}`, appliesTo: "其他", status: "active" as const, sourceKind: "human" as const, sourceById: "u-lin" }))
    await ctx.db.insert(t.memories).values(extra)
    const taskId = await autoTask({ title: TITLE, goal: GOAL })
    const before = embedInputs.length
    const { sessionId } = await runToDone(taskId)
    const snapshot = (await sessionRow(ctx.db, sessionId))!.snapshot!
    // 挑的那次调用：查询 + 64 条
    expect(embedInputs.slice(before).find((inputs) => inputs[0] === QUERY)).toHaveLength(65)
    expect(snapshot.autoMemory).toMatchObject({ status: "done", notReady: 6, candidates: 4 + 64 + 1 })
    expect((await autoEvent(sessionId)).detail).toContain("还有 6 条没算好，这次没参与")
    await ctx.db.update(t.memories).set({ status: "archived" }).where(like(t.memories.id, "m-75%"))
  })

  it("没设 embedding 模型：跳过，过程写原因，运行照常办完", async () => {
    await setEmbedModel(null)
    try {
      const taskId = await autoTask({ title: TITLE, goal: GOAL, memoryIds: [manual] })
      const calls = embedCalls
      const { sessionId, system } = await runToDone(taskId)
      expect(embedCalls).toBe(calls)
      // 结果由复核写（另一个任务），等它写好
      const row = await waitFor(async () => {
        const each = (await sessionRow(ctx.db, sessionId))!
        return each.outcome ? each : undefined
      })
      expect(row.outcome).toBe("achieved")
      expect(row.snapshot!.autoMemory).toMatchObject({ status: "skipped", reason: "还没设 embedding 模型（模型页 → 默认设置）" })
      expect(row.snapshot!.memories.map((memory) => memory.id)).toEqual([manual])
      expect(system).toContain("## 记忆（人审核过的，必须遵守）")
      const event = await autoEvent(sessionId)
      expect(event).toMatchObject({ kind: "plan", title: "没自动挑记忆", detail: "还没设 embedding 模型（模型页 → 默认设置）" })
    } finally {
      await setEmbedModel(EMBED)
    }
  })

  it("embedding 出错、超时：failed，过程写原因，只用手选的，运行照常；不出 error 类过程", async () => {
    embedBroken = true
    try {
      const taskId = await autoTask({ title: TITLE, goal: GOAL, memoryIds: [manual] })
      const { sessionId, system } = await runToDone(taskId)
      // 结果由复核写（另一个任务），等它写好
      const row = await waitFor(async () => {
        const each = (await sessionRow(ctx.db, sessionId))!
        return each.outcome ? each : undefined
      })
      expect(row.outcome).toBe("achieved")
      expect(row.snapshot!.autoMemory).toMatchObject({ status: "failed", reason: "模型挂了" })
      expect(row.snapshot!.memories.map((memory) => memory.id)).toEqual([manual])
      expect(system).not.toContain("## 可能相关的记忆")
      expect(await autoEvent(sessionId)).toMatchObject({ kind: "plan", title: "自动挑记忆没做成", detail: "模型挂了；这次只用手选的记忆" })
      expect((await eventsOf(ctx.db, sessionId)).some((event) => event.kind === "error")).toBe(false)
    } finally {
      embedBroken = false
    }

    configureEngine({ autoMemoryTimeoutMs: 200 })
    embedDelayMs = 2000
    try {
      const taskId = await autoTask({ title: TITLE, goal: GOAL })
      const { sessionId } = await runToDone(taskId)
      const row = (await sessionRow(ctx.db, sessionId))!
      expect(row.snapshot!.autoMemory!.status).toBe("failed")
      expect(row.snapshot!.autoMemory!.reason).toContain("秒还没挑完")
      expect((await autoEvent(sessionId)).title).toBe("自动挑记忆没做成")
    } finally {
      embedDelayMs = 0
      configureEngine({ autoMemoryTimeoutMs: undefined })
    }
  })

  it("只挑一次：挑过的快照再进来不调模型；两处同时拿着 pending 的快照，只有一处写进去", async () => {
    const taskId = await autoTask({ title: TITLE, goal: GOAL })
    const { sessionId } = await runToDone(taskId)
    const done = (await sessionRow(ctx.db, sessionId))!.snapshot!
    const calls = embedCalls
    expect(await resolveAutoMemory(ctx.db, sessionId, done)).toBe(done)
    expect(embedCalls).toBe(calls)

    // 一个不归 worker 管的运行（状态已经是 done），快照还是 pending
    const pendingSnapshot = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })
    expect(pendingSnapshot.autoMemory).toEqual({ status: "pending", limit: 5 })
    const id = `${taskId}-twice`
    await ctx.db.insert(t.sessions).values({ id, taskId, status: "done", modelId: EXEC, startedAt: new Date(), snapshot: pendingSnapshot })
    const first = await resolveAutoMemory(ctx.db, id, pendingSnapshot)
    expect(first.autoMemory!.status).toBe("done")
    const second = await resolveAutoMemory(ctx.db, id, pendingSnapshot)
    expect(second).toEqual(first)
    expect((await eventsOf(ctx.db, id)).filter((event) => event.kind === "plan")).toHaveLength(1)
  })

  it("快照：任务关着不写 autoMemory；固化试跑不挑；派活参数进了查询", async () => {
    const off = await createTask(ctx.db, { modelId: EXEC, title: TITLE, goal: GOAL })
    expect((await buildSnapshot(ctx.db, off, { source: "manual", runAttachments: [] })).autoMemory).toBeUndefined()

    const taskId = await autoTask({ title: TITLE, goal: GOAL, limit: 3 })
    const { versionId } = await createRoutine(ctx.db, taskId, { code: routineCode("return {}"), versionStatus: "testing" })
    const test = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [], routineTest: { versionId, attachments: [] } })
    expect(test.autoMemory).toBeUndefined()

    const dispatched = await buildSnapshot(ctx.db, taskId, {
      source: "dispatch",
      runAttachments: [],
      dispatch: { itemId: "w-x", key: "k", title: "单子", params: { 编号: "Z-9" }, depth: 1 },
    })
    expect(dispatched.autoMemory).toEqual({ status: "pending", limit: 3 })
    expect(autoMemoryQueryText(dispatched)).toBe(`${QUERY}\n单子\n编号：Z-9`)
  })

  it("开着自动挑选但一条能挑的都没有：跳过", async () => {
    await ctx.db.update(t.memories).set({ status: "archived" }).where(and(eq(t.memories.status, "active")))
    const taskId = await autoTask({ title: TITLE, goal: GOAL })
    const { sessionId } = await runToDone(taskId)
    expect((await sessionRow(ctx.db, sessionId))!.snapshot!.autoMemory).toMatchObject({ status: "skipped", reason: "记忆库里没有能挑的记忆" })
    expect(await autoEvent(sessionId)).toMatchObject({ title: "没自动挑记忆", detail: "记忆库里没有能挑的记忆" })
  })
})

describe("任务设置", () => {
  const NEW_TASK = { title: "设置测试", goal: "做完", steps: [], schedule: null }

  it("新建不传 = 开、5；改任务是整份替换，不传变回默认；助手只改标题时保留原值", async () => {
    const reviewModelId = (await ctx.db.select().from(t.modelDefaults).where(eq(t.modelDefaults.role, "review")))[0]!.modelId
    const created = await mutate(ctx.app, "tasks.create", lin, { ...NEW_TASK, reviewModelId })
    expect(created.error).toBeUndefined()
    const id = created.data.id as string
    const listed = async () => ((await query(ctx.app, "tasks.list", lin)).data as { id: string; autoMemory: boolean; autoMemoryLimit: number }[]).find((task) => task.id === id)!
    expect(await listed()).toMatchObject({ autoMemory: true, autoMemoryLimit: 5 })

    expect((await mutate(ctx.app, "tasks.update", lin, { ...NEW_TASK, reviewModelId, id, autoMemory: false, autoMemoryLimit: 10 })).error).toBeUndefined()
    expect(await listed()).toMatchObject({ autoMemory: false, autoMemoryLimit: 10 })
    expect((await mutate(ctx.app, "tasks.update", lin, { ...NEW_TASK, reviewModelId, id, autoMemoryLimit: 21 })).error?.data?.code).toBe("BAD_REQUEST")

    // 助手 update_task 只给标题：其余照原样
    await mutate(ctx.app, "tasks.update", lin, { ...NEW_TASK, reviewModelId, id, autoMemory: false, autoMemoryLimit: 10 })
    const toolCtx: ToolCtx = { db: ctx.db, actor: { id: "u-lin", isAdmin: true }, keyring: () => ctx.keyring }
    const parsed = parseToolInput(TOOLS.update_task!, { id, title: "设置测试改名" })
    if (!parsed.ok) throw new Error(parsed.error)
    const def = TOOLS.update_task!
    if (def.kind !== "write") throw new Error("update_task 应该是写工具")
    await def.apply(toolCtx, parsed.input as never, parsed.given, undefined)
    expect(await listed()).toMatchObject({ autoMemory: false, autoMemoryLimit: 10 })

    // 网页改任务不带这两项：变回默认（整份替换，网页弹窗会把原值带上）
    expect((await mutate(ctx.app, "tasks.update", lin, { ...NEW_TASK, reviewModelId, id })).error).toBeUndefined()
    expect(await listed()).toMatchObject({ autoMemory: true, autoMemoryLimit: 5 })
  })
})
