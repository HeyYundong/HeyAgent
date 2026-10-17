// 执行迁移：drizzle-kit 生成的 SQL 文件在 apps/server/drizzle/，开发时 pnpm db:migrate，容器启动时也先跑一遍。
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import { migrate } from "drizzle-orm/node-postgres/migrator"

import { createDb } from "./client.js"

const here = dirname(fileURLToPath(import.meta.url))
/** src/db 或 dist/db 往上两层就是 apps/server */
export const migrationsFolder = resolve(here, "../../drizzle")

export async function runMigrations(url: string) {
  const { db, pool } = createDb(url, 1)
  try {
    await migrate(db, { migrationsFolder })
  } finally {
    await pool.end()
  }
}
