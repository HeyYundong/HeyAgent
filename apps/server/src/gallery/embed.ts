// 图库的 embedding：把图片、一句描述变成 1024 维的向量（模型是模型页「默认设置」里选的 embedding 模型）。
// 走 OpenRouter 的 POST /embeddings：input 是 [{ content: [{ type: "image_url" | "text", ... }] }]，一次可以算多个，dimensions 固定 1024。
// 测试不调真模型：configureEngine({ embedFactory }) 给假向量。
import { GALLERY_EMBED_DIMENSIONS } from "@heyagent/shared"
import { eq } from "drizzle-orm"

import * as t from "../db/schema.js"
import type { DbLike } from "../engine/records.js"
import { runtime } from "../engine/runtime.js"
import { loadSecretById } from "../engine/secrets.js"
import { GalleryError } from "./errors.js"

const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1"
const TIMEOUT_MS = 60_000

/** 一个输入：图片（已经转成 JPEG，见 images.ts 的 modelInputImage）或者一句话 */
export type EmbedInput = { image: Buffer } | { text: string }

export interface EmbedModel {
  id: string
  name: string
}

/** 当前默认的 embedding 模型；没配时返回 undefined（以图搜图、按描述找都用不了，传图照样能传） */
export async function currentEmbedModel(db: DbLike): Promise<EmbedModel | undefined> {
  const [row] = await db
    .select({ id: t.models.id, name: t.models.name })
    .from(t.modelDefaults)
    .innerJoin(t.models, eq(t.models.id, t.modelDefaults.modelId))
    .where(eq(t.modelDefaults.role, "embed"))
  return row
}

export async function requireEmbedModel(db: DbLike): Promise<EmbedModel> {
  const model = await currentEmbedModel(db)
  if (!model) throw new GalleryError("unavailable", "还没设图库的 embedding 模型：到「模型」页的「默认设置」里选一个能处理图片的 embedding 模型")
  return model
}

/** pgvector 的文本格式：[0.1,0.2,…] */
export const vectorLiteral = (vector: number[]) => `[${vector.join(",")}]`

export function cosine(a: number[], b: number[]) {
  let dot = 0
  let na = 0
  let nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!
    na += a[i]! * a[i]!
    nb += b[i]! * b[i]!
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0
}

interface EmbeddingResponse {
  data?: { index?: number; embedding?: number[] }[]
  error?: { message?: string }
}

/** 一批输入算向量，顺序和输入一致 */
export async function embed(db: DbLike, modelId: string, inputs: EmbedInput[]): Promise<number[][]> {
  if (inputs.length === 0) return []
  const vectors = runtime.embedFactory ? await runtime.embedFactory({ modelId, inputs }) : await callOpenRouter(db, modelId, inputs)
  if (vectors.length !== inputs.length) throw new GalleryError("upstream", `embedding 模型返回了 ${vectors.length} 个向量，应该是 ${inputs.length} 个`)
  for (const vector of vectors) {
    if (vector.length !== GALLERY_EMBED_DIMENSIONS)
      throw new GalleryError("upstream", `${modelId} 返回的向量是 ${vector.length} 维，图库要 ${GALLERY_EMBED_DIMENSIONS} 维（这个模型可能不支持 dimensions 参数），请在「模型」页换一个`)
  }
  return vectors
}

async function callOpenRouter(db: DbLike, modelId: string, inputs: EmbedInput[]): Promise<number[][]> {
  const [model] = await db.select({ providerId: t.models.providerId }).from(t.models).where(eq(t.models.id, modelId))
  const [provider] = model ? await db.select().from(t.modelProviders).where(eq(t.modelProviders.id, model.providerId)) : []
  if (!provider) throw new GalleryError("unavailable", `模型 ${modelId} 没有对应的模型服务，请在「模型」页检查图库的 embedding 模型`)
  if (provider.kind !== "openrouter") throw new GalleryError("unavailable", `模型服务「${provider.name}」不能算图片的向量，请换成 OpenRouter 上的 embedding 模型`)
  const apiKey = provider.apiKeySecretId ? await loadSecretById(db, provider.apiKeySecretId) : undefined
  if (!apiKey) throw new GalleryError("unavailable", `模型服务「${provider.name}」还没有配置 API key`)
  const slug = modelId.startsWith(`${provider.id}/`) ? modelId.slice(provider.id.length + 1) : modelId
  const body = {
    model: slug,
    input: inputs.map((input) => ({
      content: [
        "image" in input
          ? { type: "image_url", image_url: { url: `data:image/jpeg;base64,${input.image.toString("base64")}` } }
          : { type: "text", text: input.text },
      ],
    })),
    dimensions: GALLERY_EMBED_DIMENSIONS,
    encoding_format: "float",
  }
  const url = `${(provider.baseUrl || DEFAULT_OPENROUTER_URL).replace(/\/+$/, "")}/embeddings`
  let lastError = ""
  // 限流和 5xx 重试一次；其余的错（key 不对、模型不支持）直接报
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, runtime.modelRetryBaseMs))
    let response: Response
    try {
      response = await fetch(url, {
        method: "POST",
        headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "x-title": "HeyAgent" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (error) {
      lastError = error instanceof Error && error.name === "TimeoutError" ? `${TIMEOUT_MS / 1000} 秒没响应` : `连不上：${(error as Error).message}`
      continue
    }
    const parsed = (await response.json().catch(() => ({}))) as EmbeddingResponse
    if (response.ok && Array.isArray(parsed.data)) {
      return [...parsed.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0)).map((row) => row.embedding ?? [])
    }
    lastError = `HTTP ${response.status}${parsed.error?.message ? `：${parsed.error.message}` : ""}`
    if (response.status !== 429 && response.status < 500) break
  }
  throw new GalleryError("upstream", `调 embedding 模型（${slug}）失败：${lastError}`)
}
