// worker 的内部控制接口（m2.md 第 8 条）：只绑 127.0.0.1，API 和 worker 在同一个 pod 里，API 能连到。每个请求都要带令牌头。
//   POST /browsers/login          { profileId, accountId?, userId } → { browserId }
//   POST /browsers/:id/save       { userId } → SaveLoginResult
//   POST /browsers/:id/close      → { ok }
//   GET  /health
//   WebSocket /browsers/:id/view?userId=…&canControl=0|1   远程画面（API 鉴权、判断能不能操作后转过来）
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"

import { WebSocketServer } from "ws"

import { BrowserUnavailableError } from "./chrome.js"
import { BrowserBusyError, type BrowserManager } from "./manager.js"
import { INTERNAL_HEADER, internalToken, tokenMatches } from "./token.js"

export interface ControlServer {
  url: string
  close(): Promise<void>
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of req) {
    size += (chunk as Buffer).length
    if (size > 64 * 1024) throw new Error("请求太大")
    chunks.push(chunk as Buffer)
  }
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>
}

function reply(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" })
  res.end(JSON.stringify(body))
}

const str = (value: unknown) => (typeof value === "string" && value ? value : undefined)

export async function startControlServer(manager: BrowserManager, options: { host?: string; port: number }): Promise<ControlServer> {
  const token = internalToken(manager.keyring())
  const host = options.host ?? "127.0.0.1"
  const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 })

  const server = createServer((req, res) => {
    void (async () => {
      if (!tokenMatches(req.headers[INTERNAL_HEADER], token)) return reply(res, 403, { error: "forbidden" })
      const url = new URL(req.url ?? "/", "http://internal")
      try {
        if (req.method === "GET" && url.pathname === "/health") return reply(res, 200, { ok: true, workerId: manager.workerId, browsers: manager.list().length })
        if (req.method === "POST" && url.pathname === "/browsers/login") {
          const body = await readJson(req)
          const profileId = str(body.profileId)
          const userId = str(body.userId)
          if (!profileId || !userId) return reply(res, 400, { error: "要 profileId 和 userId" })
          const instance = await manager.openForLogin({ profileId, accountId: str(body.accountId), userId })
          return reply(res, 200, { browserId: instance.id })
        }
        const match = /^\/browsers\/([^/]+)\/(save|close)$/.exec(url.pathname)
        if (req.method === "POST" && match) {
          const instance = manager.get(match[1]!)
          if (!instance) return reply(res, 404, { error: "这个 Chrome 已经关了" })
          if (match[2] === "save") {
            const body = await readJson(req)
            const userId = str(body.userId)
            if (!userId) return reply(res, 400, { error: "要 userId" })
            if (instance.kind !== "login") return reply(res, 400, { error: "只有「打开 Chrome 登录」开的 Chrome 能保存登录状态" })
            const result = await instance.saveLogin(userId)
            return reply(res, 200, { browserId: instance.id, ...result })
          }
          if (instance.kind !== "login") return reply(res, 400, { error: "运行中的 Chrome 由运行自己关，不能在这里关" })
          await instance.close({ writeBack: false, reason: "已关闭（没有保存）" })
          return reply(res, 200, { ok: true })
        }
        return reply(res, 404, { error: "not found" })
      } catch (error) {
        const status = error instanceof BrowserBusyError ? 409 : error instanceof BrowserUnavailableError ? 503 : 500
        if (status === 500) console.error("[browser] 内部接口出错", error)
        return reply(res, status, { error: (error as Error).message })
      }
    })()
  })

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://internal")
    const match = /^\/browsers\/([^/]+)\/view$/.exec(url.pathname)
    const instance = match ? manager.get(match[1]!) : undefined
    if (!tokenMatches(req.headers[INTERNAL_HEADER], token) || !instance) {
      socket.write(`HTTP/1.1 ${instance ? "403 Forbidden" : "404 Not Found"}\r\nConnection: close\r\n\r\n`)
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      void instance.viewer.add({ ws, userId: url.searchParams.get("userId") ?? "", canControl: url.searchParams.get("canControl") === "1" })
    })
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(options.port, host, () => resolve())
  })
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : options.port
  return {
    url: `http://${host}:${port}`,
    async close() {
      for (const client of wss.clients) client.terminate()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    },
  }
}
