// 桌面（docs/dev/desktop.md）：配置、快照、工具组、分配和等待、转人工、巡查、传文件、连不上、远程画面。
// 用假的 Windows-MCP 和假的桌面服务（desktop-helpers.ts），模型是剧本（engine-helpers.ts），不连真的虚拟机。
import type { Server } from "node:http"
import { setTimeout as sleep } from "node:timers/promises"

import { serve } from "@hono/node-server"
import { and, eq, isNull, notInArray } from "drizzle-orm"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import WebSocket from "ws"
import { ANY_DESKTOP_EVENT, desktopEventName } from "@heyagent/shared"

import { attachBrowserViewRelay } from "../src/browser/view-relay.js"
import * as t from "../src/db/schema.js"
import { sweepDesktops, wakeDesktopWaiters } from "../src/desktop/leases.js"
import { attachDesktopViewRelay } from "../src/desktop/view-relay.js"
import { DESKTOP_MCP_TOOL_DEFS } from "../src/desktop/mcp-tools.js"
import { desktopControlRetry, parseControlBlock } from "../src/desktop/control.js"
import { resolveHumanItemImpl } from "../src/engine/humans.js"
import { normalizeRuleOutput } from "../src/engine/rule-compile.js"
import { toolMatches } from "../src/engine/rules.js"
import { filterInput, rewriteMeta } from "../src/desktop/view-relay.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { startFakeAgent, startFakeMcp, type FakeAgent, type FakeMcp } from "./desktop-helpers.js"
import { call, createTask, eventsOf, Script, sessionRow, setupEngine, step, text, useScript, waitFor, waitStatus, type EngineTestContext } from "./engine-helpers.js"
import { login, mutate, query, TEST_REVIEW_MODEL } from "./helpers.js"

const KEY = "desktop-test-key-0123456789abcd"

let ctx: EngineTestContext
let lin: string
let wang: string
let li: string
let mcp: FakeMcp
let agent: FakeAgent
/** 两台能用的、一台连不上的 */
let dkA: string
let dkB: string
let dkDead: string
/** 演示数据里不归引擎管的运行（没有快照），拿来当「别的运行」占桌面 */
let holders: string[]

const run = async (taskId: string) => {
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(`立即运行失败：${JSON.stringify(res.error)}`)
  return res.data.sessionId as string
}
const newTask = async (modelId: string, desktopIds: string[], options: { vision?: boolean; tools?: string[] } = {}) => {
  const taskId = await createTask(ctx.db, { modelId, toolIds: ["desktop", ...(options.tools ?? [])] })
  await ctx.db.update(t.tasks).set({ desktopIds, allowDesktopVision: Boolean(options.vision) }).where(eq(t.tasks.id, taskId))
  return taskId
}
const waitOf = async (sessionId: string) =>
  (await ctx.db.select().from(t.sessionWaits).where(and(eq(t.sessionWaits.sessionId, sessionId), eq(t.sessionWaits.status, "waiting"))))[0]
const leaseOf = async (desktopId: string) => (await ctx.db.select().from(t.desktopLeases).where(eq(t.desktopLeases.desktopId, desktopId)))[0]
const occupy = (desktopId: string, sessionId: string, state: "running" | "held" = "running") =>
  ctx.db.insert(t.desktopLeases).values({ desktopId, sessionId, state, expiresAt: new Date(Date.now() + 10 * 60_000), holdUntil: state === "held" ? new Date(Date.now() + 10 * 60_000) : null })
const free = (desktopId: string) => ctx.db.delete(t.desktopLeases).where(eq(t.desktopLeases.desktopId, desktopId))
const toolNames = (script: Script, index = 0) => (script.prompts[index]!.tools ?? []).map((tool) => tool.name)
/** 第 index 次调模型时最后一条消息（上一个工具的结果） */
const lastMessage = (script: Script, index: number) => JSON.stringify(script.prompts[index]!.prompt.at(-1))
const toolSchema = (script: Script, name: string) => JSON.stringify(script.prompts[0]!.tools!.find((tool) => tool.name === name))

beforeAll(async () => {
  // 不开 worker 的定时巡查：巡查都由测试自己调（sweepDesktops），不会在断言中间插进来放掉、叫醒
  ctx = await setupEngine({ desktopSweepMs: false })
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  li = await login(ctx.app, "lijing@heyagent.local")
  mcp = await startFakeMcp(KEY)
  agent = await startFakeAgent(KEY)
  const rows = await ctx.db.select({ id: t.sessions.id }).from(t.sessions).where(isNull(t.sessions.snapshot)).limit(4)
  holders = rows.map((row) => row.id)
  expect(holders.length).toBe(4)
})

// 每个测试自己占、自己放；万一中途失败留下了占用，清掉，免得后面的测试跟着失败
afterEach(async () => {
  await ctx.db.delete(t.desktopLeases)
})

afterAll(async () => {
  await ctx?.stop()
  await mcp?.close()
  await agent?.close()
})

describe("纯函数", () => {
  it("规则里写 desktop 代表整组桌面工具；远程画面的消息改写和过滤；工具清单和白名单一致", () => {
    expect(toolMatches(["desktop"], "desktop.click")).toBe(true)
    expect(toolMatches(["desktop"], "browser.click")).toBe(false)
    expect(toolMatches(["desktop.type"], "desktop.click")).toBe(false)
    const known = { toolIds: new Set(["notify.staff"]), userIds: new Set(["u-wang"]), toolName: () => undefined, userName: () => undefined }
    const trigger = { type: "before_tool" as const, toolIds: ["desktop.type"], risks: [], anyTool: false, domains: [], usd: 0, proposes: [] }
    expect(normalizeRuleOutput({ supported: true, reason: "", trigger, actions: [{ type: "deny", to: "none", userId: "", reason: "不许输入" }] }, known)).toMatchObject({ supported: true })
    expect(rewriteMeta(JSON.stringify({ t: "meta", width: 10, height: 20, canControl: true }), false)).toBe(JSON.stringify({ t: "meta", width: 10, height: 20, canControl: false }))
    expect(rewriteMeta("not json", false)).toBe("not json")
    expect(filterInput(JSON.stringify({ t: "key", type: "keyDown", code: "KeyA", evil: 1 }))).toBe(JSON.stringify({ t: "key", type: "keyDown", code: "KeyA" }))
    expect(filterInput(JSON.stringify({ t: "dialog", accept: true }))).toBeUndefined()
    expect(parseControlBlock('{"code": "USER_CONTROL", "status": {"state": "user", "generation": 4, "wait_seconds": 2.72}}')).toEqual({ code: "USER_CONTROL", state: "user", waitSeconds: 2.72, executedSteps: 0 })
    expect(parseControlBlock('Error calling tool: {"code": "CONTROL_PREEMPTED", "status": {"state": "unavailable", "wait_seconds": 0.0, "executed_steps": 3}}')).toMatchObject({ code: "CONTROL_PREEMPTED", executedSteps: 3 })
    expect(parseControlBlock('{"code": "SOMETHING_ELSE"}')).toBeUndefined()
    expect(parseControlBlock("没有编号 99 的控件")).toBeUndefined()
    expect(DESKTOP_MCP_TOOL_DEFS.map((def) => def.mcpName)).toEqual(["Snapshot", "Click", "Type", "Scroll", "Move", "Shortcut", "Wait", "WaitFor", "App", "Clipboard", "MultiSelect", "MultiEdit"])
  })
})

describe("配置", () => {
  it("增删改只给主管、密钥只存密文只给掩码、改动记审计、测试连接", async () => {
    const input = { name: "运营 1 号机", description: "装了记事本，登了测试账号", mcpUrl: mcp.url, agentUrl: agent.url, key: KEY }
    expect((await mutate(ctx.app, "desktops.create", wang, input)).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "desktops.create", lin, { ...input, key: "short" })).error?.data?.code).toBe("BAD_REQUEST")
    const created = await mutate(ctx.app, "desktops.create", lin, input)
    expect(created.error).toBeUndefined()
    dkA = created.data.id
    expect(dkA).toMatch(/^dk-/)
    expect((await mutate(ctx.app, "desktops.create", lin, input)).error?.data?.code).toBe("CONFLICT")
    dkB = (await mutate(ctx.app, "desktops.create", lin, { ...input, name: "Ops 2", description: "第二台" })).data.id
    expect(dkB).toBe("dk-ops-2")

    // 列表：谁都能看；密钥只给掩码，原文不出现
    const list = await query(ctx.app, "desktops.list", wang)
    expect(JSON.stringify(list.data)).not.toContain(KEY)
    const a = list.data.find((each: { id: string }) => each.id === dkA)
    expect(a).toMatchObject({ name: "运营 1 号机", description: "装了记事本，登了测试账号", mcpUrl: mcp.url, agentUrl: agent.url, keyMask: `••••••••${KEY.slice(-4)}`, use: { state: "free" } })
    const [secret] = await ctx.db.select().from(t.secrets).where(and(eq(t.secrets.scope, "desktop"), eq(t.secrets.refId, dkA)))
    expect(secret).toBeDefined()
    expect(JSON.stringify(secret!.enc)).not.toContain(KEY)

    // 改：不填密钥 = 不改；填了太短的不行；换了密钥掩码跟着变
    expect((await mutate(ctx.app, "desktops.update", wang, { ...input, id: dkA, key: undefined })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "desktops.update", lin, { ...input, id: dkA, key: "", description: "说明改了" })).error).toBeUndefined()
    expect((await mutate(ctx.app, "desktops.update", lin, { ...input, id: dkA, key: "too-short" })).error?.data?.code).toBe("BAD_REQUEST")
    let after = (await query(ctx.app, "desktops.list", lin)).data.find((each: { id: string }) => each.id === dkA)
    expect(after).toMatchObject({ description: "说明改了", keyMask: `••••••••${KEY.slice(-4)}` })
    expect((await mutate(ctx.app, "desktops.update", lin, { ...input, id: dkA, key: "another-key-0000000000wxyz" })).error).toBeUndefined()
    after = (await query(ctx.app, "desktops.list", lin)).data.find((each: { id: string }) => each.id === dkA)
    expect(after.keyMask).toBe("••••••••wxyz")
    // 测试连接：密钥不对，两边都报错
    const bad = await mutate(ctx.app, "desktops.test", lin, { id: dkA })
    expect(bad.data.mcp.ok).toBe(false)
    expect(bad.data.agent).toMatchObject({ ok: false })
    expect(bad.data.agent.error).toContain("密钥不对")
    expect(JSON.stringify(bad.data)).not.toContain("another-key")
    await mutate(ctx.app, "desktops.update", lin, { ...input, id: dkA, key: KEY })

    const health = await mutate(ctx.app, "desktops.test", lin, { id: dkA })
    expect(health.error).toBeUndefined()
    expect(health.data.mcp).toMatchObject({ ok: true, toolCount: 21 })
    expect(health.data.agent).toMatchObject({ ok: true, version: "0.1.0-test", screen: { width: 1920, height: 1080 } })
    expect((await mutate(ctx.app, "desktops.test", wang, { id: dkA })).error?.data?.code).toBe("FORBIDDEN")

    // 审计：记了动作，密钥只记「换了」
    const audits = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.targetTable, "desktops"), eq(t.auditEvents.targetId, dkA)))
    expect(audits.map((row) => row.action)).toEqual(expect.arrayContaining(["desktop.create", "desktop.update"]))
    expect(JSON.stringify(audits)).not.toContain(KEY)
    expect(audits.some((row) => (row.detail as { key?: string }).key === "set")).toBe(true)

    // 连不上的一台：127.0.0.1 的 1 号端口（特权端口、没有服务，一定是拒绝连接；用关掉的随机端口的话，后面别的服务可能正好占到它）
    const deadUrl = "http://127.0.0.1:1"
    dkDead = (await mutate(ctx.app, "desktops.create", lin, { ...input, name: "死机", description: "连不上", mcpUrl: `${deadUrl}/mcp`, agentUrl: deadUrl })).data.id
    const dead = await mutate(ctx.app, "desktops.test", lin, { id: dkDead })
    expect(dead.data.mcp.ok).toBe(false)
    expect(dead.data.agent.ok).toBe(false)

    // 删：被占着的不让删；空着的删掉，密钥一起删
    const extra = (await mutate(ctx.app, "desktops.create", lin, { ...input, name: "临时" })).data.id as string
    await occupy(extra, holders[0]!)
    const refused = await mutate(ctx.app, "desktops.delete", lin, { id: extra })
    expect(refused.error).toMatchObject({ message: "桌面正被运行占着，先放开再删", data: { code: "CONFLICT" } })
    const busy = (await query(ctx.app, "desktops.list", wang)).data.find((each: { id: string }) => each.id === extra)
    expect(busy.use).toMatchObject({ state: "running", sessionId: holders[0] })
    expect(busy.use.taskTitle).toBeTruthy()
    await free(extra)
    expect((await mutate(ctx.app, "desktops.delete", lin, { id: extra })).error).toBeUndefined()
    expect(await ctx.db.select().from(t.secrets).where(and(eq(t.secrets.scope, "desktop"), eq(t.secrets.refId, extra)))).toEqual([])
  })

  it("任务里选的桌面要存在；快照里冻结允许的桌面和「允许看画面」", async () => {
    const taskId = await newTask("test/desktop-snap", [dkB])
    const snapshot = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })
    expect(snapshot.desktop).toEqual({ desktops: [{ id: dkB, name: "Ops 2", description: "第二台" }], allowVision: false })
    expect(snapshot.tools.map((tool) => tool.id)).toEqual(expect.arrayContaining(["desktop", "file.read"]))
    await ctx.db.update(t.tasks).set({ desktopIds: [], allowDesktopVision: true }).where(eq(t.tasks.id, taskId))
    const all = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })
    expect(all.desktop!.desktops.map((desktop) => desktop.id)).toEqual([dkA, dkB, dkDead])
    expect(all.desktop!.allowVision).toBe(true)
    // 没选「桌面」工具的任务没有这一节
    const plain = await createTask(ctx.db, { modelId: "test/desktop-snap" })
    expect((await buildSnapshot(ctx.db, plain, { source: "manual", runAttachments: [] })).desktop).toBeUndefined()

    const taskInput = { title: "桌面任务", goal: "做完", steps: [], schedule: null, memoryIds: [], skillIds: [], toolIds: ["desktop"], ruleIds: [], reviewModelId: TEST_REVIEW_MODEL }
    const bad = await mutate(ctx.app, "tasks.create", lin, { ...taskInput, desktopIds: ["dk-nope"] })
    expect(bad.error?.message).toContain("找不到桌面：dk-nope")
    const good = await mutate(ctx.app, "tasks.create", lin, { ...taskInput, desktopIds: [dkA], allowDesktopVision: true })
    expect(good.error).toBeUndefined()
    const [row] = await ctx.db.select().from(t.tasks).where(eq(t.tasks.id, good.data.id))
    expect(row).toMatchObject({ desktopIds: [dkA], allowDesktopVision: true })
  })
})

describe("工具组", () => {
  it("只开放白名单；没有「允许看画面」时没有 look、snapshot 不能截图；系统提示有「## 桌面」", async () => {
    const script = useScript("test/desktop-list", new Script([step([text("好")])]))
    const taskId = await newTask("test/desktop-list", [dkA])
    const sessionId = await run(taskId)
    await waitStatus(ctx.db, sessionId, "done", 60_000)
    const names = toolNames(script)
    const expected = ["snapshot", "click", "type", "scroll", "move", "shortcut", "wait", "wait_for", "app", "clipboard", "multi_select", "multi_edit", "use", "send_file", "fetch_file", "ask_human"]
    expect(names.filter((name) => name.startsWith("desktop_")).sort()).toEqual(expected.map((name) => `desktop_${name}`).sort())
    expect(names).toContain("file_read")
    const snapshotSchema = toolSchema(script, "desktop_snapshot")
    expect(snapshotSchema).not.toContain("use_vision")
    expect(snapshotSchema).toContain("use_ui_tree")
    expect(toolSchema(script, "desktop_use")).toContain(dkA)
    const system = JSON.stringify(script.prompts[0]!.prompt[0])
    expect(system).toContain("## 桌面")
    expect(system).toContain("本任务只允许桌面「运营 1 号机」")
    expect(system).toContain("本任务不允许看画面")
    expect(system).not.toContain("desktop_look")
    // 要人在桌面上动手的事走 desktop_ask_human：通用问人、桌面问人的说明和系统提示里都写清楚
    const tools = script.prompts[0]!.tools as { name: string; description?: string }[]
    expect(tools.find((tool) => tool.name === "ask_human")!.description).toContain("要人在桌面上动手做的事（扫码、登录、点一下、处理弹框、在软件里操作）不要用它，用 desktop_ask_human")
    expect(tools.find((tool) => tool.name === "desktop_ask_human")!.description).toMatch(/^桌面：请人在桌面上操作：要人在这台桌面上动手做的事一律用它（不要用通用的 ask_human/)
    expect(system).toContain("一律调 desktop_ask_human，不要用 ask_human")
    expect(system).toContain("要人在桌面上动手的，用桌面那一节说的 desktop_ask_human")
    // 没有桌面工具组的运行：问人的说明照旧
    const plainScript = useScript("test/desktop-plain", new Script([step([text("好")])]))
    const plain = await run(await createTask(ctx.db, { modelId: "test/desktop-plain" }))
    await waitStatus(ctx.db, plain, "done", 60_000)
    const plainAsk = (plainScript.prompts[0]!.tools as { name: string; description?: string }[]).find((tool) => tool.name === "ask_human")!
    expect(plainAsk.description).not.toContain("desktop")
    expect(JSON.stringify(plainScript.prompts[0]!.prompt[0])).not.toContain("desktop_ask_human")
    // 没调桌面工具：没占桌面、没分到
    expect(await leaseOf(dkA)).toBeUndefined()
    expect((await sessionRow(ctx.db, sessionId))!.desktopId).toBeNull()

    // 打开「允许看画面」：有 look，snapshot 可以带截图（图片交给模型）
    const before = mcp.calls.length
    const vision = useScript(
      "test/desktop-vision",
      new Script([step([call("desktop.look", {})]), step([call("desktop.snapshot", { use_vision: true })]), step([text("看完了")])])
    )
    const visionTask = await newTask("test/desktop-vision", [dkA, dkB], { vision: true })
    const visionSession = await run(visionTask)
    await waitStatus(ctx.db, visionSession, "done", 60_000)
    expect(toolNames(vision)).toContain("desktop_look")
    expect(toolSchema(vision, "desktop_snapshot")).toContain("use_vision")
    expect(JSON.stringify(vision.prompts[0]!.prompt[0])).toContain("允许看画面")
    expect(vision.promptText(1)).toContain("画面已作为下一条消息发给你")
    expect(vision.promptText(1)).toContain("image/jpeg")
    expect(vision.promptText(2)).toContain("前台窗口：记事本")
    expect(vision.promptText(2)).toContain("image/png")
    expect(mcp.calls.slice(before).find((each) => each.name === "Snapshot")!.args.use_vision).toBe(true)
    const files = await ctx.db.select().from(t.files).where(eq(t.files.sessionId, visionSession))
    expect(files.filter((file) => file.name.startsWith("look-"))).toHaveLength(1)
    // 系统挑了第一台空着的
    expect((await sessionRow(ctx.db, visionSession))!.desktopId).toBe(dkA)
  })

  it("调工具：转发给 Windows-MCP（snapshot 强制不截图、multi_edit 换格式、工具报错照给），分到的桌面记下来，结束放开", async () => {
    const before = mcp.calls.length
    const script = useScript(
      "test/desktop-call",
      new Script([
        step([call("desktop.snapshot", { use_vision: true })]),
        async () => {
          // 跑着的时候：桌面被这个运行占着
          const lease = await leaseOf(dkA)
          expect(lease).toMatchObject({ state: "running" })
          expect(lease!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 60_000)
          return step([call("desktop.type", { text: "hello", label: 1, press_enter: true })])
        },
        step([call("desktop.multi_edit", { items: [{ label: 1, text: "a" }, { loc: [5, 6], text: "b" }] })]),
        step([call("desktop.click", { label: 99 })]),
        step([call("desktop.use", { desktopId: dkB })]),
        step([text("结束")]),
      ])
    )
    const sessionId = await run(await newTask("test/desktop-call", [dkA, dkB]))
    await waitStatus(ctx.db, sessionId, "done", 60_000)
    const calls = mcp.calls.slice(before)
    expect(calls.map((each) => each.name)).toEqual(["Snapshot", "Type", "MultiEdit", "Click"])
    expect(calls[0]!.args).toMatchObject({ use_vision: false, use_ui_tree: true })
    expect(calls[1]!.args).toMatchObject({ text: "hello", label: 1, press_enter: true, clear: false, caret_position: "idle" })
    expect(calls[2]!.args).toEqual({ labels: [[1, "a"]], locs: [[5, 6, "b"]] })
    expect(script.promptText(1)).toContain("前台窗口：记事本")
    expect(script.promptText(1)).not.toContain("image/png")
    expect(script.promptText(4)).toContain("没有编号 99 的控件")
    expect(script.promptText(5)).toContain("一次运行只能用一台桌面")
    const session = await sessionRow(ctx.db, sessionId)
    expect(session!.desktopId).toBe(dkA)
    const events = await eventsOf(ctx.db, sessionId)
    const plan = events.filter((event) => event.title === "用桌面「运营 1 号机」")
    expect(plan).toHaveLength(1)
    expect(plan[0]!.detail).toMatch(new RegExp(`^桌面 ${dkA}；`))
    expect(events.some((event) => event.toolId === "desktop.type")).toBe(true)
    // 运行结束：放开
    expect(await leaseOf(dkA)).toBeUndefined()
  })

  it("传文件到桌面、取回桌面上的文件", async () => {
    agent.files.set("C:\\Users\\me\\Desktop\\报表.txt", Buffer.from("桌面上的报表", "utf8"))
    let sessionId = ""
    const script = useScript(
      "test/desktop-files",
      new Script([
        step([call("desktop.fetch_file", { path: "C:\\Users\\me\\Desktop\\报表.txt" })]),
        async () => {
          const [file] = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "download")))
          return step([call("desktop.send_file", { fileId: file!.id })])
        },
        step([call("desktop.send_file", { fileId: "f-nope" })]),
        step([call("desktop.fetch_file", { path: "C:\\Users\\me\\没有.txt" })]),
        step([text("结束")]),
      ])
    )
    sessionId = await run(await newTask("test/desktop-files", [dkB]))
    await waitStatus(ctx.db, sessionId, "done", 60_000)
    const [file] = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "download")))
    expect(file).toMatchObject({ name: "报表.txt" })
    expect(script.promptText(1)).toContain(`存成这次运行的文件 ${file!.id}`)
    expect(script.promptText(2)).toContain("C:\\\\HeyAgent\\\\files\\\\2026-10-22\\\\报表.txt")
    expect(agent.files.get("C:\\HeyAgent\\files\\2026-10-22\\报表.txt")?.toString("utf8")).toBe("桌面上的报表")
    expect(script.promptText(3)).toContain("这次运行里没有文件 f-nope")
    expect(script.promptText(4)).toContain("取文件没成功")
  })
})

describe("桌面服务的报错和文件名", () => {
  it("中文文件名（X-File-Name 百分号编码，没有时看 Content-Disposition）、路径不让取（403）、截图失败（503）都照原因报，不算连不上", async () => {
    agent.files.set("C:\\Users\\me\\Desktop\\季度 报表(终稿)#1.xlsx", Buffer.from("xlsx"))
    agent.files.set("C:\\Users\\me\\Desktop\\备注 100%.txt", Buffer.from("txt"))
    const before = agent.screenshotWidths.length
    const script = useScript(
      "test/desktop-errors",
      new Script([
        step([call("desktop.fetch_file", { path: "C:\\Users\\me\\Desktop\\季度 报表(终稿)#1.xlsx" })]),
        async () => {
          agent.omitFileNameHeader = true
          return step([call("desktop.fetch_file", { path: "C:\\Users\\me\\Desktop\\备注 100%.txt" })])
        },
        async () => {
          agent.omitFileNameHeader = false
          return step([call("desktop.fetch_file", { path: "D:\\机密\\a.txt" })])
        },
        async () => {
          agent.failScreenshot = true
          return step([call("desktop.look", {})])
        },
        async () => {
          agent.failScreenshot = false
          return step([call("desktop.look", {})])
        },
        step([text("结束")]),
      ])
    )
    const sessionId = await run(await newTask("test/desktop-errors", [dkB], { vision: true }))
    await waitStatus(ctx.db, sessionId, "done", 60_000)
    const names = (await ctx.db.select({ name: t.files.name }).from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "download")))).map((row) => row.name)
    expect(names.sort()).toEqual(["备注 100%.txt", "季度 报表(终稿)#1.xlsx"].sort())
    expect(script.promptText(1)).toContain("季度 报表(终稿)#1.xlsx")
    expect(script.promptText(3)).toContain("取文件没成功：只能取用户目录")
    expect(script.promptText(3)).toContain("403")
    expect(lastMessage(script, 3)).not.toContain("连不上")
    expect(script.promptText(4)).toContain("截图没成功：截图失败（锁屏或安全桌面时截不到）")
    expect(lastMessage(script, 4)).not.toContain("连不上")
    expect(script.promptText(5)).toContain("画面已作为下一条消息发给你")
    // look 按最宽 1920 要图
    expect(agent.screenshotWidths.slice(before)).toEqual(["1920", "1920"])
  })
})

describe("输入中文、有人在操作", () => {
  it("有非 ASCII 字的 desktop.type：先点、清空、移光标，文字交给桌面服务的 /type，再按回车；纯 ASCII 照旧走 Type；旧版桌面服务说清楚", async () => {
    const before = mcp.calls.length
    const typedBefore = agent.typed.length
    const script = useScript(
      "test/desktop-cjk",
      new Script([
        step([call("desktop.type", { text: "你好，桌面\n第二行", label: 1, clear: true, caret_position: "end", press_enter: true })]),
        step([call("desktop.type", { text: "hello", loc: [5, 6] })]),
        step([call("desktop.type", { text: "只输到当前焦点" })]),
        async () => {
          agent.noType = true
          return step([call("desktop.type", { text: "旧版" })])
        },
        async () => {
          agent.noType = false
          return step([text("结束")])
        },
      ])
    )
    const sessionId = await run(await newTask("test/desktop-cjk", [dkA]))
    await waitStatus(ctx.db, sessionId, "done", 60_000)
    const calls = mcp.calls.slice(before).map((each) => ({ name: each.name, args: each.args }))
    expect(calls).toEqual([
      { name: "Click", args: { label: 1, button: "left", clicks: 1 } },
      { name: "Shortcut", args: { shortcut: "ctrl+a" } },
      { name: "Shortcut", args: { shortcut: "backspace" } },
      { name: "Shortcut", args: { shortcut: "ctrl+end" } },
      { name: "Shortcut", args: { shortcut: "enter" } },
      { name: "Type", args: { text: "hello", loc: [5, 6], clear: false, caret_position: "idle", press_enter: false } },
    ])
    expect(agent.typed.slice(typedBefore)).toEqual(["你好，桌面\n第二行", "只输到当前焦点"])
    expect(lastMessage(script, 1)).toContain("已输入 9 个字（先点了输入框），原来的内容先清空了，按了回车")
    expect(lastMessage(script, 3)).toContain("已输入 7 个字（输入到当前焦点）")
    expect(lastMessage(script, 4)).toContain("桌面服务版本太旧")
  })

  it("Windows-MCP 说有人在操作（USER_CONTROL 等）：等它说的秒数再试；一直不行报清楚；做到一半被抢走的不重试", async () => {
    const saved = { ...desktopControlRetry }
    try {
      desktopControlRetry.maxWaitMs = 1500
      desktopControlRetry.minDelayMs = 50
      desktopControlRetry.marginMs = 50
      const script = useScript(
        "test/desktop-control",
        new Script([
          async () => {
            mcp.blocks = [{ code: "USER_CONTROL", waitSeconds: 0.2 }, { code: "TAKEOVER_PENDING" }, { code: "CONTROL_PREEMPTED", executedSteps: 0 }]
            return step([call("desktop.snapshot", {})])
          },
          async () => {
            mcp.always = { code: "USER_CONTROL", waitSeconds: 0.6 }
            return step([call("desktop.click", { label: 1 })])
          },
          async () => {
            mcp.always = undefined
            mcp.blocks = [{ code: "CONTROL_PREEMPTED", executedSteps: 2 }]
            return step([call("desktop.type", { text: "abc", label: 1 })])
          },
          async () => {
            // 中文输入的几步里被拒也一样等着重试
            mcp.blocks = [{ code: "USER_CONTROL", waitSeconds: 0.1 }]
            return step([call("desktop.type", { text: "中文", label: 2 })])
          },
          step([text("结束")]),
        ])
      )
      const blockedBefore = mcp.blocked.length
      const sessionId = await run(await newTask("test/desktop-control", [dkA]))
      await waitStatus(ctx.db, sessionId, "done", 60_000)
      // 被拒三次后成功
      expect(lastMessage(script, 1)).toContain("前台窗口：记事本")
      // 一直被拒：等不到就报
      expect(lastMessage(script, 2)).toContain("有人正在操作这台桌面（远程画面里），等人停手再试")
      expect(lastMessage(script, 2)).toContain("USER_CONTROL")
      // 做到一半被抢走：不重试，让 agent 先看现状
      expect(lastMessage(script, 3)).toContain("操作做到一半被打断了")
      expect(lastMessage(script, 3)).toContain("已经做了 2 步")
      expect(lastMessage(script, 4)).toContain("已输入 2 个字")
      const blocked = mcp.blocked.slice(blockedBefore)
      expect(blocked.slice(0, 3).map((each) => each.code)).toEqual(["USER_CONTROL", "TAKEOVER_PENDING", "CONTROL_PREEMPTED"])
      // 一直被拒的那次：总共只等 1.5 秒（每次等 0.65 秒），试几次就停，不会无限重试
      const preempted = blocked.findIndex((each, index) => index >= 3 && each.code === "CONTROL_PREEMPTED")
      const clicks = blocked.slice(3, preempted)
      expect(clicks.every((each) => each.name === "Click" && each.code === "USER_CONTROL")).toBe(true)
      expect(clicks.length).toBeGreaterThanOrEqual(2)
      expect(clicks.length).toBeLessThanOrEqual(3)
    } finally {
      Object.assign(desktopControlRetry, saved)
      mcp.always = undefined
      mcp.blocks = []
    }
  })
})

describe("分配和等待", () => {
  it("一台桌面同时只给一个运行：自动挑空着的；都被占着就挂起等这一台 / 任一台；放开后叫醒", async () => {
    // 1) A 被别的运行占着：允许 A、B 的运行自动挑到 B，不挂起
    await occupy(dkA, holders[0]!)
    const scriptPick = useScript("test/desktop-pick", new Script([step([call("desktop.snapshot", {})]), step([text("结束")])]))
    const picked = await run(await newTask("test/desktop-pick", [dkA, dkB]))
    await waitStatus(ctx.db, picked, "done", 60_000)
    expect((await sessionRow(ctx.db, picked))!.desktopId).toBe(dkB)
    expect(scriptPick.promptText(1)).toContain("前台窗口")

    // 2) 只允许 A：挂起等 A（desktop:<id>），占名额照浏览器
    const scriptOne = useScript(
      "test/desktop-one",
      new Script([step([call("desktop.snapshot", {})]), step([call("desktop.snapshot", {})]), step([text("结束")])])
    )
    const one = await run(await newTask("test/desktop-one", [dkA]))
    await waitStatus(ctx.db, one, "waiting", 60_000)
    expect(await waitOf(one)).toMatchObject({ event: desktopEventName(dkA), what: "等待桌面：桌面「运营 1 号机」正在被别的运行用" })
    // B 空出来叫不醒等 A 的
    expect(await wakeDesktopWaiters(ctx.db, dkB)).toEqual([])
    // 主管强制放开 A：叫醒，接着用 A
    expect((await mutate(ctx.app, "desktop.release", wang, { desktopId: dkA })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "desktop.release", lin, { desktopId: dkA })).error).toBeUndefined()
    await waitStatus(ctx.db, one, "done", 60_000)
    expect(scriptOne.promptText(1)).toContain("「运营 1 号机」空出来了")
    expect(scriptOne.promptText(2)).toContain("前台窗口")
    expect((await sessionRow(ctx.db, one))!.desktopId).toBe(dkA)
    expect((await eventsOf(ctx.db, holders[0]!)).some((event) => event.title === "桌面「运营 1 号机」被主管放开了")).toBe(true)
    const [audit] = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.action, "desktop.release"), eq(t.auditEvents.targetId, dkA)))
    expect(audit!.detail).toMatchObject({ sessionId: holders[0], state: "running" })

    // 3) 两台都被占着：等任一台（desktop:any）；放开的那台没人叫醒（worker 死了）时，巡查补叫
    await occupy(dkA, holders[0]!)
    await occupy(dkB, holders[1]!)
    useScript("test/desktop-any", new Script([step([call("desktop.snapshot", {})]), step([call("desktop.snapshot", {})]), step([text("结束")])]))
    const any = await run(await newTask("test/desktop-any", [dkA, dkB]))
    await waitStatus(ctx.db, any, "waiting", 60_000)
    expect(await waitOf(any)).toMatchObject({ event: ANY_DESKTOP_EVENT, what: "等待桌面：本任务允许的 2 台桌面都在被别的运行用" })
    expect((await sessionRow(ctx.db, any))!.desktopId).toBeNull()
    // 不在允许名单里的桌面空出来：不叫醒
    expect(await wakeDesktopWaiters(ctx.db, dkDead)).toEqual([])
    await free(dkB)
    await sweepDesktops(ctx.db)
    await waitStatus(ctx.db, any, "done", 60_000)
    expect((await sessionRow(ctx.db, any))!.desktopId).toBe(dkB)
    await free(dkA)
  })

  it("桌面连不上：报错、不挂起；自动分配时跳过连不上的", async () => {
    const before = mcp.calls.length
    const script = useScript("test/desktop-dead", new Script([step([call("desktop.snapshot", {})]), step([text("用不了，结束")])]))
    const dead = await run(await newTask("test/desktop-dead", [dkDead]))
    await waitStatus(ctx.db, dead, "done", 60_000)
    expect(script.promptText(1)).toContain("桌面连不上：「死机」：Windows-MCP 连不上")
    expect(await waitOf(dead)).toBeUndefined()
    expect((await sessionRow(ctx.db, dead))!.desktopId).toBeNull()
    expect(await leaseOf(dkDead)).toBeUndefined()

    // 死机排在最前面：跳过它，用下一台
    await ctx.db.update(t.desktops).set({ position: -1 }).where(eq(t.desktops.id, dkDead))
    useScript("test/desktop-skip", new Script([step([call("desktop.snapshot", {})]), step([text("结束")])]))
    const skip = await run(await newTask("test/desktop-skip", [dkDead, dkA]))
    await waitStatus(ctx.db, skip, "done", 60_000)
    expect((await sessionRow(ctx.db, skip))!.desktopId).toBe(dkA)
    expect(mcp.calls.length).toBeGreaterThan(before)

    // 指定了连不上的那台：每次调都报连不上，不挂起
    const pinned = useScript(
      "test/desktop-pinned",
      new Script([step([call("desktop.use", { desktopId: dkDead })]), step([call("desktop.click", { label: 1 })]), step([call("desktop.look", {})]), step([text("结束")])])
    )
    const pin = await run(await newTask("test/desktop-pinned", [dkDead, dkA], { vision: true }))
    await waitStatus(ctx.db, pin, "done", 60_000)
    expect(pinned.promptText(2)).toContain("桌面「死机」连不上：Windows-MCP 连不上")
    expect(pinned.promptText(3)).toContain("桌面「死机」连不上：桌面服务连不上")
    expect((await sessionRow(ctx.db, pin))!.desktopId).toBe(dkDead)
    expect(await leaseOf(dkDead)).toBeUndefined()
    await ctx.db.update(t.desktops).set({ position: 9 }).where(eq(t.desktops.id, dkDead))
  })
})

describe("转人工", () => {
  it("ask_human → 要人办的事带桌面信息、桌面保留给这个运行 → 处理好了 → 接着用同一台", async () => {
    const script = useScript(
      "test/desktop-human",
      new Script([
        step([call("desktop.snapshot", {})]),
        step([call("desktop.ask_human", { reason: "请扫码登录这个软件" })]),
        step([call("desktop.snapshot", {})]),
        step([text("结束")]),
      ])
    )
    const sessionId = await run(await newTask("test/desktop-human", [dkA, dkB]))
    await waitStatus(ctx.db, sessionId, "needs_human", 60_000)
    const [item] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.sessionId, sessionId))
    expect(item).toMatchObject({ kind: "login", title: "在桌面上处理：请扫码登录这个软件", assigneeId: "u-wang", status: "open" })
    const detail = item!.detail as { link?: unknown; desktop?: { screenshotFileId?: string }; primary: string; secondary: string }
    expect(detail).toMatchObject({ primary: "已处理好了", secondary: "处理不了", link: { page: "desktops", id: dkA }, desktop: { desktopId: dkA, sessionId, reason: "请扫码登录这个软件" } })
    const [shot] = await ctx.db.select().from(t.files).where(eq(t.files.id, detail.desktop!.screenshotFileId!))
    expect(shot!.name).toMatch(/^needs-human-.*\.jpg$/)
    // 桌面保留给这个运行（held，30 分钟）
    const lease = await waitFor(async () => {
      const row = await leaseOf(dkA)
      return row?.state === "held" ? row : undefined
    })
    expect(lease.sessionId).toBe(sessionId)
    expect(lease.holdUntil!.getTime() - Date.now()).toBeGreaterThan(25 * 60_000)
    expect((await eventsOf(ctx.db, sessionId)).some((event) => event.title === "桌面「运营 1 号机」保留 30 分钟，等人在远程画面里处理")).toBe(true)
    // 别的运行占不到它
    const listed = (await query(ctx.app, "desktops.list", wang)).data.find((each: { id: string }) => each.id === dkA)
    expect(listed.use).toMatchObject({ state: "held", sessionId })
    expect(listed.use.holdUntil).toBeTruthy()
    // 运行详情：占着桌面；负责人能操作，别人不能
    expect((await query(ctx.app, "desktop.sessionDesktop", wang, { sessionId })).data).toEqual({ open: true, desktopId: dkA, desktopName: "运营 1 号机", state: "held", canControl: true })
    expect((await query(ctx.app, "desktop.sessionDesktop", li, { sessionId })).data).toMatchObject({ open: true, canControl: false })
    expect((await query(ctx.app, "desktop.sessionDesktop", wang, { sessionId: "R-nope" })).error?.data?.code).toBe("NOT_FOUND")

    await resolveHumanItemImpl(ctx.db, { itemId: item!.id, how: "approve", actorId: "u-wang", actorName: "王悦" })
    await waitStatus(ctx.db, sessionId, "done", 60_000)
    expect(script.promptText(3)).toContain("前台窗口")
    expect((await sessionRow(ctx.db, sessionId))!.desktopId).toBe(dkA)
    // 接着用的是同一台，没有重新「用桌面」
    expect((await eventsOf(ctx.db, sessionId)).filter((event) => event.title.startsWith("用桌面"))).toHaveLength(1)
    expect(await leaseOf(dkA)).toBeUndefined()
    expect((await query(ctx.app, "desktop.sessionDesktop", wang, { sessionId })).data).toEqual({ open: false, desktopId: dkA, desktopName: "运营 1 号机", canControl: true })
  })
})

describe("巡查", () => {
  it("保留时间到了放开并记一条，继续时重新占；运行不在等人的放开；过期没续的放开并叫醒等的", async () => {
    // 1) 转人工保留着，过了保留时间：放开，记一条；人处理好以后继续，重新占同一台
    const script = useScript(
      "test/desktop-hold",
      new Script([step([call("desktop.ask_human", { reason: "处理弹框" })]), step([call("desktop.snapshot", {})]), step([text("结束")])])
    )
    const held = await run(await newTask("test/desktop-hold", [dkB]))
    await waitStatus(ctx.db, held, "needs_human", 60_000)
    await waitFor(async () => (await leaseOf(dkB))?.state === "held")
    await ctx.db.update(t.desktopLeases).set({ holdUntil: new Date(Date.now() - 1000) }).where(eq(t.desktopLeases.desktopId, dkB))
    await sweepDesktops(ctx.db)
    expect(await leaseOf(dkB)).toBeUndefined()
    const expired = (await eventsOf(ctx.db, held)).find((event) => event.title === "桌面保留时间到了，已放开")
    expect(expired?.detail).toContain(`桌面 ${dkB}；`)
    const [item] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.sessionId, held))
    await resolveHumanItemImpl(ctx.db, { itemId: item!.id, how: "approve", actorId: "u-wang", actorName: "王悦" })
    await waitStatus(ctx.db, held, "done", 60_000)
    expect(script.promptText(2)).toContain("前台窗口")

    // 2) held 但那个运行已经不在等人处理（结束了）：放开
    await ctx.db.update(t.sessions).set({ status: "done" }).where(eq(t.sessions.id, holders[2]!))
    await occupy(dkB, holders[2]!, "held")
    await sweepDesktops(ctx.db)
    expect(await leaseOf(dkB)).toBeUndefined()

    // 3) 占着的运行过期没续（worker 死了）：巡查放开，叫醒等它的
    await occupy(dkA, holders[3]!)
    useScript("test/desktop-expire", new Script([step([call("desktop.snapshot", {})]), step([call("desktop.snapshot", {})]), step([text("结束")])]))
    const waiting = await run(await newTask("test/desktop-expire", [dkA]))
    await waitStatus(ctx.db, waiting, "waiting", 60_000)
    await sweepDesktops(ctx.db)
    expect((await sessionRow(ctx.db, waiting))!.status).toBe("waiting")
    await ctx.db.update(t.desktopLeases).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(t.desktopLeases.desktopId, dkA))
    await sweepDesktops(ctx.db)
    await waitStatus(ctx.db, waiting, "done", 60_000)
    expect((await sessionRow(ctx.db, waiting))!.desktopId).toBe(dkA)
    expect(await leaseOf(dkA)).toBeUndefined()
  })
})

describe("远程画面", () => {
  it("要登录、来源可信；主管和占着它的运行的负责人能看能操作，别人 403；只看；输入按 schema 过滤；meta 按人改写", async () => {
    const server = serve({ fetch: ctx.app.fetch, port: 0, hostname: "127.0.0.1" }) as unknown as Server
    await new Promise((resolve) => server.once("listening", resolve))
    const deps = { db: ctx.db, auth: ctx.auth, keyring: () => ctx.keyring, trustedOrigins: ["http://localhost:5180"] }
    attachBrowserViewRelay(server, deps)
    attachDesktopViewRelay(server, deps)
    const port = (server.address() as { port: number }).port
    const status = (headers: Record<string, string>, path: string) =>
      new Promise<number>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers })
        ws.on("unexpected-response", (_req, res) => resolve(res.statusCode ?? 0))
        ws.on("open", () => {
          ws.close()
          resolve(101)
        })
        ws.on("error", () => resolve(-1))
      })
    const open = (cookie: string, path: string) =>
      new Promise<{ ws: WebSocket; messages: unknown[]; frames: number }>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers: { cookie } })
        const state = { ws, messages: [] as unknown[], frames: 0 }
        ws.on("message", (data, isBinary) => {
          if (isBinary) state.frames++
          else state.messages.push(JSON.parse(String(data)))
        })
        ws.on("open", () => resolve(state))
        ws.on("unexpected-response", (_req, res) => reject(new Error(`升级失败 ${res.statusCode}`)))
      })
    const path = `/api/desktop/view/${dkA}`
    expect(await status({}, path)).toBe(401)
    expect(await status({ cookie: lin, origin: "http://evil.test" }, path)).toBe(403)
    expect(await status({ cookie: lin }, "/api/desktop/view/dk-nope")).toBe(404)
    // 桌面空着：只有主管能看
    expect(await status({ cookie: wang }, path)).toBe(403)
    // 浏览器的远程画面照旧（共用一个 upgrade 监听）
    expect(await status({ cookie: wang }, "/api/browser/view/bw-nope")).toBe(404)
    expect(await status({ cookie: wang }, "/api/other")).toBe(404)

    // 主管：能操作
    const admin = await open(lin, path)
    await waitFor(async () => admin.frames > 0 && admin.messages.length >= 2)
    expect(admin.messages[0]).toEqual({ t: "meta", width: 1920, height: 1080, canControl: true })
    expect(admin.messages[1]).toEqual({ t: "cursor", x: 10, y: 20, kind: "move" })
    const seen = agent.viewMessages.length
    admin.ws.send(JSON.stringify({ t: "mouse", type: "mousePressed", x: 100, y: 200, button: "left", clickCount: 1, extra: "去掉" }))
    admin.ws.send(JSON.stringify({ t: "nav", action: "goto", url: "https://x.test" }))
    admin.ws.send("不是 JSON")
    admin.ws.send(JSON.stringify({ t: "combo", keys: "win+r" }))
    admin.ws.send(JSON.stringify({ t: "combo", keys: "ctrl+alt+del" }))
    admin.ws.send(JSON.stringify({ t: "text", text: "中文" }))
    await waitFor(async () => agent.viewMessages.length >= seen + 3)
    await sleep(200)
    expect(agent.viewMessages.slice(seen)).toEqual([
      { t: "mouse", type: "mousePressed", x: 100, y: 200, button: "left", clickCount: 1 },
      { t: "combo", keys: "win+r" },
      { t: "text", text: "中文" },
    ])
    // 桌面服务回的别的 JSON 照转
    await waitFor(async () => admin.messages.some((message) => (message as { t: string }).t === "agentAction"))
    admin.ws.close()

    // 主管只看：meta 改写成不能操作，输入不转
    const viewer = await open(lin, `${path}?viewOnly=1`)
    await waitFor(async () => viewer.messages.length >= 1)
    expect(viewer.messages[0]).toMatchObject({ t: "meta", canControl: false })
    const seen2 = agent.viewMessages.length
    viewer.ws.send(JSON.stringify({ t: "text", text: "不该到" }))
    await sleep(300)
    expect(agent.viewMessages.length).toBe(seen2)
    viewer.ws.close()

    // 桌面被王悦负责的任务的运行占着：王悦能操作，李静不能
    const [owned] = await ctx.db
      .select({ id: t.sessions.id })
      .from(t.sessions)
      .innerJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))
      .where(and(eq(t.tasks.ownerId, "u-wang"), isNull(t.sessions.snapshot), notInArray(t.sessions.id, holders)))
      .limit(1)
    expect(owned).toBeDefined()
    await occupy(dkA, owned!.id)
    const owner = await open(wang, path)
    await waitFor(async () => owner.messages.length >= 1)
    expect(owner.messages[0]).toMatchObject({ t: "meta", canControl: true })
    owner.ws.close()
    expect(await status({ cookie: li }, path)).toBe(403)
    await free(dkA)

    // 桌面服务连不上：502
    expect(await status({ cookie: lin }, `/api/desktop/view/${dkDead}`)).toBe(502)
    // 密钥不对：桌面服务先接受再用 4401 关，API 转成 closed 消息再用 4401 关（控制台据此不再重连）
    const wrong = (await mutate(ctx.app, "desktops.create", lin, { name: "密钥错了", description: "", mcpUrl: mcp.url, agentUrl: agent.url, key: "wrong-key-0000000000000000" })).data.id as string
    const rejected = await new Promise<{ messages: unknown[]; code: number }>((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/desktop/view/${wrong}`, { headers: { cookie: lin } })
      const messages: unknown[] = []
      ws.on("message", (data) => messages.push(JSON.parse(String(data))))
      ws.on("close", (code) => resolve({ messages, code }))
      ws.on("unexpected-response", (_req, res) => reject(new Error(`升级失败 ${res.statusCode}`)))
    })
    expect(rejected).toEqual({ messages: [{ t: "closed", reason: "桌面服务拒绝了连接：密钥不对（请在「桌面」页检查密钥）" }], code: 4401 })
    await mutate(ctx.app, "desktops.delete", lin, { id: wrong })
    await new Promise((resolve) => server.close(resolve))
  })
})
