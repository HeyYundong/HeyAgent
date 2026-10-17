// 模型页留在前端的东西：添加服务时的默认地址、详情「连接」卡的几行（docs/dev/m0-api.md 2.6）。
// 模型服务和默认设置来自 models.overview；contextText、priceText、defaultsAfterRemove 等纯函数在 shared。
import { ANTHROPIC_DEFAULT_URL, DEEPSEEK_DEFAULT_URL, fmtDateTime, OPENAI_DEFAULT_URL, OPENROUTER_DEFAULT_URL, providerStatusLabel, type ModelDefaults, type ModelProvider, type ModelProviderKind, type TaskDef } from "@heyagent/shared"

export { contextText, defaultsAfterRemove, modelRoles as ROLES, priceText, providerKindLabel as KIND_LABEL } from "@heyagent/shared"

/** 页面里的模型服务 = 接口返回的 ModelProvider（同一类型可以加多个，所以 id 和类型分开） */
export type Provider = ModelProvider
export type Defaults = ModelDefaults

/** 添加服务时预填的地址 */
export const DEFAULT_URL: Record<ModelProviderKind, string> = {
  ollama: "http://192.168.31.101:11434",
  openrouter: OPENROUTER_DEFAULT_URL,
  anthropic: ANTHROPIC_DEFAULT_URL,
  openai: OPENAI_DEFAULT_URL,
  deepseek: DEEPSEEK_DEFAULT_URL,
}

export function tasksOnProvider(provider: Provider, tasks: TaskDef[]) {
  return tasks.filter((task) => provider.models.some((model) => model.id === task.modelId))
}

/** 列表里的一句话：未配置的服务没有模型、没有延迟 */
export function providerLine(provider: Provider, kindLabel: string) {
  if (provider.status === "unconfigured") return `${kindLabel} · 未配置`
  const latency = provider.latencyMs !== undefined ? ` · 延迟 ${provider.latencyMs} ms` : ""
  return `${kindLabel} · ${provider.models.length} 个模型${latency}`
}

/** 详情「连接」卡的几行 */
export function connectionRows(provider: Provider): [string, string][] {
  const latency = provider.latencyMs !== undefined ? ` · 延迟 ${provider.latencyMs} ms` : ""
  return [
    ["地址", provider.baseUrl || "还没填"],
    ["API Key", provider.apiKeyMasked ?? "不需要"],
    ["状态", `${providerStatusLabel[provider.status]}${latency}`],
    ["检查时间", provider.checkedAt ? fmtDateTime(provider.checkedAt) : "还没检查过"],
  ]
}
