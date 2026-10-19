// 右下角助手的 HTTP 接口（流式，tRPC 不方便做 POST + SSE）：
// - POST /api/assistant/chat：发一条消息，body = AssistantChatInput；
// - POST /api/assistant/apply：处理一张改动确认卡（应用 / 不要），body = AssistantApplyInput。
// 都要登录（同 /api/trpc/*，没登录回 401）。返回 text/event-stream，每条是 `data: <AssistantStreamEvent 的 JSON>\n\n`；
// 请求本身出错（参数不对、卡不是你的、对话不存在……）发一条 error 事件后结束。浏览器断开时停掉模型调用。
import { assistantApplyInputSchema, assistantChatInputSchema, type AssistantStreamEvent } from "@heyagent/shared"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import type { z } from "zod"

import type { Auth } from "../auth.js"
import type { Db } from "../db/client.js"
import type { Keyring } from "../lib/crypto.js"
import { AssistantError, runApply, runChat, type AssistantActor, type RunDeps } from "./run.js"
import { issuesText } from "./tools.js"

const encoder = new TextEncoder()

/** 把一次运行包成 SSE 响应：run 里 emit 的每个事件写一行 data；run 抛错就发 error；浏览器断开就 abort */
function sseResponse(request: Request, run: (emit: RunDeps["emit"], signal: AbortSignal) => Promise<void>): Response {
  const abort = new AbortController()
  const onAbort = () => abort.abort()
  request.signal.addEventListener("abort", onAbort, { once: true })
  let closed = false
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const emit = (event: AssistantStreamEvent) => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        } catch {
          closed = true
        }
      }
      run(emit, abort.signal)
        .catch((error: unknown) => {
          if (abort.signal.aborted) return
          if (!(error instanceof AssistantError)) console.error("[assistant] 请求出错", error)
          emit({ type: "error", message: error instanceof AssistantError ? error.message : `出错了：${(error as Error)?.message?.slice(0, 300) ?? String(error)}` })
        })
        .finally(() => {
          request.signal.removeEventListener("abort", onAbort)
          if (closed) return
          closed = true
          try {
            controller.close()
          } catch {
            // 已经被取消了
          }
        })
    },
    cancel() {
      closed = true
      abort.abort()
    },
  })
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      // 反向代理（Caddy / nginx）不要攒着，来一段发一段
      "x-accel-buffering": "no",
    },
  })
}

export function registerAssistantRoutes(app: Hono, deps: { db: Db; auth: Auth; keyring: () => Keyring }) {
  const userOf = async (headers: Headers): Promise<AssistantActor | undefined> => {
    const user = (await deps.auth.api.getSession({ headers }))?.user
    return user ? { id: user.id, name: user.name, isAdmin: user.role === "admin" } : undefined
  }

  /** 登录校验、解析 body，然后按 SSE 跑 */
  const handle =
    <S extends z.ZodType>(schema: S, run: (deps: RunDeps, input: z.output<S>) => Promise<void>) =>
    async (c: { req: { raw: Request; json: () => Promise<unknown> }; json: (body: unknown, status: 401) => Response }) => {
      const actor = await userOf(c.req.raw.headers)
      if (!actor) return c.json({ error: "请先登录" }, 401)
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        body = undefined
      }
      const parsed = schema.safeParse(body)
      return sseResponse(c.req.raw, async (emit, signal) => {
        if (!parsed.success) throw new AssistantError(`请求不对：${issuesText(parsed.error)}`)
        await run({ db: deps.db, actor, keyring: deps.keyring, signal, emit }, parsed.data)
      })
    }

  const limit = bodyLimit({ maxSize: 64 * 1024, onError: (c) => c.json({ error: "内容太长了" }, 413) })
  app.post("/api/assistant/chat", limit, handle(assistantChatInputSchema, runChat))
  app.post("/api/assistant/apply", limit, handle(assistantApplyInputSchema, runApply))
}
