// 模型层：一层很薄的接口包住 AI SDK 7 + OpenRouter provider，以后换线路或直连厂商只改这里。
// - key 从 model_providers.api_key_secret_id 指向的 secrets 解密（包 P2 的模型页写入）；
// - 每次调用记下 token 和花费（OpenRouter 返回的 usage.cost；没有就按模型单价估）；
// - Anthropic 的模型开 prompt caching（OpenRouter 的顶层 cache_control）；
// - 不传 temperature、top_p；
// - Ollama 先不接：provider 种类保留，调用时报「未配置」。
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import {
  APICallError,
  generateText,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai"
import { eq } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { runtime } from "./runtime.js"
import { loadSecretById } from "./secrets.js"

const DEFAULT_OPENROUTER_URL = "https://openrouter.ai/api/v1"

/** 模型没配好（不会因为重试变好），直接让 session 失败并写清原因 */
export class ModelConfigError extends Error {}

export interface ResolvedModel {
  model: LanguageModel
  modelId: string
  /** 每百万 token 的价格（美元），OpenRouter 没返回花费时用来估算 */
  priceIn: number
  priceOut: number
  vision: boolean
}

export async function resolveModel(
  db: Db,
  modelId: string
): Promise<ResolvedModel> {
  const [info] = await db
    .select()
    .from(t.models)
    .where(eq(t.models.id, modelId))
  if (runtime.modelFactory) {
    return {
      model: await runtime.modelFactory({ modelId }),
      modelId,
      priceIn: info?.priceIn ?? 0,
      priceOut: info?.priceOut ?? 0,
      vision: info?.vision ?? true,
    }
  }
  const providerId = info?.providerId ?? modelId.split("/")[0] ?? ""
  const [provider] = await db
    .select()
    .from(t.modelProviders)
    .where(eq(t.modelProviders.id, providerId))
  if (!provider)
    throw new ModelConfigError(
      `模型 ${modelId} 没有对应的模型服务，请在「模型」页检查，或给任务换一个模型`
    )
  if (provider.kind === "ollama")
    throw new ModelConfigError(
      `模型服务「${provider.name}」（Ollama）还没有配置，暂时不能用`
    )
  if (provider.status === "unconfigured" || !provider.apiKeySecretId)
    throw new ModelConfigError(`模型服务「${provider.name}」还没有配置 API key`)
  const apiKey = await loadSecretById(db, provider.apiKeySecretId)
  if (!apiKey)
    throw new ModelConfigError(
      `模型服务「${provider.name}」的 API key 找不到了，请在「模型」页重新填写`
    )
  const slug = modelId.startsWith(`${provider.id}/`)
    ? modelId.slice(provider.id.length + 1)
    : modelId
  const openrouter = createOpenRouter({
    apiKey,
    baseURL: provider.baseUrl || DEFAULT_OPENROUTER_URL,
    compatibility: "strict",
    appName: "HeyAgent",
  })
  const model = openrouter.chat(slug, {
    usage: { include: true },
    ...(slug.startsWith("anthropic/")
      ? { cache_control: { type: "ephemeral" as const } }
      : {}),
  })
  return {
    model,
    modelId,
    priceIn: info?.priceIn ?? 0,
    priceOut: info?.priceOut ?? 0,
    vision: info?.vision ?? false,
  }
}

export interface ModelCallInput {
  system: string
  messages: ModelMessage[]
  tools: ToolSet
  abortSignal?: AbortSignal
}

export interface ModelCallResult {
  /** 模型这一步的回复（只留 assistant 消息，工具结果由工具网关补） */
  assistant: ModelMessage | undefined
  toolCalls: {
    toolCallId: string
    toolName: string
    input: unknown
    invalid?: boolean
    error?: string
  }[]
  text: string
  finishReason: string
  tokensIn: number
  tokensOut: number
  cachedTokens: number
  costUsd: number
  ms: number
}

/** 调一次模型（一步）。工具定义不带 execute，模型提出调用后由工具网关处理 */
export async function callModel(
  resolved: ResolvedModel,
  input: ModelCallInput
): Promise<ModelCallResult> {
  const started = Date.now()
  const result = await generateText({
    model: resolved.model,
    instructions: input.system,
    messages: input.messages,
    tools: input.tools,
    maxRetries: 0,
    abortSignal: input.abortSignal,
  })
  const assistant = result.responseMessages.find(
    (message) => message.role === "assistant"
  ) as ModelMessage | undefined
  const usage = result.usage
  const tokensIn = usage.inputTokens ?? 0
  const tokensOut = usage.outputTokens ?? 0
  const metadata = result.providerMetadata?.openrouter as
    { usage?: { cost?: number } } | undefined
  const reported = metadata?.usage?.cost
  const costUsd =
    typeof reported === "number"
      ? reported
      : (tokensIn * resolved.priceIn + tokensOut * resolved.priceOut) /
        1_000_000
  return {
    assistant,
    toolCalls: result.toolCalls.map((call) => {
      const invalid = (call as { invalid?: boolean }).invalid
      const error = (call as { error?: unknown }).error
      return {
        toolCallId: call.toolCallId,
        toolName: call.toolName,
        input: call.input,
        invalid,
        error: invalid ? errorText(error) : undefined,
      }
    }),
    text: result.text,
    finishReason: result.finishReason,
    tokensIn,
    tokensOut,
    cachedTokens: usage.inputTokenDetails?.cacheReadTokens ?? 0,
    costUsd,
    ms: Date.now() - started,
  }
}

function errorText(error: unknown) {
  if (!error) return "参数不对"
  if (error instanceof Error) return error.message
  const named = error as { name?: string; message?: string }
  return named.message ?? named.name ?? String(error)
}

/** 值不值得重试：配置错、请求本身不对（4xx，429 除外）不重试 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof ModelConfigError) return false
  if (APICallError.isInstance(error)) {
    const status = error.statusCode ?? 0
    if (status === 429 || status >= 500 || status === 0) return true
    if (status === 401 || status === 402 || status === 403) return false
    return error.isRetryable
  }
  if ((error as Error)?.name === "AbortError") return false
  return true
}
