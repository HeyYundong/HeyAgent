// Session 页的分组和时长（原型 sessions/data.ts）。原型里的「现在」是写死的 2026-10-16 16:30，这里改成参数，默认取当前时间。
import { z } from "zod"

import { runOutcomeSchema, sessionSummarySchema, type RunEvent, type RunStatus, type SessionSummary } from "./schemas.js"
import { browserIdsOf } from "./browsers.js"
import { relativeDayText, sameShanghaiDay } from "./time.js"

/** 会话页的状态标签（网址 ?status=，执行中是默认，不写）。等人处理里还有不属于运行的「要人办的事」（记忆审核、技能修改），页面自己加 */
export type SessionGroup = "running" | "human" | "waiting" | "verifying" | "ended"

export const sessionGroups: { id: SessionGroup; name: string }[] = [
  { id: "running", name: "执行中" },
  { id: "human", name: "等人处理" },
  { id: "waiting", name: "等待中" },
  { id: "verifying", name: "验收中" },
  { id: "ended", name: "已结束" },
]

const GROUP_OF: Record<RunStatus, SessionGroup> = {
  running: "running",
  needs_human: "human",
  waiting: "waiting",
  verifying: "verifying",
  done: "ended",
  incomplete: "ended",
  failed: "ended",
}
export const groupOf = (run: Pick<SessionSummary, "status">) => GROUP_OF[run.status]

/** 每个标签包含哪些状态（服务端 sessions.page 按它在库里筛） */
export const statusesOfGroup = (group: SessionGroup): RunStatus[] => (Object.keys(GROUP_OF) as RunStatus[]).filter((status) => GROUP_OF[status] === group)

export const sessionGroupSchema = z.enum(["running", "human", "waiting", "verifying", "ended"])
/** 运行怎么开始的：手动 / 定时 / 人加的待办到点 / 外部事件 / 派活 */
export const sessionSourceSchema = z.enum(["manual", "cron", "todo", "event", "dispatch"])

/** 会话页的一页（sessions.page）：筛选、搜索、数数、翻页都在库里做 */
export const sessionPageInputSchema = z.object({
  group: sessionGroupSchema.default("running"),
  /** 只看等我处理：等人处理、而且有一件挡住它的事（审批 / 验收争议 / 登录）是我的（主管算全部，同侧边栏数字的算法）。开着时不看 group */
  mine: z.boolean().optional(),
  source: sessionSourceSchema.optional(),
  taskId: z.string().optional(),
  outcome: runOutcomeSchema.optional(),
  /** 搜 session 编号、任务编号、任务名、派活单号（不分大小写） */
  q: z.string().trim().max(200).optional(),
  page: z.number().int().min(1).default(1),
  pageSize: z.number().int().min(1).max(200).default(50),
})
export type SessionPageInput = z.input<typeof sessionPageInputSchema>

export const sessionCountsSchema = z.object({
  running: z.number().int(),
  human: z.number().int(),
  waiting: z.number().int(),
  verifying: z.number().int(),
  ended: z.number().int(),
})
export type SessionCounts = z.infer<typeof sessionCountsSchema>

export const sessionPageSchema = z.object({
  items: z.array(sessionSummarySchema),
  /** 符合条件的一共几个（翻页用） */
  total: z.number().int(),
  /** 实际给的是第几页：超出就给最后一页 */
  page: z.number().int(),
  pageSize: z.number().int(),
  /** 各标签的个数：同样的来源、任务、结果、搜索，不算标签和「只看等我处理」 */
  counts: sessionCountsSchema,
  /** 今天（上海时间）开始的运行一共花了多少，美元。不看任何筛选 */
  spentToday: z.number(),
})
export type SessionPage = z.infer<typeof sessionPageSchema>

/** 进行中的排最上面（执行中在验收中前面），其余按开始时间倒序 */
export function sortRuns<R extends Pick<SessionSummary, "status" | "startedAt">>(list: readonly R[]): R[] {
  const rank = (run: R) => (run.status === "running" ? 0 : run.status === "verifying" ? 1 : 2)
  return [...list].sort((a, b) => rank(a) - rank(b) || b.startedAt.localeCompare(a.startedAt))
}

/** 中途挂起了多久：每个「挂起」到下一个「继续」之间的时间加起来（服务端在库里算同样的数，见 loaders.ts） */
export function pausedMsOf(events: readonly Pick<RunEvent, "at" | "kind">[]) {
  let total = 0
  let since: number | undefined
  for (const event of events) {
    if (event.kind === "wait") since = Date.parse(event.at)
    if (event.kind === "resume" && since !== undefined) {
      total += Date.parse(event.at) - since
      since = undefined
    }
  }
  return total
}

type EventSummary = Pick<SessionSummary, "eventCount" | "lastEvent" | "lastError" | "doneDetail" | "pausedMs" | "browserIds">

/** 从全部过程（按 seq 从小到大）算摘要里的几样：和服务端 sessions.list 在库里算的一致，测试、假数据用 */
export function summarizeEvents(events: readonly RunEvent[]): EventSummary {
  const last = events.at(-1)
  const error = events.findLast((event) => event.kind === "error")
  const done = events.findLast((event) => event.kind === "done")
  return {
    eventCount: events.length,
    lastEvent: last && { at: last.at, kind: last.kind, title: last.title },
    lastError: error && { at: error.at, title: error.title },
    doneDetail: done?.detail,
    pausedMs: pausedMsOf(events),
    browserIds: browserIdsOf(events),
  }
}

/** 「7 分钟」「2 小时 10 分」「1 天 5 小时」 */
export function duration(ms: number) {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ""}`
  return `${Math.floor(hours / 24)} 天${hours % 24 ? ` ${hours % 24} 小时` : ""}`
}

/** 已结束的 session：总时长，中途挂起过的带上「（挂起 …）」 */
export function endedText(run: Pick<SessionSummary, "startedAt" | "endedAt" | "lastEvent" | "pausedMs">) {
  const end = Date.parse(run.endedAt ?? run.lastEvent?.at ?? run.startedAt)
  const paused = run.pausedMs
  return `${duration(end - Date.parse(run.startedAt))}${paused > 0 ? `（挂起 ${duration(paused)}）` : ""}`
}

/** 「今天 09:12」「昨天 14:30」「10-14 11:05」 */
export const startText = (startedAt: string, now: Date | string | number = new Date()) => relativeDayText(startedAt, now)

export const isToday = (run: Pick<SessionSummary, "startedAt">, now: Date | string | number = new Date()) => sameShanghaiDay(run.startedAt, now)
