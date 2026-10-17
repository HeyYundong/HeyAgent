// 简单的 cron 解析：5 段（分 时 日 月 周），支持 *、数字、a-b、a,b、*/n、a-b/n。
// 只用来在加待办时显示人话预览和接下来几次的时间，常见写法能翻译就行。

type Field = { raw: string; any: boolean; values: Set<number> }

const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]
const WEEK = "日一二三四五六"
const pad = (n: number) => String(n).padStart(2, "0")
const isNum = (field: Field) => /^\d+$/.test(field.raw)

function parseField(raw: string, [min, max]: [number, number]): Field | null {
  const values = new Set<number>()
  for (const part of raw.split(",")) {
    const match = part.match(/^(?:(\*)|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/)
    if (!match) return null
    const step = match[4] ? Number(match[4]) : 1
    const from = match[1] ? min : Number(match[2])
    const to = match[1] || (match[4] && !match[3]) ? max : match[3] ? Number(match[3]) : from
    if (from < min || to > max || from > to || step < 1) return null
    for (let value = from; value <= to; value += step) values.add(max === 7 && value === 7 ? 0 : value) // 周日写 0 或 7 都行
  }
  return { raw, any: raw === "*", values }
}

function parse(expr: string): Field[] | null {
  const parts = expr.trim().split(/\s+/)
  const fields = parts.length === 5 ? parts.map((part, index) => parseField(part, RANGES[index])) : []
  return fields.length === 5 && fields.every(Boolean) ? (fields as Field[]) : null
}

/** 「0 10 * * 1-5」→「每个工作日 10:00」；看不懂返回 null */
export function cronText(expr: string): string | null {
  const fields = parse(expr)
  if (!fields) return null
  const [minute, hour, day, month, week] = fields
  let date = week.raw === "1-5" ? "每个工作日" : !week.any ? `每周${[...week.values].sort().map((v) => WEEK[v]).join("、")}` : !day.any ? `每月 ${day.raw} 日` : "每天"
  if (!month.any) date = `${month.raw} 月${date}`
  const every = minute.raw.match(/^\*\/(\d+)$/)
  const everyHour = hour.raw.match(/^\*\/(\d+)$/)
  let time = "按表达式的时间"
  if (isNum(minute) && isNum(hour)) time = `${pad(Number(hour.raw))}:${pad(Number(minute.raw))}`
  else if (isNum(minute) && hour.any) time = `每小时的第 ${minute.raw} 分`
  else if (isNum(minute) && everyHour) time = `每 ${everyHour[1]} 小时（第 ${minute.raw} 分）`
  else if (every) time = `${hour.any ? "" : `${hour.raw} 点`}每 ${every[1]} 分钟`
  return date === "每天" && time.startsWith("每") ? time : `${date} ${time}`
}

function matches([minute, hour, day, month, week]: Field[], at: Date) {
  const [dayOk, weekOk] = [day.values.has(at.getDate()), week.values.has(at.getDay())]
  const dateOk = day.any || week.any ? dayOk && weekOk : dayOk || weekOk // 日和周都写了时满足一个就行（cron 的老规矩）
  return dateOk && month.values.has(at.getMonth() + 1) && hour.values.has(at.getHours()) && minute.values.has(at.getMinutes())
}

/** 从 from 往后（不含）的接下来 count 次，格式「2026-10-17 10:00」 */
export function nextRuns(expr: string, from: Date, count = 3): string[] {
  const fields = parse(expr)
  const result: string[] = []
  const at = new Date(from)
  at.setSeconds(0, 0)
  for (let step = 0; fields && step < 60 * 24 * 400 && result.length < count; step++) {
    at.setMinutes(at.getMinutes() + 1)
    if (matches(fields, at)) result.push(format(at))
  }
  return result
}

const format = (at: Date) => `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`

/** 「2026-10-16 11:45」加 N 天 →「2026-10-23 11:45」（只等事件的挂起，最晚等到什么时候） */
export function addDays(text: string, days: number) {
  const at = new Date(text.replace(" ", "T"))
  at.setDate(at.getDate() + days)
  return format(at)
}

/** 「2026-10-17 10:00」→「10-17 周六 10:00」 */
export const shortTime = (text: string) => `${text.slice(5, 10)} 周${WEEK[new Date(text.replace(" ", "T")).getDay()]} ${text.slice(11)}`
