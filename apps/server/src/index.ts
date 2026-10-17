// API 服务入口（端口 3100）。worker 在 M1 加，同一份代码另一个入口。
import { serve } from "@hono/node-server"

import type { Server } from "node:http"

import { createApp } from "./app.js"
import { createAuth } from "./auth.js"
import { adminPasswordFileFromEnv, bootstrap } from "./bootstrap/index.js"
import { attachBrowserViewRelay } from "./browser/view-relay.js"
import { createDb } from "./db/client.js"
import { initEngineClient } from "./engine/queue.js"
import { env } from "./env.js"
import { loadKeyring } from "./lib/crypto.js"
import { ChangeHub } from "./live/hub.js"

const { db, pool } = createDb(env.databaseUrl)
const auth = createAuth(db, { secret: env.authSecret, baseURL: env.authUrl, trustedOrigins: env.trustedOrigins })
const keyring = loadKeyring(env.kekFile)
// 空白环境初始化（M1 P2）：建管理员、写默认设置、按 .env 接入 OpenRouter。可以重复执行
await bootstrap(db, { auth, keyring, adminPasswordFile: adminPasswordFileFromEnv(), openrouterApiKey: env.openrouterApiKey, log: (message) => console.log(`[bootstrap] ${message}`) })
const hub = new ChangeHub(env.databaseUrl)
await hub.start()
// 引擎：API 进程只发任务（立即运行、继续、定时同步），不跑任务
await initEngineClient(db)

const app = createApp({ db, auth, hub, keyring })
const server = serve({ fetch: app.fetch, port: env.port, hostname: env.host }, (info) => {
  console.log(`HeyAgent API 已启动：http://${info.address}:${info.port}`)
})
// 远程画面（M2）：GET /api/browser/view/:browserId 的 WebSocket 升级，转到 worker 里的 Chrome
attachBrowserViewRelay(server as Server, {
  db,
  auth,
  keyring: () => keyring,
  trustedOrigins: [...env.trustedOrigins, new URL(env.authUrl).origin],
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
