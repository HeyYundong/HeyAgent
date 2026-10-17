// 领域类型：照原型 design/prototype/src/mock/shared.ts 和各页面 data.ts 改写成 zod schema。
// 字段名和含义就是前后端的契约，原型已经和用户对齐过，不要随意改名。和原型不同的地方都在注释里写明：
// - 所有时间字段都是 ISO 8601 字符串（UTC，例如 2026-10-16T01:12:00.000Z）。原型里写的是「2026-10-16 09:12」「09:58」这样的显示文字，
//   显示前用 ./time.ts 的 fmtDateTime / fmtShort / eventTimeText 转回原型的写法（上海时间）。
// - 数据库里为空的字段在接口里直接省略（对应原型的可选字段 ?:），不会出现 null。
import { z } from "zod"

import { ruleCompileViewSchema } from "./rules.js"

/** ISO 8601 时间（UTC）。接口返回的时间都是这个格式 */
export const isoTime = z.string()

// ---------- 人 ----------

export const staffSchema = z.object({
  id: z.string(),
  name: z.string(),
  title: z.string(),
  /** 主管（better-auth admin 插件的 role = "admin"） */
  isAdmin: z.boolean(),
})
export type Staff = z.infer<typeof staffSchema>

/** 当前登录的人：比 Staff 多邮箱和侧边栏「待办」上的数字 */
export const meSchema = staffSchema.extend({
  email: z.string(),
  /** 等我处理的事（主管算全部，员工只算分给自己的），对应原型的 needsMeCount */
  needsMeCount: z.number().int(),
})
export type Me = z.infer<typeof meSchema>

export const platformSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 这个平台的域名（M2）：打开这些域名（含子域名）下的网址时按「平台 × 账号」申请租约 */
  domains: z.array(z.string()),
})
export type Platform = z.infer<typeof platformSchema>

// ---------- 模型 ----------

/** ollama：内网；openrouter：一个 key 用各家；anthropic / openai / deepseek：直连厂商自己的接口 */
export const modelProviderKindSchema = z.enum(["ollama", "openrouter", "anthropic", "openai", "deepseek"])
export type ModelProviderKind = z.infer<typeof modelProviderKindSchema>

export const modelInfoSchema = z.object({
  /** 全局唯一：服务 id/模型名，例如 openrouter/anthropic/claude-sonnet-5.5 */
  id: z.string(),
  name: z.string(),
  /** 一句话：适合干什么 */
  note: z.string(),
  contextK: z.number(),
  /** 每百万 token 的价格（美元）；本地模型为 0 */
  priceIn: z.number(),
  priceOut: z.number(),
  /** 新增：能不能看图（验证码判断、看截图证据要用） */
  vision: z.boolean().optional(),
})
export type ModelInfo = z.infer<typeof modelInfoSchema>

/** 新增 unconfigured：服务保留着但还没配好（例如内网还没有 Ollama），这时 baseUrl 为空、没有模型、没有检查时间和延迟 */
export const providerStatusSchema = z.enum(["ok", "error", "unconfigured"])
export type ProviderStatus = z.infer<typeof providerStatusSchema>

/** 对应原型 models/data.ts 的 Provider：同一类型可以加多个，所以 id 和类型分开 */
export const modelProviderSchema = z.object({
  id: z.string(),
  kind: modelProviderKindSchema,
  name: z.string(),
  /** 未配置时是空字符串 */
  baseUrl: z.string(),
  /** 只给掩码，例如 sk-or-v1-••••••••3f2a；只有 Ollama 没有 */
  apiKeyMasked: z.string().optional(),
  status: providerStatusSchema,
  /** 上次检查连接的时间；未配置时没有 */
  checkedAt: isoTime.optional(),
  latencyMs: z.number().optional(),
  /** 能调工具的聊天模型（任务、执行 / 规划 / 验收用） */
  models: z.array(modelInfoSchema),
  /**
   * embedding 模型（把图片、文字变成向量，图库检索用）。和 models 分开，免得出现在任务的模型下拉里。
   * vision = 能处理图片；priceIn 是每百万 token 的价格，priceOut 为 0。目前只有 OpenRouter 有（Ollama 的 embedding 不支持图片）
   */
  embeddingModels: z.array(modelInfoSchema).optional(),
})
export type ModelProvider = z.infer<typeof modelProviderSchema>

/** embed = 图库的 embedding 模型（以图搜图、比对、按描述找图） */
export const modelRoleSchema = z.enum(["run", "plan", "verify", "embed"])
export type ModelRole = z.infer<typeof modelRoleSchema>

/** 默认用哪个模型：执行任务 / 规划拆解 / 三方验收 / 图库的 embedding（没配时没有） */
export const modelDefaultsSchema = z.object({ run: z.string(), plan: z.string(), verify: z.string(), embed: z.string().optional() })
export type ModelDefaults = z.infer<typeof modelDefaultsSchema>

// ---------- 浏览器（Chrome） ----------

export const accountStatusSchema = z.enum(["ok", "expired", "captcha"])
export type AccountStatus = z.infer<typeof accountStatusSchema>

/** 某个 Chrome 里登录过的网站 = 平台 × 账号 */
export const browserSiteSchema = z.object({
  /** 新增：账号的 id（以后改并发上限、发租约用） */
  accountId: z.string(),
  platformId: z.string(),
  account: z.string(),
  status: accountStatusSchema,
  lastLoginAt: isoTime,
  loggedInById: z.string(),
  /** 这个账号同时最多几个 session 在用 */
  maxConcurrent: z.number().int(),
  /** 这个账号现在有几个 session 在用（= 没释放的账号租约数） */
  running: z.number().int(),
  /** 新增（方案 2.3.6）：登录探测网址，M2 用 */
  probeUrl: z.string().optional(),
  /** 新增（方案 2.3.6）：登录态要不要连 IndexedDB 一起存 */
  saveIndexedDb: z.boolean().optional(),
  /** 存了登录密码（密码本身只存密文，不返回）：能「立刻登录」，运行中遇到登录页 agent 自己登录 */
  hasPassword: z.boolean().optional(),
})
export type BrowserSite = z.infer<typeof browserSiteSchema>

export const browserProxySchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none") }),
  z.object({
    kind: z.literal("socks5"),
    host: z.string(),
    port: z.number().int(),
    username: z.string().optional(),
    /** 新增：代理密码有没有存（密码本身只存密文，不返回） */
    hasPassword: z.boolean().optional(),
  }),
])
export type BrowserProxy = z.infer<typeof browserProxySchema>

/** 对应原型 browsers/data.ts 的 Chrome */
export const browserProfileSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 给 agent 看的说明：它靠这句话自己选用哪个 Chrome */
  description: z.string(),
  proxy: browserProxySchema,
  /** 出口 IP 所在地 */
  exitIp: z.string(),
  /** 这个 Chrome 现在开着几个 session（= 占着它账号租约的不同 session 数） */
  running: z.number().int(),
  /** 同时最多几个运行用这个 Chrome */
  maxSessions: z.number().int(),
  sites: z.array(browserSiteSchema),
  cookieCount: z.number().int(),
  /** 保险箱版本：每次回写 +1 */
  vaultVersion: z.number().int(),
  /** 保险箱最后更新时间（没有保险箱时是 Chrome 配置的更新时间） */
  updatedAt: isoTime,
  /** 新增（方案 2.3.6）：时区、语言，M2 起 Chrome 按这个启动 */
  timezone: z.string().optional(),
  locale: z.string().optional(),
})
export type BrowserProfile = z.infer<typeof browserProfileSchema>

// ---------- 工具 ----------

export const toolSourceSchema = z.enum(["builtin", "mcp", "http"])
export type ToolSource = z.infer<typeof toolSourceSchema>

export const riskSchema = z.enum(["read", "write", "external", "money"])
export type Risk = z.infer<typeof riskSchema>

export const mcpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  transport: z.enum(["stdio", "http"]),
  /** stdio：启动命令 */
  command: z.string().optional(),
  /** http：服务地址 */
  url: z.string().optional(),
  status: z.enum(["connected", "error"]),
  note: z.string(),
  /** 环境变量，每行「名字=••••」：只给名字，值是掩码（原型 tool-dialog 的 Server.env，页面只取 = 前面的名字） */
  env: z.string().optional(),
})
export type McpServer = z.infer<typeof mcpServerSchema>

export const httpMethodSchema = z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
export const httpSpecSchema = z.object({
  method: httpMethodSchema,
  /** 模板：{参数} 由模型填，{{名字}} 是密钥的占位符，密钥原文从不出现在这里 */
  url: z.string(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.string().optional(),
})
export type HttpSpec = z.infer<typeof httpSpecSchema>

/** 对应原型 tools 页的 Tool = ToolRef + 给模型看的完整说明（原型 tools/data.ts 的 DESCRIPTIONS） */
export const toolSchema = z.object({
  /** 模型里的名字，例如 browser.open */
  id: z.string(),
  name: z.string(),
  /** 给模型看的一句话 */
  summary: z.string(),
  /** 给模型看的完整说明 */
  description: z.string(),
  source: toolSourceSchema,
  serverId: z.string().optional(),
  http: httpSpecSchema.optional(),
  risk: riskSchema,
  /** 每个任务都自带（勾检查点、挂起等待、问人） */
  alwaysOn: z.boolean().optional(),
})
export type Tool = z.infer<typeof toolSchema>

/** 已经存在服务器上的密钥：只有名字、谁存的、什么时候存的（对应原型 tools/data.ts 的 SavedSecret，多了 byId，at 改成 ISO） */
export const savedSecretSchema = z.object({ by: z.string(), byId: z.string(), at: isoTime })
export type SavedSecret = z.infer<typeof savedSecretSchema>

// ---------- 规则 ----------

export const ruleSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 触发条件：一句话 */
  trigger: z.string(),
  /** 命中后怎么办 */
  action: z.string(),
  /** 规则命中后会调用的工具 */
  toolIds: z.array(z.string()),
  /** 翻译后、人确认过的规则（M3：compiledRuleSchema 的结构，正在执行的版本）；没有确认过时省略 */
  compiledTrigger: z.record(z.string(), z.unknown()).optional(),
  /** M3：翻译和确认的状态（「系统理解为」、生效没有、为什么没生效）。见 rules.ts 的 ruleCompileViewSchema */
  compile: ruleCompileViewSchema.optional(),
})
export type RuleRef = z.infer<typeof ruleSchema>

// ---------- 记忆 ----------

export const memoryStatusSchema = z.enum(["active", "pending", "rejected", "archived"])
export type MemoryStatus = z.infer<typeof memoryStatusSchema>

export const memoryEvidenceSchema = z.enum(["chat", "web", "result"])
export type MemoryEvidence = z.infer<typeof memoryEvidenceSchema>

export const memorySourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("human"), byId: z.string() }),
  z.object({ kind: z.literal("agent"), taskId: z.string(), evidence: memoryEvidenceSchema }),
])
export type MemorySource = z.infer<typeof memorySourceSchema>

export const memorySchema = z.object({
  id: z.string(),
  content: z.string(),
  /** 适用于：「分类 · 对象」或只有分类 */
  appliesTo: z.string(),
  status: memoryStatusSchema,
  source: memorySourceSchema,
  reviewerId: z.string().optional(),
  createdAt: isoTime,
  /** 来自网页内容、没核实过 */
  webUnverified: z.boolean().optional(),
  /** 原型 memory/data.ts 的 MemoryNote，合并进来：证据摘录、最近一次被读到（lastUsed 由服务端按当前时间生成，例如「最近一次：今天 16:10，T-1036 的运行开始时读到」） */
  note: z.object({ evidence: z.string().optional(), lastUsed: z.string().optional() }),
  /** 新增：待审核时，「待办」里那件事的 id（原型直接用记忆 id 当待办 id，以后新提议的不再相同，「去待办处理」请用这个） */
  reviewItemId: z.string().optional(),
})
export type MemoryRef = z.infer<typeof memorySchema>

// ---------- 技能 ----------

export const skillStatusSchema = z.enum(["published", "draft", "disabled"])
export type SkillStatus = z.infer<typeof skillStatusSchema>

/** 对应原型技能页的 Skill = SkillRef + 版本、更新时间、SKILL.md 正文（原型 skills/data.ts） */
export const skillSchema = z.object({
  id: z.string(),
  name: z.string(),
  /** 规划 agent 平时只看到这一句 */
  description: z.string(),
  /** 岗位 */
  dept: z.string(),
  status: skillStatusSchema,
  ownerId: z.string(),
  toolIds: z.array(z.string()),
  /** agent 提的修改建议（在待办里审核） */
  suggestion: z
    .object({
      taskId: z.string(),
      summary: z.string(),
      reviewerId: z.string(),
      createdAt: isoTime,
      /** 新增：「待办」里那件事的 id（用法同 MemoryRef.reviewItemId） */
      itemId: z.string().optional(),
    })
    .optional(),
  version: z.number().int(),
  updatedAt: isoTime,
  /** SKILL.md 正文（不含头部；头部由名称、描述、工具生成） */
  body: z.string(),
})
export type Skill = z.infer<typeof skillSchema>

// ---------- 检查点 ----------

export const checkpointKindSchema = z.enum(["visit", "message", "count", "artifact", "confirm", "note"])
export type CheckpointKind = z.infer<typeof checkpointKindSchema>

// ---------- 任务 ----------

export const taskStepSchema = z.object({
  id: z.string(),
  text: z.string(),
  /** 这一步允许挂起等待 */
  wait: z.boolean(),
  /** 这一步的检查点内容（勾了「检查点」才有） */
  checkpoint: z.string().optional(),
})
export type TaskStep = z.infer<typeof taskStepSchema>

export const taskSchema = z.object({
  id: z.string(),
  /** 一句话的任务 */
  title: z.string(),
  /** 目标：做到什么算完成 */
  goal: z.string(),
  steps: z.array(taskStepSchema),
  ownerId: z.string(),
  createdAt: isoTime,
  /** 已启动：关掉就不会运行，也不会按定时运行 */
  enabled: z.boolean(),
  /** 定时运行（cron）；没有就是只跑一次 */
  schedule: z.object({ cron: z.string(), text: z.string() }).optional(),
  /** 预计下次运行（定时任务才有） */
  nextRunAt: isoTime.optional(),
  modelId: z.string(),
  memoryIds: z.array(z.string()),
  skillIds: z.array(z.string()),
  toolIds: z.array(z.string()),
  ruleIds: z.array(z.string()),
  /** M2：选了「浏览器」工具时允许用哪些 Chrome 配置；空 = 全部 */
  browserProfileIds: z.array(z.string()),
  /** M2：网址白名单（域名，子域名也算）；空 = 不限制 */
  allowedDomains: z.array(z.string()),
  /** M2：是否允许 agent 在网页里执行脚本 */
  allowBrowserEvaluate: z.boolean(),
  /** M3：这个任务自己选的三方验收模型；没有就用默认验收模型。必须和执行模型不是同一家 */
  verifyModelId: z.string().optional(),
})
export type TaskDef = z.infer<typeof taskSchema>

// ---------- 运行（session） ----------

export const runStatusSchema = z.enum(["running", "needs_human", "waiting", "verifying", "done", "failed"])
export type RunStatus = z.infer<typeof runStatusSchema>

export const triggerSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time"), at: isoTime }),
  z.object({ kind: z.literal("cron"), cron: z.string(), text: z.string(), next: isoTime }),
  z.object({ kind: z.literal("event"), event: z.string(), fallbackDays: z.number().int() }),
  z.object({ kind: z.literal("time_or_event"), at: isoTime, event: z.string() }),
])
export type Trigger = z.infer<typeof triggerSchema>

export const checkpointRecordSchema = z.object({ at: isoTime, text: z.string(), synced: z.boolean() })
export type CheckpointRecord = z.infer<typeof checkpointRecordSchema>

export const runCheckpointSchema = z.object({
  title: z.string(),
  kind: checkpointKindSchema,
  target: z.number().int().optional(),
  /** 来自哪一步（agent 自己探索出来的就没有） */
  stepId: z.string().optional(),
  status: z.enum(["done", "open", "skipped"]),
  progress: z.number().int().optional(),
  records: z.array(checkpointRecordSchema),
  skipReason: z.string().optional(),
})
export type RunCheckpoint = z.infer<typeof runCheckpointSchema>

export const runEventKindSchema = z.enum(["plan", "think", "tool", "checkpoint", "rule", "wait", "resume", "human", "verify", "done", "error"])
export type RunEventKind = z.infer<typeof runEventKindSchema>

export const runEventSchema = z.object({
  /** 新增：session 内的序号，从 1 开始只增不减（session_events 的主键是 (session_id, seq)） */
  seq: z.number().int(),
  at: isoTime,
  kind: runEventKindSchema,
  title: z.string(),
  detail: z.string().optional(),
  toolId: z.string().optional(),
  /** 工具调用的输入、输出（原文） */
  input: z.string().optional(),
  output: z.string().optional(),
  ms: z.number().int().optional(),
  tokensIn: z.number().int().optional(),
  tokensOut: z.number().int().optional(),
})
export type RunEvent = z.infer<typeof runEventSchema>

/** 验收模型对一条检查点的结论：通过 / 不通过 / 存疑 */
export const verifyVerdictSchema = z.enum(["pass", "fail", "unsure"])
export type VerifyVerdict = z.infer<typeof verifyVerdictSchema>

export const verificationSchema = z.object({
  status: z.enum(["passed", "asking", "disputed"]),
  at: isoTime,
  headline: z.string(),
  notes: z.array(z.object({ by: z.enum(["verifier", "executor"]), text: z.string() })),
  /** M3：第几轮验收（负责人「补充说明后继续」后从 1 重新数） */
  round: z.number().int().optional(),
  /** M3：验收用的模型 */
  modelId: z.string().optional(),
  /** M3：总结论 */
  verdict: verifyVerdictSchema.optional(),
  /** M3：每条检查点的结论和理由（index 是检查点序号，从 1 开始） */
  items: z
    .array(z.object({ index: z.number().int(), title: z.string(), verdict: verifyVerdictSchema, reason: z.string() }))
    .optional(),
  /** M3：验收争议交给负责人后，负责人怎么处理的：算通过 / 算失败 / 补充说明后继续 */
  resolution: z
    .object({ how: z.enum(["pass", "fail", "continue"]), byId: z.string(), byName: z.string().optional(), note: z.string().optional(), at: isoTime })
    .optional(),
})
export type Verification = z.infer<typeof verificationSchema>

// ---------- 任务记忆 ----------
// 每个任务自己的经验，一条一条的，负责人和主管能直接写、改、删。
// 运行结束后可以让三方 AI 总结这次运行、提取候选（SessionDigest），人审核通过的才记进任务记忆。每次运行开始时全部放进系统提示。

export const taskMemoryEntrySchema = z.object({
  id: z.number().int(),
  taskId: z.string(),
  content: z.string(),
  /** 从哪次运行总结来的；人直接写的没有 */
  sourceSessionId: z.string().optional(),
  /** 人写的：谁写的；总结来的：谁审核通过的 */
  createdById: z.string().optional(),
  createdAt: isoTime,
  updatedAt: isoTime,
})
export type TaskMemoryEntry = z.infer<typeof taskMemoryEntrySchema>

export const digestCandidateStatusSchema = z.enum(["pending", "accepted", "rejected"])
export type DigestCandidateStatus = z.infer<typeof digestCandidateStatusSchema>

/** 三方 AI 对一次已结束运行的总结，和从中提取的任务记忆候选（人审核后才记进任务记忆） */
export const sessionDigestSchema = z.object({
  at: isoTime,
  /** 用的哪个模型（任务的验收模型或默认验收模型，和执行模型不是同一家） */
  modelId: z.string(),
  /** 谁点的「总结」 */
  byId: z.string(),
  /** 这次运行做了什么、结果如何、遇到了什么问题（Markdown） */
  summary: z.string(),
  candidates: z.array(
    z.object({
      /** 一条记忆；记进去的是人审核时改过的版本 */
      text: z.string(),
      /** 依据：在这次运行的哪里看到的 */
      reason: z.string(),
      status: digestCandidateStatusSchema,
      /** 记进去以后对应的任务记忆 id */
      entryId: z.number().int().optional(),
    })
  ),
  /** 候选全部处理完的时间和人 */
  reviewedAt: isoTime.optional(),
  reviewedById: z.string().optional(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costUsd: z.number(),
})
export type SessionDigest = z.infer<typeof sessionDigestSchema>

/** 一次运行 = 一个 session */
export const sessionRunSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  /** 新增：父 session（v1.1 子 agent 用，现在都没有） */
  parentSessionId: z.string().optional(),
  startedAt: isoTime,
  endedAt: isoTime.optional(),
  status: runStatusSchema,
  modelId: z.string(),
  tokensIn: z.number().int(),
  tokensOut: z.number().int(),
  costUsd: z.number(),
  /** 任务没写步骤时，agent 自己探索出来的步骤 */
  exploredSteps: z.array(z.string()).optional(),
  checkpoints: z.array(runCheckpointSchema),
  /** 按 seq 从小到大 */
  events: z.array(runEventSchema),
  /** 挂起时：在等什么、什么时候继续（来自 session_waits 里状态为 waiting 的那条） */
  waiting: z.object({ what: z.string(), trigger: triggerSchema, since: isoTime }).optional(),
  verification: verificationSchema.optional(),
  /** 运行结束后三方 AI 的总结和任务记忆候选（有人点过「总结」才有） */
  digest: sessionDigestSchema.optional(),
})
export type SessionRun = z.infer<typeof sessionRunSchema>

// ---------- 待办：要人办的事 ----------

export const humanItemKindSchema = z.enum(["approval", "verify", "login", "memory", "skill"])
export type HumanItemKind = z.infer<typeof humanItemKindSchema>

const pairSchema = z.tuple([z.string(), z.string()])

/** 处理一件事时要看的几段话和按钮文案（原型 todos/data.ts 的 HumanDetail，原样搬过来） */
export const humanDetailSchema = z.object({
  sections: z.array(
    z.object({
      title: z.string(),
      text: z.string().optional(),
      block: z.object({ title: z.string(), text: z.string() }).optional(),
      diff: z.array(z.object({ variant: z.enum(["default", "added", "removed"]), text: z.string() })).optional(),
    })
  ),
  /** 顶部醒目提醒（网页来源的记忆） */
  warn: pairSchema.optional(),
  /** 主按钮 */
  primary: z.string(),
  /** 涉及金钱：主按钮先弹 AlertDialog 二次确认 */
  pay: pairSchema.optional(),
  /** 主按钮是链接（去浏览器里登录） */
  link: z.object({ page: z.literal("browsers"), id: z.string() }).optional(),
  done: pairSchema.optional(),
  secondary: z.string(),
  secondaryDone: pairSchema.optional(),
  rejectHint: z.string().optional(),
  did: pairSchema.optional(),
  secondaryFinishes: z.boolean().optional(),
  /**
   * M2：遇到验证码或登录页时附上的浏览器信息。browserId 是当时保留着的 Chrome（远程画面用 GET /api/browser/view/:browserId）；
   * Chrome 过了保留时间会关掉，这时用 browser.sessionBrowser 查不到，人可以用 browser.openForLogin(profileId, accountId) 新开一个处理
   */
  browser: z
    .object({
      browserId: z.string(),
      sessionId: z.string(),
      profileId: z.string(),
      accountId: z.string().optional(),
      url: z.string(),
      reason: z.string(),
      screenshotFileId: z.string().optional(),
    })
    .optional(),
  /**
   * M3：规则「调工具前交给人审批」拦下的工具调用。批准 = 执行这次调用接着跑；拒绝 = 把「被拒绝：理由」作为工具结果交给 agent。
   * input 是参数的 JSON（密钥类字段已隐藏、太长已截断）
   */
  toolCall: z
    .object({ toolId: z.string(), toolName: z.string(), input: z.string(), risk: z.string().optional(), ruleId: z.string(), ruleName: z.string() })
    .optional(),
  /** M3：验收争议附的验收报告。三种处理：算通过（approve）/ 算失败（reject）/ 补充说明后继续（done），也可以用 engine.resolveVerifyDispute */
  verification: verificationSchema.optional(),
})
export type HumanDetail = z.infer<typeof humanDetailSchema>

export const humanItemSchema = z.object({
  id: z.string(),
  kind: humanItemKindSchema,
  title: z.string(),
  /** 一句话：为什么到了你这里 */
  summary: z.string(),
  assigneeId: z.string(),
  taskId: z.string().optional(),
  runId: z.string().optional(),
  ruleId: z.string().optional(),
  /** 新增：记忆审核、技能修改对应的记忆 / 技能 */
  memoryId: z.string().optional(),
  skillId: z.string().optional(),
  createdAt: isoTime,
  /** 越小越急 */
  urgency: z.number().int(),
  /** 原型 todos/data.ts 的 humanDetails[item.id]，合并进来 */
  detail: humanDetailSchema,
})
export type HumanItem = z.infer<typeof humanItemSchema>

// ---------- 待办：人加的提醒 ----------

export const humanTodoSchema = z.object({
  id: z.string(),
  taskId: z.string(),
  title: z.string(),
  trigger: triggerSchema,
  createdById: z.string(),
  createdAt: isoTime,
})
export type HumanTodo = z.infer<typeof humanTodoSchema>

// ---------- 实时推送 ----------

/** live.onChange 推的一条：哪张表的哪一行变了。table 是 "*" 表示断线太久补不齐，前端把所有查询都重新拉一遍 */
export const changeEventSchema = z.object({ table: z.string(), id: z.string().nullable() })
export type ChangeEvent = z.infer<typeof changeEventSchema>
