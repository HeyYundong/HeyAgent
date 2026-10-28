// 子 agent：交回给父的文字（docs/dev/sub-agents.md 7.3）和复核、三方验收的输入里「子 agent」一节（9.2）。都是纯函数，测试好写。
import type { RunOutcome, RunOutcomeBy, SubResult } from "@heyagent/shared"

import { notReady } from "./not-ready.js"

/** 一个子运行（交回、复核要的那些字段，调用方一次查好） */
export interface SubRunFacts {
  id: string
  n: number
  title: string
  goal: string
  /** 要交回的字段名（快照 sub.results） */
  results: string[]
  status: string
  outcome?: RunOutcome | null
  outcomeReason?: string | null
  outcomeBy?: RunOutcomeBy | null
  /** 出错、被停掉的原因（sessions.error） */
  error?: string | null
  subResult?: SubResult | null
  /** 它空间里的文件路径（父看到的是 subs/<n>/<路径>），前 SUBAGENT_FILES_LISTED 个 */
  files: string[]
}

/**
 * 交回给父的文字：开头一句（几个、办成几个），每个子 agent 一段（结果、summary 前 1500 字、evidence 前 1000 字、交回的字段、文件路径；
 * 出错的写错误原因，被停掉的写谁停的、为什么），已经交回过的只写一行「R-12-3.1 办成（前面给过）」，最后一句「子 agent 自报、没复核，自己核对」。
 * mode 决定开头那句（all：都结束了；any：有 N 个结束了、还有 M 个在做；none：现状）
 */
export function subagentResultsText(_rows: SubRunFacts[], _mode: "all" | "any" | "none"): string {
  return notReady("交回给父的文字")
}

/** 复核（review.ts 的 buildReviewPrompt）、三方验收（verify.ts 的 loadEvidence）的输入里加的一节；每个子 agent 截到 SUBAGENT_REVIEW_ITEM_CHARS 字以内 */
export function subagentReviewSection(_rows: SubRunFacts[]): string {
  return notReady("复核的子 agent 一节")
}
