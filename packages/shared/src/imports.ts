// 导入（2026-10-18）：别的 agent 打的 zip 包 → AI 读包、整理成「导入方案」→ 主管一步步确认 → 一次建好。
// 前后端共用这一份：导入记录、导入方案、导入结果、导入后还要人做的事、接口输入。
// 设计稿：design/BRIEF-import.md（本地）；开发说明：docs/dev/imports.md。
//
// 方案里的每一项都有一个 key（方案内唯一，例如 t1、s2、m3、r1、x4），项与项之间用 key 引用；
// 导入（imports.commit）时按 key 建出真正的任务、技能、记忆、规则、工具，再把 key 换成真正的 id。
import { z } from "zod"

import { domainSchema } from "./browser-runtime.js"
import { taskDispatchParamSchema, taskDispatchResultSchema } from "./dispatch.js"
import { secretNameSchema } from "./config.js"
import { ruleCompileResultSchema } from "./rules.js"
import { httpMethodSchema, isoTime, riskSchema, skillStatusSchema } from "./schemas.js"

// ---------- 上限 ----------

/** zip 包最大多少 MB（服务端可以用 HEYAGENT_IMPORT_MAX_MB 改） */
export const IMPORT_MAX_MB = 200
/** 包里最多多少个文件 */
export const IMPORT_MAX_FILES = 50_000
/** 解压后一共最多多少 MB（挡压缩炸弹） */
export const IMPORT_MAX_UNPACKED_MB = 1024

// ---------- 状态、步骤 ----------

/** reading 读包中 → review 待确认 → imported 已导入（→ undone 已撤销）；读包出错或被停止是 failed */
export const importStatusSchema = z.enum(["reading", "review", "imported", "failed", "undone"])
export type ImportStatus = z.infer<typeof importStatusSchema>

/** 确认向导的步骤（没有内容的步骤页面上跳过） */
export const importStepSchema = z.enum(["overview", "tasks", "skills", "memories", "rules", "tools", "confirm"])
export type ImportStep = z.infer<typeof importStepSchema>

/** 读包过程的一行：解压、找明文密钥、读某个文件、对照现有配置、翻译规则、整理方案 */
export const importReadStepSchema = z.object({
  title: z.string(),
  status: z.enum(["done", "running", "error"]),
  /** 这一步用了多久（毫秒） */
  ms: z.number().int().nonnegative().optional(),
})
export type ImportReadStep = z.infer<typeof importReadStepSchema>

// ---------- 导入方案 ----------

const key = z.string().min(1).max(40)
/** 来自包里哪个文件、第几行，给人对照，例如「memory/notes.md 第 12 行」 */
const source = z.string().max(500)

export const diffLineSchema = z.object({
  variant: z.enum(["default", "added", "removed"]),
  text: z.string(),
})

export const planTaskStepSchema = z.object({
  text: z.string().max(500),
  /** 这一步可以挂起等待 */
  wait: z.boolean(),
  /** 检查点：做到什么算数；这一步没有检查点就不写 */
  checkpoint: z.string().max(500).optional(),
})
export type PlanTaskStep = z.infer<typeof planTaskStepSchema>

/** 要登录的网站：所选 Chrome 里还没有这个平台的账号时（missing），导入后提醒去「浏览器」页登录 */
export const planLoginSchema = z.object({
  /** 平台（platforms.id）；这个域名还没有对应的平台时为 null */
  platformId: z.string().nullable(),
  name: z.string().max(100),
  domain: z.string().max(200),
  missing: z.boolean(),
})

export const planTaskSchema = z.object({
  key,
  include: z.boolean(),
  /** 导入后启用（按定时跑）；不写 = true。包里写了默认关闭自动执行的，AI 设 false，导入时建成停用的任务（2026-10-18 加） */
  enabled: z.boolean().optional(),
  title: z.string().max(200),
  goal: z.string().max(1000),
  steps: z.array(planTaskStepSchema).max(50),
  /** 定时运行；null = 只在点「立即运行」时跑 */
  schedule: z.object({ cron: z.string().max(100), text: z.string().max(100) }).nullable(),
  /** 负责人（users.id），默认是上传的人 */
  ownerId: z.string(),
  /** 执行模型（models.id）；null = 用默认执行模型 */
  modelId: z.string().nullable(),
  /** 原 agent 用的模型这里没有、换成了什么，给人看 */
  modelNote: z.string().max(300).optional(),
  /** 选了「浏览器」工具时能用哪些 Chrome（已有的 browser_profiles.id）；空 = 全部 */
  browserProfileIds: z.array(z.string()).max(50),
  /** 网址白名单；空 = 不限制 */
  allowedDomains: z.array(domainSchema).max(100),
  logins: z.array(planLoginSchema).max(20),
  /** 用到的技能、共用记忆、规则、工具（方案里的 key）。任务记忆按 PlanMemory.target 挂，不在这里 */
  skillKeys: z.array(key).max(200),
  memoryKeys: z.array(key).max(200),
  ruleKeys: z.array(key).max(200),
  toolKeys: z.array(key).max(200),
  /** 挂成任务附件的文件（包内路径） */
  attachments: z.array(z.string().max(500)).max(50),
  /**
   * 可以被派活（第二期，派活方案第 10 节）：null / 不写 = 不能。fromKeys：谁能派活给它（方案里的任务 key，导入时只连勾上的）。
   * 派活方不用新字段：toolKeys 里有内置工具「派活」（kind builtin，refId work.dispatch）
   */
  dispatch: z
    .object({
      params: z.array(taskDispatchParamSchema).max(20),
      /** 要交回的结果（run-outcome 6.1）：同 taskDispatchSchema；不写 = 不要求（读包 AI 不填，人在向导里改） */
      results: z.array(taskDispatchResultSchema).max(20).optional(),
      maxRunning: z.number().int().min(1).max(20),
      /** 没办成自动重试几次、隔多久（分钟），同 taskDispatchSchema；不写 = 不重试（读包 AI 不填，人在向导里改） */
      retries: z.number().int().min(0).max(5).optional(),
      retryDelayMinutes: z.number().int().min(1).max(1440).optional(),
      fromKeys: z.array(key).max(20),
    })
    .nullable()
    .optional(),
  source,
})
export type PlanTask = z.infer<typeof planTaskSchema>

/**
 * 技能怎么处理：new 新建并发布；已有同名技能时 use_existing 用已有的（不改它，默认）、
 * new_version 把包里的内容存成已有技能的新一版、save_as_new 另存为一个新技能
 */
export const planSkillResolutionSchema = z.enum(["new", "use_existing", "new_version", "save_as_new"])
export type PlanSkillResolution = z.infer<typeof planSkillResolutionSchema>

export const planSkillSchema = z.object({
  key,
  include: z.boolean(),
  /** 分组，例如「业务必读」「原 agent 自带：某类」；页面按它分组、整组勾选（2026-10-18 加） */
  group: z.string().max(100).optional(),
  name: z.string().max(100),
  /** 岗位 */
  dept: z.string().max(50),
  /** 什么时候用 */
  description: z.string().max(300),
  /** SKILL.md 正文（不含开头的 --- 元数据） */
  body: z.string().max(50_000),
  /** 这个技能用到的工具（方案里的 key） */
  toolKeys: z.array(key).max(50),
  source,
  /** 合并进正文的参考文件（包内路径） */
  merged: z.array(z.string().max(500)).max(50),
  /** 已有同名技能：diff 是已有的当前版 → 包里的版本 */
  existing: z
    .object({
      id: z.string(),
      name: z.string(),
      version: z.number().int(),
      status: skillStatusSchema,
      /** 一句话：两边差在哪 */
      note: z.string().max(500),
      diff: z.array(diffLineSchema).max(5000),
    })
    .optional(),
  resolution: planSkillResolutionSchema,
})
export type PlanSkill = z.infer<typeof planSkillSchema>

/** 记忆放到哪：某个任务的任务记忆，或者「记忆」页的共用记忆（适用于：「分类 · 对象」或只有分类） */
export const planMemoryTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("task"), taskKey: key }),
  z.object({ kind: z.literal("shared"), appliesTo: z.string().max(100) }),
])
export type PlanMemoryTarget = z.infer<typeof planMemoryTargetSchema>

export const planMemorySchema = z.object({
  key,
  include: z.boolean(),
  text: z.string().max(1000),
  target: planMemoryTargetSchema,
  source,
  /** 不建议导入的原因（默认不勾）：和已有的记忆重复（existingId）、像网页里混进来的指令，或者包里写明过时了、和当前技能冲突（outdated，2026-10-18 加） */
  flag: z
    .object({
      kind: z.enum(["duplicate", "suspicious", "outdated"]),
      text: z.string().max(500),
      existingId: z.string().optional(),
    })
    .optional(),
})
export type PlanMemory = z.infer<typeof planMemorySchema>

/**
 * 规则：new 新建（读包时已经用「规划」模型翻译好，compile 里是「系统理解为」）；
 * existing 用已有的、已生效的规则（existingId；suggested = 包里没有、AI 建议加上）；unsupported v1 管不了，不导入
 */
export const planRuleSchema = z.object({
  key,
  include: z.boolean(),
  kind: z.enum(["new", "existing", "unsupported"]),
  suggested: z.boolean(),
  existingId: z.string().optional(),
  name: z.string().max(100),
  /** 什么情况下（existing 时是已有规则的文字，只给人看） */
  trigger: z.string().max(500),
  /** 命中后怎么办 */
  action: z.string().max(500),
  /** new：翻译结果。文字改过以后要重新翻译（imports.compileRule），对不上的导入时不确认 */
  compile: ruleCompileResultSchema.optional(),
  /** new：要用到这次才导入的工具，导入前翻译不了；导入后到「规则」页翻译、确认 */
  needsNewTools: z.boolean(),
  /** 命中后会调用的工具（方案里的 key） */
  toolKeys: z.array(key).max(20),
  /** existing：为什么认为是同一条；unsupported：为什么管不了 */
  reason: z.string().max(500).optional(),
  source: source.optional(),
})
export type PlanRule = z.infer<typeof planRuleSchema>

/**
 * 工具：http、mcp 新建（请求、环境变量里的密钥一律是 {{名字}}）；builtin 系统内置（refId 是工具 id，例如 browser、file.save）；
 * existing 用已有的工具（refId 是工具 id；或者 MCP 服务器 id，表示它的全部工具）
 */
export const planToolSchema = z.object({
  key,
  include: z.boolean(),
  kind: z.enum(["http", "mcp", "builtin", "existing"]),
  name: z.string().max(100),
  /** 一句话：干什么用 */
  summary: z.string().max(300),
  refId: z.string().optional(),
  http: z
    .object({
      method: httpMethodSchema,
      url: z.string().max(2000),
      headers: z.record(z.string(), z.string()),
      body: z.string().max(50_000).optional(),
      /** 给模型看的说明 */
      description: z.string().max(2000),
      risk: riskSchema,
    })
    .optional(),
  mcp: z
    .object({
      transport: z.enum(["stdio", "http"]),
      command: z.string().max(2000).optional(),
      url: z.string().max(2000).optional(),
      /** stdio 是环境变量，http 是请求头；密钥写 {{名字}} */
      env: z.array(z.object({ name: z.string().max(200), value: z.string().max(10_000) })).max(50),
    })
    .optional(),
  /** builtin / existing：为什么要选上，例如「原 agent 打开过网页」 */
  why: z.string().max(300).optional(),
  source: source.optional(),
})
export type PlanTool = z.infer<typeof planToolSchema>

/** 密钥：值从不出现在方案里（包里的值读包时已加密存进这次导入，人在确认时填的也一样） */
export const planSecretSchema = z.object({
  name: secretNameSchema,
  /** 包里有值 */
  found: z.boolean(),
  /** 人在确认时填了值 */
  filled: z.boolean(),
  /** 已经有同名密钥：导入时用已有的值，不覆盖 */
  exists: z.boolean(),
  /** 在包里哪儿，或者为什么没有值 */
  where: z.string().max(300),
  /** 哪些工具用它（方案里的 key） */
  toolKeys: z.array(key).max(50),
})
export type PlanSecret = z.infer<typeof planSecretSchema>

export const planWarningSchema = z.object({
  kind: z.enum(["secret", "script", "suspicious", "other"]),
  title: z.string().max(100),
  text: z.string().max(1000),
})
export type PlanWarning = z.infer<typeof planWarningSchema>

export const planUnusedFileSchema = z.object({
  /** 包内路径；同一个目录下一批文件可以合成一行，例如「logs/（9 个文件）」 */
  path: z.string().max(500),
  reason: z.string().max(300),
})

export const importPlanSchema = z.object({
  v: z.literal(1),
  /** AI 起的名字，例如「某某 agent」 */
  name: z.string().max(100),
  /** AI 读懂的：这个包是什么、做哪几件事 */
  summary: z.string().max(4000),
  warnings: z.array(planWarningSchema).max(50),
  tasks: z.array(planTaskSchema).max(20),
  skills: z.array(planSkillSchema).max(1000),
  memories: z.array(planMemorySchema).max(500),
  rules: z.array(planRuleSchema).max(100),
  tools: z.array(planToolSchema).max(100),
  secrets: z.array(planSecretSchema).max(100),
  unused: z.array(planUnusedFileSchema).max(500),
})
export type ImportPlan = z.infer<typeof importPlanSchema>

// ---------- 导入结果、导入后还要人做的事 ----------

const createdRef = z.object({ key: z.string(), id: z.string() })

export const importResultSchema = z.object({
  tasks: z.array(createdRef),
  /** created 新建并发布；new_version 存成已有技能的新一版（fromVersion 是之前那版）；reused 用已有的 */
  skills: z.array(createdRef.extend({ how: z.enum(["created", "new_version", "reused"]), fromVersion: z.number().int().optional() })),
  /** 新建的共用记忆 */
  memories: z.array(createdRef),
  taskMemories: z.array(z.object({ key: z.string(), id: z.number().int(), taskId: z.string() })),
  /** confirmed：导入时就确认生效了（needsNewTools 的规则要导入后再翻译、确认） */
  rules: z.array(createdRef.extend({ how: z.enum(["created", "reused"]), confirmed: z.boolean() })),
  /** id：新建的 HTTP 工具 id、MCP 服务器 id；用已有的是工具 id 或服务器 id */
  tools: z.array(createdRef.extend({ how: z.enum(["created", "reused"]) })),
  /** missing：包里没有、人也没填，导入后要补 */
  secrets: z.array(z.object({ name: z.string(), how: z.enum(["created", "reused", "missing"]) })),
  files: z.array(z.object({ path: z.string(), id: z.string(), taskId: z.string() })),
  /** 撤销以后才有：删了什么、留下了什么和为什么（例如任务已经跑过，只停用） */
  undo: z
    .object({
      deleted: z.array(z.string()),
      kept: z.array(z.object({ what: z.string(), reason: z.string() })),
    })
    .optional(),
})
export type ImportResult = z.infer<typeof importResultSchema>

/**
 * 导入以后还要人做的事（导入后按库里现在的状态算，办完 done = true）：
 * login 登录网站；secret 填密钥；mcp_connect 连接 MCP 服务器、读工具；mcp_tools 把读到的工具选进任务；
 * rule_confirm 翻译并确认规则；try_run 试跑任务
 */
export const importFollowUpSchema = z.object({
  key: z.string(),
  kind: z.enum(["login", "secret", "mcp_connect", "mcp_tools", "rule_confirm", "try_run"]),
  title: z.string(),
  description: z.string(),
  done: z.boolean(),
  /** 去哪办（控制台的 hash 路由），例如 #/browsers?id=br-default */
  link: z.string().optional(),
  /** 在导入详情里直接办：run_task 用 engine 的立即运行（taskId）；attach_mcp_tools 用 imports.attachMcpTools（serverId） */
  action: z.enum(["run_task", "attach_mcp_tools"]).optional(),
  taskId: z.string().optional(),
  serverId: z.string().optional(),
})
export type ImportFollowUp = z.infer<typeof importFollowUpSchema>

// ---------- 导入记录（接口返回的形状） ----------

/** imports.list 的一行 */
export const importRecordSchema = z.object({
  id: z.string(),
  fileName: z.string(),
  size: z.number().int(),
  /** 包里有多少个文件（解压前为 0） */
  fileCount: z.number().int(),
  /** AI 起的名字（读完才有） */
  name: z.string().nullable(),
  /** 上传时的补充说明 */
  note: z.string(),
  /** 读包用的模型 */
  modelId: z.string(),
  status: importStatusSchema,
  costUsd: z.number(),
  /** 没读成的原因 */
  error: z.string().nullable(),
  createdById: z.string(),
  createdAt: isoTime,
  /** 读完的时间 */
  readAt: isoTime.nullable(),
  importedAt: isoTime.nullable(),
  importedById: z.string().nullable(),
  undoneAt: isoTime.nullable(),
})
export type ImportRecord = z.infer<typeof importRecordSchema>

/** imports.get：再加上读包过程、方案、确认到哪一步、导入结果、还要人做的事 */
export const importDetailSchema = importRecordSchema.extend({
  readLog: z.array(importReadStepSchema),
  plan: importPlanSchema.nullable(),
  step: importStepSchema,
  visited: z.array(importStepSchema),
  result: importResultSchema.nullable(),
  followUps: z.array(importFollowUpSchema),
})
export type ImportDetail = z.infer<typeof importDetailSchema>

// ---------- 接口输入 ----------

/** 确认时的改动随时存（页面上改一下就存，防抖）。只有待确认的能存 */
export const importSavePlanInputSchema = z.object({
  id: z.string().min(1),
  plan: importPlanSchema,
  step: importStepSchema,
  visited: z.array(importStepSchema).max(10),
})
export type ImportSavePlanInput = z.infer<typeof importSavePlanInputSchema>

/** 确认时填密钥的值：只进不出，加密存进这次导入，方案里只记 filled */
export const importSetSecretInputSchema = z.object({
  id: z.string().min(1),
  name: secretNameSchema,
  value: z.string().min(1, "填真正的值").max(10_000),
})

/** 方案里的一条新规则按（改过的）文字重新翻译；结果写回方案并返回这条规则 */
export const importCompileRuleInputSchema = z.object({
  id: z.string().min(1),
  key,
  name: z.string().trim().min(1).max(100),
  trigger: z.string().trim().min(1, "写一句话：什么情况下这条规则起作用").max(500),
  action: z.string().trim().min(1, "写一句话：命中后 agent 该怎么做").max(500),
})

/** 重新读包：方案作废，换模型或补一句说明再读一遍 */
export const importRereadInputSchema = z.object({
  id: z.string().min(1),
  note: z.string().trim().max(2000).optional(),
  modelId: z.string().min(1).optional(),
})

/** 导入后：把 MCP 服务器读到的工具选进这次导入的、方案里用它的任务 */
export const importAttachMcpToolsInputSchema = z.object({
  id: z.string().min(1),
  serverId: z.string().min(1),
})

// ---------- 纯函数 ----------

/** 这条记忆会不会导入：勾上了，而且是共用的，或者它的任务也导入 */
export function planMemoryIncluded(plan: Pick<ImportPlan, "tasks">, memory: PlanMemory): boolean {
  if (!memory.include) return false
  if (memory.target.kind === "shared") return true
  const taskKey = memory.target.taskKey
  return plan.tasks.some((task) => task.include && task.key === taskKey)
}

/**
 * 方案自己对不对得上（存方案、导入前都查）：key 不重复、引用的 key 都在、记忆挂的任务在、
 * 规则的「existing」有 existingId、工具按种类带上要的字段。返回给人看的问题，没问题返回空数组
 */
export function planProblems(plan: ImportPlan): string[] {
  const problems: string[] = []
  const all = [...plan.tasks, ...plan.skills, ...plan.memories, ...plan.rules, ...plan.tools].map((item) => item.key)
  const dup = all.filter((value, index) => all.indexOf(value) !== index)
  if (dup.length) problems.push(`方案里有重复的 key：${[...new Set(dup)].join("、")}`)
  const has = (list: { key: string }[]) => (value: string) => list.some((item) => item.key === value)
  const missing = (label: string, keys: string[], exists: (value: string) => boolean) => {
    const bad = keys.filter((value) => !exists(value))
    if (bad.length) problems.push(`${label}引用了不存在的 key：${bad.join("、")}`)
  }
  for (const task of plan.tasks) {
    missing(`任务「${task.title}」的技能`, task.skillKeys, has(plan.skills))
    missing(`任务「${task.title}」的记忆`, task.memoryKeys, has(plan.memories))
    missing(`任务「${task.title}」的规则`, task.ruleKeys, has(plan.rules))
    missing(`任务「${task.title}」的工具`, task.toolKeys, has(plan.tools))
    if (task.dispatch) {
      missing(`任务「${task.title}」的派活方`, task.dispatch.fromKeys, has(plan.tasks))
      if (task.dispatch.fromKeys.includes(task.key)) problems.push(`任务「${task.title}」不能派活给它自己`)
    }
  }
  for (const skill of plan.skills) {
    missing(`技能「${skill.name}」的工具`, skill.toolKeys, has(plan.tools))
    if (skill.existing && skill.resolution === "new") problems.push(`技能「${skill.name}」已经有同名的，要选用已有的、更新成新一版还是另存`)
    if (!skill.existing && skill.resolution !== "new") problems.push(`技能「${skill.name}」没有同名的已有技能，只能新建`)
  }
  for (const memory of plan.memories) {
    if (memory.target.kind === "task") missing(`记忆「${memory.text.slice(0, 20)}」挂的任务`, [memory.target.taskKey], has(plan.tasks))
  }
  for (const rule of plan.rules) {
    missing(`规则「${rule.name}」的工具`, rule.toolKeys, has(plan.tools))
    if (rule.kind === "existing" && !rule.existingId) problems.push(`规则「${rule.name}」要用已有的，但没写是哪一条`)
  }
  for (const tool of plan.tools) {
    if (tool.kind === "http" && !tool.http) problems.push(`工具「${tool.name}」是 HTTP 接口，但没有请求`)
    if (tool.kind === "mcp" && !tool.mcp) problems.push(`工具「${tool.name}」是 MCP 服务器，但没有连接方式`)
    if ((tool.kind === "builtin" || tool.kind === "existing") && !tool.refId) problems.push(`工具「${tool.name}」要用已有的，但没写是哪一个`)
  }
  return problems
}
