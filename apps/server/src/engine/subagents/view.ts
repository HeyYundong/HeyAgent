// 子 agent：页面要的数据（docs/dev/sub-agents.md 10.2、11.1）。
// - listSubagents：父运行详情「子 agent」区块（tRPC sessions.subagents），按 n 排；
// - subagentStatsOf：SessionSummary.subagents（data/loaders.ts 的 listSessions 一次分组查询带上）；
// - subGoalOf：子运行详情「子目标」区块（SessionRun.subGoal，data/loaders.ts 的 loadSession 带上）。
import type { SessionSnapshot, SubagentGoalView, SubagentRow, SubagentStats, SubResult } from "@heyagent/shared"

import type { Db } from "../../db/client.js"

/**
 * 父运行拆出去的子运行（kind = sub、parent_session_id = parentId），按 n 排。
 * state：挂起等 subagent.queue: → queued；执行中、验收中 → running；挂起等 browser. / desktop: → waiting；等人处理 → needs_human；结束 → ended。
 * 骨架先回空数组（页面照「没拆过」显示）；后端实现
 */
export async function listSubagents(_db: Db, _parentId: string): Promise<SubagentRow[]> {
  return []
}

/** 一批父运行各自的子 agent 统计（没拆过的不在 Map 里）。骨架先回空 Map；后端实现 */
export async function subagentStatsOf(_db: Db, _parentIds: string[]): Promise<Map<string, SubagentStats>> {
  return new Map()
}

/** 子运行的「子目标」：快照 sub + sub_result.data（交了的字段带 value）+ 给它的文件（files 表查 id、name、mime、size，url 用 files/service.ts 的 fileUrl）。不是子运行返回 undefined */
export function subGoalOf(_snapshot: SessionSnapshot, _subResult: SubResult | null, _files: SubagentGoalView["files"]): SubagentGoalView | undefined {
  return undefined
}
