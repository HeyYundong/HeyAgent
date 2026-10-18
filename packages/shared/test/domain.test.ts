import { describe, expect, it } from "vitest"

import {
  alwaysOnToolIds,
  boardCards,
  checkpointSummary,
  needsMeCount,
  recognizeCheckpoints,
  runNow,
  tasksUsing,
  toolIdsOfTask,
  triggerText,
  type HumanItem,
  type HumanTodo,
  type SessionRun,
  type TaskDef,
} from "../src/index.js"

const task = (id: string, extra: Partial<TaskDef> = {}): TaskDef => ({
  id, title: id, goal: "", steps: [], ownerId: "u-wang", createdAt: "2026-10-16T01:00:00.000Z", enabled: true,
  modelId: "m", memoryIds: [], skillIds: [], toolIds: [], ruleIds: [], browserProfileIds: [], allowedDomains: [], allowBrowserEvaluate: false, dispatchFrom: [], cronSkipIfRunning: true, ...extra,
})
const run = (id: string, taskId: string, status: SessionRun["status"], startedAt: string, extra: Partial<SessionRun> = {}): SessionRun => ({
  id, taskId, status, startedAt, modelId: "m", tokensIn: 0, tokensOut: 0, costUsd: 0, checkpoints: [], events: [], ...extra,
})
const detail = { sections: [], primary: "通过", secondary: "拒绝" }
const item = (id: string, assigneeId: string, extra: Partial<HumanItem> = {}): HumanItem => ({
  id, kind: "approval", title: id, summary: "", assigneeId, createdAt: "2026-10-16T02:00:00.000Z", urgency: 0, detail, ...extra,
})

describe("triggerText", () => {
  it("四种触发的写法和原型一致（时间按上海时间显示）", () => {
    expect(triggerText({ kind: "time", at: "2026-10-16T10:00:00.000Z" })).toBe("到 2026-10-16 18:00")
    expect(triggerText({ kind: "cron", cron: "0 10 * * 1-5", text: "每个工作日 10:00", next: "2026-10-19T02:00:00.000Z" })).toBe(
      "每个工作日 10:00（cron: 0 10 * * 1-5），下次 2026-10-19 10:00"
    )
    expect(triggerText({ kind: "event", event: "两件事都处理完", fallbackDays: 7 })).toBe("等到「两件事都处理完」（最多等 7 天，到期提醒负责人）")
    expect(triggerText({ kind: "time_or_event", at: "2026-10-17T02:00:00.000Z", event: "工厂在 1688 回复消息" })).toBe(
      "到 2026-10-17 10:00，或等到「工厂在 1688 回复消息」（先到先继续）"
    )
  })
})

describe("boardCards", () => {
  const tasks = [task("T-1"), task("T-2")]
  const runs = [
    run("R-1-1", "T-1", "running", "2026-10-16T08:00:00.000Z"),
    run("R-2-1", "T-2", "done", "2026-10-14T01:00:00.000Z"),
    run("R-2-2", "T-2", "done", "2026-10-15T01:00:00.000Z"),
    run("R-2-3", "T-2", "needs_human", "2026-10-16T01:00:00.000Z"),
    run("R-2-4", "T-2", "failed", "2026-10-16T02:00:00.000Z"),
    run("R-9-1", "T-9", "running", "2026-10-16T02:00:00.000Z"),
  ]
  const humanTodos: HumanTodo[] = [{ id: "td-1", taskId: "T-1", title: "x", trigger: { kind: "time", at: "2026-10-16T10:00:00.000Z" }, createdById: "u-wang", createdAt: "2026-10-16T01:00:00.000Z" }]
  const cards = boardCards({ runs, tasks, humanItems: [item("ap-1", "u-lin")], humanTodos })

  it("等人处理和失败的运行不放卡，已完成的只放每个任务最近一次，找不到任务的跳过", () => {
    expect(cards.filter((c) => c.kind === "run").map((c) => c.id)).toEqual(["R-1-1", "R-2-2"])
  })
  it("要人办的事放「等人处理」，人加的待办放「等待中」", () => {
    expect(cards.find((c) => c.id === "ap-1")?.column).toBe("needs_human")
    expect(cards.find((c) => c.id === "td-1")?.column).toBe("waiting")
  })
})

describe("needsMeCount", () => {
  const items = [item("a", "u-lin"), item("b", "u-wang"), item("c", "u-wang")]
  it("主管算全部，员工只算分给自己的", () => {
    expect(needsMeCount(items, "u-lin", true)).toBe(3)
    expect(needsMeCount(items, "u-wang", false)).toBe(2)
    expect(needsMeCount(items, "u-chen", false)).toBe(0)
  })
})

describe("工具和任务", () => {
  const tools = [
    { id: "checkpoint.mark", alwaysOn: true },
    { id: "session.wait", alwaysOn: true },
    { id: "ask.human", alwaysOn: true },
    { id: "browser.open" },
  ]
  const always = alwaysOnToolIds(tools)
  it("每个任务都自带的工具排在前面，不重复", () => {
    expect(always).toEqual(["checkpoint.mark", "session.wait", "ask.human"])
    expect(toolIdsOfTask({ toolIds: ["browser.open", "ask.human"] }, always)).toEqual(["checkpoint.mark", "session.wait", "ask.human", "browser.open"])
  })
  it("tasksUsing：自带的工具算全部任务", () => {
    const tasks = [task("T-1", { toolIds: ["browser.open"], ruleIds: ["rl-a"] }), task("T-2")]
    expect(tasksUsing(tasks, "toolIds", "session.wait", always).map((t) => t.id)).toEqual(["T-1", "T-2"])
    expect(tasksUsing(tasks, "toolIds", "browser.open", always).map((t) => t.id)).toEqual(["T-1"])
    expect(tasksUsing(tasks, "ruleIds", "rl-a").map((t) => t.id)).toEqual(["T-1"])
  })
})

describe("runNow", () => {
  const staff = [{ id: "u-lin", name: "林舟", title: "", isAdmin: true }]
  it("等人处理时列出挡住它的事（记忆审核不算）", () => {
    const r = run("R-1", "T-1", "needs_human", "2026-10-16T01:00:00.000Z")
    const items = [item("ap", "u-lin", { runId: "R-1", title: "批准打样单" }), item("m", "u-lin", { runId: "R-1", kind: "memory", title: "记忆" })]
    expect(runNow(r, items, staff)).toEqual({ label: "在等", text: "批准打样单（林舟）" })
  })
  it("挂起时写在等什么和什么时候继续", () => {
    const r = run("R-1", "T-1", "waiting", "2026-10-16T01:00:00.000Z", {
      waiting: { what: "等工厂回复", trigger: { kind: "event", event: "回复", fallbackDays: 7 }, since: "2026-10-16T01:00:00.000Z" },
    })
    expect(runNow(r, [], staff).text).toBe("工厂回复")
  })
})

describe("recognizeCheckpoints（原型 lib/checkpoint.ts）", () => {
  it("认出类型和目标数", () => {
    expect(recognizeCheckpoints("访问了 3 个供应商")).toEqual([{ title: "访问了 3 个供应商", kind: "visit", target: 3 }])
    expect(recognizeCheckpoints("给两个供应商发消息")).toEqual([{ title: "给两个供应商发消息", kind: "message", target: 2 }])
    expect(recognizeCheckpoints("工厂 ≥ 5 家")).toEqual([{ title: "工厂 ≥ 5 家", kind: "count", target: 5 }])
  })
  it("「；」分多条，认不出的归为说明", () => {
    expect(recognizeCheckpoints("比价表已保存；负责人已审核；解析客户商品链接")).toEqual([
      { title: "比价表已保存", kind: "artifact", target: undefined },
      { title: "负责人已审核", kind: "confirm", target: undefined },
      { title: "解析客户商品链接", kind: "note", target: undefined },
    ])
  })
  it("checkpointSummary", () => {
    const cp = (status: "done" | "open" | "skipped") => ({ title: status, kind: "note" as const, status, records: [] })
    expect(checkpointSummary([])).toBe("还没有")
    expect(checkpointSummary([cp("done"), cp("open"), cp("skipped")])).toBe("完成 1/3 · 跳过 1")
  })
})
