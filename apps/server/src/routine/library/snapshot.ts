// 开始运行时冻库流程（docs/dev/routine-library.md 6.2）、准备沙箱代码目录里的库流程模块（5.2、5.6）、系统提示的一节（4.2）。
// engine/sessions.ts 冻快照时调 freezeLibraryRoutines，结果放 snapshot.libraryRoutines：
// - 任务 toolIds 里的 routine.*（selected = true），取登记发布的那一版；它们 requires.routines 里调的（传递，selected = false，已经选了的不重复）；
// - 这次用不了的仍冻进来，带 unavailable：停用（「停用了：…」）、撤下、登记没了、缺要的工具（「任务没选『浏览器』」）、
//   缺开关（「任务没打开『允许直接调网站接口』」，按 missingRoutineRequires）、它调的库流程用不了（「它调的『…』用不了：…」）；
// - 调用方自己的固化脚本里 ha.routine 的流程：也要在任务里选上才在这里（同「用到的工具都在任务里」），程序检查（checks.ts）管。
// 子 agent（docs/dev/sub-agents.md）从父运行的快照抄，libraryRoutines 一起抄。
import {
  isRoutineToolId,
  libraryModulePath,
  missingRoutineRequires,
  routineBrowserFlagLabel,
  routineSlugOfToolId,
  routineToolId,
  type LibraryRoutineSnapshot,
  type RoutineRequires,
  type SessionSnapshot,
} from "@heyagent/shared"
import { and, eq, inArray } from "drizzle-orm"

import type { DbOrTx } from "../../data/config/common.js"
import * as t from "../../db/schema.js"
import { withSourceDeclared } from "./analyze.js"

const emptyRequires = (): RoutineRequires => ({ toolIds: [], browser: {}, routines: [] })

/** 冻快照：task 是任务的配置（toolIds 里有 routine.*；两个浏览器开关）。没选库流程返回空数组（快照里不写这个字段） */
export async function freezeLibraryRoutines(
  db: DbOrTx,
  task: { toolIds: readonly string[]; allowBrowserFetch: boolean; allowBrowserVision: boolean }
): Promise<LibraryRoutineSnapshot[]> {
  const selected = [...new Set(task.toolIds.filter(isRoutineToolId).map(routineSlugOfToolId).filter((slug): slug is string => Boolean(slug)))]
  if (selected.length === 0) return []

  // 按短名一层层读登记和发布的那一版（传递：它们调的库流程）
  const out = new Map<string, LibraryRoutineSnapshot>()
  let wave = selected
  while (wave.length) {
    // 在事务里：同一个连接上不能并发查询，按顺序来
    const rows = await db
      .select({ entry: t.routineLibrary, version: t.routineVersions, dispatch: t.tasks.dispatch })
      .from(t.routineLibrary)
      .leftJoin(t.routineVersions, and(eq(t.routineVersions.routineId, t.routineLibrary.routineId), eq(t.routineVersions.version, t.routineLibrary.publishedVersion)))
      .leftJoin(t.routines, eq(t.routines.id, t.routineLibrary.routineId))
      .leftJoin(t.tasks, eq(t.tasks.id, t.routines.taskId))
      .where(inArray(t.routineLibrary.slug, wave))
    const next: string[] = []
    for (const slug of wave) {
      const row = rows.find((each) => each.entry.slug === slug)
      const isSelected = selected.includes(slug)
      if (!row || !row.version) {
        // 登记没了（或者发布的那一版找不到）：冻一个空的，带原因
        out.set(slug, {
          routineId: row?.entry.routineId ?? "",
          slug,
          toolId: routineToolId(slug),
          name: row?.entry.title ?? slug,
          summary: row?.entry.summary ?? "",
          version: row?.entry.publishedVersion ?? 0,
          versionId: "",
          description: "",
          code: "",
          inputSchema: {},
          outputSchema: {},
          commits: [],
          requires: row?.entry.requires ?? emptyRequires(),
          risk: row?.entry.risk ?? "external",
          selected: isSelected,
          unavailable: row ? `发布的第 ${row.entry.publishedVersion} 版找不到了` : "流程库里没有它了",
        })
        continue
      }
      const { entry } = row
      // 输入、交回的说明：固化员没写的按来源任务（被派的）声明的补上，给模型的工具参数带着说明
      const version = withSourceDeclared(row.version, row.dispatch)
      const unavailable =
        entry.status === "paused" ? `停用了${entry.pausedReason ? `：${entry.pausedReason}` : ""}` : entry.status === "withdrawn" ? "撤下了" : undefined
      out.set(slug, {
        routineId: entry.routineId,
        slug,
        toolId: routineToolId(slug),
        name: entry.title,
        summary: entry.summary,
        version: entry.publishedVersion,
        versionId: version.id,
        description: version.description,
        code: version.code,
        inputSchema: version.inputSchema,
        outputSchema: version.outputSchema,
        commits: version.commits,
        requires: entry.requires,
        risk: entry.risk,
        selected: isSelected,
        ...(unavailable ? { unavailable } : {}),
      })
      for (const each of entry.requires.routines) if (!out.has(each) && !wave.includes(each) && !next.includes(each)) next.push(each)
    }
    wave = next
  }

  // 缺要的工具、开关（工具的中文名从工具表里取）
  const wanted = [...new Set([...out.values()].flatMap((routine) => routine.requires.toolIds))]
  const names = new Map(
    wanted.length ? (await db.select({ id: t.tools.id, name: t.tools.name }).from(t.tools).where(inArray(t.tools.id, wanted))).map((row) => [row.id, row.name]) : []
  )
  for (const routine of out.values()) {
    if (routine.unavailable) continue
    const missing = missingRoutineRequires(routine.requires, task)
    const reasons = [
      ...missing.toolIds.map((id) => `任务没选「${names.get(id) ?? id}」`),
      ...missing.browser.map((flag) => `任务没打开「${routineBrowserFlagLabel[flag]}」`),
    ]
    if (reasons.length) routine.unavailable = reasons.join("、")
  }
  // 它调的库流程用不了，它也用不了（一直传到没有变化）
  for (let changed = true; changed; ) {
    changed = false
    for (const routine of out.values()) {
      if (routine.unavailable) continue
      const bad = routine.requires.routines.map((slug) => ({ slug, dep: out.get(slug) })).find(({ dep }) => !dep || dep.unavailable)
      if (!bad) continue
      routine.unavailable = bad.dep ? `它调的「${bad.dep.name}」用不了：${bad.dep.unavailable}` : `它调的流程「${bad.slug}」不在库里`
      changed = true
    }
  }
  // 任务选了的在前（选的顺序），跟着冻进来的在后
  return [...selected.map((slug) => out.get(slug)!), ...[...out.values()].filter((routine) => !routine.selected)]
}

/**
 * 沙箱代码目录里要放的库流程模块：从 root（agent 调的那个库流程；固化脚本、code.run 是 undefined = 快照里所有用得了的）出发，
 * 按 requires.routines 传递收齐，每个一项 { path: libraryModulePath(短名), code }。用不了的不放（ha.routine 调到时工具桥报错）
 */
export function libraryModules(snapshot: Pick<SessionSnapshot, "libraryRoutines">, root?: string): { path: string; code: string }[] {
  const routines = (snapshot.libraryRoutines ?? []).filter((routine) => !routine.unavailable && routine.code)
  const bySlug = new Map(routines.map((routine) => [routine.slug, routine]))
  let chosen: string[]
  if (root === undefined) chosen = routines.map((routine) => routine.slug)
  else {
    // root 自己在 routine.mjs（agent 调的那一层），这里只放它调的
    chosen = []
    const queue = [...(bySlug.get(root)?.requires.routines ?? [])]
    while (queue.length) {
      const slug = queue.shift()!
      if (slug === root || chosen.includes(slug) || !bySlug.has(slug)) continue
      chosen.push(slug)
      queue.push(...bySlug.get(slug)!.requires.routines)
    }
  }
  return chosen.map((slug) => ({ path: libraryModulePath(slug), code: bySlug.get(slug)!.code }))
}

/** 给模型的工具名（同网关的 safeName，工具名不撞时就是它） */
const modelName = (toolId: string) => toolId.replace(/[^A-Za-z0-9_-]/g, "_")

/** 系统提示「## 固化好的流程」一节（engine/prompt.ts 调；这次没有 selected 的库流程返回 undefined） */
export function libraryPromptSection(routines: readonly LibraryRoutineSnapshot[], toolNames?: ReadonlyMap<string, string>): string | undefined {
  const selected = routines.filter((routine) => routine.selected)
  if (selected.length === 0) return undefined
  const usable = selected.filter((routine) => !routine.unavailable)
  const broken = selected.filter((routine) => routine.unavailable)
  const lines = ["## 固化好的流程"]
  if (usable.length) {
    lines.push(
      "下面这些是别的任务办成过、固化成脚本的流程。事情里有一段正好是它做的，先调它，比你一步步做快得多：",
      ...usable.map((routine) => `- ${toolNames?.get(routine.toolId) ?? modelName(routine.toolId)}「${routine.name}」：${routine.summary}`),
      "流程办成时交回的结果是它照固定步骤从页面上读到、核对过的（工具结果里有做过的步骤和依据），直接用，不要再一条条打开页面去核对；没办成或停下的，再自己处理。",
      "流程停下交回给你时，从它停下的那一页接着做；同样的输入不要马上再调一次，除非你确认是偶然的（页面没加载完）。"
    )
  }
  if (broken.length) lines.push(`这次用不了：${broken.map((routine) => `「${routine.name}」（${routine.unavailable}）`).join("；")}`)
  return lines.join("\n")
}
