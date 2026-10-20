// cron 的人话说法在 @heyagent/shared（任务、人加的待办、导入共用）。任务的下次运行时间由后端算；加待办时输入框下面的「接下来 3 次」在这里算。
import { parseCronFields } from "@heyagent/shared"

export { cronText } from "@heyagent/shared"

type Field = NonNullable<ReturnType<typeof parseCronFields>>[number]

const WEEK = "日一二三四五六"
const pad = (n: number) => String(n).padStart(2, "0")

function matches([minute, hour, day, month, week]: Field[], at: Date) {
  const [dayOk, weekOk] = [day.values.has(at.getDate()), week.values.has(at.getDay())]
  const dateOk = day.any || week.any ? dayOk && weekOk : dayOk || weekOk // 日和周都写了时满足一个就行（cron 的老规矩）
  return dateOk && month.values.has(at.getMonth() + 1) && hour.values.has(at.getHours()) && minute.values.has(at.getMinutes())
}

/** 从 from 往后（不含）的接下来 count 次，格式「2026-10-17 10:00」 */
export function nextRuns(expr: string, from: Date, count = 3): string[] {
  const fields = parseCronFields(expr)
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

/** 「2026-10-17 10:00」→「10-17 周六 10:00」 */
export const shortTime = (text: string) => `${text.slice(5, 10)} 周${WEEK[new Date(text.replace(" ", "T")).getDay()]} ${text.slice(11)}`
