// 规则翻译（M3，方案 2.3.2）：保存规则后，用「规划」默认模型把「触发条件 + 命中后怎么办」翻译成结构化结果（zod schema 约束输出），
// 再由程序校验、规整：工具和员工必须真实存在，域名按白名单规则规整，触发和动作的组合必须是 v1 支持的。
// 任何一步不过都算「v1 还不支持」，绝不退回让模型运行时自己判断。「系统理解为」那句话由程序按结构生成，人确认后才生效。
import { asc, eq } from "drizzle-orm"
import {
  checkCompiledRule,
  describeCompiledRule,
  normalizeDomain,
  riskLabel,
  ruleActionTypeSchema,
  ruleRiskSchema,
  ruleTriggerTypeSchema,
  type CompiledRule,
  type CompiledTrigger,
  type RuleAction,
  type RuleCompileResult,
  type RuleRecipient,
} from "@heyagent/shared"
import { z } from "zod"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { callStructured, resolveModel } from "./model.js"
import { EngineError } from "./sessions.js"

/** 给模型的输出格式：扁平、字段都必填（有的厂商的严格模式不认可选字段和 oneOf），由程序再组装成 CompiledRule */
export const ruleModelOutputSchema = z.object({
  supported: z
    .boolean()
    .describe(
      "能不能完全用下面的触发类型和动作表达；要靠理解内容才能判断的条件一律 false"
    ),
  reason: z
    .string()
    .describe("supported = false 时写清楚为什么 v1 不支持；true 时写空字符串"),
  trigger: z.object({
    type: ruleTriggerTypeSchema,
    toolIds: z
      .array(z.string())
      .describe(
        "before_tool / after_tool：工具 id，只能用工具清单里的；没有就空数组"
      ),
    risks: z
      .array(ruleRiskSchema)
      .describe(
        "before_tool：按风险等级匹配（external = 对外发送，money = 涉及金钱）；没有就空数组"
      ),
    anyTool: z.boolean().describe("after_tool：任意工具之后为 true"),
    domains: z
      .array(z.string())
      .describe("url_not_allowed：白名单域名，例如 example.com；没有就空数组"),
    usd: z.number().describe("cost_over：美元；其他类型写 0"),
    proposes: z
      .array(z.enum(["memory", "skill"]))
      .describe(
        "agent_proposes：memory = 记忆，skill = 修改技能；没有就空数组"
      ),
  }),
  actions: z
    .array(
      z.object({
        type: ruleActionTypeSchema,
        to: z
          .enum(["owner", "admin", "user", "none"])
          .describe(
            "ask_human / notify 交给谁：owner = 任务负责人，admin = 主管，user = 指定的人（填 userId），其他动作写 none"
          ),
        userId: z
          .string()
          .describe(
            "to = user 时填员工 id（只能用员工清单里的），否则空字符串"
          ),
        reason: z
          .string()
          .describe("deny：拦下时告诉 agent 的话；其他动作写空字符串"),
      })
    )
    .describe("命中后按顺序做的动作"),
})
export type RuleModelOutput = z.infer<typeof ruleModelOutputSchema>

const SYSTEM = `你是 HeyAgent 平台的规则翻译器。员工用一句话写规则：「触发条件」+「命中后怎么办」。你把它翻译成程序能执行的结构；程序运行时只认你的结构，不会再让模型理解原话。
触发类型（trigger.type，只能选一种）：
- before_tool：调用某些工具之前。toolIds 填工具 id，或者 risks 填风险等级（external = 对外发送，money = 涉及金钱），可以两者都填。
- after_tool：调用某些工具之后。toolIds 填工具 id，或者 anyTool = true 表示任意工具。
- url_not_allowed：agent 要打开的网址不在白名单里。domains 填白名单域名（子域名也算）。
- page_needs_human：浏览器检测到验证码或登录页（系统本来就会截图并交给人，规则只能另外加动作）。
- cost_over：这次运行的花费超过 usd 美元。
- agent_done：agent 说做完了。
- agent_proposes：agent 提议记忆（memory）或修改技能（skill）。
动作（actions[].type）：
- deny：拦下，把 reason 告诉 agent。（cost_over 时 = 结束这次运行）
- ask_human：挂起，交给人审批（批准才执行；cost_over 时 = 决定要不要继续）。to 填交给谁。
- screenshot：截图存证。
- notify：通知某人（to 填通知谁）。
- sync_checkpoint：按工具类别自动记录检查点（打开网页记访问、外发工具记消息、存文件记产物）。
- verify：交给另一家的模型做三方验收。验收流程本身就包括：逐条核对检查点、没通过或存疑的反问执行 agent 让它补做、几轮后还说不清的交给负责人决定。规则里描述的这些都算 verify 一个动作，不要因此判不支持。
（ask_human 也一样：批准才执行、拒绝就把理由告诉 agent，都是 ask_human 本身的流程。）
能用的组合：before_tool → deny / ask_human / screenshot / notify；after_tool → screenshot / notify / sync_checkpoint；url_not_allowed → deny / ask_human / screenshot / notify；page_needs_human → screenshot / notify；cost_over → ask_human / notify / deny；agent_done → verify / notify；agent_proposes → deny / notify。一条规则里 deny 和 ask_human 只能有一个。
要求：
- 工具 id 只能用工具清单里的（browser 代表整组浏览器工具，也可以写 browser.navigate、browser.click 这类具体的浏览器动作；desktop 代表整组桌面工具，也可以写 desktop.click、desktop.type 这类具体的桌面动作）；员工只能用员工清单里的 id。规则提到的工具或人在清单里找不到，就 supported = false 并说明。
- 「交给谁」写的是岗位或角色、清单里对不上具体的人时：负责人、本人之类用 owner；主管、经理之类用 admin。
- 触发条件要靠理解内容才能判断的（例如「内容可疑时」「客户是新客户时」「价格太高时」），或者要用上面没有的动作，supported = false，reason 写清楚，不要硬凑。
- 只输出要求的 JSON。`

export interface CompileInput {
  trigger: string
  action: string
  /** 规则编辑器里勾的「会调用的工具」，只作参考 */
  toolIds?: string[]
}

async function catalogs(db: Db) {
  const tools = await db
    .select({
      id: t.tools.id,
      name: t.tools.name,
      summary: t.tools.summary,
      risk: t.tools.risk,
    })
    .from(t.tools)
    .orderBy(asc(t.tools.position))
  const staff = await db
    .select({
      id: t.users.id,
      name: t.users.name,
      title: t.users.title,
      role: t.users.role,
      banned: t.users.banned,
    })
    .from(t.users)
    .orderBy(asc(t.users.createdAt))
  return { tools, staff: staff.filter((row) => !row.banned) }
}

const unsupported = (reason: string): { supported: false; reason: string } => ({
  supported: false,
  reason,
})

/** 把模型的扁平输出组装、校验成 CompiledRule；不合法就返回不支持的原因 */
export function normalizeRuleOutput(
  output: RuleModelOutput,
  known: {
    toolIds: Set<string>
    userIds: Set<string>
    toolName: (id: string) => string | undefined
    userName: (id: string) => string | undefined
  }
):
  | { supported: true; compiled: CompiledRule }
  | { supported: false; reason: string } {
  if (!output.supported)
    return unsupported(output.reason.trim() || "这条规则 v1 还不支持")
  const toolOk = (id: string) =>
    known.toolIds.has(id) || /^(browser|desktop)\.[a-z_]+$/.test(id)
  const raw = output.trigger
  const badTools = raw.toolIds.filter((id) => !toolOk(id))
  if (
    badTools.length &&
    (raw.type === "before_tool" || raw.type === "after_tool")
  )
    return unsupported(`规则里的工具在工具清单里找不到：${badTools.join("、")}`)
  let trigger: CompiledTrigger
  switch (raw.type) {
    case "before_tool":
      trigger = {
        type: "before_tool",
        toolIds: [...new Set(raw.toolIds)],
        risks: [...new Set(raw.risks)],
      }
      break
    case "after_tool":
      trigger = {
        type: "after_tool",
        toolIds: raw.anyTool ? [] : [...new Set(raw.toolIds)],
        anyTool: raw.anyTool,
      }
      break
    case "url_not_allowed": {
      const domains = [
        ...new Set(
          raw.domains
            .map((domain) => normalizeDomain(domain))
            .filter((domain): domain is string => Boolean(domain))
        ),
      ]
      if (domains.length === 0)
        return unsupported(
          "「网址不在白名单」要写出白名单里的域名，例如 example.com"
        )
      trigger = { type: "url_not_allowed", domains }
      break
    }
    case "page_needs_human":
      trigger = { type: "page_needs_human" }
      break
    case "cost_over":
      if (!(raw.usd > 0)) return unsupported("「花费超过上限」要写出多少美元")
      trigger = { type: "cost_over", usd: Math.round(raw.usd * 10000) / 10000 }
      break
    case "agent_done":
      trigger = { type: "agent_done" }
      break
    case "agent_proposes":
      trigger = {
        type: "agent_proposes",
        what: raw.proposes.length
          ? [...new Set(raw.proposes)]
          : ["memory", "skill"],
      }
      break
  }
  const actions: RuleAction[] = []
  for (const action of output.actions) {
    const recipient = (): RuleRecipient | string => {
      if (action.to === "admin") return { to: "admin" }
      if (action.to === "user") {
        if (!known.userIds.has(action.userId))
          return `规则里要交给 / 通知的人在员工清单里找不到：${action.userId || "（没写）"}`
        return { to: "user", userId: action.userId }
      }
      return { to: "owner" }
    }
    switch (action.type) {
      case "deny":
        actions.push({
          type: "deny",
          reason: action.reason.trim().slice(0, 300),
        })
        break
      case "ask_human":
      case "notify": {
        const who = recipient()
        if (typeof who === "string") return unsupported(who)
        if (
          actions.some(
            (each) =>
              each.type === action.type &&
              JSON.stringify(each) ===
                JSON.stringify({ type: action.type, recipient: who })
          )
        )
          break
        actions.push({ type: action.type, recipient: who })
        break
      }
      default:
        if (!actions.some((each) => each.type === action.type))
          actions.push({ type: action.type })
    }
  }
  if (actions.length === 0) return unsupported("没有翻译出命中后要做的动作")
  const problem = checkCompiledRule({ trigger, actions })
  if (problem) return unsupported(problem)
  const understood = describeCompiledRule(
    { trigger, actions },
    { tool: known.toolName, user: known.userName }
  )
  return { supported: true, compiled: { v: 1, trigger, actions, understood } }
}

/** 翻译一条规则（不落库）。返回结果和这次花的钱 */
export async function compileRuleText(
  db: Db,
  input: CompileInput
): Promise<{ result: RuleCompileResult; costUsd: number }> {
  const [plan] = await db
    .select({ modelId: t.modelDefaults.modelId })
    .from(t.modelDefaults)
    .where(eq(t.modelDefaults.role, "plan"))
  if (!plan)
    throw new EngineError(
      "BAD_REQUEST",
      "还没有设置「规划」默认模型，翻译不了规则：先去「模型」页设置"
    )
  const { tools, staff } = await catalogs(db)
  const prompt = [
    `## 规则\n触发条件：${input.trigger}\n命中后怎么办：${input.action}`,
    input.toolIds?.length
      ? `规则编辑器里勾的「会调用的工具」（只作参考）：${input.toolIds.join("、")}`
      : "",
    `## 工具清单（id · 名字 · 风险等级 · 说明）\n${tools.map((tool) => `- ${tool.id} · ${tool.name} · ${riskLabel[tool.risk]} · ${tool.summary}`).join("\n")}`,
    `## 员工清单（id · 名字 · 职位 · 角色）\n${staff.map((user) => `- ${user.id} · ${user.name} · ${user.title || "—"} · ${user.role === "admin" ? "主管" : "员工"}`).join("\n")}`,
  ]
    .filter(Boolean)
    .join("\n\n")
  let resolved
  try {
    resolved = await resolveModel(db, plan.modelId)
  } catch (error) {
    throw new EngineError(
      "BAD_REQUEST",
      `规划模型用不了：${(error as Error).message}`
    )
  }
  let output: RuleModelOutput
  let costUsd: number
  try {
    const result = await callStructured(resolved, {
      system: SYSTEM,
      messages: [{ role: "user", content: prompt }],
      schema: ruleModelOutputSchema,
      name: "rule",
    })
    output = result.object
    costUsd = result.costUsd
  } catch (error) {
    throw new EngineError(
      "BAD_REQUEST",
      `翻译规则时模型出错，请稍后重试：${(error as Error).message.slice(0, 300)}`
    )
  }
  const toolNames = new Map(tools.map((tool) => [tool.id, tool.name]))
  const userNames = new Map(staff.map((user) => [user.id, user.name]))
  const normalized = normalizeRuleOutput(output, {
    toolIds: new Set(toolNames.keys()),
    userIds: new Set(userNames.keys()),
    toolName: (id) => toolNames.get(id),
    userName: (id) => userNames.get(id),
  })
  const base = {
    trigger: input.trigger,
    action: input.action,
    modelId: plan.modelId,
    at: new Date().toISOString(),
  }
  const result: RuleCompileResult = normalized.supported
    ? {
        supported: true,
        compiled: normalized.compiled,
        understood: normalized.compiled.understood,
        ...base,
      }
    : {
        supported: false,
        understood: `v1 还不支持：${normalized.reason}`,
        reason: normalized.reason,
        ...base,
      }
  return { result, costUsd }
}
