// 新建一次运行：冻结任务配置（快照）、建检查点、关联附件、写第一条消息、排进 session.run。
import { and, asc, count, eq, inArray } from "drizzle-orm"
import {
  ALWAYS_ON_BUILTIN_TOOLS,
  BROWSER_TOOL_ID,
  COMPARE_TOOL_ID,
  GALLERY_TOOL_ID,
  cronSessionId,
  fmtDate,
  fmtDateTime,
  manualSessionId,
  recognizeCheckpoints,
  type BuiltinToolId,
  type SessionSnapshot,
  type SnapshotTool,
} from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { listTaskAttachments } from "../files/service.js"
import { QUEUES, runJobOptions, sendInTx, type Tx } from "./queue.js"
import { appendEvent, appendMessage, writeAudit } from "./records.js"
import {
  browserSnapshotTool,
  compareSnapshotTool,
  gallerySnapshotTool,
  builtinSnapshotTool,
  isBuiltinTool,
} from "./tools/builtin-defs.js"

export type SessionSource = SessionSnapshot["source"]

export class EngineError extends Error {
  readonly code: "NOT_FOUND" | "BAD_REQUEST" | "CONFLICT"
  constructor(code: EngineError["code"], message: string) {
    super(message)
    this.code = code
  }
}

const sourceLabel: Record<SessionSource, string> = {
  manual: "人点了立即运行",
  cron: "定时触发",
  todo: "人加的待办触发",
  event: "外部事件触发",
}

/** 按任务当前的配置做快照 */
export async function buildSnapshot(
  db: Db | Tx,
  taskId: string,
  extra: {
    source: SessionSource
    note?: string
    runAttachments: (typeof t.files.$inferSelect)[]
  }
): Promise<SessionSnapshot> {
  const [task] = await db.select().from(t.tasks).where(eq(t.tasks.id, taskId))
  if (!task) throw new EngineError("NOT_FOUND", `找不到任务 ${taskId}`)

  // 在事务里：同一个连接上不能并发查询，按顺序来
  const memories = await db
    .select({
      id: t.memories.id,
      content: t.memories.content,
      appliesTo: t.memories.appliesTo,
      status: t.memories.status,
    })
    .from(t.taskMemories)
    .innerJoin(t.memories, eq(t.memories.id, t.taskMemories.refId))
    .where(eq(t.taskMemories.taskId, taskId))
    .orderBy(asc(t.taskMemories.position))
  const skills = await db
    .select({
      id: t.skills.id,
      name: t.skills.name,
      description: t.skills.description,
      version: t.skills.version,
      body: t.skills.body,
      status: t.skills.status,
    })
    .from(t.taskSkills)
    .innerJoin(t.skills, eq(t.skills.id, t.taskSkills.refId))
    .where(eq(t.taskSkills.taskId, taskId))
    .orderBy(asc(t.taskSkills.position))
  const toolRows = await db
    .select({ tool: t.tools })
    .from(t.taskTools)
    .innerJoin(t.tools, eq(t.tools.id, t.taskTools.refId))
    .where(eq(t.taskTools.taskId, taskId))
    .orderBy(asc(t.taskTools.position))
  const rules = await db
    .select({ rule: t.rules })
    .from(t.taskRules)
    .innerJoin(t.rules, eq(t.rules.id, t.taskRules.refId))
    .where(eq(t.taskRules.taskId, taskId))
    .orderBy(asc(t.taskRules.position))
  const taskMemory = await db
    .select({ content: t.taskMemoryEntries.content })
    .from(t.taskMemoryEntries)
    .where(eq(t.taskMemoryEntries.taskId, taskId))
    .orderBy(asc(t.taskMemoryEntries.id))
  const ruleIds = rules.map(({ rule }) => rule.id)
  const ruleTools = ruleIds.length
    ? await db
        .select()
        .from(t.ruleTools)
        .where(inArray(t.ruleTools.ruleId, ruleIds))
        .orderBy(asc(t.ruleTools.position))
    : []

  // 每个任务都自带的 3 个内置工具 + 建任务时选的（内置工具的说明以代码为准）
  const tools: SnapshotTool[] = ALWAYS_ON_BUILTIN_TOOLS.map((id) =>
    builtinSnapshotTool(id)
  )
  for (const { tool } of toolRows) {
    if (tools.some((each) => each.id === tool.id)) continue
    if (tool.source === "builtin") {
      if (tool.id === BROWSER_TOOL_ID) tools.push(browserSnapshotTool())
      else if (tool.id === GALLERY_TOOL_ID) tools.push(gallerySnapshotTool())
      else if (tool.id === COMPARE_TOOL_ID) tools.push(compareSnapshotTool())
      else if (isBuiltinTool(tool.id)) tools.push(builtinSnapshotTool(tool.id))
      continue
    }
    tools.push({
      id: tool.id,
      name: tool.name,
      summary: tool.summary,
      description: tool.description,
      source: tool.source,
      risk: tool.risk,
      serverId: tool.serverId ?? undefined,
      http: tool.http ?? undefined,
    })
  }

  const checkpoints: SessionSnapshot["checkpoints"] = []
  for (const step of task.steps) {
    if (!step.checkpoint?.trim()) continue
    for (const recognized of recognizeCheckpoints(step.checkpoint))
      checkpoints.push({ ...recognized, stepId: step.id })
  }

  // 浏览器（M2）：允许的 Chrome 配置（空 = 全部）连同给 agent 看的说明、网址白名单、是否允许执行脚本，都冻结进快照
  let browser: SessionSnapshot["browser"]
  if (tools.some((tool) => tool.id === BROWSER_TOOL_ID)) {
    const profiles = await db
      .select({
        id: t.browserProfiles.id,
        name: t.browserProfiles.name,
        description: t.browserProfiles.description,
      })
      .from(t.browserProfiles)
      .where(
        task.browserProfileIds.length
          ? inArray(t.browserProfiles.id, task.browserProfileIds)
          : undefined
      )
      .orderBy(asc(t.browserProfiles.position), asc(t.browserProfiles.createdAt))
    browser = {
      profiles,
      allowedDomains: task.allowedDomains,
      allowEvaluate: task.allowBrowserEvaluate,
    }
  }

  const taskAttachments = await listTaskAttachments(db, taskId)
  const attachments = [...taskAttachments, ...extra.runAttachments].map(
    (file) => ({
      id: file.id,
      name: file.name,
      mime: file.mime,
      size: file.size,
    })
  )

  // 选了技能却没选「读取技能」、带了附件却没选「读附件」，agent 就只看得到目录读不到内容：这两个跟着自动带上
  const publishedSkills = skills.filter((skill) => skill.status === "published")
  const implied: BuiltinToolId[] = []
  if (publishedSkills.length) implied.push("skill.load")
  if (attachments.length) implied.push("file.read")
  for (const id of implied) {
    if (!tools.some((each) => each.id === id))
      tools.push(builtinSnapshotTool(id))
  }

  return {
    v: 1,
    task: {
      id: task.id,
      title: task.title,
      goal: task.goal,
      ownerId: task.ownerId,
      steps: task.steps,
    },
    modelId: task.modelId,
    ...(task.verifyModelId ? { verifyModelId: task.verifyModelId } : {}),
    memories: memories
      .filter((memory) => memory.status === "active")
      .map(({ id, content, appliesTo }) => ({ id, content, appliesTo })),
    taskMemory: taskMemory.map((entry) => entry.content),
    skills: publishedSkills.map(({ id, name, description, version, body }) => ({
      id,
      name,
      description,
      version,
      body,
    })),
    tools,
    rules: rules.map(({ rule }) => ({
      id: rule.id,
      name: rule.name,
      trigger: rule.trigger,
      action: rule.action,
      toolIds: ruleTools
        .filter((link) => link.ruleId === rule.id)
        .map((link) => link.toolId),
      compiledTrigger: rule.compiledTrigger ?? undefined,
    })),
    checkpoints,
    attachments,
    note: extra.note?.trim() || undefined,
    source: extra.source,
    ...(browser ? { browser } : {}),
  }
}

/** 第一条用户消息：开始执行 + 附加说明 */
export function firstUserMessage(snapshot: SessionSnapshot): string {
  const lines = [
    `开始执行任务（${sourceLabel[snapshot.source]}）。现在是 ${fmtDateTime(new Date())}（上海时间）。`,
  ]
  if (snapshot.note) lines.push(`附加说明：${snapshot.note}`)
  if (snapshot.attachments.length)
    lines.push(
      `这次运行带了 ${snapshot.attachments.length} 个附件，清单见系统提示，用 file.read 读取。`
    )
  lines.push("请按系统提示里的目标、步骤和检查点开始工作。")
  return lines.join("\n")
}

async function nextSessionId(
  tx: Tx,
  taskId: string,
  source: SessionSource,
  now: Date,
  attempt: number
): Promise<string> {
  if (source === "cron") {
    const mmdd = fmtDate(now).slice(5).replace("-", "")
    return cronSessionId(taskId, mmdd, attempt + 1)
  }
  const [row] = await tx
    .select({ n: count() })
    .from(t.sessions)
    .where(eq(t.sessions.taskId, taskId))
  return manualSessionId(taskId, (row?.n ?? 0) + 1 + attempt)
}

export interface StartSessionOptions {
  taskId: string
  source: SessionSource
  actorId?: string | null
  attachmentFileIds?: string[]
  note?: string
}

export async function startSessionImpl(
  db: Db,
  input: StartSessionOptions
): Promise<{ sessionId: string }> {
  const [task] = await db
    .select({
      id: t.tasks.id,
      enabled: t.tasks.enabled,
      ownerId: t.tasks.ownerId,
    })
    .from(t.tasks)
    .where(eq(t.tasks.id, input.taskId))
  if (!task) throw new EngineError("NOT_FOUND", `找不到任务 ${input.taskId}`)
  if (!task.enabled)
    throw new EngineError("BAD_REQUEST", "任务已停用，先启用再运行")

  const fileIds = [...new Set(input.attachmentFileIds ?? [])]
  const files = fileIds.length
    ? await db.select().from(t.files).where(inArray(t.files.id, fileIds))
    : []
  for (const id of fileIds) {
    const file = files.find((row) => row.id === id)
    if (!file) throw new EngineError("NOT_FOUND", `找不到附件 ${id}`)
    const isOwnTaskAttachment = file.taskId === task.id && !file.sessionId
    if (
      !isOwnTaskAttachment &&
      (file.kind !== "upload" || file.sessionId || file.taskId)
    )
      throw new EngineError(
        "BAD_REQUEST",
        `文件 ${file.name} 已经用在别处，请重新上传`
      )
  }
  // 任务附件本来就在快照里，这里只算这次运行新带的
  const runAttachments = files.filter(
    (file) => !(file.taskId === task.id && !file.sessionId)
  )

  const now = new Date()
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      const sessionId = await db.transaction(async (tx) => {
        const snapshot = await buildSnapshot(tx, input.taskId, {
          source: input.source,
          note: input.note,
          runAttachments,
        })
        const sessionId = await nextSessionId(
          tx,
          input.taskId,
          input.source,
          now,
          attempt
        )
        await tx.insert(t.sessions).values({
          id: sessionId,
          taskId: input.taskId,
          status: "running",
          modelId: snapshot.modelId,
          triggeredBy: input.source,
          startedAt: now,
          snapshot,
          note: snapshot.note ?? null,
          createdById: input.actorId ?? null,
        })
        if (snapshot.checkpoints.length) {
          await tx.insert(t.checkpoints).values(
            snapshot.checkpoints.map((checkpoint, position) => ({
              sessionId,
              position,
              title: checkpoint.title,
              kind: checkpoint.kind,
              target: checkpoint.target ?? null,
              stepId: checkpoint.stepId ?? null,
            }))
          )
        }
        if (runAttachments.length) {
          await tx
            .update(t.files)
            .set({ sessionId, kind: "attachment" })
            .where(
              inArray(
                t.files.id,
                runAttachments.map((file) => file.id)
              )
            )
        }
        if (snapshot.memories.length) {
          await tx
            .update(t.memories)
            .set({ lastUsedAt: now, lastUsedSessionId: sessionId })
            .where(
              inArray(
                t.memories.id,
                snapshot.memories.map((memory) => memory.id)
              )
            )
        }
        await appendMessage(tx, sessionId, {
          role: "user",
          content: firstUserMessage(snapshot),
        })
        await appendEvent(tx, sessionId, {
          kind: "plan",
          title: "运行开始",
          detail: [
            sourceLabel[input.source],
            snapshot.note ? `附加说明：${snapshot.note}` : null,
          ]
            .filter(Boolean)
            .join("；"),
          at: now,
        })
        await sendInTx(
          db,
          tx,
          QUEUES.run,
          { sessionId },
          runJobOptions(sessionId)
        )
        if (input.actorId)
          await writeAudit(tx, {
            actorId: input.actorId,
            action: "session.start",
            targetTable: "sessions",
            targetId: sessionId,
            detail: {
              taskId: input.taskId,
              source: input.source,
              attachments: fileIds,
            },
          })
        return sessionId
      })
      return { sessionId }
    } catch (error) {
      // 主键撞号（并发触发、同一天第二次 cron）：序号 +1 重试
      if (isSessionIdConflict(error)) continue
      throw error
    }
  }
  throw new Error("生成 session 编号失败，请稍后重试")
}

/** drizzle 会把 pg 的错误包一层（cause） */
function isSessionIdConflict(error: unknown): boolean {
  for (
    let current = error as
        { code?: string; constraint?: string; cause?: unknown } | undefined,
      depth = 0;
    current && depth < 4;
    current = current.cause as typeof current, depth++
  ) {
    if (current.code === "23505" && current.constraint === "sessions_pkey")
      return true
  }
  return false
}

/** 任务最近一个挂起等待中的 session（待办触发时用） */
export async function latestWaitingSession(db: Db | Tx, taskId: string) {
  const rows = await db
    .select({ id: t.sessions.id })
    .from(t.sessions)
    .where(and(eq(t.sessions.taskId, taskId), eq(t.sessions.status, "waiting")))
    .orderBy(asc(t.sessions.startedAt))
  return rows.at(-1)?.id
}
