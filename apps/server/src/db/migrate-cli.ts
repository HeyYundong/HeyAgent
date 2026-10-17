import { env } from "../env.js"
import { runMigrations } from "./migrate.js"

const url = process.argv.includes("--test") ? env.testDatabaseUrl : env.databaseUrl
if (!url) throw new Error("没有配置 TEST_DATABASE_URL")
await runMigrations(url)
console.log(`迁移完成：${new URL(url).pathname.slice(1)}`)
