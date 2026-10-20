// M3 真模型端到端（花钱，不在 pnpm test 里跑）：配置「审批规则 + 验收规则 + 自动记录检查点」的任务，跑一次完整的运行。
// - 规则翻译用「规划」默认模型（这里设成便宜的 Qwen Flash），执行用 Haiku，验收用 Gemini Flash；
// - 遇到审批：负责人批准；遇到验收争议：负责人「算通过」（打印报告）。
// 前提：开发库已经 pnpm db:seed，API（PORT）和 worker 都开着；.env 里有 OPENROUTER_API_KEY、SEED_PASSWORD。
// 跑之前先执行主目录的 scripts/or-usage.sh check 18。
// 用法：pnpm --filter @heyagent/server exec tsx --conditions=@heyagent/source test/m3-real-e2e.ts
import { setTimeout as sleep } from "node:timers/promises"

import { env } from "../src/env.js"

const HAIKU = "openrouter/anthropic/claude-haiku-5.5"
const GEMINI = "openrouter/google/gemini-3.8-flash"
const QWEN = "openrouter/qwen/qwen3.8-flash"
const base = `http://127.0.0.1:${env.port}`
const origin = env.trustedOrigins[0] ?? base
const apiKey = process.env.OPENROUTER_API_KEY
if (!apiKey) throw new Error("没有 OPENROUTER_API_KEY")

async function client(email: string) {
  const res = await fetch(`${base}/api/auth/sign-in/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify({ email, password: env.seedPassword }),
  })
  if (!res.ok) throw new Error(`${email} 登录失败：${res.status}`)
  const cookie = res.headers.get("set-cookie")!.split(";")[0]!
  const call = async (method: "GET" | "POST", path: string, input?: unknown) => {
    const url = method === "GET" ? `${base}/api/trpc/${path}${input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`}` : `${base}/api/trpc/${path}`
    const r = await fetch(url, { method, headers: { cookie, origin, "content-type": "application/json" }, body: method === "POST" ? JSON.stringify(input ?? {}) : undefined })
    const body = (await r.json()) as { result?: { data: any }; error?: { message: string } }
    if (body.error) throw new Error(`${path}：${body.error.message}`)
    return body.result!.data
  }
  return { q: (path: string, input?: unknown) => call("GET", path, input), m: (path: string, input?: unknown) => call("POST", path, input) }
}

const lin = await client("linzhou@heyagent.local")
const wang = await client("wangyue@heyagent.local")

const check = await lin.m("models.updateProvider", { id: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKey })
console.log("连接 OpenRouter：", check.check.ok, check.check.message)
await lin.m("models.setDefaults", { run: HAIKU, plan: QWEN, verify: GEMINI })

const rules: [string, string, string][] = [
  ["发通知前由负责人确认", "agent 要调用「通知员工」工具发通知之前", "先拦下，交给任务负责人审批，批准才发"],
  ["说做完了交给三方验收", "agent 说任务做完了时", "交给另一家的模型逐条核对检查点，没通过的反问 agent，说不清的交给负责人"],
  ["存文件后自动记检查点", "agent 存文件之后", "自动把这次的记录写进对应的检查点"],
]
const ruleIds: string[] = []
for (const [name, trigger, action] of rules) {
  const { id } = await lin.m("rules.create", { name, trigger, action, toolIds: [] })
  const result = await lin.m("rules.compile", { id })
  console.log(`规则 ${id}「${name}」→ ${result.supported ? "支持" : "不支持"}：${result.understood}`)
  if (!result.supported) continue
  await lin.m("rules.confirm", { id })
  ruleIds.push(id)
}

const task = await lin.m("tasks.create", {
  title: "整理一份三座城市的简介",
  goal: "写出北京、上海、广州各一段中文简介（每段不少于 50 字），存成 cities.md 文件，并用「通知员工」工具告诉负责人文件已经存好。",
  steps: [
    { text: "写三座城市的简介，用 file.save 存成 cities.md", wait: false, checkpoint: "简介文件已保存" },
    { text: "用通知员工工具告诉负责人文件已存好", wait: false, checkpoint: "已通知负责人" },
  ],
  schedule: null,
  ownerId: "u-wang",
  modelId: HAIKU,
  // 复核模型必填（run-outcome 2026-10-20）：用执行模型复核就够（这里不是三方验收）
  reviewModelId: HAIKU,
  toolIds: ["notify.staff", "file.save"],
  ruleIds,
})
const { sessionId } = await wang.m("engine.runNow", { taskId: task.id })
console.log(`任务 ${task.id}，规则 ${ruleIds.join("、")}，运行 ${sessionId}`)

const handled = new Set<string>()
const deadline = Date.now() + 10 * 60_000
let run: any
while (Date.now() < deadline) {
  run = await wang.q("sessions.get", { id: sessionId })
  if (run.status === "done" || run.status === "failed") break
  if (run.status === "needs_human") {
    const items = (await wang.q("todos.board")).humanItems.filter((item: any) => item.runId === sessionId && !handled.has(item.id))
    for (const item of items) {
      handled.add(item.id)
      console.log(`要人办的事 ${item.id}（${item.kind}）：${item.title}`)
      if (item.detail.toolCall) {
        console.log(`  参数：${item.detail.toolCall.input.slice(0, 300)}`)
        console.log("  批准 →", await wang.m("engine.resolveHumanItem", { itemId: item.id, how: "approve", note: "可以发" }))
      } else if (item.kind === "verify") {
        for (const each of item.detail.verification?.items ?? []) console.log(`  ${each.index}. ${each.title}：${each.verdict}——${each.reason}`)
        console.log("  算通过 →", await wang.m("engine.resolveVerifyDispute", { itemId: item.id, how: "pass", note: "我看过文件，算通过" }))
      }
    }
  }
  await sleep(3000)
}
console.log(`\n${run.id} ${run.status}，花费 $${run.costUsd.toFixed(5)}，token ${run.tokensIn}/${run.tokensOut}`)
for (const event of run.events) console.log(`${String(event.seq).padStart(3)} ${event.kind.padEnd(10)} ${event.title}`)
if (run.verification) {
  console.log("验收：", run.verification.status, run.verification.headline)
  for (const each of run.verification.items ?? []) console.log(`  ${each.index}. ${each.title}：${each.verdict}——${each.reason}`)
}
