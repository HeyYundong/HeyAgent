import { describe, expect, it } from "vitest"

import {
  alwaysOnToolIds,
  checkpointSummary,
  groupOf,
  isNeedsMe,
  needsMeCount,
  recognizeCheckpoints,
  runNow,
  sessionGroups,
  tasksUsing,
  toolIdsOfTask,
  triggerText,
  type HumanItem,
  type SessionSummary,
  type TaskDef,
} from "../src/index.js"

const task = (id: string, extra: Partial<TaskDef> = {}): TaskDef => ({
  id, title: id, goal: "", steps: [], deliverables: [], ownerId: "u-wang", createdAt: "2026-10-16T01:00:00.000Z", enabled: true,
  modelId: "m", memoryIds: [], skillIds: [], toolIds: [], ruleIds: [], browserProfileIds: [], allowedDomains: [], allowBrowserEvaluate: false, allowBrowserVision: false, allowBrowserFetch: false,
  desktopIds: [], allowDesktopVision: false, dispatchFrom: [], cronSkipIfRunning: true, autoSolidify: null, routineSkipTest: false, autoMemory: true, autoMemoryLimit: 5, ...extra,
})
const run = (id: string, taskId: string, status: SessionSummary["status"], startedAt: string, extra: Partial<SessionSummary> = {}): SessionSummary => ({
  id, taskId, status, startedAt, modelId: "m", tokensIn: 0, tokensOut: 0, costUsd: 0, checkpoints: [], eventCount: 0, pausedMs: 0, browserIds: [], ...extra,
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

describe("groupOf：会话页的状态标签", () => {
  it("执行中 / 等人处理 / 等待中 / 验收中各一档，已结束、没完成、出错都算已结束", () => {
    const of = (status: SessionSummary["status"]) => groupOf(run("R-1", "T-1", status, "2026-10-16T01:00:00.000Z"))
    expect(of("running")).toBe("running")
    expect(of("needs_human")).toBe("human")
    expect(of("waiting")).toBe("waiting")
    expect(of("verifying")).toBe("verifying")
    expect(["done", "incomplete", "failed"].map((status) => of(status as SessionSummary["status"]))).toEqual(["ended", "ended", "ended"])
  })
  it("标签顺序：执行中在最前（默认），没有「全部」", () => {
    expect(sessionGroups.map((group) => group.id)).toEqual(["running", "human", "waiting", "verifying", "ended"])
  })
})

describe("needsMeCount", () => {
  const items = [item("a", "u-lin"), item("b", "u-wang"), item("c", "u-wang")]
  it("主管算全部，员工只算分给自己的", () => {
    expect(items.filter((each) => isNeedsMe(each, "u-wang", false)).map((each) => each.id)).toEqual(["b", "c"])
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
  it("执行中写最后一条过程，出错写最后一条出错（摘要里的 lastEvent / lastError）", () => {
    const at = "2026-10-16T01:05:00.000Z"
    expect(runNow(run("R-1", "T-1", "running", at, { lastEvent: { at, kind: "tool", title: "打开网页" } }), [], staff).text).toBe("打开网页")
    expect(runNow(run("R-1", "T-1", "running", at), [], staff).text).toBe("刚开始")
    expect(runNow(run("R-1", "T-1", "failed", at, { lastError: { at, title: "模型超时" } }), [], staff).text).toBe("出错 · 模型超时")
  })
  it("结束了写结果：办成只写时间，没办成带上原因；老数据没完成算没办成；复核还在跑的写「复核中」，已结束没结果的只写「已结束」", () => {
    const at = "2026-10-16T01:05:00.000Z"
    const ended = { endedAt: at }
    expect(runNow(run("R-1", "T-1", "done", at, { ...ended, outcome: "achieved", outcomeReason: "复核：价格、链接都有" }), [], staff).text).toMatch(/^办成 · \d/)
    expect(runNow(run("R-1", "T-1", "done", at, { ...ended, outcome: "not_achieved", outcomeReason: "只放了 13 张" }), [], staff).text).toMatch(/^没办成 · 只放了 13 张 · /)
    const pending = { at, modelId: "m", reason: "", screenshot: false, tokensIn: 0, tokensOut: 0, costUsd: 0, pending: true }
    expect(runNow(run("R-1", "T-1", "done", at, { ...ended, review: pending }), [], staff).text).toMatch(/^复核中 · /)
    expect(runNow(run("R-1", "T-1", "incomplete", at, { ...ended, doneDetail: "没找到商品" }), [], staff).text).toMatch(/^没办成 · 没找到商品 · /)
    expect(runNow(run("R-1", "T-1", "done", at, ended), [], staff).text).toMatch(/^已结束 · /)
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
