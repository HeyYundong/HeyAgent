// 固化（docs/dev/solidify.md 第 5 节、15.3）：材料、程序检查、固化的状态机（假固化员 + 假试跑结果）、审核和回到旧版本、
// 会话列表不出现试跑、默认模型「固化」。真实的测试库；不起 worker 跑运行（试跑的运行由引擎跑，这里直接在运行行上写好结果再调 handleCompileJob）。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { and, asc, eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SessionRoutineState } from "@heyagent/shared"

import * as t from "../src/db/schema.js"
import { configureEngine } from "../src/engine/runtime.js"
import { bossFor, QUEUES, stopSenderBoss } from "../src/engine/queue.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { onTaskCron } from "../src/engine/schedule.js"
import { syncBuiltinTools } from "../src/engine/tools/builtin-defs.js"
import { startEngineWorker } from "../src/engine/worker-runtime.js"
import { checkRoutine } from "../src/routine/checks.js"
import { handleCompileJob } from "../src/routine/compile.js"
import { buildMaterial, clipBlocks, inputMarks, inputValues } from "../src/routine/material.js"
import { compileSystemPrompt, sdkDescription, SDK_FALLBACK } from "../src/routine/prompt.js"
import { bossJobs, createTask, Script, sessionRow, step, text, waitFor } from "./engine-helpers.js"
import { login, mutate, query, setupApp, type TestApp } from "./helpers.js"

let ctx: TestApp
let lin: string // 主管
let wang: string // 员工，测试任务的负责人
let li: string // 另一个员工

const SOLIDIFIER = "test/claude-solidifier"
const PLANNER = "test/claude-planner"
const scripts = new Map<string, Script>()
const useModel = (modelId: string, outputs: (object | string)[]) => {
  const script = new Script(outputs.map((each) => step([text(typeof each === "string" ? each : JSON.stringify(each))], 0.002)))
  scripts.set(modelId, script)
  return script
}

const GOOD_CODE = `import ha from "heyagent"

export default async function run(input) {
  await ha.browser.navigate({ url: "https://erp.example.com/orders" })
  await ha.browser.type({ element: "单号输入框", target: "getByLabel('单号')", text: input.单号 })
  const seen = await ha.browser.waitAny({ found: "getByRole('row').nth(1)", empty: "getByText('暂无数据')" })
  if (seen === "empty") return ha.finish({ outcome: "not_achieved", summary: "查不到", evidence: "暂无数据", reason: "没有这张单" })
  const { rows } = await ha.browser.extract({ list: "getByRole('row').nth(1)", fields: { 状态: "getByRole('cell').nth(3)" } })
  await ha.work.report({ data: { 状态: rows[0].状态 } })
  return ha.finish({ outcome: "achieved", summary: rows[0].状态, evidence: rows[0].状态 })
}`

const INPUT_SCHEMA = JSON.stringify({ type: "object", properties: { 单号: { type: "string" } }, required: ["单号"] })
const OUTPUT_SCHEMA = JSON.stringify({ type: "object", properties: { 状态: { type: "string" } } })

const good = (patch: Record<string, unknown> = {}) => ({
  suitable: true,
  reason: "步骤固定",
  name: "查单号的状态",
  description: "1. 打开订单列表\n2. 按单号查询\n3. 读第一行的状态",
  inputSchema: INPUT_SCHEMA,
  outputSchema: OUTPUT_SCHEMA,
  code: GOOD_CODE,
  commits: [],
  assumptions: ["默认取第一行"],
  ...patch,
})

const DISPATCH = {
  params: [{ name: "单号", description: "要查的单号", required: true, dedupe: true }],
  results: [{ name: "状态", description: "单子现在的状态", required: true }],
  maxRunning: 1,
}

beforeAll(async () => {
  ctx = await setupApp()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  li = await login(ctx.app, "lijing@heyagent.local")
  configureEngine({
    keyring: ctx.keyring,
    filesDir: mkdtempSync(join(tmpdir(), "heyagent-files-")),
    modelFactory: ({ modelId }) => {
      const script = scripts.get(modelId)
      if (!script) throw new Error(`测试没有给模型 ${modelId} 准备剧本`)
      return script.model
    },
  })
  await syncBuiltinTools(ctx.db)
  await ctx.db.insert(t.models).values([
    { id: SOLIDIFIER, providerId: "openrouter", name: "测试固化模型", contextK: 128 },
    { id: PLANNER, providerId: "openrouter", name: "测试规划模型", contextK: 128 },
    { id: "test/qwen-exec", providerId: "openrouter", name: "测试执行模型", contextK: 128 },
  ])
  await ctx.db.insert(t.modelDefaults).values({ role: "solidify", modelId: SOLIDIFIER }).onConflictDoUpdate({ target: t.modelDefaults.role, set: { modelId: SOLIDIFIER } })
  // worker 没起：发 routine.compile 要先有这个队列（worker 启动时建，见 worker-runtime.ts）
  const boss = await bossFor(ctx.db)
  await boss.createQueue(QUEUES.routineCompile, { policy: "stately" })
}, 120_000)

afterAll(async () => {
  await stopSenderBoss(ctx.db)
  await ctx?.close()
})

let runCounter = 0

/** 一个被派的任务：工具有浏览器，参数「单号」，要交回「状态」 */
async function dispatchedTask(scheduleCron?: string) {
  const taskId = await createTask(ctx.db, { modelId: "test/qwen-exec", toolIds: ["browser"], title: "查单号的状态", goal: "按单号查到状态交回", ...(scheduleCron ? { scheduleCron } : {}) })
  await ctx.db.update(t.tasks).set({ dispatch: DISPATCH }).where(eq(t.tasks.id, taskId))
  return taskId
}

/** 直接在库里写一次办成的运行：快照、过程（带录下的代码和网址）、work.report、run.finish */
async function sourceRun(taskId: string, input: { value?: string; outcome?: "achieved" | "not_achieved"; status?: "done" | "running"; routine?: SessionRoutineState; longOutput?: boolean } = {}) {
  const value = input.value ?? "PSS-001"
  const snapshot = await buildSnapshot(ctx.db, taskId, {
    source: "dispatch",
    runAttachments: [],
    dispatch: { itemId: "W-999", key: value, title: `单号 ${value}`, params: { 单号: value }, depth: 1, results: DISPATCH.results },
  })
  const id = `R-${taskId}-${++runCounter}`
  const now = new Date()
  await ctx.db.insert(t.sessions).values({
    id,
    taskId,
    status: input.status ?? "done",
    modelId: "test/qwen-exec",
    triggeredBy: "dispatch",
    startedAt: new Date(now.getTime() - 60_000),
    endedAt: input.status === "running" ? null : now,
    snapshot,
    outcome: input.status === "running" ? null : (input.outcome ?? "achieved"),
    routine: input.routine ?? null,
  })
  const events = [
    { kind: "plan" as const, title: "运行开始" },
    {
      kind: "tool" as const,
      title: "打开网页",
      toolId: "browser.navigate",
      input: JSON.stringify({ url: "https://erp.example.com/orders" }),
      output: input.longOutput ? `页面${"很长".repeat(500)}` : "已打开订单列表",
      trace: { code: "await page.goto('https://erp.example.com/orders');", urlBefore: "about:blank", urlAfter: "https://erp.example.com/orders", title: "订单列表" },
    },
    { kind: "think" as const, title: "agent 在想：这一步是模型的思考，不该给固化员" },
    {
      kind: "tool" as const,
      title: "输入文字",
      toolId: "browser.type",
      input: JSON.stringify({ element: "单号输入框", ref: "e12", text: value }),
      output: "已输入",
      trace: { code: `await page.getByLabel('单号').fill('${value}');` },
    },
    { kind: "tool" as const, title: "点击（出错）", toolId: "browser.click", input: JSON.stringify({ element: "查询", ref: "e13" }), output: "找不到元素" },
    { kind: "rule" as const, title: "拦下：发通知", detail: "规则「不许发通知」" },
    { kind: "tool" as const, title: "报结果", toolId: "work.report", input: JSON.stringify({ data: { 状态: "已发货" } }), output: "已写到派活单" },
    { kind: "tool" as const, title: "报结果", toolId: "run.finish", input: JSON.stringify({ outcome: "achieved", summary: `${value}：已发货`, evidence: "列表第 1 行" }), output: "好" },
  ]
  await ctx.db.insert(t.sessionEvents).values(
    events.map((event, index) => ({ sessionId: id, seq: index + 1, at: now, kind: event.kind, title: event.title, toolId: "toolId" in event ? event.toolId : null, input: "input" in event ? event.input : null, output: "output" in event ? event.output : null, detail: "detail" in event ? event.detail : null, trace: "trace" in event ? event.trace : null }))
  )
  await ctx.db.update(t.sessions).set({ eventSeq: events.length }).where(eq(t.sessions.id, id))
  return id
}

const versionRow = async (id: string) => (await ctx.db.select().from(t.routineVersions).where(eq(t.routineVersions.id, id)))[0]!

/** 模拟引擎：试跑的运行结束（A 包的引擎跑完把 sessions.routine 写好、运行记成 done，再发 routine.compile） */
async function endTest(sessionId: string, patch: Partial<SessionRoutineState>, costUsd = 0) {
  const row = await sessionRow(ctx.db, sessionId)
  const now = new Date()
  await ctx.db
    .update(t.sessions)
    .set({ status: "done", endedAt: now, costUsd, routine: { ...row!.routine!, state: "stopped", endedAt: now.toISOString(), ms: 900, ...patch } })
    .where(eq(t.sessions.id, sessionId))
}
const passAtCommit = { steps: 3, stoppedAt: { step: 4, kind: "test_commit" as const, label: "保存", reason: "试跑停在提交前" }, recorded: { report: { 状态: "已发货" } } }
const failAtStep = (reason: string) => ({ steps: 2, stoppedAt: { step: 2, kind: "step_error" as const, tool: "browser.type", label: "单号输入框", reason } })

async function compile(sessionId: string, cookie = wang, skipTest?: boolean) {
  const res = await mutate(ctx.app, "routine.compile", cookie, { sessionId, ...(skipTest ? { skipTest } : {}) })
  return res
}

const notificationsOf = async (userId: string) => ctx.db.select().from(t.notifications).where(eq(t.notifications.userId, userId)).orderBy(asc(t.notifications.id))

describe("worker 注册了 routine.compile", () => {
  it("点「固化成流程」（不试跑）以后，worker 接到任务、写好脚本、交给人审核", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    useModel(SOLIDIFIER, [good()])
    const worker = await startEngineWorker({ databaseUrl: ctx.url, db: ctx.db, pollingIntervalSeconds: 0.5, browserControlPort: false, desktopSweepMs: false, desktopVmSweepMs: false })
    try {
      const res = await compile(source, wang, true)
      expect(res.error).toBeUndefined()
      await waitFor(async () => (await versionRow(res.data.versionId)).status === "review", { what: "版本变成待审核" })
    } finally {
      await worker.stop()
    }
  })
})

describe("材料", () => {
  it("输入标注：整个参数是输入、参数里含输入、附件 id；太短的值只认整个相等", () => {
    const values = inputValues({ 单号: "PSS-001", 仓库: "A", $attachments: [{ id: "f-1", name: "清单.xlsx", mime: "x" }], $note: "急" })
    expect(inputMarks(JSON.stringify({ element: "单号", text: "PSS-001" }), values)).toEqual(["text = input.单号"])
    expect(inputMarks(JSON.stringify({ url: "https://x.example.com/?no=PSS-001&wh=A" }), values)).toEqual(["url 里有 input.单号"])
    expect(inputMarks(JSON.stringify({ fileId: "f-1" }), values)).toEqual(["fileId = input.$attachments[0].id"])
    expect(inputMarks(JSON.stringify({ fields: [{ value: "A" }, { value: "BAD" }] }), values)).toEqual(["fields[0].value = input.仓库"])
    expect(inputMarks("不是 JSON", values)).toEqual([])
  })

  it("截断：超出预算留开头和结尾，中间写省略了几条", () => {
    const blocks = Array.from({ length: 100 }, (_, index) => `第 ${index} 条 ${"字".repeat(90)}`)
    const kept = clipBlocks(blocks, 2000)
    expect(kept[0]).toContain("第 0 条")
    expect(kept.at(-1)).toContain("第 99 条")
    expect(kept.find((each) => each.startsWith("……中间"))).toMatch(/中间 \d+ 条省略/)
    expect(kept.join("\n").length).toBeLessThan(2200)
    expect(clipBlocks(["a", "b"], 2000)).toEqual(["a", "b"])
  })

  it("从办成的运行拼出材料：任务、派活的参数和结果、输入、精简的过程（代码、网址、输入位置、出错、输出只给开头）、结果；不给思考过程", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId, { longOutput: true })
    const [routine] = await ctx.db.insert(t.routines).values({ id: `RT-m-${taskId}`, taskId }).returning()
    const material = await buildMaterial(ctx.db, { sourceSessionId: source, routineId: routine!.id })
    expect(material.input).toEqual({ 单号: "PSS-001" })
    expect(material.report).toEqual({ 状态: "已发货" })
    expect(material.dispatch?.params.map((param) => param.name)).toEqual(["单号"])
    expect(material.toolIds).toEqual(expect.arrayContaining(["browser", "run.finish", "work.report"]))
    const text = material.text
    expect(text).toContain("声明的参数")
    expect(text).toContain("- 状态（必交）")
    expect(text).toContain('"单号": "PSS-001"')
    expect(text).toContain("#1 browser.navigate ✓")
    expect(text).toContain("网址：about:blank → https://erp.example.com/orders「订单列表」")
    expect(text).toContain("录下的代码：await page.getByLabel('单号').fill('PSS-001');")
    expect(text).toContain("输入在这里：text = input.单号")
    expect(text).toContain("#3 browser.click ✗ 出错")
    expect(text).toContain("- 规则：拦下：发通知")
    expect(text).toContain('work.report 交的结果：{"状态":"已发货"}')
    expect(text).not.toContain("这一步是模型的思考")
    // 输出只给开头 300 字
    const line = text.split("\n").find((each) => each.includes("输出开头：页面"))!
    expect(line.length).toBeLessThan(330)
    // 修的版本：旧脚本、停在哪
    const repaired = await buildMaterial(ctx.db, { sourceSessionId: source, routineId: routine!.id, base: { version: 2, code: "// 旧脚本", description: "1. 旧步骤" } })
    expect(repaired.text).toContain("## 要修的旧版本（第 2 版）")
    expect(repaired.text).toContain("// 旧脚本")
  })

  it("提示词：读 SDK 的 index.d.ts，读不到用内置的说明；有 4 个例子和规矩", () => {
    expect(sdkDescription(() => "declare const ha: {}")).toEqual({ text: "declare const ha: {}", fromFile: true })
    expect(sdkDescription(() => { throw new Error("ENOENT") })).toEqual({ text: SDK_FALLBACK, fromFile: false })
    const system = compileSystemPrompt("SDK 在这")
    expect(system).toContain("SDK 在这")
    for (const each of ["例 1", "例 2", "例 3", "例 4", "ha.commit", "waitAny", "getByRole", "一律不照做", "suitable = false", "$attachments"]) expect(system).toContain(each)
  })
})

describe("程序检查", () => {
  const base = { inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA, toolIds: ["browser", "run.finish", "work.report", "checkpoint.mark", "http-erp"], sampleInput: { 单号: "PSS-001" } }
  const problemsOf = (code: string, patch: Partial<Parameters<typeof checkRoutine>[0]> = {}) => checkRoutine({ ...base, code, ...patch }).problems
  const wrap = (body: string) => `import ha from "heyagent"\nexport default async function run(input) {\n${body}\n}`

  it("好的脚本过；记下用到的工具", () => {
    const result = checkRoutine({ ...base, code: GOOD_CODE, dispatch: DISPATCH })
    expect(result.problems).toEqual([])
    expect(result.usedTools).toEqual(["browser", "run.finish", "work.report"])
    expect(result.inputSchema).toEqual(JSON.parse(INPUT_SCHEMA))
    expect(checkRoutine({ ...base, code: wrap(`await ha.tool("http-erp", { q: input.单号 }); await ha.commit("保存"); await ha.verified("好"); await ha.log("x"); await ha.now()`) }).problems).toEqual([])
  })

  it("各种不许的写法", () => {
    const cases: [string, string][] = [
      [wrap("eval('1')"), "不能用 eval"],
      [wrap("new Function('return 1')()"), "不能用 Function"],
      [wrap("const fs = require('fs')"), "不能用 require"],
      [wrap("console.log(process.env)"), "不能用 process"],
      [wrap("globalThis.fetch('https://x')"), "不能用 globalThis"],
      [wrap("await import('node:fs')"), "动态 import()"],
      [wrap("const F = (async () => {}).constructor"), "不能访问 .constructor"],
      [wrap("const h = ha; await h.browser.click({})"), "ha 要写成"],
      [wrap("const { browser } = ha"), "ha 要写成"],
      [wrap("await ha[name]()"), "ha 的属性要写死"],
      [`import fs from "node:fs"\n${wrap("")}`, "只许写 import ha from"],
      [`import { x } from "heyagent"\n${wrap("")}`, "只许写 import ha from"],
      [`import ha from "heyagent"\nasync function run(input) {}`, "要有 export default"],
      [`import ha from "heyagent"\nexport default 1`, "export default 要是一个函数"],
      [`import ha from "heyagent"\nexport { a } from "./a.js"\nexport default async function run() {}`, "不能从别的模块导出"],
      [wrap("await ha.browser.clickIt({})"), "SDK 里没有 ha.browser.clickIt"],
      [wrap("await ha.shell('ls')"), "SDK 里没有 ha.shell"],
      [wrap("await ha.file.remove({})"), "SDK 里没有 ha.file.remove"],
      [wrap("await ha.file.read({ fileId: 'f' })"), "file.read，这个任务里没有"],
      [wrap('await ha.tool("http-other", {})'), "http-other，这个任务里没有"],
      [wrap("await ha.tool(input.id, {})"), "第一个参数要直接写"],
      [wrap('await ha.fail("oops", "x")'), "ha.fail 的第一个参数"],
      [wrap("const x = ;"), "脚本解析不了"],
      ["", "脚本是空的"],
    ]
    for (const [code, expected] of cases) expect(problemsOf(code).join("\n"), code).toContain(expected)
    // 没有浏览器工具的任务不能用 ha.browser
    expect(problemsOf(GOOD_CODE, { toolIds: ["run.finish", "work.report"] }).join("\n")).toContain("browser，这个任务里没有")
    // 对象的键、别的对象的属性叫 process 不算
    expect(problemsOf(wrap("const o = { process: 1, eval: 2 }; o.process; o.require"))).toEqual([])
  })

  it("JSON Schema：要合法、是对象类型；被派的任务要包含声明的参数和结果；原来那次的输入要符合", () => {
    expect(problemsOf(GOOD_CODE, { inputSchema: "{不是json" }).join()).toContain("不是合法的 JSON")
    expect(problemsOf(GOOD_CODE, { inputSchema: JSON.stringify({ type: "string" }) }).join()).toContain('"type": "object"')
    expect(problemsOf(GOOD_CODE, { outputSchema: JSON.stringify({ type: "object", properties: { a: { type: "nope" } } }) }).join()).toContain("不是合法的 JSON Schema")
    expect(problemsOf(GOOD_CODE, { outputSchema: JSON.stringify({ type: "object", required: "a" }) }).join()).toContain("required 要是字段名的数组")
    expect(problemsOf(GOOD_CODE, { dispatch: DISPATCH, outputSchema: JSON.stringify({ type: "object", properties: {} }) }).join()).toContain("声明的结果「状态」")
    expect(problemsOf(GOOD_CODE, { dispatch: DISPATCH, inputSchema: JSON.stringify({ type: "object", properties: { 编号: { type: "string" } } }) }).join()).toContain("声明的参数「单号」")
    expect(problemsOf(GOOD_CODE, { sampleInput: { 单号: 3 } }).join()).toContain("原来那次运行的输入不符合输入格式")
  })
})

describe("固化成流程：开始", () => {
  it("只有负责人和主管；只有办成、已结束的普通运行；同一个流程同时只能有一版在走", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    expect((await compile(source, li)).error?.data?.code).toBe("FORBIDDEN")
    const failed = await sourceRun(taskId, { outcome: "not_achieved" })
    expect((await compile(failed)).error?.message).toContain("只有办成的运行")
    const running = await sourceRun(taskId, { status: "running" })
    expect((await compile(running)).error?.message).toContain("还没结束")

    const res = await compile(source, lin)
    expect(res.error).toBeUndefined()
    expect(res.data).toEqual({ routineId: expect.stringMatching(/^RT-\d+$/), versionId: `${res.data.routineId}-v1` })
    const version = await versionRow(res.data.versionId)
    expect(version).toMatchObject({ status: "drafting", version: 1, sourceSessionId: source, createdById: "u-lin", skipTest: false, baseVersion: null, round: 0 })
    const [routine] = await ctx.db.select().from(t.routines).where(eq(t.routines.taskId, taskId))
    expect(routine).toMatchObject({ id: res.data.routineId, status: "trial", activeVersion: null })
    const jobs = await bossJobs(ctx.db, QUEUES.routineCompile)
    expect(jobs.some((job) => job.data.versionId === res.data.versionId)).toBe(true)

    const again = await compile(source)
    expect(again.error?.data?.code).toBe("CONFLICT")
    expect(again.error?.message).toContain("第 1 版")
  })
})

describe("固化的状态机（假固化员 + 假试跑结果）", () => {
  it("一次过：写脚本 → 试跑（RT-n-v1-t1，固化试跑的运行）→ 停在提交前 → 待审核，给负责人一件「审核固化流程」并通知", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    const { data } = await compile(source)
    const model = useModel(SOLIDIFIER, [good()])
    await handleCompileJob(ctx.db, { versionId: data.versionId })

    let version = await versionRow(data.versionId)
    expect(version).toMatchObject({ status: "testing", round: 1, name: "查单号的状态", code: GOOD_CODE, modelId: SOLIDIFIER, assumptions: ["默认取第一行"] })
    expect(version.inputSchema).toEqual(JSON.parse(INPUT_SCHEMA))
    expect(version.costUsd).toBeCloseTo(0.002)
    // 固化员拿到的：规矩、SDK、材料
    expect(model.promptText(0)).toContain("固化员")
    expect(model.promptText(0)).toContain("输入在这里：text = input.单号")

    const testId = `${data.versionId}-t1`
    const test = await sessionRow(ctx.db, testId)
    expect(test).toMatchObject({ kind: "routine_test", status: "running", taskId })
    expect(test!.snapshot!.routine).toMatchObject({ versionId: data.versionId, status: "test", code: GOOD_CODE })
    expect(test!.routine).toMatchObject({ mode: "test", state: "running", input: { 单号: "PSS-001" } })

    // 还没跑完：再来一次也不动
    await handleCompileJob(ctx.db, { versionId: data.versionId })
    expect((await versionRow(data.versionId)).status).toBe("testing")

    await ctx.db.insert(t.files).values({ id: `shot-${testId}`, sessionId: testId, kind: "screenshot", name: "停下.png", mime: "image/png", size: 1, storagePath: "x", sha256: "x" })
    await endTest(testId, passAtCommit)
    await handleCompileJob(ctx.db, { versionId: data.versionId })
    version = await versionRow(data.versionId)
    expect(version.status).toBe("review")
    expect(version.testReport!.rounds).toEqual([
      expect.objectContaining({ round: 1, sessionId: testId, passed: true, steps: 3, screenshotFileId: `shot-${testId}`, data: { 状态: "已发货" }, compare: [{ field: "状态", expected: "已发货", actual: "已发货", same: true }] }),
    ])
    const [item] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.routineVersionId, data.versionId))
    expect(item).toMatchObject({ kind: "routine", status: "open", assigneeId: "u-wang", taskId, sessionId: source })
    expect(item!.id).toMatch(/^ro-/)
    expect(item!.detail).toMatchObject({ primary: "启用", secondary: "不用", routine: { routineId: data.routineId, versionId: data.versionId, version: 1 } })
    expect((await query(ctx.app, "routine.version", wang, { id: data.versionId })).data).toMatchObject({ status: "review", humanItemId: item!.id, round: 1 })
    const notes = await notificationsOf("u-wang")
    expect(notes.at(-1)).toMatchObject({ title: expect.stringContaining("等你处理：审核固化流程"), link: expect.stringContaining(item!.id) })
    // 通用的处理接口不处理这种事
    const resolved = await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item!.id, how: "approve" })
    expect(resolved.error?.message).toContain("routine.review")
  })

  it("程序检查没过就接着写；试跑没过回去再写（带上试跑的错误），第 3 轮过", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    const { data } = await compile(source)
    const model = useModel(SOLIDIFIER, [good({ code: GOOD_CODE.replace("await ha.browser.navigate", "eval('x'); await ha.browser.navigate") }), good(), good({ name: "查单号的状态（改过）" })])
    await handleCompileJob(ctx.db, { versionId: data.versionId })
    let version = await versionRow(data.versionId)
    expect(version).toMatchObject({ status: "testing", round: 2 })
    expect(model.promptText(1)).toContain("程序检查没过")
    expect(model.promptText(1)).toContain("不能用 eval")

    // 之前排着的那一个（worker 没起，一直没人取）先清掉，才看得出这次又发了一个
    await ctx.db.execute(sql`delete from pgboss.job where name = ${QUEUES.routineCompile} and data->>'versionId' = ${data.versionId}`)
    await endTest(`${data.versionId}-t2`, failAtStep("找不到单号输入框"))
    await handleCompileJob(ctx.db, { versionId: data.versionId })
    version = await versionRow(data.versionId)
    expect(version.status).toBe("drafting")
    expect(version.testReport!.rounds).toEqual([expect.objectContaining({ round: 2, passed: false, error: expect.stringContaining("找不到单号输入框") })])
    expect((await bossJobs(ctx.db, QUEUES.routineCompile)).filter((job) => job.data.versionId === data.versionId).length).toBe(1)

    await handleCompileJob(ctx.db, { versionId: data.versionId })
    expect(model.promptText(2)).toContain("第 2 轮试跑")
    expect(model.promptText(2)).toContain("找不到单号输入框")
    expect(model.promptText(2)).toContain("你上一轮写的脚本")
    version = await versionRow(data.versionId)
    expect(version).toMatchObject({ status: "testing", round: 3, name: "查单号的状态（改过）" })
    expect(version.costUsd).toBeCloseTo(0.006)

    // 脚本报了办成也算过；要交回的结果和原来那次不一样只写进报告
    await endTest(`${data.versionId}-t3`, { steps: 5, recorded: { report: { 状态: "已签收" }, finish: { outcome: "achieved", summary: "好" } } })
    await handleCompileJob(ctx.db, { versionId: data.versionId })
    version = await versionRow(data.versionId)
    expect(version.status).toBe("review")
    expect(version.testReport!.rounds.at(-1)).toMatchObject({ round: 3, passed: true, compare: [{ field: "状态", expected: "已发货", actual: "已签收", same: false }] })
  })

  it("试跑 3 轮都没过：没成功，原因写清，通知负责人", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    const { data } = await compile(source)
    useModel(SOLIDIFIER, [good(), good(), good()])
    for (let round = 1; round <= 3; round++) {
      await handleCompileJob(ctx.db, { versionId: data.versionId })
      expect(await versionRow(data.versionId)).toMatchObject({ status: "testing", round })
      await endTest(`${data.versionId}-t${round}`, round === 3 ? { steps: 4, stoppedAt: { step: 4, kind: "denied", tool: "browser.click", reason: "规则不许点删除" } } : failAtStep(`第 ${round} 次找不到`))
      await handleCompileJob(ctx.db, { versionId: data.versionId })
    }
    const version = await versionRow(data.versionId)
    expect(version.status).toBe("failed")
    expect(version.failReason).toContain("3 轮都用完了")
    expect(version.failReason).toContain("规则不许点删除")
    expect(version.testReport!.rounds.map((round) => round.passed)).toEqual([false, false, false])
    const notes = await notificationsOf("u-wang")
    expect(notes.at(-1)).toMatchObject({ title: expect.stringContaining("固化没成功"), body: expect.stringContaining("规则不许点删除") })
    // 没成功的那一版不挡下一次固化
    expect((await compile(source)).error).toBeUndefined()
  })

  it("不适合固化：没成功，原因是固化员写的", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    const { data } = await compile(source)
    useModel(SOLIDIFIER, [good({ suitable: false, reason: "第 3 步要看图判断哪个最像" })])
    await handleCompileJob(ctx.db, { versionId: data.versionId })
    expect(await versionRow(data.versionId)).toMatchObject({ status: "failed", failReason: "不适合固化：第 3 步要看图判断哪个最像" })
    expect(await sessionRow(ctx.db, `${data.versionId}-t1`)).toBeUndefined()
  })

  it("程序检查 3 轮都没过、模型出错也算一轮：没成功", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    const { data } = await compile(source)
    useModel(SOLIDIFIER, ["这不是 JSON", good({ code: "import fs from 'node:fs'" }), good({ inputSchema: "{" })])
    await handleCompileJob(ctx.db, { versionId: data.versionId })
    const version = await versionRow(data.versionId)
    expect(version).toMatchObject({ status: "failed", round: 3 })
    expect(version.failReason).toContain("写了 3 轮")
    expect(version.failReason).toContain("不是合法的 JSON")
  })

  it("选了不试跑：写好、检查过了直接待审核，不开试跑；没设固化的默认模型就用规划的", async () => {
    await ctx.db.delete(t.modelDefaults).where(eq(t.modelDefaults.role, "solidify"))
    await ctx.db.update(t.modelDefaults).set({ modelId: PLANNER }).where(eq(t.modelDefaults.role, "plan"))
    try {
      const taskId = await dispatchedTask()
      const source = await sourceRun(taskId)
      const { data } = await compile(source, wang, true)
      useModel(PLANNER, [good()])
      await handleCompileJob(ctx.db, { versionId: data.versionId })
      expect(await versionRow(data.versionId)).toMatchObject({ status: "review", skipTest: true, modelId: PLANNER, testReport: null })
      expect(await sessionRow(ctx.db, `${data.versionId}-t1`)).toBeUndefined()
      const [item] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.routineVersionId, data.versionId))
      expect(JSON.stringify(item!.detail)).toContain("没有试跑")
    } finally {
      await ctx.db.insert(t.modelDefaults).values({ role: "solidify", modelId: SOLIDIFIER })
    }
  })
})

describe("审核和回到旧版本", () => {
  /** 走到待审核（不试跑） */
  async function toReview(source: string) {
    const { data } = await compile(source, wang, true)
    useModel(SOLIDIFIER, [good()])
    await handleCompileJob(ctx.db, { versionId: data.versionId })
    return data as { routineId: string; versionId: string }
  }

  it("启用：这一版启用过、流程指向它、回到试用期、计数清零、开关打开；那件事处理掉。不是负责人不能审；不用要写理由，理由下次给固化员看", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    const v1 = await toReview(source)
    expect((await mutate(ctx.app, "routine.review", li, { versionId: v1.versionId, approve: true })).error?.data?.code).toBe("FORBIDDEN")
    await ctx.db.update(t.routines).set({ status: "paused", directStreak: 2, fallbackStreak: 1, pausedReason: "停过" }).where(eq(t.routines.id, v1.routineId))
    const approved = await mutate(ctx.app, "routine.review", wang, { versionId: v1.versionId, approve: true })
    expect(approved.data).toEqual({ versionId: v1.versionId, status: "approved" })
    expect(await versionRow(v1.versionId)).toMatchObject({ status: "approved", approvedById: "u-wang" })
    const summary = (await query(ctx.app, "routine.get", wang, { taskId })).data
    expect(summary).toMatchObject({ status: "trial", activeVersion: 1, mode: "first", directStreak: 0, fallbackStreak: 0, pausedReason: null })
    const [item] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.routineVersionId, v1.versionId))
    expect(item).toMatchObject({ status: "resolved", resolvedById: "u-wang", resolution: { how: "primary" } })
    expect((await mutate(ctx.app, "routine.review", wang, { versionId: v1.versionId, approve: true })).error?.data?.code).toBe("CONFLICT")

    // 第 2 版：不用
    const v2 = await toReview(source)
    expect((await mutate(ctx.app, "routine.review", wang, { versionId: v2.versionId, approve: false })).error?.data?.code).toBe("BAD_REQUEST")
    const rejected = await mutate(ctx.app, "routine.review", lin, { versionId: v2.versionId, approve: false, reason: "定位写死了第一行，不对" })
    expect(rejected.data).toEqual({ versionId: v2.versionId, status: "rejected" })
    expect(await versionRow(v2.versionId)).toMatchObject({ status: "rejected", rejectReason: "定位写死了第一行，不对" })
    const [item2] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.routineVersionId, v2.versionId))
    expect(item2).toMatchObject({ status: "resolved", resolution: { how: "reject", reason: "定位写死了第一行，不对" } })
    expect((await query(ctx.app, "routine.get", wang, { taskId })).data).toMatchObject({ activeVersion: 1 })

    // 第 3 版：固化员看得到第 2 版不用的理由
    const { data: v3 } = await compile(source)
    const model = useModel(SOLIDIFIER, [good()])
    await handleCompileJob(ctx.db, { versionId: v3.versionId })
    expect(model.promptText(0)).toContain("定位写死了第一行，不对")
  })

  it("回到以前启用过的版本：进试用期（停用着的也重新启用）；没启用过的版本不能回；开关不动", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    const v1 = await toReview(source)
    await mutate(ctx.app, "routine.review", wang, { versionId: v1.versionId, approve: true })
    const v2 = await toReview(source)
    await mutate(ctx.app, "routine.review", wang, { versionId: v2.versionId, approve: true })
    const v3 = await toReview(source)
    await mutate(ctx.app, "routine.review", wang, { versionId: v3.versionId, approve: false, reason: "不要" })
    expect((await query(ctx.app, "routine.get", wang, { taskId })).data).toMatchObject({ activeVersion: 2 })

    await mutate(ctx.app, "routine.setMode", wang, { taskId, mode: "off" })
    await ctx.db.update(t.routines).set({ status: "paused", pausedReason: "连续 3 次跑不通", fallbackStreak: 3 }).where(eq(t.routines.id, v1.routineId))
    expect((await mutate(ctx.app, "routine.restore", li, { routineId: v1.routineId, version: 1 })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "routine.restore", wang, { routineId: v1.routineId, version: 3 })).error?.data?.code).toBe("CONFLICT")
    expect((await mutate(ctx.app, "routine.restore", wang, { routineId: v1.routineId, version: 9 })).error?.data?.code).toBe("NOT_FOUND")
    const restored = await mutate(ctx.app, "routine.restore", wang, { routineId: v1.routineId, version: 1 })
    expect(restored.data).toEqual({ routineId: v1.routineId, activeVersion: 1 })
    expect((await query(ctx.app, "routine.get", wang, { taskId })).data).toMatchObject({ activeVersion: 1, status: "trial", fallbackStreak: 0, pausedReason: null, mode: "off" })
    const audits = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.targetId, v1.routineId), eq(t.auditEvents.action, "routine.restore")))
    expect(audits[0]!.detail).toMatchObject({ before: 2, after: 1, resumed: true })
  })

  it("修的版本：源运行跑过这个流程的脚本，新版本记 baseVersion，固化员拿到旧脚本和停下的原因", async () => {
    const taskId = await dispatchedTask()
    const first = await sourceRun(taskId)
    const v1 = await toReview(first)
    await mutate(ctx.app, "routine.review", wang, { versionId: v1.versionId, approve: true })
    const ranState: SessionRoutineState = {
      routineId: v1.routineId,
      versionId: v1.versionId,
      version: 1,
      mode: "run",
      state: "fell_back",
      startedAt: new Date().toISOString(),
      steps: 2,
      stoppedAt: { step: 2, kind: "step_error", tool: "browser.type", label: "单号输入框", reason: "找不到 getByLabel('单号')" },
      commits: [],
    }
    const second = await sourceRun(taskId, { routine: ranState })
    const { data } = await compile(second)
    expect(await versionRow(data.versionId)).toMatchObject({ version: 2, baseVersion: 1 })
    const model = useModel(SOLIDIFIER, [good()])
    await handleCompileJob(ctx.db, { versionId: data.versionId })
    expect(model.promptText(0)).toContain("要修的旧版本（第 1 版）")
    expect(model.promptText(0)).toContain("找不到 getByLabel('单号')")
  })
})

describe("会话列表和统计不算试跑", () => {
  it("sessions.list、sessions.page（个数、办成数、今天花了）都没有试跑；sessions.get 按 id 能看；定时到点不因为试跑在跑就跳过", async () => {
    const taskId = await dispatchedTask("0 9 * * *")
    const source = await sourceRun(taskId)
    const { data } = await compile(source)
    useModel(SOLIDIFIER, [good()])
    await handleCompileJob(ctx.db, { versionId: data.versionId })
    const testId = `${data.versionId}-t1`
    await ctx.db.update(t.sessions).set({ costUsd: 5 }).where(eq(t.sessions.id, testId))

    const list = (await query(ctx.app, "sessions.list", wang, { taskId })).data as { id: string }[]
    expect(list.map((run) => run.id)).toEqual([source])
    expect(((await query(ctx.app, "sessions.list", wang)).data as { id: string }[]).some((run) => run.id === testId)).toBe(false)
    const page = (await query(ctx.app, "sessions.page", wang, { group: "running", taskId })).data
    expect(page.items).toEqual([])
    expect(page.counts.running).toBe(0)
    expect(page.counts.ended).toBe(1)
    expect(page.spentToday).toBeLessThan(5)
    const searched = (await query(ctx.app, "sessions.page", wang, { group: "running", q: testId })).data
    expect(searched.total).toBe(0)
    expect((await query(ctx.app, "sessions.get", wang, { id: testId })).data).toMatchObject({ id: testId, kind: "routine_test" })

    // 试跑还在跑：定时照样开
    expect((await sessionRow(ctx.db, testId))!.status).toBe("running")
    expect(await onTaskCron(ctx.db, { taskId })).toMatch(/^R-/)

    await endTest(testId, passAtCommit)
    const ended = (await query(ctx.app, "sessions.page", wang, { group: "ended", taskId })).data
    expect(ended.items.map((run: { id: string }) => run.id)).toEqual([source])
    expect(ended.endedOutcome).toEqual({ achieved: 1, notAchieved: 0 })
  })
})

describe("默认模型「固化」", () => {
  it("可选：读、写、删（空字符串 = 不单独配），要是聊天模型", async () => {
    const before = (await query(ctx.app, "models.overview", lin)).data.defaults
    expect(before.solidify).toBe(SOLIDIFIER)
    const set = await mutate(ctx.app, "models.setDefaults", lin, { run: before.run, plan: before.plan, verify: before.verify, solidify: PLANNER })
    expect(set.error).toBeUndefined()
    expect(set.data.solidify).toBe(PLANNER)
    expect((await mutate(ctx.app, "models.setDefaults", lin, { run: before.run, plan: before.plan, verify: before.verify, solidify: "test/none" })).error?.message).toContain("模型不存在")
    const cleared = await mutate(ctx.app, "models.setDefaults", lin, { run: before.run, plan: before.plan, verify: before.verify, solidify: "" })
    expect(cleared.data.solidify).toBeUndefined()
    expect((await query(ctx.app, "models.overview", lin)).data.defaults.solidify).toBeUndefined()
    // 不传不改
    await mutate(ctx.app, "models.setDefaults", lin, { run: before.run, plan: before.plan, verify: before.verify, solidify: SOLIDIFIER })
    await mutate(ctx.app, "models.setDefaults", lin, { run: before.run, plan: before.plan, verify: before.verify })
    expect((await query(ctx.app, "models.overview", lin)).data.defaults.solidify).toBe(SOLIDIFIER)
  })
})
