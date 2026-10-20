// 直连厂商的模型层（不连库、不连外网）：用假的 fetch 看真正发出去的请求长什么样、回来的用量怎么算钱，
// 以及厂商列出的模型怎么到 OpenRouter 公开目录里查价格。
import { tool, type ModelMessage } from "ai"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"

import { customCatalog, nativeCatalog, type NativeModel } from "../src/data/config/models.js"
import { callModel, callStructured, costOf, languageModel, type ResolvedModel } from "../src/engine/model.js"

const tools = { web_open: tool({ description: "打开网页", inputSchema: z.object({ url: z.string() }) }) }

interface Sent {
  url: string
  headers: Headers
  body: Record<string, unknown>
}

/** 记下发出去的请求，回一个写好的响应 */
function fakeApi(reply: unknown) {
  const sent: Sent[] = []
  vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) as Record<string, unknown> })
    return Response.json(reply)
  })
  return sent
}

afterEach(() => {
  vi.unstubAllGlobals()
})

function resolved(kind: "anthropic" | "openai" | "deepseek", slug: string, baseUrl: string, priceIn: number, priceOut: number): ResolvedModel {
  return { model: languageModel(kind, slug, `key-${kind}`, baseUrl), modelId: `${kind}/${slug}`, kind, priceIn, priceOut, vision: true }
}

/** 上一步模型想过（thinking 块带签名）、调了工具，工具结果已经回来 */
const HISTORY_WITH_THINKING: ModelMessage[] = [
  { role: "user", content: "打开 a.example 看看" },
  {
    role: "assistant",
    content: [
      { type: "reasoning", text: "", providerOptions: { anthropic: { signature: "sig-1" } } },
      { type: "tool-call", toolCallId: "toolu_0", toolName: "web_open", input: { url: "https://a.example" } },
    ],
  },
  { role: "tool", content: [{ type: "tool-result", toolCallId: "toolu_0", toolName: "web_open", output: { type: "text", value: "页面内容" } }] },
]

const CLAUDE_TOOL_REPLY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "claude-opus-5-5",
  content: [
    { type: "thinking", thinking: "", signature: "sig-2" },
    { type: "tool_use", id: "toolu_1", name: "web_open", input: { url: "https://b.example" } },
  ],
  stop_reason: "tool_use",
  stop_sequence: null,
  usage: { input_tokens: 100, cache_creation_input_tokens: 1000, cache_read_input_tokens: 9000, output_tokens: 50 },
}

describe("直连 Anthropic", () => {
  it("第一步：顶层 cache_control 自动缓存，新一代 Claude 带拒答兜底；还没有 thinking 块时不碰 thinking", async () => {
    const sent = fakeApi(CLAUDE_TOOL_REPLY)
    const model = resolved("anthropic", "claude-opus-5-5", "https://claude.example/v1", 4, 20)
    const result = await callModel(model, { system: "你是 agent", messages: [{ role: "user", content: "打开 b.example" }], tools })
    expect(sent).toHaveLength(1)
    const [request] = sent
    expect(request!.url).toBe("https://claude.example/v1/messages")
    expect(request!.headers.get("x-api-key")).toBe("key-anthropic")
    expect(request!.body).toMatchObject({ model: "claude-opus-5-5", cache_control: { type: "ephemeral" }, fallbacks: "default" })
    expect(request!.body.thinking).toBeUndefined()
    // 只能是 auto：Opus 5.5 等强制调工具（any / tool）会 400
    const toolChoice = request!.body.tool_choice as { type?: string } | undefined
    expect(toolChoice?.type ?? "auto").toBe("auto")
    // 拿到工具调用；thinking 块带着签名留在 assistant 消息里，下一步原样带回
    expect(result.toolCalls).toEqual([{ toolCallId: "toolu_1", toolName: "web_open", input: { url: "https://b.example" }, invalid: undefined, error: undefined }])
    const parts = result.assistant?.content as { type: string; providerOptions?: { anthropic?: { signature?: string } } }[]
    expect(parts.find((part) => part.type === "reasoning")?.providerOptions?.anthropic?.signature).toBe("sig-2")
  })

  it("历史里有 thinking 块：原样带回，并设 drop_block（压缩、继续改了前文也不会 400）", async () => {
    const sent = fakeApi(CLAUDE_TOOL_REPLY)
    await callModel(resolved("anthropic", "claude-opus-5-5", "https://claude.example/v1", 4, 20), { system: "你是 agent", messages: HISTORY_WITH_THINKING, tools })
    const body = sent[0]!.body as { thinking?: unknown; messages: { role: string; content: { type: string; signature?: string }[] }[] }
    expect(body.thinking).toEqual({ block_binding: { prefix_mismatch_behavior: "drop_block" } })
    expect(sent[0]!.headers.get("anthropic-beta")).toContain("thinking-binding-controls-2026-08-01")
    expect(body.messages[1]!.content[0]).toMatchObject({ type: "thinking", signature: "sig-1" })
  })

  it("Haiku 等不支持服务端兜底的模型不带 fallbacks", async () => {
    const sent = fakeApi({ ...CLAUDE_TOOL_REPLY, model: "claude-haiku-5-5" })
    await callModel(resolved("anthropic", "claude-haiku-5-5", "https://claude.example/v1", 0.1, 0.5), { system: "s", messages: [{ role: "user", content: "x" }], tools })
    expect(sent[0]!.body.fallbacks).toBeUndefined()
    expect(sent[0]!.body.cache_control).toEqual({ type: "ephemeral" })
  })

  it("花费按缓存折扣估：读 0.1 倍、写 1.25 倍", async () => {
    fakeApi(CLAUDE_TOOL_REPLY)
    const result = await callModel(resolved("anthropic", "claude-opus-5-5", "https://claude.example/v1", 4, 20), { system: "s", messages: [{ role: "user", content: "x" }], tools })
    expect(result.tokensIn).toBe(10_100)
    expect(result.cachedTokens).toBe(9000)
    // (100 + 9000×0.1 + 1000×1.25) × 4 + 50 × 20 = 10000 → 0.01 美元
    expect(result.costUsd).toBeCloseTo(0.01, 10)
  })

  it("结构化输出用 output_config.format，不强制调工具（Opus 5.5 等强制 tool_choice 会 400）", async () => {
    const sent = fakeApi({ ...CLAUDE_TOOL_REPLY, content: [{ type: "text", text: "{\"ok\":true}" }], stop_reason: "end_turn" })
    const result = await callStructured(resolved("anthropic", "claude-opus-5-5", "https://claude.example/v1", 4, 20), { system: "s", messages: [{ role: "user", content: "x" }], schema: z.object({ ok: z.boolean() }), name: "result" })
    expect(result.object).toEqual({ ok: true })
    const body = sent[0]!.body as { output_config?: { format?: { type?: string } }; tool_choice?: unknown }
    expect(body.output_config?.format?.type).toBe("json_schema")
    expect(body.tool_choice).toBeUndefined()
  })
})

describe("直连 OpenAI", () => {
  it("走 Responses API，store 设 false 并要回加密的推理内容；缓存命中按 0.1 倍算", async () => {
    const sent = fakeApi({
      id: "resp_1",
      object: "response",
      created_at: 1_760_000_000,
      status: "completed",
      model: "gpt-6-sol",
      error: null,
      incomplete_details: null,
      output: [{ type: "function_call", id: "fc_1", call_id: "call_1", name: "web_open", arguments: "{\"url\":\"https://b.example\"}", status: "completed" }],
      usage: { input_tokens: 1000, input_tokens_details: { cached_tokens: 800 }, output_tokens: 20, output_tokens_details: { reasoning_tokens: 0 }, total_tokens: 1020 },
    })
    const result = await callModel(resolved("openai", "gpt-6-sol", "https://openai.example/v1", 2, 10), { system: "你是 agent", messages: [{ role: "user", content: "打开 b.example" }], tools })
    expect(sent[0]!.url).toBe("https://openai.example/v1/responses")
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer key-openai")
    expect(sent[0]!.body).toMatchObject({ model: "gpt-6-sol", store: false })
    expect(sent[0]!.body.include).toContain("reasoning.encrypted_content")
    expect(result.toolCalls[0]).toMatchObject({ toolCallId: "call_1", toolName: "web_open", input: { url: "https://b.example" } })
    // (200 + 800×0.1) × 2 + 20 × 10 = 760
    expect(result.costUsd).toBeCloseTo(760 / 1_000_000, 12)
  })
})

describe("直连 DeepSeek", () => {
  it("走 /chat/completions；缓存命中（prompt_cache_hit_tokens）按 0.1 倍算", async () => {
    const sent = fakeApi({
      id: "c1",
      object: "chat.completion",
      created: 1,
      model: "deepseek-v4-pro",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "", reasoning_content: "先打开看看", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_open", arguments: "{\"url\":\"https://b.example\"}" } }] },
          finish_reason: "tool_calls",
        },
      ],
      usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_cache_hit_tokens: 900, prompt_cache_miss_tokens: 100 },
    })
    const result = await callModel(resolved("deepseek", "deepseek-v4-pro", "https://deepseek.example", 0.2, 0.4), { system: "s", messages: [{ role: "user", content: "x" }], tools })
    expect(sent[0]!.url).toBe("https://deepseek.example/chat/completions")
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer key-deepseek")
    expect(result.toolCalls[0]).toMatchObject({ toolName: "web_open", input: { url: "https://b.example" } })
    // (100 + 900×0.1) × 0.2 + 20 × 0.4 = 46
    expect(result.costUsd).toBeCloseTo(46 / 1_000_000, 12)
  })
})

describe("自定义服务（OpenAI 兼容）", () => {
  const reply = {
    id: "c1",
    object: "chat.completion",
    created: 1,
    model: "qwen3-max",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "web_open", arguments: "{\"url\":\"https://b.example\"}" } }] },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 20, total_tokens: 1020, prompt_tokens_details: { cached_tokens: 900 } },
  }
  const custom = (apiKey: string | undefined): ResolvedModel => ({ model: languageModel("custom", "qwen3-max", apiKey, "https://gw.example/compatible-mode/v1"), modelId: "custom/qwen3-max", kind: "custom", priceIn: 1, priceOut: 2, vision: false })

  it("走 {地址}/chat/completions，带工具定义，拿到工具调用；花费按手动填的单价、没有缓存折扣", async () => {
    const sent = fakeApi(reply)
    const result = await callModel(custom("sk-gw"), { system: "你是 agent", messages: [{ role: "user", content: "打开 b.example" }], tools })
    expect(sent[0]!.url).toBe("https://gw.example/compatible-mode/v1/chat/completions")
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer sk-gw")
    expect(sent[0]!.body).toMatchObject({ model: "qwen3-max", tools: [{ type: "function", function: { name: "web_open" } }] })
    expect(result.toolCalls[0]).toMatchObject({ toolCallId: "call_1", toolName: "web_open", input: { url: "https://b.example" } })
    expect(result.tokensIn).toBe(1000)
    // 1000 × 1 + 20 × 2 = 1040（命中缓存的 900 也按原价）
    expect(result.costUsd).toBeCloseTo(1040 / 1_000_000, 12)
  })

  it("没有 key：不带 Authorization", async () => {
    const sent = fakeApi(reply)
    await callModel(custom(undefined), { system: "s", messages: [{ role: "user", content: "x" }], tools })
    expect(sent[0]!.headers.get("authorization")).toBeNull()
  })
})

describe("costOf", () => {
  const usage = (input: number, read: number, write: number) =>
    ({ inputTokens: input, outputTokens: 0, totalTokens: input, inputTokenDetails: { noCacheTokens: input - read - write, cacheReadTokens: read, cacheWriteTokens: write }, outputTokenDetails: { textTokens: 0, reasoningTokens: 0 } }) as Parameters<typeof costOf>[1]
  it("OpenRouter 返回了花费就用它", () => {
    expect(costOf({ kind: "openrouter", priceIn: 4, priceOut: 20 }, usage(1000, 900, 0), { openrouter: { usage: { cost: 0.123 } } }).costUsd).toBe(0.123)
  })
  it("没有缓存折扣的（OpenRouter 没给花费、测试的假模型）按原价估", () => {
    expect(costOf({ kind: "openrouter", priceIn: 1, priceOut: 0 }, usage(1000, 900, 0), undefined).costUsd).toBeCloseTo(0.001, 12)
    expect(costOf({ priceIn: 1, priceOut: 0 }, usage(1000, 0, 0), undefined).costUsd).toBeCloseTo(0.001, 12)
  })
})

describe("nativeCatalog：厂商列出的模型 + OpenRouter 公开目录里的价格", () => {
  const ref = (id: string, prompt: string, completion: string, extra: Record<string, unknown> = {}) => ({
    id,
    name: `${id.split("/")[0]}: ${id.split("/")[1]}`,
    context_length: 400_000,
    pricing: { prompt, completion },
    architecture: { input_modalities: ["text", "image"] },
    supported_parameters: ["tools"],
    ...extra,
  })
  const REFERENCE = [
    ref("anthropic/claude-sonnet-5.5", "0.000002", "0.00001"),
    ref("anthropic/claude-sonnet-5.5:batch", "0.000001", "0.000005"),
    ref("anthropic/claude-haiku-4.5", "0.000001", "0.000005"),
    ref("openai/gpt-6-sol", "0.000002", "0.00001", { name: "OpenAI: GPT-6 Sol" }),
    ref("openai/o3", "0.000002", "0.000008"),
    ref("openai/gpt-5.4-image-2", "0.000008", "0.000015", { supported_parameters: ["temperature"] }),
    ref("deepseek/deepseek-v4-pro", "0.000000209", "0.000000418", { architecture: { input_modalities: ["text"] }, context_length: 1_048_576 }),
  ]
  const at = (id: string, created: number, extra: Partial<NativeModel> = {}): NativeModel => ({ id, created, ...extra })

  it("Anthropic：上下文、能不能看图用 Anthropic 自己给的；带日期的版本也能查到价格；查不到的单价记 0", () => {
    const models = nativeCatalog("anthropic", [
      at("claude-haiku-4-5-20251001", 1, { displayName: "Claude Haiku 4.5", contextK: 200, vision: true }),
      at("claude-sonnet-5-5", 3, { displayName: "Claude Sonnet 5.5", contextK: 1000, vision: true }),
      at("claude-nova-9", 2, { displayName: "Claude Nova 9", contextK: 2000, vision: false }),
    ], REFERENCE)
    expect(models.map((model) => model.name)).toEqual(["claude-sonnet-5-5", "claude-nova-9", "claude-haiku-4-5-20251001"])
    expect(models[0]).toMatchObject({ displayName: "Claude Sonnet 5.5", contextK: 1000, priceIn: 2, priceOut: 10, vision: true })
    expect(models[1]).toMatchObject({ contextK: 2000, priceIn: 0, priceOut: 0, vision: false })
    expect(models[2]).toMatchObject({ priceIn: 1, priceOut: 5 })
  })

  it("OpenAI：只留能调工具的；目录里没有的按名字猜（向量、语音、实时的不要）", () => {
    const models = nativeCatalog("openai", [
      at("gpt-6-sol", 5),
      at("o3-2025-04-16", 4),
      at("text-embedding-3-large", 3),
      at("whisper-1", 3),
      at("gpt-realtime-2", 3),
      at("gpt-5.4-image-2", 3),
      at("gpt-9", 2),
    ], REFERENCE)
    expect(models.map((model) => model.name)).toEqual(["gpt-6-sol", "o3-2025-04-16", "gpt-9"])
    expect(models[0]).toMatchObject({ displayName: "GPT-6 Sol", contextK: 400, priceIn: 2, priceOut: 10, vision: true })
    // 宽松匹配到 o3：价格用它的，名字用自己的 id
    expect(models[1]).toMatchObject({ displayName: "o3-2025-04-16", priceIn: 2, priceOut: 8 })
    expect(models[2]).toMatchObject({ displayName: "gpt-9", contextK: 0, priceIn: 0, vision: false })
  })

  it("DeepSeek：全留；公开目录没连上时价格都是 0", () => {
    const listed = [at("deepseek-v4-pro", 2), at("deepseek-flash", 1)]
    expect(nativeCatalog("deepseek", listed, REFERENCE)).toMatchObject([
      { name: "deepseek-v4-pro", contextK: 1049, priceIn: 0.209, priceOut: 0.418, vision: false },
      { name: "deepseek-flash", contextK: 0, priceIn: 0, priceOut: 0 },
    ])
    expect(nativeCatalog("deepseek", listed, undefined).every((model) => model.priceIn === 0)).toBe(true)
  })
})

describe("customCatalog：自定义服务列出的模型", () => {
  const REFERENCE = [
    { id: "qwen/qwen3-vl-plus", name: "Qwen: Qwen3 VL Plus", context_length: 262_144, pricing: { prompt: "0.0000002", completion: "0.0000016" }, architecture: { input_modalities: ["text", "image"] } },
    { id: "qwen/qwen3-vl-plus:free", name: "Qwen: Qwen3 VL Plus (free)", context_length: 1000, pricing: { prompt: "0", completion: "0" } },
  ]
  it("去掉向量、重排、语音模型；按名字最后一段宽松匹配公开目录拿上下文和看图；价格一律 0", () => {
    const models = customCatalog(["Qwen/Qwen3-VL-Plus", "text-embedding-v4", "bge-reranker-v2", "whisper-1", "my-chat", "my-chat"], REFERENCE)
    expect(models.map((model) => model.name)).toEqual(["my-chat", "Qwen/Qwen3-VL-Plus"])
    expect(models[1]).toMatchObject({ displayName: "Qwen/Qwen3-VL-Plus", contextK: 262, vision: true, priceIn: 0, priceOut: 0 })
    expect(models[0]).toMatchObject({ contextK: 0, vision: false })
    expect(customCatalog(["my-chat"], undefined)).toHaveLength(1)
  })
})
