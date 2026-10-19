// 运行的「没完成」（incomplete）：运行正常结束、但事情没做成。真实的测试库 + 进程内 worker + 假模型。
// 覆盖：agent 调「报没完成」（run.not_done）→ 没完成 + 原因、不再调模型、通知负责人；说做完了时按检查点兜底
// （有没勾的、全部跳过 → 没完成；部分跳过 → 已完成；没有检查点 → 已完成）；被派的运行没完成 → 派活单没办成、不重试；
// 清扫补写没完成的运行同样不重试；「报没完成」每个任务都自带、系统提示里有它。
import { RUN_NOT_DONE_TOOL_ID, type TaskDispatch } from "@heyagent/shared"
import { eq, sql } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { sweepWork } from "../src/engine/dispatch/sweep.js"
import { buildSystemPrompt } from "../src/engine/prompt.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { login, query } from "./helpers.js"
import {
  call,
  createTask,
  eventsOf,
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
  type EngineTestContext,
} from "./engine-helpers.js"

let ctx: EngineTestContext
let wang: string // 员工，测试任务的负责人（createTask 默认 u-wang）

beforeAll(async () => {
  ctx = await setupEngine()
  wang = await login(ctx.app, "wangyue@heyagent.local")
}, 120_000)

afterAll(async () => {
  await ctx?.stop()
})

/** 两步，各带一个检查点 */
const TWO_CHECKPOINTS = [
  { id: "s1", text: "找到报价", wait: false, checkpoint: "拿到报价" },
  { id: "s2", text: "存一张表", wait: false, checkpoint: "汇总表已保存" },
]

async function runNow(taskId: string) {
  const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
  if (!res.data) throw new Error(`runNow 失败：${JSON.stringify(res.error)}`)
  return res.data.sessionId as string
}

const notesOf = (sessionId: string) => ctx.db.select().from(t.notifications).where(eq(t.notifications.sessionId, sessionId))

describe("agent 报没完成（run.not_done）", () => {
  it("调用后运行马上结束、记没完成，原因写进 error 和结束事件；不再调模型；通知负责人", async () => {
    const script = useScript(
      "test/inc-tool",
      new Script([
        step([
          text("试过了，后台没有权限"),
          call("run.not_done", { reason: "后台账号没有导出权限，问过负责人也开不了" }),
          call("plan.set", { steps: ["不该执行"] }),
        ]),
        step([text("不该走到这里")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/inc-tool", title: "导出报表", steps: TWO_CHECKPOINTS })
    const sessionId = await runNow(taskId)
    const row = await waitStatus(ctx.db, sessionId, "incomplete")
    expect(row.endedAt).toBeTruthy()
    expect(row.error).toBe("后台账号没有导出权限，问过负责人也开不了")
    expect(script.prompts.length).toBe(1)
    // 每个任务都自带「报没完成」，系统提示里教了怎么用
    expect((script.prompts[0]!.tools ?? []).map((tool) => tool.name)).toContain("run_not_done")
    expect(script.promptText(0)).toContain("做不成（试过了、能补救的也补救了，还是不行）就调用 run_not_done 写清原因")

    const events = await eventsOf(ctx.db, sessionId)
    expect(events.at(-1)).toMatchObject({ kind: "done", title: "agent 报没完成", detail: "后台账号没有导出权限，问过负责人也开不了" })
    // 同一步里后面的调用没执行，结果照样补上（消息历史合法）
    const tools = (await messagesOf(ctx.db, sessionId)).filter((message) => message.role === "tool")
    expect(JSON.stringify(tools.at(-2)?.content)).toContain("运行到此结束")
    expect(JSON.stringify(tools.at(-1)?.content)).toContain("前面已经报了没完成")
    expect(row.exploredSteps).toBeNull()

    const notes = await notesOf(sessionId)
    expect(notes.map((note) => [note.userId, note.title, note.body])).toEqual([["u-wang", "导出报表：没完成", "后台账号没有导出权限，问过负责人也开不了"]])

    // 页面接口：状态是 incomplete，原因在最后一条 done 事件里
    const run = (await query(ctx.app, "sessions.get", wang, { id: sessionId })).data
    expect(run.status).toBe("incomplete")
    expect(run.events.at(-1)).toMatchObject({ kind: "done", detail: "后台账号没有导出权限，问过负责人也开不了" })
  })

  it("「报没完成」每个任务都自带：同步进 tools 表（自带），快照里有", async () => {
    const [tool] = await ctx.db.select().from(t.tools).where(eq(t.tools.id, RUN_NOT_DONE_TOOL_ID))
    expect(tool).toMatchObject({ source: "builtin", alwaysOn: true, name: "报没完成" })
    const taskId = await createTask(ctx.db, { modelId: "test/none" })
    const snapshot = await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })
    expect(snapshot.tools.map((each) => each.id)).toContain(RUN_NOT_DONE_TOOL_ID)
    // 这个功能以前开始的运行（快照里没有它）：系统提示不提
    const old = { ...snapshot, tools: snapshot.tools.filter((each) => each.id !== RUN_NOT_DONE_TOOL_ID) }
    expect(buildSystemPrompt(old, new Map())).not.toContain("run_not_done")
  })
})

describe("说做完了：按检查点兜底", () => {
  it("有没勾的检查点 → 没完成，原因列出没达成的", async () => {
    useScript(
      "test/inc-open",
      new Script([
        step([call("checkpoint.mark", { checkpoint: 1, status: "done", record: "拿到 3 家报价" })]),
        step([text("做完了")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/inc-open", title: "比价", steps: TWO_CHECKPOINTS })
    const sessionId = await runNow(taskId)
    const row = await waitStatus(ctx.db, sessionId, "incomplete")
    expect(row.error).toBe("1 个检查点没达成：汇总表已保存")
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.at(-1)).toMatchObject({ kind: "done", title: "检查点没达成，运行没完成", detail: "1 个检查点没达成：汇总表已保存" })
    expect((await notesOf(sessionId)).map((note) => note.title)).toEqual(["比价：没完成"])
  })

  it("检查点全部跳过 → 没完成（R-1-1 那种：全标跳过、嘴上说没完成）", async () => {
    useScript(
      "test/inc-skip-all",
      new Script([
        step([
          call("checkpoint.mark", { checkpoint: 1, status: "skipped", reason: "网站打不开" }),
          call("checkpoint.mark", { checkpoint: 2, status: "skipped", reason: "没有数据可存" }),
        ]),
        step([text("任务没有完成：网站打不开")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/inc-skip-all", steps: TWO_CHECKPOINTS })
    const sessionId = await runNow(taskId)
    const row = await waitStatus(ctx.db, sessionId, "incomplete")
    expect(row.error).toBe("2 个检查点全部跳过，一个都没达成：拿到报价、汇总表已保存")
  })

  it("部分跳过（其余都勾了）→ 已完成", async () => {
    useScript(
      "test/inc-skip-some",
      new Script([
        step([
          call("checkpoint.mark", { checkpoint: 1, status: "done", record: "拿到 3 家报价" }),
          call("checkpoint.mark", { checkpoint: 2, status: "skipped", reason: "负责人说这次不用存表" }),
        ]),
        step([text("报价拿到了，表这次不用存")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/inc-skip-some", steps: TWO_CHECKPOINTS })
    const sessionId = await runNow(taskId)
    const row = await waitStatus(ctx.db, sessionId, "done")
    expect(row.error).toBeNull()
    expect((await eventsOf(ctx.db, sessionId)).at(-1)).toMatchObject({ kind: "done", title: "agent 说做完了" })
  })

  it("没有检查点 → 照旧已完成", async () => {
    useScript("test/inc-none", new Script([step([text("做完了")])]))
    const taskId = await createTask(ctx.db, { modelId: "test/inc-none" })
    const sessionId = await runNow(taskId)
    await waitStatus(ctx.db, sessionId, "done")
    expect((await notesOf(sessionId)).map((note) => note.title)).toEqual([expect.stringContaining("：运行完成")])
  })
})

describe("被派的运行没完成", () => {
  const DISPATCH: TaskDispatch = {
    params: [{ name: "单号", description: "要办的单号", required: true, dedupe: true }],
    maxRunning: 1,
    retries: 2,
    retryDelayMinutes: 1,
  }

  async function dispatchedTask(modelId: string, steps?: typeof TWO_CHECKPOINTS) {
    const patrol = await createTask(ctx.db, { modelId: "test/none", toolIds: ["work.dispatch"], title: "巡检" })
    const worker = await createTask(ctx.db, { modelId, title: "办一件事", steps })
    await ctx.db.update(t.tasks).set({ dispatch: DISPATCH }).where(eq(t.tasks.id, worker))
    await ctx.db.insert(t.taskDispatchSources).values({ taskId: worker, sourceTaskId: patrol })
    return worker
  }

  const itemRow = async (id: string) => (await ctx.db.select().from(t.workItems).where(eq(t.workItems.id, id)))[0]!

  it("agent 报没完成 → 运行没完成；派活单没办成（not_done），配了重试也不重试；通知负责人", async () => {
    useScript(
      "test/inc-dispatch",
      new Script([
        step([text("找不到这一单"), call("run.not_done", { reason: "系统里查不到单号 K-1" })]),
        step([text("不该走到这里")]),
      ])
    )
    const worker = await dispatchedTask("test/inc-dispatch")
    const res = await mutate(ctx.app, "work.dispatch", wang, { taskId: worker, params: { 单号: "K-1" } })
    const id = res.data.item.id as string
    const item = await waitFor(async () => {
      const row = await itemRow(id)
      return row.status === "failed" ? row : undefined
    }, { what: `${id} 没办成` })
    expect(item).toMatchObject({ failKind: "not_done", autoRetries: 0, attempts: 1, error: "系统里查不到单号 K-1", notBefore: null })
    expect(item.result).toMatchObject({ summary: "找不到这一单" })
    expect(item.log.map((entry) => entry.kind)).toEqual(["created", "run_started", "run_ended"])
    expect(item.log.at(-1)).toMatchObject({ kind: "run_ended", note: "not_done", sessionId: item.sessionId })
    const session = (await sessionRow(ctx.db, item.sessionId!))!
    expect(session.status).toBe("incomplete")
    const notes = await notesOf(session.id)
    expect(notes.map((note) => [note.title, note.body])).toEqual([["办一件事：没完成", "系统里查不到单号 K-1"]])
    expect((await query(ctx.app, "work.get", wang, { id })).data.failKind).toBe("not_done")
  })

  it("检查点没达成的被派运行同样没办成、不重试", async () => {
    useScript("test/inc-dispatch-cp", new Script([step([text("办完了")])]))
    const worker = await dispatchedTask("test/inc-dispatch-cp", TWO_CHECKPOINTS)
    const res = await mutate(ctx.app, "work.dispatch", wang, { taskId: worker, params: { 单号: "K-2" } })
    const id = res.data.item.id as string
    const item = await waitFor(async () => {
      const row = await itemRow(id)
      return row.status === "failed" ? row : undefined
    }, { what: `${id} 没办成` })
    expect(item).toMatchObject({ failKind: "not_done", autoRetries: 0, error: "2 个检查点没达成：拿到报价、汇总表已保存" })
    expect((await sessionRow(ctx.db, item.sessionId!))!.status).toBe("incomplete")
  })

  it("清扫补写：运行是没完成的，单记没办成（not_done），不重试", async () => {
    const worker = await dispatchedTask("test/none")
    await ctx.db.update(t.tasks).set({ enabled: false }).where(eq(t.tasks.id, worker))
    const n = Number((await ctx.db.execute<{ n: string }>(sql`select nextval('work_item_no_seq') as n`)).rows[0]!.n)
    const id = `W-${n}`
    await ctx.db.insert(t.workItems).values({ id, taskId: worker, key: "K-3", title: "K-3", params: { 单号: "K-3" }, status: "running", via: "human" })
    const sessionId = "R-inc-sweep"
    await ctx.db.insert(t.sessions).values({ id: sessionId, taskId: worker, status: "incomplete", modelId: "test/none", triggeredBy: "dispatch", startedAt: new Date(), endedAt: new Date(), workItemId: id, error: "1 个检查点没达成：汇总表已保存" })
    await ctx.db.update(t.workItems).set({ sessionId }).where(eq(t.workItems.id, id))
    const swept = await sweepWork(ctx.db)
    expect(swept.settled).toContain(id)
    expect(await itemRow(id)).toMatchObject({ status: "failed", failKind: "not_done", autoRetries: 0, error: "1 个检查点没达成：汇总表已保存" })
  })
})
