// 实时推送：live.onChange 推 { table, id }，前端按表让相关查询失效、重新拉。
// 这张表列出每张库表变了以后要重新拉哪些查询（tRPC 的路由路径）。表名就是数据库里的表名。

export const LIVE_CHANNEL = "heyagent_changes"

export const liveQueriesByTable: Record<string, string[]> = {
  users: ["me.get", "staff.list"],
  tasks: ["tasks.list"],
  task_memories: ["tasks.list"],
  task_skills: ["tasks.list"],
  task_tools: ["tasks.list"],
  task_rules: ["tasks.list"],
  sessions: ["sessions.list", "sessions.get"],
  session_events: ["sessions.list", "sessions.get"],
  checkpoints: ["sessions.list", "sessions.get"],
  checkpoint_records: ["sessions.list", "sessions.get"],
  session_waits: ["sessions.list", "sessions.get"],
  human_items: ["todos.board", "me.get", "memories.list", "skills.list"],
  human_todos: ["todos.board"],
  memories: ["memories.list"],
  skills: ["skills.list"],
  skill_tools: ["skills.list"],
  skill_suggestions: ["skills.list"],
  rules: ["rules.list"],
  rule_tools: ["rules.list"],
  tools: ["tools.list"],
  mcp_servers: ["tools.list"],
  secrets: ["tools.list", "models.overview", "browsers.list"],
  browser_profiles: ["browsers.list"],
  browser_accounts: ["browsers.list"],
  browser_vaults: ["browsers.list"],
  account_leases: ["browsers.list"],
  platforms: ["platforms.list", "browsers.list"],
  model_providers: ["models.overview"],
  models: ["models.overview"],
  model_defaults: ["models.overview"],
}

/** 某张表变了要重新拉的查询；不认识的表（或 "*"）返回 null，表示全部重新拉 */
export function queriesForTable(table: string): string[] | null {
  return liveQueriesByTable[table] ?? null
}
