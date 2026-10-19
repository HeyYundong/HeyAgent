// 助手对话的存取：对话（assistant_chats）、消息历史（assistant_messages，原样存 AI SDK 的 ModelMessage）、改动确认卡（assistant_proposals）。
// 面板上的记录（AssistantEntry）不另存，由消息历史和卡拼出来（buildEntries），和流里发出去的保持一致：
// - user 消息 → user；assistant 消息里的文字 → 一条 assistant（id = m<seq>）；
// - 查的工具调用按出现的顺序一条 tool（id = t-<callId>），没进卡的写工具调用（参数不对、没权限）排在后面；
// - 卡挂在它那条 assistant 消息后面；role = notice 的行是给人看的提示（到上限、没配模型），不发给模型。
import { randomBytes } from "node:crypto"

import { ASSISTANT_MAX_CHATS, type AssistantChat, type AssistantChatSummary, type AssistantEntry, type AssistantProposal } from "@heyagent/shared"
import type { ModelMessage, ToolResultPart } from "ai"
import { and, asc, desc, eq, inArray, max, notInArray } from "drizzle-orm"

import type { DbOrTx } from "../data/config/common.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { isReadTool, toolLabel } from "./tools.js"

export type ChatRow = typeof t.assistantChats.$inferSelect
export type MessageRow = typeof t.assistantMessages.$inferSelect
export type ProposalRow = typeof t.assistantProposals.$inferSelect

export const newId = (prefix: string) => `${prefix}-${randomBytes(8).toString("hex")}`

/** 新对话的标题：第一条消息的前 30 个字（换行换成空格） */
export const chatTitle = (message: string) => message.replace(/\s+/g, " ").trim().slice(0, 30)

export const entryIdOf = (seq: number) => `m${seq}`
export const toolEntryId = (callId: string) => `t-${callId}`

/** Trace 展开后的细节：输入 + 输出的开头，截短 */
const DETAIL_MAX = 2000
export function toolDetail(input: unknown, output: string) {
  const text = `输入：${JSON.stringify(input ?? {})}\n\n${output}`
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text
}

// ---------- 对话 ----------

export async function loadChat(db: DbOrTx, id: string, userId: string): Promise<ChatRow | undefined> {
  const [row] = await db
    .select()
    .from(t.assistantChats)
    .where(and(eq(t.assistantChats.id, id), eq(t.assistantChats.userId, userId)))
  return row
}

export async function createChat(db: Db, input: { userId: string; title: string; modelId: string | null }): Promise<ChatRow> {
  const [row] = await db
    .insert(t.assistantChats)
    .values({ id: newId("ac"), userId: input.userId, title: input.title || "新对话", modelId: input.modelId })
    .returning()
  return row!
}

/** 每人只留最近 ASSISTANT_MAX_CHATS 段，多的删掉最旧的（消息和卡跟着级联删掉） */
export async function trimChats(db: Db, userId: string) {
  const keep = await db
    .select({ id: t.assistantChats.id })
    .from(t.assistantChats)
    .where(eq(t.assistantChats.userId, userId))
    .orderBy(desc(t.assistantChats.updatedAt), desc(t.assistantChats.createdAt))
    .limit(ASSISTANT_MAX_CHATS)
  if (keep.length < ASSISTANT_MAX_CHATS) return
  await db.delete(t.assistantChats).where(
    and(
      eq(t.assistantChats.userId, userId),
      notInArray(
        t.assistantChats.id,
        keep.map((row) => row.id)
      )
    )
  )
}

const summaryOf = (row: ChatRow): AssistantChatSummary => ({ id: row.id, title: row.title, modelId: row.modelId, costUsd: row.costUsd, updatedAt: row.updatedAt.toISOString() })

export async function listChats(db: Db, userId: string): Promise<AssistantChatSummary[]> {
  const rows = await db
    .select()
    .from(t.assistantChats)
    .where(eq(t.assistantChats.userId, userId))
    .orderBy(desc(t.assistantChats.updatedAt))
    .limit(ASSISTANT_MAX_CHATS)
  return rows.map(summaryOf)
}

export async function getChat(db: Db, userId: string, id: string): Promise<AssistantChat | undefined> {
  const chat = await loadChat(db, id, userId)
  if (!chat) return undefined
  const [messages, proposals] = await Promise.all([loadMessages(db, id), loadProposals(db, id)])
  return {
    ...summaryOf(chat),
    entries: buildEntries(messages, proposals),
    pendingProposalId: proposals.find((proposal) => proposal.status === "pending")?.id ?? null,
  }
}

export async function deleteChat(db: Db, userId: string, id: string) {
  const rows = await db
    .delete(t.assistantChats)
    .where(and(eq(t.assistantChats.id, id), eq(t.assistantChats.userId, userId)))
    .returning({ id: t.assistantChats.id })
  return rows.length > 0
}

// ---------- 消息 ----------

export async function loadMessages(db: DbOrTx, chatId: string): Promise<MessageRow[]> {
  return db.select().from(t.assistantMessages).where(eq(t.assistantMessages.chatId, chatId)).orderBy(asc(t.assistantMessages.seq))
}

export async function nextSeq(db: DbOrTx, chatId: string): Promise<number> {
  const [row] = await db
    .select({ seq: max(t.assistantMessages.seq) })
    .from(t.assistantMessages)
    .where(eq(t.assistantMessages.chatId, chatId))
  return (row?.seq ?? 0) + 1
}

export async function insertMessages(db: DbOrTx, chatId: string, rows: { seq: number; role: string; message: unknown }[]) {
  if (rows.length === 0) return
  await db.insert(t.assistantMessages).values(rows.map((row) => ({ chatId, ...row })))
}

/** 给人看的提示也存一行（role = notice），刷新以后还在；发给模型时跳过 */
export interface NoticeMessage {
  text: string
  tone: "info" | "error"
}

/**
 * 发给模型的历史：去掉 notice；某次调用没有结果的（进程中途挂了、卡还没处理）补一个「没有执行」的结果，
 * AI SDK 要求每个 tool-call 后面都有 tool-result
 */
export function historyForModel(rows: MessageRow[]): ModelMessage[] {
  const messages = rows.filter((row) => row.role !== "notice").map((row) => row.message as ModelMessage)
  const answered = new Set<string>()
  for (const message of messages) {
    if (message.role === "tool") for (const part of message.content) if (part.type === "tool-result") answered.add(part.toolCallId)
  }
  const out: ModelMessage[] = []
  for (const [index, message] of messages.entries()) {
    out.push(message)
    if (message.role !== "assistant" || typeof message.content === "string") continue
    const missing = message.content.filter((part) => part.type === "tool-call" && !answered.has(part.toolCallId))
    if (missing.length === 0) continue
    const filler: ToolResultPart[] = missing.map((part) => ({
      type: "tool-result",
      toolCallId: (part as { toolCallId: string }).toolCallId,
      toolName: (part as { toolName: string }).toolName,
      output: { type: "error-text", value: "没有执行（中断了）" },
    }))
    const next = messages[index + 1]
    // 紧跟着的 tool 消息里补上缺的；没有就插一条
    if (next?.role === "tool") next.content = [...next.content, ...filler]
    else out.push({ role: "tool", content: filler })
  }
  return out
}

/**
 * 把卡的处理结果（应用 / 不要 / 过期）接到那条 assistant 消息后面：紧跟着已经有 tool 消息（同一步里查的结果）就并进去，
 * 没有就新插一条。处理卡的时候这段对话不会有别的写入（同一时间只跑一个请求），所以 seq 就是现在最大的 + 1
 */
export async function appendToolResults(db: DbOrTx, chatId: string, afterSeq: number, parts: ToolResultPart[]) {
  if (parts.length === 0) return
  const [next] = await db
    .select()
    .from(t.assistantMessages)
    .where(and(eq(t.assistantMessages.chatId, chatId), eq(t.assistantMessages.seq, afterSeq + 1)))
  if (next?.role === "tool") {
    const message = next.message as Extract<ModelMessage, { role: "tool" }>
    await db
      .update(t.assistantMessages)
      .set({ message: { ...message, content: [...message.content, ...parts] } })
      .where(eq(t.assistantMessages.id, next.id))
    return
  }
  await insertMessages(db, chatId, [{ seq: await nextSeq(db, chatId), role: "tool", message: { role: "tool", content: parts } }])
}

// ---------- 卡 ----------

export async function loadProposals(db: DbOrTx, chatId: string): Promise<ProposalRow[]> {
  return db.select().from(t.assistantProposals).where(eq(t.assistantProposals.chatId, chatId)).orderBy(asc(t.assistantProposals.afterSeq), asc(t.assistantProposals.createdAt))
}

export async function pendingProposals(db: DbOrTx, chatId: string): Promise<ProposalRow[]> {
  return db
    .select()
    .from(t.assistantProposals)
    .where(and(eq(t.assistantProposals.chatId, chatId), eq(t.assistantProposals.status, "pending")))
}

export const proposalOf = (row: Pick<ProposalRow, "id" | "status" | "changes">): AssistantProposal => ({ id: row.id, status: row.status, changes: row.changes })

export const proposalEntry = (row: Pick<ProposalRow, "id" | "status" | "changes" | "createdAt">): AssistantEntry => ({
  kind: "proposal",
  id: row.id,
  proposal: proposalOf(row),
  at: row.createdAt.toISOString(),
})

/** 一批卡的状态改成 expired（人没理它又发了新消息） */
export async function expireProposals(db: DbOrTx, ids: string[]) {
  if (ids.length === 0) return
  await db
    .update(t.assistantProposals)
    .set({ status: "expired", decidedAt: new Date() })
    .where(and(inArray(t.assistantProposals.id, ids), eq(t.assistantProposals.status, "pending")))
}

// ---------- 拼面板记录 ----------

type ToolCallPart = { type: "tool-call"; toolCallId: string; toolName: string; input: unknown }

/** tool-result 的输出转成文字（给 Trace 的细节）；是不是出错 */
export function resultText(part: ToolResultPart): { text: string; error: boolean } {
  const output = part.output as { type: string; value?: unknown; reason?: string }
  const error = output.type === "error-text" || output.type === "error-json" || output.type === "execution-denied"
  const value = typeof output.value === "string" ? output.value : output.value !== undefined ? JSON.stringify(output.value) : (output.reason ?? "")
  return { text: value, error }
}

export function buildEntries(messages: MessageRow[], proposals: ProposalRow[]): AssistantEntry[] {
  const results = new Map<string, ToolResultPart>()
  for (const row of messages) {
    const message = row.message as ModelMessage
    if (message.role === "tool") for (const part of message.content) if (part.type === "tool-result") results.set(part.toolCallId, part)
  }
  const inProposal = new Set(proposals.flatMap((proposal) => proposal.calls.map((call) => call.callId)))
  const proposalsAfter = new Map<number, ProposalRow[]>()
  for (const proposal of proposals) proposalsAfter.set(proposal.afterSeq, [...(proposalsAfter.get(proposal.afterSeq) ?? []), proposal])

  const toolEntry = (part: ToolCallPart, at: string): AssistantEntry => {
    const result = results.get(part.toolCallId)
    const out = result ? resultText(result) : undefined
    return {
      kind: "tool",
      id: toolEntryId(part.toolCallId),
      tool: part.toolName,
      label: toolLabel(part.toolName, part.input),
      status: !out ? "running" : out.error ? "error" : "done",
      ...(out ? { detail: toolDetail(part.input, out.text) } : {}),
      at,
    }
  }

  const entries: AssistantEntry[] = []
  for (const row of messages) {
    const at = row.createdAt.toISOString()
    if (row.role === "notice") {
      const notice = row.message as NoticeMessage
      entries.push({ kind: "notice", id: entryIdOf(row.seq), text: notice.text, tone: notice.tone, at })
    } else if (row.role === "user") {
      const message = row.message as Extract<ModelMessage, { role: "user" }>
      const text = typeof message.content === "string" ? message.content : message.content.map((part) => (part.type === "text" ? part.text : "")).join("")
      entries.push({ kind: "user", id: entryIdOf(row.seq), text, at })
    } else if (row.role === "assistant") {
      const message = row.message as Extract<ModelMessage, { role: "assistant" }>
      const parts = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content
      // 和流里一样：第一段文字出现时建 assistant 记录，后面的文字段用空行接上；查的工具按顺序穿插，没进卡的写工具调用排最后
      let textEntry: Extract<AssistantEntry, { kind: "assistant" }> | undefined
      const tail: AssistantEntry[] = []
      for (const part of parts) {
        if (part.type === "text") {
          if (!part.text) continue
          if (!textEntry) {
            textEntry = { kind: "assistant", id: entryIdOf(row.seq), text: part.text, at }
            entries.push(textEntry)
          } else textEntry.text += `\n\n${part.text}`
        } else if (part.type === "tool-call") {
          const call = part as ToolCallPart
          if (inProposal.has(call.toolCallId)) continue
          if (isReadTool(call.toolName)) entries.push(toolEntry(call, at))
          else tail.push(toolEntry(call, at))
        }
      }
      entries.push(...tail)
    }
    for (const proposal of proposalsAfter.get(row.seq) ?? []) entries.push(proposalEntry(proposal))
  }
  return entries
}
