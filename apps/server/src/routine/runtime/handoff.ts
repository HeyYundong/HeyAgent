// 固化脚本跑不通、交给 agent 时的那段话（docs/dev/solidify.md 6.4）：脚本做了哪几步（每步 ✓ / ✗）、停在哪、为什么，
// 会改东西的步骤做没做、核对没有，现在的页面。步骤从过程记录里取（trace.routineStep），worker 重启后中断的也能写出来。
// 库流程当工具调、跑不通时交回 agent 的话（docs/dev/routine-library.md 5.5）也用这里的步骤行，按 trace.library.callId 取。
import { routineStopKindLabel, type RoutineSnapshot, type SessionRoutineState } from "@heyagent/shared"
import { and, asc, eq, isNotNull, sql } from "drizzle-orm"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { stepLabel } from "./bridge.js"

/** 步骤太多时：开头留几步、结尾留几步 */
const HEAD_STEPS = 5
const TAIL_STEPS = 30

const firstLine = (text: string | null | undefined, max = 200) => {
  const line = (text ?? "").split("\n").find((each) => each.trim())?.trim() ?? ""
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

const parse = (text: string | null) => {
  try {
    return text ? (JSON.parse(text) as unknown) : {}
  } catch {
    return {}
  }
}

/** wait_any 等到的那一种的定位（outcomes[名字]），太长的截短 */
function waitTarget(input: unknown, name: string): string {
  const outcomes = input && typeof input === "object" ? (input as { outcomes?: unknown }).outcomes : undefined
  const target = outcomes && typeof outcomes === "object" ? (outcomes as Record<string, unknown>)[name] : undefined
  if (typeof target !== "string") return ""
  const text = target.trim()
  return text.length > 100 ? `${text.slice(0, 99)}…` : text
}

type StepRow = Pick<typeof t.sessionEvents.$inferSelect, "kind" | "title" | "detail" | "toolId" | "input" | "output" | "trace">

const stepColumns = {
  kind: t.sessionEvents.kind,
  title: t.sessionEvents.title,
  detail: t.sessionEvents.detail,
  toolId: t.sessionEvents.toolId,
  input: t.sessionEvents.input,
  output: t.sessionEvents.output,
  trace: t.sessionEvents.trace,
}

/**
 * 一组过程记录写成步骤行（docs/dev/routine-library.md 5.5，固化脚本、库流程共用）：stepOf 取每条记录是第几步，
 * 同一步有好几条记录时取最后一条（规则拦下、出错、做完）；步骤太多时开头留几步、结尾留几步
 */
export function stepLinesOf(rows: readonly StepRow[], stepOf: (row: StepRow) => number | undefined): string[] {
  const byStep = new Map<number, StepRow>()
  for (const row of rows) {
    const step = stepOf(row)
    if (step && row.toolId) byStep.set(step, row)
  }
  const lines = [...byStep.entries()]
    .sort(([a], [b]) => a - b)
    .map(([step, row]) => {
      const label = stepLabel(row.toolId!, parse(row.input))
      if (row.kind === "rule")
        return row.title.startsWith("拦下")
          ? `${step}. ✗ ${label}：被规则拦下（${firstLine(row.detail)}）`
          : `${step}. ${label} 没做：要人审批`
      if (row.kind === "plan") return `${step}. ${label}（试跑，只记下来）`
      if (row.title.endsWith("（出错）")) return `${step}. ✗ ${label}：${firstLine(row.output?.replace(/^工具出错：/, "")) || "出错了"}`
      // 等到了哪一种：写名字和它的定位（例如 heading（getByRole('heading', { name: '…' })）），看得出核对了什么
      const matched = row.toolId === "browser.wait_any" ? /^等到了「([^」]+)」/.exec(row.output ?? "")?.[1] : undefined
      const target = matched ? waitTarget(parse(row.input), matched) : ""
      return `${step}. ${label}${matched ? ` → ${matched}${target ? `（${target}）` : ""}` : ""} ✓`
    })
  if (lines.length <= HEAD_STEPS + TAIL_STEPS) return lines
  return [...lines.slice(0, HEAD_STEPS), `…（中间 ${lines.length - HEAD_STEPS - TAIL_STEPS} 步省略）`, ...lines.slice(-TAIL_STEPS)]
}

/** 脚本做的每一步一行（trace.routineStep） */
export async function routineStepLines(db: Db, sessionId: string): Promise<string[]> {
  const rows = await db
    .select(stepColumns)
    .from(t.sessionEvents)
    .where(and(eq(t.sessionEvents.sessionId, sessionId), isNotNull(t.sessionEvents.toolId), sql`${t.sessionEvents.trace} ? 'routineStep'`))
    .orderBy(asc(t.sessionEvents.seq))
  return stepLinesOf(rows, (row) => row.trace?.routineStep)
}

/** 一次库流程调用里做的每一步一行（trace.library.callId = 这次调用；按 trace.library.step 排） */
export async function libraryStepLines(db: Db, sessionId: string, callId: string): Promise<string[]> {
  const rows = await db
    .select(stepColumns)
    .from(t.sessionEvents)
    .where(and(eq(t.sessionEvents.sessionId, sessionId), isNotNull(t.sessionEvents.toolId), sql`${t.sessionEvents.trace}->'library'->>'callId' = ${callId}`))
    .orderBy(asc(t.sessionEvents.seq))
  return stepLinesOf(rows, (row) => row.trace?.library?.step)
}

/** 会改东西的步骤做没做、核对没有 */
export function commitLines(state: SessionRoutineState): string[] {
  if (state.commits.length === 0) return ["会改东西的步骤：一步都还没做。"]
  return state.commits.map((commit) => {
    // ha.commit 之后又调过工具 = 那一步（提交、保存）已经做了
    const done = state.steps > commit.step
    if (commit.verified) return `会改东西的「${commit.label}」做了，核对过：${commit.verified}。`
    if (done) return `第 ${commit.step + 1} 步「${commit.label}」已经做了，可能已经生效：先看页面核对，不要重复做。`
    return `会改东西的「${commit.label}」还没做。`
  })
}

/** 为什么停下（一句话） */
function stopSentence(state: SessionRoutineState): string {
  const stop = state.stoppedAt
  if (!stop) return "停下了"
  const what = `${stop.label ? `${stop.label}：` : ""}${stop.reason}`
  switch (stop.kind) {
    case "bad_input":
      return `没有跑：${stop.reason}`
    case "interrupted":
      return `跑到第 ${stop.step} 步时 worker 重启了，脚本中断，不确定第 ${stop.step} 步做没做完（${stop.reason}）`
    case "approval":
      return `做到第 ${stop.step} 步停下：${what}，脚本不发起审批，这一步没做`
    case "suspend":
      // 第二期起挂起是等人处理完接着跑脚本；走到这里是接着跑时不敢重做那一步（前面的提交还没核对）
      return `做到第 ${stop.step} 步停下等人处理，接着跑时没有重做这一步：${stop.reason}`
    case "rejected":
      return `做到第 ${stop.step} 步停下：${stop.reason}，这一步没做`
    case "replay_mismatch":
      return `中途停下等人处理过，接着跑时按记录重放到第 ${stop.step} 步对不上，没有接着跑（${stop.reason}）`
    case "resume_lost":
      return `做到第 ${stop.step} 步停下等人处理；${stop.reason}`
    case "page":
      return `做到第 ${stop.step} 步，脚本发现页面和预期不一样：${stop.reason}`
    default:
      return `做到第 ${stop.step} 步停下（${routineStopKindLabel[stop.kind]}）：${what}`
  }
}

/** 最后一句：接下来怎么做 */
function instruction(state: SessionRoutineState): string {
  const stop = state.stoppedAt
  if (stop?.kind === "bad_input") return "请按任务目标自己把事情办完。"
  if (stop?.kind === "approval") return `请先单独调用第 ${stop.step} 步（${stop.label ?? stop.tool ?? "这一步"}，会照常交给人审批），再接着把任务办完，前面做过的不要重复。`
  if (stop?.kind === "rejected")
    return "被拒绝的这一步不要换个办法绕过去做；请按拒绝的理由调整做法（需要的话用 ask.human 问清楚），再接着把任务办完，前面做过的不要重复。"
  if (stop?.kind === "resume_lost") return "请先重新打开要用的网页、看清现状，再接着把任务办完，前面做过的不要重复。"
  return "请从现在的页面接着把任务办完，前面做过的不要重复。"
}

/** 交给 agent 的那段话（追加成一条用户消息） */
export function handoffText(input: { routine: Pick<RoutineSnapshot, "name" | "version">; state: SessionRoutineState; steps: string[]; page: string[] }): string {
  const { routine, state } = input
  const lines = [`（系统）这次运行先按固化流程「${routine.name}」第 ${routine.version} 版跑了，${stopSentence(state)}。`]
  if (input.steps.length) lines.push(...input.steps)
  if (state.stoppedAt?.kind !== "bad_input") lines.push(...commitLines(state))
  if (input.page.length) lines.push(...input.page)
  lines.push(instruction(state))
  return lines.join("\n")
}

/** 从库里读步骤、从网关读现在的页面，拼出交接的话 */
export async function buildHandoff(
  db: Db,
  input: { sessionId: string; routine: Pick<RoutineSnapshot, "name" | "version">; state: SessionRoutineState; pageLines: () => Promise<string[]> }
): Promise<string> {
  const steps = await routineStepLines(db, input.sessionId)
  const page = input.state.stoppedAt?.kind === "bad_input" ? [] : await input.pageLines()
  return handoffText({ routine: input.routine, state: input.state, steps, page })
}
