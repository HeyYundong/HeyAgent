// 内置工具的执行。全部通用：只碰平台自己的对象（检查点、等待、待办、记忆、技能、通知、文件）。
import { extname } from "node:path"

import { asc, eq, inArray, or, sql } from "drizzle-orm"
import {
  builtinToolInputs,
  fmtDateTime,
  memoryId,
  workDoneEvent,
  type BuiltinToolId,
  type HumanDetail,
  type SessionSnapshot,
} from "@heyagent/shared"
import type { z } from "zod"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import {
  getFileRow,
  isImageMime,
  isTextMime,
  readFileData,
  saveFile,
  TEXT_SAVE_EXTENSIONS,
} from "../../files/service.js"
import {
  createHumanItem,
  notifyAssignee,
  type CreateHumanItemInput,
} from "../humans.js"
import { listFromAgent, reportFromAgent } from "../dispatch/agent-tools.js"
import { dispatchFromAgent } from "../dispatch/dispatch.js"
import { isFinalWorkStatus, itemIdOfEvent, workDoneMessage } from "../dispatch/notify.js"
import { toWorkItems } from "../../work/service.js"
import { notifyUsers, sessionLink } from "../notify.js"
import { appendEvent } from "../records.js"
import { loadEngineSettings } from "../settings.js"
import type { SuspendInput } from "../waits.js"

export type SessionRow = typeof t.sessions.$inferSelect

export interface ToolContext {
  db: Db
  session: SessionRow
  snapshot: SessionSnapshot
}

export type SuspendPlan =
  | { kind: "wait"; input: Omit<SuspendInput, "sessionId" | "status"> }
  | { kind: "human"; item: CreateHumanItemInput & { what: string } }

export interface ToolOutcome {
  output: string
  isError?: boolean
  /** 这个工具要让 session 挂起（工具结果落库后，和挂起在同一个事务里做） */
  suspend?: SuspendPlan
  /** 要交给模型看的图片（作为下一条用户消息） */
  images?: { name: string; mime: string; base64: string }[]
  /** 要从输出里隐藏的密钥原文 */
  secrets?: string[]
  /** M3：给规则用的事实（自动记录检查点）：打开的网页、存下的文件 */
  facts?: { url?: string; title?: string; fileId?: string; fileName?: string }
  /** M3：引擎内部信号。page_needs_human = 浏览器检测到验证码或登录页（规则 page_needs_human 在内置转人工之外再加动作） */
  signals?: "page_needs_human"[]
}

const fail = (output: string): ToolOutcome => ({ output, isError: true })

/** 员工：按 id 或邮箱找，停用的不算 */
async function findStaff(db: Db, keys: string[]) {
  if (keys.length === 0) return []
  const rows = await db
    .select({
      id: t.users.id,
      name: t.users.name,
      email: t.users.email,
      banned: t.users.banned,
    })
    .from(t.users)
    .where(
      or(
        inArray(t.users.id, keys),
        inArray(
          sql`lower(${t.users.email})`,
          keys.map((key) => key.toLowerCase())
        )
      )
    )
  return rows.filter((row) => !row.banned)
}

const TEXT_READ_LIMIT = 20_000

type Inputs = { [K in BuiltinToolId]: z.infer<(typeof builtinToolInputs)[K]> }

const handlers: {
  [K in BuiltinToolId]: (
    ctx: ToolContext,
    input: Inputs[K]
  ) => Promise<ToolOutcome>
} = {
  async "checkpoint.mark"(ctx, input) {
    const rows = await ctx.db
      .select()
      .from(t.checkpoints)
      .where(eq(t.checkpoints.sessionId, ctx.session.id))
      .orderBy(asc(t.checkpoints.position))
    const checkpoint = rows[input.checkpoint - 1]
    if (!checkpoint)
      return fail(
        `没有第 ${input.checkpoint} 个检查点（一共 ${rows.length} 个）`
      )
    if (input.status === "doing") {
      // 只是指定「现在在做这个」：同类型的检查点有好几个时，规则自动写的记录记到它上面
      await ctx.db
        .update(t.checkpoints)
        .set({
          focusedAt: new Date(),
          progress: input.progress ?? checkpoint.progress,
        })
        .where(eq(t.checkpoints.id, checkpoint.id))
      if (input.record?.trim())
        await ctx.db.insert(t.checkpointRecords).values({
          checkpointId: checkpoint.id,
          at: new Date(),
          text: input.record.trim(),
          synced: false,
        })
      return {
        output: `好的，第 ${input.checkpoint} 个检查点「${checkpoint.title}」标为正在做。系统自动记录（访问、发消息、产出文件）会记到它上面；做完记得标 done。`,
      }
    }
    if (input.status === "skipped" && !input.reason?.trim())
      return fail("跳过检查点必须写理由（reason）")
    if (input.record?.trim())
      await ctx.db.insert(t.checkpointRecords).values({
        checkpointId: checkpoint.id,
        at: new Date(),
        text: input.record.trim(),
        synced: false,
      })
    // 「数量」按记录条数累计：agent 没填 progress 时，用这个检查点的记录条数
    let progress = input.progress ?? checkpoint.progress
    if (input.progress === undefined && checkpoint.kind === "count") {
      const [row] = await ctx.db
        .select({ n: sql<number>`count(*)::int` })
        .from(t.checkpointRecords)
        .where(eq(t.checkpointRecords.checkpointId, checkpoint.id))
      progress = row?.n ?? progress
    }
    await ctx.db
      .update(t.checkpoints)
      .set({
        status: input.status,
        progress,
        skipReason: input.status === "skipped" ? input.reason!.trim() : null,
      })
      .where(eq(t.checkpoints.id, checkpoint.id))
    await appendEvent(ctx.db, ctx.session.id, {
      kind: "checkpoint",
      title: `${input.status === "done" ? "勾上" : "跳过"}检查点：${checkpoint.title}`,
      detail:
        input.status === "skipped"
          ? `理由：${input.reason}`
          : (input.record ?? null),
    })
    return {
      output: `已${input.status === "done" ? "勾上" : "标为跳过"}第 ${input.checkpoint} 个检查点「${checkpoint.title}」`,
    }
  },

  async "session.wait"(ctx, input) {
    let resumeAt: Date | undefined
    if (input.until) {
      const at = new Date(input.until)
      if (Number.isNaN(at.getTime()))
        return fail(
          `until 不是合法的时间：${input.until}（要 ISO 8601，带时区）`
        )
      resumeAt = at
    } else if (input.afterMinutes) {
      resumeAt = new Date(Date.now() + input.afterMinutes * 60_000)
    }
    if (resumeAt && resumeAt.getTime() <= Date.now())
      return fail(`时间 ${fmtDateTime(resumeAt)} 已经过了，不用等`)
    if (!resumeAt && !input.event)
      return fail("until / afterMinutes 和 event 至少给一个")
    // 等派活单的结果（work.done:<单号>，第二期）：只能等这个任务派出去的单；单已经结束就不挂起，直接给结果（先结束、后等）
    const itemId = itemIdOfEvent(input.event)
    if (itemId) {
      const [row] = await ctx.db
        .select()
        .from(t.workItems)
        .where(eq(t.workItems.id, itemId))
      if (!row || row.fromTaskId !== ctx.snapshot.task.id)
        return fail(
          `没有这个任务派出去的派活单 ${itemId}（事件 ${workDoneEvent(itemId)} 只能等自己派的单）。用 work_list 看派过哪些`
        )
      if (isFinalWorkStatus(row.status)) {
        const [item] = await toWorkItems(ctx.db, [row])
        return {
          output: `不用等了，派活单已经结束：${workDoneMessage(item!)}`,
        }
      }
    }
    const settings = await loadEngineSettings(ctx.db)
    const eventOnly = !resumeAt && input.event
    const plan: SuspendPlan = {
      kind: "wait",
      input: {
        what: input.what,
        triggerKind:
          resumeAt && input.event
            ? "time_or_event"
            : resumeAt
              ? "time"
              : "event",
        resumeAt: resumeAt ?? null,
        event: input.event ?? null,
        fallbackDays: eventOnly ? settings.eventFallbackDays : null,
        deadlineAt: eventOnly
          ? new Date(
              Date.now() + settings.eventFallbackDays * 24 * 60 * 60 * 1000
            )
          : null,
      },
    }
    const how = [
      resumeAt ? `到 ${fmtDateTime(resumeAt)}（上海时间）继续` : null,
      input.event ? `等到事件「${input.event}」继续` : null,
    ]
      .filter(Boolean)
      .join("，或者")
    return {
      output: `已挂起：${how}。继续时你会收到一条消息，说明等到了什么。`,
      suspend: plan,
    }
  },

  async "ask.human"(ctx, input) {
    let assigneeId = ctx.snapshot.task.ownerId
    if (input.assignee) {
      const [found] = await findStaff(ctx.db, [input.assignee])
      if (!found)
        return fail(
          `找不到员工 ${input.assignee}（填员工 id 或邮箱，或者不填交给任务负责人）`
        )
      assigneeId = found.id
    }
    const kind = input.kind ?? "approval"
    const options = input.options ?? []
    const title = input.question.split("\n")[0]!.slice(0, 60)
    const detail: HumanDetail = {
      sections: [
        { title: "agent 的问题", text: input.question },
        ...(options.length > 2
          ? [
              {
                title: "可选的回答",
                text: options
                  .map((option, index) => `${index + 1}. ${option}`)
                  .join("\n"),
              },
            ]
          : []),
        {
          title: "来自",
          text: `任务「${ctx.snapshot.task.title}」的运行 ${ctx.session.id}。处理时可以写备注，agent 会看到。`,
        },
      ],
      primary: options[0] ?? (kind === "login" ? "已处理" : "批准"),
      secondary: options[1] ?? (kind === "login" ? "处理不了" : "不批准"),
    }
    return {
      output: `已交给负责人处理，等处理完再继续。`,
      suspend: {
        kind: "human",
        item: {
          kind,
          title,
          summary: input.question.slice(0, 300),
          assigneeId,
          taskId: ctx.snapshot.task.id,
          sessionId: ctx.session.id,
          urgency: 2,
          detail,
          what: `等人处理：${title}`,
        },
      },
    }
  },

  async "skill.load"(ctx, input) {
    const key = input.skill.trim()
    const skill = ctx.snapshot.skills.find(
      (each) => each.id === key || each.name === key
    )
    if (!skill)
      return fail(
        `本任务没有选用技能「${key}」。可用的：${ctx.snapshot.skills.map((each) => each.id).join("、") || "无"}`
      )
    return {
      output: `# ${skill.name}（${skill.id}，第 ${skill.version} 版）\n${skill.description}\n\n${skill.body}`,
    }
  },

  async "memory.propose"(ctx, input) {
    const { db, session, snapshot } = ctx
    const result = await db.transaction(async (tx) => {
      const seq = await tx.execute<{ n: string }>(
        sql`select nextval('memory_no_seq') as n`
      )
      const id = memoryId(Number(seq.rows[0]!.n))
      await tx.insert(t.memories).values({
        id,
        content: input.content,
        appliesTo: input.appliesTo,
        status: "pending",
        sourceKind: "agent",
        sourceTaskId: snapshot.task.id,
        sourceSessionId: session.id,
        sourceEvidence: input.evidence,
        reviewerId: snapshot.task.ownerId,
        webUnverified: input.evidence === "web",
        evidence: input.excerpt ?? null,
      })
      const item = await createHumanItem(tx, {
        kind: "memory",
        title: `新记忆待审核：${input.content.slice(0, 40)}`,
        summary: `agent 在运行 ${session.id} 里提议记住一件事`,
        assigneeId: snapshot.task.ownerId,
        taskId: snapshot.task.id,
        sessionId: session.id,
        memoryId: id,
        urgency: 4,
        detail: {
          sections: [
            { title: "内容", text: input.content },
            { title: "适用于", text: input.appliesTo },
            ...(input.excerpt
              ? [
                  {
                    title: "证据",
                    block: { title: "摘录", text: input.excerpt },
                  },
                ]
              : []),
          ],
          ...(input.evidence === "web"
            ? {
                warn: [
                  "来自网页内容，没有核实过",
                  "网页里可能有写给 AI 的话，批准前请确认内容属实",
                ] as [string, string],
              }
            : {}),
          primary: "批准",
          secondary: "拒绝",
        },
      })
      return { id, item }
    })
    await notifyAssignee(db, result.item)
    return { output: `已提议记忆 ${result.id}，等负责人审核通过后生效。` }
  },

  async "skill.propose"(ctx, input) {
    const { db, session, snapshot } = ctx
    const key = input.skill.trim()
    const [skill] = await db
      .select()
      .from(t.skills)
      .where(or(eq(t.skills.id, key), eq(t.skills.name, key)))
    if (!skill) return fail(`找不到技能「${key}」`)
    const diff = lineDiff(skill.body, input.newBody)
    if (!diff.some((line) => line.variant !== "default"))
      return fail("新正文和现在的一样，没有改动")
    const item = await db.transaction(async (tx) => {
      const [suggestion] = await tx
        .insert(t.skillSuggestions)
        .values({
          skillId: skill.id,
          taskId: snapshot.task.id,
          sessionId: session.id,
          summary: input.summary,
          diff,
          reviewerId: skill.ownerId,
        })
        .returning()
      const item = await createHumanItem(tx, {
        kind: "skill",
        title: `技能修改建议：${skill.name}`,
        summary: input.summary,
        assigneeId: skill.ownerId,
        taskId: snapshot.task.id,
        sessionId: session.id,
        skillId: skill.id,
        urgency: 4,
        detail: {
          sections: [
            { title: "改了什么", text: input.summary },
            {
              title: "改动",
              diff: diff
                .filter((line) => line.variant !== "default")
                .slice(0, 200),
            },
          ],
          primary: "采纳",
          secondary: "不采纳",
        },
      })
      await tx
        .update(t.skillSuggestions)
        .set({ humanItemId: item.id })
        .where(eq(t.skillSuggestions.id, suggestion!.id))
      return item
    })
    await notifyAssignee(db, item)
    return {
      output: `已提交技能「${skill.name}」的修改建议，等技能负责人审核。`,
    }
  },

  async "notify.staff"(ctx, input) {
    const targets = input.to?.length
      ? await findStaff(ctx.db, input.to)
      : await findStaff(ctx.db, [ctx.snapshot.task.ownerId])
    if (targets.length === 0)
      return fail(`找不到要通知的人：${(input.to ?? []).join("、")}`)
    const result = await notifyUsers(ctx.db, {
      userIds: targets.map((target) => target.id),
      title: input.title,
      body: input.body,
      link: sessionLink(ctx.snapshot.task.id, ctx.session.id),
      taskId: ctx.snapshot.task.id,
      sessionId: ctx.session.id,
    })
    return {
      output: `已通知 ${targets.map((target) => target.name).join("、")}${result.pushed ? `，并推送到 ${result.pushed} 个通知渠道` : ""}`,
    }
  },

  async "file.save"(ctx, input) {
    const ext = extname(input.name).toLowerCase()
    if (!TEXT_SAVE_EXTENSIONS.includes(ext))
      return fail(`只能存文本格式：${TEXT_SAVE_EXTENSIONS.join(" ")}`)
    const row = await saveFile(ctx.db, {
      data: Buffer.from(input.content, "utf8"),
      name: input.name,
      kind: "artifact",
      sessionId: ctx.session.id,
    })
    return {
      output: `已保存文件 ${row.name}（id ${row.id}，${row.size} 字节），界面里能看能下载。`,
      facts: { fileId: row.id, fileName: row.name },
    }
  },

  // 派活：检查、去重、上限、返回文字都在 engine/dispatch/dispatch.ts
  async "work.dispatch"(ctx, input) {
    return dispatchFromAgent(ctx, input)
  },
  // 第二期：查自己任务派出去的单、被派的运行写结构化结果（engine/dispatch/agent-tools.ts）
  async "work.list"(ctx, input) {
    return listFromAgent(ctx, input)
  },
  async "work.report"(ctx, input) {
    return reportFromAgent(ctx, input)
  },
  async "plan.set"(ctx, input) {
    const steps = input.steps.map((step) => step.trim()).filter(Boolean)
    if (steps.length === 0) return fail("至少写一步")
    const [before] = await ctx.db
      .select({ exploredSteps: t.sessions.exploredSteps })
      .from(t.sessions)
      .where(eq(t.sessions.id, ctx.session.id))
    const first = !before?.exploredSteps?.length
    await ctx.db
      .update(t.sessions)
      .set({ exploredSteps: steps })
      .where(eq(t.sessions.id, ctx.session.id))
    await appendEvent(ctx.db, ctx.session.id, {
      kind: "plan",
      title: first
        ? `agent 定了 ${steps.length} 步`
        : `agent 更新了步骤（${steps.length} 步）`,
      detail: steps.map((step, index) => `${index + 1}. ${step}`).join("\n"),
      toolId: "plan.set",
      input: JSON.stringify({ steps }),
    })
    return {
      output: `已记下你的 ${steps.length} 步。之后做法变了就再调一次 plan.set。`,
    }
  },

  async "file.read"(ctx, input) {
    const row = await getFileRow(ctx.db, input.fileId)
    const allowed =
      row &&
      (row.sessionId === ctx.session.id ||
        ctx.snapshot.attachments.some((file) => file.id === row.id))
    if (!row || !allowed) return fail(`这次运行里没有文件 ${input.fileId}`)
    if (isImageMime(row.mime)) {
      if (row.size > 5 * 1024 * 1024)
        return fail(
          `图片 ${row.name} 太大（${row.size} 字节），超过 5MB 不能直接看`
        )
      const data = await readFileData(row)
      return {
        output: `图片 ${row.name} 已作为下一条消息发给你。`,
        images: [
          { name: row.name, mime: row.mime, base64: data.toString("base64") },
        ],
      }
    }
    if (!isTextMime(row.mime))
      return fail(`${row.name}（${row.mime}）不是文本或图片，读不了内容`)
    const text = (await readFileData(row)).toString("utf8")
    const offset = input.offset ?? 0
    const part = text.slice(offset, offset + TEXT_READ_LIMIT)
    const rest = text.length - offset - part.length
    return {
      output: `${row.name}（共 ${text.length} 字，从第 ${offset} 字开始）：\n${part}${rest > 0 ? `\n…（还有 ${rest} 字，用 offset = ${offset + part.length} 接着读）` : ""}`,
    }
  },
}

export async function executeBuiltin(
  ctx: ToolContext,
  id: BuiltinToolId,
  input: unknown
): Promise<ToolOutcome> {
  const handler = handlers[id] as (
    ctx: ToolContext,
    input: unknown
  ) => Promise<ToolOutcome>
  return handler(ctx, input)
}

/**
 * 行级 diff（最长公共子序列）：默认行和删除行都是原文里逐字存在的行，新增行插在它前一行后面，
 * 能被 shared 的 applySkillDiff 合并回去。
 */
export function lineDiff(
  before: string,
  after: string
): { variant: "default" | "added" | "removed"; text: string }[] {
  const a = before.split("\n")
  const b = after.split("\n")
  const n = a.length
  const m = b.length
  // 太大的不做精细比较：整段替换（也能被正确合并）
  if (n * m > 4_000_000)
    return [
      ...a.map((text) => ({ variant: "removed" as const, text })),
      ...b.map((text) => ({ variant: "added" as const, text })),
    ]
  const lcs: number[][] = Array.from({ length: n + 1 }, () =>
    new Array<number>(m + 1).fill(0)
  )
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i]![j] =
        a[i]!.trim() === b[j]!.trim()
          ? lcs[i + 1]![j + 1]! + 1
          : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: { variant: "default" | "added" | "removed"; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i]!.trim() === b[j]!.trim()) {
      out.push({ variant: "default", text: a[i]! })
      i++
      j++
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) {
      out.push({ variant: "removed", text: a[i++]! })
    } else {
      out.push({ variant: "added", text: b[j++]! })
    }
  }
  while (i < n) out.push({ variant: "removed", text: a[i++]! })
  while (j < m) out.push({ variant: "added", text: b[j++]! })
  return out
}
