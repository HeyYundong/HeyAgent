// 读包时要对照的现有配置：给读包 AI 的摘要（避免重复导入、负责人和模型怎么对上），整理方案时代码再按它核对一遍。
import { and, asc, desc, eq, isNull } from "drizzle-orm"
import { compiledRuleSchema, ruleCompileStatusLabel, type Risk, type SkillStatus } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { BROWSER_TOOL_DEF, COMPARE_TOOL_DEF, DESKTOP_TOOL_DEF, GALLERY_TOOL_DEF, SELECTABLE_BUILTIN_TOOLS } from "../engine/tools/builtin-defs.js"

/** 给 AI 的共用记忆最多几条（太多时只给最近的） */
const MEMORY_LIMIT = 300

export interface ImportCatalog {
  staff: { id: string; name: string; title: string; isAdmin: boolean }[]
  models: { id: string; name: string; chat: boolean }[]
  defaults: { run?: string; plan?: string; verify?: string }
  profiles: { id: string; name: string; exitIp: string }[]
  platforms: { id: string; name: string; domains: string[] }[]
  /** 每个 Chrome 里登录过哪些平台（不管现在登录态好不好，有账号就算） */
  accounts: { profileId: string; platformId: string }[]
  skills: { id: string; name: string; dept: string; description: string; version: number; status: SkillStatus; body: string }[]
  memories: { id: string; content: string; appliesTo: string }[]
  /** 全部规则；effective = 人确认过、运行时会执行 */
  rules: { id: string; name: string; trigger: string; action: string; understood?: string; effective: boolean }[]
  tools: { id: string; name: string; summary: string; source: "builtin" | "http" | "mcp"; serverId: string | null; risk: Risk }[]
  servers: { id: string; name: string; status: string; toolIds: string[] }[]
  tasks: { id: string; title: string }[]
  /** 已有的全局密钥名（scope = http_tool） */
  secretNames: string[]
  /** 内置工具（代码里的清单，不依赖 worker 有没有同步进库） */
  builtins: { id: string; name: string; summary: string }[]
}

export const builtinToolList = () =>
  [...SELECTABLE_BUILTIN_TOOLS, BROWSER_TOOL_DEF, DESKTOP_TOOL_DEF, GALLERY_TOOL_DEF, COMPARE_TOOL_DEF].map((tool) => ({ id: tool.id as string, name: tool.name, summary: tool.summary }))

export async function loadCatalog(db: Db): Promise<ImportCatalog> {
  const [staff, models, defaults, profiles, platforms, accounts, skills, memories, rules, tools, servers, tasks, secrets] = await Promise.all([
    db.select({ id: t.users.id, name: t.users.name, title: t.users.title, role: t.users.role, banned: t.users.banned }).from(t.users).orderBy(asc(t.users.createdAt)),
    db.select({ id: t.models.id, name: t.models.name, kind: t.models.kind }).from(t.models).orderBy(asc(t.models.position)),
    db.select().from(t.modelDefaults),
    db.select({ id: t.browserProfiles.id, name: t.browserProfiles.name, exitIp: t.browserProfiles.exitIp }).from(t.browserProfiles).orderBy(asc(t.browserProfiles.position)),
    db.select({ id: t.platforms.id, name: t.platforms.name, domains: t.platforms.domains }).from(t.platforms).orderBy(asc(t.platforms.position)),
    db.select({ profileId: t.browserAccounts.profileId, platformId: t.browserAccounts.platformId }).from(t.browserAccounts),
    db.select().from(t.skills).orderBy(asc(t.skills.position)),
    db
      .select({ id: t.memories.id, content: t.memories.content, appliesTo: t.memories.appliesTo })
      .from(t.memories)
      .where(eq(t.memories.status, "active"))
      .orderBy(desc(t.memories.createdAt))
      .limit(MEMORY_LIMIT),
    db.select().from(t.rules).orderBy(asc(t.rules.position)),
    db.select({ id: t.tools.id, name: t.tools.name, summary: t.tools.summary, source: t.tools.source, serverId: t.tools.serverId, risk: t.tools.risk }).from(t.tools).orderBy(asc(t.tools.position)),
    db.select({ id: t.mcpServers.id, name: t.mcpServers.name, status: t.mcpServers.status }).from(t.mcpServers).orderBy(asc(t.mcpServers.position)),
    db.select({ id: t.tasks.id, title: t.tasks.title }).from(t.tasks).orderBy(desc(t.tasks.createdAt)),
    db.select({ name: t.secrets.name }).from(t.secrets).where(and(eq(t.secrets.scope, "http_tool"), isNull(t.secrets.refId))),
  ])
  const role = (name: "run" | "plan" | "verify") => defaults.find((row) => row.role === name)?.modelId
  return {
    staff: staff.filter((row) => !row.banned).map((row) => ({ id: row.id, name: row.name, title: row.title, isAdmin: row.role === "admin" })),
    models: models.map((row) => ({ id: row.id, name: row.name, chat: row.kind === "chat" })),
    defaults: { run: role("run"), plan: role("plan"), verify: role("verify") },
    profiles,
    platforms,
    accounts,
    skills: skills.map((row) => ({ id: row.id, name: row.name, dept: row.dept, description: row.description, version: row.version, status: row.status, body: row.body })),
    memories,
    rules: rules.map((row) => {
      const compiled = compiledRuleSchema.safeParse(row.compiledTrigger)
      return { id: row.id, name: row.name, trigger: row.trigger, action: row.action, understood: compiled.success ? compiled.data.understood : undefined, effective: compiled.success }
    }),
    tools,
    servers: servers.map((server) => ({ ...server, toolIds: tools.filter((tool) => tool.serverId === server.id).map((tool) => tool.id) })),
    tasks,
    secretNames: secrets.map((row) => row.name),
    builtins: builtinToolList(),
  }
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value)

/** 给读包 AI 的「现有配置」摘要（中文，Markdown） */
export function catalogText(catalog: ImportCatalog): string {
  const lines: string[] = []
  const section = (title: string, rows: string[], empty = "（没有）") => {
    lines.push(`### ${title}`, ...(rows.length ? rows : [empty]), "")
  }
  section(
    "员工（负责人只能从这里选 id）",
    catalog.staff.map((user) => `- ${user.id} · ${user.name} · ${user.title || "—"} · ${user.isAdmin ? "主管" : "员工"}`)
  )
  section(
    "模型（执行模型只能从这里选能调工具的；对不上就留空，写 modelNote）",
    catalog.models.filter((model) => model.chat).map((model) => `- ${model.id} · ${model.name}${model.id === catalog.defaults.run ? " · 默认执行模型" : ""}`)
  )
  section(
    "Chrome 配置（任务能用哪些 Chrome，只能从这里选 id；不限就留空）",
    catalog.profiles.map((profile) => `- ${profile.id} · ${profile.name}${profile.exitIp ? ` · 出口 ${profile.exitIp}` : ""}`)
  )
  section(
    "平台（网站）和它们的域名",
    catalog.platforms.map((platform) => `- ${platform.id} · ${platform.name} · ${platform.domains.join("、") || "（没写域名）"}`)
  )
  section(
    "已有技能（名字一样的会按同名技能处理）",
    catalog.skills.map((skill) => `- ${skill.id} · ${skill.name} · 岗位 ${skill.dept} · 第 ${skill.version} 版 · ${skill.status === "published" ? "已发布" : skill.status === "draft" ? "草稿" : "已停用"} · 什么时候用：${clip(skill.description, 100)}`)
  )
  section(
    `已有的共用记忆（重复的标 duplicate，existingId 写这里的 id${catalog.memories.length >= MEMORY_LIMIT ? `；太多了，只列最近的 ${MEMORY_LIMIT} 条` : ""}）`,
    catalog.memories.map((memory) => `- ${memory.id} · 适用于「${memory.appliesTo}」 · ${clip(memory.content, 150)}`)
  )
  section(
    "已生效的规则（一个意思的标 existing，existingId 写这里的 id）",
    catalog.rules.filter((rule) => rule.effective).map((rule) => `- ${rule.id} · ${rule.name} · 系统理解为：${clip(rule.understood ?? "", 200)}`)
  )
  const untranslated = catalog.rules.filter((rule) => !rule.effective)
  if (untranslated.length)
    section(
      `还没生效的规则（${ruleCompileStatusLabel.untranslated}或${ruleCompileStatusLabel.pending}，不能用 existing 引用）`,
      untranslated.map((rule) => `- ${rule.name}：${clip(rule.trigger, 100)} → ${clip(rule.action, 100)}`)
    )
  section(
    "内置工具（kind = builtin，refId 写这里的 id）",
    catalog.builtins.map((tool) => `- ${tool.id} · ${tool.name} · ${tool.summary}`)
  )
  section(
    "已有的 HTTP / MCP 工具（kind = existing，refId 写工具 id）",
    catalog.tools.filter((tool) => tool.source !== "builtin").map((tool) => `- ${tool.id} · ${tool.name} · ${clip(tool.summary, 100)}${tool.serverId ? ` · 属于 MCP 服务器 ${tool.serverId}` : ""}`)
  )
  section(
    "已有的 MCP 服务器（kind = existing，refId 写服务器 id 表示用它的全部工具）",
    catalog.servers.map((server) => `- ${server.id} · ${server.name} · ${server.toolIds.length} 个工具`)
  )
  section("已有的全局密钥名（工具里写 {{名字}} 引用；同名的导入时用已有的值）", catalog.secretNames.length ? [catalog.secretNames.join("、")] : [])
  section(
    "已有任务的标题（看看是不是重复导入；重复的在 warnings 里提醒）",
    catalog.tasks.slice(0, 300).map((task) => `- ${task.id} · ${clip(task.title, 80)}`)
  )
  return lines.join("\n")
}
