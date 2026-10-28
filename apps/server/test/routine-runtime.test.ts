// 固化的运行时（docs/dev/solidify.md 15.2）：不连库的部分。
// - 工具桥协议：真的 SDK（apps/server/sandbox-sdk/heyagent）用本机 node 跑（不带 bwrap），对面是假网关；
// - 定位的 JS 写法解析成调用链；录下的代码从 MCP 输出里拿掉；交接的话。
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { Risk, SessionRoutineState } from "@heyagent/shared"
import { afterAll, describe, expect, it } from "vitest"

import { parseLocatorChain } from "../src/browser/extract.js"
import { takeCode } from "../src/browser/tools.js"
import type { GatewayResult, ModelToolCall } from "../src/engine/gateway.js"
import type { EventInput } from "../src/engine/records.js"
import type { ToolOutcome } from "../src/engine/tools/builtin.js"
import { shanghaiNow, ToolBridge, type BridgeGateway, type BridgeJournal, type JournalRow } from "../src/routine/runtime/bridge.js"
import { commitLines, handoffText } from "../src/routine/runtime/handoff.js"
import { LAUNCH_SCRIPT, SDK_DIR } from "../src/routine/runtime/run.js"
import { TOOLS_SOCKET_NAME } from "../src/sandbox/runner.js"
import { directNodeRunner, routineCode } from "./routine-helpers.js"

const dirs: string[] = []
afterAll(async () => {
  for (const dir of dirs) await rm(dir, { recursive: true, force: true })
})

/** 假网关：按工具 id 给结果，记下每次调用 */
class FakeGateway implements BridgeGateway {
  readonly calls: { call: ModelToolCall; routineStep?: number }[] = []
  running = true
  shots = 0
  private readonly risks: Record<string, Risk> = { "http.ext": "external", "http.read": "read" }

  async call(call: ModelToolCall, options: { routineStep?: number; approvedRuleIds?: readonly string[] }): Promise<GatewayResult> {
    this.calls.push({ call, routineStep: options.routineStep })
    const input = (call.input ?? {}) as Record<string, unknown>
    const done = (outcome: ToolOutcome, extra: Partial<GatewayResult> = {}): GatewayResult => ({
      toolId: call.toolName,
      toolName: call.toolName,
      outcome,
      output: outcome.output,
      denied: false,
      ...extra,
    })
    switch (call.toolName) {
      case "browser.navigate":
        return done({ output: `打开了 ${String(input.url)}` })
      case "browser.wait_any":
        return done({ output: "等到了「found」（0.1 秒）。", data: { matched: "found" } })
      case "browser.extract":
        return done({ output: "| # | 状态 |", data: { rows: [{ 状态: "已发货" }], total: 1 } })
      case "browser.click":
        return input.target === "missing"
          ? done({ output: "工具出错：选择器没找到元素", isError: true })
          : done({ output: "点了" })
      case "danger.tool":
        return done({ output: "被拦下：规则不让", isError: true }, { denied: true })
      case "approve.tool":
        return done({ output: "", isError: true }, { approval: { ruleId: "r1", ruleName: "付钱要审批", assigneeId: "u-wang", reason: "要花钱。", input } })
      case "wait.tool":
        return done({ output: "检测到登录页：要登录。已交给负责人", suspend: { kind: "wait", input: { what: "等", triggerKind: "time", at: new Date() } as never } })
      case "run.finish":
        return done({ output: "已记下", finish: { outcome: "achieved", summary: String(input.summary), evidence: String(input.evidence), via: "finish" } })
      default:
        return done({ output: `${call.toolName} 做完了` })
    }
  }

  async stillRunning() {
    return this.running
  }

  toolInfo(toolName: string) {
    return { id: toolName, risk: this.risks[toolName] ?? (toolName.startsWith("browser.") ? "external" : "write") }
  }

  async screenshot() {
    this.shots++
    return { fileId: `f-shot-${this.shots}` }
  }
}

/** 准备代码目录（routine.mjs + SDK），起工具桥，用本机 node 跑 launch.js */
async function runScript(
  body: string,
  options: { mode?: "run" | "test"; trial?: boolean; maxCalls?: number; gateway?: FakeGateway; input?: Record<string, unknown>; journal?: BridgeJournal; approvedRuleIds?: string[] } = {}
) {
  const root = await mkdtemp(join(tmpdir(), "heyagent-routine-"))
  dirs.push(root)
  const codeDir = join(root, "code")
  const toolsDir = join(root, "t")
  await mkdir(join(codeDir, "node_modules"), { recursive: true })
  await mkdir(toolsDir, { recursive: true })
  await writeFile(join(codeDir, "routine.mjs"), routineCode(body))
  await cp(SDK_DIR, join(codeDir, "node_modules", "heyagent"), { recursive: true })
  const gateway = options.gateway ?? new FakeGateway()
  const state: SessionRoutineState = {
    routineId: "RT-1",
    versionId: "RT-1-v1",
    version: 1,
    mode: options.mode ?? "run",
    state: "running",
    startedAt: new Date().toISOString(),
    steps: 0,
    commits: [],
  }
  const events: EventInput[] = []
  const saves: number[] = []
  const stops: string[] = []
  const bridge = await ToolBridge.listen(join(toolsDir, TOOLS_SOCKET_NAME), {
    sessionId: "S-1",
    gateway,
    state,
    mode: options.mode ?? "run",
    trial: options.trial ?? false,
    maxCalls: options.maxCalls ?? 1000,
    save: async (value) => {
      saves.push(value.steps)
    },
    event: async (event) => {
      events.push(event)
    },
    onStop: (kind) => stops.push(kind),
    ...(options.journal ? { journal: options.journal, browserInstanceId: () => "B-1" } : {}),
    ...(options.approvedRuleIds ? { approvedRuleIds: options.approvedRuleIds } : {}),
  })
  const result = await directNodeRunner({
    language: "node",
    script: LAUNCH_SCRIPT,
    args: [],
    stdin: JSON.stringify({ input: options.input ?? { 单号: "A-1" } }),
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
  return { bridge, gateway, state, events, saves, stops, result }
}

describe("工具桥 + SDK（本机 node，假网关）", () => {
  it("一路做下来：每次调用一个 routineStep、调用 id <运行号>-r<序号>；SDK 拿到结构化结果；提交、核对、日志、时间、报结果", async () => {
    const { bridge, gateway, state, result } = await runScript(`
  await ha.browser.navigate({ url: "https://erp.example.com/orders" })
  const seen = await ha.browser.waitAny({ found: "getByRole('row').nth(1)", empty: "getByText('暂无数据')" }, { timeout: 5 })
  const { rows, total } = await ha.browser.extract({ list: "getByRole('row')", fields: { 状态: "getByRole('cell').nth(3)" } })
  await ha.commit("保存第 1 个")
  await ha.browser.click({ element: "保存", target: "getByRole('button', { name: '保存' })" })
  await ha.verified("页面提示保存成功")
  const now = await ha.now()
  await ha.log(JSON.stringify({ seen, rows, total, input: ha.input, nowOk: /\\+08:00$/.test(now) }))
  return ha.finish({ outcome: "achieved", summary: input.单号 + "：" + rows[0].状态, evidence: "列表第 1 行" })`)
    expect(result.exitCode, result.stderr.text).toBe(0)
    expect(bridge.done).toEqual({ ok: true })
    expect(gateway.calls.map((each) => [each.call.toolName, each.call.toolCallId, each.routineStep])).toEqual([
      ["browser.navigate", "S-1-r1", 1],
      ["browser.wait_any", "S-1-r2", 2],
      ["browser.extract", "S-1-r3", 3],
      ["browser.click", "S-1-r4", 4],
      ["run.finish", "S-1-r5", 5],
    ])
    expect(gateway.calls[1]!.call.input).toEqual({ outcomes: { found: "getByRole('row').nth(1)", empty: "getByText('暂无数据')" }, timeout: 5 })
    expect(state.steps).toBe(5)
    expect(state.commits).toEqual([{ step: 3, label: "保存第 1 个", verified: "页面提示保存成功" }])
    expect(JSON.parse(state.logs![0]!)).toEqual({ seen: "found", rows: [{ 状态: "已发货" }], total: 1, input: { 单号: "A-1" }, nowOk: true })
    expect(bridge.finish).toMatchObject({ outcome: "achieved", summary: "A-1：已发货" })
    expect(bridge.stopped).toBeUndefined()
  })

  it("StepError 可以接住接着做；没接住的 Denied 让脚本带着 Denied 结束，记下停在哪一步", async () => {
    const { bridge, gateway, state } = await runScript(`
  try {
    await ha.browser.click({ element: "可有可无的弹窗", target: "missing" })
  } catch (error) {
    if (!(error instanceof ha.StepError)) throw error
    await ha.log("弹窗没出现：" + error.message)
  }
  await ha.tool("danger.tool", { x: 1 })
  await ha.log("不该到这里")`)
    expect(gateway.calls.map((each) => each.call.toolName)).toEqual(["browser.click", "danger.tool"])
    expect(state.logs).toEqual(["弹窗没出现：工具出错：选择器没找到元素"])
    expect(bridge.done).toMatchObject({ ok: false, name: "Denied" })
    expect(bridge.lastFailure).toMatchObject({ step: 2, kind: "denied", tool: "danger.tool", reason: "规则不让" })
    expect(bridge.stopped).toBeUndefined()
  })

  it("要人审批：停在这一步之前（不算调过）；接住 RoutineStop 再调也一律 stop，网关不再被调", async () => {
    const { bridge, gateway, state, stops } = await runScript(`
  await ha.browser.navigate({ url: "https://pay.example.com" })
  try {
    await ha.tool("approve.tool", { amount: 3 })
  } catch (error) {
    await ha.log("接住了 " + error.name).catch((again) => { globalThis.second = again.name })
    await ha.browser.click({ target: "getByText('再点一下')" }).catch(() => {})
    throw new Error("再抛一个 " + globalThis.second)
  }`)
    expect(gateway.calls.map((each) => each.call.toolName)).toEqual(["browser.navigate", "approve.tool"])
    expect(state.steps).toBe(1)
    expect(bridge.stopped).toMatchObject({ step: 2, kind: "approval", tool: "approve.tool" })
    expect(bridge.stopped!.reason).toContain("付钱要审批")
    expect(bridge.done).toMatchObject({ ok: false, error: "再抛一个 RoutineStop" })
    expect(stops).toEqual(["approval"])
  })

  it("要挂起：停下，把挂起计划交回；ha.fail(page) 停下；调用次数到上限停下；报了结果以后再调也停", async () => {
    const suspended = await runScript(`await ha.tool("wait.tool", {})`)
    expect(suspended.bridge.stopped).toMatchObject({ step: 1, kind: "suspend", reason: "检测到登录页：要登录。已交给负责人" })
    expect(suspended.bridge.suspend?.plan.kind).toBe("wait")

    const page = await runScript(`await ha.fail("page", "列表的列和预期不一样")`)
    expect(page.bridge.stopped).toMatchObject({ step: 0, kind: "page", reason: "列表的列和预期不一样" })
    expect(page.bridge.done).toMatchObject({ ok: false, name: "RoutineStop" })

    const limited = await runScript(`for (let i = 0; i < 5; i++) await ha.browser.navigate({ url: "https://a.example.com/" + i })`, { maxCalls: 2 })
    expect(limited.gateway.calls).toHaveLength(2)
    expect(limited.bridge.stopped).toMatchObject({ kind: "limit", step: 2 })

    const after = await runScript(`await ha.finish({ outcome: "achieved", summary: "好了", evidence: "页面" })\n  await ha.browser.navigate({ url: "https://a.example.com" })`)
    expect(after.gateway.calls.map((each) => each.call.toolName)).toEqual(["run.finish"])
    expect(after.bridge.finish?.outcome).toBe("achieved")
    expect(after.bridge.stopped).toBeUndefined()
    expect(after.bridge.done).toMatchObject({ ok: false, name: "RoutineStop" })
  })

  it("运行被取消：下一次调用前发现，停下（cancelled），立刻要杀沙箱", async () => {
    const gateway = new FakeGateway()
    gateway.running = false
    const { bridge, stops } = await runScript(`await ha.browser.navigate({ url: "https://a.example.com" })`, { gateway })
    expect(gateway.calls).toHaveLength(0)
    expect(bridge.stopped?.kind).toBe("cancelled")
    expect(stops).toEqual(["cancelled"])
  })

  it("试跑：work.report / run.finish / checkpoint.mark 只记下来不真调；会对外发送的非浏览器工具停在它前面", async () => {
    const { bridge, gateway, state, events } = await runScript(
      `
  await ha.browser.navigate({ url: "https://erp.example.com" })
  await ha.work.report({ data: { 状态: "已发货", 件数: 3 } })
  await ha.checkpoint.mark({ checkpoint: 1, status: "done", record: "查到了" })
  await ha.tool("http.read", { q: 1 })
  await ha.tool("http.ext", { to: "客户" })
  await ha.finish({ outcome: "achieved", summary: "不该到这里", evidence: "-" })`,
      { mode: "test" }
    )
    expect(gateway.calls.map((each) => each.call.toolName)).toEqual(["browser.navigate", "http.read"])
    expect(state.recorded).toEqual({ report: { 状态: "已发货", 件数: 3 }, checkpoints: [{ checkpoint: 1, status: "done", record: "查到了" }] })
    expect(bridge.stopped).toMatchObject({ step: 5, kind: "test_blocked", tool: "http.ext" })
    expect(state.steps).toBe(4)
    expect(events.filter((event) => event.title.startsWith("固化试跑：记下")).map((event) => event.trace?.routineStep)).toEqual([2, 3])
  })

  it("试跑：走到第一个 ha.commit 就停，不做那一步；试用期：ha.commit 先截图存证、记一条过程", async () => {
    const test = await runScript(
      `
  await ha.browser.navigate({ url: "https://erp.example.com" })
  await ha.commit("保存第 1 个")
  await ha.browser.click({ element: "保存", target: "getByRole('button', { name: '保存' })" })`,
      { mode: "test" }
    )
    expect(test.gateway.calls.map((each) => each.call.toolName)).toEqual(["browser.navigate"])
    expect(test.bridge.stopped).toMatchObject({ step: 1, kind: "test_commit", label: "保存第 1 个" })
    expect(test.state.commits).toEqual([])

    const trial = await runScript(
      `
  await ha.browser.navigate({ url: "https://erp.example.com" })
  await ha.commit("保存第 1 个")
  await ha.browser.click({ element: "保存", target: "getByRole('button', { name: '保存' })" })
  await ha.finish({ outcome: "achieved", summary: "存好了", evidence: "提示保存成功" })`,
      { trial: true }
    )
    expect(trial.gateway.shots).toBe(1)
    expect(trial.events.find((event) => event.title === "提交前截图：保存第 1 个")).toMatchObject({ output: "f-shot-1", trace: { routineStep: 1 } })
    expect(trial.state.commits).toEqual([{ step: 1, label: "保存第 1 个" }])
    expect(trial.bridge.finish?.summary).toBe("存好了")
  })

  it("脚本自己的错（语法错、没有 export default）：done 带着错误", async () => {
    const { bridge } = await runScript(`await ha.browser.navigate({ url: "x" })\n  this is not js`)
    expect(bridge.done?.ok).toBe(false)
    expect(bridge.done?.name).toBe("SyntaxError")
  })
})

/** 存在内存里的重放日志：rows 是上次的（接着跑时按它重放），written 是这次写的（按 seq 留最后一次） */
function memoryJournal(rows: JournalRow[] = []) {
  const written = new Map<number, JournalRow>()
  const journal: BridgeJournal = {
    rows,
    write: async (row) => {
      written.set(row.seq, { ...row })
    },
  }
  /** 上次的加这次写的：下一次接着跑用 */
  const merged = () => {
    const all = new Map(rows.map((row) => [row.seq, row]))
    for (const [seq, row] of written) all.set(seq, row)
    return [...all.values()].sort((a, b) => a.seq - b.seq)
  }
  return { journal, written, merged }
}

describe("重放日志（假网关）", () => {
  const LOOKUP = `
  await ha.log("开始")
  const now = await ha.now()
  await ha.browser.navigate({ url: "https://erp.example.com/orders" })
  const seen = await ha.browser.waitAny({ found: "getByRole('row').nth(1)" })
  const { rows } = await ha.browser.extract({ list: "getByRole('row')", fields: { 状态: "getByRole('cell').nth(3)" } })
  await ha.tool("wait.tool", { now })
  await ha.browser.click({ element: "保存", target: "getByRole('button', { name: '保存' })" })
  return ha.finish({ outcome: "achieved", summary: seen + "：" + rows[0].状态 + " @" + now, evidence: "-" })`

  it("记日志：每个请求一行（tool / log / now），浏览器动作记 Chrome；停下的那一步记 stop，后面的不记", async () => {
    const memory = memoryJournal()
    const first = await runScript(LOOKUP, { journal: memory.journal })
    expect(first.bridge.stopped).toMatchObject({ step: 4, kind: "suspend", tool: "wait.tool" })
    const rows = memory.merged()
    expect(rows.map((row) => [row.seq, row.op, row.tool, row.stop, row.instanceId])).toEqual([
      [1, "log", null, null, null],
      [2, "now", null, null, null],
      [3, "tool", "browser.navigate", null, "B-1"],
      [4, "tool", "browser.wait_any", null, "B-1"],
      [5, "tool", "browser.extract", null, "B-1"],
      [6, "tool", "wait.tool", "suspend", null],
    ])
    expect(rows[4]!.reply).toMatchObject({ ok: true, data: { rows: [{ 状态: "已发货" }], total: 1 } })
    expect(rows[1]!.reply).toMatchObject({ ok: true, data: expect.stringMatching(/\+08:00$/) })
  })

  it("接着跑：对得上的不真做、回记下的结果（ha.now 是上次的时间），非浏览器的挂起算做完了，之后真做；对不上就停", async () => {
    const memory = memoryJournal()
    await runScript(LOOKUP, { journal: memory.journal })
    const rows = memory.merged()
    const recordedNow = rows[1]!.reply!.data as string
    await new Promise((resolve) => setTimeout(resolve, 20))
    const again = memoryJournal(rows)
    const resumed = await runScript(LOOKUP, { journal: again.journal })
    expect(resumed.result.exitCode, resumed.result.stderr.text).toBe(0)
    // 只真做了停下之后的：click、run.finish（wait.tool 是非浏览器的挂起，等到了就算做完）
    expect(resumed.gateway.calls.map((each) => [each.call.toolName, each.routineStep])).toEqual([
      ["browser.click", 5],
      ["run.finish", 6],
    ])
    expect(resumed.state).toMatchObject({ steps: 6, replayed: 6, logs: ["开始"] })
    // 用的是上次记下的时间（wait.tool 的参数里也带着它，hash 才对得上）
    expect(resumed.bridge.finish?.summary).toBe(`found：已发货 @${recordedNow}`)
    expect(resumed.bridge.stopped).toBeUndefined()
    expect(resumed.events.filter((event) => event.title.startsWith("流程记录"))).toEqual([])
    expect(resumed.events.find((event) => event.title.startsWith("脚本接着跑"))?.title).toBe("脚本接着跑：前 4 步按记录跳过，从第 5 步接着做")
    expect([...again.written.keys()]).toEqual([7, 8])

    // 脚本改了（走了别的路）：对不上，停下，网关一次都不调
    const changed = await runScript(LOOKUP.replace('ha.log("开始")', 'ha.log("开始了")'), { journal: memoryJournal(rows).journal })
    expect(changed.gateway.calls).toHaveLength(0)
    expect(changed.bridge.stopped).toMatchObject({ step: 0, kind: "replay_mismatch" })
    expect(changed.bridge.stopped!.reason).toContain("第 1 个请求（ha.log()）的参数和上次不一样")
    const other = await runScript(LOOKUP.replace("await ha.log(\"开始\")\n", ""), { journal: memoryJournal(rows).journal })
    expect(other.bridge.stopped!.reason).toContain("第 1 个请求上次是ha.log()，这次是ha.now()")
  })

  it("停下的那一步：审批批准 → 带着批准的规则真做；浏览器动作要人处理 → 重做；前面有没核对的提交 → 不重做（可能已经生效）", async () => {
    const PAY = `
  await ha.browser.navigate({ url: "https://pay.example.com" })
  await ha.tool("approve.tool", { amount: 3 })
  await ha.finish({ outcome: "achieved", summary: "付了", evidence: "-" })`
    const memory = memoryJournal()
    const first = await runScript(PAY, { journal: memory.journal })
    expect(first.bridge.approval).toMatchObject({ step: 2, approvedRuleIds: [] })
    expect(memory.merged().map((row) => [row.tool, row.stop, row.reply])).toEqual([
      ["browser.navigate", null, { ok: true, text: "打开了 https://pay.example.com" }],
      ["approve.tool", "approval", null],
    ])
    // 批准了：假网关看到 approvedRuleIds 就当规则放行
    const gateway = new FakeGateway()
    const original = gateway.call.bind(gateway)
    const seen: (readonly string[] | undefined)[] = []
    gateway.call = async (call, options) => {
      if (call.toolName === "approve.tool" && options.approvedRuleIds?.includes("r1")) {
        seen.push(options.approvedRuleIds)
        return { toolId: call.toolName, toolName: call.toolName, outcome: { output: "付好了" }, output: "付好了", denied: false }
      }
      return original(call, options)
    }
    const approved = await runScript(PAY, { journal: memoryJournal(memory.merged()).journal, approvedRuleIds: ["r1"], gateway })
    expect(seen).toEqual([["r1"]])
    expect(approved.bridge.finish?.summary).toBe("付了")
    expect(approved.state).toMatchObject({ steps: 3, replayed: 1 })

    // 浏览器动作要人处理（登录页）：重做那一步
    const login: JournalRow[] = [
      { seq: 1, op: "tool", tool: "browser.navigate", inputHash: memory.merged()[0]!.inputHash, reply: { ok: true, text: "检测到登录页" }, stop: "suspend", instanceId: "B-1" },
    ]
    const relogin = await runScript(PAY.replace('ha.tool("approve.tool", { amount: 3 })', 'ha.log("登录好了")'), { journal: memoryJournal(login).journal })
    expect(relogin.gateway.calls.map((each) => each.call.toolName)).toEqual(["browser.navigate", "run.finish"])

    // 过了提交点还没核对，下一步做到一半中断了：不重做
    const SAVE = `
  await ha.commit("保存")
  await ha.browser.click({ element: "保存", target: "getByRole('button', { name: '保存' })" })
  await ha.verified("保存成功")
  await ha.finish({ outcome: "achieved", summary: "存了", evidence: "-" })`
    const saveMemory = memoryJournal()
    await runScript(SAVE, { journal: saveMemory.journal })
    const cut = saveMemory.merged().slice(0, 2)
    cut[1] = { ...cut[1]!, reply: null }
    const interrupted = await runScript(SAVE, { journal: memoryJournal(cut).journal })
    expect(interrupted.gateway.calls).toHaveLength(0)
    expect(interrupted.bridge.stopped).toMatchObject({ step: 1, kind: "interrupted", tool: "browser.click" })
    expect(interrupted.bridge.stopped!.reason).toBe("过了提交点「保存」还没核对，click「保存」 可能已经生效，没有重做")
    expect(interrupted.state.commits).toEqual([{ step: 0, label: "保存" }])
  })
})

describe("定位的 JS 写法", () => {
  it("认白名单里的方法和字面量参数，别的当选择器字符串", () => {
    expect(parseLocatorChain("getByRole('button', { name: '查询' }).nth(1)")).toEqual([
      { method: "getByRole", args: ["button", { name: "查询" }] },
      { method: "nth", args: [1] },
    ])
    expect(parseLocatorChain("await page.getByText(\"暂无\\\"数据\", { exact: true }).first();")).toEqual([
      { method: "getByText", args: ['暂无"数据', { exact: true }] },
      { method: "first", args: [] },
    ])
    const regex = parseLocatorChain("getByRole('row').filter({ hasText: /单号\\s*A-1/i }).last()")!
    expect(regex[1]!.args[0]).toEqual({ hasText: /单号\s*A-1/i })
    expect(parseLocatorChain("locator('#list > li', { hasText: `苹果` })")).toEqual([{ method: "locator", args: ["#list > li", { hasText: "苹果" }] }])
    // 不认识的方法、变量、模板插值、选择器字符串：都不当 JS 写法
    expect(parseLocatorChain("getByRole('button').click()")).toBeUndefined()
    expect(parseLocatorChain("getByText(name)")).toBeUndefined()
    expect(parseLocatorChain("getByText(`${name}`)")).toBeUndefined()
    expect(parseLocatorChain("evaluate('1')")).toBeUndefined()
    expect(parseLocatorChain('role=button[name="查询"]')).toBeUndefined()
    expect(parseLocatorChain("#list .item")).toBeUndefined()
    expect(parseLocatorChain("text=暂无数据")).toBeUndefined()
  })
})

describe("录下的代码", () => {
  it("从 MCP 输出里拿掉 ### Ran Playwright code，别的段原样留着", () => {
    const output = "### Ran Playwright code\n```js\nawait page.getByRole('button', { name: '查询' }).click();\n```\n### Page\n- Page URL: https://a.example.com/\n- Page Title: 列表"
    expect(takeCode(output)).toEqual({
      code: "await page.getByRole('button', { name: '查询' }).click();",
      output: "### Page\n- Page URL: https://a.example.com/\n- Page Title: 列表",
    })
    expect(takeCode("### Ran Playwright code\n```js\nawait page.goto('https://a.example.com/');\n```")).toEqual({ code: "await page.goto('https://a.example.com/');", output: "（没有返回内容）" })
    expect(takeCode("### Error\nTimeout")).toEqual({ output: "### Error\nTimeout" })
  })
})

describe("交接的话", () => {
  const base: SessionRoutineState = { routineId: "RT-1", versionId: "RT-1-v3", version: 3, mode: "run", state: "fell_back", startedAt: shanghaiNow(), steps: 5, commits: [] }

  it("每步 ✓ / ✗、会改东西的一步都没做、现在的页面、接着做", () => {
    const text = handoffText({
      routine: { name: "查订单状态", version: 3 },
      state: { ...base, stoppedAt: { step: 5, kind: "step_error", tool: "browser.extract", label: "extract「状态」", reason: "找不到 getByRole('cell').nth(3)" } },
      steps: ["1. navigate「https://erp.example.com/orders」 ✓", "5. ✗ extract「状态」：找不到"],
      page: ["现在的页面：「订单列表」 https://erp.example.com/orders?no=1"],
    })
    expect(text).toBe(
      [
        "（系统）这次运行先按固化流程「查订单状态」第 3 版跑了，做到第 5 步停下（这一步出错）：extract「状态」：找不到 getByRole('cell').nth(3)。",
        "1. navigate「https://erp.example.com/orders」 ✓",
        "5. ✗ extract「状态」：找不到",
        "会改东西的步骤：一步都还没做。",
        "现在的页面：「订单列表」 https://erp.example.com/orders?no=1",
        "请从现在的页面接着把任务办完，前面做过的不要重复。",
      ].join("\n")
    )
  })

  it("做过提交、没核对的写「可能已经生效」；核对过的写核对了什么；还没做的写还没做", () => {
    expect(
      commitLines({
        ...base,
        steps: 7,
        commits: [
          { step: 2, label: "保存第 1 个", verified: "页面提示保存成功" },
          { step: 6, label: "保存第 3 个" },
        ],
      })
    ).toEqual(["会改东西的「保存第 1 个」做了，核对过：页面提示保存成功。", "第 7 步「保存第 3 个」已经做了，可能已经生效：先看页面核对，不要重复做。"])
    expect(commitLines({ ...base, steps: 6, commits: [{ step: 6, label: "保存第 3 个" }] })).toEqual(["会改东西的「保存第 3 个」还没做。"])
  })
})
