// 引擎的 HTTP 接口：文件上传下载（files/routes.ts）、外部事件 webhook。
// app.ts 里只加一行 registerEngineRoutes(app, deps)。
// POST /api/events：用 settings 里的令牌鉴权（存的是 sha256），内容 { event, data }，按事件名匹配等待中的 session 和待办。
// 令牌放在 Authorization: Bearer <令牌> 或 X-HeyAgent-Token 头里。
import { createHash, timingSafeEqual } from "node:crypto"

import { fireEventInputSchema } from "@heyagent/shared"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"

import type { Auth } from "../auth.js"
import type { Db } from "../db/client.js"
import { registerFileRoutes } from "../files/routes.js"
import { fireEventImpl } from "./control.js"
import { loadEngineSettings } from "./settings.js"

export const sha256Hex = (text: string) =>
  createHash("sha256").update(text, "utf8").digest("hex")

function sameHex(a: string, b: string) {
  const x = Buffer.from(a, "hex")
  const y = Buffer.from(b, "hex")
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y)
}

export function registerEngineRoutes(app: Hono, deps: { db: Db; auth: Auth }) {
  registerFileRoutes(app, deps)

  app.post(
    "/api/events",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: (c) => c.json({ error: "内容太大" }, 413),
    }),
    async (c) => {
      const header = c.req.header("authorization")
      const token = (
        header?.match(/^Bearer\s+(.+)$/i)?.[1] ??
        c.req.header("x-heyagent-token") ??
        ""
      ).trim()
      const settings = await loadEngineSettings(deps.db)
      if (!settings.eventTokenSha256)
        return c.json(
          { error: "还没有配置外部事件令牌（在「设置」页生成）" },
          401
        )
      if (!token || !sameHex(sha256Hex(token), settings.eventTokenSha256))
        return c.json({ error: "令牌不对" }, 401)
      let body: unknown
      try {
        body = await c.req.json()
      } catch {
        return c.json({ error: "内容要是 JSON：{ event, data }" }, 400)
      }
      const parsed = fireEventInputSchema.safeParse(body)
      if (!parsed.success)
        return c.json({ error: "内容要是 { event: 事件名, data?: 对象 }" }, 400)
      const result = await fireEventImpl(deps.db, {
        event: parsed.data.event,
        data: parsed.data.data,
        via: "webhook",
      })
      return c.json({ ok: true, ...result })
    }
  )
}
