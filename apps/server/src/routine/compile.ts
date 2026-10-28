// 固化（docs/dev/solidify.md 第 5 节、15.3）：把一次办成的运行写成脚本、试跑、交给人审核。
// 一版脚本是一个小状态机（routine_versions.status）：drafting 写脚本 → testing 试跑 →（没过再写、再试跑）→ review 待审核 / failed 没成功。
// - 队列任务 routine.compile 每次往下走一步，不等试跑：试跑可能要等 Chrome、等人登录，试跑的运行结束时引擎再发一次；
// - 写一次算一轮（模型出错、程序检查没过、试跑没过都要再写），最多 ROUTINE_MAX_ROUNDS 轮；
// - 程序检查没过就在同一个任务里接着写下一轮（不用等什么），试跑没过回 drafting、再发一次 routine.compile。
import { and, eq, inArray, max, sql } from "drizzle-orm"
import {
  HTTP_TOOL_SUGGESTIONS_MAX,
  httpToolSuggestionSchema,
  isRunEnded,
  moveSecrets,
  ROUTINE_MAX_ROUNDS,
  routineId as routineIdOf,
  routineTestReportSchema,
  routineVersionId as routineVersionIdOf,
  scanHttpTemplate,
  secretNameSchema,
  SITE_SECRET_MASK,
  snakeName,
  syncHttpParams,
  type HttpToolSuggestion,
  type RoutineTestReport,
  type RoutineTestRound,
} from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { assertCan, audit, badRequest, conflict, nextNo, notFound, type Tx, type WriteCtx } from "../data/config/common.js"
import { createHumanItem, notifyAssignee } from "../engine/humans.js"
import { callStructured, resolveModel, type ResolvedModel } from "../engine/model.js"
import { notifyUsers } from "../engine/notify.js"
import { sendRoutineCompile, type RoutineCompileJob } from "./jobs.js"
import { buildMaterial, reportedData, type CompileMaterial } from "./material.js"
import { compileOutputSchema, compileSystemPrompt, type CompileOutput, type HttpSuggestionOutput } from "./prompt.js"
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
 * 查完权限交给 compileFromSession；不试跑没传就按任务的「固化时不试跑」（17.1）
 */
export async function startCompile(ctx: WriteCtx, input: { sessionId: string; skipTest?: boolean }): Promise<{ routineId: string; versionId: string }> {
  const [row] = await ctx.db
    .select({ ownerId: t.tasks.ownerId })
    .from(t.sessions)
    .innerJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))
    .where(eq(t.sessions.id, input.sessionId))
  if (!row) throw notFound("运行", input.sessionId)
  assertCan(ctx.actor, "task.manage", { ownerId: row.ownerId }, "只有任务负责人和主管能把运行固化成流程")
  const result = await compileFromSession(ctx.db, { sessionId: input.sessionId, skipTest: input.skipTest, createdById: ctx.actor.id, auto: false })
  // 手动的不传 decide，不会跳过
  if (!result.started) throw new Error(result.reason)
  return { routineId: result.routineId, versionId: result.versionId }
}

type RoutineRow = typeof t.routines.$inferSelect
type SessionRowForCompile = typeof t.sessions.$inferSelect

/**
 * 自动固化的判断（routine/auto.ts）：在锁住固化流程之后调，同一个任务的几次运行同时结束也只有一个能建版本。
 * 返回 baseVersion（null = 固化第一版）就建；返回 skip 就整个事务回滚（刚建的空流程也不留），什么都不做
 */
export type CompileDecide = (
  tx: Tx,
  input: { routine: RoutineRow; created: boolean; session: SessionRowForCompile }
) => Promise<{ baseVersion: number | null } | { skip: string }>

export interface CompileFromSessionInput {
  sessionId: string
  /** 不试跑；没传按任务的「固化时不试跑」 */
  skipTest?: boolean | undefined
  /** 谁点的；自动固化是 null */
  createdById: string | null
  /** 运行办成后系统自动固化的（routine_versions.auto） */
  auto: boolean
  /** 自动固化的条件；手动的不传：有一版在走就报错，别的不限 */
  decide?: CompileDecide
}

export type CompileFromSessionResult =
  | { started: true; routineId: string; versionId: string; version: number; baseVersion: number | null }
  | { started: false; reason: string }

class SkipCompile extends Error {}

/**
 * 不查权限的固化入口（手动的 startCompile、自动的 maybeAutoSolidify 都走这里）：
 * 运行要是已结束、办成的普通运行；任务还没有固化流程就建一个（RT-<n>），再建一版（status = drafting），发 routine.compile。
 * 锁住固化流程那一行再查「有没有一版在走」，并发的两次只有一次建得成
 */
export async function compileFromSession(db: Db, input: CompileFromSessionInput): Promise<CompileFromSessionResult> {
  const [row] = await db
    .select({ session: t.sessions, skipTestDefault: t.tasks.routineSkipTest, title: t.tasks.title })
    .from(t.sessions)
    .innerJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))
    .where(eq(t.sessions.id, input.sessionId))
  if (!row) throw notFound("运行", input.sessionId)
  const { session } = row
  if (session.kind !== "run") throw badRequest("固化试跑的运行不能再固化")
  if (!isRunEnded(session.status)) throw badRequest("运行还没结束，结束后才能固化")
  if (session.outcome !== "achieved") throw badRequest("只有办成的运行能固化成流程")
  if (!session.snapshot) throw badRequest("这次运行没有快照（太老的运行），不能固化")
  const skipTest = input.skipTest ?? row.skipTestDefault

  try {
    return await db.transaction(async (tx) => {
      const lockRoutine = () => tx.select().from(t.routines).where(eq(t.routines.taskId, session.taskId)).for("update")
      let [routine] = await lockRoutine()
      // 这次新建的流程（没有任何版本）；并发时别人先建好的不算
      let created = false
      if (!routine) {
        // 并发点了两次：唯一索引挡住第二个，再读一次就是第一个建的
        const inserted = await tx
          .insert(t.routines)
          .values({ id: routineIdOf(await nextNo(tx, "routine_no_seq")), taskId: session.taskId, status: "trial" })
          .onConflictDoNothing({ target: t.routines.taskId })
          .returning({ id: t.routines.id })
        created = inserted.length > 0
        ;[routine] = await lockRoutine()
      }
      if (!routine) throw new Error("建固化流程失败")
      const [busy] = await tx
        .select({ version: t.routineVersions.version, status: t.routineVersions.status })
        .from(t.routineVersions)
        .where(and(eq(t.routineVersions.routineId, routine.id), inArray(t.routineVersions.status, [...IN_PROGRESS])))
        .limit(1)
      if (busy) {
        const message =
          busy.status === "review"
            ? `第 ${busy.version} 版在等审核，先审核了它再固化`
            : `第 ${busy.version} 版还在${busy.status === "drafting" ? "写脚本" : "试跑"}，等它写完、试跑完再固化`
        if (input.decide) throw new SkipCompile(message)
        throw conflict(message)
      }
      let baseVersion: number | null
      if (input.decide) {
        const decided = await input.decide(tx, { routine, created, session })
        if ("skip" in decided) throw new SkipCompile(decided.skip)
        baseVersion = decided.baseVersion
      } else {
        // 源运行先跑过这个流程的脚本（停下后 agent 接着办成）：这一版是修那一版
        const ran = session.routine
        baseVersion = ran && ran.mode === "run" && ran.routineId === routine.id ? ran.version : null
      }
      const [last] = await tx.select({ n: max(t.routineVersions.version) }).from(t.routineVersions).where(eq(t.routineVersions.routineId, routine.id))
      const version = (last?.n ?? 0) + 1
      const versionId = routineVersionIdOf(routine.id, version)
      await tx.insert(t.routineVersions).values({
        id: versionId,
        routineId: routine.id,
        version,
        status: "drafting",
        name: row.title,
        sourceSessionId: session.id,
        baseVersion,
        skipTest,
        auto: input.auto,
        createdById: input.createdById,
      })
      await audit(tx, input.createdById, "routine.compile", "routine_versions", versionId, {
        sessionId: session.id,
        ...(baseVersion !== null ? { baseVersion } : {}),
        ...(skipTest ? { skipTest: true } : {}),
        ...(input.auto ? { auto: true } : {}),
      })
      await sendRoutineCompile(db, tx, { versionId })
      return { started: true as const, routineId: routine.id, versionId, version, baseVersion }
    })
  } catch (error) {
    if (error instanceof SkipCompile) return { started: false, reason: error.message }
    throw error
  }
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

/**
 * 固化员偶尔把整个回答又塞进 code（code 里是 {"suitable":…,"code":"import ha …"}，基准 B 第 3 轮）：
 * 认出来就用里面那一层的脚本，别的字段用外面这一层的（外面的已经按格式校验过）
 */
export function unwrapNestedCode(output: CompileOutput): CompileOutput {
  const text = output.code.trim()
  if (!text.startsWith("{")) return output
  const inner = innerCodeOf(text)
  return inner !== undefined && /export\s+default/.test(inner) ? { ...output, code: inner } : output
}

/** 里面那一层的 "code" 字段：整段能解析就直接取；解析不了（模型套错了引号，后面还跟着别的字段）就把 "code": 后面那个字符串单独拿出来 */
function innerCodeOf(text: string): string | undefined {
  try {
    const inner = JSON.parse(text) as { code?: unknown }
    if (typeof inner.code === "string") return inner.code
  } catch {
    // 往下：只取 code 那个字符串
  }
  const key = /"code"\s*:\s*"/.exec(text)
  if (!key) return undefined
  const start = key.index + key[0].length - 1
  let end = start + 1
  for (; end < text.length; end++) {
    if (text[end] === "\\") end++
    else if (text[end] === '"') break
  }
  try {
    const value = JSON.parse(text.slice(start, end + 1)) as unknown
    return typeof value === "string" ? value : undefined
  } catch {
    return undefined
  }
}

// ---------- HTTP 工具建议（docs/dev/solidify.md 19.7） ----------

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

/**
 * 固化员给的 HTTP 工具建议规整成存进库的样子（routine_versions.http_suggestions）。不对的去掉，不算程序检查没过：
 * - 材料里没有记下的接口（knownSeqs 空）：一条都不要；依据的 seq 只留记录里有的，一个都不剩的去掉；
 * - 网址要是完整的 http(s)；请求头数组变成对象，空的 body 去掉；
 * - 密钥名照工具页的规矩（大写字母、数字、下划线）：能改成合规的（api_token → API_TOKEN）就改，改不了的（中文）去掉；
 * - 模板里有 ••••（把打了码的值抄进来了）、有明文密钥（Bearer 后面是一串值）的去掉；
 * - 参数按模板对齐（syncHttpParams），都是 string；secrets 以模板为准；同一个方法 + 网址只留一条；最多 HTTP_TOOL_SUGGESTIONS_MAX 条
 */
export function normalizeHttpSuggestions(raw: readonly HttpSuggestionOutput[], knownSeqs: readonly number[] | undefined): HttpToolSuggestion[] {
  if (!knownSeqs?.length) return []
  const known = new Set(knownSeqs)
  const out: HttpToolSuggestion[] = []
  const seen = new Set<string>()
  for (const each of raw) {
    if (out.length >= HTTP_TOOL_SUGGESTIONS_MAX) break
    const name = clip(each.name.trim(), 100)
    let url = each.url.trim()
    if (!name || !/^https?:\/\/\S+$/i.test(url)) continue
    let headers: Record<string, string> = {}
    for (const header of each.headers) {
      const key = header.name.trim()
      if (key && !(key in headers)) headers[key] = header.value.trim()
    }
    let body = each.body.trim() ? each.body : undefined
    const requestSeqs = [...new Set(each.requestSeqs.filter((seq) => known.has(seq)))].sort((a, b) => a - b)
    if (!requestSeqs.length) continue

    // 密钥名：不合规的能改就改，改不了整条不要
    let bad = false
    for (const secret of new Set(scanHttpTemplate({ url, headers, body }).filter((found) => found.kind === "secret").map((found) => found.name))) {
      if (secretNameSchema.safeParse(secret).success) continue
      const renamed = snakeName(secret)
      if (!secretNameSchema.safeParse(renamed).success) {
        bad = true
        break
      }
      const pattern = new RegExp(`\\{\\{\\s*${escapeRegExp(secret)}\\s*\\}\\}`, "g")
      const swap = (text: string) => text.replace(pattern, `{{${renamed}}}`)
      url = swap(url)
      headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [swap(key), swap(value)]))
      body = body === undefined ? undefined : swap(body)
    }
    if (bad) continue
    const headerText = Object.entries(headers)
      .map(([key, value]) => `${key}: ${value}`)
      .join("\n")
    if ([url, headerText, body ?? ""].some((text) => text.includes(SITE_SECRET_MASK))) continue
    if (moveSecrets({ url, headers: headerText, body: body ?? "" }).moved.length) continue
    const key = `${each.method} ${url}`
    if (seen.has(key)) continue

    const spec = { url, ...(Object.keys(headers).length ? { headers } : {}), ...(body !== undefined ? { body } : {}) }
    const declared = each.params
      .map((param) => ({ name: param.name.trim(), type: "string" as const, required: param.required, description: param.description.trim() }))
      .filter((param) => param.name)
    const params = syncHttpParams(spec, declared).params.map((param) => ({
      name: param.name,
      type: "string" as const,
      required: param.required ?? true,
      ...(param.description ? { description: clip(param.description, 500) } : {}),
    }))
    const secrets = [...new Set(scanHttpTemplate(spec).filter((found) => found.kind === "secret").map((found) => found.name))]
    const parsed = httpToolSuggestionSchema.safeParse({
      name,
      summary: clip(each.summary.trim(), 500),
      reason: clip(each.reason.trim(), 1000),
      http: { method: each.method, ...spec, params },
      secrets,
      requestSeqs,
    })
    if (!parsed.success) continue
    seen.add(key)
    out.push(parsed.data)
  }
  return out
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
  // 材料里有「网页调过的接口」才加第 19–24 条规矩和例 6（19.6）；选了 / 调过库流程才加「用 ha.routine 调」那一条
  const system = compileSystemPrompt(undefined, { siteApi: Boolean(material.networkSeqs?.length), library: material.library })
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
      output = unwrapNestedCode(result.object)
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
      // 不对的建议去掉就是，不算没过（19.7）
      httpSuggestions: normalizeHttpSuggestions(output.httpToolSuggestions, material.networkSeqs),
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
      allowFetch: material.allowFetch,
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
function testLine(round: RoutineTestRound | undefined, version: { skipTest: boolean; auto: boolean }) {
  if (version.skipTest) return version.auto ? "没有试跑（任务设了固化时不试跑）" : "没有试跑（点固化时选了不试跑）"
  if (!round) return "试跑过了"
  const stop = round.stoppedAt
  const where = stop?.kind === "test_commit" ? `走到第 ${stop.step} 次调用、提交「${stop.label ?? ""}」前停下` : stop?.kind === "test_blocked" ? `走到对外发送的 ${stop.tool ?? "工具"} 前停下` : "脚本报了办成"
  const diff = round.compare?.filter((each) => !each.same) ?? []
  return `第 ${round.round} 轮试跑通过：做了 ${round.steps} 次调用，${where}${diff.length ? `；要交回的结果有 ${diff.length} 项和原来那次不一样（${diff.map((each) => each.field).join("、")}）` : ""}`
}

/** 交给人审核：待审核 + 给任务负责人一件「审核固化流程」 + 通知 */
async function toReview(db: Db, loaded: Loaded, info: { name: string; description: string; assumptions: string[]; round?: RoutineTestRound }) {
  const { version } = loaded
  const test = testLine(info.round, version)
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
      summary: `「${loaded.taskTitle}」的固化流程${originOf(version)}写好了。${test}。看一下步骤和脚本，决定要不要启用。`,
      assigneeId: loaded.ownerId,
      taskId: loaded.taskId,
      sessionId: version.sourceSessionId,
      routineVersionId: version.id,
      urgency: 4,
      detail: {
        sections: [
          ...(version.auto ? [{ title: "自动固化", text: autoSourceText(version) }] : []),
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

/** 自动固化的版本在审核卡、通知里都写明（17.1） */
const AUTO_LABEL = "运行办成后自动固化的"

const autoSourceText = (version: VersionRow) =>
  version.baseVersion !== null ? `第 ${version.baseVersion} 版跑不通、agent 接手办成以后自动修的` : "任务开着「办成后自动固化」，这次运行办成以后系统自动固化的"

/** 标题后面的括号：自动固化、修第几版 */
function originOf(version: VersionRow) {
  const parts = [...(version.auto ? [AUTO_LABEL] : []), ...(version.baseVersion !== null ? [`修第 ${version.baseVersion} 版`] : [])]
  return parts.length ? `（${parts.join("，")}）` : ""
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
    body: loaded.version.auto ? `这一版是${AUTO_LABEL}${loaded.version.baseVersion !== null ? `（修第 ${loaded.version.baseVersion} 版）` : ""}。${reason}` : reason,
    link: taskLink(loaded.taskId),
    taskId: loaded.taskId,
    sessionId: loaded.version.sourceSessionId,
  })
}
