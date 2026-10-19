// Session 页的分组和时长（原型 sessions/data.ts）。原型里的「现在」是写死的 2026-10-16 16:30，这里改成参数，默认取当前时间。
import type { RunEvent, RunStatus, SessionSummary } from "./schemas.js"
import { browserIdsOf } from "./browsers.js"
import { relativeDayText, sameShanghaiDay } from "./time.js"

export type SessionGroup = "all" | "active" | "paused" | "ended"

export const sessionGroups: { id: SessionGroup; name: string }[] = [
  { id: "all", name: "全部" },
  { id: "active", name: "进行中" },
  { id: "paused", name: "挂起" },
  { id: "ended", name: "已结束" },
]

const GROUP_OF: Record<RunStatus, Exclude<SessionGroup, "all">> = {
  running: "active",
  verifying: "active",
  waiting: "paused",
  needs_human: "paused",
  done: "ended",
  incomplete: "ended",
  failed: "ended",
}
export const groupOf = (run: Pick<SessionSummary, "status">) => GROUP_OF[run.status]

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
