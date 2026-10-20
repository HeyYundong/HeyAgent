// 任务、运行、待办之间的纯函数（原型 mock/shared.ts、tasks/parts.tsx）。
// 原型里这些函数直接读全局的假数据数组，这里改成「数据作为参数传入」，前端传查询结果，后端传库里读出的数据。
import { runOutcomeLabel } from "./labels.js"
import type { HumanItem, RunCheckpoint, RunOutcome, SessionSummary, Staff, TaskDef, Tool, Trigger } from "./schemas.js"
import { fmtDateTime } from "./time.js"

export function findById<T extends { id: string }>(list: readonly T[], id: string | null | undefined): T | undefined {
  return id ? list.find((item) => item.id === id) : undefined
}

export function staffName(staff: readonly Staff[], id: string | undefined): string {
  return findById(staff, id)?.name ?? "—"
}

export function toolName(tools: readonly Pick<Tool, "id" | "name">[], id: string): string {
  return tools.find((tool) => tool.id === id)?.name ?? id
}

/** 「适用于」的分类部分：「客户偏好 · Nova Home」→「客户偏好」 */
export function memoryCategory(appliesTo: string): string {
  return appliesTo.split(" · ")[0] ?? appliesTo
}

/** 每个任务都自带的工具 id（原型的 ALWAYS_ON_TOOL_IDS） */
export function alwaysOnToolIds(tools: readonly Pick<Tool, "id" | "alwaysOn">[]): string[] {
  return tools.filter((tool) => tool.alwaysOn).map((tool) => tool.id)
}

/** 这个任务能用的全部工具：自带的 + 建任务时选的 */
export function toolIdsOfTask(task: Pick<TaskDef, "toolIds">, alwaysOnIds: readonly string[]): string[] {
  return [...alwaysOnIds, ...task.toolIds.filter((id) => !alwaysOnIds.includes(id))]
}

/** 哪些任务选用了这条规则 / 这个工具 / 这条记忆 / 这个技能。每个任务都自带的工具算全部任务 */
export function tasksUsing<T extends TaskDef>(
  tasks: readonly T[],
  field: "ruleIds" | "toolIds" | "memoryIds" | "skillIds",
  id: string,
  alwaysOnIds: readonly string[] = []
): T[] {
  if (field === "toolIds" && alwaysOnIds.includes(id)) return [...tasks]
  return tasks.filter((task) => task[field].includes(id))
}

/** 某个任务的运行，最新的在前 */
export function runsOfTask<R extends Pick<SessionSummary, "taskId" | "startedAt">>(runs: readonly R[], taskId: string): R[] {
  return runs.filter((run) => run.taskId === taskId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function latestRun<R extends Pick<SessionSummary, "taskId" | "startedAt">>(runs: readonly R[], taskId: string): R | undefined {
  return runsOfTask(runs, taskId)[0]
}

export function triggerText(trigger: Trigger): string {
  if (trigger.kind === "time") return `到 ${fmtDateTime(trigger.at)}`
  if (trigger.kind === "cron") return `${trigger.text}（cron: ${trigger.cron}），下次 ${fmtDateTime(trigger.next)}`
  if (trigger.kind === "event") return `等到「${trigger.event}」（最多等 ${trigger.fallbackDays} 天，到期提醒负责人）`
  return `到 ${fmtDateTime(trigger.at)}，或等到「${trigger.event}」（先到先继续）`
}

/** 是不是「等我处理」的事：主管算全部，员工只算分给自己的（会话页「只看等我处理」、侧边栏「会话」上的数字） */
export const isNeedsMe = (item: Pick<HumanItem, "assigneeId">, userId: string, isAdmin: boolean) => isAdmin || item.assigneeId === userId

/** 侧边栏「会话」上的数字：等我处理的事（主管算全部） */
export function needsMeCount(humanItems: readonly Pick<HumanItem, "assigneeId">[], userId: string, isAdmin: boolean): number {
  return humanItems.filter((item) => isNeedsMe(item, userId, isAdmin)).length
}

/** 一次运行此刻的一句话：在等什么（加什么时候继续）/ 正在做什么 / 验收到哪（原型 tasks/parts.tsx 的 runNow） */
export function runNow(run: SessionSummary, humanItems: readonly HumanItem[], staff: readonly Staff[]): { label: string; text: string; when?: string } {
  if (run.waiting) return { label: "在等", text: run.waiting.what.replace(/^等/, ""), when: triggerText(run.waiting.trigger) }
  if (run.status === "needs_human") {
    // 只算挡住 session 的事；记忆、技能审核不挡
    const items = humanItems.filter((item) => item.runId === run.id && ["approval", "verify", "login"].includes(item.kind))
    return { label: "在等", text: items.map((item) => `${item.title}（${staffName(staff, item.assigneeId)}）`).join("；") || "等人处理" }
  }
  if (run.status === "running") return { label: "正在", text: run.lastEvent?.title ?? "刚开始" }
  if (run.status === "verifying") return { label: "验收中", text: run.verification?.headline ?? "三方 AI 在核对检查点" }
  // 结束了：状态只管流程，办没办成写结果（run-outcome）。出错的写错误标题；其余写结果、原因（办成的不写）、结束时间
  if (run.status === "failed") return { label: "结果", text: `出错 · ${run.lastError?.title ?? "运行出错"}` }
  const outcome = outcomeOf(run)
  const reason = outcome && outcome !== "achieved" ? outcomeReasonOf(run) : undefined
  const when = run.endedAt ? fmtDateTime(run.endedAt) : ""
  return { label: "结果", text: [outcome ? runOutcomeLabel[outcome] : isReviewing(run) ? "复核中" : "已结束", reason, when].filter(Boolean).join(" · ") }
}

/**
 * 运行的结果（run-outcome）：结束了、复核完了才有。接口没给 outcome 的老数据：没完成（旧状态）、出错的算没办成（和迁移 0024 补的一样），
 * 其余的不猜，返回 undefined（页面上写「—」，复核还在跑的写「复核中」）
 */
export function outcomeOf(run: Pick<SessionSummary, "status" | "outcome">): RunOutcome | undefined {
  if (run.outcome) return run.outcome
  return run.status === "incomplete" || run.status === "failed" ? "not_achieved" : undefined
}

/** 运行已经结束、复核还在跑（结果先空着）：页面上显示「复核中」 */
export function isReviewing(run: Pick<SessionSummary, "status" | "outcome" | "review">): boolean {
  return run.status === "done" && !run.outcome && Boolean(run.review?.pending)
}

/** 结果的原因：outcomeReason（没办成缺了什么、复核的理由、人改的理由）；老数据退回没完成时的说明、出错的标题 */
export function outcomeReasonOf(run: Pick<SessionSummary, "status" | "outcomeReason" | "doneDetail" | "lastError">): string | undefined {
  if (run.outcomeReason) return run.outcomeReason
  if (run.status === "incomplete") return run.doneDetail
  if (run.status === "failed") return run.lastError?.title
  return undefined
}

/** 「完成 3/5」；有跳过的写成「完成 2/3 · 跳过 1」 */
export function checkpointSummary(checkpoints: readonly RunCheckpoint[]) {
  if (checkpoints.length === 0) return "还没有"
  const count = (status: RunCheckpoint["status"]) => checkpoints.filter((cp) => cp.status === status).length
  return `完成 ${count("done")}/${checkpoints.length}${count("skipped") ? ` · 跳过 ${count("skipped")}` : ""}`
}

/** 卡片和详情共用：预计下次运行 */
export function nextRunText(task: TaskDef, latest?: SessionSummary) {
  if (!task.enabled) return "已停用，不会运行"
  if (task.nextRunAt) return fmtDateTime(task.nextRunAt)
  if (task.schedule) return "按 cron 计算"
  if (latest && ["waiting", "needs_human"].includes(latest.status)) return "等到了就继续挂起的 session"
  if (latest && ["running", "verifying"].includes(latest.status)) return "正在运行"
  return "不再运行（只跑一次）"
}

/** 这个任务现在有没有挂起的 session（到点就继续它，没有就开始一次新的运行） */
export function suspendedRun(runs: readonly SessionSummary[], taskId: string) {
  return runs.find((run) => run.taskId === taskId && run.waiting && (run.status === "waiting" || run.status === "needs_human"))
}
