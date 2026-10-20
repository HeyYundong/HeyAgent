// 真模型端到端冒烟（花钱，不在 pnpm test 里跑）：建任务 → 立即运行 → 调一个内置工具 → session.wait 1 分钟 → 继续 → 完成。
// 前提：开发库已经 pnpm db:seed（要演示账号），API（PORT）和 worker 都开着；.env 里有 OPENROUTER_API_KEY。
// 跑之前先执行主目录的 scripts/or-usage.sh check 18。
// 用法：pnpm --filter @heyagent/server exec tsx --conditions=@heyagent/source test/real-model-smoke.ts [模型 id]
import { setTimeout as sleep } from "node:timers/promises"

import { eq, sql } from "drizzle-orm"
import { taskId as makeTaskId } from "@heyagent/shared"

import { createDb } from "../src/db/client.js"
import * as t from "../src/db/schema.js"
import { env } from "../src/env.js"
import { encrypt, loadKeyring, mask } from "../src/lib/crypto.js"

const modelId = process.argv[2] ?? "openrouter/anthropic/claude-haiku-5.5"
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) throw new Error("没有 OPENROUTER_API_KEY")
const base = `http://127.0.0.1:${env.port}`
const origin = env.trustedOrigins[0] ?? base

const { db, pool } = createDb(env.databaseUrl)
const keyring = loadKeyring(env.kekFile)

// 1. 模型服务：把 openrouter 的 key 换成真的（种子里是假值），加密存
const [provider] = await db
  .select()
  .from(t.modelProviders)
  .where(eq(t.modelProviders.kind, "openrouter"))
if (!provider) throw new Error("库里没有 OpenRouter 模型服务，先 pnpm db:seed")
const secretId = provider.apiKeySecretId ?? `sec-provider-${provider.id}`
const [old] = await db
  .select()
  .from(t.secrets)
  .where(eq(t.secrets.id, secretId))
const version = (old?.version ?? 0) + 1
const enc = encrypt(keyring, apiKey, {
  table: "secrets",
  id: secretId,
  version,
})
if (old)
  await db
    .update(t.secrets)
    .set({ enc, version, masked: mask(apiKey) })
    .where(eq(t.secrets.id, secretId))
else
  await db.insert(t.secrets).values({
    id: secretId,
    scope: "model_provider",
    refId: provider.id,
    name: "api_key",
    version,
    enc,
    masked: mask(apiKey),
  })
await db
  .update(t.modelProviders)
  .set({
    apiKeySecretId: secretId,
    status: "ok",
    baseUrl: "https://openrouter.ai/api/v1",
  })
  .where(eq(t.modelProviders.id, provider.id))
const [model] = await db.select().from(t.models).where(eq(t.models.id, modelId))
if (!model)
  await db.insert(t.models).values({
    id: modelId,
    providerId: provider.id,
    name: modelId,
    contextK: 200,
  })

// 2. 建任务（配置写接口是包 P2 的，这里直接写库）
const seq = await db.execute<{ n: string }>(
  sql`select nextval('task_no_seq') as n`
)
const taskId = makeTaskId(Number(seq.rows[0]!.n))
await db.insert(t.tasks).values({
  id: taskId,
  title: "冒烟：勾检查点、等 1 分钟、再完成",
  goal: "先勾上第 1 个检查点，然后用 session.wait 等 1 分钟（afterMinutes = 1），继续后回复一句「完成」。",
  steps: [
    {
      id: "s1",
      text: "调用 checkpoint.mark 勾上第 1 个检查点，record 写「开始了」",
      wait: false,
      checkpoint: "已开始",
    },
    {
      id: "s2",
      text: "调用 session.wait，what 写「等 1 分钟」，afterMinutes = 1",
      wait: true,
    },
    { id: "s3", text: "继续后直接回复「完成」，不要再调工具", wait: false },
  ],
  ownerId: "u-lin",
  modelId,
  // 复核模型必填（run-outcome 2026-10-20）：用执行模型复核
  reviewModelId: modelId,
})
console.log(`任务 ${taskId}，模型 ${modelId}`)

// 3. 登录 + 立即运行（走 API）
const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({
    email: "linzhou@heyagent.local",
    password: env.seedPassword,
  }),
})
if (!signIn.ok) throw new Error(`登录失败 ${signIn.status}`)
const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!
const run = await fetch(`${base}/api/trpc/engine.runNow`, {
  method: "POST",
  headers: { "content-type": "application/json", cookie },
  body: JSON.stringify({ taskId }),
})
const runBody = (await run.json()) as {
  result?: { data: { sessionId: string } }
  error?: unknown
}
if (!runBody.result)
  throw new Error(`立即运行失败：${JSON.stringify(runBody.error)}`)
const sessionId = runBody.result.data.sessionId
console.log(`session ${sessionId}`)

// 4. 等它跑完（最多 5 分钟），打印过程
const started = Date.now()
let last = ""
for (;;) {
  const res = await fetch(
    `${base}/api/trpc/sessions.get?input=${encodeURIComponent(JSON.stringify({ id: sessionId }))}`,
    { headers: { cookie } }
  )
  const body = (await res.json()) as {
    result: {
      data: {
        status: string
        costUsd: number
        tokensIn: number
        tokensOut: number
        events: { seq: number; at: string; kind: string; title: string }[]
        checkpoints: { status: string }[]
      }
    }
  }
  const data = body.result.data
  const line = `${Math.round((Date.now() - started) / 1000)}s ${data.status} 事件 ${data.events.length} 花费 $${data.costUsd}`
  if (line.replace(/^\d+s /, "") !== last) console.log(line)
  last = line.replace(/^\d+s /, "")
  if (
    data.status === "done" ||
    data.status === "failed" ||
    Date.now() - started > 5 * 60_000
  ) {
    for (const event of data.events)
      console.log(`  #${event.seq} ${event.at} [${event.kind}] ${event.title}`)
    console.log(
      `结果：${data.status}，检查点 ${data.checkpoints.map((cp) => cp.status).join(",")}，token ${data.tokensIn}/${data.tokensOut}，花费 $${data.costUsd}`
    )
    const [row] = await db
      .select({ error: t.sessions.error })
      .from(t.sessions)
      .where(eq(t.sessions.id, sessionId))
    if (row?.error) console.log(`原因：${row.error}`)
    break
  }
  await sleep(5000)
}
await pool.end()
