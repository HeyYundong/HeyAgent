// 模型的写操作：模型服务（OpenRouter / Ollama；key 进 secrets）、刷新模型列表、测试连接、三个角色的默认模型。
// 不调模型：OpenRouter 的模型列表用公开的 GET /models（不需要 key、不花钱）；测试连接另外用 GET /key 核对 key 有效（也不花钱）。
import { desc, eq, inArray, notInArray, sql } from "drizzle-orm"
import { defaultsAfterRemove, modelFamily, providerKindLabel, sameFamily, type ModelDefaults, type ModelProviderKind, type ProviderCheck } from "@heyagent/shared"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { decryptText, type Keyring } from "../../lib/crypto.js"
import { assertCan, audit, badRequest, conflict, deleteSecret, notFound, putSecret, type DbOrTx, type WriteCtx } from "./common.js"
import { usedByText } from "./tasks.js"

const TIMEOUT_MS = 15_000

/** 一个模型（刷新得到的） */
export interface CatalogModel {
  /** 服务里的模型名，例如 anthropic/claude-sonnet-5.5 */
  name: string
  displayName: string
  note: string
  contextK: number
  priceIn: number
  priceOut: number
  vision: boolean
}

async function getJson(url: string, headers: Record<string, string> = {}) {
  const started = Date.now()
  const response = await fetch(url, { headers: { accept: "application/json", ...headers }, signal: AbortSignal.timeout(TIMEOUT_MS) })
  const latencyMs = Date.now() - started
  const body = response.ok ? ((await response.json()) as unknown) : undefined
  return { status: response.status, ok: response.ok, body, latencyMs }
}

const trimUrl = (url: string) => url.trim().replace(/\/+$/, "")
const perMillion = (value: unknown) => Math.round(Number(value ?? 0) * 1_000_000 * 10_000) / 10_000

interface OpenRouterModel {
  id: string
  name?: string
  description?: string
  context_length?: number
  pricing?: { prompt?: string; completion?: string }
  architecture?: { input_modalities?: string[] }
  supported_parameters?: string[]
}

/**
 * OpenRouter 的模型目录（公开接口，不用 key）。只留能调工具的模型：agent 每一步都要调工具，
 * 不能调工具的模型选了也跑不起来（models 表没有「能不能调工具」这一列，所以不进表）。价格是负数的（按路由浮动）也不要。
 */
export function parseOpenRouterModels(body: unknown): CatalogModel[] {
  const list = (body as { data?: OpenRouterModel[] } | undefined)?.data
  if (!Array.isArray(list)) throw new Error("OpenRouter 返回的模型列表格式不对")
  return list
    .filter((model) => typeof model.id === "string" && model.supported_parameters?.includes("tools"))
    .filter((model) => Number(model.pricing?.prompt ?? 0) >= 0 && Number(model.pricing?.completion ?? 0) >= 0)
    .map((model) => ({
      name: model.id,
      // 「Anthropic: Claude Sonnet 5.5」→「Claude Sonnet 5.5」
      displayName: (model.name ?? model.id).replace(/^[^:]{1,40}:\s*/, ""),
      note: (model.description ?? "").split(/(?<=[.。])\s/)[0]!.slice(0, 120),
      contextK: Math.max(1, Math.round((model.context_length ?? 0) / 1000)),
      priceIn: perMillion(model.pricing?.prompt),
      priceOut: perMillion(model.pricing?.completion),
      vision: model.architecture?.input_modalities?.includes("image") ?? false,
    }))
}

function parseOllamaModels(body: unknown): CatalogModel[] {
  const list = (body as { models?: { name: string; details?: { parameter_size?: string; families?: string[] } }[] } | undefined)?.models
  if (!Array.isArray(list)) throw new Error("Ollama 返回的模型列表格式不对")
  return list.map((model) => ({
    name: model.name,
    displayName: model.name,
    note: model.details?.parameter_size ? `本地 ${model.details.parameter_size}` : "本地模型",
    // Ollama 的列表里没有上下文长度，先记 0，由人在模型页看说明
    contextK: 0,
    priceIn: 0,
    priceOut: 0,
    vision: model.details?.families?.includes("clip") ?? false,
  }))
}

/** 连一次服务：拿到模型目录；OpenRouter 有 key 时再核对一次 key（GET /key，不花钱） */
export async function probeProvider(kind: ModelProviderKind, baseUrl: string, apiKey?: string, verifyKey = true): Promise<{ check: ProviderCheck; models: CatalogModel[] }> {
  const base = trimUrl(baseUrl)
  try {
    if (kind === "openrouter") {
      const list = await getJson(`${base}/models`)
      if (!list.ok) return { check: { ok: false, message: `连不上 OpenRouter：GET /models 返回 HTTP ${list.status}` }, models: [] }
      const models = parseOpenRouterModels(list.body)
      if (apiKey && verifyKey) {
        const key = await getJson(`${base}/key`, { authorization: `Bearer ${apiKey}` })
        if (key.status === 401 || key.status === 403) return { check: { ok: false, latencyMs: list.latencyMs, message: "API Key 不对（OpenRouter 返回 401），请检查后重新填" }, models: [] }
        if (!key.ok) return { check: { ok: false, latencyMs: list.latencyMs, message: `核对 API Key 失败：HTTP ${key.status}` }, models: [] }
      }
      return { check: { ok: true, latencyMs: list.latencyMs, models: models.length, message: `连上了，读到 ${models.length} 个能调工具的模型` }, models }
    }
    const tags = await getJson(`${base}/api/tags`)
    if (!tags.ok) return { check: { ok: false, message: `连不上 Ollama：GET /api/tags 返回 HTTP ${tags.status}` }, models: [] }
    const models = parseOllamaModels(tags.body)
    return { check: { ok: true, latencyMs: tags.latencyMs, models: models.length, message: `连上了，读到 ${models.length} 个模型` }, models }
  } catch (error) {
    const reason = error instanceof Error && error.name === "TimeoutError" ? `${TIMEOUT_MS / 1000} 秒没响应` : error instanceof Error ? error.message : String(error)
    return { check: { ok: false, message: `连不上：${reason}` }, models: [] }
  }
}

async function providerKey(db: DbOrTx, keyring: Keyring, secretId: string | null) {
  if (!secretId) return undefined
  const [row] = await db.select().from(t.secrets).where(eq(t.secrets.id, secretId))
  return row ? decryptText(keyring, row.enc, { table: "secrets", id: row.id, version: row.version }) : undefined
}

/** 把模型目录写进 models 表：新的加上，旧的更新，没了的删掉（默认设置还在用的先留着，免得默认设置断掉） */
async function writeModels(tx: DbOrTx, providerId: string, models: CatalogModel[]) {
  const rows = models.map((model, position) => ({
    id: `${providerId}/${model.name}`,
    providerId,
    name: model.displayName,
    note: model.note,
    contextK: model.contextK,
    priceIn: model.priceIn,
    priceOut: model.priceOut,
    vision: model.vision,
    position,
  }))
  const keep = new Set(rows.map((row) => row.id))
  const defaults = (await tx.select({ modelId: t.modelDefaults.modelId }).from(t.modelDefaults)).map((row) => row.modelId)
  const stale = (await tx.select({ id: t.models.id }).from(t.models).where(eq(t.models.providerId, providerId))).map((row) => row.id).filter((id) => !keep.has(id) && !defaults.includes(id))
  if (stale.length) await tx.delete(t.models).where(inArray(t.models.id, stale))
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    await tx
      .insert(t.models)
      .values(chunk)
      .onConflictDoUpdate({
        target: t.models.id,
        set: { name: sqlExcluded("name"), note: sqlExcluded("note"), contextK: sqlExcluded("context_k"), priceIn: sqlExcluded("price_in"), priceOut: sqlExcluded("price_out"), vision: sqlExcluded("vision"), position: sqlExcluded("position") },
      })
  }
}

const sqlExcluded = (column: string) => sql.raw(`excluded.${column}`)

async function nextProviderId(db: DbOrTx, kind: ModelProviderKind) {
  const taken = (await db.select({ id: t.modelProviders.id }).from(t.modelProviders)).map((row) => row.id)
  if (!taken.includes(kind)) return kind
  for (let n = 2; ; n++) if (!taken.includes(`${kind}-${n}`)) return `${kind}-${n}`
}

/**
 * 新建模型服务（主管在页面上加；空白环境初始化时用 .env 里的 OPENROUTER_API_KEY 加）。先连一次，连不上就不存。
 * actorId 为空 = 系统自己做的（初始化）。
 */
export async function addProvider(
  db: Db,
  keyring: Keyring,
  actorId: string | null,
  input: { kind: ModelProviderKind; name?: string; baseUrl: string; apiKey?: string },
  options: { verifyKey?: boolean } = {}
) {
  if (input.kind === "openrouter" && !input.apiKey) throw badRequest("填 OpenRouter 的 API Key")
  const { check, models } = await probeProvider(input.kind, input.baseUrl, input.apiKey, options.verifyKey ?? true)
  if (!check.ok) throw badRequest(check.message)
  const id = await db.transaction(async (tx) => {
    const id = await nextProviderId(tx, input.kind)
    const [last] = await tx.select({ position: t.modelProviders.position }).from(t.modelProviders).orderBy(desc(t.modelProviders.position)).limit(1)
    await tx.insert(t.modelProviders).values({
      id,
      kind: input.kind,
      name: input.name || (id === input.kind ? providerKindLabel[input.kind] : `${providerKindLabel[input.kind]} ${id.split("-").at(-1)}`),
      baseUrl: trimUrl(input.baseUrl),
      status: "ok",
      checkedAt: new Date(),
      latencyMs: check.latencyMs ?? null,
      position: (last?.position ?? 0) + 1,
    })
    if (input.apiKey) {
      const secretId = await putSecret(tx, keyring, { scope: "model_provider", refId: id, name: "api_key" }, input.apiKey, actorId, 9)
      await tx.update(t.modelProviders).set({ apiKeySecretId: secretId }).where(eq(t.modelProviders.id, id))
    }
    await writeModels(tx, id, models)
    await audit(tx, actorId, "model_provider.create", "model_providers", id, { kind: input.kind, baseUrl: trimUrl(input.baseUrl), models: models.length, apiKeySet: Boolean(input.apiKey) })
    return id
  })
  return { id, check }
}

export async function createProvider(ctx: WriteCtx, input: { kind: ModelProviderKind; name?: string; baseUrl: string; apiKey?: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能加模型服务")
  return addProvider(ctx.db, ctx.keyring(), ctx.actor.id, input)
}

async function loadProvider(db: DbOrTx, id: string) {
  const [row] = await db.select().from(t.modelProviders).where(eq(t.modelProviders.id, id))
  if (!row) throw notFound("模型服务", id)
  return row
}

/** 改地址、换 key：先用新的连一次，连上了才存，同时刷新模型列表 */
export async function updateProvider(ctx: WriteCtx, input: { id: string; name?: string; baseUrl: string; apiKey?: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能改模型服务")
  const before = await loadProvider(ctx.db, input.id)
  const apiKey = input.apiKey || (await providerKey(ctx.db, ctx.keyring(), before.apiKeySecretId))
  if (before.kind === "openrouter" && !apiKey) throw badRequest("填 OpenRouter 的 API Key")
  const { check, models } = await probeProvider(before.kind, input.baseUrl, apiKey)
  if (!check.ok) throw badRequest(check.message)
  await ctx.db.transaction(async (tx) => {
    let apiKeySecretId = before.apiKeySecretId
    if (input.apiKey) apiKeySecretId = await putSecret(tx, ctx.keyring(), { scope: "model_provider", refId: input.id, name: "api_key" }, input.apiKey, ctx.actor.id, 9)
    await tx
      .update(t.modelProviders)
      .set({ name: input.name || before.name, baseUrl: trimUrl(input.baseUrl), apiKeySecretId, status: "ok", checkedAt: new Date(), latencyMs: check.latencyMs ?? null })
      .where(eq(t.modelProviders.id, input.id))
    await writeModels(tx, input.id, models)
    await audit(tx, ctx.actor.id, "model_provider.update", "model_providers", input.id, { baseUrl: trimUrl(input.baseUrl), apiKeyChanged: Boolean(input.apiKey), models: models.length })
  })
  return { id: input.id, check }
}

/** 测试连接：结果写回状态、检查时间、延迟（连不上不报错，返回原因） */
export async function testProvider(ctx: WriteCtx, input: { id: string }): Promise<ProviderCheck> {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能测试模型服务")
  const before = await loadProvider(ctx.db, input.id)
  if (!before.baseUrl) return { ok: false, message: "还没填地址：先编辑这个服务" }
  const apiKey = await providerKey(ctx.db, ctx.keyring(), before.apiKeySecretId)
  const { check } = await probeProvider(before.kind, before.baseUrl, apiKey)
  await ctx.db.transaction(async (tx) => {
    await tx.update(t.modelProviders).set({ status: check.ok ? "ok" : "error", checkedAt: new Date(), latencyMs: check.latencyMs ?? null }).where(eq(t.modelProviders.id, input.id))
    await audit(tx, ctx.actor.id, "model_provider.test", "model_providers", input.id, { ok: check.ok, message: check.message })
  })
  return check
}

/** 刷新模型列表 */
export async function refreshProvider(db: Db, actorId: string | null, id: string): Promise<ProviderCheck> {
  const before = await loadProvider(db, id)
  if (!before.baseUrl) return { ok: false, message: "还没填地址：先编辑这个服务" }
  // 刷新列表只用公开接口，不带 key
  const { check, models } = await probeProvider(before.kind, before.baseUrl)
  await db.transaction(async (tx) => {
    await tx.update(t.modelProviders).set({ status: check.ok ? "ok" : "error", checkedAt: new Date(), latencyMs: check.latencyMs ?? null }).where(eq(t.modelProviders.id, id))
    if (check.ok) await writeModels(tx, id, models)
    await audit(tx, actorId, "model_provider.refresh", "model_providers", id, { ok: check.ok, models: models.length })
  })
  return check
}

export async function refreshProviderAsActor(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能刷新模型列表")
  return refreshProvider(ctx.db, ctx.actor.id, input.id)
}

/** 删除模型服务：有任务在用它的模型就不能删；默认设置里用到的换成别家的 */
export async function deleteProvider(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能删模型服务")
  return ctx.db.transaction(async (tx) => {
    const before = await loadProvider(tx, input.id)
    const modelCols = { id: t.models.id, name: t.models.name, note: t.models.note, contextK: t.models.contextK, priceIn: t.models.priceIn, priceOut: t.models.priceOut }
    const own = await tx.select(modelCols).from(t.models).where(eq(t.models.providerId, input.id))
    const ownIds = own.map((row) => row.id)
    const used = ownIds.length ? await tx.select({ id: t.tasks.id, title: t.tasks.title }).from(t.tasks).where(inArray(t.tasks.modelId, ownIds)) : []
    if (used.length) throw conflict(`有 ${used.length} 个任务在用「${before.name}」的模型：${usedByText(used)}。先给这些任务换模型，再删除。`)
    const current = await readDefaults(tx)
    const rest = await tx.select(modelCols).from(t.models).where(ownIds.length ? notInArray(t.models.id, ownIds) : undefined)
    const next = defaultsAfterRemove(current, { models: own }, [{ models: rest }])
    await tx.delete(t.modelDefaults)
    for (const role of ["run", "plan", "verify"] as const) {
      if (next[role] && !ownIds.includes(next[role])) await tx.insert(t.modelDefaults).values({ role, modelId: next[role], updatedById: ctx.actor.id })
    }
    await tx.delete(t.modelProviders).where(eq(t.modelProviders.id, input.id))
    await deleteSecret(tx, { scope: "model_provider", refId: input.id, name: "api_key" })
    await audit(tx, ctx.actor.id, "model_provider.delete", "model_providers", input.id, { name: before.name, defaults: next })
    return { id: input.id, defaults: next }
  })
}

async function readDefaults(db: DbOrTx): Promise<ModelDefaults> {
  const rows = await db.select().from(t.modelDefaults)
  const of = (role: "run" | "plan" | "verify") => rows.find((row) => row.role === role)?.modelId ?? ""
  return { run: of("run"), plan: of("plan"), verify: of("verify") }
}

/** 三个角色的默认模型。验收不许和执行同一家（不算第三方） */
export async function writeDefaults(db: DbOrTx, actorId: string | null, input: ModelDefaults) {
  if (sameFamily(input.run, input.verify)) {
    throw badRequest(`执行和三方验收是同一家（${modelFamily(input.run)}），验收就不算第三方了。请给验收换一家。`)
  }
  const ids = [...new Set([input.run, input.plan, input.verify])]
  const found = (await db.select({ id: t.models.id }).from(t.models).where(inArray(t.models.id, ids))).map((row) => row.id)
  const missing = ids.filter((id) => !found.includes(id))
  if (missing.length) throw badRequest(`模型不存在：${missing.join("、")}`)
  for (const role of ["run", "plan", "verify"] as const) {
    await db
      .insert(t.modelDefaults)
      .values({ role, modelId: input[role], updatedById: actorId })
      .onConflictDoUpdate({ target: t.modelDefaults.role, set: { modelId: input[role], updatedById: actorId, updatedAt: new Date() } })
  }
}

export async function setModelDefaults(ctx: WriteCtx, input: ModelDefaults) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能改默认模型")
  return ctx.db.transaction(async (tx) => {
    const before = await readDefaults(tx)
    await writeDefaults(tx, ctx.actor.id, input)
    await audit(tx, ctx.actor.id, "model_defaults.update", "model_defaults", "defaults", { before, after: input })
    return input
  })
}

