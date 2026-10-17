// 数据库表（方案 2.4）。主键用原型那样可读的文本 id（T-1024、R-1024-1、m-009……），新 id 的规则见 @heyagent/shared 的 ids.ts。
// 时间一律 timestamptz。JS 里的字段名是 camelCase，库里的列名是 snake_case。
// 表结构照顾到 M1～M4：父 session、只追加的事件表、消息历史、等待表、账号租约、密文、规则翻译后的触发条件等，M0 先建好。
import { sql } from "drizzle-orm"
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgSequence,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"
import {
  accountStatusSchema,
  checkpointKindSchema,
  humanItemKindSchema,
  memoryEvidenceSchema,
  memoryStatusSchema,
  modelProviderKindSchema,
  modelRoleSchema,
  providerStatusSchema,
  riskSchema,
  runEventKindSchema,
  runStatusSchema,
  skillStatusSchema,
  toolSourceSchema,
  type HttpSpec,
  type HumanDetail,
  type TaskStep,
  type Verification,
} from "@heyagent/shared"

import type { Envelope } from "../lib/crypto.js"

// 枚举值直接取 shared 里 zod schema 的选项，前后端只有一份
const values = <T extends string>(options: readonly T[]) => options as [T, ...T[]]

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: "date" })
const createdAt = () => ts("created_at").notNull().defaultNow()
const updatedAt = () =>
  ts("updated_at")
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date())
/** 列表里的显示顺序（种子数据照原型的顺序） */
const position = () => integer("position").notNull().default(0)
const identity = () => bigint("id", { mode: "number" }).primaryKey().generatedAlwaysAsIdentity()

// ---------- 枚举 ----------

export const runStatusEnum = pgEnum("run_status", values(runStatusSchema.options))
export const runEventKindEnum = pgEnum("run_event_kind", values(runEventKindSchema.options))
export const checkpointKindEnum = pgEnum("checkpoint_kind", values(checkpointKindSchema.options))
export const checkpointStatusEnum = pgEnum("checkpoint_status", ["done", "open", "skipped"])
export const triggerKindEnum = pgEnum("trigger_kind", ["time", "cron", "event", "time_or_event"])
/** 等待记录：waiting → fired（到点 / 来事件 / 人处理完 / 立即继续，谁先到谁生效）或 cancelled */
export const waitStatusEnum = pgEnum("wait_status", ["waiting", "fired", "cancelled"])
export const humanItemKindEnum = pgEnum("human_item_kind", values(humanItemKindSchema.options))
export const humanItemStatusEnum = pgEnum("human_item_status", ["open", "resolved", "cancelled"])
export const todoStatusEnum = pgEnum("todo_status", ["active", "done", "cancelled"])
export const memoryStatusEnum = pgEnum("memory_status", values(memoryStatusSchema.options))
export const memorySourceKindEnum = pgEnum("memory_source_kind", ["human", "agent"])
export const memoryEvidenceEnum = pgEnum("memory_evidence", values(memoryEvidenceSchema.options))
export const skillStatusEnum = pgEnum("skill_status", values(skillStatusSchema.options))
export const suggestionStatusEnum = pgEnum("suggestion_status", ["pending", "accepted", "rejected"])
export const toolSourceEnum = pgEnum("tool_source", values(toolSourceSchema.options))
export const riskEnum = pgEnum("risk", values(riskSchema.options))
export const mcpTransportEnum = pgEnum("mcp_transport", ["stdio", "http"])
export const mcpStatusEnum = pgEnum("mcp_status", ["connected", "error"])
export const accountStatusEnum = pgEnum("account_status", values(accountStatusSchema.options))
export const proxyKindEnum = pgEnum("proxy_kind", ["none", "socks5"])
export const providerKindEnum = pgEnum("provider_kind", values(modelProviderKindSchema.options))
export const providerStatusEnum = pgEnum("provider_status", values(providerStatusSchema.options))
export const modelRoleEnum = pgEnum("model_role", values(modelRoleSchema.options))
/** 密钥属于什么：HTTP 工具模板里的 {{名字}}、MCP 服务器的环境变量、模型服务的 API key、Chrome 代理密码 */
export const secretScopeEnum = pgEnum("secret_scope", ["http_tool", "mcp_env", "model_provider", "browser_proxy"])

// ---------- 新 id 用的序列（规则见 shared/ids.ts） ----------

export const taskNoSeq = pgSequence("task_no_seq", { startWith: 1 })
export const memoryNoSeq = pgSequence("memory_no_seq", { startWith: 1 })
export const skillNoSeq = pgSequence("skill_no_seq", { startWith: 1 })
export const ruleNoSeq = pgSequence("rule_no_seq", { startWith: 1 })
export const humanItemNoSeq = pgSequence("human_item_no_seq", { startWith: 1 })
export const todoNoSeq = pgSequence("todo_no_seq", { startWith: 1 })

// ---------- 账号（better-auth 的 4 张表，字段名照 better-auth 1.7.10 + admin 插件的要求） ----------

/** 账号和角色：role = "admin" 是主管，其他（"user"）是员工。title 是职位（原型 Staff.title） */
export const users = pgTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: ts("ban_expires"),
  title: text("title").notNull().default(""),
})

/** 登录会话（better-auth 的 session 表；叫 auth_sessions 是为了和 agent 的 sessions 分开） */
export const authSessions = pgTable(
  "auth_sessions",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("auth_sessions_user_id_idx").on(t.userId)]
)

/** 登录方式：邮箱密码的密码哈希存在这里（provider_id = credential） */
export const authAccounts = pgTable(
  "auth_accounts",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_accounts_user_id_idx").on(t.userId)]
)

export const authVerifications = pgTable(
  "auth_verifications",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("auth_verifications_identifier_idx").on(t.identifier)]
)

// ---------- 业务对象 ----------

/** 平台，也就是网站（浏览器账号按「平台 × 账号」管并发）。具体有哪些全部来自数据 */
export const platforms = pgTable("platforms", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  position: position(),
})

// ---------- 密钥（只存密文） ----------

/**
 * 加密的密钥值。enc 是信封加密的结果（lib/crypto.ts），AAD 绑定「secrets:行id:version」。
 * masked 是写入时算好的掩码（例如 sk-or-v1-••••••••3f2a），页面只拿这个。
 */
export const secrets = pgTable(
  "secrets",
  {
    id: text("id").primaryKey(),
    scope: secretScopeEnum("scope").notNull(),
    /** 属于哪个对象：模型服务 id、MCP 服务器 id、Chrome id；HTTP 工具的密钥全局共用，按名字引用，这里为空 */
    refId: text("ref_id"),
    /** 名字：HTTP 模板里 {{名字}} 的名字、环境变量名；模型服务的 key 固定叫 api_key，代理密码叫 password */
    name: text("name").notNull(),
    version: integer("version").notNull().default(1),
    enc: jsonb("enc").$type<Envelope>().notNull(),
    masked: text("masked").notNull(),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("secrets_scope_ref_name_key").on(t.scope, t.refId, t.name).nullsNotDistinct()]
)

// ---------- 模型 ----------

export const modelProviders = pgTable("model_providers", {
  id: text("id").primaryKey(),
  kind: providerKindEnum("kind").notNull(),
  name: text("name").notNull(),
  /** 未配置时为空字符串 */
  baseUrl: text("base_url").notNull().default(""),
  apiKeySecretId: text("api_key_secret_id").references(() => secrets.id, { onDelete: "set null" }),
  status: providerStatusEnum("status").notNull(),
  checkedAt: ts("checked_at"),
  latencyMs: integer("latency_ms"),
  position: position(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const models = pgTable(
  "models",
  {
    /** 服务 id/模型名，例如 openrouter/anthropic/claude-sonnet-5.5 */
    id: text("id").primaryKey(),
    providerId: text("provider_id")
      .notNull()
      .references(() => modelProviders.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    note: text("note").notNull().default(""),
    contextK: integer("context_k").notNull(),
    /** 每百万 token 的价格（美元） */
    priceIn: numeric("price_in", { precision: 12, scale: 4, mode: "number" }).notNull().default(0),
    priceOut: numeric("price_out", { precision: 12, scale: 4, mode: "number" }).notNull().default(0),
    vision: boolean("vision").notNull().default(false),
    position: position(),
  },
  (t) => [index("models_provider_id_idx").on(t.providerId)]
)

/** 各角色的默认模型：执行 / 规划 / 三方验收 */
export const modelDefaults = pgTable("model_defaults", {
  role: modelRoleEnum("role").primaryKey(),
  modelId: text("model_id")
    .notNull()
    .references(() => models.id),
  updatedById: text("updated_by_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
})

// ---------- 浏览器 ----------

/** Chrome 配置：代理、出口、时区语言（方案 2.3.6 要加的字段），代理密码只存密文 */
export const browserProfiles = pgTable(
  "browser_profiles",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    proxyKind: proxyKindEnum("proxy_kind").notNull().default("none"),
    proxyHost: text("proxy_host"),
    proxyPort: integer("proxy_port"),
    proxyUsername: text("proxy_username"),
    proxyPasswordSecretId: text("proxy_password_secret_id").references(() => secrets.id, { onDelete: "set null" }),
    /** 出口所在地，例如「美国 · 洛杉矶」 */
    exitIp: text("exit_ip").notNull().default(""),
    timezone: text("timezone"),
    locale: text("locale"),
    position: position(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("browser_profiles_proxy_check", sql`${t.proxyKind} = 'none' or (${t.proxyHost} is not null and ${t.proxyPort} is not null)`)]
)

/** 每个 Chrome 里登录过的平台账号：状态、并发上限、登录探测网址 */
export const browserAccounts = pgTable(
  "browser_accounts",
  {
    id: text("id").primaryKey(),
    profileId: text("profile_id")
      .notNull()
      .references(() => browserProfiles.id, { onDelete: "cascade" }),
    platformId: text("platform_id")
      .notNull()
      .references(() => platforms.id),
    account: text("account").notNull(),
    status: accountStatusEnum("status").notNull(),
    lastLoginAt: ts("last_login_at"),
    loggedInById: text("logged_in_by_id").references(() => users.id, { onDelete: "set null" }),
    /** 这个账号同时最多几个 session 在用（已定：按「平台 × 账号」设，默认 1） */
    maxConcurrent: integer("max_concurrent").notNull().default(1),
    probeUrl: text("probe_url"),
    saveIndexedDb: boolean("save_indexed_db").notNull().default(false),
    position: position(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique("browser_accounts_profile_platform_account_key").on(t.profileId, t.platformId, t.account),
    check("browser_accounts_max_concurrent_check", sql`${t.maxConcurrent} >= 1`),
  ]
)

/** 登录态保险箱：每个 Chrome 一份加密的 cookie + localStorage，version 每次回写 +1（AAD 绑定「browser_vaults:Chrome id:version」） */
export const browserVaults = pgTable("browser_vaults", {
  profileId: text("profile_id")
    .primaryKey()
    .references(() => browserProfiles.id, { onDelete: "cascade" }),
  version: integer("version").notNull().default(1),
  enc: jsonb("enc").$type<Envelope>().notNull(),
  cookieCount: integer("cookie_count").notNull().default(0),
  updatedBySessionId: text("updated_by_session_id").references((): AnyPgColumn => sessions.id, { onDelete: "set null" }),
  updatedById: text("updated_by_id").references(() => users.id, { onDelete: "set null" }),
  updatedAt: updatedAt(),
})

// ---------- 工具、MCP、规则 ----------

export const mcpServers = pgTable(
  "mcp_servers",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    transport: mcpTransportEnum("transport").notNull(),
    command: text("command"),
    url: text("url"),
    status: mcpStatusEnum("status").notNull(),
    note: text("note").notNull().default(""),
    /** 环境变量的名字；值在 secrets 里（scope = mcp_env，ref_id = 服务器 id） */
    envKeys: text("env_keys").array().notNull().default(sql`'{}'::text[]`),
    position: position(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("mcp_servers_transport_check", sql`(${t.transport} = 'stdio' and ${t.command} is not null) or (${t.transport} = 'http' and ${t.url} is not null)`)]
)

export const tools = pgTable(
  "tools",
  {
    /** 模型里的名字，例如 browser.open */
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    summary: text("summary").notNull(),
    description: text("description").notNull(),
    source: toolSourceEnum("source").notNull(),
    serverId: text("server_id").references(() => mcpServers.id, { onDelete: "cascade" }),
    /** HTTP 接口的请求模板；密钥只以 {{名字}} 出现 */
    http: jsonb("http").$type<HttpSpec>(),
    risk: riskEnum("risk").notNull(),
    alwaysOn: boolean("always_on").notNull().default(false),
    position: position(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check("tools_source_check", sql`(${t.source} <> 'mcp' or ${t.serverId} is not null) and (${t.source} <> 'http' or ${t.http} is not null)`),
  ]
)

export const rules = pgTable("rules", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** 触发条件：一句话 */
  trigger: text("trigger").notNull(),
  action: text("action").notNull(),
  /** 翻译后的触发条件（方案 2.3.2：一种触发类型 + 参数），人确认后才写入；M3 用 */
  compiledTrigger: jsonb("compiled_trigger").$type<Record<string, unknown>>(),
  createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
  position: position(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

/** 规则命中后会调用的工具 */
export const ruleTools = pgTable(
  "rule_tools",
  {
    ruleId: text("rule_id")
      .notNull()
      .references(() => rules.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => tools.id, { onDelete: "cascade" }),
    position: position(),
  },
  (t) => [primaryKey({ columns: [t.ruleId, t.toolId] })]
)

// ---------- 任务 ----------

export const tasks = pgTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    goal: text("goal").notNull(),
    /** 步骤（可以为空，让 agent 自己探索）：[{ id, text, wait, checkpoint? }] */
    steps: jsonb("steps").$type<TaskStep[]>().notNull().default([]),
    ownerId: text("owner_id")
      .notNull()
      .references(() => users.id),
    enabled: boolean("enabled").notNull().default(true),
    scheduleCron: text("schedule_cron"),
    scheduleText: text("schedule_text"),
    nextRunAt: ts("next_run_at"),
    /** 不加外键：模型列表会随服务刷新变化，模型没了任务要换模型才能运行（原型模型页的说法） */
    modelId: text("model_id").notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("tasks_owner_id_idx").on(t.ownerId),
    check("tasks_schedule_check", sql`(${t.scheduleCron} is null) = (${t.scheduleText} is null)`),
  ]
)

// 任务和记忆、技能、工具、规则之间的关联表；position 保留建任务时选的顺序
const taskLink = <N extends string>(name: N, column: string, target: () => AnyPgColumn) =>
  pgTable(
    name,
    {
      taskId: text("task_id")
        .notNull()
        .references(() => tasks.id, { onDelete: "cascade" }),
      refId: text(column)
        .notNull()
        .references(target, { onDelete: "cascade" }),
      position: position(),
    },
    (t) => [primaryKey({ columns: [t.taskId, t.refId] }), index(`${name}_${column}_idx`).on(t.refId)]
  )

export const taskMemories = taskLink("task_memories", "memory_id", (): AnyPgColumn => memories.id)
export const taskSkills = taskLink("task_skills", "skill_id", (): AnyPgColumn => skills.id)
export const taskTools = taskLink("task_tools", "tool_id", () => tools.id)
export const taskRules = taskLink("task_rules", "rule_id", () => rules.id)

// ---------- 运行（session） ----------

export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    /** 父 session：v1.1 规划 agent 拆给子 agent 时用 */
    parentSessionId: text("parent_session_id").references((): AnyPgColumn => sessions.id, { onDelete: "set null" }),
    status: runStatusEnum("status").notNull(),
    modelId: text("model_id").notNull(),
    /** 怎么触发的：manual（人点）、cron、todo（人加的待办到点）、event（外部事件） */
    triggeredBy: text("triggered_by"),
    startedAt: ts("started_at").notNull(),
    endedAt: ts("ended_at"),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    exploredSteps: jsonb("explored_steps").$type<string[]>(),
    /** 最近一次三方验收的结论（每轮的过程在 session_events 里） */
    verification: jsonb("verification").$type<Verification>(),
    /** 乐观锁：状态变更用 where version = ? 防并发（M1） */
    version: integer("version").notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sessions_task_id_started_at_idx").on(t.taskId, t.startedAt.desc()),
    index("sessions_status_idx").on(t.status),
    index("sessions_parent_session_id_idx").on(t.parentSessionId),
  ]
)

/** 发给模型的完整消息历史，继续时读回（M1 写入）。按 (session_id, seq) 只追加 */
export const sessionMessages = pgTable(
  "session_messages",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** system / user / assistant / tool */
    role: text("role").notNull(),
    content: jsonb("content").notNull(),
    /** 长 session 压缩上下文时，被摘要替换掉的消息标记为 true（方案 2.3.5） */
    compacted: boolean("compacted").notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })]
)

/** 过程：模型调用、工具调用、检查点、规则命中、挂起和继续、验收。按 (session_id, seq) 只追加，库里有触发器禁止 UPDATE */
export const sessionEvents = pgTable(
  "session_events",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    at: ts("at").notNull(),
    kind: runEventKindEnum("kind").notNull(),
    title: text("title").notNull(),
    detail: text("detail"),
    /** 不加外键：工具删了以后过程记录还要能看 */
    toolId: text("tool_id"),
    input: text("input"),
    output: text("output"),
    ms: integer("ms"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })]
)

/** 每个 session 的检查点 */
export const checkpoints = pgTable(
  "checkpoints",
  {
    id: identity(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    position: position(),
    title: text("title").notNull(),
    kind: checkpointKindEnum("kind").notNull(),
    target: integer("target"),
    /** 来自任务的哪一步；agent 自己加的为空 */
    stepId: text("step_id"),
    status: checkpointStatusEnum("status").notNull().default("open"),
    progress: integer("progress"),
    skipReason: text("skip_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [unique("checkpoints_session_position_key").on(t.sessionId, t.position)]
)

/** 检查点的记录；synced = 规则「同步检查点」自动写的，agent 改不了 */
export const checkpointRecords = pgTable(
  "checkpoint_records",
  {
    id: identity(),
    checkpointId: bigint("checkpoint_id", { mode: "number" })
      .notNull()
      .references(() => checkpoints.id, { onDelete: "cascade" }),
    at: ts("at").notNull(),
    text: text("text").notNull(),
    synced: boolean("synced").notNull().default(false),
  },
  (t) => [index("checkpoint_records_checkpoint_id_idx").on(t.checkpointId)]
)

/**
 * 挂起的 session 在等什么（方案 2.3.5）：到点时间、等哪个事件、兜底期限。
 * 一个 session 同时只有一条 waiting；继续时用「status = 'waiting' 才能改」的条件更新，谁先到谁生效。
 */
export const sessionWaits = pgTable(
  "session_waits",
  {
    id: identity(),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** 一句话：在等什么 */
    what: text("what").notNull(),
    triggerKind: triggerKindEnum("trigger_kind").notNull(),
    /** 到点时间（time、time_or_event） */
    resumeAt: ts("resume_at"),
    /** 等哪个事件（event、time_or_event）：给人看的一句话 */
    event: text("event"),
    /** 事件匹配条件（M1：webhook 进来按 jsonb 包含匹配） */
    match: jsonb("match").$type<Record<string, unknown>>(),
    cron: text("cron"),
    cronText: text("cron_text"),
    /** 只等事件时最多等几天 */
    fallbackDays: integer("fallback_days"),
    /** 兜底期限：到期只提醒负责人，不自动继续 */
    deadlineAt: ts("deadline_at"),
    status: waitStatusEnum("status").notNull().default("waiting"),
    /** 谁让它继续的：timer / event / human / resume_now */
    firedCause: text("fired_cause"),
    firedAt: ts("fired_at"),
    /** 挂起的时间（原型 waiting.since） */
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("session_waits_one_waiting_idx").on(t.sessionId).where(sql`${t.status} = 'waiting'`),
    index("session_waits_resume_at_idx").on(t.resumeAt).where(sql`${t.status} = 'waiting'`),
  ]
)

/** 浏览器账号租约：哪个 session 占着哪个「平台 × 账号」、到期时间。released_at 为空表示还占着 */
export const accountLeases = pgTable(
  "account_leases",
  {
    id: identity(),
    accountId: text("account_id")
      .notNull()
      .references(() => browserAccounts.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    acquiredAt: ts("acquired_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    releasedAt: ts("released_at"),
  },
  (t) => [
    index("account_leases_active_idx").on(t.accountId).where(sql`${t.releasedAt} is null`),
    uniqueIndex("account_leases_one_active_idx").on(t.accountId, t.sessionId).where(sql`${t.releasedAt} is null`),
  ]
)

// ---------- 记忆、技能 ----------

export const memories = pgTable(
  "memories",
  {
    id: text("id").primaryKey(),
    content: text("content").notNull(),
    /** 适用于：「分类 · 对象」或只有分类 */
    appliesTo: text("applies_to").notNull(),
    status: memoryStatusEnum("status").notNull(),
    sourceKind: memorySourceKindEnum("source_kind").notNull(),
    sourceById: text("source_by_id").references(() => users.id, { onDelete: "set null" }),
    /** 不加外键：提议它的任务可能早就删了（原型里的 T-0950 等就是这种），来源照样要能显示 */
    sourceTaskId: text("source_task_id"),
    sourceSessionId: text("source_session_id").references(() => sessions.id, { onDelete: "set null" }),
    sourceEvidence: memoryEvidenceEnum("source_evidence"),
    reviewerId: text("reviewer_id").references(() => users.id, { onDelete: "set null" }),
    /** 来自网页内容、没核实过 */
    webUnverified: boolean("web_unverified").notNull().default(false),
    /** agent 提议时附的证据，一句话 */
    evidence: text("evidence"),
    /** 最近一次被读到（运行开始时读入），M1 由引擎写 */
    lastUsedAt: ts("last_used_at"),
    lastUsedSessionId: text("last_used_session_id").references(() => sessions.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "memories_source_check",
      sql`(${t.sourceKind} = 'human' and ${t.sourceById} is not null) or (${t.sourceKind} = 'agent' and ${t.sourceTaskId} is not null and ${t.sourceEvidence} is not null)`
    ),
  ]
)

export const skills = pgTable("skills", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  description: text("description").notNull(),
  dept: text("dept").notNull(),
  status: skillStatusEnum("status").notNull(),
  ownerId: text("owner_id")
    .notNull()
    .references(() => users.id),
  /** 当前版本号；历史在 skill_versions */
  version: integer("version").notNull().default(1),
  /** SKILL.md 正文（不含头部） */
  body: text("body").notNull(),
  position: position(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

export const skillTools = pgTable(
  "skill_tools",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    toolId: text("tool_id")
      .notNull()
      .references(() => tools.id, { onDelete: "cascade" }),
    position: position(),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.toolId] })]
)

/** 技能每一版的内容（保存一次 +1 版；agent 的修改建议通过后也记一版） */
export const skillVersions = pgTable(
  "skill_versions",
  {
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull(),
    body: text("body").notNull(),
    toolIds: text("tool_ids").array().notNull().default(sql`'{}'::text[]`),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.skillId, t.version] })]
)

// ---------- 待办 ----------

/** 要人办的事：审批、验收争议、登录和验证码、记忆审核、技能修改 */
export const humanItems = pgTable(
  "human_items",
  {
    id: text("id").primaryKey(),
    kind: humanItemKindEnum("kind").notNull(),
    title: text("title").notNull(),
    /** 一句话：为什么到了你这里 */
    summary: text("summary").notNull(),
    assigneeId: text("assignee_id")
      .notNull()
      .references(() => users.id),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    ruleId: text("rule_id").references(() => rules.id, { onDelete: "set null" }),
    memoryId: text("memory_id").references(() => memories.id, { onDelete: "set null" }),
    skillId: text("skill_id").references(() => skills.id, { onDelete: "set null" }),
    /** 越小越急 */
    urgency: integer("urgency").notNull().default(4),
    /** 处理时要看的几段话和按钮文案（原型 humanDetails） */
    detail: jsonb("detail").$type<HumanDetail>().notNull(),
    status: humanItemStatusEnum("status").notNull().default("open"),
    /** 处理结果：{ how: primary | secondary | reject, reason?, did? }（审计：谁批准了什么） */
    resolution: jsonb("resolution").$type<Record<string, unknown>>(),
    resolvedById: text("resolved_by_id").references(() => users.id, { onDelete: "set null" }),
    resolvedAt: ts("resolved_at"),
    createdAt: createdAt(),
  },
  (t) => [index("human_items_status_assignee_idx").on(t.status, t.assigneeId), index("human_items_session_id_idx").on(t.sessionId)]
)

/** agent 对技能的修改建议（在待办里审核） */
export const skillSuggestions = pgTable("skill_suggestions", {
  id: identity(),
  skillId: text("skill_id")
    .notNull()
    .references(() => skills.id, { onDelete: "cascade" }),
  taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
  sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
  summary: text("summary").notNull(),
  /** 改动（diff 行），通过后合并成新一版 */
  diff: jsonb("diff").$type<{ variant: "default" | "added" | "removed"; text: string }[]>(),
  reviewerId: text("reviewer_id")
    .notNull()
    .references(() => users.id),
  status: suggestionStatusEnum("status").notNull().default("pending"),
  humanItemId: text("human_item_id").references(() => humanItems.id, { onDelete: "set null" }),
  createdAt: createdAt(),
  resolvedAt: ts("resolved_at"),
})

/** 人加的待办：到点（可以是 cron）或等到事件，就让 agent 去做；有挂起的 session 就继续它 */
export const humanTodos = pgTable("human_todos", {
  id: text("id").primaryKey(),
  taskId: text("task_id")
    .notNull()
    .references(() => tasks.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  triggerKind: triggerKindEnum("trigger_kind").notNull(),
  at: ts("at"),
  cron: text("cron"),
  cronText: text("cron_text"),
  /** cron 的下一次（M1 由调度算好写回） */
  nextAt: ts("next_at"),
  event: text("event"),
  fallbackDays: integer("fallback_days"),
  status: todoStatusEnum("status").notNull().default("active"),
  createdById: text("created_by_id")
    .notNull()
    .references(() => users.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
})

// ---------- 文件 ----------

/** 截图和产物：文件本身放在服务器磁盘（storage_path），这里只记元数据 */
export const files = pgTable(
  "files",
  {
    id: text("id").primaryKey(),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    /** screenshot / artifact / upload */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    storagePath: text("storage_path").notNull(),
    sha256: text("sha256").notNull(),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
  },
  (t) => [index("files_session_id_idx").on(t.sessionId)]
)
