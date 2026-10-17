// 规则的写操作：新建、修改、删除（没人用的直接删，页面上可以撤销；被任务用着的不能删）。
// M1 只存文字：触发条件翻译成程序能判断的条件是 M3 的事。
import { eq, inArray } from "drizzle-orm"
import { ruleId, type RuleRef } from "@heyagent/shared"

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
    // 文字改了，之前翻译好的触发条件就作废了（M3 重新翻译）
    const textChanged = before.trigger !== input.trigger
    await tx
      .update(t.rules)
      .set({ name: input.name, trigger: input.trigger, action: input.action, ...(textChanged ? { compiledTrigger: null } : {}) })
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
