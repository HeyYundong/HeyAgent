// 模型层：一层很薄的接口包住 AI SDK 7 的各家 provider，换线路或直连厂商只改这里。
// - 线路：OpenRouter；直连 Anthropic（Messages API）、OpenAI（Responses API）、DeepSeek；自定义服务（任何 OpenAI 兼容的 /chat/completions）；
// - key 从 model_providers.api_key_secret_id 指向的 secrets 解密（包 P2 的模型页写入）；自定义服务可以没有 key；
// - 每次调用记下 token 和花费（OpenRouter 返回的 usage.cost；直连厂商不返回，按模型单价估，缓存命中按折扣算）；
// - Anthropic 的模型开 prompt caching（OpenRouter 和直连都用顶层 cache_control）；
// - 不传 temperature、top_p；
// - Ollama 先不接：provider 种类保留，调用时报「未配置」。
import { createAnthropic, type AnthropicLanguageModelOptions } from "@ai-sdk/anthropic"
import { createDeepSeek } from "@ai-sdk/deepseek"
import { createOpenAI } from "@ai-sdk/openai"
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import { createOpenRouter } from "@openrouter/ai-sdk-provider"
import {
  APICallError,
  generateText,
  NoObjectGeneratedError,
  Output,
  zodSchema,
  type LanguageModel,
  type LanguageModelUsage,
  type ModelMessage,
  type ToolSet,
} from "ai"
import type { z } from "zod"
import { eq } from "drizzle-orm"
import {
  ANTHROPIC_DEFAULT_URL,
  DEEPSEEK_DEFAULT_URL,
  OPENAI_DEFAULT_URL,
  type ModelProviderKind,
} from "@heyagent/shared"

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
  /** 哪种服务（决定每次调用带什么选项、缓存怎么算钱）；测试的假模型没有 */
  kind?: ModelProviderKind
  /** 每百万 token 的价格（美元），没返回花费时（直连厂商）用来估算 */
  priceIn: number
  priceOut: number
  vision: boolean
  /** 上下文多长（千 token，models.context_k）；0 或没有 = 不知道（Ollama、公开目录里查不到的模型） */
  contextK?: number
  /**
   * 结构化输出时请求里带不上 JSON Schema（自定义服务没开「支持 json_schema」：只发 json_object，schema 被丢掉），
   * callStructured 要把格式写进提示词，不然模型不知道字段名、枚举值，只能猜
   */
  schemaInPrompt?: boolean
}

type ProviderOptions = Parameters<typeof generateText>[0]["providerOptions"]

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
      contextK: info?.contextK ?? 0,
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
  if (provider.status === "unconfigured")
    throw new ModelConfigError(`模型服务「${provider.name}」还没有配置`)
  // 自定义服务的 key 是可选的（自建的 vLLM 等常常没有）
  const keyOptional = provider.kind === "custom"
  if (!provider.apiKeySecretId && !keyOptional)
    throw new ModelConfigError(`模型服务「${provider.name}」还没有配置 API key`)
  const apiKey = provider.apiKeySecretId
    ? await loadSecretById(db, provider.apiKeySecretId)
    : undefined
  if (!apiKey && !keyOptional)
    throw new ModelConfigError(
      `模型服务「${provider.name}」的 API key 找不到了，请在「模型」页重新填写`
    )
  const slug = modelId.startsWith(`${provider.id}/`)
    ? modelId.slice(provider.id.length + 1)
    : modelId
  return {
    model: languageModel(provider.kind, slug, apiKey, provider.baseUrl, { supportsJsonSchema: provider.supportsJsonSchema }),
    modelId,
    kind: provider.kind,
    priceIn: info?.priceIn ?? 0,
    priceOut: info?.priceOut ?? 0,
    vision: info?.vision ?? false,
    contextK: info?.contextK ?? 0,
    schemaInPrompt: schemaInPrompt(provider.kind, provider.supportsJsonSchema),
  }
}

/**
 * 结构化输出时要不要把 JSON Schema 写进提示词（按各家 provider 包实际发出去的请求定）：
 * - OpenRouter、直连 OpenAI：response_format / text.format 是 json_schema；直连 Anthropic：output_config.format 或 JSON 工具，都带 schema；
 * - 直连 DeepSeek：发 json_object，但 @ai-sdk/deepseek 自己把 schema 写进了 system 消息；
 * - 自定义服务（@ai-sdk/openai-compatible）：没开 supportsStructuredOutputs 时只发 json_object、schema 直接丢掉，要我们补上
 */
export function schemaInPrompt(kind: ModelProviderKind, supportsJsonSchema: boolean) {
  return kind === "custom" && !supportsJsonSchema
}

/** apiKey 只有自定义服务可以不给（其余由 resolveModel 先检查过）；supportsJsonSchema 只有自定义服务看 */
export function languageModel(
  kind: Exclude<ModelProviderKind, "ollama">,
  slug: string,
  apiKey: string | undefined,
  baseUrl: string,
  options: { supportsJsonSchema?: boolean } = {}
): LanguageModel {
  switch (kind) {
    case "openrouter": {
      const openrouter = createOpenRouter({
        apiKey,
        baseURL: baseUrl || DEFAULT_OPENROUTER_URL,
        compatibility: "strict",
        appName: "HeyAgent",
      })
      return openrouter.chat(slug, {
        usage: { include: true },
        ...(slug.startsWith("anthropic/")
          ? { cache_control: { type: "ephemeral" as const } }
          : {}),
      })
    }
    case "anthropic":
      return createAnthropic({ apiKey, baseURL: baseUrl || ANTHROPIC_DEFAULT_URL })(slug)
    // 默认就是 Responses API（OpenAI 现在主推的接口，新模型有的只在这里有）
    case "openai":
      return createOpenAI({ apiKey, baseURL: baseUrl || OPENAI_DEFAULT_URL })(slug)
    case "deepseek":
      return createDeepSeek({ apiKey, baseURL: baseUrl || DEEPSEEK_DEFAULT_URL })(slug)
    // 走 /chat/completions（各家兼容得最好的接口）；includeUsage 让流式输出（助手）最后也带回 token 用量，不然算不了钱。
    // 结构化输出：开了「支持 json_schema」就发 response_format: json_schema（服务按 schema 回答）；
    // 默认只发 json_object（json_schema 不少服务不认），schema 由 callStructured 写进提示词，不合 schema 时再抠一次 JSON
    case "custom":
      return createOpenAICompatible({
        name: "custom",
        baseURL: baseUrl,
        apiKey: apiKey || undefined,
        includeUsage: true,
        supportsStructuredOutputs: options.supportsJsonSchema === true,
      }).chatModel(slug)
  }
}

/** 遇到安全分类器拒答时，服务端自动换模型重答：只给文档写明支持的这几代 Claude 带（Haiku 没有服务端兜底） */
const CLAUDE_FALLBACK = /^claude-(fable-5-1|opus-5|sonnet-5-5)/

/** 历史里有没有 Claude 的 thinking 块（直连 Anthropic 时 reasoning 部分带签名） */
function hasClaudeThinking(messages: ModelMessage[]) {
  return messages.some(
    (message) =>
      message.role === "assistant" &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) =>
          part.type === "reasoning" &&
          (part.providerOptions?.anthropic as { signature?: unknown } | undefined)?.signature != null
      )
  )
}

/**
 * 每次调用按服务带的选项：
 * - 直连 Anthropic：顶层 cache_control 自动缓存最长的前文；新一代 Claude 开服务端拒答兜底；
 *   历史里有 thinking 块时设 drop_block：压缩上下文会改写较早的工具输出、继续时系统提示和工具会重新生成，
 *   前文变了，原样回放的 thinking 块在 2026-08-31 以后开的账号上会直接 400，drop_block 让 API 丢掉对不上的块（不计费）接着跑；
 * - 直连 OpenAI：store 设 false，对话不存在 OpenAI 那边，推理内容加密后随消息带回（session 挂起几天再继续也不依赖对方保存的记录）。
 */
export function providerOptionsFor(
  resolved: Pick<ResolvedModel, "kind" | "modelId">,
  messages: ModelMessage[]
): ProviderOptions {
  if (resolved.kind === "anthropic") {
    const slug = resolved.modelId.split("/").slice(1).join("/")
    const anthropic = {
      cacheControl: { type: "ephemeral" },
      ...(CLAUDE_FALLBACK.test(slug) ? { fallbacks: "default" } : {}),
      ...(hasClaudeThinking(messages)
        ? { thinking: { blockBinding: { prefixMismatchBehavior: "drop_block" } } }
        : {}),
    } satisfies AnthropicLanguageModelOptions
    return { anthropic }
  }
  if (resolved.kind === "openai") return { openai: { store: false } }
  return undefined
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
    providerOptions: providerOptionsFor(resolved, input.messages),
    maxRetries: 0,
    abortSignal: input.abortSignal,
  })
  const assistant = result.responseMessages.find(
    (message) => message.role === "assistant"
  ) as ModelMessage | undefined
  const usage = result.usage
  const { tokensIn, tokensOut, costUsd } = costOf(
    resolved,
    usage,
    result.providerMetadata
  )
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

/**
 * 缓存的 token 按输入单价的几倍算（各家公开的价格结构）：Anthropic 读 0.1 倍、写 1.25 倍（5 分钟缓存）；
 * OpenAI、DeepSeek 自动缓存，读约 0.1 倍，写不加价。只是估算：长 session 大部分输入都命中缓存，
 * 按原价算会高估好几倍，提前撞上花费上限。
 * 自定义服务不知道是哪家、有没有缓存折扣：按原价算（宁可高估，单价是人在模型页手动填的）
 */
const CACHE_PRICE: Partial<Record<ModelProviderKind, { read: number; write: number }>> = {
  anthropic: { read: 0.1, write: 1.25 },
  openai: { read: 0.1, write: 1 },
  deepseek: { read: 0.1, write: 1 },
}

export function costOf(
  resolved: Pick<ResolvedModel, "kind" | "priceIn" | "priceOut">,
  usage: LanguageModelUsage | undefined,
  providerMetadata: unknown
) {
  const tokensIn = usage?.inputTokens ?? 0
  const tokensOut = usage?.outputTokens ?? 0
  const metadata = (
    providerMetadata as
      { openrouter?: { usage?: { cost?: number } } } | undefined
  )?.openrouter
  const reported = metadata?.usage?.cost
  if (typeof reported === "number") return { tokensIn, tokensOut, costUsd: reported }
  const cache = (resolved.kind && CACHE_PRICE[resolved.kind]) ?? { read: 1, write: 1 }
  const read = usage?.inputTokenDetails?.cacheReadTokens ?? 0
  const write = usage?.inputTokenDetails?.cacheWriteTokens ?? 0
  const plain = Math.max(0, tokensIn - read - write)
  const input = plain + read * cache.read + write * cache.write
  const costUsd = (input * resolved.priceIn + tokensOut * resolved.priceOut) / 1_000_000
  return { tokensIn, tokensOut, costUsd }
}

/** 从模型的文字里抠出 JSON（有的模型会包一层 ```json``` 或前后加话） */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const body = fenced ? fenced[1]! : text
  const start = body.indexOf("{")
  const end = body.lastIndexOf("}")
  if (start < 0 || end <= start) throw new Error("模型没有返回 JSON")
  return JSON.parse(body.slice(start, end + 1))
}

export interface StructuredResult<T> {
  object: T
  text: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  ms: number
}

/** 结构化输出没通过校验的一处：哪个字段、为什么；枚举值不对时带上允许的取值和模型给的值 */
export interface StructuredIssue {
  path: string
  message: string
  allowed?: string[]
  received?: unknown
}

/**
 * 模型返回了文字、但不是要的格式（抠不出 JSON，或者不合 schema）。带上模型原样返回的文字、哪几处不对和这次的用量（钱已经花了），
 * 调用方可以把原文存下来查原因、再请模型改一次（callStructuredWithFix）
 */
export class StructuredOutputError extends Error {
  readonly text: string
  readonly issues: StructuredIssue[]
  readonly usage: { tokensIn: number; tokensOut: number; costUsd: number }
  constructor(
    message: string,
    text: string,
    issues: StructuredIssue[],
    usage: { tokensIn: number; tokensOut: number; costUsd: number },
    options?: ErrorOptions
  ) {
    super(message, options)
    this.name = "StructuredOutputError"
    this.text = text
    this.issues = issues
    this.usage = usage
  }
}

/** 按 zod 的 path 取 JSON 里的值（看模型给了什么） */
function valueAt(json: unknown, path: readonly PropertyKey[]): unknown {
  let value = json
  for (const key of path) {
    if (value === null || typeof value !== "object") return undefined
    value = (value as Record<PropertyKey, unknown>)[key]
  }
  return value
}

/**
 * 请求里带不上 schema 时接在系统提示后面的格式要求。$schema 那一行对模型没用，去掉省 token
 */
export function schemaDirective(jsonSchema: object) {
  const rest: Record<string, unknown> = { ...jsonSchema }
  delete rest.$schema
  return [
    "## 回答格式",
    "只回答一个 JSON 对象，符合下面的 JSON Schema：必填（required）的字段都要有，字段名照抄，枚举（enum）只能用列出的值之一，类型要对（数字不要写成字符串）。",
    "不要用 Markdown，不要用 ``` 代码块包起来，JSON 前后不要加任何别的文字。",
    JSON.stringify(rest),
  ].join("\n")
}

/**
 * 结构化输出（比物、规则翻译、复核、三方验收、压缩摘要用）：ai 7 里 generateObject 已标记废弃，用 generateText + output: Output.object。
 * resolved.schemaInPrompt 时（请求里带不上 schema）把 JSON Schema 接在系统提示后面。
 * 模型返回的 JSON 不合 schema 时抛 NoObjectGeneratedError；这里再按文字抠一次 JSON 用 zod 校验，还不行才抛错。
 * 花费照样算（失败时也尽量从错误里拿到 usage）。
 */
export async function callStructured<T>(
  resolved: ResolvedModel,
  input: {
    system: string
    messages: ModelMessage[]
    schema: z.ZodType<T>
    name: string
    abortSignal?: AbortSignal
  }
): Promise<StructuredResult<T>> {
  const started = Date.now()
  const schema = zodSchema(input.schema)
  const instructions = resolved.schemaInPrompt
    ? `${input.system}\n\n${schemaDirective(await schema.jsonSchema)}`
    : input.system
  try {
    const result = await generateText({
      model: resolved.model,
      instructions,
      messages: input.messages,
      output: Output.object({ schema, name: input.name }),
      providerOptions: providerOptionsFor(resolved, input.messages),
      maxRetries: 1,
      abortSignal: input.abortSignal,
    })
    const cost = costOf(resolved, result.usage, result.providerMetadata)
    return {
      object: result.output as T,
      text: result.text,
      ...cost,
      ms: Date.now() - started,
    }
  } catch (error) {
    if (!NoObjectGeneratedError.isInstance(error) || !error.text) throw error
    const cost = costOf(resolved, error.usage, undefined)
    const usage = { tokensIn: cost.tokensIn, tokensOut: cost.tokensOut, costUsd: cost.costUsd }
    let json: unknown
    try {
      json = extractJson(error.text)
    } catch (parseError) {
      throw new StructuredOutputError(`模型返回的结果格式不对：${(parseError as Error).message}`, error.text, [{ path: "", message: "没有返回能解析的 JSON" }], usage, { cause: error })
    }
    const parsed = input.schema.safeParse(json)
    if (!parsed.success) {
      const issues = parsed.error.issues.slice(0, 5).map((issue): StructuredIssue => {
        const path = issue.path.map(String).join(".")
        const allowed = issue.code === "invalid_value" ? issue.values.map(String) : undefined
        return { path, message: issue.message, ...(allowed ? { allowed, received: valueAt(json, issue.path) } : {}) }
      })
      throw new StructuredOutputError(
        `模型返回的结果格式不对：${issues
          .slice(0, 3)
          .map((issue) => `${issue.path} ${issue.message}`)
          .join("；")}`,
        error.text,
        issues,
        usage,
        { cause: error }
      )
    }
    return {
      object: parsed.data,
      text: error.text,
      ...cost,
      ms: Date.now() - started,
    }
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
