// 运行结果（docs/dev/run-outcome.md 第 2、4 节）：状态只管流程，结果单独一列，只有办成 / 没办成（2026-10-20 简化）。
// 收尾时先过硬规则：agent 的报告（run.finish / 旧的 run.not_done / work.report not_done）、检查点、被派运行必交的结果，有一条不过就是没办成；
// 三方验收通过的直接办成。其余的（agent 说办成了）都要复核（review.ts），复核也判办成才算办成；证据不足、复核出错、没有复核模型都记没办成。
// 这里的判断是纯函数（judgeByRules / combineReview / noReviewModel），事实在收尾的事务里读（outcomeFactsInTx）。
import { reviewVerdictLabel, runOutcomeLabel, type ReviewVerdict, type RunOutcome, type RunOutcomeBy, type SessionSnapshot, type WorkFailKind } from "@heyagent/shared"
import { eq } from "drizzle-orm"

import * as t from "../db/schema.js"
import { reportedIn } from "./dispatch/settle.js"
import type { Tx } from "./queue.js"

/** agent 自己报的结果：run.finish、旧快照里的 run.not_done（= not_achieved）、被派运行的 work.report not_done */
export interface AgentClaim {
  outcome: RunOutcome
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
  /** 被派的单没办成时记成哪种（not_done / missing_result） */
  failKind?: WorkFailKind
}

/**
 * 硬规则的结论：outcome = not_achieved 是定论（不再复核）；achieved 时 final = 三方验收通过（定论），否则要等复核。
 * claimed = agent 用 run.finish 报了结果（没报、只回一段文字的为 false）
 */
export interface RuleVerdict extends Judged {
  final: boolean
  claimed: boolean
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}…` : value)

/**
 * 检查点的约束：有没达成的 → 没办成；全部达成不压低。没有检查点不管。
 * 跳过的（部分跳过、全部跳过）不在这里判（2026-10-22 起）：跳过理由站不站得住、影不影响目标交给复核按目标判
 */
function checkpointLimit(checkpoints: OutcomeFacts["checkpoints"]): Judged | undefined {
  const open = checkpoints.filter((cp) => cp.status === "open")
  if (open.length) return { outcome: "not_achieved", by: "rule", reason: `${open.length} 个检查点没达成：${open.map((cp) => cp.title).join("、")}`, failKind: "not_done" }
  return undefined
}

/**
 * 硬规则（第 4 节）：agent 的报告、检查点有没达成的（三方验收通过的不再按检查点判）、必交的结果，
 * 有一条不过就是没办成（原因都写上）。都过了：三方验收通过 = 办成（定论）；否则上限是办成，等复核。
 * 只回文字（没报结果）当作「说做完了」
 */
export function judgeByRules(facts: OutcomeFacts): RuleVerdict {
  const limits: Judged[] = []
  const { claim } = facts
  const claimed = Boolean(claim)
  if (claim && claim.outcome !== "achieved")
    limits.push({ outcome: "not_achieved", by: "agent", reason: claim.reason?.trim() || claim.summary.trim() || "agent 报的，没写原因", failKind: "not_done" })
  if (facts.missingResults.length)
    limits.push({ outcome: "not_achieved", by: "rule", reason: `缺结果：${facts.missingResults.join("、")}`, failKind: "missing_result" })
  if (!facts.verified) {
    const limit = checkpointLimit(facts.checkpoints)
    if (limit) limits.push(limit)
  }
  if (limits.length) {
    // 几条都写上原因；谁定的、单记哪种没办成按 agent 报的 > 缺结果 > 检查点（数组本来就是这个顺序）
    return { ...limits[0]!, reason: limits.map((each) => each.reason).join("；"), final: true, claimed }
  }
  if (facts.verified) return { outcome: "achieved", by: facts.verified.by, reason: facts.verified.headline, final: true, claimed }
  return { outcome: "achieved", by: "agent", reason: clip((claim?.evidence ?? claim?.summary ?? "").trim(), 1000), final: false, claimed }
}

const pick = ({ outcome, by, reason, failKind }: Judged): Judged => ({ outcome, by, reason, ...(failKind ? { failKind } : {}) })

/** 硬规则已经是定论（没办成，或者三方验收通过）时的最终结果 */
export const finalByRules = (verdict: RuleVerdict): Judged => pick(verdict)

/** 要复核、却没有复核模型（任务没选、也没有默认复核模型）：没办成 */
export const noReviewModel = (): Judged => ({ outcome: "not_achieved", by: "rule", reason: "没配复核模型，没能确认办成", failKind: "not_done" })

/**
 * 复核以后的最终结果：硬规则说办成、复核也判办成才算办成。复核判没办成（旧报告的部分办成、说不准也一样）记没办成；
 * 复核出错（verdict 为空，重试过一次）记没办成。复核只在硬规则说办成时跑，所以结果都是复核定的
 */
export function combineReview(review: { verdict?: ReviewVerdict; reason: string; error?: string }): Judged {
  if (!review.verdict) return { outcome: "not_achieved", by: "review", reason: `复核出错，没能确认办成：${clip(review.error ?? "没有结果", 300)}`, failKind: "not_done" }
  if (review.verdict === "achieved") return { outcome: "achieved", by: "review", reason: review.reason.trim() || "复核判办成" }
  return { outcome: "not_achieved", by: "review", reason: review.reason.trim() || `复核判${reviewVerdictLabel[review.verdict]}`, failKind: "not_done" }
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

/** 结束事件的标题：「agent 报办成，等 AI 复核」「agent 报办成，结果记没办成」「检查点…，结果记没办成」…… */
export function finishTitle(facts: OutcomeFacts, result: Judged | undefined): string {
  if (facts.claim) {
    const said = `agent 报${runOutcomeLabel[facts.claim.outcome]}`
    if (!result) return `${said}，等 AI 复核`
    return facts.claim.outcome === result.outcome || result.by === "agent" ? said : `${said}，结果记${runOutcomeLabel[result.outcome]}`
  }
  if (!result) return "agent 说做完了（没报结果），等 AI 复核"
  if (facts.verified) return result.outcome === "achieved" ? "验收通过，运行结束" : `验收通过，结果记${runOutcomeLabel[result.outcome]}`
  return `agent 说做完了（没报结果），结果记${runOutcomeLabel[result.outcome]}`
}
