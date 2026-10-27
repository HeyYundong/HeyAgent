// 从库里读数据，拼成 @heyagent/shared 里的领域类型（和原型页面读的形状一致）。
// 规则：库里为空的字段直接省略；时间都转成 ISO；密钥只给掩码，登录态只给状态和个数，绝不读出原文。
import { and, asc, desc, eq, inArray, isNull, sql, type AnyColumn } from "drizzle-orm"
import {
  BROWSER_ID_IN_INPUT,
  BROWSER_ID_IN_PLAN,
  compiledRuleSchema,
  NOTIFY_SECRET_PREFIX,
  relativeDayText,
  type RuleCompileView,
  type BrowserProfile,
  type HumanItem,
  type HumanTodo,
  type McpServer,
  type Me,
  type MemoryRef,
  type ModelDefaults,
  type ModelRole,
  type RunOutcome,
  type ModelProvider,
  type Platform,
  type RuleRef,
  type SavedSecret,
  type SessionRun,
  type SessionSummary,
  type Skill,
  type Staff,
  type TaskDef,
  type TaskMemoryEntry,
  type Tool,
  type Trigger,
} from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { parseCompiledText } from "./config/rules.js"

const iso = (value: Date) => value.toISOString()
const isoOpt = (value: Date | null) => (value ? value.toISOString() : undefined)
const opt = <T>(value: T | null): T | undefined => (value === null ? undefined : value)

/** 去掉值为 undefined 的键：zod 输出校验和 JSON 里都不出现 */
function compact<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

// ---------- 人 ----------

const toStaff = (row: typeof t.users.$inferSelect): Staff => ({ id: row.id, name: row.name, title: row.title, isAdmin: row.role === "admin" })

export async function listStaff(db: Db): Promise<Staff[]> {
  const rows = await db.select().from(t.users).orderBy(asc(t.users.createdAt), asc(t.users.id))
  return rows.map(toStaff)
}

export async function loadMe(db: Db, userId: string): Promise<Me | undefined> {
  const [row] = await db.select().from(t.users).where(eq(t.users.id, userId))
  if (!row) return undefined
  const staff = toStaff(row)
  const condition = staff.isAdmin ? eq(t.humanItems.status, "open") : and(eq(t.humanItems.status, "open"), eq(t.humanItems.assigneeId, userId))
  const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(t.humanItems).where(condition)
  return { ...staff, email: row.email, needsMeCount: count?.n ?? 0 }
}

export async function listPlatforms(db: Db): Promise<Platform[]> {
  return db.select({ id: t.platforms.id, name: t.platforms.name, domains: t.platforms.domains }).from(t.platforms).orderBy(asc(t.platforms.position))
}

// ---------- 任务 ----------

async function linksByTask(db: Db, table: typeof t.taskMemories | typeof t.taskSkills | typeof t.taskTools | typeof t.taskRules, taskIds: string[]) {
  const map = new Map<string, string[]>()
  if (taskIds.length === 0) return map
  const rows = await db.select().from(table).where(inArray(table.taskId, taskIds)).orderBy(asc(table.position))
  for (const row of rows) map.set(row.taskId, [...(map.get(row.taskId) ?? []), row.refId])
  return map
}

export async function listTasks(db: Db, ids?: string[]): Promise<TaskDef[]> {
  const rows = await db
    .select()
    .from(t.tasks)
    .where(ids ? inArray(t.tasks.id, ids) : undefined)
    .orderBy(desc(t.tasks.createdAt))
  const taskIds = rows.map((row) => row.id)
  const [memoryIds, skillIds, toolIds, ruleIds, dispatchFrom] = await Promise.all([
    linksByTask(db, t.taskMemories, taskIds),
    linksByTask(db, t.taskSkills, taskIds),
    linksByTask(db, t.taskTools, taskIds),
    linksByTask(db, t.taskRules, taskIds),
    dispatchSourcesByTask(db, taskIds),
  ])
  return rows.map((row) =>
    compact({
      id: row.id,
      title: row.title,
      goal: row.goal,
      steps: row.steps.map((step) => compact(step)),
      ownerId: row.ownerId,
      createdAt: iso(row.createdAt),
      enabled: row.enabled,
      schedule: row.scheduleCron && row.scheduleText ? { cron: row.scheduleCron, text: row.scheduleText } : undefined,
      nextRunAt: isoOpt(row.nextRunAt),
      modelId: row.modelId,
      memoryIds: memoryIds.get(row.id) ?? [],
      skillIds: skillIds.get(row.id) ?? [],
      toolIds: toolIds.get(row.id) ?? [],
      ruleIds: ruleIds.get(row.id) ?? [],
      browserProfileIds: row.browserProfileIds,
      allowedDomains: row.allowedDomains,
      allowBrowserEvaluate: row.allowBrowserEvaluate,
      allowBrowserVision: row.allowBrowserVision,
      desktopIds: row.desktopIds,
      allowDesktopVision: row.allowDesktopVision,
      verifyModelId: opt(row.verifyModelId),
      reviewModelId: opt(row.reviewModelId),
      dispatch: row.dispatch ?? undefined,
      dispatchFrom: dispatchFrom.get(row.id) ?? [],
      cronSkipIfRunning: row.cronSkipIfRunning,
    })
  )
}

/** 派活：谁能派活给这些任务（task_id → source_task_id[]，按 id 排序） */
async function dispatchSourcesByTask(db: Db, taskIds: string[]) {
  const map = new Map<string, string[]>()
  if (taskIds.length === 0) return map
  const rows = await db.select().from(t.taskDispatchSources).where(inArray(t.taskDispatchSources.taskId, taskIds)).orderBy(asc(t.taskDispatchSources.sourceTaskId))
  for (const row of rows) map.set(row.taskId, [...(map.get(row.taskId) ?? []), row.sourceTaskId])
  return map
}

// ---------- 运行（session） ----------

/** session_waits / human_todos 的列 → 原型的 Trigger */
function toTrigger(row: {
  triggerKind: (typeof t.triggerKindEnum.enumValues)[number]
  at: Date | null
  cron: string | null
  cronText: string | null
  event: string | null
  fallbackDays: number | null
}): Trigger {
  switch (row.triggerKind) {
    case "time":
      return { kind: "time", at: iso(row.at!) }
    case "cron":
      return { kind: "cron", cron: row.cron!, text: row.cronText ?? row.cron!, next: iso(row.at!) }
    case "event":
      return { kind: "event", event: row.event!, fallbackDays: row.fallbackDays ?? 7 }
    case "time_or_event":
      return { kind: "time_or_event", at: iso(row.at!), event: row.event! }
  }
}

/** outcome 只筛列表的行（run-outcome：可以给几种），过程摘要等照 ids / taskId 的范围取 */
type SessionFilter = { ids?: string[]; taskId?: string; outcome?: RunOutcome[] }

/** 只取这些 session 的行：按 id，或按任务（子查询，不把 id 一个个拼进 SQL）；不筛返回 undefined */
function sessionScope(db: Db, column: AnyColumn, filter: SessionFilter) {
  if (filter.ids) return inArray(column, filter.ids)
  if (filter.taskId) return inArray(column, db.select({ id: t.sessions.id }).from(t.sessions).where(eq(t.sessions.taskId, filter.taskId)))
  return undefined
}

/**
 * 每个 session 的过程摘要（条数、最后一条、最后一条出错、挂起多久、用过的 Chrome），全在库里算，不把过程的输入、输出、详情读进来。
 * 算法和 shared 的 summarizeEvents 一样（测试里对过）
 */
async function eventSummaries(db: Db, filter: SessionFilter) {
  const ev = t.sessionEvents
  const scope = sessionScope(db, ev.sessionId, filter)
  const andScope = scope ? sql`and ${scope}` : sql``
  // 每个 session 的条数和最大的 seq，再按主键取那一条（比 DISTINCT ON 整表排序快得多）
  const latest = db
    .select({ sessionId: ev.sessionId, seq: sql<number>`max(${ev.seq})`.as("last_seq"), count: sql<number>`count(*)::int`.as("event_count") })
    .from(ev)
    .where(scope)
    .groupBy(ev.sessionId)
    .as("latest")
  const [lasts, errors, dones, paused, browsers] = await Promise.all([
    db
      .select({ sessionId: ev.sessionId, at: ev.at, kind: ev.kind, title: ev.title, count: latest.count })
      .from(latest)
      .innerJoin(ev, and(eq(ev.sessionId, latest.sessionId), eq(ev.seq, latest.seq))),
    db
      .selectDistinctOn([ev.sessionId], { sessionId: ev.sessionId, at: ev.at, title: ev.title })
      .from(ev)
      .where(and(scope, eq(ev.kind, "error")))
      .orderBy(ev.sessionId, desc(ev.seq)),
    // 最后一条结束过程的说明（没完成的原因）
    db
      .selectDistinctOn([ev.sessionId], { sessionId: ev.sessionId, detail: ev.detail })
      .from(ev)
      .where(and(scope, eq(ev.kind, "done")))
      .orderBy(ev.sessionId, desc(ev.seq)),
    // 挂起、继续按 seq 排，前一条是挂起的「继续」才算（连着两个挂起按后一个算）；截到毫秒，和前端 Date.parse 的结果一致
    db.execute<{ session_id: string; ms: number }>(sql`
      select session_id, (sum(extract(epoch from date_trunc('milliseconds', at) - date_trunc('milliseconds', prev_at))) * 1000)::float8 as ms
      from (
        select ${ev.sessionId} as session_id, ${ev.kind} as kind, ${ev.at} as at, lag(${ev.kind}) over w as prev_kind, lag(${ev.at}) over w as prev_at
        from ${ev}
        where ${ev.kind} in ('wait', 'resume') ${andScope}
        window w as (partition by ${ev.sessionId} order by ${ev.seq})
      ) pairs
      where kind = 'resume' and prev_kind = 'wait'
      group by session_id`),
    // 工具输入里的 profileId / browser，和「打开了 Chrome」过程详情开头的配置 id；先用 strpos、like 筛掉不相干的，正则只跑剩下的
    db.execute<{ session_id: string; id: string }>(sql`
      select ${ev.sessionId} as session_id, (regexp_matches(${ev.input}, ${BROWSER_ID_IN_INPUT}, 'g'))[1] as id
      from ${ev}
      where (strpos(${ev.input}, '"profileId"') > 0 or strpos(${ev.input}, '"browser"') > 0) ${andScope}
      union
      select ${ev.sessionId}, substring(${ev.detail} from ${BROWSER_ID_IN_PLAN})
      from ${ev}
      where ${ev.kind} = 'plan' and ${ev.detail} like 'Chrome 配置 %' ${andScope}`),
  ])
  const browserIds = new Map<string, Set<string>>()
  for (const row of browsers.rows) {
    if (!row.id) continue
    const set = browserIds.get(row.session_id) ?? new Set()
    browserIds.set(row.session_id, set.add(row.id))
  }
  return {
    last: new Map(lasts.map((row) => [row.sessionId, row])),
    error: new Map(errors.map((row) => [row.sessionId, row])),
    doneDetail: new Map(dones.map((row) => [row.sessionId, row.detail])),
    pausedMs: new Map(paused.rows.map((row) => [row.session_id, Math.round(Number(row.ms))])),
    // 和 shared 的 browserIdsOf 一样按 JS 的默认顺序排（库里的排序规则可能不同）
    browserIds: (sessionId: string) => [...(browserIds.get(sessionId) ?? [])].sort(),
  }
}

/**
 * session 列表（新的在前）：摘要，不带过程。可以按 id 或任务筛。
 * 不按 id 取时（sessions.list：会话页、任务卡片的最近运行、浏览器页「最近用它的运行」）只列普通运行：
 * 固化试跑不进会话列表、不算统计（docs/dev/solidify.md 15.3 第 5 条）；按 id 取（sessions.get、会话页的一页）照常能看试跑
 */
export async function listSessions(db: Db, filter: SessionFilter = {}): Promise<SessionSummary[]> {
  const rows = await db
    .select()
    .from(t.sessions)
    .where(
      and(
        filter.ids ? inArray(t.sessions.id, filter.ids) : eq(t.sessions.kind, "run"),
        filter.taskId ? eq(t.sessions.taskId, filter.taskId) : undefined,
        filter.outcome?.length ? inArray(t.sessions.outcome, filter.outcome) : undefined
      )
    )
    .orderBy(desc(t.sessions.startedAt))
  if (rows.length === 0) return []
  const checkpointScope = sessionScope(db, t.checkpoints.sessionId, filter)
  const [summaries, checkpoints, records, waits] = await Promise.all([
    eventSummaries(db, filter),
    db.select().from(t.checkpoints).where(checkpointScope).orderBy(asc(t.checkpoints.sessionId), asc(t.checkpoints.position)),
    db
      .select()
      .from(t.checkpointRecords)
      .where(checkpointScope ? inArray(t.checkpointRecords.checkpointId, db.select({ id: t.checkpoints.id }).from(t.checkpoints).where(checkpointScope)) : undefined)
      .orderBy(asc(t.checkpointRecords.at), asc(t.checkpointRecords.id)),
    db
      .select()
      .from(t.sessionWaits)
      .where(and(sessionScope(db, t.sessionWaits.sessionId, filter), eq(t.sessionWaits.status, "waiting"))),
  ])

  const group = <R, K>(list: R[], key: (row: R) => K) => {
    const map = new Map<K, R[]>()
    for (const row of list) map.set(key(row), [...(map.get(key(row)) ?? []), row])
    return map
  }
  const checkpointsBy = group(checkpoints, (row) => row.sessionId)
  const recordsBy = group(records, (row) => row.checkpointId)
  const waitBy = new Map(waits.map((row) => [row.sessionId, row]))

  return rows.map((row) => {
    const wait = waitBy.get(row.id)
    const last = summaries.last.get(row.id)
    const error = summaries.error.get(row.id)
    return compact({
      id: row.id,
      taskId: row.taskId,
      parentSessionId: opt(row.parentSessionId),
      workItemId: opt(row.workItemId),
      source: opt(row.triggeredBy),
      startedAt: iso(row.startedAt),
      endedAt: isoOpt(row.endedAt),
      status: row.status,
      outcome: opt(row.outcome),
      outcomeReason: opt(row.outcomeReason),
      outcomeBy: opt(row.outcomeBy),
      review: opt(row.review),
      modelId: row.modelId,
      tokensIn: row.tokensIn,
      tokensOut: row.tokensOut,
      costUsd: row.costUsd,
      exploredSteps: opt(row.exploredSteps),
      checkpoints: (checkpointsBy.get(row.id) ?? []).map((cp) =>
        compact({
          title: cp.title,
          kind: cp.kind,
          target: opt(cp.target),
          stepId: opt(cp.stepId),
          status: cp.status,
          progress: opt(cp.progress),
          records: (recordsBy.get(cp.id) ?? []).map((record) => ({ at: iso(record.at), text: record.text, synced: record.synced })),
          skipReason: opt(cp.skipReason),
        })
      ),
      waiting: wait ? { what: wait.what, trigger: toTrigger({ ...wait, at: wait.resumeAt }), since: iso(wait.createdAt) } : undefined,
      verification: opt(row.verification),
      digest: opt(row.digest),
      eventCount: last?.count ?? 0,
      lastEvent: last && { at: iso(last.at), kind: last.kind, title: last.title },
      lastError: error && { at: iso(error.at), title: error.title },
      doneDetail: opt(summaries.doneDetail.get(row.id)),
      pausedMs: summaries.pausedMs.get(row.id) ?? 0,
      browserIds: summaries.browserIds(row.id),
      kind: row.kind === "run" ? undefined : row.kind,
      routine: opt(row.routine),
    })
  })
}

/** 一个 session 的全部：摘要 + 全部过程（按 seq） */
export async function loadSession(db: Db, id: string): Promise<SessionRun | undefined> {
  const [[summary], events] = await Promise.all([
    listSessions(db, { ids: [id] }),
    db.select().from(t.sessionEvents).where(eq(t.sessionEvents.sessionId, id)).orderBy(asc(t.sessionEvents.seq)),
  ])
  if (!summary) return undefined
  return {
    ...summary,
    events: events.map((event) =>
      compact({
        seq: event.seq,
        at: iso(event.at),
        kind: event.kind,
        title: event.title,
        detail: opt(event.detail),
        toolId: opt(event.toolId),
        input: opt(event.input),
        output: opt(event.output),
        ms: opt(event.ms),
        tokensIn: opt(event.tokensIn),
        tokensOut: opt(event.tokensOut),
        trace: opt(event.trace),
      })
    ),
  }
}

// ---------- 任务记忆 ----------

export async function listTaskMemory(db: Db, taskId: string): Promise<TaskMemoryEntry[]> {
  const rows = await db.select().from(t.taskMemoryEntries).where(eq(t.taskMemoryEntries.taskId, taskId)).orderBy(asc(t.taskMemoryEntries.id))
  return rows.map((row) =>
    compact({
      id: row.id,
      taskId: row.taskId,
      content: row.content,
      sourceSessionId: opt(row.sourceSessionId),
      createdById: opt(row.createdById),
      createdAt: iso(row.createdAt),
      updatedAt: iso(row.updatedAt),
    })
  )
}

// ---------- 待办 ----------

export async function listOpenHumanItems(db: Db): Promise<HumanItem[]> {
  const rows = await db.select().from(t.humanItems).where(eq(t.humanItems.status, "open")).orderBy(asc(t.humanItems.urgency), asc(t.humanItems.createdAt))
  return rows.map((row) =>
    compact({
      id: row.id,
      kind: row.kind,
      title: row.title,
      summary: row.summary,
      assigneeId: row.assigneeId,
      taskId: opt(row.taskId),
      runId: opt(row.sessionId),
      ruleId: opt(row.ruleId),
      memoryId: opt(row.memoryId),
      skillId: opt(row.skillId),
      createdAt: iso(row.createdAt),
      urgency: row.urgency,
      detail: row.detail,
    })
  )
}

export async function listActiveTodos(db: Db): Promise<HumanTodo[]> {
  const rows = await db.select().from(t.humanTodos).where(eq(t.humanTodos.status, "active")).orderBy(desc(t.humanTodos.createdAt))
  return rows.map((row) => ({
    id: row.id,
    taskId: row.taskId,
    title: row.title,
    trigger: toTrigger({ ...row, at: row.triggerKind === "cron" ? row.nextAt : row.at }),
    createdById: row.createdById,
    createdAt: iso(row.createdAt),
  }))
}

// ---------- 记忆 ----------

export async function listMemories(db: Db, now = new Date()): Promise<MemoryRef[]> {
  const rows = await db
    .select({ memory: t.memories, lastUsedTaskId: t.sessions.taskId })
    .from(t.memories)
    .leftJoin(t.sessions, eq(t.sessions.id, t.memories.lastUsedSessionId))
    // id 按编号递增（m-001、m-002……），和原型的顺序一致
    .orderBy(asc(t.memories.id))
  const reviewItems = await db
    .select({ id: t.humanItems.id, memoryId: t.humanItems.memoryId })
    .from(t.humanItems)
    .where(and(eq(t.humanItems.status, "open"), eq(t.humanItems.kind, "memory")))
  const reviewBy = new Map(reviewItems.map((row) => [row.memoryId, row.id]))
  return rows.map(({ memory, lastUsedTaskId }) =>
    compact({
      id: memory.id,
      content: memory.content,
      appliesTo: memory.appliesTo,
      status: memory.status,
      source:
        memory.sourceKind === "human"
          ? { kind: "human" as const, byId: memory.sourceById ?? "" }
          : { kind: "agent" as const, taskId: memory.sourceTaskId ?? "", evidence: memory.sourceEvidence ?? "result" },
      reviewerId: opt(memory.reviewerId),
      createdAt: iso(memory.createdAt),
      webUnverified: memory.webUnverified || undefined,
      note: compact({
        evidence: opt(memory.evidence),
        lastUsed: memory.lastUsedAt && lastUsedTaskId ? `最近一次：${relativeDayText(iso(memory.lastUsedAt), now)}，${lastUsedTaskId} 的运行开始时读到` : undefined,
      }),
      reviewItemId: memory.status === "pending" ? reviewBy.get(memory.id) : undefined,
    })
  )
}

// ---------- 技能 ----------

export async function listSkills(db: Db): Promise<Skill[]> {
  const [rows, links, suggestions] = await Promise.all([
    db.select().from(t.skills).orderBy(asc(t.skills.position), asc(t.skills.createdAt)),
    db.select().from(t.skillTools).orderBy(asc(t.skillTools.position)),
    db.select().from(t.skillSuggestions).where(eq(t.skillSuggestions.status, "pending")).orderBy(desc(t.skillSuggestions.createdAt)),
  ])
  return rows.map((row) => {
    const suggestion = suggestions.find((each) => each.skillId === row.id)
    return compact({
      id: row.id,
      name: row.name,
      description: row.description,
      dept: row.dept,
      status: row.status,
      ownerId: row.ownerId,
      toolIds: links.filter((link) => link.skillId === row.id).map((link) => link.toolId),
      suggestion: suggestion
        ? compact({ taskId: suggestion.taskId ?? "", summary: suggestion.summary, reviewerId: suggestion.reviewerId, createdAt: iso(suggestion.createdAt), itemId: opt(suggestion.humanItemId) })
        : undefined,
      version: row.version,
      updatedAt: iso(row.updatedAt),
      body: row.body,
    })
  })
}

// ---------- 规则、工具 ----------

export async function listRules(db: Db): Promise<RuleRef[]> {
  const [rows, links] = await Promise.all([db.select().from(t.rules).orderBy(asc(t.rules.position), asc(t.rules.createdAt)), db.select().from(t.ruleTools).orderBy(asc(t.ruleTools.position))])
  return rows.map((row) =>
    compact({
      id: row.id,
      name: row.name,
      trigger: row.trigger,
      action: row.action,
      toolIds: links.filter((link) => link.ruleId === row.id).map((link) => link.toolId),
      compiledTrigger: opt(row.compiledTrigger),
      compile: ruleCompileView(row),
    })
  )
}

/** 规则的生效状态（M3）：现在这段文字翻译了没有、确认了没有；正在执行的是哪个版本 */
export function ruleCompileView(row: typeof t.rules.$inferSelect): RuleCompileView {
  const enforced = compiledRuleSchema.safeParse(row.compiledTrigger)
  const enforcedText = parseCompiledText(row.compiledText)
  const effective = enforced.success
  const current = effective && enforcedText?.trigger === row.trigger && enforcedText?.action === row.action
  const draft = row.compileDraft && row.compileDraft.trigger === row.trigger && row.compileDraft.action === row.action ? row.compileDraft : undefined
  const status: RuleCompileView["status"] = current ? "active" : draft ? (draft.supported ? "pending" : "unsupported") : "untranslated"
  return compact({
    status,
    understood: current && enforced.success ? enforced.data.understood : draft?.understood,
    reason: !current && draft && !draft.supported ? draft.reason : undefined,
    draft: current && enforced.success ? enforced.data : draft?.compiled,
    translatedAt: current ? isoOpt(row.confirmedAt) : draft?.at,
    modelId: draft?.modelId,
    effective,
    enforced: enforced.success
      ? compact({
          understood: enforced.data.understood,
          trigger: enforcedText?.trigger ?? row.trigger,
          action: enforcedText?.action ?? row.action,
          confirmedAt: isoOpt(row.confirmedAt),
          confirmedById: opt(row.confirmedById),
        })
      : undefined,
    outdated: effective && !current ? true : undefined,
  }) as RuleCompileView
}

export async function listTools(db: Db): Promise<{ tools: Tool[]; mcpServers: McpServer[]; savedSecrets: Record<string, SavedSecret> }> {
  const [toolRows, serverRows, secretRows] = await Promise.all([
    db.select().from(t.tools).orderBy(asc(t.tools.position), asc(t.tools.createdAt)),
    db.select().from(t.mcpServers).orderBy(asc(t.mcpServers.position), asc(t.mcpServers.createdAt)),
    // 只取名字、谁存的、什么时候存的；enc（密文）不读出来
    db
      .select({ name: t.secrets.name, byId: t.secrets.createdById, by: t.users.name, at: t.secrets.createdAt })
      .from(t.secrets)
      .leftJoin(t.users, eq(t.users.id, t.secrets.createdById))
      .where(eq(t.secrets.scope, "http_tool")),
  ])
  return {
    tools: toolRows.map((row) =>
      compact({
        id: row.id,
        name: row.name,
        summary: row.summary,
        description: row.description,
        source: row.source,
        serverId: opt(row.serverId),
        http: row.http ? compact(row.http) : undefined,
        risk: row.risk,
        alwaysOn: row.alwaysOn || undefined,
      })
    ),
    mcpServers: serverRows.map((row) =>
      compact({
        id: row.id,
        name: row.name,
        transport: row.transport,
        command: opt(row.command),
        url: opt(row.url),
        status: row.status,
        note: row.note,
        env: row.envKeys.length ? row.envKeys.map((key) => `${key}=••••`).join("\n") : undefined,
      })
    ),
    // 通知渠道的 webhook 地址也存在这个范围，但不是给工具用的，不显示
    savedSecrets: Object.fromEntries(secretRows.filter((row) => !row.name.startsWith(NOTIFY_SECRET_PREFIX)).map((row) => [row.name, { by: row.by ?? "—", byId: row.byId ?? "", at: iso(row.at) }])),
  }
}

// ---------- 浏览器 ----------

export async function listBrowsers(db: Db): Promise<BrowserProfile[]> {
  const [profiles, accounts, vaults, leases, passwords, accountPasswords] = await Promise.all([
    db.select().from(t.browserProfiles).orderBy(asc(t.browserProfiles.position), asc(t.browserProfiles.createdAt)),
    db.select().from(t.browserAccounts).orderBy(asc(t.browserAccounts.position), asc(t.browserAccounts.createdAt)),
    // 保险箱只取版本、cookie 个数、更新时间，不读密文
    db.select({ profileId: t.browserVaults.profileId, version: t.browserVaults.version, cookieCount: t.browserVaults.cookieCount, updatedAt: t.browserVaults.updatedAt }).from(t.browserVaults),
    db.select({ accountId: t.accountLeases.accountId, sessionId: t.accountLeases.sessionId }).from(t.accountLeases).where(isNull(t.accountLeases.releasedAt)),
    db.select({ id: t.secrets.id }).from(t.secrets).where(eq(t.secrets.scope, "browser_proxy")),
    // 账号的登录密码：只看有没有，不读密文
    db.select({ refId: t.secrets.refId }).from(t.secrets).where(eq(t.secrets.scope, "browser_account")),
  ])
  const passwordIds = new Set(passwords.map((row) => row.id))
  const accountsWithPassword = new Set(accountPasswords.map((row) => row.refId))
  return profiles.map((profile) => {
    const vault = vaults.find((row) => row.profileId === profile.id)
    const own = accounts.filter((row) => row.profileId === profile.id)
    const ownIds = new Set(own.map((row) => row.id))
    const sessionsHere = new Set(leases.filter((lease) => ownIds.has(lease.accountId)).map((lease) => lease.sessionId))
    return compact({
      id: profile.id,
      name: profile.name,
      description: profile.description,
      proxy:
        profile.proxyKind === "socks5"
          ? compact({
              kind: "socks5" as const,
              host: profile.proxyHost ?? "",
              port: profile.proxyPort ?? 0,
              username: opt(profile.proxyUsername),
              hasPassword: profile.proxyPasswordSecretId ? passwordIds.has(profile.proxyPasswordSecretId) : undefined,
            })
          : { kind: "none" as const },
      exitIp: profile.exitIp,
      running: sessionsHere.size,
      sites: own.map((account) =>
        compact({
          accountId: account.id,
          platformId: account.platformId,
          account: account.account,
          status: account.status,
          lastLoginAt: iso(account.lastLoginAt ?? account.createdAt),
          loggedInById: account.loggedInById ?? "",
          maxConcurrent: account.maxConcurrent,
          running: leases.filter((lease) => lease.accountId === account.id).length,
          probeUrl: opt(account.probeUrl),
          saveIndexedDb: account.saveIndexedDb || undefined,
          hasPassword: accountsWithPassword.has(account.id) || undefined,
        })
      ),
      cookieCount: vault?.cookieCount ?? 0,
      vaultVersion: vault?.version ?? 0,
      updatedAt: iso(vault?.updatedAt ?? profile.updatedAt),
      timezone: opt(profile.timezone),
      locale: opt(profile.locale),
    })
  })
}

// ---------- 模型 ----------

export async function loadModels(db: Db): Promise<{ providers: ModelProvider[]; defaults: ModelDefaults }> {
  const [providers, models, defaults] = await Promise.all([
    // API key 只取掩码
    db
      .select({ provider: t.modelProviders, masked: t.secrets.masked })
      .from(t.modelProviders)
      .leftJoin(t.secrets, eq(t.secrets.id, t.modelProviders.apiKeySecretId))
      .orderBy(asc(t.modelProviders.position), asc(t.modelProviders.createdAt)),
    db.select().from(t.models).orderBy(asc(t.models.position)),
    db.select().from(t.modelDefaults),
  ])
  const defaultOf = (role: ModelRole) => defaults.find((row) => row.role === role)?.modelId ?? ""
  const modelsOf = (providerId: string, kind: "chat" | "embedding") =>
    models
      .filter((model) => model.providerId === providerId && model.kind === kind)
      .map((model) => ({ id: model.id, name: model.name, note: model.note, contextK: model.contextK, priceIn: model.priceIn, priceOut: model.priceOut, vision: model.vision, ...(model.manual ? { manual: true } : {}) }))
  return {
    providers: providers.map(({ provider, masked }) => {
      const embeddingModels = modelsOf(provider.id, "embedding")
      return compact({
        id: provider.id,
        kind: provider.kind,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKeyMasked: opt(masked),
        status: provider.status,
        checkedAt: isoOpt(provider.checkedAt),
        latencyMs: opt(provider.latencyMs),
        supportsJsonSchema: provider.kind === "custom" ? provider.supportsJsonSchema : undefined,
        models: modelsOf(provider.id, "chat"),
        embeddingModels: embeddingModels.length ? embeddingModels : undefined,
      })
    }),
    defaults: compact({
      run: defaultOf("run"),
      plan: defaultOf("plan"),
      verify: defaultOf("verify"),
      embed: opt(defaultOf("embed") || null),
      assistant: opt(defaultOf("assistant") || null),
      review: opt(defaultOf("review") || null),
      solidify: opt(defaultOf("solidify") || null),
    }),
  }
}
