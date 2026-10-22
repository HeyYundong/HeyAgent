// 规则「自动记录检查点」（sync_checkpoint，M3 / 方案 2.3.3）：调完工具按工具的类别写记录，标「自动」（synced），agent 改不了。
// - 访问：浏览器打开网页后，记网址和页面标题；
// - 发送消息：调了风险等级为「外发」的工具（浏览器工具除外）后，记发给谁和原文；
// - 产出文件：file.save 之后，记文件链接；
// - 数量：按记录条数累计（在 checkpoint.mark 里算，见 tools/builtin.ts）。
// 一条记录对应哪个检查点：按类型匹配；同类型有多个时，记到 agent 用 checkpoint.mark(status = doing) 最近指定的那个，
// 没指定过就记到第一个还没完成的。
import { asc, eq } from "drizzle-orm"
import type { CheckpointKind } from "@heyagent/shared"

import * as t from "../db/schema.js"
import type { ToolCallContext } from "./hooks.js"
import { appendEvent } from "./records.js"
import type { ToolOutcome } from "./tools/builtin.js"

const TO_KEYS = [
  "to",
  "recipient",
  "receiver",
  "target",
  "phone",
  "email",
  "chatId",
  "chat_id",
  "channel",
  "user",
  "userId",
  "user_id",
  "contact",
]
const TEXT_KEYS = ["text", "message", "content", "body", "msg", "caption"]
const clip = (value: string, max: number) =>
  value.length > max ? `${value.slice(0, max)}…` : value

function firstString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim()
    if (typeof value === "number") return String(value)
    if (
      Array.isArray(value) &&
      value.every((item) => typeof item === "string") &&
      value.length
    )
      return value.join("、")
  }
  return undefined
}

/** 外发工具的「发给谁和原文」：参数里常见的字段名；认不出就记参数原文 */
export function messageRecord(toolName: string, input: unknown): string {
  const record =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {}
  const to = firstString(record, TO_KEYS)
  const text = firstString(record, TEXT_KEYS)
  if (to || text)
    return clip(
      `${toolName}：${to ? `发给 ${to}` : "发出"}${text ? `：${text}` : ""}`,
      2000
    )
  return clip(`${toolName}：${JSON.stringify(input ?? {})}`, 2000)
}

/** 这次工具调用该写哪些记录 */
export function recordsFor(
  ctx: Pick<ToolCallContext, "toolId" | "toolName" | "risk" | "input">,
  outcome: ToolOutcome
): { kind: CheckpointKind; text: string }[] {
  const out: { kind: CheckpointKind; text: string }[] = []
  if (outcome.facts?.url)
    out.push({
      kind: "visit",
      text: clip(
        `${outcome.facts.title ? `${outcome.facts.title} · ` : ""}${outcome.facts.url}`,
        1000
      ),
    })
  if (outcome.facts?.fileId)
    out.push({
      kind: "artifact",
      text: `${outcome.facts.fileName ?? "文件"} · /api/files/${outcome.facts.fileId}`,
    })
  if (
    ctx.risk === "external" &&
    !ctx.toolId.startsWith("browser.") &&
    ctx.toolId !== "browser" &&
    !ctx.toolId.startsWith("desktop.") &&
    ctx.toolId !== "desktop"
  )
    out.push({
      kind: "message",
      text: messageRecord(ctx.toolName ?? ctx.toolId, ctx.input),
    })
  return out
}

export async function syncCheckpoints(
  ctx: ToolCallContext & { outcome: ToolOutcome },
  ruleName: string
) {
  const records = recordsFor(ctx, ctx.outcome)
  if (records.length === 0) return
  const { db, session } = ctx
  const rows = await db
    .select()
    .from(t.checkpoints)
    .where(eq(t.checkpoints.sessionId, session.id))
    .orderBy(asc(t.checkpoints.position))
  for (const record of records) {
    const sameKind = rows.filter((row) => row.kind === record.kind)
    if (sameKind.length === 0) continue
    const open = sameKind.filter((row) => row.status === "open")
    const focused = (list: typeof sameKind) =>
      list
        .filter((row) => row.focusedAt)
        .sort((a, b) => b.focusedAt!.getTime() - a.focusedAt!.getTime())[0]
    const target =
      focused(open) ?? open[0] ?? focused(sameKind) ?? sameKind.at(-1)!
    const now = new Date()
    await db
      .insert(t.checkpointRecords)
      .values({
        checkpointId: target.id,
        at: now,
        text: record.text,
        synced: true,
      })
    // 进度：访问、发消息按「不同的对象」数（同一个网址只算一次）；到了目标数就算完成。产出文件有一条记录就算完成
    const synced = await db
      .select({
        text: t.checkpointRecords.text,
        synced: t.checkpointRecords.synced,
      })
      .from(t.checkpointRecords)
      .where(eq(t.checkpointRecords.checkpointId, target.id))
    const distinct = new Set(
      synced.filter((row) => row.synced).map((row) => row.text)
    ).size
    let progress = target.progress
    let status = target.status
    if (record.kind === "visit" || record.kind === "message") {
      progress = Math.max(target.progress ?? 0, distinct)
      if (status === "open" && target.target && progress >= target.target)
        status = "done"
    } else if (record.kind === "artifact" && status === "open") {
      status = "done"
    }
    await db
      .update(t.checkpoints)
      .set({ progress, status })
      .where(eq(t.checkpoints.id, target.id))
    target.progress = progress
    target.status = status
    const progressText = target.target
      ? `${progress ?? 0}/${target.target}`
      : status === "done"
        ? "已完成"
        : "有了记录"
    await appendEvent(db, session.id, {
      kind: "checkpoint",
      title: `「${target.title}」${progressText}`,
      detail: `由规则「${ruleName}」自动记下：${record.text}`,
      toolId: ctx.toolId,
    })
  }
}
