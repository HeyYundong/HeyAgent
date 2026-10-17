// 测试脚本共用：管理员账号（测试里固定用 admin@heyagent.local）。
// 全新环境一个账号都没有，要先「设置管理员」（POST /api/setup）：密码随机生成，先写进密码文件（权限 600，不打印）再提交，
// 免得建好了却没存下密码。已经设置过的环境就读密码文件。
import { randomBytes } from "node:crypto"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export const ADMIN_EMAIL = "admin@heyagent.local"
export const ADMIN_NAME = "管理员"

/** 还没有任何账号、要先设置管理员 */
export async function setupNeeded(base) {
  const response = await fetch(new URL("api/setup", base))
  if (!response.ok) throw new Error(`GET /api/setup：HTTP ${response.status}`)
  return (await response.json()).needed === true
}

/** 生成新的管理员密码，先写进文件再返回 */
export function newAdminPassword(file) {
  const password = randomBytes(18).toString("base64url")
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${password}\n`, { mode: 0o600 })
  chmodSync(file, 0o600)
  return password
}

export function readAdminPassword(file) {
  return existsSync(file) ? readFileSync(file, "utf8").trim() : ""
}

/** 拿到能登录的管理员账号：全新环境直接调接口设置好，否则读密码文件（读不到就退出） */
export async function ensureAdmin(base, file) {
  if (await setupNeeded(base)) {
    const password = newAdminPassword(file)
    const response = await fetch(new URL("api/setup", base), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: ADMIN_NAME, email: ADMIN_EMAIL, password }),
    })
    if (!response.ok) throw new Error(`设置管理员失败：HTTP ${response.status} ${await response.text()}`)
    console.log(`全新环境：已设置管理员 ${ADMIN_EMAIL}，密码写在 ${file}（权限 600）`)
    return { email: ADMIN_EMAIL, password }
  }
  const password = readAdminPassword(file)
  if (!password) {
    console.error(`没有管理员密码：找不到 ${file}`)
    process.exit(2)
  }
  return { email: ADMIN_EMAIL, password }
}
