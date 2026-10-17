// 规则（M3，方案 2.3.2）：用一句话写，保存时由「规划」模型翻译成「一种触发类型 + 参数 + 动作」，人确认后才生效，
// 运行时引擎只按翻译结果执行，模型绕不过。翻译不进去的规则标成「未生效（v1 还不支持）」，绝不退回让模型自己判断。
// 平台通用：这里只有通用的触发类型和动作，具体工具、域名、人都是参数。
import { z } from "zod"

import type { Risk } from "./schemas.js"

// 这个文件不从 schemas.ts 引运行时的值（schemas.ts 要引这里的 ruleCompileViewSchema，避免循环引用）
const isoTime = z.string()

// ---------- 触发类型 ----------

export const ruleTriggerTypeSchema = z.enum([
  "before_tool",
  "after_tool",
  "url_not_allowed",
  "page_needs_human",
  "cost_over",
  "agent_done",
  "agent_proposes",
])
export type RuleTriggerType = z.infer<typeof ruleTriggerTypeSchema>

/** 「调工具前」按风险等级匹配时只认这两种（外发、涉及金钱） */
export const ruleRiskSchema = z.enum(["external", "money"])

export const compiledTriggerSchema = z.discriminatedUnion("type", [
  /** 调用某些工具之前：工具 id 命中，或者工具的风险等级命中，任一即可 */
  z.object({
    type: z.literal("before_tool"),
    toolIds: z.array(z.string()),
    risks: z.array(ruleRiskSchema),
  }),
  /** 调用某些工具之后（anyTool = 任意工具） */
  z.object({
    type: z.literal("after_tool"),
    toolIds: z.array(z.string()),
    anyTool: z.boolean(),
  }),
  /** 要打开的网址不在白名单里（域名，子域名也算；翻译时已经按 normalizeDomain 规整过） */
  z.object({
    type: z.literal("url_not_allowed"),
    domains: z.array(z.string().min(1)).min(1),
  }),
  /** 浏览器检测到验证码或登录页（引擎内部信号）。内置的「截图 + 转人工」始终会做，规则只能再加动作 */
  z.object({ type: z.literal("page_needs_human") }),
  /** 这次运行的花费超过多少美元 */
  z.object({ type: z.literal("cost_over"), usd: z.number().positive() }),
  /** agent 说做完了 */
  z.object({ type: z.literal("agent_done") }),
  /** agent 提议记忆或修改技能 */
  z.object({
    type: z.literal("agent_proposes"),
    what: z.array(z.enum(["memory", "skill"])).min(1),
  }),
])
export type CompiledTrigger = z.infer<typeof compiledTriggerSchema>

// ---------- 动作 ----------

export const ruleActionTypeSchema = z.enum([
  "deny",
  "ask_human",
  "screenshot",
  "notify",
  "sync_checkpoint",
  "verify",
])
export type RuleActionType = z.infer<typeof ruleActionTypeSchema>

/** 交给谁 / 通知谁：任务负责人、指定的人（userId）、主管（第一位没停用的主管） */
export const ruleRecipientSchema = z.discriminatedUnion("to", [
  z.object({ to: z.literal("owner") }),
  z.object({ to: z.literal("admin") }),
  z.object({ to: z.literal("user"), userId: z.string().min(1) }),
])
export type RuleRecipient = z.infer<typeof ruleRecipientSchema>

export const ruleActionSchema = z.discriminatedUnion("type", [
  /** 拦下，把理由告诉 agent */
  z.object({ type: z.literal("deny"), reason: z.string() }),
  /** 挂起，交给某人审批（调工具前：批准才执行，拒绝就把理由告诉 agent；花费超了：批准就继续，拒绝就结束） */
  z.object({ type: z.literal("ask_human"), recipient: ruleRecipientSchema }),
  /** 截图存证（这次运行开着浏览器时） */
  z.object({ type: z.literal("screenshot") }),
  /** 通知某人（站内通知 + 通知渠道） */
  z.object({ type: z.literal("notify"), recipient: ruleRecipientSchema }),
  /** 按工具的类别自动写检查点记录（标「自动」，agent 改不了） */
  z.object({ type: z.literal("sync_checkpoint") }),
  /** 交给三方验收 */
  z.object({ type: z.literal("verify") }),
])
export type RuleAction = z.infer<typeof ruleActionSchema>

/** 每种触发类型能配哪些动作（v1）。不在表里的组合算「v1 还不支持」 */
export const RULE_ACTIONS_ALLOWED: Record<
  RuleTriggerType,
  readonly RuleActionType[]
> = {
  before_tool: ["deny", "ask_human", "screenshot", "notify"],
  after_tool: ["screenshot", "notify", "sync_checkpoint"],
  url_not_allowed: ["deny", "ask_human", "screenshot", "notify"],
  page_needs_human: ["screenshot", "notify"],
  cost_over: ["ask_human", "notify", "deny"],
  agent_done: ["verify", "notify"],
  agent_proposes: ["deny", "notify"],
}

/** 翻译后的一条规则（rules.compiled_trigger 存的就是它；session 快照里原样冻结） */
export const compiledRuleSchema = z.object({
  v: z.literal(1),
  trigger: compiledTriggerSchema,
  actions: z.array(ruleActionSchema).min(1).max(6),
  /** 「系统理解为：……」，由 describeCompiledRule 按结构生成（不是模型写的） */
  understood: z.string(),
})
export type CompiledRule = z.infer<typeof compiledRuleSchema>

/** 结构上合不合法（触发和动作的组合、拦下和审批不能同时有……）。返回给人看的原因，合法返回 undefined */
export function checkCompiledRule(
  rule: Pick<CompiledRule, "trigger" | "actions">
): string | undefined {
  const allowed = RULE_ACTIONS_ALLOWED[rule.trigger.type]
  for (const action of rule.actions) {
    if (!allowed.includes(action.type))
      return `v1 还不支持在「${ruleTriggerLabel[rule.trigger.type]}」时「${ruleActionLabel[action.type]}」`
  }
  const blocking = rule.actions.filter(
    (action) => action.type === "deny" || action.type === "ask_human"
  )
  if (blocking.length > 1) return "一条规则里「拦下」和「交给人审批」只能有一个"
  const types = rule.actions.map((action) => action.type)
  if (
    new Set(types).size !== types.length &&
    !types.every((type) => type === "notify")
  )
    return "同一种动作写了两次"
  if (
    rule.trigger.type === "before_tool" &&
    rule.trigger.toolIds.length === 0 &&
    rule.trigger.risks.length === 0
  )
    return "「调用工具之前」要指明是哪些工具，或者哪种风险等级（外发、涉及金钱）"
  if (
    rule.trigger.type === "after_tool" &&
    rule.trigger.toolIds.length === 0 &&
    !rule.trigger.anyTool
  )
    return "「调用工具之后」要指明是哪些工具，或者任意工具"
  return undefined
}

// ---------- 给人看的文字 ----------

export const ruleTriggerLabel: Record<RuleTriggerType, string> = {
  before_tool: "调用工具之前",
  after_tool: "调用工具之后",
  url_not_allowed: "打开的网址不在白名单里",
  page_needs_human: "页面出现验证码或登录页",
  cost_over: "花费超过上限",
  agent_done: "agent 说做完了",
  agent_proposes: "agent 提议记忆或修改技能",
}

export const ruleActionLabel: Record<RuleActionType, string> = {
  deny: "拦下",
  ask_human: "交给人审批",
  screenshot: "截图存证",
  notify: "通知",
  sync_checkpoint: "自动记录检查点",
  verify: "交给三方验收",
}

const ruleRiskLabel: Record<"external" | "money", string> = {
  external: "对外发送",
  money: "涉及金钱",
}

export interface RuleNames {
  /** 工具 id → 名字（找不到就显示 id） */
  tool?: (id: string) => string | undefined
  /** 员工 id → 名字 */
  user?: (id: string) => string | undefined
}

export function recipientText(recipient: RuleRecipient, names: RuleNames = {}) {
  if (recipient.to === "owner") return "任务负责人"
  if (recipient.to === "admin") return "主管"
  return names.user?.(recipient.userId) ?? recipient.userId
}

/** 「系统理解为：……」：完全按结构生成，人看到的就是程序要执行的 */
export function describeCompiledRule(
  rule: Pick<CompiledRule, "trigger" | "actions">,
  names: RuleNames = {}
): string {
  const tool = (id: string) => {
    const name = names.tool?.(id)
    return name && name !== id ? `「${name}」（${id}）` : id
  }
  const { trigger } = rule
  let when: string
  switch (trigger.type) {
    case "before_tool": {
      const parts = [
        trigger.toolIds.length ? trigger.toolIds.map(tool).join("、") : "",
        trigger.risks.length
          ? `任何风险等级为「${trigger.risks.map((risk) => ruleRiskLabel[risk]).join("」或「")}」的工具`
          : "",
      ].filter(Boolean)
      when = `调用 ${parts.join("，或者 ")} 之前`
      break
    }
    case "after_tool":
      when = trigger.anyTool
        ? "调用任意工具之后"
        : `调用 ${trigger.toolIds.map(tool).join("、")} 之后`
      break
    case "url_not_allowed":
      when = `要打开的网址不在白名单（${trigger.domains.join("、")}，含子域名）里时`
      break
    case "page_needs_human":
      when = "浏览器检测到验证码或登录页时（系统本来就会截图并转人工）"
      break
    case "cost_over":
      when = `这次运行的花费超过 ${trigger.usd} 美元时`
      break
    case "agent_done":
      when = "agent 说做完了时"
      break
    case "agent_proposes":
      when = `agent 提议${trigger.what.map((what) => (what === "memory" ? "记忆" : "修改技能")).join("或")}时`
      break
  }
  const actions = rule.actions.map((action) => {
    switch (action.type) {
      case "deny":
        return trigger.type === "cost_over"
          ? `结束这次运行${action.reason ? `（理由：${action.reason}）` : ""}`
          : `拦下，告诉 agent${action.reason ? `「${action.reason}」` : "理由"}`
      case "ask_human":
        return trigger.type === "cost_over"
          ? `挂起，交给${recipientText(action.recipient, names)}决定要不要继续`
          : `拦下交给${recipientText(action.recipient, names)}审批，批准才执行`
      case "screenshot":
        return "截图存证"
      case "notify":
        return `通知${recipientText(action.recipient, names)}`
      case "sync_checkpoint":
        return "按工具类别自动记录检查点（标「自动」）"
      case "verify":
        return "交给另一家的模型做三方验收"
    }
  })
  return `${when}，${actions.join("，")}`
}

/** 某个风险等级会不会被「调工具前」的风险条件命中（工具页显示「哪些规则管着它」也用） */
export function riskMatches(
  risks: readonly ("external" | "money")[],
  risk: Risk
) {
  return (risks as readonly string[]).includes(risk)
}

// ---------- 翻译和确认（接口） ----------

/**
 * 规则的生效状态：
 * - untranslated：还没翻译（或者文字改过，还没重新翻译）；
 * - pending：翻译好了，等人确认；
 * - active：人确认过，正在按它执行；
 * - unsupported：翻译不进去（v1 还不支持），建任务时选不了。
 */
export const ruleCompileStatusSchema = z.enum([
  "untranslated",
  "pending",
  "active",
  "unsupported",
])
export type RuleCompileStatus = z.infer<typeof ruleCompileStatusSchema>

export const ruleCompileStatusLabel: Record<RuleCompileStatus, string> = {
  untranslated: "未翻译",
  pending: "待确认",
  active: "生效",
  unsupported: "未生效（v1 还不支持）",
}

/** 一次翻译的结果（rules.compile 返回；有规则 id 时也存进 rules.compile_draft） */
export const ruleCompileResultSchema = z.object({
  supported: z.boolean(),
  /** 翻译出来的结构（supported 时才有） */
  compiled: compiledRuleSchema.optional(),
  /** supported：「系统理解为」那句话；不支持：为什么不支持 */
  understood: z.string(),
  reason: z.string().optional(),
  /** 翻译时的文字（确认时要和规则现在的文字一致） */
  trigger: z.string(),
  action: z.string(),
  modelId: z.string(),
  at: isoTime,
})
export type RuleCompileResult = z.infer<typeof ruleCompileResultSchema>

/** rules.list 每条规则多出来的 compile（M3） */
export const ruleCompileViewSchema = z.object({
  status: ruleCompileStatusSchema,
  /** 现在这段文字的翻译：「系统理解为……」（未翻译时没有） */
  understood: z.string().optional(),
  /** 不支持的原因 */
  reason: z.string().optional(),
  /** 现在这段文字翻译出来的结构（待确认、生效时有） */
  draft: compiledRuleSchema.optional(),
  translatedAt: isoTime.optional(),
  modelId: z.string().optional(),
  /** 运行时会不会执行它、建任务时能不能选（有确认过的版本就是 true） */
  effective: z.boolean(),
  /** 正在执行的版本（确认过的）。文字改过还没重新确认时，引擎仍按这个旧版本执行 */
  enforced: z
    .object({
      understood: z.string(),
      trigger: z.string(),
      action: z.string(),
      confirmedAt: isoTime.optional(),
      confirmedById: z.string().optional(),
    })
    .optional(),
  /** 文字改过，正在执行的是旧版本 */
  outdated: z.boolean().optional(),
})
export type RuleCompileView = z.infer<typeof ruleCompileViewSchema>

/** rules.compile：给规则 id（翻译它现在的文字，结果存成待确认），或者直接给文字（只预览，不存） */
export const ruleCompileInputSchema = z
  .object({
    id: z.string().min(1).optional(),
    trigger: z.string().trim().min(1).max(500).optional(),
    action: z.string().trim().min(1).max(500).optional(),
    toolIds: z.array(z.string().min(1)).max(200).optional(),
  })
  .refine(
    (input) => input.id || (input.trigger && input.action),
    "给规则 id，或者给触发条件和命中后怎么办"
  )
export type RuleCompileInput = z.input<typeof ruleCompileInputSchema>

export const ruleConfirmInputSchema = z.object({ id: z.string().min(1) })
