// 中文标签和固定的说明文字：从原型 mock/shared.ts 和各页面 data.ts 原样搬过来。
import type {
  AccountStatus,
  CheckpointKind,
  HumanItemKind,
  MemoryEvidence,
  MemoryStatus,
  ModelProviderKind,
  ModelRole,
  ProviderStatus,
  Risk,
  RunOutcome,
  RunOutcomeBy,
  RunStatus,
  SkillStatus,
  ToolSource,
} from "./schemas.js"

export const accountStatusLabel: Record<AccountStatus, string> = {
  ok: "已登录",
  expired: "登录失效",
  captcha: "需要验证码",
}

export const toolSourceLabel: Record<ToolSource, string> = {
  builtin: "内置",
  mcp: "MCP",
  http: "HTTP 接口",
}

export const riskLabel: Record<Risk, string> = {
  read: "只读",
  write: "写入内部数据",
  external: "对外发送",
  money: "涉及金钱",
}

/**
 * 风险说明（原型 tools/data.ts 的 RISK_NOTES）。
 * 平台通用：这里不点名具体规则。哪些规则管着某个工具，M3 起由规则「翻译后的触发条件」按数据算出来。
 */
export const riskNotes: Record<Risk, { text: string }> = {
  read: { text: "只读取数据，不会改动任何东西。" },
  write: { text: "会写入公司内部的数据（ERP、待办、检查点等），出错可以改回来。" },
  external: { text: "会发给公司外面的人，发出去就收不回。建任务时最好同时选上一条「调用前要人确认」的规则。" },
  money: { text: "会直接花公司的钱。建任务时最好同时选上一条「调用前要主管审批」的规则。" },
}

export const memoryStatusLabel: Record<MemoryStatus, string> = {
  active: "生效",
  pending: "待审核",
  rejected: "已拒绝",
  archived: "已归档",
}

/** agent 根据什么提议的（原型 memory/data.ts） */
export const evidenceLabel: Record<MemoryEvidence, string> = { chat: "聊天记录", web: "网页内容", result: "任务结果" }

export const skillStatusLabel: Record<SkillStatus, string> = {
  published: "已发布",
  draft: "草稿",
  disabled: "已停用",
}

export const checkpointKinds: { id: CheckpointKind; name: string; example: string; done: string; autoSync?: string }[] = [
  { id: "visit", name: "访问", example: "访问了 3 个网站", done: "记录到 N 个不同的对象", autoSync: "打开网页后自动记下网址和时间" },
  { id: "message", name: "发送消息", example: "给 2 个联系人发消息", done: "记录到 N 条已经发出的消息", autoSync: "发出的消息原文、对象、时间自动同步" },
  { id: "count", name: "数量达标", example: "工厂 ≥ 5 家", done: "agent 填上数量并附清单，达到 N" },
  { id: "artifact", name: "产出文件", example: "汇总表已保存", done: "有文件或链接", autoSync: "保存后自动附上链接" },
  { id: "confirm", name: "人工确认", example: "负责人已审核", done: "指定的人点了确认" },
  { id: "note", name: "说明", example: "其他任何一句话", done: "agent 写一段说明" },
]

export const checkpointKindLabel = Object.fromEntries(checkpointKinds.map((kind) => [kind.id, kind.name])) as Record<CheckpointKind, string>

export const runStatusLabel: Record<RunStatus, string> = {
  running: "执行中",
  needs_human: "等人处理",
  waiting: "等待中",
  verifying: "验收中",
  done: "已结束",
  incomplete: "没完成",
  failed: "出错",
}

/** 运行 / 派活单的结果（run-outcome） */
export const runOutcomeLabel: Record<RunOutcome, string> = {
  achieved: "办成",
  partial: "部分办成",
  not_achieved: "没办成",
  unverified: "没核实",
}

/** 结果是谁定的 */
export const runOutcomeByLabel: Record<RunOutcomeBy, string> = {
  agent: "agent 自己报的",
  rule: "规则",
  review: "AI 复核",
  verify: "三方验收",
  human: "人改的",
}

export const humanItemKindLabel: Record<HumanItemKind, string> = {
  approval: "审批",
  verify: "验收",
  login: "登录",
  memory: "记忆审核",
  skill: "技能修改",
}

export type BoardColumn = "running" | "needs_human" | "waiting" | "verifying" | "done"

export const boardColumns: { id: BoardColumn; name: string; hint: string }[] = [
  { id: "running", name: "执行中", hint: "session 正在跑" },
  { id: "needs_human", name: "等人处理", hint: "要你拍板或动手" },
  { id: "waiting", name: "等待中", hint: "session 已挂起，等到了就继续" },
  { id: "verifying", name: "验收中", hint: "三方 AI 在核对检查点" },
  { id: "done", name: "已完成", hint: "最近完成的运行" },
]

export type LoopStage = "task_start" | "model" | "pre_tool" | "tool" | "post_tool" | "task_end"

export const loopStages: { id: LoopStage; name: string; description: string }[] = [
  { id: "task_start", name: "运行开始", description: "读入选中的记忆和技能目录" },
  { id: "model", name: "调模型", description: "模型决定下一步做什么" },
  { id: "pre_tool", name: "调工具前", description: "选中的规则检查：放行、拦截或等人" },
  { id: "tool", name: "执行工具", description: "打开网页、调接口、查资料库……" },
  { id: "post_tool", name: "调工具后", description: "同步检查点、截图；要等就挂起" },
  { id: "task_end", name: "说做完了", description: "三方 AI 验收检查点" },
]

/** 模型服务类型（原型 models/data.ts 的 KIND_LABEL） */
export const providerKindLabel: Record<ModelProviderKind, string> = { ollama: "Ollama", openrouter: "OpenRouter", anthropic: "Claude", openai: "OpenAI", deepseek: "DeepSeek" }

/** 新增：模型服务状态。原型只有正常 / 连不上 */
export const providerStatusLabel: Record<ProviderStatus, string> = { ok: "正常", error: "连不上", unconfigured: "未配置" }

/** 各角色的默认模型（原型 models/data.ts 的 ROLES） */
/** 必须配的三个聊天模型角色；图库的 embedding 模型（embed）、助手（assistant，可选）、复核（review，可选）单独选，见模型页「默认设置」 */
export const modelRoles: { id: Exclude<ModelRole, "embed" | "assistant" | "review">; label: string; hint: string }[] = [
  { id: "run", label: "执行任务", hint: "每一步干活、调工具都用它，任务没写步骤时也由它自己探索步骤，花费主要在这里。" },
  { id: "plan", label: "规划", hint: "保存规则时把那句话翻译成程序能执行的结构；长对话压缩上下文时写摘要。" },
  { id: "verify", label: "三方验收", hint: "检查执行 agent 是不是真的做完了检查点。" },
]

/** 只靠事件继续时，最多等几天；到期还没等到就提醒负责人（已定） */
export const EVENT_FALLBACK_DAYS = 7
