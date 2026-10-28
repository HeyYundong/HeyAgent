// 一次运行的结果定了以后（复核完、标失败之后，docs/dev/solidify.md 17.1）：
// 先记固化流程的试用、正式、停用（runtime/stats.ts），再看要不要自动固化（auto.ts）。两件事各自出错只记日志，不影响运行本身
import type { Db } from "../db/client.js"
import { maybeAutoSolidify } from "./auto.js"
import { settleRoutineRun } from "./runtime/stats.js"

export async function afterRunSettled(db: Db, sessionId: string): Promise<void> {
  await settleRoutineRun(db, sessionId).catch((error: unknown) => console.warn(`[routine] ${sessionId} 的固化流程统计没记上：${(error as Error).message}`))
  await maybeAutoSolidify(db, sessionId).catch((error: unknown) => console.warn(`[routine] ${sessionId} 办成后自动固化出错：${(error as Error).message}`))
}
