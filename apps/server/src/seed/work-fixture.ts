// 派活页的演示数据（开发、测试用，不进正式环境）：一个「巡检」任务派活给一个「处理一张单」的任务，
// 十来张派活单覆盖各种状态（排队、在办的四种、办完、重办后办完、没办成、不办了）和人派的。
// 运行（sessions）只插页面要的几列，没有快照和消息，不能「继续」，只用来看。
import { manualSessionId, taskId as makeTaskId, workItemId, type TaskDispatch, type WorkLogEntry } from "@heyagent/shared"
import { asc, eq, sql } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"

const nextNo = async (db: Db, seq: string) => Number((await db.execute<{ n: string }>(sql`select nextval(${seq}) as n`)).rows[0]!.n)

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

/** 插入演示数据，返回 { 派活的任务, 被派的任务, 派活单 id } */
export async function insertWorkFixtures(db: Db): Promise<{ patrolId: string; workerId: string; itemIds: string[] }> {
  const [admin] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.role, "admin")).orderBy(asc(t.users.createdAt)).limit(1)
  if (!admin) throw new Error("库里还没有主管账号：先灌演示数据（pnpm db:seed）或在页面上设置管理员")
  const [model] = await db.select({ id: t.models.id }).from(t.models).where(eq(t.models.kind, "chat")).orderBy(asc(t.models.priceIn)).limit(1)
  const modelId = model?.id ?? "openrouter/anthropic/claude-sonnet-5.5"

  const dispatch: TaskDispatch = {
    params: [
      { name: "单号", description: "后台的搜品单号，例如 PSS-1016-0012", required: true, dedupe: true },
      { name: "商品图", description: "商品主图网址；不填就从搜品单里取", required: false, dedupe: false },
    ],
    maxRunning: 1,
  }
  const patrolId = makeTaskId(await nextNo(db, "task_no_seq"))
  const workerId = makeTaskId(await nextNo(db, "task_no_seq"))
  await db.insert(t.tasks).values([
    {
      id: patrolId,
      title: "巡检后台里没完成的搜品单，派给「处理一张搜品单」",
      goal: "查出归属本账号、还没完成的搜品单，每张用派活派出去",
      steps: [],
      ownerId: admin.id,
      enabled: true,
      scheduleCron: "*/5 9-17 * * 1-5",
      scheduleText: "每个工作日 09:00–18:00 每 5 分钟",
      modelId,
    },
    {
      id: workerId,
      title: "处理一张搜品单（图搜、比物、询盘、建源商品并回填）",
      goal: "这张搜品单找到同款（比物 ≥ 95 分）、建好源商品并关联、回填后台；找不到同款就在单上写清原因",
      steps: [],
      ownerId: admin.id,
      enabled: true,
      modelId,
      dispatch,
    },
  ])
  await db.insert(t.taskDispatchSources).values({ taskId: workerId, sourceTaskId: patrolId })
  const [tool] = await db.select({ id: t.tools.id }).from(t.tools).where(eq(t.tools.id, "work.dispatch"))
  if (tool) await db.insert(t.taskTools).values({ taskId: patrolId, refId: tool.id, position: 0 })

  // 巡检的两次运行（派活单的来源）
  const patrolRuns = [manualSessionId(patrolId, 1), manualSessionId(patrolId, 2)]
  await db.insert(t.sessions).values([
    { id: patrolRuns[0]!, taskId: patrolId, status: "done", modelId, triggeredBy: "cron", startedAt: minutesAgo(400), endedAt: minutesAgo(398), costUsd: 0.01 },
    { id: patrolRuns[1]!, taskId: patrolId, status: "done", modelId, triggeredBy: "cron", startedAt: minutesAgo(150), endedAt: minutesAgo(148), costUsd: 0.01 },
  ])

  let run = 0
  const runId = () => manualSessionId(workerId, ++run)
  const itemIds: string[] = []

  type Spec = {
    no: string
    status: (typeof t.workItems.$inferInsert)["status"]
    ago: number
    from?: 0 | 1
    human?: boolean
    /** 运行：状态、开始于几分钟前、结束于几分钟前 */
    runs?: { status: (typeof t.sessions.$inferInsert)["status"]; start: number; end?: number; error?: string; wait?: string }[]
    result?: string
    error?: string
    redo?: boolean
  }
  const specs: Spec[] = [
    { no: "PSS-1016-0035", status: "queued", ago: 10, from: 1 },
    { no: "PSS-1016-0033", status: "queued", ago: 12, from: 1 },
    { no: "PSS-1016-0031", status: "running", ago: 140, from: 1, runs: [{ status: "running", start: 30 }] },
    { no: "PSS-1016-0029", status: "running", ago: 145, from: 1, runs: [{ status: "needs_human", start: 120 }] },
    { no: "PSS-1016-0027", status: "running", ago: 146, from: 1, runs: [{ status: "verifying", start: 135 }] },
    { no: "PSS-1016-0021", status: "running", ago: 390, from: 0, runs: [{ status: "waiting", start: 380, wait: "等义乌恒达日用品厂回复单件包装尺寸和毛重" }] },
    { no: "PSS-1016-0018", status: "done", ago: 392, from: 0, runs: [{ status: "done", start: 370, end: 330 }], result: "已建源商品 SPU-2210（3 个 SKU）并关联，回填 noteId 88123。同款：义乌恒达日用品厂，比物 97 分。" },
    { no: "PSS-1016-0012", status: "done", ago: 395, from: 0, redo: true, runs: [{ status: "failed", start: 394, end: 391, error: "BestDealer 后台登录失效" }, { status: "done", start: 300, end: 260 }], result: "已建源商品 SPU-2207（2 个 SKU）并关联，回填 noteId 88101。" },
    { no: "PSS-1016-0009", status: "failed", ago: 396, from: 0, runs: [{ status: "failed", start: 260, end: 230, error: "没找到同款：14 个候选最高 71 分" }], error: "没找到同款：14 个候选最高 71 分" },
    { no: "PSS-1015-0045", status: "cancelled", ago: 1500, from: 0, error: "客户撤回了搜品单" },
    { no: "PSS-1015-0038", status: "done", ago: 1600, human: true, runs: [{ status: "done", start: 1590, end: 1550 }], result: "试单：已建源商品 SPU-2190 并关联。" },
  ]

  for (const spec of specs) {
    const id = workItemId(await nextNo(db, "work_item_no_seq"))
    itemIds.push(id)
    const fromSessionId = spec.human ? null : patrolRuns[spec.from ?? 0]!
    const log: WorkLogEntry[] = [{ at: minutesAgo(spec.ago).toISOString(), kind: "created", ...(spec.human ? { byId: admin.id } : {}) }]
    await db.insert(t.workItems).values({
      id,
      taskId: workerId,
      key: spec.no,
      title: `搜品单 ${spec.no}${spec.human ? "（试一张）" : ""}`,
      params: { 单号: spec.no },
      status: spec.status,
      via: spec.human ? "human" : "agent",
      fromTaskId: spec.human ? null : patrolId,
      fromSessionId,
      fromUserId: spec.human ? admin.id : null,
      createdAt: minutesAgo(spec.ago),
      error: spec.error ?? null,
      result: spec.result ? { summary: spec.result, verification: "三方 AI 验收通过：检查点都对得上", fileIds: [] } : null,
    })
    let lastSession: string | null = null
    for (const [index, each] of (spec.runs ?? []).entries()) {
      const sessionId = runId()
      lastSession = sessionId
      if (index > 0 && spec.redo) log.push({ at: minutesAgo(each.start + 1).toISOString(), kind: "redo", byId: admin.id })
      log.push({ at: minutesAgo(each.start).toISOString(), kind: "run_started", sessionId })
      await db.insert(t.sessions).values({
        id: sessionId,
        taskId: workerId,
        status: each.status,
        modelId,
        triggeredBy: "dispatch",
        startedAt: minutesAgo(each.start),
        endedAt: each.end !== undefined ? minutesAgo(each.end) : null,
        costUsd: each.status === "done" ? 0.38 : 0.05,
        error: each.error ?? null,
        workItemId: id,
        parentSessionId: fromSessionId,
      })
      await db.insert(t.checkpoints).values(
        ["读到单子和原商品", "以图搜图找到候选", "比物找到同款", "询盘拿到包装数据", "建源商品并关联", "回填后台"].map((title, position) => ({
          sessionId,
          position,
          title,
          kind: "confirm" as const,
          status: each.status === "done" || position < (each.status === "failed" ? 2 : 3) ? ("done" as const) : ("open" as const),
        }))
      )
      if (each.wait) await db.insert(t.sessionWaits).values({ sessionId, what: each.wait, triggerKind: "time_or_event", resumeAt: minutesAgo(-600), event: `回复:${spec.no}` })
      if (each.end !== undefined) log.push({ at: minutesAgo(each.end).toISOString(), kind: "run_ended", sessionId, note: each.status })
    }
    if (spec.status === "cancelled") log.push({ at: minutesAgo(spec.ago - 30).toISOString(), kind: "cancelled", byId: admin.id, note: spec.error })
    const runs = spec.runs ?? []
    await db
      .update(t.workItems)
      .set({
        sessionId: lastSession,
        attempts: runs.length,
        startedAt: runs.length ? minutesAgo(runs[runs.length - 1]!.start) : null,
        finishedAt: ["done", "failed", "cancelled"].includes(spec.status) ? minutesAgo(runs.at(-1)?.end ?? spec.ago - 30) : null,
        log,
      })
      .where(eq(t.workItems.id, id))
  }
  return { patrolId, workerId, itemIds }
}
