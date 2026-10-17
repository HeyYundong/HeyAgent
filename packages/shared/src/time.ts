// 时间：接口里都是 ISO 8601（UTC），界面按上海时间显示成原型的写法。
// 公司只在一个时区，上海 1991 年以后没有夏令时，所以直接按固定的 +08:00 换算，不依赖浏览器或服务器的本地时区。

export const TIME_ZONE = "Asia/Shanghai"
const OFFSET_MS = 8 * 60 * 60 * 1000

const toDate = (value: string | Date | number) => (value instanceof Date ? value : new Date(value))

/** 上海时间的「2026-10-16T09:12:00.000」（不带时区），给下面的格式化函数切片用 */
function shanghai(value: string | Date | number) {
  const ms = toDate(value).getTime()
  if (Number.isNaN(ms)) throw new RangeError(`不是合法的时间：${String(value)}`)
  return new Date(ms + OFFSET_MS).toISOString().slice(0, 23)
}

/** 「2026-10-16 09:12」：原型里 startedAt、createdAt 这类字段的写法 */
export const fmtDateTime = (value: string | Date | number) => shanghai(value).slice(0, 16).replace("T", " ")

/** 「2026-10-16」 */
export const fmtDate = (value: string | Date | number) => shanghai(value).slice(0, 10)

/** 「10-16 09:12」：原型里 `xxx.slice(5)` 的写法 */
export const fmtShort = (value: string | Date | number) => fmtDateTime(value).slice(5)

/** 「09:12」 */
export const fmtClock = (value: string | Date | number) => shanghai(value).slice(11, 16)

/** 「2026-10-16 09:12」（上海时间）→ ISO。也接受只有日期的「2026-10-16」（当天 00:00） */
export function shanghaiToIso(text: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?$/.exec(text.trim())
  if (!match) throw new RangeError(`认不出的时间写法：${text}`)
  const [, date, time = "00:00", seconds = "00"] = match
  return new Date(`${date}T${time}:${seconds}+08:00`).toISOString()
}

interface RunTimes {
  startedAt: string
  endedAt?: string
  events: { at: string }[]
}

/** 这次运行是不是跨了天（按上海日期） */
export function runSpansDays(run: RunTimes): boolean {
  const last = run.endedAt ?? run.events.at(-1)?.at ?? run.startedAt
  return fmtDate(run.startedAt) !== fmtDate(last)
}

/**
 * 运行里事件和检查点记录的时间：原型的写法是当天的运行只写「09:58」，跨天的运行每条都写「10-15 15:40」。
 * 用在 RunEvent.at、RunCheckpoint.records[].at 上。
 */
export function eventTimeText(at: string, run: RunTimes): string {
  return runSpansDays(run) ? fmtShort(at) : fmtClock(at)
}

/** 「今天 09:12」「昨天 14:30」「10-14 11:05」（原型 sessions/data.ts 的 startText） */
export function relativeDayText(value: string, now: Date | string | number = new Date()): string {
  const day = fmtDate(value)
  const today = fmtDate(now)
  const yesterday = fmtDate(toDate(now).getTime() - 24 * 60 * 60 * 1000)
  if (day === today) return `今天 ${fmtClock(value)}`
  if (day === yesterday) return `昨天 ${fmtClock(value)}`
  return fmtShort(value)
}

/** 同一个上海日期 */
export const sameShanghaiDay = (a: string | Date | number, b: string | Date | number) => fmtDate(a) === fmtDate(b)

/** 加 N 天（只等事件的挂起，最晚等到什么时候） */
export const addDaysIso = (value: string, days: number) => new Date(toDate(value).getTime() + days * 24 * 60 * 60 * 1000).toISOString()
