// 登录：better-auth 1.7.10，邮箱 + 密码，加 admin 插件（role = "admin" 是主管）。
// 关闭公开注册（emailAndPassword.disableSignUp），账号只能由管理员建（admin 插件的 createUser）。
// 配置项名字照安装的版本里的类型定义（@better-auth/core 的 init-options.d.mts）。
import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { admin } from "better-auth/plugins"

import type { Db } from "./db/client.js"
import { authAccounts, authSessions, authVerifications, users } from "./db/schema.js"

export interface AuthOptions {
  secret: string
  baseURL: string
  trustedOrigins: string[]
}

export function createAuth(db: Db, options: AuthOptions) {
  return betterAuth({
    appName: "HeyAgent",
    secret: options.secret,
    baseURL: options.baseURL,
    basePath: "/api/auth",
    trustedOrigins: options.trustedOrigins,
    database: drizzleAdapter(db, {
      provider: "pg",
      // 键名要和下面的 modelName 一致，better-auth 按 modelName 找表
      schema: { users, auth_sessions: authSessions, auth_accounts: authAccounts, auth_verifications: authVerifications },
    }),
    emailAndPassword: { enabled: true, disableSignUp: true, minPasswordLength: 8 },
    user: {
      modelName: "users",
      additionalFields: {
        // 职位（原型 Staff.title），由管理员填，用户自己不能改
        title: { type: "string", required: false, defaultValue: "", input: false },
      },
    },
    session: { modelName: "auth_sessions" },
    account: { modelName: "auth_accounts" },
    verification: { modelName: "auth_verifications" },
    plugins: [admin({ defaultRole: "user", adminRoles: ["admin"] })],
    telemetry: { enabled: false },
  })
}

export type Auth = ReturnType<typeof createAuth>
