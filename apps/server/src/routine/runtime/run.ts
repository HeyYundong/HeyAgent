// 跑固化脚本（docs/dev/solidify.md 4.3、6.3、15.2 第 4、5 条）：按 inputSchema 校验输入 → 准备沙箱的代码目录
// （routine.mjs + node_modules/heyagent/ 里的 SDK，跑的时候拷进去，不用重建镜像）→ 起工具桥 → 在沙箱里跑 launch.js
// → 按工具桥记下的结果定这次脚本的结局，写进 sessions.routine。
// 沙箱用 code.run 的同一套（sandbox/runner.ts），但不挂出网代理（脚本不能上网，和外面打交道只能经过工具桥），
// 空间文件只读挂在 /workspace，内存 512 MB。上限：一次最多 1000 次工具调用、默认 10 分钟（要小于 runtime.maxRunMs）。
// 这里只跑脚本、定结局；接下来怎么收尾（报结果、交给 agent、挂起、审批）由引擎（engine/loop.ts）做。
// 接着跑（docs/dev/solidify.md 17.2）：停下等人以后、进程中途被杀以后，从头再跑一遍脚本，工具桥按 routine_journal 重放。
// 审批被拒绝、日志里有浏览器动作而这次运行的 Chrome 已经不在了：不重放，直接停下交给 agent。
// 流程库（docs/dev/routine-library.md 5.6）：代码目录里另放快照里用得了的库流程（routines/<短名>.mjs），脚本里 ha.routine 调；
// 每次调用（每一层）写一行 routine_calls（试跑不记）。
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import { routineStopKindLabel, type RoutineSnapshot, type SessionRoutineState, type SessionSnapshot } from "@heyagent/shared"
import { asc, eq } from "drizzle-orm"
import { getBrowserManager } from "../../browser/manager.js"
import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { listSpace, readFileData } from "../../files/service.js"
import type { GatewayResult, ToolGateway } from "../../engine/gateway.js"
import type { AgentClaim } from "../../engine/outcome.js"
import { appendEvent } from "../../engine/records.js"
import { runtime, type SandboxConfig } from "../../engine/runtime.js"
import type { SessionRow, SuspendPlan } from "../../engine/tools/builtin.js"
import {
  bwrapRunner,
  SANDBOX_CODE_DIR,
  sandboxUnavailable,
  TOOLS_SOCKET_NAME,
  type SandboxRunner,
  type SandboxRunResult,
} from "../../sandbox/runner.js"
import { prepareWorkspace, saveManifest, sessionDirs } from "../../sandbox/workspace.js"
import { libraryModules } from "../library/snapshot.js"
import { recordRoutineCall } from "../library/stats.js"
import { checkRoutineInput, ToolBridge, type BridgeGateway, type BridgeJournal, type BridgeRoutineCall, type JournalRow } from "./bridge.js"
import { judgeForRun } from "./judge.js"

export { checkRoutineInput }

const num = (name: string, fallback: number) => {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

/** 上限（docs/dev/solidify.md 4.1）：防死循环。时间还要小于 runtime.maxRunMs（单个任务跑太久会交接） */
export const routineLimits = {
  maxCalls: num("HEYAGENT_ROUTINE_MAX_CALLS", 1000),
  timeoutMs: num("HEYAGENT_ROUTINE_MAX_MINUTES", 10) * 60_000,
  /** 脚本的内存（Node 的堆） */
  memoryBytes: num("HEYAGENT_ROUTINE_MEMORY_MB", 512) * 1024 * 1024,
  /** 停下以后脚本还不退出（接住了 RoutineStop 还在跑），过多久杀掉 */
  killGraceMs: 5000,
  /** 脚本跑着时多久看一次运行有没有被取消（脚本一直不调工具时也能停） */
  cancelCheckMs: 5000,
}

/** 测试用：改上限 */
export function configureRoutineRuntime(patch: Partial<typeof routineLimits>) {
  Object.assign(routineLimits, patch)
}

const timeoutMs = () => Math.max(30_000, Math.min(routineLimits.timeoutMs, runtime.maxRunMs - 60_000))

/** 测试用：换掉真正的沙箱（开发机上没有 bwrap，用「直接跑 node」的 runner） */
export interface RoutineSandboxDeps {
  runner: SandboxRunner
  unavailable: (config: SandboxConfig) => Promise<string | undefined>
}
const defaultDeps: RoutineSandboxDeps = { runner: bwrapRunner, unavailable: sandboxUnavailable }
let deps = defaultDeps
export function setRoutineSandboxDeps(patch: Partial<RoutineSandboxDeps> | undefined) {
  deps = patch ? { ...defaultDeps, ...patch } : defaultDeps
}
/** 现在用的沙箱（库流程当工具跑时也用它，routine/library/tool.ts） */
export const routineSandboxDeps = () => deps

/** 代码目录里放库流程的模块（routines/<短名>.mjs） */
export async function writeLibraryModules(codeDir: string, modules: { path: string; code: string }[]) {
  for (const module of modules) {
    const file = join(codeDir, module.path)
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, module.code)
  }
}

/** 调用记录的写法（调用方的运行、任务补上）：工具桥每一层库流程结束时调 */
export const callRecorder =
  (db: Db, session: Pick<SessionRow, "id" | "taskId">) =>
  (call: BridgeRoutineCall): Promise<void> =>
    recordRoutineCall(db, { ...call, sessionId: session.id, taskId: session.taskId }).then(() => undefined)

/** SDK 的源目录（src/routine/runtime → apps/server/sandbox-sdk；dist 下同样的深度） */
export const SDK_DIR = fileURLToPath(new URL("../../../sandbox-sdk/heyagent/", import.meta.url))
/** 沙箱里跑的程序：SDK 的启动器，它再载入同一目录下的 routine.mjs */
export const LAUNCH_SCRIPT = `${SANDBOX_CODE_DIR}/node_modules/heyagent/launch.js`

export type RoutineSnapshotted = SessionSnapshot & { routine: RoutineSnapshot }

export interface RoutineRunContext {
  db: Db
  session: SessionRow
  snapshot: RoutineSnapshotted
  gateway: ToolGateway | BridgeGateway
  /** run = 普通运行先跑脚本；test = 固化试跑 */
  mode: "run" | "test"
  /** 这次的输入（普通运行 = routineInputOf(快照)；试跑 = 原来那次运行的输入） */
  input: Record<string, unknown>
  signal?: AbortSignal
  /**
   * 接着跑（普通运行，sessions.routine.state 是 suspended 或 running）：previous = 上次的脚本状态；
   * decision = 停在审批那一步时人的决定（approvedRuleIds = 批准后真做时带的规则）
   */
  resume?: {
    previous: SessionRoutineState
    decision?: { how: "approve" | "reject"; note?: string; actorName: string; approvedRuleIds: string[] }
    /** 停下等的那件要人办的事（登录页、验证码）被点了「处理不了」：不重放，交给 agent */
    declined?: { note?: string }
  }
}

export interface RoutineRunResult {
  /** 最终的脚本状态（已经写进 sessions.routine） */
  state: SessionRoutineState
  /** 普通运行：脚本报的结果（run.finish 真调过，引擎照常收尾） */
  finish?: AgentClaim
  /** 要挂起：普通运行照常挂起（state = suspended），处理完接着跑；试跑照常挂起，继续后从头跑 */
  suspend?: { plan: SuspendPlan; output: string }
  /** 要人审批（普通运行，state = suspended）：引擎生成「审批工具调用」；这一步没做 */
  approval?: { result: GatewayResult; step: number; approvedRuleIds: string[]; library?: { name: string; step: number } }
  /** worker 要退出（signal）：脚本被杀，sessions.routine 还是 running，下次进来按日志接着跑 */
  aborted?: boolean
}

async function saveState(db: Db, sessionId: string, state: SessionRoutineState) {
  await db.update(t.sessions).set({ routine: state }).where(eq(t.sessions.id, sessionId))
}

/** 这次运行的重放日志（按 seq 排好） */
export async function loadJournal(db: Db, sessionId: string): Promise<JournalRow[]> {
  const rows = await db.select().from(t.routineJournal).where(eq(t.routineJournal.sessionId, sessionId)).orderBy(asc(t.routineJournal.seq))
  return rows.map((row) => ({
    seq: row.seq,
    op: row.op as JournalRow["op"],
    tool: row.tool,
    inputHash: row.inputHash,
    reply: row.reply ?? null,
    stop: (row.stop as JournalRow["stop"]) ?? null,
    instanceId: row.instanceId,
  }))
}

/** 写一行日志（同一个 seq 再写就是改） */
function journalOf(db: Db, sessionId: string, rows: JournalRow[]): BridgeJournal {
  return {
    rows,
    write: async (row) => {
      const values = { op: row.op, tool: row.tool, inputHash: row.inputHash, reply: row.reply, stop: row.stop, instanceId: row.instanceId, at: new Date() }
      await db
        .insert(t.routineJournal)
        .values({ sessionId, seq: row.seq, ...values })
        .onConflictDoUpdate({ target: [t.routineJournal.sessionId, t.routineJournal.seq], set: values })
    },
  }
}

/**
 * 日志里有做完的浏览器动作，而这次运行的 Chrome 已经不在了（过了保留时间被关掉、worker 重启）或者换了一个：
 * 页面不是上次的样子，不能按记录接着跑。返回原因；没问题返回 undefined
 */
function browserLost(rows: JournalRow[], current: string | undefined): string | undefined {
  const used = rows.filter((row) => row.op === "tool" && row.tool?.startsWith("browser.") && row.reply && row.stop !== "suspend")
  if (used.length === 0) return undefined
  const last = used.at(-1)!.instanceId
  if (!current) return "等人处理期间这次运行的 Chrome 已经关了（过了保留时间，或者 worker 重启了），页面不是上次的样子，脚本不能按记录接着跑"
  if (last && last !== current) return `这次运行的 Chrome 换了（上次 ${last}，现在 ${current}），页面不是上次的样子，脚本不能按记录接着跑`
  return undefined
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`

/**
 * 跑一遍脚本。普通运行：sessions.routine 为空时从头跑、记重放日志；停下等人、进程被杀以后（resume）从头再跑、按日志重放。
 * 试跑：每次进来都从头跑，不记日志
 */
export async function runRoutineScript(ctx: RoutineRunContext): Promise<RoutineRunResult> {
  const { db, session, snapshot, mode, resume } = ctx
  const routine = snapshot.routine
  const started = Date.now()
  // 接着跑：步数、提交、日志按重放重新数一遍；用时接着上次的算（等人的时间不算）
  const previous = resume?.previous
  const baseMs = previous?.state === "suspended" ? (previous.ms ?? 0) : 0
  const state: SessionRoutineState = previous
    ? (() => {
        const { stoppedAt: _stop, endedAt: _end, ms: _ms, logs: _logs, ...rest } = previous
        return { ...rest, state: "running" as const, steps: 0, commits: [], resumes: (previous.resumes ?? 0) + 1, replayed: 0 }
      })()
    : {
        routineId: routine.id,
        versionId: routine.versionId,
        version: routine.version,
        mode,
        state: "running",
        startedAt: new Date(started).toISOString(),
        steps: 0,
        commits: [],
        input: ctx.input,
      }

  const end = async (patch: Partial<RoutineRunResult> = {}, stop?: SessionRoutineState["stoppedAt"]): Promise<RoutineRunResult> => {
    if (stop && !state.stoppedAt) state.stoppedAt = stop
    const finished = Boolean(patch.finish) || (mode === "test" && Boolean(state.recorded?.finish) && !state.stoppedAt)
    const waiting = mode === "run" && !finished && Boolean(patch.suspend || patch.approval)
    state.state = finished
      ? "finished"
      : waiting
        ? "suspended"
        : mode === "test" || ["cancelled", "input"].includes(state.stoppedAt?.kind ?? "")
          ? "stopped"
          : "fell_back"
    // 试跑：停下、跑完时截一张图（试跑报告「停下时的截图」）
    if (mode === "test") {
      const shot = await ctx.gateway.screenshot().catch(() => undefined)
      if (shot) state.screenshotFileId = shot.fileId
    }
    state.endedAt = new Date().toISOString()
    state.ms = baseMs + (Date.now() - started)
    await saveState(db, session.id, state)
    const stopped = state.stoppedAt
    const step = stopped?.step ?? state.steps
    await appendEvent(db, session.id, {
      kind: finished || waiting || stopped?.kind === "test_commit" || stopped?.kind === "test_blocked" || !stopped ? "plan" : "error",
      title: finished
        ? `固化流程跑完了：${state.steps} 步 · ${seconds(state.ms)}`
        : waiting
          ? `固化流程在第 ${step} 步停下等人处理（${routineStopKindLabel[stopped?.kind ?? "suspend"]}），处理好以后接着跑`
          : `固化流程停在第 ${step} 步：${routineStopKindLabel[stopped?.kind ?? "script_error"]}`,
      detail: stopped && !finished ? stopped.reason : null,
      ...(state.stoppedAt?.step ? { trace: { routineStep: state.stoppedAt.step } } : {}),
    })
    return { state, ...patch }
  }

  // 重放日志：普通运行才记。第一次跑先清掉（按理是空的）；接着跑读出来按它重放
  let journal: BridgeJournal | undefined
  if (mode === "run") {
    if (!previous) await db.delete(t.routineJournal).where(eq(t.routineJournal.sessionId, session.id))
    journal = journalOf(db, session.id, previous ? await loadJournal(db, session.id) : [])
  }

  if (previous) {
    await saveState(db, session.id, state)
    const pending = previous.stoppedAt
    // 不用重放就交给 agent 的：步数、提交、日志照上次的
    const keepPrevious = () => Object.assign(state, { steps: previous.steps, commits: previous.commits, ...(previous.logs ? { logs: previous.logs } : {}) })
    const where = { ...(pending?.tool ? { tool: pending.tool } : {}), ...(pending?.label ? { label: pending.label } : {}) }
    // 停在审批那一步、人拒绝了
    if (resume.decision?.how === "reject") {
      keepPrevious()
      return end({}, {
        step: pending?.step ?? previous.steps + 1,
        kind: "rejected",
        ...where,
        reason: `${pending?.label ?? pending?.tool ?? "这一步"} 要人审批，${resume.decision.actorName}拒绝了。理由：${resume.decision.note || "没有写理由"}`,
      })
    }
    // 登录页、验证码，人点了「处理不了」：重做还会停在同一个地方
    if (resume.declined) {
      keepPrevious()
      return end({}, {
        step: pending?.step ?? previous.steps,
        kind: "suspend",
        ...where,
        reason: `要人处理的事被点了「处理不了」${resume.declined.note ? `（${resume.declined.note}）` : ""}，没有重做这一步`,
      })
    }
    const lost = browserLost(journal?.rows ?? [], getBrowserManager()?.forSession(session.id)?.id)
    if (lost) {
      keepPrevious()
      return end({}, { step: previous.steps, kind: "resume_lost", reason: lost })
    }
  } else {
    await saveState(db, session.id, state)
    await appendEvent(db, session.id, {
      kind: "plan",
      title:
        mode === "test"
          ? `固化试跑：开始跑固化流程「${routine.name}」第 ${routine.version} 版的脚本`
          : `按固化流程「${routine.name}」第 ${routine.version} 版跑（脚本，不调执行模型）`,
    })
  }

  const bad = checkRoutineInput(routine.inputSchema, ctx.input)
  if (bad) return end({}, { step: 0, kind: "bad_input", reason: `输入不符合固化流程的要求：${bad}` })

  const config: SandboxConfig = { ...runtime.sandbox, memoryBytes: routineLimits.memoryBytes }
  const unavailable = await deps.unavailable(config)
  if (unavailable) return end({}, { step: 0, kind: "sandbox", reason: `沙箱没起来：${unavailable}` })

  const dirs = sessionDirs(config.dir, session.id)
  const codeDir = join(dirs.root, "routine")
  const toolsDir = join(dirs.root, "t")
  let prepared: Awaited<ReturnType<typeof prepareWorkspace>>
  try {
    await rm(codeDir, { recursive: true, force: true })
    await mkdir(join(codeDir, "node_modules"), { recursive: true })
    await mkdir(toolsDir, { recursive: true })
    await writeFile(join(codeDir, "routine.mjs"), routine.code)
    await writeLibraryModules(codeDir, libraryModules(snapshot))
    await cp(SDK_DIR, join(codeDir, "node_modules", "heyagent"), { recursive: true })
    const entries = await listSpace(db, session.id, snapshot.attachments.map((file) => file.id))
    prepared = await prepareWorkspace(dirs, entries, (entry) => readFileData(entry.row))
    await saveManifest(dirs, prepared.manifest)
  } catch (error) {
    return end({}, { step: 0, kind: "sandbox", reason: `沙箱没起来：准备代码目录时出错（${(error as Error).message}）` })
  }

  const kill = new AbortController()
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, kill.signal]) : kill.signal
  let graceTimer: NodeJS.Timeout | undefined
  const bridge = await ToolBridge.listen(join(toolsDir, TOOLS_SOCKET_NAME), {
    sessionId: session.id,
    gateway: ctx.gateway,
    state,
    mode,
    trial: routine.status === "trial",
    maxCalls: routineLimits.maxCalls,
    save: (value) => saveState(db, session.id, value),
    event: async (event) => {
      await appendEvent(db, session.id, event)
    },
    // 停下了：脚本一般马上退出；接住了 RoutineStop 还在跑的，过一会儿杀掉（取消的马上杀）
    onStop: (kind) => {
      if (kind === "cancelled") kill.abort()
      else graceTimer ??= setTimeout(() => kill.abort(), routineLimits.killGraceMs)
    },
    ...(journal ? { journal } : {}),
    ...(resume?.decision?.how === "approve" ? { approvedRuleIds: resume.decision.approvedRuleIds } : {}),
    browserInstanceId: () => getBrowserManager()?.forSession(session.id)?.id,
    // ha.judge：用这次运行的执行模型（试跑照常调；普通运行接着跑时按日志回记下的答案）
    judge: (request, trace) => judgeForRun({ db, session, snapshot, ...(ctx.signal ? { signal: ctx.signal } : {}) }, request, trace),
    ...(snapshot.libraryRoutines?.length ? { library: { routines: snapshot.libraryRoutines } } : {}),
    recordCall: callRecorder(db, session),
  })
  // 脚本一直不调工具时也能停：定时看运行有没有被取消
  const watcher = setInterval(() => {
    void ctx.gateway
      .stillRunning()
      .then((running) => (running ? undefined : bridge.stopWith("cancelled", "运行被取消了")))
      .catch(() => {})
  }, routineLimits.cancelCheckMs)
  let result: SandboxRunResult | undefined
  let runError: string | undefined
  try {
    result = await deps.runner({
      language: "node",
      script: LAUNCH_SCRIPT,
      args: [],
      stdin: JSON.stringify({ input: ctx.input }),
      timeoutSec: Math.ceil(timeoutMs() / 1000),
      workspaceDir: dirs.workspace,
      homeDir: dirs.home,
      codeDir,
      toolsDir,
      workspaceReadonly: true,
      readonlyDirs: prepared.readonlyDirs,
      config,
      signal,
    })
  } catch (error) {
    runError = (error as Error).message
  } finally {
    clearInterval(watcher)
    if (graceTimer) clearTimeout(graceTimer)
    // 最后一个请求可能还在处理（例如沙箱被杀时正在等工具）：等它处理完再定结局
    await bridge.idle()
    await bridge.close()
  }
  // 还没出来的库流程（停下了、脚本出错）：各记一行调用记录。worker 要退出的不记（下次进来按日志接着跑）
  if (!(ctx.signal?.aborted && !bridge.stopped)) await bridge.settleFrames()

  // worker 要退出：不定结局，sessions.routine 留在 running，下次进来按日志接着跑
  if (ctx.signal?.aborted && !bridge.stopped) return { state, aborted: true }

  if (bridge.stopped) return end(bridge.suspend ? { suspend: bridge.suspend } : bridge.approval && mode === "run" ? { approval: bridge.approval } : {})
  if (bridge.finish) return end({ finish: bridge.finish })
  if (mode === "test" && state.recorded?.finish) return end()
  const done = bridge.done
  if (done && !done.ok) {
    // 没接住的 StepError / Denied：停在那一步；别的是脚本自己的错
    const failure = bridge.lastFailure
    if (failure && (done.name === "StepError" || done.name === "Denied")) return end({}, failure)
    return end({}, { step: state.steps, kind: "script_error", reason: `脚本出错：${done.error ?? "没有说明"}` })
  }
  if (done?.ok) return end({}, { step: state.steps, kind: "script_error", reason: "脚本跑完了，但没调 ha.finish 报结果" })
  if (runError) return end({}, { step: state.steps, kind: "sandbox", reason: `沙箱没起来：${runError}` })
  if (result?.timedOut) return end({}, { step: state.steps, kind: "timeout", reason: `脚本跑了 ${Math.round(timeoutMs() / 60_000)} 分钟还没完，到上限了` })
  const stderr = result?.stderr.text.trim() ?? ""
  if (result && result.exitCode === 1 && /^bwrap: /.test(stderr)) return end({}, { step: state.steps, kind: "sandbox", reason: `沙箱没起来：${stderr.slice(0, 500)}` })
  return end({}, { step: state.steps, kind: "script_error", reason: `脚本没报完就退出了（退出码 ${result?.exitCode ?? "?"}）${stderr ? `：${stderr.slice(-500)}` : ""}` })
}
