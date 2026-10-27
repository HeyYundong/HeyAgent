// 运行结果（docs/dev/run-outcome.md）：状态只管流程（正常结束都是「已结束」），办没办成看结果列，只有办成 / 没办成（2026-10-20 简化）。
// 真实的测试库 + 进程内 worker + 假模型（默认复核模型是 TEST_REVIEWER，没给剧本时判办成）。
// 覆盖：run.finish（校验、报没办成直接收尾、旧说明的 partial 当没办成、报办成先过验收规则）；旧快照的 run.not_done；只回文字提醒一次；
// 检查点兜底（没达成、全部跳过、部分跳过 → 没办成；全部达成 → 还要复核）；复核（一定做；判办成才办成；证据不足、出错（重试一次）记没办成；
// 没复核模型的不开始运行、旧快照结束时没复核模型记没办成）；被派的运行（单跟着结果走：没办成不重试，缺必交结果 missing_result，
// 复核完才结算，清扫不结算复核中的、超时记没办成，人取消的不重试）；人改结果（负责人、主管能改；已结束、出错、取消的都能改；单跟着改结果不改状态）；
// 迁移 0024 + 0026 补旧数据（在事务里灌样例、跑补数据的语句、回滚）。
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
import { REVIEW_EXPIRED_REASON } from "../src/engine/dispatch/sweep.js"
import {
  call,
  createTask,
  eventsOf,
  messagesOf,
  mutate,
  resetTestReviewer,
  reviewVerdict,
  Script,
  sessionRow,
  setupEngine,
  step,
  text,
  TEST_REVIEWER,
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

/** 这次运行的通知。通知在收尾的事务提交以后才写（状态先变、通知晚一点，负载高时看得出来）：等最多 3 秒，有了就返回 */
async function notesOf(sessionId: string) {
  const read = () => ctx.db.select().from(t.notifications).where(eq(t.notifications.sessionId, sessionId))
  for (let i = 0; i < 30; i++) {
    const rows = await read()
    if (rows.length) return rows
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return read()
}
// partial 是旧说明里的写法（运行中途的模型可能还会传），照收、当没办成
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
    expect(script.promptText(0)).toContain("结束时一定调用 run_finish 报结果，结果只有办成、没办成两种。")
    expect(script.promptText(0)).toContain("拿到一部分也算没办成，在 reason 写清拿到了什么、缺什么")
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

  it("校验：not_achieved 不写 reason 是工具错误，agent 接着干；补上再调就收尾", async () => {
    const script = useScript(
      "test/out-check",
      new Script([step([finish("not_achieved")]), step([finish("not_achieved", { reason: "只拿到 2 家报价，缺第 3 家" })])])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/out-check" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "not_achieved", outcomeBy: "agent", outcomeReason: "只拿到 2 家报价，缺第 3 家" })
    expect(script.promptText(1)).toContain("outcome = not_achieved 时要写 reason")
  })

  it("旧说明里的 partial（部分办成）照收：当没办成，不复核", async () => {
    const reviewer = useScript(TEST_REVIEWER, new Script([]))
    useScript("test/out-partial", new Script([step([finish("partial", { reason: "只拿到价格，缺链接" })])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-partial" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "not_achieved", outcomeBy: "agent", outcomeReason: "只拿到价格，缺链接", review: null })
    expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "done", title: "agent 报没办成" })
    expect(reviewer.prompts.length).toBe(0)
    await resetTestReviewer(ctx.db)
  })

  it("报办成、没有检查点：一定复核，复核判办成才办成（复核定的）", async () => {
    useScript("test/out-ach", new Script([step([finish("achieved", { summary: "表存好了", evidence: "result.csv" })])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-ach", title: "存表" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "achieved", outcomeBy: "review", review: { modelId: TEST_REVIEWER, verdict: "achieved" } })
    expect((await eventsOf(ctx.db, sessionId)).map((event) => event.title).slice(-2)).toEqual(["agent 报办成，等 AI 复核", "AI 复核：办成"])
    const notes = await notesOf(sessionId)
    expect(notes.map((note) => note.title)).toEqual(["存表：办成"])
  })

  it("没有复核模型（任务没选、也没有默认的）：不开始运行，说清楚", async () => {
    await ctx.db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "review"))
    try {
      const taskId = await createTask(ctx.db, { modelId: "test/none" })
      const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
      expect(res.error?.data?.code).toBe("BAD_REQUEST")
      expect(res.error?.message).toBe("任务没设复核模型，先在任务里选一个")
      expect(await ctx.db.select().from(t.sessions).where(eq(t.sessions.taskId, taskId))).toEqual([])
      // 任务自己选了复核模型的照常开始
      useScript("test/out-own-review", new Script([step([finish("not_achieved", { reason: "没有" })])]))
      const own = await createTask(ctx.db, { modelId: "test/out-own-review", reviewModelId: TEST_REVIEWER })
      expect((await waitOutcome(await runNow(own))).outcome).toBe("not_achieved")
    } finally {
      await resetTestReviewer(ctx.db)
    }
  })

  it("任务的复核模型必填：不给、给空的、给不存在的都存不了；给了就冻进快照", async () => {
    const base = { title: "复核模型必填", goal: "目标", steps: [], schedule: null, memoryIds: [], skillIds: [], toolIds: [], ruleIds: [] }
    const missing = await mutate(ctx.app, "tasks.create", lin, base)
    expect(missing.error?.data?.code).toBe("BAD_REQUEST")
    expect(missing.error?.message).toContain("选一个复核模型")
    expect((await mutate(ctx.app, "tasks.create", lin, { ...base, reviewModelId: " " })).error?.message).toContain("选一个复核模型")
    expect((await mutate(ctx.app, "tasks.create", lin, { ...base, reviewModelId: "test/nope" })).error?.message).toContain("复核模型 test/nope 不存在")
    const created = await mutate(ctx.app, "tasks.create", lin, { ...base, reviewModelId: TEST_REVIEWER })
    expect(created.error).toBeUndefined()
    const snapshot = await buildSnapshot(ctx.db, created.data.id, { source: "manual", runAttachments: [] })
    expect(snapshot.reviewModelId).toBe(TEST_REVIEWER)
    expect("reviewEnabled" in snapshot).toBe(false)
  })

  it("开始以后默认复核模型没了（快照没冻复核模型）：结果记没办成，原因「没配复核模型」", async () => {
    useScript("test/out-no-review", new Script([step([finish("achieved")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-no-review", title: "没复核" })
    const snapshot = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })
    await ctx.db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "review"))
    try {
      const sessionId = "R-out-no-review-1"
      await ctx.db.insert(t.sessions).values({ id: sessionId, taskId, status: "running", modelId: "test/out-no-review", triggeredBy: "manual", startedAt: new Date(), snapshot })
      await appendMessage(ctx.db, sessionId, { role: "user", content: "开始执行任务" })
      await ctx.worker.boss.send(QUEUES.run, { sessionId }, runJobOptions(sessionId))
      const row = await waitOutcome(sessionId)
      expect(row).toMatchObject({ status: "done", outcome: "not_achieved", outcomeBy: "rule", outcomeReason: "没配复核模型，没能确认办成", review: null })
      expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "done", title: "agent 报办成，结果记没办成" })
      expect((await notesOf(sessionId)).map((note) => note.title)).toEqual(["没复核：没办成"])
    } finally {
      await resetTestReviewer(ctx.db)
    }
  })

  it("旧快照（有 run.not_done、没有 run.finish、没有 reviewEnabled）照旧能用：等价于报没办成", async () => {
    const script = useScript("test/out-old", new Script([step([call("run.not_done", { reason: "后台没有权限" })])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-old", title: "旧运行" })
    const fresh = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })
    const old = { ...fresh, tools: [...fresh.tools.filter((tool) => tool.id !== RUN_FINISH_TOOL_ID), { id: RUN_NOT_DONE_TOOL_ID, name: "报没完成", summary: "做不成时调用", description: "", source: "builtin" as const, risk: "read" as const, alwaysOn: true }] }
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
  it("第一次只回文字 → 追加提醒接着跑；再回文字 → 按没报结果收尾，交给复核", async () => {
    const script = useScript("test/out-nudge", new Script([step([text("做完了")]), step([text("真的做完了")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-nudge" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(script.prompts.length).toBe(2)
    expect(script.promptText(1)).toContain("要结束请调用 run_finish 报结果（办成 / 没办成），并对照目标写依据。")
    expect(row).toMatchObject({ status: "done", outcome: "achieved", outcomeBy: "review" })
    expect(row.ruleState).toMatchObject({ finishNudged: true })
    const titles = (await eventsOf(ctx.db, sessionId)).map((event) => event.title)
    expect(titles).toContain("agent 只回了文字、没报结果，提醒它调用 run_finish")
    expect(titles.slice(-2)).toEqual(["agent 说做完了（没报结果），等 AI 复核", "AI 复核：办成"])
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
    expect(row.outcome).toBe("achieved")
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

  it("部分跳过（其余都勾了）→ 没办成（只办成一部分），不复核", async () => {
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
    expect(row).toMatchObject({ status: "done", outcome: "not_achieved", outcomeBy: "rule", outcomeReason: "1 个检查点跳过，只办成了一部分：汇总表已保存", review: null })
  })

  it("全部达成 + 报办成 → 还要复核（检查点是 agent 自己勾的），复核判办成才办成", async () => {
    useScript(
      "test/out-all-done",
      new Script([step([call("checkpoint.mark", { checkpoint: 1, status: "done", record: "3 家" }), call("checkpoint.mark", { checkpoint: 2, status: "done", record: "sum.csv" })]), step([finish("achieved")])])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/out-all-done", title: "全部做完", steps: TWO_CHECKPOINTS })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "achieved", outcomeBy: "review", review: { verdict: "achieved" } })
    expect((await notesOf(sessionId)).map((note) => note.title)).toEqual(["全部做完：办成"])
  })
})

describe("复核", () => {
  afterAll(async () => {
    await resetTestReviewer(ctx.db)
  })

  it("报办成、复核判办成 → 办成（复核定的）；复核报告、过程记录、用量记进运行", async () => {
    const reviewer = useScript(TEST_REVIEWER, new Script([reviewVerdict("achieved", "过程记录里有存好的表")]))
    useScript("test/out-rv-ok", new Script([step([finish("achieved", { summary: "表存好了", evidence: "result.csv 里 3 行" })], 0.001)]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-rv-ok", goal: "存一张三行的表" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "achieved", outcomeBy: "review", outcomeReason: "过程记录里有存好的表" })
    expect(row.review).toMatchObject({ modelId: TEST_REVIEWER, verdict: "achieved", screenshot: false, costUsd: 0.0004 })
    expect(row.review?.pending).toBeUndefined()
    expect(row.costUsd).toBeCloseTo(0.0014, 6)
    // 复核的输入：目标、agent 的报告（总结 + 依据）；提示词说清只有两种、拿不准判没办成
    expect(reviewer.promptText(0)).toContain("存一张三行的表")
    expect(reviewer.promptText(0)).toContain("result.csv 里 3 行")
    expect(JSON.stringify(reviewer.prompts[0]?.prompt)).toContain("证据不够下结论、拿不准时也判 not_achieved")
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.map((event) => [event.kind, event.title]).slice(-2)).toEqual([
      ["done", "agent 报办成，等 AI 复核"],
      ["verify", "AI 复核：办成"],
    ])
  })

  it("复核判没办成 → 没办成、通知负责人", async () => {
    useScript(TEST_REVIEWER, new Script([reviewVerdict("not_achieved", "目标要的商品链接一个都没有")]))
    useScript("test/out-rv-low", new Script([step([finish("achieved")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-rv-low", title: "找链接" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ outcome: "not_achieved", outcomeBy: "review", outcomeReason: "目标要的商品链接一个都没有" })
    expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "verify", title: "AI 复核：没办成" })
    expect((await notesOf(sessionId)).map((note) => note.title)).toEqual(["找链接：没办成"])
  })

  it("证据不足（只回文字）→ 复核判没办成，原因写缺什么", async () => {
    useScript(TEST_REVIEWER, new Script([reviewVerdict("not_achieved", "证据不足：过程记录里看不到表")]))
    useScript("test/out-rv-unsure", new Script([step([text("做完了")]), step([text("做完了")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-rv-unsure" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ outcome: "not_achieved", outcomeBy: "review", outcomeReason: "证据不足：过程记录里看不到表" })
  })

  it("复核出错重试一次：第二次成了照常定结果", async () => {
    const reviewer = useScript(
      TEST_REVIEWER,
      new Script([
        () => {
          throw new Error("复核模型抖了一下")
        },
        reviewVerdict("achieved", "表在"),
      ])
    )
    useScript("test/out-rv-retry", new Script([step([finish("achieved")])]))
    const sessionId = await runNow(await createTask(ctx.db, { modelId: "test/out-rv-retry" }))
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ outcome: "achieved", outcomeBy: "review", outcomeReason: "表在" })
    expect(row.review?.error).toBeUndefined()
    expect(reviewer.prompts.length).toBe(2)
  })

  it("复核两次都出错 → 没办成（没能确认办成），报告写 error，过程记录写原因；运行状态不受影响", async () => {
    const boom = () => {
      throw new Error("复核模型挂了")
    }
    const reviewer = useScript(TEST_REVIEWER, new Script([boom, boom]))
    useScript("test/out-rv-err", new Script([step([finish("achieved")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-rv-err" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row).toMatchObject({ status: "done", outcome: "not_achieved", outcomeBy: "review" })
    expect(row.outcomeReason).toMatch(/^复核出错，没能确认办成：复核模型挂了/)
    expect(row.review?.error).toContain("重试了一次")
    expect(row.review?.verdict).toBeUndefined()
    expect(reviewer.prompts.length).toBe(2)
    expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "verify", title: "AI 复核出错，结果记没办成" })
  })

  it("agent 报没办成不复核；任务自己选的复核模型优先于默认的", async () => {
    const reviewer = useScript(TEST_REVIEWER, new Script([]))
    useScript("test/out-rv-skip", new Script([step([finish("not_achieved", { reason: "没有" })])]))
    const first = await runNow(await createTask(ctx.db, { modelId: "test/out-rv-skip" }))
    expect((await waitOutcome(first)).outcome).toBe("not_achieved")
    expect(reviewer.prompts.length).toBe(0)

    const OWN = "test/out-rv-own-model"
    await ctx.db.insert(t.models).values({ id: OWN, providerId: "openrouter", name: "任务自己的复核模型", contextK: 100, vision: false, kind: "chat" }).onConflictDoNothing()
    const own = useScript(OWN, new Script([reviewVerdict("achieved", "自己的复核模型看过了")]))
    useScript("test/out-rv-own", new Script([step([finish("achieved")])]))
    const second = await runNow(await createTask(ctx.db, { modelId: "test/out-rv-own", reviewModelId: OWN }))
    const row = await waitOutcome(second)
    expect(row).toMatchObject({ outcome: "achieved", review: { modelId: OWN } })
    expect(own.prompts.length).toBe(1)
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

  it("只办成一部分（旧说明的 partial）→ 单没办成（not_done），不重试", async () => {
    useScript("test/out-d-partial", new Script([step([finish("partial", { reason: "只核对了一半" })])]))
    const worker = await dispatchedTask("test/out-d-partial")
    const item = await ended(await dispatch(worker, "K-2"))
    expect(item).toMatchObject({ failKind: "not_done", autoRetries: 0, outcome: "not_achieved", error: "只核对了一半" })
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
    expect((await query(ctx.app, "work.list", wang, { taskId: worker, outcome: ["achieved"] })).data.items).toEqual([])
    // 派活页的「没办成」标签
    const bad = (await query(ctx.app, "work.list", wang, { taskId: worker, view: "not_achieved" })).data
    expect(bad.items.map((each: { id: string }) => each.id)).toEqual([id])
    expect(bad.counts.notAchieved).toBe(1)
    // 旧的结果值不认了
    expect((await query(ctx.app, "work.list", wang, { taskId: worker, outcome: "unverified" })).error?.data?.code).toBe("BAD_REQUEST")
  })

  it("交齐了结果、复核判办成 → 单办完，结果办成", async () => {
    useScript("test/out-d-ok", new Script([step([call("work.report", { data: { 价格: 12.5 } })]), step([finish("achieved", { summary: "价格 12.5" })])]))
    const worker = await dispatchedTask("test/out-d-ok", { dispatch: { results: [{ name: "价格", description: "", required: true }] } })
    const item = await ended(await dispatch(worker, "K-4"), "done")
    expect(item).toMatchObject({ failKind: null, outcome: "achieved", outcomeReason: "测试默认复核：办成" })
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
    // 复核中：运行已结束，结果先空着（页面上显示「复核中」）
    expect(pending.session).toMatchObject({ status: "done", outcome: null, outcomeReason: null })
    expect(pending.row.status).toBe("running")
    expect((await sweepWork(ctx.db)).settled).not.toContain(id)
    release()
    const item = await ended(id)
    expect(item).toMatchObject({ failKind: "not_done", outcome: "not_achieved", outcomeReason: "页面上没有回填的结果" })
  })

  it("清扫：复核过了时限还没回来（worker 中途没了）→ 清掉标记、结果记没办成、通知负责人，单没办成、不重试", async () => {
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
    expect(await itemRow(id)).toMatchObject({ status: "failed", failKind: "not_done", autoRetries: 0, outcome: "not_achieved", outcomeReason: REVIEW_EXPIRED_REASON })
    const session = (await sessionRow(ctx.db, sessionId))!
    expect(session).toMatchObject({ outcome: "not_achieved", outcomeBy: "review", outcomeReason: REVIEW_EXPIRED_REASON })
    expect(session.review?.pending).toBeUndefined()
    expect(session.review?.error).toContain("没有结果")
    expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "verify", title: "AI 复核超时没有结果，结果记没办成" })
    expect((await notesOf(sessionId)).map((note) => [note.title, note.body])).toEqual([["办一件事：没办成", REVIEW_EXPIRED_REASON]])
  })

  it("清扫补写：人取消的运行（结果是人定的）→ 单没办成（cancelled_run），配了重试也不重试", async () => {
    const worker = await dispatchedTask("test/none")
    await ctx.db.update(t.tasks).set({ enabled: false }).where(eq(t.tasks.id, worker))
    const n = Number((await ctx.db.execute<{ n: string }>(sql`select nextval('work_item_no_seq') as n`)).rows[0]!.n)
    const id = `W-${n}`
    await ctx.db.insert(t.workItems).values({ id, taskId: worker, key: "K-9", title: "K-9", params: { 单号: "K-9" }, status: "running", via: "human" })
    const sessionId = "R-out-sweep-3"
    const reason = "王悦取消了这次运行"
    await ctx.db.insert(t.sessions).values({ id: sessionId, taskId: worker, status: "failed", error: reason, outcome: "not_achieved", outcomeBy: "human", outcomeReason: reason, modelId: "test/none", triggeredBy: "dispatch", startedAt: new Date(), endedAt: new Date(), workItemId: id })
    await ctx.db.update(t.workItems).set({ sessionId }).where(eq(t.workItems.id, id))
    expect((await sweepWork(ctx.db)).settled).toContain(id)
    expect(await itemRow(id)).toMatchObject({ status: "failed", failKind: "cancelled_run", autoRetries: 0, notBefore: null, outcome: "not_achieved", error: reason })
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
  it("负责人、主管能改；别的员工不能；只有办成 / 没办成；没结束的不能改；记过程记录和审计", async () => {
    useScript("test/out-set", new Script([step([finish("achieved")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/out-set" })
    const sessionId = await runNow(taskId)
    await waitOutcome(sessionId)
    const input = { id: sessionId, outcome: "achieved", reason: "我看过了，表是对的" }
    expect((await mutate(ctx.app, "sessions.setOutcome", chen, input)).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "sessions.setOutcome", wang, { ...input, reason: " " })).error?.data?.code).toBe("BAD_REQUEST")
    expect((await mutate(ctx.app, "sessions.setOutcome", wang, input)).data).toEqual({ sessionId, outcome: "achieved" })
    expect(await sessionRow(ctx.db, sessionId)).toMatchObject({ status: "done", outcome: "achieved", outcomeBy: "human", outcomeReason: "我看过了，表是对的" })
    expect((await mutate(ctx.app, "sessions.setOutcome", lin, { ...input, outcome: "partial", reason: "其实少了一列" })).error?.data?.code).toBe("BAD_REQUEST")
    expect((await mutate(ctx.app, "sessions.setOutcome", lin, { ...input, outcome: "not_achieved", reason: "其实少了一列" })).data?.outcome).toBe("not_achieved")
    const events = (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "human")
    expect(events.map((event) => event.title)).toEqual([expect.stringContaining("把结果改成「办成」"), expect.stringContaining("把结果改成「没办成」")])
    expect(events[1]!.detail).toContain("原来是「办成」")
    const audits = await ctx.db.select().from(t.auditEvents).where(eq(t.auditEvents.targetId, sessionId))
    expect(audits.filter((row) => row.action === "session.set_outcome").length).toBe(2)
    expect((await mutate(ctx.app, "sessions.setOutcome", wang, { id: "R-nope", outcome: "achieved", reason: "x" })).error?.data?.code).toBe("NOT_FOUND")

    // 还没结束的不能改
    const running = "R-out-running-1"
    await ctx.db.insert(t.sessions).values({ id: running, taskId, status: "waiting", modelId: "test/none", triggeredBy: "manual", startedAt: new Date() })
    expect((await mutate(ctx.app, "sessions.setOutcome", wang, { ...input, id: running })).error?.data?.code).toBe("BAD_REQUEST")
    // 列表按结果筛
    const list = (await query(ctx.app, "sessions.list", wang, { taskId, outcome: ["not_achieved"] })).data
    expect(list.map((each: { id: string }) => each.id)).toEqual([sessionId])
  })

  it("出错、取消的运行也能改结果（例如取消前其实已经办成了）", async () => {
    const taskId = await createTask(ctx.db, { modelId: "test/none" })
    const cancelled = "R-out-cancelled-1"
    await ctx.db.insert(t.sessions).values({ id: cancelled, taskId, status: "failed", error: "王悦取消了这次运行", outcome: "not_achieved", outcomeBy: "human", outcomeReason: "王悦取消了这次运行", modelId: "test/none", triggeredBy: "manual", startedAt: new Date(), endedAt: new Date() })
    const res = await mutate(ctx.app, "sessions.setOutcome", wang, { id: cancelled, outcome: "achieved", reason: "取消前表已经存好了" })
    expect(res.data).toEqual({ sessionId: cancelled, outcome: "achieved" })
    expect(await sessionRow(ctx.db, cancelled)).toMatchObject({ status: "failed", outcome: "achieved", outcomeBy: "human", outcomeReason: "取消前表已经存好了" })
  })
})

/** 迁移文件里补数据的语句（UPDATE），去掉注释 */
const updatesIn = (file: string) =>
  readFileSync(new URL(`../drizzle/${file}`, import.meta.url), "utf8")
    .split("--> statement-breakpoint")
    .map((part) => part.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n").trim())
    .filter((part) => part.startsWith("UPDATE"))

describe("迁移 0024 + 0026 补旧数据", () => {
  it("每一行规则（在事务里灌样例、先跑 0024 再跑 0026 补数据的语句、回滚）", async () => {
    const statements = updatesIn("0024_run_outcome.sql")
    expect(statements.length).toBe(8)
    const simplify = updatesIn("0026_outcome_two_values.sql")
    expect(simplify.length).toBe(3)
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

      // 0026：部分办成、没核实都改成没办成，原因前面写上原来记的是什么；单的状态不改。没选复核模型的任务补默认复核模型
      await client.query(`insert into tasks (id, title, goal, steps, owner_id, model_id) values ('T-mig-1', '旧任务', '目标', '[]', 'u-wang', 'test/none')`)
      await client.query(`insert into tasks (id, title, goal, steps, owner_id, model_id, review_model_id) values ('T-mig-2', '选过的', '目标', '[]', 'u-wang', 'test/none', 'test/own')`)
      for (const statement of simplify) await client.query(statement)
      const after = Object.fromEntries(
        (await client.query<{ id: string; outcome: string; outcome_reason: string | null }>(`select id, outcome::text, outcome_reason from sessions where id like 'R-mig-%'`)).rows.map((row) => [row.id, row])
      )
      expect(after["R-mig-someskip"]).toMatchObject({ outcome: "not_achieved", outcome_reason: "原来记「部分办成」：1 个检查点跳过：检查点2" })
      expect(after["R-mig-alldone"]).toMatchObject({ outcome: "not_achieved", outcome_reason: "原来记「没核实」：旧运行，agent 说做完了，还没核实" })
      expect(after["R-mig-verified"]).toMatchObject({ outcome: "achieved", outcome_reason: "全部通过" })
      expect(after["R-mig-open"]).toMatchObject({ outcome: "not_achieved", outcome_reason: "1 个检查点没达成：检查点2" })
      const { rows: left } = await client.query(`select id from sessions where outcome::text in ('partial', 'unverified') union all select id from work_items where outcome::text in ('partial', 'unverified')`)
      expect(left).toEqual([])
      const items2 = Object.fromEntries(
        (await client.query<{ id: string; status: string; outcome: string | null; outcome_reason: string | null }>(`select id, status::text, outcome::text, outcome_reason from work_items where id like 'W-mig-%'`)).rows.map((row) => [row.id, row])
      )
      expect(items2["W-mig-1"]).toMatchObject({ status: "done", outcome: "not_achieved", outcome_reason: "原来记「没核实」：旧运行，agent 说做完了，还没核实" })
      expect(items2["W-mig-2"]).toMatchObject({ status: "failed", outcome: "not_achieved", outcome_reason: "后台没权限" })
      const tasks = Object.fromEntries((await client.query<{ id: string; review_model_id: string | null }>(`select id, review_model_id from tasks where id like 'T-mig-%'`)).rows.map((row) => [row.id, row.review_model_id]))
      expect(tasks).toEqual({ "T-mig-1": TEST_REVIEWER, "T-mig-2": "test/own" })
    } finally {
      await client.query("rollback").catch(() => undefined)
      await client.end()
    }
  })
})
