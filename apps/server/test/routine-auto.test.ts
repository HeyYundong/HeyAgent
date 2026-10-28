// 办成后自动固化、跑不通后自动修、任务的两个固化设置（docs/dev/solidify.md 17.1）。
// 真实的测试库；多数用例直接在库里写好结束的运行再调 maybeAutoSolidify（不起 worker，发出的 routine.compile 没人取）；
// 最后一个起 worker：假执行模型办成 → 复核办成 → afterRunSettled → 自动建一版 → worker 接 routine.compile → 写好交给人审核。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { and, desc, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SessionRoutineState } from "@heyagent/shared"

import * as t from "../src/db/schema.js"
import { configureEngine } from "../src/engine/runtime.js"
import { bossFor, QUEUES, stopSenderBoss } from "../src/engine/queue.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { syncBuiltinTools } from "../src/engine/tools/builtin-defs.js"
import { startEngineWorker } from "../src/engine/worker-runtime.js"
import { afterRunSettled } from "../src/routine/after-run.js"
import { maybeAutoSolidify } from "../src/routine/auto.js"
import { handleCompileJob } from "../src/routine/compile.js"
import { bossJobs, createTask, finishWith, reviewVerdict, Script, sessionRow, step, text, waitFor } from "./engine-helpers.js"
import { login, mutate, query, setupApp, TEST_REVIEW_MODEL, type TestApp } from "./helpers.js"

let ctx: TestApp
let lin: string // 主管
let wang: string // 员工，测试任务的负责人

const SOLIDIFIER = "test/auto-solidifier"
const EXEC = "test/auto-exec"
const scripts = new Map<string, Script>()
const useModel = (modelId: string, outputs: (object | string)[]) => {
  const script = new Script(outputs.map((each) => step([text(typeof each === "string" ? each : JSON.stringify(each))], 0.002)))
  scripts.set(modelId, script)
  return script
}

const EMPTY_SCHEMA = JSON.stringify({ type: "object", properties: {} })
/** 一段只报办成的脚本（不用浏览器，任务不挂工具也能过程序检查） */
const good = (patch: Record<string, unknown> = {}) => ({
  suitable: true,
  reason: "步骤固定",
  name: "自动固化的流程",
  description: "1. 报办成",
  inputSchema: EMPTY_SCHEMA,
  outputSchema: EMPTY_SCHEMA,
  code: `import ha from "heyagent"\n\nexport default async function run(input) {\n  return ha.finish({ outcome: "achieved", summary: "好了", evidence: "依据" })\n}\n`,
  commits: [],
  assumptions: [],
  ...patch,
})

const DISPATCH = {
  params: [{ name: "单号", description: "要查的单号", required: true, dedupe: true }],
  results: [],
  maxRunning: 1,
}

beforeAll(async () => {
  ctx = await setupApp()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  configureEngine({
    keyring: ctx.keyring,
    filesDir: mkdtempSync(join(tmpdir(), "heyagent-files-")),
    modelRetryBaseMs: 10,
    modelFactory: ({ modelId }) => {
      const script = scripts.get(modelId)
      if (!script) throw new Error(`测试没有给模型 ${modelId} 准备剧本`)
      return script.model
    },
  })
  await syncBuiltinTools(ctx.db)
  await ctx.db
    .insert(t.models)
    .values([
      { id: SOLIDIFIER, providerId: "openrouter", name: "测试固化模型", contextK: 128 },
      { id: EXEC, providerId: "openrouter", name: "测试执行模型", contextK: 128 },
    ])
    .onConflictDoNothing()
  await ctx.db.insert(t.modelDefaults).values({ role: "solidify", modelId: SOLIDIFIER }).onConflictDoUpdate({ target: t.modelDefaults.role, set: { modelId: SOLIDIFIER } })
  // worker 没起：发 routine.compile 要先有这个队列（worker 启动时建）
  const boss = await bossFor(ctx.db)
  await boss.createQueue(QUEUES.routineCompile, { policy: "stately" })
}, 120_000)

afterAll(async () => {
  await stopSenderBoss(ctx.db)
  await ctx?.close()
})

// ---------- 造数据 ----------

type Kind = "dispatch" | "schedule" | "plain"

async function task(kind: Kind, settings: { autoSolidify?: boolean | null; routineSkipTest?: boolean } = {}) {
  // 不给 = 按默认（null）；createTask 在测试里默认关自动固化
  const id = await createTask(ctx.db, { modelId: EXEC, title: `固化测试 ${kind}`, autoSolidify: settings.autoSolidify ?? null, ...(kind === "schedule" ? { scheduleCron: "0 9 * * *" } : {}) })
  const patch = {
    ...(kind === "dispatch" ? { dispatch: DISPATCH } : {}),
    ...(settings.routineSkipTest !== undefined ? { routineSkipTest: settings.routineSkipTest } : {}),
  }
  if (Object.keys(patch).length) await ctx.db.update(t.tasks).set(patch).where(eq(t.tasks.id, id))
  return id
}

let runCounter = 0

/** 在库里写一次结束了的运行（默认办成的普通运行） */
async function endedRun(taskId: string, input: { outcome?: "achieved" | "not_achieved"; routine?: SessionRoutineState; kind?: "run" | "routine_test" } = {}) {
  const snapshot = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })
  const id = `R-auto-${taskId}-${++runCounter}`
  const now = new Date()
  await ctx.db.insert(t.sessions).values({
    id,
    taskId,
    kind: input.kind ?? "run",
    status: "done",
    modelId: EXEC,
    triggeredBy: "manual",
    startedAt: new Date(now.getTime() - 60_000),
    endedAt: now,
    snapshot,
    outcome: input.outcome ?? "achieved",
    routine: input.routine ?? null,
  })
  return id
}

/** 运行上的脚本状态：跑的是 versionId 那一版 */
const ranState = (routineId: string, version: number, state: SessionRoutineState["state"], extra: Partial<SessionRoutineState> = {}): SessionRoutineState => ({
  routineId,
  versionId: `${routineId}-v${version}`,
  version,
  mode: "run",
  state,
  startedAt: new Date().toISOString(),
  steps: 2,
  commits: [],
  ...(state === "fell_back" ? { stoppedAt: { step: 2, kind: "step_error", tool: "browser.type", label: "单号输入框", reason: "找不到单号输入框" } } : {}),
  ...extra,
})

let routineCounter = 7000

/** 一个有启用版本的固化流程（第 1 版启用；建得早，不算 24 小时内） */
async function activeRoutine(taskId: string, input: { status?: "trial" | "active" | "paused"; auto?: boolean } = {}) {
  const id = `RT-${++routineCounter}`
  await ctx.db.insert(t.routines).values({ id, taskId, status: input.status ?? "trial", activeVersion: 1 })
  const old = new Date(Date.now() - 10 * 24 * 3600_000)
  await ctx.db.insert(t.routineVersions).values({ id: `${id}-v1`, routineId: id, version: 1, status: "approved", name: "第一版", code: "x", auto: input.auto ?? false, createdAt: old, updatedAt: old })
  await ctx.db.update(t.tasks).set({ routineMode: "first" }).where(eq(t.tasks.id, taskId))
  return id
}

const versionsOf = async (taskId: string) =>
  ctx.db
    .select({ version: t.routineVersions })
    .from(t.routineVersions)
    .innerJoin(t.routines, eq(t.routines.id, t.routineVersions.routineId))
    .where(eq(t.routines.taskId, taskId))
    .orderBy(desc(t.routineVersions.version))
    .then((rows) => rows.map((row) => row.version))

const versionRow = async (id: string) => (await ctx.db.select().from(t.routineVersions).where(eq(t.routineVersions.id, id)))[0]!

/** 把一版的时间往前挪（测 24 小时、7 天） */
async function ageVersion(id: string, input: { createdHours?: number; updatedHours?: number }) {
  await ctx.db
    .update(t.routineVersions)
    .set({
      ...(input.createdHours !== undefined ? { createdAt: new Date(Date.now() - input.createdHours * 3600_000) } : {}),
      ...(input.updatedHours !== undefined ? { updatedAt: new Date(Date.now() - input.updatedHours * 3600_000) } : {}),
    })
    .where(eq(t.routineVersions.id, id))
}

const started = (result: Awaited<ReturnType<typeof maybeAutoSolidify>>) => {
  if (!result.started) throw new Error(`没有自动固化：${result.reason}`)
  return result
}

// ---------- 任务的两个设置 ----------

describe("任务设置：办成后自动固化、固化时不试跑", () => {
  const NEW_TASK = { title: "固化设置", goal: "做完", steps: [{ text: "做", wait: false }], schedule: null, memoryIds: [], skillIds: [], toolIds: [], ruleIds: [], reviewModelId: TEST_REVIEW_MODEL }
  const lastAudit = async (action: string, targetId: string) =>
    (await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.action, action), eq(t.auditEvents.targetId, targetId))).orderBy(desc(t.auditEvents.id)).limit(1))[0]

  it("新建不传 = 按默认（null）、要试跑；传了就存；修改保存、读回；改了的记在审计的 changed 里", async () => {
    const plain = await mutate(ctx.app, "tasks.create", lin, NEW_TASK)
    expect(plain.error).toBeUndefined()
    expect((await query(ctx.app, "tasks.get", lin, { id: plain.data.id })).data).toMatchObject({ autoSolidify: null, routineSkipTest: false })
    expect((await lastAudit("task.create", plain.data.id))!.detail).not.toHaveProperty("autoSolidify")

    const created = await mutate(ctx.app, "tasks.create", lin, { ...NEW_TASK, autoSolidify: false, routineSkipTest: true })
    const id = created.data.id as string
    expect((await query(ctx.app, "tasks.get", lin, { id })).data).toMatchObject({ autoSolidify: false, routineSkipTest: true })
    expect((await lastAudit("task.create", id))!.detail).toMatchObject({ autoSolidify: false, routineSkipTest: true })

    expect((await mutate(ctx.app, "tasks.update", lin, { ...NEW_TASK, id, autoSolidify: true, routineSkipTest: true })).error).toBeUndefined()
    expect((await query(ctx.app, "tasks.get", lin, { id })).data).toMatchObject({ autoSolidify: true, routineSkipTest: true })
    const changed = (await lastAudit("task.update", id))!.detail as { changed: string[] }
    expect(changed.changed).toContain("autoSolidify")
    expect(changed.changed).not.toContain("routineSkipTest")

    // 回到默认
    await mutate(ctx.app, "tasks.update", lin, { ...NEW_TASK, id, autoSolidify: null, routineSkipTest: false })
    expect((await query(ctx.app, "tasks.get", lin, { id })).data).toMatchObject({ autoSolidify: null, routineSkipTest: false })
    expect(((await lastAudit("task.update", id))!.detail as { changed: string[] }).changed).toEqual(expect.arrayContaining(["autoSolidify", "routineSkipTest"]))
  })
})

// ---------- 自动固化的判断 ----------

describe("自动固化：要不要固化", () => {
  it("第一版：被派的任务默认开，办成就建一版（auto、没有 created_by、不试跑按任务设置），记审计、发 routine.compile", async () => {
    const taskId = await task("dispatch", { routineSkipTest: true })
    const source = await endedRun(taskId)
    const result = started(await maybeAutoSolidify(ctx.db, source))
    expect(result).toMatchObject({ version: 1, baseVersion: null })
    const version = await versionRow(result.versionId)
    expect(version).toMatchObject({ status: "drafting", auto: true, createdById: null, skipTest: true, sourceSessionId: source, baseVersion: null })
    const [routine] = await ctx.db.select().from(t.routines).where(eq(t.routines.taskId, taskId))
    expect(routine).toMatchObject({ id: result.routineId, status: "trial", activeVersion: null })
    const [audit] = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.action, "routine.compile"), eq(t.auditEvents.targetId, result.versionId)))
    expect(audit).toMatchObject({ actorId: null, detail: { sessionId: source, auto: true, skipTest: true } })
    expect((await bossJobs(ctx.db, QUEUES.routineCompile)).some((job) => job.data.versionId === result.versionId)).toBe(true)
    // 读接口带 auto
    expect((await query(ctx.app, "routine.version", wang, { id: result.versionId })).data).toMatchObject({ auto: true, createdBy: null })
    expect((await query(ctx.app, "routine.get", wang, { taskId })).data.versions).toEqual([expect.objectContaining({ version: 1, auto: true })])
  })

  it("默认值：定时任务开、别的关；任务上设了就按设的", async () => {
    expect(started(await maybeAutoSolidify(ctx.db, await endedRun(await task("schedule"))))).toMatchObject({ baseVersion: null })
    expect(await maybeAutoSolidify(ctx.db, await endedRun(await task("plain")))).toEqual({ started: false, reason: expect.stringContaining("没开") })
    expect((await maybeAutoSolidify(ctx.db, await endedRun(await task("plain", { autoSolidify: true })))).started).toBe(true)
    expect((await maybeAutoSolidify(ctx.db, await endedRun(await task("dispatch", { autoSolidify: false })))).started).toBe(false)
    expect((await maybeAutoSolidify(ctx.db, await endedRun(await task("schedule", { autoSolidify: false })))).started).toBe(false)
  })

  it("没办成、固化试跑的运行不固化；关着的任务没有建空的固化流程", async () => {
    const taskId = await task("dispatch")
    expect(await maybeAutoSolidify(ctx.db, await endedRun(taskId, { outcome: "not_achieved" }))).toEqual({ started: false, reason: "运行没办成" })
    expect(await maybeAutoSolidify(ctx.db, await endedRun(taskId, { kind: "routine_test" }))).toEqual({ started: false, reason: "不是普通运行" })
    expect(await ctx.db.select().from(t.routines).where(eq(t.routines.taskId, taskId))).toEqual([])
  })

  it("脚本直接办成不固化；交给 agent、agent 办成 → 修那一版；脚本报了办成后 agent 接着做完的不固化", async () => {
    const taskId = await task("dispatch")
    const routineId = await activeRoutine(taskId)
    expect(await maybeAutoSolidify(ctx.db, await endedRun(taskId, { routine: ranState(routineId, 1, "finished") }))).toEqual({ started: false, reason: "脚本直接办成，不用再固化" })
    expect((await maybeAutoSolidify(ctx.db, await endedRun(taskId, { routine: ranState(routineId, 1, "finished", { agentAfter: true }) }))).started).toBe(false)

    const fellBack = await endedRun(taskId, { routine: ranState(routineId, 1, "fell_back") })
    const result = started(await maybeAutoSolidify(ctx.db, fellBack))
    expect(result).toMatchObject({ routineId, version: 2, baseVersion: 1 })
    expect(await versionRow(result.versionId)).toMatchObject({ auto: true, baseVersion: 1, sourceSessionId: fellBack, skipTest: false })
  })

  it("流程停用着、这次只有 agent（没冻流程）→ 修启用的那一版；没停用、这次没跑脚本 → 不固化", async () => {
    const paused = await task("dispatch")
    const pausedRoutine = await activeRoutine(paused, { status: "paused" })
    expect(started(await maybeAutoSolidify(ctx.db, await endedRun(paused)))).toMatchObject({ routineId: pausedRoutine, baseVersion: 1, version: 2 })

    const running = await task("dispatch")
    await activeRoutine(running)
    expect(await maybeAutoSolidify(ctx.db, await endedRun(running))).toEqual({ started: false, reason: expect.stringContaining("这次运行没跑脚本") })
    expect(await versionsOf(running)).toHaveLength(1)
  })

  it("有一版在写、试跑、待审核：不固化", async () => {
    const taskId = await task("dispatch")
    const first = started(await maybeAutoSolidify(ctx.db, await endedRun(taskId)))
    for (const status of ["drafting", "testing", "review"] as const) {
      await ctx.db.update(t.routineVersions).set({ status, createdAt: new Date(Date.now() - 48 * 3600_000) }).where(eq(t.routineVersions.id, first.versionId))
      const result = await maybeAutoSolidify(ctx.db, await endedRun(taskId))
      expect(result, status).toEqual({ started: false, reason: expect.stringContaining("第 1 版") })
    }
    expect(await versionsOf(taskId)).toHaveLength(1)
  })

  it("24 小时内自动固化过就不再自动；过了 24 小时可以", async () => {
    const taskId = await task("dispatch")
    const routineId = await activeRoutine(taskId)
    const v2 = started(await maybeAutoSolidify(ctx.db, await endedRun(taskId, { routine: ranState(routineId, 1, "fell_back") })))
    // 第 2 版审核过了、启用了：不在走，只剩 24 小时这条
    await ctx.db.update(t.routineVersions).set({ status: "approved" }).where(eq(t.routineVersions.id, v2.versionId))
    await ctx.db.update(t.routines).set({ activeVersion: 2 }).where(eq(t.routines.id, routineId))
    const again = await endedRun(taskId, { routine: ranState(routineId, 2, "fell_back") })
    expect(await maybeAutoSolidify(ctx.db, again)).toEqual({ started: false, reason: expect.stringContaining("24 小时内已经自动固化过（第 2 版）") })
    await ageVersion(v2.versionId, { createdHours: 25 })
    expect(started(await maybeAutoSolidify(ctx.db, again))).toMatchObject({ version: 3, baseVersion: 2 })
  })

  it("最近一版「不用」或「没成功」：7 天内不再自动；过了 7 天可以", async () => {
    for (const status of ["rejected", "failed"] as const) {
      const taskId = await task("dispatch")
      const v1 = started(await maybeAutoSolidify(ctx.db, await endedRun(taskId)))
      await ctx.db.update(t.routineVersions).set({ status }).where(eq(t.routineVersions.id, v1.versionId))
      await ageVersion(v1.versionId, { createdHours: 6 * 24, updatedHours: 6 * 24 })
      expect(await maybeAutoSolidify(ctx.db, await endedRun(taskId)), status).toEqual({ started: false, reason: expect.stringContaining("7 天内不再自动固化") })
      await ageVersion(v1.versionId, { updatedHours: 8 * 24 })
      expect(started(await maybeAutoSolidify(ctx.db, await endedRun(taskId)))).toMatchObject({ version: 2, baseVersion: null })
    }
  })

  it("同一个任务两次运行几乎同时结束：只建一版（没有流程时、已有流程时都一样）", async () => {
    const fresh = await task("dispatch")
    const runs = await Promise.all([endedRun(fresh), endedRun(fresh), endedRun(fresh)])
    const results = await Promise.all(runs.map((id) => maybeAutoSolidify(ctx.db, id)))
    expect(results.filter((each) => each.started)).toHaveLength(1)
    expect(await versionsOf(fresh)).toHaveLength(1)
    expect(await ctx.db.select().from(t.routines).where(eq(t.routines.taskId, fresh))).toHaveLength(1)

    const existing = await task("dispatch")
    const routineId = await activeRoutine(existing)
    const fellBack = await Promise.all([1, 2, 3].map(() => endedRun(existing, { routine: ranState(routineId, 1, "fell_back") })))
    const repaired = await Promise.all(fellBack.map((id) => maybeAutoSolidify(ctx.db, id)))
    expect(repaired.filter((each) => each.started)).toHaveLength(1)
    expect(await versionsOf(existing)).toHaveLength(2)
  })

  it("人点「固化成流程」不受 24 小时、7 天的限制；不试跑没传时按任务的设置", async () => {
    const taskId = await task("dispatch", { routineSkipTest: true })
    const v1 = started(await maybeAutoSolidify(ctx.db, await endedRun(taskId)))
    await ctx.db.update(t.routineVersions).set({ status: "failed" }).where(eq(t.routineVersions.id, v1.versionId))
    expect((await maybeAutoSolidify(ctx.db, await endedRun(taskId))).started).toBe(false)
    const manual = await mutate(ctx.app, "routine.compile", wang, { sessionId: await endedRun(taskId) })
    expect(manual.error).toBeUndefined()
    expect(await versionRow(manual.data.versionId)).toMatchObject({ version: 2, auto: false, createdById: "u-wang", skipTest: true })
    // 传了就照传的
    await ctx.db.update(t.routineVersions).set({ status: "rejected" }).where(eq(t.routineVersions.id, manual.data.versionId))
    const explicit = await mutate(ctx.app, "routine.compile", wang, { sessionId: await endedRun(taskId), skipTest: false })
    expect(await versionRow(explicit.data.versionId)).toMatchObject({ version: 3, skipTest: false })
  })
})

// ---------- 审核卡、通知的文案 ----------

describe("自动固化的版本：审核卡、通知写明", () => {
  const latestNote = async () => (await ctx.db.select().from(t.notifications).where(eq(t.notifications.userId, "u-wang")).orderBy(desc(t.notifications.id)).limit(1))[0]

  it("写好交给人审核：审核卡、通知里写「运行办成后自动固化的」；修的版本写修第几版", async () => {
    // 不用被派的任务：假固化员的脚本没写派活声明的参数，过不了程序检查
    const taskId = await task("plain", { autoSolidify: true, routineSkipTest: true })
    const routineId = await activeRoutine(taskId, { status: "paused" })
    const result = started(await maybeAutoSolidify(ctx.db, await endedRun(taskId)))
    useModel(SOLIDIFIER, [good()])
    await handleCompileJob(ctx.db, { versionId: result.versionId })
    const reviewed = await versionRow(result.versionId)
    expect(reviewed, reviewed.failReason ?? "").toMatchObject({ status: "review", auto: true })
    const [item] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.routineVersionId, result.versionId))
    expect(item!.summary).toContain("（运行办成后自动固化的，修第 1 版）")
    expect(item!.summary).toContain("没有试跑（任务设了固化时不试跑）")
    expect(JSON.stringify(item!.detail)).toContain("自动固化")
    expect(item!.detail).toMatchObject({ routine: { routineId, versionId: result.versionId, version: 2 } })
    expect(await latestNote()).toMatchObject({ title: expect.stringContaining("等你处理：审核固化流程"), body: expect.stringContaining("运行办成后自动固化的") })
  })

  it("没成功：通知里写这一版是自动固化的", async () => {
    const taskId = await task("dispatch")
    const result = started(await maybeAutoSolidify(ctx.db, await endedRun(taskId)))
    useModel(SOLIDIFIER, [good({ suitable: false, reason: "要看图判断" })])
    await handleCompileJob(ctx.db, { versionId: result.versionId })
    expect(await versionRow(result.versionId)).toMatchObject({ status: "failed" })
    expect(await latestNote()).toMatchObject({ title: expect.stringContaining("固化没成功"), body: expect.stringMatching(/^这一版是运行办成后自动固化的。不适合固化：要看图判断/) })
  })

  it("人点的版本不写", async () => {
    const taskId = await task("plain")
    const manual = await mutate(ctx.app, "routine.compile", wang, { sessionId: await endedRun(taskId), skipTest: true })
    useModel(SOLIDIFIER, [good()])
    await handleCompileJob(ctx.db, { versionId: manual.data.versionId })
    const [item] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.routineVersionId, manual.data.versionId))
    expect(item!.summary).not.toContain("自动固化")
    expect(item!.summary).toContain("没有试跑（点固化时选了不试跑）")
  })
})

// ---------- 从运行结束到建版本 ----------

describe("从运行结束一路走到待审核（起 worker）", () => {
  it("afterRunSettled 不出错、不固化的什么都不做", async () => {
    const taskId = await task("plain")
    await afterRunSettled(ctx.db, await endedRun(taskId))
    expect(await versionsOf(taskId)).toEqual([])
  })

  it("开着自动固化的任务跑一次：agent 办成 → 复核办成 → 自动建一版 → worker 接 routine.compile → 写好（不试跑）交给人审核", async () => {
    const taskId = await task("plain", { autoSolidify: true, routineSkipTest: true })
    scripts.set(EXEC, new Script([step(finishWith("做完了"))]))
    scripts.set(TEST_REVIEW_MODEL, new Script(Array.from({ length: 5 }, () => reviewVerdict("achieved", "测试复核：办成"))))
    useModel(SOLIDIFIER, [good()])
    // 别的用例排着、没人取的 routine.compile 先清掉（不然 worker 起来会先拿它们去用固化员的剧本）
    await ctx.db.execute(sql`delete from pgboss.job where name = ${QUEUES.routineCompile}`)
    const worker = await startEngineWorker({ databaseUrl: ctx.url, db: ctx.db, pollingIntervalSeconds: 0.5, browserControlPort: false, desktopSweepMs: false, desktopVmSweepMs: false })
    try {
      const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
      expect(res.error).toBeUndefined()
      const sessionId = res.data.sessionId as string
      const run = await waitFor(
        async () => {
          const row = await sessionRow(ctx.db, sessionId)
          return row?.outcome && !row.review?.pending ? row : undefined
        },
        { timeout: 60_000, what: "运行办成、复核完" }
      )
      expect(run).toMatchObject({ status: "done", outcome: "achieved" })
      const version = await waitFor(
        async () => {
          const [row] = await versionsOf(taskId)
          return row?.status === "review" ? row : undefined
        },
        { timeout: 60_000, what: "自动固化的一版写好、待审核" }
      )
      expect(version).toMatchObject({ version: 1, auto: true, createdById: null, skipTest: true, sourceSessionId: sessionId })
      const [item] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.routineVersionId, version.id))
      expect(item).toMatchObject({ kind: "routine", status: "open", assigneeId: "u-wang" })
      expect(item!.summary).toContain("运行办成后自动固化的")
    } finally {
      await worker.stop()
      scripts.delete(TEST_REVIEW_MODEL)
    }
  }, 150_000)
})
