// worker 进程入口：连数据库、启动 pg-boss、注册各类任务、同步内置工具，收到 SIGTERM / SIGINT 优雅退出。
// 和 API 是同一份代码，部署成两个容器（worker 的镜像里多装了 Chrome，M2 用）。
import { createDb } from "./db/client.js"
import { env } from "./env.js"
import { getKeyring } from "./engine/runtime.js"
import { startEngineWorker } from "./engine/worker-runtime.js"

const num = (name: string) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : undefined
}

const { db, pool } = createDb(env.databaseUrl)
// 先读一次主密钥：配错了启动时就报出来，而不是等第一个 session
getKeyring()

const worker = await startEngineWorker({
  databaseUrl: env.databaseUrl,
  db,
  concurrency: num("HEYAGENT_WORKER_CONCURRENCY"),
  pollingIntervalSeconds: num("HEYAGENT_WORKER_POLL_SECONDS"),
  superviseIntervalSeconds: num("HEYAGENT_WORKER_SUPERVISE_SECONDS"),
  cronWorkerIntervalSeconds: num("HEYAGENT_WORKER_CRON_SECONDS"),
})
console.log("HeyAgent worker 已启动")

let stopping = false
async function shutdown(signal: string) {
  if (stopping) return
  stopping = true
  console.log(`收到 ${signal}，正在关闭 worker`)
  try {
    await worker.stop()
    await pool.end()
  } finally {
    process.exit(0)
  }
}
process.on("SIGINT", () => void shutdown("SIGINT"))
process.on("SIGTERM", () => void shutdown("SIGTERM"))
