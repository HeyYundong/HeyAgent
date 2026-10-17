import { describe, expect, it } from "vitest"

import { defaultsAfterRemove, modelFamily, modelName, priceText, contextText, sameFamily } from "../src/index.js"

describe("modelFamily", () => {
  it("Ollama 的 llama 模型认成 Meta（回归：服务前缀里的 llama 不能误伤）", () => {
    expect(modelFamily("ollama/llama3.3:70b")).toBe("Meta")
  })
  it("Ollama 的 qwen 模型认成阿里通义（回归）", () => {
    expect(modelFamily("ollama/qwen3:32b")).toBe("阿里通义")
  })
  it("OpenRouter 的模型按 id 里的关键词认", () => {
    expect(modelFamily("openrouter/anthropic/claude-sonnet-5.5")).toBe("Anthropic")
    expect(modelFamily("openrouter/google/gemini-3.8-flash")).toBe("Google")
    expect(modelFamily("openrouter/qwen/qwen3.8-flash")).toBe("阿里通义")
  })
  it("认不出的：OpenRouter 取厂商，Ollama 取模型名开头", () => {
    expect(modelFamily("openrouter/moonshotai/kimi-k3")).toBe("Moonshotai")
    expect(modelFamily("ollama/yi:34b")).toBe("Yi")
  })
  it("只有服务前缀时归为「其他」", () => {
    expect(modelFamily("ollama")).toBe("其他")
  })
  it("直连厂商：按模型名认，认不出就是这家（openai/o3）", () => {
    expect(modelFamily("anthropic/claude-sonnet-5-5")).toBe("Anthropic")
    expect(modelFamily("openai/gpt-6-sol")).toBe("OpenAI")
    expect(modelFamily("openai-2/o3")).toBe("OpenAI")
    expect(modelFamily("deepseek/deepseek-flash")).toBe("DeepSeek")
    expect(sameFamily("anthropic/claude-opus-5-5", "openrouter/anthropic/claude-haiku-5.5")).toBe(true)
  })
  it("OpenRouter 不算直连：openrouter/openai/o3 里的「openai」照样认成 OpenAI，但服务 id 本身不当厂商", () => {
    expect(modelFamily("openrouter/openai/o3")).toBe("OpenAI")
    expect(modelFamily("openrouter/acme/o3")).toBe("Acme")
  })
})

describe("sameFamily", () => {
  it("执行 Claude、验收 Gemini 不是同一家", () => {
    expect(sameFamily("openrouter/anthropic/claude-sonnet-5.5", "openrouter/google/gemini-3.8-flash")).toBe(false)
  })
  it("不同服务上的同一家算同一家", () => {
    expect(sameFamily("ollama/qwen3:32b", "openrouter/qwen/qwen3.8-flash")).toBe(true)
  })
})

describe("模型展示", () => {
  const model = { id: "openrouter/anthropic/claude-opus-5.5", name: "Claude Opus 5.5", note: "", contextK: 1000, priceIn: 4, priceOut: 20 }
  it("modelName 找不到时原样返回 id", () => {
    expect(modelName([model], model.id)).toBe("Claude Opus 5.5")
    expect(modelName([model], "x/y")).toBe("x/y")
    expect(modelName([model], undefined)).toBe("—")
  })
  it("上下文和价格", () => {
    expect(contextText(model)).toBe("1M")
    expect(contextText({ ...model, contextK: 128 })).toBe("128K")
    expect(priceText(model)).toBe("$4 / $20")
    expect(priceText({ ...model, id: "ollama/qwen3:32b", priceIn: 0, priceOut: 0 })).toBe("免费（本地）")
    // 云端的单价 0 = 没查到价格
    expect(priceText({ ...model, id: "deepseek/deepseek-flash", priceIn: 0, priceOut: 0 })).toBe("未知")
    expect(contextText({ ...model, contextK: 0 })).toBe("未知")
  })
})

describe("defaultsAfterRemove", () => {
  const claude = { models: [{ id: "openrouter/anthropic/claude-sonnet-5.5" }, { id: "openrouter/google/gemini-3.8-flash" }] }
  const ollama = { models: [{ id: "ollama/qwen3:32b" }] }
  const mk = (models: { id: string }[]) => ({ models: models.map((m) => ({ ...m, name: m.id, note: "", contextK: 1, priceIn: 0, priceOut: 0 })) })
  it("删掉验收用的服务后，验收换成和执行不同家的模型", () => {
    const next = defaultsAfterRemove(
      { run: "openrouter/anthropic/claude-sonnet-5.5", plan: "openrouter/anthropic/claude-sonnet-5.5", verify: "ollama/qwen3:32b" },
      mk(ollama.models),
      [mk(claude.models)]
    )
    expect(next.verify).toBe("openrouter/google/gemini-3.8-flash")
  })
})
