// 流程库的读和写（docs/dev/routine-library.md 第 2、4.1、6.3、6.4 节，10.3 的接口）。
// - 读：列表、详情（登记、发布的那一版、谁在用、最近 50 次成绩、最近 5 次停下的）、调用记录分页；任务详情「固化流程」区块里的那一行。
// - 写（都要 config.manage，都在一个事务里改数据 + 记审计）：发布（第一次、新版本、回到以前的版本）、改名字和说明、停用 / 重新启用、撤下。
// - 发布时写 tools 那一行：id = routine.<短名>、source = routine、routine_id、name = 名字、summary = 「什么时候用」、
//   description = analyze.ts 的 routineToolDescription、risk；同时写一行 routine_library_versions（requires、risk、compat、当时在用几个任务）。
// - 撤下：没有任务选用（tasksUsingRef(t.taskTools, [toolId])）、也没有别的库流程调它（别的登记的 requires.routines）时才能撤，
//   删掉 tools 那一行，登记留着（status = withdrawn），能重新发布；短名不变。
// - 停用：不管有没有人用都能停，tools 那一行留着；重新启用清零 fail_streak。
// 审计：routine.library.publish / .update / .pause / .resume / .withdraw（自动停用 .auto_pause 在 stats.ts）。
// 通知（7）：来源流程有新的转正式版本（可以发布）、来源流程被自动停用（「库里的第 3 版多半也跑不通了」），runtime/stats.ts 调；
// 库流程自己连续跑不通自动停用的通知在 stats.ts（A 包）。
import { and, asc, desc, eq, gt, inArray, isNotNull, like, lt, sql } from "drizzle-orm"
import {
  LIBRARY_CALLS_PAGE,
  LIBRARY_RECENT_STOPS,
  LIBRARY_STATS_WINDOW,
  defaultLibrarySummary,
  missingRoutineRequires,
  routineBrowserFlagLabel,
  routineRequiresSchema,
  routineSlugSchema,
  routineToolId,
  type Actor,
  type RoutineCall,
  type RoutineCallsPage,
  type RoutineLibraryCandidate,
  type RoutineLibraryDetail,
  type RoutineLibraryItem,
  type RoutineLibraryPreview,
  type RoutineLibraryPublishInput,
  type RoutineLibraryStatus,
  type RoutineRequires,
  type RoutineSummary,
} from "@heyagent/shared"

import { assertCan, audit, badRequest, conflict, notFound, type DbOrTx, type WriteCtx } from "../../data/config/common.js"
import { tasksUsingRef, usedByText } from "../../data/config/tasks.js"
import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { notifyUsers } from "../../engine/notify.js"
import { analyzeForPublish, analyzeLibraryCode, compatWithPublished, routineSource, routineToolDescription, withSourceDeclared } from "./analyze.js"

/** 流程页的链接（通知用） */
export const libraryLink = (routineId: string) => `#/routines?id=${encodeURIComponent(routineId)}`

const iso = (value: Date) => value.toISOString()
const emptyRequires = (): RoutineRequires => ({ toolIds: [], browser: {}, routines: [] })
const requiresOf = (value: unknown): RoutineRequires => {
  const parsed = routineRequiresSchema.safeParse(value)
  return parsed.success ? parsed.data : emptyRequires()
}

type EntryRow = typeof t.routineLibrary.$inferSelect

async function loadEntry(db: DbOrTx, routineId: string): Promise<EntryRow | undefined> {
  const [row] = await db.select().from(t.routineLibrary).where(eq(t.routineLibrary.routineId, routineId))
  return row
}

async function requireEntry(db: DbOrTx, routineId: string): Promise<EntryRow> {
  const entry = await loadEntry(db, routineId)
  if (!entry) throw notFound("流程库里的流程", routineId)
  return entry
}

/** 每个工具 id 被几个任务选用 */
async function taskCounts(db: DbOrTx, toolIds: string[]): Promise<Map<string, number>> {
  if (!toolIds.length) return new Map()
  const rows = await db
    .select({ toolId: t.taskTools.refId, count: sql<number>`count(*)::int` })
    .from(t.taskTools)
    .where(inArray(t.taskTools.refId, toolIds))
    .groupBy(t.taskTools.refId)
  return new Map(rows.map((row) => [row.toolId, row.count]))
}

/** 转过正式的版本号（新的在前），每个流程一组 */
async function provenVersions(db: DbOrTx, routineIds: string[]): Promise<Map<string, { version: number; name: string; provenAt: Date }[]>> {
  if (!routineIds.length) return new Map()
  const rows = await db
    .select({ routineId: t.routineVersions.routineId, version: t.routineVersions.version, name: t.routineVersions.name, provenAt: t.routineVersions.provenAt })
    .from(t.routineVersions)
    .where(and(inArray(t.routineVersions.routineId, routineIds), isNotNull(t.routineVersions.provenAt)))
    .orderBy(desc(t.routineVersions.version))
  const out = new Map<string, { version: number; name: string; provenAt: Date }[]>()
  for (const row of rows) out.set(row.routineId, [...(out.get(row.routineId) ?? []), { version: row.version, name: row.name, provenAt: row.provenAt! }])
  return out
}

async function people(db: DbOrTx, ids: (string | null)[]): Promise<(id: string | null) => { id: string; name: string } | null> {
  const unique = [...new Set(ids.filter((id): id is string => Boolean(id)))]
  const rows = unique.length ? await db.select({ id: t.users.id, name: t.users.name }).from(t.users).where(inArray(t.users.id, unique)) : []
  return (id) => (id ? (rows.find((row) => row.id === id) ?? { id, name: id }) : null)
}

// ---------- 读 ----------

/** 列表（所有人）：在库里的、停用的、撤下的都列，前端分组 */
export async function listLibrary(db: Db): Promise<RoutineLibraryItem[]> {
  const entries = await db.select().from(t.routineLibrary).orderBy(asc(t.routineLibrary.createdAt), asc(t.routineLibrary.slug))
  const counts = await taskCounts(
    db,
    entries.map((entry) => routineToolId(entry.slug))
  )
  const proven = await provenVersions(
    db,
    entries.map((entry) => entry.routineId)
  )
  return entries.map((entry) => {
    const newer = (proven.get(entry.routineId) ?? []).find((each) => each.version > entry.publishedVersion)
    return {
      routineId: entry.routineId,
      slug: entry.slug,
      toolId: routineToolId(entry.slug),
      title: entry.title,
      summary: entry.summary,
      status: entry.status,
      publishedVersion: entry.publishedVersion,
      taskCount: entry.status === "withdrawn" ? 0 : (counts.get(routineToolId(entry.slug)) ?? 0),
      newerVersion: newer?.version ?? null,
      failStreak: entry.failStreak,
    }
  })
}

const callColumns = {
  id: t.routineCalls.id,
  routineId: t.routineCalls.routineId,
  version: t.routineCalls.version,
  sessionId: t.routineCalls.sessionId,
  taskId: t.routineCalls.taskId,
  taskTitle: t.tasks.title,
  callId: t.routineCalls.callId,
  via: t.routineCalls.via,
  depth: t.routineCalls.depth,
  result: t.routineCalls.result,
  stopKind: t.routineCalls.stopKind,
  stopStep: t.routineCalls.stopStep,
  stopReason: t.routineCalls.stopReason,
  steps: t.routineCalls.steps,
  ms: t.routineCalls.ms,
  at: t.routineCalls.at,
}

const toCall = (row: Omit<RoutineCall, "at"> & { at: Date }): RoutineCall => ({ ...row, at: iso(row.at) })

const average = (values: number[]) => (values.length ? Math.round(values.reduce((sum, each) => sum + each, 0) / values.length) : null)

/** 最近 LIBRARY_STATS_WINDOW 次调用的成绩：报了结果的平均用时；按任务分开；最近几次停下的另查 */
function statsOf(calls: RoutineCall[]): Omit<RoutineLibraryDetail["stats"], "recentStops"> {
  const reported = (rows: RoutineCall[]) => rows.filter((row) => row.result === "achieved" || row.result === "not_achieved")
  const byTask = new Map<string, RoutineCall[]>()
  for (const call of calls) byTask.set(call.taskId, [...(byTask.get(call.taskId) ?? []), call])
  return {
    calls: calls.length,
    achieved: calls.filter((row) => row.result === "achieved").length,
    notAchieved: calls.filter((row) => row.result === "not_achieved").length,
    badInput: calls.filter((row) => row.result === "bad_input").length,
    stopped: calls.filter((row) => row.result === "stopped").length,
    avgMs: average(reported(calls).map((row) => row.ms)),
    byTask: [...byTask.entries()].map(([taskId, rows]) => ({
      taskId,
      title: rows[0]!.taskTitle,
      calls: rows.length,
      achieved: rows.filter((row) => row.result === "achieved").length,
      notAchieved: rows.filter((row) => row.result === "not_achieved").length,
      stopped: rows.filter((row) => row.result === "stopped").length,
      avgMs: average(reported(rows).map((row) => row.ms)),
    })),
  }
}

/** 别的库流程（没撤下的）里调了它的 */
function callersOf<E extends Pick<EntryRow, "slug" | "status" | "requires">>(entries: E[], slug: string): E[] {
  return entries.filter((entry) => entry.slug !== slug && entry.status !== "withdrawn" && requiresOf(entry.requires).routines.includes(slug))
}

/** 详情（所有人）。没有登记 → NOT_FOUND */
export async function getLibraryEntry(db: Db, routineId: string): Promise<RoutineLibraryDetail> {
  const entry = await requireEntry(db, routineId)
  const toolId = routineToolId(entry.slug)
  const [found] = await db
    .select({ taskId: t.tasks.id, title: t.tasks.title, ownerId: t.tasks.ownerId, dispatch: t.tasks.dispatch })
    .from(t.routines)
    .innerJoin(t.tasks, eq(t.tasks.id, t.routines.taskId))
    .where(eq(t.routines.id, routineId))
  if (!found) throw notFound("固化流程", routineId)
  const { dispatch, ...source } = found
  const [stored] = await db
    .select()
    .from(t.routineVersions)
    .where(and(eq(t.routineVersions.routineId, routineId), eq(t.routineVersions.version, entry.publishedVersion)))
  if (!stored) throw notFound("固化流程的版本", `${routineId} 第 ${entry.publishedVersion} 版`)
  // 输入、交回表的说明：固化员没写的按来源任务声明的补上
  const version = withSourceDeclared(stored, dispatch)
  const proven = (await provenVersions(db, [routineId])).get(routineId) ?? []
  const publishes = await db
    .select()
    .from(t.routineLibraryVersions)
    .where(eq(t.routineLibraryVersions.routineId, routineId))
    .orderBy(desc(t.routineLibraryVersions.publishedAt), desc(t.routineLibraryVersions.id))
  const person = await people(db, [entry.publishedById, ...publishes.map((row) => row.publishedById)])

  // 谁在用：选了它的任务（最近一次调用）；调它的库流程
  const users = entry.status === "withdrawn" ? [] : await tasksUsingRef(db, t.taskTools, [toolId])
  const lastCalls = users.length
    ? await db
        .selectDistinctOn([t.routineCalls.taskId], { taskId: t.routineCalls.taskId, at: t.routineCalls.at, result: t.routineCalls.result })
        .from(t.routineCalls)
        .where(and(eq(t.routineCalls.routineId, routineId), inArray(t.routineCalls.taskId, users.map((task) => task.id))))
        .orderBy(t.routineCalls.taskId, desc(t.routineCalls.at), desc(t.routineCalls.id))
    : []
  const entries = await db.select().from(t.routineLibrary)
  const callers = callersOf(entries, entry.slug)

  const recent = (
    await db
      .select(callColumns)
      .from(t.routineCalls)
      .innerJoin(t.tasks, eq(t.tasks.id, t.routineCalls.taskId))
      .where(eq(t.routineCalls.routineId, routineId))
      .orderBy(desc(t.routineCalls.at), desc(t.routineCalls.id))
      .limit(LIBRARY_STATS_WINDOW)
  ).map(toCall)
  const stops = (
    await db
      .select(callColumns)
      .from(t.routineCalls)
      .innerJoin(t.tasks, eq(t.tasks.id, t.routineCalls.taskId))
      .where(and(eq(t.routineCalls.routineId, routineId), eq(t.routineCalls.result, "stopped")))
      .orderBy(desc(t.routineCalls.at), desc(t.routineCalls.id))
      .limit(LIBRARY_RECENT_STOPS)
  ).map(toCall)

  return {
    routineId,
    slug: entry.slug,
    toolId,
    title: entry.title,
    summary: entry.summary,
    status: entry.status,
    publishedVersion: entry.publishedVersion,
    requires: requiresOf(entry.requires),
    risk: entry.risk,
    failStreak: entry.failStreak,
    pausedReason: entry.pausedReason,
    publishedBy: person(entry.publishedById),
    publishedAt: iso(entry.publishedAt),
    createdAt: iso(entry.createdAt),
    source,
    version: {
      versionId: version.id,
      version: version.version,
      name: version.name,
      description: version.description,
      inputSchema: version.inputSchema,
      outputSchema: version.outputSchema,
      commits: version.commits,
      provenAt: version.provenAt ? iso(version.provenAt) : null,
    },
    newerVersions: proven.filter((each) => each.version > entry.publishedVersion).map((each) => each.version),
    publishes: publishes.map((row) => ({
      version: row.version,
      publishedBy: person(row.publishedById),
      publishedAt: iso(row.publishedAt),
      taskCount: row.taskCount,
      compat: row.compat,
    })),
    usedBy: {
      tasks: users.map((task) => {
        const last = lastCalls.find((row) => row.taskId === task.id)
        return { taskId: task.id, title: task.title, lastCall: last ? { at: iso(last.at), result: last.result } : null }
      }),
      routines: callers.map((caller) => ({ routineId: caller.routineId, slug: caller.slug, title: caller.title })),
    },
    stats: { ...statsOf(recent), recentStops: stops },
  }
}

/** 能发布的（主管）：有转过正式版本（routine_versions.proven_at 不空）的固化流程，连同已经在库里的登记 */
export async function libraryCandidates(db: Db, actor: Actor): Promise<RoutineLibraryCandidate[]> {
  assertCan(actor, "config.manage", {}, "只有主管能发布流程到流程库")
  const routineRows = await db
    .selectDistinct({ routineId: t.routines.id, taskId: t.tasks.id, taskTitle: t.tasks.title, activeVersion: t.routines.activeVersion })
    .from(t.routines)
    .innerJoin(t.tasks, eq(t.tasks.id, t.routines.taskId))
    .innerJoin(t.routineVersions, and(eq(t.routineVersions.routineId, t.routines.id), isNotNull(t.routineVersions.provenAt)))
    .orderBy(asc(t.tasks.id))
  const ids = routineRows.map((row) => row.routineId)
  const proven = await provenVersions(db, ids)
  const entries = ids.length ? await db.select().from(t.routineLibrary).where(inArray(t.routineLibrary.routineId, ids)) : []
  const active = ids.length
    ? await db
        .select({ routineId: t.routineVersions.routineId, version: t.routineVersions.version, name: t.routineVersions.name })
        .from(t.routineVersions)
        .innerJoin(t.routines, and(eq(t.routines.id, t.routineVersions.routineId), eq(t.routines.activeVersion, t.routineVersions.version)))
        .where(inArray(t.routineVersions.routineId, ids))
    : []
  return routineRows.map((row) => {
    const versions = proven.get(row.routineId) ?? []
    const entry = entries.find((each) => each.routineId === row.routineId)
    return {
      taskId: row.taskId,
      taskTitle: row.taskTitle,
      routineId: row.routineId,
      name: active.find((each) => each.routineId === row.routineId)?.name || versions[0]?.name || row.taskTitle,
      library: entry ? { slug: entry.slug, status: entry.status, publishedVersion: entry.publishedVersion } : null,
      versions: versions.map((each) => ({ version: each.version, name: each.name, provenAt: iso(each.provenAt) })),
    }
  })
}

/** 脚本里 ha.routine 调了 slug 的固化流程（各任务启用的那一版）和库流程（发布的那一版） */
async function routineCallers(db: DbOrTx, slug: string, entries: EntryRow[]): Promise<RoutineLibraryPreview["affected"]["routines"]> {
  const rows = await db
    .select({ routineId: t.routines.id, taskId: t.routines.taskId, title: t.tasks.title, version: t.routineVersions.version, code: t.routineVersions.code })
    .from(t.routineVersions)
    .innerJoin(t.routines, and(eq(t.routines.id, t.routineVersions.routineId), eq(t.routines.activeVersion, t.routineVersions.version)))
    .innerJoin(t.tasks, eq(t.tasks.id, t.routines.taskId))
    .where(like(t.routineVersions.code, "%routine%"))
  const out: RoutineLibraryPreview["affected"]["routines"] = rows
    .filter((row) => analyzeLibraryCode(row.code).routines.includes(slug))
    .map(({ routineId, taskId, title, version }) => ({ routineId, taskId, title, version }))
  const callers = callersOf(entries, slug)
  if (callers.length) {
    const sources = await db
      .select({ routineId: t.routines.id, taskId: t.routines.taskId })
      .from(t.routines)
      .where(inArray(t.routines.id, callers.map((caller) => caller.routineId)))
    for (const caller of callers) {
      if (out.some((each) => each.routineId === caller.routineId && each.version === caller.publishedVersion)) continue
      out.push({ routineId: caller.routineId, taskId: sources.find((each) => each.routineId === caller.routineId)?.taskId ?? "", title: caller.title, version: caller.publishedVersion })
    }
  }
  return out
}

/** 选了 toolId 的任务，按新的 requires 缺什么（工具写名字，开关写中文） */
async function affectedTasks(db: DbOrTx, toolId: string, requires: RoutineRequires): Promise<RoutineLibraryPreview["affected"]["tasks"]> {
  const users = await tasksUsingRef(db, t.taskTools, [toolId])
  if (!users.length) return []
  const ids = users.map((task) => task.id)
  // 一个一个查：发布时在事务里（同一个连接不能并发）
  const flags = await db.select({ id: t.tasks.id, fetch: t.tasks.allowBrowserFetch, vision: t.tasks.allowBrowserVision }).from(t.tasks).where(inArray(t.tasks.id, ids))
  const links = await db.select({ taskId: t.taskTools.taskId, toolId: t.taskTools.refId }).from(t.taskTools).where(inArray(t.taskTools.taskId, ids))
  const names = requires.toolIds.length ? await db.select({ id: t.tools.id, name: t.tools.name }).from(t.tools).where(inArray(t.tools.id, requires.toolIds)) : []
  return users.map((task) => {
    const flag = flags.find((row) => row.id === task.id)
    const missing = missingRoutineRequires(requires, {
      toolIds: links.filter((row) => row.taskId === task.id).map((row) => row.toolId),
      allowBrowserFetch: flag?.fetch ?? false,
      allowBrowserVision: flag?.vision ?? false,
    })
    return {
      taskId: task.id,
      title: task.title,
      missing: [
        ...missing.toolIds.map((id) => `工具「${names.find((row) => row.id === id)?.name ?? id}」`),
        ...missing.browser.map((flagName) => `打开「${routineBrowserFlagLabel[flagName]}」`),
      ],
    }
  })
}

/** 第一次发布的短名有什么问题（格式、和别的登记、和已有的工具撞） */
async function slugProblems(db: DbOrTx, routineId: string, slug: string | undefined): Promise<string[]> {
  if (!slug?.trim()) return ["第一次发布要填短名（英文小写字母、数字、下划线，例如 order_status）"]
  const parsed = routineSlugSchema.safeParse(slug)
  if (!parsed.success) return [parsed.error.issues[0]?.message ?? "短名格式不对"]
  const [taken] = await db.select({ routineId: t.routineLibrary.routineId, title: t.routineLibrary.title }).from(t.routineLibrary).where(eq(t.routineLibrary.slug, parsed.data))
  if (taken && taken.routineId !== routineId) return [`短名「${parsed.data}」已经被「${taken.title}」用了，换一个`]
  return toolIdProblems(db, routineId, parsed.data)
}

/** tools 里 routine.<短名> 已经被别的占了（只有流程库写这种 id，正常不会有） */
async function toolIdProblems(db: DbOrTx, routineId: string, slug: string): Promise<string[]> {
  const [tool] = await db.select({ id: t.tools.id, routineId: t.tools.routineId }).from(t.tools).where(eq(t.tools.id, routineToolId(slug)))
  return tool && tool.routineId !== routineId ? [`已经有别的工具叫 ${tool.id}，换一个短名`] : []
}

interface PreviewCore extends RoutineLibraryPreview {
  slug: string
  entry: EntryRow | undefined
  version: number
  versionRow: typeof t.routineVersions.$inferSelect
}

async function previewCore(db: DbOrTx, input: { routineId: string; version: number; slug?: string }): Promise<PreviewCore> {
  const [routine] = await db.select({ id: t.routines.id }).from(t.routines).where(eq(t.routines.id, input.routineId))
  if (!routine) throw notFound("固化流程", input.routineId)
  const [stored] = await db
    .select()
    .from(t.routineVersions)
    .where(and(eq(t.routineVersions.routineId, input.routineId), eq(t.routineVersions.version, input.version)))
  if (!stored) throw notFound("固化流程的版本", `${input.routineId} 第 ${input.version} 版`)
  // 被派的来源任务：输入、交回的说明按声明的补上（工具说明、tools 那一行都用补过的）
  const source = await routineSource(db, input.routineId)
  const versionRow = withSourceDeclared(stored, source?.dispatch)
  const entry = await loadEntry(db, input.routineId)
  // 短名发布后不能改：有登记就用登记的
  const slug = entry?.slug ?? input.slug?.trim() ?? ""
  const problems = entry ? await toolIdProblems(db, input.routineId, entry.slug) : await slugProblems(db, input.routineId, input.slug)
  const analysis = await analyzeForPublish(db, { routineId: input.routineId, version: input.version, slug: slug || `#${input.routineId}` })
  problems.push(...analysis.problems)
  // 撤下的不算「现在发布的」：没人在用，不比
  const compat = entry && entry.status !== "withdrawn" ? await compatWithPublished(db, { routineId: input.routineId, version: input.version, requires: analysis.requires }) : []
  const entries = await db.select().from(t.routineLibrary)
  const affected =
    entry && entry.status !== "withdrawn"
      ? { tasks: await affectedTasks(db, routineToolId(entry.slug), analysis.requires), routines: await routineCallers(db, entry.slug, entries) }
      : { tasks: [], routines: [] }
  const toolDescription = routineToolDescription({
    summary: entry?.summary ?? defaultLibrarySummary({ name: versionRow.name, taskTitle: source?.title }),
    description: versionRow.description,
    inputSchema: versionRow.inputSchema,
    outputSchema: versionRow.outputSchema,
    commits: analysis.commits,
    usesBrowser: analysis.requires.toolIds.includes("browser"),
  })
  return {
    routineId: input.routineId,
    version: input.version,
    requires: analysis.requires,
    risk: analysis.risk,
    commits: analysis.commits,
    toolDescription,
    problems,
    compat,
    affected,
    slug,
    entry,
    versionRow,
  }
}

/**
 * 发布前看一眼（主管）：要的工具和风险（analyze.ts）、程序检查（没转正式、有环、层数超了、调的库流程不在库里、短名）、
 * 和现在发布的版本比的不兼容改动、受影响的任务（按新版的 requires 缺什么）和流程（脚本里 ha.routine 调它的固化流程、库流程）
 */
export async function previewPublish(db: Db, actor: Actor, input: { routineId: string; version: number; slug?: string }): Promise<RoutineLibraryPreview> {
  assertCan(actor, "config.manage", {}, "只有主管能发布流程到流程库")
  const { routineId, version, requires, risk, commits, toolDescription, problems, compat, affected } = await previewCore(db, input)
  return { routineId, version, requires, risk, commits, toolDescription, problems, compat, affected }
}

/** tools 那一行：发布、改名字时重写（id = routine.<短名>） */
async function writeToolRow(
  tx: DbOrTx,
  input: { routineId: string; slug: string; title: string; summary: string; risk: RoutineLibraryPreview["risk"]; version: typeof t.routineVersions.$inferSelect; requires: RoutineRequires }
) {
  const values = {
    name: input.title,
    summary: input.summary,
    description: routineToolDescription({
      summary: input.summary,
      description: input.version.description,
      inputSchema: input.version.inputSchema,
      outputSchema: input.version.outputSchema,
      commits: input.version.commits,
      usesBrowser: input.requires.toolIds.includes("browser"),
    }),
    risk: input.risk,
    routineId: input.routineId,
    source: "routine" as const,
  }
  await tx
    .insert(t.tools)
    .values({ id: routineToolId(input.slug), ...values })
    .onConflictDoUpdate({ target: t.tools.id, set: { ...values, updatedAt: new Date() } })
}

/**
 * 发布（主管）：第一次（要 slug，不能和别的登记、tools 里已有的 id 撞）、新版本、回到以前的版本都是它。
 * 只收转过正式的版本；preview 的 problems 不空就 BAD_REQUEST；有不兼容改动而没有 acceptBreaking 就 CONFLICT（写清是哪些）。
 * 写登记（published_version、requires、risk，状态撤下的回到 listed、fail_streak 清零）、发布记录、tools 那一行
 */
export async function publishRoutine(ctx: WriteCtx, input: RoutineLibraryPublishInput): Promise<{ routineId: string; version: number }> {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能发布流程到流程库")
  return ctx.db.transaction(async (tx) => {
    // 同一个流程同时发布两次：后来的等前面的做完再算
    await tx.select({ id: t.routines.id }).from(t.routines).where(eq(t.routines.id, input.routineId)).for("update")
    const preview = await previewCore(tx, input)
    if (preview.problems.length) throw badRequest(`不能发布：${preview.problems.join("；")}`)
    const { entry, slug, versionRow } = preview
    if (preview.compat.length && !input.acceptBreaking) {
      const users = preview.affected.tasks.map((task) => `${task.taskId}「${task.title}」`)
      const scripts = preview.affected.routines.map((each) => `${each.routineId} 第 ${each.version} 版「${each.title}」`)
      throw conflict(
        `和现在发布的第 ${entry?.publishedVersion} 版比有不兼容的改动：${preview.compat.map((issue) => issue.text).join("；")}。` +
          `${users.length ? `选用它的任务：${users.join("、")}。` : ""}${scripts.length ? `脚本里调它的：${scripts.join("、")}。` : ""}确认这些会受影响再发布。`
      )
    }
    const toolId = routineToolId(slug)
    const taskCount = entry && entry.status !== "withdrawn" ? ((await taskCounts(tx, [toolId])).get(toolId) ?? 0) : 0
    const now = new Date()
    const fields = {
      title: input.title,
      summary: input.summary,
      publishedVersion: input.version,
      requires: preview.requires,
      risk: preview.risk,
      failStreak: 0,
      publishedById: ctx.actor.id,
      publishedAt: now,
      updatedAt: now,
    }
    if (entry)
      await tx
        .update(t.routineLibrary)
        .set({ ...fields, ...(entry.status === "withdrawn" ? { status: "listed" as const, pausedReason: null } : {}) })
        .where(eq(t.routineLibrary.routineId, input.routineId))
    else await tx.insert(t.routineLibrary).values({ routineId: input.routineId, slug, status: "listed", ...fields })
    await tx.insert(t.routineLibraryVersions).values({
      routineId: input.routineId,
      version: input.version,
      publishedById: ctx.actor.id,
      publishedAt: now,
      requires: preview.requires,
      risk: preview.risk,
      compat: preview.compat,
      taskCount,
    })
    await writeToolRow(tx, { routineId: input.routineId, slug, title: input.title, summary: input.summary, risk: preview.risk, version: versionRow, requires: preview.requires })
    await audit(tx, ctx.actor.id, "routine.library.publish", "routines", input.routineId, {
      slug,
      version: input.version,
      ...(entry ? { before: entry.publishedVersion, status: entry.status } : { first: true }),
      ...(preview.compat.length ? { compat: preview.compat.map((issue) => issue.text), acceptBreaking: true } : {}),
      taskCount,
    })
    return { routineId: input.routineId, version: input.version }
  })
}

/** 改名字和「什么时候用」（主管）：重写 tools 那一行（name、summary、description），下一次运行生效 */
export async function updateLibraryEntry(ctx: WriteCtx, input: { routineId: string; title: string; summary: string }): Promise<{ routineId: string }> {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能改流程库里的流程")
  return ctx.db.transaction(async (tx) => {
    const entry = await requireEntry(tx, input.routineId)
    if (entry.title === input.title && entry.summary === input.summary) return { routineId: input.routineId }
    await tx.update(t.routineLibrary).set({ title: input.title, summary: input.summary, updatedAt: new Date() }).where(eq(t.routineLibrary.routineId, input.routineId))
    // 撤下的没有 tools 那一行：重新发布时再写
    if (entry.status !== "withdrawn") {
      const [stored] = await tx
        .select()
        .from(t.routineVersions)
        .where(and(eq(t.routineVersions.routineId, input.routineId), eq(t.routineVersions.version, entry.publishedVersion)))
      if (!stored) throw notFound("固化流程的版本", `${input.routineId} 第 ${entry.publishedVersion} 版`)
      const version = withSourceDeclared(stored, (await routineSource(tx, input.routineId))?.dispatch)
      await writeToolRow(tx, { routineId: input.routineId, slug: entry.slug, title: input.title, summary: input.summary, risk: entry.risk, version, requires: requiresOf(entry.requires) })
    }
    const changed = [...(entry.title !== input.title ? ["title"] : []), ...(entry.summary !== input.summary ? ["summary"] : [])]
    await audit(tx, ctx.actor.id, "routine.library.update", "routines", input.routineId, { slug: entry.slug, changed })
    return { routineId: input.routineId }
  })
}

/** 停用 / 重新启用（主管）。撤下的不能这样启用（要重新发布） */
export async function setLibraryPaused(ctx: WriteCtx, input: { routineId: string; paused: boolean }): Promise<{ routineId: string; status: RoutineLibraryStatus }> {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能停用、启用流程库里的流程")
  return ctx.db.transaction(async (tx) => {
    const entry = await requireEntry(tx, input.routineId)
    if (entry.status === "withdrawn") throw badRequest("这个流程已经撤下了：要用就重新发布")
    const target = input.paused ? "paused" : "listed"
    if (entry.status === target) return { routineId: input.routineId, status: entry.status }
    if (input.paused) {
      const [actor] = await tx.select({ name: t.users.name }).from(t.users).where(eq(t.users.id, ctx.actor.id))
      await tx
        .update(t.routineLibrary)
        .set({ status: "paused", pausedReason: `${actor?.name ?? "主管"}停用了`, updatedAt: new Date() })
        .where(eq(t.routineLibrary.routineId, input.routineId))
    } else
      await tx
        .update(t.routineLibrary)
        .set({ status: "listed", pausedReason: null, failStreak: 0, updatedAt: new Date() })
        .where(eq(t.routineLibrary.routineId, input.routineId))
    await audit(tx, ctx.actor.id, input.paused ? "routine.library.pause" : "routine.library.resume", "routines", input.routineId, {
      slug: entry.slug,
      ...(input.paused ? {} : { failStreak: entry.failStreak, pausedReason: entry.pausedReason }),
    })
    return { routineId: input.routineId, status: target }
  })
}

/** 撤下（主管）：有任务选用、别的库流程调它时 CONFLICT，写清是哪些 */
export async function withdrawLibraryEntry(ctx: WriteCtx, input: { routineId: string }): Promise<{ routineId: string; status: "withdrawn" }> {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能撤下流程库里的流程")
  return ctx.db.transaction(async (tx) => {
    const entry = await requireEntry(tx, input.routineId)
    if (entry.status === "withdrawn") return { routineId: input.routineId, status: "withdrawn" as const }
    const toolId = routineToolId(entry.slug)
    const used = await tasksUsingRef(tx, t.taskTools, [toolId])
    const callers = callersOf(await tx.select().from(t.routineLibrary), entry.slug)
    if (used.length || callers.length)
      throw conflict(
        [
          used.length ? `这个流程正被 ${used.length} 个任务选用：${usedByText(used)}` : "",
          callers.length ? `库里的流程${callers.map((caller) => `「${caller.title}」（${caller.slug}）`).join("、")}在脚本里调它` : "",
        ]
          .filter(Boolean)
          .join("；") + "。先去掉这些引用，再撤下（只是暂时不让用，可以「停用」）。"
      )
    await tx.delete(t.tools).where(and(eq(t.tools.id, toolId), eq(t.tools.routineId, input.routineId)))
    await tx.update(t.routineLibrary).set({ status: "withdrawn", updatedAt: new Date() }).where(eq(t.routineLibrary.routineId, input.routineId))
    await audit(tx, ctx.actor.id, "routine.library.withdraw", "routines", input.routineId, { slug: entry.slug, from: entry.status })
    return { routineId: input.routineId, status: "withdrawn" as const }
  })
}

/** 调用记录（所有人）：新的在前，一页 LIBRARY_CALLS_PAGE 条，cursor 是上一页最后一条的 id */
export async function listLibraryCalls(db: Db, input: { routineId: string; cursor?: number; taskId?: string }): Promise<RoutineCallsPage> {
  await requireEntry(db, input.routineId)
  const rows = await db
    .select(callColumns)
    .from(t.routineCalls)
    .innerJoin(t.tasks, eq(t.tasks.id, t.routineCalls.taskId))
    .where(
      and(
        eq(t.routineCalls.routineId, input.routineId),
        input.cursor ? lt(t.routineCalls.id, input.cursor) : undefined,
        input.taskId ? eq(t.routineCalls.taskId, input.taskId) : undefined
      )
    )
    .orderBy(desc(t.routineCalls.id))
    .limit(LIBRARY_CALLS_PAGE + 1)
  const items = rows.slice(0, LIBRARY_CALLS_PAGE).map(toCall)
  return { items, nextCursor: rows.length > LIBRARY_CALLS_PAGE ? items.at(-1)!.id : null }
}

/**
 * 任务详情「固化流程」区块（routine.get）里流程库的那两项：登记（没发布过 = null）、能发布的版本号（转过正式、比发布的新，新的在前）。
 * routine/service.ts 的 getTaskRoutine 调它
 */
export async function libraryOfRoutine(db: DbOrTx, routineId: string): Promise<Pick<RoutineSummary, "library" | "publishable">> {
  const entry = await loadEntry(db, routineId)
  const proven = await db
    .select({ version: t.routineVersions.version })
    .from(t.routineVersions)
    .where(
      and(
        eq(t.routineVersions.routineId, routineId),
        isNotNull(t.routineVersions.provenAt),
        entry ? gt(t.routineVersions.version, entry.publishedVersion) : undefined
      )
    )
    .orderBy(desc(t.routineVersions.version))
  const publishable = proven.map((row) => row.version)
  if (!entry) return { library: null, publishable }
  const toolId = routineToolId(entry.slug)
  const taskCount = entry.status === "withdrawn" ? 0 : ((await taskCounts(db, [toolId])).get(toolId) ?? 0)
  return {
    library: { slug: entry.slug, toolId, title: entry.title, publishedVersion: entry.publishedVersion, status: entry.status, taskCount },
    publishable,
  }
}

// ---------- 通知（第 7 节）：来源流程转正式、被自动停用时，runtime/stats.ts 调 ----------

/** 发布过这个库流程的人（发布记录里的，去重） */
async function publishers(db: DbOrTx, routineId: string): Promise<string[]> {
  const rows = await db
    .selectDistinct({ id: t.routineLibraryVersions.publishedById })
    .from(t.routineLibraryVersions)
    .where(and(eq(t.routineLibraryVersions.routineId, routineId), isNotNull(t.routineLibraryVersions.publishedById)))
  return rows.map((row) => row.id!)
}

/** 来源流程第 version 版转正式了：库里有它、发布的比这一版旧 → 通知发布过的主管「可以发布」 */
export async function notifyLibraryPublishable(db: Db, input: { routineId: string; version: number; taskId: string; taskTitle: string }): Promise<boolean> {
  const entry = await loadEntry(db, input.routineId)
  if (!entry || entry.status === "withdrawn" || entry.publishedVersion >= input.version) return false
  const userIds = await publishers(db, input.routineId)
  if (!userIds.length) return false
  await notifyUsers(db, {
    userIds,
    title: `流程库「${entry.title}」：第 ${input.version} 版可以发布了`,
    body: `来源任务 ${input.taskId}「${input.taskTitle}」上的第 ${input.version} 版已经转正式（连着 3 次脚本直接办成）。库里现在是第 ${entry.publishedVersion} 版，要给用它的任务换新版，到流程页「发布第 ${input.version} 版」。`,
    link: libraryLink(input.routineId),
    taskId: input.taskId,
    push: false,
  })
  return true
}

/** 来源流程被自动停用了：库里有它（没撤下）→ 通知发布过的主管，库里的多半也跑不通了（库不跟着停，有自己的计数） */
export async function notifyLibrarySourcePaused(
  db: Db,
  input: { routineId: string; version: number; taskId: string; taskTitle: string; reason: string; sessionId?: string }
): Promise<boolean> {
  const entry = await loadEntry(db, input.routineId)
  if (!entry || entry.status === "withdrawn") return false
  const userIds = await publishers(db, input.routineId)
  if (!userIds.length) return false
  const same = entry.publishedVersion === input.version
  await notifyUsers(db, {
    userIds,
    title: `流程库「${entry.title}」：来源任务上的流程自动停用了`,
    body: `来源任务 ${input.taskId}「${input.taskTitle}」上的第 ${input.version} 版连续跑不通，已经自动停用（${input.reason}）。${
      same ? `库里发布的也是第 ${entry.publishedVersion} 版，多半也跑不通了` : `库里发布的是第 ${entry.publishedVersion} 版，网站改了的话多半也跑不通`
    }：可以先在流程页停用，等来源任务上修好、转正式以后发布新版。`,
    link: libraryLink(input.routineId),
    taskId: input.taskId,
    ...(input.sessionId ? { sessionId: input.sessionId } : {}),
  })
  return true
}
