import { describe, expect, it } from "vitest"

import { liveQueriesById, liveQueriesByTable, liveTargets } from "../src/index.js"

describe("实时推送要重新拉的查询", () => {
  it("运行的过程变了：列表（摘要）整个失效，运行详情只失效推来的那个 session", () => {
    expect(liveTargets({ table: "session_events", id: "R-1" })).toEqual({ paths: ["sessions.list"], byId: [{ path: "sessions.get", id: "R-1" }] })
    expect(liveTargets({ table: "sessions", id: "R-1" })).toEqual({
      paths: ["sessions.list", "work.list", "work.get", "work.taskStats"],
      byId: [{ path: "sessions.get", id: "R-1" }],
    })
  })

  it("checkpoint_records 推的是检查点 id，对不上 session：运行详情全部失效；没有 id 的也是", () => {
    expect(liveTargets({ table: "checkpoint_records", id: "42" })).toEqual({ paths: ["sessions.list", "sessions.get"], byId: [] })
    expect(liveTargets({ table: "session_events", id: null })).toEqual({ paths: ["sessions.list", "sessions.get"], byId: [] })
  })

  it("不认识的表、\"*\"：全部重新拉", () => {
    expect(liveTargets({ table: "*", id: null })).toBeNull()
    expect(liveTargets({ table: "nope", id: "x" })).toBeNull()
  })

  it("按 id 失效的查询都在这张表自己的对照里", () => {
    for (const [table, paths] of Object.entries(liveQueriesById)) for (const path of paths) expect(liveQueriesByTable[table], table).toContain(path)
  })
})
