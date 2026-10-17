// 通知：站内通知（notifications 表）+ 按设置推送到 webhook 渠道（飞书、企业微信群机器人的文本消息，或通用 JSON）。
import { inArray } from "drizzle-orm"

import * as t from "../db/schema.js"
import type { DbLike } from "./records.js"
import { loadGlobalSecrets } from "./secrets.js"
import { loadEngineSettings } from "./settings.js"

export interface NotifyInput {
  userIds: string[]
  title: string
  body?: string
  /** 控制台里的链接（hash 路由），例如 #/tasks?id=T-1&run=R-1-1 */
  link?: string
  taskId?: string | null
  sessionId?: string | null
  /** 要不要推到 webhook 渠道（默认推） */
  push?: boolean
}

export const sessionLink = (taskId: string, sessionId: string) =>
  `#/tasks?id=${encodeURIComponent(taskId)}&run=${encodeURIComponent(sessionId)}`
export const TODOS_LINK = "#/todos"

/** 站内通知；推送失败不影响站内通知（只记日志） */
export async function notifyUsers(
  db: DbLike,
  input: NotifyInput
): Promise<{ notified: string[]; pushed: number }> {
  const ids = [...new Set(input.userIds)]
  const existing = ids.length
    ? await db
        .select({ id: t.users.id, name: t.users.name })
        .from(t.users)
        .where(inArray(t.users.id, ids))
    : []
  if (existing.length) {
    await db.insert(t.notifications).values(
      existing.map((user) => ({
        userId: user.id,
        title: input.title.slice(0, 200),
        body: (input.body ?? "").slice(0, 4000),
        link: input.link ?? null,
        taskId: input.taskId ?? null,
        sessionId: input.sessionId ?? null,
      }))
    )
  }
  let pushed = 0
  if (input.push !== false && existing.length) {
    pushed = await pushToChannels(db, {
      ...input,
      names: existing.map((user) => user.name),
    })
  }
  return { notified: existing.map((user) => user.id), pushed }
}

/** 推送到启用的 webhook 渠道；返回成功推了几个 */
export async function pushToChannels(
  db: DbLike,
  message: NotifyInput & { names?: string[] }
): Promise<number> {
  const settings = await loadEngineSettings(db)
  const channels = settings.channels.filter((channel) => channel.enabled)
  if (channels.length === 0) return 0
  const urls = await loadGlobalSecrets(
    db,
    channels.map((channel) => channel.urlSecretName)
  )
  const to = message.names?.length ? `（给 ${message.names.join("、")}）` : ""
  const text = [`【HeyAgent】${message.title}${to}`, message.body]
    .filter(Boolean)
    .join("\n")
  let ok = 0
  await Promise.all(
    channels.map(async (channel) => {
      const url = urls.get(channel.urlSecretName)
      if (!url) {
        console.warn(
          `[notify] 渠道「${channel.name}」的地址没有存（${channel.urlSecretName}）`
        )
        return
      }
      const body =
        channel.kind === "feishu"
          ? { msg_type: "text", content: { text } }
          : channel.kind === "wecom"
            ? { msgtype: "text", text: { content: text } }
            : {
                title: message.title,
                body: message.body ?? "",
                link: message.link,
                taskId: message.taskId ?? undefined,
                sessionId: message.sessionId ?? undefined,
                at: new Date().toISOString(),
              }
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(10_000),
        })
        if (res.ok) ok += 1
        else
          console.warn(
            `[notify] 渠道「${channel.name}」推送失败：HTTP ${res.status}`
          )
      } catch (error) {
        console.warn(
          `[notify] 渠道「${channel.name}」推送失败：${(error as Error).message}`
        )
      }
    })
  )
  return ok
}
