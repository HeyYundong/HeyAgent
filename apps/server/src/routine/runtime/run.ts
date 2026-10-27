// 跑固化脚本（docs/dev/solidify.md 4.3、6.3、15.2 第 4、5 条）：按 inputSchema 校验输入 → 准备沙箱的代码目录
// （routine.mjs + node_modules/heyagent/ 里的 SDK，跑的时候拷进去，不用重建镜像）→ 起工具桥 → 在沙箱里跑 launch.js
// → 按工具桥记下的结果定这次脚本的结局，写进 sessions.routine。
// 沙箱用 code.run 的同一套（sandbox/runner.ts），但不挂出网代理（脚本不能上网，和外面打交道只能经过工具桥），
// 空间文件只读挂在 /workspace，内存 512 MB。上限：一次最多 1000 次工具调用、默认 10 分钟（要小于 runtime.maxRunMs）。
// 这里只跑脚本、定结局；接下来怎么收尾（报结果、交给 agent、挂起）由引擎（engine/loop.ts）做。
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"

import { routineStopKindLabel, type RoutineSnapshot, type SessionRoutineState, type SessionSnapshot } from "@heyagent/shared"
import { eq } from "drizzle-orm"
import { z } from "zod"

import type { Db } from "../../db/client.js"
import * as t from "../../db/schema.js"
import { listSpace, readFileData } from "../../files/service.js"
import type { ToolGateway } from "../../engine/gateway.js"
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
import { ToolBridge, type BridgeGateway } from "./bridge.js"

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
}

export interface RoutineRunResult {
  /** 最终的脚本状态（已经写进 sessions.routine） */
  state: SessionRoutineState
  /** 普通运行：脚本报的结果（run.finish 真调过，引擎照常收尾） */
  finish?: AgentClaim
  /** 要挂起：交接的话和挂起在同一个事务里落库 */
  suspend?: { plan: SuspendPlan; output: string }
  /** worker 要退出（signal）：脚本被杀，sessions.routine 还是 running，下次进来算中断 */
  aborted?: boolean
}

async function saveState(db: Db, sessionId: string, state: SessionRoutineState) {
  await db.update(t.sessions).set({ routine: state }).where(eq(t.sessions.id, sessionId))
}

/** 输入按 inputSchema 校验：不合格返回原因；schema 是空的、写得解析不了（程序检查管）就不校验 */
export function checkRoutineInput(schema: Record<string, unknown>, input: Record<string, unknown>): string | undefined {
  if (Object.keys(schema).length === 0) return undefined
  let validator: z.ZodType
  try {
    validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
  } catch {
    return undefined
  }
  const parsed = validator.safeParse(input)
  if (parsed.success) return undefined
  return parsed.error.issues
    .slice(0, 5)
    .map((issue) => `${issue.path.join(".") || "输入"}：${issue.message}`)
    .join("；")
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`

/** 跑一遍脚本。普通运行：sessions.routine 为空时才跑；试跑：每次进来都从头跑 */
export async function runRoutineScript(ctx: RoutineRunContext): Promise<RoutineRunResult> {
  const { db, session, snapshot, mode } = ctx
  const routine = snapshot.routine
  const started = Date.now()
  const state: SessionRoutineState = {
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
  await saveState(db, session.id, state)
  await appendEvent(db, session.id, {
    kind: "plan",
    title:
      mode === "test"
        ? `固化试跑：开始跑固化流程「${routine.name}」第 ${routine.version} 版的脚本`
        : `按固化流程「${routine.name}」第 ${routine.version} 版跑（脚本，不调执行模型）`,
  })

  const end = async (patch: Partial<RoutineRunResult> = {}, stop?: SessionRoutineState["stoppedAt"]): Promise<RoutineRunResult> => {
    if (stop && !state.stoppedAt) state.stoppedAt = stop
    const finished = Boolean(patch.finish) || (mode === "test" && Boolean(state.recorded?.finish) && !state.stoppedAt)
    state.state = finished ? "finished" : mode === "test" || ["cancelled", "input"].includes(state.stoppedAt?.kind ?? "") ? "stopped" : "fell_back"
    // 试跑：停下、跑完时截一张图（试跑报告「停下时的截图」）
    if (mode === "test") {
      const shot = await ctx.gateway.screenshot().catch(() => undefined)
      if (shot) state.screenshotFileId = shot.fileId
    }
    state.endedAt = new Date().toISOString()
    state.ms = Date.now() - started
    await saveState(db, session.id, state)
    const stopped = state.stoppedAt
    await appendEvent(db, session.id, {
      kind: stopped && !finished ? (stopped.kind === "test_commit" || stopped.kind === "test_blocked" ? "plan" : "error") : "plan",
      title: finished
        ? `固化流程跑完了：${state.steps} 步 · ${seconds(state.ms)}`
        : `固化流程停在第 ${stopped?.step ?? state.steps} 步：${routineStopKindLabel[stopped?.kind ?? "script_error"]}`,
      detail: stopped && !finished ? stopped.reason : null,
      ...(state.stoppedAt?.step ? { trace: { routineStep: state.stoppedAt.step } } : {}),
    })
    return { state, ...patch }
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

  // worker 要退出：不定结局，sessions.routine 留在 running，下次进来按中断交给 agent
  if (ctx.signal?.aborted && !bridge.stopped) return { state, aborted: true }

  if (bridge.stopped) return end(bridge.suspend ? { suspend: bridge.suspend } : {})
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
