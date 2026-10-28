// 子 agent 的三个内置工具（docs/dev/sub-agents.md 4.1、7.1、第 8 节）：
// - subagent.start「拆给子 agent」：一个事务里开出几个子运行（start.ts），先全部排队，发 subagent.pump 按名额放行；
// - subagent.wait「等子 agent」：all（默认）/ any 条件满足了直接返回结果，没满足就挂起等 subagent.all:<父> / subagent.any:<父>；none 只看现状；
// - subagent.cancel「停掉子 agent」：停掉这次运行拆出去的几个（settle.ts 的 stopSubRunInTx），发 subagent.pump。
// 只有父运行（kind = run、快照里有 subagent.start）能用；子快照里本来就没有这三个，处理函数里再挡一次。
import { SUBAGENT_RESULTS_ARE_BASIS, SUBAGENT_START_TOOL_ID, subagentWaitEvent, type builtinToolInputs } from "@heyagent/shared"
import { eq } from "drizzle-orm"
import type { z } from "zod"

import { readSubagentSettings } from "../../data/config/settings.js"
import * as t from "../../db/schema.js"
import { loadEngineSettings } from "../settings.js"
import type { ToolContext, ToolOutcome } from "../tools/builtin.js"
import { markDeliveredInTx } from "./notify.js"
import { subagentResultsText, toDeliver, waitSatisfied } from "./results.js"
import { stopSubRunInTx } from "./settle.js"
import { maxSubN, resolveSubFilesInTx, startSubRunsInTx } from "./start.js"
import { loadSubRunFacts } from "./view.js"

type StartInput = z.infer<(typeof builtinToolInputs)["subagent.start"]>
type WaitInput = z.infer<(typeof builtinToolInputs)["subagent.wait"]>
type CancelInput = z.infer<(typeof builtinToolInputs)["subagent.cancel"]>

const fail = (output: string): ToolOutcome => ({ output, isError: true })

/** 只有父运行能用：子运行（kind = sub）不能再拆，固化试跑不叫 agent；快照里要有「拆给子 agent」 */
function notParent(ctx: ToolContext): string | undefined {
  if (ctx.session.kind === "sub") return "你是子 agent，不能再拆、也没有子 agent 可等可停（只有一层）。这件事自己做，或者调用 run_finish 报没办成、写清原因，交给父 agent 决定"
  if (ctx.session.kind !== "run") return "这次运行不能拆给子 agent"
  if (!ctx.snapshot.tools.some((tool) => tool.id === SUBAGENT_START_TOOL_ID)) return "这个任务没有选「拆给子 agent」，不能拆"
  return undefined
}

/**
 * 拆（4.2）：检查（kind、快照、总数上限 subagent.maxPerRun、fileIds 都是父运行能读的）不合格整次拒绝、一个都不开；
 * 合格的调 start.ts 的 startSubRunsInTx，返回每个一行（编号、标题）+ 名额和总数说明
 */
export async function startFromAgent(ctx: ToolContext, input: StartInput): Promise<ToolOutcome> {
  const refused = notParent(ctx)
  if (refused) return fail(refused)
  const { db } = ctx
  return db.transaction(async (tx) => {
    const [parent] = await tx.select().from(t.sessions).where(eq(t.sessions.id, ctx.session.id)).for("update")
    if (!parent || parent.status !== "running") return fail("这次运行已经不在执行中了（可能被取消了），不能再拆")
    const settings = await readSubagentSettings(tx)
    const { count } = await maxSubN(tx, parent.id)
    if (count + input.items.length > settings.maxPerRun)
      return fail(
        `一次运行一共最多拆 ${settings.maxPerRun} 个子 agent：这次运行已经拆了 ${count} 个，这次要拆 ${input.items.length} 个，超了。一个都没开：合并几件、或者自己做一部分，再拆。`
      )
    const problems: string[] = []
    const { found, missing } = await resolveSubFilesInTx(
      tx,
      parent.id,
      ctx.snapshot,
      input.items.flatMap((item) => item.fileIds ?? [])
    )
    for (const [index, item] of input.items.entries()) {
      const bad = (item.fileIds ?? []).filter((id) => missing.includes(id))
      if (bad.length) problems.push(`第 ${index + 1} 个「${item.title}」的 fileIds 里 ${bad.join("、")} 读不到（不是这次运行空间里的文件、附件，用 file_list 看 id）`)
      if (!item.title.trim() || !item.goal.trim()) problems.push(`第 ${index + 1} 个的 title、goal 不能是空的`)
    }
    if (problems.length) return fail(`一个都没开：\n${problems.map((line) => `- ${line}`).join("\n")}`)
    const started = await startSubRunsInTx(db, tx, {
      parent,
      parentSnapshot: ctx.snapshot,
      items: input.items,
      limits: { maxCostUsd: settings.maxCostUsd, maxSteps: settings.maxSteps },
      files: found,
    })
    const total = count + started.length
    return {
      output: [
        `拆出 ${started.length} 个子 agent（这次运行同时最多跑 ${settings.maxParallel} 个，多的排队）：`,
        ...started.map((run) => `- ${run.id}「${run.title}」`),
        `这次运行一共拆了 ${total} 个，最多 ${settings.maxPerRun} 个。`,
        `接下来先做不在子目标里的事（没有就直接用 subagent_wait 等），交出去的不要自己再做一遍。${SUBAGENT_RESULTS_ARE_BASIS}`,
      ].join("\n"),
    }
  })
}

/**
 * 等（7.1）：一次都没拆过回「这次运行没有拆过子 agent」；all / any 已经满足的直接返回 results.ts 的结果文字（并写 deliveredAt），
 * 没满足的返回 suspend（事件 subagentWaitEvent(父, mode)，what「子 agent（还有 N 个没结束）」，照只等事件的兜底期限）；
 * 挂起提交以后由 notify.ts 的 recheckSubagentWaitAfterSuspend 补查一次（loop.ts 的 suspendWithResults）。
 * none 返回现状：结束了的给全文，同样记「已交回」（之后 any 只等新的）
 */
export async function waitFromAgent(ctx: ToolContext, input: WaitInput): Promise<ToolOutcome> {
  const refused = notParent(ctx)
  if (refused) return fail(refused)
  const { db, session } = ctx
  const mode = input.mode ?? "all"
  const immediate = await db.transaction(async (tx): Promise<{ output: string } | { open: number; mode: "all" | "any" }> => {
    // 和叫醒（notify.ts）同一把锁：不会两边同时把同一个结果当新的交出去
    await tx.select({ id: t.sessions.id }).from(t.sessions).where(eq(t.sessions.id, session.id)).for("update")
    const rows = await loadSubRunFacts(tx, session.id)
    if (rows.length === 0) return { output: "这次运行没有拆过子 agent。要拆就用 subagent_start。" }
    if (mode !== "none" && !waitSatisfied(rows, mode)) return { open: rows.filter((row) => row.state !== "ended").length, mode }
    const output = subagentResultsText(rows, mode)
    await markDeliveredInTx(tx, toDeliver(rows))
    return { output }
  })
  if ("output" in immediate) return { output: immediate.output }
  const settings = await loadEngineSettings(db)
  // 写成「子 agent（还有 N 个没结束）」：会话列表拼成「在等：子 agent（…）」，网页拼成「等子 agent（…）」，都不会出现两个冒号
  const what = `子 agent（还有 ${immediate.open} 个没结束）`
  return {
    output:
      mode === "all"
        ? `已挂起：等这次运行拆出去的子 agent 全部结束（还有 ${immediate.open} 个没结束）。都结束时叫醒你一次，消息里有全部结果。`
        : `已挂起：有子 agent 结束就叫醒你（还有 ${immediate.open} 个没结束），消息里有新结束的结果。`,
    suspend: {
      kind: "wait",
      input: {
        what,
        triggerKind: "event",
        event: subagentWaitEvent(session.id, immediate.mode),
        fallbackDays: settings.eventFallbackDays,
        deadlineAt: new Date(Date.now() + settings.eventFallbackDays * 24 * 60 * 60 * 1000),
      },
    },
  }
}

/** 停（第 8 节）：只能停这次运行拆出去的、还没结束的；返回停掉了哪几个、哪些已经结束了 / 不是这次运行的 */
export async function cancelFromAgent(ctx: ToolContext, input: CancelInput): Promise<ToolOutcome> {
  const refused = notParent(ctx)
  if (refused) return fail(refused)
  const { db, session } = ctx
  const reason = input.reason.trim()
  if (!reason) return fail("reason 要写：为什么停掉")
  const ids = [...new Set(input.ids.map((id) => id.trim()).filter(Boolean))]
  return db.transaction(async (tx) => {
    const rows = await loadSubRunFacts(tx, session.id)
    const stopped: string[] = []
    const ended: string[] = []
    const unknown: string[] = []
    for (const id of ids) {
      const row = rows.find((each) => each.id === id)
      if (!row) unknown.push(id)
      else if (row.state === "ended") ended.push(id)
      else if (await stopSubRunInTx(db, tx, id, `父 agent 停掉的：${reason}`)) stopped.push(id)
      else ended.push(id)
    }
    const lines = [
      stopped.length ? `已停掉 ${stopped.length} 个：${stopped.join("、")}（结果记没办成；它们写的文件还在 subs/<n>/ 下）。` : "一个都没停掉。",
      ended.length ? `已经结束了的（不用停）：${ended.join("、")}` : "",
      unknown.length ? `不是这次运行拆出去的子 agent：${unknown.join("、")}` : "",
    ]
    return { output: lines.filter(Boolean).join("\n"), ...(stopped.length ? {} : { isError: true }) }
  })
}
