// 任务的交付物（docs/dev/task-structure.md）：schema 默认空、校验；tasks.create / update / get 来回一致，以前的任务是空的；
// 运行快照冻进交付物，执行 agent 的系统提示有「要交付的东西」，复核的输入逐项列出；子运行不带父任务的交付物。
// 真实的测试库 + 进程内 worker + 假模型（同 run-outcome.test.ts）。
import { deriveSubSnapshot, taskInputSchema, type SessionSnapshot } from "@heyagent/shared"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { buildSystemPrompt } from "../src/engine/prompt.js"
import { login, query } from "./helpers.js"
import {
  createTask,
  finishWith,
  mutate,
  resetTestReviewer,
  reviewVerdict,
  Script,
  sessionRow,
  setupEngine,
  step,
  TEST_REVIEWER,
  useScript,
  waitFor,
  type EngineTestContext,
} from "./engine-helpers.js"

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

const DELIVERABLES = [
  { name: "汇总表.xlsx", description: "每行一家：名称、单价、链接" },
  { name: "一句结论", description: "" },
]

describe("单元：schema 和系统提示", () => {
  it("不传交付物 = 空；名字去掉首尾空白；空名字、超过 20 项被拒", () => {
    const base = { title: "任务", goal: "目标", steps: [], schedule: null, reviewModelId: "m" }
    expect(taskInputSchema.parse(base).deliverables).toEqual([])
    expect(taskInputSchema.parse({ ...base, deliverables: [{ name: "  表 ", description: "说明" }] }).deliverables).toEqual([{ name: "表", description: "说明" }])
    expect(taskInputSchema.safeParse({ ...base, deliverables: [{ name: " ", description: "" }] }).success).toBe(false)
    expect(taskInputSchema.safeParse({ ...base, deliverables: Array.from({ length: 21 }, (_, i) => ({ name: `第 ${i} 项`, description: "" })) }).success).toBe(false)
  })

  it("系统提示：有交付物时列「要交付的东西」、要求总结逐项写在哪；没有就不写", () => {
    const withList = buildSystemPrompt(baseSnapshot({ task: { ...baseSnapshot().task, deliverables: DELIVERABLES } }), new Map())
    expect(withList).toContain("## 要交付的东西")
    expect(withList).toContain("- 汇总表.xlsx：每行一家：名称、单价、链接\n- 一句结论\n")
    expect(withList).toContain("最后的总结里逐项写明每一样在哪")
    expect(withList).toContain("结束前对照「要交付的东西」逐项检查")
    const without = buildSystemPrompt(baseSnapshot(), new Map())
    expect(without).not.toContain("要交付的东西")
  })

  it("子运行不带父任务的交付物", () => {
    const parent = baseSnapshot({ task: { ...baseSnapshot().task, deliverables: DELIVERABLES } })
    const tool = (id: string) => ({ id, name: id, summary: "", description: "", source: "builtin" as const, risk: "read" as const })
    const sub = deriveSubSnapshot(parent, { parentSessionId: "R-1", n: 1, item: { title: "子", goal: "子目标" }, files: [], builtinTool: tool })
    expect(sub.task.deliverables).toBeUndefined()
    expect(sub.task.goal).toBe("目标一")
    expect(buildSystemPrompt(sub, new Map())).not.toContain("要交付的东西")
  })
})

let ctx: EngineTestContext
let lin: string
let wang: string

beforeAll(async () => {
  ctx = await setupEngine()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
}, 120_000)

afterAll(async () => {
  await ctx?.stop()
})

describe("接口：新建、修改、读", () => {
  it("新建带交付物，读回来一样；改成空的就空；以前建的任务是空数组", async () => {
    const created = await mutate(ctx.app, "tasks.create", lin, { title: "整理报价", goal: "报价整理好", steps: [], schedule: null, reviewModelId: TEST_REVIEWER, deliverables: DELIVERABLES })
    expect(created.error).toBeUndefined()
    const id = (created.data as { id: string }).id
    const got = await query(ctx.app, "tasks.get", lin, { id })
    expect((got.data as { deliverables: unknown }).deliverables).toEqual(DELIVERABLES)
    const [row] = await ctx.db.select({ deliverables: t.tasks.deliverables }).from(t.tasks).where(eq(t.tasks.id, id))
    expect(row!.deliverables).toEqual(DELIVERABLES)

    const task = got.data as Record<string, unknown>
    const updated = await mutate(ctx.app, "tasks.update", lin, { id, title: task.title, goal: task.goal, steps: [], schedule: null, reviewModelId: TEST_REVIEWER, deliverables: [] })
    expect(updated.error).toBeUndefined()
    expect(((await query(ctx.app, "tasks.get", lin, { id })).data as { deliverables: unknown }).deliverables).toEqual([])

    // 迁移以前建的任务（库里用默认值）：空数组
    const old = await createTask(ctx.db, { modelId: "test/deliv-old" })
    expect(((await query(ctx.app, "tasks.get", wang, { id: old })).data as { deliverables: unknown }).deliverables).toEqual([])
  })
})

describe("运行：快照、系统提示、复核", () => {
  afterAll(async () => {
    await resetTestReviewer(ctx.db)
  })

  it("快照冻进交付物；执行 agent 的系统提示和复核的输入都逐项列出", async () => {
    const reviewer = useScript(TEST_REVIEWER, new Script([reviewVerdict("achieved", "两样都交了")]))
    const runner = useScript("test/deliv-run", new Script([step(finishWith("汇总表.xlsx 在 out/ 下，结论写在总结第一段"))]))
    const taskId = await createTask(ctx.db, { modelId: "test/deliv-run", goal: "整理报价" })
    await ctx.db.update(t.tasks).set({ deliverables: DELIVERABLES }).where(eq(t.tasks.id, taskId))
    const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
    const sessionId = (res.data as { sessionId: string }).sessionId
    const row = await waitFor(
      async () => {
        const each = await sessionRow(ctx.db, sessionId)
        return each?.outcome && !each.review?.pending ? each : undefined
      },
      { what: `${sessionId} 的结果` }
    )
    expect(row.snapshot!.task.deliverables).toEqual(DELIVERABLES)
    expect(runner.promptText(0)).toContain("## 要交付的东西")
    expect(runner.promptText(0)).toContain("汇总表.xlsx：每行一家：名称、单价、链接")
    expect(reviewer.promptText(0)).toContain("## 要交付的东西")
    expect(reviewer.promptText(0)).toContain("- 一句结论")
    expect(JSON.stringify(reviewer.prompts[0]?.prompt)).toContain("缺一项、或者只在报告里说了、证据里找不到，判 not_achieved")
    expect(row).toMatchObject({ outcome: "achieved", review: { verdict: "achieved" } })
  })
})
