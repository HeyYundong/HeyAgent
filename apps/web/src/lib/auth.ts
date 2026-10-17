// 登录、退出：直接调 better-auth 的接口（/api/auth/*，见 docs/dev/m0-api.md 2.3）。当前用户是谁，页面用 tRPC 的 me.get。
// 首次设置管理员走 /api/setup（不是 tRPC：和登录一样，没登录也能调）。
import type { SetupAdminInput, SetupStatus } from "@heyagent/shared"

export class SignInError extends Error {}

/** 外壳先查这个：没登录时 better-auth 回 200 + null，不会像 tRPC 查询那样回 401（浏览器控制台会把 401 记成报错） */
export const SESSION_QUERY_KEY = ["auth", "session"] as const

export async function getSession(): Promise<{ userId: string } | null> {
  const response = await fetch("/api/auth/get-session", { headers: { Accept: "application/json" } })
  if (!response.ok) throw new Error(`取登录状态失败：HTTP ${response.status}`)
  const body = (await response.json()) as { session?: { userId: string } } | null
  return body?.session ? { userId: body.session.userId } : null
}

export async function signIn(email: string, password: string) {
  const response = await fetch("/api/auth/sign-in/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  })
  if (response.ok) return
  if (response.status === 401) throw new SignInError("邮箱或密码不对")
  if (response.status === 403) throw new SignInError("这个地址不在允许登录的名单里，请联系管理员")
  if (response.status === 429) throw new SignInError("尝试次数太多，请稍后再试")
  throw new SignInError("登录失败，请稍后再试")
}

/** 首次设置：还没有任何账号时，登录页换成「设置管理员」页（GET /api/setup） */
export const SETUP_QUERY_KEY = ["auth", "setup"] as const

export async function getSetupStatus(): Promise<SetupStatus> {
  const response = await fetch("/api/setup", { headers: { Accept: "application/json" } })
  if (!response.ok) throw new Error(`取初始化状态失败：HTTP ${response.status}`)
  return (await response.json()) as SetupStatus
}

export class SetupError extends Error {
  /** 别人已经先设置好了：该去登录页 */
  alreadyDone: boolean

  constructor(message: string, alreadyDone = false) {
    super(message)
    this.alreadyDone = alreadyDone
  }
}

/** 建第一个管理员（POST /api/setup）。建好以后还要用同一组邮箱密码 signIn */
export async function setupAdmin(input: SetupAdminInput) {
  const response = await fetch("/api/setup", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
  if (response.ok) return
  const body = (await response.json().catch(() => null)) as { error?: string } | null
  throw new SetupError(body?.error ?? "设置失败，请稍后再试", response.status === 409)
}

export async function signOut() {
  // better-auth 要求带 Origin 头，浏览器发 POST 时会自动带上
  await fetch("/api/auth/sign-out", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" })
}
