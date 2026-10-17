// 配置：从环境变量读。开发时先读仓库根目录的 .env（不存在就跳过），容器里直接用环境变量。
import { existsSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const here = dirname(fileURLToPath(import.meta.url))
/** 仓库根目录：apps/server/src（或 dist）往上三层 */
export const repoRoot = resolve(here, "../../..")

const envFile = join(repoRoot, ".env")
if (existsSync(envFile)) process.loadEnvFile(envFile)

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`缺少环境变量 ${name}（开发时参考仓库根目录的 .env.example）`)
  return value
}

const list = (value: string | undefined) => (value ?? "").split(",").map((item) => item.trim()).filter(Boolean)

export const env = {
  get databaseUrl() {
    return required("DATABASE_URL")
  },
  get testDatabaseUrl() {
    return process.env.TEST_DATABASE_URL
  },
  get kekFile() {
    const file = required("HEYAGENT_KEK_FILE")
    return resolve(repoRoot, file)
  },
  get authSecret() {
    return required("BETTER_AUTH_SECRET")
  },
  /** 控制台对外的地址（better-auth 用它生成回调地址、校验来源） */
  get authUrl() {
    return process.env.BETTER_AUTH_URL ?? "http://localhost:3100"
  },
  /** 允许带 cookie 发请求的前端地址 */
  get trustedOrigins() {
    return list(process.env.TRUSTED_ORIGINS)
  },
  get host() {
    return process.env.HOST ?? "0.0.0.0"
  },
  get port() {
    return Number(process.env.PORT ?? 3100)
  },
  get seedPassword() {
    return required("SEED_PASSWORD")
  },
}
