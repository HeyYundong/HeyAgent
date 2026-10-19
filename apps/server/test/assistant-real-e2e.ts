// 右下角助手的真模型联调（花钱，不在 pnpm test 里跑）：新建技能 → 应用；停用它 → 不要；改「这个任务」的定时 → 应用；新建任务挂上技能 → 应用。
// 前提：开发库已经 pnpm db:seed（要演示账号和 OpenRouter 模型服务），API（PORT）开着；.env 里有 OPENROUTER_API_KEY。
// 跑之前先执行主目录的 scripts/or-usage.sh check 18。
// 用法：pnpm --filter @heyagent/server exec tsx --conditions=@heyagent/source test/assistant-real-e2e.ts [模型 id]
import { and, desc, eq, sql } from "drizzle-orm"
import { assistantStreamEventSchema, type AssistantPageContext, type AssistantProposal, type AssistantStreamEvent } from "@heyagent/shared"

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

// 1. OpenRouter 的 key 换成真的（种子里是假值），plan 默认模型设成要测的模型
const [provider] = await db.select().from(t.modelProviders).where(eq(t.modelProviders.kind, "openrouter"))
if (!provider) throw new Error("库里没有 OpenRouter 模型服务，先 pnpm db:seed")
const secretId = provider.apiKeySecretId ?? `sec-provider-${provider.id}`
const [old] = await db.select().from(t.secrets).where(eq(t.secrets.id, secretId))
const version = (old?.version ?? 0) + 1
const enc = encrypt(keyring, apiKey, { table: "secrets", id: secretId, version })
if (old) await db.update(t.secrets).set({ enc, version, masked: mask(apiKey) }).where(eq(t.secrets.id, secretId))
else await db.insert(t.secrets).values({ id: secretId, scope: "model_provider", refId: provider.id, name: "api_key", version, enc, masked: mask(apiKey) })
await db.update(t.modelProviders).set({ apiKeySecretId: secretId, status: "ok", baseUrl: "https://openrouter.ai/api/v1" }).where(eq(t.modelProviders.id, provider.id))
const [model] = await db.select().from(t.models).where(eq(t.models.id, modelId))
if (!model) await db.insert(t.models).values({ id: modelId, providerId: provider.id, name: modelId, contextK: 200 })
await db.insert(t.modelDefaults).values({ role: "plan", modelId }).onConflictDoUpdate({ target: t.modelDefaults.role, set: { modelId } })

// 2. 登录（主管）
const signIn = await fetch(`${base}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ email: "linzhou@heyagent.local", password: env.seedPassword }),
})
if (!signIn.ok) throw new Error(`登录失败 ${signIn.status}`)
const cookie = signIn.headers.get("set-cookie")!.split(";")[0]!

let total = 0
async function call(path: string, body: unknown) {
  const response = await fetch(`${base}${path}`, { method: "POST", headers: { "content-type": "application/json", cookie, origin }, body: JSON.stringify(body) })
  if (!response.ok) throw new Error(`${path} ${response.status}`)
  const text = await response.text()
  const events: AssistantStreamEvent[] = text
    .split("\n\n")
    .filter((block) => block.startsWith("data:"))
    .map((block) => assistantStreamEventSchema.parse(JSON.parse(block.slice(5))))
  let chatId = ""
  let reply = ""
  let proposal: AssistantProposal | undefined
  for (const event of events) {
    if (event.type === "chat") chatId = event.chatId
    if (event.type === "delta") reply += event.text
    if (event.type === "error") console.log(`  ✗ error：${event.message}`)
    if (event.type === "done") total += event.costUsd
    const entry = event.type === "entry" || event.type === "update" ? event.entry : undefined
    if (entry?.kind === "tool" && entry.status !== "running") console.log(`  · ${entry.label}${entry.status === "error" ? `（出错：${entry.detail?.slice(0, 120)}）` : ""}`)
    if (entry?.kind === "notice") console.log(`  ! ${entry.text}`)
    if (entry?.kind === "proposal") proposal = entry.proposal
  }
  if (proposal) {
    console.log(`  卡 ${proposal.id}（${proposal.status}）：`)
    for (const change of proposal.changes) {
      console.log(`    - ${change.title}${change.destructive ? "【删除类】" : ""}${change.result ? ` → ${change.result.ok ? "✓" : "✗"} ${change.result.message}` : ""}`)
      for (const field of change.fields) console.log(`        ${field.label}：${field.before ?? ""}${field.before !== undefined ? " → " : ""}${(field.after ?? "").slice(0, 80)}`)
    }
  }
  console.log(`  回答：${reply.trim().slice(0, 300) || "（没有文字）"}`)
  const done = events.find((event) => event.type === "done")
  return { chatId, proposal: done?.type === "done" && done.pendingProposalId ? proposal : undefined }
}

const chat = (message: string, chatId?: string, context?: AssistantPageContext) => {
  console.log(`\n> ${message}${context ? `（在 ${context.page} ${JSON.stringify(context.params)}）` : ""}`)
  return call("/api/assistant/chat", { message, chatId, context })
}
/** 应用后模型可能接着出下一张卡（例如上一项失败了重出、或者分两步建）：应用时最多跟着点 3 张 */
async function decide(chatId: string, proposal: AssistantProposal | undefined, accept: boolean, note?: string) {
  if (!proposal) throw new Error("没有出确认卡")
  let current: AssistantProposal | undefined = proposal
  let result = { chatId, proposal: undefined as AssistantProposal | undefined }
  for (let round = 0; current && round < 3; round++) {
    console.log(`\n> [${accept ? "应用" : "不要"}]${note ? ` ${note}` : ""}`)
    result = { ...(await call("/api/assistant/apply", { proposalId: current.id, accept, note })), chatId }
    current = accept ? result.proposal : undefined
  }
  return result
}

// 3. 新建技能 → 应用
const skillName = `导出报表-${Date.now() % 10000}`
let step = await chat(`新建一个技能，名字叫「${skillName}」，内容：打开后台的报表页，选好日期范围，点「导出」，把下载的文件用 file.save 存下来。`)
step = await decide(step.chatId, step.proposal, true)
const [skill] = await db.select().from(t.skills).where(eq(t.skills.name, skillName))
console.log(`  库里：技能 ${skill ? `${skill.id} ✓` : "没有 ✗"}`)

// 4. 同一段对话：停用它 → 不要
step = await chat("把刚才那个技能停用", step.chatId)
await decide(step.chatId, step.proposal, false, "先别停，我还要用")
const [skillAfter] = await db.select().from(t.skills).where(eq(t.skills.name, skillName))
console.log(`  库里：技能状态 ${skillAfter?.status}（应该没变：${skill?.status}）`)

// 5. 在任务详情里说「这个任务」
const [task] = await db.select().from(t.tasks).orderBy(desc(t.tasks.createdAt)).limit(1)
if (!task) throw new Error("库里没有任务")
step = await chat("把这个任务改成每天早上 9 点跑一次", undefined, { page: "tasks", params: { id: task.id } })
await decide(step.chatId, step.proposal, true)
const [taskAfter] = await db.select().from(t.tasks).where(eq(t.tasks.id, task.id))
console.log(`  库里：${task.id} 定时 ${task.scheduleCron} → ${taskAfter?.scheduleCron}（${taskAfter?.scheduleText}）`)

// 6. 新建任务、挂上新技能
const title = `每日导出-${Date.now() % 10000}`
step = await chat(`新建一个任务「${title}」：每周一早上 8 点导出上周的报表，用技能「${skillName}」，用便宜点的模型。`)
await decide(step.chatId, step.proposal, true)
const [created] = await db.select().from(t.tasks).where(eq(t.tasks.title, title))
const linked = created ? await db.select().from(t.taskSkills).where(eq(t.taskSkills.taskId, created.id)) : []
console.log(`  库里：任务 ${created ? `${created.id} ✓，挂了 ${linked.length} 个技能` : "没有 ✗"}`)

// 7. 审计看得出是助手改的
const audits = await db
  .select({ action: t.auditEvents.action, targetId: t.auditEvents.targetId })
  .from(t.auditEvents)
  .where(and(sql`${t.auditEvents.detail}->>'via' = 'assistant'`, sql`${t.auditEvents.at} > now() - interval '30 minutes'`))
console.log(`\n审计（via = assistant）：${audits.map((row) => `${row.action} ${row.targetId}`).join("、")}`)
console.log(`一共花了 $${total.toFixed(4)}`)
await pool.end()
