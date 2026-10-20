// 派活第二期（docs/dev/dispatch-p2.md 第 9.3 节）：真实的测试库 + 进程内 worker + 假模型。
// 覆盖：导入直接导成派活（toPlan、organize 六条、commit 连关联、撤销）；派活方等结果（四处叫醒、中间重试不叫醒、
// 先结束后等、挂起窗口补发）；work.list；work.report（合并、办不成、只有被派的运行有）；自动重试（重试 / 不重试的几种、
// 到点才领、重办清零、只在最后一次通知）；没有检查点就不提检查点。
import { WORK_DISPATCH_TOOL_ID, workDoneEvent, type ImportPlan, type PlanTask, type SessionSnapshot, type TaskDispatch } from "@heyagent/shared"
import { and, asc, eq, inArray, like, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { listFromAgent, reportFromAgent } from "../src/engine/dispatch/agent-tools.js"
import { dispatchFromAgent } from "../src/engine/dispatch/dispatch.js"
import { recheckWorkDoneAfterSuspend } from "../src/engine/dispatch/notify.js"
import { pumpTask } from "../src/engine/dispatch/pump.js"
import { settleWorkItemInTx } from "../src/engine/dispatch/settle.js"
import { sweepWork } from "../src/engine/dispatch/sweep.js"
import { createHumanItem, resolveHumanItemImpl, resolveVerifyDisputeImpl } from "../src/engine/humans.js"
import { buildSystemPrompt } from "../src/engine/prompt.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { executeBuiltin } from "../src/engine/tools/builtin.js"
import { builtinToolList, type ImportCatalog } from "../src/imports/catalog.js"
import { organizePlan } from "../src/imports/organize.js"
import { ImportPackage } from "../src/imports/package.js"
import { toPlan, type PlanModelOutput } from "../src/imports/prompt.js"
import { SecretCollector } from "../src/imports/redact.js"
import { login, query } from "./helpers.js"
import {
  bossJobs,
  call,
  finishWith,
  createTask,
  messagesOf,
  mutate,
  Script,
  sessionRow,
  setupEngine,
  step,
  text,
  useScript,
  waitFor,
  waitStatus,
  type CallOptions,
  type EngineTestContext,
} from "./engine-helpers.js"

let ctx: EngineTestContext
let lin: string // 主管
let wang: string // 员工，测试任务的负责人（createTask 默认 u-wang）

beforeAll(async () => {
  ctx = await setupEngine()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
}, 120_000)

afterAll(async () => {
  for (const g of gates) g.open()
  await ctx?.stop()
})

const DISPATCH: TaskDispatch = {
  results: [],
  params: [
    { name: "单号", description: "要办的单号", required: true, dedupe: true },
    { name: "备注", description: "", required: false, dedupe: false },
  ],
  maxRunning: 1,
}

const promptOf = (options: CallOptions) => JSON.stringify(options.prompt)

/** 每次都照同一个函数回复的假模型 */
function responder(modelId: string, fn: (options: CallOptions) => ReturnType<typeof step> | Promise<ReturnType<typeof step>>) {
  return useScript(modelId, new Script(Array.from({ length: 200 }, () => fn)))
}

/** 模型调用卡住，直到 open() */
const gates: { open: () => void }[] = []
function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  const g = { promise, open }
  gates.push(g)
  return g
}

/** 一对任务：派活的（选了「派活」工具）和被派的（能被派活，谁能派活给它 = 派活的） */
async function makePair(options: { workerModel: string; patrolModel?: string; enabled?: boolean; dispatch?: Partial<TaskDispatch>; steps?: { id: string; text: string; wait: boolean; checkpoint?: string }[] }) {
  const patrol = await createTask(ctx.db, { modelId: options.patrolModel ?? "test/none", toolIds: ["work.dispatch"], title: "巡检" })
  const worker = await createTask(ctx.db, { modelId: options.workerModel, enabled: options.enabled ?? true, title: "办一件事", steps: options.steps })
  await ctx.db
    .update(t.tasks)
    .set({ dispatch: { ...DISPATCH, ...options.dispatch } })
    .where(eq(t.tasks.id, worker))
  await ctx.db.insert(t.taskDispatchSources).values({ taskId: worker, sourceTaskId: patrol })
  return { patrol, worker }
}

const itemRow = async (id: string) => (await ctx.db.select().from(t.workItems).where(eq(t.workItems.id, id)))[0]!

async function waitItem(id: string, check: (row: typeof t.workItems.$inferSelect) => boolean, what: string, timeout = 20_000) {
  return waitFor(
    async () => {
      const row = await itemRow(id)
      return check(row) ? row : undefined
    },
    { timeout, what: `${id} ${what}` }
  )
}

let fakeNo = 0
/** 直接插一行运行（不经过引擎，没有快照、不会被执行） */
async function fakeRun(taskId: string, extra: Partial<typeof t.sessions.$inferInsert> = {}) {
  const id = `R-p2-${++fakeNo}`
  await ctx.db.insert(t.sessions).values({ id, taskId, status: "done", modelId: "test/none", triggeredBy: "manual", startedAt: new Date(), ...extra })
  return (await sessionRow(ctx.db, id))!
}

/** 直接插一张单 */
async function fakeItem(taskId: string, extra: Partial<typeof t.workItems.$inferInsert> & { key: string }) {
  const n = Number((await ctx.db.execute<{ n: string }>(sql`select nextval('work_item_no_seq') as n`)).rows[0]!.n)
  const id = `W-${n}`
  await ctx.db.insert(t.workItems).values({ id, taskId, title: extra.key, params: { 单号: extra.key }, status: "queued", via: "human", ...extra })
  return id
}

/** 一张在办的单 + 它的运行（假的） */
async function runningItem(worker: string, key: string, session: Partial<typeof t.sessions.$inferInsert> = {}, item: Partial<typeof t.workItems.$inferInsert> = {}) {
  const id = await fakeItem(worker, { key, status: "running", ...item })
  const run = await fakeRun(worker, { status: "running", workItemId: id, triggeredBy: "dispatch", ...session })
  await ctx.db.update(t.workItems).set({ sessionId: run.id }).where(eq(t.workItems.id, id))
  return { id, run }
}

/** 不经过模型，以派活方某次运行的身份派活，返回新建的单号 */
async function agentDispatch(patrol: string, worker: string, keys: string[], session?: Awaited<ReturnType<typeof fakeRun>>) {
  const row = session ?? (await fakeRun(patrol))
  const snapshot = await buildSnapshot(ctx.db, patrol, { source: "manual", runAttachments: [] })
  const result = await dispatchFromAgent({ db: ctx.db, session: row, snapshot }, { task: worker, items: keys.map((key) => ({ title: `单 ${key}`, params: { 单号: key } })) })
  return { ids: [...result.output.matchAll(/(W-\d+) 新建/g)].map((match) => match[1]!), session: row, output: result.output }
}

/** 派活方的一次运行挂起等 work.done:<单号>（假的运行：被叫醒后没有快照，引擎不碰它） */
async function waitingOn(patrol: string, itemId: string) {
  const session = await fakeRun(patrol, { status: "waiting" })
  const [wait] = await ctx.db
    .insert(t.sessionWaits)
    .values({ sessionId: session.id, what: `等 ${itemId} 的结果`, triggerKind: "event", event: workDoneEvent(itemId) })
    .returning()
  return { session, waitId: wait!.id }
}

const waitRow = async (id: number) => (await ctx.db.select().from(t.sessionWaits).where(eq(t.sessionWaits.id, id)))[0]!
const waitFired = (id: number) => waitFor(async () => ((await waitRow(id)).status === "fired" ? waitRow(id) : undefined), { what: `等待 ${id} 被叫醒` })
const lastMessage = async (sessionId: string) => JSON.stringify((await messagesOf(ctx.db, sessionId)).at(-1)?.content)
const notifyJobsOf = async (itemId: string) => (await bossJobs(ctx.db, "work.notify")).filter((job) => job.data.itemId === itemId)

// ---------- 导入 ----------

const catalog: ImportCatalog = {
  staff: [{ id: "u-wang", name: "王悦", title: "", isAdmin: false }],
  models: [],
  defaults: {},
  profiles: [],
  platforms: [],
  accounts: [],
  skills: [],
  memories: [],
  rules: [],
  tools: [],
  servers: [],
  tasks: [],
  secretNames: [],
  builtins: builtinToolList(),
}

const planTask = (key: string, extra: Partial<PlanTask> = {}): PlanTask => ({
  key,
  include: true,
  title: `任务 ${key}`,
  goal: "做完",
  steps: [],
  schedule: null,
  ownerId: "u-wang",
  modelId: null,
  browserProfileIds: [],
  allowedDomains: [],
  logins: [],
  skillKeys: [],
  memoryKeys: [],
  ruleKeys: [],
  toolKeys: [],
  attachments: [],
  dispatch: null,
  source: "",
  ...extra,
})

const emptyPlan = (tasks: PlanTask[], extra: Partial<ImportPlan> = {}): ImportPlan => ({
  v: 1,
  name: "测试包",
  summary: "",
  warnings: [],
  tasks,
  skills: [],
  memories: [],
  rules: [],
  tools: [],
  secrets: [],
  unused: [],
  ...extra,
})

const organize = (plan: ImportPlan) => organizePlan(plan, { catalog, uploaderId: "u-wang", pkg: new ImportPackage([], new SecretCollector()), collector: new SecretCollector() })

describe("导入直接导成派活", () => {
  it("toPlan：不接受派活的 dispatch = null，忽略其余三个字段；接受的转成参数、名额、派活方", () => {
    const task = (key: string, extra: Partial<PlanModelOutput["tasks"][number]>): PlanModelOutput["tasks"][number] => ({
      key,
      enabled: true,
      title: `任务 ${key}`,
      goal: "做完",
      steps: [],
      cron: "",
      scheduleText: "",
      ownerId: "",
      modelId: "",
      modelNote: "",
      browserProfileIds: [],
      allowedDomains: [],
      logins: [],
      skillKeys: [],
      memoryKeys: [],
      ruleKeys: [],
      toolKeys: [],
      attachments: [],
      acceptsDispatch: false,
      dispatchParams: [{ name: "不该出现", description: "", required: true, dedupe: true }],
      dispatchMaxRunning: 3,
      dispatchFromKeys: ["t2"],
      source: "",
      ...extra,
    })
    const { plan } = toPlan({
      name: "包",
      summary: "",
      warnings: [],
      tasks: [
        task("t1", {}),
        task("t2", { acceptsDispatch: true, dispatchParams: [{ name: " 单号 ", description: "要办的单", required: true, dedupe: true }], dispatchMaxRunning: 2.4, dispatchFromKeys: [" t1 "] }),
      ],
      skills: [],
      memories: [],
      rules: [],
      tools: [],
      unused: [],
    })
    expect(plan.tasks[0]!.dispatch).toBeNull()
    expect(plan.tasks[1]!.dispatch).toEqual({ params: [{ name: "单号", description: "要办的单", required: true, dedupe: true }], maxRunning: 2, fromKeys: ["t1"] })
  })

  it("organize 六条：派活方对上、补「派活」工具、参数去重、名额范围、去掉定时、没有派活方提醒", () => {
    const plan = organize(
      emptyPlan([
        planTask("t1", { title: "巡检", schedule: { cron: "*/5 * * * *", text: "每 5 分钟" } }),
        planTask("t2", {
          title: "办一件事",
          schedule: { cron: "* * * * *", text: "每分钟" },
          dispatch: {
            params: [
              { name: " 单号 ", description: " 单号 ", required: true, dedupe: true },
              { name: "单号", description: "重复的", required: false, dedupe: false },
              { name: "  ", description: "空的", required: false, dedupe: false },
            ],
            maxRunning: 30,
            fromKeys: ["t1", "t9", "t2"],
          },
        }),
        planTask("t3", { title: "没人派", dispatch: { params: [], maxRunning: 0, retries: 9, retryDelayMinutes: 0, fromKeys: [] } }),
      ])
    )
    const [t1, t2, t3] = plan.tasks
    const titles = plan.warnings.map((warning) => `${warning.title}｜${warning.text}`)
    // ① 派活方只留方案里有的、不是自己的
    expect(t2!.dispatch!.fromKeys).toEqual(["t1"])
    expect(titles).toContainEqual(expect.stringContaining("「办一件事」的派活方对不上｜派活方 t9、t2"))
    // ② 补一项内置工具「派活」，加进派活方
    const tool = plan.tools.find((each) => each.refId === WORK_DISPATCH_TOOL_ID)!
    expect(tool).toMatchObject({ kind: "builtin", include: true, name: "派活", why: "把事派给「办一件事」" })
    expect(t1!.toolKeys).toEqual([tool.key])
    expect(t2!.toolKeys).toEqual([])
    // ③ 参数去空白、去重、去空 ④ 名额卡在 1～20
    expect(t2!.dispatch!.params).toEqual([{ name: "单号", description: "单号", required: true, dedupe: true }])
    expect(t2!.dispatch!.maxRunning).toBe(20)
    expect(t3!.dispatch!.maxRunning).toBe(1)
    // 自动重试（向导里改的）也卡范围；没写的不加
    expect(t3!.dispatch).toMatchObject({ retries: 5, retryDelayMinutes: 1 })
    expect(t2!.dispatch!.retries).toBeUndefined()
    // ⑤ 被派活的去掉定时，派活方的定时留着
    expect(t2!.schedule).toBeNull()
    expect(t1!.schedule).not.toBeNull()
    expect(titles).toContainEqual(expect.stringContaining("「办一件事」会被派活，不用定时｜原来的定时「每分钟」已去掉"))
    // ⑥ 没有派活方：照样导入，提醒
    expect(titles).toContainEqual(expect.stringContaining("还没有任务派活给「没人派」"))

    // 方案里已经有「派活」工具：不再补，用它
    const again = organize(
      emptyPlan([planTask("t1", { toolKeys: [] }), planTask("t2", { dispatch: { params: [], maxRunning: 1, fromKeys: ["t1"] } })], {
        tools: [{ key: "x7", include: true, kind: "builtin", name: "派活", summary: "派活", refId: WORK_DISPATCH_TOOL_ID }],
      })
    )
    expect(again.tools.map((each) => each.key)).toEqual(["x7"])
    expect(again.tasks[0]!.toolKeys).toEqual(["x7"])
  })

  let importNo = 0
  /** 直接插一条待确认的导入（方案已经整理好），再走导入接口 */
  async function commitPlan(plan: ImportPlan) {
    const id = `IM-p2-${++importNo}`
    await ctx.db.insert(t.imports).values({ id, fileName: "x.zip", size: 1, modelId: "test/none", status: "review", plan, createdById: "u-lin" })
    const res = await mutate(ctx.app, "imports.commit", lin, { id })
    if (res.error) throw new Error(`导入失败：${res.error.message}`)
    const [row] = await ctx.db.select().from(t.imports).where(eq(t.imports.id, id))
    return { id, result: row!.result! }
  }
  const sourcesOf = async (taskId: string) => (await ctx.db.select().from(t.taskDispatchSources).where(eq(t.taskDispatchSources.taskId, taskId))).map((row) => row.sourceTaskId)

  it("commit：被派的任务带 dispatch，派活方排在后面也连上；派活方没勾上就不连，导入后的事改成「派一张试试」；撤销后关联也没了", async () => {
    const plan = organize(
      emptyPlan([
        // 被派的排在前面：建它的时候派活方还没建
        planTask("t2", { title: "办一件事（导入）", dispatch: { params: [{ name: "单号", description: "", required: true, dedupe: true }], maxRunning: 2, retries: 2, retryDelayMinutes: 30, fromKeys: ["t1"] } }),
        planTask("t1", { title: "巡检（导入）" }),
      ])
    )
    const { id, result } = await commitPlan(plan)
    const ids = Object.fromEntries(result.tasks.map((each) => [each.key, each.id]))
    const [receiver] = await ctx.db.select().from(t.tasks).where(eq(t.tasks.id, ids.t2!))
    expect(receiver!.dispatch).toEqual({ params: [{ name: "单号", description: "", required: true, dedupe: true }], results: [], maxRunning: 2, retries: 2, retryDelayMinutes: 30 })
    // 任务列表接口带出重试两项（TaskDef 的形状里有，保存一次不会被剥掉）
    expect((await query(ctx.app, "tasks.list", lin)).data.find((task: { id: string }) => task.id === ids.t2).dispatch).toMatchObject({ retries: 2, retryDelayMinutes: 30 })
    expect(await sourcesOf(ids.t2!)).toEqual([ids.t1])
    const senderTools = await ctx.db.select().from(t.taskTools).where(eq(t.taskTools.taskId, ids.t1!))
    expect(senderTools.map((link) => link.refId)).toEqual([WORK_DISPATCH_TOOL_ID])
    // 导入后还要做的事：被派的任务是「派一张试试」，派活方照旧试跑
    const detail = (await query(ctx.app, "imports.get", lin, { id })).data
    const tryReceiver = detail.followUps.find((each: { key: string }) => each.key === `try_run:${ids.t2}`)
    expect(tryReceiver).toMatchObject({ title: "派一张试试「办一件事（导入）」", done: false, link: `#/work?task=${ids.t2}&new=1` })
    expect(tryReceiver.action).toBeUndefined()
    expect(detail.followUps.find((each: { key: string }) => each.key === `try_run:${ids.t1}`)).toMatchObject({ action: "run_task" })
    await fakeItem(ids.t2!, { key: "try-1", status: "cancelled" })
    const after = (await query(ctx.app, "imports.get", lin, { id })).data
    expect(after.followUps.find((each: { key: string }) => each.key === `try_run:${ids.t2}`).done).toBe(true)
    await ctx.db.delete(t.workItems).where(eq(t.workItems.taskId, ids.t2!))

    // 撤销：没跑过的任务删掉，关联随任务级联删除
    expect((await mutate(ctx.app, "imports.undo", lin, { id })).error).toBeUndefined()
    expect(await ctx.db.select().from(t.taskDispatchSources).where(inArray(t.taskDispatchSources.taskId, [ids.t1!, ids.t2!]))).toEqual([])
    expect(await ctx.db.select().from(t.tasks).where(inArray(t.tasks.id, [ids.t1!, ids.t2!]))).toEqual([])

    // 派活方没勾上：被派的照样建、不连，导入后的事里提醒
    const unchecked = organize(
      emptyPlan([
        planTask("t1", { title: "巡检（没勾）", include: false }),
        planTask("t2", { title: "办一件事（没人派）", dispatch: { params: [], maxRunning: 1, fromKeys: ["t1"] } }),
      ])
    )
    const second = await commitPlan(unchecked)
    expect(second.result.tasks.map((each) => each.key)).toEqual(["t2"])
    const lonely = second.result.tasks[0]!.id
    expect(await sourcesOf(lonely)).toEqual([])
    const followUp = (await query(ctx.app, "imports.get", lin, { id: second.id })).data.followUps.find((each: { key: string }) => each.key === `try_run:${lonely}`)
    expect(followUp.description).toContain("现在还没有任务派活给它")

    // 方案改错了（派活方 key 对不上）：导入前就挡掉
    const broken = emptyPlan([planTask("t2", { dispatch: { params: [], maxRunning: 1, fromKeys: ["t404"] } })])
    await expect(commitPlan(broken)).rejects.toThrow(/派活方引用了不存在的 key：t404/)
  })
})

// ---------- 派活方等结果 ----------

describe("派活方等结果：单结束时叫醒", () => {
  it("办完：叫醒等 work.done 的运行，消息里有总结和报的结果", async () => {
    responder("test/p2-wake-done", (options) =>
      promptOf(options).includes("已写到派活单") ? step(finishWith("办完了：已处理")) : step([call("work.report", { data: { 件数: 3, 已回填: true } })])
    )
    const { patrol, worker } = await makePair({ workerModel: "test/p2-wake-done", enabled: false })
    const { ids } = await agentDispatch(patrol, worker, ["D-1"])
    const { session, waitId } = await waitingOn(patrol, ids[0]!)
    await ctx.db.update(t.tasks).set({ enabled: true }).where(eq(t.tasks.id, worker))
    await pumpTask(ctx.db, worker)
    await waitFired(waitId)
    const message = await lastMessage(session.id)
    expect(message).toContain(`等到了事件「work.done:${ids[0]}」（派活单结束）`)
    // 没配复核模型：单办完，结果没核实（一句话里标出来）
    expect(message).toContain(`${ids[0]}「单 D-1」办完（没核实：`)
    expect(message).toContain("：办完了：已处理 · 结果：件数=3，已回填=是")
    expect(message).toContain('\\"outcome\\":\\"unverified\\"')
    expect(message).toContain('\\"report\\":{\\"件数\\":3,\\"已回填\\":true}')
  })

  it("没办成（运行出错，不重试）：叫醒", async () => {
    responder("test/p2-wake-fail", () => {
      throw new Error("模型坏了")
    })
    const { patrol, worker } = await makePair({ workerModel: "test/p2-wake-fail", enabled: false })
    const { ids } = await agentDispatch(patrol, worker, ["D-2"])
    const { session, waitId } = await waitingOn(patrol, ids[0]!)
    await ctx.db.update(t.tasks).set({ enabled: true }).where(eq(t.tasks.id, worker))
    await pumpTask(ctx.db, worker)
    await waitFired(waitId)
    expect(await lastMessage(session.id)).toContain(`${ids[0]}「单 D-2」没办成：模型调用失败`)
    expect(await itemRow(ids[0]!)).toMatchObject({ status: "failed", failKind: "error" })
  })

  it("不办了：叫醒", async () => {
    const { patrol, worker } = await makePair({ workerModel: "test/none", enabled: false })
    const { ids } = await agentDispatch(patrol, worker, ["D-3"])
    const { session, waitId } = await waitingOn(patrol, ids[0]!)
    expect((await mutate(ctx.app, "work.cancel", wang, { id: ids[0], reason: "不要了" })).error).toBeUndefined()
    await waitFired(waitId)
    expect(await lastMessage(session.id)).toContain(`${ids[0]}「单 D-3」不办了：王悦点了不办了：不要了`)
  })

  it("清扫补写：叫醒；中间排队等重试的不叫醒", async () => {
    const { patrol, worker } = await makePair({ workerModel: "test/none", enabled: false })
    const { id } = await runningItem(worker, "D-4", { status: "done", endedAt: new Date() }, { fromTaskId: patrol })
    const { waitId } = await waitingOn(patrol, id)
    await sweepWork(ctx.db)
    await waitFired(waitId)

    // 配了自动重试：运行记录没了 → 回到排队等重试，不叫醒
    await ctx.db.update(t.tasks).set({ dispatch: { ...DISPATCH, retries: 1, retryDelayMinutes: 30 } }).where(eq(t.tasks.id, worker))
    const orphan = await fakeItem(worker, { key: "D-5", status: "running", fromTaskId: patrol })
    const pending = await waitingOn(patrol, orphan)
    await sweepWork(ctx.db)
    expect(await itemRow(orphan)).toMatchObject({ status: "queued", autoRetries: 1, error: "运行记录没了，没法知道办得怎么样" })
    expect(await notifyJobsOf(orphan)).toEqual([])
    expect((await waitRow(pending.waitId)).status).toBe("waiting")
  })

  it("session.wait 等 work.done：单已经结束就不挂起直接给结果；不是自己派的单报错；还没结束的照常挂起", async () => {
    const { patrol, worker } = await makePair({ workerModel: "test/none", enabled: false })
    const { ids } = await agentDispatch(patrol, worker, ["E-1", "E-2"])
    await ctx.db
      .update(t.workItems)
      .set({ status: "done", finishedAt: new Date(), result: { summary: "早就办完了", fileIds: [], data: { 件数: 1 } } })
      .where(eq(t.workItems.id, ids[0]!))
    const tool = async (taskId: string, event: string) =>
      executeBuiltin({ db: ctx.db, session: await fakeRun(taskId), snapshot: await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] }) }, "session.wait", { what: "等结果", event })
    const done = await tool(patrol, workDoneEvent(ids[0]!))
    expect(done.suspend).toBeUndefined()
    expect(done.output).toContain(`不用等了，派活单已经结束：${ids[0]}「单 E-1」办完：早就办完了 · 结果：件数=1`)
    const open = await tool(patrol, workDoneEvent(ids[1]!))
    expect(open.suspend).toMatchObject({ kind: "wait", input: { event: workDoneEvent(ids[1]!) } })
    const other = await createTask(ctx.db, { modelId: "test/none" })
    const stranger = await tool(other, workDoneEvent(ids[1]!))
    expect(stranger.isError).toBe(true)
    expect(stranger.output).toContain(`没有这个任务派出去的派活单 ${ids[1]}`)
    expect((await tool(patrol, workDoneEvent("W-999999"))).isError).toBe(true)
  })

  it("挂起窗口：单在挂起提交之前就结束了（那次叫醒没看到等待），挂起后再查一次补发", async () => {
    const { patrol, worker } = await makePair({ workerModel: "test/none", enabled: false })
    const id = await fakeItem(worker, { key: "E-3", status: "done", fromTaskId: patrol, result: { summary: "办完了", fileIds: [] } })
    const { waitId } = await waitingOn(patrol, id)
    await recheckWorkDoneAfterSuspend(ctx.db, workDoneEvent(id))
    await waitFired(waitId)
  })

  it("真跑一遍：派活方派完用 session.wait 等，被派的办完后派活方被叫醒接着办完", async () => {
    const g = gate()
    responder("test/p2-e2e-worker", async (options) => {
      if (promptOf(options).includes("已写到派活单")) return step(finishWith("办完了：E2E 已处理"))
      await g.promise
      return step([call("work.report", { data: { 件数: 2 } })])
    })
    let itemId = ""
    const patrolScript = responder("test/p2-e2e-patrol", (options) => {
      const prompt = promptOf(options)
      if (prompt.includes("【继续】")) return step([text("收到结果，结束")])
      const created = /(W-\d+) 新建/.exec(prompt)
      if (created) {
        itemId = created[1]!
        return step([call("session.wait", { what: "等单办完", event: workDoneEvent(itemId) })])
      }
      const workerId = /T-\d+「办一件事」/.exec(prompt)![0].split("「")[0]
      return step([call("work.dispatch", { task: workerId, items: [{ title: "单 E2E-1", params: { 单号: "E2E-1" } }] })])
    })
    const { patrol } = await makePair({ workerModel: "test/p2-e2e-worker", patrolModel: "test/p2-e2e-patrol" })
    const run = await mutate(ctx.app, "engine.runNow", wang, { taskId: patrol })
    const sessionId = run.data.sessionId as string
    await waitStatus(ctx.db, sessionId, "waiting")
    // 派活方的系统提示里有怎么等结果；工具里自动带上了「查派过的活」
    const system = promptOf(patrolScript.prompts[0]!)
    expect(system).toContain("要等结果时：用 session_wait 等事件 work.done:<单号>，一次等一张；醒来后用 work_list 看其余的。")
    expect((patrolScript.prompts[0]!.tools ?? []).map((each) => each.name)).toContain("work_list")
    g.open()
    await waitStatus(ctx.db, sessionId, "done")
    expect(await itemRow(itemId)).toMatchObject({ status: "done", result: { summary: "办完了：E2E 已处理", data: { 件数: 2 } } })
    const resumed = JSON.stringify((await messagesOf(ctx.db, sessionId)).map((message) => message.content))
    expect(resumed).toContain(`${itemId}「单 E2E-1」办完（没核实：`)
    expect(resumed).toContain("：办完了：E2E 已处理 · 结果：件数=2")
  }, 60_000)
})

// ---------- work.list ----------

describe("work.list：查派过的活", () => {
  it("只看自己任务派的；thisRun 只看这次运行的；open 只看没结束的；按单号查；还有更多时提示", async () => {
    const { patrol, worker } = await makePair({ workerModel: "test/none", enabled: false })
    const other = await createTask(ctx.db, { modelId: "test/none", toolIds: ["work.dispatch"], title: "另一个巡检" })
    await ctx.db.insert(t.taskDispatchSources).values({ taskId: worker, sourceTaskId: other })
    const first = await agentDispatch(patrol, worker, ["L-1", "L-2", "L-3"])
    const second = await agentDispatch(patrol, worker, ["L-4"])
    const foreign = await agentDispatch(other, worker, ["L-9"])
    await ctx.db
      .update(t.workItems)
      .set({ status: "done", finishedAt: new Date(), result: { summary: "办完了", fileIds: [], data: { 件数: 3 } } })
      .where(eq(t.workItems.id, first.ids[0]!))
    const list = async (input: Record<string, unknown>, session = first.session) =>
      (await listFromAgent({ db: ctx.db, session, snapshot: await buildSnapshot(ctx.db, patrol, { source: "manual", runAttachments: [] }) }, input as never)).output

    const all = await list({})
    expect(all).toContain("这个任务派出去的单：共 4 张。")
    for (const id of [...first.ids, ...second.ids]) expect(all).toContain(`- ${id}「`)
    expect(all).not.toContain(foreign.ids[0]!)
    // 最新的在前；办完的带结果
    expect(all.indexOf(second.ids[0]!)).toBeLessThan(all.indexOf(first.ids[0]!))
    expect(all).toMatch(new RegExp(`${first.ids[0]}「单 L-1」办完（[^）]+）：办完了 · 结果：件数=3`))

    const thisRun = await list({ thisRun: true })
    expect(thisRun).toContain("这次运行派出去的单：共 3 张。")
    expect(thisRun).not.toContain(second.ids[0]!)

    const open = await list({ status: "open" })
    expect(open).toContain("这个任务派出去的还没结束的单：共 3 张。")
    expect(open).not.toContain(first.ids[0]!)

    const byId = await list({ items: [first.ids[1], foreign.ids[0]] })
    expect(byId).toContain(`- ${first.ids[1]}「单 L-2」排队`)
    expect(byId).toContain(`没有找到：${foreign.ids[0]}（不存在，或者不是这个任务派的）`)

    const limited = await list({ limit: 2 })
    expect(limited).toContain("共 4 张，列出最新的 2 张")
    expect(limited).toContain("还有 2 张没列出来，用 status / items 缩小范围。")
  })
})

// ---------- work.report ----------

describe("work.report：报结果", () => {
  /** 被派来的运行的快照（假的运行，直接调工具） */
  async function dispatchedCtx(worker: string, key: string) {
    const { id, run } = await runningItem(worker, key)
    const snapshot = await buildSnapshot(ctx.db, worker, { source: "dispatch", runAttachments: [], dispatch: { itemId: id, key, title: key, params: { 单号: key }, depth: 1 } })
    return { id, ctx: { db: ctx.db, session: run, snapshot } }
  }

  it("可以调多次、合并、同名以后一次为准；办不成记下、可以撤回；字段太多拒绝；不是被派的运行报不了", async () => {
    const { worker } = await makePair({ workerModel: "test/none", enabled: false })
    const { id, ctx: tool } = await dispatchedCtx(worker, "M-1")
    expect((await reportFromAgent(tool, { data: { 件数: 1, 备注: "先这样" } })).output).toBe(`已写到派活单 ${id}：件数=1，备注=先这样。`)
    expect((await reportFromAgent(tool, { data: { 件数: 3, 已回填: false } })).output).toContain("件数=3，备注=先这样，已回填=否")
    let row = await itemRow(id)
    expect(row.result).toEqual({ summary: "", fileIds: [], data: { 件数: 3, 备注: "先这样", 已回填: false } })
    expect(row.log.filter((entry) => entry.kind === "reported")).toEqual([expect.objectContaining({ sessionId: row.sessionId, note: "件数=1，备注=先这样" })])
    // 页面接口能读到「已报」
    expect((await query(ctx.app, "work.get", wang, { id })).data.result.data).toEqual({ 件数: 3, 备注: "先这样", 已回填: false })

    expect((await reportFromAgent(tool, { outcome: "not_done" })).isError).toBe(true)
    const notDone = await reportFromAgent(tool, { outcome: "not_done", reason: "找不到" })
    expect(notDone.output).toContain("这件办不成（找不到）")
    row = await itemRow(id)
    expect(row).toMatchObject({ status: "running", failKind: "not_done", error: "agent 判断办不成：找不到" })
    // 在办的单不显示 failKind
    expect((await query(ctx.app, "work.get", wang, { id })).data.failKind).toBeNull()
    expect((await reportFromAgent(tool, { outcome: "done" })).output).toContain("之前报的「办不成」已撤回")
    expect(await itemRow(id)).toMatchObject({ failKind: null, error: null })

    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`字段${i}`, i]))
    const tooMany = await reportFromAgent(tool, { data: many })
    expect(tooMany.isError).toBe(true)
    expect(tooMany.output).toContain("最多 20 个字段")
    expect((await reportFromAgent(tool, {})).isError).toBe(true)

    const plain = { ...tool, snapshot: await buildSnapshot(ctx.db, worker, { source: "manual", runAttachments: [] }) }
    expect((await reportFromAgent(plain, { data: { 件数: 1 } })).output).toContain("这次运行不是被派来的")
  })

  it("只有被派来的运行有「报结果」，选了「派活」的有「查派过的活」；两个都不在 tools 表里（不能单独选）", async () => {
    const { patrol, worker } = await makePair({ workerModel: "test/none", enabled: false })
    const ids = (snapshot: SessionSnapshot) => snapshot.tools.map((tool) => tool.id)
    const plainWorker = await buildSnapshot(ctx.db, worker, { source: "manual", runAttachments: [] })
    expect(ids(plainWorker)).not.toContain("work.report")
    expect(ids(plainWorker)).not.toContain("work.list")
    const dispatched = await buildSnapshot(ctx.db, worker, { source: "dispatch", runAttachments: [], dispatch: { itemId: "W-1", key: "k", title: "k", params: {}, depth: 1 } })
    expect(ids(dispatched)).toContain("work.report")
    const system = buildSystemPrompt(dispatched, new Map([["work.report", "work_report"]]))
    expect(system).toContain("有要交回去的结果（数字、是 / 否、编号），用 work_report 写；办不成（例如找不到、对方拒绝）就调用 run_finish 报没办成并写清原因。")
    expect(ids(await buildSnapshot(ctx.db, patrol, { source: "manual", runAttachments: [] }))).toContain("work.list")
    expect(await ctx.db.select().from(t.tools).where(inArray(t.tools.id, ["work.list", "work.report"]))).toEqual([])
  })

  it("真跑：agent 报办不成 → 运行没完成，单记没办成（not_done），配了重试也不重试，照常通知负责人", async () => {
    responder("test/p2-notdone", (options) =>
      promptOf(options).includes("已记在派活单")
        ? step([text("办不成：14 个候选都不是同一个东西")])
        : step([call("work.report", { data: { 候选数: 14 }, outcome: "not_done", reason: "14 个候选都不是同一个东西" })])
    )
    const { worker } = await makePair({ workerModel: "test/p2-notdone", dispatch: { retries: 2, retryDelayMinutes: 1 } })
    const res = await mutate(ctx.app, "work.dispatch", wang, { taskId: worker, params: { 单号: "N-1" } })
    const id = res.data.item.id as string
    const row = await waitItem(id, (each) => each.status === "failed", "没办成")
    expect(row).toMatchObject({ failKind: "not_done", autoRetries: 0, attempts: 1, error: "agent 判断办不成：14 个候选都不是同一个东西" })
    expect(row.result).toMatchObject({ summary: "办不成：14 个候选都不是同一个东西", data: { 候选数: 14 } })
    expect(row.log.map((entry) => entry.kind)).toEqual(["created", "run_started", "reported", "run_ended"])
    expect((await sessionRow(ctx.db, row.sessionId!))!).toMatchObject({ status: "done", outcome: "not_achieved", outcomeBy: "agent", outcomeReason: "agent 判断办不成：14 个候选都不是同一个东西" })
    const notes = await ctx.db.select().from(t.notifications).where(eq(t.notifications.sessionId, row.sessionId!))
    expect(notes.map((note) => [note.title, note.body])).toEqual([[expect.stringContaining("：没办成"), "agent 判断办不成：14 个候选都不是同一个东西"]])
    const detail = (await query(ctx.app, "work.get", wang, { id })).data
    expect(detail.failKind).toBe("not_done")
  })
})

// ---------- 自动重试 ----------

describe("没办成自动重试", () => {
  it("运行出错：排队等重试（到点才领、不算名次、不通知、不叫醒），重试用完才没办成并通知一次；重办清零", async () => {
    responder("test/p2-retry", () => {
      throw new Error("上游超时")
    })
    const { worker } = await makePair({ workerModel: "test/p2-retry", dispatch: { retries: 2, retryDelayMinutes: 5 } })
    const res = await mutate(ctx.app, "work.dispatch", wang, { taskId: worker, params: { 单号: "Y-1" } })
    const id = res.data.item.id as string
    const sessions = new Set<string>()
    for (let retry = 1; retry <= 2; retry++) {
      const row = await waitItem(id, (each) => each.status === "queued" && each.autoRetries === retry, `排队等第 ${retry} 次重试`)
      sessions.add(row.sessionId!)
      expect(row.error).toContain("上游超时")
      expect(row.failKind).toBeNull()
      expect(row.result).toBeNull()
      expect(row.notBefore!.getTime()).toBeGreaterThan(Date.now() + 4 * 60_000)
      expect(row.log.at(-1)).toMatchObject({ kind: "retry_scheduled", retry, notBefore: row.notBefore!.toISOString() })
      expect(row.log.at(-2)).toMatchObject({ kind: "run_ended", note: "failed", sessionId: row.sessionId })
      // 到点才领；不算排队名次；返回给 agent 的写「第 n 次重试」
      expect((await pumpTask(ctx.db, worker)).started).toEqual([])
      const shown = (await query(ctx.app, "work.get", wang, { id })).data
      expect(shown).toMatchObject({ status: "queued", queuePosition: null, autoRetries: retry, notBefore: row.notBefore!.toISOString() })
      // 延迟的 work.pump：自己的 singletonKey，到点开
      const delayed = (await bossJobs(ctx.db, "work.pump")).filter((job) => job.data.taskId === worker && new Date(job.start_after).getTime() >= row.notBefore!.getTime() - 1000)
      expect(delayed.length).toBeGreaterThanOrEqual(1)
      // 清扫不给没到点的任务领单
      expect((await sweepWork(ctx.db)).pumped).not.toContain(worker)
      // 还会重试的这次不通知、不叫醒
      expect(await ctx.db.select().from(t.notifications).where(eq(t.notifications.sessionId, row.sessionId!))).toEqual([])
      expect(await notifyJobsOf(id)).toEqual([])
      // 拨到点：领单开下一次运行
      await ctx.db.update(t.workItems).set({ notBefore: new Date(Date.now() - 1000) }).where(eq(t.workItems.id, id))
      expect((await pumpTask(ctx.db, worker)).started.map((each) => each.itemId)).toEqual([id])
    }
    const failed = await waitItem(id, (each) => each.status === "failed", "重试用完没办成")
    sessions.add(failed.sessionId!)
    expect(failed).toMatchObject({ failKind: "error", autoRetries: 2, attempts: 3, notBefore: null })
    expect(failed.log.map((entry) => entry.kind)).toEqual(["created", "run_started", "run_ended", "retry_scheduled", "run_started", "run_ended", "retry_scheduled", "run_started", "run_ended"])
    const notes = await ctx.db.select().from(t.notifications).where(inArray(t.notifications.sessionId, [...sessions]))
    expect(notes.map((note) => note.body)).toEqual([expect.stringMatching(/^自动重试了 2 次都没办成：模型调用失败/)])
    expect((await notifyJobsOf(id)).length).toBe(1)

    // 重办：自动重试的次数清零，又有完整的 2 次
    await ctx.db.update(t.tasks).set({ enabled: false }).where(eq(t.tasks.id, worker))
    const redo = await mutate(ctx.app, "work.redo", wang, { id })
    expect(redo.data).toMatchObject({ status: "queued", autoRetries: 0, notBefore: null, failKind: null, error: null })
  }, 60_000)

  it("不重试的几种：人取消、人选不继续、人判验收失败、规则让它失败；清扫补写（运行出错）重试", async () => {
    const g = gate()
    responder("test/p2-noretry", async () => {
      await g.promise
      return step([text("办完了")])
    })
    const { worker } = await makePair({ workerModel: "test/p2-noretry", dispatch: { retries: 3, retryDelayMinutes: 5 } })
    // 人取消
    const res = await mutate(ctx.app, "work.dispatch", wang, { taskId: worker, params: { 单号: "Z-1" } })
    const running = await waitItem(res.data.item.id, (each) => each.status === "running", "在办")
    await waitStatus(ctx.db, running.sessionId!, "running")
    expect((await mutate(ctx.app, "engine.cancel", wang, { sessionId: running.sessionId, reason: "不用了" })).error).toBeUndefined()
    expect(await waitItem(running.id, (each) => each.status === "failed", "没办成")).toMatchObject({ failKind: "cancelled_run", autoRetries: 0, error: "王悦取消了这次运行：不用了" })
    g.open()
    await ctx.db.update(t.tasks).set({ enabled: false }).where(eq(t.tasks.id, worker))

    // 人选不继续（花费 / 步数上限）
    const limit = await runningItem(worker, "Z-2", { status: "needs_human" })
    const human = await createHumanItem(ctx.db, { kind: "approval", title: "步数到了上限，要不要继续", summary: "到上限了", assigneeId: "u-wang", taskId: worker, sessionId: limit.run.id, detail: { sections: [], primary: "继续", secondary: "不继续" } })
    await ctx.db.insert(t.sessionWaits).values({ sessionId: limit.run.id, what: "等人处理", triggerKind: "event", event: `等 ${human.id} 处理`, humanItemId: human.id, match: { limit: "steps" } })
    await resolveHumanItemImpl(ctx.db, { itemId: human.id, how: "reject", actorId: "u-wang", actorName: "王悦" })
    expect(await itemRow(limit.id)).toMatchObject({ status: "failed", failKind: "cancelled_run", autoRetries: 0 })

    // 人判验收失败
    const dispute = await runningItem(worker, "Z-3", { status: "needs_human", verification: { status: "disputed", at: new Date().toISOString(), headline: "没有证据", notes: [] } })
    const verify = await createHumanItem(ctx.db, { kind: "verify", title: "验收有争议", summary: "看一下", assigneeId: "u-wang", taskId: worker, sessionId: dispute.run.id, detail: { sections: [], primary: "算通过", secondary: "算失败" } })
    await ctx.db.insert(t.sessionWaits).values({ sessionId: dispute.run.id, what: "等人处理验收争议", triggerKind: "event", event: `等 ${verify.id} 处理`, humanItemId: verify.id })
    await resolveVerifyDisputeImpl(ctx.db, { itemId: verify.id, how: "fail", actorId: "u-lin", actorName: "林舟" })
    expect(await itemRow(dispute.id)).toMatchObject({ status: "failed", failKind: "cancelled_run", autoRetries: 0 })

    // 规则让它失败（failSession 传 retryable = false）
    const rule = await runningItem(worker, "Z-4")
    await ctx.db.transaction((tx) => settleWorkItemInTx(ctx.db, tx, rule.run.id, { status: "failed", error: "规则「花费超过 1 美元」：结束这次运行", retryable: false, failKind: "error" }))
    expect(await itemRow(rule.id)).toMatchObject({ status: "failed", failKind: "error", autoRetries: 0 })

    // 运行出错（验收判失败、程序出错这类）重试；清扫补写同样算运行出错
    const crashed = await runningItem(worker, "Z-5", { status: "failed", error: "worker 崩了" })
    await sweepWork(ctx.db)
    expect(await itemRow(crashed.id)).toMatchObject({ status: "queued", autoRetries: 1, error: "worker 崩了" })
  }, 60_000)
})

// ---------- 没有检查点就不提检查点 ----------

describe("没有检查点就不提检查点", () => {
  it("没写步骤的任务：给模型的工具里没有 checkpoint_mark，系统提示里没有「检查点」；有检查点的不变", async () => {
    const plain = responder("test/p2-nocp", () => step([text("做完了")]))
    const withCp = responder("test/p2-cp", () => step([text("做完了")]))
    const a = await createTask(ctx.db, { modelId: "test/p2-nocp" })
    const b = await createTask(ctx.db, { modelId: "test/p2-cp", steps: [{ id: "s1", text: "存一张表", wait: false, checkpoint: "表已经存好" }] })
    for (const taskId of [a, b]) {
      const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
      // 有检查点的那个没勾就说做完了：已结束，结果没办成
      const row = await waitStatus(ctx.db, res.data.sessionId, "done")
      expect(row.outcome).toBe(taskId === a ? "unverified" : "not_achieved")
    }
    const toolNames = (script: Script) => (script.prompts[0]!.tools ?? []).map((each) => each.name)
    expect(toolNames(plain)).not.toContain("checkpoint_mark")
    expect(toolNames(plain)).toEqual(expect.arrayContaining(["session_wait", "ask_human", "plan_set"]))
    expect(promptOf(plain.prompts[0]!)).not.toContain("检查点")
    expect(promptOf(plain.prompts[0]!)).toContain("验收员会按目标核对结果和证据")
    expect(toolNames(withCp)).toContain("checkpoint_mark")
    expect(promptOf(withCp.prompts[0]!)).toContain("## 检查点清单")
    expect(promptOf(withCp.prompts[0]!)).toContain("检查点有没勾的、全部跳过的记没办成")
    // 快照的 tools 不改（任务页、规则页照样显示它是自带的）
    const [session] = await ctx.db.select().from(t.sessions).where(and(eq(t.sessions.taskId, a), like(t.sessions.id, "R-%"))).orderBy(asc(t.sessions.startedAt))
    expect(session!.snapshot!.tools.map((tool) => tool.id)).toContain("checkpoint.mark")
  })
})
