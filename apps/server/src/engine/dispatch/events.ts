// 派活第三期：外部事件自动派单（docs/dev/dispatch-p3.md 第 3 节）。
// 外部系统 POST /api/events（或主管在控制台手动触发）时，fireEventImpl 在叫醒等待、触发待办之后调这里：
// 找出 dispatch.events 里配了这个事件名的任务，按配置从事件数据里取参数（shared 的 workItemFromEvent），
// 每个任务一个事务走 createItemsInTx（via = event、from_event、depth 1、requireKey、ifExists = skip、各自的优先级和延迟）。
// 没派成的（事件数据缺字段、撞了上限、意外出错）写进返回的 rejected，并且当天第一次时通知那个任务的负责人。
import { workItemFromEvent, workNotBefore, type FireEventResult, type TaskDispatchEvent } from "@heyagent/shared"
import { and, asc, isNotNull, sql } from "drizzle-orm"

import { readDispatchSettings } from "../../data/config/settings.js"
import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { normalizeDispatch } from "../../work/service.js"
import { createItemsInTx, notifyDayLimitOnce, notifyOwnerOnceToday, type DispatchTarget } from "./dispatch.js"

export interface EventDispatchInput {
  event: string
  data: Record<string, unknown>
  /** 控制台手动触发的人（单的 from_user_id、log 里 byId）；外部系统发的为 null */
  actorId: string | null
  via: "webhook" | "console"
}

export interface EventDispatchResult {
  dispatched: FireEventResult["dispatched"]
  rejected: FireEventResult["dispatchRejected"]
}

/** 配了这个事件的任务（开着被派活的），按任务 id 排。停用的任务照样接单、先排着（同 agent 派） */
async function targetsFor(db: Db, event: string): Promise<{ task: DispatchTarget; binding: TaskDispatchEvent }[]> {
  const rows = await db
    .select({ id: t.tasks.id, title: t.tasks.title, ownerId: t.tasks.ownerId, enabled: t.tasks.enabled, dispatch: t.tasks.dispatch })
    .from(t.tasks)
    .where(and(isNotNull(t.tasks.dispatch), sql`${t.tasks.dispatch}->'events' @> jsonb_build_array(jsonb_build_object('event', ${event}::text))`))
    .orderBy(asc(t.tasks.id))
  return rows.flatMap((row) => {
    const dispatch = normalizeDispatch(row.dispatch)
    // 事件名在一个任务里不重复（保存时校验），这里还是逐条找，万一有旧数据重复也只派第一条
    const binding = dispatch?.events?.find((each) => each.event === event)
    return dispatch && binding ? [{ task: { ...row, dispatch }, binding }] : []
  })
}

/** 按任务上的「收到事件就派一张」派单。一个任务出错不影响别的任务，也不让事件接口报错 */
export async function dispatchFromEvent(db: Db, input: EventDispatchInput): Promise<EventDispatchResult> {
  const result: EventDispatchResult = { dispatched: [], rejected: [] }
  let targets: Awaited<ReturnType<typeof targetsFor>>
  try {
    targets = await targetsFor(db, input.event)
  } catch (error) {
    console.warn(`[work] 外部事件「${input.event}」找派单的任务出错`, error)
    return result
  }
  if (!targets.length) return result
  const limits = await readDispatchSettings(db)
  for (const { task, binding } of targets) {
    let reason: string | null = null
    let dayLimitHit = false
    try {
      const picked = workItemFromEvent(task.dispatch, binding, input.data)
      if ("problem" in picked) {
        reason = picked.problem
      } else {
        const outcome = await db.transaction(async (tx) => {
          const { outcomes, dayLimitHit: hit } = await createItemsInTx(
            db,
            tx,
            task,
            [
              {
                title: picked.title,
                params: picked.params,
                key: picked.key,
                ...(binding.priority ? { priority: binding.priority } : {}),
                ...(binding.delayMinutes ? { notBefore: workNotBefore({ delayMinutes: binding.delayMinutes }) } : {}),
              },
            ],
            {
              via: "event",
              fromEvent: input.event,
              fromUserId: input.actorId,
              depth: 1,
              ifExists: "skip",
              maxPerTaskPerDay: limits.maxPerTaskPerDay,
              maxQueued: limits.maxQueued,
              requireKey: true,
            }
          )
          dayLimitHit = hit
          return outcomes[0]!
        })
        if (outcome.kind === "rejected") reason = outcome.reason
        else result.dispatched.push({ taskId: task.id, itemId: outcome.row.id, existing: outcome.kind === "existing" })
      }
    } catch (error) {
      console.warn(`[work] 外部事件「${input.event}」给 ${task.id} 派单出错`, error)
      reason = `派单出错：${(error as Error).message}`.slice(0, 500)
    }
    if (dayLimitHit) await notifyDayLimitOnce(db, task, limits.maxPerTaskPerDay).catch((error) => console.warn("[work] 通知负责人失败", error))
    if (reason) {
      result.rejected.push({ taskId: task.id, reason })
      await notifyRejectedOnce(db, task, input, reason).catch((error) => console.warn("[work] 通知负责人失败", error))
    }
  }
  return result
}

/** 事件派单没派成：当天第一次通知被派任务的负责人（标题一样就只发一次） */
async function notifyRejectedOnce(db: Db, task: DispatchTarget, input: EventDispatchInput, reason: string) {
  const data = JSON.stringify(input.data)
  await notifyOwnerOnceToday(
    db,
    task,
    `${task.title}：外部事件派单没派成`,
    [
      `外部事件「${input.event}」（${input.via === "webhook" ? "外部系统发来" : "控制台手动触发"}）按「收到事件就派一张」的配置没派成：${reason}`,
      `事件数据：${data.length > 500 ? `${data.slice(0, 500)}…` : data}`,
      "今天再有没派成的不再通知。要改取哪个字段就去任务设置的「被派活」里改。",
    ].join("\n")
  )
}
