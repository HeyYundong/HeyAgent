// 派活：领单（work.pump 的处理函数，方案 5.2）。同一个任务的领单排成一队（事务级 advisory lock），
// 按名额数空位、取排队单（优先级高的先、同一级先派的先，for update skip locked）、开运行、单改成「在办」，全在一个事务里：
// 要么单和运行一起成，要么都不成，一张单不会被两个运行领到。
// 第三期：任务设了每天花费上限、今天被派来的运行花到了，就不开新运行（budgetHit，worker 提交后通知负责人一次）。
import type { SessionSnapshot, TaskDispatchResult } from "@heyagent/shared"
import { and, count, eq, isNull, lte, or, sql } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { budgetReached, dispatchSpentToday, occupiedSlots, QUEUE_ORDER } from "../../work/service.js"
import type { Tx } from "../queue.js"
import { startSessionInTx } from "../sessions.js"
import { sendWorkDoneInTx } from "./notify.js"
import { appendLog } from "./settle.js"

type WorkItemRow = typeof t.workItems.$inferSelect

/** 同一个任务的领单 / 派活各用一把事务级锁（按任务 id 的 hash）。派活和领单不互相等 */
export const lockTaskInTx = (tx: Tx, scope: "pump" | "dispatch", taskId: string) =>
  tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`work.${scope}:${taskId}`}))`)

/** 快照里的「被派来的」：单号、参数、谁派的 */
async function snapshotDispatch(tx: Tx, item: WorkItemRow, results: TaskDispatchResult[]): Promise<NonNullable<SessionSnapshot["dispatch"]>> {
  let from: NonNullable<SessionSnapshot["dispatch"]>["from"]
  if (item.fromTaskId && item.fromSessionId) {
    const [task] = await tx.select({ title: t.tasks.title }).from(t.tasks).where(eq(t.tasks.id, item.fromTaskId))
    from = { taskId: item.fromTaskId, taskTitle: task?.title ?? item.fromTaskId, sessionId: item.fromSessionId }
  }
  // 第三期：外部系统（API 密钥）、外部事件派的写各自的来源，不写 fromUser（不然第一条消息会说成「某某手动派的」）
  if (item.via === "api") {
    const [key] = item.apiKeyId ? await tx.select({ name: t.apiKeys.name }).from(t.apiKeys).where(eq(t.apiKeys.id, item.apiKeyId)) : []
    return { ...base(item, results), fromApi: { keyName: key?.name ?? "已删除的密钥" } }
  }
  if (item.via === "event") return { ...base(item, results), fromEvent: { event: item.fromEvent ?? "" } }
  let fromUser: NonNullable<SessionSnapshot["dispatch"]>["fromUser"]
  if (item.fromUserId) {
    const [user] = await tx.select({ name: t.users.name }).from(t.users).where(eq(t.users.id, item.fromUserId))
    fromUser = { id: item.fromUserId, name: user?.name ?? item.fromUserId }
  }
  return { ...base(item, results), ...(from ? { from } : {}), ...(fromUser ? { fromUser } : {}) }
}

/** 快照里和来源无关的那部分 */
function base(item: WorkItemRow, results: TaskDispatchResult[]): NonNullable<SessionSnapshot["dispatch"]> {
  return {
    itemId: item.id,
    key: item.key,
    title: item.title,
    ...(item.note ? { note: item.note } : {}),
    params: item.params,
    depth: item.depth,
    // 要交回的结果（run-outcome 6.1）：按领单时的配置冻进来，收尾时按它查必填的交没交
    ...(results.length ? { results: results.map(({ name, description, required }) => ({ name, description, required })) } : {}),
  }
}

/** 这次领单因为每天花费上限没开新运行（第三期）：worker 在事务提交后通知负责人（当天一次） */
export interface BudgetHit {
  spent: number
  budget: number
  /** 到点的排队单（明天 0 点以后接着办的） */
  queued: number
}

/** 排队、到点了的单（等自动重试、「过多久再办」的 not_before 在将来，到点才领） */
const dueQueued = (taskId: string) =>
  and(eq(t.workItems.taskId, taskId), eq(t.workItems.status, "queued"), or(isNull(t.workItems.notBefore), lte(t.workItems.notBefore, sql`now()`)))

/**
 * 给一张排队的单开运行、单改成「在办」（领单和人点「现在就办」共用）。在一个 savepoint 里：开不出运行时单不动、错误往外抛。
 * options.byId：人点了「现在就办」（manage.ts startWorkItemNow），处理记录先记一条 start_now；停用的任务也照样开这一张。
 * 运行算谁开的照旧是派单的人（createdById），点的人记在单的处理记录和审计里
 */
export async function startItemInTx(db: Db, tx: Tx, item: WorkItemRow, results: TaskDispatchResult[], options: { byId?: string } = {}): Promise<string> {
  return tx.transaction(async (sp) => {
    const { sessionId } = await startSessionInTx(db, sp, {
      taskId: item.taskId,
      source: "dispatch",
      dispatch: await snapshotDispatch(sp, item, results),
      parentSessionId: item.fromSessionId,
      createdById: item.fromUserId,
      ...(options.byId ? { allowDisabled: true } : {}),
    })
    const now = new Date()
    const at = now.toISOString()
    await sp
      .update(t.workItems)
      .set({
        status: "running",
        sessionId,
        attempts: sql`${t.workItems.attempts} + 1`,
        startedAt: now,
        notBefore: null,
        updatedAt: now,
        log: appendLog(...(options.byId ? [{ at, kind: "start_now" as const, byId: options.byId }] : []), { at, kind: "run_started", sessionId }),
      })
      .where(eq(t.workItems.id, item.id))
    return sessionId
  })
}

/** 给一个被派任务领单：返回这次开出来的运行；因为每天花费上限没开的返回 budgetHit */
export async function pumpTask(db: Db, taskId: string): Promise<{ started: { itemId: string; sessionId: string }[]; budgetHit?: BudgetHit }> {
  return db.transaction(async (tx) => {
    await lockTaskInTx(tx, "pump", taskId)
    const [task] = await tx.select({ id: t.tasks.id, enabled: t.tasks.enabled, dispatch: t.tasks.dispatch }).from(t.tasks).where(eq(t.tasks.id, taskId))
    // 停用了、关了被派活：单留着排队，重新打开时接着领
    if (!task || !task.enabled || !task.dispatch) return { started: [] }
    // 第三期每天花费上限：今天被派来的运行花到了就不开新的，排队的单留到明天 0 点以后（每分钟的清扫照常发 work.pump）；在跑的不停
    const budget = task.dispatch.dailyBudgetUsd
    if (budget != null) {
      const spent = (await dispatchSpentToday(tx, [taskId])).get(taskId) ?? 0
      if (budgetReached(spent, budget)) {
        const [due] = await tx.select({ n: count() }).from(t.workItems).where(dueQueued(taskId))
        // 没有排队的就不算「挡住了」（运行结束时也会发 work.pump），不用通知
        return due?.n ? { started: [], budgetHit: { spent, budget, queued: due.n } } : { started: [] }
      }
    }
    const results = task.dispatch.results ?? []
    const free = task.dispatch.maxRunning - (await occupiedSlots(tx, taskId))
    if (free <= 0) return { started: [] }
    const items = await tx
      .select()
      .from(t.workItems)
      .where(dueQueued(taskId))
      // 优先级高的先领，同一级按派进来的先后（排队名次用同一个顺序）
      .orderBy(...QUEUE_ORDER)
      .limit(free)
      .for("update", { skipLocked: true })
    const started: { itemId: string; sessionId: string }[] = []
    for (const item of items) {
      try {
        // 每张单一个 savepoint：一张开不出运行（例如快照出错）不连累别的单，也不让整次领单反复重试
        const sessionId = await startItemInTx(db, tx, item, results)
        started.push({ itemId: item.id, sessionId })
      } catch (error) {
        const now = new Date()
        const reason = `没能开始运行：${(error as Error).message}`.slice(0, 2000)
        console.warn(`[work] ${item.id} ${reason}`)
        await tx
          .update(t.workItems)
          // 结果记没办成，原因就是开不了的原因（例如「任务没设复核模型，先在任务里选一个」）
          .set({ status: "failed", error: reason, failKind: "error", outcome: "not_achieved", outcomeReason: reason, notBefore: null, finishedAt: now, updatedAt: now, log: appendLog({ at: now.toISOString(), kind: "run_ended", note: "failed" }) })
          .where(eq(t.workItems.id, item.id))
        // 最终结束（配置坏了，重试也没用）：叫醒等它的派活方
        await sendWorkDoneInTx(db, tx, item.id)
      }
    }
    return { started }
  })
}
