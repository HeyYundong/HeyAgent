// 运行结果（docs/dev/run-outcome.md 第 2、4 节）：状态只管流程，结果单独一列（办成 / 部分办成 / 没办成 / 没核实）。
// 收尾时按硬规则取最低：agent 的报告（run.finish / 旧的 run.not_done / work.report not_done）、检查点、被派运行必交的结果、三方验收。
// 硬规则的结论（ceiling）是复核能给的上限：复核只能往低判（review.ts）；不复核时，agent 说办成但没有依据的记没核实。
// 这里的判断是纯函数（judgeByRules / finalWithoutReview / combineReview），事实在收尾的事务里读（outcomeFactsInTx）。
import { lowerOutcome, RUN_OUTCOME_RANK, runOutcomeLabel, type RunOutcome, type RunOutcomeBy, type SessionSnapshot, type WorkFailKind } from "@heyagent/shared"
import { eq } from "drizzle-orm"

import * as t from "../db/schema.js"
import { reportedIn } from "./dispatch/settle.js"
import type { Tx } from "./queue.js"

/** agent 自己报的结果：run.finish、旧快照里的 run.not_done（= not_achieved）、被派运行的 work.report not_done */
export interface AgentClaim {
  outcome: "achieved" | "partial" | "not_achieved"
  /** 做了什么、结果在哪（写回派活单的总结） */
  summary: string
  evidence?: string
  reason?: string
  via: "finish" | "not_done" | "work_report"
}

export interface OutcomeFacts {
  /** agent 的报告；只回了一段文字、没报结果为空 */
  claim?: AgentClaim
  checkpoints: { title: string; status: string }[]
  /** 被派的运行：必交的结果里没交的（名字） */
  missingResults: string[]
  /** 三方验收通过（验收员通过，或者负责人在验收争议里判了通过） */
  verified?: { by: "verify" | "human"; headline: string }
}

/** 一个结果和它的来历 */
export interface Judged {
  outcome: RunOutcome
  by: RunOutcomeBy
  reason: string
  /** 被派的单没办成时记成哪种（not_done / missing_result / partial） */
  failKind?: WorkFailKind
}

/** 硬规则的结论：ceiling 是复核能给的上限；evidence = 有依据（验收通过，或者 agent 报办成且检查点全部达成） */
export interface RuleVerdict extends Judged {
  evidence: boolean
  claimed: boolean
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value)

/** 检查点的约束：有没达成的、全部跳过 → 没办成；部分跳过 → 最多部分办成；全部达成不压低。没有检查点不管 */
function checkpointLimit(checkpoints: OutcomeFacts["checkpoints"]): Judged | undefined {
  if (checkpoints.length === 0) return undefined
  const open = checkpoints.filter((cp) => cp.status === "open")
  if (open.length) return { outcome: "not_achieved", by: "rule", reason: `${open.length} 个检查点没达成：${open.map((cp) => cp.title).join("、")}`, failKind: "not_done" }
  const skipped = checkpoints.filter((cp) => cp.status === "skipped")
  if (skipped.length === checkpoints.length)
    return { outcome: "not_achieved", by: "rule", reason: `${checkpoints.length} 个检查点全部跳过，一个都没达成：${checkpoints.map((cp) => cp.title).join("、")}`, failKind: "not_done" }
  if (skipped.length) return { outcome: "partial", by: "rule", reason: `${skipped.length} 个检查点跳过：${skipped.map((cp) => cp.title).join("、")}`, failKind: "partial" }
  return undefined
}

/**
 * 硬规则（第 4 节），取最低：agent 的报告、检查点（三方验收通过的不再按检查点判，验收员已经逐条核对过跳过理由）、必交的结果。
 * 只回文字（没报结果）当作「说做完了」：上限是办成，有没有依据另算
 */
export function judgeByRules(facts: OutcomeFacts): RuleVerdict {
  const limits: Judged[] = []
  const { claim } = facts
  if (claim && claim.outcome !== "achieved")
    limits.push({
      outcome: claim.outcome,
      by: "agent",
      reason: claim.reason?.trim() || claim.summary.trim() || "agent 报的，没写原因",
      failKind: claim.outcome === "partial" ? "partial" : "not_done",
    })
  if (facts.missingResults.length)
    limits.push({ outcome: "not_achieved", by: "rule", reason: `缺结果：${facts.missingResults.join("、")}`, failKind: "missing_result" })
  if (!facts.verified) {
    const limit = checkpointLimit(facts.checkpoints)
    if (limit) limits.push(limit)
  }
  const claimed = Boolean(claim)
  const allDone = facts.checkpoints.length > 0 && facts.checkpoints.every((cp) => cp.status === "done")
  const evidence = Boolean(facts.verified) || (claim?.outcome === "achieved" && allDone)
  if (limits.length === 0) {
    if (facts.verified) return { outcome: "achieved", by: facts.verified.by, reason: facts.verified.headline, evidence, claimed }
    if (evidence) return { outcome: "achieved", by: "rule", reason: `检查点全部达成${claim?.evidence ? `；agent 的依据：${clip(claim.evidence.trim(), 400)}` : ""}`, evidence, claimed }
    return { outcome: "achieved", by: "agent", reason: clip((claim?.evidence ?? claim?.summary ?? "").trim(), 1000), evidence, claimed }
  }
  const lowest = limits.reduce((low, each) => (RUN_OUTCOME_RANK[each.outcome] < RUN_OUTCOME_RANK[low.outcome] ? each : low))
  const same = limits.filter((each) => each.outcome === lowest.outcome)
  // 同样低的几条：原因都写上；谁定的、单记哪种没办成按 agent 报的 > 缺结果 > 检查点（数组本来就是这个顺序）
  return { ...same[0]!, reason: same.map((each) => each.reason).join("；"), evidence, claimed }
}

/** 为什么没复核（写进没核实的原因） */
export type NoReviewWhy = "disabled" | "no_model" | "legacy" | "verified"

const noReviewText: Record<NoReviewWhy, string> = {
  disabled: "任务关了复核",
  no_model: "没配复核模型",
  legacy: "这次运行开始时还没有复核",
  verified: "已有三方验收",
}

/** 不复核时的最终结果：硬规则的结论；办成但没有依据的记没核实 */
export function finalWithoutReview(verdict: RuleVerdict, why: NoReviewWhy): Judged {
  if (verdict.outcome !== "achieved" || verdict.evidence) return pick(verdict)
  return {
    outcome: "unverified",
    by: "rule",
    reason: verdict.claimed
      ? `agent 说办成了，但没有依据：${noReviewText[why]}，也没有全部达成的检查点`
      : `agent 只回了一段文字、没报结果；${noReviewText[why]}`,
  }
}

/** 复核前先写的结果（复核回来再改）：同不复核时 */
export const interimOutcome = (verdict: RuleVerdict): Judged =>
  verdict.outcome === "achieved" && !verdict.evidence
    ? { outcome: "unverified", by: "rule", reason: "等 AI 复核" }
    : pick(verdict)

const pick = ({ outcome, by, reason, failKind }: Judged): Judged => ({ outcome, by, reason, ...(failKind ? { failKind } : {}) })

export type ReviewLevel = "achieved" | "partial" | "not_achieved" | "unsure"

/**
 * 复核以后的最终结果：min(硬规则的结论, 复核结论)，说不准记没核实；复核出错（verdict 为空）记没核实（或者保留更低的）。
 * 复核定了（改低了或者确认了）的记 review，否则保留硬规则那边的来历
 */
export function combineReview(verdict: RuleVerdict, review: { verdict?: ReviewLevel; reason: string; error?: string }): Judged {
  const level: RunOutcome = !review.verdict || review.verdict === "unsure" ? "unverified" : review.verdict
  const outcome = lowerOutcome(verdict.outcome, level)
  if (outcome === verdict.outcome && RUN_OUTCOME_RANK[verdict.outcome] < RUN_OUTCOME_RANK[level]) return pick(verdict)
  const reason = review.error ? `复核出错，没核实：${clip(review.error, 300)}` : review.reason.trim() || `复核判${review.verdict === "unsure" ? "说不准" : runOutcomeLabel[level]}`
  return { outcome, by: "review", reason, ...(outcome === "partial" ? { failKind: "partial" } : outcome === "not_achieved" ? { failKind: "not_done" } : {}) }
}

/** 运行出错、取消、人判失败：结果记没办成，原因就是错误信息 */
export const failedOutcome = (reason: string, by: RunOutcomeBy = "rule") => ({ outcome: "not_achieved" as const, outcomeReason: reason.slice(0, 2000), outcomeBy: by })

/** 被派的运行：必交的结果里，这次运行没用 work.report 交的（快照里冻着声明；旧快照没有 = 不要求） */
export function missingResults(snapshot: Pick<SessionSnapshot, "dispatch">, item: { log: (typeof t.workItems.$inferSelect)["log"]; result: (typeof t.workItems.$inferSelect)["result"] } | undefined, sessionId: string) {
  const required = (snapshot.dispatch?.results ?? []).filter((result) => result.required)
  if (required.length === 0) return []
  const data = item && reportedIn(item.log, sessionId) ? (item.result?.data ?? {}) : {}
  // 字段名宽松一点：agent 常在名字后面加单位（「价格（元）」），去掉末尾的括号、空白、大小写再比
  const filled = new Set(
    Object.entries(data)
      .filter(([, value]) => value !== undefined && value !== null && !(typeof value === "string" && value.trim() === ""))
      .map(([name]) => resultKey(name))
  )
  return required.filter((result) => !filled.has(resultKey(result.name))).map((result) => result.name)
}

/** 比对结果名用：去掉末尾的（…）/ (…)、空白，转小写 */
const resultKey = (name: string) =>
  name
    .trim()
    .replace(/\s*[（(][^（）()]*[）)]\s*$/, "")
    .replace(/\s+/g, "")
    .toLowerCase()

/** 收尾时的事实（在收尾的事务里读）：被派运行报的「办不成」、检查点、必交的结果、三方验收 */
export async function outcomeFactsInTx(tx: Tx, sessionId: string, snapshot: SessionSnapshot, claim: AgentClaim | undefined): Promise<OutcomeFacts> {
  const [row] = await tx.select({ workItemId: t.sessions.workItemId, verification: t.sessions.verification }).from(t.sessions).where(eq(t.sessions.id, sessionId))
  let item: typeof t.workItems.$inferSelect | undefined
  if (row?.workItemId) {
    const [found] = await tx.select().from(t.workItems).where(eq(t.workItems.id, row.workItemId))
    if (found && found.status === "running" && found.sessionId === sessionId) item = found
  }
  // work.report 报了办不成（这次运行报的）：agent 自己报的没办成，比 run.finish 报的办成算数（取最低）
  let effective = claim
  if (item?.failKind === "not_done" && reportedIn(item.log, sessionId) && claim?.outcome !== "not_achieved") {
    const reason = item.error ?? "agent 判断办不成"
    effective = { outcome: "not_achieved", summary: claim?.summary ?? "", reason, via: "work_report" }
  }
  const checkpoints = await tx
    .select({ title: t.checkpoints.title, status: t.checkpoints.status })
    .from(t.checkpoints)
    .where(eq(t.checkpoints.sessionId, sessionId))
    .orderBy(t.checkpoints.position)
  const verification = row?.verification
  const verified =
    verification?.status === "passed" ? { by: verification.resolution?.how === "pass" ? ("human" as const) : ("verify" as const), headline: verification.headline } : undefined
  return { ...(effective ? { claim: effective } : {}), checkpoints, missingResults: missingResults(snapshot, item, sessionId), ...(verified ? { verified } : {}) }
}

/** agent 报告的文字（结束事件的详情、复核的输入） */
export function claimText(claim: AgentClaim | undefined, text: string): string {
  if (!claim) return text
  return [
    `结果：${runOutcomeLabel[claim.outcome]}`,
    claim.summary.trim() ? `总结：${claim.summary.trim()}` : "",
    claim.evidence?.trim() ? `依据：${claim.evidence.trim()}` : "",
    claim.reason?.trim() ? `原因：${claim.reason.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n")
}

/** 结束事件的标题：「agent 报办成」「agent 报办成，规则判没办成」「检查点没达成，结果记没办成」…… */
export function finishTitle(facts: OutcomeFacts, result: Judged, reviewing: boolean): string {
  const label = runOutcomeLabel[result.outcome]
  if (facts.claim) {
    const said = `agent 报${runOutcomeLabel[facts.claim.outcome]}`
    if (reviewing && (facts.claim.outcome === "achieved" || result.outcome === facts.claim.outcome)) return `${said}，等 AI 复核`
    return facts.claim.outcome === result.outcome || result.by === "agent" ? said : `${said}，结果记${label}`
  }
  if (reviewing && result.outcome === "unverified") return "agent 说做完了（没报结果），等 AI 复核"
  if (facts.verified) return result.outcome === "achieved" ? "验收通过，运行结束" : `验收通过，结果记${label}`
  return result.by === "rule" && result.outcome !== "unverified" ? `agent 说做完了，结果记${label}` : "agent 说做完了（没报结果）"
}
