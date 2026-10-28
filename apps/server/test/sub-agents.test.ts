// 子 agent（docs/dev/sub-agents.md 第 13 节）：真实的测试库 + 进程内 worker + 假模型。
// 覆盖：拆（编号、子快照、附件只读、第一条消息、整次拒绝）；名额（每次运行、全系统、等浏览器占 / 等人处理不占、父结束后排队的取消）；
// 等（all 叫醒一次、any 只给新的、已经满足的直接返回、none、挂起窗口补发、外部事件挡掉）；结果（不复核、只回文字、work.report、缺字段、
// subs/<n>/ 只读）；失败（出错、上限、subagent.cancel、人取消、父结束跟着停、run.finish 被拒、只回文字提醒后停掉）；
// 花费（合计、同意继续按合计、今天的花费、派活每天花费）；别处（列表、统计、手动编号、派活名额、复核一节、不能固化）；清扫。
import { SETTING_KEYS, subagentQueueEvent, subagentWaitEvent, type SessionSnapshot } from "@heyagent/shared"
import { and, eq, inArray, notInArray, sql } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"

import { listSessions, loadSession } from "../src/data/loaders.js"
import { pageSessions } from "../src/data/session-page.js"
import * as t from "../src/db/schema.js"
import { cancelSessionImpl, fireEventImpl, resumeNowImpl } from "../src/engine/control.js"
import { createHumanItem, resolveHumanItemImpl } from "../src/engine/humans.js"
import { buildSystemPrompt } from "../src/engine/prompt.js"
import { buildReviewPrompt } from "../src/engine/review.js"
import { buildSnapshot, startSessionImpl } from "../src/engine/sessions.js"
import { cancelFromAgent, startFromAgent, waitFromAgent } from "../src/engine/subagents/agent-tools.js"
import { recheckSubagentWaitAfterSuspend } from "../src/engine/subagents/notify.js"
import { pumpSubagents } from "../src/engine/subagents/pump.js"
import { SUBAGENT_RESULTS_TAIL, subagentResultsText, type SubRunFacts } from "../src/engine/subagents/results.js"
import { bossFor, QUEUES, SCHEDULE_TZ } from "../src/engine/queue.js"
import { familyCost } from "../src/engine/subagents/settle.js"
import { sweepSubagents } from "../src/engine/subagents/sweep.js"
import { listSubagents } from "../src/engine/subagents/view.js"
import { executeBuiltin, type SessionRow } from "../src/engine/tools/builtin.js"
import { writeSpaceFile } from "../src/files/service.js"
import { insertSubagentFixtures } from "../src/seed/subagent-fixture.js"
import { compileFromSession } from "../src/routine/compile.js"
import { dispatchSpentToday, occupiedSlots } from "../src/work/service.js"
import {
  call,
  createTask,
  eventsOf,
  finishWith,
  messagesOf,
  Script,
  sessionRow,
  setSetting,
  setupEngine,
  step,
  text,
  useScript,
  waitFor,
  waitStatus,
  type CallOptions,
  type EngineTestContext,
} from "./engine-helpers.js"

let ctx: EngineTestContext

beforeAll(async () => {
  ctx = await setupEngine()
}, 120_000)

afterAll(async () => {
  for (const g of gates.values()) g.open()
  await ctx?.stop()
})

/** 每个测试结束：放开卡住的子 agent、把还没结束的子运行（包括假的）都停掉、设置改回默认，不影响下一个测试的名额 */
afterEach(async () => {
  for (const g of gates.values()) g.open()
  await ctx.db
    .update(t.sessions)
    .set({ status: "failed", endedAt: new Date() })
    .where(and(eq(t.sessions.kind, "sub"), notInArray(t.sessions.status, ["done", "failed", "incomplete"])))
  await ctx.db.update(t.sessionWaits).set({ status: "cancelled" }).where(and(eq(t.sessionWaits.status, "waiting"), sql`${t.sessionWaits.event} like 'subagent.%'`))
  await ctx.db.delete(t.settings).where(inArray(t.settings.key, [SETTING_KEYS.subagentMaxParallel, SETTING_KEYS.subagentMaxPerRun, SETTING_KEYS.subagentMaxRunningGlobal, SETTING_KEYS.subagentMaxCostUsd, SETTING_KEYS.subagentMaxSteps]))
})

// ---------- 假模型 ----------

const promptOf = (options: CallOptions) => JSON.stringify(options.prompt)
const toolResults = (options: CallOptions) => options.prompt.filter((message) => message.role === "tool").length
/** 子 agent 的子目标标题（第一条消息「子目标「…」：」） */
const titleOf = (options: CallOptions) => /子目标「([^」]+)」/.exec(promptOf(options))?.[1] ?? ""

/** 子 agent 卡住，直到 open()（按标题） */
const gates = new Map<string, { promise: Promise<void>; open: () => void }>()
function gate(title: string) {
  let entry = gates.get(title)
  if (!entry) {
    let open!: () => void
    const promise = new Promise<void>((resolve) => (open = resolve))
    entry = { promise, open }
    gates.set(title, entry)
  }
  return entry
}

/**
 * 子 agent 的假模型：按标题开头决定怎么做。
 * 等…：卡到 gate 开；报字段…：先 work_report 再报办成；只回文字…：一直只回文字；出错…：模型出错；走步…：一直 plan_set；
 * 没交…：直接报办成（缺 results 要的字段）；其余：直接报办成
 */
async function childReply(options: CallOptions) {
  const title = titleOf(options)
  const turn = toolResults(options)
  if (title.startsWith("停")) return stopReply(title, options)
  if (title.startsWith("等")) await gate(title).promise
  if (title.startsWith("出错")) throw new Error("模型那边坏了")
  if (title.startsWith("只回文字")) return step([text(`说一句话：${title}`)])
  if (title.startsWith("走步")) return step([call("plan.set", { steps: ["走一步"] })])
  if (title.includes("写文件") && turn === 0) return step([call("file.save", { path: "out/result.txt", content: `内容 ${title}` })])
  if (title.startsWith("报字段") && turn === 0) return step([call("work.report", { data: { 价格: 12.5, 链接: "https://example.com/x" } })])
  return step(finishWith(`完成：${title}`))
}

/** 停掉以后才回来的那次回复花的钱（照记进运行的花费） */
const LATE_REPLY_COST = 0.0042

/** 停的测试：模型开始调的时间、被中止的时间、不理中止回来的时间（按标题） */
const modelEntered = new Map<string, number>()
const modelAborted = new Map<string, number>()
const modelReturned = new Map<string, number>()

/**
 * 停…的子 agent：停等…：一直等，直到这次调用被中止（AbortSignal）；停慢…：不理中止，1.5 秒后回一个工具调用（模拟停掉时模型已经在回了）
 */
async function stopReply(title: string, options: CallOptions) {
  modelEntered.set(title, Date.now())
  if (title.startsWith("停等"))
    await new Promise<void>((resolve, reject) => {
      const signal = options.abortSignal
      const timer = setTimeout(resolve, 20_000)
      signal?.addEventListener(
        "abort",
        () => {
          clearTimeout(timer)
          modelAborted.set(title, Date.now())
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"))
        },
        { once: true }
      )
    })
  else await new Promise((resolve) => setTimeout(resolve, 1500))
  modelReturned.set(title, Date.now())
  return step([call("plan.set", { steps: ["接着做"] })], LATE_REPLY_COST)
}

let modelNo = 0
/** 子 agent 用的模型（每个测试一个，剧本是 childReply） */
function childModel() {
  const id = `test/sub-child-${++modelNo}`
  useScript(id, new Script(Array.from({ length: 300 }, () => childReply)))
  return id
}

/** 父任务：选了「拆给子 agent」，子 agent 用 childModel */
async function makeParentTask(options: { parentModel?: string; childModelId?: string; toolIds?: string[]; steps?: { id: string; text: string; wait: boolean; checkpoint?: string }[] } = {}) {
  const taskId = await createTask(ctx.db, {
    modelId: options.parentModel ?? "test/none",
    toolIds: options.toolIds ?? ["subagent.start", "file.save"],
    title: "汇总几件事",
    goal: "把几件事的结果汇总成一张表",
    steps: options.steps,
  })
  const child = options.childModelId ?? childModel()
  await ctx.db.update(t.tasks).set({ subagentModelId: child }).where(eq(t.tasks.id, taskId))
  return { taskId, child }
}

let fakeNo = 0
/** 直接插一行父运行（快照照任务算，不经过引擎、不会被执行） */
async function fakeParent(taskId: string, extra: Partial<typeof t.sessions.$inferInsert> = {}) {
  const snapshot = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })
  const id = `R-${taskId.slice(2)}-${900 + ++fakeNo}`
  await ctx.db.insert(t.sessions).values({ id, taskId, status: "running", modelId: snapshot.modelId, triggeredBy: "manual", startedAt: new Date(), snapshot, ...extra })
  return { row: (await sessionRow(ctx.db, id))!, snapshot }
}

/** 直接插一个子运行（没有快照：被放行后引擎不碰它，状态停在执行中） */
async function fakeChild(parentId: string, taskId: string, n: number, state: { status: (typeof t.sessions.$inferInsert)["status"]; event?: string; extra?: Partial<typeof t.sessions.$inferInsert> }) {
  const id = `${parentId}.${n}`
  await ctx.db.insert(t.sessions).values({
    id,
    taskId,
    status: state.status,
    modelId: "test/none",
    triggeredBy: "sub",
    startedAt: new Date(Date.now() + n),
    parentSessionId: parentId,
    kind: "sub",
    ...state.extra,
  })
  if (state.event) await ctx.db.insert(t.sessionWaits).values({ sessionId: id, what: "等", triggerKind: "event", event: state.event })
  return id
}

/** 假子运行的 snapshot.sub（交回、统计要标题和 n） */
const subSnapshot = (parent: SessionSnapshot, parentId: string, n: number, title: string, results: string[] = []): SessionSnapshot => ({
  ...parent,
  source: "sub",
  sub: { parentSessionId: parentId, n, title, goal: `做 ${title}`, input: {}, results, fileIds: [] },
})

const childrenOf = (parentId: string) =>
  ctx.db.select().from(t.sessions).where(and(eq(t.sessions.parentSessionId, parentId), eq(t.sessions.kind, "sub"))).orderBy(t.sessions.id)

const toolCtx = (row: SessionRow, snapshot: SessionSnapshot) => ({ db: ctx.db, session: row, snapshot })

const items = (...titles: string[]) => titles.map((title) => ({ title, goal: `把 ${title} 做完，交回结果` }))

// ---------- 拆 ----------

describe("拆", () => {
  it("开出子运行：编号接着数、子快照、附件只读不挪、第一条消息、排队后按名额放行", async () => {
    const { taskId, child } = await makeParentTask({ steps: [{ id: "s1", text: "拆", wait: false, checkpoint: "都查完" }] })
    const parent = await fakeParent(taskId)
    const { row: file } = await writeSpaceFile(ctx.db, { sessionId: parent.row.id, path: "data/list.csv", data: Buffer.from("a,b\n1,2\n") })
    const first = await startFromAgent(toolCtx(parent.row, parent.snapshot), {
      items: [
        { title: "等甲", goal: "查甲，交回价格", input: { 网址: "https://example.com/a" }, fileIds: [file.id], results: ["价格"] },
        { title: "等乙", goal: "查乙" },
      ],
    })
    expect(first.isError).toBeFalsy()
    expect(first.output).toContain(`${parent.row.id}.1「等甲」`)
    expect(first.output).toContain(`${parent.row.id}.2「等乙」`)
    const again = await startFromAgent(toolCtx(parent.row, parent.snapshot), { items: items("丙") })
    expect(again.output).toContain(`${parent.row.id}.3「丙」`)
    expect(again.output).toContain("一共拆了 3 个")

    const rows = await childrenOf(parent.row.id)
    expect(rows.map((row) => row.id)).toEqual([1, 2, 3].map((n) => `${parent.row.id}.${n}`))
    const one = rows[0]!
    expect(one).toMatchObject({ kind: "sub", triggeredBy: "sub", parentSessionId: parent.row.id, modelId: child, costLimitUsd: 1, maxSteps: 60, taskId })
    const snap = one.snapshot!
    expect(snap.source).toBe("sub")
    expect(snap.task.steps).toEqual([])
    expect(snap.checkpoints).toEqual([])
    const toolIds = snap.tools.map((tool) => tool.id)
    for (const dropped of ["subagent.start", "subagent.wait", "subagent.cancel", "work.dispatch", "session.wait", "checkpoint.mark"]) expect(toolIds).not.toContain(dropped)
    expect(toolIds).toContain("work.report")
    expect(snap.attachments.map((each) => each.id)).toContain(file.id)
    expect(snap.sub).toMatchObject({ parentSessionId: parent.row.id, n: 1, title: "等甲", results: ["价格"], fileIds: [file.id] })
    // 父的文件没被挪
    const [fileAfter] = await ctx.db.select().from(t.files).where(eq(t.files.id, file.id))
    expect(fileAfter!.sessionId).toBe(parent.row.id)
    // 第一条消息
    const [message] = await messagesOf(ctx.db, one.id)
    const firstText = JSON.stringify(message!.content)
    expect(firstText).toContain(`运行 ${parent.row.id} 拆出来的第 1 个子 agent`)
    expect(firstText).toContain("查甲，交回价格")
    expect(firstText).toContain("网址：https://example.com/a")
    expect(firstText).toContain("要交回的字段（用 work_report 交，都必填）：价格")
    // 系统提示：父任务的目标当背景、你是子 agent、不写步骤
    const system = buildSystemPrompt(snap, new Map())
    expect(system).toContain("父任务的目标（背景")
    expect(system).toContain("## 你是子 agent")
    expect(system).not.toContain("## 步骤")
    // 放行：默认同时 3 个，3 个都放出来、卡在模型里
    await waitFor(async () => (await childrenOf(parent.row.id)).every((row) => row.status === "running"), { what: "3 个子运行都放行" })
  })

  it("整次拒绝：超过每次运行上限、文件读不到、子运行调、没选工具，都一个不开", async () => {
    const { taskId } = await makeParentTask()
    await setSetting(ctx.db, SETTING_KEYS.subagentMaxPerRun, 3)
    const parent = await fakeParent(taskId)
    const tooMany = await startFromAgent(toolCtx(parent.row, parent.snapshot), { items: items("等1", "等2", "等3", "等4") })
    expect(tooMany.isError).toBe(true)
    expect(tooMany.output).toContain("最多拆 3 个")
    const other = await fakeParent(taskId)
    const { row: foreign } = await writeSpaceFile(ctx.db, { sessionId: other.row.id, path: "x.txt", data: Buffer.from("x") })
    const badFile = await startFromAgent(toolCtx(parent.row, parent.snapshot), { items: [{ title: "等1", goal: "做", fileIds: [foreign.id] }, { title: "等2", goal: "做" }] })
    expect(badFile.isError).toBe(true)
    expect(badFile.output).toContain(foreign.id)
    expect(await childrenOf(parent.row.id)).toEqual([])

    // 子运行调：不能再拆
    const subSnap = subSnapshot(parent.snapshot, parent.row.id, 1, "子")
    const childId = await fakeChild(parent.row.id, taskId, 1, { status: "running", extra: { snapshot: subSnap } })
    const nested = await startFromAgent(toolCtx((await sessionRow(ctx.db, childId))!, subSnap), { items: items("孙") })
    expect(nested.isError).toBe(true)
    expect(nested.output).toContain("不能再拆")

    // 任务没选「拆给子 agent」
    const plain = await createTask(ctx.db, { modelId: "test/none" })
    const plainRun = await fakeParent(plain)
    const refused = await startFromAgent(toolCtx(plainRun.row, plainRun.snapshot), { items: items("一") })
    expect(refused.isError).toBe(true)
    expect(await childrenOf(plainRun.row.id)).toEqual([])
  })
})

// ---------- 名额 ----------

describe("名额（subagent.pump）", () => {
  it("每次运行同时 3 个，一个结束放行下一个；等浏览器的占名额、等人处理的不占", async () => {
    const { taskId } = await makeParentTask()
    const parent = await fakeParent(taskId)
    const ids = []
    for (let n = 1; n <= 5; n++) ids.push(await fakeChild(parent.row.id, taskId, n, { status: "waiting", event: subagentQueueEvent(parent.row.id) }))
    await pumpSubagents(ctx.db)
    const status = async () => (await childrenOf(parent.row.id)).map((row) => row.status)
    expect(await status()).toEqual(["running", "running", "running", "waiting", "waiting"])
    const [summary] = await listSessions(ctx.db, { ids: [parent.row.id] })
    expect(summary!.subagents).toMatchObject({ total: 5, queued: 2, running: 3, ended: 0 })
    // 第 1 个结束 → 放行第 4 个
    await ctx.db.update(t.sessions).set({ status: "done", endedAt: new Date() }).where(eq(t.sessions.id, ids[0]!))
    await pumpSubagents(ctx.db)
    expect(await status()).toEqual(["done", "running", "running", "running", "waiting"])
    // 第 2 个挂起等浏览器（占名额）：不放行
    await ctx.db.update(t.sessions).set({ status: "waiting" }).where(eq(t.sessions.id, ids[1]!))
    await ctx.db.insert(t.sessionWaits).values({ sessionId: ids[1]!, what: "等待浏览器", triggerKind: "event", event: "browser.profile:any" })
    await pumpSubagents(ctx.db)
    expect((await status())[4]).toBe("waiting")
    // 第 3 个等人处理（不占）：放行第 5 个
    await ctx.db.update(t.sessions).set({ status: "needs_human" }).where(eq(t.sessions.id, ids[2]!))
    await pumpSubagents(ctx.db)
    expect((await status())[4]).toBe("running")
    const rows = await listSubagents(ctx.db, parent.row.id)
    expect(rows.map((row) => row.state)).toEqual(["ended", "waiting", "needs_human", "running", "running"])
  })

  it("全系统上限：两个父运行按排队先后放行；父运行结束了，排队的跟着取消", async () => {
    const { taskId } = await makeParentTask()
    await setSetting(ctx.db, SETTING_KEYS.subagentMaxRunningGlobal, 4)
    const a = await fakeParent(taskId)
    const b = await fakeParent(taskId)
    for (let n = 1; n <= 3; n++) await fakeChild(a.row.id, taskId, n, { status: "waiting", event: subagentQueueEvent(a.row.id) })
    for (let n = 1; n <= 3; n++) await fakeChild(b.row.id, taskId, n, { status: "waiting", event: subagentQueueEvent(b.row.id) })
    await pumpSubagents(ctx.db)
    const running = async (id: string) => (await childrenOf(id)).filter((row) => row.status === "running").length
    expect(await running(a.row.id)).toBe(3)
    expect(await running(b.row.id)).toBe(1)
    // 父运行 b 被取消（直接改状态，模拟漏了跟着停）：排队的两个在放行时取消
    await ctx.db.update(t.sessions).set({ status: "failed", endedAt: new Date() }).where(eq(t.sessions.id, b.row.id))
    const result = await pumpSubagents(ctx.db)
    expect(result.cancelled.sort()).toEqual([`${b.row.id}.2`, `${b.row.id}.3`])
    const cancelled = (await childrenOf(b.row.id)).filter((row) => row.status === "failed")
    expect(cancelled.every((row) => row.outcome === "not_achieved" && row.outcomeBy === "rule")).toBe(true)
  })

  it("排队的子运行不能「立即继续」；待办不会叫醒它", async () => {
    const { taskId } = await makeParentTask()
    const parent = await fakeParent(taskId)
    await setSetting(ctx.db, SETTING_KEYS.subagentMaxRunningGlobal, 1)
    await fakeChild(parent.row.id, taskId, 1, { status: "running" })
    const queued = await fakeChild(parent.row.id, taskId, 2, { status: "waiting", event: subagentQueueEvent(parent.row.id) })
    await expect(resumeNowImpl(ctx.db, { sessionId: queued, actorId: "u-lin", actorName: "林舟" })).rejects.toThrow("排队中")
  })
})

// ---------- 等、结果（走真的引擎） ----------

describe("等和交回", () => {
  it("all：父挂起，最后一个结束才叫醒一次，消息里有全部结果；子运行不复核、不通知", async () => {
    const parentModel = "test/sub-parent-all"
    const script = useScript(
      parentModel,
      new Script([
        step([call("subagent.start", { items: [{ title: "等一", goal: "做一", results: ["价格"] }, { title: "等二", goal: "做二" }, { title: "等三", goal: "做三" }] })]),
        step([call("subagent.wait", {})]),
        step(finishWith("汇总好了")),
      ])
    )
    const { taskId } = await makeParentTask({ parentModel })
    const { sessionId } = await startSessionImpl(ctx.db, { taskId, source: "manual" })
    await waitStatus(ctx.db, sessionId, "waiting")
    const waits = await ctx.db.select().from(t.sessionWaits).where(and(eq(t.sessionWaits.sessionId, sessionId), eq(t.sessionWaits.status, "waiting")))
    expect(waits[0]!.event).toBe(subagentWaitEvent(sessionId, "all"))
    expect(waits[0]!.what).toBe("子 agent（还有 3 个没结束）")
    gate("等一").open()
    await waitStatus(ctx.db, `${sessionId}.1`, "done")
    gate("等二").open()
    await waitStatus(ctx.db, `${sessionId}.2`, "done")
    // 两个结束了，父还在等
    expect((await sessionRow(ctx.db, sessionId))!.status).toBe("waiting")
    gate("等三").open()
    const done = await waitStatus(ctx.db, sessionId, "done", 30_000)
    await waitFor(async () => (await sessionRow(ctx.db, sessionId))!.outcome, { what: "父运行复核完" })
    expect(script.prompts.length).toBe(3)
    const woke = script.promptText(2)
    expect(woke).toContain("子 agent 都结束了（3 个：办成 2，没办成 1）")
    expect(woke).toContain(`${sessionId}.1「等一」没办成`)
    expect(woke).toContain("缺结果：价格")
    expect(woke).toContain(`${sessionId}.3「等三」办成：完成：等三`)
    const resumes = (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "resume")
    expect(resumes.map((event) => event.title)).toEqual(["子 agent 都结束了，继续"])
    expect(done.status).toBe("done")
    // 子运行：不复核（没有 review）、结果 agent 自报；没有给负责人发通知
    const children = await childrenOf(sessionId)
    expect(children.map((row) => [row.outcome, row.outcomeBy, row.review])).toEqual([
      ["not_achieved", "rule", null],
      ["achieved", "agent", null],
      ["achieved", "agent", null],
    ])
    expect(children.every((row) => row.subResult?.deliveredAt)).toBe(true)
    const notes = await ctx.db.select().from(t.notifications).where(inArray(t.notifications.sessionId, children.map((row) => row.id)))
    expect(notes).toEqual([])
    // 摘要：父运行的子 agent 统计、子运行的 sub；会话列表不列子运行
    const [summary] = await listSessions(ctx.db, { ids: [sessionId] })
    expect(summary!.subagents).toMatchObject({ total: 3, ended: 3, achieved: 2, queued: 0, running: 0, needsHuman: 0 })
    const listed = await listSessions(ctx.db, { taskId })
    expect(listed.map((row) => row.id)).toEqual([sessionId])
    const childView = await loadSession(ctx.db, `${sessionId}.1`)
    expect(childView!.sub).toEqual({ n: 1, title: "等一" })
    expect(childView!.parentSessionId).toBe(sessionId)
    expect(childView!.subGoal).toMatchObject({ n: 1, title: "等一", goal: "做一", results: [{ name: "价格" }] })
    // 复核的输入里有子 agent 一节
    const { prompt } = await buildReviewPrompt(ctx.db, (await sessionRow(ctx.db, sessionId))!, done.snapshot!, "汇总好了", false)
    expect(prompt).toContain("## 子 agent（这次运行拆出去的 3 个：办成 2，没办成 1）")
    // 拆过子 agent 的运行不能固化
    await ctx.db.update(t.sessions).set({ outcome: "achieved" }).where(eq(t.sessions.id, sessionId))
    await expect(compileFromSession(ctx.db, { sessionId, createdById: "u-lin", auto: false })).rejects.toThrow("拆了子 agent")
  })

  it("any：有一个结束就叫醒，第二次只给新的；work.report 交的字段、写的文件交回去", async () => {
    const parentModel = "test/sub-parent-any"
    const script = useScript(
      parentModel,
      new Script([
        step([call("subagent.start", { items: [{ title: "报字段", goal: "交价格和链接", results: ["价格", "链接"] }, { title: "等写文件", goal: "写个文件" }] })]),
        step([call("subagent.wait", { mode: "any" })]),
        step([call("subagent.wait", { mode: "any" })]),
        step(finishWith("都拿到了")),
      ])
    )
    const { taskId } = await makeParentTask({ parentModel })
    const { sessionId } = await startSessionImpl(ctx.db, { taskId, source: "manual" })
    await waitFor(async () => script.prompts.length >= 3, { what: "父被第一次叫醒", timeout: 30_000 })
    const first = script.promptText(2)
    expect(first).toContain(`${sessionId}.1「报字段」办成`)
    expect(first).toContain("交回的字段：价格=12.5，链接=https://example.com/x")
    expect(first).toContain(`${sessionId}.2「等写文件」还没结束`)
    await waitStatus(ctx.db, sessionId, "waiting")
    gate("等写文件").open()
    await waitStatus(ctx.db, sessionId, "done", 30_000)
    const second = script.promptText(3)
    expect(second).toContain(`${sessionId}.1「报字段」办成（前面给过）`)
    expect(second).toContain("文件：subs/2/out/result.txt")
    const [one] = await childrenOf(sessionId)
    expect(one!.subResult?.data).toEqual({ 价格: 12.5, 链接: "https://example.com/x" })
    // 父运行的空间里有 subs/2/out/result.txt：能按路径、按 id 读，不能写
    const parentRow = (await sessionRow(ctx.db, sessionId))!
    const snapshot = parentRow.snapshot!
    const list = await executeBuiltin(toolCtx(parentRow, snapshot), "file.list", {})
    expect(list.output).toContain("subs/2/out/result.txt")
    expect(list.output).toContain("子 agent")
    const byPath = await executeBuiltin(toolCtx(parentRow, snapshot), "file.read", { path: "subs/2/out/result.txt" })
    expect(byPath.output).toContain("内容 等写文件")
    const [childFile] = await ctx.db.select().from(t.files).where(eq(t.files.sessionId, `${sessionId}.2`))
    const byId = await executeBuiltin(toolCtx(parentRow, snapshot), "file.read", { fileId: childFile!.id })
    expect(byId.isError).toBeFalsy()
    const write = await executeBuiltin(toolCtx(parentRow, snapshot), "file.save", { path: "subs/2/out/result.txt", content: "改" })
    expect(write.isError).toBe(true)
    // 别的运行读不到子运行的文件
    const other = await fakeParent(taskId)
    const foreign = await executeBuiltin(toolCtx(other.row, other.snapshot), "file.read", { fileId: childFile!.id })
    expect(foreign.isError).toBe(true)
  })

  it("已经满足的不挂起、none 只看现状、挂起窗口里结束的补发叫醒；外部事件不能发 subagent.", async () => {
    const { taskId } = await makeParentTask()
    const parent = await fakeParent(taskId)
    const tc = toolCtx(parent.row, parent.snapshot)
    expect((await waitFromAgent(tc, {})).output).toContain("没有拆过子 agent")
    await fakeChild(parent.row.id, taskId, 1, { status: "done", extra: { outcome: "achieved", outcomeBy: "agent", snapshot: subSnapshot(parent.snapshot, parent.row.id, 1, "甲"), subResult: { summary: "甲的结果" } } })
    await fakeChild(parent.row.id, taskId, 2, { status: "waiting", event: subagentQueueEvent(parent.row.id), extra: { snapshot: subSnapshot(parent.snapshot, parent.row.id, 2, "乙") } })
    const none = await waitFromAgent(tc, { mode: "none" })
    expect(none.suspend).toBeUndefined()
    expect(none.output).toContain("甲」办成：甲的结果")
    expect(none.output).toContain("乙」还没结束：排队")
    // none 给过的，any 不再当新的：要挂起
    const any = await waitFromAgent(tc, { mode: "any" })
    expect(any.suspend?.kind).toBe("wait")
    const all = await waitFromAgent(tc, { mode: "all" })
    expect(all.suspend).toMatchObject({ kind: "wait", input: { event: subagentWaitEvent(parent.row.id, "all"), what: "子 agent（还有 1 个没结束）" } })
    // 父挂起（假的：直接写等待），挂起前乙已经结束 → 补查时发 subagent.notify → 叫醒
    await ctx.db.update(t.sessions).set({ status: "done", endedAt: new Date(), outcome: "achieved" }).where(eq(t.sessions.id, `${parent.row.id}.2`))
    await ctx.db.update(t.sessions).set({ status: "waiting" }).where(eq(t.sessions.id, parent.row.id))
    const [wait] = await ctx.db.insert(t.sessionWaits).values({ sessionId: parent.row.id, what: "等子 agent", triggerKind: "event", event: subagentWaitEvent(parent.row.id, "all") }).returning()
    await recheckSubagentWaitAfterSuspend(ctx.db, wait!.event)
    await waitFor(async () => (await ctx.db.select().from(t.sessionWaits).where(eq(t.sessionWaits.id, wait!.id)))[0]!.status === "fired", { what: "父被补发的叫醒叫醒" })
    const [message] = (await messagesOf(ctx.db, parent.row.id)).slice(-1)
    expect(JSON.stringify(message!.content)).toContain("甲」办成（前面给过）")
    await expect(fireEventImpl(ctx.db, { event: subagentWaitEvent(parent.row.id, "all"), via: "console" })).rejects.toThrow("subagent.")
  })
})

// ---------- 失败、取消 ----------

describe("失败和取消", () => {
  it("子 agent 出错、到了步数上限、只回文字：都记没办成交回父，不重试、不问人、不通知", async () => {
    await setSetting(ctx.db, SETTING_KEYS.subagentMaxSteps, 2)
    const parentModel = "test/sub-parent-fail"
    const script = useScript(
      parentModel,
      new Script([
        step([call("subagent.start", { items: items("出错了", "走步", "只回文字") })]),
        step([call("subagent.wait", {})]),
        step(finishWith("有的没办成", "not_achieved", "子 agent 没办成")),
      ])
    )
    const { taskId } = await makeParentTask({ parentModel })
    const { sessionId } = await startSessionImpl(ctx.db, { taskId, source: "manual" })
    await waitStatus(ctx.db, sessionId, "done", 40_000)
    const children = await childrenOf(sessionId)
    expect(children.map((row) => row.status)).toEqual(["failed", "done", "done"])
    expect(children[0]!.error).toContain("模型那边坏了")
    expect(children[1]).toMatchObject({ outcome: "not_achieved", outcomeBy: "rule" })
    expect(children[1]!.outcomeReason).toContain("子 agent 的步数到了上限 2 步")
    expect(children[2]).toMatchObject({ outcome: "not_achieved", outcomeBy: "rule", outcomeReason: "子 agent 没调用 run_finish 报结果" })
    const woke = script.promptText(2)
    expect(woke).toContain("出错了」没办成（出错或被停掉）")
    expect(woke).toContain("步数到了上限")
    const humans = await ctx.db.select().from(t.humanItems).where(inArray(t.humanItems.sessionId, children.map((row) => row.id)))
    expect(humans).toEqual([])
    const notes = await ctx.db.select().from(t.notifications).where(inArray(t.notifications.sessionId, children.map((row) => row.id)))
    expect(notes).toEqual([])
  })

  it("subagent.cancel 停掉排队的；人取消子运行，父收到；父被取消，子运行全部停掉", async () => {
    const { taskId } = await makeParentTask()
    await setSetting(ctx.db, SETTING_KEYS.subagentMaxParallel, 1)
    const parent = await fakeParent(taskId)
    const tc = toolCtx(parent.row, parent.snapshot)
    await startFromAgent(tc, { items: items("等甲", "等乙", "等丙") })
    await waitStatus(ctx.db, `${parent.row.id}.1`, "running")
    const cancelled = await cancelFromAgent(tc, { ids: [`${parent.row.id}.3`, "R-0-0.1"], reason: "用不上了" })
    expect(cancelled.output).toContain(`已停掉 1 个：${parent.row.id}.3`)
    expect(cancelled.output).toContain("不是这次运行拆出去的子 agent：R-0-0.1")
    const third = (await sessionRow(ctx.db, `${parent.row.id}.3`))!
    expect(third).toMatchObject({ status: "failed", outcome: "not_achieved", outcomeBy: "rule", outcomeReason: "父 agent 停掉的：用不上了" })
    // 人取消正在跑的第 1 个：第 2 个被放行
    await cancelSessionImpl(ctx.db, { sessionId: `${parent.row.id}.1`, actorId: "u-lin", actorName: "林舟" })
    await waitStatus(ctx.db, `${parent.row.id}.2`, "running")
    const none = await waitFromAgent(tc, { mode: "none" })
    expect(none.output).toContain("林舟取消了这次运行")
    // 父运行被取消：第 2 个跟着停
    await cancelSessionImpl(ctx.db, { sessionId: parent.row.id, actorId: "u-lin", actorName: "林舟" })
    const second = (await sessionRow(ctx.db, `${parent.row.id}.2`))!
    expect(second.status).toBe("failed")
    expect(second.error).toContain(`父运行 ${parent.row.id} 已经结束`)
  })

  it("停掉父运行：子 agent 正在调的模型马上中止；停掉以后才回来的模型回复不记进过程、不算步数，花的钱照记（父的「含子 agent」也算）；「已停掉」后面没有别的过程记录", async () => {
    const { taskId } = await makeParentTask()
    const parent = await fakeParent(taskId)
    const tc = toolCtx(parent.row, parent.snapshot)
    await startFromAgent(tc, { items: items("停等甲", "停慢乙") })
    const [first, second] = [`${parent.row.id}.1`, `${parent.row.id}.2`]
    await waitFor(async () => modelEntered.has("停等甲") && modelEntered.has("停慢乙"), { what: "两个子 agent 都在调模型" })
    const cancelledAt = Date.now()
    await cancelSessionImpl(ctx.db, { sessionId: parent.row.id, actorId: "u-lin", actorName: "林舟" })
    // 甲的模型调用很快被中止（轮询 1 秒一次），不等它调完（20 秒）
    const abortedAt = await waitFor(async () => modelAborted.get("停等甲"), { what: "甲的模型调用被中止", timeout: 5000 })
    expect(abortedAt - cancelledAt).toBeLessThan(3000)
    // 乙的模型不理中止，停掉以后才回来：这笔钱实际花了，照记
    await waitFor(async () => modelReturned.get("停慢乙"), { what: "乙的模型回来", timeout: 5000 })
    const late = await waitFor(async () => {
      const row = await sessionRow(ctx.db, second)
      return row && Number(row.costUsd) > 0 ? row : undefined
    }, { what: "乙晚回来的那次回复记上花费", timeout: 5000 })
    expect(Number(late.costUsd)).toBeCloseTo(LATE_REPLY_COST)
    expect(late).toMatchObject({ tokensIn: 100, tokensOut: 20 })
    expect(await familyCost(ctx.db, parent.row.id)).toBeCloseTo(Number(parent.row.costUsd) + LATE_REPLY_COST)
    // 甲中止后没有回复，拿不到用量，不记
    expect(Number((await sessionRow(ctx.db, first))!.costUsd)).toBe(0)
    for (const id of [first, second]) {
      const row = (await sessionRow(ctx.db, id))!
      expect(row.status).toBe("failed")
      // 两个都没算步数
      expect(row.stepCount).toBe(0)
      const events = await eventsOf(ctx.db, id)
      const stop = events.findIndex((event) => event.title === "已停掉")
      expect(stop).toBeGreaterThan(-1)
      expect(events.slice(stop + 1).map((event) => event.title)).toEqual([])
      expect(events.some((event) => event.kind === "think")).toBe(false)
    }
  })

  it("父还有子 agent 没结束：run.finish 被拒；只回文字先提醒一次，再只回文字就停掉子 agent 收尾", async () => {
    const parentModel = "test/sub-parent-text"
    const script = useScript(
      parentModel,
      new Script([
        step([call("subagent.start", { items: items("等不来") })]),
        step(finishWith("想直接结束")),
        step([text("我不等了")]),
        step([text("真的不等了")]),
        step(finishWith("结束")),
      ])
    )
    const { taskId } = await makeParentTask({ parentModel })
    const { sessionId } = await startSessionImpl(ctx.db, { taskId, source: "manual" })
    await waitStatus(ctx.db, sessionId, "done", 30_000)
    expect(script.promptText(2)).toContain("还有 1 个子 agent 没结束")
    expect(script.promptText(3)).toContain("先用 subagent_wait 等，或者用 subagent_cancel 停掉")
    const child = (await sessionRow(ctx.db, `${sessionId}.1`))!
    expect(child.status).toBe("failed")
    expect(child.error).toContain("父 agent 没等子 agent 结束就收尾了")
  })
})

// ---------- 花费 ----------

describe("花费", () => {
  it("合计花费、同意继续按合计调高、今天的花费算上子运行、派活每天花费算上被派运行的子运行", async () => {
    const { taskId } = await makeParentTask()
    const parent = await fakeParent(taskId, { costUsd: 0.5 })
    await fakeChild(parent.row.id, taskId, 1, { status: "done", extra: { costUsd: 0.25 } })
    await fakeChild(parent.row.id, taskId, 2, { status: "done", extra: { costUsd: 0.125 } })
    expect(await familyCost(ctx.db, parent.row.id)).toBeCloseTo(0.875)
    // 花费上限「同意继续」：在合计上再给一份默认额度（默认 2 美元）
    await ctx.db.update(t.sessions).set({ status: "needs_human" }).where(eq(t.sessions.id, parent.row.id))
    const item = await createHumanItem(ctx.db, { kind: "approval", title: "花费到了上限", summary: "", assigneeId: "u-wang", taskId, sessionId: parent.row.id, urgency: 1, detail: { sections: [], primary: "继续", secondary: "不继续" } })
    await ctx.db.insert(t.sessionWaits).values({ sessionId: parent.row.id, what: "花费到了上限", triggerKind: "event", event: `等 ${item.id} 处理`, humanItemId: item.id, match: { limit: "cost" } })
    await resolveHumanItemImpl(ctx.db, { itemId: item.id, how: "approve", actorId: "u-wang", actorName: "王悦" })
    expect((await sessionRow(ctx.db, parent.row.id))!.costLimitUsd).toBeCloseTo(2.875)
    // 今天的花费：普通运行 + 子运行
    const page = await pageSessions(ctx.db, { taskId }, { id: "u-lin", isAdmin: true })
    expect(page.spentToday).toBeGreaterThanOrEqual(0.875)
    // 被派的运行拆出去的子运行：算进派活每天花费
    const dispatched = await fakeParent(taskId, { costUsd: 0.25 })
    const before = (await dispatchSpentToday(ctx.db, [taskId])).get(taskId) ?? 0
    const n = Number((await ctx.db.execute<{ n: string }>(sql`select nextval('work_item_no_seq') as n`)).rows[0]!.n)
    await ctx.db.insert(t.workItems).values({ id: `W-${n}`, taskId, key: `k${n}`, title: "一件", params: {}, status: "running", via: "human", sessionId: dispatched.row.id })
    await ctx.db.update(t.sessions).set({ workItemId: `W-${n}` }).where(eq(t.sessions.id, dispatched.row.id))
    await fakeChild(dispatched.row.id, taskId, 1, { status: "done", extra: { costUsd: 0.5 } })
    const after = (await dispatchSpentToday(ctx.db, [taskId])).get(taskId) ?? 0
    expect(after - before).toBeCloseTo(0.75)
    // 被派的运行在等子 agent：照样占派活名额
    await ctx.db.update(t.sessions).set({ status: "waiting" }).where(eq(t.sessions.id, dispatched.row.id))
    await ctx.db.insert(t.sessionWaits).values({ sessionId: dispatched.row.id, what: "等子 agent", triggerKind: "event", event: subagentWaitEvent(dispatched.row.id, "all") })
    expect(await occupiedSlots(ctx.db, taskId)).toBe(1)
  })
})

// ---------- 别处 ----------

describe("别处", () => {
  it("手动编号不被子运行、定时编号撑大", async () => {
    const parentModel = "test/sub-parent-number"
    useScript(parentModel, new Script(Array.from({ length: 20 }, () => () => step(finishWith("没事")))))
    const { taskId } = await makeParentTask({ parentModel })
    const n = taskId.slice(2)
    const { sessionId: first } = await startSessionImpl(ctx.db, { taskId, source: "manual" })
    expect(first).toBe(`R-${n}-1`)
    await waitStatus(ctx.db, first, "done")
    for (let k = 1; k <= 4; k++) await fakeChild(first, taskId, k, { status: "done" })
    await ctx.db.insert(t.sessions).values({ id: `R-${n}-1028`, taskId, status: "done", modelId: "test/none", triggeredBy: "cron", startedAt: new Date() })
    const { sessionId: second } = await startSessionImpl(ctx.db, { taskId, source: "manual" })
    expect(second).toBe(`R-${n}-2`)
  })

  it("父运行的系统提示有「拆给子 agent」一节（名额、Chrome 个数、可以 none 看现状）", async () => {
    const { taskId } = await makeParentTask()
    const parent = await fakeParent(taskId)
    const system = buildSystemPrompt(parent.snapshot, new Map(), { subagent: { maxParallel: 3, maxPerRun: 10 } })
    expect(system).toContain("## 拆给子 agent")
    expect(system).toContain("同时最多 3 个子 agent 在跑，一共最多拆 10 个")
    expect(system).toContain("mode: none")
    // 21.3 第 1 条：交出去的不要自己再做、只查矛盾和缺的那一处；没办成、缺的照常处理
    expect(system).toContain("拆完先做不在子目标里的事")
    expect(system).toContain("交出去的不要自己再做一遍")
    expect(system).toContain("看各个子 agent 交回的依据、文件有没有互相矛盾、和目标对不对得上")
    expect(system).toContain("有矛盾或缺的只查那一处，或补拆")
    expect(system).toContain("子 agent 报没办成、或交回的东西缺了的，看原因")
    expect(system).not.toContain("先做你自己能做的")
    expect(system).not.toContain("自己核对")
    expect(buildSystemPrompt(parent.snapshot, new Map())).not.toContain("## 拆给子 agent")
  })

  it("交回的文字：开头的数、已经给过的一行、出错的写原因（纯函数）", () => {
    const base = { goal: "", results: [], files: [] }
    const rows: SubRunFacts[] = [
      { ...base, id: "R-1-1.1", n: 1, title: "甲", status: "done", outcome: "achieved", subResult: { summary: "好了", evidence: "页面上有", data: { 数: 3 }, deliveredAt: undefined }, files: ["out/a.csv"] },
      { ...base, id: "R-1-1.2", n: 2, title: "乙", status: "failed", outcome: "not_achieved", error: "父 agent 停掉的：不要了" },
      { ...base, id: "R-1-1.3", n: 3, title: "丙", status: "done", outcome: "achieved", subResult: { deliveredAt: "2026-10-28T00:00:00Z" } },
    ]
    const text = subagentResultsText(rows, "all")
    expect(text).toContain("子 agent 都结束了（3 个：办成 2，没办成 1）")
    expect(text).toContain("- R-1-1.1「甲」办成：好了\n  依据：页面上有\n  交回的字段：数=3\n  文件：subs/1/out/a.csv")
    expect(text).toContain("R-1-1.2「乙」没办成（出错或被停掉）：父 agent 停掉的：不要了")
    expect(text).toContain("R-1-1.3「丙」办成（前面给过）")
    expect(text).toContain("没有复核")
    // 21.3 第 1 条：叫醒消息的最后一句只让看矛盾、查缺的那一处，不要逐个重做
    expect(text.split("\n").at(-1)).toBe(SUBAGENT_RESULTS_TAIL)
    expect(SUBAGENT_RESULTS_TAIL).toContain("看各个子 agent 交回的依据、文件有没有互相矛盾、和目标对不对得上")
    expect(SUBAGENT_RESULTS_TAIL).toContain("有矛盾或缺的只查那一处，或补拆")
    expect(SUBAGENT_RESULTS_TAIL).toContain("报没办成的、交回的东西缺了的照常处理")
    expect(text).not.toContain("自己核对")
  })
})

// ---------- 演示数据 ----------

describe("演示数据", () => {
  it("一个父运行拆了 5 个：2 个办成、1 个没办成、1 个排队、1 个排队时被停掉；页面要的数据都齐", async () => {
    const { parentId, childIds } = await insertSubagentFixtures(ctx.db)
    const rows = await listSubagents(ctx.db, parentId)
    expect(rows.map((row) => [row.id, row.state, row.outcome ?? null])).toEqual([
      [childIds[0], "ended", "achieved"],
      [childIds[1], "ended", "achieved"],
      [childIds[2], "ended", "not_achieved"],
      [childIds[3], "queued", null],
      [childIds[4], "ended", "not_achieved"],
    ])
    // 用时从轮到（ranAt）算，不算排队：15 秒、80 秒、42 秒；一直没轮到的没有 ranAt（页面写「没开始」）
    const ran = rows.map((row) => (row.ranAt && row.endedAt ? (Date.parse(row.endedAt) - Date.parse(row.ranAt)) / 1000 : null))
    expect(ran).toEqual([15, 80, 42, null, null])
    expect(rows[3]!.ranAt).toBeUndefined()
    expect(rows[4]!.ranAt).toBeUndefined()
    const [summary] = await listSessions(ctx.db, { ids: [parentId] })
    expect(summary!.subagents).toMatchObject({ total: 5, ended: 4, achieved: 2, queued: 1 })
    expect(summary!.waiting?.what).toBe("子 agent（还有 1 个没结束）")
    const child = await loadSession(ctx.db, childIds[0]!)
    expect(child!.subGoal).toMatchObject({ n: 1, results: [{ name: "标题", value: "Example A" }, { name: "状态码", value: 200 }], files: [{ name: "in/pages.csv" }] })
    const parentRow = (await sessionRow(ctx.db, parentId))!
    const list = await executeBuiltin(toolCtx(parentRow, parentRow.snapshot!), "file.list", {})
    expect(list.output).toContain("subs/1/out/a.json")
  })
})

// ---------- 清扫 ----------

/**
 * 清扫的测试自己调 sweepSubagents：先停掉 worker 每分钟的 work.sweep（它也调 sweepSubagents，会和这里抢着停、抢着叫醒，
 * 负载高时这个测试因此不稳），等排着的、正在跑的 work.sweep 都做完（有期限），测完再排回去
 */
async function withoutCronSweep(work: () => Promise<void>) {
  const boss = await bossFor(ctx.db)
  await boss.unschedule(QUEUES.workSweep)
  try {
    await waitFor(
      async () => {
        const result = await ctx.db.execute<{ n: string }>(sql`select count(*) as n from pgboss.job where name = ${QUEUES.workSweep} and state in ('created', 'retry', 'active')`)
        return Number(result.rows[0]?.n ?? 0) === 0
      },
      { what: "排着的 work.sweep 做完", timeout: 30_000 }
    )
    await work()
  } finally {
    await boss.schedule(QUEUES.workSweep, "* * * * *", {}, { tz: SCHEDULE_TZ })
  }
}

describe("清扫", () => {
  it("父已结束的子运行停掉、漏了的叫醒补发、有排队的发 pump", async () => {
    await withoutCronSweep(sweepCase)
  })
})

/** 清扫那一例的内容（在 withoutCronSweep 里跑） */
async function sweepCase() {
  const { taskId } = await makeParentTask()
  const ended = await fakeParent(taskId, { status: "failed", endedAt: new Date() })
  const orphan = await fakeChild(ended.row.id, taskId, 1, { status: "running" })
  const waiting = await fakeParent(taskId, { status: "waiting" })
  await fakeChild(waiting.row.id, taskId, 1, { status: "done", extra: { outcome: "achieved", snapshot: subSnapshot(waiting.snapshot, waiting.row.id, 1, "甲") } })
  await ctx.db.insert(t.sessionWaits).values({ sessionId: waiting.row.id, what: "等子 agent", triggerKind: "event", event: subagentWaitEvent(waiting.row.id, "all") })
  const live = await fakeParent(taskId)
  await setSetting(ctx.db, SETTING_KEYS.subagentMaxRunningGlobal, 1)
  await fakeChild(live.row.id, taskId, 1, { status: "running" })
  await fakeChild(live.row.id, taskId, 2, { status: "waiting", event: subagentQueueEvent(live.row.id) })
  const result = await sweepSubagents(ctx.db)
  expect(result.stopped).toContain(orphan)
  expect(result.notified).toContain(waiting.row.id)
  expect(result.pumped).toBe(true)
  expect((await sessionRow(ctx.db, orphan))!).toMatchObject({ status: "failed", error: expect.stringContaining(`父运行 ${ended.row.id} 已经结束`) })
  // 补发的叫醒到了：父运行等子 agent 的那条等待被事件叫醒、交回的子运行标了已交回。父运行醒来以后用的是假模型，
  // 马上又会结束，所以不等它「执行中」（一闪而过，负载高时轮询看不到），看等待和交回
  const fired = await waitFor(
    async () => {
      const [wait] = await ctx.db.select().from(t.sessionWaits).where(and(eq(t.sessionWaits.sessionId, waiting.row.id), sql`${t.sessionWaits.event} like 'subagent.%'`))
      return wait && wait.status !== "waiting" ? wait : undefined
    },
    { what: "父运行被叫醒", timeout: 30_000 }
  )
  expect(fired).toMatchObject({ status: "fired", firedCause: "event" })
  expect((await sessionRow(ctx.db, `${waiting.row.id}.1`))!.subResult?.deliveredAt).toBeTruthy()
  expect((await sessionRow(ctx.db, waiting.row.id))!.status).not.toBe("waiting")
}
