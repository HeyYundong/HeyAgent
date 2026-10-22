// 引擎测试的公共部分：真实的测试库 + 进程内的 worker（pg-boss）+ AI SDK 的假模型。不花钱、不连外网。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import { MockLanguageModelV4 } from "ai/test"
import { eq, sql } from "drizzle-orm"
import pg from "pg"

import type { Db } from "../src/db/client.js"
import * as t from "../src/db/schema.js"
import { configureEngine } from "../src/engine/runtime.js"
import { stopSenderBoss } from "../src/engine/queue.js"
import {
  startEngineWorker,
  type EngineWorker,
} from "../src/engine/worker-runtime.js"
import { encrypt, mask, type Keyring } from "../src/lib/crypto.js"
import { setupApp, TEST_REVIEW_MODEL, testDatabaseUrl, type TestApp } from "./helpers.js"

type DoGenerate = NonNullable<
  ConstructorParameters<typeof MockLanguageModelV4>[0]
>["doGenerate"]
export type GenerateResult = Exclude<
  Awaited<ReturnType<Extract<DoGenerate, (...args: never[]) => unknown>>>,
  undefined
>
export type CallOptions = Parameters<
  Extract<DoGenerate, (...args: never[]) => unknown>
>[0]
type Content = GenerateResult["content"][number]

let callCounter = 0

/** 模型的一步回复：内容 + 用量 + OpenRouter 格式的花费 */
export function step(content: Content[], costUsd = 0.001): GenerateResult {
  const hasCalls = content.some((part) => part.type === "tool-call")
  return {
    content,
    finishReason: {
      unified: hasCalls ? "tool-calls" : "stop",
      raw: hasCalls ? "tool_calls" : "stop",
    },
    usage: {
      inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 20, text: 20, reasoning: 0 },
    },
    providerMetadata: { openrouter: { usage: { cost: costUsd } } },
    warnings: [],
  }
}

/** 模型提出一次工具调用（工具名按网关的规则把 . 换成 _） */
export const call = (
  toolId: string,
  input: unknown,
  id = `call-${++callCounter}`
): Content => ({
  type: "tool-call",
  toolCallId: id,
  toolName: toolId.replace(/[^A-Za-z0-9_-]/g, "_"),
  input: typeof input === "string" ? input : JSON.stringify(input),
})

export const text = (value: string): Content => ({ type: "text", text: value })

/** 收尾：说一段话，同时调 run.finish 报结果（run-outcome：只回文字会先被提醒一次） */
export const finishWith = (summary: string, outcome: "achieved" | "not_achieved" = "achieved", reason?: string): Content[] => [
  text(summary),
  call("run.finish", { outcome, summary, evidence: summary, ...(reason ? { reason } : {}) }),
]

/** 照剧本回复的假模型：第 n 次调用用第 n 个函数；记下每次收到的提示 */
export class Script {
  readonly prompts: CallOptions[] = []
  readonly model: MockLanguageModelV4
  private readonly turns: ((
    options: CallOptions,
    index: number
  ) => GenerateResult | Promise<GenerateResult>)[]

  constructor(
    turns: (
      | GenerateResult
      | ((
          options: CallOptions,
          index: number
        ) => GenerateResult | Promise<GenerateResult>)
    )[]
  ) {
    this.turns = turns.map((turn) =>
      typeof turn === "function" ? turn : () => turn
    )
    this.model = new MockLanguageModelV4({
      provider: "test",
      modelId: "script",
      doGenerate: async (options) => {
        const index = this.prompts.length
        this.prompts.push(options)
        const turn = this.turns[index]
        if (!turn)
          return step([text(`（剧本没有第 ${index + 1} 步，直接结束）`)])
        return turn(options, index)
      },
    })
  }

  /** 第 n 次调用（从 0 开始）收到的消息，拍平成文字，方便断言 */
  promptText(index: number) {
    return JSON.stringify(this.prompts[index]?.prompt ?? [])
  }
}

/** 按任务的模型 id 找剧本：每个测试用自己的模型 id，互不干扰 */
const scripts = new Map<string, Script>()

/**
 * 测试用的默认复核模型（run-outcome：运行结束一定复核，任务没选复核模型时用默认的）。setupApp 建好这个模型、设成默认复核模型；
 * 没给它准备剧本时一律判办成（不影响只关心流程的测试），要测复核的用 useScript(TEST_REVIEWER, …) 换掉
 */
export const TEST_REVIEWER = TEST_REVIEW_MODEL
export const reviewVerdict = (verdict: string, reason: string, costUsd = 0.0004) => step([text(JSON.stringify({ verdict, reason }))], costUsd)
const defaultReviewer = new MockLanguageModelV4({ provider: "test", modelId: "reviewer", doGenerate: async () => reviewVerdict("achieved", "测试默认复核：办成") })

/** 把测试用的复核模型设回默认复核模型、去掉它的剧本（改过默认复核模型的测试结束时调） */
export async function resetTestReviewer(db: Db) {
  scripts.delete(TEST_REVIEWER)
  await db.insert(t.modelDefaults).values({ role: "review", modelId: TEST_REVIEWER }).onConflictDoUpdate({ target: t.modelDefaults.role, set: { modelId: TEST_REVIEWER } })
}
export function useScript(modelId: string, script: Script) {
  scripts.set(modelId, script)
  return script
}

export interface EngineTestContext extends TestApp {
  worker: EngineWorker
  filesDir: string
  stop(): Promise<void>
}

export async function dropBossSchema(url = testDatabaseUrl()) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  await client.query("drop schema if exists pgboss cascade")
  await client.end()
}

export async function setupEngine(
  options: {
    superviseIntervalSeconds?: number
    cronWorkerIntervalSeconds?: number
    /** 桌面巡查的定时器：false = 不开（桌面测试自己调 sweepDesktops） */
    desktopSweepMs?: number | false
  } = {}
): Promise<EngineTestContext> {
  await dropBossSchema()
  const app = await setupApp()
  const filesDir = mkdtempSync(join(tmpdir(), "heyagent-files-"))
  configureEngine({
    keyring: app.keyring,
    filesDir,
    modelRetryBaseMs: 10,
    modelFactory: ({ modelId }) => {
      const script = scripts.get(modelId)
      if (!script && modelId === TEST_REVIEWER) return defaultReviewer
      if (!script) throw new Error(`测试没有给模型 ${modelId} 准备剧本`)
      return script.model
    },
  })
  const worker = await startEngineWorker({
    databaseUrl: app.url,
    db: app.db,
    pollingIntervalSeconds: 0.5,
    superviseIntervalSeconds: options.superviseIntervalSeconds ?? 5,
    cronWorkerIntervalSeconds: options.cronWorkerIntervalSeconds,
    concurrency: 4,
    browserControlPort: 0,
    desktopSweepMs: options.desktopSweepMs,
  })
  return {
    ...app,
    worker,
    filesDir,
    async stop() {
      await worker.stop()
      await stopSenderBoss(app.db)
      await app.close()
    },
  }
}

/** 一直等到条件成立（轮询），超时报错并带上最后一次的值 */
export async function waitFor<T>(
  fn: () => Promise<T | undefined | null | false>,
  { timeout = 20_000, interval = 200, what = "条件" } = {}
): Promise<T> {
  const deadline = Date.now() + timeout
  let last: unknown
  while (Date.now() < deadline) {
    last = await fn()
    if (last) return last as T
    await sleep(interval)
  }
  throw new Error(
    `等 ${what} 超时（${timeout} 毫秒），最后一次：${JSON.stringify(last)}`
  )
}

export async function sessionRow(db: Db, id: string) {
  const [row] = await db.select().from(t.sessions).where(eq(t.sessions.id, id))
  return row
}

export async function waitStatus(
  db: Db,
  id: string,
  status: string | string[],
  timeout = 20_000
) {
  const wanted = Array.isArray(status) ? status : [status]
  return waitFor(
    async () => {
      const row = await sessionRow(db, id)
      return row && wanted.includes(row.status) ? row : undefined
    },
    { timeout, what: `${id} 变成 ${wanted.join("/")}` }
  )
}

export async function eventsOf(db: Db, id: string) {
  return db
    .select()
    .from(t.sessionEvents)
    .where(eq(t.sessionEvents.sessionId, id))
    .orderBy(t.sessionEvents.seq)
}

export async function messagesOf(db: Db, id: string) {
  return db
    .select()
    .from(t.sessionMessages)
    .where(eq(t.sessionMessages.sessionId, id))
    .orderBy(t.sessionMessages.seq)
}

let taskCounter = 9000

/** 直接在库里建一个任务（配置写接口是包 P2 的，这里不依赖） */
export async function createTask(
  db: Db,
  input: {
    modelId: string
    title?: string
    goal?: string
    ownerId?: string
    steps?: { id: string; text: string; wait: boolean; checkpoint?: string }[]
    toolIds?: string[]
    skillIds?: string[]
    memoryIds?: string[]
    scheduleCron?: string
    enabled?: boolean
    /** 不给 = 不选，运行时用默认复核模型（测试里是 TEST_REVIEWER） */
    reviewModelId?: string
  }
) {
  const id = `T-${++taskCounter}`
  await db.insert(t.tasks).values({
    id,
    title: input.title ?? `测试任务 ${id}`,
    goal: input.goal ?? "按步骤做完",
    steps: input.steps ?? [],
    ownerId: input.ownerId ?? "u-wang",
    modelId: input.modelId,
    enabled: input.enabled ?? true,
    scheduleCron: input.scheduleCron ?? null,
    scheduleText: input.scheduleCron ? `cron ${input.scheduleCron}` : null,
    reviewModelId: input.reviewModelId ?? null,
  })
  for (const [position, toolId] of (input.toolIds ?? []).entries())
    await db.insert(t.taskTools).values({ taskId: id, refId: toolId, position })
  for (const [position, skillId] of (input.skillIds ?? []).entries())
    await db
      .insert(t.taskSkills)
      .values({ taskId: id, refId: skillId, position })
  for (const [position, memoryId] of (input.memoryIds ?? []).entries())
    await db
      .insert(t.taskMemories)
      .values({ taskId: id, refId: memoryId, position })
  return id
}

/** 存一个加密的密钥 */
export async function saveSecret(
  db: Db,
  keyring: Keyring,
  input: {
    id: string
    scope: "http_tool" | "mcp_env" | "model_provider"
    name: string
    value: string
    refId?: string
  }
) {
  await db.insert(t.secrets).values({
    id: input.id,
    scope: input.scope,
    refId: input.refId ?? null,
    name: input.name,
    version: 1,
    enc: encrypt(keyring, input.value, {
      table: "secrets",
      id: input.id,
      version: 1,
    }),
    masked: mask(input.value),
  })
}

export async function setSetting(db: Db, key: string, value: unknown) {
  await db
    .insert(t.settings)
    .values({ key, value })
    .onConflictDoUpdate({ target: t.settings.key, set: { value } })
}

/** 调一个 tRPC mutation（POST /api/trpc/<path>，没有 transformer，body 就是输入） */
export async function mutate(
  app: TestApp["app"],
  path: string,
  cookie: string | undefined,
  input: unknown
) {
  const res = await app.request(`/api/trpc/${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify(input),
  })
  const body = (await res.json()) as {
    result?: { data: unknown }
    error?: { message: string; data?: { code: string } }
  }
  return {
    status: res.status,
    data: body.result?.data as any,
    error: body.error,
  }
}

export async function bossJobs(db: Db, name: string) {
  const rows = await db.execute<{
    id: string
    state: string
    data: Record<string, unknown>
    start_after: Date
  }>(
    sql`select id, state, data, start_after from pgboss.job where name = ${name} order by created_on`
  )
  return rows.rows
}
