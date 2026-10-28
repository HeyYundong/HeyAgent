// 真浏览器 + 假模型：固化的运行时（docs/dev/solidify.md 第 3、4、6 节）。
// - 录：浏览器动作的过程记录带上 MCP 录下的 Playwright 代码和前后网址，给模型的输出里没有这一段；
// - browser.wait_any / browser.extract：等几种结果里的一个、按定位读列表（JS 写法和选择器字符串）；
// - 先跑脚本：沙箱（worker 镜像里有 bwrap 就用真沙箱）里的脚本经工具桥在真 Chrome 上跑通，执行模型一次都没调；
// - 按钮改了名字：脚本停下，agent 用同一个 Chrome 接着办成；
// - 中途遇到登录页：交给人，处理好以后脚本按重放日志跳过前面几步、在同一个 Chrome 里接着跑完（docs/dev/solidify.md 17.2）；
// - 剪贴板：脚本复制图片、点到文档的格子、粘贴，页面收到这张图（照基准站点的 /c/doc）。
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { and, eq } from "drizzle-orm"
import sharp from "sharp"
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
let runnerName = ""
const sandboxDir = mkdtempSync(join(tmpdir(), "heyagent-routine-browser-"))

/** 图片页上「大写字母 X」那张图（40×30 的 PNG）；文档页的格子贴进来的图：行 → 宽高 */
let letterPng: Buffer
const pasted = new Map<string, { width: number; height: number }>()

const html = (title: string, body: string) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`

/** 订单查询页：单号 A-1 查得到（两行），别的显示「暂无数据」。button 是按钮上的字（/orders2 改成了「搜索」） */
const ordersPage = (button: string) =>
  html(
    "订单列表",
    `<label>单号 <input id="no" aria-label="单号"></label><button id="go">${button}</button>
<div id="out"></div>
<script>
document.getElementById("go").onclick = () => setTimeout(() => {
  const no = document.getElementById("no").value
  const out = document.getElementById("out")
  out.innerHTML = no === "A-1"
    ? '<table><tr><th>单号</th><th>状态</th><th>详情</th></tr><tr><td>A-1</td><td>已发货</td><td><a href="/detail/A-1">看</a></td></tr><tr><td>A-1-2</td><td>待发货</td><td><a href="/detail/A-1-2">看</a></td></tr></table>'
    : '<p>暂无数据</p>'
}, 300)
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
  // worker 镜像里有 bwrap 和沙箱根文件系统就用真沙箱（脚本不能上网，只能走工具桥）；没有就直接跑 node
  const unavailable = await sandboxUnavailable(runtime.sandbox)
  runnerName = unavailable ? `直接跑 node（${unavailable}）` : "bwrap 沙箱"
  if (unavailable) setRoutineSandboxDeps({ runner: directNodeRunner, unavailable: async () => undefined })
  console.log(`[routine] 跑脚本用：${runnerName}`)
  letterPng = await sharp({ create: { width: 40, height: 30, channels: 3, background: { r: 200, g: 30, b: 30 } } }).png().toBuffer()
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    // 剪贴板（照基准站点 /c/search、/c/doc）：图片页、能贴图的文档格子，贴进来的图报回服务器
    if (url.pathname === "/img/x.png") return res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" }).end(letterPng)
    if (url.pathname === "/pasted" && req.method === "POST") {
      let body = ""
      req.on("data", (chunk) => (body += chunk))
      req.on("end", () => {
        const data = JSON.parse(body) as { row: string; width: number; height: number }
        pasted.set(data.row, { width: data.width, height: data.height })
        res.writeHead(200).end("ok")
      })
      return
    }
    if (url.pathname === "/pics")
      return res
        .writeHead(200, { "content-type": "text/html; charset=utf-8" })
        .end(html("图片搜索", `<h1>图片</h1><img src="/img/x.png" alt="大写字母 X" width="80"><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" alt="大写字母 E" width="80">`))
    if (url.pathname === "/doc")
      return res.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
        html(
          "字母图片表",
          `<table><tr><th>字母</th><th>图片</th></tr>${["E", "X"].map((letter) => `<tr><td>${letter}</td><td><div class="cell" contenteditable="true" data-row="${letter}" aria-label="字母 ${letter} 的图片格"></div></td></tr>`).join("")}</table>
<script>
document.querySelectorAll('.cell').forEach((cell) => cell.addEventListener('paste', async (event) => {
  event.preventDefault()
  const file = [...event.clipboardData.files].find((each) => each.type.startsWith('image/'))
  if (!file) return
  const bitmap = await createImageBitmap(file)
  const img = document.createElement('img'); img.src = URL.createObjectURL(file); img.alt = '已贴的图 ' + bitmap.width + '×' + bitmap.height; img.width = 80
  cell.replaceChildren(img)
  await fetch('/pasted', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ row: cell.dataset.row, width: bitmap.width, height: bitmap.height }) })
}))
</script>`
        )
      )
    // 会员页要登录：没登录跳到登录页（有密码框、网址带 login，引擎认成登录页、交给人）；登录页提交后写 cookie、跳回会员页
    const loggedIn = /(?:^|;\s*)member=ok/.test(req.headers.cookie ?? "")
    if (url.pathname === "/members" && !loggedIn) return res.writeHead(302, { location: "/login?next=/members" }).end()
    if (url.pathname === "/login" && req.method === "POST") return res.writeHead(302, { location: "/members", "set-cookie": "member=ok; Path=/; HttpOnly" }).end()
    const page =
      url.pathname === "/orders"
        ? ordersPage("查询")
        : url.pathname === "/orders2"
          ? ordersPage("搜索")
          : url.pathname.startsWith("/detail/")
            ? html("详情", "<h1>详情</h1>")
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

async function browserTask(modelId: string) {
  const taskId = await createTask(ctx.db, { modelId, toolIds: ["browser"], ownerId: "u-wang" })
  await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], allowedDomains: [] }).where(eq(t.tasks.id, taskId))
  return taskId
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

describe("录、browser.wait_any、browser.extract", () => {
  it("动作的过程记录带上录下的代码和前后网址（模型看不到这段）；wait_any 等到结果、超时报错；extract 读成一张表", async () => {
    const script = useScript(
      "test/routine-record",
      new Script([
        step([call("browser.navigate", { url: `${base}/orders` })]),
        step([call("browser.type", { element: "单号", target: "getByRole('textbox', { name: '单号' })", text: "A-1" })]),
        step([call("browser.click", { element: "查询", target: 'role=button[name="查询"]' })]),
        step([call("browser.wait_any", { outcomes: { found: "getByRole('row').nth(1)", empty: "getByText('暂无数据')" } })]),
        step([
          call("browser.extract", {
            list: "getByRole('row').filter({ hasText: 'A-1' })",
            fields: { 单号: "getByRole('cell').first()", 状态: "getByRole('cell').nth(1)", 链接: { target: "getByRole('link')", attr: "href" }, 备注: "css=.none" },
          }),
        ]),
        // 不给 list：定位匹配到 2 处只读第一处、给了 limit 也没用，输出里提示（docs/dev/sub-agents.md 21.7.4 第 2 条）
        step([call("browser.extract", { fields: { 订单: "getByRole('row').filter({ hasText: 'A-1' })" }, limit: 20 })]),
        step([call("browser.extract", { fields: { 单号: "getByRole('cell', { name: 'A-1-2', exact: true })" }, limit: 5 })]),
        step([call("browser.wait_any", { outcomes: { never: "text=不会出现", gone: "url=/never" }, timeout: 1 })]),
        step(finishWith("读到了")),
      ])
    )
    const sessionId = await runNow(await browserTask("test/routine-record"))
    await waitOutcome(sessionId)
    for (const index of [1, 2, 3]) expect(outputs(script, index)).not.toContain("Ran Playwright code")
    expect(outputs(script, 4)).toContain("等到了「found」")
    const table = outputs(script, 5)
    expect(table).toContain("一共 2 行，读了 2 行")
    expect(table).toContain(`| 1 | A-1 | 已发货 | ${base}/detail/A-1 | （没有） |`)
    expect(table).toContain(`| 2 | A-1-2 | 待发货 | ${base}/detail/A-1-2 | （没有） |`)
    expect(table).not.toContain("只读了第一处")
    const many = outputs(script, 6)
    expect(many).toMatch(/\| 1 \| A-1 .*已发货/)
    expect(many).not.toContain("A-1-2")
    expect(many).toContain("注意：「订单」的定位 getByRole('row').filter({ hasText: 'A-1' }) 在页面上找到 2 处，只读了第一处。要读全部，给 list")
    expect(many).toContain("（没给 list 时 limit 不起作用。）")
    const one = outputs(script, 7)
    expect(one).toContain("| 1 | A-1-2 |")
    expect(one).not.toContain("只读了第一处")
    expect(one).toContain("注意：没给 list 时 limit 不起作用，整页只读一行（每个字段读第一处）。要读多行，给 list（每一行的定位）。")
    const timedOut = outputs(script, 8)
    expect(timedOut).toContain("等了 1 秒，页面上没出现「never」、「gone」里的任何一个")
    expect(timedOut).toContain("现在的页面：「订单列表」")

    const events = (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "tool")
    const byTool = (toolId: string) => events.find((event) => event.toolId === toolId)!
    expect(byTool("browser.navigate").trace).toMatchObject({ urlAfter: `${base}/orders`, title: "订单列表" })
    expect(byTool("browser.navigate").trace?.code).toContain(`await page.goto('${base}/orders')`)
    // JS 写法的定位原样录下；选择器字符串录成 locator('…')（用快照 ref 点的，MCP 会换成稳定的 getBy… 写法）
    expect(byTool("browser.type").trace?.code).toContain("await page.getByRole('textbox', { name: '单号' }).fill('A-1')")
    expect(byTool("browser.click").trace).toMatchObject({ urlBefore: `${base}/orders`, urlAfter: `${base}/orders` })
    expect(byTool("browser.click").trace?.code).toContain(`await page.locator('role=button[name="查询"]').click()`)
    expect(byTool("browser.click").output).not.toContain("Ran Playwright code")
    expect(byTool("browser.extract").trace).toMatchObject({ urlAfter: `${base}/orders` })
  })
})

describe("先跑脚本（真 Chrome）", () => {
  const lookup = (button: string) =>
    routineCode(`
  await ha.browser.navigate({ url: ${JSON.stringify(`${base}/orders`)}.replace("/orders", input.$note ?? "/orders") })
  await ha.browser.type({ element: "单号", target: "getByRole('textbox', { name: '单号' })", text: "A-1" })
  await ha.browser.click({ element: ${JSON.stringify(button)}, target: "getByRole('button', { name: '${button}' })" })
  const seen = await ha.browser.waitAny({ found: "getByRole('row').nth(1)", empty: "getByText('暂无数据')" })
  if (seen === "empty") return ha.finish({ outcome: "not_achieved", summary: "查不到 A-1", evidence: "列表显示「暂无数据」", reason: "系统里没有这张单" })
  const { rows, total } = await ha.browser.extract({ list: "getByRole('row').filter({ hasText: 'A-' })", fields: { 单号: "getByRole('cell').nth(0)", 状态: "getByRole('cell').nth(1)" } })
  await ha.log("读到 " + total + " 行：" + JSON.stringify(rows))
  return ha.finish({ outcome: "achieved", summary: "A-1：" + rows[0].状态, evidence: "订单列表第 1 行：" + rows[0].状态 })`)

  it("脚本在沙箱里经工具桥跑通：执行模型一次都没调，步数 0；每步带 routineStep 和录下的代码；照常复核、记办成", async () => {
    const script = useScript("test/routine-direct", new Script([]))
    const taskId = await browserTask("test/routine-direct")
    await createRoutine(ctx.db, taskId, { code: lookup("查询"), name: "查订单状态" })
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(row.stepCount).toBe(0)
    expect(script.prompts).toHaveLength(0)
    expect(row.routine).toMatchObject({ state: "finished", steps: 6, logs: ['读到 2 行：[{"单号":"A-1","状态":"已发货"},{"单号":"A-1-2","状态":"待发货"}]'] })
    const events = (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "tool")
    expect(events.map((event) => [event.toolId, event.trace?.routineStep])).toEqual([
      ["browser.navigate", 1],
      ["browser.type", 2],
      ["browser.click", 3],
      ["browser.wait_any", 4],
      ["browser.extract", 5],
      ["run.finish", 6],
    ])
    expect(events[2]!.trace?.code).toContain("getByRole('button', { name: '查询' }).click()")
    const finish = await ctx.db.select({ outcomeReason: t.sessions.outcomeReason }).from(t.sessions).where(eq(t.sessions.id, sessionId))
    console.log(`[routine] ${runnerName}：${row.routine?.ms} 毫秒跑完；结果 ${finish[0]?.outcomeReason ?? ""}`)
  })

  it("按钮改了名字：脚本停在点「查询」那一步，交接的话写清楚；agent 用同一个 Chrome 从现在的页面接着办成", async () => {
    const script = useScript(
      "test/routine-fallback",
      new Script([
        step([call("browser.click", { element: "搜索", target: 'role=button[name="搜索"]' })]),
        step([call("browser.extract", { list: "getByRole('row').filter({ hasText: 'A-' })", fields: { 状态: "getByRole('cell').nth(1)" } })]),
        step(finishWith("A-1：已发货")),
      ])
    )
    const taskId = await browserTask("test/routine-fallback")
    await createRoutine(ctx.db, taskId, { code: lookup("查询"), name: "查订单状态" })
    const res = await mutate(ctx.app, "engine.runNow", wang, { taskId, note: "/orders2" })
    const sessionId = res.data!.sessionId as string
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(row.routine).toMatchObject({ state: "fell_back", steps: 3, stoppedAt: { step: 3, kind: "step_error", tool: "browser.click" } })
    const prompt = script.promptText(0)
    expect(prompt).toContain("这次运行先按固化流程「查订单状态」第 1 版跑了，做到第 3 步停下（这一步出错）")
    expect(prompt).toContain("2. type「单号」 ✓")
    expect(prompt).toContain("3. ✗ click「查询」")
    expect(prompt).toContain("会改东西的步骤：一步都还没做。")
    expect(prompt).toContain(`现在的页面：「订单列表」 ${base}/orders2`)
    // 同一个 Chrome、同一页：agent 点「搜索」以后读得到表
    expect(outputs(script, 2)).toContain("| 1 | 已发货 |")
  })

  it("脚本中途遇到登录页：照常交给人、Chrome 保留；人登录好点「已处理好了」→ 脚本按日志跳过前两步，在同一个 Chrome 里接着跑完（执行模型一次都没调）", async () => {
    const script = useScript("test/routine-resume", new Script([]))
    const taskId = await browserTask("test/routine-resume")
    await createRoutine(ctx.db, taskId, {
      name: "读会员",
      code: routineCode(`
  await ha.browser.navigate({ url: ${JSON.stringify(`${base}/orders`)} })
  await ha.browser.type({ element: "单号", target: "getByRole('textbox', { name: '单号' })", text: "A-1" })
  await ha.browser.navigate({ url: ${JSON.stringify(`${base}/members`)} })
  const { rows } = await ha.browser.extract({ fields: { 会员: "#who" } })
  return ha.finish({ outcome: "achieved", summary: rows[0].会员, evidence: "会员页：" + rows[0].会员 })`),
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
    const [item] = await ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open")))
    expect(item).toMatchObject({ kind: "login" })
    const browserId = item!.detail.browser!.browserId
    // Chrome 保留着，日志里记的就是它
    const journal = await ctx.db.select().from(t.routineJournal).where(eq(t.routineJournal.sessionId, sessionId)).orderBy(t.routineJournal.seq)
    expect(journal.map((row) => [row.tool, row.stop, row.instanceId])).toEqual([
      ["browser.navigate", null, browserId],
      ["browser.type", null, browserId],
      ["browser.navigate", "suspend", browserId],
    ])
    await waitFor(async () => (await ctx.db.select().from(t.browserInstances).where(eq(t.browserInstances.id, browserId)))[0]?.state === "held", { what: "Chrome 保留" })

    // 人在远程画面里登录（这里直接用编排器连接点）
    const page = ctx.worker.browser!.get(browserId)!.currentPage()!
    await page.fill("#pw", "secret")
    await Promise.all([page.waitForURL(/\/members/), page.click("#go")])
    const resolved = await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item!.id, how: "done", note: "登录好了" })
    expect(resolved.data).toMatchObject({ resumedSessionId: sessionId })

    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(0)
    expect(row.stepCount).toBe(0)
    expect(row.routine).toMatchObject({ state: "finished", steps: 5, resumes: 1, replayed: 2 })
    const events = await eventsOf(ctx.db, sessionId)
    // 前两步只做了一次；遇到登录页的那一步重做了一次
    expect(events.filter((event) => event.kind === "tool").map((event) => [event.toolId, event.trace?.routineStep])).toEqual([
      ["browser.navigate", 1],
      ["browser.type", 2],
      ["browser.navigate", 3],
      ["browser.navigate", 3],
      ["browser.extract", 4],
      ["run.finish", 5],
    ])
    expect(events.some((event) => event.title === "脚本接着跑：前 2 步按记录跳过，从第 3 步接着做")).toBe(true)
    const finish = events.find((event) => event.toolId === "run.finish")
    expect(finish?.input).toContain("会员：张三")
  })
})

describe("剪贴板（真 Chrome）", () => {
  it("脚本复制一张图（按 alt 定位）、点到文档的格子、ha.commit 后粘贴：页面收到这张图；clipboardRead 读回图片的 fileId；执行模型一次都没调", async () => {
    const script = useScript("test/routine-clipboard", new Script([]))
    const taskId = await browserTask("test/routine-clipboard")
    await createRoutine(ctx.db, taskId, {
      name: "贴字母图",
      code: routineCode(`
  await ha.browser.navigate({ url: ${JSON.stringify(`${base}/pics`)} })
  const copied = await ha.browser.copyImage({ element: "大写字母 X", target: "getByRole('img', { name: '大写字母 X' })" })
  await ha.browser.navigate({ url: ${JSON.stringify(`${base}/doc`)} })
  await ha.browser.click({ element: "字母 X 的图片格", target: "locator('.cell[data-row=\\"X\\"]')" })
  await ha.commit("贴 X 的图")
  await ha.browser.clipboardPaste({ fileId: copied.fileId })
  const seen = await ha.browser.waitAny({ pasted: "locator('.cell[data-row=\\"X\\"] img')", none: "url=/never" })
  const { rows } = await ha.browser.extract({ list: "locator('.cell[data-row=\\"X\\"]')", fields: { alt: { target: "locator('img')", attr: "alt" } } })
  await ha.verified("格子里有图：" + (rows[0] && rows[0].alt))
  const read = await ha.browser.clipboardRead()
  await ha.log(JSON.stringify({ copied, seen, read }))
  return ha.finish({ outcome: "achieved", summary: "贴好了 X 的图", evidence: "字母 X 的格子里：" + (rows[0] && rows[0].alt) })`),
    })
    pasted.clear()
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    const events = await eventsOf(ctx.db, sessionId)
    const tools = events.filter((event) => event.kind === "tool")
    const why = JSON.stringify({ routine: row.routine, tools: tools.map((event) => [event.toolId, event.title, event.output?.slice(0, 300)]) })
    expect(script.prompts, why).toHaveLength(0)
    expect(row.outcome, why).toBe("achieved")
    expect(row.stepCount).toBe(0)
    // 页面收到了这张图（原图 40×30）
    expect(pasted.get("X")).toEqual({ width: 40, height: 30 })
    expect(pasted.has("E")).toBe(false)
    const logged = JSON.parse(row.routine!.logs![0]!) as { copied: { fileId: string; width: number; height: number }; seen: string; read: { fileId?: string } }
    expect(logged.copied).toMatchObject({ width: 40, height: 30 })
    expect(logged.copied.fileId).toMatch(/\S/)
    expect(logged.seen).toBe("pasted")
    // 粘贴以后剪贴板里还是这张图：读回来存成了另一个文件
    expect(logged.read.fileId).toMatch(/\S/)
    expect(row.routine).toMatchObject({ state: "finished", commits: [{ label: "贴 X 的图", verified: "格子里有图：已贴的图 40×30" }] })
    expect(tools.map((event) => event.toolId)).toEqual([
      "browser.navigate",
      "browser.copy_image",
      "browser.navigate",
      "browser.click",
      "browser.clipboard_paste",
      "browser.wait_any",
      "browser.extract",
      "browser.clipboard_read",
      "run.finish",
    ])
  })
})
