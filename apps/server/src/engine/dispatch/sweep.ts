// 派活：每分钟清扫（work.sweep，pg-boss 的 schedule）。思路同 browser/leases.ts 的 sweepLeases：
// 1. 「在办」的单，运行已经结束了（某处结束时漏写）或者运行没了 → 补写；
// 2. 有到点的排队单（不在等自动重试，或者已经到点）、开着被派活、启用了的任务 → 各发一个 work.pump
//    （漏发的、worker 重启丢的、刚调大名额的、等重试到点的：延迟的 work.pump 丢了也有它兜底）。
// 补写：运行正常结束的按它的结果（run-outcome 6.2）；运行出错的算「运行出错」，自动重试还没用完的回到排队；旧的「没完成」记没办成，不重试。
// 复核还在跑的（sessions.review.pending）先不补写：被派的单等复核完再结算；过了时限（worker 中途没了）按现在的结果结算，
// 复核报告记上「超时没结果」。没被派的运行同样清掉过时的复核标记。
import { ENDED_RUN_STATUSES, isRunEnded, type RunReview } from "@heyagent/shared"
import { and, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { appendEvent } from "../records.js"
import type { Tx } from "../queue.js"
import { REVIEW_PENDING_TIMEOUT_MS } from "../review.js"
import { writeSettled, type SettleOutcome } from "./settle.js"
import { sendPump } from "./signal.js"

/** 复核还在跑、没过时限：先不动 */
const reviewWaiting = (review: RunReview | null | undefined, now = Date.now()) =>
  Boolean(review?.pending) && now - Date.parse(review!.at) < REVIEW_PENDING_TIMEOUT_MS

/** 复核过了时限还没回来：标记清掉，报告写上原因，结果保持现在的（硬规则的结论） */
async function expireReviewInTx(tx: Tx, sessionId: string, review: RunReview) {
  const expired: RunReview = { ...review, pending: undefined, error: `复核 ${REVIEW_PENDING_TIMEOUT_MS / 60_000} 分钟没有结果（worker 可能中途重启了），结果按硬规则的结论` }
  delete expired.pending
  const updated = await tx
    .update(t.sessions)
    .set({ review: expired })
    .where(and(eq(t.sessions.id, sessionId), sql`${t.sessions.review}->>'pending' = 'true'`))
    .returning({ id: t.sessions.id })
  if (updated.length) await appendEvent(tx, sessionId, { kind: "verify", title: "AI 复核超时没有结果，结果按硬规则的结论", detail: expired.error ?? null })
}

/** 运行已经结束、单还在办：按运行的结果补写 */
function settleOutcomeOf(session: { status: string; outcome: string | null; outcomeReason: string | null } | undefined): SettleOutcome {
  if (!session) return { status: "failed", retryable: true, error: "运行记录没了，没法知道办得怎么样" }
  if (session.status === "done") {
    const outcome = (session.outcome ?? "unverified") as NonNullable<SettleOutcome["outcome"]>
    return {
      status: "done",
      outcome,
      ...(session.outcomeReason ? { outcomeReason: session.outcomeReason } : {}),
      // 缺必交结果的原因以「缺结果：」开头（outcome.ts 的 judgeByRules）
      ...(outcome === "not_achieved" && session.outcomeReason?.startsWith("缺结果：") ? { failKind: "missing_result" as const } : {}),
    }
  }
  if (session.status === "incomplete") return { status: "failed", retryable: false, failKind: "not_done" }
  return { status: "failed", retryable: true }
}

export async function sweepWork(db: Db): Promise<{ settled: string[]; pumped: string[] }> {
  // 复核过了时限还没回来的（worker 中途没了）：先清掉标记（结果保持硬规则的结论），下面再结算它们的单。
  // 单独的事务、只锁运行：结算单的事务先锁单，两边不交叉加锁
  const stuck = await db
    .select({ id: t.sessions.id })
    .from(t.sessions)
    .where(and(sql`${t.sessions.review}->>'pending' = 'true'`, sql`(${t.sessions.review}->>'at')::timestamptz < now() - make_interval(secs => ${REVIEW_PENDING_TIMEOUT_MS / 1000})`))
  for (const { id } of stuck)
    await db.transaction(async (tx) => {
      const [row] = await tx.select({ review: t.sessions.review }).from(t.sessions).where(eq(t.sessions.id, id)).for("update")
      if (row?.review?.pending && !reviewWaiting(row.review)) await expireReviewInTx(tx, id, row.review)
    })

  const stale = await db
    .select({ id: t.workItems.id })
    .from(t.workItems)
    .leftJoin(t.sessions, eq(t.sessions.id, t.workItems.sessionId))
    .where(and(eq(t.workItems.status, "running"), or(isNull(t.workItems.sessionId), isNull(t.sessions.id), inArray(t.sessions.status, [...ENDED_RUN_STATUSES]))))
  const settled: string[] = []
  for (const { id } of stale) {
    const done = await db.transaction(async (tx) => {
      // 锁住再看一遍：这期间可能已经被正常的结束回写写过了
      const [item] = await tx.select().from(t.workItems).where(eq(t.workItems.id, id)).for("update")
      if (!item || item.status !== "running") return false
      const [session] = item.sessionId
        ? await tx
            .select({
              id: t.sessions.id,
              status: t.sessions.status,
              error: t.sessions.error,
              verification: t.sessions.verification,
              outcome: t.sessions.outcome,
              outcomeReason: t.sessions.outcomeReason,
              review: t.sessions.review,
            })
            .from(t.sessions)
            .where(eq(t.sessions.id, item.sessionId))
        : []
      if (session && !isRunEnded(session.status)) return false
      // 复核还在跑：等复核完由收尾那边结算（过了时限的上面已经清掉标记）
      if (session?.review?.pending) return false
      await writeSettled(db, tx, item, session ?? null, settleOutcomeOf(session))
      return true
    })
    if (done) settled.push(id)
  }

  const tasks = await db
    .selectDistinct({ id: t.tasks.id })
    .from(t.workItems)
    .innerJoin(t.tasks, eq(t.tasks.id, t.workItems.taskId))
    .where(
      and(
        eq(t.workItems.status, "queued"),
        or(isNull(t.workItems.notBefore), lte(t.workItems.notBefore, sql`now()`)),
        eq(t.tasks.enabled, true),
        isNotNull(t.tasks.dispatch),
        sql`${t.tasks.dispatch} <> 'null'::jsonb`
      )
    )
  for (const task of tasks) await sendPump(db, task.id)
  if (settled.length) console.log(`[work] 清扫：补写了 ${settled.length} 张单的结束（${settled.join("、")}）`)
  return { settled, pumped: tasks.map((task) => task.id) }
}
