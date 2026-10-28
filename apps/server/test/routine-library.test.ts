// 流程库：发布、读、改、停用、撤下（docs/dev/routine-library.md 第 2、4、6 节，12.1 的「发布」「成绩」里 B 包的部分），
// 来源流程转正式 / 自动停用时的 proven_at 和通知，工具页不列库流程、工具接口不让改它；
// 固化员（12.1「固化员」）：程序检查认 ha.routine，材料里库流程那一步是一行、里面的接口请求归到这一行，提示词有这条规矩。
// 真实的测试库；固化流程、版本、调用记录都直接写表（不起 worker、不调模型）。业务词只是中性的举例。
import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { LibraryRoutineSnapshot, NetworkRequestLine, SessionRoutineState } from "@heyagent/shared"

import * as t from "../src/db/schema.js"
import * as tools from "../src/data/config/tools.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { syncBuiltinTools } from "../src/engine/tools/builtin-defs.js"
import { analyzeLibraryCode, findLibraryCycle, libraryDepthOf, libraryDescriptionSteps, libraryRisk, routineToolDescription } from "../src/routine/library/analyze.js"
import { libraryPromptSection } from "../src/routine/library/snapshot.js"
import { stepLinesOf } from "../src/routine/runtime/handoff.js"
import { checkRoutine } from "../src/routine/checks.js"
import { buildMaterial, compactLog, librarySection, networkSection, sdkCallOf, stepRefs, toolsSection } from "../src/routine/material.js"
import { compileSystemPrompt } from "../src/routine/prompt.js"
import { settleRoutineRun } from "../src/routine/runtime/stats.js"
import { createTask } from "./engine-helpers.js"
import { login, mutate, query, setupApp, TEST_REVIEW_MODEL, type TestApp } from "./helpers.js"
import { routineCode } from "./routine-helpers.js"

let ctx: TestApp
let lin: string // 主管
let wang: string // 员工

const EXEC = "test/library-exec"

beforeAll(async () => {
  ctx = await setupApp()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  await syncBuiltinTools(ctx.db)
  await ctx.db.insert(t.models).values({ id: EXEC, providerId: "openrouter", name: "测试执行模型", contextK: 128 }).onConflictDoNothing()
  // 两个 HTTP 工具：只读的、会花钱的
  await ctx.db.insert(t.tools).values([
    { id: "http-lookup", name: "查一条", summary: "查", description: "查", source: "http", http: { method: "GET", url: "https://api.example.com/q" } as never, risk: "read" },
    { id: "http-pay", name: "付一笔", summary: "付", description: "付", source: "http", http: { method: "POST", url: "https://api.example.com/pay" } as never, risk: "money" },
  ])
}, 120_000)

afterAll(async () => {
  await ctx?.close()
})

// ---------- 造数据 ----------

let routineNo = 500

interface VersionInput {
  code: string
  proven?: boolean
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  commits?: string[]
  description?: string
  name?: string
}

/** 一个来源任务和它的固化流程（每个 versions 一版，最后一版是启用的） */
async function sourceRoutine(versions: VersionInput[], options: { status?: "trial" | "active"; title?: string } = {}) {
  const taskId = await createTask(ctx.db, { modelId: EXEC, title: options.title ?? `来源任务 ${routineNo + 1}`, ownerId: "u-wang" })
  const routineId = `RT-${++routineNo}`
  await ctx.db.insert(t.routines).values({ id: routineId, taskId, status: options.status ?? "active", activeVersion: versions.length })
  for (const [index, version] of versions.entries())
    await ctx.db.insert(t.routineVersions).values({
      id: `${routineId}-v${index + 1}`,
      routineId,
      version: index + 1,
      status: "approved",
      name: version.name ?? "查一条记录",
      description: version.description ?? "1. 打开列表\n2. 按编号查询\n3. 读出状态",
      code: version.code,
      inputSchema: version.inputSchema ?? {},
      outputSchema: version.outputSchema ?? {},
      commits: version.commits ?? [],
      provenAt: version.proven === false ? null : new Date(),
    })
  return { taskId, routineId }
}

const READ_ONLY = routineCode(`  await ha.browser.navigate({ url: "https://erp.example.com/list" })
  const { rows } = await ha.browser.extract({ list: "getByRole('row')", fields: { 状态: "getByRole('cell')" } })
  await ha.work.report({ data: { 状态: rows[0].状态 } })
  return ha.finish({ outcome: "achieved", summary: "好了", evidence: "第 1 行" })`)
const WITH_COMMIT = routineCode(`  await ha.browser.navigate({ url: "https://erp.example.com/new" })
  await ha.commit("保存")
  await ha.browser.click({ element: "保存", target: "getByRole('button', { name: '保存' })" })
  return ha.finish({ outcome: "achieved", summary: "好了", evidence: "保存了" })`)
const calls = (slug: string, body = "") => routineCode(`  const r = await ha.routine("${slug}", {})\n${body}  return ha.finish({ outcome: r.outcome, summary: r.summary, evidence: "x" })`)

const publish = (cookie: string, input: Record<string, unknown>) => mutate(ctx.app, "routineLibrary.publish", cookie, { title: "查一条记录", summary: "要查一条记录的状态时", ...input })
const preview = (input: Record<string, unknown>) => query(ctx.app, "routineLibrary.preview", lin, input)
const entryOf = async (routineId: string) => (await ctx.db.select().from(t.routineLibrary).where(eq(t.routineLibrary.routineId, routineId)))[0]
const toolRow = async (id: string) => (await ctx.db.select().from(t.tools).where(eq(t.tools.id, id)))[0]

// ---------- 纯函数 ----------

describe("分析（纯函数）", () => {
  it("要的工具：浏览器算组、ha.tool 的、组里的子工具算组；ha.file / finish / work.report / checkpoint 不算；开关和调的流程", () => {
    const code = routineCode(`  await ha.browser.navigate({ url: "https://a.example.com" })
  await ha.browser.fetch({ url: "https://a.example.com/api" })
  await ha.tool("http-lookup", { q: "1" })
  await ha.tool("browser.mouse_click_xy", { x: 1, y: 2 })
  await ha.tool("desktop.click", {})
  await ha.file.read({ fileId: "f" })
  await ha.checkpoint.mark({ title: "x" })
  await ha.work.report({ data: {} })
  const r = await ha.routine("other_one", {})
  return ha.finish({ outcome: "achieved", summary: "s", evidence: "e" })`)
    expect(analyzeLibraryCode(code)).toEqual({
      toolIds: ["browser", "http-lookup", "desktop"],
      browser: { fetch: true, vision: true },
      routines: ["other_one"],
      usesCommit: false,
      problems: [],
    })
    // copyImage 写坐标也要「允许看画面」；不写不要
    expect(analyzeLibraryCode(routineCode(`  await ha.browser.copyImage({ element: "图", x: 10, y: 20 })`)).browser).toEqual({ vision: true })
    expect(analyzeLibraryCode(routineCode(`  await ha.browser.copyImage({ element: "图", target: "getByRole('img')" })`)).browser).toEqual({})
    expect(analyzeLibraryCode(WITH_COMMIT).usesCommit).toBe(true)
    // 短名不是字面量、ha.tool 调库流程：写法不对
    const bad = analyzeLibraryCode(routineCode(`  const name = "x"\n  await ha.routine(name, {})\n  await ha.tool("routine.other_one", {})`))
    expect(bad.problems.join("\n")).toContain("ha.routine 的第一个参数要直接写流程的短名")
    expect(bad.problems.join("\n")).toContain('ha.routine("other_one", 输入)')
    expect(bad.routines).toEqual([])
  })

  it("风险：没提交、工具都只读 = read；否则取最高的（浏览器 external，调的流程按它的）", () => {
    expect(libraryRisk({ usesCommit: false, usesBrowser: true, tools: [], routines: [] })).toBe("read")
    expect(libraryRisk({ usesCommit: false, usesBrowser: false, tools: ["read"], routines: ["read"] })).toBe("read")
    expect(libraryRisk({ usesCommit: true, usesBrowser: true, tools: [], routines: [] })).toBe("external")
    expect(libraryRisk({ usesCommit: false, usesBrowser: true, tools: ["write"], routines: [] })).toBe("external")
    expect(libraryRisk({ usesCommit: true, usesBrowser: true, tools: ["money"], routines: [] })).toBe("money")
    expect(libraryRisk({ usesCommit: false, usesBrowser: false, tools: [], routines: ["write"] })).toBe("write")
    expect(libraryRisk({ usesCommit: true, usesBrowser: false, tools: ["read"], routines: [] })).toBe("read")
  })

  it("环和层数", () => {
    const edges = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", []],
      ["x", ["y"]],
      ["y", ["x"]],
    ])
    expect(findLibraryCycle(edges, "a")).toBeUndefined()
    expect(findLibraryCycle(edges, "x")).toEqual(["x", "y", "x"])
    expect(findLibraryCycle(new Map([["s", ["s"]]]), "s")).toEqual(["s", "s"])
    expect(libraryDepthOf(edges, "a")).toBe(3)
    expect(libraryDepthOf(edges, "b")).toBe(2)
    expect(libraryDepthOf(edges, "c")).toBe(1)
    expect(libraryDepthOf(new Map(), "z")).toBe(1)
  })

  it("给模型的说明：参数名换成 p<n> 时写原名，必填、交回、提交、浏览器、步骤最多 15 行", () => {
    const text = routineToolDescription({
      summary: "要查一条记录的状态时",
      description: Array.from({ length: 17 }, (_, i) => `${i + 1}. 第 ${i + 1} 步`).join("\n"),
      inputSchema: { type: "object", properties: { 编号: { type: "string", description: "记录的编号" }, limit: { type: "number" }, $note: { type: "string" } }, required: ["编号"] },
      outputSchema: { type: "object", properties: { 状态: { type: "string", description: "现在的状态" } } },
      commits: [],
      usesBrowser: true,
    })
    expect(text).toContain("固化好的流程（几秒做完")
    expect(text).toContain("什么时候用：要查一条记录的状态时")
    expect(text).toContain("- p1（编号）：记录的编号（必填）")
    expect(text).toContain("- limit")
    expect(text).toContain("- note")
    expect(text).toContain("15. 第 15 步")
    expect(text).not.toContain("16. 第 16 步")
    expect(text).toContain("……还有 2 步")
    expect(text).toContain("- 状态：现在的状态")
    expect(text).toContain("会真的提交：只读，不改东西")
    expect(text).toContain("用的是你这次运行的浏览器")
    const plain = routineToolDescription({ summary: "s", description: "", inputSchema: {}, outputSchema: {}, commits: ["保存"], usesBrowser: false })
    expect(plain).toContain("要的输入：不用输入")
    expect(plain).toContain("会真的提交：保存")
    expect(plain).not.toContain("浏览器")
  })

  it("给别的任务看的「做什么」：去掉交回、报结果的行（半行的去掉那一半），「派活的『X』」写成「输入的『X』」，重新编号", () => {
    const description = [
      "1. 打开记录搜索页 https://erp.example.com/search",
      "2. 按派活的「编号」在搜索框输入并回车",
      "3. 等搜索结果里出现编号完全一致的那一条，同时等「没有找到」和报错提示",
      "4. 读出详情页表格里的状态，交回状态",
      "5. 通过 work_report 交回状态和更新时间，并 finish 报办成",
      "6. 用 ha.finish 报没办成（查不到时）",
    ].join("\n")
    expect(libraryDescriptionSteps(description)).toEqual([
      "1. 打开记录搜索页 https://erp.example.com/search",
      "2. 按输入的「编号」在搜索框输入并回车",
      "3. 等搜索结果里出现编号完全一致的那一条，同时等「没有找到」和报错提示",
      "4. 读出详情页表格里的状态",
    ])
    const text = routineToolDescription({ summary: "s", description, inputSchema: {}, outputSchema: {}, commits: [], usesBrowser: true })
    expect(text).not.toMatch(/work_report|finish|派活|报办成|报没办成/)
    expect(text).toContain("4. 读出详情页表格里的状态\n要的输入")
    // 没编号的照样过滤，不加编号
    expect(libraryDescriptionSteps("打开列表\n交回结果\n\n读状态")).toEqual(["打开列表", "读状态"])
  })

  it("办成时的步骤行：wait_any 写等到的那一种和它的定位（看得出核对了什么）", () => {
    const rows = [
      { kind: "tool" as const, title: "navigate", detail: null, toolId: "browser.navigate", input: JSON.stringify({ url: "https://erp.example.com/a" }), output: "ok", trace: null },
      {
        kind: "tool" as const,
        title: "wait_any",
        detail: null,
        toolId: "browser.wait_any",
        input: JSON.stringify({ outcomes: { heading: "getByRole('heading', { name: '编号 A-1' })", error: "getByRole('alert')" } }),
        output: "等到了「heading」（0.3 秒）。",
        trace: null,
      },
    ]
    const lines = stepLinesOf(rows as never, (row) => rows.indexOf(row as never) + 1)
    expect(lines).toEqual([
      "1. navigate「https://erp.example.com/a」 ✓",
      "2. wait_any「heading / error」 → heading（getByRole('heading', { name: '编号 A-1' })） ✓",
    ])
  })

  it("系统提示「固化好的流程」：办成交回的结果直接用，不要再一条条打开页面核对", () => {
    const routine = { toolId: "routine.record_status", name: "查一条记录", summary: "要查一条记录时用", selected: true } as LibraryRoutineSnapshot
    const text = libraryPromptSection([routine])!
    expect(text).toContain("routine_record_status「查一条记录」：要查一条记录时用")
    expect(text).toContain("流程办成时交回的结果是它照固定步骤从页面上读到、核对过的")
    expect(text).toContain("直接用，不要再一条条打开页面去核对；没办成或停下的，再自己处理")
  })
})

// ---------- 发布 ----------

describe("发布", () => {
  it("只有主管能看能发布的、发布前看、发布", async () => {
    const { routineId } = await sourceRoutine([{ code: READ_ONLY }])
    expect((await query(ctx.app, "routineLibrary.candidates", wang)).error?.data?.code).toBe("FORBIDDEN")
    expect((await query(ctx.app, "routineLibrary.preview", wang, { routineId, version: 1, slug: "x_one" })).error?.data?.code).toBe("FORBIDDEN")
    expect((await publish(wang, { routineId, version: 1, slug: "x_one" })).error?.data?.code).toBe("FORBIDDEN")
  })

  it("没转正式的版本不让发；第一次要短名、格式要对", async () => {
    const { routineId } = await sourceRoutine([{ code: READ_ONLY, proven: false }])
    const seen = await preview({ routineId, version: 1 })
    expect(seen.data.problems.join("\n")).toContain("还没在来源任务上转正式")
    expect(seen.data.problems.join("\n")).toContain("第一次发布要填短名")
    expect((await preview({ routineId, version: 1, slug: "Bad-Name" })).data.problems.join("\n")).toContain("短名只能用英文小写字母")
    const res = await publish(lin, { routineId, version: 1, slug: "unproven_one" })
    expect(res.error?.data?.code).toBe("BAD_REQUEST")
    expect(res.error?.message).toContain("还没在来源任务上转正式")
    expect(await entryOf(routineId)).toBeUndefined()
    // 没有这一版 → NOT_FOUND
    expect((await preview({ routineId, version: 9, slug: "unproven_one" })).error?.data?.code).toBe("NOT_FOUND")
    // 能发布的里没有它（没有转过正式的版本）
    const candidates = (await query(ctx.app, "routineLibrary.candidates", lin)).data as { routineId: string }[]
    expect(candidates.some((each) => each.routineId === routineId)).toBe(false)
  })

  it("第一次发布：登记、发布记录、tools 那一行（routine.<短名>、风险、给模型的说明）、审计；短名不能和别的撞", async () => {
    const { routineId, taskId } = await sourceRoutine([
      {
        code: READ_ONLY,
        inputSchema: { type: "object", properties: { 编号: { type: "string" } }, required: ["编号"] },
        outputSchema: { type: "object", properties: { 状态: { type: "string" } } },
      },
    ])
    const candidates = (await query(ctx.app, "routineLibrary.candidates", lin)).data as { routineId: string; taskId: string; library: unknown; versions: { version: number }[] }[]
    expect(candidates.find((each) => each.routineId === routineId)).toMatchObject({ taskId, library: null, versions: [{ version: 1 }] })
    const seen = await preview({ routineId, version: 1, slug: "record_status" })
    expect(seen.data).toMatchObject({ requires: { toolIds: ["browser"], browser: {}, routines: [] }, risk: "read", problems: [], compat: [], affected: { tasks: [], routines: [] } })
    // 没登记时「什么时候用」默认是流程的名字（不是步骤说明的第一行「打开列表」）
    expect(seen.data.toolDescription).toContain("什么时候用：查一条记录\n")
    const res = await publish(lin, { routineId, version: 1, slug: "record_status" })
    expect(res.data).toEqual({ routineId, version: 1 })
    expect(await entryOf(routineId)).toMatchObject({ slug: "record_status", status: "listed", publishedVersion: 1, risk: "read", failStreak: 0, publishedById: "u-lin", title: "查一条记录" })
    const tool = await toolRow("routine.record_status")
    expect(tool).toMatchObject({ source: "routine", routineId, name: "查一条记录", summary: "要查一条记录的状态时", risk: "read" })
    expect(tool!.description).toContain("什么时候用：要查一条记录的状态时")
    expect(tool!.description).toContain("- p1（编号）（必填）")
    const versions = await ctx.db.select().from(t.routineLibraryVersions).where(eq(t.routineLibraryVersions.routineId, routineId))
    expect(versions).toMatchObject([{ version: 1, publishedById: "u-lin", risk: "read", compat: [], taskCount: 0 }])
    const audits = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.action, "routine.library.publish"), eq(t.auditEvents.targetId, routineId)))
    expect(audits[0]!.detail).toMatchObject({ slug: "record_status", version: 1, first: true })

    // 别的流程用同一个短名
    const other = await sourceRoutine([{ code: READ_ONLY }])
    expect((await preview({ routineId: other.routineId, version: 1, slug: "record_status" })).data.problems.join()).toContain("已经被「查一条记录」用了")
    expect((await publish(lin, { routineId: other.routineId, version: 1, slug: "record_status" })).error?.data?.code).toBe("BAD_REQUEST")
    // 发布后短名不能改：再发传了别的短名也不认
    await publish(lin, { routineId, version: 1, slug: "changed_name" })
    expect((await entryOf(routineId))!.slug).toBe("record_status")
    expect(await toolRow("routine.changed_name")).toBeUndefined()
  })

  it("被派的来源任务：输入、交回的说明按声明的参数、结果补上（固化员没写的），工具说明、tools 那一行、详情、快照里的工具参数都有；「什么时候用」没名字时用来源任务的标题", async () => {
    const { routineId, taskId } = await sourceRoutine(
      [
        {
          code: READ_ONLY,
          name: "",
          inputSchema: { type: "object", properties: { 编号: { type: "string" }, 备注: { type: "string", description: "固化员写的" } }, required: ["编号"] },
          outputSchema: { type: "object", properties: { 状态: { type: "string" } } },
        },
      ],
      { title: "按编号查状态" }
    )
    await ctx.db
      .update(t.tasks)
      .set({
        dispatch: {
          params: [
            { name: "编号", description: "要查的记录的编号", required: true, dedupe: true },
            { name: "备注", description: "声明里的备注", required: false, dedupe: false },
          ],
          results: [{ name: "状态", description: "详情页上的状态", required: true }],
          maxRunning: 1,
        },
      })
      .where(eq(t.tasks.id, taskId))
    const seen = await preview({ routineId, version: 1, slug: "declared_one" })
    expect(seen.data.problems).toEqual([])
    expect(seen.data.toolDescription).toContain("什么时候用：按编号查状态\n")
    expect(seen.data.toolDescription).toMatch(/- p\d（编号）：要查的记录的编号（必填）/)
    expect(seen.data.toolDescription).toMatch(/- p\d（备注）：固化员写的/)
    expect(seen.data.toolDescription).toContain("- 状态：详情页上的状态")
    expect((await publish(lin, { routineId, version: 1, slug: "declared_one", summary: "要查一条记录的状态时用" })).data).toEqual({ routineId, version: 1 })
    expect((await toolRow("routine.declared_one"))!.description).toMatch(/- p\d（编号）：要查的记录的编号（必填）/)
    // 存的那一版没改；详情的输入 / 交回表、快照用补过的
    const [stored] = await ctx.db.select().from(t.routineVersions).where(eq(t.routineVersions.routineId, routineId))
    expect(stored!.inputSchema).toEqual({ type: "object", properties: { 编号: { type: "string" }, 备注: { type: "string", description: "固化员写的" } }, required: ["编号"] })
    const detail = (await query(ctx.app, "routineLibrary.get", wang, { routineId })).data
    expect(detail.version.inputSchema.properties.编号).toEqual({ type: "string", description: "要查的记录的编号" })
    expect(detail.version.outputSchema.properties.状态).toEqual({ type: "string", description: "详情页上的状态" })
    const caller = await createTask(ctx.db, { modelId: EXEC, toolIds: ["routine.declared_one", "browser"] })
    const snapshot = await buildSnapshot(ctx.db, caller, { source: "manual", runAttachments: [] })
    const frozen = snapshot.libraryRoutines!.find((routine) => routine.slug === "declared_one")!
    expect((frozen.inputSchema.properties as Record<string, unknown>).编号).toEqual({ type: "string", description: "要查的记录的编号" })
    expect((frozen.outputSchema.properties as Record<string, unknown>).状态).toEqual({ type: "string", description: "详情页上的状态" })
  })

  it("要的工具和风险：带提交、会花钱的 HTTP 工具、只读的 HTTP 工具、直接调接口、调别的库流程（传递）", async () => {
    const committing = await sourceRoutine([{ code: WITH_COMMIT, commits: ["保存"] }])
    expect((await preview({ routineId: committing.routineId, version: 1, slug: "commit_one" })).data).toMatchObject({ risk: "external", commits: ["保存"] })
    const paying = await sourceRoutine([{ code: routineCode(`  await ha.commit("付款")\n  await ha.tool("http-pay", { amount: 1 })`) }])
    expect((await preview({ routineId: paying.routineId, version: 1, slug: "pay_one" })).data).toMatchObject({ risk: "money", requires: { toolIds: ["http-pay"] } })
    const lookup = await sourceRoutine([{ code: routineCode(`  await ha.tool("http-lookup", { q: "1" })`) }])
    expect((await preview({ routineId: lookup.routineId, version: 1, slug: "lookup_one" })).data).toMatchObject({ risk: "read", requires: { toolIds: ["http-lookup"] } })
    // 不存在的工具
    const gone = await sourceRoutine([{ code: routineCode(`  await ha.tool("http-gone", {})`) }])
    expect((await preview({ routineId: gone.routineId, version: 1, slug: "gone_one" })).data.problems.join()).toContain("http-gone 已经没有了")

    // 被调的：直接调网站接口 + 带提交
    const inner = await sourceRoutine([{ code: routineCode(`  await ha.browser.fetch({ url: "https://a.example.com/api" })\n  await ha.commit("改")\n  await ha.browser.click({ element: "x", target: "getByText('x')" })`) }])
    expect((await publish(lin, { routineId: inner.routineId, version: 1, slug: "inner_fetch" })).data).toBeTruthy()
    // 调它的：自己只用只读 HTTP 工具；要的工具、开关、风险都算上被调的
    const outer = await sourceRoutine([{ code: calls("inner_fetch", `  await ha.tool("http-lookup", {})\n`) }])
    const seen = await preview({ routineId: outer.routineId, version: 1, slug: "outer_lookup" })
    expect(seen.data.problems).toEqual([])
    expect(seen.data.requires).toEqual({ toolIds: ["http-lookup", "browser"], browser: { fetch: true }, routines: ["inner_fetch"] })
    expect(seen.data.risk).toBe("external")
    // 调的流程不在库里
    const lost = await sourceRoutine([{ code: calls("not_in_library") }])
    expect((await preview({ routineId: lost.routineId, version: 1, slug: "lost_one" })).data.problems.join()).toContain("「not_in_library」不在流程库里")
  })

  it("有环、层数超了不让发（含发布以后让调它的流程超了层数）", async () => {
    const leaf = await sourceRoutine([{ code: READ_ONLY }, { code: calls("loop_b") }, { code: calls("loop_d") }])
    await publish(lin, { routineId: leaf.routineId, version: 1, slug: "loop_a" })
    const middle = await sourceRoutine([{ code: calls("loop_a") }])
    expect((await publish(lin, { routineId: middle.routineId, version: 1, slug: "loop_b" })).data).toBeTruthy()
    // A 的第 2 版调 B，B 调 A：绕圈
    const cycle = await preview({ routineId: leaf.routineId, version: 2 })
    expect(cycle.data.problems.join()).toContain("调用绕成了圈：loop_a → loop_b → loop_a")
    // C 调 B（B 调 A）：3 层
    const top = await sourceRoutine([{ code: calls("loop_b") }])
    expect((await preview({ routineId: top.routineId, version: 1, slug: "loop_c" })).data.problems.join()).toContain("调了 3 层库流程")
    // A 的第 3 版调 D（叶子）：A 自己 2 层没问题，但调 A 的 B 变成 3 层
    const other = await sourceRoutine([{ code: READ_ONLY }])
    await publish(lin, { routineId: other.routineId, version: 1, slug: "loop_d" })
    const deeper = await preview({ routineId: leaf.routineId, version: 3 })
    expect(deeper.data.problems).toEqual([expect.stringContaining("库流程「查一条记录」（loop_b）调它，发布以后那边要 3 层")])
    // 自己调自己
    const self = await sourceRoutine([{ code: calls("self_call") }])
    expect((await preview({ routineId: self.routineId, version: 1, slug: "self_call" })).data.problems.join()).toContain("self_call → self_call")
  })

  it("新版本：列出不兼容的改动和受影响的任务、流程，没勾确认不让发；回到以前的版本", async () => {
    const v1 = {
      code: READ_ONLY,
      inputSchema: { type: "object", properties: { 编号: { type: "string" }, 备注: { type: "string" } }, required: ["编号"] },
      outputSchema: { type: "object", properties: { 状态: { type: "string" }, 时间: { type: "string" } } },
    }
    const v2 = {
      code: READ_ONLY,
      inputSchema: { type: "object", properties: { 编号: { type: "number" }, 仓库: { type: "string" } }, required: ["编号", "仓库"] },
      outputSchema: { type: "object", properties: { 时间: { type: "string" } } },
    }
    const v3 = { ...v2, code: routineCode(`  await ha.browser.fetch({ url: "https://a.example.com/api" })\n  await ha.tool("http-lookup", {})`) }
    const { routineId } = await sourceRoutine([v1, v2, v3])
    await publish(lin, { routineId, version: 1, slug: "compat_one" })
    // 一个任务选用它（选了浏览器，没选 http-lookup，没开直接调接口）；一个固化流程的脚本里调它
    const user = await createTask(ctx.db, { modelId: EXEC, title: "用它的任务", toolIds: ["routine.compat_one", "browser"] })
    const caller = await sourceRoutine([{ code: calls("compat_one") }], { title: "调它的任务" })

    const seen = await preview({ routineId, version: 2 })
    expect(seen.data.problems).toEqual([])
    expect(seen.data.compat.map((issue: { kind: string; field: string }) => `${issue.kind}:${issue.field}`).sort()).toEqual(
      ["input_added_required:仓库", "input_type_changed:编号", "input_removed:备注", "output_removed:状态"].sort()
    )
    expect(seen.data.affected.tasks).toEqual([{ taskId: user, title: "用它的任务", missing: [] }])
    expect(seen.data.affected.routines).toEqual([{ routineId: caller.routineId, taskId: caller.taskId, title: "调它的任务", version: 1 }])
    const refused = await publish(lin, { routineId, version: 2 })
    expect(refused.error?.data?.code).toBe("CONFLICT")
    expect(refused.error?.message).toContain("新加了必填的参数「仓库」")
    expect(refused.error?.message).toContain(user)
    expect((await entryOf(routineId))!.publishedVersion).toBe(1)
    expect((await publish(lin, { routineId, version: 2, acceptBreaking: true })).data).toEqual({ routineId, version: 2 })

    // 第 3 版多要了工具和开关：受影响的任务缺什么
    const third = await preview({ routineId, version: 3 })
    expect(third.data.compat.filter((issue: { kind: string }) => issue.kind === "requires_added").map((issue: { field: string }) => issue.field)).toEqual(["http-lookup", "fetch"])
    expect(third.data.affected.tasks).toEqual([{ taskId: user, title: "用它的任务", missing: ["工具「查一条」", "打开「允许直接调网站接口」"] }])

    // 回到第 1 版：同样要确认（和现在发布的第 2 版比）
    expect((await publish(lin, { routineId, version: 1 })).error?.data?.code).toBe("CONFLICT")
    expect((await publish(lin, { routineId, version: 1, acceptBreaking: true })).data).toEqual({ routineId, version: 1 })
    const detail = (await query(ctx.app, "routineLibrary.get", wang, { routineId })).data
    expect(detail.publishedVersion).toBe(1)
    expect(detail.publishes.map((row: { version: number }) => row.version)).toEqual([1, 2, 1])
    expect(detail.publishes[1]).toMatchObject({ version: 2, taskCount: 1, publishedBy: { id: "u-lin" } })
    expect(detail.publishes[1].compat.length).toBe(4)
    expect(detail.newerVersions).toEqual([3, 2])
  })
})

// ---------- 读、改、停用、撤下 ----------

describe("读、改、停用、撤下", () => {
  it("列表、详情（谁在用、成绩、最近停下的）、调用记录分页、任务详情里的「在流程库里」", async () => {
    const { routineId, taskId: sourceTaskId } = await sourceRoutine([{ code: READ_ONLY }, { code: READ_ONLY }, { code: READ_ONLY, proven: false }])
    await publish(lin, { routineId, version: 1, slug: "stats_one" })
    const first = await createTask(ctx.db, { modelId: EXEC, title: "用它的甲", toolIds: ["routine.stats_one", "browser"] })
    const second = await createTask(ctx.db, { modelId: EXEC, title: "用它的乙", toolIds: ["routine.stats_one", "browser"] })
    const callerRoutine = await sourceRoutine([{ code: calls("stats_one") }])
    await publish(lin, { routineId: callerRoutine.routineId, version: 1, slug: "stats_caller", title: "调它的流程" })

    // 调用记录：甲 55 次（办成、没办成、停下、输入不对），乙 2 次
    const sessionOf = async (taskId: string) => {
      const id = `R-lib-${taskId}`
      await ctx.db
        .insert(t.sessions)
        .values({ id, taskId, kind: "run", status: "done", modelId: EXEC, triggeredBy: "manual", startedAt: new Date(), snapshot: await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] }) })
        .onConflictDoNothing()
      return id
    }
    const base = Date.now() - 3600_000
    const rows = Array.from({ length: 55 }, (_, i) => ({
      routineId,
      version: 1,
      taskId: first,
      callId: `call-${i}`,
      via: "tool" as const,
      depth: 1,
      result: (i % 5 === 0 ? "stopped" : i % 5 === 1 ? "not_achieved" : i % 5 === 2 ? "bad_input" : "achieved") as "stopped" | "not_achieved" | "bad_input" | "achieved",
      ...(i % 5 === 0 ? { stopKind: "step_error" as const, stopStep: 3, stopReason: `找不到按钮 ${i}` } : {}),
      steps: 4,
      ms: 1000,
      at: new Date(base + i * 1000),
    }))
    const firstSession = await sessionOf(first)
    await ctx.db.insert(t.routineCalls).values(rows.map((row) => ({ ...row, sessionId: firstSession })))
    const secondSession = await sessionOf(second)
    await ctx.db.insert(t.routineCalls).values([
      { routineId, version: 1, taskId: second, sessionId: secondSession, callId: "b-1", via: "script", depth: 1, result: "achieved", steps: 3, ms: 3000, at: new Date(base + 100_000) },
      { routineId, version: 1, taskId: second, sessionId: secondSession, callId: "b-2", via: "script", depth: 1, result: "not_achieved", steps: 3, ms: 5000, at: new Date(base + 101_000) },
    ])

    const list = (await query(ctx.app, "routineLibrary.list", wang)).data as { routineId: string }[]
    expect(list.find((each) => each.routineId === routineId)).toEqual({
      routineId,
      slug: "stats_one",
      toolId: "routine.stats_one",
      title: "查一条记录",
      summary: "要查一条记录的状态时",
      status: "listed",
      publishedVersion: 1,
      taskCount: 2,
      newerVersion: 2,
      failStreak: 0,
    })

    const detail = (await query(ctx.app, "routineLibrary.get", wang, { routineId })).data
    expect(detail).toMatchObject({ slug: "stats_one", source: { taskId: sourceTaskId, ownerId: "u-wang" }, version: { version: 1 }, newerVersions: [2] })
    expect(detail.usedBy.tasks).toEqual(
      expect.arrayContaining([
        { taskId: first, title: "用它的甲", lastCall: { at: rows[54]!.at.toISOString(), result: "achieved" } },
        { taskId: second, title: "用它的乙", lastCall: { at: new Date(base + 101_000).toISOString(), result: "not_achieved" } },
      ])
    )
    expect(detail.usedBy.routines).toEqual([{ routineId: callerRoutine.routineId, slug: "stats_caller", title: "调它的流程" }])
    // 最近 50 次：乙 2 次 + 甲最近 48 次（i = 7…54）
    expect(detail.stats.calls).toBe(50)
    expect(detail.stats.achieved + detail.stats.notAchieved + detail.stats.badInput + detail.stats.stopped).toBe(50)
    expect(detail.stats.byTask.find((row: { taskId: string }) => row.taskId === second)).toMatchObject({ calls: 2, achieved: 1, notAchieved: 1, stopped: 0, avgMs: 4000 })
    expect(detail.stats.recentStops).toHaveLength(5)
    expect(detail.stats.recentStops[0]).toMatchObject({ result: "stopped", stopKind: "step_error", stopStep: 3, stopReason: "找不到按钮 50", taskTitle: "用它的甲", sessionId: firstSession })

    // 调用记录分页：新的在前，一页 50 条；按任务筛
    const page1 = (await query(ctx.app, "routineLibrary.calls", wang, { routineId })).data
    expect(page1.items).toHaveLength(50)
    expect(page1.items[0].callId).toBe("b-2")
    const page2 = (await query(ctx.app, "routineLibrary.calls", wang, { routineId, cursor: page1.nextCursor })).data
    expect(page2.items).toHaveLength(7)
    expect(page2.nextCursor).toBeNull()
    const onlySecond = (await query(ctx.app, "routineLibrary.calls", wang, { routineId, taskId: second })).data
    expect(onlySecond.items.map((row: { callId: string }) => row.callId)).toEqual(["b-2", "b-1"])

    // 任务详情「固化流程」区块
    const summary = (await query(ctx.app, "routine.get", wang, { taskId: sourceTaskId })).data
    expect(summary.library).toEqual({ slug: "stats_one", toolId: "routine.stats_one", title: "查一条记录", publishedVersion: 1, status: "listed", taskCount: 2 })
    expect(summary.publishable).toEqual([2])
    // 没发布过的：library = null，转过正式的都能发布
    const fresh = await sourceRoutine([{ code: READ_ONLY }, { code: READ_ONLY, proven: false }, { code: READ_ONLY }])
    expect((await query(ctx.app, "routine.get", wang, { taskId: fresh.taskId })).data).toMatchObject({ library: null, publishable: [3, 1] })
    expect((await query(ctx.app, "routineLibrary.get", wang, { routineId: fresh.routineId })).error?.data?.code).toBe("NOT_FOUND")
  })

  it("改名字和说明：重写 tools 那一行", async () => {
    const { routineId } = await sourceRoutine([{ code: READ_ONLY }])
    await publish(lin, { routineId, version: 1, slug: "rename_one" })
    expect((await mutate(ctx.app, "routineLibrary.update", wang, { routineId, title: "新名字", summary: "新说明" })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "routineLibrary.update", lin, { routineId, title: "新名字", summary: "要看新说明的时候" })).data).toEqual({ routineId })
    expect(await entryOf(routineId)).toMatchObject({ title: "新名字", summary: "要看新说明的时候" })
    const tool = await toolRow("routine.rename_one")
    expect(tool).toMatchObject({ name: "新名字", summary: "要看新说明的时候" })
    expect(tool!.description).toContain("什么时候用：要看新说明的时候")
  })

  it("停用 / 重新启用（清零计数）；撤下：有任务选用、别的流程调它时不让撤，撤下删 tools 那一行，能重新发布", async () => {
    const { routineId } = await sourceRoutine([{ code: READ_ONLY }])
    await publish(lin, { routineId, version: 1, slug: "pause_one" })
    expect((await mutate(ctx.app, "routineLibrary.setPaused", wang, { routineId, paused: true })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "routineLibrary.setPaused", lin, { routineId, paused: true })).data).toEqual({ routineId, status: "paused" })
    expect(await entryOf(routineId)).toMatchObject({ status: "paused", pausedReason: expect.stringContaining("停用了") })
    expect(await toolRow("routine.pause_one")).toBeTruthy()
    await ctx.db.update(t.routineLibrary).set({ failStreak: 2 }).where(eq(t.routineLibrary.routineId, routineId))
    expect((await mutate(ctx.app, "routineLibrary.setPaused", lin, { routineId, paused: false })).data).toEqual({ routineId, status: "listed" })
    expect(await entryOf(routineId)).toMatchObject({ status: "listed", pausedReason: null, failStreak: 0 })

    // 有任务选用
    const user = await createTask(ctx.db, { modelId: EXEC, title: "选了它的任务", toolIds: ["routine.pause_one"] })
    const used = await mutate(ctx.app, "routineLibrary.withdraw", lin, { routineId })
    expect(used.error?.data?.code).toBe("CONFLICT")
    expect(used.error?.message).toContain(`${user}「选了它的任务」`)
    await ctx.db.delete(t.taskTools).where(eq(t.taskTools.taskId, user))
    // 别的库流程调它
    const caller = await sourceRoutine([{ code: calls("pause_one") }])
    await publish(lin, { routineId: caller.routineId, version: 1, slug: "pause_caller", title: "调它的" })
    const called = await mutate(ctx.app, "routineLibrary.withdraw", lin, { routineId })
    expect(called.error?.data?.code).toBe("CONFLICT")
    expect(called.error?.message).toContain("「调它的」（pause_caller）在脚本里调它")
    await mutate(ctx.app, "routineLibrary.setPaused", lin, { routineId: caller.routineId, paused: true })
    expect((await mutate(ctx.app, "routineLibrary.withdraw", lin, { routineId })).error?.data?.code).toBe("CONFLICT")
    expect((await mutate(ctx.app, "routineLibrary.withdraw", lin, { routineId: caller.routineId })).data).toEqual({ routineId: caller.routineId, status: "withdrawn" })

    expect((await mutate(ctx.app, "routineLibrary.withdraw", lin, { routineId })).data).toEqual({ routineId, status: "withdrawn" })
    expect(await toolRow("routine.pause_one")).toBeUndefined()
    expect(await entryOf(routineId)).toMatchObject({ status: "withdrawn", slug: "pause_one" })
    expect((await mutate(ctx.app, "routineLibrary.setPaused", lin, { routineId, paused: false })).error?.data?.code).toBe("BAD_REQUEST")
    const listed = ((await query(ctx.app, "routineLibrary.list", lin)).data as { routineId: string; status: string; taskCount: number }[]).find((each) => each.routineId === routineId)
    expect(listed).toMatchObject({ status: "withdrawn", taskCount: 0 })
    const audits = (await ctx.db.select().from(t.auditEvents).where(eq(t.auditEvents.targetId, routineId))).map((row) => row.action)
    expect(audits).toEqual(expect.arrayContaining(["routine.library.publish", "routine.library.pause", "routine.library.resume", "routine.library.withdraw"]))

    // 重新发布：回到在库里，tools 那一行回来，短名不变
    expect((await publish(lin, { routineId, version: 1, slug: "ignored_slug" })).data).toEqual({ routineId, version: 1 })
    expect(await entryOf(routineId)).toMatchObject({ status: "listed", slug: "pause_one" })
    expect(await toolRow("routine.pause_one")).toMatchObject({ source: "routine", routineId })
  })

  it("任务保存时选库流程：照常存进 task_tools，缺它要的工具也不拦（开始运行时再判断）", async () => {
    const { routineId } = await sourceRoutine([{ code: READ_ONLY }])
    await publish(lin, { routineId, version: 1, slug: "pick_one" })
    const input = { title: "选库流程的任务", goal: "做完", steps: [], schedule: null, memoryIds: [], skillIds: [], toolIds: ["routine.pick_one"], ruleIds: [], reviewModelId: TEST_REVIEW_MODEL }
    const created = await mutate(ctx.app, "tasks.create", lin, input)
    expect(created.error).toBeUndefined()
    const links = await ctx.db.select().from(t.taskTools).where(eq(t.taskTools.taskId, created.data.id))
    expect(links.map((row) => row.refId)).toEqual(["routine.pick_one"])
    expect(((await query(ctx.app, "routineLibrary.list", wang)).data as { slug: string; taskCount: number }[]).find((each) => each.slug === "pick_one")!.taskCount).toBe(1)
  })

  it("工具页不列库流程；工具的改、删接口拦下它", async () => {
    const { routineId } = await sourceRoutine([{ code: READ_ONLY }])
    await publish(lin, { routineId, version: 1, slug: "tool_page_one" })
    const page = (await query(ctx.app, "tools.list", lin)).data as { tools: { id: string; source: string }[] }
    expect(page.tools.some((tool) => tool.source === "routine")).toBe(false)
    expect(page.tools.some((tool) => tool.id === "http-lookup")).toBe(true)
    const write = { db: ctx.db, actor: { id: "u-lin", isAdmin: true }, keyring: () => ctx.keyring }
    await expect(tools.updateHttpTool(write, { id: "routine.tool_page_one" } as never)).rejects.toThrow(tools.ROUTINE_TOOL_MESSAGE)
    await expect(tools.deleteHttpTool(write, { id: "routine.tool_page_one" })).rejects.toThrow(tools.ROUTINE_TOOL_MESSAGE)
    expect(await toolRow("routine.tool_page_one")).toBeTruthy()
  })
})

// ---------- 来源流程转正式、自动停用（runtime/stats.ts） ----------

describe("来源流程转正式、自动停用", () => {
  /** 一次跑了脚本的普通运行（结束了），然后结算 */
  async function settle(taskId: string, routineId: string, version: number, state: "finished" | "fell_back") {
    const id = `R-settle-${routineId}-${Math.random().toString(36).slice(2, 8)}`
    const routine: SessionRoutineState = {
      routineId,
      versionId: `${routineId}-v${version}`,
      version,
      mode: "run",
      state,
      startedAt: new Date().toISOString(),
      steps: 3,
      commits: [],
      ...(state === "fell_back" ? { stoppedAt: { step: 3, kind: "step_error" as const, tool: "browser.click", label: "查询", reason: "找不到查询按钮" } } : {}),
    }
    await ctx.db.insert(t.sessions).values({
      id,
      taskId,
      kind: "run",
      status: "done",
      modelId: EXEC,
      triggeredBy: "manual",
      startedAt: new Date(Date.now() - 1000),
      endedAt: new Date(),
      snapshot: await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] }),
      outcome: state === "finished" ? "achieved" : "not_achieved",
      routine,
    })
    await settleRoutineRun(ctx.db, id)
  }
  const notesOf = async (title: string) => (await ctx.db.select().from(t.notifications).where(eq(t.notifications.userId, "u-lin"))).filter((note) => note.title.includes(title))

  it("转正式记下 proven_at；库里有它、发布的比这一版旧 → 通知发布过的主管「可以发布」", async () => {
    const { routineId, taskId } = await sourceRoutine([{ code: READ_ONLY }, { code: READ_ONLY, proven: false }], { status: "trial" })
    await publish(lin, { routineId, version: 1, slug: "promote_one", title: "转正式的流程" })
    await ctx.db.update(t.routines).set({ directStreak: 2 }).where(eq(t.routines.id, routineId))
    await settle(taskId, routineId, 2, "finished")
    const [v2] = await ctx.db.select().from(t.routineVersions).where(eq(t.routineVersions.id, `${routineId}-v2`))
    expect(v2!.provenAt).toBeInstanceOf(Date)
    const notes = await notesOf("流程库「转正式的流程」：第 2 版可以发布了")
    expect(notes).toHaveLength(1)
    expect(notes[0]!.link).toBe(`#/routines?id=${routineId}`)
    expect((await query(ctx.app, "routine.get", wang, { taskId })).data.publishable).toEqual([2])
  })

  it("没在库里的流程转正式只记 proven_at，不通知流程库", async () => {
    const { routineId, taskId } = await sourceRoutine([{ code: READ_ONLY, proven: false }], { status: "trial", title: "没在库里" })
    await ctx.db.update(t.routines).set({ directStreak: 2 }).where(eq(t.routines.id, routineId))
    await settle(taskId, routineId, 1, "finished")
    const [v1] = await ctx.db.select().from(t.routineVersions).where(eq(t.routineVersions.id, `${routineId}-v1`))
    expect(v1!.provenAt).toBeInstanceOf(Date)
    expect((await query(ctx.app, "routineLibrary.candidates", lin)).data.some((each: { routineId: string }) => each.routineId === routineId)).toBe(true)
  })

  it("来源流程被自动停用 → 通知发布过的主管，库里的不跟着停", async () => {
    const { routineId, taskId } = await sourceRoutine([{ code: READ_ONLY }])
    await publish(lin, { routineId, version: 1, slug: "source_paused", title: "来源停了的流程" })
    await ctx.db.update(t.routines).set({ fallbackStreak: 2 }).where(eq(t.routines.id, routineId))
    await settle(taskId, routineId, 1, "fell_back")
    expect((await ctx.db.select().from(t.routines).where(eq(t.routines.id, routineId)))[0]!.status).toBe("paused")
    const notes = await notesOf("流程库「来源停了的流程」：来源任务上的流程自动停用了")
    expect(notes).toHaveLength(1)
    expect(notes[0]!.body).toContain("库里发布的也是第 1 版，多半也跑不通了")
    expect(notes[0]!.body).toContain("找不到查询按钮")
    expect((await entryOf(routineId))!.status).toBe("listed")
  })
})

// ---------- 固化员（程序检查、材料、提示词） ----------

describe("固化员", () => {
  const SNAP: LibraryRoutineSnapshot = {
    routineId: "RT-77",
    slug: "record_status",
    toolId: "routine.record_status",
    name: "查一条记录",
    summary: "要查一条记录的状态时",
    version: 3,
    versionId: "RT-77-v3",
    description: "1. 打开列表\n2. 按编号查询",
    code: READ_ONLY,
    inputSchema: { type: "object", properties: { 编号: { type: "string" } }, required: ["编号"] },
    outputSchema: { type: "object", properties: { 状态: { type: "string" } } },
    commits: [],
    requires: { toolIds: ["browser"], browser: {}, routines: [] },
    risk: "read",
    selected: true,
  }
  const SCHEMA = '{"type":"object","properties":{}}'

  it("程序检查：ha.routine 要写死短名、任务要选了它；ha.tool 不能调库流程；RoutineFailed 能用", () => {
    const check = (body: string, toolIds: string[]) => checkRoutine({ code: routineCode(body), inputSchema: SCHEMA, outputSchema: SCHEMA, toolIds: ["run.finish", ...toolIds] })
    const ok = check(
      `  try {\n    const r = await ha.routine("record_status", { 编号: "1" })\n    return ha.finish({ outcome: r.outcome, summary: r.summary, evidence: "x" })\n  } catch (error) {\n    if (error instanceof ha.RoutineFailed) return ha.fail("page", error.message)\n    throw error\n  }`,
      ["routine.record_status"]
    )
    expect(ok.problems).toEqual([])
    expect(ok.usedTools).toContain("routine.record_status")
    expect(check(`  await ha.routine("record_status", {})`, []).problems).toEqual([
      'ha.routine("record_status")：任务没选流程「routine.record_status」（流程库里的流程要在任务里选上才能调）',
    ])
    expect(check(`  const slug = "record_status"\n  await ha.routine(slug, {})`, ["routine.record_status"]).problems.join()).toContain("ha.routine 的第一个参数要直接写流程的短名")
    expect(check(`  await ha.tool("routine.record_status", {})`, ["routine.record_status"]).problems.join()).toContain('流程库里的流程用 ha.routine("record_status", 输入) 调')
    // 模板字符串（没有插值）也算写死
    expect(check("  await ha.routine(`record_status`, {})", ["routine.record_status"]).problems).toEqual([])
  })

  type Event = Parameters<typeof compactLog>[0][number]
  const T0 = Date.parse("2026-10-28T02:00:00.000Z")
  const ev = (seq: number, patch: Partial<Event>): Event => ({
    sessionId: "R-x",
    seq,
    at: new Date(T0 + seq * 1000),
    kind: "tool",
    title: patch.toolId ?? "工具",
    detail: null,
    toolId: null,
    input: "{}",
    output: "好了",
    ms: 10,
    tokensIn: null,
    tokensOut: null,
    trace: null,
    ...patch,
  })
  const lib = (step: number, callId: string, depth = 1) => ({ routineId: "RT-77", version: 3, step, callId, depth })
  /** agent 调了一次（里面 3 步在前，工具那一行做完才记）、自己点了一下、脚本里 ha.routine 又调了一次（里面 2 步在后） */
  const EVENTS: Event[] = [
    ev(1, { toolId: "browser.navigate", input: '{"url":"https://erp.example.com/list"}', trace: { library: lib(1, "call-a") } }),
    ev(2, { toolId: "browser.type", input: '{"text":"A-100"}', trace: { library: lib(2, "call-a"), network: { first: 2, last: 3 } } }),
    ev(3, { toolId: "browser.extract", trace: { library: lib(3, "call-a") } }),
    ev(4, { toolId: "routine.record_status", input: '{"p1":"A-100"}', output: '{"outcome":"achieved","data":{"状态":"已完成"}}' }),
    ev(5, { toolId: "browser.click", input: '{"element":"详情"}', trace: { network: { first: 4, last: 4 } } }),
    ev(6, { toolId: "routine.record_status", input: '{"编号":"A-100"}', trace: { routineStep: 1 } }),
    ev(7, { toolId: "browser.navigate", trace: { routineStep: 2, library: lib(1, "call-b") } }),
    ev(8, { toolId: "browser.extract", trace: { routineStep: 3, library: lib(2, "call-b") } }),
  ]
  const VALUES = [{ label: "input.编号", value: "A-100" }]

  it("材料：库流程那一次是一行（里面的步骤不展开，写脚本里怎么调、参数名对应），里面发的接口归到这一行", () => {
    const numbering = new Map<number, number>()
    const blocks = compactLog(EVENTS, VALUES, [], numbering, [SNAP])
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toContain("#1 routine.record_status ✓（流程库里的流程「查一条记录」第 3 版：一次调用跑完，里面 3 步不展开）")
    expect(blocks[0]).toContain("输入在这里：p1 = input.编号")
    expect(blocks[0]).toContain('脚本里这样调：await ha.routine("record_status", { 编号: … })；agent 调时的参数名对应：p1 = 编号')
    expect(blocks[1]).toContain("#2 browser.click ✓")
    expect(blocks[2]).toContain("#3 routine.record_status ✓（流程库里的流程「查一条记录」第 3 版：一次调用跑完，里面 2 步不展开）（固化脚本做的，第 1 次调用）")
    expect(blocks[2]).not.toContain("参数名对应")
    expect(blocks.join("\n")).not.toContain("browser.navigate")
    // 里面的步骤的序号记成调它的那一行
    expect([...numbering.entries()].sort(([a], [b]) => a - b)).toEqual([
      [1, 1],
      [2, 1],
      [3, 1],
      [4, 1],
      [5, 2],
      [6, 3],
      [7, 3],
      [8, 3],
    ])
    const stepOf = stepRefs(EVENTS, numbering, new Map([["RT-77", "查一条记录"]]))
    const request = (seq: number): NetworkRequestLine => ({
      seq,
      at: new Date(T0 + 2500).toISOString(),
      type: "fetch",
      method: "GET",
      url: `https://erp.example.com/api/list?no=A-100&s=${seq}`,
      page: "https://erp.example.com/list",
      headers: [],
      auth: { cookie: true, headers: [] },
      status: 200,
      ms: 5,
    })
    expect(stepOf(request(2))).toBe("#1（在流程「查一条记录」里发的，browser.type）")
    expect(stepOf(request(4))).toBe("#2 browser.click")
    const section = networkSection({ requests: [request(2), request(3)] }, VALUES, stepOf)
    expect(section).toContain("在哪一步：#1（在流程「查一条记录」里发的，browser.type）")
  })

  it("材料：任务里的工具（库流程写 ha.routine，里面的步骤不算用过的子工具）、「任务选的库流程」一节", () => {
    expect(sdkCallOf("routine.record_status")).toContain('ha.routine("record_status", { … })')
    const outside = EVENTS.filter((event) => !event.trace?.library)
    const section = toolsSection(
      [
        { id: "browser", name: "浏览器", risk: "external", summary: "" },
        { id: "routine.record_status", name: "查一条记录", risk: "read", summary: "要查一条记录的状态时" },
      ],
      outside
    )
    expect(section).toContain('- routine.record_status：查一条记录（风险 read） 要查一条记录的状态时 → ha.routine("record_status"')
    expect(section).toContain("browser.click（1 次）")
    expect(section).not.toContain("browser.navigate")
    const library = librarySection([SNAP, { ...SNAP, slug: "only_called", toolId: "routine.only_called", selected: false }])
    expect(library).toContain("## 任务选的库流程（脚本里用 ha.routine 调）")
    expect(library).toContain('const r = await ha.routine("record_status", { 编号: … })')
    expect(library).toContain("输入：编号（必填）；交回 r.data：状态")
    expect(library).toContain("只读，不改东西")
    expect(library).not.toContain("only_called")
    expect(librarySection([])).toBe("")
  })

  it("拼材料：快照里有库流程时带上那一节、library = true；过程里库流程那一行不展开", async () => {
    const taskId = await createTask(ctx.db, { modelId: EXEC, title: "调库流程的任务", toolIds: ["browser"] })
    const snapshot = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })
    snapshot.libraryRoutines = [SNAP]
    snapshot.tools.push({ id: "routine.record_status", name: "查一条记录", summary: "要查一条记录的状态时", description: "", source: "routine", risk: "read", routineId: "RT-77" })
    const sessionId = `R-lib-material-${taskId}`
    await ctx.db.insert(t.sessions).values({ id: sessionId, taskId, kind: "run", status: "done", modelId: EXEC, triggeredBy: "manual", startedAt: new Date(), endedAt: new Date(), snapshot, outcome: "achieved" })
    await ctx.db.insert(t.sessionEvents).values(EVENTS.map((event) => ({ ...event, sessionId })))
    const [routine] = await ctx.db.insert(t.routines).values({ id: `RT-lm-${taskId}`, taskId }).returning()
    const material = await buildMaterial(ctx.db, { sourceSessionId: sessionId, routineId: routine!.id })
    expect(material.library).toBe(true)
    expect(material.toolIds).toContain("routine.record_status")
    expect(material.text).toContain("## 任务选的库流程（脚本里用 ha.routine 调）")
    expect(material.text).toContain("里面 3 步不展开")
    expect(material.text).not.toContain("browser.navigate")
    // 没选、也没调过库流程的：false
    const plainTask = await createTask(ctx.db, { modelId: EXEC, title: "普通任务", toolIds: ["browser"] })
    const plainSession = `R-lib-plain-${plainTask}`
    await ctx.db.insert(t.sessions).values({
      id: plainSession,
      taskId: plainTask,
      kind: "run",
      status: "done",
      modelId: EXEC,
      triggeredBy: "manual",
      startedAt: new Date(),
      endedAt: new Date(),
      snapshot: await buildSnapshot(ctx.db, plainTask, { source: "manual", runAttachments: [] }),
      outcome: "achieved",
    })
    const [plainRoutine] = await ctx.db.insert(t.routines).values({ id: `RT-lm-${plainTask}`, taskId: plainTask }).returning()
    const plain = await buildMaterial(ctx.db, { sourceSessionId: plainSession, routineId: plainRoutine!.id })
    expect(plain.library).toBe(false)
    expect(plain.text).not.toContain("任务选的库流程")
  })

  it("提示词：evidence 要写出核对了什么；description 不写交回、报结果，不写「派活的…」", () => {
    const text = compileSystemPrompt("SDK")
    expect(text).toContain("evidence 写依据：写出核对了什么、在哪看到的")
    expect(text).toContain("不能只写「查到了」")
    expect(text).toContain("交回结果、报办成（ha.work.report、ha.finish）不算一步，不写")
  })

  it("提示词：有库流程才加「用 ha.routine 调同一个」那一条，编号接在最后", () => {
    const plain = compileSystemPrompt("SDK")
    expect(plain).not.toContain("过程里调了流程库里的流程")
    const library = compileSystemPrompt("SDK", { library: true })
    expect(library).toContain('19. 过程里调了流程库里的流程的（标「流程库里的流程」的那一行，工具 routine.<短名>），脚本里用 await ha.routine("短名", 输入) 调同一个')
    expect(library).toContain("不要把它里面的步骤、它发的接口请求")
    const both = compileSystemPrompt("SDK", { library: true, siteApi: true })
    expect(both).toContain("25. 过程里调了流程库里的流程的")
    expect(both.indexOf("24. 用 token 认证的接口")).toBeLessThan(both.indexOf("25. 过程里调了流程库里的流程的"))
  })
})
