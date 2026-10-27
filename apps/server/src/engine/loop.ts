// agent 循环：读快照和完整消息历史 → 调模型 → 工具网关 → 落库 → 再调模型……
// 直到 agent 报结果（run.finish；旧快照的 run.not_done）、只回文字（提醒一次报结果，再回文字就按没报结果收尾；
// 说做完了的先过三方验收）、某个工具让 session 挂起、规则要求审批、触发上限（转人工），或者出错（重试后标失败）。
// 状态只管流程（docs/dev/run-outcome.md）：正常结束都记「已结束」（done），办没办成看结果列（outcome.ts 的硬规则 + review.ts 的复核）。
// 每一步都先落库再继续，进程随时被杀掉都能从库里接着跑（同一个 session id）。
// 结束时的顺序：最终结论确定后，先关资源（工具连接、Chrome），再写过程记录，最后写最终状态；复核在收尾的事务之后跑。
// 固化（docs/dev/solidify.md 6.3）：快照里有固化流程的，先在沙箱里跑脚本（routine/runtime/run.ts），跑通了照常收尾、不调执行模型；
// 跑不通追加一段交接的话，进 agent 循环（同一个网关、同一个 Chrome）。固化试跑（kind = routine_test）只跑脚本，结束后交给固化（routine.compile）。
import { setTimeout as sleep } from "node:timers/promises"

import type { ModelMessage, ToolResultPart } from "ai"
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import {
  RUN_FINISH_TOOL_ID,
  routineInputOf,
  routineStopKindLabel,
  runOutcomeLabel,
  type HumanDetail,
  type RunReview,
  type SessionRoutineState,
  type SessionSnapshot,
  type WorkFailKind,
} from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import type { PendingToolCalls } from "../db/schema.js"
import { sendRoutineCompile } from "../routine/jobs.js"
import { buildHandoff } from "../routine/runtime/handoff.js"
import { runRoutineScript, type RoutineSnapshotted } from "../routine/runtime/run.js"
import { settleRoutineRun } from "../routine/runtime/stats.js"
import { endRoutineTestInTx } from "../routine/runtime/test-end.js"
import { maybeCompact } from "./compact.js"
import {
  ToolGateway,
  type GatewayResult,
  type ModelToolCall,
} from "./gateway.js"
import { runBeforeStepHooks, runFinishHooks, runStartHooks } from "./hooks.js"
import { askHumanInTx, notifyAssignee } from "./humans.js"
import {
  callModel,
  isRetryable,
  ModelConfigError,
  resolveModel,
  type ModelCallResult,
  type ResolvedModel,
} from "./model.js"
import { notifyUsers, sessionLink } from "./notify.js"
import { buildSystemPrompt } from "./prompt.js"
import { QUEUES, bossFor, runJobOptions } from "./queue.js"
import { appendEvent, appendMessage, loadMessages } from "./records.js"
import { runtime } from "./runtime.js"
import { maskSecretFields } from "./secrets.js"
import { loadEngineSettings } from "./settings.js"
import type { SessionRow, ToolOutcome } from "./tools/builtin.js"
import { recheckWorkDoneAfterSuspend } from "./dispatch/notify.js"
import { settleWorkItemInTx } from "./dispatch/settle.js"
import {
  claimText,
  combineReview,
  failedOutcome,
  finalByRules,
  finishTitle,
  judgeByRules,
  noReviewModel,
  outcomeFactsInTx,
  type AgentClaim,
  type Judged,
} from "./outcome.js"
import { pendingReview, performReview, reviewEventTitle, reviewModelFor } from "./review.js"
import { suspendInTx } from "./waits.js"

/** 这次 runSession 怎么停下的（不是运行的结果：结果在 sessions.outcome） */
export type RunOutcome =
  "done" | "suspended" | "failed" | "handoff" | "stopped" | "skipped"

export interface RunOptions {
  signal?: AbortSignal
}

const toolResult = (
  toolCallId: string,
  toolName: string,
  output: string,
  isError?: boolean
): ModelMessage => ({
  role: "tool",
  content: [
    {
      type: "tool-result",
      toolCallId,
      toolName,
      output: isError
        ? { type: "error-text", value: output }
        : { type: "text", value: output },
    } satisfies ToolResultPart,
  ],
})

/** 进程中途被杀掉时，最后一条 assistant 消息里可能有还没写结果的工具调用：补上「中断」的结果，消息历史才合法 */
async function repairDanglingCalls(
  db: Db,
  sessionId: string,
  messages: ModelMessage[]
) {
  let lastAssistant = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.role === "assistant") {
      lastAssistant = i
      break
    }
  }
  if (lastAssistant < 0) return messages
  const assistant = messages[lastAssistant]!
  if (!Array.isArray(assistant.content)) return messages
  const answered = new Set(
    messages
      .slice(lastAssistant + 1)
      .filter((message) => message.role === "tool")
      .flatMap((message) =>
        (message.content as ToolResultPart[]).map((part) => part.toolCallId)
      )
  )
  const repaired = [...messages]
  for (const part of assistant.content) {
    if (part.type !== "tool-call" || answered.has(part.toolCallId)) continue
    const message = toolResult(
      part.toolCallId,
      part.toolName,
      "这次工具调用被中断了（worker 重启），不确定有没有执行成功。需要的话先确认现状，再决定要不要重新调用。",
      true
    )
    await appendMessage(db, sessionId, message)
    await appendEvent(db, sessionId, {
      kind: "error",
      title: "工具调用被中断",
      detail: `worker 重启前没来得及记下 ${part.toolName} 的结果`,
    })
    repaired.splice(repaired.length, 0, message)
  }
  return repaired
}

async function loadSession(
  db: Db,
  sessionId: string
): Promise<SessionRow | undefined> {
  const [session] = await db
    .select()
    .from(t.sessions)
    .where(eq(t.sessions.id, sessionId))
  return session
}

/**
 * 标失败并写清原因（只在还是执行中时）。被派的运行：派活单跟着没办成，或者（运行出错、自动重试还没用完）回到排队；
 * 还会重试的这次不通知负责人，最后一次没办成才通知（派活第二期 4.3）。
 * retryable：运行出错（模型、程序出错、验收判失败）= true；规则让它失败 = false（规则就是要它停）
 */
async function failSession(
  db: Db,
  session: SessionRow,
  snapshot: SessionSnapshot | null,
  reason: string,
  options: { retryable: boolean; failKind?: WorkFailKind } = { retryable: true }
) {
  // 过程记录和最终状态在同一个事务里写：读到「失败」时一定也读得到原因
  const failed = await db.transaction(async (tx) => {
    const updated = await tx
      .update(t.sessions)
      .set({
        status: "failed",
        endedAt: new Date(),
        error: reason.slice(0, 2000),
        // 出错的运行结果记没办成，原因就是错误信息
        ...failedOutcome(reason),
      })
      .where(
        and(
          eq(t.sessions.id, session.id),
          inArray(t.sessions.status, ["running", "verifying"])
        )
      )
      .returning({ id: t.sessions.id })
    if (updated.length === 0) return false
    await appendEvent(tx, session.id, {
      kind: "error",
      title: "运行失败",
      detail: reason,
    })
    // 被派的运行：派活单跟着记「没办成」（原因同运行的），或者排队等自动重试
    const settled = await settleWorkItemInTx(db, tx, session.id, {
      status: "failed",
      error: reason.slice(0, 2000),
      retryable: options.retryable,
      ...(options.failKind ? { failKind: options.failKind } : {}),
    })
    // 固化试跑出错：脚本状态记停下（运行出错），同样交给固化往下走（它看试跑运行的状态，记这一轮没过）
    await endRoutineTestInTx(db, tx, session.id, { kind: "run_failed", reason })
    return { settled }
  })
  if (!failed) return
  // 跑过固化流程的运行：试用、转正式、连续跑不通停用（routine/runtime/stats.ts）
  await settleRoutineRun(db, session.id).catch((error: unknown) => console.warn(`[routine] ${session.id} 的固化流程统计没记上：${(error as Error).message}`))
  // 固化试跑不通知负责人（固化没成功时由固化那边通知）
  if (session.kind === "routine_test") return
  if (failed.settled?.kind === "retry") return
  if (snapshot) {
    const retried = failed.settled?.kind === "failed" ? failed.settled.autoRetries : 0
    await notifyUsers(db, {
      userIds: [snapshot.task.ownerId],
      title: `${snapshot.task.title}：运行失败`,
      body: retried ? `自动重试了 ${retried} 次都没办成：${reason}` : reason,
      link: sessionLink(session.taskId, session.id),
      taskId: session.taskId,
      sessionId: session.id,
    })
  }
}

/** 只回文字、没调 run.finish 时提醒一次的话（3.2） */
export const finishNudge = (name: string) => `要结束请调用 ${name} 报结果（办成 / 没办成），并对照目标写依据。`

/**
 * 正常收尾（agent 报了结果，或者只回文字、说做完了）。调用前先关资源（工具连接、Chrome）。
 * 收尾的事务：过程记录、状态「已结束」一起写。硬规则已经是定论的（没办成、三方验收通过）一并写结果、结算被派的单；
 * 要复核的结果先空着、写复核标记（页面显示「复核中」），被派的单等复核完再结算。事务之后跑复核（review.ts），再按最终结果通知负责人
 */
async function finishRun(
  db: Db,
  session: SessionRow,
  snapshot: SessionSnapshot,
  input: { text: string; claim?: AgentClaim; messages?: ModelMessage[] }
): Promise<RunOutcome> {
  const report = claimText(input.claim, input.text)
  // 被派的单上写的总结：run.finish 的 summary，或者最后那段文字
  const summary = input.claim?.summary || input.text
  const finished = await db.transaction(async (tx) => {
    for (const message of input.messages ?? []) await appendMessage(tx, session.id, message)
    const facts = await outcomeFactsInTx(tx, session.id, snapshot, input.claim)
    const verdict = judgeByRules(facts)
    // 要不要复核（5.1）：硬规则还没定论（agent 说办成了、没有三方验收）就一定复核；没有复核模型的直接记没办成
    let reviewModelId: string | undefined
    let result: Judged | undefined
    if (verdict.final) result = finalByRules(verdict)
    else {
      reviewModelId = await reviewModelFor(tx, snapshot)
      if (!reviewModelId) result = noReviewModel()
    }
    const updated = await tx
      .update(t.sessions)
      .set({
        status: "done",
        endedAt: new Date(),
        ...(result
          ? { outcome: result.outcome, outcomeReason: result.reason.slice(0, 2000) || null, outcomeBy: result.by }
          : { outcome: null, outcomeReason: null, outcomeBy: null, review: pendingReview(reviewModelId!) }),
      })
      .where(
        and(
          eq(t.sessions.id, session.id),
          inArray(t.sessions.status, ["running", "verifying"])
        )
      )
      .returning({ id: t.sessions.id })
    if (updated.length === 0) throw new RollbackSignal()
    await appendEvent(tx, session.id, {
      kind: "done",
      title: finishTitle(facts, result),
      detail: [report.trim(), result ? `结果：${runOutcomeLabel[result.outcome]}${result.reason ? `（${result.reason}）` : ""}` : ""].filter(Boolean).join("\n\n") || null,
    })
    // 被派的运行：有结果的现在就结算派活单（办成 → 办完；没办成 → 没办成，不重试）；要复核的等复核完
    const settled = result
      ? await settleWorkItemInTx(db, tx, session.id, { status: "done", outcome: result.outcome, outcomeReason: result.reason, summary, ...(result.failKind ? { failKind: result.failKind } : {}) })
      : undefined
    return { result, reviewModelId, settled }
  }).catch((error) => {
    if (error instanceof RollbackSignal) return undefined
    throw error
  })
  if (!finished) return "stopped"
  const final = finished.result ?? (await reviewAfterFinish(db, session, snapshot, { modelId: finished.reviewModelId!, report, summary }))
  await notifyFinished(db, session, snapshot, final, summary)
  // 跑过固化流程的运行：结果定了，记试用 / 正式 / 停用（routine/runtime/stats.ts）
  await settleRoutineRun(db, session.id).catch((error: unknown) => console.warn(`[routine] ${session.id} 的固化流程统计没记上：${(error as Error).message}`))
  return "done"
}

/**
 * 固化试跑结束（docs/dev/solidify.md 5.6）：运行记「已结束」，结果留空、不复核、不通知；写一条「固化试跑结束」过程，
 * 同一个事务里发 routine.compile，由固化那边看试跑结果往下走。调用前先关资源（Chrome）
 */
async function finishRoutineTest(db: Db, session: SessionRow, snapshot: RoutineSnapshotted, state: SessionRoutineState): Promise<RunOutcome> {
  const stop = state.stoppedAt
  const detail = [
    `${state.steps} 步 · ${((state.ms ?? 0) / 1000).toFixed(1)} 秒。`,
    stop ? `停下：${routineStopKindLabel[stop.kind]}（第 ${stop.step} 步）：${stop.reason}` : state.recorded?.finish ? `脚本报了结果：${runOutcomeLabel[state.recorded.finish.outcome]}。${state.recorded.finish.summary}` : "",
    state.recorded?.report ? `要交回的结果（没生效）：${JSON.stringify(state.recorded.report)}` : "",
  ]
    .filter(Boolean)
    .join("\n")
  const ended = await db.transaction(async (tx) => {
    const updated = await tx
      .update(t.sessions)
      .set({ status: "done", endedAt: new Date(), outcome: null, outcomeReason: null, outcomeBy: null })
      .where(and(eq(t.sessions.id, session.id), inArray(t.sessions.status, ["running", "verifying"])))
      .returning({ id: t.sessions.id })
    if (updated.length === 0) return false
    await appendEvent(tx, session.id, { kind: "done", title: "固化试跑结束", detail })
    await sendRoutineCompile(db, tx, { versionId: snapshot.routine.versionId })
    return true
  })
  return ended ? "done" : "stopped"
}

/**
 * 收尾以后的复核：复核判办成才算办成（outcome.ts 的 combineReview）；出错重试一次，还出错记没办成。
 * 写结果、复核报告、过程记录，复核的用量（两次都算）记进这次运行；被派的单这时才结算（叫醒派活方在结算的事务里发）
 */
async function reviewAfterFinish(
  db: Db,
  session: SessionRow,
  snapshot: SessionSnapshot,
  input: { modelId: string; report: string; summary: string }
): Promise<Judged> {
  const first: RunReview = await performReview(db, { session, snapshot, modelId: input.modelId, report: input.report })
  let review = first
  if (first.error) {
    const retry = await performReview(db, { session, snapshot, modelId: input.modelId, report: input.report })
    review = {
      ...retry,
      tokensIn: first.tokensIn + retry.tokensIn,
      tokensOut: first.tokensOut + retry.tokensOut,
      costUsd: first.costUsd + retry.costUsd,
      ...(retry.error ? { error: `${retry.error}（重试了一次，第一次：${first.error}）`.slice(0, 1000) } : {}),
    }
  }
  let final = combineReview(review)
  await db.transaction(async (tx) => {
    // 复核的用量记进这次运行；复核期间负责人已经手动改过结果的，不再覆盖
    const [row] = await tx
      .select({ outcome: t.sessions.outcome, outcomeReason: t.sessions.outcomeReason, outcomeBy: t.sessions.outcomeBy })
      .from(t.sessions)
      .where(eq(t.sessions.id, session.id))
      .for("update")
    const human = row?.outcomeBy === "human" && row.outcome
    if (human) final = { outcome: row.outcome!, by: "human", reason: row.outcomeReason ?? "" }
    await tx
      .update(t.sessions)
      .set({
        ...(human ? {} : { outcome: final.outcome, outcomeReason: final.reason.slice(0, 2000) || null, outcomeBy: final.by }),
        review,
        tokensIn: sql`${t.sessions.tokensIn} + ${review.tokensIn}`,
        tokensOut: sql`${t.sessions.tokensOut} + ${review.tokensOut}`,
        costUsd: sql`${t.sessions.costUsd} + ${review.costUsd}`,
      })
      .where(eq(t.sessions.id, session.id))
    await appendEvent(tx, session.id, {
      kind: "verify",
      title: reviewEventTitle(review, final.outcome),
      detail: review.error ? `复核模型 ${review.modelId} 出错：${review.error}` : `${review.reason}${review.screenshot ? "\n（带了最后一张截图）" : ""}`,
      ...(review.error ? {} : { tokensIn: review.tokensIn, tokensOut: review.tokensOut, output: `复核模型 ${review.modelId}，花费 ${review.costUsd.toFixed(6)} 美元` }),
    })
    await settleWorkItemInTx(db, tx, session.id, { status: "done", outcome: final.outcome, outcomeReason: final.reason, summary: input.summary, ...(final.failKind ? { failKind: final.failKind } : {}) })
  })
  return final
}

/** 按最终结果通知负责人：没办成和失败一样通知（被派的也发：单没办成、不会重试）；办成不推送，被派的办成不发 */
async function notifyFinished(db: Db, session: SessionRow, snapshot: SessionSnapshot, final: Judged, summary: string) {
  const link = sessionLink(session.taskId, session.id)
  const base = { userIds: [snapshot.task.ownerId], link, taskId: session.taskId, sessionId: session.id }
  if (final.outcome === "not_achieved") {
    await notifyUsers(db, { ...base, title: `${snapshot.task.title}：${runOutcomeLabel[final.outcome]}`, body: (final.reason || summary).slice(0, 500) })
    return
  }
  // 被派的运行一天可能几十上百次：办成时不发站内通知（派活页能看全部结果）
  if (session.workItemId) return
  await notifyUsers(db, { ...base, title: `${snapshot.task.title}：办成`, body: summary.slice(0, 500), push: false })
}

/** 调模型，出错按退避重试；重试完还不行就抛出 */
async function callWithRetry(
  db: Db,
  sessionId: string,
  resolved: ResolvedModel,
  input: Parameters<typeof callModel>[1]
): Promise<ModelCallResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callModel(resolved, input)
    } catch (error) {
      if (input.abortSignal?.aborted) throw error
      if (!isRetryable(error) || attempt >= runtime.modelRetries) throw error
      const wait = runtime.modelRetryBaseMs * 2 ** attempt
      await appendEvent(db, sessionId, {
        kind: "error",
        title: `模型调用出错，${Math.round(wait / 1000)} 秒后重试（第 ${attempt + 1} 次）`,
        detail: (error as Error).message,
      })
      await sleep(wait)
    }
  }
}

/** 花费或步数到了上限：生成一件要人办的事，session 挂起等人 */
async function hitLimit(
  db: Db,
  session: SessionRow,
  snapshot: SessionSnapshot,
  kind: "cost" | "steps",
  limit: number
) {
  const title =
    kind === "cost" ? "花费到了上限，要不要继续" : "步数到了上限，要不要继续"
  const summary =
    kind === "cost"
      ? `运行 ${session.id} 已经花了 ${Number(session.costUsd).toFixed(4)} 美元，到了上限 ${limit} 美元。同意就再给一份额度继续，不同意就结束这次运行。`
      : `运行 ${session.id} 已经调了 ${session.stepCount} 次模型，到了上限 ${limit} 步。同意就再给一份额度继续，不同意就结束这次运行。`
  const result = await db
    .transaction(async (tx) => {
      const created = await askHumanInTx(db, tx, {
        kind: "approval",
        title,
        summary,
        assigneeId: snapshot.task.ownerId,
        taskId: snapshot.task.id,
        sessionId: session.id,
        urgency: 1,
        detail: {
          sections: [
            { title: "为什么到了你这里", text: summary },
            { title: "任务", text: snapshot.task.title },
          ],
          primary: "继续",
          secondary: "不继续",
          ...(kind === "cost"
            ? {
                pay: [
                  "确定再花一份额度吗？",
                  "同意后这次运行可以再花一份默认额度的钱。",
                ] as [string, string],
              }
            : {}),
        },
        what: title,
        limitKind: kind,
      })
      if (!created) throw new RollbackSignal()
      return created
    })
    .catch((error) => {
      if (error instanceof RollbackSignal) return undefined
      throw error
    })
  if (result) {
    const [item] = await db
      .select()
      .from(t.humanItems)
      .where(eq(t.humanItems.id, result.itemId))
    if (item) await notifyAssignee(db, item)
  }
}

class RollbackSignal extends Error {}

/** 工具要求挂起：工具结果（以及同一步里后面没执行的调用的结果）和挂起在同一个事务里落库 */
async function suspendWithResults(
  db: Db,
  session: SessionRow,
  results: ModelMessage[],
  plan: NonNullable<ToolOutcome["suspend"]>
): Promise<boolean> {
  try {
    const item = await db.transaction(async (tx) => {
      for (const message of results)
        await appendMessage(tx, session.id, message)
      if (plan.kind === "wait") {
        const wait = await suspendInTx(db, tx, {
          ...plan.input,
          sessionId: session.id,
          status: "waiting",
        })
        if (!wait) throw new RollbackSignal()
        return undefined
      }
      const created = await askHumanInTx(db, tx, {
        ...plan.item,
        sessionId: session.id,
      })
      if (!created) throw new RollbackSignal()
      return created.itemId
    })
    if (item) {
      const [row] = await db
        .select()
        .from(t.humanItems)
        .where(eq(t.humanItems.id, item))
      if (row) await notifyAssignee(db, row)
    }
    // 等派活单的结果（work.done:<单号>）：挂起提交以后再查一次，单在这期间结束了就补发叫醒
    if (plan.kind === "wait") await recheckWorkDoneAfterSuspend(db, plan.input.event)
    return true
  } catch (error) {
    if (error instanceof RollbackSignal) return false
    throw error
  }
}

/** 规则要求审批：生成「审批工具调用」这件事，session 等人处理；这次调用和同一步里后面的调用都先存着，还没执行 */
async function suspendForApproval(
  db: Db,
  session: SessionRow,
  snapshot: SessionSnapshot,
  calls: ModelToolCall[],
  done: GatewayResult,
  approvedRuleIds: readonly string[]
): Promise<boolean> {
  const approval = done.approval!
  const input = maskSecretFields(JSON.stringify(approval.input ?? {}, null, 2))
  const shown =
    input.length > 4000
      ? `${input.slice(0, 4000)}\n…（参数太长，只显示开头）`
      : input
  const title = `审批工具调用：${done.toolName}`
  const summary = `${approval.reason}批准就执行这次调用，拒绝就把理由告诉 agent。`
  const detail: HumanDetail = {
    sections: [
      { title: "为什么到了你这里", text: approval.reason },
      { title: "工具", text: `${done.toolName}（${done.toolId}）` },
      { title: "参数", block: { title: "agent 要传的参数", text: shown } },
      {
        title: "来自",
        text: `任务「${snapshot.task.title}」的运行 ${session.id}。拒绝时写上理由，agent 会看到。`,
      },
    ],
    primary: "批准",
    secondary: "拒绝",
    ...(approval.risk === "money"
      ? {
          pay: ["确定批准吗？", "这次调用涉及金钱，批准后会立即执行。"] as [
            string,
            string,
          ],
        }
      : {}),
    toolCall: {
      toolId: done.toolId,
      toolName: done.toolName,
      input: shown,
      ...(approval.risk ? { risk: approval.risk } : {}),
      ruleId: approval.ruleId,
      ruleName: approval.ruleName,
    },
  }
  const pending: PendingToolCalls = {
    calls: calls.map((call) => ({
      toolCallId: call.toolCallId,
      toolName: call.toolName,
      input: call.input,
      ...(call.invalid ? { invalid: true } : {}),
      ...(call.error ? { error: call.error } : {}),
    })),
    approvedRuleIds: [...approvedRuleIds],
    ruleId: approval.ruleId,
    ruleName: approval.ruleName,
  }
  try {
    const created = await db.transaction(async (tx) => {
      const result = await askHumanInTx(db, tx, {
        kind: "approval",
        title,
        summary,
        assigneeId: approval.assigneeId,
        taskId: snapshot.task.id,
        sessionId: session.id,
        ruleId: approval.ruleId,
        urgency: approval.risk === "money" ? 0 : 1,
        detail,
        what: `等人审批：${done.toolName}`,
        pending,
      })
      if (!result) throw new RollbackSignal()
      return result
    })
    const [item] = await db
      .select()
      .from(t.humanItems)
      .where(eq(t.humanItems.id, created.itemId))
    if (item) await notifyAssignee(db, item)
    return true
  } catch (error) {
    if (error instanceof RollbackSignal) return false
    throw error
  }
}

export async function runSession(
  db: Db,
  sessionId: string,
  options: RunOptions = {}
): Promise<RunOutcome> {
  const first = await loadSession(db, sessionId)
  if (!first || first.status !== "running") return "skipped"
  const snapshot = first.snapshot
  // 没有快照的只有 M0 种子里的演示 session，引擎不碰它们
  if (!snapshot) return "skipped"
  const started = Date.now()
  let gateway: ToolGateway | undefined
  let closed = false
  // 资源（工具连接、Chrome）先关，过程记录写好，最后才写最终状态（M2 留下的先后顺序问题）
  const closeGateway = async () => {
    if (!gateway || closed) return
    closed = true
    await gateway.close()
  }
  let messages: ModelMessage[] = []
  const isTest = first.kind === "routine_test"
  // 这次先跑固化脚本：试跑每次进来都从头跑；普通运行快照里有固化流程、还没跑过（sessions.routine 为空）
  const scriptFirst = Boolean(snapshot.routine) && (isTest || !first.routine)
  try {
    // 执行模型：先跑脚本的运行等交给 agent 时再解析（脚本跑通就用不着）
    let resolved: ResolvedModel | undefined
    if (!scriptFirst)
      try {
        resolved = await resolveModel(db, snapshot.modelId)
      } catch (error) {
        await failSession(db, first, snapshot, (error as Error).message)
        return "failed"
      }
    gateway = await ToolGateway.create(db, first, snapshot)
    const system = buildSystemPrompt(snapshot, gateway.names())
    const tools = gateway.toolSet()
    const screenshot = () => gateway!.screenshot()
    // 开始钩子只跑一次：脚本跑完 stepCount 还是 0，要看 sessions.routine；试跑不跑
    if (!isTest && first.stepCount === 0 && !first.routine)
      await runStartHooks({ db, session: first, snapshot, screenshot })

    /** 依次交给网关执行一步里的工具调用。返回 undefined = 接着调模型 */
    const processCalls = async (
      calls: ModelToolCall[],
      firstCall: { approvedRuleIds?: readonly string[]; prefix?: string } = {}
    ): Promise<RunOutcome | undefined> => {
      const images: NonNullable<ToolOutcome["images"]> = []
      for (let index = 0; index < calls.length; index++) {
        const call = calls[index]!
        // 每个工具调用前再看一眼：被取消了就不再执行
        const live = await loadSession(db, sessionId)
        if (!live || live.status !== "running") return "stopped"
        const approved = index === 0 ? (firstCall.approvedRuleIds ?? []) : []
        const done: GatewayResult = await gateway!.call(call, {
          approvedRuleIds: approved,
        })
        if (done.approval) {
          const ok = await suspendForApproval(
            db,
            live,
            snapshot,
            calls.slice(index),
            done,
            approved
          )
          return ok ? "suspended" : "stopped"
        }
        const output =
          index === 0 && firstCall.prefix
            ? `${firstCall.prefix}\n${done.output}`
            : done.output
        const message = toolResult(
          call.toolCallId,
          call.toolName,
          output,
          done.outcome.isError
        )
        // 报结果（run.finish / 旧的 run.not_done）：同一步里后面的调用不再执行，结果照样补上（消息历史合法），不再调模型
        if (done.outcome.finish && !done.denied) {
          const claim = done.outcome.finish
          const rest = calls
            .slice(index + 1)
            .map((other) =>
              toolResult(other.toolCallId, other.toolName, "没有执行：前面已经报了结果，运行结束了。", true)
            )
          // 没办成（含旧说明里的部分办成）：直接收尾（结果和这几条消息在收尾的事务里一起落库）
          if (claim.outcome !== "achieved") {
            await closeGateway()
            return finishRun(db, live, snapshot, { text: claim.summary, claim, messages: [message, ...rest] })
          }
          // 报办成也算「说做完了」：先落库，再过「说做完了」的规则（三方验收可能反问、交给人）
          for (const each of [message, ...rest]) await appendMessage(db, sessionId, each)
          messages = [...messages, message, ...rest]
          return agentSaysDone(claim.summary, claim)
        }
        if (done.outcome.suspend && !done.denied) {
          const rest = calls
            .slice(index + 1)
            .map((other) =>
              toolResult(
                other.toolCallId,
                other.toolName,
                "没有执行：前面的工具让 session 挂起了。继续后需要的话再调用。",
                true
              )
            )
          const ok = await suspendWithResults(
            db,
            live,
            [message, ...rest],
            done.outcome.suspend
          )
          return ok ? "suspended" : "stopped"
        }
        await appendMessage(db, sessionId, message)
        messages = [...messages, message]
        if (done.outcome.images) images.push(...done.outcome.images)
      }
      if (images.length) {
        const message: ModelMessage = {
          role: "user",
          content: [
            {
              type: "text",
              text: `工具给你看的图片（${images.map((image) => image.name).join("、")}）：`,
            },
            ...images.map((image) => ({
              type: "file" as const,
              data: image.base64,
              mediaType: image.mime,
              filename: image.name,
            })),
          ],
        }
        await appendMessage(db, sessionId, message)
        messages = [...messages, message]
      }
      return undefined
    }

    // 模型看到的「报结果」工具名（旧快照没有 run.finish：不提醒，只回文字直接收尾）
    const finishName = snapshot.tools.some((tool) => tool.id === RUN_FINISH_TOOL_ID) ? (gateway.names().get(RUN_FINISH_TOOL_ID) ?? "run_finish") : undefined

    /**
     * 说做完了（只回文字，或者 run.finish 报办成）：先过「说做完了」的规则（三方验收），最终结论确定后再关资源、收尾。
     * 返回 undefined = 规则让 agent 接着干（反问的话已经追加进消息）
     */
    async function agentSaysDone(text: string, claim?: AgentClaim): Promise<RunOutcome | undefined> {
      const current = (await loadSession(db, sessionId))!
      const decision = await runFinishHooks({
        db,
        session: current,
        snapshot: snapshot!,
        screenshot,
        text: claim ? claimText(claim, text) : text,
      })
      if (decision.action === "continue") {
        const message: ModelMessage = { role: "user", content: decision.message }
        await appendMessage(db, sessionId, message)
        messages = [...messages, message]
        return undefined
      }
      if (decision.action === "suspended") return "suspended"
      if (decision.action === "fail") {
        await closeGateway()
        await failSession(db, current, snapshot!, decision.reason)
        return "failed"
      }
      const live = await loadSession(db, sessionId)
      if (!live || (live.status !== "running" && live.status !== "verifying"))
        return "stopped"
      await closeGateway()
      return finishRun(db, live, snapshot!, { text, ...(claim ? { claim } : {}) })
    }

    /**
     * 先跑固化脚本（docs/dev/solidify.md 6.3）：跑通了照常收尾（办成的过「说做完了」的规则）；ha.fail("input") 按没办成收尾；
     * 跑不通、要挂起、上次中断了的，追加交接的话（挂起的和挂起在同一个事务里落库）。返回 undefined = 交给 agent 接着做
     */
    const routinePhase = async (): Promise<RunOutcome | undefined> => {
      const routine = snapshot.routine!
      const current = first.routine
      // 跑过了（交给 agent 以后挂起、交接再进来的）：直接 agent 循环
      if (current && current.state !== "running") return undefined
      let state: SessionRoutineState
      let suspend: { plan: NonNullable<ToolOutcome["suspend"]> } | undefined
      if (current) {
        // 上次跑脚本时进程被杀：不确定最后一步做没做，交给 agent
        state = {
          ...current,
          state: "fell_back",
          stoppedAt: { step: current.steps, kind: "interrupted", reason: `跑到第 ${current.steps} 步时 worker 重启了，脚本中断` },
          endedAt: new Date().toISOString(),
          ms: Math.max(0, Date.now() - Date.parse(current.startedAt)),
        }
        await db.update(t.sessions).set({ routine: state }).where(eq(t.sessions.id, sessionId))
        await appendEvent(db, sessionId, { kind: "error", title: `固化流程中断了（第 ${current.steps} 步）`, detail: "worker 重启，脚本没跑完，不确定最后一步做没做。" })
      } else {
        const result = await runRoutineScript({
          db,
          session: first,
          snapshot: snapshot as RoutineSnapshotted,
          gateway: gateway!,
          mode: "run",
          input: routineInputOf(snapshot),
          signal: options.signal,
        })
        if (result.aborted) return "stopped"
        state = result.state
        if (state.state === "finished" && result.finish) {
          const live = await loadSession(db, sessionId)
          if (!live || live.status !== "running") return "stopped"
          const claim = result.finish
          if (claim.outcome !== "achieved") {
            await closeGateway()
            return finishRun(db, live, snapshot, { text: claim.summary, claim })
          }
          // 报了办成：照常过「说做完了」的规则（三方验收可能反问，那就进 agent 循环，所以先记一句脚本做了什么）
          const note: ModelMessage = {
            role: "user",
            content: `（系统）这次运行按固化流程「${routine.name}」第 ${routine.version} 版跑完了（${state.steps} 步，没调执行模型），脚本报了办成：${claim.summary}${claim.evidence ? `\n依据：${claim.evidence}` : ""}`,
          }
          await appendMessage(db, sessionId, note)
          messages = [...messages, note]
          return agentSaysDone(claim.summary, claim)
        }
        if (state.state === "stopped") {
          const stop = state.stoppedAt
          if (stop?.kind !== "input") return "stopped"
          // 输入本身有问题：记没办成，不交 agent
          const live = await loadSession(db, sessionId)
          if (!live || live.status !== "running") return "stopped"
          await closeGateway()
          const claim = {
            outcome: "not_achieved" as const,
            summary: `固化流程发现输入有问题：${stop.reason}`,
            evidence: `固化流程「${routine.name}」第 ${routine.version} 版在第 ${stop.step} 步停下：${stop.reason}`,
            reason: `输入有问题：${stop.reason}`,
            via: "finish" as const,
          }
          return finishRun(db, live, snapshot, { text: claim.summary, claim })
        }
        if (result.suspend) suspend = { plan: result.suspend.plan }
      }
      // 交给 agent：同一个网关、同一个 Chrome，从现在的页面接着做
      const text = await buildHandoff(db, { sessionId, routine, state, pageLines: () => gateway!.pageLines() })
      const message: ModelMessage = { role: "user", content: text }
      await appendEvent(db, sessionId, {
        kind: "plan",
        title: `交给 agent 接着做（固化流程停在第 ${state.stoppedAt?.step ?? state.steps} 步：${routineStopKindLabel[state.stoppedAt?.kind ?? "script_error"]}）`,
        detail: text,
      })
      if (suspend) {
        const live = await loadSession(db, sessionId)
        if (!live || live.status !== "running") return "stopped"
        const ok = await suspendWithResults(db, live, [message], suspend.plan)
        return ok ? "suspended" : "stopped"
      }
      await appendMessage(db, sessionId, message)
      messages = [...messages, message]
      return undefined
    }

    /** 固化试跑（docs/dev/solidify.md 5.6）：每次进来都从头跑脚本，不叫 agent；遇到登录页、验证码照常挂起等人 */
    const routineTest = async (): Promise<RunOutcome> => {
      if (!snapshot.routine) {
        await closeGateway()
        await failSession(db, first, snapshot, "固化试跑的快照里没有要试的脚本", { retryable: false })
        return "failed"
      }
      const routineSnapshot = snapshot as RoutineSnapshotted
      const result = await runRoutineScript({
        db,
        session: first,
        snapshot: routineSnapshot,
        gateway: gateway!,
        mode: "test",
        input: first.routine?.input ?? routineInputOf(snapshot),
        signal: options.signal,
      })
      if (result.aborted) return "stopped"
      if (result.state.stoppedAt?.kind === "cancelled") {
        // 试跑被取消（取消时 control.ts 已经发过一次；脚本这时才停下，状态定了再发一次）：让固化那边往下走
        await endRoutineTestInTx(db, undefined, sessionId, { kind: "cancelled", reason: "运行被取消了" })
        return "stopped"
      }
      if (result.suspend) {
        const live = await loadSession(db, sessionId)
        if (!live || live.status !== "running") return "stopped"
        const ok = await suspendWithResults(db, live, [], result.suspend.plan)
        return ok ? "suspended" : "stopped"
      }
      await closeGateway()
      return finishRoutineTest(db, first, routineSnapshot, result.state)
    }

    messages = await loadMessages(db, sessionId)

    if (isTest) return await routineTest()
    if (snapshot.routine) {
      const outcome = await routinePhase()
      if (outcome) return outcome
    }
    // 交给 agent 了（或者本来就没有脚本）：这时才要执行模型
    if (!resolved)
      try {
        resolved = await resolveModel(db, snapshot.modelId)
      } catch (error) {
        await closeGateway()
        await failSession(db, (await loadSession(db, sessionId)) ?? first, snapshot, (error as Error).message)
        return "failed"
      }
    const model: ResolvedModel = resolved

    // 审批过的工具调用（M3）：先处理它们（批准就执行，拒绝就告诉 agent），再调模型
    const [pendingWait] = await db
      .select()
      .from(t.sessionWaits)
      .where(
        and(
          eq(t.sessionWaits.sessionId, sessionId),
          eq(t.sessionWaits.status, "fired"),
          isNotNull(t.sessionWaits.pending)
        )
      )
      .orderBy(desc(t.sessionWaits.id))
      .limit(1)
    const pending = pendingWait?.pending
    if (pending?.decision && pending.state !== "done") {
      const setState = (state: "executing" | "done") =>
        db
          .update(t.sessionWaits)
          .set({ pending: { ...pending, state } })
          .where(eq(t.sessionWaits.id, pendingWait!.id))
      const [head, ...rest] = pending.calls
      const answered = new Set(
        messages
          .filter((message) => message.role === "tool")
          .flatMap((message) =>
            (message.content as ToolResultPart[]).map((part) => part.toolCallId)
          )
      )
      let outcome: RunOutcome | undefined
      if (head && !answered.has(head.toolCallId)) {
        const who = pending.decision.actorName
        const note = pending.decision.note
        if (pending.state === "executing") {
          // 上次执行到一半 worker 没了：不确定执行没有，不重复执行
          const message = toolResult(
            head.toolCallId,
            head.toolName,
            `${who}批准了这次调用，开始执行后 worker 重启了，不确定有没有执行成功。需要的话先确认现状，再决定要不要重新调用。`,
            true
          )
          await appendMessage(db, sessionId, message)
          messages = [...messages, message]
        } else if (pending.decision.how === "approve") {
          await setState("executing")
          outcome = await processCalls([head], {
            approvedRuleIds: [...pending.approvedRuleIds, pending.ruleId],
            prefix: `（${who}批准了这次调用${note ? `，备注：${note}` : ""}）`,
          })
        } else {
          const message = toolResult(
            head.toolCallId,
            head.toolName,
            `被拒绝：${who}拒绝了这次调用（规则「${pending.ruleName}」要求审批）。理由：${note || "没有写理由"}。不要换个办法绕过去；需要的话调整做法，或者用 ask.human 问清楚。`,
            true
          )
          await appendMessage(db, sessionId, message)
          messages = [...messages, message]
          await appendEvent(db, sessionId, {
            kind: "rule",
            title: `规则「${pending.ruleName}」：${who}拒绝了，没有执行`,
            detail: note ? `理由：${note}` : null,
          })
        }
      }
      if (!outcome) {
        await setState("done")
        outcome = await processCalls(
          rest.filter((call) => !answered.has(call.toolCallId))
        )
      } else {
        await setState("done")
      }
      if (outcome) return outcome
    }

    messages = await repairDanglingCalls(db, sessionId, messages)
    const settings = await loadEngineSettings(db)
    let lastInputTokens: number | undefined

    for (;;) {
      if (options.signal?.aborted) return "stopped"
      const session = await loadSession(db, sessionId)
      if (!session || session.status !== "running") return "stopped"

      // 单个任务不跑太久：排一个新的 session.run（同一个 session 只会有一个排着），自己退出
      if (Date.now() - started > runtime.maxRunMs) {
        const boss = await bossFor(db)
        await boss.send(QUEUES.run, { sessionId }, runJobOptions(sessionId))
        await appendEvent(db, sessionId, {
          kind: "plan",
          title: "跑了一段时间，交接给下一轮继续",
        })
        return "handoff"
      }

      const costLimit = session.costLimitUsd ?? settings.maxCostUsd
      if (Number(session.costUsd) >= costLimit) {
        await hitLimit(db, session, snapshot, "cost", costLimit)
        return "suspended"
      }
      // 设置里的最多步数是 0 = 不限；人同意继续后单独调高过的 session 用自己的上限
      const stepLimit = session.maxSteps ?? settings.maxSteps
      if (stepLimit > 0 && session.stepCount >= stepLimit) {
        await hitLimit(db, session, snapshot, "steps", stepLimit)
        return "suspended"
      }

      // 调模型前的规则（M3：花费超过 X）
      const before = await runBeforeStepHooks({
        db,
        session,
        snapshot,
        screenshot,
      })
      if (before?.action === "suspended") return "suspended"
      if (before?.action === "fail") {
        await closeGateway()
        await failSession(db, session, snapshot, before.reason, { retryable: false, failKind: "error" })
        return "failed"
      }

      // 历史太长就压缩（M3）
      const compacted = await maybeCompact(db, {
        sessionId,
        modelId: snapshot.modelId,
        systemChars: system.length,
        lastInputTokens,
      })
      if (compacted) messages = compacted

      let result: ModelCallResult
      try {
        result = await callWithRetry(db, sessionId, model, {
          system,
          messages,
          tools,
          abortSignal: options.signal,
        })
      } catch (error) {
        if (options.signal?.aborted) return "stopped"
        const reason =
          error instanceof ModelConfigError
            ? error.message
            : `模型调用失败（已重试 ${runtime.modelRetries} 次）：${(error as Error).message}`
        await closeGateway()
        await failSession(db, session, snapshot, reason)
        return "failed"
      }
      lastInputTokens = result.tokensIn

      // 用量和花费累计到 session（不管状态，钱已经花了）
      await db
        .update(t.sessions)
        .set({
          tokensIn: sql`${t.sessions.tokensIn} + ${result.tokensIn}`,
          tokensOut: sql`${t.sessions.tokensOut} + ${result.tokensOut}`,
          costUsd: sql`${t.sessions.costUsd} + ${result.costUsd}`,
          stepCount: sql`${t.sessions.stepCount} + 1`,
        })
        .where(eq(t.sessions.id, sessionId))
      const callNames = result.toolCalls.map((call) =>
        gateway!.label(call.toolName)
      )
      await appendEvent(db, sessionId, {
        kind: "think",
        title: callNames.length
          ? `模型决定调用：${callNames.join("、")}`
          : "模型给出答复",
        detail: result.text || null,
        tokensIn: result.tokensIn,
        tokensOut: result.tokensOut,
        ms: result.ms,
        output: `花费 ${result.costUsd.toFixed(6)} 美元${result.cachedTokens ? `，缓存命中 ${result.cachedTokens} token` : ""}`,
      })

      const assistant: ModelMessage = result.assistant ?? {
        role: "assistant",
        content: result.text || "（空回复）",
      }
      await appendMessage(db, sessionId, assistant)
      messages = [...messages, assistant]

      // 只回文字：没报结果的先提醒一次（3.2，标记存在 rule_state，挂起再继续也只提醒一次）；再回文字就按「说做完了、没报结果」收尾
      if (result.toolCalls.length === 0) {
        if (finishName) {
          const current = (await loadSession(db, sessionId))!
          if (!current.ruleState?.finishNudged) {
            await db
              .update(t.sessions)
              .set({ ruleState: sql`jsonb_set(${t.sessions.ruleState}, '{finishNudged}', 'true'::jsonb)` })
              .where(eq(t.sessions.id, sessionId))
            const message: ModelMessage = { role: "user", content: finishNudge(finishName) }
            await appendMessage(db, sessionId, message)
            messages = [...messages, message]
            await appendEvent(db, sessionId, { kind: "plan", title: `agent 只回了文字、没报结果，提醒它调用 ${finishName}` })
            continue
          }
        }
        const outcome = await agentSaysDone(result.text || "")
        if (outcome) return outcome
        continue
      }

      // 工具调用：依次交给网关
      const outcome = await processCalls(result.toolCalls)
      if (outcome) return outcome
    }
  } catch (error) {
    if (options.signal?.aborted) return "stopped"
    // 引擎自己的意外错误：写清楚原因标失败；连数据库都写不了就抛给 pg-boss 重试
    await closeGateway().catch(() => {})
    const session = await loadSession(db, sessionId)
    if (session)
      await failSession(
        db,
        session,
        snapshot,
        `引擎出错：${(error as Error).message}`
      )
    return "failed"
  } finally {
    await closeGateway()
  }
}
