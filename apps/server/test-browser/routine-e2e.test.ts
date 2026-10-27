// 固化从头到尾（真 Chrome + 假模型，docs/dev/solidify.md 第 13 节 P1 验收）：
// agent 办成一次（填表保存、读回列表）→「固化成流程」→ 假固化员写出脚本 → 真 Chrome 试跑（停在第一次提交前，网站上没多存一条）
// → 待审核、要人办的事 → 启用 → 以后的运行先跑脚本（执行模型一次都没调，提交前截图存证）→ 试用满 3 次转正式。
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { ROUTINE_TRIAL_RUNS } from "@heyagent/shared"
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { configureEngine, runtime } from "../src/engine/runtime.js"
import { setRoutineSandboxDeps } from "../src/routine/runtime/run.js"
import { sandboxUnavailable } from "../src/sandbox/runner.js"
import { call, createTask, eventsOf, finishWith, Script, sessionRow, setupEngine, step, text, useScript, waitFor, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate, query } from "../test/helpers.js"
import { directNodeRunner } from "../test/routine-helpers.js"
import { createProfile } from "./fixtures.js"

const EXEC = "test/e2e-exec"
const SOLIDIFIER = "test/e2e-solidifier"

let ctx: EngineTestContext
let wang: string
let profileId: string
let server: Server
let base = ""
const items: { name: string; price: string }[] = []
const sandboxDir = mkdtempSync(join(tmpdir(), "heyagent-routine-e2e-"))

const html = (title: string, body: string) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

/** 新建页：填名称、价格，点「保存」发 POST，存好了显示「保存成功」 */
const newPage = html(
  "新建商品",
  `<label>名称 <input id="name" aria-label="名称"></label><label>价格 <input id="price" aria-label="价格"></label><button id="save">保存</button>
<div id="out"></div>
<script>
document.getElementById("save").onclick = async () => {
  const res = await fetch("/items", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: document.getElementById("name").value, price: document.getElementById("price").value }) })
  document.getElementById("out").innerHTML = res.ok ? "<p>保存成功</p>" : '<p role="alert">保存失败</p>'
}
</script>`
)

const listPage = () =>
  html(
    "商品列表",
    `<table><tr><th>名称</th><th>价格</th></tr>${items.map((item) => `<tr><td>${item.name}</td><td>${item.price}</td></tr>`).join("")}</table>`
  )

/** 固化员写出来的脚本：填表 → 提交前 ha.commit → 保存 → 等结果 → 回列表读回核对 → 报办成 */
const solidified = () => `import ha from "heyagent"

export default async function run(input) {
  await ha.browser.navigate({ url: ${JSON.stringify(`${base}/items/new`)} })
  await ha.browser.fillForm({ fields: [
    { name: "名称", type: "textbox", target: "getByLabel('名称')", value: "蓝色水杯" },
    { name: "价格", type: "textbox", target: "getByLabel('价格')", value: "12.5" },
  ] })
  await ha.commit("保存「蓝色水杯」")
  await ha.browser.click({ element: "保存", target: "getByRole('button', { name: '保存' })" })
  const saved = await ha.browser.waitAny({ ok: "getByText('保存成功')", error: "getByRole('alert')" })
  if (saved === "error") return ha.fail("page", "保存时页面报错")
  await ha.browser.navigate({ url: ${JSON.stringify(`${base}/items`)} })
  const { rows } = await ha.browser.extract({ list: "getByRole('row').filter({ hasText: '蓝色水杯' })", fields: { 价格: "getByRole('cell').nth(1)" } })
  if (!rows.length) return ha.fail("page", "保存后列表里没有「蓝色水杯」")
  await ha.verified("列表里有「蓝色水杯」，价格 " + rows[0].价格)
  return ha.finish({ outcome: "achieved", summary: "存好了「蓝色水杯」", evidence: "商品列表里有这一条，价格 " + rows[0].价格 })
}
`

beforeAll(async () => {
  ctx = await setupEngine()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  profileId = await createProfile(ctx.db, ctx.keyring)
  const res = await mutate(ctx.app, "settings.updateBrowser", await login(ctx.app, "linzhou@heyagent.local"), {
    maxPerWorker: 4,
    visionCheck: false,
    visionModel: "openrouter/qwen/qwen3.8-flash",
    captchaSolve: false,
    humanHoldMinutes: 30,
  })
  if (res.error) throw new Error(JSON.stringify(res.error))
  configureEngine({ sandbox: { ...runtime.sandbox, dir: sandboxDir } })
  const unavailable = await sandboxUnavailable(runtime.sandbox)
  if (unavailable) setRoutineSandboxDeps({ runner: directNodeRunner, unavailable: async () => undefined })
  console.log(`[routine-e2e] 跑脚本用：${unavailable ? `直接跑 node（${unavailable}）` : "bwrap 沙箱"}`)
  // 「固化」的默认模型
  await ctx.db.insert(t.models).values({ id: SOLIDIFIER, providerId: "openrouter", name: "测试固化模型", contextK: 128 }).onConflictDoNothing()
  await ctx.db.insert(t.modelDefaults).values({ role: "solidify", modelId: SOLIDIFIER }).onConflictDoUpdate({ target: t.modelDefaults.role, set: { modelId: SOLIDIFIER } })
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    if (req.method === "POST" && url.pathname === "/items") {
      let body = ""
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
      req.on("end", () => {
        const item = JSON.parse(body) as { name: string; price: string }
        items.push(item)
        res.writeHead(200, { "content-type": "application/json" }).end("{}")
      })
      return
    }
    const page = url.pathname === "/items/new" ? newPage : url.pathname === "/items" ? listPage() : undefined
    if (!page) return res.writeHead(404).end()
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  setRoutineSandboxDeps(undefined)
  await ctx?.stop()
  await new Promise((resolve) => server?.close(resolve))
  await rm(sandboxDir, { recursive: true, force: true })
})

async function runNow(taskId: string) {
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  return res.data.sessionId as string
}

async function waitOutcome(sessionId: string, timeout = 120_000) {
  return waitFor(
    async () => {
      const row = await sessionRow(ctx.db, sessionId)
      return row && ["done", "failed"].includes(row.status) && row.outcome ? row : undefined
    },
    { timeout, what: `${sessionId} 结束、结果定了` }
  )
}

describe("固化从头到尾", () => {
  it("agent 办成 → 固化成流程 → 试跑停在提交前 → 审核启用 → 以后先跑脚本、不调执行模型 → 试用满 3 次转正式", async () => {
    // 1. agent 办成一次
    const agent = useScript(
      EXEC,
      new Script([
        step([call("browser.navigate", { url: `${base}/items/new` })]),
        step([
          call("browser.fill_form", {
            fields: [
              { name: "名称", type: "textbox", target: "getByLabel('名称')", value: "蓝色水杯" },
              { name: "价格", type: "textbox", target: "getByLabel('价格')", value: "12.5" },
            ],
          }),
        ]),
        step([call("browser.click", { element: "保存", target: "getByRole('button', { name: '保存' })" })]),
        step([call("browser.wait_any", { outcomes: { ok: "getByText('保存成功')", error: "getByRole('alert')" } })]),
        step([call("browser.navigate", { url: `${base}/items` })]),
        step([call("browser.extract", { list: "getByRole('row').filter({ hasText: '蓝色水杯' })", fields: { 价格: "getByRole('cell').nth(1)" } })]),
        step(finishWith("存好了「蓝色水杯」")),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: EXEC, title: "录一个商品", goal: "在商品后台新建「蓝色水杯」，价格 12.5，保存后在列表里核对", toolIds: ["browser"], ownerId: "u-wang" })
    await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], allowedDomains: [] }).where(eq(t.tasks.id, taskId))
    const source = await waitOutcome(await runNow(taskId))
    expect(source.outcome).toBe("achieved")
    expect(items).toHaveLength(1)
    const agentCalls = agent.prompts.length

    // 2. 固化成流程：假固化员写出脚本 → 真 Chrome 试跑 → 待审核
    const solidifier = useScript(
      SOLIDIFIER,
      new Script([
        step([
          text(
            JSON.stringify({
              suitable: true,
              reason: "步骤固定：填表、保存、读回核对",
              name: "录一个商品",
              description: "1. 打开新建页\n2. 填名称、价格\n3. 点「保存」（会改东西）\n4. 等「保存成功」\n5. 回列表读回核对\n6. 报结果",
              inputSchema: JSON.stringify({ type: "object", properties: {} }),
              outputSchema: JSON.stringify({ type: "object", properties: {} }),
              code: solidified(),
              commits: ["保存「蓝色水杯」"],
              assumptions: [],
            })
          ),
        ]),
      ])
    )
    const compiled = await mutate(ctx.app, "routine.compile", wang, { sessionId: source.id })
    if (!compiled.data) throw new Error(JSON.stringify(compiled.error))
    const versionId = compiled.data.versionId as string
    const version = await waitFor(
      async () => {
        const [row] = await ctx.db.select().from(t.routineVersions).where(eq(t.routineVersions.id, versionId))
        return row && ["review", "failed"].includes(row.status) ? row : undefined
      },
      { timeout: 180_000, what: `${versionId} 写好、试跑完` }
    )
    expect(version.failReason).toBeNull()
    expect(version.status).toBe("review")
    expect(solidifier.prompts).toHaveLength(1)
    // 材料里有录下的定位代码
    expect(solidifier.promptText(0)).toContain("getByRole('button', { name: '保存' })")
    // 试跑停在第一次提交前：网站上没多存一条
    expect(items).toHaveLength(1)
    const round = version.testReport!.rounds.at(-1)!
    expect(round).toMatchObject({ round: 1, passed: true, stoppedAt: { kind: "test_commit", label: "保存「蓝色水杯」" } })
    const test = await sessionRow(ctx.db, round.sessionId)
    expect(test).toMatchObject({ kind: "routine_test", status: "done", outcome: null })
    // 试跑不进会话页
    const page = await query(ctx.app, "sessions.page", wang, { group: "ended", taskId })
    expect(JSON.stringify(page.data)).not.toContain(round.sessionId)
    // 要人办的事：审核固化流程
    const [item] = await ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.routineVersionId, versionId), eq(t.humanItems.status, "open")))
    expect(item).toMatchObject({ kind: "routine", assigneeId: "u-wang" })

    // 3. 启用：进试用期，任务开关打开「先跑流程」
    const reviewed = await mutate(ctx.app, "routine.review", wang, { versionId, approve: true })
    expect(reviewed.data).toMatchObject({ status: "approved" })
    const [task] = await ctx.db.select({ mode: t.tasks.routineMode }).from(t.tasks).where(eq(t.tasks.id, taskId))
    expect(task?.mode).toBe("first")

    // 4. 以后的运行先跑脚本：执行模型一次都没调，提交前截图存证；试用满 3 次转正式
    for (let n = 1; n <= ROUTINE_TRIAL_RUNS; n++) {
      const run = await waitOutcome(await runNow(taskId))
      expect(run.outcome).toBe("achieved")
      expect(run.stepCount).toBe(0)
      expect(run.routine).toMatchObject({ state: "finished", commits: [{ label: "保存「蓝色水杯」", verified: "列表里有「蓝色水杯」，价格 12.5" }] })
      const events = await eventsOf(ctx.db, run.id)
      expect(events.some((event) => event.title.startsWith("提交前截图"))).toBe(true)
      expect(items).toHaveLength(1 + n)
      console.log(`[routine-e2e] 第 ${n} 次先跑脚本：${run.routine?.steps} 步，${run.routine?.ms} 毫秒`)
    }
    expect(agent.prompts).toHaveLength(agentCalls)
    const summary = await query(ctx.app, "routine.get", wang, { taskId })
    expect(summary.data).toMatchObject({ status: "active", activeVersion: 1, directStreak: ROUTINE_TRIAL_RUNS, fallbackStreak: 0 })
    expect(summary.data.recent).toMatchObject({ runs: ROUTINE_TRIAL_RUNS, direct: ROUTINE_TRIAL_RUNS, fellBack: 0 })
  })
})
