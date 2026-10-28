// 固化的真模型基准（花钱，docs/dev/solidify.md 第 13 节 P1 验收）：每个场景
// 1. 先让 agent（真的 DeepSeek）办成一次，和 speed.bench.ts 一样；
// 2. 「固化成流程」：真的固化模型写脚本，真 Chrome 在基准站点上试跑（走到第一次提交前停），等到待审核；
// 3. 审核启用，再按同一个任务跑 ROUTINE_REPEAT 遍：先跑脚本，不调执行模型（只有复核那一次）。
// 每一步一行 JSON 追加进 SPEED_OUT：总时间、模型调用次数、花费、做对几项、脚本直接办成还是交给了 agent。
// 用法：scripts/speed-bench.sh <标签> [场景] [遍数]，环境变量 SPEED_FILE=routine 选这个文件（见 vitest.speed.config.ts）
import { appendFileSync, writeFileSync } from "node:fs"

import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, it } from "vitest"

import * as t from "../../src/db/schema.js"
import { configureEngine } from "../../src/engine/runtime.js"
import { readFileData } from "../../src/files/service.js"
import { encrypt, mask } from "../../src/lib/crypto.js"
import { buildMaterial } from "../../src/routine/material.js"
import { createTask, eventsOf, sessionRow, setupEngine, waitStatus, type EngineTestContext } from "../../test/engine-helpers.js"
import { login, mutate } from "../../test/helpers.js"
import { createProfile } from "../fixtures.js"
import { E_ITEMS, E_TARGETS, LETTERS, PRODUCTS, score, startSpeedSite, SUPPLIERS, TARGET_SUPPLIERS, type SpeedScenario, type SpeedSite } from "./site.js"

const MODEL = process.env.SPEED_MODEL ?? "openrouter/deepseek/deepseek-v4.1-flash-1017"
/** 写脚本的模型（模型页「固化」）：默认用比执行模型强一些的 */
const SOLIDIFY_MODEL = process.env.ROUTINE_SOLIDIFY_MODEL ?? "openrouter/deepseek/deepseek-v4-pro"
const LABEL = process.env.SPEED_LABEL ?? "routine"
const SCENARIOS = (process.env.SPEED_SCENARIOS ?? "A,B,C").split(",").filter(Boolean) as SpeedScenario[]
const REPEAT = Number(process.env.SPEED_REPEAT ?? 3)
/** 任务的工具（逗号分隔）。加上 code.run：agent 可能自己写循环脚本，固化员照它写（docs/dev/solidify.md 18.1） */
const TOOLS = (process.env.SPEED_TOOLS ?? "browser,run.finish").split(",").filter(Boolean)
/** agent 第一遍没做对时最多再试几遍（固化要从办成的运行来） */
const AGENT_TRIES = Number(process.env.ROUTINE_AGENT_TRIES ?? 2)
const OUT = process.env.SPEED_OUT
const RUN_TIMEOUT = 25 * 60_000
const COMPILE_TIMEOUT = 30 * 60_000

let ctx: EngineTestContext
let site: SpeedSite
let wang: string
let profileId: string

function goalOf(scenario: SpeedScenario) {
  if (scenario === "A")
    return `把 ${site.url("/a/products")} 上列的 ${PRODUCTS.length} 个商品逐个录入 ERP：在 ${site.url("/a/new")} 填好编号、名称、单价、起订量、类目、含税，每个商品提交一次（不要重复提交）。${PRODUCTS.length} 个都录完后结束。`
  if (scenario === "D")
    return `${site.url("/d/requests")} 上有几条采购需求。每条需求在商品目录 ${site.url("/d/catalog")} 里挑一个最符合的商品，到 ${site.url("/d/order")} 下单：选需求编号和商品，点提交，每条需求只提交一次。所有需求都下单后结束。`
  if (scenario === "E")
    return `在采购系统的商品列表 ${site.url("/e/list")} 查下面 ${E_TARGETS.length} 个商品的单价和供应商（每样商品都有标准款和加大款，要看准）：${E_TARGETS.map((code) => E_ITEMS.find((each) => each.code === code)!.name).join("、")}。列表一页只显示 8 个，要翻页。查完后到 ${site.url("/e/report")} 提交汇总，每行一个商品，格式「名称,单价,供应商」，名称照列表写全（带款式）。`
  if (scenario === "F")
    return `在采购系统的商品列表 ${site.url("/e/list")} 查下面 ${E_TARGETS.length} 个商品的单价、供应商和库存（每样商品都有标准款和加大款，要看准）：${E_TARGETS.map((code) => E_ITEMS.find((each) => each.code === code)!.name).join("、")}。列表一页只显示 8 个，要翻页。查完后到 ${site.url("/e/report")} 提交汇总，每行一个商品，格式「名称,单价,供应商,库存」，名称照列表写全（带款式）。`
  if (scenario === "B")
    return `在供应商搜索 ${site.url("/b/search")} 查下面 ${TARGET_SUPPLIERS.length} 家供应商的电话和评分（注意有名字相近的别家，要看准全名）：${TARGET_SUPPLIERS.map((id) => SUPPLIERS.find((each) => each.id === id)!.name).join("、")}。查完后到 ${site.url("/b/report")} 提交汇总，每行一家，格式「名称,电话,评分」，名称写全名。`
  return `在线文档 ${site.url("/c/doc")} 是一张字母图片表，按 ${LETTERS.join("、")} 每行放一张图：图片到 ${site.url("/c/search?q=letter+A")} 这样的网址搜（把 A 换成对应字母），选「大写字母 X」那张（X 是这一行的字母），复制图片，贴进文档里这个字母那一行的图片格。${LETTERS.length} 行都贴好、没有贴错的后结束。`
}

/** vision：模型能不能看图（执行、复核用的 DeepSeek V4.1 Flash 能看图：复核才带得上最后一张截图，和正式环境一样） */
async function ensureModel(id: string, providerId: string, vision: boolean) {
  const [model] = await ctx.db.select().from(t.models).where(eq(t.models.id, id))
  if (!model) await ctx.db.insert(t.models).values({ id, providerId, name: id, contextK: 1000, priceIn: 0.3, priceOut: 1.2, vision })
  else if (model.vision !== vision) await ctx.db.update(t.models).set({ vision }).where(eq(t.models.id, id))
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
  await ensureModel(MODEL, provider.id, process.env.SPEED_MODEL_VISION !== "0")
  await ensureModel(SOLIDIFY_MODEL, provider.id, false)
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

/** 存到 SPEED_OUT 旁边的文件（E：记下的接口、脚本），跑完测试库会被下一次清空 */
const dump = (suffix: string, content: string) => {
  if (!OUT) return undefined
  const path = OUT.replace(/\.jsonl$/, `-${suffix}`)
  writeFileSync(path, content)
  return path
}

/** 这次运行记下的接口（network/requests.jsonl）：存一份，返回行数和摘要 */
async function networkLogOf(sessionId: string) {
  const [row] = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "network")))
  if (!row) return null
  const text = (await readFileData(row)).toString("utf8")
  const lines = text.split("\n").filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>)
  return {
    file: dump(`${sessionId}-requests.jsonl`, text),
    path: row.path ?? row.name,
    lines: lines.length,
    requests: lines.filter((line) => !line.end).map((line) => `${line.seq} ${line.method} ${String(line.url).replace(/^https?:\/\/[^/]+/, "")} → ${line.status} cookie=${(line.auth as { cookie?: boolean } | undefined)?.cookie} auth=${JSON.stringify((line.auth as { headers?: string[] } | undefined)?.headers ?? [])}`),
  }
}

const write = (record: Record<string, unknown>) => {
  console.log(JSON.stringify(record))
  if (OUT) appendFileSync(OUT, `${JSON.stringify(record)}\n`)
}

/** 跑一遍任务（agent 或脚本），等到结束、复核完 */
async function runOnce(scenario: SpeedScenario, taskId: string) {
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
  const byTool: Record<string, number> = {}
  for (const event of tools) byTool[event.toolId ?? "?"] = (byTool[event.toolId ?? "?"] ?? 0) + 1
  return {
    sessionId,
    status,
    outcome: row.outcome,
    routine: row.routine ? { state: row.routine.state, steps: row.routine.steps, stoppedAt: row.routine.stoppedAt ?? null } : null,
    wallSec: Math.round((end - row.startedAt.getTime()) / 100) / 10,
    modelCalls: think.length,
    toolCalls: tools.length,
    codeRuns: tools.filter((event) => event.toolId === "code.run").length,
    scriptSteps: tools.filter((event) => event.trace?.scriptStep).length,
    costUsd: row.costUsd,
    correct: graded.correct,
    total: graded.total,
    notes: graded.notes,
    byTool,
    ...(scenario === "E" || scenario === "F" ? { eHits: { ...site.results.eHits }, network: await networkLogOf(sessionId) } : {}),
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

async function runScenario(scenario: SpeedScenario) {
  const taskId = await createTask(ctx.db, { modelId: MODEL, title: `固化基准 ${scenario}`, goal: goalOf(scenario), toolIds: TOOLS, ownerId: "u-wang", reviewModelId: MODEL })
  await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], allowBrowserVision: scenario === "C", allowBrowserFetch: scenario === "E" || scenario === "F" }).where(eq(t.tasks.id, taskId))

  // 1. agent 办成一次
  let source: Awaited<ReturnType<typeof runOnce>> | undefined
  for (let tryNo = 1; tryNo <= AGENT_TRIES && !source; tryNo++) {
    const run = await runOnce(scenario, taskId)
    write({ label: LABEL, scenario, step: "agent", tryNo, ...run })
    if (run.status === "done" && run.correct === run.total && run.outcome !== "achieved") {
      // 站点判分全对、复核却判没办成（复核看错了）：像人一样「改结果」，再拿它固化。记一行，复核的准确率另算
      const fixed = await mutate(ctx.app, "sessions.setOutcome", wang, { id: run.sessionId, outcome: "achieved", reason: "基准站点判分全对，复核判错了" })
      if (!fixed.data) throw new Error(JSON.stringify(fixed.error))
      write({ label: LABEL, scenario, step: "fix-outcome", tryNo, sessionId: run.sessionId, reviewSaid: run.outcome })
      run.outcome = "achieved"
    }
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
    httpSuggestions: version.httpSuggestions,
    usesFetch: version.code.includes("ha.browser.fetch"),
    codeFile: dump(`${scenario}-v${version.version}.js`, version.code),
    // 固化员拿到的材料（看「网页调过的接口」一节在不在、写了什么）：测试的文件存在容器里，跑完就没了，这里存一份
    materialFile: dump(
      `${scenario}-v${version.version}-material.md`,
      await buildMaterial(ctx.db, { sourceSessionId: source.sessionId, routineId: version.routineId })
        .then((material) => `networkSeqs: ${JSON.stringify(material.networkSeqs ?? null)}\n\n${material.text}`)
        .catch((err: unknown) => `材料没建出来：${String(err)}`)
    ),
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
