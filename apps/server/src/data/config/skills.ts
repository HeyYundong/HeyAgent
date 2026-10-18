// 技能的写操作：新建（草稿）、改 SKILL.md（每次保存出一个新版本，写进 skill_versions）、发布 / 停用；
// agent 提的修改建议：批准（合并成新一版）或拒绝，同时处理掉待办里那件事。
import { and, desc, eq, inArray } from "drizzle-orm"
import { applySkillDiff, skillId, type Actor, type SkillStatus } from "@heyagent/shared"

import * as t from "../../db/schema.js"
import { assertCan, audit, badRequest, conflict, freeId, nextNo, notFound, slugOf, type DbOrTx, type Tx, type WriteCtx } from "./common.js"
import { tasksUsingRef, usedByText } from "./tasks.js"

export interface SkillFields {
  name: string
  dept: string
  description: string
  body: string
  toolIds: string[]
}

async function loadSkill(db: DbOrTx, id: string) {
  const [row] = await db.select().from(t.skills).where(eq(t.skills.id, id))
  if (!row) throw notFound("技能", id)
  return row
}

async function checkTools(db: DbOrTx, toolIds: string[]) {
  if (toolIds.length === 0) return
  const rows = await db.select({ id: t.tools.id }).from(t.tools).where(inArray(t.tools.id, toolIds))
  const missing = toolIds.filter((id) => !rows.some((row) => row.id === id))
  if (missing.length) throw badRequest(`找不到工具：${missing.join("、")}`)
}

async function writeTools(tx: Tx, id: string, toolIds: string[]) {
  await tx.delete(t.skillTools).where(eq(t.skillTools.skillId, id))
  const unique = [...new Set(toolIds)]
  if (unique.length) await tx.insert(t.skillTools).values(unique.map((toolId, position) => ({ skillId: id, toolId, position })))
}

/** 记一版：skills 表放当前版，skill_versions 留全部历史 */
async function saveVersion(tx: Tx, id: string, version: number, fields: SkillFields, actorId: string) {
  await tx.insert(t.skillVersions).values({ skillId: id, version, name: fields.name, description: fields.description, body: fields.body, toolIds: [...new Set(fields.toolIds)], createdById: actorId })
}

/** 在调用方的事务里新建技能（草稿，第 1 版）。导入时也用它，建好后再发布 */
export async function insertSkill(tx: Tx, actor: Actor, input: SkillFields, auditDetail: Record<string, unknown> = {}) {
  await checkTools(tx, input.toolIds)
  const slug = slugOf(input.name)
  // 编号的也要查重：英文短名可能恰好是数字，和序列号撞上
  const id = await freeId(
    async (each) => (await tx.select({ id: t.skills.id }).from(t.skills).where(eq(t.skills.id, each))).length > 0,
    slug ? skillId(slug) : skillId(await nextNo(tx, "skill_no_seq"))
  )
  // 新建的先存为草稿，发布后建任务时才能选用
  await tx.insert(t.skills).values({ id, name: input.name, description: input.description, dept: input.dept, status: "draft", ownerId: actor.id, version: 1, body: input.body })
  await writeTools(tx, id, input.toolIds)
  await saveVersion(tx, id, 1, input, actor.id)
  await audit(tx, actor.id, "skill.create", "skills", id, { name: input.name, version: 1, ...auditDetail })
  return { id, version: 1 }
}

export async function createSkill(ctx: WriteCtx, input: SkillFields) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能新建技能")
  return ctx.db.transaction((tx) => insertSkill(tx, ctx.actor, input))
}

/** 在调用方的事务里把技能存成新一版（导入「更新成新一版」、撤销导入时恢复旧内容也用它） */
export async function saveSkillVersion(tx: Tx, actor: Actor, input: SkillFields & { id: string }, auditDetail: Record<string, unknown> = {}) {
  const before = await loadSkill(tx, input.id)
  await checkTools(tx, input.toolIds)
  const version = before.version + 1
  await tx.update(t.skills).set({ name: input.name, description: input.description, dept: input.dept, body: input.body, version }).where(eq(t.skills.id, input.id))
  await writeTools(tx, input.id, input.toolIds)
  await saveVersion(tx, input.id, version, input, actor.id)
  const changed = (["name", "description", "dept", "body"] as const).filter((key) => before[key] !== input[key])
  await audit(tx, actor.id, "skill.update", "skills", input.id, { version, changed, ...auditDetail })
  return { id: input.id, version }
}

export async function updateSkill(ctx: WriteCtx, input: SkillFields & { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能修改技能")
  return ctx.db.transaction((tx) => saveSkillVersion(tx, ctx.actor, input))
}

/** 在调用方的事务里改技能状态（规则同 setSkillStatus） */
export async function changeSkillStatus(tx: Tx, actor: Actor, input: { id: string; status: SkillStatus }, auditDetail: Record<string, unknown> = {}) {
  const before = await loadSkill(tx, input.id)
  if (before.status === input.status) return { id: input.id, status: input.status }
  if (input.status !== "published") {
    const used = await tasksUsingRef(tx, t.taskSkills, [input.id])
    if (used.length) throw conflict(`这个技能正被 ${used.length} 个任务选用：${usedByText(used)}。先在这些任务里去掉它，再停用。`)
  }
  await tx.update(t.skills).set({ status: input.status }).where(eq(t.skills.id, input.id))
  const action = input.status === "published" ? "skill.publish" : input.status === "disabled" ? "skill.disable" : "skill.draft"
  await audit(tx, actor.id, action, "skills", input.id, { from: before.status, ...auditDetail })
  return { id: input.id, status: input.status }
}

/** 发布 / 停用 / 改回草稿。停用或改回草稿时，选用它的任务下一次运行就用不到了，所以被选用时不让停用 */
export async function setSkillStatus(ctx: WriteCtx, input: { id: string; status: SkillStatus }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能发布或停用技能")
  return ctx.db.transaction((tx) => changeSkillStatus(tx, ctx.actor, input))
}

async function pendingSuggestion(tx: Tx, skillIdValue: string) {
  const [row] = await tx
    .select()
    .from(t.skillSuggestions)
    .where(and(eq(t.skillSuggestions.skillId, skillIdValue), eq(t.skillSuggestions.status, "pending")))
    .orderBy(desc(t.skillSuggestions.createdAt))
    .limit(1)
  if (!row) throw conflict("这个技能现在没有待审核的修改建议")
  return row
}

async function resolveItem(tx: Tx, humanItemId: string | null, actorId: string, resolution: Record<string, unknown>) {
  if (!humanItemId) return
  await tx
    .update(t.humanItems)
    .set({ status: "resolved", resolution, resolvedById: actorId, resolvedAt: new Date() })
    .where(and(eq(t.humanItems.id, humanItemId), eq(t.humanItems.status, "open")))
}

/** 批准 agent 的修改建议：把 diff 合并进正文，记为新一版 */
export async function acceptSkillSuggestion(ctx: WriteCtx, input: { id: string }) {
  return ctx.db.transaction(async (tx) => {
    const skill = await loadSkill(tx, input.id)
    const suggestion = await pendingSuggestion(tx, input.id)
    assertCan(ctx.actor, "humanItem.resolve", { assigneeId: suggestion.reviewerId }, "这条修改建议不是分给你审核的")
    const body = applySkillDiff(skill.body, suggestion.diff ?? [])
    if (body === null) throw conflict("技能在这条建议之后又被改过，建议里的改动对不上了。请拒绝这条建议，再手动编辑技能。")
    const version = skill.version + 1
    const toolIds = (await tx.select({ id: t.skillTools.toolId }).from(t.skillTools).where(eq(t.skillTools.skillId, input.id))).map((row) => row.id)
    await tx.update(t.skills).set({ body, version }).where(eq(t.skills.id, input.id))
    await saveVersion(tx, input.id, version, { name: skill.name, description: skill.description, dept: skill.dept, body, toolIds }, ctx.actor.id)
    await tx.update(t.skillSuggestions).set({ status: "accepted", resolvedAt: new Date() }).where(eq(t.skillSuggestions.id, suggestion.id))
    await resolveItem(tx, suggestion.humanItemId, ctx.actor.id, { how: "primary" })
    await audit(tx, ctx.actor.id, "skill.suggestion.accept", "skills", input.id, { suggestionId: suggestion.id, version, humanItemId: suggestion.humanItemId })
    return { id: input.id, version }
  })
}

export async function rejectSkillSuggestion(ctx: WriteCtx, input: { id: string; reason?: string }) {
  return ctx.db.transaction(async (tx) => {
    await loadSkill(tx, input.id)
    const suggestion = await pendingSuggestion(tx, input.id)
    assertCan(ctx.actor, "humanItem.resolve", { assigneeId: suggestion.reviewerId }, "这条修改建议不是分给你审核的")
    await tx.update(t.skillSuggestions).set({ status: "rejected", resolvedAt: new Date() }).where(eq(t.skillSuggestions.id, suggestion.id))
    await resolveItem(tx, suggestion.humanItemId, ctx.actor.id, { how: "reject", ...(input.reason ? { reason: input.reason } : {}) })
    await audit(tx, ctx.actor.id, "skill.suggestion.reject", "skills", input.id, { suggestionId: suggestion.id, ...(input.reason ? { reason: input.reason } : {}) })
    return { id: input.id }
  })
}
