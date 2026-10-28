// 子 agent（docs/dev/sub-agents.md）：发 subagent.pump / subagent.notify。单独一个文件，只依赖队列（同 engine/dispatch/signal.ts）：
// 挂起（waits.ts）、运行结束（run-ended.ts）、设置页、清扫都要发，不用把开运行、叫醒的代码一起引进来。
import type { Db } from "../../db/client.js"
import { bossFor, QUEUES, sendInTx, subagentNotifyJobOptions, subagentPumpJobOptions, type Tx } from "../queue.js"

/** 在调用方的事务里发 subagent.pump（6.2：拆、子运行结束、子运行挂起等人处理、subagent.cancel 时） */
export async function sendSubagentPumpInTx(db: Db, tx: Tx) {
  await sendInTx(db, tx, QUEUES.subagentPump, {}, subagentPumpJobOptions())
}

/** 不在事务里（设置页改了「子 agent」这组、清扫） */
export async function sendSubagentPump(db: Db) {
  const boss = await bossFor(db)
  await boss.send(QUEUES.subagentPump, {}, subagentPumpJobOptions())
}

/** 在调用方的事务里发 subagent.notify（7.2：子运行结束的事务里，参数是父运行编号） */
export async function sendSubagentNotifyInTx(db: Db, tx: Tx, parentSessionId: string) {
  await sendInTx(db, tx, QUEUES.subagentNotify, { parentSessionId }, subagentNotifyJobOptions(parentSessionId))
}

/** 不在事务里（挂起后补查、清扫） */
export async function sendSubagentNotify(db: Db, parentSessionId: string) {
  const boss = await bossFor(db)
  await boss.send(QUEUES.subagentNotify, { parentSessionId }, subagentNotifyJobOptions(parentSessionId))
}
