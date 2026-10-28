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
  vector,
  type AnyPgColumn,
} from "drizzle-orm/pg-core"
import {
  accountStatusSchema,
  GALLERY_EMBED_DIMENSIONS,
  MEMORY_EMBED_DIMENSIONS,
  checkpointKindSchema,
  compareConfidenceSchema,
  compareStatusSchema,
  compareViaSchema,
  importStatusSchema,
  humanItemKindSchema,
  memoryEvidenceSchema,
  memoryStatusSchema,
  modelProviderKindSchema,
  modelRoleSchema,
  providerStatusSchema,
  riskSchema,
  routineModeSchema,
  routineStatusSchema,
  routineVersionStatusSchema,
  runEventKindSchema,
  runOutcomeBySchema,
  runStatusSchema,
  sessionKindSchema,
  skillStatusSchema,
  toolSourceSchema,
  workItemStatusSchema,
  workViaSchema,
  type AssistantChange,
  type DesktopKind,
  type DesktopVmState,
  type EventTrace,
  type AssistantProposalStatus,
  type HttpSpec,
  type HumanDetail,
  type ImportPlan,
  type ImportReadStep,
  type ImportResult,
  type RoutineTestReport,
  type RuleCompileResult,
  type SessionDigest,
  type SessionRoutineState,
  type SessionSnapshot,
  type TaskDispatch,
  type TaskStep,
  type RunOutcome,
  type RunReview,
  type Verification,
  type WorkLogEntry,
  type WorkFailKind,
  type WorkResult,
} from "@heyagent/shared"

import type { Envelope } from "../lib/crypto.js"

/** 虚拟机等着做的一次性操作（desktop_vms.op） */
export type DesktopVmOp = "restart" | "reset" | "seal" | "delete"

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

// ---------- M3 的 jsonb 结构 ----------

export interface SessionRuleState {
  /** 「花费超过 X」已经触发过的规则 id */
  costFired?: string[]
  /** 已经提示过「还没生效、这次不执行」的规则 */
  warned?: boolean
  /** run-outcome 3.2：agent 只回文字、没调 run.finish，已经提醒过一次（再回文字就按没报结果收尾） */
  finishNudged?: boolean
}

/** 库里的派活配置：run-outcome 以前存的没有 results */
export type StoredTaskDispatch = Omit<TaskDispatch, "results"> & Partial<Pick<TaskDispatch, "results">>

export interface PendingCall {
  toolCallId: string
  toolName: string
  input: unknown
  invalid?: boolean
  error?: string
}

/** 一步里从等审批的那个调用开始、还没处理的工具调用 */
export interface PendingToolCalls {
  calls: PendingCall[]
  /** 已经批准过的规则（继续时第一个调用不再因为这些规则拦下） */
  approvedRuleIds: string[]
  ruleId: string
  ruleName: string
  /** 人处理完写上：approve = 执行；reject = 不执行，把理由告诉 agent */
  decision?: { how: "approve" | "reject"; note?: string; actorName: string }
  /** executing：正在执行批准的那个调用（进程中途被杀掉时，继续时不再重复执行）；done：处理完了 */
  state?: "executing" | "done"
  /**
   * 固化脚本的第几个工具调用要审批（docs/dev/solidify.md 17.2）：这时 calls 是空的（不是模型的调用），
   * 继续时按日志重放脚本，到这一步按 decision 做（批准 = 带上 ruleId 真做；拒绝 = 停下交给 agent）
   */
  routineStep?: number
}

// ---------- 枚举 ----------

export const runStatusEnum = pgEnum("run_status", values(runStatusSchema.options))
/**
 * 库里的 run_outcome 枚举还有 partial（部分办成）、unverified（没核实）：2026-10-20 简化成办成 / 没办成以后不再写入，
 * 迁移 0026 把旧数据都改成了 not_achieved。Postgres 的枚举值删不掉（同 run_status 的 incomplete），留着不用；列的类型按 RunOutcome 收窄
 */
export const runOutcomeEnum = pgEnum("run_outcome", ["achieved", "partial", "not_achieved", "unverified"])
export const runOutcomeByEnum = pgEnum("run_outcome_by", values(runOutcomeBySchema.options))
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
/**
 * 密钥属于什么：HTTP 工具模板里的 {{名字}}、MCP 服务器的环境变量、模型服务的 API key、Chrome 代理密码；
 * import：导入时从 zip 包里挪出来的、人在确认时填的密钥值（ref_id = 导入 id），导入时转存成 http_tool 的全局密钥
 */
export const secretScopeEnum = pgEnum("secret_scope", ["http_tool", "mcp_env", "model_provider", "browser_proxy", "browser_account", "import", "desktop"])
export const importStatusEnum = pgEnum("import_status", values(importStatusSchema.options))
export const compareStatusEnum = pgEnum("compare_status", values(compareStatusSchema.options))
export const compareConfidenceEnum = pgEnum("compare_confidence", values(compareConfidenceSchema.options))
export const compareViaEnum = pgEnum("compare_via", values(compareViaSchema.options))
export const workItemStatusEnum = pgEnum("work_item_status", values(workItemStatusSchema.options))
export const workViaEnum = pgEnum("work_via", values(workViaSchema.options))
// 固化（docs/dev/solidify.md）
export const routineStatusEnum = pgEnum("routine_status", values(routineStatusSchema.options))
export const routineVersionStatusEnum = pgEnum("routine_version_status", values(routineVersionStatusSchema.options))
export const routineModeEnum = pgEnum("routine_mode", values(routineModeSchema.options))
export const sessionKindEnum = pgEnum("session_kind", values(sessionKindSchema.options))

// ---------- 新 id 用的序列（规则见 shared/ids.ts） ----------

export const taskNoSeq = pgSequence("task_no_seq", { startWith: 1 })
export const memoryNoSeq = pgSequence("memory_no_seq", { startWith: 1 })
export const skillNoSeq = pgSequence("skill_no_seq", { startWith: 1 })
export const ruleNoSeq = pgSequence("rule_no_seq", { startWith: 1 })
export const humanItemNoSeq = pgSequence("human_item_no_seq", { startWith: 1 })
export const todoNoSeq = pgSequence("todo_no_seq", { startWith: 1 })
export const galleryNoSeq = pgSequence("gallery_no_seq", { startWith: 1 })
export const apiKeyNoSeq = pgSequence("api_key_no_seq", { startWith: 1 })
export const importNoSeq = pgSequence("import_no_seq", { startWith: 1 })
export const compareNoSeq = pgSequence("compare_no_seq", { startWith: 1 })
export const compareStandardNoSeq = pgSequence("compare_standard_no_seq", { startWith: 1 })
export const workItemNoSeq = pgSequence("work_item_no_seq", { startWith: 1 })
export const routineNoSeq = pgSequence("routine_no_seq", { startWith: 1 })

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
  /** 这个平台的域名（M2）：session 打开这些域名下的网址时，按「平台 × 账号」申请租约。例如 ["example.com"]，子域名也算 */
  domains: text("domains").array().notNull().default(sql`'{}'::text[]`),
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
  /**
   * 自定义服务认不认 response_format: json_schema（vLLM、strata 等认）。认：结构化输出把 JSON Schema 发给服务按格式回答；
   * 不认（默认）：只发 json_object，格式写进提示词。其余类型不看这一列
   */
  supportsJsonSchema: boolean("supports_json_schema").notNull().default(false),
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
    /** chat = 能调工具的聊天模型；embedding = 向量模型（图库用，vision 表示能处理图片） */
    kind: text("kind").$type<"chat" | "embedding">().notNull().default("chat"),
    /** 人手动加的（自定义服务）：刷新模型列表时不删，列表里有同名的也以手动填的为准 */
    manual: boolean("manual").notNull().default(false),
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
  (t) => [
    check("browser_profiles_proxy_check", sql`${t.proxyKind} = 'none' or (${t.proxyHost} is not null and ${t.proxyPort} is not null)`),
  ]
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
  /** M3：正在执行的版本（compiled_trigger）是按哪段文字翻译、确认的：「触发条件\n命中后怎么办」 */
  compiledText: text("compiled_text"),
  /** M3：最近一次翻译的结果（不管支不支持）；文字改了就清空 */
  compileDraft: jsonb("compile_draft").$type<RuleCompileResult>(),
  confirmedById: text("confirmed_by_id").references(() => users.id, { onDelete: "set null" }),
  confirmedAt: ts("confirmed_at"),
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
    /** M2：选了「浏览器」工具时，允许用哪些 Chrome 配置（browser_profiles.id）；空表示不限 */
    browserProfileIds: text("browser_profile_ids").array().notNull().default(sql`'{}'::text[]`),
    /** M2：网址白名单（域名，子域名也算）；空表示不限制 */
    allowedDomains: text("allowed_domains").array().notNull().default(sql`'{}'::text[]`),
    /** M2：是否允许 agent 在网页里执行脚本（Playwright MCP 的 browser_evaluate），默认不允许 */
    allowBrowserEvaluate: boolean("allow_browser_evaluate").notNull().default(false),
    /** 是否允许 agent 看画面（browser.look 截图发给模型 + 按坐标操作），默认不允许 */
    allowBrowserVision: boolean("allow_browser_vision").notNull().default(false),
    /** 桌面：选了「桌面」工具时，允许用哪些桌面（desktops.id）；空表示不限 */
    desktopIds: text("desktop_ids").array().notNull().default(sql`'{}'::text[]`),
    /** 桌面：是否允许 agent 看画面（desktop.look、desktop.snapshot 带截图），默认不允许 */
    allowDesktopVision: boolean("allow_desktop_vision").notNull().default(false),
    /** M3：这个任务自己选的三方验收模型；为空用默认验收模型 */
    verifyModelId: text("verify_model_id"),
    /**
     * 复核模型（run-outcome）：运行结束后一定复核（三方验收通过的除外）。新建、保存任务时必填；
     * 2026-10-20 以前建的任务可能为空（迁移 0026 补了默认复核模型，没有默认的留空），运行时用默认复核模型
     */
    reviewModelId: text("review_model_id"),
    /** 派活：能被派活时的参数声明和名额；为空 = 不能被派活。results（要交回的结果）是 run-outcome 加的，旧数据没有 = 不要求 */
    dispatch: jsonb("dispatch").$type<StoredTaskDispatch>(),
    /** 定时到点时上一次还没跑完（执行中 / 验收中）就跳过这次 */
    cronSkipIfRunning: boolean("cron_skip_if_running").notNull().default(true),
    /** 固化流程的开关（docs/dev/solidify.md 6.1）：off = 不用；first = 先跑流程。第一次启用固化流程时自动打开 */
    routineMode: routineModeEnum("routine_mode").notNull().default("off"),
    /** 办成后自动固化（docs/dev/solidify.md 17.1）：空 = 按默认（被派的、定时的开，shared 的 autoSolidifyDefault） */
    autoSolidify: boolean("auto_solidify"),
    /** 固化时不试跑（会自动存草稿的网站）：自动固化照它，手动固化的弹窗默认勾上 */
    routineSkipTest: boolean("routine_skip_test").notNull().default(false),
    /**
     * 自动挑选记忆（docs/dev/memory-retrieval.md 第 4 节）：运行开始时按这次要办的事从记忆库里再挑几条。
     * 库里默认关（迁移前建的任务保持原样）；新建任务时 shared 的 taskInputSchema 默认开，总是显式写入
     */
    autoMemory: boolean("auto_memory").notNull().default(false),
    /** 自动挑的最多几条（1～20） */
    autoMemoryLimit: integer("auto_memory_limit").notNull().default(5),
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

/** 派活：谁能派活给这个任务（task_id 是被派的，source_task_id 是派活的）。删任务时级联清掉 */
export const taskDispatchSources = pgTable(
  "task_dispatch_sources",
  {
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    sourceTaskId: text("source_task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.sourceTaskId] }), index("task_dispatch_sources_source_idx").on(t.sourceTaskId)]
)

/**
 * 任务记忆：每个任务自己的经验，一条一行，按 id 排序。负责人和主管能直接写、改、删；
 * 运行结束后三方 AI 总结出的候选，人审核通过后也记进来（source_session_id 指向那次运行）。每次运行开始时全部放进系统提示
 */
export const taskMemoryEntries = pgTable(
  "task_memory_entries",
  {
    id: identity(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    content: text("content").notNull(),
    /** 从哪次运行总结来的；人直接写的为空 */
    sourceSessionId: text("source_session_id").references((): AnyPgColumn => sessions.id, { onDelete: "set null" }),
    /** 人写的：谁写的；总结来的：谁审核通过的 */
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("task_memory_entries_task_id_idx").on(t.taskId, t.id)]
)

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
    /** 结果（run-outcome）：办成 / 没办成；运行结束时写，没结束、复核还在跑时为空 */
    outcome: runOutcomeEnum("outcome").$type<RunOutcome>(),
    /** 结果的原因（没办成缺了什么、复核理由、人改结果的理由） */
    outcomeReason: text("outcome_reason"),
    /** 结果是谁定的：agent / rule / review / verify / human */
    outcomeBy: runOutcomeByEnum("outcome_by"),
    /** 轻量复核的报告（跑过复核才有） */
    review: jsonb("review").$type<RunReview>(),
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
    /** 开始运行时冻结的任务配置（M1）：步骤、目标、检查点、记忆、技能、工具、规则、模型、附件 */
    snapshot: jsonb("snapshot").$type<SessionSnapshot>(),
    /** 额外的一句话（人加的待办的标题、立即运行时的备注） */
    note: text("note"),
    /** 谁点的「立即运行」 */
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    /** 失败、取消或没完成的原因 */
    error: text("error"),
    /** 已经调了几次模型（步数上限按它算） */
    stepCount: integer("step_count").notNull().default(0),
    /** 这个 session 的花费上限 / 步数上限；为空用 settings 里的。人同意「继续」时调高 */
    costLimitUsd: numeric("cost_limit_usd", { precision: 12, scale: 6, mode: "number" }),
    maxSteps: integer("max_steps"),
    /** session_events / session_messages 的序号计数器：API 和 worker 都会追加，用行锁发号 */
    eventSeq: integer("event_seq").notNull().default(0),
    msgSeq: integer("msg_seq").notNull().default(0),
    /**
     * M2：这次运行用的 Chrome 配置。第一次用浏览器时系统从任务允许的里自动挑一个空闲的（每个 Chrome 同时只给一个运行用），
     * 或者 agent 先调 browser.use 指定。分到以后从头到尾只用它，绝不切换：挂起再继续时它被别的运行占着就等它
     */
    browserProfileId: text("browser_profile_id"),
    /** 桌面：这次运行用的桌面。和 Chrome 一样，分到以后从头到尾只用它（docs/dev/desktop.md 第 3 节） */
    desktopId: text("desktop_id"),
    /** M3：规则执行的状态（例如「花费超过 X」已经触发过的规则，不再重复触发） */
    ruleState: jsonb("rule_state").$type<SessionRuleState>().notNull().default({}),
    /** 运行结束后三方 AI 的总结和任务记忆候选（人点「总结」才有；审核通过的记进 task_memory_entries） */
    digest: jsonb("digest").$type<SessionDigest>(),
    /** 派活触发的运行：哪张派活单（parent_session_id 同时写派活的那次运行） */
    workItemId: text("work_item_id").references((): AnyPgColumn => workItems.id, { onDelete: "set null" }),
    /** 运行的种类（docs/dev/solidify.md 5.6）：run = 普通运行；routine_test = 固化试跑（不进会话列表、不算统计） */
    kind: sessionKindEnum("kind").notNull().default("run"),
    /** 跑过固化流程的运行、固化试跑：脚本跑到哪了、停在哪、为什么（shared/routine.ts 的 sessionRoutineStateSchema） */
    routine: jsonb("routine").$type<SessionRoutineState>(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("sessions_task_id_started_at_idx").on(t.taskId, t.startedAt.desc()),
    index("sessions_status_idx").on(t.status),
    index("sessions_parent_session_id_idx").on(t.parentSessionId),
    index("sessions_work_item_id_idx").on(t.workItemId),
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
    /** M3：压缩后发给模型的内容（摘要 + 文件引用）。compacted = true 时读这个，原文 content 留着 */
    summary: jsonb("summary"),
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
    /** 固化的录制信息（docs/dev/solidify.md 3.2）：浏览器动作录下的定位代码、前后网址；脚本做的步骤记第几次调用 */
    trace: jsonb("trace").$type<EventTrace>(),
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
    /** M3：agent 用 checkpoint.mark(status = doing) 指定「现在在做这个」的时间；同类型有多个时，自动记录记到最近指定的那个 */
    focusedAt: ts("focused_at"),
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
    /** 等的是一件「要人办的事」（ask.human、花费上限）：处理完就继续 */
    humanItemId: text("human_item_id").references((): AnyPgColumn => humanItems.id, { onDelete: "set null" }),
    /** 兜底期限到了、已经提醒过负责人的时间 */
    remindedAt: ts("reminded_at"),
    /** M3：等审批的工具调用（规则「调工具前交给人审批」）。处理完写上 decision，继续时由引擎先处理这些调用 */
    pending: jsonb("pending").$type<PendingToolCalls>(),
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

// ---------- 桌面（docs/dev/desktop.md） ----------

/**
 * 一台桌面：装了 Windows-MCP 和桌面服务的 Windows 电脑。两个服务共用一个密钥（只存密文，secrets.scope = desktop）。
 * kind（docs/dev/desktop-vm.md 第 0 节）：manual 手动登记的；vm 系统开的桌面（从模板复制）；template 模板。
 * vm / template 的地址和密钥由系统管（desktop_vms 一行），模板不分给运行
 */
export const desktops = pgTable(
  "desktops",
  {
    id: text("id").primaryKey(),
    kind: text("kind").$type<DesktopKind>().notNull().default("manual"),
    name: text("name").notNull(),
    /** 给 agent 看的说明：装了哪些软件、登的哪个账号 */
    description: text("description").notNull().default(""),
    mcpUrl: text("mcp_url").notNull(),
    agentUrl: text("agent_url").notNull(),
    keySecretId: text("key_secret_id").references(() => secrets.id, { onDelete: "set null" }),
    /** 谁建的（系统开的桌面：建的人能开关、重置、删除） */
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    position: position(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [check("desktops_kind_check", sql`${t.kind} in ('manual', 'vm', 'template')`)]
)

/**
 * 系统开的桌面和模板的虚拟机（docs/dev/desktop-vm.md 第 1、4 节）：一台一行，一台 = 一个 Podman 容器（dockurr/windows）。
 * 接口只改 desired / op，worker 去做（同一台同时只有一个操作，pg-boss 的 desktop.vm 队列按桌面 id 排）。
 * op：等着做的一次性操作（restart / reset / seal / delete），做完清掉；开机、关机只改 desired
 */
export const desktopVms = pgTable(
  "desktop_vms",
  {
    desktopId: text("desktop_id")
      .primaryKey()
      .references(() => desktops.id, { onDelete: "cascade" }),
    /** 桌面从哪个模板建的（模板自己为空）。模板有桌面在用就删不了 */
    templateId: text("template_id").references((): AnyPgColumn => desktops.id, { onDelete: "restrict" }),
    /** 存放位置（HEYAGENT_DESKTOP_STORAGE_ROOTS 里的一个） */
    storagePath: text("storage_path").notNull(),
    /** 这台的目录：<存放位置>/heyagent-desktops/<desktopId>，挂进容器的 /storage */
    dir: text("dir").notNull(),
    container: text("container").notNull(),
    state: text("state").$type<DesktopVmState>().notNull(),
    desired: text("desired").$type<"running" | "stopped">().notNull(),
    op: text("op").$type<DesktopVmOp>(),
    message: text("message"),
    stateSince: ts("state_since").notNull().defaultNow(),
    /** 模板第一次连上桌面服务（Windows 和两个服务装好了）的时间；之后再开机不算「装 Windows」 */
    installedAt: ts("installed_at"),
    memoryGb: integer("memory_gb").notNull(),
    cpus: integer("cpus").notNull(),
    diskGb: integer("disk_gb").notNull(),
    mcpPort: integer("mcp_port").notNull().unique(),
    agentPort: integer("agent_port").notNull().unique(),
    /** Windows 的登录密码（模板生成，从它建的桌面共用） */
    vmPasswordSecretId: text("vm_password_secret_id").references(() => secrets.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    check(
      "desktop_vms_state_check",
      sql`${t.state} in ('creating', 'installing', 'starting', 'running', 'setup', 'ready', 'stopping', 'stopped', 'error', 'deleting')`
    ),
    check("desktop_vms_desired_check", sql`${t.desired} in ('running', 'stopped')`),
    check("desktop_vms_op_check", sql`${t.op} is null or ${t.op} in ('restart', 'reset', 'seal', 'delete')`),
    index("desktop_vms_template_idx").on(t.templateId),
  ]
)

/**
 * 桌面的占用：一台桌面最多一行（同一时间只给一个运行用）。有行 = 被占着；运行结束删掉。
 * running：运行在用，worker 每次调工具、每 30 秒续 expires_at，过期没续（worker 死了）由巡查删掉并叫醒等它的运行；
 * held：转人工时保留给这个运行，到 hold_until 还没处理完就放掉
 */
export const desktopLeases = pgTable(
  "desktop_leases",
  {
    desktopId: text("desktop_id")
      .primaryKey()
      .references(() => desktops.id, { onDelete: "cascade" }),
    sessionId: text("session_id")
      .notNull()
      .unique()
      .references(() => sessions.id, { onDelete: "cascade" }),
    state: text("state").$type<"running" | "held">().notNull(),
    acquiredAt: ts("acquired_at").notNull().defaultNow(),
    expiresAt: ts("expires_at").notNull(),
    holdUntil: ts("hold_until"),
  },
  (t) => [check("desktop_leases_state_check", sql`${t.state} in ('running', 'held')`)]
)

/** M2：带 Chrome 的 worker（每个进程一行，心跳）。API 按 control_url 找它：打开 Chrome、远程画面转发 */
export const browserWorkers = pgTable("browser_workers", {
  id: text("id").primaryKey(),
  /** worker 的内部控制地址（只绑 127.0.0.1，API 和 worker 在同一个 pod 里），例如 http://127.0.0.1:3190 */
  controlUrl: text("control_url").notNull(),
  /** 这个 worker 同时最多开几个 Chrome（启动时的设置，给页面看） */
  maxBrowsers: integer("max_browsers").notNull(),
  startedAt: ts("started_at").notNull().defaultNow(),
  heartbeatAt: ts("heartbeat_at").notNull().defaultNow(),
})

/** M2：现在开着（或排队、保留着）的 Chrome。worker 起 Chrome 时写入，关掉时删除；worker 死掉后按心跳清理 */
export const browserInstances = pgTable(
  "browser_instances",
  {
    id: text("id").primaryKey(),
    workerId: text("worker_id")
      .notNull()
      .references(() => browserWorkers.id, { onDelete: "cascade" }),
    /** session = 某次运行在用；login = 人「打开 Chrome」开的 */
    kind: text("kind").$type<"session" | "login">().notNull(),
    profileId: text("profile_id")
      .notNull()
      .references(() => browserProfiles.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "cascade" }),
    accountId: text("account_id").references(() => browserAccounts.id, { onDelete: "set null" }),
    openedById: text("opened_by_id").references(() => users.id, { onDelete: "set null" }),
    /** queued / starting / running / held（等人处理，保留到 hold_until）/ closing */
    state: text("state").$type<"queued" | "starting" | "running" | "held" | "closing">().notNull(),
    url: text("url").notNull().default(""),
    title: text("title").notNull().default(""),
    /** 正在看远程画面的人 */
    viewers: jsonb("viewers").$type<{ userId: string; canControl: boolean }[]>().notNull().default([]),
    holdUntil: ts("hold_until"),
    startedAt: ts("started_at").notNull().defaultNow(),
    lastActiveAt: ts("last_active_at").notNull().defaultNow(),
  },
  (t) => [index("browser_instances_session_id_idx").on(t.sessionId), index("browser_instances_worker_id_idx").on(t.workerId)]
)

/** 浏览器页「操作历史」：agent 每调一次浏览器工具记一行（哪个 Chrome、哪次运行、调完停在哪个网址、什么动作）。只留 90 天 */
export const browserActions = pgTable(
  "browser_actions",
  {
    id: identity(),
    profileId: text("profile_id")
      .notNull()
      .references(() => browserProfiles.id, { onDelete: "cascade" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    url: text("url").notNull(),
    /** 动作标签，例如 Click、Input（见 shared 的 browserActionTag） */
    action: text("action").notNull(),
    failed: boolean("failed").notNull().default(false),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [index("browser_actions_profile_at_idx").on(t.profileId, t.at)]
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
    /** 最近一次算向量失败：原因和时间（后台隔 10 分钟再试；算成了清空）。改这两列会推 memories，记忆页的「算没算好」跟着刷新 */
    embedError: text("embed_error"),
    embedTriedAt: ts("embed_tried_at"),
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

/**
 * 记忆的向量（docs/dev/memory-retrieval.md 第 2 节）：每个 embedding 模型一行，换模型时新旧并存，新模型全部算完才删旧的。
 * content_hash = md5(适用于 + 换行 + 内容)（shared 的 memoryEmbedText）：和记忆现在的内容对不上 = 内容改过、要重算，挑选时不用它。
 * 不建 HNSW：记忆最多几千条，精确算一遍只要几毫秒，还不会因为带着筛选条件漏掉结果。不推实时（行里有 1024 维向量，NOTIFY 太大）
 */
export const memoryEmbeddings = pgTable(
  "memory_embeddings",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    contentHash: text("content_hash").notNull(),
    embedding: vector("embedding", { dimensions: MEMORY_EMBED_DIMENSIONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.memoryId, t.modelId] }), index("memory_embeddings_model_id_idx").on(t.modelId)]
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
    /** 审核固化流程：哪一版（docs/dev/solidify.md 5.7） */
    routineVersionId: text("routine_version_id").references((): AnyPgColumn => routineVersions.id, { onDelete: "set null" }),
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
    /** 任务附件：跨运行一直有效（session_id 为空）。session 的附件和产物只属于那次运行 */
    taskId: text("task_id").references(() => tasks.id, { onDelete: "cascade" }),
    /** screenshot / artifact / upload */
    kind: text("kind").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    storagePath: text("storage_path").notNull(),
    sha256: text("sha256").notNull(),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    /**
     * Session 空间里的路径（docs/dev/session-space.md 2.1）：只有 agent 写的文件（artifact）有，例如 state/progress.json；
     * 同一个 session 里唯一，同一路径再写就是覆盖（id 不变）。别的来源为空，列表里放在固定目录下
     */
    path: text("path"),
    createdAt: createdAt(),
    /** 最后一次覆盖内容的时间（不用 $onUpdate：挂到任务上这类改元数据的不算） */
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [
    index("files_session_id_idx").on(t.sessionId),
    index("files_task_id_idx").on(t.taskId),
    uniqueIndex("files_session_path_idx").on(t.sessionId, t.path).where(sql`${t.kind} = 'artifact' and ${t.path} is not null`),
  ]
)

// ---------- M1 公共表（监工在并行开发前先建好，两个开发包都要用） ----------

/** 审计：谁在什么时候改了什么配置、批准了什么（方案 2.3.7）。只追加 */
export const auditEvents = pgTable(
  "audit_events",
  {
    id: identity(),
    at: ts("at").notNull().defaultNow(),
    /** 谁做的；系统自己做的（定时、agent）为空 */
    actorId: text("actor_id").references(() => users.id, { onDelete: "set null" }),
    /** 例如 task.create、memory.approve、human_item.resolve */
    action: text("action").notNull(),
    targetTable: text("target_table").notNull(),
    targetId: text("target_id").notNull(),
    /** 改了哪些字段、处理意见等；不放密钥原文 */
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("audit_events_target_idx").on(t.targetTable, t.targetId), index("audit_events_at_idx").on(t.at)]
)

/** 全局设置（键值）：例如每个 session 的花费上限、只靠事件继续的兜底天数、通知渠道 */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").$type<unknown>().notNull(),
  updatedAt: updatedAt(),
  updatedById: text("updated_by_id").references(() => users.id, { onDelete: "set null" }),
})

// ---------- M1 引擎（包 P1） ----------

/** 站内通知：给谁、标题、内容、链接、已读时间 */
export const notifications = pgTable(
  "notifications",
  {
    id: identity(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    /** 控制台里的链接，例如 /sessions/R-1024-1 */
    link: text("link"),
    taskId: text("task_id").references(() => tasks.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    readAt: ts("read_at"),
    createdAt: createdAt(),
  },
  (t) => [index("notifications_user_created_idx").on(t.userId, t.createdAt.desc())]
)

// ---------- API 密钥、图库 ----------

/** 外部系统调接口用的密钥（只有主管能建）：库里只存 sha256，原文只在新建时给一次。用它做的事算在创建人头上 */
export const apiKeys = pgTable("api_keys", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  /** 尾号，给人认 */
  hint: text("hint").notNull(),
  sha256: text("sha256").notNull().unique(),
  createdById: text("created_by_id")
    .notNull()
    .references(() => users.id),
  lastUsedAt: ts("last_used_at"),
  createdAt: createdAt(),
})

/**
 * 图库里的图：原图和缩略图都是 files 里的文件（kind = gallery / gallery_thumb），这里记文本（JSON 对象）和标签。
 * 同一份文件（sha256 一样）只存一条。向量在 gallery_embeddings，按模型分开存，换模型后后台重算。
 */
export const galleryImages = pgTable(
  "gallery_images",
  {
    id: text("id").primaryKey(),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id),
    thumbFileId: text("thumb_file_id")
      .notNull()
      .references(() => files.id),
    sha256: text("sha256").notNull(),
    name: text("name").notNull(),
    mime: text("mime").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    width: integer("width").notNull(),
    height: integer("height").notNull(),
    text: jsonb("text").$type<Record<string, unknown>>().notNull().default({}),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** web / api / mcp / agent */
    via: text("via").$type<"web" | "api" | "mcp" | "agent">().notNull(),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    /** 最近一次算向量失败：原因和时间（后台重算时隔一会儿再试） */
    embedError: text("embed_error"),
    embedTriedAt: ts("embed_tried_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("gallery_images_sha256_idx").on(t.sha256),
    index("gallery_images_created_idx").on(t.createdAt.desc(), t.id.desc()),
    index("gallery_images_tags_idx").using("gin", t.tags),
    index("gallery_images_text_idx").using("gin", t.text.op("jsonb_path_ops")),
  ]
)

/** 图的向量：每个模型一行（换模型时新旧并存，重算完之前搜索还能用旧的） */
export const galleryEmbeddings = pgTable(
  "gallery_embeddings",
  {
    imageId: text("image_id")
      .notNull()
      .references(() => galleryImages.id, { onDelete: "cascade" }),
    modelId: text("model_id").notNull(),
    embedding: vector("embedding", { dimensions: GALLERY_EMBED_DIMENSIONS }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.imageId, t.modelId] }),
    index("gallery_embeddings_hnsw_idx").using("hnsw", t.embedding.op("vector_cosine_ops")),
  ]
)

// ---------- 导入（2026-10-18） ----------

/**
 * 一次导入：上传的 zip 包（files 里 kind = import 的一行，解压出的文件放在文件目录的 imports/<id>/ 下）、
 * AI 读包的过程和整理出的方案、确认到哪一步、导入后建了什么（撤销时按它删）。
 * 包里挪出来的密钥值不在这里，在 secrets（scope = import，ref_id = 导入 id）。
 */
export const imports = pgTable(
  "imports",
  {
    id: text("id").primaryKey(),
    /** 上传的 zip；放弃导入时连文件一起删 */
    fileId: text("file_id").references(() => files.id, { onDelete: "set null" }),
    fileName: text("file_name").notNull(),
    size: bigint("size", { mode: "number" }).notNull(),
    /** 包里有多少个文件（解压后才知道） */
    fileCount: integer("file_count").notNull().default(0),
    /** AI 起的名字，读完才有 */
    name: text("name"),
    /** 上传时的补充说明 */
    note: text("note").notNull().default(""),
    /** 读包用的模型 */
    modelId: text("model_id").notNull(),
    status: importStatusEnum("status").notNull(),
    readLog: jsonb("read_log").$type<ImportReadStep[]>().notNull().default([]),
    /** 导入方案：读完写入，确认时随改随存 */
    plan: jsonb("plan").$type<ImportPlan>(),
    /** 确认到哪一步、看过哪几步（ImportStep） */
    step: text("step").notNull().default("overview"),
    visited: text("visited").array().notNull().default(sql`'{}'::text[]`),
    /** 导入后建了什么、用了哪些已有的；撤销后加上 undo */
    result: jsonb("result").$type<ImportResult>(),
    /** 读包（含翻译规则）一共花了多少 */
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    /** 没读成的原因 */
    error: text("error"),
    createdById: text("created_by_id")
      .notNull()
      .references(() => users.id),
    readAt: ts("read_at"),
    importedAt: ts("imported_at"),
    importedById: text("imported_by_id").references(() => users.id, { onDelete: "set null" }),
    undoneAt: ts("undone_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("imports_created_at_idx").on(t.createdAt.desc())]
)

// ---------- 比物（2026-10-18） ----------

/** 比对标准：一段打分要求 + 合格线 + 模型。页面、agent、接口都按标准比，结果才前后一致。只有一个 is_default */
export const compareStandards = pgTable(
  "compare_standards",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    prompt: text("prompt").notNull(),
    passScore: integer("pass_score").notNull(),
    /** 不加外键：模型列表会随服务刷新变化 */
    modelId: text("model_id").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    position: position(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("compare_standards_name_idx").on(t.name), uniqueIndex("compare_standards_default_idx").on(t.isDefault).where(sql`${t.isDefault}`)]
)

/**
 * 一次比对：两张图（files 里 kind = compare 的文件）、当时用的要求 / 合格线 / 模型、模型给的结论。
 * dedupe_key = 两张图的 sha256 + 要求 + 模型的哈希：COMPARE_REUSE_MINUTES 内重复比直接返回上次的结果
 */
export const comparisons = pgTable(
  "comparisons",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    status: compareStatusEnum("status").notNull(),
    fileAId: text("file_a_id").notNull().references(() => files.id),
    fileBId: text("file_b_id").notNull().references(() => files.id),
    labelA: text("label_a").notNull().default(""),
    labelB: text("label_b").notNull().default(""),
    fromA: text("from_a").notNull().default(""),
    fromB: text("from_b").notNull().default(""),
    standardId: text("standard_id").references(() => compareStandards.id, { onDelete: "set null" }),
    standardName: text("standard_name"),
    prompt: text("prompt").notNull(),
    passScore: integer("pass_score").notNull(),
    modelId: text("model_id").notNull(),
    dedupeKey: text("dedupe_key").notNull(),
    score: integer("score"),
    confidence: compareConfidenceEnum("confidence"),
    verdict: text("verdict").notNull().default(""),
    reasons: jsonb("reasons").$type<string[]>().notNull().default([]),
    dimensions: jsonb("dimensions").$type<{ name: string; score: number; note: string }[]>().notNull().default([]),
    differences: jsonb("differences").$type<string[]>().notNull().default([]),
    /** 模型的原始回复（排查用，接口里叫 raw） */
    raw: text("raw"),
    error: text("error"),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    via: compareViaEnum("via").notNull(),
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    sessionId: text("session_id").references(() => sessions.id, { onDelete: "set null" }),
    taskId: text("task_id"),
    apiKeyId: text("api_key_id").references(() => apiKeys.id, { onDelete: "set null" }),
    createdAt: createdAt(),
    finishedAt: ts("finished_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    index("comparisons_created_idx").on(t.createdAt.desc(), t.id.desc()),
    index("comparisons_dedupe_idx").on(t.dedupeKey, t.createdAt.desc()),
    index("comparisons_session_idx").on(t.sessionId),
  ]
)

// ---------- 派活（2026-10-18） ----------

/** 派活单：一件事一张，同一个任务下同一个去重键只有一张（重办是同一张单再开一次运行） */
export const workItems = pgTable(
  "work_items",
  {
    /** W-<序号>（序列 work_item_no_seq） */
    id: text("id").primaryKey(),
    /** 被派的任务 */
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id),
    /** 去重键（去掉首尾空白） */
    key: text("key").notNull(),
    title: text("title").notNull(),
    params: jsonb("params").$type<Record<string, string>>().notNull().default({}),
    note: text("note").notNull().default(""),
    status: workItemStatusEnum("status").notNull(),
    /** 当前（最近一次）在办的运行 */
    sessionId: text("session_id").references((): AnyPgColumn => sessions.id, { onDelete: "set null" }),
    attempts: integer("attempts").notNull().default(0),
    via: workViaEnum("via").notNull(),
    fromTaskId: text("from_task_id").references(() => tasks.id, { onDelete: "set null" }),
    fromSessionId: text("from_session_id").references((): AnyPgColumn => sessions.id, { onDelete: "set null" }),
    fromUserId: text("from_user_id").references(() => users.id, { onDelete: "set null" }),
    depth: integer("depth").notNull().default(1),
    result: jsonb("result").$type<WorkResult>(),
    error: text("error"),
    /** 没办成的种类（第二期）：error 运行出错 / not_done agent 报办不成 / cancelled_run 人取消、人选不继续、人判验收失败 */
    failKind: text("fail_kind").$type<WorkFailKind>(),
    /** 结果（run-outcome 6.2）：跟着最后那次运行的结果；单结束了才有 */
    outcome: runOutcomeEnum("outcome").$type<RunOutcome>(),
    outcomeReason: text("outcome_reason"),
    /** 排队等自动重试：到这个时间才领（第二期） */
    notBefore: ts("not_before"),
    /** 这一轮已经自动重试了几次（人点重办清零；第二期） */
    autoRetries: integer("auto_retries").notNull().default(0),
    /** 处理记录：派进来、开运行、运行结束、重办、改参数、不办了 */
    log: jsonb("log").$type<WorkLogEntry[]>().notNull().default([]),
    createdAt: createdAt(),
    startedAt: ts("started_at"),
    finishedAt: ts("finished_at"),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex("work_items_task_key_idx").on(t.taskId, t.key),
    index("work_items_task_status_idx").on(t.taskId, t.status, t.createdAt),
    index("work_items_task_not_before_idx").on(t.taskId, t.status, t.notBefore),
    index("work_items_created_idx").on(t.createdAt.desc(), t.id.desc()),
    index("work_items_from_session_idx").on(t.fromSessionId),
    index("work_items_from_task_idx").on(t.fromTaskId),
    index("work_items_session_idx").on(t.sessionId),
  ]
)

// ---------- 右下角助手（2026-10-19） ----------

/** 一段对话：只有本人看得见。每人保留最近 ASSISTANT_MAX_CHATS 段 */
export const assistantChats = pgTable(
  "assistant_chats",
  {
    id: text("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** 第一条消息的前 30 个字 */
    title: text("title").notNull(),
    /** 本对话设置里人明确选的模型；null = 跟默认走（「模型」页的助手默认，没配用 plan） */
    modelId: text("model_id"),
    /** 本对话的上限；null = 跟设置页「助手」一组的全局值 */
    maxSteps: integer("max_steps"),
    maxCostUsd: numeric("max_cost_usd", { precision: 12, scale: 6, mode: "number" }),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index("assistant_chats_user_idx").on(t.userId, t.updatedAt.desc())]
)

/**
 * 发给模型的消息历史（AI SDK 的 ModelMessage，原样存在 message 里），按 seq 排。
 * 面板上显示的记录（AssistantEntry）由它和 assistant_proposals 拼出来，不另存。
 */
export const assistantMessages = pgTable(
  "assistant_messages",
  {
    id: identity(),
    chatId: text("chat_id")
      .notNull()
      .references(() => assistantChats.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    role: text("role").notNull(),
    message: jsonb("message").$type<unknown>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("assistant_messages_chat_seq_idx").on(t.chatId, t.seq)]
)

/**
 * 改动确认卡：模型这一步要调的写工具（calls：原样的工具名和输入，应用时照这个执行，前端只传卡的 id），
 * 和给人看的每一项（changes，应用后带上 result）。一段对话同时最多一张 pending。
 */
export const assistantProposals = pgTable(
  "assistant_proposals",
  {
    id: text("id").primaryKey(),
    chatId: text("chat_id")
      .notNull()
      .references(() => assistantChats.id, { onDelete: "cascade" }),
    /** 这张卡挂在哪条 assistant 消息（带 tool-call 的那条）后面 */
    afterSeq: integer("after_seq").notNull(),
    status: text("status").$type<AssistantProposalStatus>().notNull().default("pending"),
    /** prepared：出卡时算好、应用时照用的东西（例如规则的翻译结果，不用再花一次钱） */
    calls: jsonb("calls").$type<{ callId: string; tool: string; input: unknown; prepared?: unknown }[]>().notNull(),
    changes: jsonb("changes").$type<AssistantChange[]>().notNull(),
    createdAt: createdAt(),
    decidedAt: ts("decided_at"),
  },
  (t) => [index("assistant_proposals_chat_idx").on(t.chatId, t.status)]
)

// ---------- 固化（docs/dev/solidify.md） ----------

/** 固化流程：第一期一个任务一个。脚本内容按版本存在 routine_versions */
export const routines = pgTable(
  "routines",
  {
    /** RT-<n>，序列 routine_no_seq */
    id: text("id").primaryKey(),
    taskId: text("task_id")
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    status: routineStatusEnum("status").notNull().default("trial"),
    /** 启用的那一版；还没启用过 = 空 */
    activeVersion: integer("active_version"),
    /** 连着几次脚本直接办成（试用期满 ROUTINE_TRIAL_RUNS 次转正式；交给 agent 一次清零） */
    directStreak: integer("direct_streak").notNull().default(0),
    /** 连着几次交给 agent（满 ROUTINE_PAUSE_AFTER_FALLBACKS 次自动停用；直接办成一次清零） */
    fallbackStreak: integer("fallback_streak").notNull().default(0),
    /** 停用的原因（人停的写谁停的，自动停的写连续几次跑不通） */
    pausedReason: text("paused_reason"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("routines_task_id_idx").on(t.taskId)]
)

/** 一版脚本：固化员写的、试跑报告、审核结果。id = RT-<n>-v<版本> */
export const routineVersions = pgTable(
  "routine_versions",
  {
    id: text("id").primaryKey(),
    routineId: text("routine_id")
      .notNull()
      .references(() => routines.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    status: routineVersionStatusEnum("status").notNull().default("drafting"),
    name: text("name").notNull().default(""),
    /** 给人看的步骤说明，一步一行 */
    description: text("description").notNull().default(""),
    /** 脚本（ES module，export default async function run(input)） */
    code: text("code").notNull().default(""),
    inputSchema: jsonb("input_schema").$type<Record<string, unknown>>().notNull().default({}),
    outputSchema: jsonb("output_schema").$type<Record<string, unknown>>().notNull().default({}),
    /** 哪几步会真的改东西（ha.commit 的说明） */
    commits: text("commits").array().notNull().default(sql`'{}'::text[]`),
    assumptions: text("assumptions").array().notNull().default(sql`'{}'::text[]`),
    /** 没成功的原因：不适合固化、程序检查没过、试跑几轮都没过、模型出错 */
    failReason: text("fail_reason"),
    /** 从哪次运行固化来的（修的版本：agent 接手办成的那次） */
    sourceSessionId: text("source_session_id").references(() => sessions.id, { onDelete: "set null" }),
    /** 修的版本：改的是哪一版 */
    baseVersion: integer("base_version"),
    /** 写到第几轮了（写一次算一轮，试跑不过再改一次 +1，最多 ROUTINE_MAX_ROUNDS） */
    round: integer("round").notNull().default(0),
    /** 点「固化成流程」时选了不试跑（会自动存草稿的网站，第 14 节问题 4）：写好、程序检查过了直接交给人审核 */
    skipTest: boolean("skip_test").notNull().default(false),
    /** 运行办成后系统自动固化的（17.1）；人点的是 false */
    auto: boolean("auto").notNull().default(false),
    testReport: jsonb("test_report").$type<RoutineTestReport>(),
    /** 写这一版用的模型和花费（几轮合计） */
    modelId: text("model_id"),
    tokensIn: bigint("tokens_in", { mode: "number" }).notNull().default(0),
    tokensOut: bigint("tokens_out", { mode: "number" }).notNull().default(0),
    costUsd: numeric("cost_usd", { precision: 12, scale: 6, mode: "number" }).notNull().default(0),
    rejectReason: text("reject_reason"),
    /** 谁点的「固化成流程」 */
    createdById: text("created_by_id").references(() => users.id, { onDelete: "set null" }),
    approvedById: text("approved_by_id").references(() => users.id, { onDelete: "set null" }),
    approvedAt: ts("approved_at"),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex("routine_versions_routine_version_idx").on(t.routineId, t.version)]
)

/**
 * 固化脚本的重放日志（docs/dev/solidify.md 17.2）：普通运行里工具桥收到的每个请求一行（试跑不记）。
 * 停下等人、进程中途被杀以后接着跑时，从头再跑一遍脚本：对得上的请求直接回这里记下的结果，不真做
 */
export const routineJournal = pgTable(
  "routine_journal",
  {
    sessionId: text("session_id")
      .notNull()
      .references(() => sessions.id, { onDelete: "cascade" }),
    /** 第几个请求（从 1 开始；和工具调用的序号不同：commit、log、now 也占一个） */
    seq: integer("seq").notNull(),
    /** tool / commit / verified / log / now */
    op: text("op").notNull(),
    /** op = tool：工具 id */
    tool: text("tool"),
    /** 请求参数（tool 的 input、commit 的 label……）的 sha256：重放时对一下，对不上就是脚本走了别的路 */
    inputHash: text("input_hash").notNull(),
    /** 回给脚本的（{ ok, text?, data?, error?, code? }）；还没做完（进程被杀、停下等人）的为空 */
    reply: jsonb("reply").$type<Record<string, unknown>>(),
    /** 这一步停下的样子：approval（没做，等审批）/ suspend（做了，等人处理）；正常的为空 */
    stop: text("stop"),
    /** 做这一步时用的 Chrome（浏览器动作才有）：接着跑时 Chrome 换了就不重放 */
    instanceId: text("instance_id"),
    at: ts("at").notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.sessionId, t.seq] })]
)
