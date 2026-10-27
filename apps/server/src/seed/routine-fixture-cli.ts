// pnpm --filter @heyagent/server dev:routine-fixture：往开发库插固化流程的演示数据（docs/dev/solidify.md 15.4），做固化的界面时用。
// 加 --test 插进测试库。只动种子任务 T-1040 上的固化流程和这份数据自己插的运行（重复跑先删再插），正式环境不能跑。
import { createDb } from "../db/client.js"
import { env } from "../env.js"
import { insertRoutineFixtures, ROUTINE_FIXTURE_TASK } from "./routine-fixture.js"

if (process.env.NODE_ENV === "production") {
  console.error("正式环境不插演示数据")
  process.exit(1)
}

const url = process.argv.includes("--test") ? env.testDatabaseUrl : env.databaseUrl
if (!url) throw new Error("没有配置数据库地址")
const { db, pool } = createDb(url, 2)
try {
  const { routineId, reviewVersionId, itemId, runIds, testRunIds } = await insertRoutineFixtures(db)
  console.log(
    `固化演示数据已插进 ${new URL(url).pathname.slice(1)}：任务 ${ROUTINE_FIXTURE_TASK} 的固化流程 ${routineId}（第 3 版正式在用），` +
      `待审核 ${reviewVersionId}（要人办的事 ${itemId}），运行 ${runIds.join("、")}，试跑 ${testRunIds.join("、")}`
  )
} finally {
  await pool.end()
}
