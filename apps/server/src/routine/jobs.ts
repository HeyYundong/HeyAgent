// 固化的队列任务 routine.compile（docs/dev/solidify.md 5.6）：一版脚本往下走一步。
// 谁都可以发：点「固化成流程」时、固化试跑的运行结束时（引擎发）。处理函数在 routine/compile.ts，worker 注册
import type { SendOptions } from "pg-boss"

import type { Db } from "../db/client.js"
import { QUEUES, bossFor, sendInTx, type Tx } from "../engine/queue.js"

export interface RoutineCompileJob {
  versionId: string
}

/** 同一版同时只走一步；进程崩溃重试两次（模型出错由固化员自己处理） */
export const routineCompileJobOptions = (versionId: string): SendOptions => ({
  singletonKey: versionId,
  heartbeatSeconds: 30,
  expireInSeconds: 1800,
  retryLimit: 2,
  retryDelay: 10,
})

/** 发一步：在事务里发（tx），提交了才执行；不在事务里就直接发 */
export async function sendRoutineCompile(db: Db, tx: Tx | undefined, job: RoutineCompileJob) {
  if (tx) {
    await sendInTx(db, tx, QUEUES.routineCompile, job, routineCompileJobOptions(job.versionId))
    return
  }
  const boss = await bossFor(db)
  await boss.send(QUEUES.routineCompile, job, routineCompileJobOptions(job.versionId))
}
