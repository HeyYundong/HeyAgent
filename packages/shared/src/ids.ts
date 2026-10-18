// 可读的文本 id：界面上直接显示这些 id，所以主键不用 uuid。种子数据沿用原型的 id，M1 起新建的按下面的规则生成。
// 数字部分来自数据库里的序列（迁移里建好，种子灌完会把序列推到现有最大值之后），并发生成也不会撞号。

/** 任务：T-1042。序列 task_no_seq */
export const taskId = (n: number) => `T-${n}`

/** 从任务 id 取出数字部分：T-1024 → 1024 */
export const taskNumber = (id: string) => Number(id.replace(/^T-/, ""))

/**
 * 运行（session）：
 * - 人点「创建并启动 / 立即运行」、待办到点、外部事件触发：R-<任务号>-<这个任务的第几次运行>，例如 R-1024-1；
 * - cron 定时触发：R-<任务号>-<触发日 MMDD（上海时间）>，例如 R-1040-1016；同一天第二次触发加 -2。
 * 撞号时序号 +1 重试（主键冲突）。
 */
export const manualSessionId = (taskIdValue: string, k: number) => `R-${taskNumber(taskIdValue)}-${k}`
export const cronSessionId = (taskIdValue: string, mmdd: string, k = 1) => `R-${taskNumber(taskIdValue)}-${mmdd}${k > 1 ? `-${k}` : ""}`

/** 记忆：m-011（三位，不够补零）。序列 memory_no_seq */
export const memoryId = (n: number) => `m-${String(n).padStart(3, "0")}`

/** 技能：sk-<英文短名>，主管新建时填；没填就用 sk-<序号>（序列 skill_no_seq） */
export const skillId = (slugOrNumber: string | number) => `sk-${slugOrNumber}`

/** 规则：rl-<英文短名> 或 rl-<序号>（序列 rule_no_seq） */
export const ruleId = (slugOrNumber: string | number) => `rl-${slugOrNumber}`

/** MCP 服务器：mcp-<英文短名>；Chrome：br-<英文短名>（例如 br-uk）。重名时加 -2、-3 */
export const mcpServerId = (slug: string) => `mcp-${slug}`
export const browserProfileId = (slug: string) => `br-${slug}`

/** 浏览器账号：acc-<Chrome 短名>-<平台>，同一个 Chrome 同一平台第二个账号加 -2 */
export const browserAccountId = (profileIdValue: string, platformId: string, k = 1) =>
  `acc-${profileIdValue.replace(/^br-/, "")}-${platformId}${k > 1 ? `-${k}` : ""}`

/**
 * 要人办的事：前缀按类型，数字共用序列 human_item_no_seq。
 * 原型的种子数据里记忆审核、技能修改直接用了记忆 / 技能的 id（m-008、sk-find-same），以后新建的用下面的前缀，
 * 并通过 MemoryRef.reviewItemId、Skill.suggestion.itemId 关联。
 */
export const HUMAN_ITEM_PREFIX = { approval: "ap", verify: "vf", login: "lg", memory: "mr", skill: "ss" } as const
export const humanItemId = (kind: keyof typeof HUMAN_ITEM_PREFIX, n: number) => `${HUMAN_ITEM_PREFIX[kind]}-${String(n).padStart(2, "0")}`

/** 人加的待办：td-09。序列 todo_no_seq */
export const todoId = (n: number) => `td-${String(n).padStart(2, "0")}`

/** 模型服务：<类型>-<序号>，例如 ollama-2；模型：<服务 id>/<模型名> */
export const modelProviderId = (kind: string, n: number) => `${kind}-${n}`
export const modelId = (providerIdValue: string, model: string) => `${providerIdValue}/${model}`

/** 图库里的图：img-12。序列 gallery_no_seq */
export const galleryImageId = (n: number) => `img-${n}`

/** API 密钥：ak-3。序列 api_key_no_seq */
export const apiKeyId = (n: number) => `ak-${n}`

/** 导入（别的 agent 打的 zip 包）：IM-3。序列 import_no_seq */
export const importId = (n: number) => `IM-${n}`

/** 派活单：W-57。序列 work_item_no_seq */
export const workItemId = (n: number) => `W-${n}`

/** 比图：一次比对 cmp-12（序列 compare_no_seq）；比对标准 std-3（序列 compare_standard_no_seq），自带的是 std-same-item */
export const comparisonId = (n: number) => `cmp-${n}`
export const compareStandardId = (n: number) => `std-${n}`
