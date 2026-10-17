// agent 循环：读快照和完整消息历史 → 调模型 → 工具网关 → 落库 → 再调模型……
// 直到模型给出最终答复（说做完了）、某个工具让 session 挂起、触发上限（转人工），或者出错（重试后标失败）。
// 每一步都先落库再继续，进程随时被杀掉都能从库里接着跑（同一个 session id）。
import { setTimeout as sleep } from "node:timers/promises"

import type { ModelMessage, ToolResultPart } from "ai"
import { and, eq, sql } from "drizzle-orm"
import type { SessionSnapshot } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { ToolGateway, type GatewayResult } from "./gateway.js"
import { runFinishHooks, runStartHooks } from "./hooks.js"
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
import { loadEngineSettings } from "./settings.js"
import type { SessionRow, ToolOutcome } from "./tools/builtin.js"
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

/** 标失败并写清原因（只在还是执行中时） */
async function failSession(
  db: Db,
  session: SessionRow,
  snapshot: SessionSnapshot | null,
  reason: string
) {
  const updated = await db
    .update(t.sessions)
    .set({
      status: "failed",
      endedAt: new Date(),
      error: reason.slice(0, 2000),
    })
    .where(and(eq(t.sessions.id, session.id), eq(t.sessions.status, "running")))
    .returning({ id: t.sessions.id })
  if (updated.length === 0) return
  await appendEvent(db, session.id, {
    kind: "error",
    title: "运行失败",
    detail: reason,
  })
  if (snapshot) {
    await notifyUsers(db, {
      userIds: [snapshot.task.ownerId],
      title: `${snapshot.task.title}：运行失败`,
      body: reason,
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
    if (first.stepCount === 0)
      await runStartHooks({ db, session: first, snapshot })

    let messages = await repairDanglingCalls(
      db,
      sessionId,
      await loadMessages(db, sessionId)
    )
    const settings = await loadEngineSettings(db)

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
      const stepLimit = session.maxSteps ?? settings.maxSteps
      if (session.stepCount >= stepLimit) {
        await hitLimit(db, session, snapshot, "steps", stepLimit)
        return "suspended"
      }

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
        await failSession(db, session, snapshot, reason)
        return "failed"
      }

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

      // 说做完了
      if (result.toolCalls.length === 0) {
        const current = (await loadSession(db, sessionId))!
        const decision = await runFinishHooks({
          db,
          session: current,
          snapshot,
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
        const updated = await db
          .update(t.sessions)
          .set({ status: "done", endedAt: new Date() })
          .where(
            and(eq(t.sessions.id, sessionId), eq(t.sessions.status, "running"))
          )
          .returning({ id: t.sessions.id, costUsd: t.sessions.costUsd })
        if (updated.length === 0) return "stopped"
        await appendEvent(db, sessionId, {
          kind: "done",
          title: "agent 说做完了",
          detail: result.text || null,
        })
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
      const images: NonNullable<ToolOutcome["images"]> = []
      for (let index = 0; index < result.toolCalls.length; index++) {
        const call = result.toolCalls[index]!
        // 每个工具调用前再看一眼：被取消了就不再执行
        const live = await loadSession(db, sessionId)
        if (!live || live.status !== "running") return "stopped"
        const done: GatewayResult = await gateway.call(call)
        const message = toolResult(
          call.toolCallId,
          call.toolName,
          done.output,
          done.outcome.isError
        )
        if (done.outcome.suspend && !done.denied) {
          const rest = result.toolCalls
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
    }
  } catch (error) {
    if (options.signal?.aborted) return "stopped"
    // 引擎自己的意外错误：写清楚原因标失败；连数据库都写不了就抛给 pg-boss 重试
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
    await gateway?.close()
  }
}
