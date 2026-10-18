// cron 的人话说法：5 段（分 时 日 月 周），支持 *、数字、a-b、a,b、*/n、a-b/n。
// 任务、待办、导入向导显示定时都用这一个，导入时也用它生成任务的 schedule.text，不用读包 AI 自己写的说法。

const WEEK = "日一二三四五六"
const RANGES: [number, number][] = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]]

type Field = { raw: string; any: boolean; values: Set<number> }

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

/** 5 段都看得懂才返回 */
export function parseCronFields(expr: string): Field[] | null {
  const parts = expr.trim().split(/\s+/)
  const fields = parts.length === 5 ? parts.map((part, index) => parseField(part, RANGES[index])) : []
  return fields.length === 5 && fields.every(Boolean) ? (fields as Field[]) : null
}

/** 小时写成时间段：「9-11,13-17」→「09:00–12:00、13:00–18:00」；带步长的不翻 */
function hourSpans(raw: string): string | null {
  const spans = raw.split(",").map((part) => {
    const match = part.match(/^(\d+)(?:-(\d+))?$/)
    if (!match) return null
    const from = Number(match[1])
    const to = match[2] ? Number(match[2]) : from
    return `${pad(from)}:00–${pad(to + 1)}:00`
  })
  return spans.every(Boolean) ? spans.join("、") : null
}

/** 「0 10 * * 1-5」→「每个工作日 10:00」，「* 9-11,13-17 * * 1-5」→「每个工作日 09:00–12:00、13:00–18:00 每分钟」；看不懂返回 null */
export function cronText(expr: string): string | null {
  const fields = parseCronFields(expr)
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
  else if (minute.any || every) {
    const often = minute.any ? "每分钟" : `每 ${every![1]} 分钟`
    const spans = hour.any ? "" : hourSpans(hour.raw)
    if (spans === null) time = `${hour.raw} 点${often}`
    else time = spans ? `${spans} ${often}` : often
  }
  return date === "每天" && time.startsWith("每") ? time : `${date} ${time}`
}
