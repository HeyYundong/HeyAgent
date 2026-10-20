// 任务的写操作：新建、修改、启停、删除。保存后调引擎的 syncTaskSchedule（定时触发由引擎管）。
import { and, count, eq, inArray } from "drizzle-orm"
import { compiledRuleSchema, modelFamily, nextCronRun, ruleCompileStatusLabel, sameFamily, taskId, type Actor, type TaskStep, type taskInputSchema } from "@heyagent/shared"
import type { z } from "zod"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { syncTaskSchedule } from "../../engine/api.js"
import { sendPumpInTx } from "../../engine/dispatch/signal.js"
import { assertCan, audit, badRequest, conflict, nextNo, notFound, type DbOrTx, type Tx, type WriteCtx } from "./common.js"

export type TaskInput = z.output<typeof taskInputSchema>

async function defaultModel(db: DbOrTx, role: "run" | "verify") {
  const [row] = await db.select({ modelId: t.modelDefaults.modelId }).from(t.modelDefaults).where(eq(t.modelDefaults.role, role))
  return row?.modelId
}

/**
 * 检查模型和关联的配置都存在；执行模型不许和验收模型同一家。
 * 规则（M3）：新选上的规则必须已经生效（人确认过翻译）；原来就选着的规则保留（文字改过还没重新确认的，运行时照旧版本执行）
 */
async function checkTask(db: DbOrTx, input: TaskInput, previousRuleIds: string[] = [], selfId?: string) {
  const modelId = input.modelId || (await defaultModel(db, "run"))
  if (!modelId) throw badRequest("还没有可用的模型：先去「模型」页接入模型服务并设置默认模型")
  const [model] = await db.select({ id: t.models.id, name: t.models.name, kind: t.models.kind }).from(t.models).where(eq(t.models.id, modelId))
  if (!model) throw badRequest(`模型 ${modelId} 不存在（可能刷新模型列表后下架了），请换一个`)
  if (model.kind !== "chat") throw badRequest(`${modelId} 是 embedding 模型，不能用来执行任务，请换一个`)
  const verifyModelId = input.verifyModelId || null
  if (verifyModelId) {
    const [found] = await db.select({ id: t.models.id, kind: t.models.kind }).from(t.models).where(eq(t.models.id, verifyModelId))
    if (!found) throw badRequest(`验收模型 ${verifyModelId} 不存在，请换一个`)
    if (found.kind !== "chat") throw badRequest(`${verifyModelId} 是 embedding 模型，不能用来验收，请换一个`)
    if (sameFamily(modelId, verifyModelId))
      throw badRequest(`执行模型和这个任务选的验收模型是同一家（${modelFamily(modelId)}），验收就不算第三方了。换一个执行模型或验收模型。`)
  } else {
    const verify = await defaultModel(db, "verify")
    if (verify && sameFamily(modelId, verify)) {
      throw badRequest(`执行模型和三方验收模型是同一家（${modelFamily(modelId)}），验收就不算第三方了。换一个执行模型，或去「模型」页换验收模型。`)
    }
  }
  // 复核模型（run-outcome）：要是聊天模型；不要求和执行模型不同家（这不是三方验收）
  const reviewModelId = input.reviewModelId || null
  if (reviewModelId) {
    const [found] = await db.select({ id: t.models.id, kind: t.models.kind }).from(t.models).where(eq(t.models.id, reviewModelId))
    if (!found) throw badRequest(`复核模型 ${reviewModelId} 不存在，请换一个`)
    if (found.kind !== "chat") throw badRequest(`${reviewModelId} 是 embedding 模型，不能用来复核，请换一个`)
  }
  const dispatchFrom = await checkDispatchSources(db, input.dispatchFrom, selfId)
  const exist = async (table: typeof t.memories | typeof t.skills | typeof t.rules | typeof t.tools, list: string[], what: string) => {
    if (list.length === 0) return
    const rows = await db.select({ id: table.id }).from(table).where(inArray(table.id, list))
    const missing = list.filter((id) => !rows.some((row) => row.id === id))
    if (missing.length) throw badRequest(`找不到${what}：${missing.join("、")}`)
  }
  await exist(t.memories, input.memoryIds, "记忆")
  await exist(t.skills, input.skillIds, "技能")
  await exist(t.rules, input.ruleIds, "规则")
  const added = input.ruleIds.filter((id) => !previousRuleIds.includes(id))
  if (added.length) {
    const rows = await db.select({ id: t.rules.id, name: t.rules.name, compiledTrigger: t.rules.compiledTrigger, compileDraft: t.rules.compileDraft }).from(t.rules).where(inArray(t.rules.id, added))
    const inactive = rows.filter((row) => !compiledRuleSchema.safeParse(row.compiledTrigger).success)
    if (inactive.length)
      throw badRequest(
        `这些规则还没生效，不能选：${inactive
          .map((row) => `「${row.name}」（${row.compileDraft ? (row.compileDraft.supported ? ruleCompileStatusLabel.pending : `${ruleCompileStatusLabel.unsupported}：${row.compileDraft.reason ?? ""}`) : ruleCompileStatusLabel.untranslated}）`)
          .join("、")}。先到规则页翻译并确认「系统理解为」。`
      )
  }
  await exist(t.tools, input.toolIds, "工具")
  if (input.browserProfileIds.length) {
    const rows = await db.select({ id: t.browserProfiles.id }).from(t.browserProfiles).where(inArray(t.browserProfiles.id, input.browserProfileIds))
    const missing = input.browserProfileIds.filter((id) => !rows.some((row) => row.id === id))
    if (missing.length) throw badRequest(`找不到 Chrome 配置：${missing.join("、")}`)
  }
  // 每个任务都自带的工具不用存关联
  const alwaysOn = input.toolIds.length
    ? (await db.select({ id: t.tools.id }).from(t.tools).where(and(inArray(t.tools.id, input.toolIds), eq(t.tools.alwaysOn, true)))).map((row) => row.id)
    : []
  return { modelId, verifyModelId, reviewModelId, toolIds: input.toolIds.filter((id) => !alwaysOn.includes(id)), dispatchFrom }
}

/** 派活：谁能派活给它（必须存在、不能是自己）。返回去重后的 */
async function checkDispatchSources(db: DbOrTx, sourceIds: string[], selfId?: string) {
  const dispatchFrom = [...new Set(sourceIds)]
  if (selfId && dispatchFrom.includes(selfId)) throw badRequest("「谁能派活给它」里不能选这个任务自己")
  if (dispatchFrom.length) {
    const rows = await db.select({ id: t.tasks.id }).from(t.tasks).where(inArray(t.tasks.id, dispatchFrom))
    const missing = dispatchFrom.filter((id) => !rows.some((row) => row.id === id))
    if (missing.length) throw badRequest(`「谁能派活给它」里的任务不存在：${missing.join("、")}`)
  }
  return dispatchFrom
}

/**
 * 在调用方的事务里改「谁能派活给它」（先删后插），校验同 checkTask。
 * 导入（imports/commit.ts）全部任务建完以后再连：派活方可能排在被派的任务后面
 */
export async function setDispatchSources(tx: Tx, taskId: string, sourceIds: string[]) {
  const dispatchFrom = await checkDispatchSources(tx, sourceIds, taskId)
  await tx.delete(t.taskDispatchSources).where(eq(t.taskDispatchSources.taskId, taskId))
  if (dispatchFrom.length) await tx.insert(t.taskDispatchSources).values(dispatchFrom.map((sourceTaskId) => ({ taskId, sourceTaskId })))
}

function columns(input: TaskInput, modelId: string, verifyModelId: string | null, reviewModelId: string | null) {
  const steps = input.steps.map((step, index) => ({
    id: step.id || `s${index + 1}`,
    text: step.text,
    wait: step.wait,
    ...(step.checkpoint ? { checkpoint: step.checkpoint } : {}),
  }))
  // 步骤 id 要唯一：检查点按 stepId 关联
  const seen = new Set<string>()
  for (const step of steps) {
    if (seen.has(step.id)) step.id = `${step.id}-${seen.size + 1}`
    seen.add(step.id)
  }
  const schedule = input.schedule
  return {
    title: input.title,
    goal: input.goal,
    steps,
    modelId,
    enabled: input.enabled,
    scheduleCron: schedule?.cron ?? null,
    scheduleText: schedule ? schedule.text || schedule.cron : null,
    nextRunAt: schedule && input.enabled ? new Date(nextCronRun(schedule.cron)!) : null,
    browserProfileIds: [...new Set(input.browserProfileIds)],
    allowedDomains: [...new Set(input.allowedDomains)],
    allowBrowserEvaluate: input.allowBrowserEvaluate,
    verifyModelId,
    reviewEnabled: input.reviewEnabled,
    reviewModelId,
    // 派活：参数声明和名额（已经按 shared 的 taskDispatchSchema 校验过：参数名不重复）；null = 不能被派活
    dispatch: input.dispatch ?? null,
    cronSkipIfRunning: input.cronSkipIfRunning,
  }
}

async function writeLinks(tx: Tx, id: string, input: { memoryIds: string[]; skillIds: string[]; toolIds: string[]; ruleIds: string[]; dispatchFrom: string[] }) {
  const links = [
    [t.taskMemories, input.memoryIds],
    [t.taskSkills, input.skillIds],
    [t.taskTools, input.toolIds],
    [t.taskRules, input.ruleIds],
  ] as const
  for (const [table, list] of links) {
    await tx.delete(table).where(eq(table.taskId, id))
    const unique = [...new Set(list)]
    if (unique.length) await tx.insert(table).values(unique.map((refId, position) => ({ taskId: id, refId, position })))
  }
  await tx.delete(t.taskDispatchSources).where(eq(t.taskDispatchSources.taskId, id))
  if (input.dispatchFrom.length) await tx.insert(t.taskDispatchSources).values(input.dispatchFrom.map((sourceTaskId) => ({ taskId: id, sourceTaskId })))
}

async function loadTask(db: DbOrTx, id: string) {
  const [row] = await db.select().from(t.tasks).where(eq(t.tasks.id, id))
  if (!row) throw notFound("任务", id)
  return row
}

/**
 * 在调用方的事务里新建任务（全部校验照 checkTask）。导入（imports/commit.ts）一个事务里建好多样东西时也用它。
 * allowInactiveRuleIds：允许选上还没生效的规则——导入时新建、要用到这次才导入的工具、导入后才能翻译确认的规则；
 * 运行时引擎只执行确认过的规则（engine/rules.ts 的 activeRules），确认以后自动生效。调用方事务提交后要调 syncTaskSchedule
 */
export async function insertTask(tx: Tx, actor: Actor, input: TaskInput, options: { allowInactiveRuleIds?: string[]; audit?: Record<string, unknown> } = {}): Promise<string> {
  const ownerId = input.ownerId || actor.id
  const { modelId, verifyModelId, reviewModelId, toolIds, dispatchFrom } = await checkTask(tx, input, options.allowInactiveRuleIds ?? [])
  const [owner] = await tx.select({ id: t.users.id }).from(t.users).where(eq(t.users.id, ownerId))
  if (!owner) throw badRequest("负责人不存在")
  const id = taskId(await nextNo(tx, "task_no_seq"))
  await tx.insert(t.tasks).values({ id, ownerId, ...columns(input, modelId, verifyModelId, reviewModelId) })
  await writeLinks(tx, id, { ...input, toolIds, dispatchFrom })
  await audit(tx, actor.id, "task.create", "tasks", id, { title: input.title, ownerId, modelId, ...options.audit })
  return id
}

export async function createTask(ctx: WriteCtx, input: TaskInput): Promise<{ id: string }> {
  assertCan(ctx.actor, "task.create", {}, "只有主管能新建任务")
  const id = await ctx.db.transaction((tx) => insertTask(tx, ctx.actor, input))
  await syncTaskSchedule(ctx.db, id)
  return { id }
}

export async function updateTask(ctx: WriteCtx, input: TaskInput & { id: string }): Promise<{ id: string }> {
  await ctx.db.transaction(async (tx) => {
    const before = await loadTask(tx, input.id)
    assertCan(ctx.actor, "task.manage", { ownerId: before.ownerId }, "只有负责人和主管能改这个任务")
    // 员工不能把任务转给别人
    const ownerId = ctx.actor.isAdmin && input.ownerId ? input.ownerId : before.ownerId
    const previousRuleIds = (await tx.select({ id: t.taskRules.refId }).from(t.taskRules).where(eq(t.taskRules.taskId, input.id))).map((row) => row.id)
    const { modelId, verifyModelId, reviewModelId, toolIds, dispatchFrom } = await checkTask(tx, input, previousRuleIds, input.id)
    const next = columns(input, modelId, verifyModelId, reviewModelId)
    await tx.update(t.tasks).set({ ...next, ownerId }).where(eq(t.tasks.id, input.id))
    await writeLinks(tx, input.id, { ...input, toolIds, dispatchFrom })
    // 能被派活（刚打开、调大名额、改了别的）：领一次单。关掉时排着的单留着不动，重新打开接着领
    if (next.dispatch && next.enabled) await sendPumpInTx(ctx.db, tx, input.id)
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((key) => JSON.stringify(before[key]) !== JSON.stringify(next[key]))
    await audit(tx, ctx.actor.id, "task.update", "tasks", input.id, { changed: [...changed, ...(ownerId !== before.ownerId ? ["ownerId"] : [])] })
  })
  await syncTaskSchedule(ctx.db, input.id)
  return { id: input.id }
}

export async function setTaskEnabled(ctx: WriteCtx, input: { id: string; enabled: boolean }) {
  await ctx.db.transaction(async (tx) => {
    const before = await loadTask(tx, input.id)
    assertCan(ctx.actor, "task.manage", { ownerId: before.ownerId }, "只有负责人和主管能启停这个任务")
    const nextRunAt = input.enabled && before.scheduleCron ? new Date(nextCronRun(before.scheduleCron) ?? Date.now()) : null
    await tx.update(t.tasks).set({ enabled: input.enabled, nextRunAt }).where(eq(t.tasks.id, input.id))
    // 重新启用能被派活的任务：接着领排着的单
    if (input.enabled && before.dispatch) await sendPumpInTx(ctx.db, tx, input.id)
    await audit(tx, ctx.actor.id, input.enabled ? "task.enable" : "task.disable", "tasks", input.id)
  })
  await syncTaskSchedule(ctx.db, input.id)
  return { id: input.id, enabled: input.enabled }
}

/**
 * 把一次运行里 agent 写下的步骤（plan.set）存成任务的步骤（M3）：整体覆盖原来的步骤（原来步骤上的检查点也一起换掉），记审计。
 * 负责人或主管能做（task.manage）。已经在跑的运行不受影响（它们有自己的快照）
 */
export async function saveStepsFromSession(ctx: WriteCtx, input: { sessionId: string }): Promise<{ id: string; steps: TaskStep[] }> {
  return ctx.db.transaction(async (tx) => {
    const [session] = await tx.select({ id: t.sessions.id, taskId: t.sessions.taskId, exploredSteps: t.sessions.exploredSteps }).from(t.sessions).where(eq(t.sessions.id, input.sessionId))
    if (!session) throw notFound("运行", input.sessionId)
    const before = await loadTask(tx, session.taskId)
    assertCan(ctx.actor, "task.manage", { ownerId: before.ownerId }, "只有任务负责人和主管能把步骤存到任务里")
    const explored = (session.exploredSteps ?? []).map((text) => text.trim()).filter(Boolean)
    if (explored.length === 0) throw badRequest("这次运行里 agent 没有写下步骤（plan.set），没有可存的")
    const steps: TaskStep[] = explored.slice(0, 50).map((text, index) => ({ id: `s${index + 1}`, text: text.slice(0, 500), wait: false }))
    await tx.update(t.tasks).set({ steps }).where(eq(t.tasks.id, before.id))
    await audit(tx, ctx.actor.id, "task.save_steps", "tasks", before.id, { sessionId: session.id, before: before.steps, after: steps })
    return { id: before.id, steps }
  })
}

/** 有运行记录、有派活单（作为被派的）的不能删（记录要留着查），只能停用 */
export async function deleteTask(ctx: WriteCtx, input: { id: string }) {
  await ctx.db.transaction(async (tx) => {
    const before = await loadTask(tx, input.id)
    assertCan(ctx.actor, "task.manage", { ownerId: before.ownerId }, "只有负责人和主管能删这个任务")
    const [items] = await tx.select({ n: count() }).from(t.workItems).where(eq(t.workItems.taskId, input.id))
    if ((items?.n ?? 0) > 0) throw conflict("这个任务有派活单，只能停用")
    const [runs] = await tx.select({ n: count() }).from(t.sessions).where(eq(t.sessions.taskId, input.id))
    if ((runs?.n ?? 0) > 0) throw conflict(`这个任务已经有 ${runs!.n} 次运行记录，不能删除（运行记录要留着查）。不想让它再运行，就把它停用。`)
    await tx.delete(t.tasks).where(eq(t.tasks.id, input.id))
    await audit(tx, ctx.actor.id, "task.delete", "tasks", input.id, { title: before.title })
  })
  await syncTaskSchedule(ctx.db, input.id)
  return { id: input.id }
}

/** 哪些任务用着某个配置（删除前检查，提示写清楚是哪些任务） */
export async function tasksUsingRef(db: Db | Tx, table: typeof t.taskMemories | typeof t.taskSkills | typeof t.taskTools | typeof t.taskRules, refIds: string[]) {
  if (refIds.length === 0) return []
  return db
    .selectDistinct({ id: t.tasks.id, title: t.tasks.title })
    .from(table)
    .innerJoin(t.tasks, eq(t.tasks.id, table.taskId))
    .where(inArray(table.refId, refIds))
}

export const usedByText = (tasks: { id: string; title: string }[]) => tasks.map((task) => `${task.id}「${task.title}」`).join("、")
