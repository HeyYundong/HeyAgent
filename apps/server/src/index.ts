// API 服务入口（端口 3100）。worker 在 M1 加，同一份代码另一个入口。
import { serve } from "@hono/node-server"

import { createApp } from "./app.js"
import { createAuth } from "./auth.js"
import { createDb } from "./db/client.js"
import { env } from "./env.js"
import { ChangeHub } from "./live/hub.js"

const { db, pool } = createDb(env.databaseUrl)
const auth = createAuth(db, { secret: env.authSecret, baseURL: env.authUrl, trustedOrigins: env.trustedOrigins })
const hub = new ChangeHub(env.databaseUrl)
await hub.start()

const app = createApp({ db, auth, hub })
const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`HeyAgent API 已启动：http://${info.address}:${info.port}`)
})

async function shutdown(signal: string) {
  console.log(`收到 ${signal}，正在关闭`)
  server.close()
  await hub.stop()
  await pool.end()
  process.exit(0)
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
