// 引擎对外的入口（docs/dev/m1.md「对接接口」）。M1 包 P1 实现；包 P2 只在配置写操作里调用 syncTaskSchedule、syncTodo。
// 签名要改，先找监工：两个包在并行开发，靠这份签名对接。
// 现在是占位实现：syncTaskSchedule、syncTodo 什么都不做，startSession 直接报错，P1 会换成真的。
import type { Db } from "../db/client.js"

/** 一次运行是怎么触发的 */
export type SessionSource = "manual" | "cron" | "todo" | "event"

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
export async function startSession(_db: Db, _input: StartSessionInput): Promise<{ sessionId: string }> {
  throw new Error("引擎还没接上（M1 包 P1 实现）")
}

/** 任务新建、修改、删除、启用或停用之后调用：按任务的 cron 和启用状态同步定时触发 */
export async function syncTaskSchedule(_db: Db, _taskId: string): Promise<void> {}

/** 人加的待办新建、修改、删除之后调用：同步它的定时 / cron / 事件触发 */
export async function syncTodo(_db: Db, _todoId: string): Promise<void> {}
