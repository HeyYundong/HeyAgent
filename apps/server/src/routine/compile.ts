// 固化（docs/dev/solidify.md 第 5 节）：把一次办成的运行写成脚本、试跑、交给人审核。
// 骨架：接口和队列处理函数的样子先定下，内容由固化的开发包（docs/dev/solidify.md 第 15 节 B 包）写。
import type { Db } from "../db/client.js"
import { badRequest, type WriteCtx } from "../data/config/common.js"
import type { RoutineCompileJob } from "./jobs.js"

/**
 * 运行详情「⋯ → 固化成流程」：已结束、办成的普通运行；任务负责人和主管。
 * 任务还没有固化流程就建一个（RT-<n>），再建一版（status = drafting），发 routine.compile
 */
export async function startCompile(_ctx: WriteCtx, _input: { sessionId: string; skipTest?: boolean }): Promise<{ routineId: string; versionId: string }> {
  throw badRequest("固化还没做完")
}

/** routine.compile 的处理函数：按这一版的 status 往下走一步（写 / 改脚本 → 开试跑；试跑结束 → 看结果、再改或交给人审核） */
export async function handleCompileJob(_db: Db, _job: RoutineCompileJob): Promise<void> {
  throw new Error("固化还没做完")
}
