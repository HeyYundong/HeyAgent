// 落库：session 的过程事件、消息历史、审计。
// 序号用 sessions 行上的计数器发（update ... returning，行锁保证 API 和 worker 同时追加也不撞号）；
// 种子数据里的老 session 没有计数器，取「计数器」和「现有最大序号」里大的那个。
import { asc, eq, sql } from "drizzle-orm"
import type { ModelMessage } from "ai"
import type { RunEventKind } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import type { Tx } from "./queue.js"

export type DbLike = Db | Tx

/** 事件里的输入输出最多存多少字符（全文太长的工具输出另存成文件） */
const EVENT_TEXT_MAX = 50_000
const clip = (value: string | undefined | null) =>
  value == null
    ? null
    : value.length > EVENT_TEXT_MAX
      ? `${value.slice(0, EVENT_TEXT_MAX)}\n…（已截断）`
      : value

export interface EventInput {
  kind: RunEventKind
  title: string
  detail?: string | null
  toolId?: string | null
  input?: string | null
  output?: string | null
  ms?: number | null
  tokensIn?: number | null
  tokensOut?: number | null
  at?: Date
}

export async function appendEvent(
  db: DbLike,
  sessionId: string,
  event: EventInput
): Promise<number> {
  const rows = await db.execute<{ seq: number }>(sql`
    update sessions set event_seq = greatest(event_seq, coalesce((select max(seq) from session_events where session_id = ${sessionId}), 0)) + 1
    where id = ${sessionId} returning event_seq as seq`)
  const seq = rows.rows[0]?.seq
  if (seq === undefined) throw new Error(`找不到 session ${sessionId}`)
  await db.insert(t.sessionEvents).values({
    sessionId,
    seq,
    at: event.at ?? new Date(),
    kind: event.kind,
    title: event.title.slice(0, 500),
    detail: clip(event.detail),
    toolId: event.toolId ?? null,
    input: clip(event.input),
    output: clip(event.output),
    ms: event.ms ?? null,
    tokensIn: event.tokensIn ?? null,
    tokensOut: event.tokensOut ?? null,
  })
  return seq
}

export async function appendMessage(
  db: DbLike,
  sessionId: string,
  message: ModelMessage
): Promise<number> {
  const rows = await db.execute<{ seq: number }>(sql`
    update sessions set msg_seq = greatest(msg_seq, coalesce((select max(seq) from session_messages where session_id = ${sessionId}), 0)) + 1
    where id = ${sessionId} returning msg_seq as seq`)
  const seq = rows.rows[0]?.seq
  if (seq === undefined) throw new Error(`找不到 session ${sessionId}`)
  await db
    .insert(t.sessionMessages)
    .values({ sessionId, seq, role: message.role, content: message })
  return seq
}

/**
 * 发给模型的消息历史，继续时读回。压缩过的消息（compacted = true）用压缩后的内容（summary：摘要 + 文件引用）代替原文；
 * 没有 summary 的压缩消息（老数据）直接跳过。库里的原文一直留着。
 */
export async function loadMessages(
  db: DbLike,
  sessionId: string
): Promise<ModelMessage[]> {
  return (await loadMessageRows(db, sessionId)).map((row) => row.message)
}

export async function loadMessageRows(
  db: DbLike,
  sessionId: string
): Promise<{ seq: number; message: ModelMessage; compacted: boolean }[]> {
  const rows = await db
    .select({
      seq: t.sessionMessages.seq,
      content: t.sessionMessages.content,
      compacted: t.sessionMessages.compacted,
      summary: t.sessionMessages.summary,
    })
    .from(t.sessionMessages)
    .where(eq(t.sessionMessages.sessionId, sessionId))
    .orderBy(asc(t.sessionMessages.seq))
  return rows
    .filter((row) => !row.compacted || row.summary)
    .map((row) => ({
      seq: row.seq,
      message: (row.compacted ? row.summary : row.content) as ModelMessage,
      compacted: row.compacted,
    }))
}

export interface AuditInput {
  actorId?: string | null
  action: string
  targetTable: string
  targetId: string
  detail?: Record<string, unknown>
}

export async function writeAudit(db: DbLike, input: AuditInput) {
  await db.insert(t.auditEvents).values({
    actorId: input.actorId ?? null,
    action: input.action,
    targetTable: input.targetTable,
    targetId: input.targetId,
    detail: input.detail ?? {},
  })
}
