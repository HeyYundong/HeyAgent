// 子 agent：交回给父的文字（docs/dev/sub-agents.md 7.3）和复核、三方验收的输入里「子 agent」一节（9.2）。都是纯函数，测试好写。
import {
  isRunEnded,
  runOutcomeLabel,
  SUBAGENT_EVIDENCE_CHARS,
  SUBAGENT_FILES_LISTED,
  SUBAGENT_RESULTS_ARE_BASIS,
  SUBAGENT_REVIEW_ITEM_CHARS,
  SUBAGENT_SUMMARY_CHARS,
  subagentStateLabel,
  workReportLine,
  type RunOutcome,
  type RunOutcomeBy,
  type SubagentState,
  type SubResult,
} from "@heyagent/shared"

import { missingFields } from "../outcome.js"

/** 一个子运行（交回、复核要的那些字段，调用方一次查好） */
export interface SubRunFacts {
  id: string
  n: number
  title: string
  goal: string
  /** 要交回的字段名（快照 sub.results） */
  results: string[]
  status: string
  outcome?: RunOutcome | null
  outcomeReason?: string | null
  outcomeBy?: RunOutcomeBy | null
  /** 出错、被停掉的原因（sessions.error） */
  error?: string | null
  subResult?: SubResult | null
  /** 它空间里的文件路径（父看到的是 subs/<n>/<路径>），前 SUBAGENT_FILES_LISTED 个 */
  files: string[]
  /** 现在的样子（view.ts 按状态和等待算；没给按状态粗算） */
  state?: SubagentState
  /** 挂起时在等什么 */
  waitingWhat?: string | null
}

const clip = (value: string, max: number) => {
  const text = value.trim()
  return text.length > max ? `${text.slice(0, max)}…（后面省略）` : text
}

const ended = (row: SubRunFacts) => isRunEnded(row.status as Parameters<typeof isRunEnded>[0])
const delivered = (row: SubRunFacts) => Boolean(row.subResult?.deliveredAt)

/** 结束的子运行算办成还是没办成：出错、被停掉、没记结果的都算没办成 */
const outcomeOf = (row: SubRunFacts): RunOutcome => (row.status === "done" && row.outcome === "achieved" ? "achieved" : "not_achieved")

/** 还没结束的子运行现在的样子（一小句） */
function stateText(row: SubRunFacts): string {
  const state = row.state ?? (row.status === "needs_human" ? "needs_human" : row.status === "waiting" ? "waiting" : "running")
  if (state === "waiting" && row.waitingWhat) return row.waitingWhat
  if (state === "queued") return "排队"
  return subagentStateLabel[state]
}

/** 父 agent 等子 agent 时，按 mode 判断现在满足了没有（7.1）：all 全部结束；any 有结束了、还没交给过父的（全部结束、都给过了也算满足） */
export function waitSatisfied(rows: SubRunFacts[], mode: "all" | "any"): boolean {
  if (rows.length === 0) return true
  if (rows.every(ended)) return true
  return mode === "any" && rows.some((row) => ended(row) && !delivered(row))
}

/** 这次要按全文交出去的（结束了、还没交给过父的）：交出去以后写 deliveredAt */
export const toDeliver = (rows: SubRunFacts[]) => rows.filter((row) => ended(row) && !delivered(row)).map((row) => row.id)

/** 结束了的一个子 agent 的全文（结果、summary、evidence、交回的字段、文件） */
function endedBlock(row: SubRunFacts, limits: { summary: number; evidence: number }): string[] {
  const outcome = outcomeOf(row)
  const label = runOutcomeLabel[outcome]
  const lines: string[] = []
  const summary = row.subResult?.summary?.trim()
  if (row.status === "done") {
    lines.push(`- ${row.id}「${row.title}」${label}${summary ? `：${clip(summary, limits.summary)}` : ""}`)
    // 没办成的原因（agent 报的、缺交回的字段、到了上限）和总结不一样时另写一行
    const reason = row.outcomeReason?.trim()
    if (outcome === "not_achieved" && reason && reason !== summary) lines.push(`  原因：${clip(reason, 500)}${row.outcomeBy === "agent" ? "（子 agent 自报）" : ""}`)
  } else {
    // 出错、被停掉、被人取消、旧的「没完成」：原因就是错误信息（被停掉的写了谁停的、为什么）
    const reason = (row.error ?? row.outcomeReason ?? "").trim()
    lines.push(`- ${row.id}「${row.title}」${label}${row.status === "failed" ? "（出错或被停掉）" : ""}${reason ? `：${clip(reason, 500)}` : ""}`)
    if (summary) lines.push(`  总结：${clip(summary, limits.summary)}`)
  }
  const evidence = row.subResult?.evidence?.trim()
  if (evidence && evidence !== summary) lines.push(`  依据：${clip(evidence, limits.evidence)}`)
  const data = row.subResult?.data ?? {}
  const report = workReportLine(data)
  if (report) lines.push(`  交回的字段：${report}`)
  const missing = missingFields(row.results, data)
  if (row.results.length && missing.length) lines.push(`  没交的字段：${missing.join("、")}`)
  if (row.files.length) lines.push(`  文件：${row.files.slice(0, SUBAGENT_FILES_LISTED).map((path) => `subs/${row.n}/${path}`).join("、")}${row.files.length > SUBAGENT_FILES_LISTED ? ` 等 ${row.files.length} 个` : ""}`)
  return lines
}

/** 「4 个：办成 3，没办成 1」或「4 个：结束 2（办成 1，没办成 1），在跑 1，排队 1」 */
function countsText(rows: SubRunFacts[]): string {
  const done = rows.filter(ended)
  const achieved = done.filter((row) => outcomeOf(row) === "achieved").length
  const outcomes = `办成 ${achieved}，没办成 ${done.length - achieved}`
  if (done.length === rows.length) return `${rows.length} 个：${outcomes}`
  const open = rows.filter((row) => !ended(row))
  const queued = open.filter((row) => row.state === "queued").length
  const parts = [`结束 ${done.length}${done.length ? `（${outcomes}）` : ""}`, `没结束 ${open.length}${queued ? `（其中排队 ${queued}）` : ""}`]
  return `${rows.length} 个：${parts.join("，")}`
}

/** 交回给父的文字的最后一句（叫醒父的消息、subagent_wait 的结果）：交回的值就是依据，只查矛盾和缺的，不要逐个重做（21.3 第 1 条、21.6.5 第 1 条） */
export const SUBAGENT_RESULTS_TAIL = `以上是子 agent 交回的结果。${SUBAGENT_RESULTS_ARE_BASIS}不要把交出去的事逐个重做。报没办成的、交回的东西缺了的照常处理。`

/**
 * 交回给父的文字：开头一句（几个、办成几个），每个子 agent 一段（结果、summary 前 1500 字、evidence 前 1000 字、交回的字段、文件路径；
 * 出错的写错误原因，被停掉的写谁停的、为什么），已经交回过的只写一行「R-12-3.1 办成（前面给过）」，最后一句 SUBAGENT_RESULTS_TAIL（交回的值就是依据；只查矛盾和缺的，不要逐个重做）。
 * mode 决定开头那句（all：都结束了；any：有 N 个结束了、还有 M 个在做；none：现状）
 */
export function subagentResultsText(rows: SubRunFacts[], mode: "all" | "any" | "none"): string {
  if (rows.length === 0) return "这次运行没有拆过子 agent。"
  const sorted = [...rows].sort((a, b) => a.n - b.n)
  const open = sorted.filter((row) => !ended(row))
  const fresh = sorted.filter((row) => ended(row) && !delivered(row))
  const head =
    open.length === 0
      ? `子 agent 都结束了（${countsText(sorted)}）。`
      : mode === "none"
        ? `子 agent 的现状（${countsText(sorted)}）。`
        : `有 ${fresh.length} 个子 agent 刚结束，还有 ${open.length} 个没结束（${countsText(sorted)}）。`
  const lines = [fresh.length ? `${head}结束了的结果如下，文件在你空间的 subs/<n>/ 下（只读）。` : head]
  for (const row of sorted) {
    if (!ended(row)) lines.push(`- ${row.id}「${row.title}」还没结束：${stateText(row)}`)
    else if (delivered(row)) lines.push(`- ${row.id}「${row.title}」${runOutcomeLabel[outcomeOf(row)]}（前面给过）`)
    else lines.push(...endedBlock(row, { summary: SUBAGENT_SUMMARY_CHARS, evidence: SUBAGENT_EVIDENCE_CHARS }))
  }
  if (open.length) lines.push("还没结束的：要等就用 subagent_wait（all 等全部、any 有一个结束就叫醒），不要了就用 subagent_cancel 停掉；都结束以前不能报结果。")
  if (fresh.length) lines.push(SUBAGENT_RESULTS_TAIL)
  return lines.join("\n")
}

/** 复核（review.ts 的 buildReviewPrompt）、三方验收（verify.ts 的 loadEvidence）的输入里加的一节；每个子 agent 截到 SUBAGENT_REVIEW_ITEM_CHARS 字以内 */
export function subagentReviewSection(rows: SubRunFacts[]): string {
  if (rows.length === 0) return ""
  const sorted = [...rows].sort((a, b) => a.n - b.n)
  const parts = [
    `## 子 agent（这次运行拆出去的 ${countsText(sorted)}）`,
    "每个子 agent 是一次单独的运行，结果是它们自报的，没有复核。父 agent 说办成的，要看它汇总的数据能不能在下面子 agent 的结果或文件里找到。",
  ]
  for (const row of sorted) {
    const block = ended(row)
      ? [`### ${row.n}. ${row.title}（${row.id}）`, `子目标：${clip(row.goal, 400)}`, ...endedBlock(row, { summary: 600, evidence: 400 }).map((line) => line.replace(/^- /, "").replace(/^ {2}/, ""))]
      : [`### ${row.n}. ${row.title}（${row.id}）`, `子目标：${clip(row.goal, 400)}`, `还没结束：${stateText(row)}`]
    parts.push(clip(block.join("\n"), SUBAGENT_REVIEW_ITEM_CHARS))
  }
  return parts.join("\n\n")
}

/** 父 agent 还有子 agent 没结束就要报结果（run.finish 被拒、只回文字的提醒，第 8 节） */
export const openChildrenText = (ids: string[]) =>
  `还有 ${ids.length} 个子 agent 没结束（${ids.slice(0, 10).join("、")}${ids.length > 10 ? " 等" : ""}）：先用 subagent_wait 等，或者用 subagent_cancel 停掉，再报结果。`
