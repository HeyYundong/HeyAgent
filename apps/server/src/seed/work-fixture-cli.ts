// pnpm --filter @heyagent/server dev:work-fixture：往开发库插派活的演示数据（巡检派活给处理一张单，十来张派活单），做派活页时用。
// 加 --test 插进测试库。不清空任何数据，正式环境不能跑。
import { createDb } from "../db/client.js"
import { env } from "../env.js"
import { insertWorkFixtures } from "./work-fixture.js"

if (process.env.NODE_ENV === "production") {
  console.error("正式环境不插演示数据")
  process.exit(1)
}

const url = process.argv.includes("--test") ? env.testDatabaseUrl : env.databaseUrl
if (!url) throw new Error("没有配置数据库地址")
const { db, pool } = createDb(url, 2)
try {
  const { patrolId, workerId, checkerId, budgetId, itemIds } = await insertWorkFixtures(db)
  console.log(
    `派活演示数据已插进 ${new URL(url).pathname.slice(1)}：${patrolId} 派活给 ${workerId}（外部系统能派活、收到事件派单）、${checkerId}（自动重试 2 次）；${budgetId} 设了每天花费上限、今天已经到了；派活单 ${itemIds.join("、")}`
  )
} finally {
  await pool.end()
}
