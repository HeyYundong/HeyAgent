// 库流程当工具给 agent 调（docs/dev/routine-library.md 5.1、5.2、5.5）。
// 网关（engine/gateway.ts）给 snapshot.libraryRoutines 里 selected、没有 unavailable 的每个库流程一个工具：
// 名字 safeName("routine.<短名>")，参数 toolSchemaOf(inputSchema).jsonSchema，执行是这里的 executeLibraryTool：
// 1. inputOfToolArgs 转回脚本的输入（attachments 按调用方能读的文件展开），再按 inputSchema 校验，不合格当场出错、不起沙箱；
// 2. 起沙箱（同固化脚本：不挂出网代理，/workspace 只读），代码目录放这个库流程（routine.mjs）、它调的库流程（routines/<短名>.mjs，snapshot.ts 的 libraryModules）、SDK；
// 3. 起工具桥 mode = tool：每一步 gateway.call()，调用 id `<这次的调用 id>-l<步>`，trace.library（callId = 这次的调用 id，depth 1）；
//    要审批 → 停在它前面、不发起审批（同 browser.batch）；会改东西的 browser.fetch 前要有自己的 ha.commit（库流程都是固化脚本，19.5 的规矩照用）；
//    ha.finish / ha.work.report 收进交回值，ha.checkpoint.mark 不做（过程里记一句「库流程里的检查点不算」）；不记重放日志；
// 4. 结局：报了结果 → 交回值（routineReturnSchema，文字 + data；not_achieved 不算出错）；ha.fail("input") → 出错「输入有问题：…」；
//    别的停下 → 出错，文字是交接的话（handoff.ts 的步骤行按 trace.library.callId 取），data 是 routineToolStopDataSchema；
//    要挂起 → 同 code.run（tools）：结果带 suspend、signals、facts，引擎照常挂起，库流程不接着跑（交接的话里写清停在哪）；
// 5. 上限：routineLimits 的次数、时间，时间还要压在这次运行剩下的时间里；
// 6. 每次调用写一行 routine_calls（stats.ts 的 recordRoutineCall，via = tool）；里面再调的一层由工具桥记（via = script）。
// 工具结果的文字最后一行是交回值 / 停下的 data 的 JSON（网页 run-script.ts 按它显示结局）；过程记录那一条的 trace.libraryCall 由网关写。
import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"

import {
  inputOfToolArgs,
  routineStopKindLabel,
  toolSchemaOf,
  type LibraryRoutineSnapshot,
  type RoutineCallerFile,
  type RoutineReturn,
  type RoutineStop,
  type RoutineToolStopData,
  type SessionRoutineState,
  type SessionSnapshot,
} from "@heyagent/shared"

import type { Db } from "../../db/client.js"
import { listSpace, readFileData } from "../../files/service.js"
import type { ToolGateway } from "../../engine/gateway.js"
import { appendEvent } from "../../engine/records.js"
import { runtime, type SandboxConfig } from "../../engine/runtime.js"
import type { SessionRow, ToolOutcome } from "../../engine/tools/builtin.js"
import { TOOLS_SOCKET_NAME, type SandboxRunResult } from "../../sandbox/runner.js"
import { prepareWorkspace, saveManifest, sessionDirs } from "../../sandbox/workspace.js"
import { checkRoutineInput, returnDataText, ToolBridge } from "../runtime/bridge.js"
import { commitLines, libraryStepLines } from "../runtime/handoff.js"
import { judgeForRun } from "../runtime/judge.js"
import { callRecorder, LAUNCH_SCRIPT, routineLimits, routineSandboxDeps, SDK_DIR, writeLibraryModules } from "../runtime/run.js"
import { libraryModules } from "./snapshot.js"
import { recordRoutineCall, type NewRoutineCall } from "./stats.js"

export interface LibraryToolContext {
  db: Db
  session: SessionRow
  snapshot: SessionSnapshot
  /** 调用方这次运行的网关：库流程里的每一步都走它（同 code.run 带 tools 的 scriptTools.gateway） */
  gateway: ToolGateway
  /** 这次运行还剩多少毫秒（上限按 routineLimits.timeoutMs 和它取小的） */
  remainingMs: () => number
  /** 调用方能读的文件（attachments 展开用）：快照的附件 + 这次运行的产物 */
  files: () => Promise<RoutineCallerFile[]>
  signal?: AbortSignal
}

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} 秒`
/** 给模型的工具名（网关的规则：点换成下划线） */
const modelToolName = (toolId: string) => toolId.replace(/[^A-Za-z0-9_-]/g, "_")

/** 网关执行 routine.<短名>：args 是模型给的参数（已经按 toolSchemaOf 的 JSON Schema 校验过），call 是这次的模型工具调用 */
export async function executeLibraryTool(
  ctx: LibraryToolContext,
  routine: LibraryRoutineSnapshot,
  args: Record<string, unknown>,
  call: { toolCallId: string }
): Promise<ToolOutcome> {
  const { db, session, snapshot } = ctx
  const started = Date.now()
  const head = `流程「${routine.name}」第 ${routine.version} 版`
  const record = (patch: Pick<NewRoutineCall, "result" | "stopKind" | "stopStep" | "stopReason"> & { steps?: number }) =>
    recordRoutineCall(db, {
      routineId: routine.routineId,
      version: routine.version,
      sessionId: session.id,
      taskId: session.taskId,
      callId: call.toolCallId,
      via: "tool",
      depth: 1,
      steps: 0,
      ms: Date.now() - started,
      ...patch,
    }).catch((error: unknown) => console.warn("[routine] 写调用记录出错", error))

  // 1. 模型给的参数 → 脚本的输入，按 inputSchema 再校验一次
  const { params } = toolSchemaOf(routine.inputSchema)
  const converted = inputOfToolArgs(args, params, await ctx.files())
  const bad = converted.ok ? checkRoutineInput(routine.inputSchema, converted.input) : converted.error
  if (!converted.ok || bad) {
    const reason = bad ?? "输入不对"
    await record({ result: "bad_input", stopKind: "bad_input", stopStep: 0, stopReason: reason })
    return { output: `输入有问题：${reason}（${head}没有跑，没改任何东西）`, isError: true }
  }
  const input = converted.input

  // 2. 沙箱：代码目录放这个库流程、它调的库流程、SDK；空间文件只读
  const deps = routineSandboxDeps()
  const config: SandboxConfig = { ...runtime.sandbox, memoryBytes: routineLimits.memoryBytes }
  const fail = async (reason: string): Promise<ToolOutcome> => {
    await record({ result: "stopped", stopKind: "sandbox", stopStep: 0, stopReason: reason })
    return { output: `${head}没有跑：沙箱没起来（${reason}）。请你自己一步步做。`, isError: true }
  }
  const unavailable = await deps.unavailable(config)
  if (unavailable) return fail(unavailable)
  const dirs = sessionDirs(config.dir, session.id)
  const codeDir = join(dirs.root, "lib")
  const toolsDir = join(dirs.root, "tl")
  let prepared: Awaited<ReturnType<typeof prepareWorkspace>>
  try {
    await rm(codeDir, { recursive: true, force: true })
    await mkdir(join(codeDir, "node_modules"), { recursive: true })
    await mkdir(toolsDir, { recursive: true })
    await writeFile(join(codeDir, "routine.mjs"), routine.code)
    await writeLibraryModules(codeDir, libraryModules(snapshot, routine.slug))
    await cp(SDK_DIR, join(codeDir, "node_modules", "heyagent"), { recursive: true })
    const entries = await listSpace(db, session.id, snapshot.attachments.map((file) => file.id))
    prepared = await prepareWorkspace(dirs, entries, (entry) => readFileData(entry.row))
    await saveManifest(dirs, prepared.manifest)
  } catch (error) {
    return fail(`准备代码目录时出错：${(error as Error).message}`)
  }

  // 3. 工具桥 mode = tool：每一步回到调用方的网关
  const state: SessionRoutineState = {
    routineId: routine.routineId,
    versionId: routine.versionId,
    version: routine.version,
    mode: "run",
    state: "running",
    startedAt: new Date(started).toISOString(),
    steps: 0,
    commits: [],
    input,
  }
  const kill = new AbortController()
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, kill.signal]) : kill.signal
  let graceTimer: NodeJS.Timeout | undefined
  const bridge = await ToolBridge.listen(join(toolsDir, TOOLS_SOCKET_NAME), {
    sessionId: session.id,
    gateway: ctx.gateway,
    state,
    mode: "tool",
    trial: false,
    maxCalls: routineLimits.maxCalls,
    save: async () => {},
    event: async (event) => {
      await appendEvent(db, session.id, event)
    },
    onStop: (kind) => {
      if (kind === "cancelled") kill.abort()
      else graceTimer ??= setTimeout(() => kill.abort(), routineLimits.killGraceMs)
    },
    judge: (request, trace) => judgeForRun({ db, session, snapshot, ...(ctx.signal ? { signal: ctx.signal } : {}) }, request, trace),
    library: { routines: snapshot.libraryRoutines ?? [], root: { routine, callId: call.toolCallId } },
    recordCall: callRecorder(db, session),
  })
  const watcher = setInterval(() => {
    void ctx.gateway
      .stillRunning()
      .then((running) => (running ? undefined : bridge.stopWith("cancelled", "运行被取消了")))
      .catch(() => {})
  }, routineLimits.cancelCheckMs)
  // 时间：固化脚本的上限，还要压在这一轮运行剩下的时间里（留半分钟给引擎收尾）
  const timeoutMs = Math.max(30_000, Math.min(routineLimits.timeoutMs, ctx.remainingMs() - 30_000))
  let result: SandboxRunResult | undefined
  let runError: string | undefined
  try {
    result = await deps.runner({
      language: "node",
      script: LAUNCH_SCRIPT,
      args: [],
      stdin: JSON.stringify({ input, library: { slug: routine.slug } }),
      timeoutSec: Math.ceil(timeoutMs / 1000),
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
    await bridge.idle()
    await bridge.close()
    // 里面再调的一层没出来的（停在里面了）：各记一行
    await bridge.settleFrames()
  }

  // 4. 结局
  const ms = Date.now() - started
  const steps = bridge.rootFrame?.steps ?? state.steps
  const end = bridge.done?.routine
  const pageLines = () => ctx.gateway.pageLines()

  // 报了结果：交回值（没办成不算出错）
  if (!bridge.stopped && end?.end === "finished" && end.finish) {
    const value: RoutineReturn = {
      routine: routine.slug,
      name: routine.name,
      version: routine.version,
      outcome: end.finish.outcome,
      summary: end.finish.summary,
      ...(end.finish.evidence ? { evidence: end.finish.evidence } : {}),
      ...(end.finish.reason ? { reason: end.finish.reason } : {}),
      data: end.data ?? {},
    }
    await record({ result: value.outcome, steps })
    const data = returnDataText(value.data, 2000)
    const lines = [
      `${head}跑完了：${steps} 步 · ${seconds(ms)}。`,
      `结果：${value.outcome === "achieved" ? "办成" : "没办成"}。${value.summary}`,
      ...(value.evidence ? [`依据：${value.evidence}`] : []),
      ...(value.reason ? [`原因：${value.reason}`] : []),
      ...(data ? [`交回：${data}`] : []),
      ...(await pageLines()),
      // 最后一行是交回值的 JSON（routineReturnSchema）：网页按它显示结局
      JSON.stringify(value),
    ]
    return { output: lines.join("\n"), data: value }
  }

  // 库流程自己说输入有问题（ha.fail("input")）
  if (!bridge.stopped && end?.end === "failed" && end.kind === "input") {
    const reason = end.error || "输入有问题"
    await record({ result: "bad_input", stopKind: "input", stopStep: steps, stopReason: reason, steps })
    return {
      output: `输入有问题：${reason}${state.commits.length ? `\n${commitLines(state).join("\n")}` : "（流程没改任何东西）"}`,
      isError: true,
    }
  }

  // 停下了：交接的话
  const stop: RoutineStop = bridge.stopped ?? stopOf()
  function stopOf(): RoutineStop {
    if (end?.end === "failed") return { step: steps, kind: "page", reason: end.error || routineStopKindLabel.page }
    if (end?.end === "error") {
      const failure = bridge.lastFailure
      if (failure && (end.name === "StepError" || end.name === "Denied")) return failure
      return { step: steps, kind: "script_error", reason: `脚本出错：${end.error ?? "没有说明"}` }
    }
    if (runError) return { step: steps, kind: "sandbox", reason: `沙箱没起来：${runError}` }
    if (result?.timedOut) return { step: steps, kind: "timeout", reason: `跑了 ${Math.round(timeoutMs / 1000)} 秒还没完，到上限了` }
    const stderr = result?.stderr.text.trim() ?? ""
    return { step: steps, kind: "script_error", reason: `脚本没报完就退出了（退出码 ${result?.exitCode ?? "?"}）${stderr ? `：${stderr.slice(-500)}` : ""}` }
  }
  await record({ result: stop.kind === "input" ? "bad_input" : "stopped", stopKind: stop.kind, stopStep: stop.step, stopReason: stop.reason, steps })
  const stepLines = await libraryStepLines(db, session.id, call.toolCallId)
  const where = stop.label ? `${stop.label}：` : ""
  const lines = [`${head}做到第 ${stop.step} 步停下，没跑完（${routineStopKindLabel[stop.kind]}）：`, ...stepLines]
  if (stop.kind !== "step_error" || !stepLines.length) lines.push(`停下的原因：${where}${stop.reason}`)
  lines.push(...commitLines(state))
  if (!bridge.suspend) lines.push(...(await pageLines()))
  if (stop.kind === "approval")
    lines.push(
      `第 ${stop.step} 步${stop.label ? ` ${stop.label}` : ""}要人审批，库流程里不做要审批的动作，没做：你单独调用这一步（${stop.tool ? modelToolName(stop.tool) : "那个工具"}，会照常交给人审批），再接着做后面的，前面做过的不要重复。`
    )
  else if (bridge.suspend) lines.push("运行要挂起等人处理；处理好以后流程不会接着跑：先看页面现在的样子，从停下的地方接着把这件事做完，前面做过的不要重复。")
  else if (stop.kind === "denied") lines.push("被规则拦下的这一步不要换个办法绕过去做；请按规则调整做法，再接着把这件事做完，前面做过的不要重复。")
  else lines.push("请从现在的页面接着把这件事做完，前面做过的不要重复。同样的输入不要再调这个流程。")
  const data: RoutineToolStopData = {
    routine: routine.slug,
    name: routine.name,
    version: routine.version,
    steps,
    stoppedAt: stop,
    commits: state.commits,
  }
  // 最后一行是停下的 data 的 JSON（routineToolStopDataSchema）：网页按它显示停在哪
  lines.push(JSON.stringify(data))
  const suspend = bridge.suspend
  if (!suspend) return { output: lines.join("\n"), isError: true, data }
  // 停在要挂起的那一步（验证码、登录页……）：带出挂起计划，引擎照常挂起；那一步已经过了调工具后的钩子（nested）
  return {
    output: lines.join("\n"),
    data,
    suspend: suspend.plan,
    ...(suspend.signals ? { signals: suspend.signals } : {}),
    ...(suspend.facts ? { facts: suspend.facts } : {}),
    nested: {},
  }
}
