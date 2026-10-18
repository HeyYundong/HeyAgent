// 读包（worker 进程，pg-boss 队列 import.read）：解压 → 挪走明文密钥 → 读包 agent（模型 + 只读工具）→ 代码整理、翻译新规则 → 写方案。
// - 每做完一步往 read_log 写一行（正在做的那行 running），imports 表有触发器，页面实时刷新；
// - 每一步之间查一下状态：被「停止读包」改成 failed 了就立刻退出，不再调模型；所有写入都带「status = reading」条件，不会盖掉人的操作；
// - 进程挂了 pg-boss 重试时从头读（清空 read_log、这次导入挪出的密钥、解压目录）；
// - 密钥：模型看到任何内容之前，先把包里全部文字文件扫一遍、找出明文密钥（值加密存进 secrets，scope = import）；
//   之后给模型的每一段文字都按同样的规则换成 {{名字}}，再把已知的值全文替换一遍。模型、日志、read_log、错误信息里都只有名字。
import { readFile, writeFile } from "node:fs/promises"
import { setTimeout as sleep } from "node:timers/promises"

import { tool, zodSchema, type ModelMessage, type ToolResultPart } from "ai"
import { and, eq } from "drizzle-orm"
import { importPlanSchema, planProblems, type ImportPlan, type ImportReadStep, type PlanRule } from "@heyagent/shared"
import { z } from "zod"

import { putSecret } from "../data/config/common.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { callModel, isRetryable, ModelConfigError, resolveModel, type ModelCallResult, type ResolvedModel } from "../engine/model.js"
import { notifyUsers } from "../engine/notify.js"
import { compileRuleText } from "../engine/rule-compile.js"
import { getKeyring, runtime } from "../engine/runtime.js"
import { getFileRow, readFileData } from "../files/service.js"
import { catalogText, loadCatalog } from "./catalog.js"
import { importFilesDir, importLimits, importManifest, sizeText } from "./limits.js"
import { organizePlan, planSecrets } from "./organize.js"
import { classify, ImportPackage, type PackageFile } from "./package.js"
import { planModelSchema, READER_SYSTEM, toPlan } from "./prompt.js"
import { isCodeFile, redactText, SecretCollector, type FoundSecret } from "./redact.js"
import { fillSkillBodies } from "./skills.js"
import { extractZip, ImportReadError } from "./zip.js"

/** 被人停止、重新读包、放弃了：静默退出，不再写任何东西 */
class Stopped extends Error {}
/** worker 要退出：不改状态，让 pg-boss 重试（从头读） */
class Interrupted extends Error {}

export type ReadOutcome = "review" | "failed" | "stopped" | "skipped" | "interrupted"

export const importLink = (id: string) => `#/imports?id=${encodeURIComponent(id)}`

/** 解压出来的文件清单（导入时按它找附件）；没有（还没读过、被清掉了）返回空数组 */
export async function readManifest(importId: string): Promise<PackageFile[]> {
  try {
    return JSON.parse(await readFile(importManifest(importId), "utf8")) as PackageFile[]
  } catch {
    return []
  }
}

interface RunState {
  db: Db
  id: string
  log: ImportReadStep[]
  baseCost: number
  spent: number
  started: number
  signal?: AbortSignal
}

/** 写 read_log 和花费（以及别的字段）；这次导入已经不是「读包中」了就说明被停止了 */
async function write(state: RunState, patch: Partial<typeof t.imports.$inferInsert> = {}) {
  const rows = await state.db
    .update(t.imports)
    .set({ readLog: state.log.map((line) => ({ ...line })), costUsd: state.baseCost + state.spent, ...patch })
    .where(and(eq(t.imports.id, state.id), eq(t.imports.status, "reading")))
    .returning({ id: t.imports.id })
  if (rows.length === 0) throw new Stopped()
}

async function alive(state: RunState) {
  if (state.signal?.aborted) throw new Interrupted()
  const [row] = await state.db.select({ status: t.imports.status }).from(t.imports).where(eq(t.imports.id, state.id))
  if (row?.status !== "reading") throw new Stopped()
  if (Date.now() - state.started > importLimits.maxRunMs)
    throw new ImportReadError(`读包超过 ${Math.round(importLimits.maxRunMs / 60_000)} 分钟还没读完，停了。把包里用不上的文件删掉，或者换个快一点的模型再试`)
}

/** 开始一行（running），返回收尾函数（done，记用时；可以改标题） */
async function begin(state: RunState, title: string) {
  const line: ImportReadStep = { title, status: "running" }
  const at = Date.now()
  state.log.push(line)
  await write(state)
  return async (finalTitle?: string) => {
    line.status = "done"
    line.ms = Date.now() - at
    if (finalTitle) line.title = finalTitle
    await write(state)
  }
}

function checkCost(state: RunState) {
  if (state.spent > importLimits.maxCostUsd)
    throw new ImportReadError(`读包花了 ${state.spent.toFixed(2)} 美元，超过了上限 ${importLimits.maxCostUsd} 美元，停了。可以换个便宜点的模型，或者把包里用不上的文件删掉再试`)
}

/** 调模型，出错按退避重试（同 engine/loop.ts 的做法）；重试完还不行就抛出 */
async function callWithRetry(resolved: ResolvedModel, input: Parameters<typeof callModel>[1]): Promise<ModelCallResult> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await callModel(resolved, input)
    } catch (error) {
      if (input.abortSignal?.aborted) throw new Interrupted()
      if (!isRetryable(error) || attempt >= runtime.modelRetries) {
        const message = (error as Error).message.slice(0, 300)
        throw new ImportReadError(isRetryable(error) ? `模型调用失败（已重试 ${runtime.modelRetries} 次）：${message}` : `模型调用失败：${message}`)
      }
      await sleep(runtime.modelRetryBaseMs * 2 ** attempt)
    }
  }
}

const LIST_FILES_INPUT = z.object({
  dir: z.string().describe("从哪个目录列（包内路径）；根目录写空字符串"),
  depth: z.number().int().describe("列几层，1～6，一般写 2"),
})
const LIST_SKILLS_INPUT = z.object({ dir: z.string().describe("只看这个目录下的；全部写空字符串") })
const READ_FILE_INPUT = z.object({
  path: z.string().describe("包内路径，照文件清单写"),
  from_line: z.number().int().describe("从第几行开始（从 1 开始）"),
  max_lines: z.number().int().describe("最多读几行，建议 400 以内"),
})

const TOOLS = {
  list_files: tool({
    description: "分层看包里的文件：目录给文件数和大小，文件多的目录折叠成一行，依赖和缓存目录标「跳过」。默认根目录下两层，要看某个目录就带 dir",
    inputSchema: zodSchema(LIST_FILES_INPUT),
  }),
  list_skills: tool({
    description: "列出包里（或某个目录下）的 SKILL.md：路径、名字、说明（来自开头的元数据）、正文字数、旁边有几个参考文件和脚本。技能多时用它决定导哪些，不用一个个读；太多时先按目录给个数",
    inputSchema: zodSchema(LIST_SKILLS_INPUT),
  }),
  read_file: tool({
    description: "读一个文字文件（明文密钥已经换成 {{名字}}），带行号。长文件分段读：看结尾的提示从第几行接着读",
    inputSchema: zodSchema(READ_FILE_INPUT),
  }),
  submit_plan: tool({
    description: "交导入方案（一次交完整）。方案有问题会告诉你哪里不对，改好后再交一次",
    inputSchema: zodSchema(planModelSchema),
  }),
}

const toolResult = (toolCallId: string, toolName: string, output: string, isError = false): ToolResultPart => ({
  type: "tool-result",
  toolCallId,
  toolName,
  output: isError ? { type: "error-text", value: output } : { type: "text", value: output },
})

const cleanPath = (path: string) => path.trim().replace(/^\.?\/+/, "")

type Submitted = ReturnType<typeof toPlan>

/** 读包 agent：一步一步调模型，工具由我们执行（都是只读的）。交上合格的方案就返回 */
async function readWithAgent(state: RunState, ctx: { pkg: ImportPackage; resolved: ResolvedModel; intro: string }): Promise<Submitted> {
  const { pkg } = ctx
  const messages: ModelMessage[] = [{ role: "user", content: ctx.intro }]
  const readPaths = new Set<string>()
  let readChars = 0
  let fixes = 0
  const pending: { line: ImportReadStep; at: number }[] = []
  const budgetLeft = () => importLimits.readTotalChars - readChars
  const overBudget = () => `已经读了约 ${Math.round(readChars / 10_000)} 万字，到上限了。用已经读到的内容整理，调用 submit_plan 交方案`

  const readFileTool = async (input: z.infer<typeof READ_FILE_INPUT>): Promise<{ text: string; error?: boolean }> => {
    const file = pkg.byPath.get(cleanPath(input.path))
    if (!file) return { text: `包里没有文件「${input.path}」，照文件清单的路径写（目录要用 list_files 看）`, error: true }
    if (!file.text) {
      const why = file.skipped ? `没有解开（${file.skipped}）` : file.tooLarge ? `太大了（${sizeText(file.size)}），不给读` : "是二进制文件，读不了内容"
      return { text: `「${file.path}」${why}。要用的话做成任务附件，或者列进 unused`, error: true }
    }
    if (budgetLeft() <= 0) return { text: overBudget(), error: true }
    const lines = ((await pkg.text(file.path)) ?? "").split("\n")
    const from = Math.max(1, Math.min(input.from_line || 1, lines.length))
    const maxLines = Math.max(1, Math.min(input.max_lines || 400, 2000))
    const budget = Math.min(importLimits.readChunkChars, budgetLeft())
    const width = String(lines.length).length
    const out: string[] = []
    let size = 0
    let last = from - 1
    for (let n = from; n <= lines.length && n < from + maxLines; n++) {
      const text = `${String(n).padStart(width)}| ${lines[n - 1]}`
      if (size + text.length > budget && out.length > 0) break
      out.push(text.length > budget ? `${text.slice(0, budget)}…（这一行太长，截断了）` : text)
      size += text.length + 1
      last = n
    }
    readChars += size
    if (!readPaths.has(file.path)) {
      readPaths.add(file.path)
      const line: ImportReadStep = { title: `读 ${file.path}`.slice(0, 300), status: "running" }
      state.log.push(line)
      pending.push({ line, at: Date.now() })
    }
    const more = last < lines.length ? `\n（后面还有 ${lines.length - last} 行，从第 ${last + 1} 行接着读）` : "\n（读完了）"
    return { text: `文件 ${file.path}（共 ${lines.length} 行）第 ${from}–${last} 行：\n${out.join("\n")}${more}` }
  }

  /** 交上来的方案：形状、key 引用、技能的 path 都要对得上 */
  const checkSubmit = (input: unknown, invalid?: boolean, error?: string): { problems: string[]; converted?: Submitted } => {
    const parsed = planModelSchema.safeParse(input)
    if (invalid || !parsed.success) return { problems: parsed.success ? [error ?? "格式不对"] : parsed.error.issues.slice(0, 8).map((issue) => `${issue.path.join(".")}：${issue.message}`) }
    const converted = toPlan(parsed.data)
    const problems = planProblems(converted.plan)
    for (const [key, path] of converted.skillPaths) {
      if (!pkg.byPath.get(path)?.text) problems.push(`技能 ${key} 的 path「${path}」在包里找不到，或者不是文字文件`)
    }
    for (const skill of parsed.data.skills) {
      if (!skill.path.trim() && !skill.body.trim()) problems.push(`技能 ${skill.key} 既没写 path 也没写正文`)
    }
    return { problems, converted }
  }

  for (let stepNo = 0; stepNo < importLimits.maxSteps; stepNo++) {
    await alive(state)
    // 模型思考时总有一行 running：刚读的文件（AI 在看它），或者「AI 看文件清单 / 想下一步」
    let transient: ImportReadStep | undefined
    if (pending.length === 0) {
      transient = { title: stepNo === 0 ? "AI 看文件清单" : "AI 想下一步读什么", status: "running" }
      state.log.push(transient)
    }
    await write(state)
    const started = Date.now()
    const result = await callWithRetry(ctx.resolved, { system: READER_SYSTEM, messages, tools: TOOLS, abortSignal: state.signal })
    state.spent += result.costUsd
    for (const each of pending.splice(0)) {
      each.line.status = "done"
      each.line.ms = Date.now() - each.at
    }
    if (transient) {
      if (stepNo === 0) {
        transient.status = "done"
        transient.ms = Date.now() - started
      } else state.log.splice(state.log.indexOf(transient), 1)
    }
    await write(state)
    checkCost(state)
    if (result.assistant) messages.push(result.assistant)
    if (result.toolCalls.length === 0) {
      messages.push({ role: "user", content: "请只调用工具：需要的文件读够了就调用 submit_plan 交完整的方案。" })
      continue
    }
    const outputs: ToolResultPart[] = []
    let accepted: Submitted | undefined
    for (const call of result.toolCalls) {
      if (call.toolName === "list_files") {
        const parsed = LIST_FILES_INPUT.partial().safeParse(call.input)
        const text = pkg.listFiles(cleanPath(parsed.data?.dir ?? ""), parsed.data?.depth ?? 2)
        outputs.push(toolResult(call.toolCallId, call.toolName, text, text.startsWith("包里没有目录")))
      } else if (call.toolName === "list_skills") {
        if (budgetLeft() <= 0) {
          outputs.push(toolResult(call.toolCallId, call.toolName, overBudget(), true))
          continue
        }
        const text = await pkg.skillsText(cleanPath(LIST_SKILLS_INPUT.partial().safeParse(call.input).data?.dir ?? ""))
        readChars += text.length
        outputs.push(toolResult(call.toolCallId, call.toolName, text))
      } else if (call.toolName === "read_file") {
        const parsed = READ_FILE_INPUT.partial({ from_line: true, max_lines: true }).safeParse(call.input)
        if (call.invalid || !parsed.success) {
          outputs.push(toolResult(call.toolCallId, call.toolName, `参数不对：${call.error ?? "要 path、from_line、max_lines"}`, true))
          continue
        }
        const out = await readFileTool({ path: parsed.data.path, from_line: parsed.data.from_line ?? 1, max_lines: parsed.data.max_lines ?? 400 })
        outputs.push(toolResult(call.toolCallId, call.toolName, out.text, out.error))
      } else if (call.toolName === "submit_plan") {
        if (accepted) {
          outputs.push(toolResult(call.toolCallId, call.toolName, "已经收到方案了"))
          continue
        }
        const { problems, converted } = checkSubmit(call.input, call.invalid, call.error)
        if (problems.length === 0 && converted) {
          accepted = converted
          outputs.push(toolResult(call.toolCallId, call.toolName, "收到，方案交上来了"))
          continue
        }
        fixes += 1
        if (fixes > importLimits.planFixes) throw new ImportReadError(`AI 交的方案有问题，改了 ${importLimits.planFixes} 次还不对：${problems.slice(0, 3).join("；")}`)
        outputs.push(toolResult(call.toolCallId, call.toolName, `方案有问题，改好后重新调用 submit_plan 交一次完整的：\n${problems.slice(0, 10).map((problem) => `- ${problem}`).join("\n")}`, true))
      } else {
        outputs.push(toolResult(call.toolCallId, call.toolName, `没有叫 ${call.toolName} 的工具，只有 list_files、list_skills、read_file、submit_plan`, true))
      }
    }
    messages.push({ role: "tool", content: outputs })
    if (accepted) {
      // 刚读的文件交了方案就算读完了
      for (const each of pending.splice(0)) {
        each.line.status = "done"
        each.line.ms = Date.now() - each.at
      }
      return accepted
    }
  }
  throw new ImportReadError(`AI 调了 ${importLimits.maxSteps} 次模型还没交方案，停了。把包里用不上的文件删掉、补一句说明再试`)
}

/** 新规则用「规划」模型翻译（最多同时几条），每条 read_log 一行；翻译不进去的改成 unsupported */
async function compileRules(state: RunState, plan: ImportPlan) {
  const toolIdOf = new Map(plan.tools.filter((tool) => tool.refId).map((tool) => [tool.key, tool.refId!]))
  const queue = plan.rules.filter((rule) => rule.kind === "new" && rule.include && !rule.needsNewTools)
  const work = async (rule: PlanRule) => {
    await alive(state)
    const line: ImportReadStep = { title: `翻译规则「${rule.name}」`.slice(0, 300), status: "running" }
    const at = Date.now()
    state.log.push(line)
    await write(state)
    try {
      const { result, costUsd } = await compileRuleText(state.db, { trigger: rule.trigger, action: rule.action, toolIds: rule.toolKeys.flatMap((key) => toolIdOf.get(key) ?? []) })
      state.spent += costUsd
      rule.compile = result
      if (!result.supported) {
        rule.kind = "unsupported"
        rule.include = false
        rule.reason = (result.reason ?? result.understood).slice(0, 500)
        delete rule.compile
      }
    } catch (error) {
      // 翻译出错（模型不可用等）：先不翻译，导入后到规则页翻译、确认
      plan.warnings.push({ kind: "other", title: `规则「${rule.name.slice(0, 40)}」还没翻译`, text: `翻译时出错：${(error as Error).message.slice(0, 300)}。导入后到「规则」页翻译、确认。` })
    }
    line.status = "done"
    line.ms = Date.now() - at
    await write(state)
    checkCost(state)
  }
  let next = 0
  const workers = Array.from({ length: Math.min(importLimits.compileConcurrency, queue.length) }, async () => {
    while (next < queue.length) await work(queue[next++]!)
  })
  await Promise.all(workers)
  plan.warnings = plan.warnings.slice(0, 50)
}

async function storeSecrets(state: RunState, found: FoundSecret[], stored: Set<string>, actorId: string) {
  for (const secret of found) {
    if (stored.has(secret.name)) continue
    await putSecret(state.db, getKeyring(), { scope: "import", refId: state.id, name: secret.name }, secret.value, actorId)
    stored.add(secret.name)
  }
}

/**
 * 解压并扫一遍密钥（读包的①②，不调模型）。返回包和找到的密钥；reader 和手动试包的脚本都用它
 */
export async function unpack(data: Buffer, importId: string): Promise<{ pkg: ImportPackage; totalBytes: number; extracted: number }> {
  const extracted = await extractZip(data, importFilesDir(importId))
  const files: PackageFile[] = extracted.skipped.map((each) => ({ path: each.path, diskPath: "", size: each.size, text: false, skipped: each.reason }))
  const collector = new SecretCollector()
  for (const file of extracted.files) {
    const { entry, content } = await classify(file)
    files.push(entry)
    // 模型看到任何内容之前，说明、配置这类文字文件先扫一遍（之后给模型的文字按同样的规则换成 {{名字}}）；
    // 程序源码等 AI 真要读时再挪（isCodeFile 的说明）
    if (content !== undefined && !isCodeFile(file.path)) redactText(file.path, content, collector)
  }
  await writeFile(importManifest(importId), JSON.stringify(files), { mode: 0o600 })
  return { pkg: new ImportPackage(files, collector), totalBytes: extracted.totalBytes, extracted: extracted.files.length }
}

/**
 * 读一次包（import.read 的处理函数）。只处理「读包中」的；结果写回导入记录并通知上传的人。
 * 返回 interrupted 时调用方要抛错，让 pg-boss 重试
 */
export async function runImportRead(db: Db, importId: string, options: { signal?: AbortSignal } = {}): Promise<ReadOutcome> {
  const [row] = await db.select().from(t.imports).where(eq(t.imports.id, importId))
  if (!row || row.status !== "reading") return "skipped"
  const state: RunState = { db, id: importId, log: [], baseCost: row.costUsd, spent: 0, started: Date.now(), signal: options.signal }
  try {
    // 从头读：上一次（进程挂了、重新读包）留下的都清掉
    await db.delete(t.secrets).where(and(eq(t.secrets.scope, "import"), eq(t.secrets.refId, importId)))
    await write(state, { fileCount: 0, plan: null, error: null, name: null })

    // ①② 解压（流式写盘；依赖和缓存目录不解开），找明文密钥
    let done = await begin(state, "解压，找明文密钥")
    const fileRow = row.fileId ? await getFileRow(db, row.fileId) : undefined
    const data = fileRow ? await readFileData(fileRow).catch(() => undefined) : undefined
    if (!data) throw new ImportReadError("上传的包找不到了，请重新上传")
    const { pkg, totalBytes, extracted } = await unpack(data, importId)
    const collector = pkg.collector
    await done(`解压：${pkg.files.length} 个文件，${sizeText(totalBytes)}`)
    await write(state, { fileCount: pkg.files.length })
    if (extracted === 0) throw new ImportReadError("包里没有能读的文件")
    const stored = new Set<string>()
    await storeSecrets(state, collector.found, stored, row.createdById)
    const count = collector.found.length
    state.log.push({ title: count ? `找明文密钥：${count} 个，已换成 {{名字}}，AI 看不到原值` : "找明文密钥：没有", status: "done" })
    await write(state)
    await alive(state)

    // ③ 读包 agent
    const catalog = await loadCatalog(db)
    let resolved: ResolvedModel
    try {
      resolved = await resolveModel(db, row.modelId)
    } catch (error) {
      throw new ImportReadError(error instanceof ModelConfigError ? error.message : `读包的模型用不了：${(error as Error).message.slice(0, 200)}`)
    }
    const uploader = catalog.staff.find((user) => user.id === row.createdById)
    const intro = [
      "## 这次导入",
      `上传的人：${uploader ? `${uploader.name}（${uploader.id}）` : row.createdById}`,
      `包的文件名：${row.fileName}`,
      `上传时的补充说明：${row.note.trim() || "（没有）"}`,
      "",
      "## 包里的文件（路径已去掉最外层目录；这里是根目录下两层，要看更深的用 list_files）",
      pkg.listFiles("", 2),
      "",
      "## 现有配置",
      catalogText(catalog),
    ].join("\n")
    const submitted = await readWithAgent(state, { pkg, resolved, intro })

    // ④ 整理（代码做）：技能正文从文件取，再对照现有配置
    done = await begin(state, "对照现有配置")
    await fillSkillBodies(submitted.plan, submitted.skillPaths, pkg)
    const plan = organizePlan(submitted.plan, { catalog, uploaderId: row.createdById, pkg, collector })
    await done()
    await compileRules(state, plan)
    done = await begin(state, "整理成导入方案")
    await storeSecrets(state, collector.found, stored, row.createdById)
    plan.secrets = planSecrets(plan, collector.found, catalog.secretNames)
    const parsed = importPlanSchema.safeParse(plan)
    if (!parsed.success) throw new ImportReadError(`整理出的方案格式不对：${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("；")}`)
    const problems = planProblems(parsed.data)
    if (problems.length) throw new ImportReadError(`整理出的方案对不上：${problems.slice(0, 3).join("；")}`)
    await done()

    // ⑤ 收尾
    await write(state, { plan: parsed.data, name: parsed.data.name, readAt: new Date(), status: "review", step: "overview", visited: [] })
    const tasks = parsed.data.tasks.length
    await notifyUsers(db, {
      userIds: [row.createdById],
      title: `「${row.fileName}」读完了，${tasks ? `整理出 ${tasks} 个任务` : "没有任务，只有技能、记忆等配置"}，等你确认`,
      link: importLink(importId),
    }).catch((error) => console.error("[import] 通知失败", error))
    return "review"
  } catch (error) {
    if (error instanceof Stopped) return "stopped"
    if (error instanceof Interrupted || options.signal?.aborted) return "interrupted"
    const message = error instanceof ImportReadError ? error.message : `读包时出错：${(error as Error).message.slice(0, 300)}`
    if (!(error instanceof ImportReadError)) console.error(`[import] ${importId} 读包出错`, error)
    const running = [...state.log].reverse().find((line) => line.status === "running")
    if (running) running.status = "error"
    else state.log.push({ title: message.slice(0, 300), status: "error" })
    try {
      await write(state, { status: "failed", error: message })
    } catch (writeError) {
      if (writeError instanceof Stopped) return "stopped"
      throw writeError
    }
    await notifyUsers(db, { userIds: [row.createdById], title: `「${row.fileName}」没读成`, body: message, link: importLink(importId) }).catch((notifyError) =>
      console.error("[import] 通知失败", notifyError)
    )
    return "failed"
  }
}
