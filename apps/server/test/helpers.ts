// 测试连真实的 PostgreSQL（开发数据库里的 heyagent_test 库，scripts/dev-db.sh up 建好的），不用 mock 数据库。
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import pg from "pg"

import { createApp } from "../src/app.js"
import { createAuth } from "../src/auth.js"
import { createDb } from "../src/db/client.js"
import { runMigrations } from "../src/db/migrate.js"
import { env } from "../src/env.js"
import { loadKeyring, newKekLine } from "../src/lib/crypto.js"
import { ChangeHub } from "../src/live/hub.js"
import { seedDemo } from "../src/seed/seed.js"

export const PASSWORD = "test-password-123"

export function testDatabaseUrl() {
  const url = env.testDatabaseUrl
  if (!url) throw new Error("测试要连 heyagent_test：在 .env 里配置 TEST_DATABASE_URL（见 .env.example）")
  if (!new URL(url).pathname.endsWith("_test")) throw new Error(`TEST_DATABASE_URL 必须指向 *_test 库，现在是 ${url}`)
  return url
}

/** 清空测试库再从头跑一遍迁移。pg-boss 的 pgboss schema 一起删，免得留下上一轮的任务 */
export async function resetTestDatabase(url = testDatabaseUrl()) {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  await client.query("drop schema if exists pgboss cascade; drop schema if exists public cascade; drop schema if exists drizzle cascade; create schema public;")
  await client.end()
  await runMigrations(url)
}

/** 临时的 KEK 文件 */
export function tempKeyring(lines = [newKekLine(1)]) {
  const dir = mkdtempSync(join(tmpdir(), "heyagent-kek-"))
  const file = join(dir, "kek")
  writeFileSync(file, lines.join("\n") + "\n", { mode: 0o600 })
  return loadKeyring(file)
}

/** 迁移 + 灌演示数据 + 起一个 app（不监听端口，用 app.request 调） */
export async function setupApp() {
  const url = testDatabaseUrl()
  await resetTestDatabase(url)
  const keyring = tempKeyring()
  const { db, pool } = createDb(url, 5)
  await seedDemo(db, keyring, { password: PASSWORD })
  const auth = createAuth(db, { secret: "test-secret-test-secret-test-secret-0", baseURL: "http://localhost:3100", trustedOrigins: ["http://localhost:5180"] })
  const hub = new ChangeHub(url)
  await hub.start()
  const app = createApp({ db, auth, hub, keyring })
  return {
    url,
    db,
    keyring,
    hub,
    app,
    auth,
    async close() {
      await hub.stop()
      await pool.end()
    },
  }
}

export type TestApp = Awaited<ReturnType<typeof setupApp>>

/** 用邮箱密码登录，返回 Cookie 头 */
export async function login(app: TestApp["app"], email: string, password = PASSWORD) {
  const res = await app.request("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (res.status !== 200) throw new Error(`${email} 登录失败：${res.status} ${await res.text()}`)
  const cookie = res.headers.get("set-cookie")
  if (!cookie) throw new Error("登录没有返回 cookie")
  return cookie.split(";")[0]!
}

/** 调一个 tRPC 查询（GET /api/trpc/<path>?input=...） */
export async function query(app: TestApp["app"], path: string, cookie?: string, input?: unknown) {
  const search = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`
  const res = await app.request(`/api/trpc/${path}${search}`, { headers: cookie ? { cookie } : {} })
  const body = (await res.json()) as { result?: { data: unknown }; error?: { message: string; data?: { code: string } } }
  return { status: res.status, data: body.result?.data as any, error: body.error }
}

/** 调一个 tRPC mutation（POST /api/trpc/<path>，body 是输入的 JSON） */
export async function mutate(app: TestApp["app"], path: string, cookie: string | undefined, input?: unknown) {
  const res = await app.request(`/api/trpc/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: input === undefined ? undefined : JSON.stringify(input),
  })
  const body = (await res.json()) as { result?: { data: unknown }; error?: { message: string; data?: { code: string } } }
  return { status: res.status, data: body.result?.data as any, error: body.error }
}
