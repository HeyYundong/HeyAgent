// 规则的写操作：新建、修改、删除（没人用的直接删，页面上可以撤销；被任务用着的不能删）、翻译、确认（M3）。
// 规则的生效流程：保存文字 → rules.compile 用「规划」模型翻译（结果存成待确认）→ 人看「系统理解为……」→ rules.confirm 才生效。
// 文字改了：之前的翻译作废；已经确认过的旧版本继续执行，直到新文字翻译并确认（免得改一个字规则就失效）。
import { TRPCError } from "@trpc/server"
import { eq, inArray } from "drizzle-orm"
import { compiledRuleSchema, ruleId, type RuleCompileInput, type RuleCompileResult, type RuleRef } from "@heyagent/shared"

import { compileRuleText } from "../../engine/rule-compile.js"
import { EngineError } from "../../engine/sessions.js"

import * as t from "../../db/schema.js"
import { assertCan, audit, badRequest, conflict, freeId, nextNo, notFound, slugOf, type DbOrTx, type Tx, type WriteCtx } from "./common.js"
import { tasksUsingRef, usedByText } from "./tasks.js"

interface RuleFields {
  name: string
  trigger: string
  action: string
  toolIds: string[]
}

async function checkTools(db: DbOrTx, toolIds: string[]) {
  if (toolIds.length === 0) return
  const rows = await db.select({ id: t.tools.id }).from(t.tools).where(inArray(t.tools.id, toolIds))
  const missing = toolIds.filter((id) => !rows.some((row) => row.id === id))
  if (missing.length) throw badRequest(`找不到工具：${missing.join("、")}`)
}

async function writeTools(tx: Tx, id: string, toolIds: string[]) {
  await tx.delete(t.ruleTools).where(eq(t.ruleTools.ruleId, id))
  const unique = [...new Set(toolIds)]
  if (unique.length) await tx.insert(t.ruleTools).values(unique.map((toolId, position) => ({ ruleId: id, toolId, position })))
}

const ruleExists = (tx: DbOrTx) => async (id: string) => (await tx.select({ id: t.rules.id }).from(t.rules).where(eq(t.rules.id, id))).length > 0

export async function createRule(ctx: WriteCtx, input: RuleFields) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能新建规则")
  return ctx.db.transaction(async (tx) => {
    await checkTools(tx, input.toolIds)
    const slug = slugOf(input.name)
    const id = slug ? await freeId(ruleExists(tx), ruleId(slug)) : ruleId(await nextNo(tx, "rule_no_seq"))
    await tx.insert(t.rules).values({ id, name: input.name, trigger: input.trigger, action: input.action, createdById: ctx.actor.id })
    await writeTools(tx, id, input.toolIds)
    await audit(tx, ctx.actor.id, "rule.create", "rules", id, { name: input.name })
    return { id }
  })
}

export async function updateRule(ctx: WriteCtx, input: RuleFields & { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能修改规则")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.rules).where(eq(t.rules.id, input.id))
    if (!before) throw notFound("规则", input.id)
    await checkTools(tx, input.toolIds)
    // 文字改了：之前的翻译（待确认的）作废，要重新翻译、确认；已经确认过的旧版本继续执行，直到新版本确认
    const textChanged = before.trigger !== input.trigger || before.action !== input.action
    await tx
      .update(t.rules)
      .set({ name: input.name, trigger: input.trigger, action: input.action, ...(textChanged ? { compileDraft: null } : {}) })
      .where(eq(t.rules.id, input.id))
    await writeTools(tx, input.id, input.toolIds)
    await audit(tx, ctx.actor.id, "rule.update", "rules", input.id, { changed: (["name", "trigger", "action"] as const).filter((key) => before[key] !== input[key]) })
    return { id: input.id }
  })
}

/** 删除：被任务用着的不能删。返回删掉的规则，页面上「撤销」时原样建回来 */
export async function deleteRule(ctx: WriteCtx, input: { id: string }): Promise<RuleRef> {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能删除规则")
  return ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.rules).where(eq(t.rules.id, input.id))
    if (!before) throw notFound("规则", input.id)
    const used = await tasksUsingRef(tx, t.taskRules, [input.id])
    if (used.length) throw conflict(`规则「${before.name}」正被 ${used.length} 个任务选用：${usedByText(used)}。先在这些任务里去掉它，再删除。`)
    const toolIds = (await tx.select({ id: t.ruleTools.toolId }).from(t.ruleTools).where(eq(t.ruleTools.ruleId, input.id))).map((row) => row.id)
    await tx.delete(t.rules).where(eq(t.rules.id, input.id))
    await audit(tx, ctx.actor.id, "rule.delete", "rules", input.id, { name: before.name })
    return { id: before.id, name: before.name, trigger: before.trigger, action: before.action, toolIds }
  })
}

/** 撤销删除：照原样（含 id）建回来 */
export async function restoreRule(ctx: WriteCtx, input: RuleFields & { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能恢复规则")
  return ctx.db.transaction(async (tx) => {
    if (await ruleExists(tx)(input.id)) throw conflict(`规则 ${input.id} 已经存在`)
    const tools = input.toolIds.length ? (await tx.select({ id: t.tools.id }).from(t.tools).where(inArray(t.tools.id, input.toolIds))).map((row) => row.id) : []
    await tx.insert(t.rules).values({ id: input.id, name: input.name, trigger: input.trigger, action: input.action, createdById: ctx.actor.id })
    await writeTools(tx, input.id, input.toolIds.filter((id) => tools.includes(id)))
    await audit(tx, ctx.actor.id, "rule.restore", "rules", input.id, { name: input.name })
    return { id: input.id }
  })
}

/** 正在执行的版本是按哪段文字确认的（compiled_text 存的 JSON） */
export function parseCompiledText(value: string | null): { trigger: string; action: string } | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as { trigger?: unknown; action?: unknown }
    if (typeof parsed.trigger === "string" && typeof parsed.action === "string") return { trigger: parsed.trigger, action: parsed.action }
  } catch {
    // 不是 JSON 的老数据：当作对不上
  }
  return undefined
}

function engineError(error: unknown): never {
  if (error instanceof EngineError) throw new TRPCError({ code: error.code, message: error.message })
  throw error
}

/**
 * 翻译规则（M3）：给 id 就翻译这条规则现在的文字，结果存成待确认（compile_draft）；只给文字就只预览，不存。
 * 要调模型（花钱），所以只有主管能调。翻译不进去的返回 supported = false 和原因，规则保存为「未生效（v1 还不支持）」
 */
export async function compileRule(ctx: WriteCtx, input: RuleCompileInput): Promise<RuleCompileResult> {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能翻译规则")
  let text: { trigger: string; action: string; toolIds: string[] }
  if (input.id) {
    const [row] = await ctx.db.select().from(t.rules).where(eq(t.rules.id, input.id))
    if (!row) throw notFound("规则", input.id)
    const toolIds = (await ctx.db.select({ id: t.ruleTools.toolId }).from(t.ruleTools).where(eq(t.ruleTools.ruleId, row.id))).map((link) => link.id)
    text = { trigger: row.trigger, action: row.action, toolIds }
  } else {
    text = { trigger: input.trigger!, action: input.action!, toolIds: input.toolIds ?? [] }
  }
  const { result, costUsd } = await compileRuleText(ctx.db, text).catch(engineError)
  if (input.id) {
    const id = input.id
    await ctx.db.transaction(async (tx) => {
      // 翻译期间文字被改了：结果对不上，不存
      const [row] = await tx.select({ trigger: t.rules.trigger, action: t.rules.action }).from(t.rules).where(eq(t.rules.id, id))
      if (!row || row.trigger !== text.trigger || row.action !== text.action) throw conflict("翻译期间规则被改过了，请重新翻译")
      await tx.update(t.rules).set({ compileDraft: result }).where(eq(t.rules.id, id))
      await audit(tx, ctx.actor.id, "rule.compile", "rules", id, { supported: result.supported, understood: result.understood, modelId: result.modelId, costUsd })
    })
  }
  return result
}

/** 确认「系统理解为……」（M3）：把待确认的翻译设为正在执行的版本。已经在跑的运行不受影响（它们有自己的快照） */
export async function confirmRule(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能确认规则")
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(t.rules).where(eq(t.rules.id, input.id))
    if (!row) throw notFound("规则", input.id)
    const draft = row.compileDraft
    if (!draft || draft.trigger !== row.trigger || draft.action !== row.action) throw badRequest("这条规则现在的文字还没有翻译，先翻译再确认")
    if (!draft.supported || !draft.compiled) throw badRequest(`这条规则 v1 还不支持，不能确认：${draft.reason ?? ""}`)
    const compiled = compiledRuleSchema.parse(draft.compiled)
    await tx
      .update(t.rules)
      .set({ compiledTrigger: compiled, compiledText: JSON.stringify({ trigger: row.trigger, action: row.action }), confirmedById: ctx.actor.id, confirmedAt: new Date() })
      .where(eq(t.rules.id, row.id))
    await audit(tx, ctx.actor.id, "rule.confirm", "rules", row.id, { understood: compiled.understood, compiled })
    return { id: row.id, understood: compiled.understood }
  })
}
