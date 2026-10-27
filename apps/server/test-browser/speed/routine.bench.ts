// 固化的真模型基准（花钱，docs/dev/solidify.md 第 13 节 P1 验收）：每个场景
// 1. 先让 agent（真的 DeepSeek）办成一次，和 speed.bench.ts 一样；
// 2. 「固化成流程」：真的固化模型写脚本，真 Chrome 在基准站点上试跑（走到第一次提交前停），等到待审核；
// 3. 审核启用，再按同一个任务跑 ROUTINE_REPEAT 遍：先跑脚本，不调执行模型（只有复核那一次）。
// 每一步一行 JSON 追加进 SPEED_OUT：总时间、模型调用次数、花费、做对几项、脚本直接办成还是交给了 agent。
// 用法：scripts/speed-bench.sh <标签> [场景] [遍数]，环境变量 SPEED_FILE=routine 选这个文件（见 vitest.speed.config.ts）
import { appendFileSync } from "node:fs"

import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, it } from "vitest"

import * as t from "../../src/db/schema.js"
import { configureEngine } from "../../src/engine/runtime.js"
import { encrypt, mask } from "../../src/lib/crypto.js"
import { createTask, eventsOf, sessionRow, setupEngine, waitStatus, type EngineTestContext } from "../../test/engine-helpers.js"
import { login, mutate } from "../../test/helpers.js"
import { createProfile } from "../fixtures.js"
import { LETTERS, PRODUCTS, score, startSpeedSite, SUPPLIERS, TARGET_SUPPLIERS, type SpeedSite } from "./site.js"

const MODEL = process.env.SPEED_MODEL ?? "openrouter/deepseek/deepseek-v4.1-flash-1017"
/** 写脚本的模型（模型页「固化」）：默认用比执行模型强一些的 */
const SOLIDIFY_MODEL = process.env.ROUTINE_SOLIDIFY_MODEL ?? "openrouter/deepseek/deepseek-v4-pro"
const LABEL = process.env.SPEED_LABEL ?? "routine"
const SCENARIOS = (process.env.SPEED_SCENARIOS ?? "A,B,C").split(",").filter(Boolean) as ("A" | "B" | "C")[]
const REPEAT = Number(process.env.SPEED_REPEAT ?? 3)
/** agent 第一遍没做对时最多再试几遍（固化要从办成的运行来） */
const AGENT_TRIES = Number(process.env.ROUTINE_AGENT_TRIES ?? 2)
const OUT = process.env.SPEED_OUT
const RUN_TIMEOUT = 25 * 60_000
const COMPILE_TIMEOUT = 30 * 60_000

let ctx: EngineTestContext
let site: SpeedSite
let wang: string
let profileId: string

function goalOf(scenario: "A" | "B" | "C") {
  if (scenario === "A")
    return `把 ${site.url("/a/products")} 上列的 ${PRODUCTS.length} 个商品逐个录入 ERP：在 ${site.url("/a/new")} 填好编号、名称、单价、起订量、类目、含税，每个商品提交一次（不要重复提交）。${PRODUCTS.length} 个都录完后结束。`
  if (scenario === "B")
    return `在供应商搜索 ${site.url("/b/search")} 查下面 ${TARGET_SUPPLIERS.length} 家供应商的电话和评分（注意有名字相近的别家，要看准全名）：${TARGET_SUPPLIERS.map((id) => SUPPLIERS.find((each) => each.id === id)!.name).join("、")}。查完后到 ${site.url("/b/report")} 提交汇总，每行一家，格式「名称,电话,评分」，名称写全名。`
  return `在线文档 ${site.url("/c/doc")} 是一张字母图片表，按 ${LETTERS.join("、")} 每行放一张图：图片到 ${site.url("/c/search?q=letter+A")} 这样的网址搜（把 A 换成对应字母），选「大写字母 X」那张（X 是这一行的字母），复制图片，贴进文档里这个字母那一行的图片格。${LETTERS.length} 行都贴好、没有贴错的后结束。`
}

async function ensureModel(id: string, providerId: string) {
  const [model] = await ctx.db.select().from(t.models).where(eq(t.models.id, id))
  if (!model) await ctx.db.insert(t.models).values({ id, providerId, name: id, contextK: 1000, priceIn: 0.3, priceOut: 1.2 })
}

async function useRealModels() {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("没有 OPENROUTER_API_KEY")
  const [provider] = await ctx.db.select().from(t.modelProviders).where(eq(t.modelProviders.kind, "openrouter"))
  if (!provider) throw new Error("种子里没有 OpenRouter 模型服务")
  const secretId = provider.apiKeySecretId ?? `sec-provider-${provider.id}`
  const [old] = await ctx.db.select().from(t.secrets).where(eq(t.secrets.id, secretId))
  const version = (old?.version ?? 0) + 1
  const enc = encrypt(ctx.keyring, apiKey, { table: "secrets", id: secretId, version })
  if (old) await ctx.db.update(t.secrets).set({ enc, version, masked: mask(apiKey) }).where(eq(t.secrets.id, secretId))
  else await ctx.db.insert(t.secrets).values({ id: secretId, scope: "model_provider", refId: provider.id, name: "api_key", version, enc, masked: mask(apiKey) })
  await ctx.db.update(t.modelProviders).set({ apiKeySecretId: secretId, status: "ok", baseUrl: "https://openrouter.ai/api/v1" }).where(eq(t.modelProviders.id, provider.id))
  await ensureModel(MODEL, provider.id)
  await ensureModel(SOLIDIFY_MODEL, provider.id)
  // 模型页「固化」的默认模型
  await ctx.db
    .insert(t.modelDefaults)
    .values({ role: "solidify", modelId: SOLIDIFY_MODEL })
    .onConflictDoUpdate({ target: t.modelDefaults.role, set: { modelId: SOLIDIFY_MODEL } })
  configureEngine({ modelFactory: undefined })
}

beforeAll(async () => {
  ctx = await setupEngine()
  site = await startSpeedSite()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  profileId = await createProfile(ctx.db, ctx.keyring)
  await useRealModels()
  const res = await mutate(ctx.app, "settings.updateBrowser", await login(ctx.app, "linzhou@heyagent.local"), {
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

const write = (record: Record<string, unknown>) => {
  console.log(JSON.stringify(record))
  if (OUT) appendFileSync(OUT, `${JSON.stringify(record)}\n`)
}

/** 跑一遍任务（agent 或脚本），等到结束、复核完 */
async function runOnce(scenario: "A" | "B" | "C", taskId: string) {
  site.reset()
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  const sessionId = res.data.sessionId as string
  let status = "timeout"
  try {
    status = (await waitStatus(ctx.db, sessionId, ["done", "failed", "cancelled", "needs_human", "verifying"], RUN_TIMEOUT)).status
    if (status === "verifying" || status === "done") status = (await waitStatus(ctx.db, sessionId, ["done", "failed"], 5 * 60_000).catch(() => ({ status }))).status
    // 复核出结果（不算进总时间）
    for (let i = 0; i < 150 && !(await sessionRow(ctx.db, sessionId))?.outcome; i++) await new Promise((resolve) => setTimeout(resolve, 2000))
  } catch {
    await mutate(ctx.app, "engine.cancel", wang, { sessionId }).catch(() => {})
  }
  const row = (await sessionRow(ctx.db, sessionId))!
  const events = await eventsOf(ctx.db, sessionId)
  const finish = [...events].reverse().find((event) => event.toolId === "run.finish")
  const end = (finish?.at ?? row.endedAt ?? new Date()).getTime()
  const think = events.filter((event) => event.kind === "think")
  const tools = events.filter((event) => event.kind === "tool")
  const graded = score(scenario, site.results)
  return {
    sessionId,
    status,
    outcome: row.outcome,
    routine: row.routine ? { state: row.routine.state, steps: row.routine.steps, stoppedAt: row.routine.stoppedAt ?? null } : null,
    wallSec: Math.round((end - row.startedAt.getTime()) / 100) / 10,
    modelCalls: think.length,
    toolCalls: tools.length,
    costUsd: row.costUsd,
    correct: graded.correct,
    total: graded.total,
    notes: graded.notes,
  }
}

/** 等这一版写好、试跑完（待审核）或者没成功 */
async function waitVersion(versionId: string) {
  const deadline = Date.now() + COMPILE_TIMEOUT
  for (;;) {
    const [version] = await ctx.db.select().from(t.routineVersions).where(eq(t.routineVersions.id, versionId))
    if (version && (version.status === "review" || version.status === "failed")) return version
    if (Date.now() > deadline) throw new Error(`固化 ${versionId} 等了 ${COMPILE_TIMEOUT / 60_000} 分钟还没好（现在 ${version?.status}）`)
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

async function runScenario(scenario: "A" | "B" | "C") {
  const taskId = await createTask(ctx.db, { modelId: MODEL, title: `固化基准 ${scenario}`, goal: goalOf(scenario), toolIds: ["browser", "run.finish"], ownerId: "u-wang", reviewModelId: MODEL })
  await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], allowBrowserVision: scenario === "C" }).where(eq(t.tasks.id, taskId))

  // 1. agent 办成一次
  let source: Awaited<ReturnType<typeof runOnce>> | undefined
  for (let tryNo = 1; tryNo <= AGENT_TRIES && !source; tryNo++) {
    const run = await runOnce(scenario, taskId)
    write({ label: LABEL, scenario, step: "agent", tryNo, ...run })
    if (run.outcome === "achieved" && run.correct === run.total) source = run
  }
  if (!source) {
    write({ label: LABEL, scenario, step: "skip", reason: `agent ${AGENT_TRIES} 遍都没做对，没法固化` })
    return
  }

  // 2. 固化成流程，等待审核
  const compileStarted = Date.now()
  const compiled = await mutate(ctx.app, "routine.compile", wang, { sessionId: source.sessionId })
  if (!compiled.data) throw new Error(JSON.stringify(compiled.error))
  const version = await waitVersion(compiled.data.versionId as string)
  const tests = await ctx.db
    .select({ id: t.sessions.id, routine: t.sessions.routine })
    .from(t.sessions)
    .where(and(eq(t.sessions.taskId, taskId), eq(t.sessions.kind, "routine_test")))
  write({
    label: LABEL,
    scenario,
    step: "compile",
    versionId: version.id,
    status: version.status,
    failReason: version.failReason,
    rounds: version.round,
    compileSec: Math.round((Date.now() - compileStarted) / 100) / 10,
    costUsd: version.costUsd,
    modelId: version.modelId,
    tests: tests.map((each) => ({ id: each.id, state: each.routine?.state, stoppedAt: each.routine?.stoppedAt ?? null })),
    report: version.testReport,
  })
  if (version.status !== "review") return

  // 3. 审核启用，再跑几遍
  const reviewed = await mutate(ctx.app, "routine.review", wang, { versionId: version.id, approve: true })
  if (!reviewed.data) throw new Error(JSON.stringify(reviewed.error))
  for (let round = 1; round <= REPEAT; round++) write({ label: LABEL, scenario, step: "routine", round, ...(await runOnce(scenario, taskId)) })
}

describe("固化基准", () => {
  for (const scenario of SCENARIOS) it(`${LABEL} ${scenario}`, () => runScenario(scenario), (AGENT_TRIES + REPEAT) * (RUN_TIMEOUT + 6 * 60_000) + COMPILE_TIMEOUT)
})
