// 引擎相关的接口（M1 包 P1）：立即运行、取消、立即继续、处理要人办的事、触发事件、附件和产物、MCP 读工具、通知。
// 挂在 appRouter 的 engine 下（router.ts 已经挂好）。权限都用 shared 的 can()；处理要人办的事、立即运行、取消这类操作写 audit_events。
import { TRPCError } from "@trpc/server"
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm"
import {
  attachInputSchema,
  can,
  cancelInputSchema,
  fireEventInputSchema,
  fireEventResultSchema,
  listMcpServerToolsResultSchema,
  notificationListSchema,
  resolveHumanItemInputSchema,
  resolveVerifyDisputeInputSchema,
  runNowInputSchema,
  sessionFileSchema,
  sessionIdInputSchema,
} from "@heyagent/shared"
import { z } from "zod"

import { attachFilesToTask } from "../data/config/task-files.js"
import * as t from "../db/schema.js"
import {
  cancelSessionImpl,
  fireEventImpl,
  resumeNowImpl,
} from "../engine/control.js"
import {
  resolveHumanItemImpl,
  resolveVerifyDisputeImpl,
} from "../engine/humans.js"
import { writeAudit } from "../engine/records.js"
import { fireTodo } from "../engine/schedule.js"
import { EngineError, startSessionImpl } from "../engine/sessions.js"
import { listMcpServerToolsImpl } from "../engine/tools/mcp.js"
import {
  listSessionFiles,
  listTaskAttachments,
  toSessionFile,
} from "../files/service.js"
import { protectedProcedure, router, type Context } from "./init.js"

type Db = Context["db"]

const forbidden = (message = "你没有权限做这件事") =>
  new TRPCError({ code: "FORBIDDEN", message })
const notFound = (message: string) =>
  new TRPCError({ code: "NOT_FOUND", message })

/** 引擎的错误换成 tRPC 的错误码 */
async function engineCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn()
  } catch (error) {
    if (error instanceof EngineError)
      throw new TRPCError({ code: error.code, message: error.message })
    throw error
  }
}

async function taskOf(db: Db, taskId: string) {
  const [task] = await db
    .select({ id: t.tasks.id, ownerId: t.tasks.ownerId })
    .from(t.tasks)
    .where(eq(t.tasks.id, taskId))
  if (!task) throw notFound(`找不到任务 ${taskId}`)
  return task
}

async function sessionWithTask(db: Db, sessionId: string) {
  const [row] = await db
    .select({
      id: t.sessions.id,
      taskId: t.sessions.taskId,
      ownerId: t.tasks.ownerId,
      snapshot: t.sessions.snapshot,
    })
    .from(t.sessions)
    .innerJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))
    .where(eq(t.sessions.id, sessionId))
  if (!row) throw notFound(`找不到 session ${sessionId}`)
  return row
}

export const engineRouter = router({
  /** 立即运行（可以带附件：先 POST /api/files 上传拿到 id） */
  runNow: protectedProcedure
    .input(runNowInputSchema)
    .output(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const task = await taskOf(ctx.db, input.taskId)
      if (!can(ctx.user, "task.manage", { ownerId: task.ownerId }))
        throw forbidden("只有任务负责人和主管能运行这个任务")
      return engineCall(() =>
        startSessionImpl(ctx.db, {
          taskId: task.id,
          source: "manual",
          actorId: ctx.user.id,
          attachmentFileIds: input.attachmentFileIds,
          note: input.note,
        })
      )
    }),

  /**
   * 待办的「立即执行」（M1 P3 加）：和待办到点一样走 fireTodo——任务有挂起等待的 session 就用待办标题继续它，
   * 没有就新开一次运行；非 cron 的待办执行后就结束，不会到点再触发一次。
   * 权限照 shared 的 todo.run：加这条的人、任务负责人、主管。
   */
  runTodoNow: protectedProcedure
    .input(z.object({ todoId: z.string().min(1) }))
    .output(
      z.object({
        resumedSessionId: z.string().optional(),
        startedSessionId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [todo] = await ctx.db
        .select({
          id: t.humanTodos.id,
          taskId: t.humanTodos.taskId,
          createdById: t.humanTodos.createdById,
        })
        .from(t.humanTodos)
        .where(eq(t.humanTodos.id, input.todoId))
      if (!todo) throw notFound(`找不到待办 ${input.todoId}`)
      const task = await taskOf(ctx.db, todo.taskId)
      if (
        !can(ctx.user, "todo.run", {
          createdById: todo.createdById,
          taskOwnerId: task.ownerId,
        })
      )
        throw forbidden("只有加这条待办的人、任务负责人和主管能立即执行")
      // fireTodo 会先把一次性待办标成已执行再开始运行；任务停用时先拦下，免得待办白白结束
      const [{ enabled } = { enabled: false }] = await ctx.db
        .select({ enabled: t.tasks.enabled })
        .from(t.tasks)
        .where(eq(t.tasks.id, task.id))
      if (!enabled)
        throw new TRPCError({
          code: "BAD_REQUEST",
          message: "任务已停用，先启用再执行",
        })
      const result = await engineCall(() =>
        fireTodo(ctx.db, todo.id, "manual")
      )
      if (!result)
        throw new TRPCError({
          code: "CONFLICT",
          message: "这条待办已经执行过或已经删除",
        })
      await writeAudit(ctx.db, {
        actorId: ctx.user.id,
        action: "todo.run",
        targetTable: "human_todos",
        targetId: todo.id,
        detail: result,
      })
      return result
    }),

  /** 取消一次运行（标失败，写清是谁取消的） */
  cancel: protectedProcedure
    .input(cancelInputSchema)
    .output(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const session = await sessionWithTask(ctx.db, input.sessionId)
      if (!can(ctx.user, "task.manage", { ownerId: session.ownerId }))
        throw forbidden("只有任务负责人和主管能取消")
      return engineCall(() =>
        cancelSessionImpl(ctx.db, {
          sessionId: session.id,
          actorId: ctx.user.id,
          actorName: ctx.user.name,
          reason: input.reason,
        })
      )
    }),

  /** 挂起等待中的 session 立即继续 */
  resumeNow: protectedProcedure
    .input(sessionIdInputSchema)
    .output(z.object({ sessionId: z.string() }))
    .mutation(async ({ ctx, input }) => {
      const session = await sessionWithTask(ctx.db, input.sessionId)
      if (!can(ctx.user, "session.resume", { taskOwnerId: session.ownerId }))
        throw forbidden("只有任务负责人和主管能让它立即继续")
      return engineCall(() =>
        resumeNowImpl(ctx.db, {
          sessionId: session.id,
          actorId: ctx.user.id,
          actorName: ctx.user.name,
        })
      )
    }),

  /** 处理要人办的事：批准 / 拒绝 / 已处理，加备注；关联的 session 在等它就继续 */
  resolveHumanItem: protectedProcedure
    .input(resolveHumanItemInputSchema)
    .output(
      z.object({
        resumedSessionId: z.string().optional(),
        endedSessionId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [item] = await ctx.db
        .select({ assigneeId: t.humanItems.assigneeId })
        .from(t.humanItems)
        .where(eq(t.humanItems.id, input.itemId))
      if (!item) throw notFound(`找不到待办 ${input.itemId}`)
      if (!can(ctx.user, "humanItem.resolve", { assigneeId: item.assigneeId }))
        throw forbidden("这件事不是分给你的")
      return engineCall(() =>
        resolveHumanItemImpl(ctx.db, {
          itemId: input.itemId,
          how: input.how,
          note: input.note,
          actorId: ctx.user.id,
          actorName: ctx.user.name,
        })
      )
    }),

  /**
   * 验收争议（M3）：算通过 / 算失败 / 补充说明后继续（note 必填，交给 agent）。
   * 和 resolveHumanItem 处理 kind = verify 的事效果一样（approve = 算通过，reject = 算失败，done = 补充说明后继续）
   */
  resolveVerifyDispute: protectedProcedure
    .input(resolveVerifyDisputeInputSchema)
    .output(
      z.object({
        resumedSessionId: z.string().optional(),
        endedSessionId: z.string().optional(),
      })
    )
    .mutation(async ({ ctx, input }) => {
      const [item] = await ctx.db
        .select({ assigneeId: t.humanItems.assigneeId })
        .from(t.humanItems)
        .where(eq(t.humanItems.id, input.itemId))
      if (!item) throw notFound(`找不到待办 ${input.itemId}`)
      if (!can(ctx.user, "humanItem.resolve", { assigneeId: item.assigneeId }))
        throw forbidden("这件事不是分给你的")
      return engineCall(() =>
        resolveVerifyDisputeImpl(ctx.db, {
          itemId: input.itemId,
          how: input.how,
          note: input.note,
          actorId: ctx.user.id,
          actorName: ctx.user.name,
        })
      )
    }),

  /** 控制台手动触发一个事件（和外部系统 POST /api/events 效果一样）。会叫醒任何人的 session，所以只给主管 */
  fireEvent: protectedProcedure
    .input(fireEventInputSchema)
    .output(fireEventResultSchema)
    .mutation(async ({ ctx, input }) => {
      if (!can(ctx.user, "config.manage", {}))
        throw forbidden("只有主管能手动触发事件")
      // 平台内部的事件名（work.done: / browser. / desktop: / subagent.）会被拒：BAD_REQUEST
      return engineCall(() =>
        fireEventImpl(ctx.db, {
          event: input.event,
          data: input.data,
          actorId: ctx.user.id,
          via: "console",
        })
      )
    }),

  /** 任务附件：跨运行一直有效 */
  taskAttachments: protectedProcedure
    .input(z.object({ taskId: z.string().min(1) }))
    .output(z.array(sessionFileSchema))
    .query(async ({ ctx, input }) => {
      await taskOf(ctx.db, input.taskId)
      return (await listTaskAttachments(ctx.db, input.taskId)).map((row) =>
        toSessionFile(row, "task")
      )
    }),

  attachToTask: protectedProcedure
    .input(attachInputSchema)
    .output(sessionFileSchema)
    .mutation(async ({ ctx, input }) => {
      // 规矩（权限、只收没归属的上传文件、审计）在 data/config/task-files.ts，助手的 attach_files_to_task 也用它
      const [row] = await attachFilesToTask({ db: ctx.db, actor: ctx.user }, { taskId: input.taskId, fileIds: [input.fileId] })
      return toSessionFile(row!, "task")
    }),

  /** 去掉任务附件。已经开始的运行快照里还有它，照样能读 */
  detachFromTask: protectedProcedure
    .input(attachInputSchema)
    .output(z.object({ ok: z.boolean() }))
    .mutation(async ({ ctx, input }) => {
      const task = await taskOf(ctx.db, input.taskId)
      if (!can(ctx.user, "task.manage", { ownerId: task.ownerId }))
        throw forbidden("只有任务负责人和主管能改任务附件")
      const updated = await ctx.db
        .update(t.files)
        .set({ taskId: null, kind: "upload" })
        .where(
          and(
            eq(t.files.id, input.fileId),
            eq(t.files.taskId, task.id),
            isNull(t.files.sessionId)
          )
        )
        .returning({ id: t.files.id })
      if (updated.length === 0) throw notFound("这个任务没有这个附件")
      await writeAudit(ctx.db, {
        actorId: ctx.user.id,
        action: "task.detach",
        targetTable: "tasks",
        targetId: task.id,
        detail: { fileId: input.fileId },
      })
      return { ok: true }
    }),

  /** session 的附件和产物（下载走 GET /api/files/:id） */
  sessionFiles: protectedProcedure
    .input(sessionIdInputSchema)
    .output(z.array(sessionFileSchema))
    .query(async ({ ctx, input }) => {
      const session = await sessionWithTask(ctx.db, input.sessionId)
      return listSessionFiles(
        ctx.db,
        session.id,
        session.snapshot?.attachments.map((file) => file.id) ?? []
      )
    }),

  /** 工具页的「连接并读取工具」 */
  listMcpServerTools: protectedProcedure
    .input(z.object({ serverId: z.string().min(1) }))
    .output(listMcpServerToolsResultSchema)
    .mutation(async ({ ctx, input }) => {
      if (!can(ctx.user, "config.manage", {}))
        throw forbidden("只有主管能改工具配置")
      return listMcpServerToolsImpl(ctx.db, input.serverId)
    }),

  notifications: router({
    /** 我的通知（新的在前）和未读数 */
    list: protectedProcedure
      .input(
        z
          .object({
            limit: z.number().int().min(1).max(200).optional(),
            unreadOnly: z.boolean().optional(),
          })
          .optional()
      )
      .output(notificationListSchema)
      .query(async ({ ctx, input }) => {
        const mine = eq(t.notifications.userId, ctx.user.id)
        const rows = await ctx.db
          .select()
          .from(t.notifications)
          .where(
            input?.unreadOnly ? and(mine, isNull(t.notifications.readAt)) : mine
          )
          .orderBy(desc(t.notifications.createdAt), desc(t.notifications.id))
          .limit(input?.limit ?? 50)
        const [unread] = await ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(t.notifications)
          .where(and(mine, isNull(t.notifications.readAt)))
        return {
          items: rows.map((row) => ({
            id: row.id,
            title: row.title,
            body: row.body,
            ...(row.link ? { link: row.link } : {}),
            ...(row.taskId ? { taskId: row.taskId } : {}),
            ...(row.sessionId ? { sessionId: row.sessionId } : {}),
            createdAt: row.createdAt.toISOString(),
            ...(row.readAt ? { readAt: row.readAt.toISOString() } : {}),
          })),
          unread: unread?.n ?? 0,
        }
      }),
    /** 标为已读：给 ids 就只标这些，不给就全部标已读 */
    markRead: protectedProcedure
      .input(z.object({ ids: z.array(z.number().int()).max(500).optional() }))
      .output(z.object({ updated: z.number().int() }))
      .mutation(async ({ ctx, input }) => {
        const conditions = [
          eq(t.notifications.userId, ctx.user.id),
          isNull(t.notifications.readAt),
          input.ids ? inArray(t.notifications.id, input.ids) : undefined,
        ]
        const rows = await ctx.db
          .update(t.notifications)
          .set({ readAt: new Date() })
          .where(and(...conditions))
          .returning({ id: t.notifications.id })
        return { updated: rows.length }
      }),
  }),
})
