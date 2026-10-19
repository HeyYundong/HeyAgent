// 演示数据，M4 换成真实数据。「看懂架构」页的讲解内容（v3），从原型 pages/learn/data.ts 复制；名称和 id 来自 ./prototype（原型的演示数据）。
import {
  allModels,
  EVENT_FALLBACK_DAYS,
  findById,
  humanItemKindLabel,
  runs,
  staffName,
  triggerText,
  type BoardCard,
  type BoardColumn,
  type BrowserProfile,
  type LoopStage,
  type ModelInfo,
} from "./prototype"

// ---------- 左边列表（id 固定，各页「这是什么？」会链接过来）----------

export type LessonId =
  | "loop"
  | "task"
  | "checkpoint"
  | "todo"
  | "memory"
  | "skills"
  | "rules"
  | "tools"
  | "browsers"
  | "models"
  | "flow"

export const lessonGroups: { label: string; items: { id: LessonId; title: string; hint: string }[] }[] = [
  {
    label: "先看这个",
    items: [{ id: "loop", title: "一个 agent 怎么干活", hint: "每次运行都跑同一个循环" }],
  },
  {
    label: "任务怎么跑",
    items: [
      { id: "task", title: "任务和 session：挂起后接着跑", hint: "等的时候挂起，等到了继续同一个 session" },
      { id: "checkpoint", title: "步骤、检查点和三方验收", hint: "建任务时怎么写，最后谁来核对" },
      { id: "todo", title: "待办看板：每次运行一张卡", hint: "卡片怎么在五列之间移动" },
    ],
  },
  {
    label: "建任务时选的东西",
    items: [
      { id: "memory", title: "记忆：选了哪几条就读哪几条", hint: "选一个任务，看运行开始时读到什么" },
      { id: "skills", title: "技能：只看目录，用到才读全文", hint: "选一个情况，看 agent 翻开哪本手册" },
      { id: "rules", title: "规则：选上的才管用", hint: "选一个情况，看哪条规则命中" },
      { id: "tools", title: "工具：三种来源，模型只看说明书", hint: "MCP、HTTP 接口、内置" },
    ],
  },
  {
    label: "背后的环境",
    items: [
      { id: "browsers", title: "浏览器：多个 Chrome，共用登录态", hint: "agent 自己选用哪个 Chrome" },
      { id: "models", title: "模型：执行和验收用不同家", hint: "Ollama、OpenRouter" },
    ],
  },
  {
    label: "串起来看",
    items: [{ id: "flow", title: "一次搜品任务的完整过程", hint: "动画：从客户发链接到发出报价" }],
  },
]

export const LESSON_IDS: LessonId[] = lessonGroups.flatMap((group) => group.items.map((item) => item.id))

/** 旧 id 兼容（v2 的规则页链接到 hooks） */
export const LESSON_ALIASES: Record<string, LessonId> = { hooks: "rules" }

/** 演示里一行的语气，决定图标和样式 */
export type StepTone = "pass" | "block" | "wait" | "log" | "skip" | "run"

// ---------- loop：几样东西在循环的哪一步起作用 ----------

export interface LoopPart {
  id: "memory" | "skills" | "rules" | "tools" | "wait"
  name: string
  /** 细看哪一条 */
  lesson: LessonId
  what: string
  stages: LoopStage[]
  notes: Partial<Record<LoopStage, string>>
}

export const loopParts: LoopPart[] = [
  {
    id: "memory",
    name: "记忆",
    lesson: "memory",
    what: "记忆管「是什么」：客户偏好、供应商印象、公司经验。建任务时选几条，运行一开始读入；agent 学到新东西只能提议，人审核后才能被选用。",
    stages: ["task_start", "post_tool"],
    notes: {
      task_start: "读入建任务时选的那几条记忆",
      post_tool: "调「提议记忆」，进待办等人审核",
    },
  },
  {
    id: "skills",
    name: "技能",
    lesson: "skills",
    what: "技能管「怎么做」：一本本操作手册。运行开始时只看选中技能的目录，用得上再读全文，可以按情况调整。",
    stages: ["task_start", "model"],
    notes: {
      task_start: "只读选中技能的目录：书名 + 一句话",
      model: "用得上时，再调「读取技能」读全文",
    },
  },
  {
    id: "rules",
    name: "规则",
    lesson: "rules",
    what: "规则管「必须遵守的事」：没有全局开关，建任务时选上哪几条，这次运行就受哪几条管。命中了由代码执行，模型绕不过。",
    stages: ["pre_tool", "post_tool", "task_end"],
    notes: {
      pre_tool: "发消息要 AM 确认、下单要主管批",
      post_tool: "同步检查点、截图；看到验证码就停",
      task_end: "「三方 AI 验收」逐条核对检查点",
    },
  },
  {
    id: "tools",
    name: "工具",
    lesson: "tools",
    what: "工具管「能做什么」：打开网页、以图搜同款、发 WhatsApp……来自 MCP、HTTP 接口或系统内置。建任务时选用哪些，模型就只看得到哪些。",
    stages: ["model", "tool"],
    notes: {
      model: "模型读选中工具的说明书，决定用哪个",
      tool: "工具真正干活，结果交回模型",
    },
  },
  {
    id: "wait",
    name: "挂起",
    lesson: "task",
    what: "要等商家回复、等人审批时，agent 调「挂起等待」，写下在等什么。session 不占模型也不花钱，等到了从原地继续，还是同一个 session。",
    stages: ["post_tool", "model"],
    notes: {
      post_tool: "调「挂起等待」：记下在等什么，session 挂起",
      model: "等到了，继续同一个 session，接着调模型",
    },
  },
]

// ---------- task：选哪几个任务来讲 ----------

export const sessionTaskIds = ["T-1024", "T-1035", "T-1040"]

// ---------- checkpoint：选哪几个任务来讲 ----------

export const checkpointTaskIds = ["T-1035", "T-1031", "T-1019"]

// ---------- todo：每一列讲什么 ----------

export const columnLessons: Record<BoardColumn, { comes: string; goes: string }> = {
  running: {
    comes: "任务启动、定时到点，或者挂起的 session 等到了，卡片进这一列。",
    goes: "要等就挂起，移到「等待中」；规则拦下要人办的事，就移到「等人处理」；agent 说做完了，移到「验收中」。",
  },
  needs_human: {
    comes: "每件要人办的事单独一张卡：审批、验收没过、登录或验证码、记忆审核、技能修改。侧边栏「待办」上的数字，就是这一列里分给你的卡。",
    goes: "你办完，卡片消失；被它挡住的 session 继续跑，还是同一个 session。",
  },
  waiting: {
    comes: "session 已挂起。卡上写清楚在等什么、什么时候继续。人加的待办也放在这一列。",
    goes: `等到回复或到点，卡片移回「执行中」，继续原来的 session，不会新开一个。只等事件的最多等 ${EVENT_FALLBACK_DAYS} 天，到期提醒负责人。`,
  },
  verifying: {
    comes: "agent 说做完了。另一家的模型逐条核对检查点，没做完的反问执行 agent。",
    goes: "核对通过移到「已完成」；说不清的，「等人处理」里多一张验收卡。",
  },
  done: {
    comes: "验收通过的运行。定时任务每触发一次是新的一次运行，所以每天都会多一张卡。",
    goes: "不再移动。完整过程在「会话」页能看到（任务详情头部点「会话」）。",
  },
}

// ---------- memory：选哪几个任务来讲 ----------

export const memoryTaskIds = ["T-1024", "T-1035", "T-1031"]

// ---------- skills：T-1024 里常见的情况 → 翻开哪本手册 ----------

export const skillTaskId = "T-1024"

export const skillScenarios = [
  { id: "link", label: "客户发来链接", situation: "Nova Home 发来一个 Shopify 商品链接", skillId: "sk-link-parse" },
  { id: "search", label: "要找货源", situation: "要去 Temu、1688 等平台找同款", skillId: "sk-find-same" },
  { id: "score", label: "要挑工厂", situation: "找到 10 家候选，要挑出靠谱的工厂", skillId: "sk-supplier-score" },
  { id: "reply", label: "要回客户", situation: "比价表做好了，要给客户发一条摘要", skillId: "sk-wa-reply" },
]

/** 每本手册全文大约多少字 */
export const skillFullChars: Record<string, number> = {
  "sk-link-parse": 796,
  "sk-find-same": 556,
  "sk-supplier-score": 610,
  "sk-quote-table": 381,
  "sk-wa-reply": 448,
}

// ---------- rules：一个情况，任务选了哪些规则，哪条命中 ----------

export interface RuleScenario {
  id: string
  label: string
  taskId: string
  /** 发生了什么 */
  call: string
  /** 命中的规则 → 这次具体怎么做 */
  hits: Record<string, string>
  result: string
  /** 待办里对应的那张卡 */
  todoId?: string
  /** 本来能管这件事、但建任务时没选的规则 */
  missing?: string
}

export const ruleScenarios: RuleScenario[] = [
  {
    id: "wa",
    label: "给客户发 WhatsApp",
    taskId: "T-1024",
    call: "agent 要把比价摘要用 WhatsApp 发给 Nova Home",
    hits: { "rl-wa-confirm": "消息先不发，把原文交给 Emily 批准" },
    result: "待办「等人处理」多一张卡给 Emily，session 挂起。Emily 批准后消息才发出，继续同一个 session。",
    todoId: "ap-01",
  },
  {
    id: "order",
    label: "下 ¥168 打样单",
    taskId: "T-1019",
    call: "agent 要在 1688 向义乌恒达下 3 套打样单，¥168",
    hits: { "rl-order-approval": "拦下，交给运营主管林舟审批" },
    result: "林舟在待办里批准之前，钱不会花出去。",
    todoId: "ap-02",
  },
  {
    id: "captcha",
    label: "亚马逊弹验证码",
    taskId: "T-1024",
    call: "agent 打开亚马逊搜同款，页面是一个验证码",
    hits: {
      "rl-captcha": "截图，挂起，通知王悦去「浏览器」里处理",
      "rl-checkpoint-sync": "没读到内容，不算一次访问，不记进检查点",
    },
    result: "agent 不会自己乱点验证码。王悦处理完，session 从这一步继续。",
    todoId: "ap-03",
  },
  {
    id: "unknown",
    label: "打开陌生网站",
    taskId: "T-1024",
    call: "agent 在商品页里看到一个链接，想打开 alibaba-deals.shop",
    hits: {},
    missing: "rl-whitelist",
    result: "T-1024 建任务时没选「只访问白名单网站」，所以没有规则拦，网页照常打开。想管住，就在建任务时把这条选上。",
  },
]

// ---------- tools：三种来源各举一个 ----------

export interface ToolLesson {
  source: "mcp" | "http" | "builtin"
  toolId: string
  /** 模型看到的说明书（name / description / input_schema），排版成短 JSON */
  manual: string
}

export const toolLessons: ToolLesson[] = [
  {
    source: "mcp",
    toolId: "browser.open",
    manual: `{
  "name": "browser.open",
  "description": "在所选 Chrome 里打开一个网址，读取页面内容。登录状态已经带上，你拿不到账号密码。",
  "input_schema": {
    "browser": "用哪个 Chrome，按说明自己选",
    "url": "要打开的网址"
  }
}`,
  },
  {
    source: "http",
    toolId: "whatsapp.send",
    manual: `{
  "name": "whatsapp.send",
  "description": "给客户发 WhatsApp 消息（官方 Business 接口）。用客户的语言写。",
  "input_schema": {
    "to": "客户的 WhatsApp 号码",
    "text": "消息正文"
  }
}`,
  },
  {
    source: "builtin",
    toolId: "session.wait",
    manual: `{
  "name": "session.wait",
  "description": "记下在等什么，挂起当前 session。等到回复或到点后，系统继续同一个 session，你从这里接着做。",
  "input_schema": {
    "what": "在等什么，一句话",
    "until": "最晚等到什么时候（可选）",
    "or_event": "等哪件事发生（可选）"
  }
}`,
  },
]

// ---------- browsers：一件事 → agent 选哪个 Chrome ----------

export const browserScenarios = [
  { id: "us", label: "搜亚马逊美国站", situation: "要在亚马逊美国站搜同款", browserId: "br-us", url: "www.amazon.com", platformId: "amazon" },
  { id: "cn", label: "看 1688 店铺", situation: "要看义乌恒达的 1688 店铺", browserId: "br-cn", url: "hengda.1688.com", platformId: "1688" },
  { id: "de", label: "查德国运费", situation: "要查发德国的物流报价", browserId: "br-de", url: "…/sea-lcl-quote", platformId: undefined },
]

// ---------- models：三个角色 ----------

export type ModelRole = "plan" | "run" | "verify"

export const modelRoles: { id: ModelRole; label: string; what: string }[] = [
  { id: "plan", label: "规划", what: "保存规则时把那句话翻译成程序能执行的结构；长对话压缩上下文时给工具输出写摘要。" },
  { id: "run", label: "执行", what: "按步骤调工具干活，任务没写步骤时也由它自己探索步骤，token 用得最多。每个任务可以单独选，不选就用默认。" },
  { id: "verify", label: "三方验收", what: "agent 说做完时，逐条核对检查点。不许和执行用同一家的模型：模型页保存不了，新建任务也会拦。" },
]

// ---------- 讲解文案：从共享数据拼出演示里的一句话 ----------

/** 卡片上的一句状态说明，和待办页一致 */
export function cardLine(card: BoardCard): { title: string; text: string; badge: string } {
  if (card.kind === "human") {
    const { item } = card
    return { title: item.title, text: `${item.summary} · 分给 ${staffName(item.assigneeId)}`, badge: humanItemKindLabel[item.kind] }
  }
  if (card.kind === "todo") return { title: card.todo.title, text: triggerText(card.todo.trigger), badge: "人加的" }
  const { run } = card
  const status = {
    running: `正在：${run.events.at(-1)?.title}`,
    waiting: `在等：${run.waiting?.what} · 什么时候继续：${run.waiting ? triggerText(run.waiting.trigger) : "—"}`,
    verifying: run.verification?.headline ?? "三方 AI 在核对",
    done: `${run.endedAt} 完成 · 验收通过`,
  }[card.column as "running" | "waiting" | "verifying" | "done"]
  return { title: card.task.title, text: `${run.id} · ${status}`, badge: "运行" }
}

export function proxyText(profile: BrowserProfile) {
  if (profile.proxy.kind === "none") return `不用代理，出口：${profile.exitIp}`
  const user = profile.proxy.username ? `（用户 ${profile.proxy.username}）` : ""
  return `SOCKS5 ${profile.proxy.host}:${profile.proxy.port}${user}，出口：${profile.exitIp}`
}

export const price = (model: ModelInfo) =>
  model.priceIn === 0 ? "本地运行，免费" : `每百万 token：输入 $${model.priceIn}，输出 $${model.priceOut}`

/** 每个角色举一个真实的例子 */
export function modelExample(role: ModelRole): { title: string; text: string } {
  if (role === "plan") {
    const steps = findById(runs, "R-1019-1")?.exploredSteps ?? []
    return { title: `T-1019 没写步骤，规划出 ${steps.length} 步`, text: steps.join(" → ") }
  }
  if (role === "run") {
    const run = findById(runs, "R-1024-1")!
    const model = findById(allModels, run.modelId)!
    const k = (n: number) => `${(n / 1000).toFixed(1)}k`
    return {
      title: `${run.id} 花了 $${run.costUsd.toFixed(2)}`,
      text: `输入 ${k(run.tokensIn)} × $${model.priceIn} + 输出 ${k(run.tokensOut)} × $${model.priceOut}（每百万 token）`,
    }
  }
  const run = findById(runs, "R-1031-1")!
  return { title: `${run.id}：${run.verification?.headline}`, text: run.verification?.notes.at(-1)?.text ?? "" }
}

// ---------- 「一次完整的任务」（lesson-flow）：讲的是种子数据里的搜品示例 ----------

export const flowLesson = {
  title: "一次搜品任务的完整过程",
  meta: "任务 T-1024：Nova Home 发来一个收纳篮链接，要找 5 家工厂。动画把前面讲的记忆、技能、规则、工具串起来走一遍，约 45 秒一轮。",
  points: {
    flexible: "Temu 搜出来的结果不对，agent 自己切到美国站重搜，还提议把这件事记下来。",
    rules: "T-1024 建任务时选了「遇到验证码就停下」「给客户发消息前由 AM 确认」：亚马逊出现验证码就停，发给客户的消息必须等 Emily 确认。模型绕不过。",
    suspend: "亚马逊弹验证码时暂停，王悦处理完从原地恢复；Emily 确认后消息才发出。这就是挂起后继续同一个 session。",
  },
}
