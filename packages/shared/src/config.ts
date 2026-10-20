// 配置写操作的输入校验（M1 包 P2 负责）：任务、记忆、技能、规则、工具、浏览器、模型、待办、用户、设置。
// 前后端共用同一份 zod schema：前端表单用它做校验（React Hook Form + zodResolver），后端 tRPC 用它校验输入。
// 另外放几样前后端都要用的纯函数：明文密钥识别、cron 下一次时间、技能修改建议的合并。
import { CronExpressionParser } from "cron-parser"
import { z } from "zod"

import { domainSchema } from "./browser-runtime.js"
import { canonicalLocale, canonicalTimeZone } from "./browsers.js"
import { taskDispatchSchema } from "./dispatch.js"
import { settingsAssistantInputSchema } from "./assistant.js"
import { httpMethodSchema, httpSpecSchema, modelProviderKindSchema, riskSchema, skillStatusSchema, taskStepSchema, type ModelProviderKind } from "./schemas.js"
import { TIME_ZONE } from "./time.js"

const text = (message: string, max = 2000) => z.string().trim().min(1, message).max(max, `太长了，最多 ${max} 个字`)
const optionalText = (max = 2000) => z.string().trim().max(max, `太长了，最多 ${max} 个字`)
const ids = z.array(z.string().min(1)).max(200)
export const idInput = z.object({ id: z.string().min(1) })

// ---------- 通用：密钥名、cron ----------

/** 通知渠道的 webhook 地址存成 NOTIFY_<渠道 id>_URL：这个前缀留给系统，工具页不显示、不能用 */
export const NOTIFY_SECRET_PREFIX = "NOTIFY_"

/** 密钥名：模板里写成 {{名字}}。大写字母开头，只有大写字母、数字、下划线 */
export const secretNameSchema = z
  .string()
  .trim()
  .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "密钥名只能用大写字母、数字和下划线，字母开头，例如 API_TOKEN")
  .refine((name) => !name.startsWith(NOTIFY_SECRET_PREFIX), "NOTIFY_ 开头的名字留给通知渠道，换一个")

/** cron 表达式（分 时 日 月 周），按上海时间算 */
export function isValidCron(expr: string): boolean {
  const fields = expr.trim().split(/\s+/)
  if (fields.length !== 5) return false
  try {
    CronExpressionParser.parse(expr.trim(), { tz: TIME_ZONE })
    return true
  } catch {
    return false
  }
}

/** cron 从 from 往后的下一次（ISO）；表达式不对返回 undefined */
export function nextCronRun(expr: string, from: Date = new Date()): string | undefined {
  if (!isValidCron(expr)) return undefined
  return CronExpressionParser.parse(expr.trim(), { tz: TIME_ZONE, currentDate: from }).next().toDate().toISOString()
}

export const cronSchema = z.string().trim().refine(isValidCron, "看不懂这个 cron：要 5 段（分 时 日 月 周），例如 0 9 * * *")

// ---------- 明文密钥识别（工具页导入 cURL 时自动挪走；服务端保存前也用它检查） ----------

export type SecretWhere = "url" | "headers" | "body"
export type SecretTemplate = { url: string; headers: string; body: string }
export type MovedSecret = { name: string; value: string; where: SecretWhere }

const KEYISH = String.raw`[^=&"\s:]*(?:key|token|secret|password|signature)[^=&"\s:]*`
const HEADER = /^([^:\n]*(?:authorization|token|key|secret|cookie)[^:\n]*):[ \t]*((?:Bearer|Basic|Token)[ \t]+)?([^{\n]{4,})$/gim
const PAIR = new RegExp(String.raw`([?&]|^)(${KEYISH})=([^&#{\s]{4,})`, "gim") // ?key=… 或表单 token=…
const JSON_PAIR = new RegExp(String.raw`"(${KEYISH})"\s*:\s*"([^"{]{4,})"`, "gi") // "api_key": "…"
const TOKEN = /\b(?:sk|pk|rk)[-_](?:live_|test_|or_|or-)?[A-Za-z0-9-]{8,}|\bAIza[\w-]{20,}|\bghp_\w{20,}|\bxox[abp]-[\w-]{10,}/g // 常见密钥长相

/** 常见密钥长相（导入时在包里找明文密钥也用它）。每次返回新的正则（带 g 的正则有 lastIndex，不能共用） */
export const secretTokenPattern = () => new RegExp(TOKEN.source, "g")

export const snakeName = (value: string) =>
  value
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")

/** 名字前缀取接口的域名，例如 api.shipwise.example → SHIPWISE；IP 地址就用 API */
function hostPrefix(url: string) {
  const host = /^https?:\/\/([^/:?#]+)/i.exec(url.trim())?.[1] ?? ""
  return /^[\d.]+$/.test(host) || !host.includes(".") ? "API" : snakeName(host.split(".").at(-2)!) || "API"
}
const headerSuffix = (key: string) => (/authorization/i.test(key) ? "TOKEN" : /cookie/i.test(key) ? "COOKIE" : snakeName(key).replace(/^X_/, ""))

/** 把模板里的明文密钥换成 {{名字}}；taken 是模板里已经用掉的名字。moved 不为空 = 模板里有明文密钥 */
export function moveSecrets(t: SecretTemplate, taken: string[] = []) {
  const moved: MovedSecret[] = []
  const prefix = hostPrefix(t.url)
  const slot = (suffix: string, value: string, where: SecretWhere) => {
    const same = moved.find((m) => m.value === value)
    if (same) return `{{${same.name}}}`
    const base = suffix.startsWith(prefix) ? suffix : `${prefix}_${suffix}`
    let name = /^[A-Z]/.test(base) ? base : `K_${base}`
    for (let n = 2; [...taken, ...moved.map((m) => m.name)].includes(name); n++) name = `${base}_${n}`
    moved.push({ name, value, where })
    return `{{${name}}}`
  }
  const pairs = (value: string, where: SecretWhere) => value.replace(PAIR, (_, lead, key, found) => `${lead}${key}=${slot(snakeName(key), found, where)}`)
  const generic = (value: string, where: SecretWhere) => value.replace(TOKEN, (found) => slot("TOKEN", found, where))
  const headers = t.headers.replace(HEADER, (_, key, auth = "", found) => `${key}: ${auth}${slot(headerSuffix(key), found.trim(), "headers")}`)
  const body = t.body.replace(JSON_PAIR, (_, key, found) => `"${key}": "${slot(snakeName(key), found, "body")}"`)
  const template = { url: generic(pairs(t.url, "url"), "url"), headers: generic(headers, "headers"), body: generic(pairs(body, "body"), "body") }
  return { template, moved }
}

/** 一段文字里有没有明文密钥（MCP 命令、地址这类单行文字用） */
export function hasPlainSecret(value: string): boolean {
  return moveSecrets({ url: value, headers: value, body: value }).moved.length > 0
}

/** 认出模板里的占位符：{参数} 由模型填，{{密钥}} 存在服务器上 */
export function templatePlaceholders(value: string) {
  const unique = (re: RegExp) => [...new Set([...value.matchAll(re)].map((m) => m[1]!))]
  return { params: unique(/(?<!\{)\{([^{}]+)\}(?!\})/g), secrets: unique(/\{\{([^{}]+)\}\}/g) }
}

// ---------- 任务 ----------

export const taskStepInputSchema = taskStepSchema.extend({
  id: z.string().optional(),
  text: text("这一步写点什么，或者删掉这一步", 500),
  checkpoint: optionalText(500).optional(),
})

export const taskInputSchema = z.object({
  title: text("写一句话：要 agent 做什么", 200),
  goal: text("写一句话：做到什么算完成（三方 AI 按它验收）", 1000),
  steps: z.array(taskStepInputSchema).max(50),
  /** 不填就用默认的执行模型 */
  modelId: z.string().optional(),
  /** 负责人；不填就是自己（只有主管能指定别人） */
  ownerId: z.string().optional(),
  /** 定时运行；null 表示只跑一次 */
  schedule: z.object({ cron: cronSchema, text: optionalText(100) }).nullable(),
  enabled: z.boolean().default(true),
  memoryIds: ids.default([]),
  skillIds: ids.default([]),
  toolIds: ids.default([]),
  ruleIds: ids.default([]),
  /** 选了「浏览器」工具时允许用哪些 Chrome 配置（M2）；空 = 全部 Chrome 配置都能用 */
  browserProfileIds: ids.default([]),
  /** 网址白名单（M2）：域名，子域名也算；空 = 不限制 */
  allowedDomains: z.array(domainSchema).max(100).default([]),
  /** 是否允许 agent 在网页里执行脚本（M2，Playwright MCP 的 browser_evaluate），默认不允许 */
  allowBrowserEvaluate: z.boolean().default(false),
  /** 三方验收模型（M3）；不填（或空串）用默认验收模型。必须和执行模型不是同一家 */
  verifyModelId: z.string().optional(),
  /** 运行结束后让 AI 轻量复核结果（默认开；配了三方验收的不复核） */
  reviewEnabled: z.boolean().default(true),
  /** 复核模型；不填（或空串）用默认复核模型 */
  reviewModelId: z.string().optional(),
  /** 派活：能被派活（参数声明 + 名额）；null = 不能被派活 */
  dispatch: taskDispatchSchema.nullable().default(null),
  /** 派活：谁能派活给这个任务（任务 id） */
  dispatchFrom: ids.default([]),
  /** 定时到点时上一次还没跑完就跳过这次（默认跳过） */
  cronSkipIfRunning: z.boolean().default(true),
})
export type TaskInput = z.input<typeof taskInputSchema>
export const taskUpdateSchema = taskInputSchema.extend({ id: z.string().min(1) })
export const taskSetEnabledSchema = z.object({ id: z.string().min(1), enabled: z.boolean() })

// ---------- 任务记忆 ----------

/** 一个任务最多记多少条（全部放进系统提示，太多了 agent 抓不住重点） */
export const TASK_MEMORY_MAX = 100
const taskMemoryText = text("写一条这个任务要记住的经验", 1000)
export const taskMemoryAddSchema = z.object({ taskId: z.string().min(1), content: taskMemoryText })
export const taskMemoryUpdateSchema = z.object({ id: z.number().int(), content: taskMemoryText })
export const taskMemoryDeleteSchema = z.object({ id: z.number().int() })
export const taskMemoryListSchema = z.object({ taskId: z.string().min(1) })
/** 让三方 AI 总结一次已结束的运行、提取任务记忆候选 */
export const digestSessionInputSchema = z.object({ sessionId: z.string().min(1) })
/** 审核候选：index 是候选的序号（从 0 开始）；采用的可以改过文字再记 */
export const digestReviewInputSchema = z.object({
  sessionId: z.string().min(1),
  items: z
    .array(
      z
        .object({ index: z.number().int().min(0), accept: z.boolean(), text: optionalText(1000) })
        .refine((item) => !item.accept || item.text.length > 0, { message: "要记的那条不能是空的", path: ["text"] })
    )
    .min(1)
    .max(50),
})
export type DigestReviewInput = z.infer<typeof digestReviewInputSchema>

// ---------- 记忆 ----------

export const memoryInputSchema = z.object({
  content: text("请写下这条记忆", 1000),
  appliesTo: text("请选择或输入适用于哪里", 100),
})
export type MemoryInput = z.infer<typeof memoryInputSchema>
export const memoryUpdateSchema = memoryInputSchema.extend({ id: z.string().min(1) })
export const reviewInputSchema = z.object({ id: z.string().min(1), reason: optionalText(500).optional() })

// ---------- 技能 ----------

export const skillInputSchema = z.object({
  name: text("请填写名称", 100),
  dept: text("请选择或输入岗位", 50),
  description: text("请写一句什么时候用", 300),
  body: z.string().max(50_000, "操作手册太长了"),
  toolIds: ids.default([]),
})
export type SkillInput = z.input<typeof skillInputSchema>
export const skillUpdateSchema = skillInputSchema.extend({ id: z.string().min(1) })
export const skillSetStatusSchema = z.object({ id: z.string().min(1), status: skillStatusSchema })

export type DiffLine = { variant: "default" | "added" | "removed"; text: string }

/**
 * 把技能修改建议（逐行 diff）合并进正文：default / removed 行要在正文里按顺序找到（忽略首尾空白），
 * removed 删掉，added 插在前一行后面。diff 可以是整篇，也可以只是改动的那几段。
 * 找不到对应的行（技能在建议之后又被人改过）返回 null，提示人手动改。
 */
export function applySkillDiff(body: string, diff: readonly DiffLine[]): string | null {
  const lines = body.split("\n")
  const out: string[] = []
  let cursor = 0
  for (const line of diff) {
    if (line.variant === "added") {
      out.push(line.text)
      continue
    }
    let found = -1
    for (let j = cursor; j < lines.length; j++) {
      if (lines[j]!.trim() === line.text.trim()) {
        found = j
        break
      }
    }
    if (found < 0) return null
    out.push(...lines.slice(cursor, found))
    if (line.variant === "default") out.push(lines[found]!)
    cursor = found + 1
  }
  out.push(...lines.slice(cursor))
  return out.join("\n")
}

// ---------- 规则 ----------

export const ruleInputSchema = z.object({
  name: text("给规则起个名字，例如「改价前由主管确认」", 100),
  trigger: text("写一句话：什么情况下这条规则起作用", 500),
  action: text("写一句话：命中后 agent 该怎么做", 500),
  toolIds: ids.default([]),
})
export type RuleInput = z.input<typeof ruleInputSchema>
export const ruleUpdateSchema = ruleInputSchema.extend({ id: z.string().min(1) })
/** 删除后「撤销」：照原样（含 id）建回来 */
export const ruleRestoreSchema = ruleUpdateSchema

// ---------- 工具：HTTP 接口、密钥、MCP 服务器 ----------

/** 这次新填的密钥值：名字 → 值（只进不出，接口永远不返回） */
const secretValues = z.record(secretNameSchema, z.string().min(1).max(10_000)).default({})

export const httpToolInputSchema = z.object({
  /** 模型里的名字。新建时不填就按 URL 生成 http.<路径最后一段> */
  id: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9_.-]{1,63}$/, "模型里的名字只能用小写字母、数字和 . _ -，字母开头")
    .optional(),
  name: text("给工具起个名字，例如「查物流报价」", 100),
  description: text("写一两句话告诉模型什么时候用它", 2000),
  /** 一句话；不填就取说明的第一句 */
  summary: optionalText(200).optional(),
  http: z.object({
    method: httpMethodSchema,
    url: z.string().trim().regex(/^https?:\/\/\S+$/, "URL 要以 http:// 或 https:// 开头"),
    headers: z.record(z.string().trim().min(1), z.string()).default({}),
    body: z.string().max(50_000).optional(),
  }),
  risk: riskSchema,
  secrets: secretValues,
})
export type HttpToolInput = z.input<typeof httpToolInputSchema>
export const httpToolUpdateSchema = httpToolInputSchema.extend({ id: z.string().min(1) })
/** 删除后「撤销」：照原样建回来（密钥是全局的，删工具时不跟着删） */
export const httpToolRestoreSchema = z.object({ id: z.string().min(1), name: z.string().min(1), summary: z.string(), description: z.string(), http: httpSpecSchema, risk: riskSchema })

export const secretInputSchema = z.object({ name: secretNameSchema, value: z.string().min(1, "填真正的值").max(10_000) })

const mcpToolSchema = z.object({
  id: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/, "工具名只能用字母、数字和 . _ -"),
  name: text("工具要有名字", 100),
  summary: optionalText(300),
  description: optionalText(4000).optional(),
  risk: riskSchema,
})

/** 一行环境变量 / 请求头：值不填表示保留服务器上已存的值（编辑时只给了名字） */
const keyValueSchema = z.object({ name: z.string().trim().min(1).max(200), value: z.string().max(10_000).optional() })

const mcpServerBaseSchema = z.object({
  name: text("给服务器起个名字，例如「飞书」", 100),
  transport: z.enum(["stdio", "http"]),
  /** stdio：启动命令（含参数） */
  command: optionalText(2000).optional(),
  /** http：服务地址 */
  url: optionalText(2000).optional(),
  note: optionalText(300).default(""),
  /** stdio 是环境变量，http 是请求头；值只加密存，可以写 {{名字}} 引用已存的密钥 */
  env: z.array(keyValueSchema).max(50).default([]),
  /** 连接后读到并勾选的工具（工具页「连接并读取工具」读到后勾选的）；不传表示不改工具 */
  tools: z.array(mcpToolSchema).max(200).optional(),
})
function checkMcpTarget(value: { transport: "stdio" | "http"; command?: string; url?: string }, ctx: z.RefinementCtx) {
  if (value.transport === "stdio" && !value.command) ctx.addIssue({ code: "custom", path: ["command"], message: "填启动命令" })
  if (value.transport === "http" && !/^https?:\/\/\S+$/.test(value.url ?? "")) ctx.addIssue({ code: "custom", path: ["url"], message: "填服务地址，以 http:// 或 https:// 开头" })
}
export const mcpServerInputSchema = mcpServerBaseSchema.superRefine(checkMcpTarget)
export type McpServerInput = z.input<typeof mcpServerInputSchema>
export const mcpServerUpdateSchema = mcpServerBaseSchema.extend({ id: z.string().min(1) }).superRefine(checkMcpTarget)

// ---------- 浏览器 ----------

export const browserProfileInputSchema = z.object({
  name: text("起个名字，例如「英国 Chrome」", 100),
  description: optionalText(500).default(""),
  proxy: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("none") }),
    z.object({
      kind: z.literal("socks5"),
      host: text("填代理地址", 200),
      port: z.number().int().min(1, "端口不对").max(65535, "端口不对"),
      username: optionalText(200).optional(),
      /** 新密码；不填表示不改（编辑时） */
      password: z.string().max(1000).optional(),
      /** 去掉已存的密码 */
      clearPassword: z.boolean().optional(),
    }),
  ]),
  /** 出口地：一句话，给人看的（例如「英国 · 伦敦」），系统不检测 */
  exitIp: optionalText(100).optional(),
  /** IANA 时区，例如 Asia/Shanghai；空 = 用默认（上海） */
  timezone: optionalText(64)
    .refine((value) => !value || canonicalTimeZone(value), "不认识这个时区，从列表里选一个，例如 Asia/Shanghai")
    .transform((value) => (value ? canonicalTimeZone(value)! : value))
    .optional(),
  /** 语言，例如 zh-CN、en-US；空 = 用默认（zh-CN） */
  locale: optionalText(32)
    .refine((value) => !value || canonicalLocale(value), "填语言代码，例如 zh-CN、en-US")
    .transform((value) => (value ? canonicalLocale(value)! : value))
    .optional(),
})
export type BrowserProfileInput = z.input<typeof browserProfileInputSchema>
export const browserProfileUpdateSchema = browserProfileInputSchema.extend({ id: z.string().min(1) })

export const platformInputSchema = z.object({
  name: text("填平台（网站）名，例如「示例商城」", 100),
  /** 英文短名；不填就按名字生成 */
  id: z
    .string()
    .trim()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "英文短名只能用小写字母、数字和 -")
    .optional(),
  /** 这个平台的域名（M2）：session 打开这些域名下的网址时按「平台 × 账号」申请租约。子域名也算 */
  domains: z.array(domainSchema).max(50).default([]),
})
export const platformUpdateSchema = z.object({
  id: z.string().min(1),
  name: text("填平台（网站）名，例如「示例商城」", 100),
  domains: z.array(domainSchema).max(50).default([]),
})

export const browserAccountInputSchema = z.object({
  profileId: z.string().min(1),
  platformId: z.string().min(1, "选一个平台"),
  /** 登录用的账号（用户名、邮箱或手机号） */
  account: text("填账号", 200),
  /** 登录密码：只加密存，任何接口都不返回；agent 只看到占位符。不填 = 只能人工登录 */
  password: z.string().max(1000).optional(),
  maxConcurrent: z.number().int().min(1).max(20).default(1),
  probeUrl: z
    .string()
    .trim()
    .regex(/^https?:\/\/\S+$/, "网址要以 http:// 或 https:// 开头")
    .optional()
    .or(z.literal("")),
  saveIndexedDb: z.boolean().default(false),
})
export type BrowserAccountInput = z.input<typeof browserAccountInputSchema>
export const browserAccountUpdateSchema = z.object({
  id: z.string().min(1),
  account: text("填账号", 200).optional(),
  /** 新密码；不填 = 不改 */
  password: z.string().max(1000).optional(),
  /** 去掉已存的密码 */
  clearPassword: z.boolean().optional(),
  maxConcurrent: z.number().int().min(1).max(20).optional(),
  probeUrl: browserAccountInputSchema.shape.probeUrl,
  saveIndexedDb: z.boolean().optional(),
})

// ---------- 模型 ----------

export const OPENROUTER_DEFAULT_URL = "https://openrouter.ai/api/v1"
/** 直连厂商的官方地址（AI SDK 各 provider 的默认值；列模型是 地址 + /models） */
export const ANTHROPIC_DEFAULT_URL = "https://api.anthropic.com/v1"
export const OPENAI_DEFAULT_URL = "https://api.openai.com/v1"
export const DEEPSEEK_DEFAULT_URL = "https://api.deepseek.com"

/** 除了内网的 Ollama，都要 API Key */
export const providerNeedsKey = (kind: ModelProviderKind) => kind !== "ollama"

export const providerInputSchema = z.object({
  kind: modelProviderKindSchema,
  name: optionalText(100).optional(),
  baseUrl: z.string().trim().regex(/^https?:\/\/\S+$/, "填完整地址，以 http:// 或 https:// 开头"),
  /** 新 key；编辑时不填表示不改 */
  apiKey: z.string().trim().max(1000).optional(),
})
export type ProviderInput = z.input<typeof providerInputSchema>
export const providerUpdateSchema = providerInputSchema.omit({ kind: true }).extend({ id: z.string().min(1) })
/**
 * embed 不传 = 不改；传空字符串 = 不用 embedding 模型（图库就不能以图搜图）。
 * assistant 同样：不传 = 不改；传空字符串 = 不单独配，助手用 plan 默认模型。
 * review（复核，run-outcome 5.2）同样：不传 = 不改；传空字符串 = 不配复核模型，运行结束不复核，结果落到「没核实」
 */
export const modelDefaultsInputSchema = z.object({ run: z.string().min(1), plan: z.string().min(1), verify: z.string().min(1), embed: z.string().optional(), assistant: z.string().optional(), review: z.string().optional() })

/** 测试连接、刷新模型列表的结果 */
export const providerCheckSchema = z.object({
  ok: z.boolean(),
  latencyMs: z.number().optional(),
  models: z.number().int().optional(),
  message: z.string(),
  /** 连上了但要提醒的事，例如直连厂商时有模型查不到价格 */
  note: z.string().optional(),
})
export type ProviderCheck = z.infer<typeof providerCheckSchema>

// ---------- 人加的待办 ----------

export const todoTriggerInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("time"), at: z.string().min(1, "选一个时间") }),
  z.object({ kind: z.literal("cron"), cron: cronSchema, text: optionalText(100).optional() }),
  z.object({ kind: z.literal("event"), event: text("选一个事件，或者输入一句话描述要等的事", 200), fallbackDays: z.number().int().min(1).max(90) }),
  z.object({ kind: z.literal("time_or_event"), at: z.string().min(1, "选一个时间"), event: text("选一个事件，或者输入一句话描述要等的事", 200) }),
])
export const todoInputSchema = z.object({
  taskId: z.string().min(1, "选一个任务"),
  title: text("写一句要 agent 做什么", 500),
  trigger: todoTriggerInputSchema,
})
export type TodoInput = z.input<typeof todoInputSchema>
export const todoUpdateSchema = todoInputSchema.extend({ id: z.string().min(1) })

// ---------- 用户 ----------

export const PASSWORD_MIN = 8
const passwordSchema = z.string().min(PASSWORD_MIN, `密码至少 ${PASSWORD_MIN} 位`).max(128, "密码太长了")
export const userRoleSchema = z.enum(["admin", "user"])

export const userCreateSchema = z.object({
  email: z.string().trim().toLowerCase().email("邮箱格式不对"),
  name: text("填名字", 50),
  title: optionalText(50).default(""),
  role: userRoleSchema,
  password: passwordSchema,
})
export type UserCreateInput = z.input<typeof userCreateSchema>
export const userUpdateSchema = z.object({ id: z.string().min(1), name: text("填名字", 50), title: optionalText(50), role: userRoleSchema })
export const userSetDisabledSchema = z.object({ id: z.string().min(1), disabled: z.boolean() })
export const userResetPasswordSchema = z.object({ id: z.string().min(1), password: passwordSchema })
export const changePasswordSchema = z.object({ currentPassword: z.string().min(1, "填现在的密码"), newPassword: passwordSchema })

/** 首次设置（POST /api/setup）：还没有任何账号时，第一个打开控制台的人建管理员 */
export const setupAdminSchema = z.object({
  name: text("填名字", 50),
  email: userCreateSchema.shape.email,
  password: passwordSchema,
})
export type SetupAdminInput = z.input<typeof setupAdminSchema>
/** GET /api/setup：needed = 还没有任何账号，要先建管理员 */
export interface SetupStatus {
  needed: boolean
}

/** 用户页的一行（只有管理员能看） */
export const userAccountSchema = z.object({
  id: z.string(),
  name: z.string(),
  email: z.string(),
  title: z.string(),
  isAdmin: z.boolean(),
  /** 已停用：登录不了 */
  disabled: z.boolean(),
  createdAt: z.string(),
})
export type UserAccount = z.infer<typeof userAccountSchema>

// ---------- 全局设置（settings 表，键值） ----------

/** settings 表里的键。引擎（P1）按这些键读 */
export const SETTING_KEYS = {
  /** 单个 session 的花费上限（美元），超过就转人工 */
  maxCostUsd: "session.maxCostUsd",
  /** 单个 session 最多步数（模型调用次数），超过就转人工；0 = 不限 */
  maxSteps: "session.maxSteps",
  /** 只等事件时的兜底天数 */
  eventFallbackDays: "wait.eventFallbackDays",
  /** 外部事件（POST /api/events）的令牌：只存 sha256，原文只在生成时给一次 */
  eventToken: "events.token",
  /** 通知渠道：webhook 地址存在 secrets（scope = http_tool，名字 = urlSecretName） */
  notifyChannels: "notify.channels",
  /** 每个 worker 同时最多开几个 Chrome（M2），满了排队 */
  browserMaxPerWorker: "browser.maxPerWorker",
  /** 验证码 / 登录页规则拿不准时，交给便宜的视觉模型看截图（M2，默认关） */
  browserVisionCheck: "browser.visionCheck",
  /** 浏览器用的视觉模型：拿不准时看截图、自动过验证码都用它（2026-10-19） */
  browserVisionModel: "browser.visionModel",
  /** 遇到验证码先自己试着过（图片字符、「我不是机器人」这类简单的），过不了再交给人（2026-10-19，默认开） */
  browserCaptchaSolve: "browser.captchaSolve",
  /** 遇到验证码等人处理时，Chrome 最多保留多少分钟（M2） */
  browserHumanHoldMinutes: "browser.humanHoldMinutes",
  /** 三方验收最多几轮（M3）：前几轮有不通过或存疑就反问执行的 agent，到最后一轮还说不清就交给负责人 */
  verifyMaxRounds: "verify.maxRounds",
  /** 发给模型的历史超过多少 token 就压缩（M3）；0 = 只按模型上下文的 60% */
  compactMaxTokens: "context.compactMaxTokens",
  /** 派活：最多几层（被派的运行再派活算一层） */
  dispatchMaxDepth: "dispatch.maxDepth",
  /** 派活：一次运行最多派几张（已有的单再派一次不算） */
  dispatchMaxPerSession: "dispatch.maxPerSession",
  /** 派活：一个任务每天（上海时间）最多被派几张 */
  dispatchMaxPerTaskPerDay: "dispatch.maxPerTaskPerDay",
  /** 派活：一个任务最多排队几张 */
  dispatchMaxQueued: "dispatch.maxQueued",
  /** 右下角助手：一次请求最多几步模型调用（2026-10-19） */
  assistantMaxSteps: "assistant.maxSteps",
  /** 右下角助手：一次请求最多花多少美元（2026-10-19） */
  assistantMaxCostUsd: "assistant.maxCostUsd",
} as const

export const SETTINGS_DEFAULTS = {
  maxCostUsd: 2,
  maxSteps: 0,
  eventFallbackDays: 7,
  browserMaxPerWorker: 4,
  browserVisionCheck: false,
  browserVisionModel: "openrouter/qwen/qwen3.8-flash",
  browserCaptchaSolve: true,
  browserHumanHoldMinutes: 30,
  verifyMaxRounds: 2,
  compactMaxTokens: 0,
  dispatchMaxDepth: 3,
  dispatchMaxPerSession: 100,
  dispatchMaxPerTaskPerDay: 500,
  dispatchMaxQueued: 1000,
  assistantMaxSteps: 20,
  assistantMaxCostUsd: 0.2,
} as const

/** 设置页「派活」一组 */
export const settingsDispatchInputSchema = z.object({
  maxDepth: z.number().int().min(1, "至少 1 层").max(10, "最多 10 层"),
  maxPerSession: z.number().int().min(1, "至少 1 张").max(1000, "最多 1000 张"),
  maxPerTaskPerDay: z.number().int().min(1, "至少 1 张").max(100_000, "最多 100000 张"),
  maxQueued: z.number().int().min(1, "至少 1 张").max(100_000, "最多 100000 张"),
})
export type SettingsDispatchInput = z.infer<typeof settingsDispatchInputSchema>

/** 浏览器视觉模型的默认值（OpenRouter 上便宜的视觉模型）；设置页「浏览器」里可以换 */
export const BROWSER_VISION_MODEL = SETTINGS_DEFAULTS.browserVisionModel

export const notifyChannelSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(["feishu", "wecom", "webhook"]),
  /** webhook 地址存在 secrets 里的名字（scope = http_tool） */
  urlSecretName: z.string(),
  enabled: z.boolean(),
})
export type NotifyChannel = z.infer<typeof notifyChannelSchema>

/** events.token 存的值 */
export const eventTokenRecordSchema = z.object({ sha256: z.string(), hint: z.string(), createdAt: z.string() })

export const settingsLimitsInputSchema = z.object({
  maxCostUsd: z.number().min(0.01, "至少 0.01 美元").max(1000, "最多 1000 美元"),
  /** 0 = 不限 */
  maxSteps: z.number().int().min(0, "不能小于 0（0 表示不限）").max(10_000, "最多 10000 步"),
  eventFallbackDays: z.number().int().min(1, "至少 1 天").max(90, "最多 90 天"),
})
export type SettingsLimitsInput = z.infer<typeof settingsLimitsInputSchema>

export const notifyChannelInputSchema = z.object({
  id: z.string().optional(),
  name: text("给渠道起个名字，例如「运营群」", 50),
  kind: notifyChannelSchema.shape.kind,
  /** 新地址；编辑时不填表示不改 */
  url: z
    .string()
    .trim()
    .regex(/^https?:\/\/\S+$/, "地址要以 http:// 或 https:// 开头")
    .optional()
    .or(z.literal("")),
  enabled: z.boolean().default(true),
})
export type NotifyChannelInput = z.input<typeof notifyChannelInputSchema>

/** 设置页读到的样子：令牌只给尾号，渠道地址只给掩码 */
export const settingsBrowserInputSchema = z.object({
  maxPerWorker: z.number().int().min(1, "至少 1 个").max(32, "最多 32 个"),
  visionCheck: z.boolean(),
  /** 视觉模型：拿不准时看截图、自动过验证码都用它；要是能看图的聊天模型 */
  visionModel: z.string().trim().min(1, "选一个能看图的模型"),
  /** 遇到验证码先自己试着过 */
  captchaSolve: z.boolean(),
  humanHoldMinutes: z.number().int().min(1, "至少 1 分钟").max(24 * 60, "最多 1440 分钟"),
})
export type SettingsBrowserInput = z.infer<typeof settingsBrowserInputSchema>

/** agent 相关的设置（M3）：验收最多几轮、上下文压缩的 token 上限 */
export const settingsAgentInputSchema = z.object({
  verifyMaxRounds: z.number().int().min(1, "至少 1 轮").max(10, "最多 10 轮"),
  /** 0 = 只按模型上下文的 60% */
  compactMaxTokens: z.number().int().min(0).max(10_000_000),
})
export type SettingsAgentInput = z.infer<typeof settingsAgentInputSchema>

export const settingsViewSchema = settingsLimitsInputSchema.extend({
  browser: settingsBrowserInputSchema,
  /** M3：验收轮数、压缩上限（老前端不认也不影响） */
  agent: settingsAgentInputSchema.optional(),
  /** 派活的四个上限（老前端不认也不影响） */
  dispatch: settingsDispatchInputSchema.optional(),
  /** 右下角助手的两个上限（老前端不认也不影响） */
  assistant: settingsAssistantInputSchema.optional(),
  eventToken: z.object({ hint: z.string(), createdAt: z.string() }).optional(),
  channels: z.array(notifyChannelSchema.extend({ urlMasked: z.string().optional() })),
})
export type SettingsView = z.infer<typeof settingsViewSchema>

// ---------- 前端表单专用（表单的形状和接口输入不完全一样时用；提交前转换成上面的接口输入） ----------

/** 改密码：多一个「再输一次」 */
export const changePasswordFormSchema = changePasswordSchema
  .extend({ confirm: z.string() })
  .refine((value) => value.confirm === value.newPassword, { path: ["confirm"], message: "两次输入的新密码不一样" })
export type ChangePasswordForm = z.input<typeof changePasswordFormSchema>

/** 首次设置管理员：多一个「再输一次」 */
export const setupAdminFormSchema = setupAdminSchema
  .extend({ confirm: z.string() })
  .refine((value) => value.confirm === value.password, { path: ["confirm"], message: "两次输入的密码不一样" })
export type SetupAdminForm = z.input<typeof setupAdminFormSchema>

/** HTTP 工具：请求头在表单里是多行文字「名字: 值」，提交时转成对象；secrets 是这次新填的值 */
export const httpToolFormSchema = z.object({
  name: httpToolInputSchema.shape.name,
  description: httpToolInputSchema.shape.description,
  method: httpMethodSchema,
  url: z.string().trim().regex(/^https?:\/\/\S+$/, "URL 要以 http:// 或 https:// 开头"),
  headers: z.string(),
  body: z.string(),
  risk: riskSchema,
  secrets: z.record(z.string(), z.string()),
})
export type HttpToolForm = z.input<typeof httpToolFormSchema>

/** MCP 服务器：环境变量 / 请求头在表单里是多行文字「名字=值」，值写 •••• 表示保留服务器上已存的 */
export const mcpServerFormSchema = z
  .object({
    name: mcpServerBaseSchema.shape.name,
    transport: z.enum(["stdio", "http"]),
    target: z.string().trim(),
    note: optionalText(300),
    env: z.string(),
  })
  .superRefine((value, ctx) => {
    if (!value.target) ctx.addIssue({ code: "custom", path: ["target"], message: value.transport === "stdio" ? "填启动命令" : "填服务地址" })
    else if (value.transport === "http" && !/^https?:\/\/\S+$/.test(value.target)) ctx.addIssue({ code: "custom", path: ["target"], message: "地址要以 http:// 或 https:// 开头" })
  })
export type McpServerForm = z.input<typeof mcpServerFormSchema>

/** 人加的待办：四种「什么时候」平铺成一个表单，提交时按 mode 转成 todoTriggerInputSchema */
export const todoFormSchema = z
  .object({
    taskId: z.string().min(1, "选一个任务"),
    title: text("写一句要 agent 做什么", 500),
    mode: z.enum(["time", "cron", "event", "time_or_event"]),
    /** datetime-local 的值（上海时间），例如 2026-10-17T10:00 */
    at: z.string(),
    cron: z.string(),
    event: z.string(),
    fallbackDays: z.number().int().min(1).max(90),
  })
  .superRefine((value, ctx) => {
    if ((value.mode === "time" || value.mode === "time_or_event") && !value.at) ctx.addIssue({ code: "custom", path: ["at"], message: "选一个时间" })
    if ((value.mode === "event" || value.mode === "time_or_event") && !value.event.trim()) ctx.addIssue({ code: "custom", path: ["event"], message: "选一个事件，或者输入一句话描述要等的事" })
    if (value.mode === "cron" && !isValidCron(value.cron)) ctx.addIssue({ code: "custom", path: ["cron"], message: "看不懂这个表达式：要 5 段（分 时 日 月 周），例如 0 9 * * 1-5" })
  })
export type TodoForm = z.input<typeof todoFormSchema>

/** 保留已存值的占位（MCP 环境变量、请求头编辑时显示） */
export const KEEP_SECRET_MASK = "••••"
