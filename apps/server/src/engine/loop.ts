// agent 循环：读快照和完整消息历史 → 调模型 → 工具网关 → 落库 → 再调模型……
// 直到模型给出最终答复（说做完了，有验收规则的先过三方验收）、某个工具让 session 挂起、规则要求审批、触发上限（转人工），
// 或者出错（重试后标失败）。每一步都先落库再继续，进程随时被杀掉都能从库里接着跑（同一个 session id）。
// 结束时的顺序：最终结论确定后，先关资源（工具连接、Chrome），再写过程记录，最后写最终状态。
import { setTimeout as sleep } from "node:timers/promises"

import type { ModelMessage, ToolResultPart } from "ai"
import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm"
import type { HumanDetail, SessionSnapshot, WorkFailKind } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import type { PendingToolCalls } from "../db/schema.js"
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
import { suspendInTx } from "./waits.js"

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
    return { settled }
  })
  if (!failed) return
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
  try {
    let resolved: ResolvedModel
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
    if (first.stepCount === 0)
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
              text: `file.read 读到的图片（${images.map((image) => image.name).join("、")}）：`,
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

    messages = await loadMessages(db, sessionId)

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
        result = await callWithRetry(db, sessionId, resolved, {
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

      // 说做完了：先过「说做完了」的规则（三方验收），最终结论确定后再关资源、写过程记录、最后写状态
      if (result.toolCalls.length === 0) {
        const current = (await loadSession(db, sessionId))!
        const decision = await runFinishHooks({
          db,
          session: current,
          snapshot,
          screenshot,
          text: result.text,
        })
        if (decision.action === "continue") {
          const message: ModelMessage = {
            role: "user",
            content: decision.message,
          }
          await appendMessage(db, sessionId, message)
          messages = [...messages, message]
          continue
        }
        if (decision.action === "suspended") return "suspended"
        if (decision.action === "fail") {
          await closeGateway()
          await failSession(db, current, snapshot, decision.reason)
          return "failed"
        }
        const live = await loadSession(db, sessionId)
        if (!live || (live.status !== "running" && live.status !== "verifying"))
          return "stopped"
        const verified = live.verification?.status === "passed"
        await closeGateway()
        // 过程记录和最终状态同一个事务：读到「已完成」时，完成事件（以及关资源时写的记录）一定都在
        const finished = await db.transaction(async (tx) => {
          const updated = await tx
            .update(t.sessions)
            .set({ status: "done", endedAt: new Date() })
            .where(
              and(
                eq(t.sessions.id, sessionId),
                inArray(t.sessions.status, ["running", "verifying"])
              )
            )
            .returning({ id: t.sessions.id })
          if (updated.length === 0) return false
          await appendEvent(tx, sessionId, {
            kind: "done",
            title: verified ? "验收通过，运行完成" : "agent 说做完了",
            detail: result.text || null,
          })
          // 被派的运行：派活单跟着记「办完」，这段总结写回单上（agent 报过办不成的记「没办成」）
          const settled = await settleWorkItemInTx(db, tx, sessionId, { status: "done", summary: result.text || "" })
          return { settled }
        })
        if (!finished) return "stopped"
        // 被派的运行一天可能几十上百次：完成时不发站内通知（派活页能看全部结果）；失败照常通知。
        // agent 判断办不成的：运行正常结束，但单没办成，照常给负责人发失败通知
        if (live.workItemId) {
          if (finished.settled?.kind === "failed")
            await notifyUsers(db, {
              userIds: [snapshot.task.ownerId],
              title: `${snapshot.task.title}：没办成`,
              body: finished.settled.error,
              link: sessionLink(session.taskId, sessionId),
              taskId: session.taskId,
              sessionId,
            })
          return "done"
        }
        await notifyUsers(db, {
          userIds: [snapshot.task.ownerId],
          title: `${snapshot.task.title}：运行完成`,
          body: (result.text || "").slice(0, 500),
          link: sessionLink(session.taskId, sessionId),
          taskId: session.taskId,
          sessionId,
          push: false,
        })
        return "done"
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
