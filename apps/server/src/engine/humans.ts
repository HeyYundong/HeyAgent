// 要人办的事：ask.human、花费 / 步数上限转人工。处理完（批准 / 拒绝 / 已处理 + 备注）就继续对应的 session。
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
import { notifyUsers, TODOS_LINK } from "./notify.js"
import type { Tx } from "./queue.js"
import { appendEvent, writeAudit } from "./records.js"
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
    match: input.limitKind ? { limit: input.limitKind } : null,
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
  const result = await db.transaction(async (tx) => {
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
    const [wait] = await tx
      .select()
      .from(t.sessionWaits)
      .where(
        and(
          eq(t.sessionWaits.humanItemId, item.id),
          eq(t.sessionWaits.status, "waiting")
        )
      )
    if (!wait) return {}
    const limit = (wait.match as { limit?: "cost" | "steps" } | null)?.limit
    if (limit && input.how === "reject") {
      await tx
        .update(t.sessionWaits)
        .set({ status: "cancelled", firedCause: "human", firedAt: new Date() })
        .where(eq(t.sessionWaits.id, wait.id))
      await tx
        .update(t.sessions)
        .set({
          status: "failed",
          endedAt: new Date(),
          error: `${limit === "cost" ? "花费" : "步数"}到了上限，${input.actorName}决定不继续`,
        })
        .where(eq(t.sessions.id, item.sessionId))
      await appendEvent(tx, item.sessionId, {
        kind: "error",
        title: "负责人决定不继续，运行结束",
        detail: note ?? null,
      })
      return { endedSessionId: item.sessionId }
    }
    let sessionPatch: Partial<typeof t.sessions.$inferInsert> | undefined
    if (limit) {
      // 同意继续：在现在的基础上再给一份默认额度
      const [session] = await tx
        .select()
        .from(t.sessions)
        .where(eq(t.sessions.id, item.sessionId))
      const settings = await loadEngineSettings(tx)
      sessionPatch =
        limit === "cost"
          ? { costLimitUsd: Number(session!.costUsd) + settings.maxCostUsd }
          : { maxSteps: session!.stepCount + settings.maxSteps }
    }
    const message = limit
      ? `${input.actorName}同意继续（${limit === "cost" ? "花费" : "步数"}上限已调高）。${note ? `备注：${note}` : ""}`
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
