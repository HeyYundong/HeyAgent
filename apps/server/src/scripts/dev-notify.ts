// pnpm dev:notify <table> <id>：手动发一条变化通知，演示实时推送（和库里触发器发的一样）。
import pg from "pg"
import { LIVE_CHANNEL } from "@heyagent/shared"

import { env } from "../env.js"

const [table, id] = process.argv.slice(2)
if (!table) {
  console.error("用法：pnpm dev:notify <table> <id>，例如 pnpm dev:notify sessions R-1024-1")
  process.exit(2)
}
const client = new pg.Client({ connectionString: env.databaseUrl })
await client.connect()
const payload = JSON.stringify({ table, id: id ?? null })
await client.query("select pg_notify($1, $2)", [LIVE_CHANNEL, payload])
await client.end()
console.log(`已发送 ${LIVE_CHANNEL}：${payload}`)
