// 演示数据，M4 换成真实数据。
// 从 design/prototype/src/mock/shared.ts 原样复制（2026-10-17），只给「看懂架构」页的讲解用；其他页面都读接口，不要从这里取数据。
// HeyAgent 原型 v3 · 共享假数据（单一来源，页面只读）
// 架构：任务 → 每次运行是一个 session（要等时挂起，等到了继续同一个 session）→ 检查点、工具调用、token 都记在运行里。
// 待办看板 = 每次运行一张卡 + 每件要人办的事一张卡。规则、工具、记忆、技能、模型在建任务时选。
// 页面需要的细节（长文案、证据、说明书等）写在各自的 data.ts 里，用这里的 id 关联。

// ---------- 人 ----------

export interface Staff {
  id: string
  name: string
  title: string
  isAdmin: boolean
}

export const staff: Staff[] = [
  { id: "u-lin", name: "林舟", title: "运营主管", isAdmin: true },
  { id: "u-wang", name: "王悦", title: "搜品专员", isAdmin: false },
  { id: "u-li", name: "李静", title: "采购专员", isAdmin: false },
  { id: "u-chen", name: "陈强", title: "物流专员", isAdmin: false },
  { id: "u-emily", name: "Emily Zhao", title: "客户经理（AM）", isAdmin: false },
]

/** 主管视角登录的人 */
export const ADMIN_USER_ID = "u-lin"
/** 员工视角登录的人 */
export const STAFF_USER_ID = "u-wang"

// ---------- 业务对象 ----------

export interface Platform {
  id: string
  name: string
}

export const platforms: Platform[] = [
  { id: "amazon", name: "亚马逊" },
  { id: "temu", name: "Temu" },
  { id: "tiktok", name: "TikTok Shop" },
  { id: "1688", name: "1688" },
  { id: "shopify", name: "Shopify" },
  { id: "whatsapp", name: "WhatsApp" },
]

export interface Client {
  id: string
  name: string
  country: string
}

export const clients: Client[] = [
  { id: "c-nova", name: "Nova Home", country: "美国" },
  { id: "c-lumi", name: "Lumi Beauty", country: "英国" },
  { id: "c-kito", name: "Kito Pets", country: "德国" },
]

export interface Supplier {
  id: string
  name: string
  kind: "工厂" | "贸易商"
}

export const suppliers: Supplier[] = [
  { id: "s-hengda", name: "义乌恒达日用品厂", kind: "工厂" },
  { id: "s-xunke", name: "深圳迅科电子", kind: "贸易商" },
  { id: "s-lvye", name: "杭州绿叶家居", kind: "工厂" },
]

// ---------- 模型 ----------

export type ModelProviderKind = "ollama" | "openrouter"

export interface ModelInfo {
  /** 全局唯一：provider/模型名 */
  id: string
  name: string
  /** 一句话：适合干什么 */
  note: string
  contextK: number
  /** 每百万 token 的价格（美元）；本地模型为 0 */
  priceIn: number
  priceOut: number
}

export interface ModelProvider {
  id: ModelProviderKind
  name: string
  baseUrl: string
  /** OpenRouter 才有 */
  apiKeyMasked?: string
  status: "ok" | "error"
  checkedAt: string
  latencyMs: number
  models: ModelInfo[]
}

export const modelProviders: ModelProvider[] = [
  {
    id: "ollama",
    name: "Ollama（内网）",
    baseUrl: "http://192.168.31.100:11434",
    status: "ok",
    checkedAt: "2026-10-16 16:20",
    latencyMs: 12,
    models: [
      { id: "ollama/qwen3:32b", name: "qwen3:32b", note: "本地免费，中文好；默认做三方验收", contextK: 128, priceIn: 0, priceOut: 0 },
      { id: "ollama/qwen2.5-vl:7b", name: "qwen2.5-vl:7b", note: "能看图，以图搜同款前先看主图", contextK: 32, priceIn: 0, priceOut: 0 },
      { id: "ollama/llama3.3:70b", name: "llama3.3:70b", note: "英文客户回复备用", contextK: 128, priceIn: 0, priceOut: 0 },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyMasked: "sk-or-v1-••••••••3f2a",
    status: "ok",
    checkedAt: "2026-10-16 16:20",
    latencyMs: 420,
    models: [
      { id: "openrouter/anthropic/claude-opus-5.5", name: "Claude Opus 5.5", note: "最聪明，用来规划和拆复杂任务", contextK: 1000, priceIn: 4, priceOut: 20 },
      { id: "openrouter/anthropic/claude-sonnet-5.5", name: "Claude Sonnet 5.5", note: "日常执行，又快又稳", contextK: 1000, priceIn: 2, priceOut: 10 },
      { id: "openrouter/anthropic/claude-haiku-5.5", name: "Claude Haiku 5.5", note: "便宜，适合大量简单子任务", contextK: 1000, priceIn: 0.1, priceOut: 0.5 },
    ],
  },
]

/** 默认用哪个模型：执行任务 / 规划拆解 / 三方验收（验收用不同家族的模型，才算真的「第三方」） */
export const modelDefaults = {
  run: "openrouter/anthropic/claude-sonnet-5.5",
  plan: "openrouter/anthropic/claude-opus-5.5",
  verify: "ollama/qwen3:32b",
}

export const allModels: ModelInfo[] = modelProviders.flatMap((provider) => provider.models)

/** 模型属于哪一家（看 id 里的关键词）。三方验收不许和执行用同一家（已定） */
const FAMILY_NAMES: [keyword: string, name: string][] = [
  ["anthropic", "Anthropic"], ["claude", "Anthropic"], ["qwen", "阿里通义"], ["llama", "Meta"], ["deepseek", "DeepSeek"],
  ["openai", "OpenAI"], ["gpt", "OpenAI"], ["gemini", "Google"], ["gemma", "Google"], ["mistral", "Mistral"], ["x-ai", "xAI"], ["grok", "xAI"], ["phi", "Microsoft"],
]

export function modelFamily(modelId: string): string {
  // 先去掉服务前缀（ollama/、openrouter/），否则「ollama」里的「llama」会把所有 Ollama 模型认成 Meta
  const model = modelId.toLowerCase().split("/").slice(1).join("/")
  const known = FAMILY_NAMES.find(([keyword]) => model.includes(keyword))
  if (known) return known[1]
  // 认不出来的：OpenRouter 取厂商（厂商/模型），Ollama 取模型名的开头（名字:标签）
  const raw = model.includes("/") ? model.split("/")[0] : model.split(/[:\d.-]/)[0]
  return raw ? raw.charAt(0).toUpperCase() + raw.slice(1) : "其他"
}

export function sameFamily(a: string, b: string): boolean {
  return modelFamily(a) === modelFamily(b)
}

export function modelName(id: string | undefined): string {
  return allModels.find((model) => model.id === id)?.name ?? id ?? "—"
}

// ---------- 浏览器（Chrome） ----------

export type AccountStatus = "ok" | "expired" | "captcha"

export const accountStatusLabel: Record<AccountStatus, string> = {
  ok: "已登录",
  expired: "登录失效",
  captcha: "需要验证码",
}

/** 某个 Chrome 里登录过的网站（cookie / session 存在这个 Chrome 的登录态保险箱里） */
export interface BrowserSite {
  platformId: string
  account: string
  status: AccountStatus
  lastLoginAt: string
  loggedInById: string
  /** 这个账号同时最多几个 session 在用（同一账号多处同时登录容易被平台风控）。已定：按「平台 × 账号」设 */
  maxConcurrent: number
  /** 这个账号现在有几个 session 在用 */
  running: number
}

export type BrowserProxy = { kind: "none" } | { kind: "socks5"; host: string; port: number; username?: string }

export interface BrowserProfile {
  id: string
  name: string
  /** 给 agent 看的说明：它靠这句话自己选用哪个 Chrome */
  description: string
  proxy: BrowserProxy
  /** 出口 IP 所在地 */
  exitIp: string
  /** 这个 Chrome 现在开着几个 session */
  running: number
  sites: BrowserSite[]
  cookieCount: number
  /** 保险箱版本：每次回写 +1 */
  vaultVersion: number
  updatedAt: string
}

export const browserProfiles: BrowserProfile[] = [
  {
    id: "br-cn",
    name: "国内 Chrome",
    description: "国内 IP，用于 1688、淘宝等国内平台",
    proxy: { kind: "none" },
    exitIp: "杭州 · 公司宽带",
    running: 0,
    sites: [{ platformId: "1688", account: "公司采购账号", status: "ok", lastLoginAt: "2026-10-14 09:00", loggedInById: "u-li", maxConcurrent: 3, running: 0 }],
    cookieCount: 46,
    vaultVersion: 12,
    updatedAt: "2026-10-16 16:21",
  },
  {
    id: "br-us",
    name: "美国 Chrome",
    description: "美国 IP（SOCKS5 代理），用于亚马逊、Temu、TikTok Shop 美国站",
    proxy: { kind: "socks5", host: "10.0.8.21", port: 1080, username: "heyagent" },
    exitIp: "美国 · 洛杉矶",
    running: 1,
    sites: [
      { platformId: "amazon", account: "买家账号（美国站）", status: "captcha", lastLoginAt: "2026-10-12 15:20", loggedInById: "u-wang", maxConcurrent: 1, running: 0 },
      { platformId: "temu", account: "买家账号（美国站）", status: "ok", lastLoginAt: "2026-10-15 10:30", loggedInById: "u-wang", maxConcurrent: 2, running: 1 },
      { platformId: "tiktok", account: "买家账号", status: "expired", lastLoginAt: "2026-09-28 11:05", loggedInById: "u-wang", maxConcurrent: 1, running: 0 },
    ],
    cookieCount: 88,
    vaultVersion: 31,
    updatedAt: "2026-10-16 11:02",
  },
  {
    id: "br-de",
    name: "德国 Chrome",
    description: "德国 IP（SOCKS5 代理），查德国本地仓和亚马逊德国站",
    proxy: { kind: "socks5", host: "10.0.8.22", port: 1080 },
    exitIp: "德国 · 法兰克福",
    running: 0,
    sites: [],
    cookieCount: 0,
    vaultVersion: 1,
    updatedAt: "2026-10-15 18:00",
  },
]

// ---------- 工具 ----------

export type ToolSource = "builtin" | "mcp" | "http"

export const toolSourceLabel: Record<ToolSource, string> = {
  builtin: "内置",
  mcp: "MCP",
  http: "HTTP 接口",
}

export type Risk = "read" | "write" | "external" | "money"

export const riskLabel: Record<Risk, string> = {
  read: "只读",
  write: "写入内部数据",
  external: "对外发送",
  money: "涉及金钱",
}

export interface McpServer {
  id: string
  name: string
  transport: "stdio" | "http"
  /** stdio：启动命令 */
  command?: string
  /** http：服务地址 */
  url?: string
  status: "connected" | "error"
  note: string
}

export const mcpServers: McpServer[] = [
  {
    id: "mcp-playwright",
    name: "浏览器（Playwright MCP）",
    transport: "stdio",
    command: "npx @playwright/mcp@0.0.83 --isolated --cdp-endpoint {所选 Chrome}",
    status: "connected",
    note: "agent 自己选用哪个 Chrome；登录态来自「浏览器」里的保险箱",
  },
  {
    id: "mcp-erp",
    name: "公司 ERP",
    transport: "http",
    url: "http://192.168.31.20:8080/mcp",
    status: "connected",
    note: "供应商库、比价表",
  },
]

export interface HttpSpec {
  method: "GET" | "POST"
  url: string
  headers?: Record<string, string>
  body?: string
}

export interface ToolRef {
  id: string
  name: string
  /** 给模型看的一句话 */
  summary: string
  source: ToolSource
  /** source 为 mcp 时：来自哪个 MCP 服务器 */
  serverId?: string
  /** source 为 http 时：怎么调 */
  http?: HttpSpec
  risk: Risk
  /** 每个任务都自带，建任务时不用选（已定：勾检查点、挂起等待、问人） */
  alwaysOn?: boolean
}

export const tools: ToolRef[] = [
  { id: "browser.open", name: "打开网页", summary: "在所选 Chrome 里打开一个网址，读取页面内容", source: "mcp", serverId: "mcp-playwright", risk: "read" },
  { id: "browser.act", name: "网页操作", summary: "在网页上点击、输入、翻页、发消息", source: "mcp", serverId: "mcp-playwright", risk: "write" },
  { id: "browser.screenshot", name: "网页截图", summary: "给当前页面截图，留作证据", source: "mcp", serverId: "mcp-playwright", risk: "read" },
  { id: "shopify.product", name: "解析 Shopify 商品", summary: "走接口读取 Shopify 商品的标题、图片、价格和规格，不用开浏览器", source: "http", http: { method: "GET", url: "https://{shop}/products/{handle}.json" }, risk: "read" },
  { id: "image.search", name: "以图搜同款", summary: "用商品主图在多个平台搜同款", source: "http", http: { method: "POST", url: "http://192.168.31.30:9000/api/image-search", headers: { "Content-Type": "application/json" }, body: '{"image_url": "{image_url}", "platforms": ["1688", "temu", "amazon"]}' }, risk: "read" },
  { id: "supplier.lookup", name: "查供应商库", summary: "在公司供应商库里查合作记录和评价", source: "mcp", serverId: "mcp-erp", risk: "read" },
  { id: "quote.save", name: "保存比价表", summary: "把整理好的供应商比价表存进 ERP", source: "mcp", serverId: "mcp-erp", risk: "write" },
  { id: "whatsapp.send", name: "发 WhatsApp", summary: "给客户发 WhatsApp 消息（官方 Business 接口）", source: "http", http: { method: "POST", url: "https://graph.facebook.com/v21.0/{phone_number_id}/messages", headers: { Authorization: "Bearer {{WHATSAPP_TOKEN}}", "Content-Type": "application/json" }, body: '{"messaging_product": "whatsapp", "to": "{to}", "type": "text", "text": {"body": "{text}"}}' }, risk: "external" },
  { id: "order.place", name: "1688 下单", summary: "在 1688 下采购单或打样单", source: "http", http: { method: "POST", url: "https://gw.open.1688.com/openapi/{下单接口}", headers: { Authorization: "Bearer {{ALI1688_TOKEN}}" } }, risk: "money" },
  { id: "skill.load", name: "读取技能", summary: "按名字读取某个技能的全文", source: "builtin", risk: "read" },
  { id: "memory.propose", name: "提议记忆", summary: "提议记住一件事，进入待办等人审核", source: "builtin", risk: "write" },
  { id: "skill.propose", name: "提议修改技能", summary: "对某个技能提出修改建议，进入待办等人审核", source: "builtin", risk: "write" },
  { id: "checkpoint.mark", name: "勾检查点", summary: "把一个检查点标记为完成或跳过，附上结果或跳过理由", source: "builtin", risk: "write", alwaysOn: true },
  { id: "session.wait", name: "挂起等待", summary: "记下在等什么，挂起当前 session；等到回复或到点后继续同一个 session", source: "builtin", risk: "write", alwaysOn: true },
  { id: "ask.human", name: "问人", summary: "向负责人提问或请人拍板，等回答后继续", source: "builtin", risk: "write", alwaysOn: true },
  { id: "notify.staff", name: "通知员工", summary: "给员工发站内通知", source: "builtin", risk: "write" },
]

/** 每个任务都自带的工具 id */
export const ALWAYS_ON_TOOL_IDS: string[] = tools.filter((tool) => tool.alwaysOn).map((tool) => tool.id)

// ---------- 规则（建任务时手动选，没有全局开关） ----------

export interface RuleRef {
  id: string
  name: string
  /** 触发条件：用一句话描述，什么情况下这条规则起作用 */
  trigger: string
  /** 命中后怎么办 */
  action: string
  /** 规则命中后会调用的工具 */
  toolIds: string[]
}

export const rules: RuleRef[] = [
  { id: "rl-wa-confirm", name: "给客户发消息前由 AM 确认", trigger: "agent 要给客户发 WhatsApp 消息时", action: "先拦下，把原文交给对应客户的 AM，批准才发出", toolIds: ["ask.human"] },
  { id: "rl-order-approval", name: "下单前必须主管审批", trigger: "agent 要在 1688 下单或付款时", action: "拦下，交给运营主管审批", toolIds: ["ask.human"] },
  { id: "rl-captcha", name: "遇到验证码就停下", trigger: "打开网页后看到验证码或登录页时", action: "截图，挂起任务，通知负责人去「浏览器」里处理", toolIds: ["browser.screenshot", "notify.staff"] },
  { id: "rl-screenshot", name: "每一步截图留证", trigger: "每次打开网页或在网页上操作之后", action: "截一张图，存进运行记录", toolIds: ["browser.screenshot"] },
  { id: "rl-whitelist", name: "只访问白名单网站", trigger: "agent 要打开不在白名单里的网址时", action: "拦下，告诉 agent 换一个网站", toolIds: [] },
  { id: "rl-memory-review", name: "新记忆先审核", trigger: "agent 提议记住一件事时", action: "放进待办，等相关员工审核", toolIds: ["notify.staff"] },
  { id: "rl-checkpoint-sync", name: "同步检查点", trigger: "发出消息、打开网页、保存文件之后", action: "把这次的记录写进对应的检查点", toolIds: ["checkpoint.mark"] },
  { id: "rl-verify", name: "三方 AI 验收", trigger: "agent 说任务做完时", action: "让另一个模型逐条核对检查点，没完成的反问执行 agent；说不清的交给人", toolIds: ["ask.human"] },
  { id: "rl-budget", name: "单次运行花费上限 20 美元", trigger: "这次运行的模型花费超过 20 美元时", action: "挂起，通知负责人决定要不要继续", toolIds: ["notify.staff"] },
]

// ---------- 记忆 ----------

export type MemoryStatus = "active" | "pending" | "rejected" | "archived"

export const memoryStatusLabel: Record<MemoryStatus, string> = {
  active: "生效",
  pending: "待审核",
  rejected: "已拒绝",
  archived: "已归档",
}

export type MemorySource =
  | { kind: "human"; byId: string }
  | { kind: "agent"; taskId: string; evidence: "chat" | "web" | "result" }

export interface MemoryRef {
  id: string
  content: string
  /** 适用于：「分类 · 对象」或只有分类，例如「客户偏好 · Nova Home」「公司经验」。可以输入新的 */
  appliesTo: string
  status: MemoryStatus
  source: MemorySource
  reviewerId?: string
  createdAt: string
  /** 来自网页内容、没核实过 */
  webUnverified?: boolean
}

export const memories: MemoryRef[] = [
  { id: "m-001", content: "家居类商品用 1688 以图搜同款，命中率最高，优先用", appliesTo: "公司经验", status: "active", source: { kind: "human", byId: "u-wang" }, createdAt: "2026-09-02" },
  { id: "m-002", content: "亚马逊搜索结果要按销量排序，否则前几页大多是广告", appliesTo: "公司经验", status: "active", source: { kind: "agent", taskId: "T-0950", evidence: "result" }, reviewerId: "u-wang", createdAt: "2026-09-18" },
  { id: "m-003", content: "Nova Home 只要工厂，不要贸易商；单价 3 美元以内；发美国", appliesTo: "客户偏好 · Nova Home", status: "active", source: { kind: "agent", taskId: "T-0987", evidence: "chat" }, reviewerId: "u-emily", createdAt: "2026-10-03" },
  { id: "m-004", content: "Lumi Beauty 要求外包装上不能出现中文", appliesTo: "客户偏好 · Lumi Beauty", status: "active", source: { kind: "human", byId: "u-emily" }, createdAt: "2026-08-21" },
  { id: "m-005", content: "义乌恒达质量稳定，但交期经常拖 5–7 天，下单要留余量", appliesTo: "供应商印象 · 义乌恒达", status: "active", source: { kind: "human", byId: "u-li" }, createdAt: "2026-07-30" },
  { id: "m-006", content: "深圳迅科是贸易商，报价快，但价格通常比工厂高 10%–15%", appliesTo: "供应商印象 · 深圳迅科", status: "active", source: { kind: "agent", taskId: "T-0961", evidence: "result" }, reviewerId: "u-li", createdAt: "2026-09-25" },
  { id: "m-007", content: "Kito Pets 希望从德国本地仓发货，可以接受稍高的运费", appliesTo: "客户偏好 · Kito Pets", status: "pending", source: { kind: "agent", taskId: "T-1031", evidence: "chat" }, reviewerId: "u-emily", createdAt: "2026-10-16 10:20" },
  { id: "m-008", content: "Temu 搜索要先切换到美国站，结果才和客户看到的一致", appliesTo: "公司经验", status: "pending", source: { kind: "agent", taskId: "T-1024", evidence: "result" }, reviewerId: "u-wang", createdAt: "2026-10-16 09:47" },
  { id: "m-009", content: "杭州绿叶家居是亚马逊官方认证工厂", appliesTo: "供应商印象 · 杭州绿叶", status: "pending", source: { kind: "agent", taskId: "T-1024", evidence: "web" }, reviewerId: "u-wang", createdAt: "2026-10-16 10:31", webUnverified: true },
  { id: "m-010", content: "工厂回复报价一般要第二天，催之前至少等半天", appliesTo: "公司经验", status: "active", source: { kind: "human", byId: "u-li" }, createdAt: "2026-10-08" },
]

/** 「适用于」的分类部分：「客户偏好 · Nova Home」→「客户偏好」 */
export function memoryCategory(appliesTo: string): string {
  return appliesTo.split(" · ")[0]
}

// ---------- 技能 ----------

export type SkillStatus = "published" | "draft" | "disabled"

export const skillStatusLabel: Record<SkillStatus, string> = {
  published: "已发布",
  draft: "草稿",
  disabled: "已停用",
}

export interface SkillRef {
  id: string
  name: string
  /** 规划 agent 平时只看到这一句 */
  description: string
  /** 岗位：可以输入新的 */
  dept: string
  status: SkillStatus
  ownerId: string
  toolIds: string[]
  /** agent 提的修改建议（在待办里审核） */
  suggestion?: { taskId: string; summary: string; reviewerId: string; createdAt: string }
}

export const skills: SkillRef[] = [
  { id: "sk-link-parse", name: "解析客户商品链接", description: "客户发来商品链接时使用：读出标题、主图、价格、规格，判断是哪个平台", dept: "搜品", status: "published", ownerId: "u-wang", toolIds: ["shopify.product", "browser.open", "browser.screenshot"] },
  { id: "sk-find-same", name: "多平台找同款", description: "需要找同款或货源时使用：先以图搜，再用关键词补充，记录每个平台的结果", dept: "搜品", status: "published", ownerId: "u-wang", toolIds: ["image.search", "browser.open", "browser.act"], suggestion: { taskId: "T-1024", summary: "补充一步：Temu 要先切换到美国站再搜", reviewerId: "u-wang", createdAt: "2026-10-16 09:50" } },
  { id: "sk-supplier-score", name: "供应商评估标准", description: "给候选供应商打分时使用：价格、起订量、评分、开店年限、工厂还是贸易商", dept: "搜品", status: "published", ownerId: "u-wang", toolIds: ["supplier.lookup"] },
  { id: "sk-quote-table", name: "比价表格式", description: "输出搜品结果时使用：固定字段的供应商比价表", dept: "搜品", status: "published", ownerId: "u-wang", toolIds: ["quote.save"] },
  { id: "sk-ask-specs", name: "向商家要规格", description: "需要长宽高、重量、材质时使用：一次问全，问完就挂起等回复", dept: "采购", status: "published", ownerId: "u-li", toolIds: ["browser.act", "session.wait"] },
  { id: "sk-inquiry", name: "供应商询价话术", description: "需要向供应商询价时使用：开场、必问问题、砍价要点", dept: "采购", status: "published", ownerId: "u-li", toolIds: ["browser.act", "ask.human"] },
  { id: "sk-freight", name: "运费估算", description: "需要估运费时使用：按重量、体积、目的国选择物流渠道并估价", dept: "物流", status: "draft", ownerId: "u-chen", toolIds: ["browser.open", "browser.act"] },
  { id: "sk-wa-reply", name: "WhatsApp 回复规范", description: "起草给客户的 WhatsApp 回复时使用：语气、语言、报价怎么写", dept: "AM", status: "published", ownerId: "u-emily", toolIds: ["whatsapp.send", "ask.human"] },
  { id: "sk-ask-when-unsure", name: "拿不准就问人", description: "需求不清楚、结果互相矛盾、或要做不可撤销的事时使用：先问负责人", dept: "通用", status: "published", ownerId: "u-lin", toolIds: ["ask.human"] },
]

// ---------- 检查点 ----------

export type CheckpointKind = "visit" | "message" | "count" | "artifact" | "confirm" | "note"

export const checkpointKinds: { id: CheckpointKind; name: string; example: string; done: string; autoSync?: string }[] = [
  { id: "visit", name: "访问", example: "访问了 3 个供应商", done: "记录到 N 个不同的对象", autoSync: "打开网页后自动记下网址和时间" },
  { id: "message", name: "发送消息", example: "给 2 个供应商发消息", done: "记录到 N 条已经发出的消息", autoSync: "发出的消息原文、对象、时间自动同步" },
  { id: "count", name: "数量达标", example: "工厂 ≥ 5 家", done: "agent 填上数量并附清单，达到 N" },
  { id: "artifact", name: "产出文件", example: "比价表已保存", done: "有文件或链接", autoSync: "保存后自动附上链接" },
  { id: "confirm", name: "人工确认", example: "负责人已审核", done: "指定的人点了确认" },
  { id: "note", name: "说明", example: "其他任何一句话", done: "agent 写一段说明" },
]

export const checkpointKindLabel = Object.fromEntries(checkpointKinds.map((kind) => [kind.id, kind.name])) as Record<CheckpointKind, string>

// ---------- 任务 ----------

/** 任务的一个步骤（步骤可以不写，让 agent 自己探索） */
export interface TaskStep {
  id: string
  text: string
  /** 这一步允许挂起等待（例如问商家要长宽高后等回复） */
  wait: boolean
  /** 这一步的检查点内容（勾了「检查点」才有） */
  checkpoint?: string
}

export interface TaskDef {
  id: string
  /** 一句话的任务 */
  title: string
  /** 目标：做到什么算完成 */
  goal: string
  steps: TaskStep[]
  ownerId: string
  createdAt: string
  /** 已启动：关掉就不会运行，也不会按定时运行 */
  enabled: boolean
  /** 定时运行（cron）；没有就是只跑一次 */
  schedule?: { cron: string; text: string }
  /** 预计下次运行（定时任务才有） */
  nextRunAt?: string
  modelId: string
  memoryIds: string[]
  skillIds: string[]
  toolIds: string[]
  ruleIds: string[]
}

export const tasks: TaskDef[] = [
  {
    id: "T-1024",
    title: "给 Nova Home 的硅胶折叠收纳篮找 5 家工厂",
    goal: "交出一份比价表：至少 5 家工厂（不要贸易商），单价 3 美元以内，王悦审核通过",
    steps: [
      { id: "s1", text: "解析客户给的 Shopify 链接", wait: false, checkpoint: "解析客户商品链接" },
      { id: "s2", text: "在亚马逊、Temu、1688 找同款", wait: false, checkpoint: "访问 3 个平台" },
      { id: "s3", text: "筛出符合要求的工厂", wait: false, checkpoint: "工厂 ≥ 5 家" },
      { id: "s4", text: "整理比价表，交给王悦审核", wait: true, checkpoint: "比价表已保存；负责人已审核" },
    ],
    ownerId: "u-wang",
    createdAt: "2026-10-16 09:10",
    enabled: true,
    modelId: "openrouter/anthropic/claude-sonnet-5.5",
    memoryIds: ["m-001", "m-002", "m-003"],
    skillIds: ["sk-link-parse", "sk-find-same", "sk-supplier-score", "sk-quote-table", "sk-wa-reply"],
    toolIds: ["shopify.product", "image.search", "browser.open", "browser.act", "browser.screenshot", "supplier.lookup", "quote.save", "whatsapp.send", "skill.load", "memory.propose"],
    ruleIds: ["rl-wa-confirm", "rl-captcha", "rl-checkpoint-sync", "rl-memory-review", "rl-verify"],
  },
  {
    id: "T-1035",
    title: "问两家工厂要收纳篮的长宽高、重量和报价",
    goal: "拿到义乌恒达、杭州绿叶的长宽高、毛重、500 件含税单价和交期，汇总存进 ERP",
    steps: [
      { id: "s1", text: "看一下几家工厂的 1688 店铺", wait: false, checkpoint: "访问了 3 个供应商" },
      { id: "s2", text: "给义乌恒达、杭州绿叶发消息，问长宽高、重量、单价和交期", wait: true, checkpoint: "给 2 个供应商发消息" },
      { id: "s3", text: "汇总回复", wait: false, checkpoint: "报价汇总已保存" },
    ],
    ownerId: "u-li",
    createdAt: "2026-10-16 15:05",
    enabled: true,
    modelId: "openrouter/anthropic/claude-sonnet-5.5",
    memoryIds: ["m-005", "m-010"],
    skillIds: ["sk-ask-specs", "sk-inquiry"],
    toolIds: ["browser.open", "browser.act", "quote.save", "skill.load"],
    ruleIds: ["rl-checkpoint-sync", "rl-screenshot", "rl-verify"],
  },
  {
    id: "T-1019",
    title: "给 Lumi Beauty 找化妆刷套装工厂并打样 3 套",
    goal: "选定一家工厂，下 3 套打样单；外包装不能有中文",
    steps: [],
    ownerId: "u-wang",
    createdAt: "2026-10-15 14:30",
    enabled: true,
    modelId: "openrouter/anthropic/claude-sonnet-5.5",
    memoryIds: ["m-004", "m-005"],
    skillIds: ["sk-find-same", "sk-supplier-score", "sk-quote-table", "sk-inquiry"],
    toolIds: ["image.search", "browser.open", "supplier.lookup", "quote.save", "order.place", "skill.load"],
    ruleIds: ["rl-order-approval", "rl-checkpoint-sync", "rl-verify"],
  },
  {
    id: "T-1031",
    title: "估一下 Kito Pets 自动喂食器发德国的运费",
    goal: "至少对比 3 个物流渠道，给出运费表",
    steps: [
      { id: "s1", text: "确认重量和体积（200 件，单件 1.2 kg）", wait: false, checkpoint: "确认重量和体积" },
      { id: "s2", text: "比较物流渠道", wait: false, checkpoint: "对比 3 个物流渠道" },
      { id: "s3", text: "整理运费表", wait: false, checkpoint: "运费表已保存" },
    ],
    ownerId: "u-chen",
    createdAt: "2026-10-16 10:05",
    enabled: true,
    modelId: "openrouter/anthropic/claude-haiku-5.5",
    memoryIds: ["m-007"],
    skillIds: ["sk-freight"],
    toolIds: ["browser.open", "browser.act", "skill.load"],
    ruleIds: ["rl-checkpoint-sync", "rl-verify"],
  },
  {
    id: "T-1036",
    title: "给 Kito Pets 的宠物饮水机找有 CE 认证的工厂",
    goal: "至少 5 家有 CE 认证的工厂，比价表交王悦审核",
    steps: [],
    ownerId: "u-wang",
    createdAt: "2026-10-16 16:10",
    enabled: true,
    modelId: "openrouter/anthropic/claude-sonnet-5.5",
    memoryIds: ["m-001", "m-002"],
    skillIds: ["sk-find-same", "sk-supplier-score", "sk-quote-table"],
    toolIds: ["image.search", "browser.open", "browser.act", "supplier.lookup", "quote.save", "skill.load"],
    ruleIds: ["rl-captcha", "rl-checkpoint-sync", "rl-verify", "rl-budget"],
  },
  {
    id: "T-1012",
    title: "给 Nova Home 的桌面收纳盒找工厂",
    goal: "至少 5 家工厂，单价 2 美元以内，比价表交王悦审核",
    steps: [
      { id: "s1", text: "解析链接", wait: false, checkpoint: "解析客户商品链接" },
      { id: "s2", text: "多平台找同款", wait: false, checkpoint: "访问 3 个平台" },
      { id: "s3", text: "筛工厂", wait: false, checkpoint: "工厂 ≥ 5 家" },
      { id: "s4", text: "比价表给王悦审核", wait: true, checkpoint: "比价表已保存；负责人已审核" },
    ],
    ownerId: "u-wang",
    createdAt: "2026-10-10 09:00",
    enabled: true,
    modelId: "openrouter/anthropic/claude-sonnet-5.5",
    memoryIds: ["m-001", "m-003"],
    skillIds: ["sk-link-parse", "sk-find-same", "sk-quote-table"],
    toolIds: ["shopify.product", "image.search", "browser.open", "supplier.lookup", "quote.save", "skill.load"],
    ruleIds: ["rl-checkpoint-sync", "rl-verify"],
  },
  {
    id: "T-1040",
    title: "每天看 TikTok Shop 家居类新品榜，挑适合 Nova Home 的商品",
    goal: "每天一份日报：新品榜前 20 名里挑 5 个适合 Nova Home 的，附理由",
    steps: [
      { id: "s1", text: "打开 TikTok Shop 家居类新品榜", wait: false, checkpoint: "访问 1 个榜单页面" },
      { id: "s2", text: "记录前 20 个新品", wait: false, checkpoint: "新品 ≥ 20 个" },
      { id: "s3", text: "按 Nova Home 的偏好挑 5 个", wait: false },
      { id: "s4", text: "写成日报", wait: false, checkpoint: "日报已保存" },
    ],
    ownerId: "u-wang",
    createdAt: "2026-10-01 18:00",
    enabled: true,
    schedule: { cron: "0 9 * * *", text: "每天 09:00" },
    nextRunAt: "2026-10-17 09:00",
    modelId: "openrouter/anthropic/claude-haiku-5.5",
    memoryIds: ["m-003"],
    skillIds: [],
    toolIds: ["browser.open", "browser.screenshot", "quote.save"],
    ruleIds: ["rl-captcha", "rl-checkpoint-sync", "rl-verify"],
  },
  {
    id: "T-1041",
    title: "每周一汇总上周所有询价结果",
    goal: "一份周报：上周问过的工厂、报价、交期，按商品分组",
    steps: [],
    ownerId: "u-li",
    createdAt: "2026-10-14 11:00",
    enabled: false,
    schedule: { cron: "0 10 * * 1", text: "每周一 10:00" },
    modelId: "openrouter/anthropic/claude-haiku-5.5",
    memoryIds: [],
    skillIds: ["sk-quote-table"],
    toolIds: ["supplier.lookup", "quote.save"],
    ruleIds: ["rl-verify"],
  },
]

// ---------- 运行（session） ----------

export type RunStatus = "running" | "needs_human" | "waiting" | "verifying" | "done" | "incomplete" | "failed"

export const runStatusLabel: Record<RunStatus, string> = {
  running: "执行中",
  needs_human: "等人处理",
  waiting: "等待中",
  verifying: "验收中",
  done: "已结束",
  incomplete: "没完成",
  failed: "出错",
}

export type Trigger =
  | { kind: "time"; at: string }
  | { kind: "cron"; cron: string; text: string; next: string }
  | { kind: "event"; event: string; fallbackDays: number }
  | { kind: "time_or_event"; at: string; event: string }

/** 只靠事件继续时，最多等几天；到期还没等到就提醒负责人（已定） */
export const EVENT_FALLBACK_DAYS = 7

export function triggerText(trigger: Trigger): string {
  if (trigger.kind === "time") return `到 ${trigger.at}`
  if (trigger.kind === "cron") return `${trigger.text}（cron: ${trigger.cron}），下次 ${trigger.next}`
  if (trigger.kind === "event") return `等到「${trigger.event}」（最多等 ${trigger.fallbackDays} 天，到期提醒负责人）`
  return `到 ${trigger.at}，或等到「${trigger.event}」（先到先继续）`
}

export interface RunCheckpoint {
  title: string
  kind: CheckpointKind
  target?: number
  /** 来自哪一步（agent 自己探索出来的就没有） */
  stepId?: string
  status: "done" | "open" | "skipped"
  progress?: number
  records: { at: string; text: string; synced: boolean }[]
  skipReason?: string
}

export type RunEventKind = "plan" | "think" | "tool" | "checkpoint" | "rule" | "wait" | "resume" | "human" | "verify" | "done" | "error"

/** session 里的一条记录 */
export interface RunEvent {
  at: string
  kind: RunEventKind
  title: string
  detail?: string
  toolId?: string
  /** 工具调用的输入、输出（原文） */
  input?: string
  output?: string
  ms?: number
  tokensIn?: number
  tokensOut?: number
}

export interface Verification {
  status: "passed" | "asking" | "disputed"
  at: string
  headline: string
  notes: { by: "verifier" | "executor"; text: string }[]
}

/** 一次运行 = 一个 session。要等的时候挂起，等到了继续同一个 session */
export interface SessionRun {
  id: string
  taskId: string
  startedAt: string
  endedAt?: string
  status: RunStatus
  modelId: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  /** 任务没写步骤时，agent 自己探索出来的步骤 */
  exploredSteps?: string[]
  checkpoints: RunCheckpoint[]
  events: RunEvent[]
  /** 挂起时：在等什么、什么时候继续 */
  waiting?: { what: string; trigger: Trigger; since: string }
  verification?: Verification
}

export const runs: SessionRun[] = [
  {
    id: "R-1024-1",
    taskId: "T-1024",
    startedAt: "2026-10-16 09:12",
    status: "needs_human",
    modelId: "openrouter/anthropic/claude-sonnet-5.5",
    tokensIn: 182_400,
    tokensOut: 9_400,
    costUsd: 0.46,
    checkpoints: [
      { title: "解析客户商品链接", kind: "note", stepId: "s1", status: "done", records: [{ at: "09:14", text: "硅胶折叠收纳篮 · 主图 5 张 · 售价 $12.99", synced: false }] },
      { title: "访问 3 个平台", kind: "visit", target: 3, stepId: "s2", status: "open", progress: 2, records: [
        { at: "09:31", text: "Temu 美国站 · 找到 9 款同款", synced: true },
        { at: "09:35", text: "1688 · 以图搜同款 12 家", synced: true },
      ] },
      { title: "工厂 ≥ 5 家", kind: "count", target: 5, stepId: "s3", status: "done", progress: 7, records: [{ at: "09:52", text: "7 家工厂（按记忆排除了 3 家贸易商）", synced: false }] },
      { title: "比价表已保存", kind: "artifact", stepId: "s4", status: "done", records: [{ at: "11:30", text: "比价表 · 3 家推荐工厂，最低 $2.6", synced: true }] },
      { title: "负责人已审核", kind: "confirm", stepId: "s4", status: "open", records: [] },
    ],
    events: [
      { at: "09:12", kind: "plan", title: "按任务步骤开始", detail: "4 个步骤，第 4 步允许等待", tokensIn: 6_200, tokensOut: 310 },
      { at: "09:13", kind: "tool", title: "读取技能「解析客户商品链接」", toolId: "skill.load", input: '{"id": "sk-link-parse"}', output: "全文 796 字", ms: 40, tokensIn: 7_100, tokensOut: 90 },
      { at: "09:14", kind: "tool", title: "解析 Shopify 商品", toolId: "shopify.product", input: '{"url": "https://shop.novahome.com/products/silicone-basket"}', output: '{"title": "Silicone Collapsible Basket", "price": 12.99, "images": 5}', ms: 900, tokensIn: 8_400, tokensOut: 160 },
      { at: "09:14", kind: "checkpoint", title: "勾上「解析客户商品链接」" },
      { at: "09:30", kind: "tool", title: "打开 Temu 美国站搜同款（美国 Chrome）", toolId: "browser.open", input: '{"browser": "br-us", "url": "https://www.temu.com/search?q=silicone+collapsible+basket"}', output: "9 款同款，最低 $4.99", ms: 8_400, tokensIn: 21_800, tokensOut: 640 },
      { at: "09:31", kind: "checkpoint", title: "「访问 3 个平台」1/3", detail: "由规则「同步检查点」自动记下" },
      { at: "09:35", kind: "tool", title: "1688 以图搜同款", toolId: "image.search", input: '{"image_url": "…/basket-main.jpg", "platforms": ["1688"]}', output: "12 家", ms: 2_100, tokensIn: 24_300, tokensOut: 520 },
      { at: "09:35", kind: "checkpoint", title: "「访问 3 个平台」2/3", detail: "由规则「同步检查点」自动记下" },
      { at: "09:52", kind: "tool", title: "查供应商库", toolId: "supplier.lookup", input: '{"names": ["义乌恒达", "杭州绿叶", "…"]}', output: "7 家工厂，3 家贸易商", ms: 300, tokensIn: 26_900, tokensOut: 880 },
      { at: "09:52", kind: "checkpoint", title: "勾上「工厂 ≥ 5 家」（7 家）" },
      { at: "09:58", kind: "wait", title: "挂起：亚马逊上午容易弹验证码，10:58 再试", toolId: "session.wait", input: '{"until": "2026-10-16 10:58"}', tokensIn: 27_400, tokensOut: 120 },
      { at: "10:58", kind: "resume", title: "到点，继续同一个 session" },
      { at: "11:02", kind: "tool", title: "打开亚马逊搜同款（美国 Chrome）", toolId: "browser.open", input: '{"browser": "br-us", "url": "https://www.amazon.com/s?k=silicone+collapsible+basket"}', output: "页面出现验证码", ms: 6_900, tokensIn: 29_100, tokensOut: 210 },
      { at: "11:02", kind: "rule", title: "规则「遇到验证码就停下」：截图，通知王悦", detail: "待办里多了一张「处理亚马逊验证码」" },
      { at: "11:30", kind: "tool", title: "保存比价表", toolId: "quote.save", input: '{"task": "T-1024", "rows": 3}', output: "已保存 · ERP 比价表 #8812", ms: 450, tokensIn: 30_200, tokensOut: 1_900 },
      { at: "11:30", kind: "checkpoint", title: "勾上「比价表已保存」", detail: "由规则「同步检查点」自动记下" },
      { at: "11:40", kind: "rule", title: "规则「给客户发消息前由 AM 确认」：拦下 WhatsApp 摘要，等 Emily", toolId: "whatsapp.send" },
      { at: "11:45", kind: "wait", title: "挂起：等王悦处理验证码，等 Emily 确认消息", toolId: "session.wait" },
    ],
    waiting: { what: "等王悦处理亚马逊验证码；等 Emily 确认发给客户的摘要", trigger: { kind: "event", event: "两件事都处理完", fallbackDays: 7 }, since: "2026-10-16 11:45" },
  },
  {
    id: "R-1035-1",
    taskId: "T-1035",
    startedAt: "2026-10-16 15:05",
    status: "waiting",
    modelId: "openrouter/anthropic/claude-sonnet-5.5",
    tokensIn: 64_200,
    tokensOut: 3_100,
    costUsd: 0.16,
    checkpoints: [
      { title: "访问了 3 个供应商", kind: "visit", target: 3, stepId: "s1", status: "done", progress: 3, records: [
        { at: "15:07", text: "义乌恒达日用品厂 · 1688 店铺", synced: true },
        { at: "15:08", text: "杭州绿叶家居 · 1688 店铺", synced: true },
        { at: "15:10", text: "深圳迅科电子 · 1688 店铺（对比用）", synced: true },
      ] },
      { title: "给 2 个供应商发消息", kind: "message", target: 2, stepId: "s2", status: "done", progress: 2, records: [
        { at: "15:12", text: "→ 义乌恒达：您好，硅胶折叠收纳篮麻烦发一下长宽高、毛重，500 件含税单价和交期？", synced: true },
        { at: "15:14", text: "→ 杭州绿叶：您好，想了解硅胶折叠收纳篮的长宽高和重量，以及 500 件的含税单价、交期。", synced: true },
      ] },
      { title: "报价汇总已保存", kind: "artifact", stepId: "s3", status: "open", records: [] },
    ],
    events: [
      { at: "15:05", kind: "plan", title: "按任务步骤开始", detail: "3 个步骤，第 2 步允许等待", tokensIn: 5_800, tokensOut: 280 },
      { at: "15:07", kind: "tool", title: "打开义乌恒达的 1688 店铺（国内 Chrome）", toolId: "browser.open", input: '{"browser": "br-cn", "url": "https://hengda.1688.com"}', output: "店铺首页 · 收纳类 86 款", ms: 5_200, tokensIn: 14_600, tokensOut: 300 },
      { at: "15:10", kind: "checkpoint", title: "「访问了 3 个供应商」3/3", detail: "由规则「同步检查点」自动记下" },
      { at: "15:12", kind: "tool", title: "给义乌恒达发 1688 旺旺消息", toolId: "browser.act", input: '{"browser": "br-cn", "action": "send_message", "to": "义乌恒达"}', output: "已发送", ms: 3_100, tokensIn: 31_200, tokensOut: 420 },
      { at: "15:14", kind: "tool", title: "给杭州绿叶发 1688 旺旺消息", toolId: "browser.act", input: '{"browser": "br-cn", "action": "send_message", "to": "杭州绿叶"}', output: "已发送", ms: 2_900, tokensIn: 38_400, tokensOut: 410 },
      { at: "15:14", kind: "checkpoint", title: "「给 2 个供应商发消息」2/2", detail: "消息原文由规则「同步检查点」自动记下" },
      { at: "15:20", kind: "wait", title: "挂起：工厂一般第二天才回，等回复再继续", toolId: "session.wait", input: '{"until": "2026-10-17 10:00", "or_event": "工厂在 1688 回复消息"}', tokensIn: 40_100, tokensOut: 180 },
    ],
    waiting: { what: "等义乌恒达、杭州绿叶回复长宽高、重量和报价", trigger: { kind: "time_or_event", at: "2026-10-17 10:00", event: "工厂在 1688 回复消息" }, since: "2026-10-16 15:20" },
  },
  {
    id: "R-1019-1",
    taskId: "T-1019",
    startedAt: "2026-10-15 14:30",
    status: "needs_human",
    modelId: "openrouter/anthropic/claude-sonnet-5.5",
    tokensIn: 241_000,
    tokensOut: 12_800,
    costUsd: 0.61,
    exploredSteps: ["以图搜同款（亚马逊、Temu、1688）", "筛出 6 家工厂并打分", "比价表交王悦审核（挂起等审核）", "向义乌恒达下 3 套打样单"],
    checkpoints: [
      { title: "比价表已保存", kind: "artifact", status: "done", records: [{ at: "10-15 15:35", text: "比价表 · 6 家工厂", synced: true }] },
      { title: "负责人已审核", kind: "confirm", status: "done", records: [{ at: "10-15 17:20", text: "王悦确认：选义乌恒达打样", synced: true }] },
      { title: "打样单已下", kind: "confirm", status: "open", records: [] },
    ],
    events: [
      { at: "10-15 14:30", kind: "plan", title: "任务没写步骤，agent 自己定了 4 步", detail: "以图搜同款 → 筛工厂打分 → 比价表交审核 → 下打样单", tokensIn: 6_900, tokensOut: 620 },
      { at: "10-15 15:35", kind: "tool", title: "保存比价表", toolId: "quote.save", input: '{"task": "T-1019", "rows": 6}', output: "已保存 · ERP 比价表 #8790", ms: 380, tokensIn: 98_000, tokensOut: 2_400 },
      { at: "10-15 15:40", kind: "wait", title: "挂起：等王悦审核比价表", toolId: "session.wait", input: '{"or_event": "王悦审核比价表"}' },
      { at: "10-15 17:20", kind: "resume", title: "王悦审核通过，继续同一个 session" },
      { at: "10-16 10:58", kind: "rule", title: "规则「下单前必须主管审批」：拦下 ¥168 打样单，等林舟", toolId: "order.place" },
      { at: "10-16 10:58", kind: "wait", title: "挂起：等林舟批准打样单", toolId: "session.wait" },
    ],
    waiting: { what: "等林舟批准 ¥168 的打样单", trigger: { kind: "event", event: "林舟批准打样单", fallbackDays: 7 }, since: "2026-10-16 10:58" },
  },
  {
    id: "R-1031-1",
    taskId: "T-1031",
    startedAt: "2026-10-16 10:05",
    endedAt: "2026-10-16 10:42",
    status: "needs_human",
    modelId: "openrouter/anthropic/claude-haiku-5.5",
    tokensIn: 51_000,
    tokensOut: 2_600,
    costUsd: 0.01,
    checkpoints: [
      { title: "确认重量和体积", kind: "note", stepId: "s1", status: "done", records: [{ at: "10:08", text: "5 箱，毛重 240 kg，体积 0.24 m³", synced: false }] },
      { title: "对比 3 个物流渠道", kind: "visit", target: 3, stepId: "s2", status: "skipped", progress: 2, records: [
        { at: "10:15", text: "海运拼箱 · 约 ¥3,100 · 35 天", synced: true },
        { at: "10:22", text: "空运专线 · 约 ¥9,800 · 8 天", synced: true },
      ], skipReason: "第三个渠道（德国本地仓头程）报价页一直打不开，先用两个渠道的报价" },
      { title: "运费表已保存", kind: "artifact", stepId: "s3", status: "done", records: [{ at: "10:36", text: "运费表 · 2 个渠道", synced: true }] },
    ],
    events: [
      { at: "10:05", kind: "plan", title: "按任务步骤开始", detail: "3 个步骤", tokensIn: 4_100, tokensOut: 200 },
      { at: "10:15", kind: "tool", title: "查海运拼箱报价（德国 Chrome）", toolId: "browser.open", input: '{"browser": "br-de", "url": "https://…/sea-lcl-quote"}', output: "约 ¥3,100 · 35 天", ms: 7_300, tokensIn: 18_000, tokensOut: 400 },
      { at: "10:22", kind: "tool", title: "查空运专线报价（德国 Chrome）", toolId: "browser.open", input: '{"browser": "br-de", "url": "https://…/air-quote"}', output: "约 ¥9,800 · 8 天", ms: 6_800, tokensIn: 26_000, tokensOut: 380 },
      { at: "10:30", kind: "tool", title: "查德国本地仓头程报价（德国 Chrome）", toolId: "browser.open", input: '{"browser": "br-de", "url": "https://…/de-warehouse-quote"}', output: "超时：页面打不开", ms: 30_000, tokensIn: 31_000, tokensOut: 150 },
      { at: "10:36", kind: "checkpoint", title: "跳过「对比 3 个物流渠道」", detail: "理由：德国本地仓的报价页打不开" },
      { at: "10:40", kind: "verify", title: "agent 说做完了，三方 AI（qwen3:32b）开始验收" },
      { at: "10:42", kind: "human", title: "三方 AI 不同意跳过，交给陈强决定" },
    ],
    verification: {
      status: "disputed",
      at: "2026-10-16 10:42",
      headline: "「对比 3 个物流渠道」被跳过",
      notes: [
        { by: "verifier", text: "「对比 3 个物流渠道」只记录了 2 个，为什么没做完？" },
        { by: "executor", text: "德国本地仓的报价页一直打不开，所以先用两个渠道的报价。" },
        { by: "verifier", text: "agent 刚提议过一条记忆：Kito Pets 希望从德国本地仓发货（m-007，还在待审核）。这个渠道恰恰最重要，不建议跳过。交给负责人决定。" },
      ],
    },
  },
  {
    id: "R-1036-1",
    taskId: "T-1036",
    startedAt: "2026-10-16 16:10",
    status: "running",
    modelId: "openrouter/anthropic/claude-sonnet-5.5",
    tokensIn: 38_600,
    tokensOut: 1_900,
    costUsd: 0.1,
    exploredSteps: ["以图搜同款（1688、Temu）", "只留有 CE 认证的工厂", "比价表交王悦审核"],
    checkpoints: [],
    events: [
      { at: "16:10", kind: "plan", title: "任务没写步骤，agent 自己定了 3 步", detail: "以图搜同款 → 只留有 CE 认证的工厂 → 比价表交审核", tokensIn: 5_200, tokensOut: 540 },
      { at: "16:21", kind: "tool", title: "1688 以图搜同款", toolId: "image.search", input: '{"image_url": "…/fountain-main.jpg", "platforms": ["1688"]}', output: "18 家", ms: 2_400, tokensIn: 17_300, tokensOut: 480 },
      { at: "16:29", kind: "tool", title: "打开 Temu 美国站搜同款（美国 Chrome）", toolId: "browser.open", input: '{"browser": "br-us", "url": "https://www.temu.com/search?q=pet+water+fountain"}', output: "（进行中）", tokensIn: 38_600, tokensOut: 1_900 },
    ],
  },
  {
    id: "R-1040-1016",
    taskId: "T-1040",
    startedAt: "2026-10-16 09:00",
    status: "verifying",
    modelId: "openrouter/anthropic/claude-haiku-5.5",
    tokensIn: 72_000,
    tokensOut: 4_100,
    costUsd: 0.01,
    checkpoints: [
      { title: "访问 1 个榜单页面", kind: "visit", target: 1, stepId: "s1", status: "done", progress: 1, records: [{ at: "09:02", text: "TikTok Shop · 家居类新品榜", synced: true }] },
      { title: "新品 ≥ 20 个", kind: "count", target: 20, stepId: "s2", status: "open", progress: 18, records: [{ at: "09:06", text: "记录了 18 个（第 19、20 名加载不出来）", synced: false }] },
      { title: "日报已保存", kind: "artifact", stepId: "s4", status: "done", records: [{ at: "09:12", text: "日报 · 10-16 · 推荐 5 个", synced: true }] },
    ],
    events: [
      { at: "09:00", kind: "plan", title: "定时触发（每天 09:00），按任务步骤开始", tokensIn: 3_900, tokensOut: 180 },
      { at: "09:02", kind: "tool", title: "打开 TikTok Shop 新品榜（美国 Chrome）", toolId: "browser.open", input: '{"browser": "br-us", "url": "https://shop.tiktok.com/…/new-arrivals?category=home"}', output: "榜单 · 显示 18 个", ms: 9_800, tokensIn: 28_000, tokensOut: 600 },
      { at: "09:12", kind: "tool", title: "保存日报", toolId: "quote.save", input: '{"type": "daily_report", "date": "2026-10-16"}', output: "已保存", ms: 400, tokensIn: 61_000, tokensOut: 2_900 },
      { at: "09:13", kind: "verify", title: "agent 说做完了，三方 AI 开始验收" },
      { at: "09:14", kind: "verify", title: "三方 AI 反问：新品要 ≥ 20 个，只记录了 18 个" },
    ],
    verification: {
      status: "asking",
      at: "2026-10-16 09:14",
      headline: "「新品 ≥ 20 个」只有 18 个",
      notes: [
        { by: "verifier", text: "「新品 ≥ 20 个」只记录了 18 个，第 19、20 名呢？" },
        { by: "executor", text: "（正在重新加载榜单第 2 页……）" },
      ],
    },
  },
  {
    id: "R-1040-1015",
    taskId: "T-1040",
    startedAt: "2026-10-15 09:00",
    endedAt: "2026-10-15 09:11",
    status: "done",
    modelId: "openrouter/anthropic/claude-haiku-5.5",
    tokensIn: 69_000,
    tokensOut: 3_900,
    costUsd: 0.01,
    checkpoints: [
      { title: "访问 1 个榜单页面", kind: "visit", target: 1, stepId: "s1", status: "done", progress: 1, records: [{ at: "09:02", text: "TikTok Shop · 家居类新品榜", synced: true }] },
      { title: "新品 ≥ 20 个", kind: "count", target: 20, stepId: "s2", status: "done", progress: 20, records: [{ at: "09:05", text: "记录了 20 个", synced: false }] },
      { title: "日报已保存", kind: "artifact", stepId: "s4", status: "done", records: [{ at: "09:10", text: "日报 · 10-15 · 推荐 5 个", synced: true }] },
    ],
    events: [
      { at: "09:00", kind: "plan", title: "定时触发（每天 09:00），按任务步骤开始" },
      { at: "09:11", kind: "done", title: "三方 AI 验收通过" },
    ],
    verification: { status: "passed", at: "2026-10-15 09:11", headline: "3 个检查点全部完成", notes: [{ by: "verifier", text: "3 个检查点全部完成，验收通过。" }] },
  },
  {
    id: "R-1012-1",
    taskId: "T-1012",
    startedAt: "2026-10-10 09:00",
    endedAt: "2026-10-11 14:10",
    status: "done",
    modelId: "openrouter/anthropic/claude-sonnet-5.5",
    tokensIn: 156_000,
    tokensOut: 8_200,
    costUsd: 0.39,
    checkpoints: [
      { title: "解析客户商品链接", kind: "note", stepId: "s1", status: "done", records: [{ at: "10-10 09:03", text: "桌面收纳盒 · 3 格 · 售价 $8.5", synced: false }] },
      { title: "访问 3 个平台", kind: "visit", target: 3, stepId: "s2", status: "done", progress: 3, records: [
        { at: "10-10 09:15", text: "亚马逊 · 8 款", synced: true },
        { at: "10-10 09:22", text: "Temu 美国站 · 5 款", synced: true },
        { at: "10-10 09:30", text: "1688 · 20 家", synced: true },
      ] },
      { title: "工厂 ≥ 5 家", kind: "count", target: 5, stepId: "s3", status: "done", progress: 8, records: [{ at: "10-10 09:41", text: "8 家工厂", synced: false }] },
      { title: "比价表已保存", kind: "artifact", stepId: "s4", status: "done", records: [{ at: "10-10 09:48", text: "比价表 · 4 家推荐工厂，最低 $1.7", synced: true }] },
      { title: "负责人已审核", kind: "confirm", stepId: "s4", status: "done", records: [{ at: "10-11 14:02", text: "王悦确认", synced: true }] },
    ],
    events: [
      { at: "10-10 09:00", kind: "plan", title: "按任务步骤开始" },
      { at: "10-10 09:50", kind: "wait", title: "挂起：等王悦审核比价表", toolId: "session.wait" },
      { at: "10-11 14:02", kind: "resume", title: "王悦审核通过，继续同一个 session" },
      { at: "10-11 14:10", kind: "done", title: "三方 AI 验收通过" },
    ],
    verification: { status: "passed", at: "2026-10-11 14:10", headline: "5 个检查点全部完成", notes: [{ by: "verifier", text: "5 个检查点全部完成，记录和比价表一致，验收通过。" }] },
  },
  // ---------- 更早的 session（历史）：给「Session」页和任务的运行记录用 ----------
  {
    id: "R-1040-1014",
    taskId: "T-1040",
    startedAt: "2026-10-14 09:00",
    endedAt: "2026-10-14 09:10",
    status: "done",
    modelId: "openrouter/anthropic/claude-haiku-5.5",
    tokensIn: 66_500,
    tokensOut: 3_700,
    costUsd: 0.01,
    checkpoints: [
      { title: "访问 1 个榜单页面", kind: "visit", target: 1, stepId: "s1", status: "done", progress: 1, records: [{ at: "09:02", text: "TikTok Shop · 家居类新品榜", synced: true }] },
      { title: "新品 ≥ 20 个", kind: "count", target: 20, stepId: "s2", status: "done", progress: 20, records: [{ at: "09:05", text: "记录了 20 个", synced: false }] },
      { title: "日报已保存", kind: "artifact", stepId: "s4", status: "done", records: [{ at: "09:09", text: "日报 · 10-14 · 推荐 5 个", synced: true }] },
    ],
    events: [
      { at: "09:00", kind: "plan", title: "定时触发（每天 09:00），按任务步骤开始", tokensIn: 3_800, tokensOut: 170 },
      { at: "09:02", kind: "tool", title: "打开 TikTok Shop 新品榜（美国 Chrome）", toolId: "browser.open", input: '{"browser": "br-us", "url": "https://shop.tiktok.com/…/new-arrivals?category=home"}', output: "榜单 · 显示 20 个", ms: 9_100, tokensIn: 27_400, tokensOut: 580 },
      { at: "09:09", kind: "tool", title: "保存日报", toolId: "quote.save", input: '{"type": "daily_report", "date": "2026-10-14"}', output: "已保存", ms: 380, tokensIn: 35_300, tokensOut: 2_950 },
      { at: "09:10", kind: "done", title: "三方 AI 验收通过" },
    ],
    verification: { status: "passed", at: "2026-10-14 09:10", headline: "3 个检查点全部完成", notes: [{ by: "verifier", text: "3 个检查点全部完成，验收通过。" }] },
  },
  {
    id: "R-1040-1013",
    taskId: "T-1040",
    startedAt: "2026-10-13 09:00",
    endedAt: "2026-10-13 09:31",
    status: "done",
    modelId: "openrouter/anthropic/claude-haiku-5.5",
    tokensIn: 74_800,
    tokensOut: 4_000,
    costUsd: 0.01,
    checkpoints: [
      { title: "访问 1 个榜单页面", kind: "visit", target: 1, stepId: "s1", status: "done", progress: 1, records: [{ at: "09:22", text: "TikTok Shop · 家居类新品榜", synced: true }] },
      { title: "新品 ≥ 20 个", kind: "count", target: 20, stepId: "s2", status: "done", progress: 20, records: [{ at: "09:25", text: "记录了 20 个", synced: false }] },
      { title: "日报已保存", kind: "artifact", stepId: "s4", status: "done", records: [{ at: "09:30", text: "日报 · 10-13 · 推荐 5 个", synced: true }] },
    ],
    events: [
      { at: "09:00", kind: "plan", title: "定时触发（每天 09:00），按任务步骤开始", tokensIn: 3_800, tokensOut: 170 },
      { at: "09:02", kind: "tool", title: "打开 TikTok Shop 新品榜（美国 Chrome）", toolId: "browser.open", input: '{"browser": "br-us", "url": "https://shop.tiktok.com/…/new-arrivals?category=home"}', output: "弹出滑块验证码", ms: 7_600, tokensIn: 18_200, tokensOut: 420 },
      { at: "09:03", kind: "rule", title: "规则「遇到验证码就停下」：截图，通知王悦" },
      { at: "09:03", kind: "wait", title: "挂起：等王悦在美国 Chrome 里过验证码" },
      { at: "09:21", kind: "resume", title: "王悦处理了验证码，继续同一个 session" },
      { at: "09:22", kind: "tool", title: "重新打开新品榜（美国 Chrome）", toolId: "browser.open", input: '{"browser": "br-us", "url": "https://shop.tiktok.com/…/new-arrivals?category=home"}', output: "榜单 · 显示 20 个", ms: 8_900, tokensIn: 21_600, tokensOut: 560 },
      { at: "09:30", kind: "tool", title: "保存日报", toolId: "quote.save", input: '{"type": "daily_report", "date": "2026-10-13"}', output: "已保存", ms: 410, tokensIn: 31_200, tokensOut: 2_850 },
      { at: "09:31", kind: "done", title: "三方 AI 验收通过" },
    ],
    verification: { status: "passed", at: "2026-10-13 09:31", headline: "3 个检查点全部完成", notes: [{ by: "verifier", text: "3 个检查点全部完成，验收通过。" }] },
  },
  {
    id: "R-1040-1012",
    taskId: "T-1040",
    startedAt: "2026-10-12 09:00",
    endedAt: "2026-10-12 09:07",
    status: "failed",
    modelId: "openrouter/anthropic/claude-haiku-5.5",
    tokensIn: 12_400,
    tokensOut: 600,
    costUsd: 0.0,
    checkpoints: [
      { title: "访问 1 个榜单页面", kind: "visit", target: 1, stepId: "s1", status: "done", progress: 1, records: [{ at: "09:02", text: "TikTok Shop · 家居类新品榜", synced: true }] },
      { title: "新品 ≥ 20 个", kind: "count", target: 20, stepId: "s2", status: "open", progress: 0, records: [] },
      { title: "日报已保存", kind: "artifact", stepId: "s4", status: "open", records: [] },
    ],
    events: [
      { at: "09:00", kind: "plan", title: "定时触发（每天 09:00），按任务步骤开始", tokensIn: 3_800, tokensOut: 170 },
      { at: "09:02", kind: "tool", title: "打开 TikTok Shop 新品榜（美国 Chrome）", toolId: "browser.open", input: '{"browser": "br-us", "url": "https://shop.tiktok.com/…/new-arrivals?category=home"}', output: "榜单 · 显示 20 个", ms: 9_400, tokensIn: 8_600, tokensOut: 430 },
      { at: "09:03", kind: "error", title: "调模型超时（OpenRouter），30 秒后重试" },
      { at: "09:05", kind: "error", title: "又超时两次，放弃这次运行", detail: "OpenRouter 当时整体故障。明天 09:00 照常运行，不用人管。" },
    ],
  },
  {
    id: "R-1041-1",
    taskId: "T-1041",
    startedAt: "2026-10-14 11:05",
    endedAt: "2026-10-14 11:19",
    status: "done",
    modelId: "openrouter/anthropic/claude-haiku-5.5",
    tokensIn: 41_300,
    tokensOut: 5_200,
    costUsd: 0.01,
    exploredSteps: ["从 ERP 拉出上周的询价记录", "按商品分组，合并同一家工厂的多次报价", "写成周报存进 ERP"],
    checkpoints: [
      { title: "周报已保存", kind: "artifact", status: "done", records: [{ at: "11:17", text: "周报 · 10-06～10-12 · 4 个商品 · 11 家工厂", synced: true }] },
    ],
    events: [
      { at: "11:05", kind: "plan", title: "李静点了「立即执行」；任务没写步骤，agent 自己定步骤", detail: "定了 3 步，记进这次的运行记录", tokensIn: 2_900, tokensOut: 260 },
      { at: "11:06", kind: "tool", title: "查上周的询价记录", toolId: "supplier.lookup", input: '{"since": "2026-10-06", "until": "2026-10-12", "type": "inquiry"}', output: "23 条询价 · 4 个商品 · 11 家工厂", ms: 1_200, tokensIn: 14_800, tokensOut: 900 },
      { at: "11:17", kind: "tool", title: "保存周报", toolId: "quote.save", input: '{"type": "weekly_report", "week": "2026-W41"}', output: "已保存", ms: 420, tokensIn: 23_600, tokensOut: 4_040 },
      { at: "11:17", kind: "checkpoint", title: "勾上「周报已保存」", detail: "由规则「同步检查点」自动记下" },
      { at: "11:19", kind: "done", title: "三方 AI 验收通过" },
    ],
    verification: { status: "passed", at: "2026-10-14 11:19", headline: "周报已保存，内容和 ERP 记录一致", notes: [{ by: "verifier", text: "周报里的 23 条询价和 ERP 记录一致，验收通过。" }] },
  },
]

export function runsOfTask(taskId: string): SessionRun[] {
  return runs.filter((run) => run.taskId === taskId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function latestRun(taskId: string): SessionRun | undefined {
  return runsOfTask(taskId)[0]
}

// ---------- 待办：要人办的事 ----------

export type HumanItemKind = "approval" | "verify" | "login" | "memory" | "skill"

export const humanItemKindLabel: Record<HumanItemKind, string> = {
  approval: "审批",
  verify: "验收",
  login: "登录",
  memory: "记忆审核",
  skill: "技能修改",
}

export interface HumanItem {
  id: string
  kind: HumanItemKind
  title: string
  /** 一句话：为什么到了你这里 */
  summary: string
  assigneeId: string
  taskId?: string
  runId?: string
  ruleId?: string
  createdAt: string
  /** 越小越急 */
  urgency: number
}

export const humanItems: HumanItem[] = [
  { id: "ap-02", kind: "approval", title: "批准打样单：化妆刷套装 3 套，¥168", summary: "规则「下单前必须主管审批」拦下", assigneeId: "u-lin", taskId: "T-1019", runId: "R-1019-1", ruleId: "rl-order-approval", createdAt: "2026-10-16 10:58", urgency: 0 },
  { id: "ap-01", kind: "approval", title: "确认发给 Nova Home 的 WhatsApp 摘要", summary: "规则「给客户发消息前由 AM 确认」拦下", assigneeId: "u-emily", taskId: "T-1024", runId: "R-1024-1", ruleId: "rl-wa-confirm", createdAt: "2026-10-16 11:40", urgency: 1 },
  { id: "ap-03", kind: "login", title: "处理亚马逊验证码（美国 Chrome）", summary: "规则「遇到验证码就停下」挂起了任务", assigneeId: "u-wang", taskId: "T-1024", runId: "R-1024-1", ruleId: "rl-captcha", createdAt: "2026-10-16 11:02", urgency: 2 },
  { id: "vf-1031", kind: "verify", title: "验收没通过：「对比 3 个物流渠道」被跳过", summary: "三方 AI 不同意跳过，等你决定", assigneeId: "u-chen", taskId: "T-1031", runId: "R-1031-1", ruleId: "rl-verify", createdAt: "2026-10-16 10:42", urgency: 2 },
  { id: "lg-tiktok", kind: "login", title: "TikTok Shop 登录失效（美国 Chrome）", summary: "要人重新登录一次，agent 才能继续用这个平台", assigneeId: "u-wang", createdAt: "2026-10-16 08:30", urgency: 3 },
  { id: "m-008", kind: "memory", title: "Temu 搜索要先切换到美国站，结果才和客户看到的一致", summary: "agent 提议记住（公司经验）", assigneeId: "u-wang", taskId: "T-1024", runId: "R-1024-1", ruleId: "rl-memory-review", createdAt: "2026-10-16 09:47", urgency: 4 },
  { id: "m-009", kind: "memory", title: "杭州绿叶家居是亚马逊官方认证工厂", summary: "agent 提议记住（来自网页，没核实）", assigneeId: "u-wang", taskId: "T-1024", runId: "R-1024-1", ruleId: "rl-memory-review", createdAt: "2026-10-16 10:31", urgency: 4 },
  { id: "m-007", kind: "memory", title: "Kito Pets 希望从德国本地仓发货，可以接受稍高的运费", summary: "agent 提议记住（客户偏好）", assigneeId: "u-emily", taskId: "T-1031", runId: "R-1031-1", ruleId: "rl-memory-review", createdAt: "2026-10-16 10:20", urgency: 4 },
  { id: "sk-find-same", kind: "skill", title: "多平台找同款：补充一步，Temu 要先切换到美国站", summary: "agent 提议修改技能", assigneeId: "u-wang", taskId: "T-1024", runId: "R-1024-1", createdAt: "2026-10-16 09:50", urgency: 4 },
]

// ---------- 待办：人加的提醒 ----------

/** 人往待办里插的一条：到点（可以是 cron）或等到事件，就让 agent 去做；有挂起的 session 就继续它 */
export interface HumanTodo {
  id: string
  taskId: string
  title: string
  trigger: Trigger
  createdById: string
  createdAt: string
}

export const humanTodos: HumanTodo[] = [
  { id: "td-05", taskId: "T-1024", title: "周五 18:00 前把比价结果发给 Nova Home", trigger: { kind: "time", at: "2026-10-16 18:00" }, createdById: "u-emily", createdAt: "2026-10-16 12:10" },
  { id: "td-08", taskId: "T-1035", title: "每个工作日 10:00 看一眼有没有新报价", trigger: { kind: "cron", cron: "0 10 * * 1-5", text: "每个工作日 10:00", next: "2026-10-19 10:00" }, createdById: "u-li", createdAt: "2026-10-16 15:30" },
]

// ---------- 待办看板 ----------

export type BoardColumn = "running" | "needs_human" | "waiting" | "verifying" | "done"

export const boardColumns: { id: BoardColumn; name: string; hint: string }[] = [
  { id: "running", name: "执行中", hint: "session 正在跑" },
  { id: "needs_human", name: "等人处理", hint: "要你拍板或动手" },
  { id: "waiting", name: "等待中", hint: "session 已挂起，等到了就继续" },
  { id: "verifying", name: "验收中", hint: "三方 AI 在核对检查点" },
  { id: "done", name: "已结束", hint: "最近结束的运行，卡上写结果" },
]

export type BoardCard =
  | { kind: "run"; id: string; column: BoardColumn; run: SessionRun; task: TaskDef }
  | { kind: "human"; id: string; column: "needs_human"; item: HumanItem }
  | { kind: "todo"; id: string; column: "waiting"; todo: HumanTodo }

/** 看板上的所有卡片：主管看全部，员工只看自己负责的任务和分给自己的事 */
/** 看板上的全部卡片。已定：员工也能看全部（只读），能不能操作由页面按负责人判断 */
export function boardCards(): BoardCard[] {
  const cards: BoardCard[] = []
  for (const run of runs) {
    const task = findById(tasks, run.taskId)
    if (!task) continue
    // 等人处理的运行，由下面「要人办的事」的卡片代表，不重复放
    if (run.status === "needs_human" || run.status === "failed" || run.status === "incomplete") continue
    // 已结束的只放每个任务最近一次，更早的历史在「Session」页
    if (run.status === "done" && runs.some((other) => other.taskId === run.taskId && other.status === "done" && other.startedAt > run.startedAt)) continue
    cards.push({ kind: "run", id: run.id, column: run.status, run, task })
  }
  for (const item of humanItems) cards.push({ kind: "human", id: item.id, column: "needs_human", item })
  for (const todo of humanTodos) cards.push({ kind: "todo", id: todo.id, column: "waiting", todo })
  return cards
}

/** 侧边栏「待办」上的数字：等我处理的事 */
export function needsMeCount(userId: string, isAdmin: boolean): number {
  return humanItems.filter((item) => isAdmin || item.assigneeId === userId).length
}

// ---------- agent 循环 ----------

export type LoopStage = "task_start" | "model" | "pre_tool" | "tool" | "post_tool" | "task_end"

export const loopStages: { id: LoopStage; name: string; description: string }[] = [
  { id: "task_start", name: "运行开始", description: "读入选中的记忆和技能目录" },
  { id: "model", name: "调模型", description: "模型决定下一步做什么" },
  { id: "pre_tool", name: "调工具前", description: "选中的规则检查：放行、拦截或等人" },
  { id: "tool", name: "执行工具", description: "打开网页、搜同款、查供应商库……" },
  { id: "post_tool", name: "调工具后", description: "同步检查点、截图；要等就挂起" },
  { id: "task_end", name: "说做完了", description: "三方 AI 验收检查点" },
]

// ---------- 查询助手 ----------

export function findById<T extends { id: string }>(list: T[], id: string | null | undefined): T | undefined {
  return id ? list.find((item) => item.id === id) : undefined
}

export function staffName(id: string | undefined): string {
  return findById(staff, id)?.name ?? "—"
}

export function toolName(id: string): string {
  return findById(tools, id)?.name ?? id
}

/** 哪些任务选用了这条规则 / 这个工具 / 这条记忆 / 这个技能 */
export function tasksUsing(field: "ruleIds" | "toolIds" | "memoryIds" | "skillIds", id: string): TaskDef[] {
  if (field === "toolIds" && ALWAYS_ON_TOOL_IDS.includes(id)) return tasks
  return tasks.filter((task) => task[field].includes(id))
}

/** 这个任务能用的全部工具：自带的 + 建任务时选的 */
export function toolIdsOfTask(task: TaskDef): string[] {
  return [...ALWAYS_ON_TOOL_IDS, ...task.toolIds.filter((id) => !ALWAYS_ON_TOOL_IDS.includes(id))]
}
