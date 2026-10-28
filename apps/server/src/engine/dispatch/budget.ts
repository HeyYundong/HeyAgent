// 派活第三期：每天花费上限（docs/dev/dispatch-p3.md 4.1）。花了多少（dispatchSpentToday）在 work/service.ts，
// 领单时判断（pump.ts）；这里是领单被挡住以后通知负责人：当天第一次撞到时一条（同 notifyDayLimitOnce 的判断法）。
import { eq } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { notifyOwnerOnceToday } from "./dispatch.js"
import type { BudgetHit } from "./pump.js"

const usd = (value: number) => `$${value.toFixed(2)}`

/** work.pump 返回 budgetHit 以后（领单的事务已经提交）：今天第一次就通知被派任务的负责人 */
export async function notifyBudgetOnce(db: Db, taskId: string, hit: BudgetHit) {
  const [task] = await db.select({ id: t.tasks.id, title: t.tasks.title, ownerId: t.tasks.ownerId }).from(t.tasks).where(eq(t.tasks.id, taskId))
  if (!task) return false
  return notifyOwnerOnceToday(
    db,
    task,
    `${task.title}：今天被派来的运行花到了上限`,
    `今天花了 ${usd(hit.spent)}，每天的上限 ${usd(hit.budget)}，排队的 ${hit.queued} 张明天 0 点以后接着办；要今天接着办就去任务里调大上限。已经在跑的运行不受影响。`
  )
}
