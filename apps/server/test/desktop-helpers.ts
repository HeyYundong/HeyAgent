// 桌面测试用的假服务：假的 Windows-MCP（streamable HTTP，同样的工具名，查 Bearer 密钥）和假的桌面服务（/health、/screenshot、/files、/view）。
// 都只绑 127.0.0.1 的随机端口，记下收到的调用，测试里断言。
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"

import { serve } from "@hono/node-server"
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server"
import sharp from "sharp"
import { WebSocketServer, type WebSocket } from "ws"
import { z } from "zod"

/** Windows-MCP 0.8.8 的全部工具名（白名单 12 个 + 不开放的） */
const MCP_TOOL_NAMES = [
  "Snapshot",
  "Click",
  "Type",
  "Scroll",
  "Move",
  "Shortcut",
  "Wait",
  "WaitFor",
  "App",
  "Clipboard",
  "MultiSelect",
  "MultiEdit",
  "PowerShell",
  "FileSystem",
  "Registry",
  "Process",
  "Scrape",
  "Notification",
  "Screenshot",
  "ControlStatus",
  "DisplayInventory",
]

// 1×1 的 PNG
const PIXEL_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

/** Windows-MCP 0.8.8 发现有人在动键鼠时拒绝调用的样子（windows_mcp/desktop/control.py） */
export interface ControlBlockSpec {
  code: "USER_CONTROL" | "TAKEOVER_PENDING" | "PHYSICAL_INPUT_HELD" | "CONTROL_UNAVAILABLE" | "CONTROL_PREEMPTED"
  waitSeconds?: number
  executedSteps?: number
}

export interface FakeMcp {
  url: string
  calls: { name: string; args: Record<string, unknown> }[]
  /** 接下来的调用依次被拒（每个用掉一个）；always：之后每次都拒，直到设回 undefined */
  blocks: ControlBlockSpec[]
  always?: ControlBlockSpec
  /** 被拒的调用 */
  blocked: { name: string; code: string }[]
  /** 收到的请求里有几个没带对密钥 */
  rejected: number
  close(): Promise<void>
}

export async function startFakeMcp(key: string): Promise<FakeMcp> {
  const state = { calls: [] as FakeMcp["calls"], rejected: 0, blocks: [] as ControlBlockSpec[], always: undefined as ControlBlockSpec | undefined, blocked: [] as FakeMcp["blocked"] }
  const build = () => {
    const server = new McpServer({ name: "fake-windows-mcp", version: "0.8.8" })
    for (const name of MCP_TOOL_NAMES)
      server.registerTool(name, { description: `fake ${name}`, inputSchema: z.looseObject({}) }, (args): CallToolResult => {
        const block = state.blocks.shift() ?? state.always
        if (block) {
          state.blocked.push({ name, code: block.code })
          const status = {
            state: block.code === "USER_CONTROL" ? "user" : block.code === "TAKEOVER_PENDING" ? "takeover_pending" : block.code === "CONTROL_PREEMPTED" ? "ai" : "unavailable",
            generation: 4,
            wait_seconds: block.waitSeconds ?? 0,
            ...(block.code === "CONTROL_PREEMPTED" ? { executed_steps: block.executedSteps ?? 0 } : {}),
          }
          // 同 fastmcp 的 ToolError：isError + 一段 JSON
          return { isError: true, content: [{ type: "text", text: JSON.stringify({ code: block.code, status }) }] }
        }
        state.calls.push({ name, args: args as Record<string, unknown> })
        if (name === "Snapshot") {
          const content: CallToolResult["content"] = [{ type: "text", text: "前台窗口：记事本\n[1] 编辑框「文本编辑器」(100, 200)\n[2] 按钮「保存」(300, 40)" }]
          if ((args as { use_vision?: unknown }).use_vision === true) content.push({ type: "image", data: PIXEL_PNG, mimeType: "image/png" })
          return { content }
        }
        if (name === "Click" && (args as { label?: unknown }).label === 99) return { isError: true, content: [{ type: "text", text: "没有编号 99 的控件" }] }
        return { content: [{ type: "text", text: `${name} 做好了` }] }
      })
    return server
  }
  const handler = createMcpHandler(build, { legacy: "stateless" })
  const http = serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (request: Request) => {
      if (request.headers.get("authorization") !== `Bearer ${key}`) {
        state.rejected++
        return new Response("unauthorized", { status: 401 })
      }
      return handler.fetch(request)
    },
  }) as unknown as Server
  await new Promise<void>((resolve) => (http.listening ? resolve() : http.once("listening", () => resolve())))
  const port = (http.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    get calls() {
      return state.calls
    },
    get rejected() {
      return state.rejected
    },
    get blocks() {
      return state.blocks
    },
    set blocks(value: ControlBlockSpec[]) {
      state.blocks = value
    },
    get always() {
      return state.always
    },
    set always(value: ControlBlockSpec | undefined) {
      state.always = value
    },
    get blocked() {
      return state.blocked
    },
    close: () => new Promise<void>((resolve) => http.close(() => resolve())),
  }
}

export interface FakeAgent {
  url: string
  /** 桌面上的文件：路径 → 内容（传上来的也放这里） */
  files: Map<string, Buffer>
  /** 远程画面收到的消息（控制台经 API 转过来的） */
  viewMessages: unknown[]
  /** 连上 /view 的次数 */
  viewConnections: number
  screenshots: number
  /** 收到的 /screenshot 的 maxWidth 参数 */
  screenshotWidths: (string | null)[]
  /** true：截图回 503（锁屏、UAC 安全桌面时截不到） */
  failScreenshot: boolean
  /** true：取文件不带 X-File-Name（只有 Content-Disposition） */
  omitFileNameHeader: boolean
  /** POST /type 收到的文字 */
  typed: string[]
  /** true：像旧版桌面服务一样没有 /type（404） */
  noType: boolean
  close(): Promise<void>
}

/** 同 Python 的 urllib.parse.quote(name, safe="!'()*-._~")，也就是 encodeURIComponent（真的桌面服务这样编码 X-File-Name） */
const headerFileName = (name: string) => encodeURIComponent(name)

/** 同 starlette 的 FileResponse：不是纯 ASCII 的用 filename*=utf-8''…，否则 filename="…" */
const contentDisposition = (name: string) =>
  /^[\x20-\x7e]*$/.test(name) ? `attachment; filename="${name}"` : `attachment; filename*=utf-8''${encodeURIComponent(name)}`

/** 只让取这两个目录下面的（同真的桌面服务的白名单） */
const DOWNLOAD_ROOTS = ["c:\\users\\", "c:\\heyagent\\files\\"]

/**
 * 假的桌面服务，照 apps/desktop-agent/heyagent_desktop_agent/app.py 的行为：密钥不对 HTTP 回 401（JSON { error }），
 * WebSocket 先接受再用 4401 关；错误都是 { error }；截图失败 503；取文件的路径不在白名单 403、不存在 404；
 * X-File-Name 是百分号编码的 UTF-8；重名加「 (1)」
 */
export async function startFakeAgent(key: string): Promise<FakeAgent> {
  const jpeg = await sharp({ create: { width: 64, height: 36, channels: 3, background: { r: 20, g: 40, b: 60 } } }).jpeg().toBuffer()
  const files = new Map<string, Buffer>()
  const state = { viewMessages: [] as unknown[], viewConnections: 0, screenshots: 0, screenshotWidths: [] as (string | null)[], failScreenshot: false, omitFileNameHeader: false, typed: [] as string[], noType: false }
  const authorized = (req: IncomingMessage) => req.headers.authorization === `Bearer ${key}`
  const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) =>
    res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body))
  const http = createServer((req, res) => {
    if (!authorized(req)) {
      json(res, 401, { error: "密钥不对" }, { "www-authenticate": "Bearer" })
      return
    }
    const url = new URL(req.url ?? "/", "http://agent")
    if (req.method === "GET" && url.pathname === "/health") {
      json(res, 200, { ok: true, version: "0.1.0-test", screen: { width: 1920, height: 1080 } })
      return
    }
    if (req.method === "GET" && url.pathname === "/screenshot") {
      state.screenshots++
      state.screenshotWidths.push(url.searchParams.get("maxWidth"))
      if (state.failScreenshot) {
        json(res, 503, { error: "截图失败（锁屏或安全桌面时截不到）：screen grab failed" })
        return
      }
      res.writeHead(200, { "content-type": "image/jpeg", "x-screen-width": "1920", "x-screen-height": "1080", "cache-control": "no-store" }).end(jpeg)
      return
    }
    if (url.pathname === "/type" && req.method === "POST" && !state.noType) {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        let text: unknown
        try {
          text = (JSON.parse(Buffer.concat(chunks).toString("utf8")) as { text?: unknown }).text
        } catch {
          text = undefined
        }
        if (typeof text !== "string" || !text) {
          json(res, 400, { error: "text 是要输入的文字" })
          return
        }
        state.typed.push(text)
        json(res, 200, { ok: true, chars: text.length }) // 同真的桌面服务：按 UTF-16 码元数
      })
      return
    }
    if (url.pathname === "/files" && req.method === "POST") {
      const chunks: Buffer[] = []
      req.on("data", (chunk: Buffer) => chunks.push(chunk))
      req.on("end", () => {
        const name = url.searchParams.get("name") || "file"
        const dot = name.lastIndexOf(".")
        const [stem, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""]
        let path = `C:\\HeyAgent\\files\\2026-10-22\\${name}`
        for (let n = 1; files.has(path); n++) path = `C:\\HeyAgent\\files\\2026-10-22\\${stem} (${n})${ext}`
        const data = Buffer.concat(chunks)
        files.set(path, data)
        json(res, 200, { path, size: data.length })
      })
      return
    }
    if (url.pathname === "/files" && req.method === "GET") {
      const path = url.searchParams.get("path") ?? ""
      if (!DOWNLOAD_ROOTS.some((root) => path.toLowerCase().startsWith(root))) {
        json(res, 403, { error: "只能取用户目录和 C:\\HeyAgent\\files 下面的文件" })
        return
      }
      const data = files.get(path)
      if (!data) {
        json(res, 404, { error: "文件不存在" })
        return
      }
      const name = path.split("\\").pop()!
      res
        .writeHead(200, {
          "content-type": "application/octet-stream",
          "content-length": String(data.length),
          "content-disposition": contentDisposition(name),
          ...(state.omitFileNameHeader ? {} : { "x-file-name": headerFileName(name) }),
        })
        .end(data)
      return
    }
    json(res, 404, { error: "Not Found" })
  })
  const wss = new WebSocketServer({ noServer: true })
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://agent")
    if (url.pathname !== "/view") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n")
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws: WebSocket) => {
      // 密钥不对：先接受再用 4401 关（握手时拒绝的话，客户端只看得到 403）
      if (!authorized(req)) {
        ws.close(4401, "unauthorized")
        return
      }
      state.viewConnections++
      ws.send(JSON.stringify({ t: "meta", width: 1920, height: 1080, canControl: true }))
      ws.send(jpeg, { binary: true })
      ws.send(JSON.stringify({ t: "cursor", x: 10, y: 20, kind: "move" }))
      ws.on("message", (data) => {
        const message = JSON.parse(String(data)) as unknown
        state.viewMessages.push(message)
        // 回一条，测试据此知道输入到了
        ws.send(JSON.stringify({ t: "agentAction", label: `收到 ${(message as { t: string }).t}` }))
      })
    })
  })
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve))
  const port = (http.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${port}`,
    files,
    get viewMessages() {
      return state.viewMessages
    },
    get viewConnections() {
      return state.viewConnections
    },
    get screenshots() {
      return state.screenshots
    },
    get screenshotWidths() {
      return state.screenshotWidths
    },
    get failScreenshot() {
      return state.failScreenshot
    },
    set failScreenshot(value: boolean) {
      state.failScreenshot = value
    },
    get typed() {
      return state.typed
    },
    get noType() {
      return state.noType
    },
    set noType(value: boolean) {
      state.noType = value
    },
    get omitFileNameHeader() {
      return state.omitFileNameHeader
    },
    set omitFileNameHeader(value: boolean) {
      state.omitFileNameHeader = value
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const client of wss.clients) client.terminate()
        http.close(() => resolve())
        http.closeAllConnections()
      }),
  }
}
