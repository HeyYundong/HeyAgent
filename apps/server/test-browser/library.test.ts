// 真浏览器 + 假模型：流程库的运行时（docs/dev/routine-library.md 12.2）。库流程直接往 routine_library、tools 里写行造。
// - 任务 B 的 agent 把「查一条记录」当工具调：在 B 的 Chrome 上跑完、拿回结果；站点上按钮改了名字 → 停下交回，
//   交接的话写清做到哪一步、现在的页面，B 的 agent 用同一个 Chrome 接着做完；
// - 任务 C 的固化脚本里 ha.routine 调它，库流程中途遇到登录页 → 交给人 → 人登录好 → 脚本按日志跳过做过的（含进入库流程那一步）接着跑完。
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { and, asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { configureEngine, runtime } from "../src/engine/runtime.js"
import { setRoutineSandboxDeps } from "../src/routine/runtime/run.js"
import { sandboxUnavailable } from "../src/sandbox/runner.js"
import { call, createTask, eventsOf, finishWith, Script, sessionRow, setupEngine, step, useScript, waitFor, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate } from "../test/helpers.js"
import { createRoutine, directNodeRunner, routineCode } from "../test/routine-helpers.js"
import { createProfile } from "./fixtures.js"

let ctx: EngineTestContext
let wang: string
let profileId: string
let server: Server
let base = ""
const sandboxDir = mkdtempSync(join(tmpdir(), "heyagent-library-browser-"))

const html = (title: string, body: string) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

/** 记录查询页：编号 A-1 查得到，别的显示「暂无数据」。button 是按钮上的字（/records2 改成了「搜索」） */
const recordsPage = (button: string) =>
  html(
    "记录列表",
    `<label>编号 <input id="no" aria-label="编号"></label><button id="go">${button}</button>
<div id="out"></div>
<script>
document.getElementById("go").onclick = () => setTimeout(() => {
  const no = document.getElementById("no").value
  document.getElementById("out").innerHTML = no === "A-1"
    ? '<table><tr><th>编号</th><th>状态</th></tr><tr><td>A-1</td><td>已完成</td></tr></table>'
    : '<p>暂无数据</p>'
}, 200)
</script>`
  )

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
  console.log(`[library] 跑脚本用：${unavailable ? `直接跑 node（${unavailable}）` : "bwrap 沙箱"}`)
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    const loggedIn = /(?:^|;\s*)member=ok/.test(req.headers.cookie ?? "")
    if (url.pathname === "/members" && !loggedIn) return res.writeHead(302, { location: "/login?next=/members" }).end()
    if (url.pathname === "/login" && req.method === "POST") return res.writeHead(302, { location: "/members", "set-cookie": "member=ok; Path=/; HttpOnly" }).end()
    const page =
      url.pathname === "/records"
        ? recordsPage("查询")
        : url.pathname === "/records2"
          ? recordsPage("搜索")
          : url.pathname === "/members"
            ? html("会员", `<p id="who">会员：张三</p>`)
            : url.pathname === "/login"
              ? html("登录", `<form method="post" action="/login"><input name="user" aria-label="账号"><input id="pw" type="password" name="pw" aria-label="密码"><button id="go" type="submit">登录</button></form>`)
              : undefined
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

async function browserTask(modelId: string, toolIds: string[]) {
  const taskId = await createTask(ctx.db, { modelId, toolIds: ["browser", ...toolIds], ownerId: "u-wang" })
  await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], allowedDomains: [] }).where(eq(t.tasks.id, taskId))
  return taskId
}

let slugCounter = 0
/** 任务 A 上转过正式的一版，发布进库（直接写表） */
async function publish(title: string, body: string, inputSchema: Record<string, unknown> = {}) {
  const slug = `browser_lib_${++slugCounter}`
  const sourceTask = await browserTask("test/library-source", [])
  const { routineId, versionId } = await createRoutine(ctx.db, sourceTask, { code: routineCode(body), name: title, status: "active", inputSchema })
  await ctx.db.update(t.routineVersions).set({ provenAt: new Date() }).where(eq(t.routineVersions.id, versionId))
  const requires = { toolIds: ["browser"], browser: {}, routines: [] }
  await ctx.db.insert(t.routineLibrary).values({ routineId, slug, title, summary: `要${title}时用`, publishedVersion: 1, requires, risk: "external", publishedById: "u-lin" })
  await ctx.db.insert(t.tools).values({ id: `routine.${slug}`, name: title, summary: `要${title}时用`, description: title, source: "routine", risk: "external", routineId })
  return { routineId, slug, toolId: `routine.${slug}` }
}

async function runNow(taskId: string) {
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  return res.data.sessionId as string
}

async function waitOutcome(sessionId: string, timeout = 90_000) {
  return waitFor(
    async () => {
      const row = await sessionRow(ctx.db, sessionId)
      return row && ["done", "failed"].includes(row.status) && row.outcome ? row : undefined
    },
    { timeout, what: `${sessionId} 结束、结果定了` }
  )
}

/** 第 index 次调模型时收到的最后一条工具结果（原文） */
function outputs(script: Script, index: number): string {
  const tool = [...(script.prompts[index]?.prompt ?? [])].reverse().find((message) => message.role === "tool")
  if (!tool || tool.role !== "tool") return ""
  return tool.content.map((part) => (part.type === "tool-result" && "value" in part.output ? String(part.output.value) : "")).join("\n")
}

const LOOKUP_INPUT = {
  type: "object",
  properties: { 编号: { type: "string", description: "要查的编号" }, page: { type: "string", description: "查询页的路径" } },
  required: ["编号"],
}

const lookupBody = () => `
  await ha.browser.navigate({ url: ${JSON.stringify(base)} + (input.page ?? "/records") })
  await ha.browser.type({ element: "编号", target: "getByRole('textbox', { name: '编号' })", text: input.编号 })
  await ha.browser.click({ element: "查询", target: "getByRole('button', { name: '查询' })" })
  const seen = await ha.browser.waitAny({ found: "getByRole('row').nth(1)", empty: "getByText('暂无数据')" })
  if (seen === "empty") return ha.finish({ outcome: "not_achieved", summary: "查不到 " + input.编号, reason: "列表显示「暂无数据」" })
  const { rows } = await ha.browser.extract({ list: "getByRole('row').filter({ hasText: '" + input.编号 + "' })", fields: { 状态: "getByRole('cell').nth(1)" } })
  await ha.work.report({ data: { 状态: rows[0].状态 } })
  return ha.finish({ outcome: "achieved", summary: input.编号 + "：" + rows[0].状态, evidence: "列表第 1 行" })`

describe("agent 把库流程当工具调（真 Chrome）", () => {
  it("在调用方的 Chrome 上跑完、拿回结果；按钮改了名字 → 停下交回，agent 在同一页接着做完", async () => {
    const lib = await publish("查一条记录", lookupBody(), LOOKUP_INPUT)
    const script = useScript(
      "test/library-agent",
      new Script([
        // 中文参数名换成 p<n>（n 是它在 inputSchema 里的序号）；存进 jsonb 以后键按长短排，page 在前，「编号」是 p2
        step([call(lib.toolId, { p2: "A-1" }, "c-ok")]),
        step([call(lib.toolId, { p2: "A-1", page: "/records2" }, "c-renamed")]),
        step([call("browser.click", { element: "搜索", target: 'role=button[name="搜索"]' })]),
        step([call("browser.extract", { list: "getByRole('row').filter({ hasText: 'A-1' })", fields: { 状态: "getByRole('cell').nth(1)" } })]),
        step(finishWith("A-1：已完成")),
      ])
    )
    const sessionId = await runNow(await browserTask("test/library-agent", [lib.toolId]))
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    const done = outputs(script, 1)
    expect(done).toContain("流程「查一条记录」第 1 版跑完了：5 步")
    expect(done).toContain("结果：办成。A-1：已完成")
    expect(done).toContain("交回：状态=已完成")
    expect(done).toContain("现在的页面：「记录列表」")
    const stopped = outputs(script, 2)
    expect(stopped).toContain("流程「查一条记录」第 1 版做到第 3 步停下，没跑完（这一步出错）")
    expect(stopped).toContain("2. type「编号」 ✓")
    expect(stopped).toContain("3. ✗ click「查询」")
    expect(stopped).toContain(`现在的页面：「记录列表」 ${base}/records2`)
    expect(stopped).toContain("同样的输入不要再调这个流程")
    // 同一个 Chrome、同一页：agent 点「搜索」以后读得到表
    expect(outputs(script, 4)).toContain("已完成")
    const events = (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "tool")
    expect(events.filter((event) => event.trace?.library?.callId === "c-ok").map((event) => [event.toolId, event.trace?.library?.step])).toEqual([
      ["browser.navigate", 1],
      ["browser.type", 2],
      ["browser.click", 3],
      ["browser.wait_any", 4],
      ["browser.extract", 5],
    ])
    expect(events.find((event) => event.toolId === "browser.click" && event.trace?.library?.callId === "c-ok")?.trace?.code).toContain("getByRole('button', { name: '查询' }).click()")
    const calls = await ctx.db.select().from(t.routineCalls).where(eq(t.routineCalls.routineId, lib.routineId)).orderBy(asc(t.routineCalls.id))
    expect(calls.map((each) => [each.callId, each.via, each.result, each.stopKind, each.stopStep])).toEqual([
      ["c-ok", "tool", "achieved", null, null],
      ["c-renamed", "tool", "stopped", "step_error", 3],
    ])
  })
})

describe("固化脚本里 ha.routine 调（真 Chrome）", () => {
  it("库流程中途遇到登录页：交给人；人登录好 → 脚本按日志跳过做过的（含进入库流程），在同一个 Chrome 里接着跑完", async () => {
    const lib = await publish(
      "读会员",
      `
  await ha.browser.navigate({ url: ${JSON.stringify(`${base}/records`)} })
  await ha.browser.navigate({ url: ${JSON.stringify(`${base}/members`)} })
  const { rows } = await ha.browser.extract({ fields: { 会员: "#who" } })
  return ha.finish({ outcome: "achieved", summary: rows[0].会员, evidence: "会员页" })`
    )
    const script = useScript("test/library-script", new Script([]))
    const taskId = await browserTask("test/library-script", [lib.toolId])
    await createRoutine(ctx.db, taskId, {
      name: "先读会员",
      status: "active",
      code: routineCode(`
  const r = await ha.routine("${lib.slug}", {})
  return ha.finish({ outcome: "achieved", summary: "读到 " + r.summary, evidence: r.evidence ?? "-" })`),
    })
    const sessionId = await runNow(taskId)
    const waiting = await waitFor(
      async () => {
        const row = await sessionRow(ctx.db, sessionId)
        return row?.status === "needs_human" ? row : undefined
      },
      { timeout: 90_000, what: "遇到登录页、等人处理" }
    )
    expect(waiting.routine).toMatchObject({ state: "suspended", steps: 3, stoppedAt: { step: 3, kind: "suspend", tool: "browser.navigate" } })
    expect(waiting.routine!.stoppedAt!.label).toContain("（流程「读会员」第 2 步）")
    const [item] = await ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open")))
    expect(item).toMatchObject({ kind: "login" })
    const browserId = item!.detail.browser!.browserId
    await waitFor(async () => (await ctx.db.select().from(t.browserInstances).where(eq(t.browserInstances.id, browserId)))[0]?.state === "held", { what: "Chrome 保留" })
    const page = ctx.worker.browser!.get(browserId)!.currentPage()!
    await page.fill("#pw", "secret")
    await Promise.all([page.waitForURL(/\/members/), page.click("#go")])
    await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item!.id, how: "done", note: "登录好了" })

    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(0)
    expect(row.routine).toMatchObject({ state: "finished", resumes: 1, replayed: 2 })
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.filter((event) => event.kind === "tool").map((event) => [event.toolId, event.trace?.routineStep, event.trace?.library?.step ?? null])).toEqual([
      [lib.toolId, 1, null],
      ["browser.navigate", 2, 1],
      ["browser.navigate", 3, 2],
      ["browser.navigate", 3, 2],
      ["browser.extract", 4, 3],
      ["run.finish", 5, null],
    ])
    expect(events.find((event) => event.toolId === "run.finish")?.input).toContain("会员：张三")
    const calls = await ctx.db.select().from(t.routineCalls).where(eq(t.routineCalls.routineId, lib.routineId))
    expect(calls.map((each) => [each.callId, each.via, each.result, each.steps])).toEqual([[`${sessionId}-r1`, "script", "achieved", 3]])
  })
})
