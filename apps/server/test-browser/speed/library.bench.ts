// 流程库的真模型基准（花钱，docs/dev/routine-library.md 12.3、第 18 节）：基准站点的场景 B
// 1. 来源任务「查一家供应商的电话和评分」（可以被派，参数「供应商全名」，交回「电话」「评分」）：派一张让 agent 办成 → 固化 →
//    审核启用 → 再派 3 张（别的供应商）照脚本跑、转正式（没转成就直接写 proven_at，记一行 manualProven）→ 主管发布进库；
// 2. 对照：场景 B 整件事（查 6 家、交汇总）不选库流程，agent 办 BASELINE 遍；
// 3. 场景 B 整件事选用这个库流程，agent 办 CALLER 遍：记 routine.* 调用的参数、过程里的 trace.library / libraryCall、调用记录；
// 4. 拿第 3 步办成的一次固化，看脚本里有没有 ha.routine 循环，审核启用后照脚本跑 REPEAT 遍。
// 每一步一行 JSON 追加进 SPEED_OUT。用法：SPEED_FILE=library scripts/speed-bench.sh <标签> B [遍数]
import { appendFileSync, writeFileSync } from "node:fs"

import { toolSchemaOf } from "@heyagent/shared"
import { and, asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, it } from "vitest"

import * as t from "../../src/db/schema.js"
import { configureEngine } from "../../src/engine/runtime.js"
import { encrypt, mask } from "../../src/lib/crypto.js"
import { buildMaterial } from "../../src/routine/material.js"
import {
  createTask,
  eventsOf,
  sessionRow,
  setupEngine,
  waitFor,
  waitStatus,
  type EngineTestContext,
} from "../../test/engine-helpers.js"
import { login, mutate, query } from "../../test/helpers.js"
import { createProfile } from "../fixtures.js"
import {
  score,
  startSpeedSite,
  SUPPLIERS,
  TARGET_SUPPLIERS,
  type SpeedSite,
} from "./site.js"

const MODEL =
  process.env.SPEED_MODEL ?? "openrouter/deepseek/deepseek-v4.1-flash-1017"
const SOLIDIFY_MODEL =
  process.env.ROUTINE_SOLIDIFY_MODEL ?? "openrouter/deepseek/deepseek-v4-pro"
const LABEL = process.env.SPEED_LABEL ?? "library"
const REPEAT = Number(process.env.SPEED_REPEAT ?? 3)
const BASELINE = Number(process.env.LIBRARY_BASELINE ?? 2)
const CALLER = Number(process.env.LIBRARY_CALLER ?? 3)
const OUT = process.env.SPEED_OUT
const RUN_TIMEOUT = 25 * 60_000
const COMPILE_TIMEOUT = 30 * 60_000
const SLUG = "supplier_contact"
/** 来源任务：agent 办的那一张、试用期的 3 张（都不是场景 B 要查的 6 家） */
const SOURCE_AGENT = "s4"
const SOURCE_TRIAL = ["s6", "s8", "s10"]

let ctx: EngineTestContext
let site: SpeedSite
let wang: string
let lin: string
let profileId: string

const nameOf = (id: string) => SUPPLIERS.find((each) => each.id === id)!.name

const write = (record: Record<string, unknown>) => {
  console.log(JSON.stringify(record))
  if (OUT) appendFileSync(OUT, `${JSON.stringify(record)}\n`)
}
const dump = (suffix: string, content: string) => {
  if (!OUT) return undefined
  const path = OUT.replace(/\.jsonl$/, `-${suffix}`)
  writeFileSync(path, content)
  return path
}

async function ensureModel(id: string, providerId: string, vision: boolean) {
  const [model] = await ctx.db
    .select()
    .from(t.models)
    .where(eq(t.models.id, id))
  if (!model)
    await ctx.db.insert(t.models).values({
      id,
      providerId,
      name: id,
      contextK: 1000,
      priceIn: 0.3,
      priceOut: 1.2,
      vision,
    })
  else if (model.vision !== vision)
    await ctx.db.update(t.models).set({ vision }).where(eq(t.models.id, id))
}

async function useRealModels() {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("没有 OPENROUTER_API_KEY")
  const [provider] = await ctx.db
    .select()
    .from(t.modelProviders)
    .where(eq(t.modelProviders.kind, "openrouter"))
  if (!provider) throw new Error("种子里没有 OpenRouter 模型服务")
  const secretId = provider.apiKeySecretId ?? `sec-provider-${provider.id}`
  const [old] = await ctx.db
    .select()
    .from(t.secrets)
    .where(eq(t.secrets.id, secretId))
  const version = (old?.version ?? 0) + 1
  const enc = encrypt(ctx.keyring, apiKey, {
    table: "secrets",
    id: secretId,
    version,
  })
  if (old)
    await ctx.db
      .update(t.secrets)
      .set({ enc, version, masked: mask(apiKey) })
      .where(eq(t.secrets.id, secretId))
  else
    await ctx.db.insert(t.secrets).values({
      id: secretId,
      scope: "model_provider",
      refId: provider.id,
      name: "api_key",
      version,
      enc,
      masked: mask(apiKey),
    })
  await ctx.db
    .update(t.modelProviders)
    .set({
      apiKeySecretId: secretId,
      status: "ok",
      baseUrl: "https://openrouter.ai/api/v1",
    })
    .where(eq(t.modelProviders.id, provider.id))
  await ensureModel(MODEL, provider.id, process.env.SPEED_MODEL_VISION !== "0")
  await ensureModel(SOLIDIFY_MODEL, provider.id, false)
  await ctx.db
    .insert(t.modelDefaults)
    .values({ role: "solidify", modelId: SOLIDIFY_MODEL })
    .onConflictDoUpdate({
      target: t.modelDefaults.role,
      set: { modelId: SOLIDIFY_MODEL },
    })
  configureEngine({ modelFactory: undefined })
}

beforeAll(async () => {
  ctx = await setupEngine()
  site = await startSpeedSite()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  lin = await login(ctx.app, "linzhou@heyagent.local")
  profileId = await createProfile(ctx.db, ctx.keyring)
  await useRealModels()
  const res = await mutate(ctx.app, "settings.updateBrowser", lin, {
    maxPerWorker: 4,
    visionCheck: false,
    visionModel: "openrouter/qwen/qwen3.8-flash",
    captchaSolve: false,
    humanHoldMinutes: 30,
  })
  if (res.error) throw new Error(JSON.stringify(res.error))
}, 180_000)

afterAll(async () => {
  await ctx?.stop()
  await site?.close()
})

const wholeGoal = () =>
  `在供应商搜索 ${site.url("/b/search")} 查下面 ${TARGET_SUPPLIERS.length} 家供应商的电话和评分（注意有名字相近的别家，要看准全名）：${TARGET_SUPPLIERS.map(nameOf).join("、")}。查完后到 ${site.url("/b/report")} 提交汇总，每行一家，格式「名称,电话,评分」，名称写全名。`

async function browserTask(title: string, goal: string, toolIds: string[]) {
  const taskId = await createTask(ctx.db, {
    modelId: MODEL,
    title,
    goal,
    toolIds,
    ownerId: "u-wang",
    reviewModelId: MODEL,
  })
  await ctx.db
    .update(t.tasks)
    .set({ browserProfileIds: [profileId] })
    .where(eq(t.tasks.id, taskId))
  return taskId
}

/** 等运行结束、复核出结果 */
async function settle(sessionId: string) {
  let status = "timeout"
  try {
    status = (
      await waitStatus(
        ctx.db,
        sessionId,
        ["done", "failed", "cancelled", "needs_human", "verifying"],
        RUN_TIMEOUT
      )
    ).status
    if (status === "verifying" || status === "done")
      status = (
        await waitStatus(
          ctx.db,
          sessionId,
          ["done", "failed"],
          5 * 60_000
        ).catch(() => ({ status }))
      ).status
    for (
      let i = 0;
      i < 150 && !(await sessionRow(ctx.db, sessionId))?.outcome;
      i++
    )
      await new Promise((resolve) => setTimeout(resolve, 2000))
  } catch {
    await mutate(ctx.app, "engine.cancel", wang, { sessionId }).catch(() => {})
  }
  return status
}

/** 一次运行的数字：总时间、模型调用、工具、库流程调用 */
async function measure(sessionId: string, status: string) {
  const row = (await sessionRow(ctx.db, sessionId))!
  const events = await eventsOf(ctx.db, sessionId)
  const finish = [...events]
    .reverse()
    .find((event) => event.toolId === "run.finish")
  const end = (finish?.at ?? row.endedAt ?? new Date()).getTime()
  const think = events.filter((event) => event.kind === "think")
  const tools = events.filter((event) => event.kind === "tool")
  const byTool: Record<string, number> = {}
  for (const event of tools)
    byTool[event.toolId ?? "?"] = (byTool[event.toolId ?? "?"] ?? 0) + 1
  // 库流程：调用那一行（routine.* 工具、脚本里的进入）、里面的步骤（trace.library）、跑完那一条（带 libraryCall 不是工具调用）
  const callRows = events.filter((event) => event.trace?.libraryCall)
  const inner = events.filter((event) => event.trace?.library)
  const callIds = new Set(
    callRows.map((event) => event.trace!.libraryCall!.callId)
  )
  const innerByCall: Record<string, number> = {}
  for (const event of inner)
    innerByCall[event.trace!.library!.callId] =
      (innerByCall[event.trace!.library!.callId] ?? 0) + 1
  const calls = await ctx.db
    .select()
    .from(t.routineCalls)
    .where(eq(t.routineCalls.sessionId, sessionId))
    .orderBy(asc(t.routineCalls.id))
  return {
    sessionId,
    status,
    outcome: row.outcome,
    outcomeReason: row.outcomeReason,
    routine: row.routine
      ? {
          state: row.routine.state,
          steps: row.routine.steps,
          stoppedAt: row.routine.stoppedAt ?? null,
          agentAfter: row.routine.agentAfter ?? null,
        }
      : null,
    wallSec: Math.round((end - row.startedAt.getTime()) / 100) / 10,
    modelCalls: think.length,
    tokensIn: think.reduce((sum, event) => sum + (event.tokensIn ?? 0), 0),
    toolCalls: tools.length,
    costUsd: row.costUsd,
    byTool,
    library: {
      // agent 调的：工具名、参数、结果第一行、用时
      toolCalls: tools
        .filter((event) => event.toolId?.startsWith("routine."))
        .map((event) => ({
          tool: event.toolId,
          input: event.input,
          ms: event.ms,
          out: String(event.output ?? "")
            .split("\n")
            .slice(0, 2)
            .join(" | ")
            .slice(0, 200),
          callId: event.trace?.libraryCall?.callId ?? null,
        })),
      callRows: callRows.length,
      innerSteps: inner.length,
      innerByCall,
      // 里面的步骤的 callId 都对得上调用那一行的 libraryCall
      orphanInner: inner.filter(
        (event) => !callIds.has(event.trace!.library!.callId)
      ).length,
      callsWithoutInner: [...callIds].filter((id) => !innerByCall[id]).length,
      records: calls.map((each) => ({
        callId: each.callId,
        via: each.via,
        depth: each.depth,
        result: each.result,
        stopKind: each.stopKind,
        stopStep: each.stopStep,
        steps: each.steps,
        ms: each.ms,
      })),
    },
  }
}

/** 派一张给来源任务，等它办完；按交回的结果判对错 */
async function dispatchOnce(taskId: string, supplierId: string) {
  const supplier = SUPPLIERS.find((each) => each.id === supplierId)!
  const res = await mutate(ctx.app, "work.dispatch", wang, {
    taskId,
    params: { 供应商全名: supplier.name },
  })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  const itemId = (res.data as { item: { id: string } }).item.id
  const sessionId = await waitFor(
    async () =>
      (
        await ctx.db
          .select({ sessionId: t.workItems.sessionId })
          .from(t.workItems)
          .where(eq(t.workItems.id, itemId))
      )[0]?.sessionId ?? undefined,
    { timeout: 120_000, what: `${itemId} 开始办` }
  )
  const status = await settle(sessionId)
  const [item] = await ctx.db
    .select()
    .from(t.workItems)
    .where(eq(t.workItems.id, itemId))
  const result = JSON.stringify(item?.result ?? null)
  return {
    supplier: supplierId,
    itemId,
    result,
    correct:
      result.includes(supplier.phone) && result.includes(supplier.rating)
        ? 1
        : 0,
    ...(await measure(sessionId, status)),
  }
}

/** 场景 B 整件事跑一遍（agent 或脚本） */
async function wholeOnce(taskId: string) {
  site.reset()
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  const sessionId = res.data.sessionId as string
  const status = await settle(sessionId)
  const graded = score("B", site.results)
  return {
    correct: graded.correct,
    total: graded.total,
    notes: graded.notes,
    ...(await measure(sessionId, status)),
  }
}

async function waitVersion(versionId: string) {
  const deadline = Date.now() + COMPILE_TIMEOUT
  for (;;) {
    const [version] = await ctx.db
      .select()
      .from(t.routineVersions)
      .where(eq(t.routineVersions.id, versionId))
    if (version && (version.status === "review" || version.status === "failed"))
      return version
    if (Date.now() > deadline)
      throw new Error(
        `固化 ${versionId} 等了 ${COMPILE_TIMEOUT / 60_000} 分钟还没好（现在 ${version?.status}）`
      )
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

/** 固化这次运行，等到待审核；记一行，存脚本和材料 */
async function compile(step: string, sessionId: string, taskId: string) {
  const started = Date.now()
  const compiled = await mutate(ctx.app, "routine.compile", wang, { sessionId })
  if (!compiled.data) throw new Error(JSON.stringify(compiled.error))
  const version = await waitVersion(compiled.data.versionId as string)
  const tests = await ctx.db
    .select({ id: t.sessions.id, routine: t.sessions.routine })
    .from(t.sessions)
    .where(
      and(eq(t.sessions.taskId, taskId), eq(t.sessions.kind, "routine_test"))
    )
  write({
    label: LABEL,
    step,
    versionId: version.id,
    routineId: version.routineId,
    status: version.status,
    failReason: version.failReason,
    rounds: version.round,
    compileSec: Math.round((Date.now() - started) / 100) / 10,
    costUsd: version.costUsd,
    inputSchema: version.inputSchema,
    outputSchema: version.outputSchema,
    usesRoutine: (version.code.match(/ha\.routine\(/g) ?? []).length,
    loops: /for\s*\(|\.map\(|while\s*\(/.test(version.code),
    tests: tests.map((each) => ({
      id: each.id,
      state: each.routine?.state,
      stoppedAt: each.routine?.stoppedAt ?? null,
    })),
    report: version.testReport,
    codeFile: dump(`${step}-v${version.version}.js`, version.code),
    materialFile: dump(
      `${step}-v${version.version}-material.md`,
      await buildMaterial(ctx.db, {
        sourceSessionId: sessionId,
        routineId: version.routineId,
      })
        .then((material) => material.text)
        .catch((err: unknown) => `材料没建出来：${String(err)}`)
    ),
  })
  return version
}

async function approve(versionId: string) {
  const reviewed = await mutate(ctx.app, "routine.review", wang, {
    versionId,
    approve: true,
  })
  if (!reviewed.data) throw new Error(JSON.stringify(reviewed.error))
}

async function run() {
  // ---------- 1. 来源任务：查一家 ----------
  const sourceTask = await browserTask(
    "查一家供应商的电话和评分",
    `在供应商搜索 ${site.url("/b/search")} 查单上「供应商全名」这家供应商的电话和评分（注意有名字相近的别家，要看准全名）。查到后交回电话和评分。`,
    ["browser", "run.finish"]
  )
  await ctx.db
    .update(t.tasks)
    .set({
      dispatch: {
        params: [
          {
            name: "供应商全名",
            description: "要查的供应商的全名",
            required: true,
            dedupe: false,
          },
        ],
        results: [
          { name: "电话", description: "供应商详情页上的电话", required: true },
          { name: "评分", description: "供应商详情页上的评分", required: true },
        ],
        maxRunning: 1,
      },
    })
    .where(eq(t.tasks.id, sourceTask))

  let source: Awaited<ReturnType<typeof dispatchOnce>> | undefined
  for (let tryNo = 1; tryNo <= 2 && !source; tryNo++) {
    const once = await dispatchOnce(sourceTask, SOURCE_AGENT)
    write({ label: LABEL, step: "source-agent", tryNo, ...once })
    if (once.outcome === "achieved" && once.correct) source = once
  }
  if (!source)
    return write({
      label: LABEL,
      step: "skip",
      reason: "来源任务 agent 两遍都没办成",
    })
  const sourceVersion = await compile(
    "source-compile",
    source.sessionId,
    sourceTask
  )
  if (sourceVersion.status !== "review") return
  await approve(sourceVersion.id)
  for (const [index, supplier] of SOURCE_TRIAL.entries())
    write({
      label: LABEL,
      step: "source-trial",
      round: index + 1,
      ...(await dispatchOnce(sourceTask, supplier)),
    })
  const [proven] = await ctx.db
    .select()
    .from(t.routineVersions)
    .where(eq(t.routineVersions.id, sourceVersion.id))
  const [sourceRoutine] = await ctx.db
    .select()
    .from(t.routines)
    .where(eq(t.routines.id, sourceVersion.routineId))
  write({
    label: LABEL,
    step: "source-proven",
    provenAt: proven?.provenAt ?? null,
    routineStatus: sourceRoutine?.status,
    directStreak: sourceRoutine?.directStreak,
  })
  if (!proven?.provenAt) {
    // 试用期没连着办成 3 次：按约定直接写（记下来）
    await ctx.db
      .update(t.routineVersions)
      .set({ provenAt: new Date() })
      .where(eq(t.routineVersions.id, sourceVersion.id))
    await ctx.db
      .update(t.routines)
      .set({ status: "active" })
      .where(eq(t.routines.id, sourceVersion.routineId))
    write({ label: LABEL, step: "source-proven", manualProven: true })
  }

  // ---------- 2. 主管发布进库 ----------
  const preview = await query(ctx.app, "routineLibrary.preview", lin, {
    routineId: sourceVersion.routineId,
    version: sourceVersion.version,
    slug: SLUG,
  })
  const toolSchema = toolSchemaOf(sourceVersion.inputSchema)
  write({
    label: LABEL,
    step: "preview",
    preview: preview.data ?? preview.error,
    toolParams: toolSchema.params,
    jsonSchema: toolSchema.jsonSchema,
  })
  const published = await mutate(ctx.app, "routineLibrary.publish", lin, {
    routineId: sourceVersion.routineId,
    version: sourceVersion.version,
    slug: SLUG,
    title: "查供应商电话和评分",
    summary: "要查某一家供应商的电话和评分时用（按全名查）",
  })
  write({
    label: LABEL,
    step: "publish",
    result: published.data ?? published.error,
  })
  if (!published.data) return
  const toolId = `routine.${SLUG}`

  // ---------- 3. 对照：不选库流程 ----------
  const plainTask = await browserTask("基准 B（不选库流程）", wholeGoal(), [
    "browser",
    "run.finish",
  ])
  for (let round = 1; round <= BASELINE; round++)
    write({
      label: LABEL,
      step: "baseline",
      round,
      ...(await wholeOnce(plainTask)),
    })

  // ---------- 4. 场景 B 整件事选用库流程 ----------
  const callerTask = await browserTask("基准 B（选用库流程）", wholeGoal(), [
    "browser",
    "run.finish",
    toolId,
  ])
  let callerSource: string | undefined
  for (let round = 1; round <= CALLER; round++) {
    const once = await wholeOnce(callerTask)
    write({ label: LABEL, step: "caller-agent", round, ...once })
    if (
      !callerSource &&
      once.outcome === "achieved" &&
      once.correct === once.total &&
      once.library.toolCalls.length
    )
      callerSource = once.sessionId
  }
  const library = await query(ctx.app, "routineLibrary.get", lin, {
    routineId: sourceVersion.routineId,
  })
  write({
    label: LABEL,
    step: "library-after-agent",
    detail: library.data ?? library.error,
  })
  if (!callerSource)
    return write({
      label: LABEL,
      step: "skip",
      reason: "选用库流程的任务没有用了库流程、又办成的运行，不固化",
    })

  // ---------- 5. 固化整件事，照脚本跑 ----------
  const callerVersion = await compile(
    "caller-compile",
    callerSource,
    callerTask
  )
  if (callerVersion.status !== "review") return
  await approve(callerVersion.id)
  for (let round = 1; round <= REPEAT; round++)
    write({
      label: LABEL,
      step: "caller-routine",
      round,
      ...(await wholeOnce(callerTask)),
    })
  const after = await query(ctx.app, "routineLibrary.get", lin, {
    routineId: sourceVersion.routineId,
  })
  write({
    label: LABEL,
    step: "library-after-script",
    detail: after.data ?? after.error,
  })
}

describe("流程库基准", () => {
  it(`${LABEL} B`, () => run(), 120 * 60_000)
})
