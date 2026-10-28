// 派活第三期的约定（docs/dev/dispatch-p3.md）：事件数据 → 一张单、过多久再办、优先级、任务配置的校验。
import { describe, expect, it } from "vitest"

import {
  eventValueText,
  readEventPath,
  taskDispatchSchema,
  workApiCreateInputSchema,
  workItemFromEvent,
  workNotBefore,
  workPriorityOf,
  WORK_PRIORITY_RANK,
  workWaitKind,
} from "../src/index.js"

const withDedupe = { params: [{ name: "单号", description: "", required: true, dedupe: true }, { name: "备注", description: "", required: false, dedupe: false }] }
const noDedupe = { params: [{ name: "内容", description: "", required: true, dedupe: false }] }

describe("readEventPath / eventValueText", () => {
  const data = { order: { id: 42, tags: ["a", "b"] }, items: [{ sku: " X-1 " }], ok: true, empty: null }
  it("按点分的路径取，数字段取数组", () => {
    expect(readEventPath(data, "order.id")).toBe(42)
    expect(readEventPath(data, "items.0.sku")).toBe(" X-1 ")
    expect(readEventPath(data, "order.tags.1")).toBe("b")
    expect(readEventPath(data, "order.nope")).toBeUndefined()
    expect(readEventPath(data, "items.x")).toBeUndefined()
    expect(readEventPath(data, "order..id")).toBeUndefined()
    expect(readEventPath(data, "toString")).toBeUndefined()
  })
  it("值变成文字", () => {
    expect(eventValueText(" X-1 ")).toBe("X-1")
    expect(eventValueText(42)).toBe("42")
    expect(eventValueText(true)).toBe("true")
    expect(eventValueText(null)).toBe("")
    expect(eventValueText(undefined)).toBe("")
    expect(eventValueText({ a: 1 })).toBe('{"a":1}')
    expect(eventValueText("x".repeat(3000))).toHaveLength(2000)
  })
})

describe("workItemFromEvent", () => {
  it("有去重参数：没写路径取同名字段，写了路径按路径取，去重键按参数算", () => {
    expect(workItemFromEvent(withDedupe, { params: { 备注: "memo.text" } }, { 单号: "A-1", memo: { text: "急" } })).toEqual({ params: { 单号: "A-1", 备注: "急" }, key: "A-1", title: "单号 A-1" })
    expect(workItemFromEvent(withDedupe, { params: { 单号: "orderNo" } }, { orderNo: 7 })).toEqual({ params: { 单号: "7" }, key: "7", title: "单号 7" })
  })
  it("缺必填 / 去重参数：说清从哪个字段取", () => {
    expect(workItemFromEvent(withDedupe, { params: { 单号: "orderNo" } }, {})).toEqual({ problem: "事件数据里没有「orderNo」（参数「单号」从这里取）" })
  })
  it("没有去重参数：去重键按 keyPath 取，取不到就拒", () => {
    expect(workItemFromEvent(noDedupe, { keyPath: "id" }, { 内容: "x", id: "e-1" })).toMatchObject({ key: "e-1" })
    expect(workItemFromEvent(noDedupe, { keyPath: "id" }, { 内容: "x" })).toEqual({ problem: "事件数据里没有「id」（去重键从这里取）" })
    expect(workItemFromEvent(noDedupe, {}, { 内容: "x" })).toHaveProperty("problem")
  })
})

describe("过多久再办、优先级", () => {
  const now = new Date("2026-10-28T02:00:00Z")
  it("workNotBefore：将来的才算，过去的、0 分钟是马上", () => {
    expect(workNotBefore({ delayMinutes: 30 }, now)?.toISOString()).toBe("2026-10-28T02:30:00.000Z")
    expect(workNotBefore({ delayMinutes: 0 }, now)).toBeNull()
    expect(workNotBefore({ notBefore: "2026-10-28T18:00:00+08:00" }, now)?.toISOString()).toBe("2026-10-28T10:00:00.000Z")
    expect(workNotBefore({ notBefore: "2026-10-28T09:00:00+08:00" }, now)).toBeNull()
    expect(workNotBefore({}, now)).toBeNull()
  })
  it("workWaitKind：等重试 / 定了时间 / 不等", () => {
    const later = "2026-10-28T03:00:00.000Z"
    expect(workWaitKind({ status: "queued", notBefore: later, autoRetries: 1 }, now)).toBe("retry")
    expect(workWaitKind({ status: "queued", notBefore: later, autoRetries: 0 }, now)).toBe("scheduled")
    expect(workWaitKind({ status: "queued", notBefore: "2026-10-28T01:00:00.000Z", autoRetries: 0 }, now)).toBeNull()
    expect(workWaitKind({ status: "running", notBefore: null, autoRetries: 0 }, now)).toBeNull()
  })
  it("优先级的数来回换", () => {
    for (const priority of ["high", "normal", "low"] as const) expect(workPriorityOf(WORK_PRIORITY_RANK[priority])).toBe(priority)
  })
})

describe("任务配置和接口输入的校验", () => {
  const base = { params: withDedupe.params, maxRunning: 1 }
  it("事件：不能重名、不能用平台的前缀、映射只能写声明了的参数；没有去重参数要写 keyPath", () => {
    expect(taskDispatchSchema.safeParse({ ...base, events: [{ event: "order.created" }] }).success).toBe(true)
    expect(taskDispatchSchema.safeParse({ ...base, events: [{ event: "a" }, { event: "a" }] }).success).toBe(false)
    expect(taskDispatchSchema.safeParse({ ...base, events: [{ event: "work.done:W-1" }] }).success).toBe(false)
    expect(taskDispatchSchema.safeParse({ ...base, events: [{ event: "a", params: { 不存在: "x" } }] }).success).toBe(false)
    expect(taskDispatchSchema.safeParse({ params: noDedupe.params, maxRunning: 1, events: [{ event: "a" }] }).success).toBe(false)
    expect(taskDispatchSchema.safeParse({ params: noDedupe.params, maxRunning: 1, events: [{ event: "a", keyPath: "id" }] }).success).toBe(true)
  })
  it("花费上限、外部系统能派活：可以不写（旧数据）", () => {
    const parsed = taskDispatchSchema.parse(base)
    expect(parsed.allowApi).toBeUndefined()
    expect(parsed.dailyBudgetUsd).toBeUndefined()
    expect(taskDispatchSchema.safeParse({ ...base, dailyBudgetUsd: 0 }).success).toBe(false)
    expect(taskDispatchSchema.safeParse({ ...base, dailyBudgetUsd: null, allowApi: true }).success).toBe(true)
  })
  it("POST /api/work-items：参数值可以是数字、是否、null；notBefore 和 delayMinutes 只给一个", () => {
    expect(workApiCreateInputSchema.safeParse({ task: "T-1", params: { 单号: 12, 加急: true, 备注: null } }).success).toBe(true)
    expect(workApiCreateInputSchema.safeParse({ task: "T-1", notBefore: "2026-10-28T18:00:00+08:00" }).success).toBe(true)
    expect(workApiCreateInputSchema.safeParse({ task: "T-1", notBefore: "2026-10-28 18:00" }).success).toBe(false)
    expect(workApiCreateInputSchema.safeParse({ task: "T-1", notBefore: "2026-10-28T18:00:00+08:00", delayMinutes: 5 }).success).toBe(false)
  })
})
