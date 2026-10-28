// pnpm --filter @heyagent/server dev:subagent-fixture：往开发库插子 agent 的演示数据（一个父运行拆了 5 个子 agent：2 个办成、1 个没办成、1 个排队、1 个排队时被停掉），
// 做运行详情的「子 agent」区块时用。加 --test 插进测试库。不清空任何数据，正式环境不能跑。
import { createDb } from "../db/client.js"
import { env } from "../env.js"
import { insertSubagentFixtures } from "./subagent-fixture.js"

if (process.env.NODE_ENV === "production") {
  console.error("正式环境不插演示数据")
  process.exit(1)
}

const url = process.argv.includes("--test") ? env.testDatabaseUrl : env.databaseUrl
if (!url) throw new Error("没有配置数据库地址")
const { db, pool } = createDb(url, 2)
try {
  const { taskId, parentId, childIds } = await insertSubagentFixtures(db)
  console.log(`子 agent 演示数据已插进 ${new URL(url).pathname.slice(1)}：任务 ${taskId}，父运行 ${parentId}（在等子 agent），子运行 ${childIds.join("、")}`)
} finally {
  await pool.end()
}
