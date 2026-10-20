// 导入（imports.commit）：一个事务按方案建好全部，记下建了什么（result，撤销时按它删）。
// 中间任何一步出错整个回滚，什么都不建；已经写到磁盘的附件文件删掉。
// 建每一样东西都复用配置写操作里事务内的那部分（insertTask、insertSkill……），校验和手动新建一模一样。
import { basename } from "node:path"
import { readFile } from "node:fs/promises"

import { and, eq } from "drizzle-orm"
import { checkCompiledRule, cronText, planMemoryIncluded, planProblems, taskInputSchema, type ImportPlan, type ImportResult } from "@heyagent/shared"

import { audit, badRequest, conflict, findSecret, notFound, putSecret, type Tx, type WriteCtx } from "../data/config/common.js"
import { insertMemory } from "../data/config/memories.js"
import { confirmRuleInTx, insertRule } from "../data/config/rules.js"
import { changeSkillStatus, insertSkill, saveSkillVersion } from "../data/config/skills.js"
import { insertTaskMemory } from "../data/config/task-memory.js"
import { insertTask, setDispatchSources } from "../data/config/tasks.js"
import { insertHttpTool, insertMcpServer } from "../data/config/tools.js"
import * as t from "../db/schema.js"
import { syncTaskSchedule } from "../engine/api.js"
import { fileStorage, mimeFromName, saveFile } from "../files/service.js"
import { decryptText } from "../lib/crypto.js"
import { toolSecretNames } from "./organize.js"
import { ImportPackage } from "./package.js"
import { readManifest } from "./reader.js"
import { SecretCollector } from "./redact.js"
import { assertCanImport } from "./service.js"

/** 这次导入挪出来、或者人在确认时填的密钥值（scope = import） */
async function importSecretValue(tx: Tx, ctx: WriteCtx, importId: string, name: string): Promise<string | undefined> {
  const [row] = await tx
    .select()
    .from(t.secrets)
    .where(and(eq(t.secrets.scope, "import"), eq(t.secrets.refId, importId), eq(t.secrets.name, name)))
  return row ? decryptText(ctx.keyring(), row.enc, { table: "secrets", id: row.id, version: row.version }) : undefined
}

/** 这次导入存的全部密钥值（读包时挪出来的、人填的），用来给附件挪密钥时起同样的名字 */
async function importCollector(tx: Tx, ctx: WriteCtx, importId: string): Promise<SecretCollector> {
  const rows = await tx
    .select()
    .from(t.secrets)
    .where(and(eq(t.secrets.scope, "import"), eq(t.secrets.refId, importId)))
  const collector = new SecretCollector()
  collector.seed(rows.map((row) => ({ name: row.name, value: decryptText(ctx.keyring(), row.enc, { table: "secrets", id: row.id, version: row.version }), where: "" })))
  return collector
}

/** 方案里至少有一项要导入 */
function anythingIncluded(plan: ImportPlan) {
  return (
    plan.tasks.some((task) => task.include) ||
    plan.skills.some((skill) => skill.include) ||
    plan.memories.some((memory) => planMemoryIncluded(plan, memory)) ||
    plan.rules.some((rule) => rule.include && rule.kind !== "unsupported") ||
    plan.tools.some((tool) => tool.include)
  )
}

/** 按方案一次建好。返回新建的任务 id（提交后同步定时） */
async function commitInTx(tx: Tx, ctx: WriteCtx, importId: string, written: string[]): Promise<string[]> {
  const [row] = await tx.select().from(t.imports).where(eq(t.imports.id, importId)).for("update")
  if (!row) throw notFound("导入", importId)
  if (row.status === "imported") throw conflict("这次导入已经导入过了，不能再导入一次")
  if (row.status !== "review") throw conflict("这次导入现在不是待确认，不能导入")
  const plan = row.plan
  if (!plan) throw conflict("这次导入还没有方案")
  const problems = planProblems(plan)
  if (problems.length) throw badRequest(`方案对不上：${problems.slice(0, 3).join("；")}`)
  if (!anythingIncluded(plan)) throw badRequest("什么都没勾，没有可导入的")
  const actor = ctx.actor
  const detail = { importId }
  const result: ImportResult = { tasks: [], skills: [], memories: [], taskMemories: [], rules: [], tools: [], secrets: [], files: [] }
  const tasks = plan.tasks.filter((task) => task.include)
  const tools = plan.tools.filter((tool) => tool.include)

  // ① 密钥：勾上的新工具用到的每个名字。已有全局密钥 → 用已有的；这次导入有值 → 存成全局密钥；都没有 → 导入后再补
  const names = [...new Set(tools.flatMap(toolSecretNames))]
  for (const name of names) {
    if (await findSecret(tx, { scope: "http_tool", refId: null, name })) {
      result.secrets.push({ name, how: "reused" })
      continue
    }
    const value = await importSecretValue(tx, ctx, importId, name)
    if (value === undefined) {
      result.secrets.push({ name, how: "missing" })
      continue
    }
    await putSecret(tx, ctx.keyring(), { scope: "http_tool", refId: null, name }, value, actor.id)
    await audit(tx, actor.id, "secret.create", "secrets", name, detail)
    result.secrets.push({ name, how: "created" })
  }

  // ② 工具：key → 任务、技能、规则里要选的工具 id
  const toolIdsByKey = new Map<string, string[]>()
  for (const tool of tools) {
    if (tool.kind === "http") {
      const http = tool.http!
      const { id } = await insertHttpTool(
        tx,
        ctx,
        { name: tool.name, description: http.description || tool.summary, summary: tool.summary, http: { method: http.method, url: http.url, headers: http.headers, body: http.body }, risk: http.risk, secrets: {} },
        // 允许引用还没有值的密钥：导入后在「还要你做的」里提醒去填
        { allowMissingSecrets: true, audit: detail }
      )
      toolIdsByKey.set(tool.key, [id])
      result.tools.push({ key: tool.key, id, how: "created" })
    } else if (tool.kind === "mcp") {
      const mcp = tool.mcp!
      // 环境变量的值原样（加密）存，{{名字}} 运行时从全局密钥替换；还没连过，没有工具（导入后去「工具」页连接）
      const { id } = await insertMcpServer(tx, ctx, { name: tool.name, transport: mcp.transport, command: mcp.command, url: mcp.url, note: tool.summary, env: mcp.env }, detail)
      toolIdsByKey.set(tool.key, [])
      result.tools.push({ key: tool.key, id, how: "created" })
    } else {
      const ref = tool.refId!
      const [found] = await tx.select({ id: t.tools.id }).from(t.tools).where(eq(t.tools.id, ref))
      if (found) toolIdsByKey.set(tool.key, [found.id])
      else {
        const [server] = await tx.select({ id: t.mcpServers.id }).from(t.mcpServers).where(eq(t.mcpServers.id, ref))
        if (!server) throw badRequest(`工具「${tool.name}」要用的${tool.kind === "builtin" ? "内置工具" : "已有工具"} ${ref} 不在了，换一个或者不勾它`)
        const serverTools = await tx.select({ id: t.tools.id }).from(t.tools).where(eq(t.tools.serverId, server.id))
        toolIdsByKey.set(tool.key, serverTools.map((each) => each.id))
      }
      result.tools.push({ key: tool.key, id: ref, how: "reused" })
    }
  }
  const toolIdsOf = (keys: string[]) => [...new Set(keys.flatMap((key) => toolIdsByKey.get(key) ?? []))]

  // ③ 技能。任务选的技能必须是发布状态：用到的已有技能没发布就发布它（写进审计）
  const usedSkillKeys = new Set(tasks.flatMap((task) => task.skillKeys))
  const skillIdByKey = new Map<string, string>()
  for (const skill of plan.skills.filter((each) => each.include)) {
    const fields = { name: skill.name, dept: skill.dept, description: skill.description, body: skill.body, toolIds: toolIdsOf(skill.toolKeys) }
    let id: string
    if (skill.resolution === "new" || skill.resolution === "save_as_new") {
      id = (await insertSkill(tx, actor, fields, detail)).id
      await changeSkillStatus(tx, actor, { id, status: "published" }, detail)
      result.skills.push({ key: skill.key, id, how: "created" })
    } else {
      const existingId = skill.existing?.id
      const [current] = existingId ? await tx.select().from(t.skills).where(eq(t.skills.id, existingId)) : []
      if (!current) throw badRequest(`技能「${skill.name}」要用的已有技能 ${existingId ?? ""} 不在了，改成新建或者不勾它`)
      id = current.id
      if (skill.resolution === "new_version") {
        // 已有技能原来用的工具留着，再加上包里这一版用到的
        const before = (await tx.select({ id: t.skillTools.toolId }).from(t.skillTools).where(eq(t.skillTools.skillId, id))).map((link) => link.id)
        await saveSkillVersion(tx, actor, { ...fields, id, toolIds: [...new Set([...before, ...fields.toolIds])] }, detail)
        result.skills.push({ key: skill.key, id, how: "new_version", fromVersion: current.version })
      } else result.skills.push({ key: skill.key, id, how: "reused" })
      if (usedSkillKeys.has(skill.key) && current.status !== "published") await changeSkillStatus(tx, actor, { id, status: "published" }, { ...detail, why: "导入的任务要用它" })
    }
    skillIdByKey.set(skill.key, id)
  }

  // ④ 共用记忆：直接生效，来源是导入的人
  const memoryIdByKey = new Map<string, string>()
  for (const memory of plan.memories) {
    if (memory.target.kind !== "shared" || !planMemoryIncluded(plan, memory)) continue
    const { id } = await insertMemory(tx, actor, { content: memory.text, appliesTo: memory.target.appliesTo }, detail)
    memoryIdByKey.set(memory.key, id)
    result.memories.push({ key: memory.key, id })
  }

  // ⑤ 规则：翻译过、文字没改过的直接确认生效；要用新工具的、没翻译的先建着，导入后到规则页翻译确认
  const ruleIdByKey = new Map<string, string>()
  const inactiveRuleIds: string[] = []
  for (const rule of plan.rules) {
    if (!rule.include || rule.kind === "unsupported") continue
    if (rule.kind === "existing") {
      const [existing] = await tx.select({ id: t.rules.id, compiled: t.rules.compiledTrigger }).from(t.rules).where(eq(t.rules.id, rule.existingId!))
      if (!existing) throw badRequest(`规则「${rule.name}」要用的已有规则 ${rule.existingId} 不在了，不勾它再导入`)
      ruleIdByKey.set(rule.key, existing.id)
      result.rules.push({ key: rule.key, id: existing.id, how: "reused", confirmed: existing.compiled !== null })
      continue
    }
    const compile = rule.compile
    // 方案是页面存回来的：翻译结果的结构再查一遍（触发和动作的组合合不合法），不合法的当没翻译
    const ready =
      !rule.needsNewTools && compile?.supported === true && compile.compiled !== undefined && !checkCompiledRule(compile.compiled) && compile.trigger === rule.trigger && compile.action === rule.action
    const { id } = await insertRule(tx, actor, { name: rule.name, trigger: rule.trigger, action: rule.action, toolIds: toolIdsOf(rule.toolKeys), compileDraft: ready ? compile : undefined }, detail)
    if (ready) await confirmRuleInTx(tx, actor, { id }, detail)
    else inactiveRuleIds.push(id)
    ruleIdByKey.set(rule.key, id)
    result.rules.push({ key: rule.key, id, how: "created", confirmed: ready })
  }

  // ⑥ 任务：全部校验照手动新建（模型、验收模型不能同一家、技能要发布……）
  const taskIdByKey = new Map<string, string>()
  for (const task of tasks) {
    const parsed = taskInputSchema.safeParse({
      title: task.title,
      goal: task.goal,
      steps: task.steps.map((step) => ({ text: step.text, wait: step.wait, ...(step.checkpoint ? { checkpoint: step.checkpoint } : {}) })),
      modelId: task.modelId ?? undefined,
      ownerId: task.ownerId,
      // 已经读好的方案里可能还是 AI 写的说法：导入时统一换成系统按 cron 生成的
      schedule: task.schedule ? { cron: task.schedule.cron, text: cronText(task.schedule.cron) ?? task.schedule.cron } : null,
      // 包里写了默认关闭自动执行的：建成停用的任务
      enabled: task.enabled ?? true,
      memoryIds: task.memoryKeys.flatMap((key) => memoryIdByKey.get(key) ?? []),
      skillIds: task.skillKeys.flatMap((key) => skillIdByKey.get(key) ?? []),
      toolIds: toolIdsOf(task.toolKeys),
      ruleIds: task.ruleKeys.flatMap((key) => ruleIdByKey.get(key) ?? []),
      browserProfileIds: task.browserProfileIds,
      allowedDomains: task.allowedDomains,
      // 派活（第二期）：先建好「可以被派活」；谁能派活给它等全部任务建完再连（派活方可能排在后面，见 ⑥b）
      dispatch: task.dispatch
        ? {
            params: task.dispatch.params,
            results: task.dispatch.results ?? [],
            maxRunning: task.dispatch.maxRunning,
            ...(task.dispatch.retries !== undefined ? { retries: task.dispatch.retries } : {}),
            ...(task.dispatch.retryDelayMinutes !== undefined ? { retryDelayMinutes: task.dispatch.retryDelayMinutes } : {}),
          }
        : null,
    })
    if (!parsed.success) throw badRequest(`任务「${task.title}」：${parsed.error.issues[0]?.message ?? "填得不对"}`)
    let id: string
    try {
      id = await insertTask(tx, actor, parsed.data, { allowInactiveRuleIds: inactiveRuleIds, audit: detail })
    } catch (error) {
      // 校验的报错前面加上是哪个任务
      if (error instanceof Error && "code" in error) error.message = `任务「${task.title}」：${error.message}`
      throw error
    }
    taskIdByKey.set(task.key, id)
    result.tasks.push({ key: task.key, id })
  }

  // ⑥b 派活：谁能派活给它。只连这次勾上的任务（没勾的派活方去掉；一个都不剩的在「还要你做的」里提醒）
  for (const task of tasks) {
    if (!task.dispatch) continue
    const sourceIds = task.dispatch.fromKeys.flatMap((key) => taskIdByKey.get(key) ?? [])
    await setDispatchSources(tx, taskIdByKey.get(task.key)!, sourceIds)
  }

  // ⑦ 任务记忆
  for (const memory of plan.memories) {
    if (memory.target.kind !== "task" || !planMemoryIncluded(plan, memory)) continue
    const taskId = taskIdByKey.get(memory.target.taskKey)!
    const { id } = await insertTaskMemory(tx, actor, { taskId, content: memory.text }, detail)
    result.taskMemories.push({ key: memory.key, id, taskId })
  }

  // ⑧ 附件：文字文件用挪过密钥的版本（附件会进 agent 的上下文），名字和读包时一样（用这次导入存的密钥值认），其他用原文件
  const attachments = tasks.flatMap((task) => task.attachments)
  const pkg = attachments.length ? new ImportPackage(await readManifest(importId), await importCollector(tx, ctx, importId)) : undefined
  for (const task of tasks) {
    const taskId = taskIdByKey.get(task.key)!
    for (const path of task.attachments) {
      const file = pkg?.byPath.get(path)
      const text = file?.text ? await pkg!.text(path).catch(() => undefined) : undefined
      const data = text !== undefined ? Buffer.from(text) : file?.diskPath ? await readFile(file.diskPath).catch(() => undefined) : undefined
      if (!data) throw badRequest(`附件「${path}」找不到了（解压出来的文件可能被清掉了），重新读包再导入`)
      const saved = await saveFile(tx, { data, name: basename(path), mime: mimeFromName(path), kind: "attachment", taskId, createdById: actor.id })
      written.push(saved.storagePath)
      await audit(tx, actor.id, "task.attach", "tasks", taskId, { fileId: saved.id, name: saved.name, ...detail })
      result.files.push({ path, id: saved.id, taskId })
    }
  }

  // ⑨ 记下建了什么；这次导入的密钥已经转存成全局的，删掉
  await tx.update(t.imports).set({ result, status: "imported", importedAt: new Date(), importedById: actor.id }).where(eq(t.imports.id, importId))
  await tx.delete(t.secrets).where(and(eq(t.secrets.scope, "import"), eq(t.secrets.refId, importId)))
  await audit(tx, actor.id, "import.commit", "imports", importId, {
    tasks: result.tasks.map((each) => each.id),
    skills: result.skills.map((each) => ({ id: each.id, how: each.how })),
    memories: result.memories.length,
    taskMemories: result.taskMemories.length,
    rules: result.rules.map((each) => ({ id: each.id, how: each.how, confirmed: each.confirmed })),
    tools: result.tools.map((each) => ({ id: each.id, how: each.how })),
    secrets: result.secrets,
    files: result.files.length,
  })
  return result.tasks.map((each) => each.id)
}

/** 导入：一个事务；提交后同步新任务的定时；回滚时删掉已经写到磁盘的附件 */
export async function commitImport(ctx: WriteCtx, importId: string): Promise<void> {
  assertCanImport(ctx)
  const written: string[] = []
  let taskIds: string[]
  try {
    taskIds = await ctx.db.transaction((tx) => commitInTx(tx, ctx, importId, written))
  } catch (error) {
    await Promise.all(written.map((path) => fileStorage().remove(path).catch(() => {})))
    throw error
  }
  for (const id of taskIds) await syncTaskSchedule(ctx.db, id)
}

