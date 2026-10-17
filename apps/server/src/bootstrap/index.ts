// 空白正式环境的初始化：API 启动时执行，可以重复执行（已经有的不动）。
// 1. 一个用户都没有时，建管理员 admin@heyagent.local：随机初始密码写进 HEYAGENT_ADMIN_PASSWORD_FILE（权限 600），不打印到日志；
// 2. 写入全局设置的默认值；
// 3. 环境变量里有 OPENROUTER_API_KEY、还没配过 OpenRouter 时：建 OpenRouter 服务（key 加密存）、刷新模型列表、设好三个默认模型。
// 不灌任何演示数据（任务、记忆、技能、规则、平台都由用户自己加）；内置工具的表行由引擎启动时同步。
import { randomBytes } from "node:crypto"
import { chmodSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, resolve } from "node:path"

import { count, eq } from "drizzle-orm"
import { OPENROUTER_DEFAULT_URL, sameFamily } from "@heyagent/shared"

import type { Auth } from "../auth.js"
import { addProvider, writeDefaults } from "../data/config/models.js"
import { ensureDefaultSettings } from "../data/config/settings.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { repoRoot } from "../env.js"
import type { Keyring } from "../lib/crypto.js"

export const ADMIN_EMAIL = "admin@heyagent.local"

/** 初始化时选的默认模型（OpenRouter 上的名字）：执行、规划、验收（验收和执行不同家） */
export const BOOTSTRAP_MODELS = { run: "anthropic/claude-sonnet-5.5", plan: "anthropic/claude-opus-5.5", verify: "google/gemini-3.8-flash" } as const

export interface BootstrapOptions {
  auth: Auth
  keyring: Keyring
  /** 管理员初始密码写到哪个文件；相对路径按仓库根目录算 */
  adminPasswordFile: string
  /** .env 里的 OpenRouter key（可以没有） */
  openrouterApiKey?: string
  log?: (message: string) => void
}

export interface BootstrapResult {
  adminCreated: boolean
  openrouter: "created" | "exists" | "skipped" | "failed"
}

export function adminPasswordFileFromEnv() {
  return resolve(repoRoot, process.env.HEYAGENT_ADMIN_PASSWORD_FILE || ".dev/admin-password")
}

async function createAdmin(db: Db, options: BootstrapOptions) {
  const [users] = await db.select({ n: count() }).from(t.users)
  if ((users?.n ?? 0) > 0) return false
  const password = randomBytes(18).toString("base64url")
  const file = resolve(repoRoot, options.adminPasswordFile)
  mkdirSync(dirname(file), { recursive: true })
  // 先写文件再建账号：建好了却没存下密码，就没人能登录了
  writeFileSync(file, `${password}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  // 服务端直接调（不带请求头）：admin 插件允许系统自己建账号
  await options.auth.api.createUser({ body: { email: ADMIN_EMAIL, password, name: "管理员", role: "admin", data: { title: "管理员", emailVerified: true } } })
  await db.update(t.users).set({ title: "管理员" }).where(eq(t.users.email, ADMIN_EMAIL))
  const [admin] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.email, ADMIN_EMAIL))
  await db.insert(t.auditEvents).values({ actorId: null, action: "user.create", targetTable: "users", targetId: admin!.id, detail: { email: ADMIN_EMAIL, role: "admin", by: "bootstrap" } })
  options.log?.(`已建管理员 ${ADMIN_EMAIL}，初始密码写在 ${file}（权限 600），登录后请在用户菜单里「修改密码」`)
  return true
}

async function setupOpenRouter(db: Db, options: BootstrapOptions): Promise<BootstrapResult["openrouter"]> {
  if (!options.openrouterApiKey) return "skipped"
  const [existing] = await db.select({ id: t.modelProviders.id }).from(t.modelProviders).where(eq(t.modelProviders.kind, "openrouter"))
  if (existing) return "exists"
  try {
    // 初始化只用公开的模型列表接口，不拿 key 去调任何接口
    const { id } = await addProvider(db, options.keyring, null, { kind: "openrouter", baseUrl: OPENROUTER_DEFAULT_URL, apiKey: options.openrouterApiKey }, { verifyKey: false })
    const [defaults] = await db.select({ n: count() }).from(t.modelDefaults)
    if ((defaults?.n ?? 0) === 0) {
      const ids = { run: `${id}/${BOOTSTRAP_MODELS.run}`, plan: `${id}/${BOOTSTRAP_MODELS.plan}`, verify: `${id}/${BOOTSTRAP_MODELS.verify}` }
      const found = (await db.select({ id: t.models.id }).from(t.models).where(eq(t.models.providerId, id))).map((row) => row.id)
      if ([ids.run, ids.plan, ids.verify].every((each) => found.includes(each)) && !sameFamily(ids.run, ids.verify)) {
        await writeDefaults(db, null, ids)
      } else {
        options.log?.("OpenRouter 的模型列表里找不到预设的默认模型，请到「模型」页手动设置默认模型")
      }
    }
    options.log?.(`已接入 OpenRouter（key 已加密保存），模型列表已刷新`)
    return "created"
  } catch (error) {
    // 连不上外网时不要挡住 API 启动：下次启动再试，或者由管理员在「模型」页手动加
    options.log?.(`接入 OpenRouter 失败，下次启动会再试：${error instanceof Error ? error.message : String(error)}`)
    return "failed"
  }
}

export async function bootstrap(db: Db, options: BootstrapOptions): Promise<BootstrapResult> {
  const adminCreated = await createAdmin(db, options)
  await ensureDefaultSettings(db)
  const openrouter = await setupOpenRouter(db, options)
  return { adminCreated, openrouter }
}
