import { defineConfig } from "drizzle-kit"

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  // 只生成迁移文件，不连库；执行用 pnpm db:migrate
  strict: true,
  verbose: true,
})
