// 子 agent 的演示数据（开发、测试用，不进正式环境；docs/dev/sub-agents.md 第 13 节）：一个选了「拆给子 agent」的任务，
// 一次父运行在等子 agent，拆了 4 个：2 个办成（一个交回了字段和文件）、1 个没办成、1 个排队。网页的「子 agent」区块、子运行详情靠它做样子。
// 运行只插页面要的几列和快照（子快照照 shared 的 deriveSubSnapshot 派生），没有消息，不能「继续」，只用来看。
import {
  deriveSubSnapshot,
  manualSessionId,
  subagentQueueEvent,
  subagentWaitEvent,
  subSessionId,
  taskId as makeTaskId,
  type SubagentItemInput,
  type SubResult,
} from "@heyagent/shared"
import { asc, eq, sql } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { appendEvent } from "../engine/records.js"
import { buildSnapshot } from "../engine/sessions.js"
import { SUBAGENT_QUEUED_WHAT } from "../engine/subagents/start.js"
import { builtinSnapshotTool, syncBuiltinTools } from "../engine/tools/builtin-defs.js"
import { saveFile } from "../files/service.js"

const nextNo = async (db: Db, seq: string) => Number((await db.execute<{ n: string }>(sql`select nextval(${seq}) as n`)).rows[0]!.n)
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)

/** 插入演示数据，返回 { 任务, 父运行, 子运行 } */
export async function insertSubagentFixtures(db: Db): Promise<{ taskId: string; parentId: string; childIds: string[] }> {
  const [admin] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.role, "admin")).orderBy(asc(t.users.createdAt)).limit(1)
  if (!admin) throw new Error("库里还没有主管账号：先灌演示数据（pnpm db:seed）或在页面上设置管理员")
  const [model] = await db.select({ id: t.models.id }).from(t.models).where(eq(t.models.kind, "chat")).orderBy(asc(t.models.priceIn)).limit(1)
  const modelId = model?.id ?? "openrouter/anthropic/claude-sonnet-5.5"

  const taskId = makeTaskId(await nextNo(db, "task_no_seq"))
  await db.insert(t.tasks).values({
    id: taskId,
    title: "分头查几个公开页面，汇总成一张表",
    goal: "每个页面查出标题和状态，汇总成 summary.csv",
    steps: [{ id: "s1", text: "每个页面拆一个子 agent 去查", wait: false }],
    ownerId: admin.id,
    enabled: true,
    modelId,
    reviewModelId: modelId,
    subagentModelId: modelId,
  })
  // 内置工具的行是 API / worker 启动时写的；空库先灌数据、还没起过服务时没有，这里补上，任务才选得上「拆给子 agent」
  await syncBuiltinTools(db)
  await db.insert(t.taskTools).values({ taskId, refId: "subagent.start", position: 0 })

  const parentSnapshot = await buildSnapshot(db, taskId, { source: "manual", runAttachments: [] })
  const parentId = manualSessionId(taskId, 1)
  await db.insert(t.sessions).values({
    id: parentId,
    taskId,
    status: "waiting",
    modelId,
    triggeredBy: "manual",
    startedAt: minutesAgo(30),
    snapshot: parentSnapshot,
    createdById: admin.id,
    costUsd: 0.11,
    stepCount: 4,
  })
  await appendEvent(db, parentId, { kind: "plan", title: "运行开始", detail: "人点了立即运行", at: minutesAgo(30) })
  await appendEvent(db, parentId, { kind: "tool", title: "拆给子 agent", toolId: "subagent.start", detail: null, at: minutesAgo(29) })
  await db.insert(t.sessionWaits).values({ sessionId: parentId, what: "子 agent（还有 1 个没结束）", triggerKind: "event", event: subagentWaitEvent(parentId, "all"), createdAt: minutesAgo(28) })

  // 父运行空间里的一个文件，给第 1 个子 agent 读
  const listFile = await saveFile(db, { data: Buffer.from("页面\nA\nB\nC\nD\n"), name: "pages.csv", mime: "text/csv", kind: "artifact", sessionId: parentId, path: "in/pages.csv" })

  type Spec = {
    item: SubagentItemInput
    status: "done" | "waiting"
    outcome?: "achieved" | "not_achieved"
    outcomeBy?: "agent" | "rule"
    reason?: string
    result?: SubResult
    cost: number
    start: number
    end?: number
    file?: string
  }
  const specs: Spec[] = [
    {
      item: { title: "查页面 A", goal: "打开页面 A，记下标题和状态码，交回这两个字段", input: { 网址: "https://example.com/a" }, fileIds: [listFile.id], results: ["标题", "状态码"] },
      status: "done",
      outcome: "achieved",
      outcomeBy: "agent",
      result: { summary: "页面 A 能打开，标题是 Example A，状态码 200；明细存在 out/a.json", evidence: "browser_navigate 返回 200，页面标题 Example A", data: { 标题: "Example A", 状态码: 200 } },
      cost: 0.05,
      start: 28,
      end: 20,
      file: "out/a.json",
    },
    {
      item: { title: "查页面 B", goal: "打开页面 B，记下标题和状态码，交回这两个字段", input: { 网址: "https://example.com/b" }, results: ["标题", "状态码"] },
      status: "done",
      outcome: "achieved",
      outcomeBy: "agent",
      result: { summary: "页面 B 能打开，标题是 Example B，状态码 200", evidence: "页面标题 Example B", data: { 标题: "Example B", 状态码: 200 } },
      cost: 0.04,
      start: 28,
      end: 18,
    },
    {
      item: { title: "查页面 C", goal: "打开页面 C，记下标题和状态码，交回这两个字段", input: { 网址: "https://example.invalid/c" }, results: ["标题", "状态码"] },
      status: "done",
      outcome: "not_achieved",
      outcomeBy: "agent",
      reason: "页面打不开：域名解析不到",
      result: { summary: "页面 C 打不开（域名解析不到），试了两次", evidence: "browser_navigate 报 ERR_NAME_NOT_RESOLVED" },
      cost: 0.03,
      start: 28,
      end: 22,
    },
    {
      item: { title: "查页面 D", goal: "打开页面 D，记下标题和状态码，交回这两个字段", input: { 网址: "https://example.com/d" }, results: ["标题", "状态码"] },
      status: "waiting",
      cost: 0,
      start: 28,
    },
  ]
  const childIds: string[] = []
  for (const [index, spec] of specs.entries()) {
    const n = index + 1
    const id = subSessionId(parentId, n)
    const files = (spec.item.fileIds ?? []).map((fileId) => ({ id: fileId, name: "in/pages.csv", mime: "text/csv", size: listFile.size }))
    const snapshot = deriveSubSnapshot(parentSnapshot, { parentSessionId: parentId, n, item: spec.item, files, builtinTool: builtinSnapshotTool })
    await db.insert(t.sessions).values({
      id,
      taskId,
      status: spec.status,
      modelId: snapshot.modelId,
      triggeredBy: "sub",
      startedAt: minutesAgo(spec.start),
      endedAt: spec.end ? minutesAgo(spec.end) : null,
      snapshot,
      createdById: admin.id,
      parentSessionId: parentId,
      kind: "sub",
      costLimitUsd: 1,
      maxSteps: 60,
      costUsd: spec.cost,
      outcome: spec.outcome ?? null,
      outcomeBy: spec.outcomeBy ?? null,
      outcomeReason: spec.reason ?? (spec.outcome === "achieved" ? spec.result?.evidence : null) ?? null,
      subResult: spec.result ?? null,
    })
    await appendEvent(db, id, { kind: "plan", title: "运行开始", detail: `父运行 ${parentId} 拆出来的第 ${n} 个子 agent「${spec.item.title}」`, at: minutesAgo(spec.start) })
    if (spec.status === "waiting")
      await db.insert(t.sessionWaits).values({ sessionId: id, what: SUBAGENT_QUEUED_WHAT, triggerKind: "event", event: subagentQueueEvent(parentId), createdAt: minutesAgo(spec.start) })
    else await appendEvent(db, id, { kind: "done", title: spec.outcome === "achieved" ? "agent 报办成" : "agent 报没办成", detail: spec.result?.summary ?? null, at: minutesAgo(spec.end ?? 0) })
    if (spec.file) await saveFile(db, { data: Buffer.from(JSON.stringify(spec.result?.data ?? {}, null, 2)), name: "a.json", mime: "application/json", kind: "artifact", sessionId: id, path: spec.file })
    childIds.push(id)
  }
  return { taskId, parentId, childIds }
}
