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
  type SettingsAgentInput,
  type SettingsAssistantInput,
  type SettingsBrowserInput,
  type SettingsDispatchInput,
  type SettingsLimitsInput,
  type SettingsSubagentInput,
  type SettingsView,
} from "@heyagent/shared"
import { z } from "zod"

import * as t from "../../db/schema.js"
import { assertCan, audit, badRequest, deleteSecret, findSecret, notFound, putSecret, type DbOrTx, type WriteCtx } from "./common.js"
import { visionModelProblem } from "./models.js"

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

/**
 * 浏览器设置（M2）：每个 worker 最多几个 Chrome、拿不准时用视觉模型、视觉模型是哪个、遇到验证码先自己试着过、等人时 Chrome 保留多久。
 * worker 每次用到时重新读
 */
export async function readBrowserSettings(db: DbOrTx): Promise<SettingsBrowserInput> {
  const values = await readKeys(db, [
    SETTING_KEYS.browserMaxPerWorker,
    SETTING_KEYS.browserVisionCheck,
    SETTING_KEYS.browserVisionModel,
    SETTING_KEYS.browserCaptchaSolve,
    SETTING_KEYS.browserHumanHoldMinutes,
  ])
  const positiveInt = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback)
  const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback)
  const model = values.get(SETTING_KEYS.browserVisionModel)
  return {
    maxPerWorker: positiveInt(values.get(SETTING_KEYS.browserMaxPerWorker), SETTINGS_DEFAULTS.browserMaxPerWorker),
    visionCheck: bool(values.get(SETTING_KEYS.browserVisionCheck), SETTINGS_DEFAULTS.browserVisionCheck),
    visionModel: typeof model === "string" && model ? model : SETTINGS_DEFAULTS.browserVisionModel,
    captchaSolve: bool(values.get(SETTING_KEYS.browserCaptchaSolve), SETTINGS_DEFAULTS.browserCaptchaSolve),
    humanHoldMinutes: positiveInt(values.get(SETTING_KEYS.browserHumanHoldMinutes), SETTINGS_DEFAULTS.browserHumanHoldMinutes),
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
    [SETTING_KEYS.browserMaxPerWorker, SETTINGS_DEFAULTS.browserMaxPerWorker],
    [SETTING_KEYS.browserVisionCheck, SETTINGS_DEFAULTS.browserVisionCheck],
    [SETTING_KEYS.browserVisionModel, SETTINGS_DEFAULTS.browserVisionModel],
    [SETTING_KEYS.browserCaptchaSolve, SETTINGS_DEFAULTS.browserCaptchaSolve],
    [SETTING_KEYS.browserHumanHoldMinutes, SETTINGS_DEFAULTS.browserHumanHoldMinutes],
    [SETTING_KEYS.verifyMaxRounds, SETTINGS_DEFAULTS.verifyMaxRounds],
    [SETTING_KEYS.compactMaxTokens, SETTINGS_DEFAULTS.compactMaxTokens],
    [SETTING_KEYS.dispatchMaxDepth, SETTINGS_DEFAULTS.dispatchMaxDepth],
    [SETTING_KEYS.dispatchMaxPerSession, SETTINGS_DEFAULTS.dispatchMaxPerSession],
    [SETTING_KEYS.dispatchMaxPerTaskPerDay, SETTINGS_DEFAULTS.dispatchMaxPerTaskPerDay],
    [SETTING_KEYS.dispatchMaxQueued, SETTINGS_DEFAULTS.dispatchMaxQueued],
    [SETTING_KEYS.subagentMaxParallel, SETTINGS_DEFAULTS.subagentMaxParallel],
    [SETTING_KEYS.subagentMaxPerRun, SETTINGS_DEFAULTS.subagentMaxPerRun],
    [SETTING_KEYS.subagentMaxRunningGlobal, SETTINGS_DEFAULTS.subagentMaxRunningGlobal],
    [SETTING_KEYS.subagentMaxCostUsd, SETTINGS_DEFAULTS.subagentMaxCostUsd],
    [SETTING_KEYS.subagentMaxSteps, SETTINGS_DEFAULTS.subagentMaxSteps],
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
  const browser = await readBrowserSettings(ctx.db)
  const agent = await readAgentSettings(ctx.db)
  const dispatch = await readDispatchSettings(ctx.db)
  const assistant = await readAssistantSettings(ctx.db)
  const subagent = await readSubagentSettings(ctx.db)
  return { ...limits, browser, agent, dispatch, assistant, subagent, ...(token ? { eventToken: { hint: token.hint, createdAt: token.createdAt } } : {}), channels: withMask }
}

/** agent 相关的设置（M3）：验收最多几轮、压缩上下文的 token 上限。引擎每次用到时重新读 */
export async function readAgentSettings(db: DbOrTx): Promise<SettingsAgentInput> {
  const values = await readKeys(db, [SETTING_KEYS.verifyMaxRounds, SETTING_KEYS.compactMaxTokens])
  const int = (value: unknown, fallback: number, min: number) => (typeof value === "number" && Number.isInteger(value) && value >= min ? value : fallback)
  return {
    verifyMaxRounds: int(values.get(SETTING_KEYS.verifyMaxRounds), SETTINGS_DEFAULTS.verifyMaxRounds, 1),
    compactMaxTokens: int(values.get(SETTING_KEYS.compactMaxTokens), SETTINGS_DEFAULTS.compactMaxTokens, 0),
  }
}

export async function updateAgentSettings(ctx: WriteCtx, input: SettingsAgentInput) {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能改全局设置")
  return ctx.db.transaction(async (tx) => {
    const before = await readAgentSettings(tx)
    await writeKey(tx, SETTING_KEYS.verifyMaxRounds, input.verifyMaxRounds, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.compactMaxTokens, input.compactMaxTokens, ctx.actor.id)
    await audit(tx, ctx.actor.id, "settings.agent.update", "settings", "agent", { before, after: input })
    return input
  })
}

/** 派活的四个上限（层数、一次运行最多派几张、一个任务每天最多被派几张、最多排队几张）。派活时每次重新读，读不到用默认值 */
export async function readDispatchSettings(db: DbOrTx): Promise<SettingsDispatchInput> {
  const values = await readKeys(db, [SETTING_KEYS.dispatchMaxDepth, SETTING_KEYS.dispatchMaxPerSession, SETTING_KEYS.dispatchMaxPerTaskPerDay, SETTING_KEYS.dispatchMaxQueued])
  const positiveInt = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback)
  return {
    maxDepth: positiveInt(values.get(SETTING_KEYS.dispatchMaxDepth), SETTINGS_DEFAULTS.dispatchMaxDepth),
    maxPerSession: positiveInt(values.get(SETTING_KEYS.dispatchMaxPerSession), SETTINGS_DEFAULTS.dispatchMaxPerSession),
    maxPerTaskPerDay: positiveInt(values.get(SETTING_KEYS.dispatchMaxPerTaskPerDay), SETTINGS_DEFAULTS.dispatchMaxPerTaskPerDay),
    maxQueued: positiveInt(values.get(SETTING_KEYS.dispatchMaxQueued), SETTINGS_DEFAULTS.dispatchMaxQueued),
  }
}

export async function updateDispatchSettings(ctx: WriteCtx, input: SettingsDispatchInput) {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能改全局设置")
  return ctx.db.transaction(async (tx) => {
    const before = await readDispatchSettings(tx)
    await writeKey(tx, SETTING_KEYS.dispatchMaxDepth, input.maxDepth, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.dispatchMaxPerSession, input.maxPerSession, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.dispatchMaxPerTaskPerDay, input.maxPerTaskPerDay, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.dispatchMaxQueued, input.maxQueued, ctx.actor.id)
    await audit(tx, ctx.actor.id, "settings.dispatch.update", "settings", "dispatch", { before, after: input })
    return input
  })
}

/** 子 agent 的五个上限（docs/dev/sub-agents.md 6.1）。拆、放行、开子运行时每次重新读，读不到用默认值 */
export async function readSubagentSettings(db: DbOrTx): Promise<SettingsSubagentInput> {
  const values = await readKeys(db, [
    SETTING_KEYS.subagentMaxParallel,
    SETTING_KEYS.subagentMaxPerRun,
    SETTING_KEYS.subagentMaxRunningGlobal,
    SETTING_KEYS.subagentMaxCostUsd,
    SETTING_KEYS.subagentMaxSteps,
  ])
  const positiveInt = (value: unknown, fallback: number) => (typeof value === "number" && Number.isInteger(value) && value > 0 ? value : fallback)
  const positive = (value: unknown, fallback: number) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback)
  return {
    maxParallel: positiveInt(values.get(SETTING_KEYS.subagentMaxParallel), SETTINGS_DEFAULTS.subagentMaxParallel),
    maxPerRun: positiveInt(values.get(SETTING_KEYS.subagentMaxPerRun), SETTINGS_DEFAULTS.subagentMaxPerRun),
    maxRunningGlobal: positiveInt(values.get(SETTING_KEYS.subagentMaxRunningGlobal), SETTINGS_DEFAULTS.subagentMaxRunningGlobal),
    maxCostUsd: positive(values.get(SETTING_KEYS.subagentMaxCostUsd), SETTINGS_DEFAULTS.subagentMaxCostUsd),
    maxSteps: positiveInt(values.get(SETTING_KEYS.subagentMaxSteps), SETTINGS_DEFAULTS.subagentMaxSteps),
  }
}

/** 改子 agent 的上限。TODO(子 agent 后端)：提交后发 subagent.pump（名额调大了，排队的能放行；signal.ts 的 sendSubagentPump） */
export async function updateSubagentSettings(ctx: WriteCtx, input: SettingsSubagentInput) {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能改全局设置")
  return ctx.db.transaction(async (tx) => {
    const before = await readSubagentSettings(tx)
    await writeKey(tx, SETTING_KEYS.subagentMaxParallel, input.maxParallel, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.subagentMaxPerRun, input.maxPerRun, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.subagentMaxRunningGlobal, input.maxRunningGlobal, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.subagentMaxCostUsd, input.maxCostUsd, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.subagentMaxSteps, input.maxSteps, ctx.actor.id)
    await audit(tx, ctx.actor.id, "settings.subagent.update", "settings", "subagent", { before, after: input })
    return input
  })
}

/** 右下角助手：一次请求最多几步、最多花多少美元。每次请求开始时重新读，读不到用默认值 */
export async function readAssistantSettings(db: DbOrTx): Promise<SettingsAssistantInput> {
  const values = await readKeys(db, [SETTING_KEYS.assistantMaxSteps, SETTING_KEYS.assistantMaxCostUsd])
  const steps = values.get(SETTING_KEYS.assistantMaxSteps)
  const cost = values.get(SETTING_KEYS.assistantMaxCostUsd)
  return {
    maxSteps: typeof steps === "number" && Number.isInteger(steps) && steps > 0 ? steps : SETTINGS_DEFAULTS.assistantMaxSteps,
    maxCostUsd: typeof cost === "number" && cost > 0 ? cost : SETTINGS_DEFAULTS.assistantMaxCostUsd,
  }
}

export async function updateAssistantSettings(ctx: WriteCtx, input: SettingsAssistantInput) {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能改全局设置")
  return ctx.db.transaction(async (tx) => {
    const before = await readAssistantSettings(tx)
    await writeKey(tx, SETTING_KEYS.assistantMaxSteps, input.maxSteps, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.assistantMaxCostUsd, input.maxCostUsd, ctx.actor.id)
    await audit(tx, ctx.actor.id, "settings.assistant.update", "settings", "assistant", { before, after: input })
    return input
  })
}

export async function updateBrowserSettings(ctx: WriteCtx, input: SettingsBrowserInput) {
  assertCan(ctx.actor, "settings.manage", {}, "只有主管能改全局设置")
  return ctx.db.transaction(async (tx) => {
    const before = await readBrowserSettings(tx)
    // 换了模型才查（没刷新模型列表时默认模型可能还不在库里，不能因此存不了别的设置）
    if (input.visionModel !== before.visionModel) {
      const problem = await visionModelProblem(tx, input.visionModel, "浏览器")
      if (problem) throw badRequest(problem)
    }
    await writeKey(tx, SETTING_KEYS.browserMaxPerWorker, input.maxPerWorker, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.browserVisionCheck, input.visionCheck, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.browserVisionModel, input.visionModel, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.browserCaptchaSolve, input.captchaSolve, ctx.actor.id)
    await writeKey(tx, SETTING_KEYS.browserHumanHoldMinutes, input.humanHoldMinutes, ctx.actor.id)
    await audit(tx, ctx.actor.id, "settings.browser.update", "settings", "browser", { before, after: input })
    return input
  })
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
