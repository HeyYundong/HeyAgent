// 派活：被叫醒继续时也要名额（2026-11-02，docs/dev/dispatch.md 第 15 节第 1 条的改动）。真实的测试库 + 进程内 worker + 假模型。
// 覆盖：名额 1，A 等人处理 → B 领到；人处理完 A → A 等名额、不进执行中；B 办完 → 先放行 A（排队的新单 C 还排着），A 拿到原来的处理结果；
// 「立即继续」：普通等待名额满了先等名额，等名额的再点就插队；并发的继续不超名额；清扫兜底放行；外部不能发 work.slot: 事件。
import { WORK_SLOT_EVENT_PREFIX, workSlotEvent, type TaskDispatch } from "@heyagent/shared"
import { and, asc, eq, inArray } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { fireEventImpl } from "../src/engine/control.js"
import { pumpTask } from "../src/engine/dispatch/pump.js"
import { sweepWork } from "../src/engine/dispatch/sweep.js"
import { resolveHumanItemImpl } from "../src/engine/humans.js"
import { occupiedSlots } from "../src/work/service.js"
import { login, query } from "./helpers.js"
import {
  call,
  createTask,
  eventsOf,
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
let wang: string // 员工，测试任务的负责人（createTask 默认 u-wang）

beforeAll(async () => {
  ctx = await setupEngine()
  wang = await login(ctx.app, "wangyue@heyagent.local")
}, 120_000)

afterAll(async () => {
  for (const g of gates) g.open()
  await ctx?.stop()
})

const DISPATCH: TaskDispatch = {
  results: [],
  params: [{ name: "单号", description: "要办的单号", required: true, dedupe: true }],
  maxRunning: 1,
}

const promptOf = (options: CallOptions) => JSON.stringify(options.prompt)

function responder(modelId: string, fn: (options: CallOptions) => ReturnType<typeof step> | Promise<ReturnType<typeof step>>) {
  return useScript(modelId, new Script(Array.from({ length: 200 }, () => fn)))
}

/** 模型调用卡住，直到 open()：运行一直是「执行中」，占着名额 */
const gates: { open: () => void }[] = []
function gate() {
  let open!: () => void
  const promise = new Promise<void>((resolve) => (open = resolve))
  const g = { promise, open }
  gates.push(g)
  return g
}

/** 被派的任务（名额 maxRunning），加一个能派活给它的任务 */
async function makeWorker(modelId: string, maxRunning = 1) {
  const patrol = await createTask(ctx.db, { modelId: "test/none", toolIds: ["work.dispatch"], title: "巡检" })
  const worker = await createTask(ctx.db, { modelId, title: "办一件事" })
  await ctx.db.update(t.tasks).set({ dispatch: { ...DISPATCH, maxRunning } }).where(eq(t.tasks.id, worker))
  await ctx.db.insert(t.taskDispatchSources).values({ taskId: worker, sourceTaskId: patrol })
  return worker
}

const itemRow = async (id: string) => (await ctx.db.select().from(t.workItems).where(eq(t.workItems.id, id)))[0]!

async function humanDispatch(taskId: string, key: string) {
  const res = await mutate(ctx.app, "work.dispatch", wang, { taskId, params: { 单号: key } })
  if (!res.data) throw new Error(`派一张失败：${JSON.stringify(res.error)}`)
  return (res.data as { item: { id: string } }).item.id
}

/** 单的运行变成某个状态（返回运行编号） */
async function runOf(itemId: string, status: string) {
  return waitFor(
    async () => {
      const row = await itemRow(itemId)
      const session = row.sessionId ? await sessionRow(ctx.db, row.sessionId) : undefined
      return session?.status === status ? session.id : undefined
    },
    { what: `${itemId} 的运行变成 ${status}` }
  )
}

const waitingOf = async (sessionId: string) =>
  (await ctx.db.select().from(t.sessionWaits).where(and(eq(t.sessionWaits.sessionId, sessionId), eq(t.sessionWaits.status, "waiting"))))[0]

describe("被叫醒继续时也要名额", () => {
  it("名额 1：A 等人处理 → B 领到；处理完 A → A 等名额；B 办完先放行 A，再领排队的 C；A 拿到人处理的结果", async () => {
    const holdB = gate()
    const holdA = gate()
    const prompts = new Map<string, string>()
    responder("test/slot-human", async (options) => {
      const prompt = promptOf(options)
      if (prompt.includes("A-1")) {
        if (!prompt.includes("【继续】")) return step([call("ask.human", { question: "这单要不要加急？", options: ["要", "不要"] })])
        prompts.set("A", prompt)
        await holdA.promise
        return step([text("A 办完了")])
      }
      if (prompt.includes("B-1")) {
        await holdB.promise
        return step([text("B 办完了")])
      }
      return step([text("C 办完了")])
    })
    const worker = await makeWorker("test/slot-human", 1)
    const a = await humanDispatch(worker, "A-1")
    const aRun = await runOf(a, "needs_human")
    // A 等人处理不占名额：B 领到、在跑
    const b = await humanDispatch(worker, "B-1")
    await runOf(b, "running")
    const c = await humanDispatch(worker, "C-1")
    expect((await itemRow(c)).status).toBe("queued")

    const [human] = await ctx.db.select().from(t.humanItems).where(eq(t.humanItems.sessionId, aRun))
    const resolved = await mutate(ctx.app, "engine.resolveHumanItem", wang, { itemId: human!.id, how: "approve", note: "要加急" })
    expect(resolved.data).toEqual({ resumedSessionId: aRun, slotWaiting: true })
    // 不进执行中：挂起等名额，写清楚在等什么
    const row = await sessionRow(ctx.db, aRun)
    expect(row!.status).toBe("waiting")
    const wait = await waitingOf(aRun)
    expect(wait).toMatchObject({ event: workSlotEvent(worker), what: "等名额（任务同时最多 1 个在跑，空出来自动继续）" })
    expect(await occupiedSlots(ctx.db, worker)).toBe(1)
    const events = await eventsOf(ctx.db, aRun)
    expect(events.at(-1)).toMatchObject({ kind: "wait", title: "人处理完，继续；名额满了，先等名额" })
    // 页面上的数字：A 的单还是在办，另数「等名额 1」，不算进排队
    const stats = await query(ctx.app, "work.taskStats", wang, { taskId: worker })
    expect(stats.data).toMatchObject({ queued: 1, running: 2, occupied: 1, slotWaiting: 1, maxRunning: 1 })
    const overview = (await query(ctx.app, "work.queueStats", wang)).data.find((each: { taskId: string }) => each.taskId === worker)
    expect(overview).toMatchObject({ queued: 1, running: 2, occupied: 1, slotWaiting: 1 })
    // 单详情：在等名额
    const detail = await query(ctx.app, "work.get", wang, { id: a })
    expect(detail.data.runs.at(-1)).toMatchObject({ status: "waiting", waitingWhat: expect.stringContaining("等名额") })
    // 名额满着领单：既不放行 A，也不开 C
    expect(await pumpTask(ctx.db, worker)).toMatchObject({ started: [], released: [] })

    // B 办完 → 先放行 A（C 还排着）
    holdB.open()
    await waitFor(async () => (await itemRow(b)).status === "done", { what: "B 办完" })
    await waitStatus(ctx.db, aRun, "running")
    expect((await itemRow(c)).status).toBe("queued")
    expect(await occupiedSlots(ctx.db, worker)).toBe(1)
    await waitFor(async () => prompts.get("A"), { what: "A 继续后调模型" })
    // 原来那次继续的消息（人处理了什么）原样交给 agent，加一句等过名额
    expect(prompts.get("A")).toContain("处理了你提的事「这单要不要加急？」")
    expect(prompts.get("A")).toContain("要加急")
    expect(prompts.get("A")).toContain("等名额等到现在")
    expect((await eventsOf(ctx.db, aRun)).some((event) => event.kind === "resume" && event.title === "名额空出来了，接着做")).toBe(true)

    holdA.open()
    await waitFor(async () => (await itemRow(c)).status === "done", { what: "C 办完", timeout: 30_000 })
    expect((await itemRow(a)).status).toBe("done")
  }, 60_000)

  it("立即继续：普通等待名额满了先等名额；在等名额的再点就插队（不看名额），agent 拿到原来那次继续的消息", async () => {
    const holdB = gate()
    const prompts = new Map<string, string>()
    responder("test/slot-now", async (options) => {
      const prompt = promptOf(options)
      const key = ["N-1", "Q-1"].find((each) => prompt.includes(each))
      if (key) {
        if (!prompt.includes("【继续】")) return step([call("session.wait", { what: "等对方回复", event: `reply:${key}` })])
        prompts.set(key, prompt)
        return step([text(`${key} 办完了`)])
      }
      await holdB.promise
      return step([text("M 办完了")])
    })
    const worker = await makeWorker("test/slot-now", 1)
    // N、Q 先后开始、都挂起等回复（不占名额），然后 M 领到、卡着占住唯一的名额
    const n = await humanDispatch(worker, "N-1")
    const nRun = await runOf(n, "waiting")
    const q = await humanDispatch(worker, "Q-1")
    const qRun = await runOf(q, "waiting")
    const m = await humanDispatch(worker, "M-1")
    await runOf(m, "running")

    // 等到了事件，但名额满了：先等名额（事件接口照样算继续了）
    const fired = await fireEventImpl(ctx.db, { event: "reply:N-1", via: "console" })
    expect(fired.resumedSessionIds).toEqual([nRun])
    expect((await waitingOf(nRun))?.event).toBe(workSlotEvent(worker))
    // 外部不能发等名额的事件
    await expect(fireEventImpl(ctx.db, { event: workSlotEvent(worker), via: "console" })).rejects.toThrow(/平台内部的事件/)

    // 在等名额的点「立即继续」：插队，名额超了也进执行中
    const now = await mutate(ctx.app, "engine.resumeNow", wang, { sessionId: nRun })
    expect(now.data).toEqual({ sessionId: nRun })
    await waitFor(async () => prompts.get("N-1"), { what: "N 继续后调模型" })
    expect(prompts.get("N-1")).toContain("等到了事件「reply:N-1」")
    expect(prompts.get("N-1")).toContain("没等名额空出来")
    await waitFor(async () => (await itemRow(n)).status === "done", { what: "N 办完" })
    const audit = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.targetId, nRun), eq(t.auditEvents.action, "session.resume.resume_now")))
    expect(audit).toHaveLength(1)

    // 普通等待（不是等名额）被点了立即继续、名额满了（M 还占着）：先等名额，页面提示再点一次可以插队
    const first = await mutate(ctx.app, "engine.resumeNow", wang, { sessionId: qRun })
    expect(first.data).toEqual({ sessionId: qRun, slotWaiting: true })
    expect((await waitingOf(qRun))?.event).toBe(workSlotEvent(worker))
    expect((await sessionRow(ctx.db, qRun))!.status).toBe("waiting")
    holdB.open()
    // M 办完，Q 被放行，拿到「立即继续」那句话
    await waitFor(async () => (await itemRow(q)).status === "done", { what: "Q 办完", timeout: 30_000 })
    expect((await itemRow(m)).status).toBe("done")
    expect(prompts.get("Q-1")).toContain("让你立即继续")
  }, 60_000)

  it("并发的继续不超名额：三个同时处理完只有一个进执行中，其余按先后放行", async () => {
    const hold = gate()
    const order: string[] = []
    responder("test/slot-race", async (options) => {
      const prompt = promptOf(options)
      const key = /K-\d/.exec(prompt)?.[0] ?? "?"
      if (!prompt.includes("【继续】")) return step([call("ask.human", { question: `看一下 ${key}`, options: ["好", "不好"] })])
      order.push(key)
      await hold.promise
      return step([text(`${key} 办完了`)])
    })
    const worker = await makeWorker("test/slot-race", 1)
    // 名额 1：一个等人处理了才领下一个，最后三个都在等人处理、不占名额
    const items: string[] = []
    const runs: string[] = []
    for (const key of ["K-1", "K-2", "K-3"]) {
      const id = await humanDispatch(worker, key)
      items.push(id)
      runs.push(await runOf(id, "needs_human"))
    }
    expect(await occupiedSlots(ctx.db, worker)).toBe(0)
    const humans = await ctx.db.select().from(t.humanItems).where(inArray(t.humanItems.sessionId, runs))
    const results = await Promise.all(humans.map((human) => resolveHumanItemImpl(ctx.db, { itemId: human.id, how: "approve", actorId: "u-wang", actorName: "王悦" })))
    expect(results.filter((result) => result.resumedSessionId && !result.slotWaiting)).toHaveLength(1)
    expect(results.filter((result) => result.slotWaiting)).toHaveLength(2)
    expect(await occupiedSlots(ctx.db, worker)).toBe(1)
    const slotWaits = await ctx.db
      .select()
      .from(t.sessionWaits)
      .where(and(eq(t.sessionWaits.status, "waiting"), eq(t.sessionWaits.event, workSlotEvent(worker))))
      .orderBy(asc(t.sessionWaits.createdAt), asc(t.sessionWaits.id))
    expect(slotWaits).toHaveLength(2)
    const keyOf = (sessionId: string) => ["K-1", "K-2", "K-3"][runs.indexOf(sessionId)]!
    const first = results.find((result) => result.resumedSessionId && !result.slotWaiting)!.resumedSessionId!
    let maxOccupied = 0
    hold.open()
    await waitFor(
      async () => {
        maxOccupied = Math.max(maxOccupied, await occupiedSlots(ctx.db, worker))
        const rows = await Promise.all(items.map(itemRow))
        return rows.every((row) => row.status === "done")
      },
      { what: "三张都办完", interval: 50, timeout: 30_000 }
    )
    expect(maxOccupied).toBeLessThanOrEqual(1)
    // 放行的先后：先进执行中的，然后按开始等名额的先后
    // 每个运行继续后模型可能调不止一次（去重看第一次）
    expect([...new Set(order)]).toEqual([keyOf(first), ...slotWaits.map((wait) => keyOf(wait.sessionId))])
  }, 60_000)

  it("清扫兜底：放行用的 work.pump 丢了，每分钟的清扫照样给有人等名额的任务（停用了也算）发 work.pump", async () => {
    const worker = await makeWorker("test/none", 1)
    await ctx.db.update(t.tasks).set({ enabled: false }).where(eq(t.tasks.id, worker))
    const itemId = await humanDispatch(worker, "S-1")
    const sessionId = "R-slot-sweep"
    // 直接插一个在等名额的运行（名额是空的，像是放行它的 work.pump 丢了）
    await ctx.db.insert(t.sessions).values({ id: sessionId, taskId: worker, status: "waiting", modelId: "test/none", triggeredBy: "dispatch", workItemId: itemId, startedAt: new Date() })
    await ctx.db.update(t.workItems).set({ status: "running", sessionId }).where(eq(t.workItems.id, itemId))
    const [wait] = await ctx.db
      .insert(t.sessionWaits)
      .values({ sessionId, what: "等名额（任务同时最多 1 个在跑，空出来自动继续）", triggerKind: "event", event: workSlotEvent(worker), match: { slot: { cause: "human", title: "人处理完，继续", message: "王悦处理了" } } })
      .returning()
    const swept = await sweepWork(ctx.db)
    expect(swept.pumped).toContain(worker)
    // worker 领到 work.pump 放行它（假运行没有快照，之后会被记出错，这里只看放行）
    const fired = await waitFor(
      async () => {
        const [row] = await ctx.db.select().from(t.sessionWaits).where(eq(t.sessionWaits.id, wait!.id))
        return row?.status === "fired" ? row : undefined
      },
      { what: `${WORK_SLOT_EVENT_PREFIX} 的等待被放行` }
    )
    expect(fired.firedCause).toBe("slot")
  }, 60_000)
})
