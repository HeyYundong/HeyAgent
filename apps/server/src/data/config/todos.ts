// 人加的待办的写操作：新建、修改、删除。保存后调引擎的 syncTodo（到点、cron、等事件由引擎管）。
import { eq } from "drizzle-orm"
import { nextCronRun, shanghaiToIso, todoId, type todoTriggerInputSchema } from "@heyagent/shared"
import type { z } from "zod"

import * as t from "../../db/schema.js"
import { syncTodo } from "../../engine/api.js"
import { assertCan, audit, badRequest, nextNo, notFound, type DbOrTx, type WriteCtx } from "./common.js"

type TriggerInput = z.output<typeof todoTriggerInputSchema>

export interface TodoFields {
  taskId: string
  title: string
  trigger: TriggerInput
}

/** 页面的 datetime-local 给的是上海时间「2026-10-17T10:00」；带时区的 ISO 也认 */
function parseAt(value: string): Date {
  const text = value.trim()
  let ms = Number.NaN
  try {
    ms = /(Z|[+-]\d{2}:?\d{2})$/.test(text) ? Date.parse(text) : Date.parse(shanghaiToIso(text.slice(0, 16)))
  } catch {
    // 下面统一报错
  }
  if (Number.isNaN(ms)) throw badRequest(`认不出的时间：${value}`)
  return new Date(ms)
}

function triggerColumns(trigger: TriggerInput) {
  const empty = { at: null, cron: null, cronText: null, nextAt: null, event: null, fallbackDays: null }
  switch (trigger.kind) {
    case "time":
      return { ...empty, triggerKind: "time" as const, at: parseAt(trigger.at) }
    case "cron":
      return { ...empty, triggerKind: "cron" as const, cron: trigger.cron, cronText: trigger.text || trigger.cron, nextAt: new Date(nextCronRun(trigger.cron)!) }
    case "event":
      return { ...empty, triggerKind: "event" as const, event: trigger.event, fallbackDays: trigger.fallbackDays }
    case "time_or_event":
      return { ...empty, triggerKind: "time_or_event" as const, at: parseAt(trigger.at), event: trigger.event }
  }
}

async function loadTask(db: DbOrTx, id: string) {
  const [task] = await db.select({ id: t.tasks.id, ownerId: t.tasks.ownerId }).from(t.tasks).where(eq(t.tasks.id, id))
  if (!task) throw notFound("任务", id)
  return task
}

async function loadTodo(db: DbOrTx, id: string) {
  const [row] = await db.select().from(t.humanTodos).where(eq(t.humanTodos.id, id))
  if (!row) throw notFound("待办", id)
  return row
}

export async function createTodo(ctx: WriteCtx, input: TodoFields) {
  const id = await ctx.db.transaction(async (tx) => {
    const task = await loadTask(tx, input.taskId)
    assertCan(ctx.actor, "todo.create", { taskOwnerId: task.ownerId }, "只能给自己负责的任务加待办")
    const id = todoId(await nextNo(tx, "todo_no_seq"))
    await tx.insert(t.humanTodos).values({ id, taskId: input.taskId, title: input.title, ...triggerColumns(input.trigger), createdById: ctx.actor.id })
    await audit(tx, ctx.actor.id, "todo.create", "human_todos", id, { taskId: input.taskId, trigger: input.trigger.kind })
    return id
  })
  await syncTodo(ctx.db, id)
  return { id }
}

export async function updateTodo(ctx: WriteCtx, input: TodoFields & { id: string }) {
  await ctx.db.transaction(async (tx) => {
    const before = await loadTodo(tx, input.id)
    assertCan(ctx.actor, "todo.manage", { createdById: before.createdById }, "只有加这条待办的人和主管能改")
    if (input.taskId !== before.taskId) {
      const task = await loadTask(tx, input.taskId)
      assertCan(ctx.actor, "todo.create", { taskOwnerId: task.ownerId }, "只能挪到自己负责的任务下")
    }
    await tx.update(t.humanTodos).set({ taskId: input.taskId, title: input.title, ...triggerColumns(input.trigger) }).where(eq(t.humanTodos.id, input.id))
    await audit(tx, ctx.actor.id, "todo.update", "human_todos", input.id, { taskId: input.taskId, trigger: input.trigger.kind })
  })
  await syncTodo(ctx.db, input.id)
  return { id: input.id }
}

export async function deleteTodo(ctx: WriteCtx, input: { id: string }) {
  await ctx.db.transaction(async (tx) => {
    const before = await loadTodo(tx, input.id)
    assertCan(ctx.actor, "todo.manage", { createdById: before.createdById }, "只有加这条待办的人和主管能删")
    await tx.delete(t.humanTodos).where(eq(t.humanTodos.id, input.id))
    await audit(tx, ctx.actor.id, "todo.delete", "human_todos", input.id, { taskId: before.taskId, title: before.title })
  })
  await syncTodo(ctx.db, input.id)
  return { id: input.id }
}
