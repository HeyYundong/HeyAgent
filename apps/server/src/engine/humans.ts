// 要人办的事：ask.human、花费 / 步数上限转人工、规则拦下的工具调用（审批）、验收争议。
// 处理完（批准 / 拒绝 / 已处理 + 备注）就继续对应的 session：
// - 普通请示：把处理结果和备注告诉 agent；
// - 花费 / 步数上限、规则「花费超过 X」：批准就继续，拒绝就结束运行；
// - 审批工具调用（M3）：批准 = 执行那次调用接着跑，拒绝 = 把「被拒绝：理由」作为工具结果交给 agent（结果由引擎继续时写，消息顺序才合法）；
// - 验收争议（M3）：算通过 / 算失败 / 补充说明后继续。
import { and, eq, sql } from "drizzle-orm"
import {
  HUMAN_ITEM_PREFIX,
  humanItemId,
  type HumanDetail,
  type HumanItemKind,
  type HumanResolution,
} from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import type { PendingToolCalls } from "../db/schema.js"
import { notifyUsers, TODOS_LINK } from "./notify.js"
import type { Tx } from "./queue.js"
import { appendEvent, writeAudit } from "./records.js"
import { settleWorkItemInTx } from "./dispatch/settle.js"
import { failedOutcome, judgeByRules, outcomeFactsInTx, type Judged } from "./outcome.js"
import { EngineError } from "./sessions.js"
import { loadEngineSettings } from "./settings.js"
import { resumeInTx, suspendInTx } from "./waits.js"

export interface CreateHumanItemInput {
  kind: HumanItemKind
  title: string
  summary: string
  assigneeId: string
  taskId?: string | null
  sessionId?: string | null
  ruleId?: string | null
  memoryId?: string | null
  skillId?: string | null
  urgency?: number
  detail: HumanDetail
}

export async function createHumanItem(
  tx: Tx | Db,
  input: CreateHumanItemInput
) {
  const result = await tx.execute<{ n: string }>(
    sql`select nextval('human_item_no_seq') as n`
  )
  const n = Number(result.rows[0]!.n)
  const id = humanItemId(input.kind as keyof typeof HUMAN_ITEM_PREFIX, n)
  const [row] = await tx
    .insert(t.humanItems)
    .values({
      id,
      kind: input.kind,
      title: input.title.slice(0, 200),
      summary: input.summary.slice(0, 1000),
      assigneeId: input.assigneeId,
      taskId: input.taskId ?? null,
      sessionId: input.sessionId ?? null,
      ruleId: input.ruleId ?? null,
      memoryId: input.memoryId ?? null,
      skillId: input.skillId ?? null,
      urgency: input.urgency ?? 3,
      detail: input.detail,
    })
    .returning()
  return row!
}

/** 「要人办的事」挂起：生成待办里的一件事，session 进入「等人处理」。在调用方的事务里 */
export async function askHumanInTx(
  db: Db,
  tx: Tx,
  input: CreateHumanItemInput & {
    sessionId: string
    what: string
    limitKind?: "cost" | "steps"
    /** 规则「花费超过 X → 交给人决定」：拒绝就结束运行（值是规则 id） */
    stopOnReject?: string
    /** 等审批的工具调用（M3） */
    pending?: PendingToolCalls
    /** session 现在的状态（默认只从「执行中」挂起；验收争议从「验收中」挂起） */
    fromStatuses?: ("running" | "verifying")[]
  }
): Promise<{ itemId: string } | undefined> {
  const item = await createHumanItem(tx, input)
  const settings = await loadEngineSettings(tx)
  const wait = await suspendInTx(db, tx, {
    sessionId: input.sessionId,
    status: "needs_human",
    what: input.what,
    triggerKind: "event",
    event: `等 ${item.id} 处理`,
    fallbackDays: settings.eventFallbackDays,
    humanItemId: item.id,
    match: input.limitKind
      ? { limit: input.limitKind }
      : input.stopOnReject
        ? { ruleStop: input.stopOnReject }
        : null,
    pending: input.pending ?? null,
    fromStatuses: input.fromStatuses,
  })
  if (!wait) return undefined
  await appendEvent(tx, input.sessionId, {
    kind: "human",
    title: `交给人处理：${input.title}`,
    detail: input.summary,
  })
  return { itemId: item.id }
}

const resolutionText: Record<HumanResolution, string> = {
  approve: "批准",
  reject: "拒绝",
  done: "已处理",
}

export interface ResolveInput {
  itemId: string
  how: HumanResolution
  note?: string
  actorId: string
  actorName: string
}

/** 处理一件事；关联的 session 在等它就继续（花费 / 步数上限的：同意就调高上限继续，拒绝就结束运行） */
export async function resolveHumanItemImpl(
  db: Db,
  input: ResolveInput
): Promise<{ resumedSessionId?: string; endedSessionId?: string }> {
  const [item] = await db
    .select()
    .from(t.humanItems)
    .where(eq(t.humanItems.id, input.itemId))
  if (!item) throw new EngineError("NOT_FOUND", `找不到待办 ${input.itemId}`)
  if (item.kind === "memory" || item.kind === "skill")
    throw new EngineError(
      "BAD_REQUEST",
      "记忆审核、技能修改请在记忆页、技能页处理"
    )
  const note = input.note?.trim()
  if (item.kind === "verify")
    return resolveVerifyDisputeImpl(db, {
      itemId: item.id,
      how:
        input.how === "approve"
          ? "pass"
          : input.how === "reject"
            ? "fail"
            : "continue",
      note,
      actorId: input.actorId,
      actorName: input.actorName,
    })
  const result = await db.transaction(async (tx) => {
    const [wait] = item.sessionId
      ? await tx
          .select()
          .from(t.sessionWaits)
          .where(
            and(
              eq(t.sessionWaits.humanItemId, item.id),
              eq(t.sessionWaits.status, "waiting")
            )
          )
      : []
    const pending = wait?.pending ?? undefined
    if (pending && input.how === "done")
      throw new EngineError("BAD_REQUEST", "审批工具调用只能批准或拒绝")
    const updated = await tx
      .update(t.humanItems)
      .set({
        status: "resolved",
        resolution: { how: input.how, note },
        resolvedById: input.actorId,
        resolvedAt: new Date(),
      })
      .where(and(eq(t.humanItems.id, item.id), eq(t.humanItems.status, "open")))
      .returning({ id: t.humanItems.id })
    if (updated.length === 0)
      throw new EngineError("CONFLICT", "这件事已经处理过了")
    await writeAudit(tx, {
      actorId: input.actorId,
      action: "human_item.resolve",
      targetTable: "human_items",
      targetId: item.id,
      detail: { how: input.how, note },
    })
    if (!item.sessionId) return {}
    await appendEvent(tx, item.sessionId, {
      kind: "human",
      title: `${input.actorName}${resolutionText[input.how]}了「${item.title}」`,
      detail: note ? `备注：${note}` : null,
    })
    if (!wait) return {}

    // 审批工具调用：把决定记在等待上，继续时由引擎先处理那次调用（批准就执行，拒绝就告诉 agent）
    if (pending) {
      const decided: PendingToolCalls = {
        ...pending,
        decision: {
          how: input.how === "approve" ? "approve" : "reject",
          note,
          actorName: input.actorName,
        },
      }
      await tx
        .update(t.sessionWaits)
        .set({ pending: decided })
        .where(eq(t.sessionWaits.id, wait.id))
      const resumed = await resumeInTx(db, tx, {
        waitId: wait.id,
        cause: "human",
        title:
          input.how === "approve"
            ? `${input.actorName}批准了，执行这次调用`
            : `${input.actorName}拒绝了，告诉 agent`,
        message: "",
        actorId: input.actorId,
      })
      return resumed ? { resumedSessionId: resumed } : {}
    }

    const match = wait.match as {
      limit?: "cost" | "steps"
      ruleStop?: string
    } | null
    const limit = match?.limit
    if ((limit || match?.ruleStop) && input.how === "reject") {
      await tx
        .update(t.sessionWaits)
        .set({ status: "cancelled", firedCause: "human", firedAt: new Date() })
        .where(eq(t.sessionWaits.id, wait.id))
      await appendEvent(tx, item.sessionId, {
        kind: "error",
        title: "负责人决定不继续，运行结束",
        detail: note ?? null,
      })
      const error = limit
        ? `${limit === "cost" ? "花费" : "步数"}到了上限，${input.actorName}决定不继续`
        : `${item.title}：${input.actorName}决定不继续`
      await tx
        .update(t.sessions)
        .set({ status: "failed", endedAt: new Date(), error, ...failedOutcome(error, "human") })
        .where(eq(t.sessions.id, item.sessionId))
      // 被派的运行：派活单跟着记「没办成」，人选了不继续的不自动重试
      await settleWorkItemInTx(db, tx, item.sessionId, { status: "failed", error, retryable: false, failKind: "cancelled_run" })
      return { endedSessionId: item.sessionId }
    }
    let sessionPatch: Partial<typeof t.sessions.$inferInsert> | undefined
    if (limit) {
      // 同意继续：在现在的基础上再给一份默认额度；最多步数现在设成 0（不限）的话，这个 session 也不再限步数
      const [session] = await tx
        .select()
        .from(t.sessions)
        .where(eq(t.sessions.id, item.sessionId))
      const settings = await loadEngineSettings(tx)
      sessionPatch =
        limit === "cost"
          ? { costLimitUsd: Number(session!.costUsd) + settings.maxCostUsd }
          : { maxSteps: settings.maxSteps > 0 ? session!.stepCount + settings.maxSteps : null }
    }
    const message = limit
      ? `${input.actorName}同意继续（${limit === "cost" ? "花费" : "步数"}上限已调高）。${note ? `备注：${note}` : ""}`
      : match?.ruleStop
        ? `${input.actorName}同意继续（规则要求的花费确认已通过）。${note ? `备注：${note}` : ""}`
        : `${input.actorName}处理了你提的事「${item.title}」：${resolutionText[input.how]}。${note ? `备注：${note}` : "没有备注。"}`
    const resumed = await resumeInTx(db, tx, {
      waitId: wait.id,
      cause: "human",
      title: "人处理完，继续",
      message,
      actorId: input.actorId,
      sessionPatch,
    })
    return resumed ? { resumedSessionId: resumed } : {}
  })
  return result
}

/**
 * 验收争议（M3）：负责人看了验收报告后的三种处理。
 * - pass 算通过：session 标「已完成」，验收结论改成通过（写上是谁判的）；
 * - fail 算失败：session 标「失败」，原因写清楚；
 * - continue 补充说明后继续：带着说明回到同一个 session 接着干（之后 agent 再说做完了，验收从第 1 轮重新数）。
 */
export async function resolveVerifyDisputeImpl(
  db: Db,
  input: {
    itemId: string
    how: "pass" | "fail" | "continue"
    note?: string
    actorId: string
    actorName: string
  }
): Promise<{ resumedSessionId?: string; endedSessionId?: string }> {
  const [item] = await db
    .select()
    .from(t.humanItems)
    .where(eq(t.humanItems.id, input.itemId))
  if (!item) throw new EngineError("NOT_FOUND", `找不到待办 ${input.itemId}`)
  if (item.kind !== "verify")
    throw new EngineError("BAD_REQUEST", "这件事不是验收争议")
  const note = input.note?.trim() || undefined
  if (input.how === "continue" && !note)
    throw new EngineError(
      "BAD_REQUEST",
      "「补充说明后继续」要写上说明，agent 会照着做"
    )
  const howText = {
    pass: "算通过",
    fail: "算失败",
    continue: "补充说明后继续",
  }[input.how]
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(t.humanItems)
      .set({
        status: "resolved",
        resolution: { how: input.how, note },
        resolvedById: input.actorId,
        resolvedAt: new Date(),
      })
      .where(and(eq(t.humanItems.id, item.id), eq(t.humanItems.status, "open")))
      .returning({ id: t.humanItems.id })
    if (updated.length === 0)
      throw new EngineError("CONFLICT", "这件事已经处理过了")
    await writeAudit(tx, {
      actorId: input.actorId,
      action: "human_item.resolve",
      targetTable: "human_items",
      targetId: item.id,
      detail: { how: input.how, note, kind: "verify" },
    })
    if (!item.sessionId) return {}
    const sessionId = item.sessionId
    const [session] = await tx
      .select()
      .from(t.sessions)
      .where(eq(t.sessions.id, sessionId))
    const [wait] = await tx
      .select()
      .from(t.sessionWaits)
      .where(
        and(
          eq(t.sessionWaits.humanItemId, item.id),
          eq(t.sessionWaits.status, "waiting")
        )
      )
    await appendEvent(tx, sessionId, {
      kind: "human",
      title: `${input.actorName}处理验收争议：${howText}`,
      detail: note ? `说明：${note}` : null,
    })
    if (!session || !wait) return {}
    const resolution = {
      how: input.how,
      byId: input.actorId,
      byName: input.actorName,
      note,
      at: new Date().toISOString(),
    }
    const previous = session.verification
    const verification = previous
      ? {
          ...previous,
          ...(input.how === "pass"
            ? {
                status: "passed" as const,
                headline: `${input.actorName}判定通过：${previous.headline}`,
              }
            : {}),
          resolution,
        }
      : undefined
    if (input.how === "continue") {
      await tx
        .update(t.sessions)
        .set({ verification })
        .where(eq(t.sessions.id, sessionId))
      const resumed = await resumeInTx(db, tx, {
        waitId: wait.id,
        cause: "human",
        title: `${input.actorName}补充了说明，接着干`,
        message: `${input.actorName}看了三方验收的报告，补充说明：${note}\n请按说明继续，做完再回复总结（会重新验收）。`,
        actorId: input.actorId,
      })
      return resumed ? { resumedSessionId: resumed } : {}
    }
    // 先写过程记录，再写最终状态
    await tx
      .update(t.sessionWaits)
      .set({ status: "fired", firedCause: "human", firedAt: new Date() })
      .where(eq(t.sessionWaits.id, wait.id))
    await appendEvent(tx, sessionId, {
      kind: input.how === "pass" ? "done" : "error",
      title:
        input.how === "pass"
          ? `${input.actorName}判定验收通过，运行完成`
          : `${input.actorName}判定验收不通过，运行失败`,
      detail: note ?? null,
    })
    // 判通过：结果照硬规则（验收通过的不再按检查点判；缺必交的结果照样没办成），不再复核；判失败：结果没办成（人判的）
    const failError = `验收没通过，${input.actorName}判定失败${note ? `：${note}` : ""}`
    let judged: Judged | undefined
    if (input.how === "pass" && session.snapshot) {
      const facts = await outcomeFactsInTx(tx, sessionId, session.snapshot, undefined)
      judged = judgeByRules({ ...facts, verified: { by: "human", headline: verification?.headline ?? `${input.actorName}判定验收通过` } })
    }
    const done = await tx
      .update(t.sessions)
      .set({
        status: input.how === "pass" ? "done" : "failed",
        endedAt: new Date(),
        verification,
        ...(input.how === "fail"
          ? { error: failError, ...failedOutcome(failError, "human") }
          : judged
            ? { outcome: judged.outcome, outcomeReason: judged.reason.slice(0, 2000), outcomeBy: judged.by }
            : { outcome: "achieved" as const, outcomeReason: `${input.actorName}判定验收通过`, outcomeBy: "human" as const }),
      })
      .where(
        and(eq(t.sessions.id, sessionId), eq(t.sessions.status, "needs_human"))
      )
      .returning({ id: t.sessions.id })
    if (done.length === 0) return {}
    // 被派的运行：判通过 = 派活单按结果结算（总结取 agent 最后那段），判失败 = 没办成（人判的，不自动重试）
    await settleWorkItemInTx(
      db,
      tx,
      sessionId,
      input.how === "pass"
        ? { status: "done", outcome: judged?.outcome ?? "achieved", ...(judged ? { outcomeReason: judged.reason } : {}), ...(judged?.failKind ? { failKind: judged.failKind } : {}) }
        : { status: "failed", error: failError, retryable: false, failKind: "cancelled_run" }
    )
    return { endedSessionId: sessionId }
  })
}

/** 给负责人发「有一件事等你处理」的通知 */
export async function notifyAssignee(
  db: Db,
  item: {
    id: string
    title: string
    summary: string
    assigneeId: string
    taskId?: string | null
    sessionId?: string | null
  }
) {
  await notifyUsers(db, {
    userIds: [item.assigneeId],
    title: `等你处理：${item.title}`,
    body: item.summary,
    link: TODOS_LINK,
    taskId: item.taskId,
    sessionId: item.sessionId,
  })
}
