// 引擎对外的入口（docs/dev/m1.md「对接接口」）。包 P2 只在配置写操作里调用 syncTaskSchedule、syncTodo。
// 签名和监工定的一致，不要改；实现在 engine/ 下各个文件里。
// 这几个函数在任何进程里都能用：发任务用的 pg-boss 按 db 登记（worker 登记自己的，其他进程第一次用到时借 db 的连接池起一个只发任务的）。
import type { Db } from "../db/client.js"
import { syncTaskScheduleImpl, syncTodoImpl } from "./schedule.js"
import { startSessionImpl } from "./sessions.js"

/** 一次运行是怎么触发的 */
export type SessionSource = "manual" | "cron" | "todo" | "event" | "dispatch"

export interface StartSessionInput {
  taskId: string
  source: SessionSource
  /** 谁点的「立即运行」；定时、事件触发时为空 */
  actorId?: string | null
  /** 这次运行额外带的附件（files.id） */
  attachmentFileIds?: string[]
  /** 额外的一句话，例如人加的待办的标题 */
  note?: string
}

/** 新建一次运行（session）并排队执行 */
export async function startSession(
  db: Db,
  input: StartSessionInput
): Promise<{ sessionId: string }> {
  return startSessionImpl(db, input)
}

/** 任务新建、修改、删除、启用或停用之后调用：按任务的 cron 和启用状态同步定时触发 */
export async function syncTaskSchedule(db: Db, taskId: string): Promise<void> {
  await syncTaskScheduleImpl(db, taskId)
}

/** 人加的待办新建、修改、删除之后调用：同步它的定时 / cron / 事件触发 */
export async function syncTodo(db: Db, todoId: string): Promise<void> {
  await syncTodoImpl(db, todoId)
}
