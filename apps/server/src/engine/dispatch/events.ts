// 派活第三期：外部事件自动派单（docs/dev/dispatch-p3.md 第 3 节）。
// 外部系统 POST /api/events（或主管在控制台手动触发）时，fireEventImpl 在叫醒等待、触发待办之后调这里：
// 找出 dispatch.events 里配了这个事件名的任务，按配置从事件数据里取参数（shared 的 workItemFromEvent），
// 每个任务一个事务走 createItemsInTx（via = event、from_event、depth 1、requireKey、ifExists = skip、各自的优先级和延迟）。
// 没派成的（事件数据缺字段、撞了上限）写进返回的 rejected，并且当天第一次时通知那个任务的负责人。
// 现在是空壳：包 A 实现。
import type { FireEventResult } from "@heyagent/shared"

import type { Db } from "../../db/client.js"

export interface EventDispatchInput {
  event: string
  data: Record<string, unknown>
  /** 控制台手动触发的人（单的 log 里 byId）；外部系统发的为 null */
  actorId: string | null
  via: "webhook" | "console"
}

export interface EventDispatchResult {
  dispatched: FireEventResult["dispatched"]
  rejected: FireEventResult["dispatchRejected"]
}

/** 按任务上的「收到事件就派一张」派单。一个任务出错不影响别的任务，也不让事件接口报错 */
export async function dispatchFromEvent(_db: Db, _input: EventDispatchInput): Promise<EventDispatchResult> {
  return { dispatched: [], rejected: [] }
}
