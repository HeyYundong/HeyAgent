// 真浏览器 + 假模型：浏览器提速（docs/dev/browser-speed.md）。
// - browser.batch：连着做几步成功（每步一条过程、最后附页面概况和快照）；中途出错停下、报后面几步没做；
//   规则拦下、要人审批（停在那一步之前，不发起审批，单独调时照常审批）；验证码页挂起，批的结果带上 suspend；
// - 动作做完附页面概况：标题网址、弹窗和按钮；文件选择框的中文提示；
// - 被弹窗挡住：「我知道了」自动点掉再做一次、记一条过程；关闭按钮被透明层盖住时靠备用点击关掉；点完记号去掉；
//   「接受」不点，出错文字写清楚被哪个弹窗挡着；
// - 分段用时：打出来看打开网页、点击的时间花在哪。
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { and, eq } from "drizzle-orm"
import { describeCompiledRule, type CompiledRule } from "@heyagent/shared"
import { afterAll, beforeAll, describe, expect, it, onTestFinished } from "vitest"

import { DISMISS_ATTR } from "../src/browser/page-brief.js"
import { takeBrowserTimings } from "../src/browser/timing.js"
import * as t from "../src/db/schema.js"
import { call, createTask, eventsOf, Script, setupEngine, step, text, useScript, waitFor, waitStatus, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate } from "../test/helpers.js"
import { createProfile } from "./fixtures.js"

let ctx: EngineTestContext
let wang: string
let profileId: string
let server: Server
let base = ""
/** 测试站点收到的请求（路径 + 查询） */
const hits: string[] = []

const html = (title: string, body: string) => `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${title}</title><style>body{margin:0;min-height:100vh}</style></head><body>${body}</body></html>`
const ping = (path: string) => `fetch('${path}')`

const PAGES: Record<string, string> = {
  "/form": html(
    "录入",
    `<form id="f" onsubmit="event.preventDefault(); ${ping("/submit?name='+encodeURIComponent(document.getElementById('name').value)+'&qty='+document.getElementById('qty').value+'")}.then(() => { document.title = '已提交'; document.getElementById('out').textContent = '已提交：' + document.getElementById('name').value })">
<input id="name" aria-label="名称"><input id="qty" aria-label="数量"><button id="submit" type="submit">提交</button></form><p id="out"></p>`
  ),
  // 公告弹窗：全屏遮罩里的对话框，「我知道了」关掉；遮罩下面的「保存」点不到
  "/notice": html(
    "公告页",
    `<button id="behind" style="margin:40px" onclick="${ping("/behind")}; document.title = '点到了'">保存</button>
<div id="mask" style="position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:10">
<div role="dialog" aria-label="系统公告" style="background:#fff;padding:24px"><h2>系统公告</h2><p>周六晚上系统维护。</p><button onclick="document.getElementById('mask').style.display = 'none'">我知道了</button></div></div>`
  ),
  // 关闭按钮被弹窗里一层透明的 div 盖住：Playwright 的点击被拦，要靠备用点击（直接在元素上触发 click）关掉；
  // 关掉只是藏起来（按钮还在页面上），看得出记号有没有去掉
  "/notice-covered": html(
    "升级页",
    `<button id="behind2" style="margin:40px" onclick="${ping("/behind2")}; document.title = '点到了'">保存</button>
<div id="mask2" style="position:fixed;inset:0;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;z-index:10">
<div role="dialog" aria-label="升级提示" style="position:relative;background:#fff;padding:24px"><h2>升级提示</h2><p>新版本已上线。</p><button id="close2" onclick="document.getElementById('mask2').style.display = 'none'">知道了</button><div style="position:absolute;inset:0"></div></div></div>`
  ),
  // Cookie 提示条：盖住下半屏，只有「接受」（有含义，不能替人点）
  "/cookie": html(
    "Cookie 页",
    `<button id="under" style="position:absolute;left:40px;bottom:40px" onclick="${ping("/under")}">下一页</button>
<div role="dialog" aria-label="Cookie 提示" style="position:fixed;left:0;right:0;bottom:0;height:45vh;background:#222;color:#fff;z-index:5"><p>本站使用 Cookie。</p><button onclick="${ping("/accepted")}; this.parentNode.remove()">接受</button></div>`
  ),
  // 整个应用包在一个全屏 fixed 容器里（在线文档常这样）：下面没有别的内容，不算弹窗
  "/app": html("应用", `<div style="position:fixed;inset:0;background:#fff"><h1>我的文档</h1><button id="close-panel">关闭</button><button id="go" onclick="document.title = '点了'">开始</button></div>`),
  "/upload": html("上传", `<input id="file" type="file" aria-label="选文件"><button id="other">别的按钮</button>`),
  "/captcha": html("安全验证", `<h1>请完成安全验证</h1><p>拖动滑块或点击下面的按钮</p><button id="human">我不是机器人</button>`),
  // 一张 1.5 秒才加载完的图、一个点了发 1 秒请求的按钮：看打开网页、点击的时间花在哪
  "/slow": html("慢页面", `<img src="/slow.png" width="10" height="10"><button id="load" onclick="${ping("/api/slow")}.then(() => document.title = '加载好了')">加载</button>`),
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=", "base64")

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
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    hits.push(`${url.pathname}${url.search}`)
    if (url.pathname === "/slow.png") {
      setTimeout(() => res.writeHead(200, { "content-type": "image/png" }).end(PNG), 1500)
      return
    }
    if (url.pathname === "/api/slow") {
      setTimeout(() => res.writeHead(200, { "content-type": "text/plain" }).end("ok"), 1000)
      return
    }
    const page = PAGES[url.pathname]
    // 页面里 fetch 的打点（/submit、/behind……）：记下就行
    if (!page) return res.writeHead(204).end()
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" })
    res.end(page)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await ctx?.stop()
  await new Promise((resolve) => server?.close(resolve))
})

const url = (path: string) => `${base}${path}`

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

/** 取消等人处理的运行，关掉它保留着的 Chrome（后面的测试用同一个 Chrome 配置） */
async function stop(sessionId: string) {
  await mutate(ctx.app, "engine.cancel", wang, { sessionId })
  await ctx.worker.browser!.sweep()
  await waitFor(async () => !ctx.worker.browser!.forSession(sessionId), { what: "Chrome 关掉" })
}

async function addRule(taskId: string, id: string, shape: Pick<CompiledRule, "trigger" | "actions">) {
  await ctx.db.insert(t.rules).values({ id, name: id, trigger: "测试", action: "测试", compiledTrigger: { v: 1, ...shape, understood: describeCompiledRule(shape) } })
  await ctx.db.insert(t.taskRules).values({ taskId, refId: id, position: 0 })
}

/** 第 index 次调模型时收到的最后一条工具结果（原文） */
function outputs(script: Script, index: number): string {
  const tool = [...(script.prompts[index]?.prompt ?? [])].reverse().find((message) => message.role === "tool")
  if (!tool || tool.role !== "tool") return ""
  return tool.content
    .map((part) => (part.type === "tool-result" && "value" in part.output ? String(part.output.value) : ""))
    .join("\n")
}

const type = (target: string, value: string, element = target) => ({ tool: "type", input: { element, target, text: value } })
const click = (target: string, element = target) => ({ tool: "click", input: { element, target } })

describe("browser.batch", () => {
  it("连着做几步：每步一条过程，最后附页面概况和快照；中途出错就停，报后面几步没做", async () => {
    const script = useScript(
      "test/speed-batch",
      new Script([
        step([call("browser.navigate", { url: url("/form") })]),
        step([call("browser.batch", { actions: [type("#name", "苹果", "名称"), { tool: "browser_type", input: { element: "数量", target: "#qty", text: "3" } }, { tool: "browser.click", input: { element: "提交", target: "#submit" } }] })]),
        step([call("browser.batch", { actions: [type("#name", "梨", "名称"), click("#missing", "不存在的按钮"), click("#submit", "提交")], snapshot: false })]),
        step([call("browser.batch", { actions: [click("#submit"), { tool: "snapshot", input: {} }] })]),
        step([text("做完了")]),
      ])
    )
    const sessionId = await runNow(await browserTask("test/speed-batch"))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    // 单独打开网页：输出末尾有页面概况
    expect(outputs(script, 1)).toContain("现在的页面：「录入」 " + url("/form"))
    const ok = outputs(script, 2)
    expect(ok).toMatch(/1\. type「名称」 ✓（\d+\.\d 秒）/)
    expect(ok).toMatch(/2\. type「数量」 ✓/)
    expect(ok).toMatch(/3\. click「提交」 ✓/)
    expect(ok).toContain("现在的页面：「已提交」")
    expect(ok).toContain("页面快照：")
    expect(ok).toContain("已提交：苹果")
    expect(hits).toContain("/submit?name=%E8%8B%B9%E6%9E%9C&qty=3")
    const bad = outputs(script, 3)
    expect(bad).toMatch(/1\. type「名称」 ✓/)
    expect(bad).toContain("2. ✗ click「不存在的按钮」")
    expect(bad).toContain("选择器没找到元素")
    expect(bad).toContain("（后面 1 步没做）")
    expect(bad).not.toContain("页面快照：")
    expect(hits.filter((hit) => hit.startsWith("/submit"))).toHaveLength(1)
    // 只读的工具不能放进批里：整批不做
    expect(outputs(script, 4)).toContain("第 2 步的 tool「snapshot」不能放进批里")
    expect(hits.filter((hit) => hit.startsWith("/submit"))).toHaveLength(1)
    // 过程里每一步照样有一条，批本身也有一条
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.filter((event) => event.toolId === "browser.type")).toHaveLength(3)
    expect(events.filter((event) => event.toolId === "browser.click")).toHaveLength(2)
    expect(events.filter((event) => event.kind === "tool" && event.toolId === "browser.batch")).toHaveLength(2)
    expect(events.some((event) => event.kind === "rule" && event.title === "拦下：浏览器：连着做几步")).toBe(true)
  })

  it("规则拦下：停在那一步、报原因；要人审批：停在那一步之前、不发起审批，单独调用时照常交给人审批", async () => {
    const script = useScript(
      "test/speed-rules",
      new Script([
        step([call("browser.navigate", { url: url("/form") })]),
        step([call("browser.batch", { actions: [type("#name", "桃", "名称"), click("#submit", "提交"), type("#qty", "9", "数量")], snapshot: false })]),
        step([call("browser.batch", { actions: [type("#name", "李", "名称"), { tool: "press_key", input: { key: "Enter" } }], snapshot: false })]),
        step([call("browser.press_key", { key: "Enter" })]),
      ])
    )
    const taskId = await browserTask("test/speed-rules")
    await addRule(taskId, "rl-speed-deny", { trigger: { type: "before_tool", toolIds: ["browser.click"], risks: [] }, actions: [{ type: "deny", reason: "不许点提交" }] })
    await ctx.db.insert(t.rules).values({ id: "rl-speed-ask", name: "按回车要审批", trigger: "测试", action: "测试", compiledTrigger: { v: 1, trigger: { type: "before_tool", toolIds: ["browser.press_key"], risks: [] }, actions: [{ type: "ask_human", recipient: { to: "owner" } }], understood: "按回车前交给负责人审批" } })
    await ctx.db.insert(t.taskRules).values({ taskId, refId: "rl-speed-ask", position: 1 })
    const sessionId = await runNow(taskId)
    onTestFinished(() => stop(sessionId))
    await waitStatus(ctx.db, sessionId, "needs_human", 90_000)
    const denied = outputs(script, 2)
    expect(denied).toMatch(/1\. type「名称」 ✓/)
    expect(denied).toContain("2. ✗ click「提交」：被拦下：")
    expect(denied).toContain("不许点提交")
    expect(denied).toContain("（后面 1 步没做）")
    const asked = outputs(script, 3)
    expect(asked).toMatch(/1\. type「名称」 ✓/)
    expect(asked).toContain("2. press_key「Enter」 没做：规则「按回车要审批」要求这一步先交给人审批")
    expect(asked).toContain("单独调用这一步（browser_press_key）")
    expect(hits.some((hit) => hit.startsWith("/submit?name=%E6%9D%8E"))).toBe(false)
    // 单独调用：照常交给人审批（只有这一次生成了审批）
    const items = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.sessionId, sessionId))
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ kind: "approval", ruleId: "rl-speed-ask", status: "open" })
    const titles = (await eventsOf(ctx.db, sessionId)).map((event) => event.title)
    expect(titles).toContain("规则「按回车要审批」：批里的第 2 步 浏览器：press_key 要人审批，没做")
    expect(titles).toContain("规则「按回车要审批」：拦下 浏览器：press_key，交给人审批")
  })

  it("某一步遇到验证码页：批停下，带出 suspend，运行等人处理（内置转人工照常）", async () => {
    useScript(
      "test/speed-suspend",
      new Script([step([call("browser.batch", { actions: [{ tool: "navigate", input: { url: url("/captcha") } }, click("#human", "我不是机器人")] })]), step([text("不该走到这里")])])
    )
    const sessionId = await runNow(await browserTask("test/speed-suspend"))
    onTestFinished(() => stop(sessionId))
    await waitStatus(ctx.db, sessionId, "needs_human", 90_000)
    const [item] = await ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open")))
    expect(item).toMatchObject({ kind: "login" })
    const events = await eventsOf(ctx.db, sessionId)
    const batch = events.find((event) => event.toolId === "browser.batch")
    expect(batch?.output).toContain("检测到验证码")
    expect(batch?.output).toContain("（后面 1 步没做）")
    expect(events.filter((event) => event.toolId === "browser.click")).toHaveLength(0)
  })
})

describe("页面概况、弹窗", () => {
  it("打开有公告弹窗的页面：概况里写弹窗和按钮；点被挡住的按钮：自动点「我知道了」、再做一次，记一条过程", async () => {
    let sessionId = ""
    let marks = -1
    const script = useScript(
      "test/speed-notice",
      new Script([
        step([call("browser.navigate", { url: url("/notice") })]),
        step([call("browser.click", { element: "保存", target: "#behind" })]),
        async () => {
          // 点完关闭按钮以后记号要去掉（Chrome 运行结束就关了，要在运行中读）
          marks = await ctx.worker.browser!.forSession(sessionId)!.currentPage()!.locator(`[${DISMISS_ATTR}]`).count()
          return step([text("做完了")])
        },
      ])
    )
    sessionId = await runNow(await browserTask("test/speed-notice"))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    expect(marks).toBe(0)
    expect(outputs(script, 1)).toContain("页面上有弹窗「系统公告」，按钮：我知道了")
    const clicked = outputs(script, 2)
    expect(clicked).toContain("系统点了「我知道了」关掉它，再做了一次")
    expect(clicked).toContain("现在的页面：「点到了」")
    expect(clicked).not.toContain("页面上有弹窗")
    expect(hits).toContain("/behind")
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.some((event) => event.kind === "plan" && event.title === "自动关掉了弹窗「系统公告」（点了「我知道了」）")).toBe(true)
    expect(events.find((event) => event.toolId === "browser.click")?.title).toBe("浏览器：click")
  })

  it("关闭按钮被透明层盖住、Playwright 点不到：备用点击直接在元素上触发 click 关掉弹窗，再做一次；记号去掉", async () => {
    let sessionId = ""
    let state = { marks: -1, mask: "" }
    const script = useScript(
      "test/speed-covered",
      new Script([
        step([call("browser.navigate", { url: url("/notice-covered") })]),
        step([call("browser.click", { element: "保存", target: "#behind2" })]),
        async () => {
          const page = ctx.worker.browser!.forSession(sessionId)!.currentPage()!
          state = {
            marks: await page.locator(`[${DISMISS_ATTR}]`).count(),
            mask: (await page.evaluate("getComputedStyle(document.getElementById('mask2')).display")) as string,
          }
          return step([text("做完了")])
        },
      ])
    )
    sessionId = await runNow(await browserTask("test/speed-covered"))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    expect(outputs(script, 1)).toContain("页面上有弹窗「升级提示」，按钮：知道了")
    const clicked = outputs(script, 2)
    expect(clicked).toContain("系统点了「知道了」关掉它，再做了一次")
    expect(clicked).toContain("现在的页面：「点到了」")
    expect(hits).toContain("/behind2")
    expect(state).toEqual({ marks: 0, mask: "none" })
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.some((event) => event.kind === "plan" && event.title === "自动关掉了弹窗「升级提示」（点了「知道了」）")).toBe(true)
  })

  it("挡着的弹窗只有「接受」：不替人点，出错文字写清楚被哪个弹窗挡着", async () => {
    const script = useScript(
      "test/speed-cookie",
      new Script([step([call("browser.navigate", { url: url("/cookie") })]), step([call("browser.click", { element: "下一页", target: "#under" })]), step([text("做完了")])])
    )
    const sessionId = await runNow(await browserTask("test/speed-cookie"))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    expect(outputs(script, 1)).toContain("页面上有弹窗「Cookie 提示」，按钮：接受")
    expect(outputs(script, 2)).toContain("点不到：被弹窗「Cookie 提示」（按钮：接受）挡住了，先处理弹窗。")
    expect(hits).not.toContain("/accepted")
    expect(hits).not.toContain("/under")
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.some((event) => event.title.startsWith("自动关掉了弹窗"))).toBe(false)
  })

  it("整个应用包在全屏 fixed 容器里：不算弹窗，点击照常", async () => {
    const script = useScript(
      "test/speed-app",
      new Script([step([call("browser.navigate", { url: url("/app") })]), step([call("browser.click", { element: "开始", target: "#go" })]), step([text("做完了")])])
    )
    const sessionId = await runNow(await browserTask("test/speed-app"))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    expect(outputs(script, 1)).toContain("现在的页面：「应用」")
    expect(outputs(script, 1)).not.toContain("页面上有弹窗")
    expect(outputs(script, 2)).toContain("现在的页面：「点了」")
  })

  it("点了文件框：提示用 browser_file_upload 上传或取消；选择框开着时别的动作报错并说明", async () => {
    const script = useScript(
      "test/speed-upload",
      new Script([
        step([call("browser.navigate", { url: url("/upload") })]),
        step([call("browser.click", { element: "选文件", target: "#file" })]),
        step([call("browser.batch", { actions: [click("#other", "别的按钮")] })]),
        step([call("browser.file_upload", {})]),
        step([text("做完了")]),
      ])
    )
    const sessionId = await runNow(await browserTask("test/speed-upload"))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    const opened = outputs(script, 2)
    expect(opened).toContain("页面打开了文件选择框：要上传就调 browser_file_upload")
    expect(opened).not.toContain("### Modal state")
    const blocked = outputs(script, 3)
    expect(blocked).toContain("1. ✗ click「别的按钮」")
    expect(blocked).toContain("页面上有文件选择框或网页弹框没处理")
    expect(blocked).toContain("页面打开了文件选择框")
    expect(outputs(script, 4)).not.toContain("页面打开了文件选择框")
  })
})

describe("分段用时", () => {
  it("打开网页、点击（引起一个 1 秒的请求）：记下 MCP、扫页面、检测、概况各花多少", async () => {
    useScript(
      "test/speed-timing",
      new Script([
        step([call("browser.navigate", { url: url("/slow") })]),
        step([call("browser.click", { element: "加载", target: "#load" })]),
        step([call("browser.click", { element: "加载", target: "#load" })]),
        step([text("做完了")]),
      ])
    )
    const sessionId = await runNow(await browserTask("test/speed-timing"))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    const timings = takeBrowserTimings(sessionId)
    for (const each of timings) console.log(`[分段用时] ${each.toolId} 共 ${each.totalMs} 毫秒：${Object.entries(each.phases).map(([phase, ms]) => `${phase} ${ms}`).join("，")}`)
    // 后台的存档截图也记一条（不在关键路径上）
    expect(timings.map((each) => each.toolId).sort()).toEqual(["browser.archive_screenshot", "browser.click", "browser.click", "browser.navigate"])
    for (const each of timings.filter((timing) => timing.toolId !== "browser.archive_screenshot")) expect(Object.keys(each.phases)).toEqual(expect.arrayContaining(["before", "mcp", "sweep", "detect", "brief", "after"]))
    // 点击引起 1 秒的请求：MCP 等它回来（加上 200 毫秒的 settle）
    expect(timings.find((timing) => timing.toolId === "browser.click")!.phases.mcp).toBeGreaterThanOrEqual(1000)
    // 存档截图在后台：运行结束前存完了
    const shots = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "screenshot")))
    expect(shots.length).toBeGreaterThanOrEqual(1)
  })
})
