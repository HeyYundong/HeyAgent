// 模型相关的纯函数（原型 mock/shared.ts 和 models/data.ts）。
import type { ModelDefaults, ModelInfo, ModelProvider } from "./schemas.js"

/** 模型属于哪一家（看 id 里的关键词）。三方验收不许和执行用同一家（已定） */
const FAMILY_NAMES: [keyword: string, name: string][] = [
  ["anthropic", "Anthropic"], ["claude", "Anthropic"], ["qwen", "阿里通义"], ["llama", "Meta"], ["deepseek", "DeepSeek"],
  ["openai", "OpenAI"], ["gpt", "OpenAI"], ["gemini", "Google"], ["gemma", "Google"], ["mistral", "Mistral"], ["x-ai", "xAI"], ["grok", "xAI"], ["phi", "Microsoft"],
]

export function modelFamily(modelId: string): string {
  // 先去掉服务前缀（ollama/、openrouter/），否则「ollama」里的「llama」会把所有 Ollama 模型认成 Meta
  const model = modelId.toLowerCase().split("/").slice(1).join("/")
  const known = FAMILY_NAMES.find(([keyword]) => model.includes(keyword))
  if (known) return known[1]
  // 认不出来的：OpenRouter 取厂商（厂商/模型），Ollama 取模型名的开头（名字:标签）
  const raw = model.includes("/") ? model.split("/")[0] : model.split(/[:\d.-]/)[0]
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "其他"
}

export function sameFamily(a: string, b: string): boolean {
  return modelFamily(a) === modelFamily(b)
}

/** 全部模型（各服务的模型拼起来） */
export const allModels = (providers: Pick<ModelProvider, "models">[]): ModelInfo[] => providers.flatMap((provider) => provider.models)

export function modelName(models: ModelInfo[], id: string | undefined): string {
  return models.find((model) => model.id === id)?.name ?? id ?? "—"
}

export function contextText(model: ModelInfo) {
  return model.contextK >= 1000 ? `${model.contextK / 1000}M` : `${model.contextK}K`
}

export function priceText(model: ModelInfo) {
  return model.priceIn === 0 ? "免费（本地）" : `$${model.priceIn} / $${model.priceOut}`
}

/** 删掉一家服务后：默认设置里用到它的模型换成剩下的；验收换成和执行不同家的（没有别家就留给人处理） */
export function defaultsAfterRemove(defaults: ModelDefaults, removed: Pick<ModelProvider, "models">, rest: Pick<ModelProvider, "models">[]): ModelDefaults {
  const left = rest.flatMap((provider) => provider.models.map((model) => model.id))
  const gone = (id: string) => removed.models.some((model) => model.id === id)
  const run = gone(defaults.run) ? (left[0] ?? "") : defaults.run
  const plan = gone(defaults.plan) ? (left[0] ?? "") : defaults.plan
  const keepVerify = !gone(defaults.verify) && !sameFamily(run, defaults.verify)
  const verify = keepVerify ? defaults.verify : (left.find((id) => !sameFamily(id, run)) ?? left[0] ?? "")
  return { run, plan, verify }
}
