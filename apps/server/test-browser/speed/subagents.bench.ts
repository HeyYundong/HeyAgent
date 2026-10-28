// 子 agent 的真模型验收（花钱，docs/dev/sub-agents.md 第 13 节最后「真模型」四条、第 21 节记录）：
// S1 不用浏览器：附 3 个读数文件，每个拆一个子 agent 用「运行代码」算统计，父汇总成表；S1seq 同样的事不拆（对比用时）
// S2 Chrome 不够：任务只允许 2 个 Chrome，拆 3 个用浏览器的子 agent 各查一家供应商（基准站点 /b/s/<id>）；S2seq 同样的事不拆（对比用时）
// S3 有一个做不到：同 S2，其中一家的页面不存在（404「没有这家供应商」）
// S4 取消：同 S2（每次运行同时最多 2 个子 agent），子 agent 在用 Chrome 时取消父运行
// S5 够大的任务：基准站点场景 B（搜 6 家供应商、最后提交汇总表单），任务允许 3 个 Chrome，建议拆 3 组各 2 家；S5seq 同一个任务不拆
// 每遍之前 1 分钟负载超过 8 先等（SPEED_MAX_LOAD 换）；场景可以重复写（S5,S5seq,S5,S5seq 交替跑）
// 每个场景一行 JSON 追加进 SPEED_OUT；过程（子 agent 状态变化、提示词、交回的结果、过程记录）存到旁边的 -<场景>.json。
// 用法：SPEED_FILE=subagents scripts/speed-bench.sh <标签> [场景，默认 S1,S1seq,S2,S3,S4；另有 S2seq、S5、S5seq，可以重复写]
import {
  appendFileSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs"

import { and, eq, inArray, ne } from "drizzle-orm"
import { afterAll, beforeAll, describe, it } from "vitest"

import * as t from "../../src/db/schema.js"
import { buildSystemPrompt, subagentSection } from "../../src/engine/prompt.js"
import { configureEngine } from "../../src/engine/runtime.js"
import { listSubagents } from "../../src/engine/subagents/view.js"
import { encrypt, mask } from "../../src/lib/crypto.js"
import {
  createTask,
  eventsOf,
  sessionRow,
  setupEngine,
  waitFor,
  waitStatus,
  type EngineTestContext,
} from "../../test/engine-helpers.js"
import { login, mutate } from "../../test/helpers.js"
import { createProfile } from "../fixtures.js"
import {
  score as siteScore,
  startSpeedSite,
  SUPPLIERS,
  TARGET_SUPPLIERS,
  type SpeedSite,
} from "./site.js"

const MODEL =
  process.env.SPEED_MODEL ?? "openrouter/deepseek/deepseek-v4.1-flash-1017"
const LABEL = process.env.SPEED_LABEL ?? "subagents"
const SCENARIOS = (process.env.SPEED_SCENARIOS ?? "S1,S1seq,S2,S3,S4")
  .split(",")
  .filter(Boolean)
const OUT = process.env.SPEED_OUT
const RUN_TIMEOUT = 15 * 60_000
const MAX_LOAD = Number(process.env.SPEED_MAX_LOAD ?? 8)

let ctx: EngineTestContext
let site: SpeedSite
let wang: string
let lin: string
let profiles: string[] = []

const dump = (suffix: string, content: unknown) => {
  // 同一个场景跑几遍：文件名带运行编号，不互相覆盖
  if (!OUT) return undefined
  const path = OUT.replace(/\.jsonl$/, `-${suffix}.json`)
  writeFileSync(path, JSON.stringify(content, null, 2))
  return path
}

async function useRealModel() {
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
  const [model] = await ctx.db
    .select()
    .from(t.models)
    .where(eq(t.models.id, MODEL))
  if (!model)
    await ctx.db.insert(t.models).values({
      id: MODEL,
      providerId: provider.id,
      name: MODEL,
      contextK: 1000,
      priceIn: 0.3,
      priceOut: 1.2,
      vision: true,
    })
  // 测试默认重试间隔 10 毫秒（engine-helpers）：真模型照正式环境 2 秒起翻倍，外网抖一下不至于 3 次重试都撞上（第 21 节第 7 条）
  configureEngine({ modelFactory: undefined, modelRetryBaseMs: 2000 })
}

/** 每个场景前设一次「子 agent」设置（第 6.1 节），返回设的值 */
async function setSubagentSettings(input: {
  maxParallel: number
  maxPerRun: number
  maxRunningGlobal: number
  maxCostUsd: number
  maxSteps: number
}) {
  const res = await mutate(ctx.app, "settings.updateSubagent", lin, input)
  if (res.error) throw new Error(JSON.stringify(res.error))
  return input
}

beforeAll(async () => {
  ctx = await setupEngine()
  site = await startSpeedSite()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  lin = await login(ctx.app, "linzhou@heyagent.local")
  profiles = [
    await createProfile(ctx.db, ctx.keyring),
    await createProfile(ctx.db, ctx.keyring),
    await createProfile(ctx.db, ctx.keyring),
  ]
  await useRealModel()
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

// ---------- S1 的数据：3 个读数文件（固定种子，每次一样） ----------

function rng(seed: number) {
  let x = seed
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648
    return x / 2147483648
  }
}
const FILES = [
  { name: "读数-甲.txt", count: 40, seed: 11 },
  { name: "读数-乙.txt", count: 55, seed: 23 },
  { name: "读数-丙.txt", count: 70, seed: 37 },
].map((file) => {
  const next = rng(file.seed)
  const values = Array.from(
    { length: file.count },
    () => 100 + Math.floor(next() * 900)
  )
  const sum = values.reduce((a, b) => a + b, 0)
  return {
    ...file,
    text: `${values.join("\n")}\n`,
    stats: {
      个数: values.length,
      合计: sum,
      平均值: (sum / values.length).toFixed(2),
      最大值: Math.max(...values),
      最小值: Math.min(...values),
    },
  }
})

async function upload(name: string, text: string) {
  const form = new FormData()
  form.append("file", new File([text], name, { type: "text/plain" }))
  const res = await ctx.app.request("/api/files", {
    method: "POST",
    body: form,
    headers: { cookie: wang },
  })
  if (res.status !== 200 && res.status !== 201)
    throw new Error(`上传失败 ${res.status} ${await res.text()}`)
  return ((await res.json()) as { id: string }).id
}

// ---------- S2–S4 的数据：基准站点的供应商页 ----------

const S2_TARGETS = ["s1", "s3", "s5"]
const S3_TARGETS = ["s7", "s9", "s99"]
const MISSING = { id: "s99", name: "宁波市海川电器有限公司" }
const supplierOf = (id: string) =>
  SUPPLIERS.find((each) => each.id === id) ?? {
    ...MISSING,
    phone: "",
    rating: "",
  }

function goalOf(scenario: string) {
  if (scenario === "S5" || scenario === "S5seq") {
    const names = TARGET_SUPPLIERS.map((id) => supplierOf(id).name)
    const base = `在供应商搜索 ${site.url("/b/search")} 查下面 ${names.length} 家供应商的电话和评分（注意有名字相近的别家，要看准全名）：${names.join("、")}。查完后到 ${site.url("/b/report")} 提交汇总，每行一家，格式「名称,电话,评分」，名称写全名。`
    if (scenario === "S5seq") return base
    const groups = [0, 2, 4].map((k) => names.slice(k, k + 2).join("、"))
    return `${base}建议分成 3 组、每组 2 家（${groups.map((g, i) => `第 ${i + 1} 组：${g}`).join("；")}），各拆一个子 agent 同时查，用 work_report 交回每家的名称、电话、评分；全部交回后你自己去提交汇总。`
  }
  const stat = "个数、合计、平均值（保留两位小数）、最大值、最小值"
  if (scenario === "S1")
    return `附件里有 ${FILES.length} 个文本文件（${FILES.map((f) => f.name).join("、")}），每个是一列数字读数，一行一个。每个文件拆一个子 agent，让它用运行代码算出这个文件的${stat}，用 work_report 交回这 5 个字段。全部交回后，你汇总成一张 Markdown 表（每个文件一行，列：文件、${stat}），写在 run_finish 的 summary 里。`
  if (scenario === "S1seq")
    return `附件里有 ${FILES.length} 个文本文件（${FILES.map((f) => f.name).join("、")}），每个是一列数字读数，一行一个。用运行代码分别算出每个文件的${stat}，汇总成一张 Markdown 表（每个文件一行，列：文件、${stat}），写在 run_finish 的 summary 里。`
  const targets = scenario === "S3" ? S3_TARGETS : S2_TARGETS
  const list = targets
    .map((id) => `${supplierOf(id).name}：${site.url(`/b/s/${id}`)}`)
    .join("；")
  if (scenario === "S2seq")
    return `查下面 ${targets.length} 家供应商的电话和评分，每家的详情页网址已经给出：${list}。用浏览器打开每家的详情页，读出电话和评分，汇总成一张 Markdown 表（列：名称、电话、评分），写在 run_finish 的 summary 里。查不到的如实写明，不要编。`
  return `查下面 ${targets.length} 家供应商的电话和评分，每家的详情页网址已经给出：${list}。每家拆一个子 agent，让它用浏览器打开这家的详情页，读出电话和评分，用 work_report 交回（字段：电话、评分）。全部交回后，你汇总成一张 Markdown 表（列：名称、电话、评分），写在 run_finish 的 summary 里。查不到的如实写明，不要编。`
}

/** 父 agent 的汇总表对不对：每个对象一行，含全部数字 */
function score(scenario: string, summary: string) {
  const lines = summary
    .split(/\r?\n/)
    .map((line) => line.replace(/\s/g, "").replace(/,/g, ""))
  const notes: string[] = []
  let correct = 0
  if (scenario.startsWith("S1")) {
    for (const file of FILES) {
      const label = file.name.replace(/\.txt$/, "")
      const want = Object.values(file.stats).map(String)
      // 平均值正好在 .xx5 上时（甲 549.125），Python round 的「四舍六入五成双」给 549.12，四舍五入给 549.13：两种都算对
      const halfEven =
        Math.round((file.stats.合计 / file.stats.个数) * 1e6) % 10_000 === 5000
          ? (
              Math.floor((file.stats.合计 / file.stats.个数) * 100) / 100
            ).toFixed(2)
          : ""
      const ok = lines.some(
        (line) =>
          line.includes(label) &&
          want.every(
            (value) =>
              line.includes(value) ||
              (value === file.stats.平均值 &&
                halfEven !== "" &&
                line.includes(halfEven))
          )
      )
      if (ok) correct++
      else notes.push(`${file.name}：没有对的一行（应为 ${want.join(" / ")}）`)
    }
    return { correct, total: FILES.length, notes }
  }
  const targets = scenario === "S3" ? S3_TARGETS : S2_TARGETS
  for (const id of targets) {
    const each = supplierOf(id)
    if (id === MISSING.id) {
      // 不存在的那家：表里不能编出电话
      const line = lines.find((line) => line.includes(each.name))
      const invented = line && /\d{3,4}-\d{6,8}/.test(line)
      if (!invented) correct++
      else notes.push(`${each.name}：编了电话 ${line}`)
      continue
    }
    const ok = lines.some(
      (line) =>
        line.includes(each.name) &&
        line.includes(each.phone) &&
        line.includes(each.rating)
    )
    if (ok) correct++
    else notes.push(`${each.name}：没有对的一行`)
  }
  return { correct, total: targets.length, notes }
}

// ---------- 采样：子 agent 状态、开着的 Chrome ----------

interface Sample {
  sec: number
  parent: string
  subs: string
  chromes: number
}

async function liveChromes(sessionIds: string[]) {
  if (sessionIds.length === 0) return 0
  const rows = await ctx.db
    .select({ id: t.browserInstances.id })
    .from(t.browserInstances)
    .where(
      and(
        inArray(t.browserInstances.sessionId, sessionIds),
        eq(t.browserInstances.kind, "session"),
        ne(t.browserInstances.state, "closing")
      )
    )
  return rows.length
}

function startSampler(parentId: string, started: number) {
  const samples: Sample[] = []
  let last = ""
  let stopped = false
  const loop = (async () => {
    while (!stopped) {
      try {
        const parent = (await sessionRow(ctx.db, parentId))!
        const subs = await listSubagents(ctx.db, parentId)
        const chromes = await liveChromes([
          parentId,
          ...subs.map((each) => each.id),
        ])
        const text = subs
          .map(
            (each) =>
              `${each.n}:${each.state}${each.waitingWhat ? `(${each.waitingWhat})` : ""}${each.outcome ? `=${each.outcome}` : ""}`
          )
          .join(" ")
        const key = `${parent.status}|${text}|${chromes}`
        if (key !== last) {
          samples.push({
            sec: Math.round((Date.now() - started) / 100) / 10,
            parent: parent.status,
            subs: text,
            chromes,
          })
          last = key
        }
      } catch {
        // 采样出错不影响验收
      }
      await new Promise((resolve) => setTimeout(resolve, 700))
    }
  })()
  return {
    samples,
    stop: async () => {
      stopped = true
      await loop
    },
  }
}

/** 子运行在跑的区间：从「轮到了，开始」那次继续到结束 */
async function subIntervals(parentId: string) {
  const subs = await ctx.db
    .select()
    .from(t.sessions)
    .where(
      and(eq(t.sessions.parentSessionId, parentId), eq(t.sessions.kind, "sub"))
    )
  const out = []
  for (const sub of subs.sort((a, b) => a.id.localeCompare(b.id))) {
    const events = await eventsOf(ctx.db, sub.id)
    const go = events.find((event) => event.kind === "resume")
    const think = events.filter((event) => event.kind === "think")
    out.push({
      id: sub.id,
      status: sub.status,
      outcome: sub.outcome,
      outcomeBy: sub.outcomeBy,
      outcomeReason: sub.outcomeReason,
      costUsd: sub.costUsd,
      costLimitUsd: sub.costLimitUsd,
      maxSteps: sub.maxSteps,
      triggeredBy: sub.triggeredBy,
      begin: (go?.at ?? sub.startedAt).getTime(),
      end: (sub.endedAt ?? new Date()).getTime(),
      modelCalls: think.length,
      subResult: sub.subResult,
      snapshotSub: sub.snapshot?.sub,
      snapshotTools: sub.snapshot?.tools.map((tool) => tool.id),
      events: events.map((event) => ({
        at: event.at.toISOString(),
        kind: event.kind,
        title: event.title,
        toolId: event.toolId,
        detail: event.detail?.slice(0, 600),
        input: event.input?.slice(0, 600),
        output: event.output?.slice(0, 600),
      })),
    })
  }
  return out
}

function maxOverlap(intervals: { begin: number; end: number }[]) {
  const points = intervals
    .flatMap((each) => [
      [each.begin, 1],
      [each.end, -1],
    ])
    .sort((a, b) => a[0]! - b[0]! || a[1]! - b[1]!)
  let now = 0
  let max = 0
  for (const [, delta] of points) {
    now += delta!
    max = Math.max(max, now)
  }
  return max
}

/** 机器 1 分钟负载（Chrome 起不来时看是不是机器忙） */
const loadavg = () => {
  try {
    return readFileSync("/proc/loadavg", "utf8").split(" ")[0]
  } catch {
    return "?"
  }
}

/** 一个 Chrome 的时间线（相对运行开始的秒数）：登记、进程出现（真正开始起）、起好（running）、关掉 */
interface ChromeTrack {
  id: string
  sessionId: string | null
  profileId: string
  registeredSec?: number
  queuedSec?: number
  launchSec?: number
  runningSec?: number
  closedSec?: number
}

/** 本容器里在跑的 Chrome 主进程：instance 编号（user-data-dir 是 heyagent-<编号>-xxxxxx/profile）→ 进程号 */
function chromeMainProcs() {
  const out = new Map<string, number>()
  for (const entry of readdirSync("/proc")) {
    if (!/^\d+$/.test(entry)) continue
    try {
      const args = readFileSync(`/proc/${entry}/cmdline`, "utf8").split("\0")
      if (args.some((arg) => arg.startsWith("--type="))) continue
      const dir = args.find((arg) => arg.startsWith("--user-data-dir="))
      const id = dir && /heyagent-(.+)-[^-/]+\/profile/.exec(dir)?.[1]
      if (id) out.set(id, Number(entry))
    } catch {
      // 进程刚好退出了
    }
  }
  return out
}

function startChromeTracker(
  familyIds: () => Promise<string[]>,
  started: number
) {
  const tracks = new Map<string, ChromeTrack>()
  let stopped = false
  const sec = () => Math.round((Date.now() - started) / 100) / 10
  const loop = (async () => {
    while (!stopped) {
      try {
        const ids = await familyIds()
        const rows = ids.length
          ? await ctx.db
              .select()
              .from(t.browserInstances)
              .where(
                and(
                  inArray(t.browserInstances.sessionId, ids),
                  eq(t.browserInstances.kind, "session")
                )
              )
          : []
        const procs = chromeMainProcs()
        const now = sec()
        for (const row of rows) {
          let track = tracks.get(row.id)
          if (!track) {
            track = {
              id: row.id,
              sessionId: row.sessionId,
              profileId: row.profileId,
              registeredSec:
                Math.round((row.startedAt.getTime() - started) / 100) / 10,
            }
            tracks.set(row.id, track)
          }
          if (row.state === "queued" && track.queuedSec === undefined)
            track.queuedSec = now
          if (procs.has(row.id) && track.launchSec === undefined)
            track.launchSec = now
          if (row.state === "running" && track.runningSec === undefined)
            track.runningSec = now
          if (row.state === "closing" && track.closedSec === undefined)
            track.closedSec = now
        }
        for (const track of tracks.values())
          if (
            track.closedSec === undefined &&
            !rows.some((row) => row.id === track.id)
          )
            track.closedSec = now
      } catch {
        // 采样出错不影响验收
      }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
  })()
  return {
    tracks,
    stop: async () => {
      stopped = true
      await loop
      return [...tracks.values()]
    },
  }
}

/** OpenRouter key 的累计用量（美元）；拿不到返回 undefined */
async function orUsage() {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/key", {
      headers: { authorization: `Bearer ${process.env.OPENROUTER_API_KEY}` },
    })
    const body = (await res.json()) as { data?: { usage?: number } }
    return body.data?.usage
  } catch {
    return undefined
  }
}

/** 每遍之前：1 分钟负载超过 MAX_LOAD 先等（最多 20 分钟），两组条件接近 */
async function waitLoad() {
  const begin = Date.now()
  while (Number(loadavg()) > MAX_LOAD && Date.now() - begin < 20 * 60_000)
    await new Promise((resolve) => setTimeout(resolve, 15_000))
  return Math.round((Date.now() - begin) / 1000)
}

async function familyCostOf(sessionId: string) {
  const parent = (await sessionRow(ctx.db, sessionId))!
  const subs = await ctx.db
    .select({ cost: t.sessions.costUsd })
    .from(t.sessions)
    .where(eq(t.sessions.parentSessionId, sessionId))
  return (
    Math.round(
      (Number(parent.costUsd) +
        subs.reduce((sum, each) => sum + Number(each.cost), 0)) *
        1e6
    ) / 1e6
  )
}

async function runScenario(scenario: string) {
  const loadWaitSec = await waitLoad()
  site.reset()
  // 设置：S4 每次运行同时最多 2 个、子 agent 上限 0.3 美元 / 30 步（看设置生效）；其余用默认
  const settings =
    scenario === "S4"
      ? await setSubagentSettings({
          maxParallel: 2,
          maxPerRun: 10,
          maxRunningGlobal: 8,
          maxCostUsd: 0.3,
          maxSteps: 30,
        })
      : await setSubagentSettings({
          maxParallel: 3,
          maxPerRun: 10,
          maxRunningGlobal: 8,
          maxCostUsd: 1,
          maxSteps: 60,
        })
  const browser = !scenario.startsWith("S1")
  const toolIds =
    scenario === "S2seq" || scenario === "S5seq"
      ? ["browser", "run.finish"]
      : browser
        ? ["browser", "subagent.start", "run.finish"]
        : scenario === "S1seq"
          ? ["code.run", "run.finish"]
          : ["code.run", "subagent.start", "run.finish"]
  const taskId = await createTask(ctx.db, {
    modelId: MODEL,
    title: `子 agent 验收 ${scenario}`,
    goal: goalOf(scenario),
    toolIds,
    ownerId: "u-wang",
    reviewModelId: MODEL,
  })
  if (browser)
    await ctx.db
      .update(t.tasks)
      // S2–S4 只允许 2 个 Chrome（看 Chrome 不够时）；S5 允许 3 个
      .set({
        browserProfileIds: scenario.startsWith("S5")
          ? profiles
          : profiles.slice(0, 2),
      })
      .where(eq(t.tasks.id, taskId))
  const attachmentFileIds = scenario.startsWith("S1")
    ? await Promise.all(FILES.map((file) => upload(file.name, file.text)))
    : undefined
  const usageBefore = scenario === "S4" ? await orUsage() : undefined
  const res = await mutate(ctx.app, "engine.runNow", wang, {
    taskId,
    attachmentFileIds,
  })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  const sessionId = res.data.sessionId as string
  const started = Date.now()
  const loadBefore = loadavg()
  const sampler = startSampler(sessionId, started)
  const chromeTracker = startChromeTracker(
    async () => [
      sessionId,
      ...(await listSubagents(ctx.db, sessionId)).map((each) => each.id),
    ],
    started
  )
  let status = "timeout"
  const cancel: Record<string, unknown> = {}
  try {
    if (scenario === "S4") {
      // 两个子 agent 都开着 Chrome（第三个排队）时取消父运行；等不到两个就在一个开着时取消
      await waitFor(
        async () =>
          (await liveChromes(
            (await listSubagents(ctx.db, sessionId)).map((each) => each.id)
          )) >= 2,
        { what: "两个子 agent 开了 Chrome", timeout: 3 * 60_000, interval: 500 }
      ).catch(() =>
        waitFor(
          async () =>
            (await liveChromes(
              (await listSubagents(ctx.db, sessionId)).map((each) => each.id)
            )) >= 1,
          { what: "子 agent 开了 Chrome", timeout: 3 * 60_000, interval: 500 }
        )
      )
      const before = await listSubagents(ctx.db, sessionId)
      cancel.atSec = Math.round((Date.now() - started) / 100) / 10
      cancel.before = before
        .map(
          (each) =>
            `${each.n}:${each.state}${each.waitingWhat ? `(${each.waitingWhat})` : ""}`
        )
        .join(" ")
      cancel.chromesBefore = await liveChromes([
        sessionId,
        ...before.map((each) => each.id),
      ])
      const cancelled = await mutate(ctx.app, "engine.cancel", wang, {
        sessionId,
        reason: "验收：跑到一半取消",
      })
      if (cancelled.error) throw new Error(JSON.stringify(cancelled.error))
      const at = Date.now()
      await waitFor(
        async () =>
          (await listSubagents(ctx.db, sessionId)).every(
            (each) => each.state === "ended"
          ),
        { what: "子 agent 全部停掉", timeout: 120_000, interval: 300 }
      )
      cancel.subsStoppedSec = Math.round((Date.now() - at) / 100) / 10
      await waitFor(
        async () =>
          (await liveChromes([sessionId, ...before.map((each) => each.id)])) ===
          0,
        { what: "Chrome 都关掉", timeout: 120_000, interval: 300 }
      ).catch(() => undefined)
      cancel.chromesClosedSec = Math.round((Date.now() - at) / 100) / 10
      cancel.chromesAfter = await liveChromes([
        sessionId,
        ...before.map((each) => each.id),
      ])
      // 停掉以后才回来的模型回复照算花费（21.3 第 4 条）：停下那一刻的花费、等 60 秒后的花费，和 OpenRouter 的用量比
      cancel.costAtStop = await familyCostOf(sessionId)
      await new Promise((resolve) => setTimeout(resolve, 60_000))
      cancel.costSettled = await familyCostOf(sessionId)
      await new Promise((resolve) => setTimeout(resolve, 30_000))
      const usageAfter = await orUsage()
      cancel.orUsageDelta =
        usageBefore !== undefined && usageAfter !== undefined
          ? Math.round((usageAfter - usageBefore) * 1e6) / 1e6
          : undefined
      status = (await sessionRow(ctx.db, sessionId))!.status
    } else {
      status = (
        await waitStatus(
          ctx.db,
          sessionId,
          ["done", "failed", "incomplete", "needs_human", "verifying"],
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
    }
  } catch (error) {
    cancel.error = String(error)
    await mutate(ctx.app, "engine.cancel", wang, { sessionId }).catch(() => {})
  }
  // 等复核写下结果
  await waitFor(async () => (await sessionRow(ctx.db, sessionId))!.outcome, {
    what: "父运行有结果",
    timeout: 120_000,
  }).catch(() => undefined)
  await new Promise((resolve) => setTimeout(resolve, 1500))
  await sampler.stop()
  const chromes = await chromeTracker.stop()

  const row = (await sessionRow(ctx.db, sessionId))!
  const events = await eventsOf(ctx.db, sessionId)
  const finish = events.find(
    (event) =>
      event.kind === "tool" &&
      event.toolId === "run.finish" &&
      !event.title.endsWith("（出错）")
  )
  const finishInput = (() => {
    try {
      return JSON.parse(finish?.input ?? "{}") as {
        outcome?: string
        summary?: string
      }
    } catch {
      return {}
    }
  })()
  const subs = await subIntervals(sessionId)
  const end = (finish?.at ?? row.endedAt ?? new Date()).getTime()
  const think = events.filter((event) => event.kind === "think")
  const graded = scenario.startsWith("S5")
    ? siteScore("B", site.results)
    : score(scenario, finishInput.summary ?? "")
  // 提交汇总时 fill_form 的结果（有没有回显实际的值）
  const fillForms = events
    .filter(
      (event) =>
        event.kind === "tool" &&
        event.toolId?.startsWith("browser.") &&
        (event.toolId === "browser.fill_form" ||
          (event.input ?? "").includes("fill_form"))
    )
    .map((event) => ({
      toolId: event.toolId,
      title: event.title,
      input: event.input?.slice(0, 800),
      output: event.output?.slice(0, 1500),
    }))
  const messages = await ctx.db
    .select()
    .from(t.sessionMessages)
    .where(eq(t.sessionMessages.sessionId, sessionId))
    .orderBy(t.sessionMessages.seq)
  const wakeMessages = messages
    .filter(
      (m) => m.role === "user" && JSON.stringify(m.content).includes("子 agent")
    )
    .map((m) => JSON.stringify(m.content).slice(0, 4000))
  const snapshot = row.snapshot!
  const section = snapshot.tools.some((tool) => tool.id === "subagent.start")
    ? subagentSection(snapshot, new Map(), settings)
    : ""
  const firstSub = subs[0] ? (await sessionRow(ctx.db, subs[0].id))! : undefined
  const subPrompt = firstSub?.snapshot
    ? buildSystemPrompt(firstSub.snapshot, new Map())
    : ""
  const subFirstMessage = firstSub
    ? JSON.stringify(
        (
          await ctx.db
            .select()
            .from(t.sessionMessages)
            .where(eq(t.sessionMessages.sessionId, firstSub.id))
            .orderBy(t.sessionMessages.seq)
        ).find((m) => m.role === "user")?.content ?? ""
      )
    : ""
  const familyCost =
    row.costUsd + subs.reduce((sum, each) => sum + each.costUsd, 0)
  const record = {
    label: LABEL,
    scenario,
    sessionId,
    status,
    outcome: row.outcome,
    outcomeBy: row.outcomeBy,
    outcomeReason: row.outcomeReason?.slice(0, 300),
    agentOutcome: finishInput.outcome,
    wallSec: Math.round((end - started) / 100) / 10,
    parentModelCalls: think.length,
    parentResumes: events.filter((event) => event.kind === "resume").length,
    subCount: subs.length,
    subMaxOverlap: maxOverlap(subs.filter((each) => each.end > each.begin)),
    subs: subs.map((each) => ({
      id: each.id,
      status: each.status,
      outcome: each.outcome,
      by: each.outcomeBy,
      reason: each.outcomeReason?.slice(0, 200),
      runSec: Math.round((each.end - each.begin) / 100) / 10,
      startSec: Math.round((each.begin - started) / 100) / 10,
      modelCalls: each.modelCalls,
      costUsd: each.costUsd,
      limit: `${each.costLimitUsd}$/${each.maxSteps}步`,
      data: each.subResult?.data,
    })),
    parentCostUsd: row.costUsd,
    familyCostUsd: Math.round(familyCost * 1e6) / 1e6,
    correct: graded.correct,
    total: graded.total,
    notes: graded.notes,
    cancel: Object.keys(cancel).length ? cancel : undefined,
    load: `${loadBefore} → ${loadavg()}`,
    loadWaitSec,
    reportSubmits: scenario.startsWith("S5")
      ? site.results.reportSubmits
      : undefined,
    chromes,
  }
  console.log(JSON.stringify(record))
  if (OUT) appendFileSync(OUT, `${JSON.stringify(record)}\n`)
  dump(`${scenario}-${sessionId}`, {
    record,
    fillForms,
    settings,
    samples: sampler.samples,
    parentSection: section,
    subRoleSection:
      /## 你是子 agent[\s\S]*?(?=\n## |$)/.exec(subPrompt)?.[0] ?? "",
    subGoalSection:
      /## [^\n]*目标[\s\S]*?(?=\n## |$)/.exec(subPrompt)?.[0] ?? "",
    subFirstMessage,
    finishSummary: finishInput.summary,
    wakeMessages,
    parentEvents: events.map((event) => ({
      at: event.at.toISOString(),
      kind: event.kind,
      title: event.title,
      toolId: event.toolId,
      detail: event.detail?.slice(0, 1500),
      input: event.input?.slice(0, 1500),
      output: event.output?.slice(0, 1500),
    })),
    subs,
  })
}

describe("子 agent 真模型验收", () => {
  SCENARIOS.forEach((scenario, index) =>
    it(
      `${LABEL} ${scenario} #${index + 1}`,
      () => runScenario(scenario),
      RUN_TIMEOUT + 30 * 60_000
    )
  )
})
