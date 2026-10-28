// 真浏览器 + 假模型：agent 用 code.run（tools: true）写循环脚本（docs/dev/solidify.md 18.1）。
// agent 先手动打开录入页，再写一段 node 脚本一次录 5 行表单（填表、标记提交、点保存、等结果、核对），最后收尾：
// 执行模型只想了 3 次；网站上 5 行都录好；脚本做的每一步都在过程里（trace.scriptStep、scriptCallId），code.run 的输出有工具汇总。
// worker 镜像里有 bwrap 就用真沙箱（脚本不能上网，只能走工具桥）；没有就直接跑 node。
import { mkdtempSync } from "node:fs"
import { rm } from "node:fs/promises"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { configureEngine, runtime } from "../src/engine/runtime.js"
import { setSandboxDeps } from "../src/sandbox/code-run.js"
import { sandboxUnavailable } from "../src/sandbox/runner.js"
import { call, createTask, eventsOf, finishWith, Script, sessionRow, setupEngine, step, useScript, waitFor, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate } from "../test/helpers.js"
import { directNodeRunner } from "../test/routine-helpers.js"
import { createProfile } from "./fixtures.js"

let ctx: EngineTestContext
let wang: string
let profileId: string
let server: Server
let base = ""
let runnerName = ""
const saved: { 名称: string; 价格: string }[] = []
const sandboxDir = mkdtempSync(join(tmpdir(), "heyagent-script-tools-browser-"))

/** 录入页：填名称、价格，点「保存」→ 存到服务器，页面提示「已保存：名称」并清空输入框；名称空着提示错误 */
const ENTRY = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>商品录入</title></head><body>
<h1>商品录入</h1>
<label>名称 <input id="name" aria-label="名称"></label>
<label>价格 <input id="price" aria-label="价格"></label>
<button id="save">保存</button>
<p id="msg"></p>
<script>
document.getElementById("save").onclick = async () => {
  const name = document.getElementById("name").value.trim()
  const price = document.getElementById("price").value.trim()
  const msg = document.getElementById("msg")
  msg.removeAttribute("role")
  msg.textContent = ""
  if (!name) { msg.setAttribute("role", "alert"); msg.textContent = "名称不能空着"; return }
  await new Promise((resolve) => setTimeout(resolve, 200))
  await fetch("/api/rows", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ 名称: name, 价格: price }) })
  msg.textContent = "已保存：" + name
  document.getElementById("name").value = ""
  document.getElementById("price").value = ""
}
</script></body></html>`

/** 一张表单：多行文字、下拉、勾选、密码（fill_form 读回实际的值，routine-library.md 18.6 第 3 条） */
const FORM = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>登记</title></head><body>
<h1>登记</h1>
<label>备注 <textarea id="note" aria-label="备注"></textarea></label>
<label>编号 <input id="code" aria-label="编号" oninput="this.value = this.value.toUpperCase()"></label>
<label>分类 <select id="kind" aria-label="分类"><option value="a">日用</option><option value="b">户外</option></select></label>
<label><input type="checkbox" id="urgent" aria-label="加急"> 加急</label>
<label>口令 <input type="password" id="pin" aria-label="口令"></label>
</body></html>`

const ROWS = [
  { 名称: "苹果", 价格: 3 },
  { 名称: "香蕉", 价格: 2 },
  { 名称: "橙子", 价格: 4 },
  { 名称: "葡萄", 价格: 9 },
  { 名称: "西瓜", 价格: 15 },
]

/** agent 写的循环脚本：一行一行填表、标记提交、点保存、等结果、核对 */
const LOOP = `import ha from "heyagent"
const rows = ${JSON.stringify(ROWS)}
for (const [i, row] of rows.entries()) {
  await ha.browser.fillForm({ fields: [
    { name: "名称", type: "textbox", target: "getByRole('textbox', { name: '名称' })", value: row.名称 },
    { name: "价格", type: "textbox", target: "getByRole('textbox', { name: '价格' })", value: String(row.价格) },
  ] })
  await ha.commit("保存第 " + (i + 1) + " 行：" + row.名称)
  await ha.browser.click({ element: "保存", target: "getByRole('button', { name: '保存' })" })
  const seen = await ha.browser.waitAny({ ok: "getByText('已保存：" + row.名称 + "')", error: "getByRole('alert')" })
  if (seen !== "ok") throw new Error("第 " + (i + 1) + " 行保存时页面报错")
  await ha.verified("第 " + (i + 1) + " 行：页面提示已保存")
  console.log("第 " + (i + 1) + " 行 " + row.名称 + " 录好了")
}`

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
  runnerName = unavailable ? `直接跑 node（${unavailable}）` : "bwrap 沙箱"
  if (unavailable) setSandboxDeps({ runner: directNodeRunner, unavailable: async () => undefined })
  console.log(`[script-tools] 跑脚本用：${runnerName}`)
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    if (url.pathname === "/api/rows" && req.method === "POST") {
      let body = ""
      req.on("data", (chunk: Buffer) => (body += chunk.toString("utf8")))
      req.on("end", () => {
        saved.push(JSON.parse(body) as { 名称: string; 价格: string })
        res.writeHead(200, { "content-type": "application/json" }).end("{}")
      })
      return
    }
    if (url.pathname === "/form") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(FORM)
    if (url.pathname === "/entry") return res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(ENTRY)
    res.writeHead(404).end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  setSandboxDeps(undefined)
  await ctx?.stop()
  await new Promise((resolve) => server?.close(resolve))
  await rm(sandboxDir, { recursive: true, force: true })
})

describe("agent 用 code.run（tools）在真 Chrome 上循环录表单", () => {
  it("先手动打开录入页，再一个脚本录 5 行：执行模型只想了 3 次，网站上 5 行都录好，每步在过程里带 scriptStep", async () => {
    const script = useScript(
      "test/script-tools-loop",
      new Script([
        step([call("browser.navigate", { url: `${base}/entry` })]),
        step([call("code.run", { language: "node", tools: true, code: LOOP, timeout: 300 }, "call-entry")]),
        step(finishWith("5 行都录好了")),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/script-tools-loop", toolIds: ["browser", "code.run"], ownerId: "u-wang" })
    await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], allowedDomains: [] }).where(eq(t.tasks.id, taskId))
    const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
    if (!res.data) throw new Error(JSON.stringify(res.error))
    const sessionId = res.data.sessionId as string
    const started = Date.now()
    const row = await waitFor(
      async () => {
        const current = await sessionRow(ctx.db, sessionId)
        return current && ["done", "failed"].includes(current.status) && current.outcome ? current : undefined
      },
      { timeout: 240_000, what: `${sessionId} 结束` }
    )
    const events = await eventsOf(ctx.db, sessionId)
    const output = events.find((event) => event.toolId === "code.run")?.output ?? ""
    console.log(`[script-tools] ${runnerName}：${Math.round((Date.now() - started) / 1000)} 秒；code.run 输出：\n${output}`)
    expect(row.outcome).toBe("achieved")
    // 执行模型只想了 3 次：打开页面、写脚本、收尾
    expect(script.prompts).toHaveLength(3)
    expect(row.stepCount).toBe(3)
    // 系统提示里有写循环脚本的那几句（任务同时有运行代码和浏览器）
    expect(script.promptText(0)).toContain("tools: true")
    expect(script.promptText(0)).toContain("fillForm({ fields: [{ name, type, target, value }] })")
    // 网站上 5 行都录好了
    expect(saved.map((each) => each.名称)).toEqual(ROWS.map((each) => each.名称))
    expect(saved.map((each) => each.价格)).toEqual(ROWS.map((each) => String(each.价格)))
    expect(output, output).toContain("第 5 行 西瓜 录好了")
    expect(output, output).toContain("脚本调了 15 次工具：browser.fill_form 5 次、browser.click 5 次、browser.wait_any 5 次")
    // code.run 自己那条也带 scriptCallId（按 id 把步骤归到它下面），它没有 scriptStep
    const scripted = events.filter((event) => event.kind === "tool" && event.trace?.scriptCallId === "call-entry" && event.toolId !== "code.run")
    expect(scripted.map((event) => event.trace?.scriptStep)).toEqual(Array.from({ length: 15 }, (_, index) => index + 1))
    expect(events.find((event) => event.toolId === "code.run")?.trace).toEqual({ scriptCallId: "call-entry" })
    expect(scripted.slice(0, 3).map((event) => event.toolId)).toEqual(["browser.fill_form", "browser.click", "browser.wait_any"])
    // 脚本做的浏览器动作照样录下代码
    expect(scripted[1]!.trace?.code).toContain("getByRole('button', { name: '保存' }).click()")
  })
})

describe("browser.fill_form 读回实际的值（真 Chrome）", () => {
  it("多行文字、下拉选中的文字、勾选框的状态都回显；页面截短了的标「和要填的不一样」；密码框不显示", async () => {
    useScript(
      "test/fill-form-readback",
      new Script([
        step([call("browser.navigate", { url: `${base}/form` })]),
        step([
          call("browser.fill_form", {
            fields: [
              { name: "备注", type: "textbox", target: "getByRole('textbox', { name: '备注' })", value: "第一行\n第二行" },
              { name: "编号", type: "textbox", target: "getByRole('textbox', { name: '编号' })", value: "ab-1" },
              { name: "分类", type: "combobox", target: "getByRole('combobox', { name: '分类' })", value: "户外" },
              { name: "加急", type: "checkbox", target: "getByRole('checkbox', { name: '加急' })", value: "true" },
              { name: "口令", type: "textbox", target: "#pin", value: "pin-SECRET-42" },
            ],
          }),
        ]),
        step(finishWith("填好了")),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/fill-form-readback", toolIds: ["browser"], ownerId: "u-wang" })
    await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], allowedDomains: [] }).where(eq(t.tasks.id, taskId))
    const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
    if (!res.data) throw new Error(JSON.stringify(res.error))
    const sessionId = res.data.sessionId as string
    await waitFor(
      async () => {
        const current = await sessionRow(ctx.db, sessionId)
        return current && ["done", "failed"].includes(current.status) && current.outcome ? current : undefined
      },
      { timeout: 120_000, what: `${sessionId} 结束` }
    )
    const output = (await eventsOf(ctx.db, sessionId)).find((event) => event.toolId === "browser.fill_form")?.output ?? ""
    expect(output, output).toContain("填进去的值（从页面上读回来的）：")
    expect(output, output).toContain('- 备注："第一行\\n第二行"\n')
    // 页面把输入改成了大写：实际的值和要填的不一样
    expect(output, output).toContain('- 编号："AB-1"（和要填的不一样）')
    expect(output, output).toContain('- 分类：选中 "户外"')
    expect(output, output).toContain("- 加急：勾上了")
    expect(output, output).toContain("- 口令：已填（密码类，不显示）")
    expect(output).not.toContain("pin-SECRET-42")
  })

  it("browser.type 也读回（sub-agents.md 21.6.5 第 5 条）：多行文字、页面改过的、密码框打码；submit 的不读", async () => {
    useScript(
      "test/type-readback",
      new Script([
        step([call("browser.navigate", { url: `${base}/form` })]),
        step([call("browser.type", { element: "备注", target: "getByRole('textbox', { name: '备注' })", text: "第一行\n第二行" })]),
        step([call("browser.type", { element: "编号", target: "getByRole('textbox', { name: '编号' })", text: "ab-1" })]),
        step([call("browser.type", { element: "口令", target: "#pin", text: "pin-SECRET-43" })]),
        step(finishWith("填好了")),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/type-readback", toolIds: ["browser"], ownerId: "u-wang" })
    await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], allowedDomains: [] }).where(eq(t.tasks.id, taskId))
    const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
    if (!res.data) throw new Error(JSON.stringify(res.error))
    const sessionId = res.data.sessionId as string
    await waitFor(
      async () => {
        const current = await sessionRow(ctx.db, sessionId)
        return current && ["done", "failed"].includes(current.status) && current.outcome ? current : undefined
      },
      { timeout: 120_000, what: `${sessionId} 结束` }
    )
    const outputs = (await eventsOf(ctx.db, sessionId)).filter((event) => event.toolId === "browser.type").map((event) => event.output ?? "")
    expect(outputs).toHaveLength(3)
    expect(outputs[0], outputs[0]).toContain('填进去的值（从页面上读回来的）：\n- 备注："第一行\\n第二行"')
    expect(outputs[1], outputs[1]).toContain('- 编号："AB-1"（和要填的不一样）')
    expect(outputs[2], outputs[2]).toContain("- 口令：已填（密码类，不显示）")
    expect(outputs.join("\n")).not.toContain("pin-SECRET-43")
  })
})
