// 助手用哪个模型、一次请求的上限（docs/dev/copilot.md 第 10 节）。
// 模型：本对话设的 → 「模型」页的助手默认 → plan 默认；上限：本对话设的 ?? 设置页「助手」一组的全局值。
import type { AssistantDefaults } from "@heyagent/shared"
import { eq, inArray } from "drizzle-orm"

import type { DbOrTx } from "../data/config/common.js"
import { readAssistantSettings } from "../data/config/settings.js"
import * as t from "../db/schema.js"

/** 不是库里能对话的模型时返回原因（给人看的），能用返回 undefined */
export async function modelProblem(db: DbOrTx, id: string): Promise<string | undefined> {
  const [model] = await db.select({ id: t.models.id, kind: t.models.kind }).from(t.models).where(eq(t.models.id, id))
  if (!model) return `模型 ${id} 不存在（可能刷新模型列表后下架了），换一个`
  if (model.kind !== "chat") return `${id} 是 embedding 模型，不能对话，换一个`
  return undefined
}

/** 本对话没单独选模型时用哪个：「模型」页的助手默认模型，没配用 plan 默认模型；都没配是 null */
async function defaultModel(db: DbOrTx): Promise<{ id: string; role: "assistant" | "plan" } | null> {
  const rows = await db
    .select({ role: t.modelDefaults.role, modelId: t.modelDefaults.modelId })
    .from(t.modelDefaults)
    .where(inArray(t.modelDefaults.role, ["assistant", "plan"]))
  const assistant = rows.find((row) => row.role === "assistant")
  if (assistant) return { id: assistant.modelId, role: "assistant" }
  const plan = rows.find((row) => row.role === "plan")
  return plan ? { id: plan.modelId, role: "plan" } : null
}

/** 这次用哪个模型：本对话设的 → 助手默认 → plan 默认；用不了就说清楚是哪一层的 */
export async function pickModel(db: DbOrTx, chatModelId: string | null): Promise<{ modelId: string } | { error: string }> {
  if (chatModelId) {
    const problem = await modelProblem(db, chatModelId)
    return problem ? { error: `本对话设的模型用不了：${problem}。到「本对话的设置」里换一个，或改回跟默认走` } : { modelId: chatModelId }
  }
  const fallback = await defaultModel(db)
  if (!fallback) return { error: "还没有配模型，先到「模型」页设助手的默认模型（或规划的默认模型）" }
  const problem = await modelProblem(db, fallback.id)
  if (!problem) return { modelId: fallback.id }
  return { error: `${fallback.role === "assistant" ? "助手的默认模型" : "规划的默认模型"}用不了：${problem}（到「模型」页换一个）` }
}

/** 一次请求的上限：本对话设的 ?? 全局的 */
export async function effectiveLimits(db: DbOrTx, chat: { maxSteps: number | null; maxCostUsd: number | null }) {
  const global = await readAssistantSettings(db)
  return { maxSteps: chat.maxSteps ?? global.maxSteps, maxCostUsd: chat.maxCostUsd ?? global.maxCostUsd }
}

/** 本对话没单独设时实际会用的值（设置面板的「跟默认走（xxx）」和 placeholder） */
export async function loadAssistantDefaults(db: DbOrTx): Promise<AssistantDefaults> {
  const [model, global] = await Promise.all([defaultModel(db), readAssistantSettings(db)])
  let modelName: string | null = null
  if (model) {
    const [row] = await db.select({ name: t.models.name }).from(t.models).where(eq(t.models.id, model.id))
    modelName = row?.name ?? model.id
  }
  return { modelId: model?.id ?? null, modelName, maxSteps: global.maxSteps, maxCostUsd: global.maxCostUsd }
}
