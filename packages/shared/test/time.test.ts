import { describe, expect, it } from "vitest"

import { duration, endedText, eventTimeText, fmtDateTime, fmtShort, relativeDayText, shanghaiToIso, startText } from "../src/index.js"

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
    const sameDay = { startedAt: shanghaiToIso("2026-10-16 09:12"), events: [{ at: shanghaiToIso("2026-10-16 11:45") }] }
    const multiDay = { startedAt: shanghaiToIso("2026-10-15 14:30"), events: [{ at: shanghaiToIso("2026-10-16 10:58") }] }
    expect(eventTimeText(sameDay.events[0]!.at, sameDay)).toBe("11:45")
    expect(eventTimeText(multiDay.events[0]!.at, multiDay)).toBe("10-16 10:58")
  })
  it("时长和挂起时长（原型 R-1012-1：10-10 09:00 到 10-11 14:10，中途挂起约 28 小时）", () => {
    expect(duration(7 * 60_000)).toBe("7 分钟")
    expect(duration(130 * 60_000)).toBe("2 小时 10 分")
    const run = {
      startedAt: shanghaiToIso("2026-10-10 09:00"),
      endedAt: shanghaiToIso("2026-10-11 14:10"),
      events: [
        { at: shanghaiToIso("2026-10-10 09:50"), kind: "wait" as const },
        { at: shanghaiToIso("2026-10-11 14:02"), kind: "resume" as const },
      ],
    }
    expect(endedText(run)).toBe("1 天 5 小时（挂起 1 天 4 小时）")
  })
})
