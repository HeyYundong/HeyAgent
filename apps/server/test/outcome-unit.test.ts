// 运行结果的纯函数（engine/outcome.ts）：硬规则取最低（agent × 检查点 × 必交结果 × 验收）、不复核时的没核实、复核只能往低判。
// 不连数据库。组合全部过一遍：每种组合的结论按「取最低」的定义独立算出来再比。
import { lowerOutcome, RUN_OUTCOME_RANK, type RunOutcome } from "@heyagent/shared"
import { describe, expect, it } from "vitest"

import { workDoneData, workDoneText } from "../src/engine/dispatch/notify.js"
import { describeItem } from "../src/engine/dispatch/dispatch.js"
import { combineReview, finalWithoutReview, interimOutcome, judgeByRules, type AgentClaim, type OutcomeFacts, type ReviewLevel } from "../src/engine/outcome.js"

const claims: (AgentClaim | undefined)[] = [
  undefined,
  { outcome: "achieved", summary: "做完了", evidence: "表在 result.csv", via: "finish" },
  { outcome: "partial", summary: "做了一半", evidence: "只有 3 家", reason: "还差 2 家", via: "finish" },
  { outcome: "not_achieved", summary: "没找到", evidence: "搜了 5 个站", reason: "没有这个商品", via: "finish" },
]
const checkpointSets: { name: string; list: OutcomeFacts["checkpoints"]; limit: RunOutcome }[] = [
  { name: "没有检查点", list: [], limit: "achieved" },
  { name: "全部达成", list: [{ title: "a", status: "done" }, { title: "b", status: "done" }], limit: "achieved" },
  { name: "部分跳过", list: [{ title: "a", status: "done" }, { title: "b", status: "skipped" }], limit: "partial" },
  { name: "全部跳过", list: [{ title: "a", status: "skipped" }, { title: "b", status: "skipped" }], limit: "not_achieved" },
  { name: "有没达成", list: [{ title: "a", status: "done" }, { title: "b", status: "open" }], limit: "not_achieved" },
]
const reviews: (ReviewLevel | "error")[] = ["achieved", "partial", "not_achieved", "unsure", "error"]

describe("硬规则取最低（全部组合）", () => {
  for (const claim of claims)
    for (const cps of checkpointSets)
      for (const missing of [[], ["价格", "链接"]])
        for (const verified of [false, true]) {
          const name = `agent ${claim?.outcome ?? "只回文字"} × ${cps.name} × ${missing.length ? "缺结果" : "结果齐"} × ${verified ? "验收通过" : "没验收"}`
          it(name, () => {
            const facts: OutcomeFacts = { ...(claim ? { claim } : {}), checkpoints: cps.list, missingResults: missing, ...(verified ? { verified: { by: "verify", headline: "全部通过" } } : {}) }
            const verdict = judgeByRules(facts)
            // 上限：agent 报的（只回文字 = 说做完了）、检查点（验收通过的不按检查点判）、缺结果 → 没办成
            let ceiling: RunOutcome = claim?.outcome ?? "achieved"
            if (!verified) ceiling = lowerOutcome(ceiling, cps.limit)
            if (missing.length) ceiling = "not_achieved"
            expect(verdict.outcome).toBe(ceiling)
            // 有依据：验收通过，或者 agent 报办成且检查点全部达成
            const evidence = verified || (claim?.outcome === "achieved" && cps.list.length > 0 && cps.list.every((cp) => cp.status === "done"))
            expect(verdict.evidence).toBe(evidence)

            // 不复核：办成但没依据 → 没核实，其余照硬规则
            const plain = finalWithoutReview(verdict, "no_model")
            expect(plain.outcome).toBe(ceiling === "achieved" && !evidence ? "unverified" : ceiling)
            // 复核前先写的结果同不复核
            expect(interimOutcome(verdict).outcome).toBe(plain.outcome)

            // 谁定的、原因
            if (missing.length && claim?.outcome !== "not_achieved") {
              expect(verdict).toMatchObject({ by: "rule", failKind: "missing_result" })
              expect(verdict.reason).toContain("缺结果：价格、链接")
            }
            if (claim && claim.outcome !== "achieved" && RUN_OUTCOME_RANK[claim.outcome] <= RUN_OUTCOME_RANK[ceiling]) {
              expect(verdict.by).toBe("agent")
              expect(verdict.reason).toContain(claim.reason!)
            }
            if (ceiling === "partial") expect(verdict.failKind).toBe("partial")
            if (ceiling === "achieved" && verified) expect(verdict.by).toBe("verify")

            // 复核只能往低判：最终 = min(上限, 复核)；说不准、出错 → 没核实
            for (const review of reviews) {
              const final = combineReview(verdict, review === "error" ? { reason: "", error: "超时" } : { verdict: review, reason: "复核理由" })
              const level: RunOutcome = review === "error" || review === "unsure" ? "unverified" : review
              expect(final.outcome).toBe(lowerOutcome(ceiling, level))
              expect(RUN_OUTCOME_RANK[final.outcome]).toBeLessThanOrEqual(RUN_OUTCOME_RANK[ceiling])
              // 复核改低了或者确认了 → 记复核；上限更低的保留硬规则那边的来历
              if (RUN_OUTCOME_RANK[ceiling] < RUN_OUTCOME_RANK[level]) expect(final.by).toBe(verdict.by)
              else expect(final.by).toBe("review")
              if (review === "error" && final.by === "review") expect(final.reason).toContain("复核出错")
            }
          })
        }

  it("检查点的原因：没达成的、全部跳过的、跳过的分别列出来", () => {
    expect(judgeByRules({ checkpoints: checkpointSets[4]!.list, missingResults: [] }).reason).toBe("1 个检查点没达成：b")
    expect(judgeByRules({ checkpoints: checkpointSets[3]!.list, missingResults: [] }).reason).toBe("2 个检查点全部跳过，一个都没达成：a、b")
    expect(judgeByRules({ checkpoints: checkpointSets[2]!.list, missingResults: [] }).reason).toBe("1 个检查点跳过：b")
  })

  it("同样低的几条原因都写上，agent 报的排在前面", () => {
    const verdict = judgeByRules({ claim: claims[3], checkpoints: checkpointSets[4]!.list, missingResults: ["价格"] })
    expect(verdict).toMatchObject({ outcome: "not_achieved", by: "agent", failKind: "not_done" })
    expect(verdict.reason).toBe("没有这个商品；缺结果：价格；1 个检查点没达成：b")
  })

  it("没核实的原因：说了办成没依据 / 只回文字", () => {
    expect(finalWithoutReview(judgeByRules({ claim: claims[1], checkpoints: [], missingResults: [] }), "disabled").reason).toContain("agent 说办成了，但没有依据：任务关了复核")
    expect(finalWithoutReview(judgeByRules({ checkpoints: [], missingResults: [] }), "legacy").reason).toContain("agent 只回了一段文字、没报结果")
    // 检查点全部达成算依据：不复核也记办成
    expect(finalWithoutReview(judgeByRules({ claim: claims[1], checkpoints: checkpointSets[1]!.list, missingResults: [] }), "disabled")).toMatchObject({ outcome: "achieved", by: "rule" })
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
  it("办完但没核实：一句话、事件数据、work.list 的一行都带上结果和原因", () => {
    const item = { ...base, status: "done" as const, result: { summary: "查到了", fileIds: [] }, error: null, failKind: null, outcome: "unverified" as const, outcomeReason: "agent 说办成了，但没有依据" }
    expect(workDoneText(item)).toBe("W-9「查 K-1」办完（没核实：agent 说办成了，但没有依据）：查到了")
    expect(workDoneData(item)).toMatchObject({ status: "done", outcome: "unverified", outcomeReason: "agent 说办成了，但没有依据" })
    expect(describeItem(item)).toContain("结果没核实（agent 说办成了，但没有依据）")
  })
  it("部分办成、缺结果：没办成，不用人处理", () => {
    const partial = { ...base, status: "failed" as const, result: null, error: "只拿到 3 家", failKind: "partial" as const, outcome: "partial" as const, outcomeReason: "只拿到 3 家" }
    expect(workDoneText(partial)).toBe("W-9「查 K-1」没办成（部分办成）：只拿到 3 家")
    expect(describeItem(partial)).toBe("部分办成（只拿到 3 家）")
    const missing = { ...partial, error: "缺结果：价格", failKind: "missing_result" as const, outcome: "not_achieved" as const, outcomeReason: "缺结果：价格" }
    expect(describeItem(missing)).toBe("没办成（缺结果：价格）")
    expect(workDoneData(missing)).toMatchObject({ status: "failed", outcome: "not_achieved", error: "缺结果：价格" })
  })
})
