import { describe, expect, it } from "vitest"

import { duration, endedText, eventTimeText, fmtDateTime, fmtShort, relativeDayText, shanghaiToIso, startText, summarizeEvents, type RunEvent } from "../src/index.js"

describe("时间换算（上海时间）", () => {
  it("ISO 和原型写法互转", () => {
    expect(shanghaiToIso("2026-10-16 09:12")).toBe("2026-10-16T01:12:00.000Z")
    expect(shanghaiToIso("2026-09-02")).toBe("2026-09-01T16:00:00.000Z")
    expect(fmtDateTime("2026-10-16T01:12:00.000Z")).toBe("2026-10-16 09:12")
    expect(fmtShort("2026-10-15T16:30:00.000Z")).toBe("10-16 00:30")
  })
  it("认不出的写法报错", () => {
    expect(() => shanghaiToIso("昨天")).toThrow()
  })
  it("相对日期", () => {
    const now = shanghaiToIso("2026-10-16 16:30")
    expect(relativeDayText(shanghaiToIso("2026-10-16 09:12"), now)).toBe("今天 09:12")
    expect(relativeDayText(shanghaiToIso("2026-10-15 14:30"), now)).toBe("昨天 14:30")
    expect(startText(shanghaiToIso("2026-10-14 11:05"), now)).toBe("10-14 11:05")
  })
  it("事件时间：当天的运行只写时分，跨天的写月日", () => {
    const sameDay = { startedAt: shanghaiToIso("2026-10-16 09:12"), lastEvent: { at: shanghaiToIso("2026-10-16 11:45") } }
    const multiDay = { startedAt: shanghaiToIso("2026-10-15 14:30"), lastEvent: { at: shanghaiToIso("2026-10-16 10:58") } }
    expect(eventTimeText(sameDay.lastEvent.at, sameDay)).toBe("11:45")
    expect(eventTimeText(multiDay.lastEvent.at, multiDay)).toBe("10-16 10:58")
    expect(eventTimeText(shanghaiToIso("2026-10-15 14:30"), { startedAt: shanghaiToIso("2026-10-15 14:30") })).toBe("14:30")
  })
  it("时长和挂起时长（原型 R-1012-1：10-10 09:00 到 10-11 14:10，中途挂起约 28 小时）", () => {
    expect(duration(7 * 60_000)).toBe("7 分钟")
    expect(duration(130 * 60_000)).toBe("2 小时 10 分")
    const event = (seq: number, at: string, kind: RunEvent["kind"]): RunEvent => ({ seq, at: shanghaiToIso(at), kind, title: kind })
    const events = [event(1, "2026-10-10 09:10", "tool"), event(2, "2026-10-10 09:50", "wait"), event(3, "2026-10-11 14:02", "resume"), event(4, "2026-10-11 14:05", "done")]
    const run = { startedAt: shanghaiToIso("2026-10-10 09:00"), endedAt: shanghaiToIso("2026-10-11 14:10"), ...summarizeEvents(events) }
    expect(endedText(run)).toBe("1 天 5 小时（挂起 1 天 4 小时）")
    // 没写结束时间的按最后一条过程算
    expect(endedText({ ...run, endedAt: undefined })).toBe("1 天 5 小时（挂起 1 天 4 小时）")
  })
  it("摘要：条数、最后一条、最后一条出错、挂起时长（只算挂起到下一个继续；连着两个挂起按后一个算，没继续的不算）", () => {
    const at = (minute: number) => new Date(Date.UTC(2026, 9, 16, 1, minute)).toISOString()
    const kinds: RunEvent["kind"][] = ["plan", "wait", "wait", "resume", "resume", "error", "wait", "resume", "tool", "error", "think", "wait"]
    const events = kinds.map((kind, index): RunEvent => ({ seq: index + 1, at: at(index * 10), kind, title: `${kind}-${index + 1}`, detail: "d", input: "{}" }))
    expect(summarizeEvents(events)).toEqual({
      eventCount: 12,
      lastEvent: { at: at(110), kind: "wait", title: "wait-12" },
      lastError: { at: at(90), title: "error-10" },
      // wait-3 → resume-4（10 分钟）+ wait-7 → resume-8（10 分钟）；resume-5 前面没有挂起，wait-12 还没继续
      pausedMs: 20 * 60_000,
      browserIds: [],
    })
    expect(summarizeEvents([])).toEqual({ eventCount: 0, lastEvent: undefined, lastError: undefined, pausedMs: 0, browserIds: [] })
  })
})
