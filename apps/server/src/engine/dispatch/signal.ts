// 派活：发 work.pump（给一个被派任务领单）。单独一个文件，只依赖队列：
// 挂起（waits.ts）、结束回写、任务配置都要发它，不用把领单的代码（会开运行）一起引进来。
import type { Db } from "../../db/client.js"
import { bossFor, QUEUES, sendInTx, workPumpJobOptions, type Tx } from "../queue.js"

/** 在调用方的事务里发：和业务写入一起提交（提交了 worker 才会领单） */
export async function sendPumpInTx(db: Db, tx: Tx, taskId: string) {
  await sendInTx(db, tx, QUEUES.workPump, { taskId }, workPumpJobOptions(taskId))
}

/** 不在事务里（清扫、写完配置以后） */
export async function sendPump(db: Db, taskId: string) {
  const boss = await bossFor(db)
  await boss.send(QUEUES.workPump, { taskId }, workPumpJobOptions(taskId))
}
