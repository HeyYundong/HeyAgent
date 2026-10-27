// 固化：引擎先跑脚本（docs/dev/solidify.md 6.3–6.6、15.2 第 5、6 条）。真的测试库 + 进程内 worker + 假模型；
// 沙箱换成「直接跑 node」的 runner（开发机没有 bwrap），SDK 和脚本照样走工具桥 → 工具网关。
// - 跑通：执行模型一次都没调，照常复核、记办成；
// - 跑不通：交给 agent，第一条交接的话对，agent 接着做完；
// - 要挂起：交接的话和挂起一起落库，继续后 agent 接着做；
// - ha.fail("input")：直接记没办成，不叫模型；输入不符合 inputSchema：交给 agent；
// - 固化试跑：只跑脚本，停在第一个 ha.commit 前，work.report 没生效，运行结束后发 routine.compile；
// - 进程中途被杀：继续时按中断交给 agent；
// - 试用满 3 次转正式；连续 3 次交给 agent 自动停用。
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { bossFor, QUEUES } from "../src/engine/queue.js"
import { configureEngine, runtime } from "../src/engine/runtime.js"
import { startSessionImpl, startSessionInTx } from "../src/engine/sessions.js"
import { setRoutineSandboxDeps } from "../src/routine/runtime/run.js"
import { login } from "./helpers.js"
import {
  bossJobs,
  createTask,
  eventsOf,
  finishWith,
  messagesOf,
  mutate,
  Script,
  sessionRow,
  setupEngine,
  step,
  useScript,
  waitFor,
  type EngineTestContext,
} from "./engine-helpers.js"
import { createRoutine, directNodeRunner, routineCode } from "./routine-helpers.js"

let ctx: EngineTestContext
let wang: string
const sandboxDir = mkdtempSync(join(tmpdir(), "heyagent-routine-it-"))
let modelCounter = 0

beforeAll(async () => {
  ctx = await setupEngine()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  configureEngine({ sandbox: { ...runtime.sandbox, dir: sandboxDir } })
  setRoutineSandboxDeps({ runner: directNodeRunner, unavailable: async () => undefined })
  // routine.compile 的队列由固化那边（B 包）在 worker 里建；这里只测引擎发出去了，先建好队列
  await (await bossFor(ctx.db)).createQueue(QUEUES.routineCompile, { policy: "stately" })
}, 120_000)

afterAll(async () => {
  setRoutineSandboxDeps(undefined)
  await ctx?.stop()
  await rm(sandboxDir, { recursive: true, force: true })
})

/** 一个带固化流程的任务和它的假模型 */
async function routineTask(body: string, options: { turns?: ConstructorParameters<typeof Script>[0]; status?: "trial" | "active"; inputSchema?: Record<string, unknown> } = {}) {
  const modelId = `test/routine-${++modelCounter}`
  const script = useScript(modelId, new Script(options.turns ?? []))
  const taskId = await createTask(ctx.db, { modelId, toolIds: ["file.save", "file.read"] })
  const routine = await createRoutine(ctx.db, taskId, { code: routineCode(body), name: "存单号", status: options.status, inputSchema: options.inputSchema })
  return { taskId, script, ...routine }
}

async function runNow(taskId: string, note?: string) {
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId, ...(note ? { note } : {}) })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  return res.data.sessionId as string
}

/** 等运行结束而且结果定了（复核完） */
async function waitOutcome(sessionId: string, timeout = 30_000) {
  return waitFor(
    async () => {
      const row = await sessionRow(ctx.db, sessionId)
      return row && ["done", "failed"].includes(row.status) && row.outcome ? row : undefined
    },
    { timeout, what: `${sessionId} 结束、结果定了` }
  )
}

const firstPromptText = (script: Script) => script.promptText(0)

/** 固化流程的成绩在收尾的最后一步才记：等它记上 */
async function routineWhen(routineId: string, ok: (row: typeof t.routines.$inferSelect) => boolean) {
  return waitFor(async () => {
    const [row] = await ctx.db.select().from(t.routines).where(eq(t.routines.id, routineId))
    return row && ok(row) ? row : undefined
  }, { what: `${routineId} 的成绩记上` })
}

const SAVE_AND_FINISH = `
  await ha.file.save({ path: "out/单号.txt", content: String(input.$note ?? "无") })
  const back = await ha.file.read({ path: "out/单号.txt" })
  await ha.log("读回来了")
  return ha.finish({ outcome: "achieved", summary: "存好了 " + input.$note, evidence: back })`

describe("普通运行先跑脚本", () => {
  it("跑通：执行模型一次都没调，步数是 0；照常复核、记办成；每步有 trace.routineStep；连着直接办成 +1", async () => {
    const { taskId, script, routineId } = await routineTask(SAVE_AND_FINISH)
    const sessionId = await runNow(taskId, "A-100")
    const row = await waitOutcome(sessionId)
    expect(row.status).toBe("done")
    expect(row.outcome).toBe("achieved")
    expect(row.stepCount).toBe(0)
    expect(script.prompts).toHaveLength(0)
    expect(row.review?.modelId).toBeTruthy()
    expect(row.routine).toMatchObject({ routineId, version: 1, mode: "run", state: "finished", steps: 3, commits: [], logs: ["读回来了"], input: { $note: "A-100" } })
    expect(row.routine?.endedAt).toBeTruthy()
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.filter((event) => event.kind === "tool").map((event) => [event.toolId, event.trace?.routineStep])).toEqual([
      ["file.save", 1],
      ["file.read", 2],
      ["run.finish", 3],
    ])
    expect(events.some((event) => event.title.startsWith("按固化流程「存单号」第 1 版跑"))).toBe(true)
    const [file] = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.path, "out/单号.txt")))
    expect(file).toBeTruthy()
    const routine = await routineWhen(routineId, (row) => row.directStreak === 1)
    expect(routine).toMatchObject({ directStreak: 1, fallbackStreak: 0, status: "trial" })
    // 试用期：每次都通知负责人
    await waitFor(async () => {
      const notes = await ctx.db.select().from(t.notifications).where(eq(t.notifications.sessionId, sessionId))
      return notes.some((note) => note.title.includes("试用中的一次运行") && note.body.includes("脚本直接办成"))
    }, { what: "试用期的通知" })
  })

  it("跑不通：交给 agent，第一条交接的话写清楚每步、停在哪、会改东西的没做；agent 接着做完；连着交给 agent +1", async () => {
    const { taskId, script, routineId } = await routineTask(
      `
  await ha.file.save({ path: "out/a.txt", content: "a" })
  await ha.commit("存第二个文件")
  await ha.file.read({ path: "没有这个.txt" })
  return ha.finish({ outcome: "achieved", summary: "不该到这里", evidence: "-" })`,
      { turns: [step(finishWith("接着做完了"))] }
    )
    const sessionId = await runNow(taskId, "A-200")
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(1)
    expect(row.stepCount).toBe(1)
    expect(row.routine).toMatchObject({ state: "fell_back", steps: 2, stoppedAt: { step: 2, kind: "step_error", tool: "file.read" }, commits: [{ step: 1, label: "存第二个文件" }] })
    const prompt = firstPromptText(script)
    expect(prompt).toContain("这次运行先按固化流程「存单号」第 1 版跑了，做到第 2 步停下（这一步出错）")
    expect(prompt).toContain("1. file.save「out/a.txt」 ✓")
    expect(prompt).toContain("2. ✗ file.read「没有这个.txt」：空间里没有 没有这个.txt")
    expect(prompt).toContain("第 2 步「存第二个文件」已经做了，可能已经生效")
    expect(prompt).toContain("请从现在的页面接着把任务办完，前面做过的不要重复。")
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.some((event) => event.title.startsWith("交给 agent 接着做（固化流程停在第 2 步"))).toBe(true)
    const routine = await routineWhen(routineId, (row) => row.fallbackStreak === 1)
    expect(routine).toMatchObject({ directStreak: 0, fallbackStreak: 1, status: "trial" })
  })

  it("要挂起：交接的话和挂起一起落库，继续后 agent 接着做（看得到交接的话）", async () => {
    const { taskId, script } = await routineTask(
      `
  await ha.file.save({ path: "out/a.txt", content: "a" })
  await ha.tool("session.wait", { what: "等一会儿", afterMinutes: 0.05 })
  return ha.finish({ outcome: "achieved", summary: "不该到这里", evidence: "-" })`,
      { turns: [step(finishWith("等完了，接着做完了"))] }
    )
    const sessionId = await runNow(taskId)
    await waitFor(async () => (await sessionRow(ctx.db, sessionId))?.status === "waiting", { what: "挂起" })
    const messages = await messagesOf(ctx.db, sessionId)
    expect(JSON.stringify(messages.at(-1)?.content)).toContain("做到第 2 步要先挂起等待")
    const row = await waitOutcome(sessionId, 40_000)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(1)
    expect(firstPromptText(script)).toContain("做到第 2 步要先挂起等待")
    expect(row.routine).toMatchObject({ state: "fell_back", stoppedAt: { step: 2, kind: "suspend" } })
  })

  it("ha.fail(\"input\")：直接按没办成收尾，不叫模型、不交 agent", async () => {
    const { taskId, script, routineId } = await routineTask(`
  if (!input.单号) await ha.fail("input", "没有给单号")
  return ha.finish({ outcome: "achieved", summary: "不该到这里", evidence: "-" })`)
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("not_achieved")
    expect(row.outcomeReason).toContain("没有给单号")
    expect(script.prompts).toHaveLength(0)
    expect(row.routine).toMatchObject({ state: "stopped", stoppedAt: { kind: "input", reason: "没有给单号" } })
    const [routine] = await ctx.db.select().from(t.routines).where(eq(t.routines.id, routineId))
    expect(routine).toMatchObject({ directStreak: 0, fallbackStreak: 0 })
  })

  it("输入不符合 inputSchema：脚本不跑，交给 agent，说明哪个参数不对", async () => {
    const { taskId, script } = await routineTask(SAVE_AND_FINISH, {
      inputSchema: { type: "object", properties: { 单号: { type: "string", minLength: 1 } }, required: ["单号"] },
      turns: [step(finishWith("自己办完了"))],
    })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(row.routine).toMatchObject({ state: "fell_back", steps: 0, stoppedAt: { step: 0, kind: "bad_input" } })
    const prompt = firstPromptText(script)
    expect(prompt).toContain("没有跑：输入不符合固化流程的要求：单号")
    expect(prompt).toContain("请按任务目标自己把事情办完。")
    expect((await eventsOf(ctx.db, sessionId)).some((event) => event.toolId === "file.save")).toBe(false)
  })

  it("进程中途被杀：继续时 sessions.routine 还是 running，按中断交给 agent，写「不确定第 n 步做没做」", async () => {
    const { taskId, script, routineId, versionId } = await routineTask(SAVE_AND_FINISH, { turns: [step(finishWith("核对过，接着做完了"))] })
    const sessionId = await ctx.db.transaction(async (tx) => {
      const { sessionId: id } = await startSessionInTx(ctx.db, tx, { taskId, source: "manual", actorId: "u-wang" })
      await tx
        .update(t.sessions)
        .set({ routine: { routineId, versionId, version: 1, mode: "run", state: "running", startedAt: new Date().toISOString(), steps: 1, commits: [] } })
        .where(eq(t.sessions.id, id))
      return id
    })
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(row.routine).toMatchObject({ state: "fell_back", stoppedAt: { step: 1, kind: "interrupted" } })
    expect(firstPromptText(script)).toContain("跑到第 1 步时 worker 重启了，脚本中断，不确定第 1 步做没做完")
    // 没有重跑脚本
    expect((await eventsOf(ctx.db, sessionId)).some((event) => event.toolId === "file.save")).toBe(false)
  })
})

describe("试用、正式、停用", () => {
  it("试用期连着 3 次脚本直接办成，转正式、通知负责人", async () => {
    const { taskId, routineId } = await routineTask(SAVE_AND_FINISH)
    for (let index = 0; index < 3; index++) await waitOutcome(await runNow(taskId, `B-${index}`))
    // 结果定了以后才记试用的成绩（收尾的最后一步）
    const routine = await waitFor(async () => {
      const [row] = await ctx.db.select().from(t.routines).where(eq(t.routines.id, routineId))
      return row?.directStreak === 3 ? row : undefined
    }, { what: "第 3 次记上" })
    expect(routine).toMatchObject({ status: "active", directStreak: 3, fallbackStreak: 0 })
    await waitFor(async () => (await ctx.db.select().from(t.notifications).where(eq(t.notifications.taskId, taskId))).some((note) => note.title.includes("转正式")), { what: "转正式的通知" })
    const audits = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.action, "routine.promote"), eq(t.auditEvents.targetId, routineId)))
    expect(audits).toHaveLength(1)
  })

  it("连续 3 次交给 agent，自动停用、写清楚原因；之后的运行只用 agent", async () => {
    const turns = Array.from({ length: 4 }, () => step(finishWith("agent 做完了")))
    const { taskId, routineId, script } = await routineTask(`await ha.file.read({ path: "没有这个.txt" })`, { status: "active", turns })
    for (let index = 0; index < 3; index++) await waitOutcome(await runNow(taskId))
    const routine = await waitFor(async () => {
      const [row] = await ctx.db.select().from(t.routines).where(eq(t.routines.id, routineId))
      return row?.fallbackStreak === 3 ? row : undefined
    }, { what: "第 3 次记上" })
    expect(routine).toMatchObject({ status: "paused", fallbackStreak: 3, directStreak: 0 })
    expect(routine!.pausedReason).toContain("连续 3 次跑不通")
    await waitFor(async () => (await ctx.db.select().from(t.notifications).where(eq(t.notifications.taskId, taskId))).some((note) => note.title.includes("自动停用")), { what: "自动停用的通知" })
    // 停用以后：快照里没有固化流程，直接 agent
    const fourth = await runNow(taskId)
    const row = await waitOutcome(fourth)
    expect(row.routine).toBeNull()
    expect(row.snapshot?.routine).toBeUndefined()
    expect(script.prompts).toHaveLength(4)
  })
})

describe("固化试跑", () => {
  it("只跑脚本，走到第一个 ha.commit 就停；work.report / checkpoint.mark 只记下来；运行结束、结果留空、不复核，发 routine.compile", async () => {
    const modelId = `test/routine-${++modelCounter}`
    const script = useScript(modelId, new Script([]))
    const taskId = await createTask(ctx.db, { modelId, toolIds: ["file.save", "file.read"], steps: [{ id: "s1", text: "查到状态", wait: false, checkpoint: "查到状态" }] })
    const { versionId } = await createRoutine(ctx.db, taskId, {
      versionStatus: "testing",
      code: routineCode(`
  await ha.file.save({ path: "test.txt", content: String(input.单号) })
  await ha.work.report({ data: { 状态: "已发货" } })
  await ha.checkpoint.mark({ checkpoint: 1, status: "done", record: "查到了" })
  await ha.commit("保存第 1 个")
  await ha.file.save({ path: "after-commit.txt", content: "不该存" })
  return ha.finish({ outcome: "achieved", summary: "不该到这里", evidence: "-" })`),
    })
    const { sessionId } = await startSessionImpl(ctx.db, { taskId, source: "manual", actorId: "u-wang", routineTest: { versionId, round: 1, input: { 单号: "A-1" }, attachments: [] } })
    expect(sessionId).toBe(`${versionId}-t1`)
    const row = await waitFor(async () => {
      const current = await sessionRow(ctx.db, sessionId)
      return current?.status === "done" ? current : undefined
    }, { what: "试跑结束" })
    expect(row.kind).toBe("routine_test")
    expect(row.outcome).toBeNull()
    expect(row.review).toBeNull()
    expect(script.prompts).toHaveLength(0)
    expect(row.routine).toMatchObject({
      mode: "test",
      state: "stopped",
      steps: 3,
      input: { 单号: "A-1" },
      stoppedAt: { step: 3, kind: "test_commit", label: "保存第 1 个" },
      recorded: { report: { 状态: "已发货" }, checkpoints: [{ checkpoint: 1, status: "done", record: "查到了" }] },
    })
    const events = await eventsOf(ctx.db, sessionId)
    // work.report、checkpoint.mark 没真调
    expect(events.filter((event) => event.kind === "tool").map((event) => event.toolId)).toEqual(["file.save"])
    const checkpoints = await ctx.db.select().from(t.checkpoints).where(eq(t.checkpoints.sessionId, sessionId))
    expect(checkpoints.map((each) => each.status)).toEqual(["open"])
    const files = await ctx.db.select({ path: t.files.path }).from(t.files).where(eq(t.files.sessionId, sessionId))
    expect(files.map((file) => file.path)).toEqual(["test.txt"])
    expect(events.at(-1)).toMatchObject({ kind: "done", title: "固化试跑结束" })
    const jobs = await bossJobs(ctx.db, "routine.compile")
    expect(jobs.some((job) => job.data.versionId === versionId)).toBe(true)
  })

  /** 开一次固化试跑（任务只有文件工具） */
  async function startTest(body: string) {
    const modelId = `test/routine-${++modelCounter}`
    useScript(modelId, new Script([]))
    const taskId = await createTask(ctx.db, { modelId, toolIds: ["file.save", "file.read"] })
    const { versionId } = await createRoutine(ctx.db, taskId, { versionStatus: "testing", code: routineCode(body) })
    const { sessionId } = await startSessionImpl(ctx.db, { taskId, source: "manual", actorId: "u-wang", routineTest: { versionId, round: 1, input: {}, attachments: [] } })
    return { versionId, sessionId }
  }
  const compileSent = async (versionId: string) => (await bossJobs(ctx.db, "routine.compile")).filter((job) => job.data.versionId === versionId).length

  it("脚本出错：试跑照样结束，脚本状态记停下（这一步出错），发 routine.compile", async () => {
    const { versionId, sessionId } = await startTest(`await ha.file.read({ path: "没有这个.txt" })`)
    const row = await waitFor(async () => {
      const current = await sessionRow(ctx.db, sessionId)
      return current?.status === "done" ? current : undefined
    }, { what: "试跑结束" })
    expect(row.routine).toMatchObject({ state: "stopped", stoppedAt: { step: 1, kind: "step_error", tool: "file.read" } })
    expect(await compileSent(versionId)).toBeGreaterThan(0)
  })

  it("跑着的时候被取消（engine.cancel 不经过 runSession）：脚本状态记停下（取消），发 routine.compile；脚本下一次调用前也停", async () => {
    const { versionId, sessionId } = await startTest(`for (let i = 0; i < 500; i++) await ha.file.save({ path: "n.txt", content: String(i) })`)
    await waitFor(async () => ((await sessionRow(ctx.db, sessionId))?.routine?.steps ?? 0) >= 2, { what: "脚本跑起来" })
    const res = await mutate(ctx.app, "engine.cancel", wang, { sessionId })
    expect(res.error).toBeUndefined()
    const row = await waitFor(async () => {
      const current = await sessionRow(ctx.db, sessionId)
      return current?.routine?.endedAt && current.routine.state === "stopped" && current.routine.steps < 500 ? current : undefined
    }, { what: "脚本停下" })
    expect(row.status).toBe("failed")
    expect(row.routine?.stoppedAt?.kind).toBe("cancelled")
    expect(await compileSent(versionId)).toBeGreaterThan(0)
  })
})
