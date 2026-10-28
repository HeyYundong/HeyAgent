// 子 agent 的约定（docs/dev/sub-agents.md）：子快照派生、事件名、名额的判断、编号、工具输入。
import { describe, expect, it } from "vitest"
import { z } from "zod"

import {
  builtinToolInputs,
  deriveSubSnapshot,
  holdsDispatchSlot,
  holdsSubagentSlot,
  isSubagentQueueEvent,
  isSubagentWaitEvent,
  parseSubSessionId,
  parseSubagentWaitEvent,
  reservedEventPrefix,
  sessionKindSchema,
  sessionSnapshotSchema,
  subSessionId,
  subagentQueueEvent,
  subagentWaitEvent,
  type SessionSnapshot,
  type SnapshotTool,
} from "../src/index.js"

const tool = (id: string): SnapshotTool => ({ id, name: id, summary: "", description: "", source: "builtin", risk: "read" })
const rule = (id: string, type: string) => ({ id, name: id, trigger: "", action: "", toolIds: [], compiledTrigger: { v: 1, trigger: { type }, actions: [], understood: "" } })

const parent: SessionSnapshot = {
  v: 1,
  task: { id: "T-12", title: "任务", goal: "整体目标", ownerId: "u-wang", steps: [{ id: "s1", text: "第一步", wait: false, checkpoint: "做完" }] },
  modelId: "p/strong",
  reviewModelId: "p/review",
  subagentModelId: "p/cheap",
  memories: [
    { id: "m-001", content: "手选的", appliesTo: "a" },
    { id: "m-002", content: "自动挑的", appliesTo: "b", auto: { score: 0.8 } },
  ],
  autoMemory: { status: "done", limit: 5, at: "2026-10-28T06:00:00.000Z" },
  taskMemory: ["经验"],
  skills: [],
  tools: ["checkpoint.mark", "session.wait", "ask.human", "plan.set", "run.finish", "subagent.start", "subagent.wait", "subagent.cancel", "work.dispatch", "work.list", "browser"].map(tool),
  rules: [rule("rl-1", "agent_done"), rule("rl-2", "cost_over"), rule("rl-3", "tool_call"), { id: "rl-4", name: "没翻译", trigger: "", action: "", toolIds: [] }],
  checkpoints: [{ title: "做完", kind: "note", stepId: "s1" }],
  attachments: [{ id: "f-1", name: "任务附件.txt", mime: "text/plain", size: 1 }],
  note: "人加的说明",
  source: "manual",
  dispatchTargets: [{ taskId: "T-13", title: "别的", enabled: true, params: [] }],
  browser: { profiles: [{ id: "br-a", name: "A", description: "" }], allowedDomains: [], allowEvaluate: false, allowVision: true, allowFetch: true },
}

const derive = (overrides: Partial<SessionSnapshot> = {}, files: SessionSnapshot["attachments"] = []) =>
  deriveSubSnapshot(
    { ...parent, ...overrides },
    {
      parentSessionId: "R-12-3",
      n: 2,
      item: { title: " 查 B 站 ", goal: " 取标题 ", input: { 网址: "https://b.example" }, results: ["标题", " 标题 ", "状态码"] },
      files,
      builtinTool: tool,
    }
  )

describe("deriveSubSnapshot", () => {
  it("去掉拆分、派活、等待、检查点工具，加上 work.report", () => {
    const ids = derive().tools.map((each) => each.id)
    for (const id of ["subagent.start", "subagent.wait", "subagent.cancel", "work.dispatch", "work.list", "session.wait", "checkpoint.mark"]) expect(ids).not.toContain(id)
    expect(ids).toEqual(expect.arrayContaining(["ask.human", "plan.set", "run.finish", "browser", "work.report"]))
  })
  it("步骤、检查点清空，目标留作背景；没有派活目标、附加说明；source = sub", () => {
    const sub = derive()
    expect(sub.task.steps).toEqual([])
    expect(sub.task.goal).toBe("整体目标")
    expect(sub.checkpoints).toEqual([])
    expect(sub.dispatchTargets).toBeUndefined()
    expect(sub.note).toBeUndefined()
    expect(sub.source).toBe("sub")
    expect(sub.subagentModelId).toBeUndefined()
  })
  it("模型用子 agent 用的模型，没选用父的执行模型", () => {
    expect(derive().modelId).toBe("p/cheap")
    expect(derive({ subagentModelId: undefined }).modelId).toBe("p/strong")
  })
  it("规则去掉「说做完了」「花费超过 X」，别的（含没翻译的）留着", () => {
    expect(derive().rules.map((each) => each.id)).toEqual(["rl-3", "rl-4"])
  })
  it("记忆沿用父挑好的，不重挑；父还是 pending 时不带 autoMemory", () => {
    const sub = derive()
    expect(sub.memories.map((each) => each.id)).toEqual(["m-001", "m-002"])
    expect(sub.autoMemory?.status).toBe("done")
    expect(derive({ autoMemory: { status: "pending", limit: 5 } }).autoMemory).toBeUndefined()
  })
  it("浏览器配置原样（含看画面、直接调接口）", () => {
    expect(derive().browser).toEqual(parent.browser)
  })
  it("给它的文件并进附件（只读、去重），sub 里记下子目标", () => {
    const sub = derive({}, [{ id: "f-1", name: "任务附件.txt", mime: "text/plain", size: 1 }, { id: "f-9", name: "out/a.csv", mime: "text/csv", size: 3 }])
    expect(sub.attachments.map((each) => each.id)).toEqual(["f-1", "f-9"])
    expect(sub.sub).toEqual({ parentSessionId: "R-12-3", n: 2, title: "查 B 站", goal: "取标题", input: { 网址: "https://b.example" }, results: ["标题", "状态码"], fileIds: ["f-1", "f-9"] })
    expect(sessionSnapshotSchema.safeParse(sub).success).toBe(true)
  })
  it("有附件却没有读附件的，带上 file.read、file.list", () => {
    const ids = derive().tools.map((each) => each.id)
    expect(ids).toEqual(expect.arrayContaining(["file.read", "file.list"]))
    const none = derive({ attachments: [] }).tools.map((each) => each.id)
    expect(none).not.toContain("file.read")
  })
})

describe("事件名和名额", () => {
  it("排队、等全部、等任意一个", () => {
    expect(subagentQueueEvent("R-12-3")).toBe("subagent.queue:R-12-3")
    expect(subagentWaitEvent("R-12-3", "all")).toBe("subagent.all:R-12-3")
    expect(parseSubagentWaitEvent("subagent.any:R-12-1028-2")).toEqual({ parentSessionId: "R-12-1028-2", mode: "any" })
    expect(parseSubagentWaitEvent("subagent.queue:R-12-3")).toBeNull()
    expect(parseSubagentWaitEvent("subagent.all:")).toBeNull()
    expect(isSubagentQueueEvent("subagent.queue:R-1-1")).toBe(true)
    expect(isSubagentWaitEvent("subagent.queue:R-1-1")).toBe(false)
    expect(isSubagentWaitEvent("subagent.all:R-1-1")).toBe(true)
  })
  it("外部事件不能发 subagent. 开头的", () => {
    expect(reservedEventPrefix(subagentWaitEvent("R-1-1", "all"))).toBe("subagent.")
  })
  it("派活名额：等浏览器、桌面、子 agent 占；子 agent 名额：只有等浏览器、桌面占", () => {
    expect(holdsDispatchSlot("browser.profile:any")).toBe(true)
    expect(holdsDispatchSlot("desktop:any")).toBe(true)
    expect(holdsDispatchSlot("subagent.all:R-1-1")).toBe(true)
    expect(holdsDispatchSlot("subagent.queue:R-1-1")).toBe(false)
    expect(holdsDispatchSlot("work.done:W-1")).toBe(false)
    expect(holdsDispatchSlot(undefined)).toBe(false)
    expect(holdsSubagentSlot("browser.profile:br-a")).toBe(true)
    expect(holdsSubagentSlot("subagent.queue:R-1-1")).toBe(false)
    expect(holdsSubagentSlot(null)).toBe(false)
  })
})

describe("编号和种类", () => {
  it("<父运行编号>.<n>", () => {
    expect(subSessionId("R-12-3", 2)).toBe("R-12-3.2")
    expect(parseSubSessionId("R-12-1028-2.10")).toEqual({ parentSessionId: "R-12-1028-2", n: 10 })
    expect(parseSubSessionId("R-12-3")).toBeNull()
    expect(parseSubSessionId("R-12-3.0")).toBeNull()
  })
  it("运行种类有 sub", () => {
    expect(sessionKindSchema.options).toContain("sub")
  })
})

describe("工具输入", () => {
  it("一次最多 10 个，至少 1 个", () => {
    const item = { title: "t", goal: "g" }
    expect(builtinToolInputs["subagent.start"].safeParse({ items: [item] }).success).toBe(true)
    expect(builtinToolInputs["subagent.start"].safeParse({ items: [] }).success).toBe(false)
    expect(builtinToolInputs["subagent.start"].safeParse({ items: Array(11).fill(item) }).success).toBe(false)
  })
  it("能转成给模型的 JSON Schema；input 最多 20 项", () => {
    for (const id of ["subagent.start", "subagent.wait", "subagent.cancel"] as const) expect(() => z.toJSONSchema(builtinToolInputs[id], { target: "draft-7" })).not.toThrow()
    const input = Object.fromEntries(Array.from({ length: 21 }, (_, index) => [`k${index}`, "v"]))
    expect(builtinToolInputs["subagent.start"].safeParse({ items: [{ title: "t", goal: "g", input }] }).success).toBe(false)
  })
  it("wait 的 mode 可以不填；cancel 要理由", () => {
    expect(builtinToolInputs["subagent.wait"].safeParse({}).success).toBe(true)
    expect(builtinToolInputs["subagent.wait"].safeParse({ mode: "some" }).success).toBe(false)
    expect(builtinToolInputs["subagent.cancel"].safeParse({ ids: ["R-1-1.1"] }).success).toBe(false)
    expect(builtinToolInputs["subagent.cancel"].safeParse({ ids: ["R-1-1.1"], reason: "拿到了" }).success).toBe(true)
  })
})
