// pnpm --filter @heyagent/server dev:import-fixture：往开发库插三条演示导入（待确认、读包中、没读成），做导入页时用。
// 加 --test 插进测试库。不清空任何数据，正式环境不能跑。
import { createDb } from "../db/client.js"
import { env } from "../env.js"
import { loadKeyring } from "../lib/crypto.js"
import { insertImportFixtures } from "./import-fixture.js"

if (process.env.NODE_ENV === "production") {
  console.error("正式环境不插演示数据")
  process.exit(1)
}

const url = process.argv.includes("--test") ? env.testDatabaseUrl : env.databaseUrl
if (!url) throw new Error("没有配置数据库地址")
const { db, pool } = createDb(url, 2)
try {
  const ids = await insertImportFixtures(db, loadKeyring(env.kekFile))
  console.log(`演示导入已插进 ${new URL(url).pathname.slice(1)}：待确认 ${ids.review}，读包中 ${ids.reading}，没读成 ${ids.failed}`)
} finally {
  await pool.end()
}
