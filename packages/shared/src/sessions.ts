// Session 页的分组和时长（原型 sessions/data.ts）。原型里的「现在」是写死的 2026-10-16 16:30，这里改成参数，默认取当前时间。
import type { RunStatus, SessionRun } from "./schemas.js"

type EventTimes = { events: readonly { at: string; kind: string }[] }
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
  failed: "ended",
}
export const groupOf = (run: Pick<SessionRun, "status">) => GROUP_OF[run.status]

/** 进行中的排最上面（执行中在验收中前面），其余按开始时间倒序 */
export function sortRuns<R extends SessionRun>(list: readonly R[]): R[] {
  const rank = (run: R) => (run.status === "running" ? 0 : run.status === "verifying" ? 1 : 2)
  return [...list].sort((a, b) => rank(a) - rank(b) || b.startedAt.localeCompare(a.startedAt))
}

/** 中途挂起了多久：每个「挂起」到下一个「继续」之间的时间加起来 */
export function pausedMs(run: EventTimes) {
  let total = 0
  let since: number | undefined
  for (const event of run.events) {
    if (event.kind === "wait") since = Date.parse(event.at)
    if (event.kind === "resume" && since !== undefined) {
      total += Date.parse(event.at) - since
      since = undefined
    }
  }
  return total
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
export function endedText(run: Pick<SessionRun, "startedAt" | "endedAt"> & EventTimes) {
  const end = Date.parse(run.endedAt ?? run.events.at(-1)?.at ?? run.startedAt)
  const paused = pausedMs(run)
  return `${duration(end - Date.parse(run.startedAt))}${paused > 0 ? `（挂起 ${duration(paused)}）` : ""}`
}

/** 「今天 09:12」「昨天 14:30」「10-14 11:05」 */
export const startText = (startedAt: string, now: Date | string | number = new Date()) => relativeDayText(startedAt, now)

export const isToday = (run: Pick<SessionRun, "startedAt">, now: Date | string | number = new Date()) => sameShanghaiDay(run.startedAt, now)
