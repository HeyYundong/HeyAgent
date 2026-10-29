// 结构化输出的容错（复核、三方验收用，docs/dev/run-outcome.md 5.3）：
// - lenientEnum：给模型的 JSON Schema 照旧是严格的枚举，解析时宽一点——大小写、前后空白、引号和句末标点、空格 / 连字符写法、
//   能明确对上的同义写法（中文「办成」、英文 success 等）都认；对不上的照旧不合格。
// - callStructuredWithFix：格式还是不对时，把模型的原话和哪里不对（允许的取值、它给的值）告诉它，请它改一次；还不对就抛
//   StructuredOutputError（带原话和两次的用量），调用方存下原话、照「复核没做成」处理。
import type { ModelMessage } from "ai"
import { z } from "zod"

import { callStructured, StructuredOutputError, type ResolvedModel, type StructuredIssue, type StructuredResult } from "./model.js"

/** 存进报告、过程记录的模型原话最多多少字 */
export const RAW_OUTPUT_MAX = 2000
/** 请模型改的那一轮里，回放给它的原话最多多少字 */
const RAW_ECHO_MAX = 4000

/** 认枚举值之前的规整：去掉前后空白、引号、括号和句末标点，转小写，空格和连字符当下划线 */
export function normalizeEnumText(value: string): string {
  return value
    .trim()
    .replace(/^["'`「『“‘《（([]+|["'`」』”’》）)\].。．!！?？,，;；:：]+$/g, "")
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
}

/**
 * 宽松的枚举：JSON Schema 里还是 enum（给模型看的格式不变），解析时先规整、再查同义写法表。
 * synonyms 的键是规整后的写法（normalizeEnumText 的结果），值是对应的枚举值；只收能明确对上的
 */
export function lenientEnum<const T extends readonly [string, ...string[]]>(values: T, synonyms: Record<string, T[number]>) {
  const table = new Map<string, T[number]>()
  for (const value of values) table.set(normalizeEnumText(value), value)
  for (const [text, value] of Object.entries(synonyms)) table.set(normalizeEnumText(text), value)
  return z.preprocess((input) => {
    if (typeof input !== "string") return input
    return table.get(normalizeEnumText(input)) ?? input
  }, z.enum(values))
}

/** 复核的结论：办成 / 没办成。部分办成、说不准按复核的规矩都是没办成 */
export const REVIEW_VERDICT_SYNONYMS: Record<string, "achieved" | "not_achieved"> = {
  办成: "achieved",
  办成了: "achieved",
  已办成: "achieved",
  达成: "achieved",
  已达成: "achieved",
  成功: "achieved",
  完成: "achieved",
  已完成: "achieved",
  success: "achieved",
  successful: "achieved",
  succeeded: "achieved",
  achieve: "achieved",
  done: "achieved",
  pass: "achieved",
  passed: "achieved",
  没办成: "not_achieved",
  未办成: "not_achieved",
  没有办成: "not_achieved",
  没达成: "not_achieved",
  未达成: "not_achieved",
  失败: "not_achieved",
  没完成: "not_achieved",
  未完成: "not_achieved",
  部分办成: "not_achieved",
  说不准: "not_achieved",
  证据不足: "not_achieved",
  not_achieve: "not_achieved",
  notachieved: "not_achieved",
  unachieved: "not_achieved",
  not_done: "not_achieved",
  fail: "not_achieved",
  failed: "not_achieved",
  failure: "not_achieved",
  partial: "not_achieved",
  partially_achieved: "not_achieved",
  unsure: "not_achieved",
}

/** 三方验收每条和总结论：通过 / 不通过 / 存疑 */
export const VERIFY_VERDICT_SYNONYMS: Record<string, "pass" | "fail" | "unsure"> = {
  通过: "pass",
  已通过: "pass",
  合格: "pass",
  passed: "pass",
  ok: "pass",
  不通过: "fail",
  未通过: "fail",
  没通过: "fail",
  不合格: "fail",
  failed: "fail",
  failure: "fail",
  not_pass: "fail",
  not_passed: "fail",
  存疑: "unsure",
  不确定: "unsure",
  说不准: "unsure",
  证据不足: "unsure",
  uncertain: "unsure",
  unknown: "unsure",
}

const shown = (value: unknown) => {
  if (value === undefined) return "（没给）"
  const text = typeof value === "string" ? `"${value}"` : JSON.stringify(value)
  return text.length > 200 ? `${text.slice(0, 200)}…` : text
}

/** 请模型改格式的那句话：每处不对的写清字段、它给的值、允许的取值 */
export function fixRequest(issues: StructuredIssue[]): string {
  const lines = issues.map((issue) => {
    const field = issue.path || "整个回答"
    if (issue.allowed) return `- ${field}：你给的是 ${shown(issue.received)}，只能是 ${issue.allowed.map((value) => `"${value}"`).join("、")} 之一（原样照抄）`
    return `- ${field}：${issue.message}`
  })
  return [
    "你上一次的回答格式不对，程序读不了：",
    ...lines,
    "请按要求的格式重新回答：只输出一个 JSON 对象，字段名照抄，枚举只能用列出的值之一，不要用代码块，JSON 前后不要加别的文字。判断不用改，只改格式。",
  ].join("\n")
}

/** 模型原话截一段（存进报告、过程记录） */
export const clipRaw = (text: string, max = RAW_OUTPUT_MAX) => (text.length > max ? `${text.slice(0, max)}…（共 ${text.length} 字，后面省略）` : text)

/**
 * callStructured，格式不对时请模型改一次。用量是两次加起来的。两次都不对抛 StructuredOutputError：text 是第二次的原话，
 * usage 是两次的合计，message 写第二次哪里不对；别的错（网络、超时、模型报错）原样抛出
 */
export async function callStructuredWithFix<T>(
  resolved: ResolvedModel,
  input: Parameters<typeof callStructured<T>>[1]
): Promise<StructuredResult<T> & { fixed: boolean }> {
  try {
    return { ...(await callStructured(resolved, input)), fixed: false }
  } catch (error) {
    if (!(error instanceof StructuredOutputError)) throw error
    const messages: ModelMessage[] = [
      ...input.messages,
      { role: "assistant", content: clipRaw(error.text, RAW_ECHO_MAX) },
      { role: "user", content: fixRequest(error.issues) },
    ]
    try {
      const result = await callStructured(resolved, { ...input, messages })
      return {
        ...result,
        tokensIn: result.tokensIn + error.usage.tokensIn,
        tokensOut: result.tokensOut + error.usage.tokensOut,
        costUsd: result.costUsd + error.usage.costUsd,
        fixed: true,
      }
    } catch (second) {
      if (!(second instanceof StructuredOutputError)) throw second
      throw new StructuredOutputError(
        `${second.message}（请模型改了一次格式还是不对；第一次：${error.message.replace(/^模型返回的结果格式不对：/, "")}）`,
        second.text,
        second.issues,
        {
          tokensIn: error.usage.tokensIn + second.usage.tokensIn,
          tokensOut: error.usage.tokensOut + second.usage.tokensOut,
          costUsd: error.usage.costUsd + second.usage.costUsd,
        },
        { cause: second }
      )
    }
  }
}
