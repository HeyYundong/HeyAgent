// 撤销导入（imports.undo）：一个事务。删掉这次新建的，用的已有配置不动；跑过的任务只停用（运行记录要留着）；
// 新建的东西还被别的任务、规则、技能用着的留下，写清原因；「更新成新一版」的技能再存一版，内容恢复成导入前那一版。
// 提交后同步定时；删掉的附件文件从磁盘删掉。
import { and, count, eq, inArray, isNull } from "drizzle-orm"
import type { ImportResult } from "@heyagent/shared"

import { audit, conflict, notFound, type Tx, type WriteCtx } from "../data/config/common.js"
import { saveSkillVersion } from "../data/config/skills.js"
import { tasksUsingRef, usedByText } from "../data/config/tasks.js"
import { secretUsers, toolUsage } from "../data/config/tools.js"
import * as t from "../db/schema.js"
import { syncTaskSchedule } from "../engine/api.js"
import { fileStorage } from "../files/service.js"
import { decryptText } from "../lib/crypto.js"
import { assertCanImport } from "./service.js"

type Undo = NonNullable<ImportResult["undo"]>

function usageText(usage: Awaited<ReturnType<typeof toolUsage>>) {
  return [
    usage.tasks.length ? `任务 ${usedByText(usage.tasks)}` : "",
    usage.rules.length ? `规则${usage.rules.map((rule) => `「${rule.name}」`).join("")}` : "",
    usage.skills.length ? `技能${usage.skills.map((skill) => `「${skill.name}」`).join("")}` : "",
  ]
    .filter(Boolean)
    .join("、")
}

/** 全局密钥还有没有人引用：HTTP 工具模板、通知渠道（同删除密钥的检查），再加上 MCP 服务器的环境变量（值是加密存的，要解开看） */
async function secretInUse(tx: Tx, ctx: WriteCtx, name: string): Promise<string | undefined> {
  const users = await secretUsers(tx, name)
  if (users.tools.length) return `工具${users.tools.map((tool) => `「${tool.name}」`).join("")}的模板里用了 {{${name}}}`
  if (users.channels.length) return `通知渠道${users.channels.map((channel) => `「${channel.name}」`).join("")}的地址存在这里`
  const envs = await tx.select().from(t.secrets).where(eq(t.secrets.scope, "mcp_env"))
  for (const row of envs) {
    const value = decryptText(ctx.keyring(), row.enc, { table: "secrets", id: row.id, version: row.version })
    if (value.includes(`{{${name}}}`)) return `MCP 服务器 ${row.refId} 的 ${row.name} 用了 {{${name}}}`
  }
  return undefined
}

async function undoInTx(tx: Tx, ctx: WriteCtx, importId: string, removedPaths: string[], touchedTasks: string[]) {
  const [row] = await tx.select().from(t.imports).where(eq(t.imports.id, importId)).for("update")
  if (!row) throw notFound("导入", importId)
  if (row.status !== "imported" || !row.result) throw conflict(row.status === "undone" ? "这次导入已经撤销过了" : "只有已导入的才能撤销")
  const result = row.result
  const plan = row.plan
  const actor = ctx.actor
  const detail = { importId }
  const undo: Undo = { deleted: [], kept: [] }

  // 任务：没跑过的删掉（任务记忆、附件跟着删）；跑过的只停用
  for (const { id } of result.tasks) {
    const [task] = await tx.select({ id: t.tasks.id, title: t.tasks.title, enabled: t.tasks.enabled }).from(t.tasks).where(eq(t.tasks.id, id))
    if (!task) continue
    touchedTasks.push(id)
    const [runs] = await tx.select({ n: count() }).from(t.sessions).where(eq(t.sessions.taskId, id))
    const n = runs?.n ?? 0
    if (n > 0) {
      if (task.enabled) {
        await tx.update(t.tasks).set({ enabled: false, nextRunAt: null }).where(eq(t.tasks.id, id))
        await audit(tx, actor.id, "task.disable", "tasks", id, detail)
      }
      undo.kept.push({ what: `任务 ${id}「${task.title}」`, reason: `已经跑过 ${n} 次，只停用，运行记录留着` })
      continue
    }
    const files = await tx.select({ path: t.files.storagePath }).from(t.files).where(eq(t.files.taskId, id))
    removedPaths.push(...files.map((file) => file.path))
    await tx.delete(t.tasks).where(eq(t.tasks.id, id))
    await audit(tx, actor.id, "task.delete", "tasks", id, { title: task.title, ...detail })
    undo.deleted.push(`任务 ${id}「${task.title}」`)
  }

  // 新建的规则、技能、共用记忆：没有任务再用就删
  const removeIfUnused = async (
    what: string,
    table: typeof t.rules | typeof t.skills | typeof t.memories,
    link: typeof t.taskRules | typeof t.taskSkills | typeof t.taskMemories,
    id: string,
    action: string
  ) => {
    const [found] = await tx.select({ id: table.id }).from(table).where(eq(table.id, id))
    if (!found) return
    const used = await tasksUsingRef(tx, link, [id])
    if (used.length) {
      undo.kept.push({ what: `${what} ${id}`, reason: `还被任务 ${usedByText(used)} 用着` })
      return
    }
    await tx.delete(table).where(eq(table.id, id))
    await audit(tx, actor.id, action, table === t.rules ? "rules" : table === t.skills ? "skills" : "memories", id, detail)
    undo.deleted.push(`${what} ${id}`)
  }
  for (const rule of result.rules.filter((each) => each.how === "created")) await removeIfUnused("规则", t.rules, t.taskRules, rule.id, "rule.delete")
  for (const memory of result.memories) await removeIfUnused("共用记忆", t.memories, t.taskMemories, memory.id, "memory.delete")
  for (const skill of result.skills) {
    if (skill.how === "created") await removeIfUnused("技能", t.skills, t.taskSkills, skill.id, "skill.delete")
    if (skill.how === "new_version" && skill.fromVersion) {
      // 再存一版，内容恢复成导入前那一版（版本历史留着）
      const [current] = await tx.select().from(t.skills).where(eq(t.skills.id, skill.id))
      const [old] = await tx
        .select()
        .from(t.skillVersions)
        .where(and(eq(t.skillVersions.skillId, skill.id), eq(t.skillVersions.version, skill.fromVersion)))
      if (!current || !old) continue
      const alive = old.toolIds.length ? (await tx.select({ id: t.tools.id }).from(t.tools).where(inArray(t.tools.id, old.toolIds))).map((tool) => tool.id) : []
      const saved = await saveSkillVersion(tx, actor, { id: skill.id, name: old.name, dept: current.dept, description: old.description, body: old.body, toolIds: old.toolIds.filter((id) => alive.includes(id)) }, { ...detail, restoredFrom: old.version })
      undo.deleted.push(`技能「${current.name}」导入时存的新一版（第 ${saved.version} 版已恢复成第 ${old.version} 版的内容）`)
    }
  }

  // 新建的 HTTP 工具、MCP 服务器：没有任务、规则、技能再用就删
  const kindOf = (key: string) => plan?.tools.find((tool) => tool.key === key)?.kind
  for (const tool of result.tools.filter((each) => each.how === "created")) {
    if (kindOf(tool.key) === "mcp") {
      const [server] = await tx.select({ id: t.mcpServers.id, name: t.mcpServers.name }).from(t.mcpServers).where(eq(t.mcpServers.id, tool.id))
      if (!server) continue
      const toolIds = (await tx.select({ id: t.tools.id }).from(t.tools).where(eq(t.tools.serverId, server.id))).map((each) => each.id)
      const usage = await toolUsage(tx, toolIds)
      if (usage.tasks.length + usage.rules.length + usage.skills.length) {
        undo.kept.push({ what: `MCP 服务器「${server.name}」`, reason: `它的工具还被${usageText(usage)}用着` })
        continue
      }
      await tx.delete(t.secrets).where(and(eq(t.secrets.scope, "mcp_env"), eq(t.secrets.refId, server.id)))
      await tx.delete(t.mcpServers).where(eq(t.mcpServers.id, server.id))
      await audit(tx, actor.id, "mcp_server.delete", "mcp_servers", server.id, { name: server.name, tools: toolIds, ...detail })
      undo.deleted.push(`MCP 服务器「${server.name}」`)
      continue
    }
    const [found] = await tx.select({ id: t.tools.id, name: t.tools.name }).from(t.tools).where(eq(t.tools.id, tool.id))
    if (!found) continue
    const usage = await toolUsage(tx, [found.id])
    if (usage.tasks.length + usage.rules.length + usage.skills.length) {
      undo.kept.push({ what: `工具「${found.name}」`, reason: `还被${usageText(usage)}用着` })
      continue
    }
    await tx.delete(t.tools).where(eq(t.tools.id, found.id))
    await audit(tx, actor.id, "tool.delete", "tools", found.id, { name: found.name, source: "http", ...detail })
    undo.deleted.push(`工具「${found.name}」`)
  }

  // 新建的全局密钥：没有工具模板、MCP 环境变量、通知渠道再引用就删
  for (const secret of result.secrets.filter((each) => each.how === "created")) {
    const [found] = await tx
      .select({ id: t.secrets.id })
      .from(t.secrets)
      .where(and(eq(t.secrets.scope, "http_tool"), isNull(t.secrets.refId), eq(t.secrets.name, secret.name)))
    if (!found) continue
    const users = await secretInUse(tx, ctx, secret.name)
    if (users) {
      undo.kept.push({ what: `密钥 ${secret.name}`, reason: users })
      continue
    }
    await tx.delete(t.secrets).where(eq(t.secrets.id, found.id))
    await audit(tx, actor.id, "secret.delete", "secrets", secret.name, detail)
    undo.deleted.push(`密钥 ${secret.name}`)
  }

  await tx
    .update(t.imports)
    .set({ result: { ...result, undo }, status: "undone", undoneAt: new Date() })
    .where(eq(t.imports.id, importId))
  await audit(tx, actor.id, "import.undo", "imports", importId, { deleted: undo.deleted, kept: undo.kept })
}

export async function undoImport(ctx: WriteCtx, importId: string): Promise<void> {
  assertCanImport(ctx)
  const removedPaths: string[] = []
  const touchedTasks: string[] = []
  await ctx.db.transaction((tx) => undoInTx(tx, ctx, importId, removedPaths, touchedTasks))
  for (const path of removedPaths) await fileStorage().remove(path).catch(() => {})
  for (const id of touchedTasks) await syncTaskSchedule(ctx.db, id)
}
