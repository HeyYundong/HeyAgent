// 办成后自动固化、跑不通后自动修（docs/dev/solidify.md 17.1）。
// 骨架：内容由第二期第一批的 B2 包写。
import type { Db } from "../db/client.js"

/**
 * 运行结果定了以后调：普通运行、办成、任务开着自动固化（tasks.auto_solidify，空 = autoSolidifyDefault）时，
 * 按 17.1 的条件建一版（auto = true、没有 created_by_id）并发 routine.compile；不该固化的什么都不做
 */
export async function maybeAutoSolidify(_db: Db, _sessionId: string): Promise<void> {}
