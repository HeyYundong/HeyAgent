// 内置工具 code.run「运行代码」（docs/dev/session-space.md 第 4 节）：
// 准备这个 session 的沙箱目录（空间文件的镜像）→ 起出网代理 → 在 bubblewrap 沙箱里跑 → 对比前后，新增、改动、删掉的文件同步回空间
// → 按 3.2 的格式返回退出码、用时、写回了什么、访问了哪些主机、stdout / stderr（各给末尾 1 万字，被截掉的全文存成 tool-outputs/ 里的文件）。
// 带 tools（docs/dev/solidify.md 18.1，只认 node）：不起出网代理，改起工具桥（mode = agent，挂到 /tmp/.tools），SDK 拷进代码目录的
// node_modules/heyagent/，用 SDK 的 agent-launch.js 启动脚本（import "heyagent" 在 /workspace 里的脚本也能找到）。脚本的每次调用经工具桥
// 回到这次运行的网关（ctx.scriptTools）；输出后面加一段「脚本调了 n 次工具…停在第 k 步…」；停在要挂起的一步时结果带上 suspend，引擎照常挂起。
import { randomBytes } from "node:crypto"
import { existsSync } from "node:fs"
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { builtinToolInputs, isRunEnded, routineStopKindLabel, type RoutineStop, type RunStatus, type SessionRoutineState } from "@heyagent/shared"
import { eq, inArray } from "drizzle-orm"
import type { z } from "zod"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import {
  deleteSpaceFile,
  listSpace,
  readFileData,
  saveFile,
  spacePathOf,
  SpacePathError,
  spaceUsage,
  writeSpaceFile,
  type SpaceEntry,
} from "../files/service.js"
import { appendEvent } from "../engine/records.js"
import { runtime, type SandboxConfig } from "../engine/runtime.js"
import type { ToolContext, ToolOutcome } from "../engine/tools/builtin.js"
import { ToolBridge } from "../routine/runtime/bridge.js"
import { judgeForRun } from "../routine/runtime/judge.js"
import { EgressProxy, type ProxyReport } from "./proxy.js"
import {
  bwrapRunner,
  PROXY_SOCKET_NAME,
  SANDBOX_CODE_DIR,
  SANDBOX_WORKSPACE,
  sandboxUnavailable,
  TOOLS_SOCKET_NAME,
  type CapturedOutput,
  type SandboxRunner,
  type SandboxRunResult,
} from "./runner.js"
import { diffWorkspace, prepareWorkspace, removeSessionDirs, saveManifest, sessionDirs } from "./workspace.js"

export type CodeRunInput = z.infer<(typeof builtinToolInputs)["code.run"]>

/** 测试用：换掉真正的沙箱（开发机上没有 bwrap） */
export interface SandboxDeps {
  runner: SandboxRunner
  unavailable: (config: SandboxConfig) => Promise<string | undefined>
}
const defaultDeps: SandboxDeps = { runner: bwrapRunner, unavailable: sandboxUnavailable }
let deps: SandboxDeps = defaultDeps
export function setSandboxDeps(patch: Partial<SandboxDeps> | undefined) {
  deps = patch ? { ...defaultDeps, ...patch } : defaultDeps
}

const fail = (output: string): ToolOutcome => ({ output, isError: true })

/** 同一个 session 的 code.run 排队跑（共用一个目录） */
const locks = new Map<string, Promise<unknown>>()
async function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve()
  const current = previous.catch(() => {}).then(fn)
  locks.set(key, current)
  try {
    return await current
  } finally {
    if (locks.get(key) === current) locks.delete(key)
  }
}

const EXT = { python: "py", node: "js", bash: "sh" } as const

/** 空间里的路径（读的时候用，保留目录也认）：容忍开头的 /workspace/、/、./ */
export function spaceReadPath(raw: string) {
  let path = raw.trim()
  if (path.startsWith(`${SANDBOX_WORKSPACE}/`)) path = path.slice(SANDBOX_WORKSPACE.length + 1)
  for (;;) {
    if (path.startsWith("/")) path = path.slice(1)
    else if (path.startsWith("./")) path = path.slice(2)
    else break
  }
  return path
}

export const secondsText = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`

const listText = (items: string[], max = 20) =>
  items.length > max ? `${items.slice(0, max).join("、")} 等 ${items.length} 个` : items.join("、")

export interface StreamPart {
  text: string
  /** 被截掉的全文存在空间里的路径 */
  fullPath?: string
  omitted: number
}

/** 一路输出留末尾多少字；超出时返回被截掉的字数（全文另存由调用方做） */
export function tailOf(text: string, max: number): { text: string; omitted: number } {
  if (text.length <= max) return { text, omitted: 0 }
  let start = text.length - max
  // 不切开代理对
  const code = text.charCodeAt(start)
  if (code >= 0xdc00 && code <= 0xdfff) start++
  return { text: text.slice(start), omitted: start }
}

export interface CodeRunReport {
  exitCode: number
  timedOut: boolean
  timeoutSec: number
  ms: number
  synced: { created: string[]; updated: string[]; deleted: string[] }
  notSynced: { path: string; reason: string }[]
  network: Pick<ProxyReport, "allowed" | "denied">
  stdout?: StreamPart
  stderr?: StreamPart
}

/** 返回给 agent（和界面）的文字，格式见 docs/dev/session-space.md 3.2 */
export function formatCodeRunOutput(report: CodeRunReport): string {
  const lines = [
    report.timedOut
      ? `超时（${report.timeoutSec} 秒），整组进程已被杀掉 · 退出码 ${report.exitCode} · 用时 ${secondsText(report.ms)}`
      : `退出码 ${report.exitCode} · 用时 ${secondsText(report.ms)}`,
  ]
  const { created, updated, deleted } = report.synced
  const synced = [
    created.length ? `新建 ${listText(created)}` : "",
    updated.length ? `覆盖 ${listText(updated)}` : "",
    deleted.length ? `删掉 ${listText(deleted)}` : "",
  ].filter(Boolean)
  if (synced.length) lines.push(`写回空间：${synced.join("；")}`)
  if (report.notSynced.length)
    lines.push(
      `没写回：${report.notSynced
        .slice(0, 20)
        .map((item) => `${item.path}（${item.reason}）`)
        .join("；")}${report.notSynced.length > 20 ? `；等 ${report.notSynced.length} 个` : ""}`
    )
  const network = [
    report.network.allowed.length ? `访问了：${listText(report.network.allowed)}` : "",
    report.network.denied.length ? `拒绝：${listText(report.network.denied)}` : "",
  ].filter(Boolean)
  if (network.length) lines.push(network.join("；"))
  for (const [label, part] of [
    ["stdout", report.stdout],
    ["stderr", report.stderr],
  ] as const) {
    if (!part || !part.text) continue
    lines.push(`--- ${label} ---`)
    if (part.omitted > 0) lines.push(`…（前面还有 ${part.omitted} 字，全文见 ${part.fullPath}）`)
    lines.push(part.text.replace(/\n$/, ""))
  }
  return lines.join("\n")
}

const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15)

/** 一路输出：末尾 N 字给模型，被截掉了就把全文存成 tool_output 文件 */
async function streamPart(ctx: ToolContext, label: "stdout" | "stderr", output: CapturedOutput, max: number, id: string): Promise<StreamPart | undefined> {
  if (!output.text) return undefined
  const tail = tailOf(output.text, max)
  if (!tail.omitted) return { text: tail.text, omitted: 0 }
  const row = await saveFile(ctx.db, {
    data: Buffer.from(output.text, "utf8"),
    name: `code-run-${id}-${label}.txt`,
    mime: "text/plain",
    kind: "tool_output",
    sessionId: ctx.session.id,
  })
  return { text: tail.text, omitted: tail.omitted, fullPath: spacePathOf(row) }
}

/** SDK 的源目录（src/sandbox → apps/server/sandbox-sdk；dist 下同样的深度） */
const SDK_DIR = fileURLToPath(new URL("../../sandbox-sdk/heyagent/", import.meta.url))
/** 带 tools 时沙箱里跑的启动器：node agent-launch.js <脚本> [参数…] */
const AGENT_LAUNCH = `${SANDBOX_CODE_DIR}/node_modules/heyagent/agent-launch.js`

/** 带 tools 的上限（docs/dev/solidify.md 18.1）：一次 code.run 最多调几次工具；时间用 code.run 的 timeout */
export const scriptToolLimits = {
  maxCalls: 500,
  /** 脚本已经停了（要审批、要挂起……）还不退出（接住了 RoutineStop 还在跑），过多久杀掉 */
  killGraceMs: 5000,
  /** 脚本跑着时多久看一次运行有没有被取消（脚本一直不调工具时也能停） */
  cancelCheckMs: 5000,
}

/** 测试用：改上限 */
export function configureScriptTools(patch: Partial<typeof scriptToolLimits>) {
  Object.assign(scriptToolLimits, patch)
}

/** 工具 id 换成给模型的名字（网关的规则：点换成下划线） */
const modelToolName = (toolId: string) => toolId.replace(/[^A-Za-z0-9_-]/g, "_")

/**
 * 输出后面加的一段（docs/dev/solidify.md 18.1）：脚本调了 n 次工具（每个工具几次、出错几次）；停在第 k 步……
 * 要审批的那一步写明「没做：单独调用它」；要挂起的写明继续后脚本不会接着跑
 */
export function formatScriptTools(input: {
  stats: Map<string, { calls: number; errors: number }>
  stopped?: RoutineStop
  lastFailure?: RoutineStop
}): string {
  const { stats, stopped, lastFailure } = input
  const total = [...stats.values()].reduce((sum, each) => sum + each.calls, 0)
  const errors = [...stats.values()].reduce((sum, each) => sum + each.errors, 0)
  const lines = ["--- 脚本调的工具 ---"]
  lines.push(
    total
      ? `脚本调了 ${total} 次工具${errors ? `（出错 ${errors} 次）` : ""}：${[...stats.entries()]
          .map(([tool, each]) => `${tool} ${each.calls} 次${each.errors ? `（出错 ${each.errors} 次）` : ""}`)
          .join("、")}`
      : "脚本没有调工具。"
  )
  if (stopped) {
    const where = stopped.label ?? stopped.tool ?? ""
    const at = stopped.step ? `停在第 ${stopped.step} 步` : "停下了"
    switch (stopped.kind) {
      case "approval":
        lines.push(
          `${at}：${stopped.reason}。这一步没做（脚本里不做要审批的动作）；要做的话单独调用它（${stopped.tool ? modelToolName(stopped.tool) : "那个工具"}），系统会交给人审批。后面的步骤也没做。`
        )
        break
      case "suspend":
        lines.push(`${at}：${where ? `${where}：` : ""}${stopped.reason}。运行要挂起等人处理；继续后脚本不会接着跑，先看页面现在的样子，再决定从哪一步接着做。`)
        break
      case "input":
      case "page":
        lines.push(`脚本自己停下了（ha.fail）：${stopped.reason}`)
        break
      default:
        lines.push(`${at}（${routineStopKindLabel[stopped.kind]}）：${where ? `${where}：` : ""}${stopped.reason}`)
    }
  } else if (lastFailure) {
    lines.push(`最后一次出错：第 ${lastFailure.step} 步 ${lastFailure.label ?? lastFailure.tool ?? ""}：${lastFailure.reason}`)
  }
  return lines.join("\n")
}

export async function runCode(ctx: ToolContext, input: CodeRunInput): Promise<ToolOutcome> {
  if ((input.file === undefined) === (input.code === undefined))
    return fail("file（空间里的脚本路径）和 code（直接给代码）要给一个，而且只能给一个")
  if (input.tools) {
    if (input.language !== "node")
      return fail(`tools: true 只能和 language = node 一起用（脚本里 import ha from "heyagent"），现在是 ${input.language}。不调工具的 ${input.language} 代码去掉 tools 再跑`)
    if (!ctx.scriptTools) return fail("这里不能用 tools：只有运行里的 code.run 能在脚本里调工具")
  }
  const config = runtime.sandbox
  const reason = await deps.unavailable(config)
  if (reason) return fail(`沙箱没起来：${reason}`)
  const sessionId = ctx.session.id
  void sweepThrottled(ctx.db)
  return withLock(sessionId, () => runLocked(ctx, input, config))
}

async function runLocked(ctx: ToolContext, input: CodeRunInput, config: SandboxConfig): Promise<ToolOutcome> {
  const { db } = ctx
  const sessionId = ctx.session.id
  const entries = await listSpace(db, sessionId, ctx.snapshot.attachments.map((file) => file.id))
  let script: string
  if (input.file !== undefined) {
    const path = spaceReadPath(input.file)
    const entry = entries.find((each) => each.path === path)
    if (!entry) return fail(`空间里没有 ${path}（用 file.list 看有哪些；要跑的脚本先用 file.save 存进去，或者直接给 code）`)
    script = `${SANDBOX_WORKSPACE}/${path}`
  } else {
    script = `${SANDBOX_CODE_DIR}/main.${EXT[input.language]}`
  }
  const tools = input.tools && ctx.scriptTools ? ctx.scriptTools : undefined
  const timeoutSec = input.timeout ?? config.defaultTimeoutSec
  const dirs = sessionDirs(config.dir, sessionId)
  const runId = `${stamp()}-${randomBytes(2).toString("hex")}`

  let prepared
  try {
    prepared = await prepareWorkspace(dirs, entries, (entry) => readFileData(entry.row))
  } catch (error) {
    return fail(`沙箱没起来：准备空间文件时出错（${(error as Error).message}）`)
  }
  if (input.code !== undefined || tools) {
    try {
      await rm(dirs.code, { recursive: true, force: true }).catch(() => {})
      await mkdir(dirs.code, { recursive: true })
      if (input.code !== undefined) await writeFile(join(dirs.code, `main.${EXT[input.language]}`), input.code)
      // 带 tools：SDK 跑的时候拷进去，不用重建镜像
      if (tools) await cp(SDK_DIR, join(dirs.code, "node_modules", "heyagent"), { recursive: true })
    } catch (error) {
      return fail(`沙箱没起来：准备代码目录时出错（${(error as Error).message}）`)
    }
  }

  let proxy: EgressProxy | undefined
  let network: ProxyReport = { allowed: [], denied: [], bytes: 0 }
  let result: SandboxRunResult
  let scriptRun: ScriptRun | undefined
  try {
    if (tools) {
      // 带 tools：不挂出网代理（脚本不能上网，和外面打交道只能经过工具桥）
      scriptRun = await startScriptBridge(ctx, tools, dirs.root)
      result = await deps.runner({
        language: "node",
        script: AGENT_LAUNCH,
        args: [script, ...(input.args ?? [])],
        stdin: input.stdin,
        timeoutSec,
        workspaceDir: dirs.workspace,
        homeDir: dirs.home,
        codeDir: dirs.code,
        toolsDir: scriptRun.toolsDir,
        readonlyDirs: prepared.readonlyDirs,
        config,
        signal: scriptRun.signal,
      })
    } else {
      proxy = await EgressProxy.start(join(dirs.proxy, PROXY_SOCKET_NAME), { ports: config.proxyPorts, label: sessionId })
      result = await deps.runner({
        language: input.language,
        script,
        args: input.args ?? [],
        stdin: input.stdin,
        timeoutSec,
        workspaceDir: dirs.workspace,
        homeDir: dirs.home,
        codeDir: input.code !== undefined ? dirs.code : undefined,
        proxyDir: dirs.proxy,
        readonlyDirs: prepared.readonlyDirs,
        config,
      })
    }
  } catch (error) {
    return fail(`沙箱没起来：${(error as Error).message}`)
  } finally {
    if (proxy) {
      await proxy.close().catch(() => {})
      network = proxy.report()
    }
    // 最后一个请求可能还在处理（例如沙箱被杀时正在等工具）：等它处理完再写结果
    await scriptRun?.close()
  }
  // bwrap 自己出错（挂载失败这类）时退出码 1、stderr 以 bwrap: 开头：这不是代码的问题
  if (!result.timedOut && result.exitCode === 1 && /^bwrap: /.test(result.stderr.text))
    return fail(`沙箱没起来：${result.stderr.text.trim().slice(0, 500)}`)

  // 写回空间
  const synced: CodeRunReport["synced"] = { created: [], updated: [], deleted: [] }
  const notSynced: CodeRunReport["notSynced"] = prepared.conflicts.map((path) => ({ path, reason: "和只读目录撞了，没放进沙箱" }))
  let facts: ToolOutcome["facts"]
  try {
    const diff = await diffWorkspace(prepared)
    notSynced.push(...diff.skipped)
    const byPath = new Map<string, SpaceEntry>(entries.filter((entry) => entry.writable).map((entry) => [entry.path, entry]))
    let projected = await spaceUsage(db, sessionId)
    let count = 0
    let total = 0
    for (const change of diff.changes) {
      const entry = byPath.get(change.path)
      const oldSize = entry?.row.size ?? 0
      const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)} MB`
      let skip: string | undefined
      if (count >= config.syncMaxFiles) skip = `一次最多写回 ${config.syncMaxFiles} 个文件`
      else if (change.size > config.syncMaxFileBytes) skip = `超过 ${mb(config.syncMaxFileBytes)}`
      else if (total + change.size > config.syncMaxTotalBytes) skip = `这次写回合计超过 ${mb(config.syncMaxTotalBytes)}`
      else if (projected - oldSize + change.size > config.spaceMaxBytes) skip = `空间总量超过 ${mb(config.spaceMaxBytes)}`
      if (skip) {
        notSynced.push({ path: change.path, reason: skip })
        continue
      }
      const data = await readFile(join(dirs.workspace, change.path))
      const { row, created } = await writeSpaceFile(db, {
        sessionId,
        path: change.path,
        data,
        legacyRow: entry && !entry.row.path ? entry.row : undefined,
      })
      count++
      total += data.length
      projected += data.length - oldSize
      prepared.manifest.files[change.path] = { id: row.id, sha256: row.sha256, ...change.print }
      ;(created ? synced.created : synced.updated).push(change.path)
      facts ??= { fileId: row.id, fileName: change.path }
    }
    for (const path of diff.deleted) {
      const entry = byPath.get(path)
      delete prepared.manifest.files[path]
      if (!entry) continue
      try {
        await deleteSpaceFile(db, entry.row)
        synced.deleted.push(path)
      } catch (error) {
        if (!(error instanceof SpacePathError)) throw error
        notSynced.push({ path, reason: error.message })
      }
    }
  } finally {
    await saveManifest(dirs, prepared.manifest).catch(() => {})
  }

  const max = config.outputTailChars
  const report = formatCodeRunOutput({
    exitCode: result.exitCode,
    timedOut: result.timedOut,
    timeoutSec,
    ms: result.ms,
    synced,
    notSynced,
    network,
    stdout: await streamPart(ctx, "stdout", result.stdout, max, runId),
    stderr: await streamPart(ctx, "stderr", result.stderr, max, runId),
  })
  if (!scriptRun) return { output: report, keepFull: true, facts }
  const { bridge } = scriptRun
  const output = `${report}\n${formatScriptTools({
    stats: bridge.toolStats,
    ...(bridge.stopped ? { stopped: bridge.stopped } : {}),
    ...(bridge.lastFailure ? { lastFailure: bridge.lastFailure } : {}),
  })}`
  const suspend = bridge.suspend
  if (!suspend) return { output, keepFull: true, ...(facts ? { facts } : {}) }
  // 停在要挂起的那一步（验证码、登录页……）：带出挂起计划，引擎照常挂起；signals、facts 同 browser.batch
  const stepFacts = suspend.facts ?? facts
  return {
    output,
    keepFull: true,
    suspend: suspend.plan,
    ...(suspend.signals ? { signals: suspend.signals } : {}),
    ...(stepFacts ? { facts: stepFacts } : {}),
    nested: facts ? { facts } : {},
  }
}

interface ScriptRun {
  bridge: ToolBridge
  toolsDir: string
  signal: AbortSignal
  close: () => Promise<void>
}

/**
 * 起这次 code.run 的工具桥（mode = agent）：脚本的每次调用经它回到这次运行的网关。
 * 停下（要审批、要挂起、ha.fail……）以后脚本一般马上退出；接住了 RoutineStop 还在跑的过一会儿杀掉，运行被取消的马上杀
 */
async function startScriptBridge(ctx: ToolContext, tools: NonNullable<ToolContext["scriptTools"]>, root: string): Promise<ScriptRun> {
  const { db, session, snapshot } = ctx
  // 和固化脚本的工具桥（<root>/t）分开：固化脚本里调 code.run（tools）时两个 socket 不会互相删掉
  const toolsDir = join(root, "ts")
  await mkdir(toolsDir, { recursive: true })
  const kill = new AbortController()
  let graceTimer: NodeJS.Timeout | undefined
  // 工具桥要一份脚本状态（数步数、提交、日志）；agent 的脚本不写进 sessions.routine
  const state: SessionRoutineState = {
    routineId: "",
    versionId: "",
    version: 0,
    mode: "run",
    state: "running",
    startedAt: new Date().toISOString(),
    steps: 0,
    commits: [],
  }
  const bridge = await ToolBridge.listen(join(toolsDir, TOOLS_SOCKET_NAME), {
    sessionId: session.id,
    gateway: tools.gateway,
    state,
    mode: "agent",
    scriptCallId: tools.callId,
    trial: false,
    maxCalls: scriptToolLimits.maxCalls,
    save: async () => {},
    event: async (event) => {
      await appendEvent(db, session.id, event)
    },
    onStop: (kind) => {
      if (kind === "cancelled") kill.abort()
      else graceTimer ??= setTimeout(() => kill.abort(), scriptToolLimits.killGraceMs)
    },
    judge: (request, trace) => judgeForRun({ db, session, snapshot }, request, trace),
  })
  // 脚本一直不调工具时也能停：定时看运行有没有被取消
  const watcher = setInterval(() => {
    void tools.gateway
      .stillRunning()
      .then((running) => (running ? undefined : bridge.stopWith("cancelled", "运行被取消了")))
      .catch(() => {})
  }, scriptToolLimits.cancelCheckMs)
  return {
    bridge,
    toolsDir,
    signal: kill.signal,
    close: async () => {
      clearInterval(watcher)
      if (graceTimer) clearTimeout(graceTimer)
      await bridge.idle()
      await bridge.close()
    },
  }
}

// ---------- 清理 ----------

/** 运行结束（已完成 / 没完成 / 失败）了就删掉它的沙箱目录；还在跑、在等的留着（home 里装的包还要用） */
export async function cleanupSessionSandbox(db: Db, sessionId: string) {
  const config = runtime.sandbox
  if (!existsSync(sessionDirs(config.dir, sessionId).root)) return
  const [row] = await db.select({ status: t.sessions.status }).from(t.sessions).where(eq(t.sessions.id, sessionId))
  if (!row || isRunEnded(row.status as RunStatus)) await removeSessionDirs(config.dir, sessionId)
}

/** 删掉已经结束（或者不存在）的 session 的目录：worker 启动时、之后每小时最多一次 */
export async function sweepSandboxDirs(db: Db) {
  const config = runtime.sandbox
  const names = await readdir(config.dir).catch(() => [] as string[])
  if (names.length === 0) return
  const rows = await db
    .select({ id: t.sessions.id, status: t.sessions.status })
    .from(t.sessions)
    .where(inArray(t.sessions.id, names))
  const alive = new Set(rows.filter((row) => !isRunEnded(row.status as RunStatus)).map((row) => row.id))
  for (const name of names)
    if (!alive.has(name)) await rm(join(config.dir, name), { recursive: true, force: true }).catch(() => {})
}

let lastSweep = 0
export async function sweepThrottled(db: Db) {
  if (Date.now() - lastSweep < 60 * 60_000) return
  lastSweep = Date.now()
  await sweepSandboxDirs(db).catch((error) => console.warn("[sandbox] 清理旧目录出错", error))
}
