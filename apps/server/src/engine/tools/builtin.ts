// 内置工具的执行。全部通用：只碰平台自己的对象（检查点、等待、待办、记忆、技能、通知、文件）。
import { extname } from "node:path"

import { asc, eq, inArray, or, sql } from "drizzle-orm"
import {
  builtinToolInputs,
  fmtDateTime,
  memoryId,
  workDoneEvent,
  runOutcomeLabel,
  type BuiltinToolId,
  type HumanDetail,
  type SessionSnapshot,
} from "@heyagent/shared"
import type { z } from "zod"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import {
  deleteSpaceFile,
  getFileRow,
  isImageMime,
  isTextMime,
  listSpace,
  normalizeSpacePath,
  readFileData,
  RESERVED_SPACE_DIRS,
  SPACE_PATH_MAX,
  SPACE_SOURCE_LABEL,
  SpacePathError,
  spaceUsage,
  TEXT_SAVE_EXTENSIONS,
  writeSpaceFile,
  type FileRow,
  type SpaceEntry,
} from "../../files/service.js"
import { sizeText } from "../../browser/downloads.js"
import { runCode, spaceReadPath } from "../../sandbox/code-run.js"
import { runtime } from "../runtime.js"
import {
  buildWorkbook,
  isPlainSheet,
  isSheetFile,
  loadBook,
  overviewText,
  rangeText,
  SheetError,
  XLS_MIME,
  XLSX_MIME,
} from "../../files/sheets.js"
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
import type { AgentClaim } from "../outcome.js"
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
  /** 这个工具要让运行结束（报结果 run.finish、旧的报没完成 run.not_done）：引擎按 agent 报的结果收尾（outcome.ts 再按硬规则核），不再调模型 */
  finish?: AgentClaim
  /** 要交给模型看的图片（作为下一条用户消息） */
  images?: { name: string; mime: string; base64: string }[]
  /** 要从输出里隐藏的密钥原文 */
  secrets?: string[]
  /** M3：给规则用的事实（自动记录检查点）：打开的网页、存下的文件 */
  facts?: { url?: string; title?: string; fileId?: string; fileName?: string }
  /** M3：引擎内部信号。page_needs_human = 浏览器检测到验证码或登录页（规则 page_needs_human 在内置转人工之外再加动作） */
  signals?: "page_needs_human"[]
  /** 工具自己已经按规矩截断过（code.run：stdout、stderr 各留末尾，全文另存）：网关不再按 toolOutputMaxChars 截 */
  keepFull?: true
}

const fail = (output: string): ToolOutcome => ({ output, isError: true })

/** 这次运行的空间（快照里的附件 + 只属于这次运行的文件） */
const spaceOf = (ctx: ToolContext) =>
  listSpace(ctx.db, ctx.session.id, ctx.snapshot.attachments.map((file) => file.id))

const READONLY_DIRS_TEXT = RESERVED_SPACE_DIRS.map((dir) => `${dir}/`).join(" ")

/** 按路径找空间里的文件（容忍开头的 /workspace/、/、./） */
function entryAt(entries: SpaceEntry[], raw: string) {
  const path = spaceReadPath(raw)
  return { path, entry: entries.find((each) => each.path === path) }
}

/**
 * agent 要往空间里写一个文件之前：路径不能和已有的文件、目录打架（a 是文件就不能再有 a/b），总量不能超；
 * 返回要覆盖的老产物（加路径之前存的，列表里按名字放的那种）
 */
async function checkAgentWrite(
  ctx: ToolContext,
  entries: SpaceEntry[],
  path: string,
  size: number
): Promise<{ error: string } | { legacyRow?: FileRow }> {
  for (const each of entries) {
    if (each.path.startsWith(`${path}/`)) return { error: `${path} 已经是一个目录（里面有 ${each.path}），不能再存成文件，换个路径` }
    if (path.startsWith(`${each.path}/`)) return { error: `${each.path} 已经是一个文件，不能当目录用，换个路径` }
  }
  const existing = entries.find((each) => each.path === path)
  if (existing && !existing.writable) return { error: `${path} 是只读的，不能覆盖` }
  const limit = runtime.sandbox.spaceMaxBytes
  const usage = await spaceUsage(ctx.db, ctx.session.id)
  if (usage - (existing?.row.size ?? 0) + size > limit)
    return { error: `这次运行的空间满了（已经用了 ${sizeText(usage)}，上限 ${sizeText(limit)}）。用 file.delete 删掉不要的文件再存` }
  return { legacyRow: existing && !existing.row.path ? existing.row : undefined }
}

/** old 在 text 里出现几次（重叠的也算：那样也是不唯一） */
function countOccurrences(text: string, old: string) {
  let count = 0
  for (let index = text.indexOf(old); index !== -1; index = text.indexOf(old, index + 1)) count++
  return count
}

/**
 * file.edit 的替换：按顺序每段 old 必须正好出现一次，全部成功才返回新文本；有一段不行就返回错误（文件不改）
 */
export function applyEdits(text: string, edits: { old: string; new: string }[]): { text: string } | { error: string } {
  let current = text
  for (const [index, edit] of edits.entries()) {
    const count = countOccurrences(current, edit.old)
    const label = edits.length > 1 ? `第 ${index + 1} 段 old` : "old"
    if (count === 0)
      return { error: `${label} 在文件里找不到（要和原文一字不差，包括空格、缩进和换行；前面的段替换完以后再找）。文件没改` }
    if (count > 1) return { error: `${label} 在文件里出现了 ${count} 次，不唯一：多带几行上下文让它只出现一次。文件没改` }
    const at = current.indexOf(edit.old)
    current = current.slice(0, at) + edit.new + current.slice(at + edit.old.length)
  }
  return { text: current }
}

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

  // 按路径存进这次运行的空间：同一路径再存就是覆盖（id 不变）
  async "file.save"(ctx, input) {
    let path: string
    try {
      path = normalizeSpacePath(input.path)
    } catch (error) {
      if (error instanceof SpacePathError) return fail(error.message)
      throw error
    }
    const ext = extname(path).toLowerCase()
    let data: Buffer
    let mime: string | undefined
    let what: string
    if (input.sheets) {
      // Excel：扩展名和 format 要对得上；没写扩展名就按 format 补上
      const format = input.format ?? (ext === ".xls" ? "xls" : "xlsx")
      if (ext && ext !== ".xlsx" && ext !== ".xls")
        return fail(`给了 sheets 就是存 Excel，路径要以 .xlsx 或 .xls 结尾（现在是 ${path}）`)
      if (ext && ext !== `.${format}`)
        return fail(`路径是 ${ext}，format 却是 ${format}，两个要一致`)
      if (!ext) {
        path = `${path}.${format}`
        if (path.length > SPACE_PATH_MAX) return fail(`路径太长，最多 ${SPACE_PATH_MAX} 字`)
      }
      try {
        data = buildWorkbook(input.sheets, format)
      } catch (error) {
        if (error instanceof SheetError) return fail(error.message)
        throw error
      }
      mime = format === "xls" ? XLS_MIME : XLSX_MIME
      const rows = input.sheets.reduce((sum, sheet) => sum + sheet.rows.length, 0)
      what = ` Excel 文件 ${path}（{id}，${input.sheets.length} 个工作表、共 ${rows} 行，${data.length} 字节）`
    } else {
      if (ext === ".xlsx" || ext === ".xls")
        return fail("存 Excel 要给 sheets（每个工作表的 name 和 rows），不用 content")
      if (!TEXT_SAVE_EXTENSIONS.includes(ext))
        return fail(`只能存文本和代码：${TEXT_SAVE_EXTENSIONS.join(" ")}；Excel 用 .xlsx 或 .xls 加 sheets`)
      if (input.content === undefined) return fail("要给 content（文件内容）")
      data = Buffer.from(input.content, "utf8")
      what = `文件 ${path}（{id}，${data.length} 字节）`
    }
    const checked = await checkAgentWrite(ctx, await spaceOf(ctx), path, data.length)
    if ("error" in checked) return fail(checked.error)
    const { row, created } = await writeSpaceFile(ctx.db, {
      sessionId: ctx.session.id,
      path,
      data,
      mime,
      legacyRow: checked.legacyRow,
    })
    return {
      output: `已${created ? "新建" : "覆盖"}${what.replace("{id}", `id ${row.id}${created ? "" : "，id 不变"}`)}，界面里能看能下载。`,
      facts: { fileId: row.id, fileName: path },
    }
  },

  async "file.list"(ctx, input) {
    const entries = await spaceOf(ctx)
    const prefix = input.prefix?.trim() ? spaceReadPath(input.prefix) : ""
    const dir = prefix.replace(/\/+$/, "")
    const shown = dir ? entries.filter((each) => each.path === dir || each.path.startsWith(`${dir}/`)) : entries
    if (shown.length === 0)
      return { output: dir ? `空间里 ${dir}/ 下没有文件（共 ${entries.length} 个文件，不带 prefix 看全部）` : "这次运行的空间里还没有文件" }
    const sorted = [...shown].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    const LIMIT = 500
    const total = shown.reduce((sum, each) => sum + each.row.size, 0)
    const lines = sorted
      .slice(0, LIMIT)
      .map(
        (each) =>
          `${each.path} · ${each.row.id} · ${SPACE_SOURCE_LABEL[each.source]} · ${sizeText(each.row.size)} · ${each.row.updatedAt.getTime() !== each.row.createdAt.getTime() ? "更新于" : "建于"} ${fmtDateTime(each.row.updatedAt)}`
      )
    return {
      output: [
        `${dir ? `${dir}/ 下` : "空间里"}有 ${shown.length} 个文件（共 ${sizeText(total)}）。路径、id、来源、大小、时间；${READONLY_DIRS_TEXT}是只读的：`,
        ...lines,
        shown.length > LIMIT ? `…还有 ${shown.length - LIMIT} 个，用 prefix 只看一个目录` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    }
  },

  async "file.edit"(ctx, input) {
    const entries = await spaceOf(ctx)
    const { path, entry } = entryAt(entries, input.path)
    if (!entry) return fail(`空间里没有 ${path}（用 file.list 看有哪些）`)
    if (!entry.writable)
      return fail(`${path} 是只读的（${READONLY_DIRS_TEXT}放附件、下载、截图和工具输出全文），不能改。要改就读出来，用 file.save 存到别的路径`)
    if (!isTextMime(entry.row.mime))
      return fail(`${path}（${entry.row.mime}）不是文本文件，不能按原文替换。Excel 用 file.save 重新存，或者用 code.run 处理`)
    const before = (await readFileData(entry.row)).toString("utf8")
    const result = applyEdits(before, input.edits)
    if ("error" in result) return fail(`${path}：${result.error}`)
    if (result.text === before) return { output: `${path} 没有变化（替换前后一样），没有保存` }
    const data = Buffer.from(result.text, "utf8")
    const checked = await checkAgentWrite(ctx, entries, path, data.length)
    if ("error" in checked) return fail(checked.error)
    const { row } = await writeSpaceFile(ctx.db, {
      sessionId: ctx.session.id,
      path,
      data,
      mime: entry.row.mime,
      legacyRow: checked.legacyRow,
    })
    return {
      output: `已改 ${path}：替换了 ${input.edits.length} 段（id ${row.id} 不变，现在 ${data.length} 字节）`,
      facts: { fileId: row.id, fileName: path },
    }
  },

  async "file.delete"(ctx, input) {
    const { path, entry } = entryAt(await spaceOf(ctx), input.path)
    if (!entry) return fail(`空间里没有 ${path}（用 file.list 看有哪些）`)
    if (!entry.writable) return fail(`只能删 agent 写的文件；${path} 是${SPACE_SOURCE_LABEL[entry.source]}，只读`)
    try {
      await deleteSpaceFile(ctx.db, entry.row)
    } catch (error) {
      if (error instanceof SpacePathError) return fail(error.message)
      throw error
    }
    return { output: `已删掉 ${path}（id ${entry.row.id}）` }
  },

  // 运行代码：在 bubblewrap 沙箱里跑，空间文件挂在 /workspace（sandbox/code-run.ts）
  async "code.run"(ctx, input) {
    return runCode(ctx, input)
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
  // 报结果：只把结果交给引擎，由引擎（loop.ts）收尾：办成的先过「说做完了」的规则（三方验收），再按硬规则、复核定最终结果
  async "run.finish"(_ctx, input) {
    const reason = input.reason?.trim()
    if (input.outcome !== "achieved" && !reason)
      return fail(`outcome = ${input.outcome} 时要写 reason：拿到了什么、缺了什么、为什么。补上 reason 再调一次`)
    const summary = input.summary.trim()
    const evidence = input.evidence.trim()
    if (!summary || !evidence) return fail("summary 和 evidence 都要写：做了什么、结果在哪；对照目标逐条写依据")
    const label = runOutcomeLabel[input.outcome]
    return {
      output: `已记下：这次运行的结果是「${label}」${reason ? `（${reason}）` : ""}。运行到此结束，系统还会按检查点、要交回的结果${input.outcome === "achieved" ? "和复核" : ""}再核一遍。`,
      finish: { outcome: input.outcome, summary, evidence, ...(reason ? { reason } : {}), via: "finish" },
    }
  },
  // 报没完成（旧运行的快照里还有）：等价于 run.finish outcome = not_achieved
  async "run.not_done"(_ctx, input) {
    const reason = input.reason.trim()
    if (!reason) return fail("要写 reason：为什么没做成")
    return { output: `已记下：这次运行没办成（${reason}）。运行到此结束。`, finish: { outcome: "not_achieved", summary: "", reason, via: "not_done" } }
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
    if ((input.fileId === undefined) === (input.path === undefined))
      return fail("fileId 和 path 要给一个，而且只能给一个")
    let row: FileRow | undefined
    if (input.path !== undefined) {
      const found = entryAt(await spaceOf(ctx), input.path)
      if (!found.entry) return fail(`空间里没有 ${found.path}（用 file.list 看有哪些）`)
      row = found.entry.row
    } else {
      row = await getFileRow(ctx.db, input.fileId!)
      const allowed =
        row &&
        (row.sessionId === ctx.session.id ||
          ctx.snapshot.attachments.some((file) => file.id === row!.id))
      if (!row || !allowed) return fail(`这次运行里没有文件 ${input.fileId}`)
    }
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
    // 表格：按工作表读（csv / tsv 给了 offset 就照原文读）
    const tableParams =
      input.sheet !== undefined || input.startRow !== undefined || input.rows !== undefined
    if (
      isSheetFile(row.name, row.mime) &&
      (tableParams || input.offset === undefined || !isPlainSheet(row.name, row.mime))
    ) {
      try {
        const book = await loadBook(row)
        return {
          output: tableParams
            ? rangeText(book, row.name, input, TEXT_READ_LIMIT)
            : overviewText(book, row.name, TEXT_READ_LIMIT),
        }
      } catch (error) {
        if (error instanceof SheetError) return fail(error.message)
        return fail(`${row.name} 读不了：${(error as Error).message}`)
      }
    }
    if (!isTextMime(row.mime))
      return fail(
        `${row.name}（${row.mime}）不是文本、图片或表格，读不了内容（能读：文本、png/jpg/gif/webp、xlsx/xls/xlsm/xlsb/ods/csv/tsv）`
      )
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
