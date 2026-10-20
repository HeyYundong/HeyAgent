// 规则引擎（M3，方案 2.3.2）：按 session 快照里人确认过的规则，在固定阶段由程序执行，模型绕不过。
// - 调模型前：花费超过 X（cost_over）；
// - 调工具前：调用某些工具 / 某种风险等级的工具之前（before_tool）、网址不在白名单（url_not_allowed）、agent 提议记忆或技能（agent_proposes）；
// - 调工具后：调用某些工具之后（after_tool）、浏览器检测到验证码或登录页（page_needs_human，内置转人工照常，规则只能再加动作）、提议之后的通知；
// - 说做完了：agent_done（通知、交给三方验收）。
// 每次命中都写一条 rule 事件：哪条规则、做了什么。快照里没确认过的规则一律不执行（开始时写一条事件说明）。
import { asc, eq, sql } from "drizzle-orm"
import {
  compiledRuleSchema,
  hostMatches,
  parseUrl,
  recipientText,
  riskMatches,
  type CompiledRule,
  type HumanDetail,
  type RuleAction,
  type RuleRecipient,
  type SessionSnapshot,
} from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { syncCheckpoints } from "./checkpoint-sync.js"
import type {
  BeforeStepDecision,
  BeforeToolDecision,
  EngineHook,
  FinishDecision,
  RunContext,
} from "./hooks.js"
import { askHumanInTx, notifyAssignee } from "./humans.js"
import { notifyUsers, sessionLink } from "./notify.js"
import { appendEvent, type DbLike } from "./records.js"
import { httpUrlOf } from "./tools/http.js"
import { runVerification } from "./verify.js"

export interface ActiveRule {
  id: string
  name: string
  rule: CompiledRule
}

/** 快照里人确认过、结构合法的规则 */
export function activeRules(snapshot: SessionSnapshot): ActiveRule[] {
  const out: ActiveRule[] = []
  for (const rule of snapshot.rules) {
    const parsed = compiledRuleSchema.safeParse(rule.compiledTrigger)
    if (parsed.success)
      out.push({ id: rule.id, name: rule.name, rule: parsed.data })
  }
  return out
}

/** 快照里选了、但没有确认过的规则（这次运行不执行） */
export function inactiveRules(snapshot: SessionSnapshot) {
  return snapshot.rules.filter(
    (rule) => !compiledRuleSchema.safeParse(rule.compiledTrigger).success
  )
}

/** 规则里的工具 id 命中：完全相同；写「browser」表示整组浏览器工具 */
export function toolMatches(toolIds: readonly string[], toolId: string) {
  return toolIds.some(
    (id) => id === toolId || (id === "browser" && toolId.startsWith("browser."))
  )
}

const URL_KEYS = ["url", "href", "link", "targetUrl", "target_url", "uri"]

/** 这次调用要访问的网址：参数里叫 url / href / link… 的字段；HTTP 工具按模板填好参数后的地址 */
export function urlsOf(
  snapshot: SessionSnapshot,
  toolId: string,
  input: unknown
): string[] {
  const urls: string[] = []
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  for (const key of URL_KEYS) {
    const value = record[key]
    if (typeof value === "string" && /^[a-z][a-z0-9+.-]*:/i.test(value.trim()))
      urls.push(value.trim())
  }
  const http = snapshot.tools.find((tool) => tool.id === toolId)?.http
  // 和真正发请求时同一套填法（tools/http.ts），参数按给模型的键取
  if (http) urls.push(httpUrlOf(http, record))
  return urls
}

/** 网址在不在规则的白名单里：只管 http(s)，about:blank 这类本地页面不算 */
function outsideAllowlist(url: string, domains: readonly string[]) {
  const parsed = parseUrl(url)
  if (!parsed) return undefined
  if (parsed.scheme !== "http:" && parsed.scheme !== "https:") return undefined
  if (!parsed.host) return undefined
  if (domains.some((domain) => hostMatches(parsed.host, domain)))
    return undefined
  return parsed.host
}

// ---------- 动作 ----------

/** 规则里的「交给谁 / 通知谁」→ 员工 id。指定的人找不到（删了、停用了）就交给任务负责人 */
export async function recipientIds(
  db: DbLike,
  snapshot: SessionSnapshot,
  recipient: RuleRecipient,
  single: boolean
): Promise<string[]> {
  if (recipient.to === "owner") return [snapshot.task.ownerId]
  if (recipient.to === "user") {
    const [row] = await db
      .select({ id: t.users.id, banned: t.users.banned })
      .from(t.users)
      .where(eq(t.users.id, recipient.userId))
    return row && !row.banned ? [row.id] : [snapshot.task.ownerId]
  }
  const admins = await db
    .select({ id: t.users.id, banned: t.users.banned })
    .from(t.users)
    .where(eq(t.users.role, "admin"))
    .orderBy(asc(t.users.createdAt))
  const active = admins.filter((row) => !row.banned).map((row) => row.id)
  if (active.length === 0) return [snapshot.task.ownerId]
  return single ? active.slice(0, 1) : active
}

async function staffName(db: DbLike, id: string) {
  const [row] = await db
    .select({ name: t.users.name })
    .from(t.users)
    .where(eq(t.users.id, id))
  return row?.name ?? id
}

export async function ruleEvent(
  db: DbLike,
  sessionId: string,
  rule: Pick<ActiveRule, "name">,
  title: string,
  extra: {
    detail?: string | null
    toolId?: string | null
    input?: string | null
  } = {}
) {
  await appendEvent(db, sessionId, {
    kind: "rule",
    title: `规则「${rule.name}」：${title}`,
    detail: extra.detail ?? null,
    toolId: extra.toolId ?? null,
    input: extra.input ?? null,
  })
}

async function screenshotAction(
  ctx: RunContext,
  rule: ActiveRule,
  toolId?: string
) {
  const shot = await ctx.screenshot?.().catch(() => undefined)
  await ruleEvent(
    ctx.db,
    ctx.session.id,
    rule,
    shot ? "截图存证" : "要截图，但这次运行没有开着的浏览器，没截",
    { detail: shot ? `截图存为文件 ${shot.fileId}` : null, toolId }
  )
}

async function notifyAction(
  ctx: RunContext,
  rule: ActiveRule,
  action: Extract<RuleAction, { type: "notify" }>,
  what: string,
  toolId?: string
) {
  const { db, session, snapshot } = ctx
  const ids = await recipientIds(db, snapshot, action.recipient, false)
  await notifyUsers(db, {
    userIds: ids,
    title: `${snapshot.task.title}：规则「${rule.name}」`,
    body: what,
    link: sessionLink(snapshot.task.id, session.id),
    taskId: snapshot.task.id,
    sessionId: session.id,
  })
  const names = await Promise.all(ids.map((id) => staffName(db, id)))
  await ruleEvent(db, session.id, rule, `通知${names.join("、")}`, {
    detail: what,
    toolId,
  })
}

/** 不挡路的动作（截图、通知）：命中时马上做 */
async function sideActions(
  ctx: RunContext,
  rule: ActiveRule,
  what: string,
  toolId?: string
) {
  for (const action of rule.rule.actions) {
    if (action.type === "screenshot") await screenshotAction(ctx, rule, toolId)
    else if (action.type === "notify")
      await notifyAction(ctx, rule, action, what, toolId)
  }
}

async function markCostFired(db: Db, sessionId: string, ruleId: string) {
  await db
    .update(t.sessions)
    .set({
      ruleState: sql`jsonb_set(${t.sessions.ruleState}, '{costFired}', coalesce(${t.sessions.ruleState}->'costFired', '[]'::jsonb) || ${JSON.stringify([ruleId])}::jsonb)`,
    })
    .where(eq(t.sessions.id, sessionId))
}

class Rollback extends Error {}

// ---------- 钩子 ----------

export const ruleHook: EngineHook = {
  name: "rules",

  async onRunStart(ctx) {
    const inactive = inactiveRules(ctx.snapshot)
    if (inactive.length === 0) return
    await appendEvent(ctx.db, ctx.session.id, {
      kind: "rule",
      title: `${inactive.length} 条规则还没生效，这次运行不执行`,
      detail: `${inactive.map((rule) => `「${rule.name}」`).join("、")}：还没翻译或没有人确认过「系统理解为」，或者 v1 还不支持。到规则页确认后，下一次运行才会执行。`,
    })
  },

  /** 花费超过 X：每条规则每次运行只触发一次 */
  async beforeStep(ctx): Promise<BeforeStepDecision | void> {
    const { db, session, snapshot } = ctx
    const fired = new Set(session.ruleState?.costFired ?? [])
    for (const rule of activeRules(snapshot)) {
      const trigger = rule.rule.trigger
      if (trigger.type !== "cost_over" || fired.has(rule.id)) continue
      const cost = Number(session.costUsd)
      if (cost < trigger.usd) continue
      await markCostFired(db, session.id, rule.id)
      const what = `运行 ${session.id} 已经花了 ${cost.toFixed(4)} 美元，超过了规则里的 ${trigger.usd} 美元。`
      await ruleEvent(db, session.id, rule, `花费超过 ${trigger.usd} 美元`, {
        detail: what,
      })
      await sideActions(ctx, rule, what)
      const deny = rule.rule.actions.find((action) => action.type === "deny")
      if (deny)
        return {
          action: "fail",
          reason: `规则「${rule.name}」：花费超过 ${trigger.usd} 美元，结束这次运行${deny.reason ? `（${deny.reason}）` : ""}`,
        }
      const ask = rule.rule.actions.find(
        (action) => action.type === "ask_human"
      )
      if (ask) {
        const [assigneeId] = await recipientIds(
          db,
          snapshot,
          ask.recipient,
          true
        )
        const title = `花费超过 ${trigger.usd} 美元，要不要继续`
        const summary = `${what}这是规则「${rule.name}」要求的。同意就接着跑，不同意就结束这次运行。`
        const detail: HumanDetail = {
          sections: [
            { title: "为什么到了你这里", text: summary },
            { title: "规则", text: `${rule.name}：${rule.rule.understood}` },
            { title: "任务", text: snapshot.task.title },
          ],
          primary: "继续",
          secondary: "不继续",
          pay: [
            "确定继续花钱吗？",
            "同意后这次运行会接着调用模型，继续产生花费。",
          ],
        }
        const created = await db
          .transaction(async (tx) => {
            const result = await askHumanInTx(db, tx, {
              kind: "approval",
              title,
              summary,
              assigneeId: assigneeId!,
              taskId: snapshot.task.id,
              sessionId: session.id,
              ruleId: rule.id,
              urgency: 1,
              detail,
              what: title,
              stopOnReject: rule.id,
            })
            if (!result) throw new Rollback()
            return result
          })
          .catch((error) => {
            if (error instanceof Rollback) return undefined
            throw error
          })
        if (created) {
          const [item] = await db
            .select()
            .from(t.humanItems)
            .where(eq(t.humanItems.id, created.itemId))
          if (item) await notifyAssignee(db, item)
        }
        return { action: "suspended" }
      }
    }
  },

  async beforeTool(ctx): Promise<BeforeToolDecision | void> {
    const rules = activeRules(ctx.snapshot)
    if (rules.length === 0) return
    const approved = new Set(ctx.approvedRuleIds ?? [])
    const label = ctx.toolName ?? ctx.toolId
    let deny: { rule: ActiveRule; reason: string } | undefined
    let ask:
      { rule: ActiveRule; recipient: RuleRecipient; why: string } | undefined
    for (const rule of rules) {
      // 人已经批准过这次调用的规则：截图、通知在拦下时已经做过，这次整条跳过
      if (approved.has(rule.id)) continue
      const trigger = rule.rule.trigger
      let why: string | undefined
      if (trigger.type === "before_tool") {
        if (toolMatches(trigger.toolIds, ctx.toolId))
          why = `要调用 ${label}（${ctx.toolId}）`
        else if (ctx.risk && riskMatches(trigger.risks, ctx.risk))
          why = `要调用 ${label}（${ctx.toolId}，风险等级：${ctx.risk === "money" ? "涉及金钱" : "对外发送"}）`
      } else if (trigger.type === "url_not_allowed") {
        const host = urlsOf(ctx.snapshot, ctx.toolId, ctx.input)
          .map((url) => outsideAllowlist(url, trigger.domains))
          .find(Boolean)
        if (host)
          why = `要打开的 ${host} 不在白名单（${trigger.domains.join("、")}）里`
      } else if (trigger.type === "agent_proposes") {
        if (
          (ctx.toolId === "memory.propose" &&
            trigger.what.includes("memory")) ||
          (ctx.toolId === "skill.propose" && trigger.what.includes("skill"))
        )
          why =
            ctx.toolId === "memory.propose"
              ? "agent 要提议记忆"
              : "agent 要提议修改技能"
      }
      if (!why) continue
      await sideActions(ctx, rule, `${why}。`, ctx.toolId)
      for (const action of rule.rule.actions) {
        if (action.type === "deny" && !deny)
          deny = {
            rule,
            reason: `${why}。${action.reason || `规则「${rule.name}」不允许`}`,
          }
        if (action.type === "ask_human" && !ask)
          ask = { rule, recipient: action.recipient, why }
      }
    }
    if (deny)
      return {
        action: "deny",
        reason: deny.reason,
        ruleId: deny.rule.id,
        ruleName: deny.rule.name,
      }
    if (ask) {
      const [assigneeId] = await recipientIds(
        ctx.db,
        ctx.snapshot,
        ask.recipient,
        true
      )
      return {
        action: "ask_human",
        ruleId: ask.rule.id,
        ruleName: ask.rule.name,
        assigneeId: assigneeId!,
        reason: `${ask.why}。规则「${ask.rule.name}」要求先交给${recipientText(ask.recipient)}审批。`,
      }
    }
  },

  async afterTool(ctx) {
    const rules = activeRules(ctx.snapshot)
    if (rules.length === 0) return
    const { outcome } = ctx
    const label = ctx.toolName ?? ctx.toolId
    let sync: ActiveRule | undefined
    for (const rule of rules) {
      const trigger = rule.rule.trigger
      if (trigger.type === "page_needs_human") {
        if (!outcome.signals?.includes("page_needs_human")) continue
        await ruleEvent(
          ctx.db,
          ctx.session.id,
          rule,
          "页面出现验证码或登录页",
          {
            detail:
              "内置的「截图 + 交给人处理」照常进行，规则另外加了下面的动作。",
            toolId: ctx.toolId,
          }
        )
        await sideActions(
          ctx,
          rule,
          `运行 ${ctx.session.id} 调 ${label} 时遇到验证码或登录页，已经交给人处理。`,
          ctx.toolId
        )
        continue
      }
      if (outcome.isError) continue
      if (trigger.type === "after_tool") {
        if (!trigger.anyTool && !toolMatches(trigger.toolIds, ctx.toolId))
          continue
        // 内置的勾检查点、写步骤这类工具不算「干活」：任意工具时跳过它们，免得每勾一次就截图、通知
        if (trigger.anyTool && QUIET_TOOLS.has(ctx.toolId)) continue
        await sideActions(
          ctx,
          rule,
          `调用了 ${label}（${ctx.toolId}）。`,
          ctx.toolId
        )
        if (
          !sync &&
          rule.rule.actions.some((action) => action.type === "sync_checkpoint")
        )
          sync = rule
      } else if (trigger.type === "agent_proposes") {
        const hit =
          (ctx.toolId === "memory.propose" &&
            trigger.what.includes("memory")) ||
          (ctx.toolId === "skill.propose" && trigger.what.includes("skill"))
        if (!hit) continue
        // 拦下动作在调工具前已经处理过；这里只做通知
        for (const action of rule.rule.actions)
          if (action.type === "notify")
            await notifyAction(
              ctx,
              rule,
              action,
              `${outcome.output}（运行 ${ctx.session.id}）`,
              ctx.toolId
            )
      }
    }
    if (sync) await syncCheckpoints(ctx, sync.name)
  },

  async onFinish(ctx): Promise<FinishDecision | void> {
    let verify: ActiveRule | undefined
    for (const rule of activeRules(ctx.snapshot)) {
      if (rule.rule.trigger.type !== "agent_done") continue
      for (const action of rule.rule.actions)
        if (action.type === "notify")
          await notifyAction(
            ctx,
            rule,
            action,
            `agent 说做完了：${ctx.text.slice(0, 300) || "（没有总结）"}`
          )
      if (
        !verify &&
        rule.rule.actions.some((action) => action.type === "verify")
      )
        verify = rule
    }
    if (verify)
      return runVerification(ctx, { id: verify.id, name: verify.name })
  },
}

/** 「任意工具之后」不算在内的内置工具：只是记录、规划、挂起，不是在干活 */
const QUIET_TOOLS = new Set([
  "checkpoint.mark",
  "plan.set",
  "session.wait",
  "ask.human",
  "skill.load",
  "file.read",
  "file.list",
])
