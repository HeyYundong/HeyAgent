// pnpm db:seed：灌原型的演示数据。会清空业务表，只能用在开发、演示库。
// 正式环境默认不灌：NODE_ENV=production 时必须显式设置 HEYAGENT_SEED_DEMO=1。
import { createDb } from "../db/client.js"
import { env } from "../env.js"
import { loadKeyring } from "../lib/crypto.js"
import { expectedCounts, seedDemo } from "./seed.js"

if (process.env.NODE_ENV === "production" && process.env.HEYAGENT_SEED_DEMO !== "1") {
  console.error("正式环境不灌演示数据；确实要灌，请设置 HEYAGENT_SEED_DEMO=1")
  process.exit(1)
}

const url = process.argv.includes("--test") ? env.testDatabaseUrl : env.databaseUrl
if (!url) throw new Error("没有配置 TEST_DATABASE_URL")
const { db, pool } = createDb(url, 2)
try {
  const started = Date.now()
  const { counts } = await seedDemo(db, loadKeyring(env.kekFile), { password: env.seedPassword })
  const expected: Record<string, number> = expectedCounts()
  console.log(`演示数据已灌进 ${new URL(url).pathname.slice(1)}（${Date.now() - started} ms）：`)
  for (const [table, n] of Object.entries(counts)) {
    const want = expected[table]
    console.log(`  ${table.padEnd(20)} ${String(n).padStart(4)}${want === undefined ? "" : want === n ? "  ✓ 和原型一致" : `  ✗ 原型是 ${want}`}`)
  }
  if (Object.entries(expected).some(([table, n]) => counts[table] !== n)) process.exitCode = 1
} finally {
  await pool.end()
}
