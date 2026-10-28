// 固化：引擎先跑脚本（docs/dev/solidify.md 6.3–6.6、15.2 第 5、6 条）。真的测试库 + 进程内 worker + 假模型；
// 沙箱换成「直接跑 node」的 runner（开发机没有 bwrap），SDK 和脚本照样走工具桥 → 工具网关。
// - 跑通：执行模型一次都没调，照常复核、记办成；
// - 跑不通：交给 agent，第一条交接的话对，agent 接着做完；
// - 要挂起：照常挂起、不交 agent，等到了按日志接着跑完（docs/dev/solidify.md 17.2）；
// - ha.fail("input")：直接记没办成，不叫模型；输入不符合 inputSchema：交给 agent；
// - 固化试跑：只跑脚本，停在第一个 ha.commit 前，work.report 没生效，运行结束后发 routine.compile；
// - 接着跑：进程中途被杀（提交前重做、提交后交给 agent）、对不上、浏览器没了、审批批准 / 拒绝、验收反问后 agent 接着做；
// - 试用满 3 次转正式；连续 3 次交给 agent 自动停用；清扫补发 routine.compile。
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describeCompiledRule, type CompiledRule } from "@heyagent/shared"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { bossFor, QUEUES } from "../src/engine/queue.js"
import { configureEngine, runtime } from "../src/engine/runtime.js"
import { startSessionImpl, startSessionInTx } from "../src/engine/sessions.js"
import { journalHash } from "../src/routine/runtime/bridge.js"
import { setRoutineSandboxDeps } from "../src/routine/runtime/run.js"
import { sweepRoutines } from "../src/routine/sweep.js"
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
  text,
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

  it("要挂起：照常挂起、不写交接的话（state = suspended）；等到了按日志接着跑完，执行模型一次都没调", async () => {
    const { taskId, script } = await routineTask(`
  await ha.file.save({ path: "out/a.txt", content: "a" })
  await ha.tool("session.wait", { what: "等一会儿", afterMinutes: 0.05 })
  const back = await ha.file.read({ path: "out/a.txt" })
  return ha.finish({ outcome: "achieved", summary: "等完了，读回来 " + back, evidence: "读回来了" })`)
    const sessionId = await runNow(taskId)
    const waiting = await waitFor(async () => {
      const row = await sessionRow(ctx.db, sessionId)
      return row?.status === "waiting" ? row : undefined
    }, { what: "挂起" })
    expect(waiting.routine).toMatchObject({ state: "suspended", steps: 2, stoppedAt: { step: 2, kind: "suspend", tool: "session.wait" } })
    // 没有交接的话
    expect(JSON.stringify(await messagesOf(ctx.db, sessionId))).not.toContain("这次运行先按固化流程")
    const journal = await ctx.db.select().from(t.routineJournal).where(eq(t.routineJournal.sessionId, sessionId)).orderBy(t.routineJournal.seq)
    expect(journal.map((row) => [row.seq, row.op, row.tool, row.stop, row.reply === null])).toEqual([
      [1, "tool", "file.save", null, false],
      [2, "tool", "session.wait", "suspend", false],
    ])
    const row = await waitOutcome(sessionId, 40_000)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(0)
    expect(row.stepCount).toBe(0)
    expect(row.routine).toMatchObject({ state: "finished", steps: 4, resumes: 1, replayed: 2 })
    expect(row.routine?.stoppedAt).toBeUndefined()
    const events = await eventsOf(ctx.db, sessionId)
    // 前两步按记录跳过：file.save 只真做了一次
    expect(events.filter((event) => event.kind === "tool").map((event) => [event.toolId, event.trace?.routineStep])).toEqual([
      ["file.save", 1],
      ["session.wait", 2],
      ["file.read", 3],
      ["run.finish", 4],
    ])
    expect(events.some((event) => event.title === "脚本接着跑：前 2 步按记录跳过，从第 3 步接着做")).toBe(true)
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

})

/** 一行重放日志（参数按 SDK 发的样子算 hash） */
const journalRow = (seq: number, op: "tool" | "commit" | "verified" | "log" | "now", payload: unknown, extra: { tool?: string; reply?: Record<string, unknown> | null; stop?: string; instanceId?: string } = {}) => ({
  seq,
  op,
  tool: extra.tool ?? null,
  inputHash: journalHash(payload),
  reply: extra.reply === undefined ? { ok: true } : extra.reply,
  stop: extra.stop ?? null,
  instanceId: extra.instanceId ?? null,
})

/**
 * 模拟进程中途被杀：开一次运行，同一个事务里写上「脚本跑到一半」的状态（state = running）和重放日志，
 * 提交后引擎进来按日志接着跑
 */
async function interruptedRun(taskId: string, routine: { routineId: string; versionId: string }, steps: number, rows: ReturnType<typeof journalRow>[], commits: { step: number; label: string }[] = []) {
  return ctx.db.transaction(async (tx) => {
    const { sessionId: id } = await startSessionInTx(ctx.db, tx, { taskId, source: "manual", actorId: "u-wang" })
    await tx
      .update(t.sessions)
      .set({ routine: { routineId: routine.routineId, versionId: routine.versionId, version: 1, mode: "run", state: "running", startedAt: new Date().toISOString(), steps, commits, input: {} } })
      .where(eq(t.sessions.id, id))
    if (rows.length) await tx.insert(t.routineJournal).values(rows.map((row) => ({ sessionId: id, ...row })))
    return id
  })
}

const scriptToolEvents = async (sessionId: string) =>
  (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "tool" && event.trace?.routineStep).map((event) => [event.toolId, event.trace?.routineStep])

let ruleCounter = 0
async function addRule(taskId: string, shape: Pick<CompiledRule, "trigger" | "actions">, name: string) {
  const id = `rl-routine-${++ruleCounter}`
  const compiled: CompiledRule = { v: 1, ...shape, understood: describeCompiledRule(shape) }
  await ctx.db.insert(t.rules).values({ id, name, trigger: "测试", action: "测试", compiledTrigger: compiled, compiledText: JSON.stringify({ trigger: "测试", action: "测试" }), confirmedById: "u-lin", confirmedAt: new Date() })
  const position = (await ctx.db.select().from(t.taskRules).where(eq(t.taskRules.taskId, taskId))).length
  await ctx.db.insert(t.taskRules).values({ taskId, refId: id, position })
  return id
}

describe("接着跑（重放日志）", () => {
  const NOW = "2026-01-02T03:04:05.000+08:00"
  const STAMP = `
  await ha.log("开始")
  const now = await ha.now()
  await ha.file.save({ path: "out/时间.txt", content: now })
  const back = await ha.file.read({ path: "out/时间.txt" })
  return ha.finish({ outcome: "achieved", summary: "存了 " + now, evidence: String(back) })`

  it("进程中途被杀、前面没有提交：按日志跳过（ha.now 回记下的时间），做到一半的那一步重做，接着跑完；执行模型没调", async () => {
    const { taskId, script, ...routine } = await routineTask(STAMP)
    const sessionId = await interruptedRun(taskId, routine, 1, [
      journalRow(1, "log", "开始"),
      journalRow(2, "now", "", { reply: { ok: true, data: NOW } }),
      journalRow(3, "tool", { path: "out/时间.txt", content: NOW }, { tool: "file.save", reply: null }),
    ])
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(0)
    expect(row.routine).toMatchObject({ state: "finished", steps: 3, resumes: 1, replayed: 0, logs: ["开始"] })
    // 用的是记下的时间
    expect(row.routine?.stoppedAt).toBeUndefined()
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.find((event) => event.toolId === "run.finish")?.input).toContain(NOW)
    expect(await scriptToolEvents(sessionId)).toEqual([
      ["file.save", 1],
      ["file.read", 2],
      ["run.finish", 3],
    ])
    expect(events.some((event) => event.title === "脚本接着跑：从第 1 步接着做")).toBe(true)
    // 跳过的 ha.log 不再记过程
    expect(events.some((event) => event.title === "流程记录：开始")).toBe(false)
    // 日志补上了这次的结果
    const journal = await ctx.db.select().from(t.routineJournal).where(eq(t.routineJournal.sessionId, sessionId)).orderBy(t.routineJournal.seq)
    expect(journal.map((each) => [each.seq, each.tool, each.reply?.ok])).toEqual([
      [1, null, true],
      [2, null, true],
      [3, "file.save", true],
      [4, "file.read", true],
      [5, "run.finish", true],
    ])
  })

  it("进程中途被杀、前面有没核对的 ha.commit：不重做，交给 agent，写「可能已经生效」", async () => {
    const { taskId, script, ...routine } = await routineTask(
      `
  await ha.file.save({ path: "out/a.txt", content: "a" })
  await ha.commit("保存第 2 个")
  await ha.file.save({ path: "out/b.txt", content: "b" })
  await ha.verified("存好了")
  return ha.finish({ outcome: "achieved", summary: "存好了", evidence: "-" })`,
      { turns: [step(finishWith("核对过，b 已经存了"))] }
    )
    const sessionId = await interruptedRun(
      taskId,
      routine,
      2,
      [
        journalRow(1, "tool", { path: "out/a.txt", content: "a" }, { tool: "file.save", reply: { ok: true, text: "存好了" } }),
        journalRow(2, "commit", "保存第 2 个"),
        journalRow(3, "tool", { path: "out/b.txt", content: "b" }, { tool: "file.save", reply: null }),
      ],
      [{ step: 1, label: "保存第 2 个" }]
    )
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(1)
    expect(row.routine).toMatchObject({ state: "fell_back", steps: 2, resumes: 1, replayed: 1, stoppedAt: { step: 2, kind: "interrupted", tool: "file.save" }, commits: [{ step: 1, label: "保存第 2 个" }] })
    const prompt = firstPromptText(script)
    expect(prompt).toContain("跑到第 2 步时 worker 重启了，脚本中断，不确定第 2 步做没做完（过了提交点「保存第 2 个」还没核对")
    expect(prompt).toContain("第 2 步「保存第 2 个」已经做了，可能已经生效")
    // 脚本一步都没真做
    expect(await scriptToolEvents(sessionId)).toEqual([])
  })

  it("对不上：日志里第 1 步的参数和这次不一样，停下（replay_mismatch）交给 agent，不真做", async () => {
    const { taskId, script, ...routine } = await routineTask(SAVE_AND_FINISH, { turns: [step(finishWith("自己做完了"))] })
    const sessionId = await interruptedRun(taskId, routine, 1, [journalRow(1, "tool", { path: "out/单号.txt", content: "上次的" }, { tool: "file.save", reply: { ok: true, text: "存好了" } })])
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(row.routine).toMatchObject({ state: "fell_back", stoppedAt: { step: 1, kind: "replay_mismatch", tool: "file.save" } })
    expect(row.routine?.stoppedAt?.reason).toContain("第 1 个请求（调 file.save）的参数和上次不一样")
    expect(firstPromptText(script)).toContain("接着跑时按记录重放到第 1 步对不上")
    expect(await scriptToolEvents(sessionId)).toEqual([])
  })

  it("浏览器没了：日志里有浏览器动作，这次运行的 Chrome 已经不在了 → 不重放，交给 agent（resume_lost）", async () => {
    const { taskId, script, ...routine } = await routineTask(SAVE_AND_FINISH, { turns: [step(finishWith("重新打开网页做完了"))] })
    const sessionId = await interruptedRun(taskId, routine, 1, [journalRow(1, "tool", { url: "https://a.example.com" }, { tool: "browser.navigate", reply: { ok: true, text: "打开了" }, instanceId: "B-gone" })])
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(row.routine).toMatchObject({ state: "fell_back", steps: 1, stoppedAt: { step: 1, kind: "resume_lost" } })
    const prompt = firstPromptText(script)
    expect(prompt).toContain("Chrome 已经关了")
    expect(prompt).toContain("请先重新打开要用的网页")
    expect(await scriptToolEvents(sessionId)).toEqual([])
  })

  const PAY = `
  await ha.log("准备付款")
  try {
    await ha.file.read({ path: "上次的付款.txt" })
  } catch (error) {
    await ha.log("没有上次的记录")
  }
  await ha.file.save({ path: "out/付款.txt", content: "100 元" })
  return ha.finish({ outcome: "achieved", summary: "付好了", evidence: "存了 out/付款.txt" })`

  async function approvalRun(turns: ConstructorParameters<typeof Script>[0] = []) {
    const made = await routineTask(PAY, { turns })
    const ruleId = await addRule(made.taskId, { trigger: { type: "before_tool", toolIds: ["file.save"], risks: [] }, actions: [{ type: "ask_human", recipient: { to: "owner" } }] }, "存文件要批")
    const sessionId = await runNow(made.taskId)
    const waiting = await waitFor(async () => {
      const row = await sessionRow(ctx.db, sessionId)
      return row?.status === "needs_human" ? row : undefined
    }, { what: "等审批" })
    const [item] = await ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open")))
    return { ...made, ruleId, sessionId, waiting, item: item! }
  }

  it("要人审批：生成和 agent 调用时一样的「审批工具调用」，写「固化流程第 k 步」；批准后按日志接着跑，带着批准真做这一步", async () => {
    const { script, ruleId, sessionId, waiting, item } = await approvalRun()
    expect(waiting.routine).toMatchObject({ state: "suspended", steps: 1, stoppedAt: { step: 2, kind: "approval", tool: "file.save" } })
    expect(item).toMatchObject({ kind: "approval", ruleId, assigneeId: "u-wang" })
    expect(item.title).toContain("固化流程「存单号」第 2 步")
    expect(item.detail.toolCall).toMatchObject({ toolId: "file.save", ruleId, ruleName: "存文件要批" })
    expect(item.detail.toolCall!.input).toContain("100 元")
    const [wait] = await ctx.db.select().from(t.sessionWaits).where(and(eq(t.sessionWaits.sessionId, sessionId), eq(t.sessionWaits.status, "waiting")))
    expect(wait!.pending).toMatchObject({ calls: [], routineStep: 2, ruleId, approvedRuleIds: [] })
    // 这一步还没做
    expect(await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.path, "out/付款.txt")))).toHaveLength(0)

    const resolved = await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item.id, how: "approve", note: "可以" })
    expect(resolved.data).toEqual({ resumedSessionId: sessionId })
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(0)
    expect(row.routine).toMatchObject({ state: "finished", steps: 3, resumes: 1, replayed: 1, logs: ["准备付款", "没有上次的记录"] })
    expect(await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.path, "out/付款.txt")))).toHaveLength(1)
    expect(await scriptToolEvents(sessionId)).toEqual([
      ["file.read", 1],
      ["file.save", 2],
      ["run.finish", 3],
    ])
    const [done] = await ctx.db.select().from(t.sessionWaits).where(eq(t.sessionWaits.id, wait!.id))
    expect(done!.pending?.state).toBe("done")
  })

  it("要人审批、被拒绝：不做这一步，停下（rejected）交给 agent，交接的话写理由", async () => {
    const { script, sessionId, item } = await approvalRun([step(finishWith("没付，按理由改成记一笔待办", "not_achieved", "被拒绝了，没付款"))])
    await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item.id, how: "reject", note: "这个月不付" })
    const row = await waitOutcome(sessionId)
    expect(script.prompts).toHaveLength(1)
    expect(row.routine).toMatchObject({ state: "fell_back", steps: 1, resumes: 1, stoppedAt: { step: 2, kind: "rejected", tool: "file.save" } })
    const prompt = firstPromptText(script)
    expect(prompt).toContain("做到第 2 步停下：file.save「out/付款.txt」 要人审批，王悦拒绝了。理由：这个月不付，这一步没做")
    expect(prompt).toContain("被拒绝的这一步不要换个办法绕过去做")
    expect(await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.path, "out/付款.txt")))).toHaveLength(0)
  })

  it("要人处理的事被点了「处理不了」：不重放（重做还会停在同一处），交给 agent，交接的话写清楚", async () => {
    const { taskId, script } = await routineTask(
      `
  await ha.file.save({ path: "out/a.txt", content: "a" })
  await ha.tool("ask.human", { question: "请登录一下系统", kind: "login" })
  await ha.file.read({ path: "out/a.txt" })
  return ha.finish({ outcome: "achieved", summary: "不该到这里", evidence: "-" })`,
      { turns: [step(finishWith("登录不了，记没办成", "not_achieved", "账号被锁了"))] }
    )
    const sessionId = await runNow(taskId)
    // 脚本状态先存成 suspended，要人办的事和挂起在后面的事务里才写：等那件事出来
    const item = await waitFor(
      async () => (await ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open"))))[0],
      { what: "要人办的事" }
    )
    await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item.id, how: "reject", note: "账号被锁了" })
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("not_achieved")
    expect(script.prompts).toHaveLength(1)
    expect(row.routine).toMatchObject({ state: "fell_back", steps: 2, resumes: 1, stoppedAt: { step: 2, kind: "suspend", tool: "ask.human" } })
    expect(firstPromptText(script)).toContain("做到第 2 步停下等人处理，接着跑时没有重做这一步：要人处理的事被点了「处理不了」（账号被锁了）")
    expect(await scriptToolEvents(sessionId)).toEqual([
      ["file.save", 1],
      ["ask.human", 2],
    ])
  })

  it("停下等人时运行被取消：脚本状态记停下（取消），不再是「等人处理后接着跑」", async () => {
    const { taskId } = await routineTask(`
  await ha.tool("session.wait", { what: "等很久", afterMinutes: 60 })
  return ha.finish({ outcome: "achieved", summary: "不该到这里", evidence: "-" })`)
    const sessionId = await runNow(taskId)
    await waitFor(async () => (await sessionRow(ctx.db, sessionId))?.routine?.state === "suspended", { what: "挂起" })
    const res = await mutate(ctx.app, "engine.cancel", wang, { sessionId })
    expect(res.error).toBeUndefined()
    const row = await sessionRow(ctx.db, sessionId)
    expect(row?.routine).toMatchObject({ state: "stopped", stoppedAt: { kind: "cancelled" } })
  })

  it("脚本报了办成、三方验收反问、agent 接着做：记 agentAfter，两个计数都不动", async () => {
    // 验收模型要是另一家（按 id 里的厂商名判断）
    const executor = `test/claude-routine-${++modelCounter}`
    const verifier = `test/gemini-routine-${modelCounter}`
    const script = useScript(executor, new Script([step(finishWith("补上了核对记录"))]))
    useScript(
      verifier,
      new Script([
        step([text(JSON.stringify({ items: [{ index: 1, verdict: "fail", reason: "没看到记录" }], verdict: "fail", headline: "记录不全", question: "记录在哪？" }))], 0.002),
        step([text(JSON.stringify({ items: [{ index: 1, verdict: "pass", reason: "有记录了" }], verdict: "pass", headline: "补做后通过", question: "" }))], 0.002),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: executor, toolIds: ["file.save", "file.read"], steps: [{ id: "s1", text: "存单号", wait: false, checkpoint: "单号已保存" }] })
    await ctx.db.update(t.tasks).set({ verifyModelId: verifier }).where(eq(t.tasks.id, taskId))
    await addRule(taskId, { trigger: { type: "agent_done" }, actions: [{ type: "verify" }] }, "三方验收")
    const { routineId } = await createRoutine(ctx.db, taskId, { code: routineCode(SAVE_AND_FINISH), name: "存单号" })
    const sessionId = await runNow(taskId, "C-1")
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(1)
    expect(script.promptText(0)).toContain("【三方验收】")
    expect(row.routine).toMatchObject({ state: "finished", agentAfter: true })
    // 结果定了以后才记成绩：等试用期的通知出来再看计数
    await waitFor(async () => {
      const notes = await ctx.db.select().from(t.notifications).where(eq(t.notifications.sessionId, sessionId))
      return notes.some((note) => note.body.includes("验收反问以后 agent 接着做"))
    }, { what: "试用期的通知" })
    const [routine] = await ctx.db.select().from(t.routines).where(eq(t.routines.id, routineId))
    expect(routine).toMatchObject({ directStreak: 0, fallbackStreak: 0 })
  })
})

describe("清扫（routine.sweep）", () => {
  it("试跑中、这一轮的试跑运行已经结束（没人发 routine.compile）→ 补发；写脚本中 30 分钟没动静 → 再发一次；刚动过的不发", async () => {
    const modelId = `test/routine-${++modelCounter}`
    useScript(modelId, new Script([]))
    const taskId = await createTask(ctx.db, { modelId, toolIds: ["file.save"] })
    const { routineId, versionId } = await createRoutine(ctx.db, taskId, { versionStatus: "testing", code: routineCode(`await ha.file.save({ path: "a.txt", content: "a" })`) })
    await ctx.db.update(t.routineVersions).set({ round: 1 }).where(eq(t.routineVersions.id, versionId))
    // 试跑的运行在别处被标了失败（没经过引擎收尾）：开运行和标失败在同一个事务里，引擎进来时已经不是执行中
    await ctx.db.transaction(async (tx) => {
      const { sessionId } = await startSessionInTx(ctx.db, tx, { taskId, source: "manual", actorId: "u-wang", routineTest: { versionId, round: 1, input: {}, attachments: [] } })
      expect(sessionId).toBe(`${versionId}-t1`)
      await tx.update(t.sessions).set({ status: "failed", endedAt: new Date(), error: "别处标的失败" }).where(eq(t.sessions.id, sessionId))
    })
    const old = new Date(Date.now() - 31 * 60_000)
    await ctx.db.insert(t.routineVersions).values([
      { id: `${routineId}-v2`, routineId, version: 2, status: "drafting", name: "卡住的", code: "", inputSchema: {}, outputSchema: {}, updatedAt: old },
      { id: `${routineId}-v3`, routineId, version: 3, status: "drafting", name: "刚动过的", code: "", inputSchema: {}, outputSchema: {} },
    ])
    const sent = await sweepRoutines(ctx.db)
    expect(sent).toEqual(expect.arrayContaining([versionId, `${routineId}-v2`]))
    expect(sent).not.toContain(`${routineId}-v3`)
    const jobs = (await bossJobs(ctx.db, "routine.compile")).map((job) => job.data.versionId)
    expect(jobs).toEqual(expect.arrayContaining([versionId, `${routineId}-v2`]))
    // 再扫一次：卡住的那版刚发过（updated_at 也碰过了），不再发
    expect(await sweepRoutines(ctx.db)).not.toContain(`${routineId}-v2`)
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
