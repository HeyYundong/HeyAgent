// 流程库的运行时（docs/dev/routine-library.md 5、6.2、6.5、6.6；第 13.1 节 A 包）。
// 真的测试库 + 进程内 worker + 假模型；沙箱换成「直接跑 node」的 runner（开发机没有 bwrap），SDK 照样经工具桥 → 调用方的网关。
// 库流程直接往 routine_library、tools（source = routine）里写行造（不用 B 包的发布）。
// - 快照：跟着发布的版本、传递冻进调的库流程；停用、缺工具、缺开关、调的用不了 → unavailable，网关不给工具，系统提示写原因；
// - agent 调：交回值、没办成不算错、ha.fail("input")、跑不通交接的话、里面被规则拦下 / 要审批（不发起）/ 挂起、整个流程上的审批、次数上限；
// - 脚本调：固化脚本里 ha.routine、没接住的错、里面要审批 → 批准 → 按日志接着跑、试跑停在库流程里的第一个提交、code.run 循环调、
//   两层能跑、三层和绕圈报错、ha.tool("routine.x") 被拒、RoutineFailed 能接住；
// - 成绩：每种结局记对、fail_streak 只算那五种、满 3 次自动停用和通知、报了结果清零、旧版本的不算；
// - 复核的过程记录：库流程那一段只留最近几步。
import { mkdtempSync } from "node:fs"
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { describeCompiledRule, routineReturnSchema, routineToolStopDataSchema, type CompiledRule, type LibraryRoutineSnapshot, type RoutineRequires, type SessionRoutineState } from "@heyagent/shared"
import { and, asc, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import type { GatewayResult, ModelToolCall } from "../src/engine/gateway.js"
import { reviewLog } from "../src/engine/log-text.js"
import { bossFor, QUEUES } from "../src/engine/queue.js"
import { configureEngine, runtime } from "../src/engine/runtime.js"
import { buildSnapshot, startSessionImpl } from "../src/engine/sessions.js"
import { recordRoutineCall } from "../src/routine/library/stats.js"
import { ToolBridge, type BridgeGateway } from "../src/routine/runtime/bridge.js"
import { configureRoutineRuntime, LAUNCH_SCRIPT, routineLimits, SDK_DIR, setRoutineSandboxDeps } from "../src/routine/runtime/run.js"
import { setSandboxDeps } from "../src/sandbox/code-run.js"
import { SANDBOX_CODE_DIR, TOOLS_SOCKET_NAME } from "../src/sandbox/runner.js"
import { login } from "./helpers.js"
import {
  call,
  createTask,
  eventsOf,
  finishWith,
  mutate,
  Script,
  sessionRow,
  setupEngine,
  step,
  useScript,
  waitFor,
  type EngineTestContext,
} from "./engine-helpers.js"
import { createRoutine, directNodeRunner, routineCode } from "./routine-helpers.js"

let ctx: EngineTestContext
let wang: string
const sandboxDir = mkdtempSync(join(tmpdir(), "heyagent-library-"))
let modelCounter = 0
let slugCounter = 0

beforeAll(async () => {
  ctx = await setupEngine()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  configureEngine({ sandbox: { ...runtime.sandbox, dir: sandboxDir } })
  setSandboxDeps({ runner: directNodeRunner, unavailable: async () => undefined })
  setRoutineSandboxDeps({ runner: directNodeRunner, unavailable: async () => undefined })
  await (await bossFor(ctx.db)).createQueue(QUEUES.routineCompile, { policy: "stately" })
}, 120_000)

afterAll(async () => {
  setSandboxDeps(undefined)
  setRoutineSandboxDeps(undefined)
  await ctx?.stop()
  await rm(sandboxDir, { recursive: true, force: true })
})

const SINGLE_INPUT = { type: "object", properties: { 单号: { type: "string", description: "要查的单号" } }, required: ["单号"] }

/** 造一个「已发布」的库流程：来源任务 + 转过正式的一版 + 登记 + tools 那一行 */
async function publish(input: {
  body: string
  title?: string
  slug?: string
  inputSchema?: Record<string, unknown>
  requires?: Partial<RoutineRequires>
  status?: "listed" | "paused" | "withdrawn"
  risk?: "read" | "write" | "external" | "money"
}) {
  const slug = input.slug ?? `lib_${++slugCounter}`
  const sourceTask = await createTask(ctx.db, { modelId: "test/library-source", toolIds: ["file.save", "file.read"] })
  const { routineId, versionId } = await createRoutine(ctx.db, sourceTask, {
    code: routineCode(input.body),
    name: input.title ?? `流程 ${slug}`,
    status: "active",
    inputSchema: input.inputSchema ?? {},
  })
  await ctx.db.update(t.routineVersions).set({ provenAt: new Date(), description: "1. 存一个文件\n2. 读回来" }).where(eq(t.routineVersions.id, versionId))
  const title = input.title ?? `流程 ${slug}`
  const requires: RoutineRequires = { toolIds: ["file.save"], browser: {}, routines: [], ...input.requires }
  const risk = input.risk ?? "write"
  await ctx.db.insert(t.routineLibrary).values({ routineId, slug, title, summary: `要${title}时用`, status: input.status ?? "listed", publishedVersion: 1, requires, risk, publishedById: "u-lin" })
  await ctx.db.insert(t.tools).values({ id: `routine.${slug}`, name: title, summary: `要${title}时用`, description: `固化好的流程：${title}`, source: "routine", risk, routineId })
  return { routineId, slug, toolId: `routine.${slug}`, title, sourceTask }
}

async function callerTask(turns: ConstructorParameters<typeof Script>[0], toolIds: string[]) {
  const modelId = `test/library-${++modelCounter}`
  const script = useScript(modelId, new Script(turns))
  const taskId = await createTask(ctx.db, { modelId, toolIds })
  return { taskId, script, modelId }
}

async function runNow(taskId: string) {
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(JSON.stringify(res.error))
  return res.data.sessionId as string
}

async function waitOutcome(sessionId: string, timeout = 40_000) {
  return waitFor(
    async () => {
      const row = await sessionRow(ctx.db, sessionId)
      return row && ["done", "failed"].includes(row.status) && row.outcome ? row : undefined
    },
    { timeout, what: `${sessionId} 结束、结果定了` }
  )
}

const callsOf = (routineId: string) => ctx.db.select().from(t.routineCalls).where(eq(t.routineCalls.routineId, routineId)).orderBy(asc(t.routineCalls.id))
const entryOf = async (routineId: string) => (await ctx.db.select().from(t.routineLibrary).where(eq(t.routineLibrary.routineId, routineId)))[0]!
/** 模型看到的某次工具结果 */
const toolResultText = (script: Script, index: number) => script.promptText(index)

let ruleCounter = 0
async function addRule(taskId: string, shape: Pick<CompiledRule, "trigger" | "actions">, name: string) {
  const id = `rl-library-${++ruleCounter}`
  const compiled: CompiledRule = { v: 1, ...shape, understood: describeCompiledRule(shape) }
  await ctx.db.insert(t.rules).values({ id, name, trigger: "测试", action: "测试", compiledTrigger: compiled, compiledText: JSON.stringify({ trigger: "测试", action: "测试" }), confirmedById: "u-lin", confirmedAt: new Date() })
  const position = (await ctx.db.select().from(t.taskRules).where(eq(t.taskRules.taskId, taskId))).length
  await ctx.db.insert(t.taskRules).values({ taskId, refId: id, position })
  return id
}

const LOOKUP = `
  await ha.file.save({ path: "lib/" + input.单号 + ".txt", content: "已发货" })
  const back = await ha.file.read({ path: "lib/" + input.单号 + ".txt" })
  const 状态 = String(back).includes("已发货") ? "已发货" : "看不出来"
  await ha.work.report({ data: { 状态, 件数: 3 } })
  await ha.checkpoint.mark({ checkpoint: 1, status: "done" })
  return ha.finish({ outcome: "achieved", summary: input.单号 + " 的状态是 " + 状态, evidence: "读回来了" })`

describe("快照", () => {
  it("选了的取发布的那一版，调的库流程传递冻进来（selected = false）；停用、缺工具、缺开关、调的用不了 → unavailable", async () => {
    const inner = await publish({ body: LOOKUP, title: "里层" })
    const outer = await publish({ body: `return ha.routine("${inner.slug}", { 单号: "A" })`, title: "外层", requires: { routines: [inner.slug] } })
    const paused = await publish({ body: LOOKUP, title: "停了的", status: "paused" })
    await ctx.db.update(t.routineLibrary).set({ pausedReason: "连续 3 次跑不通" }).where(eq(t.routineLibrary.routineId, paused.routineId))
    const needsCode = await publish({ body: LOOKUP, title: "要运行代码", requires: { toolIds: ["code.run"] } })
    const needsFetch = await publish({ body: LOOKUP, title: "要调接口", requires: { browser: { fetch: true } } })
    const brokenInner = await publish({ body: LOOKUP, title: "坏的里层", status: "withdrawn" })
    const brokenOuter = await publish({ body: LOOKUP, title: "调坏的", requires: { routines: [brokenInner.slug] } })
    const taskId = await createTask(ctx.db, {
      modelId: "test/library-snapshot",
      toolIds: ["file.save", "file.read", outer.toolId, paused.toolId, needsCode.toolId, needsFetch.toolId, brokenOuter.toolId],
    })
    const snapshot = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })
    const bySlug = new Map(snapshot.libraryRoutines!.map((routine) => [routine.slug, routine]))
    expect(snapshot.libraryRoutines!.map((routine) => [routine.name, routine.selected])).toEqual([
      ["外层", true],
      ["停了的", true],
      ["要运行代码", true],
      ["要调接口", true],
      ["调坏的", true],
      ["里层", false],
      ["坏的里层", false],
    ])
    expect(bySlug.get(outer.slug)).toMatchObject({ version: 1, routineId: outer.routineId, toolId: outer.toolId })
    expect(bySlug.get(outer.slug)!.unavailable).toBeUndefined()
    expect(bySlug.get(outer.slug)!.code).toContain(`ha.routine("${inner.slug}"`)
    expect(bySlug.get(inner.slug)!.unavailable).toBeUndefined()
    expect(bySlug.get(paused.slug)!.unavailable).toBe("停用了：连续 3 次跑不通")
    expect(bySlug.get(needsCode.slug)!.unavailable).toMatch(/^任务没选「.+」$/)
    expect(bySlug.get(needsFetch.slug)!.unavailable).toBe("任务没打开「允许直接调网站接口」")
    expect(bySlug.get(brokenInner.slug)!.unavailable).toBe("撤下了")
    expect(bySlug.get(brokenOuter.slug)!.unavailable).toBe("它调的「坏的里层」用不了：撤下了")
    // 冻住以后发布新版不影响这次（快照是冻的）；没选库流程的任务快照里没有这个字段
    const plain = await buildSnapshot(ctx.db, await createTask(ctx.db, { modelId: "test/library-snapshot", toolIds: ["file.save"] }), { source: "manual", runAttachments: [] })
    expect(plain.libraryRoutines).toBeUndefined()
  })

  it("用不了的网关不给工具，系统提示「固化好的流程」一节写上用得了的和用不了的原因", async () => {
    const ok = await publish({ body: LOOKUP, title: "查状态", inputSchema: SINGLE_INPUT })
    const paused = await publish({ body: LOOKUP, title: "停了的", status: "paused" })
    const { taskId, script } = await callerTask([step(finishWith("看过了"))], ["file.save", "file.read", ok.toolId, paused.toolId])
    const sessionId = await runNow(taskId)
    await waitOutcome(sessionId)
    const prompt = script.promptText(0)
    expect(prompt).toContain("## 固化好的流程")
    expect(prompt).toContain(`routine_${ok.slug}「查状态」：要查状态时用`)
    expect(prompt).toContain("这次用不了：「停了的」（停用了）")
    const tools = (script.prompts[0]!.tools ?? []).map((each) => (each as { name: string }).name)
    expect(tools).toContain(`routine_${ok.slug}`)
    expect(tools).not.toContain(`routine_${paused.slug}`)
    // 参数名照 HTTP 工具：中文换成 p1，说明里写原名
    const schema = JSON.stringify((script.prompts[0]!.tools ?? []).find((each) => (each as { name: string }).name === `routine_${ok.slug}`))
    expect(schema).toContain('"p1"')
    expect(schema).toContain("参数名：单号")
  })
})

describe("agent 调（一次工具调用）", () => {
  it("跑完：交回值（文字 + data），每一步 trace.library；库流程的 work.report、checkpoint.mark 没写到调用方；记一行 via = tool", async () => {
    const lib = await publish({ body: LOOKUP, title: "查状态", inputSchema: SINGLE_INPUT, slug: "lookup_ok" })
    const { taskId, script } = await callerTask([step([call(lib.toolId, { p1: "A-1" }, "call-lib")]), step(finishWith("查到了"))], ["file.save", "file.read", lib.toolId])
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    const result = toolResultText(script, 1)
    expect(result).toContain("流程「查状态」第 1 版跑完了：2 步")
    expect(result).toContain("结果：办成。A-1 的状态是 已发货")
    expect(result).toContain("交回：状态=已发货，件数=3")
    const events = await eventsOf(ctx.db, sessionId)
    const inner = events.filter((event) => event.kind === "tool" && event.trace?.library)
    expect(inner.map((event) => [event.toolId, event.trace?.library])).toEqual([
      ["file.save", { routineId: lib.routineId, version: 1, step: 1, callId: "call-lib", depth: 1 }],
      ["file.read", { routineId: lib.routineId, version: 1, step: 2, callId: "call-lib", depth: 1 }],
    ])
    // 里面的步骤没有调用方脚本的步数；调库流程那一条带 libraryCall（不带 library）
    expect(inner.every((event) => !event.trace?.routineStep && !event.trace?.scriptStep)).toBe(true)
    expect(events.find((event) => event.toolId === lib.toolId)?.trace).toEqual({ libraryCall: { callId: "call-lib", routineId: lib.routineId, version: 1 } })
    expect(events.some((event) => event.toolId === "work.report" || event.toolId === "checkpoint.mark")).toBe(false)
    // 工具结果最后一行是交回值的 JSON（网页按它显示结局）
    const returned = routineReturnSchema.parse(JSON.parse(events.find((event) => event.toolId === lib.toolId)!.output!.split("\n").at(-1)!))
    expect(returned).toEqual({ routine: lib.slug, name: "查状态", version: 1, outcome: "achieved", summary: "A-1 的状态是 已发货", evidence: "读回来了", data: { 状态: "已发货", 件数: 3 } })
    expect(events.some((event) => event.title.includes("里的检查点不算"))).toBe(true)
    const [record] = await callsOf(lib.routineId)
    expect(record).toMatchObject({ sessionId, taskId, callId: "call-lib", via: "tool", depth: 1, result: "achieved", steps: 2, stopKind: null })
  })

  it("没办成不算出错；ha.fail(\"input\") → 输入有问题；参数里的文件不是这次能读的 → 当场出错、不起沙箱", async () => {
    const miss = await publish({ body: `return ha.finish({ outcome: "not_achieved", summary: "查不到", reason: "没有这个单号" })`, title: "查不到" })
    const bad = await publish({ body: `await ha.fail("input", "单号格式不对")`, title: "嫌输入不对" })
    const files = await publish({
      body: `return ha.finish({ outcome: "achieved", summary: String(input.$attachments.length), evidence: "-" })`,
      title: "收文件",
      inputSchema: { type: "object", properties: { $attachments: { type: "array" } }, required: ["$attachments"] },
    })
    const { taskId, script } = await callerTask(
      [step([call(miss.toolId, {}, "c-miss"), call(bad.toolId, {}, "c-bad"), call(files.toolId, { attachments: ["F-不存在"] }, "c-file")]), step(finishWith("看过了"))],
      ["file.save", "file.read", miss.toolId, bad.toolId, files.toolId]
    )
    const sessionId = await runNow(taskId)
    await waitOutcome(sessionId)
    const prompt = toolResultText(script, 1)
    expect(prompt).toContain("结果：没办成。查不到")
    expect(prompt).toContain("原因：没有这个单号")
    expect(prompt).toContain("输入有问题：单号格式不对（流程没改任何东西）")
    expect(prompt).toContain("文件 F-不存在 不是这次运行能读的文件")
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.find((event) => event.toolId === miss.toolId)?.title).not.toContain("出错")
    expect(events.find((event) => event.toolId === bad.toolId)?.title).toContain("出错")
    expect((await callsOf(miss.routineId)).map((each) => each.result)).toEqual(["not_achieved"])
    expect((await callsOf(bad.routineId)).map((each) => [each.result, each.stopKind])).toEqual([["bad_input", "input"]])
    expect((await callsOf(files.routineId)).map((each) => [each.result, each.stopKind, each.steps])).toEqual([["bad_input", "bad_input", 0]])
  })

  it("跑不通：交接的话写每一步、停在哪、提交做没做；agent 接着做；记 stopped、fail_streak +1", async () => {
    const lib = await publish({
      title: "存了再读",
      body: `
  await ha.file.save({ path: "lib/a.txt", content: "a" })
  await ha.commit("存第二个")
  await ha.file.save({ path: "lib/b.txt", content: "b" })
  await ha.file.read({ path: "lib/没有.txt" })
  return ha.finish({ outcome: "achieved", summary: "不该到这里", evidence: "-" })`,
    })
    const { taskId, script } = await callerTask([step([call(lib.toolId, {}, "c-stop")]), step(finishWith("自己做完了"))], ["file.save", "file.read", lib.toolId])
    const sessionId = await runNow(taskId)
    await waitOutcome(sessionId)
    const prompt = toolResultText(script, 1)
    expect(prompt).toContain("流程「存了再读」第 1 版做到第 3 步停下，没跑完（这一步出错）")
    expect(prompt).toContain("1. file.save「lib/a.txt」 ✓")
    expect(prompt).toContain("2. file.save「lib/b.txt」 ✓")
    expect(prompt).toContain("3. ✗ file.read「lib/没有.txt」")
    expect(prompt).toContain("「存第二个」已经做了，可能已经生效")
    expect(prompt).toContain("同样的输入不要再调这个流程")
    const [record] = await callsOf(lib.routineId)
    expect(record).toMatchObject({ via: "tool", result: "stopped", stopKind: "step_error", stopStep: 3, steps: 3 })
    const output = (await eventsOf(ctx.db, sessionId)).find((event) => event.toolId === lib.toolId)!.output!
    expect(routineToolStopDataSchema.parse(JSON.parse(output.split("\n").at(-1)!))).toMatchObject({
      routine: lib.slug,
      steps: 3,
      stoppedAt: { step: 3, kind: "step_error", tool: "file.read" },
      commits: [{ step: 1, label: "存第二个" }],
    })
    expect((await entryOf(lib.routineId)).failStreak).toBe(1)
  })

  it("里面一步被调用方的规则拦下 / 要审批（停在前面、不发起审批）；整个流程上的规则要审批 → 普通审批卡", async () => {
    const lib = await publish({ title: "存一个", body: `await ha.file.save({ path: "lib/x.txt", content: "x" })\n  return ha.finish({ outcome: "achieved", summary: "存了", evidence: "-" })` })
    // 拦下
    const denied = await callerTask([step([call(lib.toolId, {}, "c-deny")]), step(finishWith("看过了"))], ["file.save", "file.read", lib.toolId])
    await addRule(denied.taskId, { trigger: { type: "before_tool", toolIds: ["file.save"], risks: [] }, actions: [{ type: "deny", reason: "不许存" }] }, "不许存文件")
    const deniedSession = await runNow(denied.taskId)
    await waitOutcome(deniedSession)
    expect(toolResultText(denied.script, 1)).toContain("1. ✗ file.save「lib/x.txt」：被规则拦下")
    expect(toolResultText(denied.script, 1)).toContain("被规则拦下的这一步不要换个办法绕过去做")
    expect((await callsOf(lib.routineId)).at(-1)).toMatchObject({ result: "stopped", stopKind: "denied" })
    // 里面要审批：不发起审批
    const asked = await callerTask([step([call(lib.toolId, {}, "c-ask")]), step(finishWith("看过了"))], ["file.save", "file.read", lib.toolId])
    await addRule(asked.taskId, { trigger: { type: "before_tool", toolIds: ["file.save"], risks: [] }, actions: [{ type: "ask_human", recipient: { to: "owner" } }] }, "存文件要批")
    const askedSession = await runNow(asked.taskId)
    await waitOutcome(askedSession)
    expect(await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.sessionId, askedSession))).toHaveLength(0)
    const askedText = toolResultText(asked.script, 1)
    expect(askedText).toContain("做到第 1 步停下，没跑完（这一步要人审批）")
    expect(askedText).toContain("你单独调用这一步（file_save，会照常交给人审批）")
    const rule = (await eventsOf(ctx.db, askedSession)).find((event) => event.kind === "rule")
    expect(rule?.title).toBe(`规则「存文件要批」：流程「存一个」的第 1 步 存文件 要人审批，没做`)
    expect(rule?.trace).toEqual({ library: { routineId: lib.routineId, version: 1, step: 1, callId: "c-ask", depth: 1 } })
    expect((await callsOf(lib.routineId)).at(-1)).toMatchObject({ result: "stopped", stopKind: "approval", stopStep: 1 })
    // 整个流程上的规则：普通审批卡
    const whole = await callerTask([step([call(lib.toolId, {}, "c-whole")])], ["file.save", "file.read", lib.toolId])
    await addRule(whole.taskId, { trigger: { type: "before_tool", toolIds: [lib.toolId], risks: [] }, actions: [{ type: "ask_human", recipient: { to: "owner" } }] }, "调流程要批")
    const wholeSession = await runNow(whole.taskId)
    await waitFor(async () => ((await sessionRow(ctx.db, wholeSession))?.status === "needs_human" ? true : undefined), { what: "等审批" })
    const [item] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.sessionId, wholeSession))
    expect(item).toMatchObject({ kind: "approval" })
    expect(item!.detail.toolCall).toMatchObject({ toolId: lib.toolId })
    await mutate(ctx.app, "engine.cancel", wang, { sessionId: wholeSession })
    // 规则拦下、要审批都不算跑不通
    expect((await entryOf(lib.routineId)).failStreak).toBe(0)
  })

  it("里面要挂起（session.wait）→ 运行挂起，等到了 agent 接着做（库流程不接着跑）；次数上限", async () => {
    const lib = await publish({
      title: "存了再等",
      requires: { toolIds: ["file.save", "session.wait"] },
      body: `
  await ha.file.save({ path: "lib/a.txt", content: "a" })
  await ha.tool("session.wait", { what: "等一会儿", afterMinutes: 0.05 })
  await ha.file.save({ path: "lib/b.txt", content: "b" })
  return ha.finish({ outcome: "achieved", summary: "不该到这里", evidence: "-" })`,
    })
    const { taskId, script } = await callerTask([step([call(lib.toolId, {}, "c-wait")]), step(finishWith("等完了"))], ["file.save", "file.read", "session.wait", lib.toolId])
    const sessionId = await runNow(taskId)
    await waitFor(async () => ((await sessionRow(ctx.db, sessionId))?.status === "waiting" ? true : undefined), { what: "挂起" })
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(2)
    expect(toolResultText(script, 1)).toContain("运行要挂起等人处理；处理好以后流程不会接着跑")
    expect(await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.path, "lib/b.txt")))).toHaveLength(0)
    expect((await callsOf(lib.routineId)).at(-1)).toMatchObject({ result: "stopped", stopKind: "suspend", stopStep: 2 })

    // 次数上限
    const loop = await publish({ title: "一直存", body: `for (let i = 0; i < 10; i++) await ha.file.save({ path: "lib/" + i + ".txt", content: "x" })` })
    const limited = await callerTask([step([call(loop.toolId, {}, "c-limit")]), step(finishWith("看过了"))], ["file.save", "file.read", loop.toolId])
    const saved = routineLimits.maxCalls
    configureRoutineRuntime({ maxCalls: 3 })
    try {
      const limitedSession = await runNow(limited.taskId)
      await waitOutcome(limitedSession)
    } finally {
      configureRoutineRuntime({ maxCalls: saved })
    }
    expect(toolResultText(limited.script, 1)).toContain("没跑完（调用次数到了上限）")
    expect((await callsOf(loop.routineId)).at(-1)).toMatchObject({ result: "stopped", stopKind: "limit", steps: 3 })
  })
})

describe("脚本调（ha.routine）", () => {
  /** 一个带固化流程（先跑脚本）的调用方任务 */
  async function scriptCaller(body: string, toolIds: string[], turns: ConstructorParameters<typeof Script>[0] = []) {
    const made = await callerTask(turns, toolIds)
    const routine = await createRoutine(ctx.db, made.taskId, { code: routineCode(body), name: "调用方的流程", status: "active" })
    return { ...made, ...routine }
  }

  it("固化脚本里 ha.routine 跑通：交回值能用；里面的步骤同时有 routineStep 和 library；进入、出来记过程、调用记录 via = script；记进重放日志", async () => {
    const lib = await publish({ body: LOOKUP, title: "查状态", inputSchema: SINGLE_INPUT })
    const { taskId, script } = await scriptCaller(
      `
  const r = await ha.routine("${lib.slug}", { 单号: "B-2" })
  await ha.file.save({ path: "out/结果.txt", content: r.data.状态 + "/" + r.outcome + "/" + r.version })
  return ha.finish({ outcome: "achieved", summary: r.summary, evidence: "看了" })`,
      ["file.save", "file.read", lib.toolId]
    )
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(0)
    expect(row.routine).toMatchObject({ state: "finished", steps: 5 })
    const events = await eventsOf(ctx.db, sessionId)
    const tools = events.filter((event) => event.kind === "tool")
    expect(tools.map((event) => [event.toolId, event.trace?.routineStep, event.trace?.library?.step ?? null, event.trace?.libraryCall?.callId ?? null])).toEqual([
      [lib.toolId, 1, null, `${sessionId}-r1`],
      ["file.save", 2, 1, null],
      ["file.read", 3, 2, null],
      ["file.save", 4, null, null],
      ["run.finish", 5, null, null],
    ])
    expect(tools[0]!.output).toBe("开始跑流程「查状态」第 1 版")
    expect(tools[1]!.trace?.library).toEqual({ routineId: lib.routineId, version: 1, step: 1, callId: `${sessionId}-r1`, depth: 1 })
    const ended = events.find((event) => event.title.startsWith("流程「查状态」跑完"))
    expect(ended?.title).toMatch(/^流程「查状态」跑完：2 步 · .+ 秒 · 交回 状态=已发货，件数=3$/)
    expect(ended?.trace).toEqual({ libraryCall: { callId: `${sessionId}-r1`, routineId: lib.routineId, version: 1 } })
    const [file] = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.path, "out/结果.txt")))
    expect(file).toBeTruthy()
    const journal = await ctx.db.select().from(t.routineJournal).where(eq(t.routineJournal.sessionId, sessionId)).orderBy(t.routineJournal.seq)
    expect(journal.map((each) => [each.op, each.tool])).toEqual([
      ["tool", lib.toolId],
      ["tool", "file.save"],
      ["tool", "file.read"],
      ["log", null],
      ["routine_end", null],
      ["tool", "file.save"],
      ["tool", "run.finish"],
    ])
    expect(journal[0]!.reply).toMatchObject({ ok: true, data: { slug: lib.slug, version: 1, module: `routines/${lib.slug}.mjs`, depth: 1, input: { 单号: "B-2" } } })
    expect(await callsOf(lib.routineId)).toMatchObject([{ callId: `${sessionId}-r1`, via: "script", depth: 1, result: "achieved", steps: 2 }])
  })

  it("里面没接住的错抛到外面：调用方停在那一步，交接的话写「第 k 步（流程『…』第 j 步）」；输入不对、没选的、ha.tool 调都报错；RoutineFailed 能接住", async () => {
    const lib = await publish({ title: "会出错", body: `await ha.file.read({ path: "没有.txt" })\n  return ha.finish({ outcome: "achieved", summary: "-", evidence: "-" })` })
    const strict = await publish({ title: "要单号", body: LOOKUP, inputSchema: SINGLE_INPUT })
    const failing = await publish({ title: "页面不对", body: `await ha.fail("page", "找不到查询按钮")` })
    const notChosen = await publish({ title: "没选的", body: LOOKUP })
    const { taskId, script } = await scriptCaller(
      `
  for (const attempt of [
    () => ha.routine("${strict.slug}", { 单号: 3 }),
    () => ha.routine("${notChosen.slug}", {}),
    () => ha.tool("routine.${strict.slug}", { 单号: "A" }),
  ]) {
    try { await attempt() } catch (error) { await ha.log(error.name + "：" + error.message) }
  }
  try { await ha.routine("${failing.slug}", {}) } catch (error) { await ha.log(error.name + "/" + error.kind + "/" + error.routine + "：" + error.message) }
  await ha.routine("${lib.slug}", {})
  return ha.finish({ outcome: "achieved", summary: "不该到这里", evidence: "-" })`,
      ["file.save", "file.read", lib.toolId, strict.toolId, failing.toolId],
      [step(finishWith("自己做完了"))]
    )
    const sessionId = await runNow(taskId)
    const row = await waitOutcome(sessionId)
    expect(row.routine?.logs).toEqual([
      expect.stringContaining("StepError：输入不符合流程「要单号」的要求：单号"),
      `StepError：任务没选流程「routine.${notChosen.slug}」：库里的流程要在任务的「流程」里选上才能调`,
      `StepError：脚本里不能用 ha.tool 调流程库里的流程：用 ha.routine("${strict.slug}", 输入)`,
      `RoutineFailed/page/${failing.slug}：找不到查询按钮`,
    ])
    expect(row.routine).toMatchObject({ state: "fell_back", stoppedAt: { step: 3, kind: "step_error" } })
    const prompt = script.promptText(0)
    expect(prompt).toContain("3. ✗ file.read「没有.txt」")
    expect(row.routine!.stoppedAt!.label).toBe("file.read「没有.txt」（流程「会出错」第 1 步）")
    expect((await callsOf(strict.routineId)).map((each) => [each.result, each.stopKind])).toEqual([["bad_input", "bad_input"]])
    expect((await callsOf(failing.routineId)).map((each) => [each.result, each.stopKind, each.via])).toEqual([["stopped", "page", "script"]])
    expect((await callsOf(lib.routineId)).map((each) => [each.result, each.stopKind, each.stopStep])).toEqual([["stopped", "step_error", 1]])
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.some((event) => event.title.startsWith("流程「会出错」没跑完，停在第 1 步"))).toBe(true)
  })

  it("里面一步要审批：停下等人（审批卡写库流程第几步）→ 批准 → 按日志接着跑（进入、里面的步骤都跳过），调用记录只有一行", async () => {
    const lib = await publish({ title: "付款", body: `await ha.file.read({ path: "没有.txt" }).catch(() => null)\n  await ha.file.save({ path: "lib/付款.txt", content: "100" })\n  return ha.finish({ outcome: "achieved", summary: "付了", evidence: "-" })` })
    const { taskId, script } = await scriptCaller(
      `
  const r = await ha.routine("${lib.slug}", {})
  return ha.finish({ outcome: "achieved", summary: r.summary, evidence: "-" })`,
      ["file.save", "file.read", lib.toolId]
    )
    await addRule(taskId, { trigger: { type: "before_tool", toolIds: ["file.save"], risks: [] }, actions: [{ type: "ask_human", recipient: { to: "owner" } }] }, "存文件要批")
    const sessionId = await runNow(taskId)
    await waitFor(async () => ((await sessionRow(ctx.db, sessionId))?.status === "needs_human" ? true : undefined), { what: "等审批" })
    const [item] = await ctx.db.select().from(t.humanItems).where(and(eq(t.humanItems.sessionId, sessionId), eq(t.humanItems.status, "open")))
    expect(item!.title).toContain("固化流程「调用方的流程」第 3 步（流程「付款」第 2 步）")
    expect((await callsOf(lib.routineId)).map((each) => [each.result, each.stopKind])).toEqual([["stopped", "approval"]])
    await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: item!.id, how: "approve", note: "可以" })
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(script.prompts).toHaveLength(0)
    expect(row.routine).toMatchObject({ state: "finished", resumes: 1, replayed: 2 })
    expect(await callsOf(lib.routineId)).toMatchObject([{ result: "achieved", steps: 2, callId: `${sessionId}-r1` }])
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.filter((event) => event.title.startsWith("流程「付款」跑完"))).toHaveLength(1)
    expect(events.filter((event) => event.kind === "tool" && event.toolId === lib.toolId)).toHaveLength(1)
  })

  it("试跑停在库流程里的第一个提交（进入放行）；试跑不记调用记录", async () => {
    const lib = await publish({ title: "带提交", risk: "write", body: `await ha.file.save({ path: "lib/a.txt", content: "a" })\n  await ha.commit("保存")\n  await ha.file.save({ path: "lib/b.txt", content: "b" })\n  return ha.finish({ outcome: "achieved", summary: "-", evidence: "-" })` })
    const made = await callerTask([], ["file.save", "file.read", lib.toolId])
    const { versionId } = await createRoutine(ctx.db, made.taskId, { versionStatus: "testing", code: routineCode(`await ha.routine("${lib.slug}", {})\n  return ha.finish({ outcome: "achieved", summary: "-", evidence: "-" })`) })
    const { sessionId } = await startSessionImpl(ctx.db, { taskId: made.taskId, source: "manual", actorId: "u-wang", routineTest: { versionId, round: 1, input: {}, attachments: [] } })
    const row = await waitFor(async () => {
      const current = await sessionRow(ctx.db, sessionId)
      return current?.status === "done" ? current : undefined
    }, { what: "试跑结束" })
    expect(row.routine).toMatchObject({ state: "stopped", stoppedAt: { kind: "test_commit", label: "流程「带提交」：保存" } })
    const files = await ctx.db.select({ path: t.files.path }).from(t.files).where(eq(t.files.sessionId, sessionId))
    expect(files.map((file) => file.path)).toEqual(["lib/a.txt"])
    expect(await callsOf(lib.routineId)).toHaveLength(0)
  })

  it("code.run（tools）循环调 ha.routine；两层能跑、三层和绕圈报错", async () => {
    const leaf = await publish({ title: "叶子", body: `await ha.file.save({ path: "lib/leaf-" + input.n + ".txt", content: "x" })\n  return ha.finish({ outcome: "achieved", summary: "叶子 " + input.n, evidence: "-" })` })
    const middle = await publish({
      title: "中间",
      requires: { routines: [leaf.slug] },
      body: `const r = await ha.routine("${leaf.slug}", { n: input.n })\n  await ha.work.report({ data: { 叶子: r.summary } })\n  return ha.finish({ outcome: "achieved", summary: "中间 " + input.n, evidence: "-" })`,
    })
    const deep = await publish({ title: "太深", requires: { routines: [middle.slug] }, body: `await ha.routine("${middle.slug}", { n: 9 })\n  return ha.finish({ outcome: "achieved", summary: "-", evidence: "-" })` })
    // 绕圈：loop_a 调 loop_b，loop_b 调 loop_a（发布时会拦，这里直接造）
    const loopA = await publish({ title: "圈 A", slug: `loop_a_${slugCounter}`, body: `await ha.routine("loop_b_${slugCounter}", {})\n  return ha.finish({ outcome: "achieved", summary: "-", evidence: "-" })` })
    const loopB = await publish({ title: "圈 B", slug: `loop_b_${slugCounter - 1}`, body: `await ha.routine("${loopA.slug}", {})\n  return ha.finish({ outcome: "achieved", summary: "-", evidence: "-" })` })
    await ctx.db.update(t.routineLibrary).set({ requires: { toolIds: ["file.save"], browser: {}, routines: [loopB.slug] } }).where(eq(t.routineLibrary.routineId, loopA.routineId))
    await ctx.db.update(t.routineLibrary).set({ requires: { toolIds: ["file.save"], browser: {}, routines: [loopA.slug] } }).where(eq(t.routineLibrary.routineId, loopB.routineId))
    await ctx.db.update(t.routineVersions).set({ code: routineCode(`await ha.routine("${loopB.slug}", {})\n  return ha.finish({ outcome: "achieved", summary: "-", evidence: "-" })`) }).where(eq(t.routineVersions.routineId, loopA.routineId))
    const SCRIPT = `import ha from "heyagent"
for (let n = 1; n <= 3; n++) {
  const r = await ha.routine("${middle.slug}", { n })
  console.log(r.summary + " / " + r.data.叶子)
}
for (const slug of ["${deep.slug}", "${loopA.slug}"]) {
  try { await ha.routine(slug, {}) } catch (error) { console.log(slug + " → " + error.name + "：" + error.message) }
}`
    const { taskId, script } = await callerTask(
      [step([call("code.run", { language: "node", tools: true, code: SCRIPT, timeout: 60 }, "c-loop")]), step(finishWith("循环完了"))],
      ["code.run", "file.save", "file.read", middle.toolId, deep.toolId, loopA.toolId]
    )
    const sessionId = await runNow(taskId)
    await waitOutcome(sessionId, 60_000)
    const output = (await eventsOf(ctx.db, sessionId)).find((event) => event.toolId === "code.run")?.output ?? ""
    expect(output).toContain("中间 1 / 叶子 1")
    expect(output).toContain("中间 3 / 叶子 3")
    expect(output).toContain(`${deep.slug} → StepError：最多 2 层`)
    expect(output).toContain(`${loopA.slug} → StepError：不许绕圈`)
    expect(script.prompts).toHaveLength(2)
    expect((await callsOf(middle.routineId)).filter((each) => each.result === "achieved")).toHaveLength(3)
    expect((await callsOf(leaf.routineId)).map((each) => [each.depth, each.via, each.result])).toEqual([
      [2, "script", "achieved"],
      [2, "script", "achieved"],
      [2, "script", "achieved"],
    ])
    // 第二层的步骤：callId 是进入叶子那一步的调用 id、depth 2；叶子的进入是中间的一步（带中间的 library）
    const events = await eventsOf(ctx.db, sessionId)
    const leafSave = events.find((event) => event.toolId === "file.save" && event.trace?.library?.depth === 2)!
    const leafEnter = events.find((event) => event.toolId === leaf.toolId && event.trace?.libraryCall?.callId === leafSave.trace!.library!.callId)!
    expect(leafEnter.trace).toMatchObject({ scriptCallId: "c-loop", library: { routineId: middle.routineId, step: 1, depth: 1 } })
  })
})

describe("成绩、自动停用", () => {
  it("fail_streak 只算那五种；报了结果清零；满 3 次自动停用、写清原因、通知；旧版本的不算", async () => {
    const lib = await publish({ title: "成绩", body: LOOKUP })
    const { taskId } = await callerTask([step(finishWith("没调"))], ["file.save"])
    const session = { id: await runNow(taskId) }
    await waitOutcome(session.id)
    const base = { routineId: lib.routineId, version: 1, sessionId: session.id, taskId, via: "tool" as const, depth: 1, steps: 2, ms: 100 }
    const streak = async () => (await entryOf(lib.routineId)).failStreak
    await recordRoutineCall(ctx.db, { ...base, callId: "a", result: "stopped", stopKind: "step_error", stopStep: 2, stopReason: "找不到" })
    expect(await streak()).toBe(1)
    await recordRoutineCall(ctx.db, { ...base, callId: "b", result: "stopped", stopKind: "denied", stopReason: "拦下" })
    await recordRoutineCall(ctx.db, { ...base, callId: "c", result: "stopped", stopKind: "approval" })
    await recordRoutineCall(ctx.db, { ...base, callId: "d", result: "bad_input", stopKind: "input" })
    expect(await streak()).toBe(1)
    await recordRoutineCall(ctx.db, { ...base, callId: "e", result: "not_achieved" })
    expect(await streak()).toBe(0)
    // 旧版本的跑不通不算
    await recordRoutineCall(ctx.db, { ...base, version: 0, callId: "f", result: "stopped", stopKind: "page" })
    expect(await streak()).toBe(0)
    // 同一个调用 id 再记是覆盖
    await recordRoutineCall(ctx.db, { ...base, callId: "g", result: "stopped", stopKind: "page", stopStep: 1, stopReason: "页面不对" })
    await recordRoutineCall(ctx.db, { ...base, callId: "h", result: "stopped", stopKind: "timeout", stopStep: 3, stopReason: "超时" })
    const third = await recordRoutineCall(ctx.db, { ...base, callId: "i", result: "stopped", stopKind: "script_error", stopStep: 2, stopReason: "脚本出错" })
    expect(third).toEqual({ autoPaused: true })
    const entry = await entryOf(lib.routineId)
    expect(entry).toMatchObject({ status: "paused", failStreak: 3 })
    expect(entry.pausedReason).toContain("自动停用：第 1 版连续 3 次跑不通")
    expect(entry.pausedReason).toContain("停在第 2 步（脚本出错）：脚本出错")
    expect(entry.pausedReason).toContain("停在第 1 步（页面和预期不一样）：页面不对")
    const notes = await ctx.db.select().from(t.notifications).where(eq(t.notifications.title, `流程库：「${lib.title}」自动停用了`))
    expect(new Set(notes.map((note) => note.userId))).toEqual(new Set(["u-wang", "u-lin"]))
    const [audit] = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.action, "routine.library.auto_pause"), eq(t.auditEvents.targetId, lib.routineId)))
    expect(audit).toBeTruthy()
    await recordRoutineCall(ctx.db, { ...base, callId: "i", result: "achieved" })
    expect((await callsOf(lib.routineId)).filter((each) => each.callId === "i").map((each) => each.result)).toEqual(["achieved"])
    expect(await streak()).toBe(0)
  })
})

describe("复核的过程记录", () => {
  it("库流程里的步骤每次调用只留最近 3 步，前面的压成一行；调库流程那一条照常列", () => {
    let seq = 0
    const row = (toolId: string, trace?: Record<string, unknown>) =>
      ({ sessionId: "S", seq: ++seq, at: new Date(), kind: "tool", title: toolId, detail: null, toolId, input: "{}", output: "做完了", ms: 1, tokensIn: null, tokensOut: null, trace: trace ?? null }) as never
    const library = (step: number) => ({ library: { routineId: "RT-9", version: 2, step, callId: "c1", depth: 1 } })
    const events = [row("file.save", library(1)), row("file.save", library(2)), row("file.save", library(3)), row("file.save", library(4)), row("file.read", library(5)), row("routine.x", { libraryCall: { callId: "c1", routineId: "RT-9", version: 2 } })]
    const log = reviewLog(events, { recent: 30, budget: 12_000 })
    expect(log.lines).toHaveLength(5)
    expect(log.lines[0]).toBe("- 库流程 RT-9 第 2 版（这次调用 c1）：前 2 步（2 条记录）省略，下面是最近的几步，跑完的结果见调用它的那一条")
    expect(log.lines[1]).toContain("#3 调用 file.save（file.save）（库流程 RT-9 第 3 步）")
    expect(log.lines[4]).toContain("（调库流程）")
    expect(log.tools).toBe(6)
  })
})

describe("子 agent（docs/dev/sub-agents.md 5.1）", () => {
  it("子运行从父快照抄库流程：父选了的子 agent 能用 routine.<短名> 调到；要的工具子 agent 没有的（和调了它的）标用不了", async () => {
    const lib = await publish({ body: LOOKUP, title: "子 agent 查状态", inputSchema: SINGLE_INPUT })
    // 要「派活」：父运行用得了，子 agent 没有派活（SUBAGENT_DROPPED_TOOL_IDS）
    const needsDispatch = await publish({ body: LOOKUP, title: "要派活的", requires: { toolIds: ["file.save", "work.dispatch"] } })
    const callsDispatch = await publish({ body: `return ha.routine("${needsDispatch.slug}", { 单号: "A" })`, title: "调要派活的", requires: { routines: [needsDispatch.slug] } })
    const childModel = `test/library-sub-child-${++modelCounter}`
    const child = useScript(childModel, new Script([step([call(lib.toolId, { p1: "S-1" }, "call-sub-lib")]), step(finishWith("子 agent 查到了"))]))
    const parentModel = `test/library-sub-parent-${++modelCounter}`
    useScript(
      parentModel,
      new Script([
        step([call("subagent.start", { items: [{ title: "查一个单", goal: "用固化好的流程查 S-1 的状态" }] })]),
        step([call("subagent.wait", {})]),
        step(finishWith("汇总好了")),
      ])
    )
    const taskId = await createTask(ctx.db, {
      modelId: parentModel,
      toolIds: ["subagent.start", "work.dispatch", "file.save", "file.read", lib.toolId, needsDispatch.toolId, callsDispatch.toolId],
    })
    await ctx.db.update(t.tasks).set({ subagentModelId: childModel }).where(eq(t.tasks.id, taskId))
    const sessionId = await runNow(taskId)
    await waitOutcome(sessionId)
    const childId = `${sessionId}.1`
    const childRow = (await sessionRow(ctx.db, childId))!
    expect(childRow).toMatchObject({ kind: "sub", status: "done", outcome: "achieved" })

    // 父快照：三个都用得了；子快照：同样三个、selected 照抄，要派活的和调它的标用不了
    const parentRoutines = (await sessionRow(ctx.db, sessionId))!.snapshot!.libraryRoutines!
    expect(parentRoutines.filter((routine) => routine.unavailable)).toEqual([])
    const bySlug = new Map(childRow.snapshot!.libraryRoutines!.map((routine) => [routine.slug, routine]))
    expect(childRow.snapshot!.libraryRoutines!.map((routine) => [routine.slug, routine.selected])).toEqual(parentRoutines.map((routine) => [routine.slug, routine.selected]))
    expect(bySlug.get(lib.slug)!.unavailable).toBeUndefined()
    expect(bySlug.get(needsDispatch.slug)!.unavailable).toBe("子 agent 不能用要的工具「派活」")
    expect(bySlug.get(callsDispatch.slug)!.unavailable).toBe("它调的「要派活的」用不了：子 agent 不能用要的工具「派活」")

    // 子 agent 的模型看到的：用得了的给工具，用不了的不给、系统提示写原因
    const tools = (child.prompts[0]!.tools ?? []).map((each) => (each as { name: string }).name)
    expect(tools).toContain(`routine_${lib.slug}`)
    expect(tools).not.toContain(`routine_${needsDispatch.slug}`)
    expect(tools).not.toContain(`routine_${callsDispatch.slug}`)
    const prompt = child.promptText(0)
    expect(prompt).toContain(`routine_${lib.slug}「子 agent 查状态」`)
    expect(prompt).toContain("这次用不了：「要派活的」（子 agent 不能用要的工具「派活」）")

    // 调到了：交回值、库流程里的步骤记在子运行上、调用记录记子运行
    expect(child.promptText(1)).toContain("流程「子 agent 查状态」第 1 版跑完了：2 步")
    const inner = (await eventsOf(ctx.db, childId)).filter((event) => event.kind === "tool" && event.trace?.library)
    expect(inner.map((event) => event.toolId)).toEqual(["file.save", "file.read"])
    const [record] = await callsOf(lib.routineId)
    expect(record).toMatchObject({ sessionId: childId, taskId, callId: "call-sub-lib", via: "tool", depth: 1, result: "achieved" })
  })
})

describe("会改东西的接口请求（不连浏览器：假网关 + 真 SDK）", () => {
  /** 假网关：browser.fetch 回 200；进入库流程（inline）只回一句 */
  class FetchGateway implements BridgeGateway {
    readonly calls: { name: string; library?: unknown; inline?: boolean }[] = []
    async call(modelCall: ModelToolCall, options: { library?: unknown; inline?: boolean }): Promise<GatewayResult> {
      this.calls.push({ name: modelCall.toolName, library: options.library, inline: options.inline })
      const output = options.inline ? "开始跑流程" : `${modelCall.toolName} 做完了`
      return { toolId: modelCall.toolName, toolName: modelCall.toolName, outcome: { output, data: { status: 200 } }, output, denied: false }
    }
    async stillRunning() {
      return true
    }
    toolInfo(toolName: string) {
      return { id: toolName, risk: "external" as const }
    }
    async screenshot() {
      return undefined
    }
  }

  const libraryOf = (slug: string, body: string): LibraryRoutineSnapshot => ({
    routineId: `RT-${slug}`,
    slug,
    toolId: `routine.${slug}`,
    name: slug,
    summary: "-",
    version: 1,
    versionId: `RT-${slug}-v1`,
    description: "",
    code: routineCode(body),
    inputSchema: {},
    outputSchema: {},
    commits: [],
    requires: { toolIds: ["browser"], browser: { fetch: true }, routines: [] },
    risk: "external",
    selected: true,
  })

  /** mode = agent（agent 的脚本调 ha.routine）或 tool（agent 调库流程，root 是 routine.mjs） */
  async function run(mode: "agent" | "tool", main: string, routines: LibraryRoutineSnapshot[]) {
    const root = await mkdtemp(join(tmpdir(), "heyagent-library-fetch-"))
    const codeDir = join(root, "code")
    const toolsDir = join(root, "t")
    await mkdir(join(codeDir, "node_modules"), { recursive: true })
    await mkdir(join(codeDir, "routines"), { recursive: true })
    await mkdir(toolsDir, { recursive: true })
    await cp(SDK_DIR, join(codeDir, "node_modules", "heyagent"), { recursive: true })
    for (const routine of routines) await writeFile(join(codeDir, "routines", `${routine.slug}.mjs`), routine.code)
    if (mode === "tool") await writeFile(join(codeDir, "routine.mjs"), routines[0]!.code)
    else await writeFile(join(codeDir, "main.mjs"), main)
    const gateway = new FetchGateway()
    const state: SessionRoutineState = { routineId: "", versionId: "", version: 0, mode: "run", state: "running", startedAt: new Date().toISOString(), steps: 0, commits: [] }
    const bridge = await ToolBridge.listen(join(toolsDir, TOOLS_SOCKET_NAME), {
      sessionId: "S-F",
      gateway,
      state,
      mode,
      ...(mode === "agent" ? { scriptCallId: "c-agent" } : {}),
      trial: false,
      maxCalls: 100,
      save: async () => {},
      event: async () => {},
      library: { routines, ...(mode === "tool" ? { root: { routine: routines[0]!, callId: "c-tool" } } : {}) },
    })
    const result = await directNodeRunner({
      language: "node",
      script: mode === "tool" ? LAUNCH_SCRIPT : `${SANDBOX_CODE_DIR}/node_modules/heyagent/agent-launch.js`,
      args: mode === "tool" ? [] : [`${SANDBOX_CODE_DIR}/main.mjs`],
      stdin: mode === "tool" ? JSON.stringify({ input: {}, library: { slug: routines[0]!.slug } }) : "",
      timeoutSec: 30,
      workspaceDir: root,
      homeDir: root,
      codeDir,
      toolsDir,
      readonlyDirs: [],
      config: {} as never,
    })
    await bridge.idle()
    await bridge.close()
    await rm(root, { recursive: true, force: true })
    return { bridge, gateway, result }
  }

  const POST = `await ha.browser.fetch({ url: "https://erp.example.com/api/save", method: "POST" })`

  it("agent 自己写的那一层不要求；嵌在 agent 脚本里的库流程要自己的 ha.commit，没有就停（script_error）", async () => {
    const lib = libraryOf("post_no_commit", `${POST}\n  return ha.finish({ outcome: "achieved", summary: "-", evidence: "-" })`)
    const { bridge, gateway, result } = await run(
      "agent",
      `import ha from "heyagent"
${POST}
try { await ha.routine("post_no_commit", {}) } catch (error) { console.log(error.name) }`,
      [lib]
    )
    expect(result.stdout.text).toContain("RoutineStop")
    expect(gateway.calls.map((each) => [each.name, each.inline ?? false])).toEqual([
      ["browser.fetch", false],
      ["routine.post_no_commit", true],
    ])
    expect(bridge.stopped).toMatchObject({ kind: "script_error", step: 3, label: "fetch「POST /api/save」（流程「post_no_commit」第 1 步）" })
  })

  it("agent 调库流程（mode = tool）：前面有 ha.commit 的放行，第二个请求没有新的提交就停；报的结果放在 done.routine", async () => {
    const ok = libraryOf("post_ok", `await ha.commit("保存")\n  ${POST}\n  await ha.work.report({ data: { 号: "X-1" } })\n  return ha.finish({ outcome: "achieved", summary: "存了", evidence: "-" })`)
    const first = await run("tool", "", [ok])
    expect(first.bridge.stopped).toBeUndefined()
    expect(first.bridge.done?.routine).toMatchObject({ end: "finished", finish: { outcome: "achieved", summary: "存了" }, data: { 号: "X-1" } })
    expect(first.gateway.calls).toEqual([{ name: "browser.fetch", library: { routineId: "RT-post_ok", version: 1, step: 1, callId: "c-tool", depth: 1 }, inline: undefined }])
    const twice = libraryOf("post_twice", `await ha.commit("保存")\n  ${POST}\n  ${POST}\n  return ha.finish({ outcome: "achieved", summary: "-", evidence: "-" })`)
    const second = await run("tool", "", [twice])
    expect(second.bridge.stopped).toMatchObject({ kind: "script_error", step: 2 })
    expect(second.bridge.state.commits).toEqual([{ step: 0, label: "保存" }])
  })
})

describe("试用期", () => {
  it("调用方的固化流程在试用期：库流程里的 ha.commit 照样先截图存证（标签前面写流程）", async () => {
    const lib = await publish({ title: "带提交的", body: `await ha.commit("保存")\n  await ha.file.save({ path: "lib/t.txt", content: "t" })\n  return ha.finish({ outcome: "achieved", summary: "存了", evidence: "-" })` })
    const made = await callerTask([], ["file.save", "file.read", lib.toolId])
    await createRoutine(ctx.db, made.taskId, { code: routineCode(`const r = await ha.routine("${lib.slug}", {})\n  return ha.finish({ outcome: "achieved", summary: r.summary, evidence: "-" })`), status: "trial" })
    const sessionId = await runNow(made.taskId)
    const row = await waitOutcome(sessionId)
    expect(row.outcome).toBe("achieved")
    expect(row.routine?.commits).toEqual([{ step: 1, label: "流程「带提交的」：保存" }])
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.some((event) => event.title === "提交前截图：流程「带提交的」：保存")).toBe(true)
  })
})
