// 剪贴板工具（docs/dev/online-sheets.md 第一节）：选了「浏览器」工具就有，不受开关控制。
// - browser.copy_image：「右键 → 复制图片」（右键菜单是 Chrome 原生的，Playwright 点不到）。找到图 → 取原图 → 转 PNG → 写进剪贴板、存成运行文件；
// - browser.clipboard_read：读剪贴板（可以先按一次 Ctrl+C），表格按行列整理、太长分段并存成文件，图片存成文件；
// - browser.clipboard_paste：把文字 / 表格（编成 TSV）/ 运行里的图片写进剪贴板，在当前焦点处按 Ctrl+V。
// 剪贴板在 CDP 隔离环境里调（网页自己的脚本看不到，不需要「允许执行脚本」）；标签页必须在前台、有焦点，每次先 bringToFront，
// 再按网页的 origin 给剪贴板权限（实测，第 0 步）。按键用编排器这条 Playwright 连接的 page.keyboard，网页收到的是正常的 paste 事件。
// 每个 Chrome 有自己的 Xvfb，剪贴板天然按运行隔离。
// 元素 ref 是 Playwright MCP 那条连接的快照生成的，编排器自己的连接认不出 aria-ref（浏览器测试里验证过），
// 所以 ref 方式由网关内部调 MCP 的 browser_evaluate 找图、给元素打一次性的记号属性，编排器再按记号定位（截图兜底），用完删掉。
// 原图一律走 Chrome 自己的网络栈（CDP Network.loadNetworkResource）：代理、登录态、白名单都在 Chrome 里；
// 绝不用 Playwright 的 context.request（Node 发的请求，会绕过代理、暴露服务器的真实 IP）。
import { randomBytes } from "node:crypto"

import { browserActionLabel } from "@heyagent/shared"
import type { CDPSession, Frame, Locator, Page } from "playwright-core"
import sharp from "sharp"
import { z } from "zod"

import type { Db } from "../db/client.js"
import { appendEvent } from "../engine/records.js"
import { runtime } from "../engine/runtime.js"
import type { SessionRow, ToolOutcome } from "../engine/tools/builtin.js"
import { getFileRow, readFileData, saveFile } from "../files/service.js"
import { sizeText } from "./downloads.js"
import type { BrowserInstance } from "./instance.js"
import type { BrowserToolEntry } from "./tools.js"
import { encodeTsv, linesPage, looksLikeTable, parseTsv, tablePage } from "./tsv.js"

/** 打在要复制的元素上的一次性记号 */
export const PICK_ATTR = "data-heyagent-pick"
/** 原图最大多少（超过就退回元素截图） */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024
/** 读剪贴板一段最多多少字：网关给模型的工具输出有上限（runtime.toolOutputMaxChars），超出会被截断存文件，所以按它来切 */
const READ_LIMIT = 20_000
/** 按完 Ctrl+C / Ctrl+V 等网页处理完 */
const KEY_SETTLE_MS = 400
const CLIPBOARD_TIMEOUT_MS = 15_000
const WORLD_NAME = "heyagent-clipboard"
/** 解码时最多多少像素（和图库一样，防止很小的文件解出巨大的图） */
const MAX_PIXELS = 100_000_000

export const COPY_IMAGE_TOOL = "browser.copy_image"
export const CLIPBOARD_READ_TOOL = "browser.clipboard_read"
export const CLIPBOARD_PASTE_TOOL = "browser.clipboard_paste"

export class ClipboardError extends Error {}

const fail = (output: string): ToolOutcome => ({ output, isError: true })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<T>((_, reject) => (timer = setTimeout(() => reject(new ClipboardError(message)), ms)))
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}

/** 找到的图（在网页里算的）。kind：img = <img>；background = 背景图；canvas；element = 没找到图，只能截元素；none = 什么都没点到 */
export interface PickedImage {
  kind: "img" | "background" | "canvas" | "element" | "none"
  src: string
  width: number
  height: number
}

/**
 * 找图（在网页里跑，字符串免得类型检查要 DOM 库）：(start, id) => PickedImage。
 * start 本身是 <img> 用它的 currentSrc；是 <canvas> 就是它；是 <picture>、链接、容器就找里面最大的 <img>；
 * 再往上几层找 <img> 或背景图（坐标模式点到的常是盖在图上的一层）；再找里面的 canvas、背景图；都没有就截 start 本身。
 */
export const PICK_FUNCTION = `(start, id) => {
  if (!start || start.nodeType !== 1) return { kind: "none", src: "", width: 0, height: 0 }
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height }
  const biggest = (list) => list.filter((el) => area(el) > 0).sort((a, b) => area(b) - area(a))[0]
  const bg = (el) => { const m = /url\\((['"]?)(.*?)\\1\\)/.exec(getComputedStyle(el).backgroundImage || ""); return m ? new URL(m[2], document.baseURI).href : "" }
  const mark = (el, kind, src) => {
    el.setAttribute(${JSON.stringify(PICK_ATTR)}, id)
    const r = el.getBoundingClientRect()
    return { kind, src: src || "", width: Math.round(el.naturalWidth || el.width || r.width), height: Math.round(el.naturalHeight || el.height || r.height) }
  }
  const img = (el) => mark(el, "img", el.currentSrc || el.src)
  if (start.tagName === "IMG") return img(start)
  if (start.tagName === "CANVAS") return mark(start, "canvas", "")
  const inner = biggest([...start.querySelectorAll("img")])
  if (inner) return img(inner)
  for (let cur = start, depth = 0; cur && cur.nodeType === 1 && depth < 6; cur = cur.parentElement, depth++) {
    if (cur.tagName === "IMG") return img(cur)
    const url = bg(cur)
    if (url) return mark(cur, "background", url)
  }
  const canvas = biggest([...start.querySelectorAll("canvas")])
  if (canvas) return mark(canvas, "canvas", "")
  const withBg = biggest([...start.querySelectorAll("*")].slice(0, 3000).filter((el) => bg(el)))
  if (withBg) return mark(withBg, "background", bg(withBg))
  return mark(start, "element", "")
}`

/** MCP 的 browser_evaluate 用的函数：ref 指向的元素 → 找图、打记号 */
export const pickByRefFunction = (id: string) => `(element) => (${PICK_FUNCTION})(element, ${JSON.stringify(id)})`

/** 坐标模式（隔离环境里跑）：这个点上叠着的元素里，先挑 <img>、canvas、有背景图的，没有就取最上面那个 */
const PICK_AT_POINT = `function (x, y, id) {
  const pick = ${PICK_FUNCTION}
  const stack = document.elementsFromPoint(x, y)
  const hasBg = (el) => /url\\(/.test(getComputedStyle(el).backgroundImage || "")
  const first = stack.find((el) => el.tagName === "IMG" || el.tagName === "CANVAS") || stack.find(hasBg) || stack[0]
  return pick(first, id)
}`

/** MCP browser_evaluate 的输出：「### Result」后面是返回值的 JSON */
export function parseEvaluateResult(output: string): unknown {
  const at = output.indexOf("### Result")
  const rest = at >= 0 ? output.slice(at + "### Result".length) : output
  const start = rest.indexOf("{")
  const end = rest.lastIndexOf("}")
  if (start < 0 || end < start) return undefined
  try {
    return JSON.parse(rest.slice(start, end + 1))
  } catch {
    return undefined
  }
}

const pickedSchema = z.object({
  kind: z.enum(["img", "background", "canvas", "element", "none"]),
  src: z.string(),
  width: z.number(),
  height: z.number(),
})

/**
 * 能用剪贴板的页面：https 网页（about:blank、chrome:// 这类没有 origin、给不了权限）。
 * 剪贴板接口只给安全的网页：http 只有本机地址（localhost、127.0.0.1）算
 */
export function clipboardPageProblem(page: Page | undefined): string | undefined {
  const url = page?.url() ?? ""
  if (!page || !url || url === "about:blank") return "还没打开网页"
  if (!/^https?:/i.test(url)) return `当前标签页是 ${url.slice(0, 100)}，这类页面用不了剪贴板，先打开要操作的网页`
  const host = new URL(url).hostname
  if (/^http:/i.test(url) && !(host === "localhost" || host.endsWith(".localhost") || host === "127.0.0.1" || host === "[::1]"))
    return "当前网页是 http（不是 https），Chrome 不让这类网页用剪贴板；换成 https 地址再试，或改用别的办法（例如上传文件）"
  return undefined
}

/** 隔离环境里的异常 → 给 agent 看得懂的话 */
export function friendlyClipboardError(message: string): string {
  if (/not focused/i.test(message)) return "标签页没有拿到焦点，剪贴板用不了（可能有弹框或别的窗口挡着）。先处理掉弹框再试"
  if (/permission|denied|NotAllowedError/i.test(message)) return "网页不允许读写剪贴板（权限被拒绝）"
  if (/超时/.test(message)) return message
  return `读写剪贴板出错：${message.split("\n")[0]!.slice(0, 200)}`
}

/** 在页面主 frame 的隔离环境里调一个函数（网页自己的 JS 看不到），参数按值传，返回按值取 */
async function callIsolated<T>(page: Page, fn: string, args: unknown[] = []): Promise<T> {
  const cdp = await page.context().newCDPSession(page)
  try {
    const tree = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } }
    const world = (await cdp.send("Page.createIsolatedWorld", { frameId: tree.frameTree.frame.id, worldName: WORLD_NAME })) as { executionContextId: number }
    const result = (await withTimeout(
      cdp.send("Runtime.callFunctionOn", {
        functionDeclaration: fn,
        executionContextId: world.executionContextId,
        arguments: args.map((value) => ({ value })),
        awaitPromise: true,
        userGesture: true,
        returnByValue: true,
      }),
      CLIPBOARD_TIMEOUT_MS,
      "剪贴板操作超时（页面可能卡住了）"
    )) as { result: { value?: unknown }; exceptionDetails?: { text?: string; exception?: { description?: string } } }
    if (result.exceptionDetails) throw new ClipboardError(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text ?? "出错了")
    return result.result.value as T
  } finally {
    await cdp.detach().catch(() => {})
  }
}

/** 剪贴板操作前：标签页拿到前台（不然 Document is not focused）、按网页的 origin 给剪贴板权限 */
async function prepare(page: Page) {
  await page.bringToFront()
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: new URL(page.url()).origin })
}

const WRITE_TEXT = `async function (text) { await navigator.clipboard.writeText(text); return true }`
const WRITE_PNG = `async function (base64) {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  await navigator.clipboard.write([new ClipboardItem({ "image/png": new Blob([bytes], { type: "image/png" }) })])
  return true
}`
const READ_ALL = `async function () {
  const out = { types: [], text: null, image: null }
  const items = await navigator.clipboard.read()
  for (const item of items) {
    for (const type of item.types) {
      out.types.push(type)
      if (type === "text/plain" && out.text === null) out.text = await (await item.getType(type)).text()
      else if (type.startsWith("image/") && !out.image) {
        const bytes = new Uint8Array(await (await item.getType(type)).arrayBuffer())
        let binary = ""
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
        out.image = { type, base64: btoa(binary) }
      }
    }
  }
  return out
}`

export async function writeClipboard(page: Page, data: { text: string } | { png: Buffer }) {
  await prepare(page)
  if ("text" in data) await callIsolated(page, WRITE_TEXT, [data.text])
  else await callIsolated(page, WRITE_PNG, [data.png.toString("base64")])
}

export interface ClipboardContent {
  types: string[]
  text?: string
  image?: { mime: string; data: Buffer }
}

export async function readClipboard(page: Page): Promise<ClipboardContent> {
  await prepare(page)
  const raw = await callIsolated<{ types: string[]; text: string | null; image: { type: string; base64: string } | null }>(page, READ_ALL)
  return {
    types: raw.types,
    ...(raw.text !== null ? { text: raw.text } : {}),
    ...(raw.image ? { image: { mime: raw.image.type, data: Buffer.from(raw.image.base64, "base64") } } : {}),
  }
}

/** 按键（真实按键，网页收到正常的 keydown / paste / copy 事件），等网页处理完 */
async function press(page: Page, keys: string) {
  await page.bringToFront()
  await page.keyboard.press(keys)
  await sleep(KEY_SETTLE_MS)
}

/** 打了记号的元素：在哪个页面的哪个 frame（ref 指的元素可能在 iframe 里） */
async function findMarked(pages: Page[], id: string): Promise<{ page: Page; frame: Frame; locator: Locator } | undefined> {
  const selector = `[${PICK_ATTR}="${id}"]`
  for (const page of pages)
    for (const frame of page.frames()) {
      const locator = frame.locator(selector).first()
      if ((await locator.count().catch(() => 0)) > 0) return { page, frame, locator }
    }
  return undefined
}

/** 用 Chrome 自己的网络栈取一个地址（代理、cookie 都是 Chrome 的）。超过上限、不是 2xx 都算拿不到 */
async function loadViaChrome(cdp: CDPSession, frameId: string, url: string): Promise<Buffer | string> {
  const { resource } = (await withTimeout(
    cdp.send("Network.loadNetworkResource", { frameId, url, options: { disableCache: false, includeCredentials: true } }),
    30_000,
    "取原图超时"
  )) as { resource: { success: boolean; httpStatusCode?: number; netErrorName?: string; stream?: string } }
  const close = async () => {
    if (resource.stream) await cdp.send("IO.close", { handle: resource.stream }).catch(() => {})
  }
  if (!resource.success || !resource.stream) {
    await close()
    return `取不到（${resource.httpStatusCode ? `HTTP ${resource.httpStatusCode}` : resource.netErrorName || "没有返回"}）`
  }
  if (resource.httpStatusCode && (resource.httpStatusCode < 200 || resource.httpStatusCode >= 300)) {
    await close()
    return `取不到（HTTP ${resource.httpStatusCode}）`
  }
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const part = (await cdp.send("IO.read", { handle: resource.stream, size: 1 << 20 })) as { data: string; base64Encoded?: boolean; eof: boolean }
      const chunk = Buffer.from(part.data, part.base64Encoded ? "base64" : "utf8")
      total += chunk.length
      if (total > MAX_IMAGE_BYTES) return `原图超过 ${sizeText(MAX_IMAGE_BYTES)}`
      chunks.push(chunk)
      if (part.eof) break
    }
  } finally {
    await close()
  }
  return Buffer.concat(chunks)
}

/** 主 frame 里打了记号的 canvas 导出 PNG、blob: 地址的图取字节（都在隔离环境里，返回 base64） */
const CANVAS_DATA = `function (id) {
  const el = document.querySelector('[${PICK_ATTR}="' + id + '"]')
  return el && el.tagName === "CANVAS" ? el.toDataURL("image/png") : null
}`
const FETCH_BLOB = `async function (src) {
  const bytes = new Uint8Array(await (await fetch(src)).arrayBuffer())
  let binary = ""
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000))
  return btoa(binary)
}`

function decodeDataUrl(src: string): Buffer | string {
  const match = /^data:([^,]*?),(.*)$/s.exec(src)
  if (!match) return "data: 地址解不开"
  const data = match[1]!.endsWith(";base64") ? Buffer.from(match[2]!, "base64") : Buffer.from(decodeURIComponent(match[2]!), "utf8")
  return data.length > MAX_IMAGE_BYTES ? `原图超过 ${sizeText(MAX_IMAGE_BYTES)}` : data
}

/** 取原图：data: 直接解；http(s) 走 Chrome 的网络栈；canvas、blob: 在隔离环境里取（只支持主 frame 里的）。拿不到返回原因 */
async function loadOriginal(target: { page: Page; frame: Frame }, picked: PickedImage, id: string): Promise<Buffer | string> {
  const mainFrame = target.frame === target.page.mainFrame()
  try {
    if (picked.kind === "canvas") {
      if (!mainFrame) return "canvas 在 iframe 里"
      const url = await callIsolated<string | null>(target.page, CANVAS_DATA, [id])
      return url ? decodeDataUrl(url) : "canvas 导不出来"
    }
    const src = picked.src
    if (!src) return "没有图片地址"
    if (/^data:/i.test(src)) return decodeDataUrl(src)
    if (/^blob:/i.test(src)) {
      if (!mainFrame) return "blob: 图片在 iframe 里"
      const data = Buffer.from(await callIsolated<string>(target.page, FETCH_BLOB, [src]), "base64")
      return data.length > MAX_IMAGE_BYTES ? `原图超过 ${sizeText(MAX_IMAGE_BYTES)}` : data
    }
    if (!/^https?:/i.test(src)) return `不支持的图片地址（${src.slice(0, 40)}）`
    const cdp = await target.page.context().newCDPSession(target.page)
    try {
      const tree = (await cdp.send("Page.getFrameTree")) as { frameTree: { frame: { id: string } } }
      return await loadViaChrome(cdp, tree.frameTree.frame.id, src)
    } finally {
      await cdp.detach().catch(() => {})
    }
  } catch (error) {
    return `出错了：${(error as Error).message.split("\n")[0]!.slice(0, 200)}`
  }
}

/** 转成 PNG（Chrome 剪贴板只收 image/png）。不是图片会抛错 */
export async function toPng(data: Buffer): Promise<{ png: Buffer; width: number; height: number }> {
  const { data: png, info } = await sharp(data, { animated: false, limitInputPixels: MAX_PIXELS }).rotate().png().toBuffer({ resolveWithObject: true })
  return { png, width: info.width, height: info.height }
}

/** 图片的宽高（不解码整张图） */
export async function imageSize(data: Buffer): Promise<{ width: number; height: number }> {
  const meta = await sharp(data, { limitInputPixels: MAX_PIXELS }).metadata()
  return { width: meta.width ?? 0, height: meta.height ?? 0 }
}

const sourceText = (src: string) => (/^data:/i.test(src) ? "网页里的 data: 图片" : /^blob:/i.test(src) ? "网页生成的图片" : src.slice(0, 200))

export interface ClipboardDeps {
  db: Db
  session: SessionRow
  attachmentIds: () => string[]
  allowVision: () => boolean
  /** 懒启动 / 分配 Chrome（和别的浏览器工具同一套）；返回 ToolOutcome = 起不来或要挂起 */
  ensure: () => Promise<BrowserInstance | ToolOutcome>
  /** 内部调 MCP 的 browser_evaluate（不受「允许执行脚本」开关限制，也不给 agent） */
  evaluate: (instance: BrowserInstance, input: { element: string; target: string; function: string }) => Promise<ToolOutcome>
  record: (name: string, failed: boolean, url: string | undefined) => Promise<void>
}

export class ClipboardTools {
  private readonly deps: ClipboardDeps

  constructor(deps: ClipboardDeps) {
    this.deps = deps
  }

  entries(): BrowserToolEntry[] {
    const vision = this.deps.allowVision()
    const copySchema = {
      type: "object",
      properties: {
        element: { type: "string", description: "给人看的图片描述（例如「商品主图」）" },
        target: { type: "string", description: "browser_snapshot 里图片（或包着图片的元素）的 ref，例如 e12" },
        ...(vision
          ? {
              x: { type: "number", description: "不给 target 时：图片上一点的 x（视口 CSS 像素，和 browser_look 截图的坐标一样）" },
              y: { type: "number", description: "不给 target 时：图片上一点的 y" },
            }
          : {}),
      },
      required: vision ? ["element"] : ["element", "target"],
      additionalProperties: false,
    }
    return [
      {
        id: COPY_IMAGE_TOOL,
        def: {
          id: COPY_IMAGE_TOOL,
          name: "浏览器：复制图片",
          summary: "相当于在网页图片上「右键 → 复制图片」：把原图复制进剪贴板，同时存成这次运行的文件",
          description: `相当于在网页图片上「右键 → 复制图片」（Chrome 的右键菜单点不到，用这个工具）：找到 target 指的图片（<img>、背景图、canvas，或元素里最大的那张），取原图（拿不到就截元素），转成 PNG 写进剪贴板，同时存成这次运行的文件。之后点到要放的位置，调 browser_clipboard_paste 粘贴。${vision ? "开了看画面时也可以不给 target、给图片上一点的坐标 x、y。" : ""}`,
          source: "builtin",
          risk: "read",
        },
        jsonSchema: copySchema,
        validator: z
          .object({ element: z.string().min(1), target: z.string().min(1).optional(), x: z.number().optional(), y: z.number().optional() })
          .refine((input) => input.target || (vision && input.x !== undefined && input.y !== undefined), { message: vision ? "要给 target，或者给坐标 x、y" : "要给 target（快照里图片的 ref）" }),
        execute: (input) => this.copyImage(input as { element: string; target?: string; x?: number; y?: number }),
      },
      {
        id: CLIPBOARD_READ_TOOL,
        def: {
          id: CLIPBOARD_READ_TOOL,
          name: "浏览器：读剪贴板",
          summary: "读剪贴板（可以先按一次 Ctrl+C）：表格按行列整理，图片存成文件",
          description:
            "读剪贴板里的内容。copy: true 先在当前焦点处按一次 Ctrl+C（先选中要复制的区域，例如在线表格在名称框里填 A1:H200 回车选中）。文字像表格（有制表符、多行）就按行列整理，每行带行号；太长分段，用 offset 接着看，完整内容同时存成文件。剪贴板里是图片就存成这次运行的文件。",
          source: "builtin",
          risk: "read",
        },
        jsonSchema: {
          type: "object",
          properties: {
            copy: { type: "boolean", description: "先按一次 Ctrl+C 复制当前选中的内容，默认 false" },
            offset: { type: "integer", minimum: 0, description: "从第几行接着看（上一次输出里告诉你的 offset），默认 0" },
          },
          additionalProperties: false,
        },
        validator: z.object({ copy: z.boolean().optional(), offset: z.number().int().min(0).optional() }),
        execute: (input) => this.read(input as { copy?: boolean; offset?: number }),
      },
      {
        id: CLIPBOARD_PASTE_TOOL,
        def: {
          id: CLIPBOARD_PASTE_TOOL,
          name: "浏览器：粘贴",
          summary: "把文字、表格或这次运行里的图片写进剪贴板，在当前焦点处按 Ctrl+V",
          description:
            "把内容写进剪贴板，再在当前焦点处按 Ctrl+V（不替你点位置：先用 browser_click 或名称框把焦点放到要贴的地方）。三选一：text 文字；table 表格（二维数组，第一行是起始行，会编成表格软件认的 TSV，格子里可以有换行）；fileId 这次运行里的图片文件（例如 browser_copy_image 存的）。往在线表格里写一块数据用 table，比逐格输入快得多。",
          source: "builtin",
          risk: "external",
        },
        jsonSchema: {
          type: "object",
          properties: {
            text: { type: "string", description: "要粘贴的文字" },
            table: { type: "array", items: { type: "array", items: { type: "string" } }, description: "要粘贴的表格：每个元素是一行，一行是各格的文字" },
            fileId: { type: "string", description: "要粘贴的图片：这次运行的文件 id（附件、产物、browser_copy_image 存的图）" },
          },
          additionalProperties: false,
        },
        validator: z
          .object({ text: z.string().optional(), table: z.array(z.array(z.string())).optional(), fileId: z.string().min(1).optional() })
          .refine((input) => [input.text !== undefined, input.table !== undefined, input.fileId !== undefined].filter(Boolean).length === 1, {
            message: "text、table、fileId 三个里给一个",
          }),
        execute: (input) => this.paste(input as { text?: string; table?: string[][]; fileId?: string }),
      },
    ]
  }

  /** 剪贴板工具都要的：起好 Chrome、拿当前页、检查能不能用剪贴板、弹框开着时 renderer 是阻塞的（CDP 调用不返回） */
  private async page(name: string, input: Record<string, unknown>): Promise<{ instance: BrowserInstance; page: Page } | ToolOutcome> {
    const ready = await this.deps.ensure()
    if (!("id" in ready)) return ready
    const instance = ready
    instance.touch()
    const page = await instance.frontPage()
    const problem = clipboardPageProblem(page)
    if (problem) return fail(problem)
    if (instance.dialogs.has(page!)) return fail("页面上开着弹框，先用 browser_handle_dialog 处理掉再用剪贴板")
    instance.viewer.announce(browserActionLabel(name, input))
    return { instance, page: page! }
  }

  private async event(title: string, detail?: string) {
    await appendEvent(this.deps.db, this.deps.session.id, { kind: "plan", title, ...(detail ? { detail } : {}) }).catch(() => {})
  }

  private async copyImage(input: { element: string; target?: string; x?: number; y?: number }): Promise<ToolOutcome> {
    const name = "browser_copy_image"
    const ready = await this.page(name, input)
    if (!("instance" in ready)) return ready
    const { instance, page } = ready
    const id = randomBytes(6).toString("hex")
    let picked: PickedImage | undefined
    if (input.target) {
      const result = await this.deps.evaluate(instance, { element: input.element, target: input.target, function: pickByRefFunction(id) })
      if (result.isError) {
        await this.deps.record(name, true, page.url())
        return fail(`没找到 ${input.target}：${result.output.replace(/^#+ Error\s*/i, "").slice(0, 300)}`)
      }
      picked = pickedSchema.safeParse(parseEvaluateResult(result.output)).data
    } else if (this.deps.allowVision() && input.x !== undefined && input.y !== undefined) {
      picked = pickedSchema.safeParse(await callIsolated(page, PICK_AT_POINT, [input.x, input.y, id]).catch(() => undefined)).data
    } else return fail("要给 target（快照里图片的 ref）")
    if (!picked || picked.kind === "none") {
      await this.deps.record(name, true, page.url())
      return fail(input.target ? `${input.target} 那里没找到图片` : `坐标 (${input.x}, ${input.y}) 那里什么都没有`)
    }

    const found = await findMarked(instance.pages(), id)
    try {
      let data: Buffer | undefined
      let source = "原图"
      let why = ""
      if (picked.kind !== "element" && found) {
        const original = await loadOriginal(found, picked, id)
        if (typeof original !== "string") data = original
        else why = original
      } else why = picked.kind === "element" ? "元素里没有图片" : "找不到元素"
      let converted: Awaited<ReturnType<typeof toPng>> | undefined
      if (data)
        converted = await toPng(data).catch(() => {
          why = "原图不是能识别的图片"
          return undefined
        })
      if (!converted) {
        // 退回元素截图（按元素截 PNG）
        const shot = found ? await found.locator.screenshot({ type: "png", timeout: 10_000 }).catch(() => undefined) : undefined
        if (!shot) {
          await this.deps.record(name, true, page.url())
          return fail(`复制图片没成功：原图拿不到（${why}），元素也截不了图`)
        }
        converted = await toPng(shot)
        source = "元素截图"
      }
      const { png, width, height } = converted
      try {
        await writeClipboard(found?.page ?? page, { png })
      } catch (error) {
        await this.deps.record(name, true, page.url())
        return fail(friendlyClipboardError((error as Error).message))
      }
      const row = await saveFile(this.deps.db, { data: png, name: `copied-image-${Date.now()}.png`, mime: "image/png", kind: "clipboard", sessionId: this.deps.session.id })
      await this.deps.record(name, false, page.url())
      await this.event(
        `复制了网页上的图片（${width}×${height}）`,
        `${source === "原图" ? `来源：原图（${sourceText(picked.src) || picked.kind}）` : `来源：元素截图（原图拿不到：${why}）`}；存成了这次运行的文件 ${row.id}（${sizeText(row.size)}）`
      )
      return {
        output: `已复制图片（${width}×${height}，来源：${source}），剪贴板里现在是这张图；文件 id：${row.id}。点到要放的位置后调 browser_clipboard_paste 粘贴（fileId 填 ${row.id}）。`,
      }
    } finally {
      await found?.locator.evaluate(`(el) => el.removeAttribute(${JSON.stringify(PICK_ATTR)})`).catch(() => {})
    }
  }

  private async read(input: { copy?: boolean; offset?: number }): Promise<ToolOutcome> {
    const name = "browser_clipboard_read"
    const ready = await this.page(name, input)
    if (!("instance" in ready)) return ready
    const { page } = ready
    let content: ClipboardContent
    try {
      if (input.copy) {
        // 先清空：没选中东西时 Ctrl+C 不改剪贴板，读到的会是上一次的内容
        await writeClipboard(page, { text: "" })
        await press(page, "Control+C")
      }
      content = await readClipboard(page)
    } catch (error) {
      await this.deps.record(name, true, page.url())
      return fail(friendlyClipboardError((error as Error).message))
    }
    await this.deps.record(name, false, page.url())
    const offset = input.offset ?? 0
    const lines: string[] = []
    const titles: string[] = []
    if (content.image) {
      const converted = await toPng(content.image.data).catch(() => undefined)
      const row = await saveFile(this.deps.db, {
        data: converted?.png ?? content.image.data,
        name: `clipboard-${Date.now()}.png`,
        mime: converted ? "image/png" : content.image.mime,
        kind: "clipboard",
        sessionId: this.deps.session.id,
      })
      const size = converted ? `${converted.width}×${converted.height}` : sizeText(row.size)
      lines.push(`剪贴板里有一张图片（${size}），已存为这次运行的文件 ${row.id}：可以用 file.read 看，或用 browser_clipboard_paste（fileId）贴到别处。`)
      titles.push(`图片 ${size}`)
    }
    const text = content.text ?? ""
    if (text) {
      const limit = Math.min(READ_LIMIT, runtime.toolOutputMaxChars - 600)
      const rows = parseTsv(text)
      const table = looksLikeTable(text, rows)
      if (table) {
        const part = tablePage(rows, offset, limit)
        titles.push(`表格 ${part.total} 行 × ${part.cols} 列`)
        lines.push(
          `剪贴板里是表格：${part.total} 行 × ${part.cols} 列（第 1 行就是复制区域的第一行）。格式：每行开头是行号，格子之间用制表符隔开，空格子留空；格子里的换行、制表符写成 \\n、\\t。`
        )
        if (offset >= part.total) lines.push(`（offset = ${offset} 已经超过最后一行）`)
        else lines.push(part.text)
        if (offset > 0 || part.next < part.total) {
          if (part.next < part.total) lines.push(`…（这里是第 ${offset + 1}～${part.next} 行，后面还有 ${part.total - part.next} 行，用 offset = ${part.next} 接着看）`)
          lines.push(await this.saveFull(text, "tsv"))
        }
      } else if (text.length <= limit && offset === 0) {
        titles.push(`文字 ${text.length} 字`)
        lines.push(`剪贴板里是文字（${text.length} 字）：`, text)
      } else {
        const part = linesPage(text, offset, limit)
        titles.push(`文字 ${text.length} 字`)
        lines.push(`剪贴板里是文字（${text.length} 字，${part.total} 行），太长分段给：每行开头是行号。`)
        lines.push(offset >= part.total ? `（offset = ${offset} 已经超过最后一行）` : part.text)
        if (part.next < part.total) lines.push(`…（这里是第 ${offset + 1}～${part.next} 行，后面还有 ${part.total - part.next} 行，用 offset = ${part.next} 接着看）`)
        lines.push(await this.saveFull(text, "txt"))
      }
    }
    if (!lines.length) {
      const others = content.types.filter((type) => type !== "text/plain")
      if (others.length) lines.push(`剪贴板里没有文字或图片（只有 ${[...new Set(others)].join("、")}）。`)
      else
        lines.push(
          input.copy ? "剪贴板是空的：按了 Ctrl+C 也没复制到东西，可能没选中内容（先选中要复制的区域，或焦点不在要复制的地方）。" : "剪贴板是空的。"
        )
      titles.push("空的")
    }
    await this.event(`读了剪贴板：${titles.join("、")}`, input.copy ? "先按了 Ctrl+C" : undefined)
    return { output: lines.join("\n") }
  }

  /** 太长的剪贴板内容整份存成文件（file.read 能读） */
  private async saveFull(text: string, ext: "tsv" | "txt") {
    const row = await saveFile(this.deps.db, { data: Buffer.from(text, "utf8"), name: `clipboard-${Date.now()}.${ext}`, kind: "clipboard", sessionId: this.deps.session.id })
    return `完整内容已存为这次运行的文件 ${row.id}（${row.name}），也可以用 file.read 读。`
  }

  private async paste(input: { text?: string; table?: string[][]; fileId?: string }): Promise<ToolOutcome> {
    const name = "browser_clipboard_paste"
    let data: { text: string } | { png: Buffer }
    let what: string
    if (input.fileId !== undefined) {
      const row = await getFileRow(this.deps.db, input.fileId)
      const allowed = row && (row.sessionId === this.deps.session.id || this.deps.attachmentIds().includes(row.id))
      if (!row || !allowed) return fail(`这次运行里没有文件 ${input.fileId}`)
      const converted = await toPng(await readFileData(row)).catch(() => undefined)
      if (!converted) return fail(`${row.name} 不是图片，只能粘贴图片文件；文字、表格用 text、table`)
      data = { png: converted.png }
      what = `图片 ${row.name}（${converted.width}×${converted.height}）`
    } else if (input.table !== undefined) {
      if (!input.table.length) return fail("table 是空的")
      const cols = input.table.reduce((max, row) => Math.max(max, row.length), 0)
      data = { text: encodeTsv(input.table) }
      what = `表格（${input.table.length} 行 × ${cols} 列）`
    } else {
      if (!input.text) return fail("text 是空的")
      data = { text: input.text }
      what = `文字（${input.text.length} 字）`
    }
    const ready = await this.page(name, {})
    if (!("instance" in ready)) return ready
    const { page } = ready
    try {
      await writeClipboard(page, data)
      await press(page, "Control+V")
    } catch (error) {
      await this.deps.record(name, true, page.url())
      return fail(friendlyClipboardError((error as Error).message))
    }
    await this.deps.record(name, false, page.url())
    await this.event(`粘贴了${what}`)
    const check = this.deps.allowVision() ? "，或用 browser_look 看一眼" : ""
    return {
      output:
        "png" in data
          ? `已把${what}写进剪贴板，并在当前焦点处按了 Ctrl+V。拿一次快照${check}确认贴上了；贴不进时用网页的「插入 → 图片 → 本地上传」配合 browser_file_upload。`
          : `已把${what}写进剪贴板，并在当前焦点处按了 Ctrl+V。要核对就选中刚贴的区域，用 browser_clipboard_read（copy: true）读回来比对${check}。`,
    }
  }
}
