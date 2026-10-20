// 运行结果（docs/dev/run-outcome.md）：状态只管流程（正常结束都是「已结束」），办没办成看结果列。真实的测试库 + 进程内 worker + 假模型。
// 覆盖：run.finish（校验、报没办成直接收尾、报办成先过验收规则）；旧快照的 run.not_done；只回文字提醒一次（挂起再继续也只一次）；
// 检查点兜底（没达成、全部跳过 → 没办成；部分跳过 → 部分办成；全部达成 → 有依据）；轻量复核（只能往低判、说不准、出错、关着、没配模型）；
// 被派的运行（单跟着结果走：部分办成、没办成都不重试，缺必交结果 missing_result，复核完才结算，清扫不结算复核中的、超时按现在的结果）；
// 人改结果（负责人、主管能改；只改已结束的；单跟着改结果不改状态）；迁移 0024 补旧数据（在事务里灌样例、跑补数据的语句、回滚）。
import { readFileSync } from "node:fs"

import { RUN_FINISH_TOOL_ID, RUN_NOT_DONE_TOOL_ID, type TaskDispatch } from "@heyagent/shared"
import { eq, sql } from "drizzle-orm"
import pg from "pg"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { sweepWork } from "../src/engine/dispatch/sweep.js"
import { buildSystemPrompt } from "../src/engine/prompt.js"
import { QUEUES, runJobOptions } from "../src/engine/queue.js"
import { appendMessage } from "../src/engine/records.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { login, query, testDatabaseUrl } from "./helpers.js"
import {
  call,
  createTask,
  eventsOf,
  messagesOf,
  mutate,
  Script,
  sessionRow,
  setupEngine,
  step,
  text,
  useScript,
  waitFor,
  type EngineTestContext,
} from "./engine-helpers.js"

let ctx: EngineTestContext
let wang: string // 员工，测试任务的负责人（createTask 默认 u-wang）
let lin: string // 主管
let chen: string // 另一个员工

beforeAll(async () => {
  ctx = await setupEngine()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  lin = await login(ctx.app, "linzhou@heyagent.local")
  chen = await login(ctx.app, "lijing@heyagent.local")
}, 120_000)

afterAll(async () => {
  await ctx?.stop()
})

/** 两步，各带一个检查点 */
const TWO_CHECKPOINTS = [
  { id: "s1", text: "找到报价", wait: false, checkpoint: "拿到报价" },
  { id: "s2", text: "存一张表", wait: false, checkpoint: "汇总表已保存" },
]

async function runNow(taskId: string) {
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(`runNow 失败：${JSON.stringify(res.error)}`)
  return res.data.sessionId as string
}

const notesOf = (sessionId: string) => ctx.db.select().from(t.notifications).where(eq(t.notifications.sessionId, sessionId))
const finish = (outcome: "achieved" | "partial" | "not_achieved", extra: { reason?: string; summary?: string; evidence?: string } = {}) =>
  call("run.finish", { outcome, summary: extra.summary ?? "总结", evidence: extra.evidence ?? "依据", ...(extra.reason ? { reason: extra.reason } : {}) })

/** 等结果写好（复核完的才算：review 没有 pending） */
async function waitOutcome(sessionId: string) {
  return waitFor(
    async () => {
      const row = await sessionRow(ctx.db, sessionId)
      return row && row.outcome && !row.review?.pending ? row : undefined
    },
    { what: `${sessionId} 的结果` }
  )
}

describe("run.finish", () => {
  it("报没办成：运行马上结束（状态已结束），结果没办成、agent 定的，原因写上；不再调模型；通知负责人", async () => {
    const script = useScript(
      "test/out-not",
      new Script([
        step([text("找过了"), finish("not_achieved", { reason: "五个站都没有这个商品", summary: "搜了五个站" }), call("plan.set", { steps: ["不该执行"] })]),
        step([text("不该走到这里")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/out-not", title: "找商品", steps: TWO_CHECKPOINTS })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "not_achieved", outcomeBy: "agent", outcomeReason: "五个站都没有这个商品；2 个检查点没达成：拿到报价、汇总表已保存", error: null })
    expect(script.prompts.length).toBe(1)
    // 每个任务都自带 run.finish（不再带 run.not_done），系统提示里是新的那句话
    const names = (script.prompts[0]!.tools ?? []).map((tool) => tool.name)
    expect(names).toContain("run_finish")
    expect(names).not.toContain("run_not_done")
    expect(script.promptText(0)).toContain("结束时一定调用 run_finish 报结果。只看任务目标要的东西拿没拿到")
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.at(-1)).toMatchObject({ kind: "done", title: "agent 报没办成" })
    expect(events.at(-1)!.detail).toContain("原因：五个站都没有这个商品")
    // 同一步里后面的调用没执行，结果照样补上
    const tools = (await messagesOf(ctx.db, sessionId)).filter((message) => message.role === "tool")
    expect(JSON.stringify(tools.at(-1)?.content)).toContain("前面已经报了结果")
    expect((await notesOf(sessionId)).map((note) => [note.title, note.body])).toEqual([["找商品：没办成", "五个站都没有这个商品；2 个检查点没达成：拿到报价、汇总表已保存"]])
    // 页面接口带上结果
    const run = (await query(ctx.app, "sessions.get", wang, { id: sessionId })).data
    expect(run).toMatchObject({ status: "done", outcome: "not_achieved", outcomeBy: "agent", outcomeReason: expect.stringContaining("五个站都没有这个商品") })
  })

  it("校验：partial / not_achieved 不写 reason 是工具错误，agent 接着干；补上再调就收尾", async () => {
    const script = useScript(
      "test/out-check",
      new Script([step([finish("partial")]), step([finish("partial", { reason: "只拿到 2 家报价" })])])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/out-check" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "partial", outcomeBy: "agent", outcomeReason: "只拿到 2 家报价" })
    expect(script.promptText(1)).toContain("outcome = partial 时要写 reason")
  })

  it("报办成、没有检查点、没配复核模型：结果没核实（规则定的）", async () => {
    useScript("test/out-ach", new Script([step([finish("achieved", { summary: "表存好了", evidence: "result.csv" })])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-ach", title: "存表" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "unverified", outcomeBy: "rule", review: null })
    expect(row.outcomeReason).toContain("没配复核模型")
    expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "done", title: "agent 报办成，结果记没核实" })
    const notes = await notesOf(sessionId)
    expect(notes.map((note) => note.title)).toEqual(["存表：运行结束，没核实"])
  })

  it("旧快照（有 run.not_done、没有 run.finish、没有 reviewEnabled）照旧能用：等价于报没办成", async () => {
    const script = useScript("test/out-old", new Script([step([call("run.not_done", { reason: "后台没有权限" })])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-old", title: "旧运行" })
    const fresh = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })
    const old = { ...fresh, tools: [...fresh.tools.filter((tool) => tool.id !== RUN_FINISH_TOOL_ID), { id: RUN_NOT_DONE_TOOL_ID, name: "报没完成", summary: "做不成时调用", description: "", source: "builtin" as const, risk: "read" as const, alwaysOn: true }] }
    delete old.reviewEnabled
    const sessionId = "R-out-old-1"
    await ctx.db.insert(t.sessions).values({ id: sessionId, taskId, status: "running", modelId: "test/out-old", triggeredBy: "manual", startedAt: new Date(), snapshot: old })
    await appendMessage(ctx.db, sessionId, { role: "user", content: "开始执行任务" })
    await ctx.worker.boss.send(QUEUES.run, { sessionId }, runJobOptions(sessionId))
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "not_achieved", outcomeBy: "agent", outcomeReason: "后台没有权限" })
    // 旧快照的系统提示照旧（教 run_not_done，不提 run_finish）
    expect(script.promptText(0)).toContain("run_not_done")
    expect(script.promptText(0)).not.toContain("run_finish")
    // run.not_done 不再同步进 tools 表，run.finish 是自带的
    expect(await ctx.db.select().from(t.tools).where(eq(t.tools.id, RUN_NOT_DONE_TOOL_ID))).toEqual([])
    const [tool] = await ctx.db.select().from(t.tools).where(eq(t.tools.id, RUN_FINISH_TOOL_ID))
    expect(tool).toMatchObject({ source: "builtin", alwaysOn: true })
    expect(buildSystemPrompt(old, new Map())).not.toContain("run_finish")
  })
})

describe("只回文字：提醒一次", () => {
  it("第一次只回文字 → 追加提醒接着跑；再回文字 → 按没报结果收尾，没核实", async () => {
    const script = useScript("test/out-nudge", new Script([step([text("做完了")]), step([text("真的做完了")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-nudge" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(script.prompts.length).toBe(2)
    expect(script.promptText(1)).toContain("要结束请调用 run_finish 报结果（办成 / 部分办成 / 没办成），并对照目标写依据。")
    expect(row).toMatchObject({ status: "done", outcome: "unverified", outcomeBy: "rule" })
    expect(row.outcomeReason).toContain("agent 只回了一段文字、没报结果")
    expect(row.ruleState).toMatchObject({ finishNudged: true })
    const titles = (await eventsOf(ctx.db, sessionId)).map((event) => event.title)
    expect(titles).toContain("agent 只回了文字、没报结果，提醒它调用 run_finish")
    expect(titles.at(-1)).toBe("agent 说做完了（没报结果）")
  })

  it("提醒过的标记存在库里：挂起再继续以后只回文字，不再提醒", async () => {
    const script = useScript(
      "test/out-nudge-wait",
      new Script([step([text("先说一句")]), step([call("session.wait", { what: "等一会儿", afterMinutes: 0.02 })]), step([text("好了")]), step([text("不该再被提醒")])])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/out-nudge-wait" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(script.prompts.length).toBe(3)
    expect(row.outcome).toBe("unverified")
    const nudges = (await eventsOf(ctx.db, sessionId)).filter((event) => event.title.startsWith("agent 只回了文字"))
    expect(nudges.length).toBe(1)
  }, 40_000)
})

describe("检查点兜底", () => {
  it("有没勾的检查点 → 没办成（规则），原因列出没达成的", async () => {
    useScript("test/out-open", new Script([step([call("checkpoint.mark", { checkpoint: 1, status: "done", record: "拿到 3 家报价" })]), step([finish("achieved")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-open", title: "比价", steps: TWO_CHECKPOINTS })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "not_achieved", outcomeBy: "rule", outcomeReason: "1 个检查点没达成：汇总表已保存" })
    expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "done", title: "agent 报办成，结果记没办成" })
    expect((await notesOf(sessionId)).map((note) => note.title)).toEqual(["比价：没办成"])
  })

  it("检查点全部跳过 → 没办成（R-1-1 那种：全标跳过、嘴上说做完了）", async () => {
    useScript(
      "test/out-skip-all",
      new Script([
        step([call("checkpoint.mark", { checkpoint: 1, status: "skipped", reason: "网站打不开" }), call("checkpoint.mark", { checkpoint: 2, status: "skipped", reason: "没有数据可存" })]),
        step([text("任务完成")]),
        step([text("任务完成")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/out-skip-all", steps: TWO_CHECKPOINTS })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "not_achieved", outcomeBy: "rule", outcomeReason: "2 个检查点全部跳过，一个都没达成：拿到报价、汇总表已保存" })
  })

  it("部分跳过（其余都勾了）→ 最多部分办成", async () => {
    useScript(
      "test/out-skip-some",
      new Script([
        step([call("checkpoint.mark", { checkpoint: 1, status: "done", record: "拿到 3 家报价" }), call("checkpoint.mark", { checkpoint: 2, status: "skipped", reason: "负责人说这次不用存表" })]),
        step([finish("achieved")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/out-skip-some", steps: TWO_CHECKPOINTS })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "partial", outcomeBy: "rule", outcomeReason: "1 个检查点跳过：汇总表已保存" })
  })

  it("全部达成 + 报办成、没配复核模型 → 办成（检查点是依据）", async () => {
    useScript(
      "test/out-all-done",
      new Script([step([call("checkpoint.mark", { checkpoint: 1, status: "done", record: "3 家" }), call("checkpoint.mark", { checkpoint: 2, status: "done", record: "sum.csv" })]), step([finish("achieved")])])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/out-all-done", title: "全部做完", steps: TWO_CHECKPOINTS })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "achieved", outcomeBy: "rule" })
    expect((await notesOf(sessionId)).map((note) => note.title)).toEqual(["全部做完：办成"])
  })
})

describe("轻量复核", () => {
  const REVIEW = "test/out-reviewer"
  const reviewJson = (verdict: string, reason: string) => step([text(JSON.stringify({ verdict, reason }))], 0.0004)

  beforeAll(async () => {
    await ctx.db.insert(t.models).values({ id: REVIEW, providerId: "openrouter", name: "复核用的假模型", contextK: 100, priceIn: 0.04, priceOut: 0.08, vision: false, kind: "chat" }).onConflictDoNothing()
    await ctx.db.insert(t.modelDefaults).values({ role: "review", modelId: REVIEW }).onConflictDoUpdate({ target: t.modelDefaults.role, set: { modelId: REVIEW } })
  })
  afterAll(async () => {
    await ctx.db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "review"))
  })

  it("报办成、复核判办成 → 办成（复核定的）；复核报告、过程记录、用量记进运行", async () => {
    const reviewer = useScript(REVIEW, new Script([reviewJson("achieved", "过程记录里有存好的表")]))
    useScript("test/out-rv-ok", new Script([step([finish("achieved", { summary: "表存好了", evidence: "result.csv 里 3 行" })], 0.001)]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-rv-ok", goal: "存一张三行的表" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "achieved", outcomeBy: "review", outcomeReason: "过程记录里有存好的表" })
    expect(row.review).toMatchObject({ modelId: REVIEW, verdict: "achieved", screenshot: false, costUsd: 0.0004 })
    expect(row.review?.pending).toBeUndefined()
    expect(row.costUsd).toBeCloseTo(0.0014, 6)
    // 复核的输入：目标、agent 的报告（总结 + 依据）
    expect(reviewer.promptText(0)).toContain("存一张三行的表")
    expect(reviewer.promptText(0)).toContain("result.csv 里 3 行")
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.map((event) => [event.kind, event.title]).slice(-2)).toEqual([
      ["done", "agent 报办成，等 AI 复核"],
      ["verify", "AI 复核：办成"],
    ])
  })

  it("复核判没办成 → 往低判，结果没办成、通知负责人", async () => {
    useScript(REVIEW, new Script([reviewJson("not_achieved", "目标要的商品链接一个都没有")]))
    useScript("test/out-rv-low", new Script([step([finish("achieved")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-rv-low", title: "找链接" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ outcome: "not_achieved", outcomeBy: "review", outcomeReason: "目标要的商品链接一个都没有" })
    expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "verify", title: "AI 复核：没办成" })
    expect((await notesOf(sessionId)).map((note) => note.title)).toEqual(["找链接：没办成"])
  })

  it("复核只能往低判：agent 报部分办成、复核判办成 → 还是部分办成（agent 定的）", async () => {
    useScript(REVIEW, new Script([reviewJson("achieved", "看起来都拿到了")]))
    useScript("test/out-rv-up", new Script([step([finish("partial", { reason: "还差一家" })])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-rv-up" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ outcome: "partial", outcomeBy: "agent", outcomeReason: "还差一家" })
    expect(row.review).toMatchObject({ verdict: "achieved" })
    expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "verify", title: "AI 复核：办成，结果记部分办成" })
  })

  it("复核说不准 → 没核实", async () => {
    useScript(REVIEW, new Script([reviewJson("unsure", "证据里看不到结果")]))
    useScript("test/out-rv-unsure", new Script([step([text("做完了")]), step([text("做完了")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-rv-unsure" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ outcome: "unverified", outcomeBy: "review", outcomeReason: "证据里看不到结果" })
  })

  it("复核出错 → 没核实，报告写 error，过程记录写原因；运行状态不受影响", async () => {
    const boom = () => {
      throw new Error("复核模型挂了")
    }
    useScript(REVIEW, new Script([boom, boom]))
    useScript("test/out-rv-err", new Script([step([finish("achieved")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-rv-err" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "unverified", outcomeBy: "review" })
    expect(row.review?.error).toContain("复核模型挂了")
    expect(row.review?.verdict).toBeUndefined()
    expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "verify", title: "AI 复核出错，结果记没核实" })
  })

  it("agent 报没办成不复核；任务关了复核不复核（没核实，原因写关了）", async () => {
    const reviewer = useScript(REVIEW, new Script([]))
    useScript("test/out-rv-skip", new Script([step([finish("not_achieved", { reason: "没有" })])]))
    const first = await runNow(await createTask(ctx.db, { modelId: "test/out-rv-skip" }))
    expect((await waitOutcome(first)).outcome).toBe("not_achieved")

    useScript("test/out-rv-off", new Script([step([finish("achieved")])]))
    const off = await createTask(ctx.db, { modelId: "test/out-rv-off" })
    await ctx.db.update(t.tasks).set({ reviewEnabled: false }).where(eq(t.tasks.id, off))
    const second = await runNow(off)
    const row = await waitOutcome(second)
    expect(row).toMatchObject({ outcome: "unverified", review: null })
    expect(row.outcomeReason).toContain("任务关了复核")
    expect(reviewer.prompts.length).toBe(0)
  })
})

describe("被派的运行：单跟着结果走", () => {
  const DISPATCH: TaskDispatch = {
    results: [],
    params: [{ name: "单号", description: "要办的单号", required: true, dedupe: true }],
    maxRunning: 1,
    retries: 2,
    retryDelayMinutes: 1,
  }

  async function dispatchedTask(modelId: string, extra: { steps?: typeof TWO_CHECKPOINTS; dispatch?: Partial<TaskDispatch> } = {}) {
    const patrol = await createTask(ctx.db, { modelId: "test/none", toolIds: ["work.dispatch"], title: "巡检" })
    const worker = await createTask(ctx.db, { modelId, title: "办一件事", steps: extra.steps })
    await ctx.db.update(t.tasks).set({ dispatch: { ...DISPATCH, ...extra.dispatch } }).where(eq(t.tasks.id, worker))
    await ctx.db.insert(t.taskDispatchSources).values({ taskId: worker, sourceTaskId: patrol })
    return worker
  }

  const itemRow = async (id: string) => (await ctx.db.select().from(t.workItems).where(eq(t.workItems.id, id)))[0]!
  const ended = (id: string, status = "failed") =>
    waitFor(async () => {
      const row = await itemRow(id)
      return row.status === status ? row : undefined
    }, { what: `${id} ${status}` })

  async function dispatch(worker: string, no: string) {
    const res = await mutate(ctx.app, "work.dispatch", wang, { taskId: worker, params: { 单号: no } })
    return res.data.item.id as string
  }

  it("报没办成 → 单没办成（not_done），配了重试也不重试；单上有结果和原因；通知负责人", async () => {
    useScript("test/out-d-not", new Script([step([text("找不到这一单"), finish("not_achieved", { reason: "系统里查不到单号 K-1", summary: "找不到这一单" })]), step([text("不该走到这里")])]))
    const worker = await dispatchedTask("test/out-d-not")
    const id = await dispatch(worker, "K-1")
    const item = await ended(id)
    expect(item).toMatchObject({ failKind: "not_done", autoRetries: 0, attempts: 1, error: "系统里查不到单号 K-1", outcome: "not_achieved", outcomeReason: "系统里查不到单号 K-1", notBefore: null })
    expect(item.result).toMatchObject({ summary: "找不到这一单" })
    expect(item.log.at(-1)).toMatchObject({ kind: "run_ended", note: "not_done", sessionId: item.sessionId })
    const session = (await sessionRow(ctx.db, item.sessionId!))!
    expect(session).toMatchObject({ status: "done", outcome: "not_achieved" })
    expect((await notesOf(session.id)).map((note) => [note.title, note.body])).toEqual([["办一件事：没办成", "系统里查不到单号 K-1"]])
    const shaped = (await query(ctx.app, "work.get", wang, { id })).data
    expect(shaped).toMatchObject({ failKind: "not_done", outcome: "not_achieved", outcomeReason: "系统里查不到单号 K-1" })
    expect(shaped.runs[0]).toMatchObject({ outcome: "not_achieved", status: "done" })
  })

  it("部分办成 → 单没办成（partial），不重试", async () => {
    useScript("test/out-d-partial", new Script([step([finish("partial", { reason: "只核对了一半" })])]))
    const worker = await dispatchedTask("test/out-d-partial")
    const item = await ended(await dispatch(worker, "K-2"))
    expect(item).toMatchObject({ failKind: "partial", autoRetries: 0, outcome: "partial", error: "只核对了一半" })
  })

  it("没设检查点、必填的结果没交 → 没办成（missing_result），原因「缺结果：…」；交了的照收", async () => {
    useScript("test/out-d-missing", new Script([step([call("work.report", { data: { 备注: "顺便看了" } })]), step([finish("achieved")])]))
    const worker = await dispatchedTask("test/out-d-missing", {
      dispatch: { results: [{ name: "价格", description: "最低价", required: true }, { name: "链接", description: "", required: true }, { name: "备注", description: "", required: false }] },
    })
    const id = await dispatch(worker, "K-3")
    const item = await ended(id)
    expect(item).toMatchObject({ failKind: "missing_result", autoRetries: 0, outcome: "not_achieved", error: "缺结果：价格、链接" })
    expect(item.result?.data).toEqual({ 备注: "顺便看了" })
    // 「派来的活」一节列出要交回的结果
    const session = (await sessionRow(ctx.db, item.sessionId!))!
    expect(session.snapshot?.dispatch?.results?.map((result) => result.name)).toEqual(["价格", "链接", "备注"])
    const prompt = buildSystemPrompt(session.snapshot!, new Map())
    expect(prompt).toContain("- 价格（必填：最低价）")
    expect(prompt).toContain("必填的没交，这张单记「没办成」")
    // 结果筛选：只看没办成的
    const list = (await query(ctx.app, "work.list", wang, { taskId: worker, outcome: "not_achieved" })).data
    expect(list.items.map((each: { id: string }) => each.id)).toEqual([id])
    expect((await query(ctx.app, "work.list", wang, { taskId: worker, outcome: ["achieved", "unverified"] })).data.items).toEqual([])
  })

  it("交齐了结果、没配复核模型 → 单办完，结果没核实", async () => {
    useScript("test/out-d-ok", new Script([step([call("work.report", { data: { 价格: 12.5 } })]), step([finish("achieved", { summary: "价格 12.5" })])]))
    const worker = await dispatchedTask("test/out-d-ok", { dispatch: { results: [{ name: "价格", description: "", required: true }] } })
    const item = await ended(await dispatch(worker, "K-4"), "done")
    expect(item).toMatchObject({ failKind: null, outcome: "unverified" })
    expect(item.outcomeReason).toContain("没有依据")
    // 被派的运行办完不发通知
    expect(await notesOf(item.sessionId!)).toEqual([])
  })

  it("复核完才结算单：复核期间运行已结束、单还在办，清扫不结算；复核回来以后按复核的结果结算", async () => {
    const REVIEW = "test/out-d-reviewer"
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    useScript(REVIEW, new Script([async () => (await gate, step([text(JSON.stringify({ verdict: "not_achieved", reason: "页面上没有回填的结果" }))]))]))
    await ctx.db.insert(t.models).values({ id: REVIEW, providerId: "openrouter", name: "复核", contextK: 100, vision: false, kind: "chat" }).onConflictDoNothing()
    useScript("test/out-d-review", new Script([step([finish("achieved")])]))
    const worker = await dispatchedTask("test/out-d-review")
    await ctx.db.update(t.tasks).set({ reviewModelId: REVIEW }).where(eq(t.tasks.id, worker))
    const id = await dispatch(worker, "K-5")
    const pending = await waitFor(async () => {
      const row = await itemRow(id)
      const session = row.sessionId ? await sessionRow(ctx.db, row.sessionId) : undefined
      return session?.review?.pending ? { row, session } : undefined
    }, { what: "复核中" })
    expect(pending.session).toMatchObject({ status: "done", outcome: "unverified" })
    expect(pending.row.status).toBe("running")
    expect((await sweepWork(ctx.db)).settled).not.toContain(id)
    release()
    const item = await ended(id)
    expect(item).toMatchObject({ failKind: "not_done", outcome: "not_achieved", outcomeReason: "页面上没有回填的结果" })
  })

  it("清扫：复核过了时限还没回来 → 清掉标记、写上原因，按现在的结果结算单", async () => {
    const worker = await dispatchedTask("test/none")
    await ctx.db.update(t.tasks).set({ enabled: false }).where(eq(t.tasks.id, worker))
    const n = Number((await ctx.db.execute<{ n: string }>(sql`select nextval('work_item_no_seq') as n`)).rows[0]!.n)
    const id = `W-${n}`
    await ctx.db.insert(t.workItems).values({ id, taskId: worker, key: "K-6", title: "K-6", params: { 单号: "K-6" }, status: "running", via: "human" })
    const sessionId = "R-out-sweep-1"
    const at = new Date(Date.now() - 11 * 60_000).toISOString()
    await ctx.db.insert(t.sessions).values({
      id: sessionId,
      taskId: worker,
      status: "done",
      outcome: "unverified",
      outcomeBy: "rule",
      outcomeReason: "等 AI 复核",
      review: { at, modelId: "x", reason: "", screenshot: false, tokensIn: 0, tokensOut: 0, costUsd: 0, pending: true },
      modelId: "test/none",
      triggeredBy: "dispatch",
      startedAt: new Date(),
      endedAt: new Date(),
      workItemId: id,
    })
    await ctx.db.update(t.workItems).set({ sessionId }).where(eq(t.workItems.id, id))
    const swept = await sweepWork(ctx.db)
    expect(swept.settled).toContain(id)
    expect(await itemRow(id)).toMatchObject({ status: "done", outcome: "unverified" })
    const session = (await sessionRow(ctx.db, sessionId))!
    expect(session.review?.pending).toBeUndefined()
    expect(session.review?.error).toContain("没有结果")
    expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "verify" })
    expect((await eventsOf(ctx.db, sessionId)).at(-1)!.title.startsWith("AI 复核")).toBe(true)
  })

  it("清扫补写：旧的没完成运行 → 单没办成（not_done），不重试", async () => {
    const worker = await dispatchedTask("test/none")
    await ctx.db.update(t.tasks).set({ enabled: false }).where(eq(t.tasks.id, worker))
    const n = Number((await ctx.db.execute<{ n: string }>(sql`select nextval('work_item_no_seq') as n`)).rows[0]!.n)
    const id = `W-${n}`
    await ctx.db.insert(t.workItems).values({ id, taskId: worker, key: "K-7", title: "K-7", params: { 单号: "K-7" }, status: "running", via: "human" })
    const sessionId = "R-out-sweep-2"
    await ctx.db.insert(t.sessions).values({ id: sessionId, taskId: worker, status: "incomplete", modelId: "test/none", triggeredBy: "dispatch", startedAt: new Date(), endedAt: new Date(), workItemId: id, error: "1 个检查点没达成：汇总表已保存" })
    await ctx.db.update(t.workItems).set({ sessionId }).where(eq(t.workItems.id, id))
    expect((await sweepWork(ctx.db)).settled).toContain(id)
    expect(await itemRow(id)).toMatchObject({ status: "failed", failKind: "not_done", autoRetries: 0, outcome: "not_achieved", error: "1 个检查点没达成：汇总表已保存" })
  })

  it("人改结果：单跟着改结果，不改状态", async () => {
    useScript("test/out-d-human", new Script([step([finish("not_achieved", { reason: "以为没有" })])]))
    const worker = await dispatchedTask("test/out-d-human")
    const item = await ended(await dispatch(worker, "K-8"))
    const res = await mutate(ctx.app, "sessions.setOutcome", wang, { id: item.sessionId, outcome: "achieved", reason: "其实找到了，在第二页" })
    expect(res.data).toEqual({ sessionId: item.sessionId, outcome: "achieved" })
    expect(await itemRow(item.id)).toMatchObject({ status: "failed", outcome: "achieved", outcomeReason: "其实找到了，在第二页" })
  })
})

describe("人改结果（sessions.setOutcome）", () => {
  it("负责人、主管能改；别的员工不能；没结束的不能改；记过程记录和审计", async () => {
    useScript("test/out-set", new Script([step([finish("achieved")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-set" })
    const sessionId = await runNow(taskId)
    await waitOutcome(sessionId)
    const input = { id: sessionId, outcome: "achieved", reason: "我看过了，表是对的" }
    expect((await mutate(ctx.app, "sessions.setOutcome", chen, input)).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "sessions.setOutcome", wang, { ...input, reason: " " })).error?.data?.code).toBe("BAD_REQUEST")
    expect((await mutate(ctx.app, "sessions.setOutcome", wang, input)).data).toEqual({ sessionId, outcome: "achieved" })
    expect(await sessionRow(ctx.db, sessionId)).toMatchObject({ status: "done", outcome: "achieved", outcomeBy: "human", outcomeReason: "我看过了，表是对的" })
    expect((await mutate(ctx.app, "sessions.setOutcome", lin, { ...input, outcome: "partial", reason: "其实少了一列" })).data?.outcome).toBe("partial")
    const events = (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "human")
    expect(events.map((event) => event.title)).toEqual([expect.stringContaining("把结果改成「办成」"), expect.stringContaining("把结果改成「部分办成」")])
    expect(events[1]!.detail).toContain("原来是「办成」")
    const audits = await ctx.db.select().from(t.auditEvents).where(eq(t.auditEvents.targetId, sessionId))
    expect(audits.filter((row) => row.action === "session.set_outcome").length).toBe(2)
    expect((await mutate(ctx.app, "sessions.setOutcome", wang, { id: "R-nope", outcome: "achieved", reason: "x" })).error?.data?.code).toBe("NOT_FOUND")

    // 还没结束的不能改
    const running = "R-out-running-1"
    await ctx.db.insert(t.sessions).values({ id: running, taskId, status: "waiting", modelId: "test/none", triggeredBy: "manual", startedAt: new Date() })
    expect((await mutate(ctx.app, "sessions.setOutcome", wang, { ...input, id: running })).error?.data?.code).toBe("BAD_REQUEST")
    // 列表按结果筛
    const list = (await query(ctx.app, "sessions.list", wang, { taskId, outcome: ["partial"] })).data
    expect(list.map((each: { id: string }) => each.id)).toEqual([sessionId])
  })
})

describe("迁移 0024 补旧数据", () => {
  it("每一行规则（在事务里灌样例、跑补数据的语句、回滚）", async () => {
    const statements = readFileSync(new URL("../drizzle/0024_run_outcome.sql", import.meta.url), "utf8")
      .split("--> statement-breakpoint")
      .map((part) => part.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
      .filter((part) => part.startsWith("UPDATE"))
    expect(statements.length).toBe(8)
    const client = new pg.Client({ connectionString: testDatabaseUrl() })
    await client.connect()
    try {
      await client.query("begin")
      const taskId = await createTask(ctx.db, { modelId: "test/none" })
      // 先把库里已有的结果清空会影响别的行：只看这里灌的几行（id 以 R-mig- 开头），已有结果的行补数据不会动
      const add = async (id: string, status: string, extra: { error?: string; verification?: unknown; checkpoints?: string[]; doneTitle?: string } = {}) => {
        await client.query(`insert into sessions (id, task_id, status, model_id, started_at, ended_at, error, verification) values ($1, $2, $3, 'test/none', now(), now(), $4, $5)`, [
          id,
          taskId,
          status,
          extra.error ?? null,
          extra.verification ? JSON.stringify(extra.verification) : null,
        ])
        for (const [position, status] of (extra.checkpoints ?? []).entries())
          await client.query(`insert into checkpoints (session_id, position, title, kind, status) values ($1, $2, $3, 'note', $4)`, [id, position, `检查点${position + 1}`, status])
        if (extra.doneTitle) await client.query(`insert into session_events (session_id, seq, at, kind, title) values ($1, 1, now(), 'done', $2)`, [id, extra.doneTitle])
      }
      await add("R-mig-inc-agent", "incomplete", { error: "后台没权限", doneTitle: "agent 报没完成" })
      await add("R-mig-inc-rule", "incomplete", { error: "1 个检查点没达成：b", doneTitle: "检查点没达成，运行没完成" })
      await add("R-mig-failed", "failed", { error: "模型调用失败" })
      await add("R-mig-open", "done", { checkpoints: ["done", "open"] })
      await add("R-mig-allskip", "done", { checkpoints: ["skipped", "skipped"] })
      await add("R-mig-verified", "done", { checkpoints: ["done", "open"], verification: { status: "passed", headline: "全部通过" } })
      await add("R-mig-someskip", "done", { checkpoints: ["done", "skipped"] })
      await add("R-mig-alldone", "done", { checkpoints: ["done", "done"] })
      await add("R-mig-plain", "done")
      const item = async (id: string, status: string, sessionId: string | null, error: string | null = null) =>
        client.query(`insert into work_items (id, task_id, key, title, params, status, via, session_id, error) values ($1, $2, $1, $1, '{}', $3, 'human', $4, $5)`, [id, taskId, status, sessionId, error])
      await item("W-mig-1", "done", "R-mig-plain")
      await item("W-mig-2", "failed", "R-mig-inc-agent", "后台没权限")
      await item("W-mig-3", "cancelled", null, "林舟点了不办了")
      await item("W-mig-4", "running", "R-mig-open")
      for (const statement of statements) await client.query(statement)
      const { rows } = await client.query<{ id: string; status: string; outcome: string; outcome_by: string; outcome_reason: string | null }>(
        `select id, status::text, outcome::text, outcome_by::text, outcome_reason from sessions where id like 'R-mig-%' order by id`
      )
      const by = Object.fromEntries(rows.map((row) => [row.id, row]))
      expect(by["R-mig-inc-agent"]).toMatchObject({ status: "done", outcome: "not_achieved", outcome_by: "agent", outcome_reason: "后台没权限" })
      expect(by["R-mig-inc-rule"]).toMatchObject({ status: "done", outcome: "not_achieved", outcome_by: "rule", outcome_reason: "1 个检查点没达成：b" })
      expect(by["R-mig-failed"]).toMatchObject({ status: "failed", outcome: "not_achieved", outcome_by: "rule", outcome_reason: "模型调用失败" })
      expect(by["R-mig-open"]).toMatchObject({ outcome: "not_achieved", outcome_by: "rule", outcome_reason: "1 个检查点没达成：检查点2" })
      expect(by["R-mig-allskip"]).toMatchObject({ outcome: "not_achieved", outcome_reason: "2 个检查点全部跳过，一个都没达成：检查点1、检查点2" })
      expect(by["R-mig-verified"]).toMatchObject({ outcome: "achieved", outcome_by: "verify", outcome_reason: "全部通过" })
      expect(by["R-mig-someskip"]).toMatchObject({ outcome: "partial", outcome_by: "rule", outcome_reason: "1 个检查点跳过：检查点2" })
      expect(by["R-mig-alldone"]).toMatchObject({ outcome: "unverified", outcome_by: "rule" })
      expect(by["R-mig-plain"]).toMatchObject({ outcome: "unverified", outcome_by: "rule", outcome_reason: "旧运行，agent 说做完了，还没核实" })
      const items = Object.fromEntries((await client.query<{ id: string; status: string; outcome: string | null; outcome_reason: string | null }>(`select id, status::text, outcome::text, outcome_reason from work_items where id like 'W-mig-%'`)).rows.map((row) => [row.id, row]))
      expect(items["W-mig-1"]).toMatchObject({ status: "done", outcome: "unverified" })
      expect(items["W-mig-2"]).toMatchObject({ status: "failed", outcome: "not_achieved", outcome_reason: "后台没权限" })
      expect(items["W-mig-3"]).toMatchObject({ status: "cancelled", outcome: "not_achieved", outcome_reason: "林舟点了不办了" })
      expect(items["W-mig-4"]).toMatchObject({ status: "running", outcome: null })
    } finally {
      await client.query("rollback").catch(() => undefined)
      await client.end()
    }
  })
})
