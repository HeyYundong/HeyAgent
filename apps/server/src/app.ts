// HTTP 入口：/api/health、/api/setup（首次设置管理员）、/api/auth/*（better-auth）、/api/trpc/*（tRPC，含 SSE 订阅）、/api/gallery/*（图库的 HTTP 接口和 MCP）、/api/imports（上传要导入的 zip）。
import { fetchRequestHandler } from "@trpc/server/adapters/fetch"
import { sql } from "drizzle-orm"
import { Hono } from "hono"

import type { Auth } from "./auth.js"
import { registerSetupRoutes } from "./bootstrap/setup.js"
import type { Db } from "./db/client.js"
import { registerEngineRoutes } from "./engine/http.js"
import { env } from "./env.js"
import { registerGalleryRoutes } from "./gallery/routes.js"
import { registerImportRoutes } from "./imports/routes.js"
import { loadKeyring, type Keyring } from "./lib/crypto.js"
import type { ChangeHub } from "./live/hub.js"
import type { Context } from "./trpc/init.js"
import { appRouter } from "./trpc/router.js"

export interface AppDeps {
  db: Db
  auth: Auth
  hub: ChangeHub
  /** 主密钥；不传就在第一次用到时从 HEYAGENT_KEK_FILE 读 */
  keyring?: Keyring
}

export function createApp({ db, auth, hub, keyring: givenKeyring }: AppDeps) {
  const app = new Hono()
  let cachedKeyring = givenKeyring
  const keyring = () => (cachedKeyring ??= loadKeyring(env.kekFile))

  async function createContext(req: Request): Promise<Context> {
    const session = await auth.api.getSession({ headers: req.headers })
    const user = session?.user
    return {
      db,
      hub,
      user: user ? { id: user.id, name: user.name, email: user.email, isAdmin: user.role === "admin" } : null,
      auth,
      headers: req.headers,
      keyring,
    }
  }

  app.get("/api/health", async (c) => {
    try {
      await db.execute(sql`select 1`)
      return c.json({ ok: true, db: "ok" })
    } catch {
      return c.json({ ok: false, db: "down" }, 503)
    }
  })

  registerSetupRoutes(app, { db, auth })
  app.on(["GET", "POST"], "/api/auth/*", (c) => auth.handler(c.req.raw))

  // SSE 订阅出错时 tRPC 是在流里发错误事件（HTTP 200）。没登录的订阅在这里直接回 401，和查询一致
  app.use("/api/trpc/*", async (c, next) => {
    if (!c.req.header("accept")?.includes("text/event-stream")) return next()
    const session = await auth.api.getSession({ headers: c.req.raw.headers })
    if (session) return next()
    return c.json({ error: { message: "请先登录", code: -32001, data: { code: "UNAUTHORIZED", httpStatus: 401 } } }, 401)
  })

  registerEngineRoutes(app, { db, auth })
  registerGalleryRoutes(app, { db, auth })
  registerImportRoutes(app, { db, auth })

  app.all("/api/trpc/*", (c) =>
    fetchRequestHandler({
      endpoint: "/api/trpc",
      req: c.req.raw,
      router: appRouter,
      createContext: () => createContext(c.req.raw),
      onError: ({ error, path }) => {
        if (error.code === "INTERNAL_SERVER_ERROR") console.error(`[trpc] ${path ?? "?"}`, error)
      },
    })
  )

  app.notFound((c) => c.json({ error: "not found" }, 404))

  return app
}
