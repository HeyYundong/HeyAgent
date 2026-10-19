// 模型的写操作：模型服务（OpenRouter / Ollama / 直连 Claude、OpenAI、DeepSeek；key 进 secrets）、刷新模型列表、测试连接、各角色的默认模型（含图库的 embedding 模型）。
// 不调模型：OpenRouter 的模型列表用公开的 GET /models 和 GET /embeddings/models（不需要 key、不花钱）；测试连接另外用 GET /key 核对 key 有效（也不花钱）。
// 直连厂商时列模型要带 key（同时就核对了 key）；厂商的列表不给价格，按模型名到 OpenRouter 的公开目录查。
import { and, asc, desc, eq, inArray, notInArray, sql } from "drizzle-orm"
import { defaultsAfterRemove, modelFamily, OPENROUTER_DEFAULT_URL, providerKindLabel, providerNeedsKey, sameFamily, type CompareModel, type ModelDefaults, type ModelProviderKind, type ModelRole, type ProviderCheck } from "@heyagent/shared"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { kickGalleryEmbeddings } from "../../gallery/background.js"
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
  /** chat = 能调工具的聊天模型；embedding = 向量模型（vision 表示能处理图片） */
  kind: "chat" | "embedding"
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
// 「Anthropic: Claude Sonnet 5.5」→「Claude Sonnet 5.5」
const withoutVendor = (name: string) => name.replace(/^[^:]{1,40}:\s*/, "")
const firstSentence = (text: string | undefined) => (text ?? "").split(/(?<=[.。])\s/)[0]!.slice(0, 120)

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
      displayName: withoutVendor(model.name ?? model.id),
      note: firstSentence(model.description),
      contextK: Math.max(1, Math.round((model.context_length ?? 0) / 1000)),
      priceIn: perMillion(model.pricing?.prompt),
      priceOut: perMillion(model.pricing?.completion),
      vision: model.architecture?.input_modalities?.includes("image") ?? false,
      kind: "chat" as const,
    }))
}

/** OpenRouter 的 embedding 模型目录（公开接口 GET /embeddings/models）。全部留下，能不能处理图片记在 vision 上 */
export function parseOpenRouterEmbeddingModels(body: unknown): CatalogModel[] {
  const list = (body as { data?: OpenRouterModel[] } | undefined)?.data
  if (!Array.isArray(list)) throw new Error("OpenRouter 返回的 embedding 模型列表格式不对")
  return list
    .filter((model) => typeof model.id === "string" && Number(model.pricing?.prompt ?? 0) >= 0)
    .map((model) => ({
      name: model.id,
      displayName: (model.name ?? model.id).replace(/^[^:]{1,40}:\s*/, ""),
      note: (model.description ?? "").split(/(?<=[.。])\s/)[0]!.slice(0, 120),
      contextK: Math.max(1, Math.round((model.context_length ?? 0) / 1000)),
      priceIn: perMillion(model.pricing?.prompt),
      priceOut: 0,
      vision: model.architecture?.input_modalities?.includes("image") ?? false,
      kind: "embedding" as const,
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
    kind: "chat" as const,
  }))
}

type NativeKind = "anthropic" | "openai" | "deepseek"
const isNative = (kind: ModelProviderKind): kind is NativeKind => kind === "anthropic" || kind === "openai" || kind === "deepseek"

/** 厂商自己列出的模型：Anthropic 还给显示名、上下文长度、能不能看图；OpenAI、DeepSeek 只有 id 和发布时间 */
export interface NativeModel {
  id: string
  /** 发布时间（毫秒），新的排前面 */
  created: number
  displayName?: string
  contextK?: number
  vision?: boolean
}

interface NativeListItem {
  id?: unknown
  created?: number
  created_at?: string
  display_name?: string
  max_input_tokens?: number
  capabilities?: { image_input?: { supported?: boolean } }
}

/** 列模型：GET /models（要 key，不花钱）。Anthropic 分页（每页最多 1000 个），OpenAI、DeepSeek 一次给全 */
async function listNativeModels(kind: NativeKind, base: string, apiKey: string) {
  const headers: Record<string, string> = kind === "anthropic" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${apiKey}` }
  const models: NativeModel[] = []
  let latencyMs: number | undefined
  let afterId: string | undefined
  // 翻页上限只是防死循环
  for (let page = 0; page < 10; page++) {
    const query = kind === "anthropic" ? `?limit=1000${afterId ? `&after_id=${encodeURIComponent(afterId)}` : ""}` : ""
    const res = await getJson(`${base}/models${query}`, headers)
    latencyMs ??= res.latencyMs
    if (!res.ok) return { status: res.status, latencyMs, models }
    const body = res.body as { data?: NativeListItem[]; has_more?: boolean; last_id?: string } | undefined
    if (!Array.isArray(body?.data)) throw new Error(`${providerKindLabel[kind]} 返回的模型列表格式不对`)
    for (const item of body.data) {
      if (typeof item.id !== "string") continue
      const created = item.created_at ? Date.parse(item.created_at) : (item.created ?? 0) * 1000
      models.push({
        id: item.id,
        created: Number.isFinite(created) ? created : 0,
        displayName: item.display_name,
        contextK: item.max_input_tokens ? Math.round(item.max_input_tokens / 1000) : undefined,
        vision: item.capabilities?.image_input?.supported,
      })
    }
    if (!body.has_more || !body.last_id) break
    afterId = body.last_id
  }
  return { status: 200, latencyMs, models }
}

/** 比模型名时忽略版本号里的点和日期后缀：claude-haiku-4-5-20251001 ≈ claude-haiku-4.5，gpt-5-2025-08-07 ≈ gpt-5 */
const looseName = (name: string) => name.toLowerCase().replace(/\./g, "-").replace(/-(\d{8}|\d{4}-\d{2}-\d{2})$/, "")

/** OpenRouter 公开目录里这家厂商的模型，按名字查：先原样，再宽松 */
function referenceLookup(reference: OpenRouterModel[], vendor: NativeKind) {
  const exact = new Map<string, OpenRouterModel>()
  const loose = new Map<string, OpenRouterModel>()
  for (const model of reference) {
    const slash = model.id.indexOf("/")
    if (slash < 0 || model.id.slice(0, slash) !== vendor) continue
    const name = model.id.slice(slash + 1)
    // :batch、:free 这类是 OpenRouter 自己的线路，价格不是厂商的
    if (name.includes(":")) continue
    exact.set(name, model)
    if (!loose.has(looseName(name))) loose.set(looseName(name), model)
  }
  return (id: string) => {
    const hit = exact.get(id)
    if (hit) return { model: hit, exact: true }
    const near = loose.get(looseName(id))
    return near ? { model: near, exact: false } : undefined
  }
}

/** OpenAI 的 /models 里还有向量、语音、画图、审核等模型。目录里查得到的看「能不能调工具」，查不到的按名字猜 */
const OPENAI_CHAT = /^(gpt-|o\d|chatgpt-)/
const OPENAI_NOT_CHAT = /(audio|realtime|tts|transcribe|image|search|embedding|instruct|moderation|diariz)/

/**
 * 直连厂商的模型目录：厂商列出的模型 + OpenRouter 公开目录里的价格、上下文长度、能不能看图（Anthropic 自己给的优先）。
 * 查不到价格的单价记 0（页面显示「未知」，花费按 0 算）；reference 为空 = 公开目录没连上。
 */
export function nativeCatalog(kind: NativeKind, listed: NativeModel[], reference: OpenRouterModel[] | undefined): CatalogModel[] {
  const lookup = referenceLookup(reference ?? [], kind)
  const out: CatalogModel[] = []
  for (const model of [...listed].sort((a, b) => b.created - a.created)) {
    const found = lookup(model.id)
    const ref = found?.model
    if (kind === "openai" && !(ref ? ref.supported_parameters?.includes("tools") : OPENAI_CHAT.test(model.id) && !OPENAI_NOT_CHAT.test(model.id))) continue
    out.push({
      name: model.id,
      // 宽松匹配到的是同名的别的版本：名字用 id，免得两行显示一样
      displayName: model.displayName ?? (ref && found.exact ? withoutVendor(ref.name ?? model.id) : model.id),
      note: firstSentence(ref?.description),
      contextK: model.contextK ?? (ref?.context_length ? Math.max(1, Math.round(ref.context_length / 1000)) : 0),
      // 负数是 OpenRouter 按路由浮动的价格，当作没查到
      priceIn: Math.max(0, perMillion(ref?.pricing?.prompt)),
      priceOut: Math.max(0, perMillion(ref?.pricing?.completion)),
      vision: model.vision ?? ref?.architecture?.input_modalities?.includes("image") ?? false,
      kind: "chat",
    })
  }
  return out
}

/** OpenRouter 的公开目录（不用 key）：只用来查价格，连不上不影响添加服务 */
async function loadReference(): Promise<OpenRouterModel[] | undefined> {
  try {
    const res = await getJson(`${OPENROUTER_DEFAULT_URL}/models`)
    const list = (res.body as { data?: OpenRouterModel[] } | undefined)?.data
    return Array.isArray(list) ? list.filter((model) => typeof model.id === "string") : undefined
  } catch {
    return undefined
  }
}

/** embedding 模型目录读不到（例如自建的中转地址没有这个接口）时返回 undefined：已有的 embedding 模型留着，不当成「全下架了」 */
async function openRouterEmbeddingModels(base: string): Promise<CatalogModel[] | undefined> {
  try {
    const list = await getJson(`${base}/embeddings/models`)
    return list.ok ? parseOpenRouterEmbeddingModels(list.body) : undefined
  } catch {
    return undefined
  }
}

async function probeNative(kind: NativeKind, base: string, apiKey: string | undefined): Promise<{ check: ProviderCheck; models: CatalogModel[] }> {
  const label = providerKindLabel[kind]
  if (!apiKey) return { check: { ok: false, message: `还没填 ${label} 的 API Key：先编辑这个服务` }, models: [] }
  const [listed, reference] = await Promise.all([listNativeModels(kind, base, apiKey), loadReference()])
  if (listed.status === 401 || listed.status === 403) return { check: { ok: false, latencyMs: listed.latencyMs, message: `API Key 不对（${label} 返回 ${listed.status}），请检查后重新填` }, models: [] }
  if (listed.status !== 200) return { check: { ok: false, latencyMs: listed.latencyMs, message: `连不上 ${label}：GET /models 返回 HTTP ${listed.status}` }, models: [] }
  const models = nativeCatalog(kind, listed.models, reference)
  const unpriced = models.filter((model) => model.priceIn === 0 && model.priceOut === 0).length
  const note = !reference
    ? "OpenRouter 的公开价格目录没连上，价格都是「未知」：花费按 0 算，花费上限管不住。稍后点「刷新模型列表」再查"
    : unpriced
      ? `${unpriced} 个模型在 OpenRouter 的公开目录里查不到价格，显示「未知」：用它们时花费按 0 算，花费上限管不住`
      : undefined
  return { check: { ok: true, latencyMs: listed.latencyMs, models: models.length, message: `连上了，读到 ${models.length} 个能调工具的模型`, note }, models }
}

/**
 * 连一次服务：拿到模型目录；OpenRouter 有 key 时再核对一次 key（GET /key，不花钱）；直连厂商列模型本身就要 key。
 * embeddingsKnown = 这次读到了 embedding 模型目录（OpenRouter 才有；Ollama 的 embedding 不支持图片，不读）
 */
export async function probeProvider(
  kind: ModelProviderKind,
  baseUrl: string,
  apiKey?: string,
  verifyKey = true
): Promise<{ check: ProviderCheck; models: CatalogModel[]; embeddingsKnown?: boolean }> {
  const base = trimUrl(baseUrl)
  try {
    if (isNative(kind)) return await probeNative(kind, base, apiKey)
    if (kind === "openrouter") {
      const list = await getJson(`${base}/models`)
      if (!list.ok) return { check: { ok: false, message: `连不上 OpenRouter：GET /models 返回 HTTP ${list.status}` }, models: [] }
      const models = parseOpenRouterModels(list.body)
      if (apiKey && verifyKey) {
        const key = await getJson(`${base}/key`, { authorization: `Bearer ${apiKey}` })
        if (key.status === 401 || key.status === 403) return { check: { ok: false, latencyMs: list.latencyMs, message: "API Key 不对（OpenRouter 返回 401），请检查后重新填" }, models: [] }
        if (!key.ok) return { check: { ok: false, latencyMs: list.latencyMs, message: `核对 API Key 失败：HTTP ${key.status}` }, models: [] }
      }
      const embeddings = await openRouterEmbeddingModels(base)
      const embeddingText = embeddings ? `、${embeddings.length} 个 embedding 模型` : "（embedding 模型列表没读到，先保留原来的）"
      return {
        check: { ok: true, latencyMs: list.latencyMs, models: models.length, message: `连上了，读到 ${models.length} 个能调工具的模型${embeddingText}` },
        models: [...models, ...(embeddings ?? [])],
        embeddingsKnown: Boolean(embeddings),
      }
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

/**
 * 把模型目录写进 models 表：新的加上，旧的更新，没了的删掉（默认设置还在用的先留着，免得默认设置断掉）。
 * embeddingsKnown 为 false 时这次没读到 embedding 模型目录，已有的 embedding 模型不动
 */
async function writeModels(tx: DbOrTx, providerId: string, models: CatalogModel[], embeddingsKnown = true) {
  const seen = new Set<string>()
  const rows = models
    .map((model, position) => ({
      id: `${providerId}/${model.name}`,
      providerId,
      name: model.displayName,
      note: model.note,
      contextK: model.contextK,
      priceIn: model.priceIn,
      priceOut: model.priceOut,
      vision: model.vision,
      kind: model.kind,
      position,
    }))
    // 聊天模型和 embedding 模型同名时留聊天模型（聊天模型排在前面）
    .filter((row) => !seen.has(row.id) && Boolean(seen.add(row.id)))
  const keep = new Set(rows.map((row) => row.id))
  const defaults = (await tx.select({ modelId: t.modelDefaults.modelId }).from(t.modelDefaults)).map((row) => row.modelId)
  const existing = await tx.select({ id: t.models.id, kind: t.models.kind }).from(t.models).where(eq(t.models.providerId, providerId))
  const stale = existing
    .filter((row) => embeddingsKnown || row.kind !== "embedding")
    .map((row) => row.id)
    .filter((id) => !keep.has(id) && !defaults.includes(id))
  if (stale.length) await tx.delete(t.models).where(inArray(t.models.id, stale))
  for (let i = 0; i < rows.length; i += 200) {
    const chunk = rows.slice(i, i + 200)
    await tx
      .insert(t.models)
      .values(chunk)
      .onConflictDoUpdate({
        target: t.models.id,
        set: {
          name: sqlExcluded("name"),
          note: sqlExcluded("note"),
          contextK: sqlExcluded("context_k"),
          priceIn: sqlExcluded("price_in"),
          priceOut: sqlExcluded("price_out"),
          vision: sqlExcluded("vision"),
          kind: sqlExcluded("kind"),
          position: sqlExcluded("position"),
        },
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
  if (providerNeedsKey(input.kind) && !input.apiKey) throw badRequest(`填 ${providerKindLabel[input.kind]} 的 API Key`)
  const { check, models, embeddingsKnown } = await probeProvider(input.kind, input.baseUrl, input.apiKey, options.verifyKey ?? true)
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
    await writeModels(tx, id, models, embeddingsKnown)
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
  if (providerNeedsKey(before.kind) && !apiKey) throw badRequest(`填 ${providerKindLabel[before.kind]} 的 API Key`)
  const { check, models, embeddingsKnown } = await probeProvider(before.kind, input.baseUrl, apiKey)
  if (!check.ok) throw badRequest(check.message)
  await ctx.db.transaction(async (tx) => {
    let apiKeySecretId = before.apiKeySecretId
    if (input.apiKey) apiKeySecretId = await putSecret(tx, ctx.keyring(), { scope: "model_provider", refId: input.id, name: "api_key" }, input.apiKey, ctx.actor.id, 9)
    await tx
      .update(t.modelProviders)
      .set({ name: input.name || before.name, baseUrl: trimUrl(input.baseUrl), apiKeySecretId, status: "ok", checkedAt: new Date(), latencyMs: check.latencyMs ?? null })
      .where(eq(t.modelProviders.id, input.id))
    await writeModels(tx, input.id, models, embeddingsKnown)
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
export async function refreshProvider(db: Db, keyring: Keyring, actorId: string | null, id: string): Promise<ProviderCheck> {
  const before = await loadProvider(db, id)
  if (!before.baseUrl) return { ok: false, message: "还没填地址：先编辑这个服务" }
  // OpenRouter 刷新列表只用公开接口，不带 key；直连厂商列模型要 key
  const apiKey = before.kind === "openrouter" ? undefined : await providerKey(db, keyring, before.apiKeySecretId)
  const { check, models, embeddingsKnown } = await probeProvider(before.kind, before.baseUrl, apiKey)
  await db.transaction(async (tx) => {
    await tx.update(t.modelProviders).set({ status: check.ok ? "ok" : "error", checkedAt: new Date(), latencyMs: check.latencyMs ?? null }).where(eq(t.modelProviders.id, id))
    if (check.ok) await writeModels(tx, id, models, embeddingsKnown)
    await audit(tx, actorId, "model_provider.refresh", "model_providers", id, { ok: check.ok, models: models.length })
  })
  return check
}

export async function refreshProviderAsActor(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能刷新模型列表")
  return refreshProvider(ctx.db, ctx.keyring(), ctx.actor.id, input.id)
}

/**
 * 删除模型服务：有任务在用它的模型就不能删；默认设置里用到的换成别家的。
 * 图库的 embedding 模型换成别的服务里能处理图片的 embedding 模型，没有就空着（图库暂时不能以图搜图）
 */
export async function deleteProvider(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能删模型服务")
  const result = await ctx.db.transaction(async (tx) => {
    const before = await loadProvider(tx, input.id)
    const modelCols = { id: t.models.id, name: t.models.name, note: t.models.note, contextK: t.models.contextK, priceIn: t.models.priceIn, priceOut: t.models.priceOut, kind: t.models.kind, vision: t.models.vision }
    const own = await tx.select(modelCols).from(t.models).where(eq(t.models.providerId, input.id))
    const ownIds = own.map((row) => row.id)
    const used = ownIds.length ? await tx.select({ id: t.tasks.id, title: t.tasks.title }).from(t.tasks).where(inArray(t.tasks.modelId, ownIds)) : []
    if (used.length) throw conflict(`有 ${used.length} 个任务在用「${before.name}」的模型：${usedByText(used)}。先给这些任务换模型，再删除。`)
    const current = await readDefaults(tx)
    const rest = await tx.select(modelCols).from(t.models).where(ownIds.length ? notInArray(t.models.id, ownIds) : undefined)
    const chat = (rows: typeof own) => rows.filter((row) => row.kind === "chat")
    const next: ModelDefaults = defaultsAfterRemove(current, { models: chat(own) }, [{ models: chat(rest) }])
    const embed = current.embed && ownIds.includes(current.embed) ? rest.find((row) => row.kind === "embedding" && row.vision)?.id : current.embed
    if (embed) next.embed = embed
    // 助手的默认模型是可选的：在删掉的服务里就不配了，助手回到 plan 默认模型
    if (current.assistant && !ownIds.includes(current.assistant)) next.assistant = current.assistant
    await tx.delete(t.modelDefaults)
    for (const role of ["run", "plan", "verify", "embed", "assistant"] as const) {
      const modelId = next[role]
      if (modelId && !ownIds.includes(modelId)) await tx.insert(t.modelDefaults).values({ role, modelId, updatedById: ctx.actor.id })
    }
    await tx.delete(t.modelProviders).where(eq(t.modelProviders.id, input.id))
    await deleteSecret(tx, { scope: "model_provider", refId: input.id, name: "api_key" })
    await audit(tx, ctx.actor.id, "model_provider.delete", "model_providers", input.id, { name: before.name, defaults: next })
    return { id: input.id, defaults: next, embedChanged: next.embed !== current.embed }
  })
  if (result.embedChanged) kickGalleryEmbeddings()
  return { id: result.id, defaults: result.defaults }
}

async function readDefaults(db: DbOrTx): Promise<ModelDefaults> {
  const rows = await db.select().from(t.modelDefaults)
  const of = (role: ModelRole) => rows.find((row) => row.role === role)?.modelId ?? ""
  const embed = of("embed")
  const assistant = of("assistant")
  return { run: of("run"), plan: of("plan"), verify: of("verify"), ...(embed ? { embed } : {}), ...(assistant ? { assistant } : {}) }
}

/**
 * 默认模型。执行 / 规划 / 验收要是聊天模型，验收不许和执行同一家（不算第三方）。
 * embed（图库的 embedding 模型）：不传不改，空字符串表示不用；要是能处理图片的 embedding 模型。
 * assistant（右下角助手）：不传不改，空字符串表示不单独配（助手用 plan）；要是聊天模型
 */
export async function writeDefaults(db: DbOrTx, actorId: string | null, input: ModelDefaults) {
  if (sameFamily(input.run, input.verify)) {
    throw badRequest(`执行和三方验收是同一家（${modelFamily(input.run)}），验收就不算第三方了。请给验收换一家。`)
  }
  const ids = [...new Set([input.run, input.plan, input.verify])]
  const found = await db.select({ id: t.models.id, kind: t.models.kind }).from(t.models).where(inArray(t.models.id, ids))
  const missing = ids.filter((id) => !found.some((row) => row.id === id))
  if (missing.length) throw badRequest(`模型不存在：${missing.join("、")}`)
  const notChat = found.filter((row) => row.kind !== "chat").map((row) => row.id)
  if (notChat.length) throw badRequest(`${notChat.join("、")} 是 embedding 模型，不能用来执行、规划或验收`)
  if (input.embed) {
    const [embed] = await db.select({ kind: t.models.kind, vision: t.models.vision }).from(t.models).where(eq(t.models.id, input.embed))
    if (!embed) throw badRequest(`模型不存在：${input.embed}`)
    if (embed.kind !== "embedding" || !embed.vision) throw badRequest(`${input.embed} 不是能处理图片的 embedding 模型，图库用不了`)
  }
  if (input.assistant) {
    const [assistant] = await db.select({ kind: t.models.kind }).from(t.models).where(eq(t.models.id, input.assistant))
    if (!assistant) throw badRequest(`模型不存在：${input.assistant}`)
    if (assistant.kind !== "chat") throw badRequest(`${input.assistant} 是 embedding 模型，助手用不了`)
  }
  const roles: ModelRole[] = ["run", "plan", "verify"]
  if (input.embed) roles.push("embed")
  if (input.assistant) roles.push("assistant")
  for (const role of roles) {
    const modelId = input[role]!
    await db
      .insert(t.modelDefaults)
      .values({ role, modelId, updatedById: actorId })
      .onConflictDoUpdate({ target: t.modelDefaults.role, set: { modelId, updatedById: actorId, updatedAt: new Date() } })
  }
  if (input.embed === "") await db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "embed"))
  if (input.assistant === "") await db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "assistant"))
}

export async function setModelDefaults(ctx: WriteCtx, input: ModelDefaults) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能改默认模型")
  const { after, embedChanged } = await ctx.db.transaction(async (tx) => {
    const before = await readDefaults(tx)
    await writeDefaults(tx, ctx.actor.id, input)
    const after = await readDefaults(tx)
    await audit(tx, ctx.actor.id, "model_defaults.update", "model_defaults", "defaults", { before, after })
    return { after, embedChanged: before.embed !== after.embed }
  })
  // 换了图库的 embedding 模型：后台用新模型把所有图重算一遍（重算完之前搜索还用旧模型的向量）
  if (embedChanged) kickGalleryEmbeddings()
  return after
}


// ---------- 视觉模型（比物、浏览器共用） ----------

/** 能看图的模型：库里 vision = true 的聊天模型，便宜的在前 */
export async function listVisionModels(db: DbOrTx): Promise<CompareModel[]> {
  const rows = await db
    .select({ id: t.models.id, name: t.models.name, priceIn: t.models.priceIn, priceOut: t.models.priceOut })
    .from(t.models)
    .where(and(eq(t.models.vision, true), eq(t.models.kind, "chat")))
    .orderBy(asc(t.models.priceIn), asc(t.models.priceOut), asc(t.models.id))
  // 「:batch」是批处理线路，聊天接口用不了（实测报错）
  return rows.filter((row) => !row.id.endsWith(":batch"))
}

/** 不是库里能看图的聊天模型时返回原因（给人看的），是就返回 undefined。use：哪里要用，例如「比物」 */
export async function visionModelProblem(db: DbOrTx, modelId: string, use: string): Promise<string | undefined> {
  const [model] = await db.select({ name: t.models.name, vision: t.models.vision, kind: t.models.kind }).from(t.models).where(eq(t.models.id, modelId))
  if (!model) return `模型 ${modelId} 不在模型列表里（模型服务刷新后可能没了）：换一个能看图的模型`
  if (model.kind !== "chat" || !model.vision || modelId.endsWith(":batch")) return `${model.name}（${modelId}）不能看图：${use}要用能看图的聊天模型`
  return undefined
}
