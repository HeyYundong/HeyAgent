// 任务、运行、待办之间的纯函数（原型 mock/shared.ts、tasks/parts.tsx）。
// 原型里这些函数直接读全局的假数据数组，这里改成「数据作为参数传入」，前端传查询结果，后端传库里读出的数据。
import type { BoardColumn } from "./labels.js"
import type { HumanItem, HumanTodo, RunCheckpoint, SessionRun, Staff, TaskDef, Tool, Trigger } from "./schemas.js"
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
export function runsOfTask<R extends SessionRun>(runs: readonly R[], taskId: string): R[] {
  return runs.filter((run) => run.taskId === taskId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function latestRun<R extends SessionRun>(runs: readonly R[], taskId: string): R | undefined {
  return runsOfTask(runs, taskId)[0]
}

export function triggerText(trigger: Trigger): string {
  if (trigger.kind === "time") return `到 ${fmtDateTime(trigger.at)}`
  if (trigger.kind === "cron") return `${trigger.text}（cron: ${trigger.cron}），下次 ${fmtDateTime(trigger.next)}`
  if (trigger.kind === "event") return `等到「${trigger.event}」（最多等 ${trigger.fallbackDays} 天，到期提醒负责人）`
  return `到 ${fmtDateTime(trigger.at)}，或等到「${trigger.event}」（先到先继续）`
}

export type BoardCard =
  | { kind: "run"; id: string; column: BoardColumn; run: SessionRun; task: TaskDef }
  | { kind: "human"; id: string; column: "needs_human"; item: HumanItem }
  | { kind: "todo"; id: string; column: "waiting"; todo: HumanTodo }

/** 看板上的全部卡片。已定：员工也能看全部（只读），能不能操作由页面按负责人判断 */
export function boardCards(data: { runs: readonly SessionRun[]; tasks: readonly TaskDef[]; humanItems: readonly HumanItem[]; humanTodos: readonly HumanTodo[] }): BoardCard[] {
  const { runs, tasks, humanItems, humanTodos } = data
  const cards: BoardCard[] = []
  for (const run of runs) {
    const task = findById(tasks, run.taskId)
    if (!task) continue
    // 等人处理的运行，由下面「要人办的事」的卡片代表，不重复放
    if (run.status === "needs_human" || run.status === "failed") continue
    // 已完成的只放每个任务最近一次，更早的历史在「Session」页
    if (run.status === "done" && runs.some((other) => other.taskId === run.taskId && other.status === "done" && other.startedAt > run.startedAt)) continue
    cards.push({ kind: "run", id: run.id, column: run.status, run, task })
  }
  for (const item of humanItems) cards.push({ kind: "human", id: item.id, column: "needs_human", item })
  for (const todo of humanTodos) cards.push({ kind: "todo", id: todo.id, column: "waiting", todo })
  return cards
}

/** 侧边栏「待办」上的数字：等我处理的事（主管算全部） */
export function needsMeCount(humanItems: readonly Pick<HumanItem, "assigneeId">[], userId: string, isAdmin: boolean): number {
  return humanItems.filter((item) => isAdmin || item.assigneeId === userId).length
}

/** 一次运行此刻的一句话：在等什么（加什么时候继续）/ 正在做什么 / 验收到哪（原型 tasks/parts.tsx 的 runNow） */
export function runNow(run: SessionRun, humanItems: readonly HumanItem[], staff: readonly Staff[]): { label: string; text: string; when?: string } {
  if (run.waiting) return { label: "在等", text: run.waiting.what.replace(/^等/, ""), when: triggerText(run.waiting.trigger) }
  if (run.status === "needs_human") {
    // 只算挡住 session 的事；记忆、技能审核不挡
    const items = humanItems.filter((item) => item.runId === run.id && ["approval", "verify", "login"].includes(item.kind))
    return { label: "在等", text: items.map((item) => `${item.title}（${staffName(staff, item.assigneeId)}）`).join("；") || "等人处理" }
  }
  if (run.status === "running") return { label: "正在", text: run.events.at(-1)?.title ?? "刚开始" }
  if (run.status === "verifying") return { label: "验收中", text: run.verification?.headline ?? "三方 AI 在核对检查点" }
  // M1 还没有三方验收（M3 做），没验收过的只写「完成」，不说「验收通过」
  if (run.status === "done") return { label: "结果", text: `${run.verification?.status === "passed" ? "验收通过" : "完成"} · ${run.endedAt ? fmtDateTime(run.endedAt) : ""}` }
  return { label: "结果", text: `失败 · ${run.events.findLast((event) => event.kind === "error")?.title ?? "运行失败"}` }
}

/** 「完成 3/5」；有跳过的写成「完成 2/3 · 跳过 1」 */
export function checkpointSummary(checkpoints: readonly RunCheckpoint[]) {
  if (checkpoints.length === 0) return "还没有"
  const count = (status: RunCheckpoint["status"]) => checkpoints.filter((cp) => cp.status === status).length
  return `完成 ${count("done")}/${checkpoints.length}${count("skipped") ? ` · 跳过 ${count("skipped")}` : ""}`
}

/** 卡片和详情共用：预计下次运行 */
export function nextRunText(task: TaskDef, latest?: SessionRun) {
  if (!task.enabled) return "已停用，不会运行"
  if (task.nextRunAt) return fmtDateTime(task.nextRunAt)
  if (task.schedule) return "按 cron 计算"
  if (latest && ["waiting", "needs_human"].includes(latest.status)) return "等到了就继续挂起的 session"
  if (latest && ["running", "verifying"].includes(latest.status)) return "正在运行"
  return "不再运行（只跑一次）"
}

/** 这个任务现在有没有挂起的 session（到点就继续它，没有就开始一次新的运行） */
export function suspendedRun(runs: readonly SessionRun[], taskId: string) {
  return runs.find((run) => run.taskId === taskId && run.waiting && (run.status === "waiting" || run.status === "needs_human"))
}
