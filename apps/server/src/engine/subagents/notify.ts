// 子 agent：子运行结束后叫醒等它们的父运行（docs/dev/sub-agents.md 7.1、7.2，队列 subagent.notify，参数是父运行编号）。
// 找父运行正在等的那条等待（subagent.all:<父> / subagent.any:<父>）；没有就结束（父在干别的，醒来以后自己会 subagent.wait）。
// 按 mode 判断条件（all：全部结束；any：有结束了、还没交给过父的），满足了一个事务里 resumeInTx（消息是 results.ts 的结果文字），
// 并把这次交出去的子运行写 sub_result.deliveredAt。叫醒是幂等的。
import { parseSubagentWaitEvent, subagentWaitEvent } from "@heyagent/shared"
import { and, eq, inArray } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import type { Tx } from "../queue.js"
import { resumeInTx } from "../waits.js"
import { subagentResultsText, toDeliver, waitSatisfied } from "./results.js"
import { patchSubResultInTx } from "./settle.js"
import { sendSubagentNotify } from "./signal.js"
import { loadSubRunFacts } from "./view.js"

/** 把这次按全文交给父的子运行标成「已交回」 */
export async function markDeliveredInTx(tx: Tx, ids: string[]) {
  const at = new Date().toISOString()
  for (const id of ids) await patchSubResultInTx(tx, id, { deliveredAt: at })
}

/** subagent.notify 的处理函数（worker-runtime.ts 注册）。返回叫醒的父运行编号（没叫醒是 null） */
export async function onSubagentNotify(db: Db, data: { parentSessionId: string }): Promise<{ resumed: string | null }> {
  const parentId = data.parentSessionId
  const events = [subagentWaitEvent(parentId, "all"), subagentWaitEvent(parentId, "any")]
  return db.transaction(async (tx) => {
    // 锁住父运行：同一个父运行的叫醒、subagent_wait 直接返回不会同时写 deliveredAt
    await tx.select({ id: t.sessions.id }).from(t.sessions).where(eq(t.sessions.id, parentId)).for("update")
    const [wait] = await tx
      .select()
      .from(t.sessionWaits)
      .where(and(eq(t.sessionWaits.sessionId, parentId), eq(t.sessionWaits.status, "waiting"), inArray(t.sessionWaits.event, events)))
    const parsed = parseSubagentWaitEvent(wait?.event)
    if (!wait || !parsed) return { resumed: null }
    const rows = await loadSubRunFacts(tx, parentId)
    if (!waitSatisfied(rows, parsed.mode)) return { resumed: null }
    const resumed = await resumeInTx(db, tx, {
      waitId: wait.id,
      cause: "event",
      title: parsed.mode === "all" ? "子 agent 都结束了，继续" : "有子 agent 结束了，继续",
      message: subagentResultsText(rows, parsed.mode),
    })
    if (!resumed) return { resumed: null }
    await markDeliveredInTx(tx, toDeliver(rows))
    return { resumed }
  })
}

/**
 * 先结束、后挂起的窗口（7.1，照 dispatch/notify.ts 的 recheckWorkDoneAfterSuspend）：父运行挂起等子 agent 的事务提交以后再查一次，
 * 条件已经满足就补发 subagent.notify。event 不是父运行等子 agent 的事件（shared 的 parseSubagentWaitEvent 认不出）就什么都不做
 */
export async function recheckSubagentWaitAfterSuspend(db: Db, event: string | null | undefined): Promise<void> {
  const parsed = parseSubagentWaitEvent(event)
  if (!parsed) return
  const rows = await loadSubRunFacts(db, parsed.parentSessionId)
  if (waitSatisfied(rows, parsed.mode)) await sendSubagentNotify(db, parsed.parentSessionId)
}
