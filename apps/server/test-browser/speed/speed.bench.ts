// 浏览器提速的真模型基准（花钱，不在 pnpm test 和 scripts/browser-test.sh 里跑）：用真的 DeepSeek 跑 site.ts 的三个场景，
// 记下每次运行的总时间、模型调用次数、工具调用次数、花费、做对几项，追加写进 SPEED_OUT（JSON 一行一条）。
// 用法见 docs/dev/browser-speed.md：scripts/speed-bench.sh <标签> [场景，默认 A,B,C] [每个场景跑几遍，默认 1]
import { appendFileSync } from "node:fs"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, it } from "vitest"

import * as t from "../../src/db/schema.js"
import { configureEngine } from "../../src/engine/runtime.js"
import { encrypt, mask } from "../../src/lib/crypto.js"
import { createTask, eventsOf, sessionRow, setupEngine, waitStatus, type EngineTestContext } from "../../test/engine-helpers.js"
import { login, mutate } from "../../test/helpers.js"
import { createProfile } from "../fixtures.js"
import { LETTERS, PRODUCTS, score, startSpeedSite, SUPPLIERS, TARGET_SUPPLIERS, type SpeedScenario, type SpeedSite } from "./site.js"

const MODEL = process.env.SPEED_MODEL ?? "openrouter/deepseek/deepseek-v4.1-flash-1017"
const LABEL = process.env.SPEED_LABEL ?? "run"
const SCENARIOS = (process.env.SPEED_SCENARIOS ?? "A,B,C").split(",").filter(Boolean) as SpeedScenario[]
const REPEAT = Number(process.env.SPEED_REPEAT ?? 1)
/** 任务的工具（逗号分隔）。加上 code.run 看 agent 会不会自己写循环脚本（docs/dev/solidify.md 18.1） */
const TOOLS = (process.env.SPEED_TOOLS ?? "browser,run.finish").split(",").filter(Boolean)
const OUT = process.env.SPEED_OUT
const RUN_TIMEOUT = 25 * 60_000

let ctx: EngineTestContext
let site: SpeedSite
let wang: string
let profileId: string

function goalOf(scenario: SpeedScenario) {
  if (scenario === "A")
    return `把 ${site.url("/a/products")} 上列的 ${PRODUCTS.length} 个商品逐个录入 ERP：在 ${site.url("/a/new")} 填好编号、名称、单价、起订量、类目、含税，每个商品提交一次（不要重复提交）。${PRODUCTS.length} 个都录完后结束。`
  if (scenario === "D")
    return `${site.url("/d/requests")} 上有几条采购需求。每条需求在商品目录 ${site.url("/d/catalog")} 里挑一个最符合的商品，到 ${site.url("/d/order")} 下单：选需求编号和商品，点提交，每条需求只提交一次。所有需求都下单后结束。`
  if (scenario === "B")
    return `在供应商搜索 ${site.url("/b/search")} 查下面 ${TARGET_SUPPLIERS.length} 家供应商的电话和评分（注意有名字相近的别家，要看准全名）：${TARGET_SUPPLIERS.map((id) => SUPPLIERS.find((each) => each.id === id)!.name).join("、")}。查完后到 ${site.url("/b/report")} 提交汇总，每行一家，格式「名称,电话,评分」，名称写全名。`
  return `在线文档 ${site.url("/c/doc")} 是一张字母图片表，按 ${LETTERS.join("、")} 每行放一张图：图片到 ${site.url("/c/search?q=letter+A")} 这样的网址搜（把 A 换成对应字母），选「大写字母 X」那张（X 是这一行的字母），复制图片，贴进文档里这个字母那一行的图片格。${LETTERS.length} 行都贴好、没有贴错的后结束。`
}

async function useRealModel() {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new Error("没有 OPENROUTER_API_KEY")
  // 种子里的 OpenRouter 模型服务是假 key：换成真的；模型走真的 OpenRouter（不用测试剧本）
  const [provider] = await ctx.db.select().from(t.modelProviders).where(eq(t.modelProviders.kind, "openrouter"))
  if (!provider) throw new Error("种子里没有 OpenRouter 模型服务")
  const secretId = provider.apiKeySecretId ?? `sec-provider-${provider.id}`
  const [old] = await ctx.db.select().from(t.secrets).where(eq(t.secrets.id, secretId))
  const version = (old?.version ?? 0) + 1
  const enc = encrypt(ctx.keyring, apiKey, { table: "secrets", id: secretId, version })
  if (old) await ctx.db.update(t.secrets).set({ enc, version, masked: mask(apiKey) }).where(eq(t.secrets.id, secretId))
  else await ctx.db.insert(t.secrets).values({ id: secretId, scope: "model_provider", refId: provider.id, name: "api_key", version, enc, masked: mask(apiKey) })
  await ctx.db.update(t.modelProviders).set({ apiKeySecretId: secretId, status: "ok", baseUrl: "https://openrouter.ai/api/v1" }).where(eq(t.modelProviders.id, provider.id))
  const [model] = await ctx.db.select().from(t.models).where(eq(t.models.id, MODEL))
  // 能看图（DeepSeek V4.1 Flash 能）：复核带得上最后一张截图，和正式环境一样
  const vision = process.env.SPEED_MODEL_VISION !== "0"
  if (!model) await ctx.db.insert(t.models).values({ id: MODEL, providerId: provider.id, name: MODEL, contextK: 1000, priceIn: 0.3, priceOut: 1.2, vision })
  else if (model.vision !== vision) await ctx.db.update(t.models).set({ vision }).where(eq(t.models.id, MODEL))
  configureEngine({ modelFactory: undefined })
}

beforeAll(async () => {
  ctx = await setupEngine()
  site = await startSpeedSite()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  profileId = await createProfile(ctx.db, ctx.keyring)
  await useRealModel()
  // 和浏览器测试一样：不开视觉判断、不自动过验证码（基准站点没有验证码）
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

async function runScenario(scenario: SpeedScenario, round: number) {
  site.reset()
  const taskId = await createTask(ctx.db, { modelId: MODEL, title: `基准 ${scenario}`, goal: goalOf(scenario), toolIds: TOOLS, ownerId: "u-wang", reviewModelId: MODEL })
  // C 和 R-1-2 一样开着「允许看画面」
  await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], allowBrowserVision: scenario === "C" }).where(eq(t.tasks.id, taskId))
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  const sessionId = res.data.sessionId as string
  let status = "timeout"
  try {
    status = (await waitStatus(ctx.db, sessionId, ["done", "failed", "cancelled", "needs_human", "verifying"], RUN_TIMEOUT)).status
    // 复核在结束后跑：等它出结果（不算进总时间）
    if (status === "verifying" || status === "done") status = (await waitStatus(ctx.db, sessionId, ["done", "failed"], 5 * 60_000).catch(() => ({ status }))).status
  } catch {
    await mutate(ctx.app, "engine.cancel", wang, { sessionId }).catch(() => {})
  }
  const row = (await sessionRow(ctx.db, sessionId))!
  const events = await eventsOf(ctx.db, sessionId)
  const finish = events.find((event) => event.toolId === "run.finish")
  const started = row.startedAt.getTime()
  const end = (finish?.at ?? row.endedAt ?? new Date()).getTime()
  const think = events.filter((event) => event.kind === "think")
  const tools = events.filter((event) => event.kind === "tool")
  const byTool: Record<string, number> = {}
  for (const event of tools) byTool[event.toolId ?? "?"] = (byTool[event.toolId ?? "?"] ?? 0) + 1
  const graded = score(scenario, site.results)
  const record = {
    label: LABEL,
    scenario,
    round,
    sessionId,
    status,
    outcome: row.outcome,
    wallSec: Math.round((end - started) / 100) / 10,
    modelCalls: think.length,
    thinkSec: Math.round(think.reduce((sum, event) => sum + (event.ms ?? 0), 0) / 100) / 10,
    toolCalls: tools.length,
    toolSec: Math.round(tools.reduce((sum, event) => sum + (event.ms ?? 0), 0) / 100) / 10,
    toolErrors: tools.filter((event) => event.title.endsWith("（出错）")).length,
    // agent 写的脚本（code.run 带 tools）：跑了几次、脚本里做了几步
    codeRuns: tools.filter((event) => event.toolId === "code.run").length,
    scriptSteps: tools.filter((event) => event.trace?.scriptStep).length,
    tokensIn: think.reduce((sum, event) => sum + (event.tokensIn ?? 0), 0),
    maxTokensIn: Math.max(0, ...think.map((event) => event.tokensIn ?? 0)),
    costUsd: row.costUsd,
    correct: graded.correct,
    total: graded.total,
    notes: graded.notes,
    byTool,
  }
  console.log(JSON.stringify(record))
  if (OUT) appendFileSync(OUT, `${JSON.stringify(record)}\n`)
}

describe("浏览器提速基准", () => {
  for (const scenario of SCENARIOS)
    for (let round = 1; round <= REPEAT; round++)
      it(`${LABEL} ${scenario} 第 ${round} 遍`, () => runScenario(scenario, round), RUN_TIMEOUT + 6 * 60_000)
})
