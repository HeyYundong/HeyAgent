// 4 个阶段的钩子（方案 2.3.2 的规则在这里执行）：运行开始、调工具前、调工具后、说做完了。
// M1 只有两条内置检查：工具必须在本任务允许的范围里；参数必须通过 schema 校验。
// M3 往这里加：规则翻译后的触发条件（调工具前拦下 / 挂起等人、调工具后同步检查点）、说做完了交给三方验收。
import type { SessionSnapshot } from "@heyagent/shared"
import type { z } from "zod"

import type { Db } from "../db/client.js"
import type { SessionRow, ToolOutcome } from "./tools/builtin.js"

export interface RunContext {
  db: Db
  session: SessionRow
  snapshot: SessionSnapshot
}

export interface ToolCallContext extends RunContext {
  toolId: string
  /** 模型给的参数（还没校验） */
  input: unknown
  /** 本任务允许的工具 id */
  allowedToolIds: ReadonlySet<string>
  /** 这个工具的参数 schema（工具不存在时为空） */
  inputSchema?: z.ZodType
}

export type BeforeToolDecision =
  /** 放行；可以换掉参数（例如 schema 解析后的值） */
  | { action: "allow"; input?: unknown }
  /** 拦下：工具不执行，理由作为工具结果交给模型 */
  | { action: "deny"; reason: string; ruleId?: string; ruleName?: string }

export type FinishDecision =
  /** 标「已完成」 */
  | { action: "done" }
  /** 不算完：把这句话交给 agent，接着干（M3 验收反问用） */
  | { action: "continue"; message: string }

export interface EngineHook {
  name: string
  onRunStart?(ctx: RunContext): Promise<void> | void
  beforeTool?(
    ctx: ToolCallContext
  ): Promise<BeforeToolDecision | void> | BeforeToolDecision | void
  afterTool?(
    ctx: ToolCallContext & { outcome: ToolOutcome }
  ): Promise<void> | void
  onFinish?(
    ctx: RunContext & { text: string }
  ): Promise<FinishDecision | void> | FinishDecision | void
}

/** 内置检查：允许的范围 + 参数校验 */
export const builtinChecks: EngineHook = {
  name: "builtin",
  beforeTool(ctx) {
    if (!ctx.allowedToolIds.has(ctx.toolId))
      return {
        action: "deny",
        reason: `工具 ${ctx.toolId} 不在本任务允许的范围里，不能调用`,
      }
    if (!ctx.inputSchema)
      return { action: "deny", reason: `工具 ${ctx.toolId} 现在不可用` }
    const parsed = ctx.inputSchema.safeParse(ctx.input ?? {})
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join(".") || "参数"}：${issue.message}`)
      return { action: "deny", reason: `参数不对：${issues.join("；")}` }
    }
    return { action: "allow", input: parsed.data }
  },
}

const hooks: EngineHook[] = [builtinChecks]

/** 加一组钩子（M3 的规则引擎、三方验收从这里接进来） */
export function registerHook(hook: EngineHook) {
  if (!hooks.some((each) => each.name === hook.name)) hooks.push(hook)
}

export function unregisterHook(name: string) {
  const index = hooks.findIndex((each) => each.name === name)
  if (index > 0) hooks.splice(index, 1)
}

export async function runStartHooks(ctx: RunContext) {
  for (const hook of hooks) await hook.onRunStart?.(ctx)
}

/** 依次执行；第一个拦下的生效。放行时后面的钩子拿到前面换过的参数 */
export async function runBeforeToolHooks(
  ctx: ToolCallContext
): Promise<BeforeToolDecision & { hook?: string }> {
  let input = ctx.input
  for (const hook of hooks) {
    const decision = await hook.beforeTool?.({ ...ctx, input })
    if (!decision) continue
    if (decision.action === "deny") return { ...decision, hook: hook.name }
    if (decision.input !== undefined) input = decision.input
  }
  return { action: "allow", input }
}

export async function runAfterToolHooks(
  ctx: ToolCallContext & { outcome: ToolOutcome }
) {
  for (const hook of hooks) await hook.afterTool?.(ctx)
}

export async function runFinishHooks(
  ctx: RunContext & { text: string }
): Promise<FinishDecision> {
  for (const hook of hooks) {
    const decision = await hook.onFinish?.(ctx)
    if (decision && decision.action !== "done") return decision
  }
  return { action: "done" }
}
