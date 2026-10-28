// pnpm --filter @heyagent/server dev:routine-library-fixture：往开发库插流程库的演示数据（docs/dev/routine-library.md 13.3），做流程页时用。
// 加 --test 插进测试库。只动这份数据自己的几个来源任务上的固化流程、source = routine 的工具和选用、带标记的运行（重复跑先删再插），正式环境不能跑。
import { createDb } from "../db/client.js"
import { env } from "../env.js"
import { insertRoutineLibraryFixtures } from "./routine-library-fixture.js"

if (process.env.NODE_ENV === "production") {
  console.error("正式环境不插演示数据")
  process.exit(1)
}

const url = process.argv.includes("--test") ? env.testDatabaseUrl : env.databaseUrl
if (!url) throw new Error("没有配置数据库地址")
const { db, pool } = createDb(url, 2)
try {
  const { routines, runIds } = await insertRoutineLibraryFixtures(db)
  console.log(
    `流程库演示数据已插进 ${new URL(url).pathname.slice(1)}：库流程 ${Object.entries(routines).map(([key, id]) => `${key}=${id}`).join("、")}，` +
      `调用方的运行 ${runIds.join("、")}`
  )
} finally {
  await pool.end()
}
