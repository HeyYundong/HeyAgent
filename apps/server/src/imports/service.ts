// 导入：把别的 agent 打的 zip 包交给 AI 读懂，整理成「导入方案」，主管一步步确认后一次导入（docs/dev/imports.md）。
// 这里是导入记录的读写和各个操作的入口；只有主管能用（导入会建任务和配置）。
// 读包（reader）、导入（commit）、撤销（undo）、导入后还要做的事（follow-ups）各自一个文件，由这里接线。
import { rm } from "node:fs/promises"

import { TRPCError } from "@trpc/server"
import { and, desc, eq, sql } from "drizzle-orm"
import {
  importStepSchema,
  planProblems,
  type ImportDetail,
  type ImportReadStep,
  type ImportRecord,
  type ImportSavePlanInput,
  type PlanRule,
} from "@heyagent/shared"

import * as t from "../db/schema.js"
import { assertCan, audit, badRequest, conflict, notFound, putSecret, type DbOrTx, type WriteCtx } from "../data/config/common.js"
import { importReadJobOptions, QUEUES, sendInTx } from "../engine/queue.js"
import { compileRuleText } from "../engine/rule-compile.js"
import { EngineError } from "../engine/sessions.js"
import { fileStorage, getFileRow } from "../files/service.js"
import { computeFollowUps } from "./follow-ups.js"
import { importDir } from "./limits.js"

type ImportRow = typeof t.imports.$inferSelect

const iso = (value: Date | null) => (value ? value.toISOString() : null)

export function toImportRecord(row: ImportRow): ImportRecord {
  return {
    id: row.id,
    fileName: row.fileName,
    size: row.size,
    fileCount: row.fileCount,
    name: row.name,
    note: row.note,
    modelId: row.modelId,
    status: row.status,
    costUsd: row.costUsd,
    error: row.error,
    createdById: row.createdById,
    createdAt: row.createdAt.toISOString(),
    readAt: iso(row.readAt),
    importedAt: iso(row.importedAt),
    importedById: row.importedById,
    undoneAt: iso(row.undoneAt),
  }
}

/** 读包用的模型：不传就用「规划」默认模型；传了要是库里有、能调工具的聊天模型。返回给人看的错误 */
export async function pickReadModel(db: DbOrTx, modelId?: string | null): Promise<{ modelId: string } | { error: string }> {
  let id = modelId?.trim()
  if (!id) {
    const [plan] = await db.select({ modelId: t.modelDefaults.modelId }).from(t.modelDefaults).where(eq(t.modelDefaults.role, "plan"))
    if (!plan) return { error: "还没有设置「规划」默认模型：先去「模型」页设置，或者选一个读包用的模型" }
    id = plan.modelId
  }
  const [model] = await db.select({ id: t.models.id, kind: t.models.kind }).from(t.models).where(eq(t.models.id, id))
  if (!model) return { error: `模型 ${id} 不存在（可能刷新模型列表后下架了），换一个` }
  if (model.kind !== "chat") return { error: `${id} 是 embedding 模型，不能读包，换一个能调工具的模型` }
  return { modelId: id }
}

export const assertCanImport = (ctx: Pick<WriteCtx, "actor">) => assertCan(ctx.actor, "config.manage", {}, "只有主管能导入")

export async function loadImport(db: DbOrTx, id: string): Promise<ImportRow> {
  const [row] = await db.select().from(t.imports).where(eq(t.imports.id, id))
  if (!row) throw notFound("导入", id)
  return row
}

export async function listImports(ctx: WriteCtx): Promise<ImportRecord[]> {
  assertCanImport(ctx)
  const rows = await ctx.db.select().from(t.imports).orderBy(desc(t.imports.createdAt))
  return rows.map(toImportRecord)
}

export async function getImport(ctx: WriteCtx, id: string): Promise<ImportDetail> {
  assertCanImport(ctx)
  const row = await loadImport(ctx.db, id)
  const step = importStepSchema.safeParse(row.step)
  return {
    ...toImportRecord(row),
    readLog: row.readLog,
    plan: row.plan,
    step: step.success ? step.data : "overview",
    visited: row.visited.flatMap((value) => {
      const parsed = importStepSchema.safeParse(value)
      return parsed.success ? [parsed.data] : []
    }),
    result: row.result,
    followUps: await computeFollowUps(ctx.db, row),
  }
}

/** 确认时的改动随时存：只有待确认的能存；方案自己要对得上（引用的 key 都在） */
export async function saveImportPlan(ctx: WriteCtx, input: ImportSavePlanInput) {
  assertCanImport(ctx)
  const problems = planProblems(input.plan)
  if (problems.length) throw badRequest(problems.slice(0, 3).join("；"))
  return ctx.db.transaction(async (tx) => {
    const row = await loadImport(tx, input.id)
    if (row.status !== "review") throw conflict("这次导入现在不是待确认，改动没有存")
    await tx.update(t.imports).set({ plan: input.plan, step: input.step, visited: input.visited }).where(eq(t.imports.id, input.id))
    return { id: input.id }
  })
}

/** 确认时填密钥的值：名字必须是方案要的；加密存进这次导入（scope = import），方案里只记 filled。值不进日志、审计 */
export async function setImportSecret(ctx: WriteCtx, input: { id: string; name: string; value: string }) {
  assertCanImport(ctx)
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(t.imports).where(eq(t.imports.id, input.id)).for("update")
    if (!row) throw notFound("导入", input.id)
    if (row.status !== "review" || !row.plan) throw conflict("这次导入现在不是待确认，不能填密钥")
    if (!row.plan.secrets.some((secret) => secret.name === input.name)) throw badRequest(`方案里没有要填的密钥 ${input.name}`)
    await putSecret(tx, ctx.keyring(), { scope: "import", refId: input.id, name: input.name }, input.value, ctx.actor.id)
    const plan = { ...row.plan, secrets: row.plan.secrets.map((secret) => (secret.name === input.name ? { ...secret, filled: true } : secret)) }
    await tx.update(t.imports).set({ plan }).where(eq(t.imports.id, input.id))
    await audit(tx, ctx.actor.id, "import.set_secret", "imports", input.id, { name: input.name })
    return { name: input.name }
  })
}

/**
 * 方案里的一条新规则按（改过的）文字重新翻译（「规划」模型，花费算进这次导入）：
 * 名字、文字、翻译结果写回方案；翻译得进去是 new，翻译不进去改成 unsupported（不导入）并写原因。返回这条规则
 */
export async function compileImportRule(ctx: WriteCtx, input: { id: string; key: string; name: string; trigger: string; action: string }): Promise<PlanRule> {
  assertCanImport(ctx)
  const row = await loadImport(ctx.db, input.id)
  if (row.status !== "review" || !row.plan) throw conflict("这次导入现在不是待确认，不能翻译规则")
  const rule = row.plan.rules.find((each) => each.key === input.key)
  if (!rule) throw notFound("方案里的规则", input.key)
  if (rule.kind === "existing") throw badRequest("用已有的规则不用翻译")
  if (rule.needsNewTools) throw badRequest("这条规则要用到这次才导入的工具，现在翻译不了。导入后到「规则」页翻译、确认")
  const toolIds = rule.toolKeys.flatMap((key) => row.plan!.tools.find((tool) => tool.key === key)?.refId ?? [])
  const { result, costUsd } = await compileRuleText(ctx.db, { trigger: input.trigger, action: input.action, toolIds }).catch((error: unknown) => {
    if (error instanceof EngineError) throw new TRPCError({ code: error.code, message: error.message })
    throw error
  })
  return ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(t.imports).where(eq(t.imports.id, input.id)).for("update")
    if (!current?.plan || current.status !== "review") throw conflict("翻译期间这次导入的状态变了，改动没有存")
    const before = current.plan.rules.find((each) => each.key === input.key)
    if (!before) throw conflict("翻译期间这条规则被删掉了")
    const next: PlanRule = result.supported
      ? { ...before, name: input.name, trigger: input.trigger, action: input.action, kind: "new", include: true, compile: result, reason: undefined }
      : { ...before, name: input.name, trigger: input.trigger, action: input.action, kind: "unsupported", include: false, compile: undefined, reason: (result.reason ?? result.understood).slice(0, 500) }
    if (next.reason === undefined) delete next.reason
    if (next.compile === undefined) delete next.compile
    const plan = { ...current.plan, rules: current.plan.rules.map((each) => (each.key === input.key ? next : each)) }
    await tx
      .update(t.imports)
      .set({ plan, costUsd: sql`${t.imports.costUsd} + ${costUsd}` })
      .where(eq(t.imports.id, input.id))
    await audit(tx, ctx.actor.id, "import.compile_rule", "imports", input.id, { key: input.key, supported: result.supported, understood: result.understood, modelId: result.modelId, costUsd })
    return next
  })
}

/** 停止读包：读包中 → 没读成。worker 在下一步之前看到就退出，不再调模型 */
export async function stopImport(ctx: WriteCtx, id: string) {
  assertCanImport(ctx)
  return ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(t.imports).where(eq(t.imports.id, id)).for("update")
    if (!row) throw notFound("导入", id)
    if (row.status !== "reading") throw conflict("这次导入现在不在读包")
    const readLog: ImportReadStep[] = row.readLog.map((line) => (line.status === "running" ? { ...line, status: "error" } : line))
    if (!readLog.some((line) => line.status === "error")) readLog.push({ title: "你停止了读包", status: "error" })
    await tx.update(t.imports).set({ status: "failed", error: "你停止了读包。", readLog }).where(eq(t.imports.id, id))
    await audit(tx, ctx.actor.id, "import.stop", "imports", id)
    return { id }
  })
}

/** 上一次读包的任务还在跑（被停止后还没走到下一步）：等它退出再重读，免得两次读包的进度写到一起 */
async function readStillRunning(db: DbOrTx, id: string) {
  try {
    const rows = await db.execute(sql`select 1 from pgboss.job where name = ${QUEUES.importRead} and singleton_key = ${id} and state = 'active' limit 1`)
    return rows.rows.length > 0
  } catch {
    // 还没有 pgboss 的表：没在跑
    return false
  }
}

/** 重新读包：待确认或没读成的，方案和读包过程清空，可以换模型、改说明；这次导入挪出的密钥全部删掉重新挪 */
export async function rereadImport(ctx: WriteCtx, input: { id: string; note?: string; modelId?: string }) {
  assertCanImport(ctx)
  const row = await loadImport(ctx.db, input.id)
  const model = await pickReadModel(ctx.db, input.modelId ?? row.modelId)
  if ("error" in model) throw badRequest(model.error)
  if (await readStillRunning(ctx.db, input.id)) throw conflict("上一次读包还在收尾，过半分钟再试")
  return ctx.db.transaction(async (tx) => {
    const [current] = await tx.select().from(t.imports).where(eq(t.imports.id, input.id)).for("update")
    if (!current) throw notFound("导入", input.id)
    if (current.status !== "review" && current.status !== "failed") throw conflict(current.status === "reading" ? "正在读包，先停止再重新读" : "已经导入过了，不能重新读包")
    await tx.delete(t.secrets).where(and(eq(t.secrets.scope, "import"), eq(t.secrets.refId, input.id)))
    await tx
      .update(t.imports)
      .set({
        status: "reading",
        modelId: model.modelId,
        ...(input.note !== undefined ? { note: input.note } : {}),
        plan: null,
        readLog: [],
        step: "overview",
        visited: [],
        error: null,
        name: null,
        readAt: null,
        fileCount: 0,
      })
      .where(eq(t.imports.id, input.id))
    await sendInTx(ctx.db, tx, QUEUES.importRead, { importId: input.id }, importReadJobOptions(input.id))
    await audit(tx, ctx.actor.id, "import.reread", "imports", input.id, { modelId: model.modelId, noteChanged: input.note !== undefined && input.note !== current.note })
    return { id: input.id }
  })
}

/** 放弃没导入过的（待确认、没读成、已撤销）：删记录、上传的包（行和磁盘文件）、解压目录、挪出来的密钥 */
export async function abandonImport(ctx: WriteCtx, id: string) {
  assertCanImport(ctx)
  const removed = await ctx.db.transaction(async (tx) => {
    const [row] = await tx.select().from(t.imports).where(eq(t.imports.id, id)).for("update")
    if (!row) throw notFound("导入", id)
    if (row.status === "reading") throw conflict("正在读包，先停止再放弃")
    if (row.status === "imported") throw conflict("已经导入了，要先撤销这次导入")
    const file = row.fileId ? await getFileRow(tx, row.fileId) : undefined
    await tx.delete(t.secrets).where(and(eq(t.secrets.scope, "import"), eq(t.secrets.refId, id)))
    await tx.delete(t.imports).where(eq(t.imports.id, id))
    if (file) await tx.delete(t.files).where(eq(t.files.id, file.id))
    await audit(tx, ctx.actor.id, "import.abandon", "imports", id, { fileName: row.fileName, status: row.status })
    return file?.storagePath
  })
  if (removed) await fileStorage().remove(removed).catch(() => {})
  await rm(importDir(id), { recursive: true, force: true })
  return { id }
}

/** 导入后：把 MCP 服务器现在的全部工具选进这次导入的、方案里用到它的任务 */
export async function attachMcpTools(ctx: WriteCtx, input: { id: string; serverId: string }) {
  assertCanImport(ctx)
  return ctx.db.transaction(async (tx) => {
    const row = await loadImport(tx, input.id)
    if (row.status !== "imported" || !row.plan || !row.result) throw conflict("只有已导入的才能这样做")
    const entry = row.result.tools.find((tool) => tool.id === input.serverId)
    const planTool = entry && row.plan.tools.find((tool) => tool.key === entry.key)
    if (!entry || !planTool || (planTool.kind !== "mcp" && planTool.kind !== "existing")) throw badRequest("这个 MCP 服务器不是这次导入新建或用到的")
    const toolIds = (await tx.select({ id: t.tools.id }).from(t.tools).where(eq(t.tools.serverId, input.serverId)).orderBy(t.tools.position)).map((tool) => tool.id)
    if (toolIds.length === 0) throw conflict("这个服务器还没有读到工具：先到「工具」页连接并读取工具")
    const taskIds = row.plan.tasks
      .filter((task) => task.toolKeys.includes(entry.key))
      .flatMap((task) => row.result!.tasks.find((each) => each.key === task.key)?.id ?? [])
    const changed: string[] = []
    for (const taskId of taskIds) {
      const [task] = await tx.select({ id: t.tasks.id }).from(t.tasks).where(eq(t.tasks.id, taskId))
      if (!task) continue
      const links = await tx.select({ refId: t.taskTools.refId, position: t.taskTools.position }).from(t.taskTools).where(eq(t.taskTools.taskId, taskId))
      const missing = toolIds.filter((id) => !links.some((link) => link.refId === id))
      if (missing.length === 0) continue
      const start = links.reduce((max, link) => Math.max(max, link.position + 1), 0)
      await tx.insert(t.taskTools).values(missing.map((refId, index) => ({ taskId, refId, position: start + index })))
      await audit(tx, ctx.actor.id, "task.update", "tasks", taskId, { changed: ["toolIds"], added: missing, importId: input.id })
      changed.push(taskId)
    }
    await audit(tx, ctx.actor.id, "import.attach_mcp_tools", "imports", input.id, { serverId: input.serverId, tasks: changed, tools: toolIds })
    return { taskIds: changed, toolIds }
  })
}
