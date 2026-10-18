// 派活页的演示数据（开发、测试用，不进正式环境）：一个「巡检」任务派活给一个「处理一张单」的任务，
// 十来张派活单覆盖各种状态（排队、在办的四种、办完、重办后办完、没办成、不办了）和人派的。
// 第二期加了：带结构化结果（work.report）的办完、agent 报办不成，以及另一个配了自动重试 2 次的被派任务（等重试、重试用完）。
// 运行（sessions）只插页面要的几列，没有快照和消息，不能「继续」，只用来看。
import { manualSessionId, taskId as makeTaskId, workItemId, workReportLine, type TaskDispatch, type WorkFailKind, type WorkLogEntry, type WorkReportValue } from "@heyagent/shared"
import { asc, eq, sql } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"

const nextNo = async (db: Db, seq: string) => Number((await db.execute<{ n: string }>(sql`select nextval(${seq}) as n`)).rows[0]!.n)

/** 几分钟前（负数 = 几分钟后） */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

/** 插入演示数据，返回 { 派活的任务, 被派的任务, 配了自动重试的被派任务, 派活单 id } */
export async function insertWorkFixtures(db: Db): Promise<{ patrolId: string; workerId: string; checkerId: string; itemIds: string[] }> {
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
  // 第二期：配了自动重试的被派任务（没办成自动再试 2 次，隔 10 分钟）
  const checkDispatch: TaskDispatch = {
    params: [{ name: "单号", description: "要核对回填的搜品单号", required: true, dedupe: true }],
    maxRunning: 2,
    retries: 2,
    retryDelayMinutes: 10,
  }
  const patrolId = makeTaskId(await nextNo(db, "task_no_seq"))
  const workerId = makeTaskId(await nextNo(db, "task_no_seq"))
  const checkerId = makeTaskId(await nextNo(db, "task_no_seq"))
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
    {
      id: checkerId,
      title: "核对一张搜品单的回填",
      goal: "后台这张搜品单上的源商品、noteId 都回填对了；不对就改对",
      steps: [],
      ownerId: admin.id,
      enabled: true,
      modelId,
      dispatch: checkDispatch,
    },
  ])
  await db.insert(t.taskDispatchSources).values([
    { taskId: workerId, sourceTaskId: patrolId },
    { taskId: checkerId, sourceTaskId: patrolId },
  ])
  const [tool] = await db.select({ id: t.tools.id }).from(t.tools).where(eq(t.tools.id, "work.dispatch"))
  if (tool) await db.insert(t.taskTools).values({ taskId: patrolId, refId: tool.id, position: 0 })

  // 巡检的两次运行（派活单的来源）
  const patrolRuns = [manualSessionId(patrolId, 1), manualSessionId(patrolId, 2)]
  await db.insert(t.sessions).values([
    { id: patrolRuns[0]!, taskId: patrolId, status: "done", modelId, triggeredBy: "cron", startedAt: minutesAgo(400), endedAt: minutesAgo(398), costUsd: 0.01 },
    { id: patrolRuns[1]!, taskId: patrolId, status: "done", modelId, triggeredBy: "cron", startedAt: minutesAgo(150), endedAt: minutesAgo(148), costUsd: 0.01 },
  ])

  const runNo = new Map<string, number>()
  const runId = (taskId: string) => {
    const n = (runNo.get(taskId) ?? 0) + 1
    runNo.set(taskId, n)
    return manualSessionId(taskId, n)
  }
  const itemIds: string[] = []

  type Spec = {
    no: string
    /** 被派的任务：默认「处理一张搜品单」；checker = 配了自动重试的那个 */
    task?: "checker"
    status: (typeof t.workItems.$inferInsert)["status"]
    ago: number
    from?: 0 | 1
    human?: boolean
    /** 运行：状态、开始于几分钟前、结束于几分钟前；report = 这次运行用 work.report 报过结果；retry = 结束后排队等第几次自动重试 */
    runs?: { status: (typeof t.sessions.$inferInsert)["status"]; start: number; end?: number; error?: string; wait?: string; report?: boolean; retry?: number }[]
    result?: string
    /** work.report 报的结构化结果 */
    data?: Record<string, WorkReportValue>
    error?: string
    failKind?: WorkFailKind
    /** 排队等自动重试：几分钟后再试（负的 minutesAgo）、这一轮已经重试了几次 */
    retryIn?: number
    autoRetries?: number
    redo?: boolean
  }
  const specs: Spec[] = [
    { no: "PSS-1016-0035", status: "queued", ago: 10, from: 1 },
    { no: "PSS-1016-0033", status: "queued", ago: 12, from: 1 },
    { no: "PSS-1016-0031", status: "running", ago: 140, from: 1, runs: [{ status: "running", start: 30 }] },
    { no: "PSS-1016-0029", status: "running", ago: 145, from: 1, runs: [{ status: "needs_human", start: 120 }] },
    { no: "PSS-1016-0027", status: "running", ago: 146, from: 1, runs: [{ status: "verifying", start: 135, report: true }], data: { 候选数: 9 } },
    { no: "PSS-1016-0021", status: "running", ago: 390, from: 0, runs: [{ status: "waiting", start: 380, wait: "等义乌恒达日用品厂回复单件包装尺寸和毛重" }] },
    {
      no: "PSS-1016-0018",
      status: "done",
      ago: 392,
      from: 0,
      runs: [{ status: "done", start: 370, end: 330, report: true }],
      result: "已建源商品 SPU-2210（3 个 SKU）并关联，回填 noteId 88123。同款：义乌恒达日用品厂，比物 97 分。",
      data: { 源商品数: 3, 比物最高分: 97, 后台已回填: true, noteId: "88123" },
    },
    { no: "PSS-1016-0012", status: "done", ago: 395, from: 0, redo: true, runs: [{ status: "failed", start: 394, end: 391, error: "BestDealer 后台登录失效" }, { status: "done", start: 300, end: 260 }], result: "已建源商品 SPU-2207（2 个 SKU）并关联，回填 noteId 88101。" },
    { no: "PSS-1016-0009", status: "failed", ago: 396, from: 0, runs: [{ status: "failed", start: 260, end: 230, error: "没找到同款：14 个候选最高 71 分" }], error: "没找到同款：14 个候选最高 71 分", failKind: "error" },
    // 第二期：agent 用 work.report 报了办不成（运行正常结束，单没办成，不重试）
    {
      no: "PSS-1016-0006",
      status: "failed",
      ago: 397,
      from: 0,
      runs: [{ status: "done", start: 225, end: 200, report: true }],
      result: "图搜 14 个候选，比物最高 71 分，没有同款。已在后台单上写明原因。",
      data: { 候选数: 14, 比物最高分: 71 },
      error: "agent 判断办不成：14 个候选比物最高 71 分，没有同款",
      failKind: "not_done",
    },
    { no: "PSS-1015-0045", status: "cancelled", ago: 1500, from: 0, error: "客户撤回了搜品单" },
    { no: "PSS-1015-0038", status: "done", ago: 1600, human: true, runs: [{ status: "done", start: 1590, end: 1550 }], result: "试单：已建源商品 SPU-2190 并关联。" },
    // 第二期：配了自动重试的任务。一张出错后排队等第 1 次重试（8 分钟后）；一张重试 2 次都没办成
    {
      no: "PSS-1016-0036",
      task: "checker",
      status: "queued",
      ago: 40,
      from: 1,
      runs: [{ status: "failed", start: 30, end: 2, error: "模型调用失败（已重试 3 次）：上游超时", retry: 1 }],
      error: "模型调用失败（已重试 3 次）：上游超时",
      retryIn: 8,
      autoRetries: 1,
    },
    {
      no: "PSS-1016-0030",
      task: "checker",
      status: "failed",
      ago: 145,
      from: 1,
      runs: [
        { status: "failed", start: 140, end: 136, error: "引擎出错：后台接口返回 502", retry: 1 },
        { status: "failed", start: 126, end: 122, error: "引擎出错：后台接口返回 502", retry: 2 },
        { status: "failed", start: 112, end: 108, error: "引擎出错：后台接口返回 502" },
      ],
      error: "引擎出错：后台接口返回 502",
      failKind: "error",
      autoRetries: 2,
    },
  ]

  for (const spec of specs) {
    const id = workItemId(await nextNo(db, "work_item_no_seq"))
    itemIds.push(id)
    const target = spec.task === "checker" ? checkerId : workerId
    const fromSessionId = spec.human ? null : patrolRuns[spec.from ?? 0]!
    const log: WorkLogEntry[] = [{ at: minutesAgo(spec.ago).toISOString(), kind: "created", ...(spec.human ? { byId: admin.id } : {}) }]
    await db.insert(t.workItems).values({
      id,
      taskId: target,
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
      failKind: spec.status === "failed" ? (spec.failKind ?? "error") : null,
      notBefore: spec.retryIn !== undefined ? minutesAgo(-spec.retryIn) : null,
      autoRetries: spec.autoRetries ?? 0,
      result:
        spec.result || spec.data
          ? {
              summary: spec.result ?? "",
              ...(spec.status === "done" ? { verification: "三方 AI 验收通过：检查点都对得上" } : {}),
              fileIds: [],
              ...(spec.data ? { data: spec.data } : {}),
            }
          : null,
    })
    let lastSession: string | null = null
    for (const [index, each] of (spec.runs ?? []).entries()) {
      const sessionId = runId(target)
      lastSession = sessionId
      if (index > 0 && spec.redo) log.push({ at: minutesAgo(each.start + 1).toISOString(), kind: "redo", byId: admin.id })
      log.push({ at: minutesAgo(each.start).toISOString(), kind: "run_started", sessionId })
      if (each.report)
        log.push({
          at: minutesAgo(each.start - 5).toISOString(),
          kind: "reported",
          sessionId,
          note: spec.failKind === "not_done" ? (spec.error ?? "").replace(/^agent 判断办不成：/, "办不成：") : workReportLine(spec.data),
        })
      await db.insert(t.sessions).values({
        id: sessionId,
        taskId: target,
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
      if (each.end !== undefined) log.push({ at: minutesAgo(each.end).toISOString(), kind: "run_ended", sessionId, note: spec.failKind === "not_done" && each.status === "done" ? "not_done" : each.status })
      if (each.retry && each.end !== undefined) {
        // 自动重试：出错以后隔 10 分钟再试（最后一张等重试的按 retryIn）
        const next = index === (spec.runs?.length ?? 0) - 1 && spec.retryIn !== undefined ? minutesAgo(-spec.retryIn) : minutesAgo(each.end - 10)
        log.push({ at: minutesAgo(each.end).toISOString(), kind: "retry_scheduled", retry: each.retry, notBefore: next.toISOString(), note: each.error })
      }
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
  return { patrolId, workerId, checkerId, itemIds }
}
