// 某次运行的 session 详情：标题卡 + 没处理的「要人办的事」（每件一张处理面板，sessions/human-item.tsx，就在这里批 / 拒 / 登录）+ 结果（结束后，run-outcome.tsx：原因、谁定的、复核报告、改结果）/ 检查点 / 验收 / 总结和记忆（结束后）/ agent 的步骤 / 空间文件 / 过程。
// 右上角「空间文件」（run-space.tsx）弹窗按来源、名字筛这次运行的全部文件。
// M3：过程里标出规则命中、agent 写下步骤（plan.set）、上下文压缩；验收逐条显示结论和理由；agent 的步骤可以「存为任务步骤」（tasks.saveStepsFromSession）。
// 派活：meta 前面写怎么开始的（派活触发写清哪张单、谁派的）；被派来的加「派来的活」，派过活的加「派出去的活」（docs/dev/dispatch.md 9.4 节）。
// 运行代码（code.run）的步骤单独显示：语言、代码、退出码、stdout / stderr（格式见 docs/dev/session-space.md 3.2）；解析不了就退回通用的输入 / 输出。
// 不带页面级布局和返回链接，放进任何 768px 宽的抽屉都能用（任务页、Session 页的抽屉都直接放它）。
// 传进来的 run 是 sessions.list 的摘要（不带过程）：标题、检查点、验收先显示；过程按 id 另取（sessions.get），取到前是骨架屏。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { BrainIcon, ChevronRightIcon, CircleAlertIcon, CodeIcon, ListOrderedIcon, ScaleIcon, CircleCheckIcon, CircleStopIcon, EllipsisIcon, FlagIcon, FoldVerticalIcon, ListTreeIcon, PauseIcon, PlayIcon, SaveIcon, ScanSearchIcon, SearchXIcon, SendIcon, ShieldIcon, TriangleAlertIcon, UserIcon, WorkflowIcon, WrenchIcon, type LucideIcon } from "lucide-react"

import { OutcomeBadge } from "@/components/shell/outcome-badge"
import { DetailPanel, DetailSection, EmptyState } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { can, eventTimeText, fmtDateTime, isReviewing, isRunEnded, outcomeOf, outcomeReasonOf, WORK_DISPATCH_TOOL_ID } from "@heyagent/shared"
import type { RunEvent, RunEventKind, SessionSummary, TaskDef, Verification } from "@heyagent/shared"

import { CodeView } from "@/components/files"
import { MarkdownView } from "@/components/markdown"
import { useHumanItems, useModels, useSessionQuery, useStaffName, useToolName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"
import { ParamsTable, WorkItemBadge, shortName, timeText, workLink } from "./work-parts"

import { VerificationReport } from "./verification"
import { CheckpointList, Elapsed, RunStatusBadge, StepList, WaitingAlert, checkpointSummary, focusedCheckpoint, money } from "./parts"
import { HumanItemPanel } from "@/pages/sessions/human-item"

import { CancelRunDialog, eventOf, FireEventButton, isActive, ResumeButton } from "./run-actions"
import { RunBrowserButton } from "./run-browser"
import { RunDesktopButton } from "./run-desktop"
import { RunSpaceButton } from "./run-space"
import { RunDigestSection } from "./run-digest"
import { RunOutcomeSection } from "./run-outcome"
import { canSolidify, isRoutineTest, RoutineRunLine, SolidifyDialog } from "./run-routine"
import { CODE_RUN_TOOL_ID, fetchCallOf, groupScriptEvents, isErrorStep, judgeOf, parseToolsSummary, TOOLS_MARK } from "./run-script"

const EVENT_ICON: Record<RunEventKind, LucideIcon> = { plan: ListTreeIcon, think: BrainIcon, tool: WrenchIcon, checkpoint: FlagIcon, rule: ShieldIcon, wait: PauseIcon, resume: PlayIcon, human: UserIcon, verify: ScanSearchIcon, done: CircleCheckIcon, error: TriangleAlertIcon }

const num = (n: number) => n.toLocaleString("en-US")

/** 「8.4 秒 · 输入 21,800 / 输出 640 token」 */
const eventMeta = ({ ms, tokensIn, tokensOut }: RunEvent) => [
  ms !== undefined && (ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${ms} 毫秒`),
  tokensIn !== undefined && `输入 ${num(tokensIn)} / 输出 ${num(tokensOut ?? 0)} token`,
].filter(Boolean).join(" · ")

export function RunDetail({ task, run }: { task: TaskDef; run?: SessionSummary }) {
  const { user } = useMe()
  const { modelName } = useModels()
  const [cancelling, setCancelling] = React.useState(false)
  const [solidifying, setSolidifying] = React.useState(false)
  const detail = useSessionQuery(run?.id)
  const openItems = useHumanItems().filter((item) => run && item.runId === run.id)
  if (!run) return <EmptyState icon={<SearchXIcon />} title="找不到这次运行" description="可能是网址里的运行编号写错了。" />
  const events = detail.data?.events
  const toolCalls = events?.filter((event) => event.kind === "tool").length ?? 0
  const ruleHits = events?.filter((event) => event.kind === "rule").length ?? 0
  // 失败原因先用摘要里的标题，详情等过程取到再补上
  const error = run.status === "failed" && run.lastError ? { ...run.lastError, detail: events?.findLast((event) => event.kind === "error")?.detail } : undefined
  const ended = isRunEnded(run.status)
  const canManage = can(user, "task.manage", { ownerId: task.ownerId })
  const waitingEvent = run.status === "waiting" ? eventOf(run.waiting?.trigger) : undefined
  // 固化试跑：不复核、不算结果，不显示结果、总结这些；办成的普通运行能「固化成流程」
  const test = isRoutineTest(run)
  const solidify = canManage && canSolidify(run)
  return (
    <DetailPanel
      title={`${run.id} · ${task.title}`}
      badges={<><RunStatusBadge status={run.status} />{ended && !test && <OutcomeBadge outcome={outcomeOf(run)} reason={outcomeReasonOf(run)} reviewing={isReviewing(run)} />}{run.status === "running" && <span className="text-xs text-muted-foreground"><Elapsed since={run.startedAt} /></span>}</>}
      meta={<><RunMeta run={run} rest={`模型 ${modelName(run.modelId)} · 输入 ${num(run.tokensIn)} / 输出 ${num(run.tokensOut)} token · 花费 ${money(run.costUsd)} · 开始 ${fmtDateTime(run.startedAt)} · ${run.endedAt ? `结束 ${fmtDateTime(run.endedAt)}` : "还没结束"}`} /><RoutineRunLine run={run} /></>}
      actions={<>
        <RunSpaceButton run={run} />
        <RunBrowserButton run={run} />
        <RunDesktopButton run={run} />
        {run.status === "waiting" && can(user, "session.resume", { taskOwnerId: task.ownerId }) && <ResumeButton run={run} size="sm" />}
        {/* 在等事件的，主管可以手动触发这个事件（和外部系统推来一样） */}
        {waitingEvent && user.isAdmin && <FireEventButton event={waitingEvent} size="sm" />}
        {isActive(run) && canManage && (
          <Button variant="outline" size="sm" onClick={() => setCancelling(true)}><CircleStopIcon data-icon="inline-start" />取消运行</Button>
        )}
        {solidify && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="这次运行的更多操作" />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              <DropdownMenuItem onClick={() => setSolidifying(true)}><WorkflowIcon />{run.routine?.state === "fell_back" ? "重新固化" : "固化成流程"}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </>}
    >
      <CancelRunDialog key={`${run.id}-${cancelling}`} run={run} open={cancelling} onOpenChange={setCancelling} />
      {solidify && <SolidifyDialog key={`solidify-${run.id}-${solidifying}`} run={run} defaultSkipTest={Boolean(task.routineSkipTest)} open={solidifying} onOpenChange={setSolidifying} />}
      {openItems.map((item) => <HumanItemPanel key={item.id} item={item} inRun />)}
      <WaitingAlert run={run} />
      {error && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>这次运行出错：{error.title}</AlertTitle>
          {error.detail && <AlertDescription>{error.detail}</AlertDescription>}
        </Alert>
      )}
      {ended && !test && <RunOutcomeSection run={run} canEdit={canManage} />}
      {run.workItemId && <DispatchedIn run={run} itemId={run.workItemId} />}
      {task.toolIds.includes(WORK_DISPATCH_TOOL_ID) && <DispatchedOut run={run} events={events} />}
      <DetailSection title={`检查点 · ${checkpointSummary(run.checkpoints)}`}>
        <CheckpointList run={run} focused={detail.data && focusedCheckpoint(detail.data)} />
      </DetailSection>
      {run.verification && <VerificationSection run={run} verification={run.verification} />}
      {ended && !test && <RunDigestSection task={task} run={run} canEdit={canManage} />}
      {run.exploredSteps && run.exploredSteps.length > 0 && (
        <AgentSteps task={task} run={run} steps={run.exploredSteps} events={events} canSave={canManage} />
      )}
      <DetailSection
        title="过程"
        description={events
          ? `${events.length} 条记录 · 工具调用 ${toolCalls} 次${ruleHits ? ` · 规则命中 ${ruleHits} 次` : ""}${run.status === "running" ? " · 实时更新" : ""}。点工具调用看输入和输出。`
          : `${run.eventCount} 条记录`}
      >
        {events ? (
          <EventList events={events} run={run} />
        ) : detail.isError ? (
          <p className="text-muted-foreground">过程没取到，稍后再试。</p>
        ) : (
          <EventsSkeleton count={run.eventCount} />
        )}
      </DetailSection>
    </DetailPanel>
  )
}

/** 过程取到前的占位：最多 6 行 */
function EventsSkeleton({ count }: { count: number }) {
  return (
    <div className="flex flex-col gap-3">
      {Array.from({ length: Math.min(count, 6) }, (_, index) => <Skeleton key={index} className="h-4 w-full" />)}
    </div>
  )
}

/** 过程：agent 用 code.run（tools）写的脚本做的步骤收成一组，放在那次 code.run 下面（还在跑的单独一组） */
function EventList({ events, run }: { events: RunEvent[]; run: SessionSummary }) {
  const items = React.useMemo(() => groupScriptEvents(events), [events])
  const lastSeq = run.status === "running" ? events.at(-1)?.seq : undefined
  return (
    <Trace className="gap-3">
      {items.map((item) => item.kind === "script" ? (
        <ScriptSteps key={`script-${item.steps[0]!.seq}`} steps={item.steps} run={run} lastSeq={lastSeq} pending />
      ) : item.script ? (
        <div key={item.event.seq} className="flex flex-col gap-1">
          <EventRow event={item.event} run={run} running={item.event.seq === lastSeq} />
          <ScriptSteps steps={item.script} run={run} lastSeq={lastSeq} />
        </div>
      ) : (
        <EventRow key={item.event.seq} event={item.event} run={run} running={item.event.seq === lastSeq} />
      ))}
    </Trace>
  )
}

/** 一次 code.run 的脚本做的步骤：缩进一层、能收起；步骤多（超过 8 步）默认收起。pending = 还没等到那次 code.run 的结果（脚本还在跑，或者中断了） */
function ScriptSteps({ steps, run, lastSeq, pending = false }: { steps: RunEvent[]; run: SessionSummary; lastSeq?: number; pending?: boolean }) {
  const errors = steps.filter(isErrorStep).length
  const live = pending && lastSeq !== undefined && steps.some((step) => step.seq === lastSeq)
  return (
    <TraceCollapsible defaultOpen={pending || steps.length <= 8} className="pl-5.5">
      <TraceCollapsibleTrigger>
        <TraceLine status={live ? "running" : undefined}>
          <TraceIcon><ListOrderedIcon /></TraceIcon>
          <TraceTitle>{pending ? (live ? `脚本在跑，已经做了 ${steps.length} 步` : `脚本做的 ${steps.length} 步（没等到运行代码的结果）`) : `脚本做的 ${steps.length} 步`}</TraceTitle>
          {errors > 0 && <TraceDescription>出错 {errors} 次</TraceDescription>}
        </TraceLine>
      </TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <Trace className="gap-2">
          {steps.map((step) => <EventRow key={step.seq} event={step} run={run} running={step.seq === lastSeq} />)}
        </Trace>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

/** 过程里几类 M3 的事件加个小标签，一眼分清：规则命中、agent 写下步骤、上下文压缩、验收 */
function eventTag(event: RunEvent): { label: string; variant: "outline" | "secondary"; icon?: LucideIcon } | undefined {
  if (event.kind === "rule") return { label: "规则", variant: "outline" }
  // 轻量复核也写成 verify 事件，标题以「AI 复核」开头（「AI 复核：办成」「AI 复核出错：…」，run-outcome 5.2）
  if (event.kind === "verify" && event.title.startsWith("AI 复核")) return { label: "复核", variant: "outline" }
  if (event.kind === "verify") return { label: "验收", variant: "outline" }
  if (event.kind === "plan" && event.toolId === "plan.set") return { label: "步骤", variant: "secondary" }
  // 压缩也写成 plan 事件，按标题区分（api.md 11.6）
  if (event.kind === "plan" && event.title.startsWith("上下文压缩")) return { label: "压缩", variant: "secondary", icon: FoldVerticalIcon }
  return undefined
}

function EventRow({ event, run, running }: { event: RunEvent; run: SessionSummary; running: boolean }) {
  const toolName = useToolName()
  // 没办成的运行：结束事件（kind = done）用感叹号，不用打勾
  const outcome = outcomeOf(run)
  const Icon = event.kind === "done" && outcome && outcome !== "achieved" ? CircleAlertIcon : EVENT_ICON[event.kind]
  const at = eventTimeText(event.at, run)
  // 挂起 / 继续：用分隔线标出来，一眼看出 session 在哪停、在哪接着跑
  if (event.kind === "wait" || event.kind === "resume") {
    return (
      <Marker variant="separator" className="py-1">
        <MarkerIcon><Icon /></MarkerIcon>
        <MarkerContent className="flex flex-wrap items-center justify-center gap-2">
          <Badge variant={event.kind === "wait" ? "outline" : "secondary"}>{event.kind === "wait" ? "挂起" : "继续同一个 session"}</Badge>
          <span className="tabular-nums">{at}</span>
          <span className="text-foreground">{event.title.replace(/^挂起：/, "").replace(/，继续同一个 session$/, "")}</span>
        </MarkerContent>
      </Marker>
    )
  }
  const meta = eventMeta(event)
  const status = running ? "running" : event.kind === "error" ? "error" : undefined
  const routineBadge = event.trace?.routineStep && <Badge variant="outline">流程</Badge>
  // 固化流程里的判断（ha.judge）：一行写问题 → 答案，下面一行理由
  const judge = judgeOf(event)
  if (judge) {
    return (
      <div className="flex flex-col gap-0.5">
        <TraceLine status={status} title={event.title}>
          <TraceIcon><ScaleIcon /></TraceIcon>
          {routineBadge}
          <Badge variant="secondary">判断</Badge>
          <TraceTitle>{judge.question}</TraceTitle>
          {judge.answer && <><TraceDescription>→</TraceDescription><span className={judge.answer.length <= 12 ? "shrink-0 font-medium text-foreground" : "min-w-0 truncate font-medium text-foreground"}>{judge.answer}</span></>}
          <TraceDescription>{at}</TraceDescription>
          {meta && <TraceDescription className="hidden sm:inline">· {meta}</TraceDescription>}
        </TraceLine>
        {/* 窄屏上问题常被截断，下面再写一遍全文 */}
        <p className="pl-5.5 text-xs text-muted-foreground sm:hidden">问题：{judge.question}</p>
        {judge.reason && <p className="pl-5.5 text-xs text-muted-foreground">理由：{judge.reason}</p>}
        {event.detail && <p className="pl-5.5 text-xs whitespace-pre-line text-muted-foreground">{event.detail}</p>}
      </div>
    )
  }
  const tag = eventTag(event)
  const RowIcon = tag?.icon ?? Icon
  const scriptStep = event.trace?.scriptStep
  // 直接调网站接口：方法、路径和参数（悬停看完整网址）、状态码（2xx outline，4xx、5xx destructive）；出错的（没拿到返回）照常标出
  const fetchCall = fetchCallOf(event)
  const fetchFailed = !!fetchCall && isErrorStep(event)
  const line = (
    <TraceLine status={status ?? (fetchFailed ? "error" : undefined)}>
      <TraceIcon><RowIcon /></TraceIcon>
      {routineBadge}
      {scriptStep && <Badge variant="outline"><CodeIcon data-icon="inline-start" />脚本</Badge>}
      {tag && <Badge variant={tag.variant}>{tag.label}</Badge>}
      {fetchCall ? (
        <>
          <Badge variant="outline">{fetchCall.method}</Badge>
          <TraceTitle className="font-mono" title={fetchCall.url}>{scriptStep ? `第 ${scriptStep} 步 · ${fetchCall.path}` : fetchCall.path}</TraceTitle>
          {fetchCall.status !== undefined && <Badge variant={fetchCall.status >= 400 ? "destructive" : "outline"}>{fetchCall.status}</Badge>}
          {fetchFailed && <Badge variant="destructive">出错</Badge>}
        </>
      ) : <TraceTitle>{scriptStep ? `第 ${scriptStep} 步 · ${event.title}` : event.title}</TraceTitle>}
      <TraceDescription>{at}</TraceDescription>
      {meta && <TraceDescription className="hidden sm:inline">· {meta}</TraceDescription>}
    </TraceLine>
  )
  // agent 的答复、思考可能是 Markdown（列表、表格），按 Markdown 显示；写下步骤、验收、规则的说明是多行纯文字，保留换行
  const prose = event.kind === "done" || event.kind === "think"
  if (event.kind !== "tool") {
    return (
      <div className="flex flex-col gap-0.5">
        {line}
        {event.detail && (prose ? <MarkdownView className="pl-5.5 text-xs">{event.detail}</MarkdownView> : <p className="pl-5.5 text-xs whitespace-pre-line text-muted-foreground">{event.detail}</p>)}
      </div>
    )
  }
  const codeRun = event.toolId === CODE_RUN_TOOL_ID ? parseCodeRunInput(event.input) : undefined
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2 text-xs">
        <span>工具：{toolName(event.toolId ?? "")}（{event.toolId}）{meta && ` · ${meta}`}</span>
        {event.trace?.routineStep && <span className="text-muted-foreground">固化流程的脚本做的第 {event.trace.routineStep} 步</span>}
        {scriptStep && <span className="text-muted-foreground">agent 写的脚本（运行代码）做的第 {scriptStep} 步</span>}
        {event.detail && <span>{event.detail}</span>}
        {codeRun ? <CodeRunView call={codeRun} output={event.output} /> : (
          <>
            {event.input && <IoBlock title="输入" text={event.input} />}
            {event.output && <IoBlock title="输出" text={event.output} />}
          </>
        )}
        {event.trace?.code && <IoBlock title="录下的定位代码" text={event.trace.code} />}
        {event.trace?.urlAfter && event.trace.urlAfter !== event.trace.urlBefore && <span className="break-all text-muted-foreground">做完到了 {event.trace.title ? `「${event.trace.title}」 ` : ""}{event.trace.urlAfter}</span>}
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
}

const IoBlock = ({ title, text }: { title: string; text: string }) => (
  <CodeBlock size="sm">
    <CodeBlockHeader><CodeBlockTitle>{title}</CodeBlockTitle></CodeBlockHeader>
    <CodeBlockContent wrap>{text}</CodeBlockContent>
  </CodeBlock>
)

// ---------- 运行代码 ----------

const CODE_LANGUAGE = { python: { label: "Python", highlight: "python" }, node: { label: "Node.js", highlight: "javascript" }, bash: { label: "bash", highlight: "bash" } } as const

interface CodeRunCall {
  language: keyof typeof CODE_LANGUAGE
  code?: string
  file?: string
  args: string[]
  stdin?: string
  timeout?: number
  /** 脚本能调这次运行的工具（docs/dev/solidify.md 18.1） */
  tools: boolean
}

/** code.run 的输入（JSON 字符串）；不是预期的形状就返回 undefined，调用方退回通用显示 */
function parseCodeRunInput(raw: string | undefined): CodeRunCall | undefined {
  if (!raw) return undefined
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== "object" || value === null) return undefined
  const input = value as Record<string, unknown>
  const language = input.language
  if (typeof language !== "string" || !(language in CODE_LANGUAGE)) return undefined
  const code = typeof input.code === "string" ? input.code : undefined
  const file = typeof input.file === "string" ? input.file : undefined
  if (code === undefined && file === undefined) return undefined
  return {
    language: language as CodeRunCall["language"],
    code,
    file,
    args: Array.isArray(input.args) ? input.args.filter((arg): arg is string => typeof arg === "string") : [],
    stdin: typeof input.stdin === "string" && input.stdin ? input.stdin : undefined,
    timeout: typeof input.timeout === "number" ? input.timeout : undefined,
    tools: input.tools === true,
  }
}

interface CodeRunResult {
  /** 第一行拆开的几段：「退出码 0」「用时 1.2 秒」「超时（60 秒），整组进程已被杀掉」…… */
  summary: string[]
  /** 退出码；超时的也有（137）；起不了沙箱的没有 */
  exitCode?: number
  failed: boolean
  /** 「写回空间：…」「访问了：…」这类说明行 */
  notes: string[]
  stdout?: string
  stderr?: string
  /** 带工具的脚本：末尾「--- 脚本调的工具 ---」后面那几行（18.1） */
  tools?: string
}

const STDOUT_MARK = "--- stdout ---"
const STDERR_MARK = "--- stderr ---"

/** 按 3.2 的格式拆 code.run 的返回文本；第一行不是已知的几种就返回 undefined */
function parseCodeRunOutput(raw: string | undefined, withTools: boolean): CodeRunResult | undefined {
  if (!raw) return undefined
  const lines = raw.split("\n")
  const first = lines[0] ?? ""
  const sandboxFailed = first.startsWith("沙箱没起来")
  const timedOut = first.startsWith("超时（")
  const exit = /(?:^|· )退出码 (-?\d+)/.exec(first)
  if (!sandboxFailed && !timedOut && !exit) return undefined
  const exitCode = exit ? Number(exit[1]) : undefined
  const outAt = lines.indexOf(STDOUT_MARK)
  const errAt = lines.indexOf(STDERR_MARK, outAt + 1)
  // 工具汇总接在最后：取最后一个「--- 脚本调的工具 ---」（stdout 里碰巧有同样的一行，也是更早的那个）
  const toolsAt = withTools ? lines.lastIndexOf(TOOLS_MARK) : -1
  const marks = [outAt, errAt, toolsAt].filter((at) => at >= 0).sort((a, b) => a - b)
  const headEnd = marks[0] ?? lines.length
  const nextMark = (from: number) => marks.find((at) => at > from) ?? lines.length
  // stdout、stderr、工具汇总：标记行的下一行起，到下一个标记（或结尾）前
  const section = (from: number) => (from < 0 ? undefined : lines.slice(from + 1, nextMark(from)).join("\n").replace(/\n+$/, ""))
  const stdout = section(outAt)
  const stderr = section(errAt)
  const tools = section(toolsAt)?.trim()
  return {
    summary: sandboxFailed ? [first] : first.split(" · "),
    exitCode,
    failed: sandboxFailed || timedOut || (exitCode !== undefined && exitCode !== 0),
    notes: lines.slice(1, headEnd).filter((line) => line.trim()),
    stdout: stdout || undefined,
    stderr: stderr || undefined,
    tools: tools || undefined,
  }
}

/** 一次运行代码：语言和代码（或脚本路径）、标准输入，再是退出码 / 写回 / 访问的网站 / stdout / stderr */
function CodeRunView({ call, output }: { call: CodeRunCall; output: string | undefined }) {
  const language = CODE_LANGUAGE[call.language]
  const result = parseCodeRunOutput(output, call.tools)
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Badge variant="secondary">{language.label}</Badge>
        {call.file && <span>运行 <span className="font-mono">{call.file}</span></span>}
        {call.args.length > 0 && <span className="text-muted-foreground">参数 <span className="font-mono">{call.args.join(" ")}</span></span>}
        {call.timeout !== undefined && <span className="text-muted-foreground">最多跑 {call.timeout} 秒</span>}
        {call.tools && <span className="text-muted-foreground">脚本能调这次运行的工具</span>}
      </div>
      {call.code !== undefined && <CodeView code={call.code} language={language.highlight} title="代码" className="max-h-96" />}
      {call.stdin !== undefined && <IoBlock title="标准输入" text={call.stdin} />}
      {result ? (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {result.summary.map((part, index) => <CodeRunSummaryPart key={index} part={part} result={result} />)}
          </div>
          {result.notes.map((note, index) => <span key={index} className="text-muted-foreground">{note}</span>)}
          {result.stdout && <IoBlock title="stdout" text={result.stdout} />}
          {result.stderr && <IoBlock title="stderr" text={result.stderr} />}
          {result.tools && <ScriptToolsSummary text={result.tools} />}
        </>
      ) : (
        output && <IoBlock title="输出" text={output} />
      )}
    </>
  )
}

/** 第一行里的一段：退出码是徽章（0 = 通过，别的 = 失败），超时、沙箱没起来是失败徽章，用时之类是灰字 */
function CodeRunSummaryPart({ part, result }: { part: string; result: CodeRunResult }) {
  if (/^退出码 /.test(part)) {
    return result.failed
      ? <Badge variant="destructive">{part}</Badge>
      : <Badge variant="outline"><CircleCheckIcon data-icon="inline-start" />{part}</Badge>
  }
  if (part.startsWith("超时（") || part.startsWith("沙箱没起来")) return <Badge variant="destructive">{part}</Badge>
  return <span className="text-muted-foreground">{part}</span>
}

/** 带工具的脚本调了哪些工具：「脚本调了 n 次工具」一个徽章，后面每个工具几次；停在第 k 步单独一行 */
function ScriptToolsSummary({ text }: { text: string }) {
  const summary = parseToolsSummary(text)
  return (
    <div className="flex flex-col gap-1">
      {summary.head && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <Badge variant="outline"><WrenchIcon data-icon="inline-start" />{summary.head}</Badge>
          {summary.counts.map((part, index) => <span key={index}>{part}</span>)}
        </div>
      )}
      {summary.stops.map((stop, index) => (
        <div key={index} className="flex flex-wrap items-center gap-2">
          <Badge variant="destructive">{stop.head}</Badge>
          {stop.rest && <span>{stop.rest}</span>}
        </div>
      ))}
      {summary.others.map((line, index) => <span key={index} className="text-muted-foreground">{line}</span>)}
    </div>
  )
}

/** agent 用「写下步骤」（plan.set）定的最后一版步骤；负责人或主管可以整体覆盖到任务的步骤里 */
function AgentSteps({ task, run, steps, events, canSave }: { task: TaskDef; run: SessionSummary; steps: string[]; events?: RunEvent[]; canSave: boolean }) {
  const [confirming, setConfirming] = React.useState(false)
  const save = useAction(trpc.tasks.saveStepsFromSession.mutationOptions({ onSuccess: () => setConfirming(false) }), {
    success: (result) => `已存为任务 ${result.id} 的步骤（${result.steps.length} 步），下一次运行照这些步骤做`,
    errorTitle: "没存成",
  })
  const same = task.steps.length === steps.length && task.steps.every((step, index) => step.text === steps[index])
  const updates = events?.filter((event) => event.kind === "plan" && event.toolId === "plan.set").length ?? 0
  const checkpoints = task.steps.filter((step) => step.checkpoint).length
  const saveNow = () => save.mutate({ sessionId: run.id })
  return (
    <DetailSection
      title="agent 的步骤"
      description={`agent 用「写下步骤」定的做法，这是最后一版${updates > 1 ? `（中途改过 ${updates - 1} 次）` : ""}。${same ? "任务的步骤已经是这一版了。" : "觉得好，可以存为任务步骤，以后照着做。"}`}
      action={canSave && !same && (
        <Button variant="outline" size="sm" disabled={save.isPending} onClick={() => (task.steps.length > 0 ? setConfirming(true) : saveNow())}>
          {save.isPending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}存为任务步骤
        </Button>
      )}
    >
      <StepList steps={steps} />
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>用 agent 的 {steps.length} 步覆盖任务现在的 {task.steps.length} 步？</AlertDialogTitle>
            <AlertDialogDescription>
              任务 {task.id} 现在的步骤会整体换掉{checkpoints > 0 ? `，原来步骤上的 ${checkpoints} 个检查点也会一起去掉（之后可以在编辑任务里重新勾）` : ""}。从下一次运行开始生效，正在跑的不受影响；改动记在审计里。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不存</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={save.isPending} onClick={saveNow}>覆盖任务步骤</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSection>
  )
}

const VERDICT = { passed: "通过", asking: "在反问", disputed: "有争议，交给人" } as const

function VerificationSection({ run, verification }: { run: SessionSummary; verification: Verification }) {
  const { modelName, defaults } = useModels()
  const model = modelName(verification.modelId ?? defaults.verify)
  return (
    <DetailSection
      title={`验收 · ${VERDICT[verification.status]}`}
      description={`三方 AI（${model}，不参与执行）逐条核对检查点${verification.round ? ` · 第 ${verification.round} 轮` : ""} · ${eventTimeText(verification.at, run)}`}
    >
      <VerificationReport verification={verification} />
    </DetailSection>
  )
}

// ---------- 派活 ----------

const SOURCE_TEXT: Record<string, string> = { manual: "手动触发", cron: "定时触发", todo: "人加的待办触发", event: "外部事件触发", dispatch: "派活触发" }

/** meta 一行：怎么开始的（派活触发写清是哪张单、谁派的，两个都是链接）+ 原来的模型、token、花费、时间 */
function RunMeta({ run, rest }: { run: SessionSummary; rest: string }) {
  const staffName = useStaffName()
  const item = useQuery(trpc.work.get.queryOptions({ id: run.workItemId ?? "" }, { enabled: Boolean(run.workItemId) })).data
  const source = run.source && SOURCE_TEXT[run.source]
  if (!run.workItemId) return <>{source ? `${source} · ` : ""}{rest}</>
  return (
    <span className="inline-flex flex-wrap items-center gap-x-1">
      <SendIcon className="size-3" />
      派活触发 ·
      <a className="font-mono underline underline-offset-4" href={workLink({ id: run.workItemId, taskId: run.taskId })}>{run.workItemId}</a>
      {item && (item.via === "agent" && item.fromTaskId ? (
        <>
          · 来自「{shortName(item.fromTaskTitle)}」
          {item.fromSessionId && <a className="font-mono underline underline-offset-4" href={href("sessions", { id: item.fromSessionId })}>{item.fromSessionId}</a>}
        </>
      ) : (
        <>· {staffName(item.fromUserId ?? undefined)}手动派的</>
      ))}
      <span>· {rest}</span>
    </span>
  )
}

/** 被派来的运行：派来的活（单号、标题、状态、参数表），在检查点上面 */
function DispatchedIn({ run, itemId }: { run: SessionSummary; itemId: string }) {
  const detail = useQuery(trpc.work.get.queryOptions({ id: itemId }))
  const item = detail.data
  const nth = item ? item.runs.findIndex((each) => each.sessionId === run.id) + 1 : 0
  return (
    <DetailSection
      title="派来的活"
      description="这次运行是别的任务派来办一件事的，参数在第一条消息里交给了 agent。办完的总结会写回派活单。"
      action={<Button variant="outline" size="sm" nativeButton={false} render={<a href={workLink({ id: itemId, taskId: run.taskId })} />}>看派活单 {itemId}</Button>}
    >
      {detail.isPending ? (
        <Spinner />
      ) : !item ? (
        <p className="text-muted-foreground">派活单 {itemId} 没取到，稍后再试。</p>
      ) : (
        <div className="flex flex-col gap-2">
          <p className="flex flex-wrap items-center gap-2">
            <span className="font-mono">{item.id}</span>
            {item.title}
            <WorkItemBadge item={item} reason />
            {item.runs.length >= 2 && nth > 0 && <Badge variant="outline">这是第 {nth} 次</Badge>}
          </p>
          <ParamsTable declared={item.taskDispatch?.params ?? []} values={item.params} />
          {item.note && <p><span className="text-muted-foreground">补充说明：</span>{item.note}</p>}
        </div>
      )}
    </DetailSection>
  )
}

/** 派过活的运行：派出去的活，每行一张单，点了在被派任务的抽屉里看那张单 */
function DispatchedOut({ run, events }: { run: SessionSummary; events?: RunEvent[] }) {
  const page = useQuery(trpc.work.list.queryOptions({ fromSessionId: run.id, days: 0, limit: 200 }))
  const list = page.data?.items ?? []
  const called = events?.some((event) => event.toolId === WORK_DISPATCH_TOOL_ID)
  return (
    <DetailSection
      title={`派出去的活（新建 ${page.data?.counts.all ?? list.length} 张）`}
      description="这次运行用内置工具「派活」派出去的单。已经有单的同一件事不会重复建，只在过程里的「派活」调用返回现状。"
    >
      {page.isPending || (!list.length && !events) ? (
        <Spinner />
      ) : list.length ? (
        <ItemGroup className="gap-2">
          {list.map((item) => (
            <Item key={item.id} variant="outline" size="sm" render={<a href={workLink(item)} />}>
              <ItemContent className="min-w-0">
                <ItemTitle><span className="font-mono">{item.id}</span>{item.title}</ItemTitle>
                <ItemDescription className="line-clamp-1">派给「{item.taskTitle}」 · {timeText(item.createdAt)}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <WorkItemBadge item={item} />
                <ChevronRightIcon className="size-4 text-muted-foreground" />
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      ) : (
        <p className="text-muted-foreground">{called ? "这次没有新派的单：查到的单都已经有了（见过程里「派活」那一步的输出）。" : "这次没有派活。"}</p>
      )}
    </DetailSection>
  )
}
