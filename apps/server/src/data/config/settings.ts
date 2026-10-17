// 全局设置（只有主管）：单个 session 的花费上限、最多步数、事件兜底天数、外部事件令牌、通知渠道。
// 存在 settings 表（键值），键名见 shared 的 SETTING_KEYS，引擎（P1）按同样的键读。
import { createHash, randomBytes } from "node:crypto"

import { eq, inArray } from "drizzle-orm"
import {
  eventTokenRecordSchema,
  notifyChannelSchema,
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  snakeName,
  type NotifyChannel,
  type SettingsLimitsInput,
  type SettingsView,
} from "@heyagent/shared"
import { z } from "zod"

import * as t from "../../db/schema.js"
import { assertCan, audit, badRequest, deleteSecret, findSecret, notFound, putSecret, type DbOrTx, type WriteCtx } from "./common.js"

const channelsSchema = z.array(notifyChannelSchema)

async function readKeys(db: DbOrTx, keys: string[]) {
  const rows = await db.select().from(t.settings).where(inArray(t.settings.key, keys))
  return new Map(rows.map((row) => [row.key, row.value]))
}

async function writeKey(db: DbOrTx, key: string, value: unknown, actorId: string | null) {
  await db
    .insert(t.settings)
    .values({ key, value, updatedById: actorId })
    .onConflictDoUpdate({ target: t.settings.key, set: { value, updatedById: actorId, updatedAt: new Date() } })
}

const num = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) ? value : fallback)

export async function readLimits(db: DbOrTx): Promise<SettingsLimitsInput> {
  const values = await readKeys(db, [SETTING_KEYS.maxCostUsd, SETTING_KEYS.maxSteps, SETTING_KEYS.eventFallbackDays])
  return {
    maxCostUsd: num(values.get(SETTING_KEYS.maxCostUsd), SETTINGS_DEFAULTS.maxCostUsd),
    maxSteps: num(values.get(SETTING_KEYS.maxSteps), SETTINGS_DEFAULTS.maxSteps),
    eventFallbackDays: num(values.get(SETTING_KEYS.eventFallbackDays), SETTINGS_DEFAULTS.eventFallbackDays),
  }
}

async function readChannels(db: DbOrTx): Promise<NotifyChannel[]> {
  const values = await readKeys(db, [SETTING_KEYS.notifyChannels])
  return channelsSchema.safeParse(values.get(SETTING_KEYS.notifyChannels) ?? []).data ?? []
}

/** 空白环境初始化：没写过的设置写入默认值（已有的不动，可以重复执行） */
export async function ensureDefaultSettings(db: DbOrTx) {
  const defaults: [string, unknown][] = [
    [SETTING_KEYS.maxCostUsd, SETTINGS_DEFAULTS.maxCostUsd],
    [SETTING_KEYS.maxSteps, SETTINGS_DEFAULTS.maxSteps],
    [SETTING_KEYS.eventFallbackDays, SETTINGS_DEFAULTS.eventFallbackDays],
    [SETTING_KEYS.notifyChannels, []],
  ]
  for (const [key, value] of defaults) await db.insert(t.settings).values({ key, value }).onConflictDoNothing()
}

export async function getSettings(ctx: WriteCtx): Promise<SettingsView> {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能看全局设置")
  const limits = await readLimits(ctx.db)
  const values = await readKeys(ctx.db, [SETTING_KEYS.eventToken])
  const token = eventTokenRecordSchema.safeParse(values.get(SETTING_KEYS.eventToken)).data
  const channels = await readChannels(ctx.db)
  const withMask = await Promise.all(
    channels.map(async (channel) => {
      const secret = await findSecret(ctx.db, { scope: "http_tool", refId: null, name: channel.urlSecretName })
      return { ...channel, ...(secret ? { urlMasked: secret.masked } : {}) }
    })
  )
  return { ...limits, ...(token ? { eventToken: { hint: token.hint, createdAt: token.createdAt } } : {}), channels: withMask }
}

export async function updateLimits(ctx: WriteCtx, input: SettingsLimitsInput) {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能改全局设置")
  return ctx.db.transaction(async (tx) => {
    const before = await readLimits(tx)
    await writeKey(tx, SETTING_KEYS.maxCostUsd, input.maxCostUsd, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.maxSteps, input.maxSteps, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.eventFallbackDays, input.eventFallbackDays, ctx.actor.id)
    await audit(tx, ctx.actor.id, "settings.update", "settings", "limits", { before, after: input })
    return input
  })
}

export const hashEventToken = (token: string) => createHash("sha256").update(token, "utf8").digest("hex")

/** 生成新的外部事件令牌：原文只在这里返回一次，库里只存 sha256；旧令牌立刻失效 */
export async function regenerateEventToken(ctx: WriteCtx) {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能生成令牌")
  const token = `hae_${randomBytes(24).toString("base64url")}`
  const record = { sha256: hashEventToken(token), hint: token.slice(-4), createdAt: new Date().toISOString() }
  await ctx.db.transaction(async (tx) => {
    await writeKey(tx, SETTING_KEYS.eventToken, record, ctx.actor.id)
    await audit(tx, ctx.actor.id, "settings.event_token.regenerate", "settings", SETTING_KEYS.eventToken, { hint: record.hint })
  })
  return { token, hint: record.hint, createdAt: record.createdAt }
}

/** 停用外部事件：删掉令牌，POST /api/events 一律拒绝 */
export async function clearEventToken(ctx: WriteCtx) {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能停用令牌")
  await ctx.db.transaction(async (tx) => {
    await tx.delete(t.settings).where(eq(t.settings.key, SETTING_KEYS.eventToken))
    await audit(tx, ctx.actor.id, "settings.event_token.clear", "settings", SETTING_KEYS.eventToken)
  })
  return { ok: true }
}

/** 新建或修改一个通知渠道；webhook 地址加密存进 secrets（名字 NOTIFY_<渠道 id>_URL） */
export async function saveChannel(ctx: WriteCtx, input: { id?: string; name: string; kind: NotifyChannel["kind"]; url?: string; enabled: boolean }) {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能改通知渠道")
  return ctx.db.transaction(async (tx) => {
    const channels = await readChannels(tx)
    const existing = input.id ? channels.find((channel) => channel.id === input.id) : undefined
    if (input.id && !existing) throw notFound("通知渠道", input.id)
    if (!existing && !input.url) throw badRequest("填 webhook 地址")
    const id = existing?.id ?? `ch-${randomBytes(3).toString("hex")}`
    const urlSecretName = existing?.urlSecretName ?? `NOTIFY_${snakeName(id)}_URL`
    if (input.url) await putSecret(tx, ctx.keyring(), { scope: "http_tool", refId: null, name: urlSecretName }, input.url, ctx.actor.id, 24)
    const next: NotifyChannel = { id, name: input.name, kind: input.kind, urlSecretName, enabled: input.enabled }
    await writeKey(tx, SETTING_KEYS.notifyChannels, existing ? channels.map((channel) => (channel.id === id ? next : channel)) : [...channels, next], ctx.actor.id)
    await audit(tx, ctx.actor.id, existing ? "settings.channel.update" : "settings.channel.create", "settings", id, { name: input.name, kind: input.kind, enabled: input.enabled, urlChanged: Boolean(input.url) })
    return { id }
  })
}

export async function deleteChannel(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能删通知渠道")
  return ctx.db.transaction(async (tx) => {
    const channels = await readChannels(tx)
    const existing = channels.find((channel) => channel.id === input.id)
    if (!existing) throw notFound("通知渠道", input.id)
    await writeKey(tx, SETTING_KEYS.notifyChannels, channels.filter((channel) => channel.id !== input.id), ctx.actor.id)
    await deleteSecret(tx, { scope: "http_tool", refId: null, name: existing.urlSecretName })
    await audit(tx, ctx.actor.id, "settings.channel.delete", "settings", input.id, { name: existing.name })
    return { id: input.id }
  })
}
