// pnpm --filter @heyagent/server dev:compare-fixture：往开发库插比物的演示数据（两个标准、五条比对），做比物页时用。
// 加 --test 插进测试库。不清空任何数据，正式环境不能跑。
import { createDb } from "../db/client.js"
import { env } from "../env.js"
import { insertCompareFixtures } from "./compare-fixture.js"

if (process.env.NODE_ENV === "production") {
  console.error("正式环境不插演示数据")
  process.exit(1)
}

const url = process.argv.includes("--test") ? env.testDatabaseUrl : env.databaseUrl
if (!url) throw new Error("没有配置数据库地址")
const { db, pool } = createDb(url, 2)
try {
  const ids = await insertCompareFixtures(db)
  console.log(`比物演示数据已插进 ${new URL(url).pathname.slice(1)}：${ids.join("、")}`)
} finally {
  await pool.end()
}
