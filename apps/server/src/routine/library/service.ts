// 流程库的读和写（docs/dev/routine-library.md 第 2、4.1、6.3、6.4 节，10.3 的接口）。B 包实现，现在是空壳。
// - 读：列表、详情（登记、发布的那一版、谁在用、最近 50 次成绩、最近 5 次停下的）、调用记录分页；任务详情「固化流程」区块里的那一行。
// - 写（都要 config.manage，都在一个事务里改数据 + 记审计）：发布（第一次、新版本、回到以前的版本）、改名字和说明、停用 / 重新启用、撤下。
// - 发布时写 tools 那一行：id = routine.<短名>、source = routine、routine_id、name = 名字、summary = 「什么时候用」、
//   description = analyze.ts 的 routineToolDescription、risk；同时写一行 routine_library_versions（requires、risk、compat、当时在用几个任务）。
// - 撤下：没有任务选用（tasksUsingRef(t.taskTools, [toolId])）、也没有别的库流程调它（别的登记的 requires.routines）时才能撤，
//   删掉 tools 那一行，登记留着（status = withdrawn），能重新发布；短名不变。
// - 停用：不管有没有人用都能停，tools 那一行留着；重新启用清零 fail_streak。
// 审计：routine.library.publish / .update / .pause / .resume / .withdraw（自动停用 .auto_pause 在 stats.ts）。
// 通知（6.6、7）：来源流程有新的转正式版本（可以发布）、自动停用、来源流程被自动停用（「库里的第 3 版多半也跑不通了」）。
import { TRPCError } from "@trpc/server"
import type {
  Actor,
  RoutineCallsPage,
  RoutineLibraryCandidate,
  RoutineLibraryDetail,
  RoutineLibraryItem,
  RoutineLibraryPreview,
  RoutineLibraryPublishInput,
  RoutineLibraryStatus,
  RoutineSummary,
} from "@heyagent/shared"

import type { DbOrTx, WriteCtx } from "../../data/config/common.js"
import type { Db } from "../../db/client.js"

/** 还没做好（B 包实现前，接口一律回这个） */
export const libraryNotYet = () => new TRPCError({ code: "NOT_IMPLEMENTED", message: "流程库还没做好（docs/dev/routine-library.md）" })

/** 列表（所有人）：在库里的、停用的、撤下的都列，前端分组 */
export async function listLibrary(_db: Db): Promise<RoutineLibraryItem[]> {
  throw libraryNotYet()
}

/** 详情（所有人）。没有登记 → NOT_FOUND */
export async function getLibraryEntry(_db: Db, _routineId: string): Promise<RoutineLibraryDetail> {
  throw libraryNotYet()
}

/** 能发布的（主管）：有转过正式版本（routine_versions.proven_at 不空）的固化流程，连同已经在库里的登记 */
export async function libraryCandidates(_db: Db, _actor: Actor): Promise<RoutineLibraryCandidate[]> {
  throw libraryNotYet()
}

/**
 * 发布前看一眼（主管）：要的工具和风险（analyze.ts）、程序检查（没转正式、有环、层数超了、调的库流程不在库里、短名）、
 * 和现在发布的版本比的不兼容改动、受影响的任务（按新版的 requires 缺什么）和流程（脚本里 ha.routine 调它的固化流程、库流程）
 */
export async function previewPublish(_db: Db, _actor: Actor, _input: { routineId: string; version: number; slug?: string }): Promise<RoutineLibraryPreview> {
  throw libraryNotYet()
}

/**
 * 发布（主管）：第一次（要 slug，不能和别的登记、tools 里已有的 id 撞）、新版本、回到以前的版本都是它。
 * 只收转过正式的版本；preview 的 problems 不空就 BAD_REQUEST；有不兼容改动而没有 acceptBreaking 就 CONFLICT（写清是哪些）。
 * 写登记（published_version、requires、risk，状态撤下的回到 listed、fail_streak 清零）、发布记录、tools 那一行
 */
export async function publishRoutine(_ctx: WriteCtx, _input: RoutineLibraryPublishInput): Promise<{ routineId: string; version: number }> {
  throw libraryNotYet()
}

/** 改名字和「什么时候用」（主管）：重写 tools 那一行（name、summary、description），下一次运行生效 */
export async function updateLibraryEntry(_ctx: WriteCtx, _input: { routineId: string; title: string; summary: string }): Promise<{ routineId: string }> {
  throw libraryNotYet()
}

/** 停用 / 重新启用（主管）。撤下的不能这样启用（要重新发布） */
export async function setLibraryPaused(_ctx: WriteCtx, _input: { routineId: string; paused: boolean }): Promise<{ routineId: string; status: RoutineLibraryStatus }> {
  throw libraryNotYet()
}

/** 撤下（主管）：有任务选用、别的库流程调它时 CONFLICT，写清是哪些 */
export async function withdrawLibraryEntry(_ctx: WriteCtx, _input: { routineId: string }): Promise<{ routineId: string; status: "withdrawn" }> {
  throw libraryNotYet()
}

/** 调用记录（所有人）：新的在前，一页 LIBRARY_CALLS_PAGE 条，cursor 是上一页最后一条的 id */
export async function listLibraryCalls(_db: Db, _input: { routineId: string; cursor?: number; taskId?: string }): Promise<RoutineCallsPage> {
  throw libraryNotYet()
}

/**
 * 任务详情「固化流程」区块（routine.get）里流程库的那两项：登记（没发布过 = null）、能发布的版本号（转过正式、比发布的新，新的在前）。
 * routine/service.ts 的 getTaskRoutine 调它（现在先填 null 和 []）
 */
export async function libraryOfRoutine(_db: DbOrTx, _routineId: string): Promise<Pick<RoutineSummary, "library" | "publishable">> {
  throw libraryNotYet()
}
