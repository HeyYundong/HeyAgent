// 实时推送：live.onChange 推 { table, id }，前端按表让相关查询失效、重新拉。
// 这张表列出每张库表变了以后要重新拉哪些查询（tRPC 的路由路径）。表名就是数据库里的表名。

export const LIVE_CHANNEL = "heyagent_changes"

export const liveQueriesByTable: Record<string, string[]> = {
  users: ["me.get", "staff.list", "users.list"],
  // 会话页的一页（sessions.page）能按任务名搜
  tasks: ["tasks.list", "work.taskStats", "work.queueStats", "sessions.page"],
  task_memories: ["tasks.list"],
  task_skills: ["tasks.list"],
  task_tools: ["tasks.list"],
  task_rules: ["tasks.list"],
  task_memory_entries: ["taskMemory.list"],
  // 被派的运行状态变了，派活单的徽章（sessionStatus）和名额数跟着变。
  // sessions.list / sessions.page 只是摘要（不带过程），跑起来常变也不重；sessions.get（带全部过程）只让推来的那个 session 的失效，见 liveQueriesById
  sessions: ["sessions.list", "sessions.page", "sessions.get", "work.list", "work.get", "work.taskStats", "work.queueStats"],
  session_events: ["sessions.list", "sessions.page", "sessions.get"],
  checkpoints: ["sessions.list", "sessions.page", "sessions.get"],
  checkpoint_records: ["sessions.list", "sessions.page", "sessions.get"],
  session_waits: ["sessions.list", "sessions.page", "sessions.get", "browser.accountStatus"],
  // 会话页「只看等我处理」按没处理的事筛
  human_items: ["todos.board", "me.get", "memories.list", "skills.list", "sessions.page"],
  human_todos: ["todos.board"],
  memories: ["memories.list"],
  skills: ["skills.list"],
  skill_tools: ["skills.list"],
  skill_suggestions: ["skills.list"],
  rules: ["rules.list"],
  rule_tools: ["rules.list"],
  tools: ["tools.list"],
  mcp_servers: ["tools.list"],
  secrets: ["tools.list", "models.overview", "browsers.list", "desktops.list"],
  browser_profiles: ["browsers.list"],
  browser_accounts: ["browsers.list", "browser.accountStatus"],
  browser_vaults: ["browsers.list"],
  account_leases: ["browsers.list", "browser.accountStatus"],
  // M2：开着的 Chrome（远程画面入口、谁在看）
  browser_instances: ["browser.live", "browser.sessionBrowser"],
  browser_actions: ["browser.history"],
  desktops: ["desktops.list"],
  desktop_leases: ["desktops.list", "desktop.sessionDesktop"],
  // 系统开的桌面：虚拟机状态（开机中 → 开着……）、开着几台占多少内存
  desktop_vms: ["desktops.list", "desktops.host"],
  platforms: ["platforms.list", "browsers.list"],
  model_providers: ["models.overview"],
  models: ["models.overview"],
  model_defaults: ["models.overview"],
  // 引擎（M1）：新通知、新产物 / 附件、设置
  notifications: ["engine.notifications.list"],
  files: ["engine.sessionFiles", "engine.taskAttachments"],
  // desktop.storage（桌面存放位置）在 desktops.host 里
  settings: ["settings.get", "desktops.host"],
  // 图库：图的增删改（向量表不推，重算进度靠页面轮询 gallery.stats）
  gallery_images: ["gallery.list", "gallery.get", "gallery.stats", "gallery.tags"],
  api_keys: ["apiKeys.list"],
  // 比物：比对记录（比对中 → 比完）、比对标准
  comparisons: ["compare.list", "compare.get"],
  compare_standards: ["compare.standards"],
  // 导入：读包进度、方案、导入后的状态
  imports: ["imports.list", "imports.get"],
  // 派活：派活单的增删改（排队 → 在办 → 办完）
  work_items: ["work.list", "work.get", "work.taskStats", "work.queueStats", "work.lookup"],
}

/**
 * 这些表推来的 id 就是这些查询的 input.id（session_events、checkpoints、session_waits 推的是 session_id，见 drizzle/0001_triggers.sql）：
 * 只让 id 对得上的那一个失效，不把开着的每个运行详情都重新拉。checkpoint_records 推的是 checkpoint_id，对不上，还是全部
 */
export const liveQueriesById: Record<string, string[]> = {
  sessions: ["sessions.get"],
  session_events: ["sessions.get"],
  checkpoints: ["sessions.get"],
  session_waits: ["sessions.get"],
}

/** 变得很勤的表（agent 跑起来一秒好几条）：前端两次失效之间至少隔一会儿，别一直重新拉 */
export const liveThrottledTables: ReadonlySet<string> = new Set(["sessions", "session_events", "checkpoints", "checkpoint_records", "session_waits", "browser_actions"])

/** 某张表变了要重新拉的查询；不认识的表（或 "*"）返回 null，表示全部重新拉 */
export function queriesForTable(table: string): string[] | null {
  return liveQueriesByTable[table] ?? null
}

/** 一条推送要重新拉的查询：paths 整个失效，byId 只失效 input.id 对得上的；null 表示全部重新拉 */
export function liveTargets(change: { table: string; id: string | null }): { paths: string[]; byId: { path: string; id: string }[] } | null {
  const list = queriesForTable(change.table)
  if (list === null) return null
  const narrow = change.id === null ? [] : (liveQueriesById[change.table] ?? [])
  return {
    paths: list.filter((path) => !narrow.includes(path)),
    byId: narrow.filter((path) => list.includes(path)).map((path) => ({ path, id: change.id! })),
  }
}
