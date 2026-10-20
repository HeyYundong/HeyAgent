// 定时：任务的 cron、人加的待办（时间 / cron / 事件 + 兜底期限）。
// cron 用 pg-boss 自带的 schedule（时区 Asia/Shanghai），按任务 id / 待办 id 作为 schedule key，改了就覆盖，删了就取消。
// 时间触发的待办排一个延迟任务，任务里带上当时的触发时间；待办后来改了时间，旧任务到点发现对不上就不做。
import { and, eq, inArray } from "drizzle-orm"
import { fmtDateTime } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { notifyUsers } from "./notify.js"
import { bossFor, QUEUES, SCHEDULE_TZ } from "./queue.js"
import {
  EngineError,
  latestWaitingSession,
  startSessionImpl,
} from "./sessions.js"
import { loadEngineSettings } from "./settings.js"
import { resume } from "./waits.js"

async function nextOccurrence(db: Db, cron: string): Promise<Date | null> {
  const boss = await bossFor(db)
  try {
    return boss.previewSchedule(cron, { tz: SCHEDULE_TZ, count: 1 })[0] ?? null
  } catch {
    return null
  }
}

export async function syncTaskScheduleImpl(
  db: Db,
  taskId: string
): Promise<void> {
  const boss = await bossFor(db)
  const [task] = await db.select().from(t.tasks).where(eq(t.tasks.id, taskId))
  if (!task || !task.enabled || !task.scheduleCron) {
    await boss.unschedule(QUEUES.taskCron, taskId)
    if (task?.nextRunAt)
      await db
        .update(t.tasks)
        .set({ nextRunAt: null })
        .where(eq(t.tasks.id, taskId))
    return
  }
  try {
    await boss.schedule(
      QUEUES.taskCron,
      task.scheduleCron,
      { taskId },
      { tz: SCHEDULE_TZ, key: taskId }
    )
  } catch (error) {
    throw new EngineError(
      "BAD_REQUEST",
      `定时写法认不出：${task.scheduleCron}（${(error as Error).message}）`
    )
  }
  await db
    .update(t.tasks)
    .set({ nextRunAt: await nextOccurrence(db, task.scheduleCron) })
    .where(eq(t.tasks.id, taskId))
}

/** task.cron 到点：新开一次运行 */
export async function onTaskCron(db: Db, data: { taskId: string }) {
  const [task] = await db
    .select()
    .from(t.tasks)
    .where(eq(t.tasks.id, data.taskId))
  if (!task || !task.enabled || !task.scheduleCron) return null
  // 上一次还没跑完（执行中 / 验收中）就跳过这次；挂起等待、等人处理的不算没跑完。任务上可以关
  if (task.cronSkipIfRunning) {
    const [busy] = await db
      .select({ id: t.sessions.id, status: t.sessions.status })
      .from(t.sessions)
      .where(and(eq(t.sessions.taskId, task.id), inArray(t.sessions.status, ["running", "verifying"])))
      .limit(1)
    if (busy) {
      console.log(`[engine] ${task.id} 定时到点，上一次 ${busy.id} 还${busy.status === "running" ? "在执行" : "在验收"}，跳过这次`)
      await db
        .update(t.tasks)
        .set({ nextRunAt: await nextOccurrence(db, task.scheduleCron) })
        .where(eq(t.tasks.id, task.id))
      return null
    }
  }
  let sessionId: string | null = null
  try {
    sessionId = (await startSessionImpl(db, { taskId: task.id, source: "cron" })).sessionId
  } catch (error) {
    // 开不了（例如任务没设复核模型）：重试也没用，不让 pg-boss 反复重跑；通知负责人，下次到点照样再试（和待办触发不了一样）
    if (!(error instanceof EngineError)) throw error
    console.warn(`[engine] ${task.id} 定时到点，没能开始运行：${error.message}`)
    await notifyUsers(db, { userIds: [task.ownerId], title: `${task.title}：定时运行没能开始`, body: error.message, taskId: task.id })
  }
  await db
    .update(t.tasks)
    .set({ nextRunAt: await nextOccurrence(db, task.scheduleCron) })
    .where(eq(t.tasks.id, task.id))
  return sessionId
}

// ---------- 人加的待办 ----------

export async function syncTodoImpl(db: Db, todoId: string): Promise<void> {
  const boss = await bossFor(db)
  const [todo] = await db
    .select()
    .from(t.humanTodos)
    .where(eq(t.humanTodos.id, todoId))
  if (!todo || todo.status !== "active" || todo.triggerKind !== "cron")
    await boss.unschedule(QUEUES.todoCron, todoId)
  if (!todo || todo.status !== "active") return

  switch (todo.triggerKind) {
    case "cron": {
      if (!todo.cron)
        throw new EngineError("BAD_REQUEST", "cron 待办没有写定时")
      try {
        await boss.schedule(
          QUEUES.todoCron,
          todo.cron,
          { todoId },
          { tz: SCHEDULE_TZ, key: todoId }
        )
      } catch (error) {
        throw new EngineError(
          "BAD_REQUEST",
          `定时写法认不出：${todo.cron}（${(error as Error).message}）`
        )
      }
      await db
        .update(t.humanTodos)
        .set({ nextAt: await nextOccurrence(db, todo.cron) })
        .where(eq(t.humanTodos.id, todoId))
      return
    }
    case "time":
    case "time_or_event": {
      if (!todo.at) throw new EngineError("BAD_REQUEST", "待办没有写时间")
      await boss.send(
        QUEUES.todoFire,
        { todoId, at: todo.at.toISOString() },
        {
          startAfter: todo.at,
          singletonKey: `${todoId}@${todo.at.toISOString()}`,
        }
      )
      return
    }
    case "event": {
      // 只等事件：加兜底期限，到期提醒加待办的人和任务负责人
      const days =
        todo.fallbackDays ?? (await loadEngineSettings(db)).eventFallbackDays
      const deadline = new Date(Date.now() + days * 24 * 60 * 60 * 1000)
      await boss.send(
        QUEUES.todoRemind,
        { todoId, version: todo.updatedAt.toISOString() },
        { startAfter: deadline }
      )
      return
    }
  }
}

/**
 * 待办触发：任务有挂起等待中的 session，就用待办标题作为「等到了什么」继续它；否则用待办标题作为附加说明新开一次运行。
 * 非 cron 的待办只触发一次（用条件更新保证只有一个来源生效）。
 */
export async function fireTodo(
  db: Db,
  todoId: string,
  _reason: "time" | "cron" | "event" | "manual"
): Promise<{ resumedSessionId?: string; startedSessionId?: string } | null> {
  const [todo] = await db
    .select()
    .from(t.humanTodos)
    .where(eq(t.humanTodos.id, todoId))
  if (!todo || todo.status !== "active") return null
  // cron 待办一直有效；其他的只触发一次（立即执行也算一次）
  if (todo.triggerKind !== "cron") {
    const done = await db
      .update(t.humanTodos)
      .set({ status: "done" })
      .where(
        and(eq(t.humanTodos.id, todoId), eq(t.humanTodos.status, "active"))
      )
      .returning({ id: t.humanTodos.id })
    if (done.length === 0) return null
  }
  try {
    const waitingId = await latestWaitingSession(db, todo.taskId)
    if (waitingId) {
      const resumed = await resume(db, {
        sessionId: waitingId,
        cause: "todo",
        title: `待办触发：${todo.title}`,
        message: `人加的待办到了：「${todo.title}」。`,
      })
      if (resumed) return { resumedSessionId: resumed }
    }
    const { sessionId } = await startSessionImpl(db, {
      taskId: todo.taskId,
      source: "todo",
      note: todo.title,
      actorId: null,
    })
    return { startedSessionId: sessionId }
  } catch (error) {
    const [task] = await db
      .select({ ownerId: t.tasks.ownerId, title: t.tasks.title })
      .from(t.tasks)
      .where(eq(t.tasks.id, todo.taskId))
    await notifyUsers(db, {
      userIds: [todo.createdById, ...(task ? [task.ownerId] : [])],
      title: `待办「${todo.title}」没能触发`,
      body: (error as Error).message,
      taskId: todo.taskId,
    })
    throw error
  }
}

export async function onTodoFire(db: Db, data: { todoId: string; at: string }) {
  const [todo] = await db
    .select()
    .from(t.humanTodos)
    .where(eq(t.humanTodos.id, data.todoId))
  if (
    !todo ||
    !todo.at ||
    todo.at.toISOString() !== data.at ||
    !["time", "time_or_event"].includes(todo.triggerKind)
  )
    return null
  return fireTodo(db, data.todoId, "time")
}

export async function onTodoCron(db: Db, data: { todoId: string }) {
  const [todo] = await db
    .select()
    .from(t.humanTodos)
    .where(eq(t.humanTodos.id, data.todoId))
  if (!todo || todo.status !== "active" || todo.triggerKind !== "cron")
    return null
  const result = await fireTodo(db, data.todoId, "cron")
  if (todo.cron)
    await db
      .update(t.humanTodos)
      .set({ nextAt: await nextOccurrence(db, todo.cron) })
      .where(eq(t.humanTodos.id, todo.id))
  return result
}

export async function onTodoRemind(
  db: Db,
  data: { todoId: string; version: string }
) {
  const [todo] = await db
    .select()
    .from(t.humanTodos)
    .where(eq(t.humanTodos.id, data.todoId))
  if (
    !todo ||
    todo.status !== "active" ||
    todo.triggerKind !== "event" ||
    todo.updatedAt.toISOString() !== data.version
  )
    return false
  const [task] = await db
    .select({ ownerId: t.tasks.ownerId, title: t.tasks.title })
    .from(t.tasks)
    .where(eq(t.tasks.id, todo.taskId))
  await notifyUsers(db, {
    userIds: [todo.createdById, ...(task ? [task.ownerId] : [])],
    title: `待办「${todo.title}」等了很久还没等到事件`,
    body: `在等事件「${todo.event ?? ""}」，从 ${fmtDateTime(todo.updatedAt)} 起已经到了兜底期限。待办还在，可以手动执行或删掉。`,
    taskId: todo.taskId,
  })
  return true
}

/** 外部事件或控制台手动触发：按事件名匹配等待中的 session 和待办 */
export async function todosForEvent(db: Db, event: string) {
  return db
    .select({ id: t.humanTodos.id })
    .from(t.humanTodos)
    .where(
      and(
        eq(t.humanTodos.status, "active"),
        eq(t.humanTodos.event, event),
        inArray(t.humanTodos.triggerKind, ["event", "time_or_event"])
      )
    )
}
