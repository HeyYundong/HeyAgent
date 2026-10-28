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
import { handleCompileJob, unwrapNestedCode } from "../src/routine/compile.js"
import { buildMaterial, clipBlocks, inputMarks, inputValues, sdkCallOf, toolsSection } from "../src/routine/material.js"
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

describe("固化员的回答套了一层", () => {
  const base = { suitable: true, reason: "", name: "查供应商", description: "1. 搜索", inputSchema: "{}", outputSchema: "{}", commits: [], assumptions: [], httpToolSuggestions: [] }
  const script = 'import ha from "heyagent"\n\nexport default async function run(input) {\n  return ha.finish({ outcome: "achieved", summary: "好", evidence: "页面显示「已提交」" })\n}'
  it("code 里又是一整个回答（能解析）：用里面的脚本，别的字段用外面的", () => {
    const nested = JSON.stringify({ suitable: true, input: { type: "object" }, code: script })
    expect(unwrapNestedCode({ ...base, code: nested })).toEqual({ ...base, code: script })
  })
  it("套错了引号、后面还跟着别的字段（基准 B 第 3 轮那样，整段解析不了）：只取 code 那个字符串", () => {
    const broken = `${JSON.stringify({ suitable: true, code: script })},"commits":["提交汇总"]}`
    expect(() => JSON.parse(broken)).toThrow()
    expect(unwrapNestedCode({ ...base, code: broken }).code).toBe(script)
  })
  it("正常的脚本、里面没有脚本的 JSON：原样不动", () => {
    expect(unwrapNestedCode({ ...base, code: script }).code).toBe(script)
    const notScript = JSON.stringify({ code: "1 + 1" })
    expect(unwrapNestedCode({ ...base, code: notScript }).code).toBe(notScript)
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
    // 属性顺序记进 x-order（jsonb 存进去会按键长短重排，p1、p2 要照作者写的顺序）
    expect(result.inputSchema).toEqual({ ...JSON.parse(INPUT_SCHEMA), "x-order": ["单号"] })
    const ordered = checkRoutine({ ...base, code: GOOD_CODE, inputSchema: '{"type":"object","properties":{"工厂链接":{"type":"string"},"单号":{"type":"string"},"q":{"type":"string"}},"required":["单号"]}' })
    expect(ordered.inputSchema?.["x-order"]).toEqual(["工厂链接", "单号", "q"])
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

  it("没有输入 / 没有结果时常见的写法（空串、{}、有 properties 没写 type）：当成对象，不算错", () => {
    const code = wrap('  await ha.browser.navigate({ url: "https://erp.example.com/orders" })\n  return ha.finish({ outcome: "achieved", summary: "打开了", evidence: "订单页" })')
    for (const schema of ["", "{}", JSON.stringify({ properties: {} })]) {
      expect(problemsOf(code, { inputSchema: schema, outputSchema: schema, sampleInput: {} })).toEqual([])
    }
    const check = checkRoutine({ ...base, code, inputSchema: "{}", outputSchema: "", sampleInput: {} })
    expect(check.inputSchema).toMatchObject({ type: "object" })
    expect(check.outputSchema).toMatchObject({ type: "object" })
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
    expect(version.inputSchema).toEqual({ ...JSON.parse(INPUT_SCHEMA), "x-order": ["单号"] })
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

// ---------- 第二期第二批（docs/dev/solidify.md 18.1、18.2）：判断题 ha.judge、agent 运行中写的脚本 ----------

const JUDGE_CODE = `import ha from "heyagent"

export default async function run(input) {
  await ha.browser.navigate({ url: "https://erp.example.com/orders" })
  await ha.browser.type({ element: "单号输入框", target: "getByLabel('单号')", text: input.单号 })
  const { rows } = await ha.browser.extract({ list: "getByRole('row')", fields: { 状态: "getByRole('cell').nth(3)" }, limit: 3 })
  const { answer, reason } = await ha.judge({
    question: "哪一行是这张单现在的状态？",
    data: rows.map((row, i) => ({ 编号: String(i + 1), 状态: row.状态 })),
    choices: rows.map((_, i) => String(i + 1)),
  })
  await ha.log(\`选了第 \${answer} 行：\${reason}\`)
  const picked = rows[Number(answer) - 1]
  await ha.work.report({ data: { 状态: picked.状态 } })
  return ha.finish({ outcome: "achieved", summary: picked.状态, evidence: reason })
}`

/** agent 运行中写的循环脚本（code.run 的 code 参数） */
const AGENT_SCRIPT = `import ha from "heyagent"
const rows = ["PSS-001", "PSS-002"]
for (const no of rows) {
  await ha.browser.type({ element: "单号输入框", target: "getByLabel('单号')", text: no })
  await ha.browser.click({ element: "查询", target: "getByRole('button', { name: '查询' })" })
}`

/** 在一次运行的过程后面接着加几条 */
async function appendEvents(sessionId: string, events: { kind: "tool" | "plan" | "rule"; title: string; toolId?: string; input?: string; output?: string; trace?: Record<string, unknown> }[]) {
  const [last] = await ctx.db.select({ seq: sql<number>`max(${t.sessionEvents.seq})` }).from(t.sessionEvents).where(eq(t.sessionEvents.sessionId, sessionId))
  const start = Number(last?.seq ?? 0)
  await ctx.db.insert(t.sessionEvents).values(
    events.map((event, index) => ({ sessionId, seq: start + index + 1, at: new Date(), kind: event.kind, title: event.title, toolId: event.toolId ?? null, input: event.input ?? null, output: event.output ?? null, trace: event.trace ?? null }))
  )
  await ctx.db.update(t.sessions).set({ eventSeq: start + events.length }).where(eq(t.sessions.id, sessionId))
}

/** agent 用 code.run（tools）跑了一个脚本：脚本做的步骤（带 scriptStep，先落）、一条判断、最后是 code.run 自己那条 */
const agentScriptEvents = (callId: string, code: string) => [
  { kind: "tool" as const, title: "输入文字", toolId: "browser.type", input: JSON.stringify({ element: "单号输入框", target: "getByLabel('单号')", text: "PSS-001" }), output: "已输入", trace: { scriptStep: 1, scriptCallId: callId, code: "await page.getByLabel('单号').fill('PSS-001');" } },
  { kind: "tool" as const, title: "点击（出错）", toolId: "browser.click", input: JSON.stringify({ element: "查询", target: "getByRole('button', { name: '查询' })" }), output: "超时", trace: { scriptStep: 2, scriptCallId: callId } },
  { kind: "plan" as const, title: "流程判断：哪一行最符合 → 1（第一行是最新的）", trace: { scriptStep: 3, scriptCallId: callId } },
  { kind: "tool" as const, title: "运行代码", toolId: "code.run", input: JSON.stringify({ language: "node", code, tools: true, timeout: 120 }), output: `退出码 0\n${"输出".repeat(400)}\n脚本调了 2 次工具：browser.type 1 次、browser.click 1 次（出错 1 次）` },
]

describe("判断题 ha.judge 和 agent 写的脚本（18.1、18.2）", () => {
  it("提示词：规矩第 9、10、14 条和例 5；SDK 说明里还没有 judge 就补上，有了不重复", async () => {
    const { compileOutputSchema, JUDGE_DTS } = await import("../src/routine/prompt.js")
    const system = compileSystemPrompt("declare const ha: {}")
    for (const each of ["ha.judge", "尽量给 choices", "只有每一步都要看内容判断", "只用来选路", "不要把 answer、reason 的文字原样填进会改东西的表单", "例 5", "choices: [...rows.map", "agent 运行中写的脚本", "可以照它的写法写循环"]) expect(system).toContain(each)
    expect(system).toContain(JUDGE_DTS)
    // index.d.ts 里有 judge 了（A3 写的）：不再补
    const withJudge = compileSystemPrompt("interface Heyagent { judge(args: { question: string }): Promise<{ answer: string; reason: string }> }")
    expect(withJudge).not.toContain(JUDGE_DTS)
    // 内置的说明里有 judge
    expect(SDK_FALLBACK).toContain("judge(args: { question: string; data?: unknown; choices?: string[] })")
    expect(compileOutputSchema.shape.suitable.description).toContain("ha.judge")
  })

  it("程序检查：ha.judge 不要任务里的工具；要写 question；choices 至少两个；ha.StepError 认得", () => {
    const toolIds = ["browser", "run.finish", "work.report"]
    const ok = checkRoutine({ code: JUDGE_CODE, inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA, toolIds, dispatch: DISPATCH, sampleInput: { 单号: "PSS-001" } })
    expect(ok.problems).toEqual([])
    expect(ok.usedTools).toEqual(["browser", "run.finish", "work.report"])
    const wrap = (body: string) => `import ha from "heyagent"\nexport default async function run(input) {\n${body}\n}`
    const problemsOf = (body: string, ids: string[] = []) => checkRoutine({ code: wrap(body), inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA, toolIds: ids }).problems
    // 一个工具都没有的任务也能用 judge
    expect(problemsOf(`const r = await ha.judge({ question: "是不是差评", data: input.单号, choices: ["是", "否"] }); await ha.log(r.answer)`)).toEqual([])
    expect(problemsOf(`const args = { question: "x" }; await ha.judge({ ...args })`)).toEqual([])
    expect(problemsOf(`try { await ha.log("x") } catch (error) { if (error instanceof ha.StepError || error instanceof ha.Denied || error instanceof ha.RoutineStop) await ha.log("y") }`)).toEqual([])
    expect(problemsOf(`await ha.judge({ data: "x", choices: ["是", "否"] })`).join()).toContain("要写 question")
    expect(problemsOf(`await ha.judge({ question: "x", choices: ["是"] })`).join()).toContain("choices 至少要两个")
    expect(problemsOf(`await ha.judge()`).join()).toContain("要给参数")
    expect(problemsOf(`const f = ha.judge`).join()).toContain("ha.judge 要直接调用")
    // 展开的选项看不出几个，不报
    expect(problemsOf(`const list = ["a", "b"]; await ha.judge({ question: "x", choices: [...list] })`)).toEqual([])
  })

  it("材料：agent 脚本的原文完整给（不截到 300 字），它做的步骤标「脚本 k 第 n 步」；不带 tools 的 code.run 不算；一样的脚本不重复给", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    const longScript = `${AGENT_SCRIPT}\n// ${"注释".repeat(400)}`
    await appendEvents(source, [
      { kind: "tool", title: "运行代码", toolId: "code.run", input: JSON.stringify({ language: "python", code: "print(1)" }), output: "1" },
      ...agentScriptEvents("call-1", longScript),
      ...agentScriptEvents("call-2", longScript),
    ])
    const [routine] = await ctx.db.insert(t.routines).values({ id: `RT-s-${taskId}`, taskId }).returning()
    const material = await buildMaterial(ctx.db, { sourceSessionId: source, routineId: routine!.id })
    const text = material.text
    expect(text).toContain("## agent 运行中写的脚本（code.run 带 tools）")
    expect(text).toContain(longScript)
    expect(text).toContain("### 脚本 1：调了 2 次工具，code.run 跑完了")
    expect(text).toContain("### 脚本 2：调了 2 次工具，code.run 跑完了\n和脚本 1 一字不差。")
    expect(text.split(longScript).length).toBe(2)
    // 过程：先是那次 code.run（不带原文），后面跟它做的步骤
    expect(text).toMatch(/#\d+ code\.run ✓：agent 运行中写的循环脚本（脚本 1，原文见「agent 运行中写的脚本」）/)
    expect(text).toContain('参数（不含原文）：{"language":"node","tools":true,"timeout":120}')
    expect(text).toMatch(/输出结尾：….*脚本调了 2 次工具/)
    expect(text).toMatch(/#\d+ browser\.type ✓（脚本 1 第 1 步）/)
    expect(text).toMatch(/#\d+ browser\.click ✗ 出错（脚本 2 第 2 步）/)
    expect(text).toContain("- 脚本 1 第 3 步：流程判断：哪一行最符合 → 1（第一行是最新的）")
    const log = text.slice(text.indexOf("## 这次运行的过程"))
    expect(log.indexOf("agent 运行中写的循环脚本（脚本 1")).toBeLessThan(log.indexOf("（脚本 1 第 1 步）"))
    expect(log.indexOf("（脚本 1 第 3 步")).toBeLessThan(log.indexOf("agent 运行中写的循环脚本（脚本 2"))
    // 不带 tools 的 python 照普通工具调用列
    expect(text).toMatch(/#\d+ code\.run ✓\n {2}参数：\{"language":"python","code":"print\(1\)"\}/)
  })

  it("材料：脚本太长截到 2 万字；合计超出预算留后面的；参数存的时候截断了取得到开头；用文件跑的按 file.save / file.edit 推出原文，推不出读空间里的文件；找不到 code.run 的步骤也列出来", async () => {
    const { AGENT_SCRIPT_MAX, agentScriptsSection, collectAgentScripts, compactLog, jsonStringPrefix, resolveAgentScripts } = await import("../src/routine/material.js")
    type Row = Parameters<typeof collectAgentScripts>[0][number]
    let seq = 0
    const row = (patch: Partial<Row>): Row => ({ sessionId: "R-x", seq: ++seq, at: new Date(), kind: "tool", title: "x", toolId: null, input: null, output: null, detail: null, ms: null, tokensIn: null, tokensOut: null, trace: null, ...patch }) as Row

    // 太长：截到 2 万字
    const huge = `// 开头\n${"x".repeat(AGENT_SCRIPT_MAX + 5000)}`
    const [long] = collectAgentScripts([row({ toolId: "code.run", input: JSON.stringify({ language: "node", code: huge, tools: true }) })])
    const section = agentScriptsSection([long!])
    expect(section).toContain("// 开头")
    expect(section).toContain(`后面 ${huge.length - AGENT_SCRIPT_MAX} 字省略`)
    expect(section.length).toBeLessThan(AGENT_SCRIPT_MAX + 1000)

    // 合计超出预算：留后面的
    const many = collectAgentScripts([1, 2, 3].map((n) => row({ toolId: "code.run", input: JSON.stringify({ language: "node", code: `// 第 ${n} 个\n${"y".repeat(15_000)}`, tools: true }) })))
    const budgeted = agentScriptsSection(many)
    expect(budgeted).toContain("// 第 3 个")
    expect(budgeted).toContain("// 第 2 个")
    expect(budgeted).not.toContain("// 第 1 个")
    expect(budgeted).toContain("### 脚本 1：调了 0 次工具，code.run 跑完了\n（原文省略")

    // 参数存的时候截断了（records.ts 超过 5 万字截断）：JSON 解析不了，取 code 的开头
    const raw = JSON.stringify({ language: "node", code: 'const a = "引号\\n"\n' + "z".repeat(60_000), tools: true }).slice(0, 50_000) + "\n…（已截断）"
    expect(jsonStringPrefix(raw, "code")).toMatch(/^const a = "引号\\n"\nzzz/)
    const steps = [row({ toolId: "browser.click", trace: { scriptStep: 1, scriptCallId: "c-9" } })]
    const [cut] = collectAgentScripts([...steps, row({ toolId: "code.run", input: raw })])
    expect(cut).toMatchObject({ note: "参数存的时候截断了，只有开头", steps })
    expect(cut!.code!.startsWith('const a = "引号\\n"')).toBe(true)

    // 用空间里的文件跑：file.save 之后 file.edit 改过，推出 code.run 那时的内容（之后再改的不算）
    seq = 0
    const events = [
      row({ toolId: "file.save", input: JSON.stringify({ path: "scripts/loop.mjs", content: 'import ha from "heyagent"\nawait ha.log("旧")' }) }),
      row({ toolId: "file.edit", input: JSON.stringify({ path: "./scripts/loop.mjs", edits: [{ old: '"旧"', new: '"新"' }] }) }),
      row({ toolId: "code.run", input: JSON.stringify({ language: "node", file: "scripts/loop.mjs", tools: true }) }),
      row({ toolId: "file.edit", input: JSON.stringify({ path: "scripts/loop.mjs", edits: [{ old: '"新"', new: '"更新"' }] }) }),
      row({ toolId: "code.run", input: JSON.stringify({ language: "node", file: "scripts/other.mjs", tools: true }) }),
      row({ toolId: "code.run", input: JSON.stringify({ language: "node", file: "scripts/gone.mjs", tools: true }) }),
    ]
    const scripts = collectAgentScripts(events)
    await resolveAgentScripts(scripts, events, async (path) => (path === "scripts/other.mjs" ? "// 空间里的文件" : undefined))
    expect(scripts.map((each) => each.code)).toEqual(['import ha from "heyagent"\nawait ha.log("新")', "// 空间里的文件", undefined])
    expect(scripts[1]!.note).toContain("运行结束时空间里的这个文件")
    expect(agentScriptsSection(scripts)).toContain("### 脚本 3（空间文件 scripts/gone.mjs）：调了 0 次工具，code.run 跑完了\n（没有原文：过程里推不出当时的内容，空间里也找不到这个文件）")

    // 找不到 code.run 的（中途被打断）：步骤照样列出来，标脚本几第几步
    seq = 0
    const orphan = [row({ toolId: "browser.navigate", input: "{}", trace: { scriptStep: 1, scriptCallId: "c-lost" } }), row({ kind: "rule", title: "拦下：删除" })]
    const log = compactLog(orphan, [])
    expect(log[0]).toContain("code.run（找不到记录）：agent 运行中写的循环脚本（脚本 1")
    expect(log[1]).toContain("#2 browser.navigate ✓（脚本 1 第 1 步）")
    expect(log[2]).toBe("- 规则：拦下：删除")
  })

  it("固化员（假模型）看着 agent 的脚本写出带 ha.judge 的脚本：过了程序检查，进试跑", async () => {
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    await appendEvents(source, agentScriptEvents("call-9", AGENT_SCRIPT))
    const { data } = await compile(source)
    const model = useModel(SOLIDIFIER, [good({ code: JUDGE_CODE, assumptions: ["第 3 步用 ha.judge 挑哪一行"] })])
    await handleCompileJob(ctx.db, { versionId: data.versionId })
    const version = await versionRow(data.versionId)
    expect(version).toMatchObject({ status: "testing", round: 1, code: JUDGE_CODE, assumptions: ["第 3 步用 ha.judge 挑哪一行"] })
    const prompt = model.promptText(0)
    expect(prompt).toContain("ha.judge")
    // promptText 是消息的 JSON：换行、引号都转义了
    expect(prompt).toContain(JSON.stringify(AGENT_SCRIPT).slice(1, -1))
    expect(prompt).toContain("（脚本 1 第 1 步）")
    const test = await sessionRow(ctx.db, `${data.versionId}-t1`)
    expect(test).toMatchObject({ kind: "routine_test", status: "running" })
    expect(test!.snapshot!.routine).toMatchObject({ code: JUDGE_CODE })
  })
})

describe("剪贴板：复制图片、粘贴（基准 C 里固化员说 SDK 做不了）", () => {
  /** 基准 C 那样：一张按坐标复制、一张按 ref 复制，点格子，粘贴；另外一次批、一次快照、一次后退 */
  const pasteEvents = [
    { kind: "tool" as const, title: "复制图片", toolId: "browser.copy_image", input: JSON.stringify({ element: "大写字母 X", x: 120, y: 340 }), output: "已复制图片（64×64，来源：原图）" },
    { kind: "tool" as const, title: "复制图片", toolId: "browser.copy_image", input: JSON.stringify({ element: "大写字母 E", target: "e31" }), output: "已复制图片（64×64，来源：原图）" },
    { kind: "tool" as const, title: "点击", toolId: "browser.click", input: JSON.stringify({ element: "第 1 行图片格", target: "e40" }), output: "点了" },
    { kind: "tool" as const, title: "粘贴（出错）", toolId: "browser.clipboard_paste", input: JSON.stringify({ fileId: "f-1" }), output: "页面没有焦点" },
    { kind: "tool" as const, title: "粘贴", toolId: "browser.clipboard_paste", input: JSON.stringify({ fileId: "f-1" }), output: "已把图片写进剪贴板" },
    { kind: "tool" as const, title: "连着做几步", toolId: "browser.batch", input: "{}", output: "做完了" },
    { kind: "tool" as const, title: "看页面", toolId: "browser.snapshot", input: "{}", output: "- img" },
    { kind: "tool" as const, title: "后退", toolId: "browser.navigate_back", input: "{}", output: "退回去了" },
    { kind: "tool" as const, title: "按坐标点", toolId: "browser.mouse_click_xy", input: JSON.stringify({ element: "格子", x: 1, y: 2 }), output: "点了" },
  ]

  it("材料：组工具下面列出这次用过的子工具和 SDK 里的调法；按坐标的标出来；非组工具也写调法", async () => {
    const tools = [
      { id: "browser", name: "浏览器", risk: "external" as const, summary: "操作网页" },
      { id: "gallery", name: "图库", risk: "write" as const, summary: "" },
      { id: "http-erp", name: "ERP 接口", risk: "read" as const, summary: "" },
      { id: "work.report", name: "交回结果", risk: "write" as const, summary: "" },
    ]
    const section = toolsSection(tools, [...pasteEvents, { kind: "tool" as const, title: "报结果", toolId: "work.report", input: "{}", output: "好" }])
    expect(section).toContain("## 任务里的工具（脚本只能用这些）")
    expect(section).toContain("没有的用 ha.tool(\"工具 id\", 参数)")
    expect(section).toContain("- browser.copy_image（2 次，1 次按坐标 x、y：脚本里换成定位 target）→ ha.browser.copyImage(…)")
    expect(section).toContain("- browser.clipboard_paste（2 次，1 次出错）→ ha.browser.clipboardPaste(…)")
    expect(section).toContain("- browser.click（1 次）→ ha.browser.click(…)")
    expect(section).toContain('- browser.navigate_back（1 次）→ ha.tool("browser.navigate_back", { … })')
    expect(section).toContain("- browser.batch（1 次）→ 脚本里不用：一步一步调")
    expect(section).toContain("- browser.snapshot（1 次）→ agent 看页面用的，脚本里不用")
    expect(section).toContain("- browser.mouse_click_xy（1 次，1 次按坐标 x、y：脚本里换成定位 target）")
    expect(section).toContain("- gallery：图库（风险 write）（一组工具，这次运行没用过）")
    expect(section).toContain('- http-erp：ERP 接口（风险 read） → ha.tool("http-erp", { … })')
    expect(section).toContain("- work.report：交回结果（风险 write） → ha.work.report(…)")
    // 子工具排在组的下面
    const lines = section.split("\n")
    expect(lines.findIndex((line) => line.includes("browser.copy_image"))).toBeGreaterThan(lines.findIndex((line) => line.startsWith("- browser：")))
    expect(sdkCallOf("browser.clipboard_read")).toBe("ha.browser.clipboardRead(…)")
    expect(sdkCallOf("browser.wait_any")).toBe("ha.browser.waitAny(…)")
    expect(sdkCallOf("run.finish")).toBe("ha.finish(…)")

    // 从库里拼的材料用的就是这一节
    const taskId = await dispatchedTask()
    const source = await sourceRun(taskId)
    await appendEvents(source, pasteEvents)
    const [routine] = await ctx.db.insert(t.routines).values({ id: `RT-c-${taskId}`, taskId }).returning()
    const material = await buildMaterial(ctx.db, { sourceSessionId: source, routineId: routine!.id })
    expect(material.text).toContain("这次运行用过的子工具（脚本里怎么调）：")
    expect(material.text).toContain("- browser.copy_image（2 次，1 次按坐标 x、y：脚本里换成定位 target）→ ha.browser.copyImage(…)")
    expect(material.text).toContain("- browser.navigate（1 次）→ ha.browser.navigate(…)")
  })

  it("提示词：有包装的用包装、没有的用 ha.tool；坐标换成定位；复制 → 点位置 → commit → 粘贴；SDK 说明里有这三个函数", () => {
    const system = compileSystemPrompt()
    for (const each of ["15. 过程里用过的工具都能在脚本里用", "ha.tool(\"工具 id\", 参数)", "16. agent 按坐标（x、y）做的操作", "17. 复制图片再贴到别处", "await ha.commit(\"贴第 n 张图\")"])
      expect(system).toContain(each)
    // 读的是真的 index.d.ts：三个函数和 ha.tool 的说明都在
    for (const each of ["copyImage(args: CopyImageArgs): Promise<CopyImageResult>", "clipboardRead(", "clipboardPaste(", "也包括上面没有包装的浏览器工具（browser.xxx）"]) expect(system).toContain(each)
    for (const each of ["copyImage(", "clipboardRead(", "clipboardPaste("]) expect(SDK_FALLBACK).toContain(each)
  })

  it("程序检查：认三个新函数（要任务里有 browser）；ha.tool 调没包装的浏览器工具也认", () => {
    const wrap = (body: string) => `import ha from "heyagent"\nexport default async function run(input) {\n${body}\n}`
    const code = wrap(`
  for (const [i, letter] of ["X", "E"].entries()) {
    const { fileId } = await ha.browser.copyImage({ element: "大写字母 " + letter, target: "getByRole('img', { name: '大写字母 " + letter + "' })" })
    await ha.browser.click({ element: "第 " + (i + 1) + " 行图片格", target: "getByRole('cell').nth(" + i + ")" })
    await ha.commit("贴第 " + (i + 1) + " 张图")
    await ha.browser.clipboardPaste({ fileId })
  }
  const read = await ha.browser.clipboardRead({ copy: true })
  await ha.tool("browser.navigate_back", {})
  return ha.finish({ outcome: "achieved", summary: String(read.text), evidence: "x" })`)
    const ok = checkRoutine({ code, inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA, toolIds: ["browser", "run.finish"] })
    expect(ok.problems).toEqual([])
    expect(ok.usedTools).toEqual(["browser", "browser.navigate_back", "run.finish"])
    const missing = checkRoutine({ code, inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA, toolIds: ["run.finish"] }).problems.join("\n")
    expect(missing).toContain("ha.browser.copyImage（browser.copy_image） 要用工具 browser，这个任务里没有这个工具")
    expect(missing).toContain("browser.navigate_back，这个任务里没有")
    // 拼错的还是报，并提示 ha.tool
    expect(checkRoutine({ code: wrap("await ha.browser.copy_image({})"), inputSchema: INPUT_SCHEMA, outputSchema: OUTPUT_SCHEMA, toolIds: ["browser"] }).problems.join()).toContain('SDK 里没有 ha.browser.copy_image')
  })
})
