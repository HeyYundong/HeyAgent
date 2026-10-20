// 对「没核实」的已结束运行补跑轻量复核（docs/dev/run-outcome.md 第 7 节）。
//
// 用法（开发机：pnpm --filter @heyagent/server outcome:review [--limit 200] [--yes]；容器里：node dist/scripts/outcome-review.js …）：
//   不带 --yes：只列出有多少条、用哪个复核模型、预计花多少钱，不调模型
//   --yes：真跑。默认最多 200 条（最近结束的在前），--limit 改
//
// 复核结论只写结果列（outcome / outcome_reason / outcome_by、复核报告 review）和一条过程记录；被派的单只跟着改结果。
// 不改运行和单的状态，不发通知，不叫醒派活方。复核只能往低判：没核实的上限是「办成」（agent 当时说做完了）。
// 复核的花费只记在复核报告里，不加进运行的花费（运行早就结束了）。
import { pathToFileURL } from "node:url"

import { runOutcomeLabel, type RunOutcome } from "@heyagent/shared"
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"

import { createDb, type Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { env } from "../env.js"
import { lastAssistantText } from "../engine/dispatch/settle.js"
import { combineReview, type RuleVerdict } from "../engine/outcome.js"
import { appendEvent } from "../engine/records.js"
import { performReview, reviewEventTitle, reviewModelFor } from "../engine/review.js"

/** 粗估一次复核的用量：文字（目标、检查点、报告、最近 30 条过程、产物摘录）加一张截图 */
export const ESTIMATE_TOKENS_IN = 10_000
export const ESTIMATE_TOKENS_OUT = 300

export interface ReviewBacklogItem {
  id: string
  modelId: string
}

/** 要补复核的运行：已结束、结果没核实、不在复核中；最近结束的在前 */
export async function reviewBacklog(db: Db, limit: number): Promise<{ total: number; items: ReviewBacklogItem[]; missingModel: number }> {
  const where = and(eq(t.sessions.status, "done"), eq(t.sessions.outcome, "unverified"), isNotNull(t.sessions.snapshot), sql`coalesce(${t.sessions.review}->>'pending', 'false') <> 'true'`)
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(t.sessions).where(where)
  const rows = await db.select({ id: t.sessions.id, snapshot: t.sessions.snapshot }).from(t.sessions).where(where).orderBy(desc(t.sessions.endedAt), desc(t.sessions.id)).limit(limit)
  const items: ReviewBacklogItem[] = []
  let missingModel = 0
  for (const row of rows) {
    const modelId = await reviewModelFor(db, row.snapshot ?? {})
    if (modelId) items.push({ id: row.id, modelId })
    else missingModel++
  }
  return { total: count?.n ?? 0, items, missingModel }
}

/** 按模型的价格估花费（美元） */
export async function estimateCost(db: Db, items: ReviewBacklogItem[]): Promise<{ usd: number; byModel: { modelId: string; runs: number; usd: number; priced: boolean }[] }> {
  const ids = [...new Set(items.map((item) => item.modelId))]
  const models = ids.length ? await db.select({ id: t.models.id, priceIn: t.models.priceIn, priceOut: t.models.priceOut }).from(t.models).where(inArray(t.models.id, ids)) : []
  const byModel = ids.map((modelId) => {
    const runs = items.filter((item) => item.modelId === modelId).length
    const model = models.find((each) => each.id === modelId)
    const usd = model ? (runs * (ESTIMATE_TOKENS_IN * model.priceIn + ESTIMATE_TOKENS_OUT * model.priceOut)) / 1_000_000 : 0
    return { modelId, runs, usd, priced: Boolean(model && (model.priceIn || model.priceOut)) }
  })
  return { usd: byModel.reduce((sum, each) => sum + each.usd, 0), byModel }
}

/** 复核一条：只写结果列、复核报告、过程记录；被派的单（还是这次运行的、已经结束的）跟着改结果 */
export async function reviewOne(db: Db, item: ReviewBacklogItem): Promise<{ outcome: RunOutcome; costUsd: number; error?: string } | undefined> {
  const [session] = await db.select().from(t.sessions).where(eq(t.sessions.id, item.id))
  if (!session?.snapshot || session.status !== "done" || session.outcome !== "unverified") return undefined
  // agent 当时的报告：最后一条结束事件的详情（新运行里有 run.finish 的总结和依据），没有就用最后一段文字
  const [done] = await db
    .select({ detail: t.sessionEvents.detail })
    .from(t.sessionEvents)
    .where(and(eq(t.sessionEvents.sessionId, session.id), eq(t.sessionEvents.kind, "done")))
    .orderBy(desc(t.sessionEvents.seq))
    .limit(1)
  const report = done?.detail || (await lastAssistantText(db, session.id))
  const review = await performReview(db, { session, snapshot: session.snapshot, modelId: item.modelId, report })
  // 没核实的上限是办成（agent 说做完了、规则没压低）；复核只能往低判
  const ceiling: RuleVerdict = { outcome: "achieved", by: session.outcomeBy ?? "rule", reason: session.outcomeReason ?? "", evidence: false, claimed: true }
  const final = combineReview(ceiling, review)
  const written = await db.transaction(async (tx) => {
    const updated = await tx
      .update(t.sessions)
      .set({ outcome: final.outcome, outcomeReason: final.reason.slice(0, 2000) || null, outcomeBy: final.by, review })
      // 这期间人改过结果的（outcome 不再是没核实）不覆盖
      .where(and(eq(t.sessions.id, session.id), eq(t.sessions.outcome, "unverified")))
      .returning({ id: t.sessions.id })
    if (updated.length === 0) return false
    await appendEvent(tx, session.id, {
      kind: "verify",
      title: `${reviewEventTitle(review, final.outcome)}（命令补跑）`,
      detail: review.error ? `复核模型 ${review.modelId} 出错：${review.error}` : `${review.reason}\n（命令 outcome:review 补跑，花费 ${review.costUsd.toFixed(6)} 美元，只记在复核报告里）`,
    })
    if (session.workItemId)
      await tx
        .update(t.workItems)
        .set({ outcome: final.outcome, outcomeReason: final.reason.slice(0, 2000) || null, updatedAt: new Date() })
        .where(and(eq(t.workItems.id, session.workItemId), eq(t.workItems.sessionId, session.id), inArray(t.workItems.status, ["done", "failed"])))
    return true
  })
  if (!written) return undefined
  return { outcome: final.outcome, costUsd: review.costUsd, ...(review.error ? { error: review.error } : {}) }
}

function parseArgs(argv: string[]) {
  const yes = argv.includes("--yes")
  const at = argv.indexOf("--limit")
  const limit = at >= 0 ? Number(argv[at + 1]) : 200
  if (!Number.isInteger(limit) || limit <= 0) throw new Error("--limit 要是正整数")
  return { yes, limit }
}

async function main() {
  const { yes, limit } = parseArgs(process.argv.slice(2))
  const { db, pool } = createDb(env.databaseUrl, 2)
  try {
    const backlog = await reviewBacklog(db, limit)
    if (backlog.total === 0) return console.log("没有要补复核的运行（已结束、结果没核实的）")
    const estimate = await estimateCost(db, backlog.items)
    console.log(`没核实的已结束运行一共 ${backlog.total} 条，这次${backlog.total > limit ? `取最近结束的 ${limit} 条` : "全部"}：能复核 ${backlog.items.length} 条${backlog.missingModel ? `，${backlog.missingModel} 条没有复核模型（任务没选、「模型」页也没设默认复核模型），跳过` : ""}。`)
    for (const each of estimate.byModel)
      console.log(`  ${each.modelId}：${each.runs} 条，预计 ${each.priced ? `${each.usd.toFixed(4)} 美元` : "（模型列表里没有价格，估不出来）"}`)
    console.log(`预计一共 ${estimate.usd.toFixed(4)} 美元（每条按输入 ${ESTIMATE_TOKENS_IN} token、输出 ${ESTIMATE_TOKENS_OUT} token 估）。`)
    if (!yes) return console.log("加 --yes 才真跑。")
    const tally = new Map<RunOutcome | "skipped" | "error", number>()
    let spent = 0
    for (const [index, item] of backlog.items.entries()) {
      const result = await reviewOne(db, item)
      const key = !result ? "skipped" : result.error ? "error" : result.outcome
      tally.set(key, (tally.get(key) ?? 0) + 1)
      spent += result?.costUsd ?? 0
      console.log(`  [${index + 1}/${backlog.items.length}] ${item.id}：${!result ? "跳过（已经不是没核实了）" : result.error ? `复核出错：${result.error}` : runOutcomeLabel[result.outcome]}`)
    }
    const label = (key: string) => (key === "skipped" ? "跳过" : key === "error" ? "出错" : runOutcomeLabel[key as RunOutcome])
    console.log(`做完了：${[...tally.entries()].map(([key, n]) => `${label(key)} ${n}`).join("、")}；实际花费 ${spent.toFixed(6)} 美元。`)
  } finally {
    await pool.end()
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main()
