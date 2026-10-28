// 真浏览器 + 假模型：剪贴板工具（docs/dev/online-sheets.md）。
// - 复制图片（ref 方式）：<img>、要登录 cookie 才给的图（证明原图走的是 Chrome 自己的网络栈）、背景图、canvas、blob: 图；
//   原图 404 时退回元素截图，复制完打的记号都去掉；贴进 contenteditable，网页收到的 paste 事件里有 image/png，尺寸等于原图；
// - 编排器自己的 Playwright 连接认不出 MCP 快照的 aria-ref（所以 ref 走 MCP 的 browser_evaluate 打记号）；
// - 表格粘贴进 textarea 是正确的 TSV；选中表格文字 → clipboard_read（copy: true）读回行列；
// - 原图走 Chrome 自己的网络栈：Chrome 配了代理时，取原图的请求也经代理（假域名只有代理解析得了）；
// - 「允许看画面」：browser_look 把截图发给模型，browser_mouse_click_xy 能点中元素，复制图片可以给坐标。
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { and, eq } from "drizzle-orm"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { PICK_ATTR } from "../src/browser/clipboard.js"
import type { BrowserManager } from "../src/browser/manager.js"
import { encodeTsv } from "../src/browser/tsv.js"
import * as t from "../src/db/schema.js"
import { call, createTask, eventsOf, Script, setupEngine, step, text, useScript, waitFor, waitStatus, type CallOptions, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate, query } from "../test/helpers.js"
import { createProfile, startSocks, type SocksUpstream } from "./fixtures.js"

let ctx: EngineTestContext
let manager: BrowserManager
let wang: string
let profileId: string
let server: Server
let base = ""
let upstream: SocksUpstream
/** 测试站点收到的请求（主机名 + 路径） */
const requests: { host: string; path: string }[] = []
const images: Record<string, Buffer> = {}

/** 只有经代理才连得上的假域名 */
const PROXIED_HOST = "pics.heyagent.test"

const solid = (width: number, height: number, r: number, g: number, b: number) =>
  sharp({ create: { width, height, channels: 3, background: { r, g, b } } }).png().toBuffer()

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>剪贴板</title>
<style>body{margin:0} .abs{position:absolute}</style></head><body>
<img id="pic" class="abs" style="left:20px;top:300px" alt="原图" src="/pic.png">
<img id="secret" alt="登录图" src="/secret.png">
<img id="broken" alt="坏图" src="/missing.png" width="50" height="30">
<div id="bg" role="img" aria-label="背景图" style="width:80px;height:60px;background-image:url(/bg.png)"></div>
<canvas id="cv" role="img" aria-label="画布" width="40" height="30"></canvas>
<img id="blobimg" alt="生成图">
<div id="editor" contenteditable="true" aria-label="编辑区" style="width:300px;height:80px;border:1px solid #888"></div>
<textarea id="ta" aria-label="文本框"></textarea>
<pre id="tbl">名称\t数量\n苹果\t3\n梨\t5</pre>
<button id="hit" class="abs" style="left:400px;top:300px;width:120px;height:40px" onclick="document.title='点中了'">点我</button>
<p id="log"></p>
<script>
  const cv = document.getElementById('cv').getContext('2d'); cv.fillStyle = '#0a0'; cv.fillRect(0, 0, 40, 30)
  const off = document.createElement('canvas'); off.width = 24; off.height = 18
  off.getContext('2d').fillRect(0, 0, 24, 18)
  off.toBlob((blob) => { document.getElementById('blobimg').src = URL.createObjectURL(blob) })
  document.getElementById('editor').addEventListener('paste', async (event) => {
    const types = [...event.clipboardData.types]
    const files = [...event.clipboardData.files]
    const entry = { types, files: [] }
    for (const file of files) { const bmp = await createImageBitmap(file); entry.files.push({ type: file.type, width: bmp.width, height: bmp.height }) }
    document.getElementById('log').textContent = JSON.stringify(entry)
  })
</script></body></html>`

beforeAll(async () => {
  ctx = await setupEngine()
  manager = ctx.worker.browser!
  wang = await login(ctx.app, "wangyue@heyagent.local")
  profileId = await createProfile(ctx.db, ctx.keyring)
  images.pic = await solid(64, 40, 200, 30, 30)
  images.secret = await solid(30, 20, 30, 30, 200)
  images.bg = await solid(16, 12, 30, 160, 30)
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    const path = url.pathname
    requests.push({ host: (req.headers.host ?? "").split(":")[0]!, path })
    const png = (data: Buffer) => {
      res.writeHead(200, { "content-type": "image/png", "cache-control": "no-store" })
      res.end(data)
    }
    if (path === "/pic.png") return png(images.pic!)
    if (path === "/bg.png") return png(images.bg!)
    // 要登录 cookie（HttpOnly）才给：Node 自己发的请求拿不到，只有 Chrome 的网络栈带得上
    if (path === "/secret.png") {
      if (!(req.headers.cookie ?? "").includes("sid=s3cret")) return res.writeHead(403).end("no")
      return png(images.secret!)
    }
    if (path === "/missing.png") return res.writeHead(404).end("not found")
    // 图片在只有经代理才连得上的假域名上（页面本身在 127.0.0.1：剪贴板只给 https 和本机地址的网页用）
    if (path === "/proxied") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
      return res.end(`<!doctype html><meta charset="utf-8"><title>代理图</title><img alt="代理图" src="http://${PROXIED_HOST}:${url.port || (server.address() as AddressInfo).port}/pic.png">`)
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "set-cookie": "sid=s3cret; Path=/; HttpOnly" })
    res.end(PAGE)
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  upstream = await startSocks("clip", "clip-pass", { hosts: { [PROXIED_HOST]: "127.0.0.1" } })
})

afterAll(async () => {
  await ctx?.stop()
  await upstream?.close()
  await new Promise((resolve) => server?.close(resolve))
})

async function browserTask(modelId: string, vision = false, profile = profileId) {
  const taskId = await createTask(ctx.db, { modelId, toolIds: ["browser"], ownerId: "u-wang" })
  await ctx.db.update(t.tasks).set({ browserProfileIds: [profile], allowedDomains: [], allowBrowserVision: vision }).where(eq(t.tasks.id, taskId))
  return taskId
}

async function runNow(taskId: string) {
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  return res.data.sessionId as string
}

/** 上一次快照里某个元素的 ref（工具输出在提示里是 JSON 转义过的） */
function refOf(options: CallOptions, name: string) {
  const found = new RegExp(`img \\\\"${name}\\\\" \\[ref=(e\\d+)\\]`).exec(JSON.stringify(options.prompt))
  if (!found) throw new Error(`快照里没有 ${name}`)
  return found[1]!
}

/** 最后一次工具输出里的文件 id */
function lastFileId(options: CallOptions) {
  const all = [...JSON.stringify(options.prompt).matchAll(/文件 id：(f-[0-9a-f]+)/g)]
  return all.at(-1)![1]!
}

let sessionId = ""
const page = () => manager.forSession(sessionId)!.currentPage()!

describe("剪贴板工具", () => {
  it("复制图片（ref）→ 贴进编辑区；登录才给的图、背景图、canvas、blob 图取原图，404 退回元素截图；表格贴进 textarea；选中表格读回", async () => {
    let ariaRefCount = -1
    let pastedLog = ""
    let textareaValue = ""
    let pickMarks = -1
    const snapshotTurn = step([call("browser.snapshot", {})])
    const script = useScript(
      "test/clipboard",
      new Script([
        step([call("browser.navigate", { url: `${base}/` })]),
        snapshotTurn,
        async (options) => {
          const ref = refOf(options, "原图")
          // 编排器自己的连接认不出 MCP 快照的 ref
          ariaRefCount = await page().locator(`aria-ref=${ref}`).count()
          return step([call("browser.copy_image", { element: "原图", target: ref })])
        },
        step([call("browser.click", { element: "编辑区", target: "#editor" })]),
        (options) => step([call("browser.clipboard_paste", { fileId: lastFileId(options) })]),
        async () => {
          // 贴进编辑区之后：网页收到的 paste 事件（Chrome 运行结束就关了，要在运行中读）
          pastedLog = await waitFor(async () => (await page().textContent("#log")) || undefined, { what: "编辑区收到粘贴", timeout: 10_000 })
          return snapshotTurn
        },
        (options) => step([call("browser.copy_image", { element: "登录图", target: refOf(options, "登录图") })]),
        snapshotTurn,
        (options) => step([call("browser.copy_image", { element: "坏图", target: refOf(options, "坏图") })]),
        snapshotTurn,
        (options) => step([call("browser.copy_image", { element: "背景图", target: refOf(options, "背景图") })]),
        snapshotTurn,
        (options) => step([call("browser.copy_image", { element: "画布", target: refOf(options, "画布") })]),
        snapshotTurn,
        (options) => step([call("browser.copy_image", { element: "生成图", target: refOf(options, "生成图") })]),
        step([call("browser.click", { element: "文本框", target: "#ta" })]),
        step([call("browser.clipboard_paste", { table: [["名称", "说明"], ["苹果", '红的\n"脆"'], ["含\t制表符", ""]] })]),
        async () => {
          textareaValue = await page().inputValue("#ta")
          // 复制过 6 张图：每次打的记号都要去掉
          pickMarks = await page().locator(`[${PICK_ATTR}]`).count()
          // 人（测试）在页面上选中表格文字
          await page().evaluate(`(() => { const range = document.createRange(); range.selectNodeContents(document.getElementById('tbl')); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range) })()`)
          return step([call("browser.clipboard_read", { copy: true })])
        },
        step([call("browser.clipboard_read", {})]),
        step([text("做完了")]),
      ])
    )
    sessionId = await runNow(await browserTask("test/clipboard"))
    await waitStatus(ctx.db, sessionId, "done", 170_000)
    const pasted = JSON.parse(pastedLog) as { types: string[]; files: { type: string; width: number; height: number }[] }
    expect(pasted.types).toContain("Files")
    expect(pasted.files).toEqual([{ type: "image/png", width: 64, height: 40 }])
    expect(pickMarks).toBe(0)
    expect(textareaValue).toBe(encodeTsv([["名称", "说明"], ["苹果", '红的\n"脆"'], ["含\t制表符", ""]]))

    expect(ariaRefCount).toBe(0)
    const names = (script.prompts[0]!.tools ?? []).map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(["browser_copy_image", "browser_clipboard_read", "browser_clipboard_paste"]))
    expect(names).not.toContain("browser_look")
    expect(names).not.toContain("browser_mouse_click_xy")

    expect(script.promptText(3)).toMatch(/已复制图片（64×40，来源：原图），剪贴板里现在是这张图；文件 id：f-[0-9a-f]+/)
    expect(script.promptText(5)).toContain("已把图片 copied-image-")
    expect(script.promptText(5)).toContain("（64×40）写进剪贴板，并在当前焦点处按了 Ctrl+V")
    expect(script.promptText(7)).toContain("已复制图片（30×20，来源：原图）")
    // 坏图按元素截（坏图的显示尺寸由 Chrome 定，不一定是 width / height 属性）
    expect(script.promptText(9)).toMatch(/已复制图片（\d+×\d+，来源：元素截图）/)
    expect(script.promptText(11)).toContain("已复制图片（16×12，来源：原图）")
    expect(script.promptText(13)).toContain("已复制图片（40×30，来源：原图）")
    expect(script.promptText(15)).toContain("已复制图片（24×18，来源：原图）")
    expect(script.promptText(17)).toContain("已把表格（3 行 × 2 列）写进剪贴板，并在当前焦点处按了 Ctrl+V")
    // 读回：按行列整理、每行带行号
    expect(script.promptText(18)).toContain("剪贴板里是表格：3 行 × 2 列")
    expect(script.promptText(18)).toContain("1\\t名称\\t数量")
    expect(script.promptText(18)).toContain("2\\t苹果\\t3")
    expect(script.promptText(19)).toContain("剪贴板里是表格：3 行 × 2 列")

    const files = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "clipboard")))
    expect(files).toHaveLength(6)
    const first = files.find((file) => file.size > 0 && file.name.startsWith("copied-image-"))!
    expect(first.mime).toBe("image/png")
    const listed = (await query(ctx.app, "engine.sessionFiles", wang, { sessionId })).data as { kind: string }[]
    expect(listed.filter((file) => file.kind === "clipboard")).toHaveLength(6)

    const titles = (await eventsOf(ctx.db, sessionId)).map((event) => event.title)
    expect(titles).toContain("复制了网页上的图片（64×40）")
    expect(titles).toContain("粘贴了表格（3 行 × 2 列）")
    expect(titles).toContain("读了剪贴板：表格 3 行 × 2 列")
    const shotEvent = (await eventsOf(ctx.db, sessionId)).find((event) => event.detail?.includes("元素截图"))
    expect(shotEvent?.detail).toMatch(/元素截图（原图拿不到：取不到（HTTP 404）/)
    // 操作历史
    const actions = await ctx.db.select().from(t.browserActions).where(eq(t.browserActions.sessionId, sessionId))
    expect(actions.map((each) => each.action)).toEqual(expect.arrayContaining(["CopyImage", "Paste", "ReadClipboard"]))
  }, 180_000)

  it("允许看画面：browser_look 把截图发给模型，browser_mouse_click_xy 能点中，复制图片可以给坐标", async () => {
    let title = ""
    let viewport = { w: 0, h: 0 }
    const script = useScript(
      "test/clipboard-vision",
      new Script([
        step([call("browser.navigate", { url: `${base}/` })]),
        step([call("browser.look", {})]),
        step([call("browser.mouse_click_xy", { x: 460, y: 320 })]),
        async () => {
          title = await page().title()
          viewport = (await page().evaluate("({ w: innerWidth, h: innerHeight })")) as typeof viewport
          return step([call("browser.copy_image", { element: "原图", x: 52, y: 320 })])
        },
        step([text("看完了")]),
      ])
    )
    sessionId = await runNow(await browserTask("test/clipboard-vision", true))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    const names = (script.prompts[0]!.tools ?? []).map((tool) => tool.name)
    expect(names).toEqual(expect.arrayContaining(["browser_look", "browser_mouse_click_xy", "browser_mouse_drag_xy"]))

    // look 的输出 + 下一条消息里是图片
    expect(script.promptText(2)).toMatch(/可见区域的截图已作为下一条消息发给你：宽 \d+、高 \d+，单位是视口 CSS 像素/)
    const lastUser = script.prompts[2]!.prompt.at(-1) as { role: string; content: { type: string; mediaType?: string }[] }
    expect(lastUser.role).toBe("user")
    expect(lastUser.content.some((part) => part.type === "file" && part.mediaType === "image/jpeg")).toBe(true)
    expect(script.promptText(2)).toContain(`宽 ${viewport.w}、高 ${viewport.h}`)
    expect(title).toBe("点中了")
    expect(script.promptText(4)).toContain("已复制图片（64×40，来源：原图）")
    const shots = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "screenshot")))
    expect(shots.some((file) => file.name.startsWith("look-"))).toBe(true)
  })

  it("Chrome 配了代理：取原图的请求也经代理（走 Chrome 自己的网络栈，不是 Node 发的）", async () => {
    const proxied = await createProfile(ctx.db, ctx.keyring, { proxy: { host: "127.0.0.1", port: upstream.port, username: "clip", password: "clip-pass" } })
    const picRequests = () => requests.filter((each) => each.host === PROXIED_HOST && each.path === "/pic.png").length
    let before = -1
    const script = useScript(
      "test/clipboard-proxy",
      new Script([
        step([call("browser.navigate", { url: `${base}/proxied` })]),
        step([call("browser.snapshot", {})]),
        async (options) => {
          before = picRequests()
          return step([call("browser.copy_image", { element: "代理图", target: refOf(options, "代理图") })])
        },
        step([text("好了")]),
      ])
    )
    sessionId = await runNow(await browserTask("test/clipboard-proxy", false, proxied))
    await waitStatus(ctx.db, sessionId, "done", 90_000)
    expect(script.promptText(3)).toContain("已复制图片（64×40，来源：原图）")
    // 页面自己加载过一次；复制时又经代理取了一次（假域名本机解析不了，到得了测试站点只能是经代理）
    expect(before).toBeGreaterThanOrEqual(1)
    expect(picRequests()).toBe(before + 1)
    expect(upstream.log.some((entry) => entry.ev === "connect" && entry.host === PROXIED_HOST)).toBe(true)
  })
})
