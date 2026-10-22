// 运行结果的纯函数（engine/outcome.ts）：只有办成 / 没办成（2026-10-20 简化）。硬规则（agent × 检查点 × 必交结果 × 验收）有一条不过就没办成；
// 都过了的，验收通过直接办成，否则等复核，复核判办成才算办成（说不准、旧的部分办成、出错都记没办成）。不连数据库，组合全部过一遍。
import { builtinToolInputs, type ReviewVerdict, type RunOutcome } from "@heyagent/shared"
import { describe, expect, it } from "vitest"

import { workDoneData, workDoneText } from "../src/engine/dispatch/notify.js"
import { describeItem } from "../src/engine/dispatch/dispatch.js"
import { builtinJsonSchema } from "../src/engine/tools/builtin-defs.js"
import { combineReview, finalByRules, judgeByRules, missingResults, noReviewModel, type AgentClaim, type OutcomeFacts } from "../src/engine/outcome.js"

const claims: (AgentClaim | undefined)[] = [
  undefined,
  { outcome: "achieved", summary: "做完了", evidence: "表在 result.csv", via: "finish" },
  { outcome: "not_achieved", summary: "没找到", evidence: "搜了 5 个站", reason: "没有这个商品", via: "finish" },
]
const checkpointSets: { name: string; list: OutcomeFacts["checkpoints"]; ok: boolean }[] = [
  { name: "没有检查点", list: [], ok: true },
  { name: "全部达成", list: [{ title: "a", status: "done" }, { title: "b", status: "done" }], ok: true },
  { name: "部分跳过", list: [{ title: "a", status: "done" }, { title: "b", status: "skipped" }], ok: true },
  { name: "全部跳过", list: [{ title: "a", status: "skipped" }, { title: "b", status: "skipped" }], ok: true },
  { name: "有没达成", list: [{ title: "a", status: "done" }, { title: "b", status: "open" }], ok: false },
]
const reviews: (ReviewVerdict | "error")[] = ["achieved", "not_achieved", "partial", "unsure", "error"]

describe("硬规则 + 复核（全部组合）", () => {
  for (const claim of claims)
    for (const cps of checkpointSets)
      for (const missing of [[], ["价格", "链接"]])
        for (const verified of [false, true]) {
          const name = `agent ${claim?.outcome ?? "只回文字"} × ${cps.name} × ${missing.length ? "缺结果" : "结果齐"} × ${verified ? "验收通过" : "没验收"}`
          it(name, () => {
            const facts: OutcomeFacts = { ...(claim ? { claim } : {}), checkpoints: cps.list, missingResults: missing, ...(verified ? { verified: { by: "verify", headline: "全部通过" } } : {}) }
            const verdict = judgeByRules(facts)
            // 硬规则：agent 报没办成、缺结果、检查点有没达成的（验收通过的不按检查点判）→ 没办成（定论）；跳过的交给复核
            const rulesOk = claim?.outcome !== "not_achieved" && missing.length === 0 && (verified || cps.ok)
            const expected: RunOutcome = rulesOk ? "achieved" : "not_achieved"
            expect(verdict.outcome).toBe(expected)
            // 定论：没办成，或者验收通过；其余（说办成了）要复核
            expect(verdict.final).toBe(!rulesOk || verified)
            if (verdict.final) expect(finalByRules(verdict).outcome).toBe(expected)
            if (!rulesOk) expect(verdict.failKind).toBe(missing.length && claim?.outcome !== "not_achieved" ? "missing_result" : "not_done")
            if (rulesOk && verified) expect(verdict.by).toBe("verify")

            // 谁定的、原因
            if (missing.length && claim?.outcome !== "not_achieved") {
              expect(verdict).toMatchObject({ by: "rule", failKind: "missing_result" })
              expect(verdict.reason).toContain("缺结果：价格、链接")
            }
            if (claim?.outcome === "not_achieved") {
              expect(verdict.by).toBe("agent")
              expect(verdict.reason).toContain(claim.reason!)
            }
          })
        }

  it("复核：判办成才算办成；没办成、旧的部分办成、说不准、出错都记没办成（复核定的）", () => {
    for (const review of reviews) {
      const final = combineReview(review === "error" ? { reason: "", error: "超时" } : { verdict: review, reason: "复核理由" })
      expect(final.outcome).toBe(review === "achieved" ? "achieved" : "not_achieved")
      expect(final.by).toBe("review")
      if (review === "error") expect(final.reason).toBe("复核出错，没能确认办成：超时")
      else expect(final.reason).toBe("复核理由")
      if (final.outcome === "not_achieved") expect(final.failKind).toBe("not_done")
    }
    expect(combineReview({ verdict: "unsure", reason: "" }).reason).toBe("复核判说不准")
  })

  it("没有复核模型：没办成，写清原因", () => {
    expect(noReviewModel()).toMatchObject({ outcome: "not_achieved", by: "rule", reason: "没配复核模型，没能确认办成", failKind: "not_done" })
  })

  it("检查点：没达成的列出来；跳过的（部分、全部）不按规则判，交给复核（2026-10-22 起）", () => {
    expect(judgeByRules({ checkpoints: checkpointSets[4]!.list, missingResults: [] }).reason).toBe("1 个检查点没达成：b")
    expect(judgeByRules({ checkpoints: checkpointSets[3]!.list, missingResults: [] })).toMatchObject({ outcome: "achieved", final: false })
    expect(judgeByRules({ checkpoints: checkpointSets[2]!.list, missingResults: [] })).toMatchObject({ outcome: "achieved", final: false })
  })

  it("几条原因都写上，agent 报的排在前面", () => {
    const verdict = judgeByRules({ claim: claims[2], checkpoints: checkpointSets[4]!.list, missingResults: ["价格"] })
    expect(verdict).toMatchObject({ outcome: "not_achieved", by: "agent", failKind: "not_done" })
    expect(verdict.reason).toBe("没有这个商品；缺结果：价格；1 个检查点没达成：b")
  })

  it("run.finish 只有办成 / 没办成；旧说明里的 partial 照收，当没办成", () => {
    const schema = builtinToolInputs["run.finish"]
    expect(schema.parse({ outcome: "partial", summary: "s", evidence: "e", reason: "只拿到价格" }).outcome).toBe("not_achieved")
    expect(schema.parse({ outcome: "achieved", summary: "s", evidence: "e" }).outcome).toBe("achieved")
    expect(schema.safeParse({ outcome: "unsure", summary: "s", evidence: "e" }).success).toBe(false)
    // 给模型看的 JSON Schema 里只有两种
    expect((builtinJsonSchema("run.finish").properties as Record<string, { enum?: string[] }>).outcome?.enum).toEqual(["achieved", "not_achieved"])
  })
})

describe("必交的结果", () => {
  const snapshot = { dispatch: { itemId: "W-1", key: "k", title: "k", params: {}, depth: 1, results: [{ name: "价格", description: "元", required: true }, { name: "Link", description: "", required: true }, { name: "备注", description: "", required: false }] } }
  const item = (data: Record<string, string | number | boolean>) => ({ log: [{ at: "2026-10-20T00:00:00.000Z", kind: "reported" as const, sessionId: "R-1" }], result: { summary: "", fileIds: [], data } })
  it("没报过、报的是上一次运行的：全部算缺", () => {
    expect(missingResults(snapshot, undefined, "R-1")).toEqual(["价格", "Link"])
    expect(missingResults(snapshot, item({ 价格: 3, Link: "x" }), "R-2")).toEqual(["价格", "Link"])
  })
  it("空字符串算没交；名字末尾多了单位括号、大小写不同照样认；可选的不管", () => {
    expect(missingResults(snapshot, item({ "价格（元）": 39, link: " " }), "R-1")).toEqual(["Link"])
    expect(missingResults(snapshot, item({ "价格 (元)": 0, LINK: "https://a" }), "R-1")).toEqual([])
    expect(missingResults({ dispatch: undefined }, item({}), "R-1")).toEqual([])
  })
})

describe("派活方看到的结果", () => {
  const base = {
    id: "W-9",
    taskId: "T-1",
    taskTitle: "办事",
    key: "k",
    title: "查 K-1",
    params: {},
    note: "",
    sessionId: "R-1",
    sessionStatus: null,
    attempts: 1,
    via: "agent" as const,
    fromTaskId: null,
    fromTaskTitle: null,
    fromSessionId: null,
    fromUserId: null,
    depth: 1,
    notBefore: null,
    autoRetries: 0,
    queuePosition: null,
    createdAt: "2026-10-20T00:00:00.000Z",
    startedAt: null,
    finishedAt: "2026-10-20T01:00:00.000Z",
    updatedAt: "2026-10-20T01:00:00.000Z",
  }
  it("办成：一句话、事件数据带上结果", () => {
    const item = { ...base, status: "done" as const, result: { summary: "查到了", fileIds: [] }, error: null, failKind: null, outcome: "achieved" as const, outcomeReason: "复核：价格、链接都有" }
    expect(workDoneText(item)).toBe("W-9「查 K-1」办完（办成）：查到了")
    expect(workDoneData(item)).toMatchObject({ status: "done", outcome: "achieved", outcomeReason: "复核：价格、链接都有" })
  })
  it("旧的「没核实」单（迁移后办完 + 没办成）：带上原因标出来", () => {
    const item = { ...base, status: "done" as const, result: { summary: "查到了", fileIds: [] }, error: null, failKind: null, outcome: "not_achieved" as const, outcomeReason: "原来记「没核实」：agent 说办成了，但没有依据" }
    expect(workDoneText(item)).toBe("W-9「查 K-1」办完（没办成：原来记「没核实」：agent 说办成了，但没有依据）：查到了")
    expect(describeItem(item)).toContain("结果没办成（原来记「没核实」：agent 说办成了，但没有依据）")
  })
  it("没办成（只拿到一部分）、缺结果：没办成，不用人处理", () => {
    const partial = { ...base, status: "failed" as const, result: null, error: "只拿到 3 家", failKind: "not_done" as const, outcome: "not_achieved" as const, outcomeReason: "只拿到 3 家" }
    expect(workDoneText(partial)).toBe("W-9「查 K-1」没办成：只拿到 3 家")
    expect(describeItem(partial)).toBe("没办成（只拿到 3 家）")
    const missing = { ...partial, error: "缺结果：价格", failKind: "missing_result" as const, outcome: "not_achieved" as const, outcomeReason: "缺结果：价格" }
    expect(describeItem(missing)).toBe("没办成（缺结果：价格）")
    expect(workDoneData(missing)).toMatchObject({ status: "failed", outcome: "not_achieved", error: "缺结果：价格" })
  })
})
