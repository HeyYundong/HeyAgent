// 派活：领单（work.pump 的处理函数，方案 5.2）。同一个任务的领单排成一队（事务级 advisory lock），
// 按名额数空位、取最早的排队单（for update skip locked）、开运行、单改成「在办」，全在一个事务里：
// 要么单和运行一起成，要么都不成，一张单不会被两个运行领到。
import type { SessionSnapshot } from "@heyagent/shared"
import { and, asc, eq, isNull, lte, or, sql } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { occupiedSlots } from "../../work/service.js"
import type { Tx } from "../queue.js"
import { startSessionInTx } from "../sessions.js"
import { sendWorkDoneInTx } from "./notify.js"
import { appendLog } from "./settle.js"

type WorkItemRow = typeof t.workItems.$inferSelect

/** 同一个任务的领单 / 派活各用一把事务级锁（按任务 id 的 hash）。派活和领单不互相等 */
export const lockTaskInTx = (tx: Tx, scope: "pump" | "dispatch", taskId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`work.${scope}:${taskId}`}))`)

/** 快照里的「被派来的」：单号、参数、谁派的 */
async function snapshotDispatch(tx: Tx, item: WorkItemRow): Promise<NonNullable<SessionSnapshot["dispatch"]>> {
  let from: NonNullable<SessionSnapshot["dispatch"]>["from"]
  if (item.fromTaskId && item.fromSessionId) {
    const [task] = await tx.select({ title: t.tasks.title }).from(t.tasks).where(eq(t.tasks.id, item.fromTaskId))
    from = { taskId: item.fromTaskId, taskTitle: task?.title ?? item.fromTaskId, sessionId: item.fromSessionId }
  }
  let fromUser: NonNullable<SessionSnapshot["dispatch"]>["fromUser"]
  if (item.fromUserId) {
    const [user] = await tx.select({ name: t.users.name }).from(t.users).where(eq(t.users.id, item.fromUserId))
    fromUser = { id: item.fromUserId, name: user?.name ?? item.fromUserId }
  }
  return {
    itemId: item.id,
    key: item.key,
    title: item.title,
    ...(item.note ? { note: item.note } : {}),
    params: item.params,
    depth: item.depth,
    ...(from ? { from } : {}),
    ...(fromUser ? { fromUser } : {}),
  }
}

/** 给一个被派任务领单：返回这次开出来的运行 */
export async function pumpTask(db: Db, taskId: string): Promise<{ started: { itemId: string; sessionId: string }[] }> {
  return db.transaction(async (tx) => {
    await lockTaskInTx(tx, "pump", taskId)
    const [task] = await tx.select({ id: t.tasks.id, enabled: t.tasks.enabled, dispatch: t.tasks.dispatch }).from(t.tasks).where(eq(t.tasks.id, taskId))
    // 停用了、关了被派活：单留着排队，重新打开时接着领
    if (!task || !task.enabled || !task.dispatch) return { started: [] }
    const free = task.dispatch.maxRunning - (await occupiedSlots(tx, taskId))
    if (free <= 0) return { started: [] }
    const items = await tx
      .select()
      .from(t.workItems)
      // 排队等自动重试的（not_before 在将来）到点才领
      .where(and(eq(t.workItems.taskId, taskId), eq(t.workItems.status, "queued"), or(isNull(t.workItems.notBefore), lte(t.workItems.notBefore, sql`now()`))))
      .orderBy(asc(t.workItems.createdAt), asc(t.workItems.id))
      .limit(free)
      .for("update", { skipLocked: true })
    const started: { itemId: string; sessionId: string }[] = []
    for (const item of items) {
      try {
        // 每张单一个 savepoint：一张开不出运行（例如快照出错）不连累别的单，也不让整次领单反复重试
        const sessionId = await tx.transaction(async (sp) => {
          const { sessionId } = await startSessionInTx(db, sp, {
            taskId,
            source: "dispatch",
            dispatch: await snapshotDispatch(sp, item),
            parentSessionId: item.fromSessionId,
            createdById: item.fromUserId,
          })
          const now = new Date()
          await sp
            .update(t.workItems)
            .set({
              status: "running",
              sessionId,
              attempts: sql`${t.workItems.attempts} + 1`,
              startedAt: now,
              notBefore: null,
              updatedAt: now,
              log: appendLog({ at: now.toISOString(), kind: "run_started", sessionId }),
            })
            .where(eq(t.workItems.id, item.id))
          return sessionId
        })
        started.push({ itemId: item.id, sessionId })
      } catch (error) {
        const now = new Date()
        const reason = `没能开始运行：${(error as Error).message}`.slice(0, 2000)
        console.warn(`[work] ${item.id} ${reason}`)
        await tx
          .update(t.workItems)
          .set({ status: "failed", error: reason, failKind: "error", notBefore: null, finishedAt: now, updatedAt: now, log: appendLog({ at: now.toISOString(), kind: "run_ended", note: "failed" }) })
          .where(eq(t.workItems.id, item.id))
        // 最终结束（配置坏了，重试也没用）：叫醒等它的派活方
        await sendWorkDoneInTx(db, tx, item.id)
      }
    }
    return { started }
  })
}
