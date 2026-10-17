// cron 的人话预览：只认常见写法（分 时 日 月 周），够原型用。下次运行时间由后端算，前端不算。

const WEEK = "日一二三四五六"
const isNum = (s: string) => /^\d+$/.test(s)

/** 「0 9 * * *」→「每天 09:00」；认不出返回 null */
export function cronText(cron: string): string | null {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const [mi, h, dom, mon, dow] = fields
  if (mon !== "*" || !isNum(mi) || !isNum(h) || Number(mi) > 59 || Number(h) > 23) return null
  const time = `${h.padStart(2, "0")}:${mi.padStart(2, "0")}`
  if (dom === "*" && dow === "*") return `每天 ${time}`
  if (dom === "*" && dow === "1-5") return `每个工作日 ${time}`
  if (dom === "*" && /^[0-7](,[0-7])*$/.test(dow)) return `每周${dow.split(",").map((d) => WEEK[Number(d) % 7]).join("、")} ${time}`
  if (isNum(dom) && dow === "*") return `每月 ${dom} 日 ${time}`
  return null
}
