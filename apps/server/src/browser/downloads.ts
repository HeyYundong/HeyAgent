// 运行的 Chrome 里下载的文件：一律存成这次运行的文件（kind = download），agent 能用「读附件」读。
// 做法：编排器自己开一条浏览器级的 CDP 会话，Browser.setDownloadBehavior（allowAndName：不弹「另存为」、不问「要下载多个文件吗」，
// 文件按 guid 存进这个 Chrome 自己的下载目录），再听 Browser.downloadWillBegin / downloadProgress。
// 整个浏览器的下载都走这里：链接下载、新标签页里打开的附件、网页用 blob: 生成的文件都算（实测），人在远程画面里点的下载也算。
// 编排器和 Playwright MCP 连 Chrome 时都用 noDefaults，不会改下载设置，所以这里设的不会被覆盖（实测）。不限大小。
// 下完就存文件、记一条过程记录，下一次浏览器工具的输出里告诉 agent（browser/tools.ts 调 collect）。
import { mkdirSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

import type { Browser, CDPSession } from "playwright-core"

import type { Db } from "../db/client.js"
import { appendEvent } from "../engine/records.js"
import { saveFile } from "../files/service.js"

interface WillBegin {
  guid: string
  url: string
  suggestedFilename: string
}

interface Progress {
  guid: string
  totalBytes: number
  receivedBytes: number
  state: "inProgress" | "completed" | "canceled"
  filePath?: string
}

/**
 * 可能引出下载的动作（点导出按钮、回车提交、打开下载链接……）：调完先等一小会儿看有没有新下载开始。
 * 只改输入框的（填字不带回车、填表单、选下拉）不等：几乎不会引出下载，真引出了也照样在后台存好、下次调浏览器工具时说（docs/dev/browser-speed.md D）
 */
const TRIGGER_TOOLS = new Set([
  "browser_click",
  "browser_mouse_click_xy",
  "browser_mouse_up",
  "browser_press_key",
  "browser_keyup",
  "browser_navigate",
  "browser_reload",
  "browser_tabs",
  "browser_handle_dialog",
  "browser_evaluate",
])
/**
 * 等多久：MCP 做完动作已经等过这一步引起的请求（下载的请求收到响应头时下载就开始了）和 settle，这里只兜一下底。
 * 原来 600 毫秒，每次点击、打开网页都要多等这么久（分段计时量出来的）
 */
const START_GRACE_MS = 250
/** 已经开始的下载，调完工具最多等这么久下完（再长的下载照样在后台下完、存好，下次调浏览器工具时再说） */
const FINISH_WAIT_MS = 20_000

export function sizeText(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} 字节`
}

const sourceText = (url: string) =>
  /^blob:/i.test(url) ? "网页生成的文件" : /^data:/i.test(url) ? "网页里的 data: 链接" : url.slice(0, 300)

export class DownloadCapture {
  private readonly db: Db
  private readonly sessionId: string
  readonly dir: string
  private cdp?: CDPSession
  private readonly pending = new Map<string, WillBegin & { received: number; total: number }>()
  private readonly saving = new Set<Promise<void>>()
  /** 还没告诉 agent 的话 */
  private readonly notes: string[] = []
  private closed = false

  constructor(deps: { db: Db; sessionId: string; dir: string }) {
    this.db = deps.db
    this.sessionId = deps.sessionId
    this.dir = deps.dir
  }

  async start(browser: Browser) {
    mkdirSync(this.dir, { recursive: true })
    const cdp = await browser.newBrowserCDPSession()
    this.cdp = cdp
    cdp.on("Browser.downloadWillBegin", (event) => {
      const begin = event as WillBegin
      this.pending.set(begin.guid, { ...begin, received: 0, total: 0 })
    })
    cdp.on("Browser.downloadProgress", (event) => this.onProgress(event as Progress))
    await cdp.send("Browser.setDownloadBehavior", { behavior: "allowAndName", downloadPath: this.dir, eventsEnabled: true })
  }

  private onProgress(event: Progress) {
    const item = this.pending.get(event.guid)
    if (!item) return
    if (event.state === "inProgress") {
      item.received = event.receivedBytes
      item.total = event.totalBytes
      return
    }
    this.pending.delete(event.guid)
    if (event.state === "canceled") {
      this.notes.push(`下载 ${item.suggestedFilename} 没完成（被取消了，可能是网页或网络中断）。`)
      return
    }
    const task = this.save(item, event.filePath || join(this.dir, event.guid)).finally(() => this.saving.delete(task))
    this.saving.add(task)
  }

  private async save(item: WillBegin, path: string) {
    try {
      const data = await readFile(path)
      const row = await saveFile(this.db, { data, name: item.suggestedFilename || "download", kind: "download", sessionId: this.sessionId })
      rmSync(path, { force: true })
      await appendEvent(this.db, this.sessionId, {
        kind: "plan",
        title: `浏览器里下载了 ${row.name}`,
        detail: `存成了这次运行的文件 ${row.id}（${sizeText(row.size)}），来自 ${sourceText(item.url)}`,
      }).catch(() => {})
      this.notes.push(`下载了 ${row.name}（文件 ${row.id}，${sizeText(row.size)}），可以用「读附件」（file.read）读。`)
    } catch (error) {
      console.warn(`[browser] 下载的文件没存上：${(error as Error).message}`)
      this.notes.push(`下载了 ${item.suggestedFilename}，但没存上：${(error as Error).message}`)
    }
  }

  /**
   * 调完一个浏览器工具：可能引出下载的动作先等一小会儿看有没有新下载，已经开始的等它下完（有上限），
   * 取走要告诉 agent 的话（包括之前在后台下完的、人在远程画面里下的）。
   */
  async collect(mcpToolName: string, input: Record<string, unknown> = {}): Promise<string[]> {
    if (this.closed) return []
    const trigger = TRIGGER_TOOLS.has(mcpToolName) || (mcpToolName === "browser_type" && Boolean(input.submit))
    if (trigger && !this.pending.size) await sleep(START_GRACE_MS)
    const deadline = Date.now() + FINISH_WAIT_MS
    while (this.pending.size && Date.now() < deadline) await sleep(200)
    await Promise.all([...this.saving])
    const lines = this.notes.splice(0)
    for (const item of this.pending.values())
      lines.push(
        `正在下载 ${item.suggestedFilename}（已收到 ${sizeText(item.received)}${item.total ? ` / ${sizeText(item.total)}` : ""}），下完会自动存成这次运行的文件，之后调浏览器工具时告诉你。`
      )
    return lines
  }

  /** 关 Chrome 前：等正在存的存完；没下完的记一条 */
  async close() {
    if (this.closed) return
    this.closed = true
    await Promise.race([Promise.all([...this.saving]), sleep(30_000)])
    for (const item of this.pending.values())
      await appendEvent(this.db, this.sessionId, {
        kind: "plan",
        title: `下载 ${item.suggestedFilename} 没完成`,
        detail: `Chrome 关掉时还在下（已收到 ${sizeText(item.received)}），没有存下来。`,
      }).catch(() => {})
    this.pending.clear()
    await this.cdp?.detach().catch(() => {})
  }
}

/** 运行的 Chrome 起来后调：开始接管下载。出错不影响浏览器本身（只是下载存不下来） */
export async function startDownloadCapture(browser: Browser, deps: { db: Db; sessionId: string; dir: string }) {
  const capture = new DownloadCapture(deps)
  try {
    await capture.start(browser)
    return capture
  } catch (error) {
    console.warn(`[browser] 接管下载失败，这次运行下载的文件存不下来：${(error as Error).message}`)
    return undefined
  }
}
