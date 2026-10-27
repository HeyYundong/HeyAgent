// 固化（docs/dev/solidify.md 第 5 节、15.3）：把一次办成的运行写成脚本、试跑、交给人审核。
// 一版脚本是一个小状态机（routine_versions.status）：drafting 写脚本 → testing 试跑 →（没过再写、再试跑）→ review 待审核 / failed 没成功。
// - 队列任务 routine.compile 每次往下走一步，不等试跑：试跑可能要等 Chrome、等人登录，试跑的运行结束时引擎再发一次；
// - 写一次算一轮（模型出错、程序检查没过、试跑没过都要再写），最多 ROUTINE_MAX_ROUNDS 轮；
// - 程序检查没过就在同一个任务里接着写下一轮（不用等什么），试跑没过回 drafting、再发一次 routine.compile。
import { and, eq, inArray, max, sql } from "drizzle-orm"
import {
  isRunEnded,
  ROUTINE_MAX_ROUNDS,
  routineId as routineIdOf,
  routineTestReportSchema,
  routineVersionId as routineVersionIdOf,
  type RoutineTestReport,
  type RoutineTestRound,
} from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { assertCan, audit, badRequest, conflict, nextNo, notFound, type WriteCtx } from "../data/config/common.js"
import { createHumanItem, notifyAssignee } from "../engine/humans.js"
import { callStructured, resolveModel, type ResolvedModel } from "../engine/model.js"
import { notifyUsers } from "../engine/notify.js"
import { sendRoutineCompile, type RoutineCompileJob } from "./jobs.js"
import { buildMaterial, reportedData, type CompileMaterial } from "./material.js"
import { compileOutputSchema, compileSystemPrompt, type CompileOutput } from "./prompt.js"
import { checkRoutine } from "./checks.js"
import { evaluateTestRun, startTestRun, testFeedback } from "./test-run.js"

/** 还在往下走的版本：同一个流程同时只能有一版 */
const IN_PROGRESS = ["drafting", "testing", "review"] as const
/** 脚本、说明最长多少字（太长的多半是模型跑偏了） */
const CODE_MAX = 100_000
const TEXT_MAX = 4000

const clip = (value: string, limit: number) => (value.length > limit ? `${value.slice(0, limit)}…` : value)
const taskLink = (taskId: string) => `#/tasks?id=${encodeURIComponent(taskId)}`

/**
 * 运行详情「⋯ → 固化成流程」：已结束、办成的普通运行；任务负责人和主管。
 * 任务还没有固化流程就建一个（RT-<n>），再建一版（status = drafting），发 routine.compile
 */
export async function startCompile(ctx: WriteCtx, input: { sessionId: string; skipTest?: boolean }): Promise<{ routineId: string; versionId: string }> {
  const [row] = await ctx.db
    .select({ session: t.sessions, ownerId: t.tasks.ownerId })
    .from(t.sessions)
    .innerJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))
    .where(eq(t.sessions.id, input.sessionId))
  if (!row) throw notFound("运行", input.sessionId)
  const { session } = row
  assertCan(ctx.actor, "task.manage", { ownerId: row.ownerId }, "只有任务负责人和主管能把运行固化成流程")
  if (session.kind !== "run") throw badRequest("固化试跑的运行不能再固化")
  if (!isRunEnded(session.status)) throw badRequest("运行还没结束，结束后才能固化")
  if (session.outcome !== "achieved") throw badRequest("只有办成的运行能固化成流程")
  if (!session.snapshot) throw badRequest("这次运行没有快照（太老的运行），不能固化")

  return ctx.db.transaction(async (tx) => {
    const lockRoutine = () => tx.select().from(t.routines).where(eq(t.routines.taskId, session.taskId)).for("update")
    let [routine] = await lockRoutine()
    if (!routine) {
      // 并发点了两次：唯一索引挡住第二个，再读一次就是第一个建的
      await tx
        .insert(t.routines)
        .values({ id: routineIdOf(await nextNo(tx, "routine_no_seq")), taskId: session.taskId, status: "trial" })
        .onConflictDoNothing({ target: t.routines.taskId })
      ;[routine] = await lockRoutine()
    }
    if (!routine) throw new Error("建固化流程失败")
    const [busy] = await tx
      .select({ version: t.routineVersions.version, status: t.routineVersions.status })
      .from(t.routineVersions)
      .where(and(eq(t.routineVersions.routineId, routine.id), inArray(t.routineVersions.status, [...IN_PROGRESS])))
      .limit(1)
    if (busy)
      throw conflict(
        busy.status === "review"
          ? `第 ${busy.version} 版在等审核，先审核了它再固化`
          : `第 ${busy.version} 版还在${busy.status === "drafting" ? "写脚本" : "试跑"}，等它写完、试跑完再固化`
      )
    const [last] = await tx.select({ n: max(t.routineVersions.version) }).from(t.routineVersions).where(eq(t.routineVersions.routineId, routine.id))
    const version = (last?.n ?? 0) + 1
    const versionId = routineVersionIdOf(routine.id, version)
    // 源运行先跑过这个流程的脚本（停下后 agent 接着办成）：这一版是修那一版
    const ran = session.routine
    const baseVersion = ran && ran.mode === "run" && ran.routineId === routine.id ? ran.version : null
    const [task] = await tx.select({ title: t.tasks.title }).from(t.tasks).where(eq(t.tasks.id, session.taskId))
    await tx.insert(t.routineVersions).values({
      id: versionId,
      routineId: routine.id,
      version,
      status: "drafting",
      name: task?.title ?? "",
      sourceSessionId: session.id,
      baseVersion,
      skipTest: input.skipTest ?? false,
      createdById: ctx.actor.id,
    })
    await audit(tx, ctx.actor.id, "routine.compile", "routine_versions", versionId, {
      sessionId: session.id,
      ...(baseVersion !== null ? { baseVersion } : {}),
      ...(input.skipTest ? { skipTest: true } : {}),
    })
    await sendRoutineCompile(ctx.db, tx, { versionId })
    return { routineId: routine.id, versionId }
  })
}

// ---------- routine.compile：往下走一步 ----------

type VersionRow = typeof t.routineVersions.$inferSelect

interface Loaded {
  version: VersionRow
  taskId: string
  taskTitle: string
  ownerId: string
}

async function loadVersion(db: Db, versionId: string): Promise<Loaded | undefined> {
  const [row] = await db
    .select({ version: t.routineVersions, taskId: t.tasks.id, taskTitle: t.tasks.title, ownerId: t.tasks.ownerId })
    .from(t.routineVersions)
    .innerJoin(t.routines, eq(t.routines.id, t.routineVersions.routineId))
    .innerJoin(t.tasks, eq(t.tasks.id, t.routines.taskId))
    .where(eq(t.routineVersions.id, versionId))
  return row
}

/** routine.compile 的处理函数：按这一版的 status 往下走一步（写 / 改脚本 → 开试跑；试跑结束 → 看结果、再改或交给人审核） */
export async function handleCompileJob(db: Db, job: RoutineCompileJob): Promise<void> {
  const loaded = await loadVersion(db, job.versionId)
  // 版本删了（任务删了），或者已经往下走过了（重复的任务）：没事做
  if (!loaded) return
  if (loaded.version.status === "drafting") return draft(db, loaded)
  if (loaded.version.status === "testing") return afterTest(db, loaded)
}

/** 固化用哪个模型：默认模型的「固化」，没设用「规划」 */
async function solidifyModelId(db: Db) {
  const rows = await db
    .select({ role: t.modelDefaults.role, modelId: t.modelDefaults.modelId })
    .from(t.modelDefaults)
    .where(inArray(t.modelDefaults.role, ["solidify", "plan"]))
  return rows.find((row) => row.role === "solidify")?.modelId ?? rows.find((row) => row.role === "plan")?.modelId
}

const reportOf = (version: VersionRow): RoutineTestReport => {
  const parsed = version.testReport ? routineTestReportSchema.safeParse(version.testReport) : undefined
  return parsed?.success ? parsed.data : { rounds: [] }
}

/** 上一轮的问题（交回固化员）：试跑没过的那一轮，加上那一版的脚本 */
async function previousProblem(db: Db, version: VersionRow): Promise<string | undefined> {
  const last = reportOf(version).rounds.at(-1)
  if (!last || last.passed || last.round !== version.round) return undefined
  return [await testFeedback(db, last), previousCode(version.code)].join("\n\n")
}

const previousCode = (code: string) => (code ? `你上一轮写的脚本：\n\`\`\`js\n${code}\n\`\`\`` : "")

/** 写脚本：最多写到第 ROUTINE_MAX_ROUNDS 轮，写出一版过了程序检查的就去试跑（或者直接交给人审核） */
async function draft(db: Db, loaded: Loaded) {
  const { version } = loaded
  if (version.round >= ROUTINE_MAX_ROUNDS) return fail(db, loaded, `已经写了 ${version.round} 轮，没写出能用的脚本`)
  if (!version.sourceSessionId) return fail(db, loaded, "原来那次运行已经删掉了，没法固化")

  let material: CompileMaterial
  try {
    const base = version.baseVersion !== null ? await baseOf(db, version.routineId, version.baseVersion) : undefined
    material = await buildMaterial(db, { sourceSessionId: version.sourceSessionId, routineId: version.routineId, ...(base ? { base } : {}) })
  } catch (error) {
    return fail(db, loaded, `读不到原来那次运行：${(error as Error).message}`)
  }
  const modelId = await solidifyModelId(db)
  if (!modelId) return fail(db, loaded, "「模型」页没有设固化的默认模型，也没有规划的默认模型")
  let resolved: ResolvedModel
  try {
    resolved = await resolveModel(db, modelId)
  } catch (error) {
    return fail(db, loaded, `固化用的模型 ${modelId} 用不了：${(error as Error).message}`)
  }
  const system = compileSystemPrompt()
  let problem = await previousProblem(db, version)
  let lastError = ""

  for (let round = version.round + 1; round <= ROUTINE_MAX_ROUNDS; round++) {
    const content = problem ? `${material.text}\n\n## 上一轮的问题（这一轮要改好）\n${problem}` : material.text
    let output: CompileOutput
    try {
      const result = await callStructured(resolved, {
        system,
        messages: [{ role: "user", content }],
        schema: compileOutputSchema,
        name: "routine_compile",
      })
      await addCost(db, version.id, { round, modelId, tokensIn: result.tokensIn, tokensOut: result.tokensOut, costUsd: result.costUsd })
      output = result.object
    } catch (error) {
      // 模型出错、格式不对：这一轮算用掉了（不然坏掉的模型会一直重试）
      await addCost(db, version.id, { round, modelId, tokensIn: 0, tokensOut: 0, costUsd: 0 })
      lastError = `固化员（${modelId}）出错：${clip((error as Error).message, 300)}`
      problem = `上一轮没有给出合格的 JSON：${clip((error as Error).message, 300)}。照要求的字段只输出 JSON。`
      continue
    }

    const fields = {
      name: clip(output.name.trim() || loaded.taskTitle, 100),
      description: clip(output.description.trim(), TEXT_MAX),
      code: output.code,
      commits: output.commits.map((each) => clip(each.trim(), 200)).filter(Boolean).slice(0, 50),
      assumptions: output.assumptions.map((each) => clip(each.trim(), 500)).filter(Boolean).slice(0, 50),
    }
    if (!output.suitable) {
      await db.update(t.routineVersions).set({ name: fields.name, description: fields.description }).where(eq(t.routineVersions.id, version.id))
      return fail(db, loaded, `不适合固化：${clip(output.reason.trim() || "固化员没写原因", 1000)}`)
    }
    const check = checkRoutine({
      code: output.code,
      inputSchema: output.inputSchema,
      outputSchema: output.outputSchema,
      toolIds: material.toolIds,
      ...(material.dispatch ? { dispatch: material.dispatch } : {}),
      sampleInput: material.input,
    })
    const problems = [...check.problems]
    if (output.code.length > CODE_MAX) problems.push(`脚本太长（${output.code.length} 字，最多 ${CODE_MAX}）`)
    // 写下来：没过的也存着最后一版（审核卡、没成功时看得到写成了什么样）
    await db
      .update(t.routineVersions)
      .set({
        ...fields,
        code: clip(output.code, CODE_MAX),
        ...(check.inputSchema ? { inputSchema: check.inputSchema } : {}),
        ...(check.outputSchema ? { outputSchema: check.outputSchema } : {}),
      })
      .where(eq(t.routineVersions.id, version.id))
    if (problems.length) {
      lastError = `程序检查没过：${problems.join("；")}`
      problem = [`程序检查没过：\n${problems.map((each) => `- ${each}`).join("\n")}`, previousCode(output.code)].join("\n\n")
      continue
    }
    if (version.skipTest) return toReview(db, loaded, { name: fields.name, description: fields.description, assumptions: fields.assumptions })
    return startTest(db, loaded, round, material)
  }
  return fail(db, loaded, `写了 ${ROUTINE_MAX_ROUNDS} 轮都没写出能用的脚本。最后一轮：${lastError}`)
}

async function baseOf(db: Db, routineId: string, version: number) {
  const [row] = await db
    .select({ version: t.routineVersions.version, code: t.routineVersions.code, description: t.routineVersions.description })
    .from(t.routineVersions)
    .where(and(eq(t.routineVersions.routineId, routineId), eq(t.routineVersions.version, version)))
  return row
}

/** 这一轮的花费累计进这一版（几轮合计）；轮数一起记下（进程崩了重试时接着数） */
async function addCost(db: Db, versionId: string, input: { round: number; modelId: string; tokensIn: number; tokensOut: number; costUsd: number }) {
  await db
    .update(t.routineVersions)
    .set({
      round: input.round,
      modelId: input.modelId,
      tokensIn: sql`${t.routineVersions.tokensIn} + ${input.tokensIn}`,
      tokensOut: sql`${t.routineVersions.tokensOut} + ${input.tokensOut}`,
      costUsd: sql`${t.routineVersions.costUsd} + ${input.costUsd}`,
    })
    .where(eq(t.routineVersions.id, versionId))
}

/** 开试跑：版本改成 testing 和开运行在同一个事务里（开不了就是没成功，原因写清） */
async function startTest(db: Db, loaded: Loaded, round: number, material: CompileMaterial) {
  try {
    await db.transaction(async (tx) => {
      const moved = await tx
        .update(t.routineVersions)
        .set({ status: "testing", failReason: null })
        .where(and(eq(t.routineVersions.id, loaded.version.id), eq(t.routineVersions.status, "drafting")))
        .returning({ id: t.routineVersions.id })
      if (!moved.length) return
      await startTestRun(db, tx, {
        taskId: loaded.taskId,
        versionId: loaded.version.id,
        round,
        scriptInput: material.input,
        attachments: material.attachments,
      })
    })
  } catch (error) {
    return fail(db, loaded, `开不了试跑：${clip((error as Error).message, 500)}`)
  }
}

/** 试跑的运行结束了（引擎发的）：过了交给人审核；没过不到 3 轮就回去再写，到了就没成功 */
async function afterTest(db: Db, loaded: Loaded) {
  const { version } = loaded
  let expectedReport: Record<string, unknown> | undefined
  if (version.sourceSessionId) {
    const events = await db
      .select({ kind: t.sessionEvents.kind, toolId: t.sessionEvents.toolId, title: t.sessionEvents.title, input: t.sessionEvents.input })
      .from(t.sessionEvents)
      .where(and(eq(t.sessionEvents.sessionId, version.sourceSessionId), eq(t.sessionEvents.toolId, "work.report")))
      .orderBy(t.sessionEvents.seq)
    expectedReport = reportedData(events)
  }
  const verdict = await evaluateTestRun(db, { versionId: version.id, round: version.round, ...(expectedReport ? { expectedReport } : {}) })
  if (verdict.state === "pending") return
  if (verdict.state === "missing") return fail(db, loaded, `找不到第 ${version.round} 轮试跑的运行`)
  const round = verdict.round
  const report: RoutineTestReport = { rounds: [...reportOf(version).rounds.filter((each) => each.round !== round.round), round].sort((a, b) => a.round - b.round) }
  await db.update(t.routineVersions).set({ testReport: report }).where(eq(t.routineVersions.id, version.id))

  if (round.passed) return toReview(db, loaded, { name: version.name, description: version.description, assumptions: version.assumptions, round })
  if (version.round >= ROUTINE_MAX_ROUNDS) return fail(db, loaded, `试跑没过，${ROUTINE_MAX_ROUNDS} 轮都用完了。最后一轮：${round.error ?? "原因不明"}`)
  await db.transaction(async (tx) => {
    const moved = await tx
      .update(t.routineVersions)
      .set({ status: "drafting" })
      .where(and(eq(t.routineVersions.id, version.id), eq(t.routineVersions.status, "testing")))
      .returning({ id: t.routineVersions.id })
    if (moved.length) await sendRoutineCompile(db, tx, { versionId: version.id })
  })
}

/** 试跑结果一句话（审核卡的通用内容、通知） */
function testLine(round: RoutineTestRound | undefined, skipTest: boolean) {
  if (skipTest) return "没有试跑（点固化时选了不试跑）"
  if (!round) return "试跑过了"
  const stop = round.stoppedAt
  const where = stop?.kind === "test_commit" ? `走到第 ${stop.step} 次调用、提交「${stop.label ?? ""}」前停下` : stop?.kind === "test_blocked" ? `走到对外发送的 ${stop.tool ?? "工具"} 前停下` : "脚本报了办成"
  const diff = round.compare?.filter((each) => !each.same) ?? []
  return `第 ${round.round} 轮试跑通过：做了 ${round.steps} 次调用，${where}${diff.length ? `；要交回的结果有 ${diff.length} 项和原来那次不一样（${diff.map((each) => each.field).join("、")}）` : ""}`
}

/** 交给人审核：待审核 + 给任务负责人一件「审核固化流程」 + 通知 */
async function toReview(db: Db, loaded: Loaded, info: { name: string; description: string; assumptions: string[]; round?: RoutineTestRound }) {
  const { version } = loaded
  const test = testLine(info.round, version.skipTest)
  const item = await db.transaction(async (tx) => {
    const moved = await tx
      .update(t.routineVersions)
      .set({ status: "review", failReason: null })
      .where(and(eq(t.routineVersions.id, version.id), inArray(t.routineVersions.status, ["drafting", "testing"])))
      .returning({ id: t.routineVersions.id })
    if (!moved.length) return undefined
    return createHumanItem(tx, {
      kind: "routine",
      title: `审核固化流程：${info.name}（第 ${version.version} 版）`,
      summary: `「${loaded.taskTitle}」的固化流程${version.baseVersion !== null ? `（修第 ${version.baseVersion} 版）` : ""}写好了。${test}。看一下步骤和脚本，决定要不要启用。`,
      assigneeId: loaded.ownerId,
      taskId: loaded.taskId,
      sessionId: version.sourceSessionId,
      routineVersionId: version.id,
      urgency: 4,
      detail: {
        sections: [
          { title: "步骤", text: info.description || "（没写）" },
          { title: "试跑", text: test },
          ...(info.assumptions.length ? [{ title: "假设", text: info.assumptions.map((each) => `- ${each}`).join("\n") }] : []),
        ],
        primary: "启用",
        secondary: "不用",
        rejectHint: "写一下为什么不用，下次固化时固化员会看到",
        routine: { routineId: version.routineId, versionId: version.id, version: version.version },
      },
    })
  })
  if (item) await notifyAssignee(db, item)
}

/** 没成功：原因写清，通知任务负责人 */
async function fail(db: Db, loaded: Loaded, reason: string) {
  const moved = await db
    .update(t.routineVersions)
    .set({ status: "failed", failReason: clip(reason, 2000) })
    .where(and(eq(t.routineVersions.id, loaded.version.id), inArray(t.routineVersions.status, ["drafting", "testing"])))
    .returning({ id: t.routineVersions.id })
  if (!moved.length) return
  await notifyUsers(db, {
    userIds: [loaded.ownerId],
    title: `固化没成功：${loaded.taskTitle}（第 ${loaded.version.version} 版）`,
    body: reason,
    link: taskLink(loaded.taskId),
    taskId: loaded.taskId,
    sessionId: loaded.version.sourceSessionId,
  })
}
