// 某次运行的 session 详情：标题卡 + 检查点 / 过程 / 验收 / agent 的步骤。
// M3：过程里标出规则命中、agent 写下步骤（plan.set）、上下文压缩；验收逐条显示结论和理由；agent 的步骤可以「存为任务步骤」（tasks.saveStepsFromSession）。
// 不带页面级布局和返回链接，放进任何 768px 宽的抽屉都能用（任务页、Session 页的抽屉都直接放它）。
import * as React from "react"
import { BrainIcon, CircleCheckIcon, CircleStopIcon, FlagIcon, FoldVerticalIcon, ListTreeIcon, PauseIcon, PlayIcon, SaveIcon, ScanSearchIcon, SearchXIcon, ShieldIcon, TriangleAlertIcon, UserIcon, WrenchIcon, type LucideIcon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Spinner } from "@/components/ui/spinner"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { can, eventTimeText, fmtDateTime } from "@heyagent/shared"
import type { RunEvent, RunEventKind, SessionRun, TaskDef, Verification } from "@heyagent/shared"

import { MarkdownView } from "@/components/markdown"
import { useHumanItems, useModels, useToolName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { VerificationReport } from "./verification"
import { CheckpointGrid, Elapsed, RunStatusBadge, StepList, WaitingAlert, checkpointSummary, money } from "./parts"
import { CancelRunDialog, isActive, ResumeButton, SessionFiles } from "./run-actions"
import { RunBrowserButton } from "./run-browser"

const EVENT_ICON: Record<RunEventKind, LucideIcon> = { plan: ListTreeIcon, think: BrainIcon, tool: WrenchIcon, checkpoint: FlagIcon, rule: ShieldIcon, wait: PauseIcon, resume: PlayIcon, human: UserIcon, verify: ScanSearchIcon, done: CircleCheckIcon, error: TriangleAlertIcon }

const num = (n: number) => n.toLocaleString("en-US")

/** 「8.4 秒 · 输入 21,800 / 输出 640 token」 */
const eventMeta = ({ ms, tokensIn, tokensOut }: RunEvent) => [
  ms !== undefined && (ms >= 1000 ? `${(ms / 1000).toFixed(1)} 秒` : `${ms} 毫秒`),
  tokensIn !== undefined && `输入 ${num(tokensIn)} / 输出 ${num(tokensOut ?? 0)} token`,
].filter(Boolean).join(" · ")

export function RunDetail({ task, run }: { task: TaskDef; run?: SessionRun }) {
  const { user } = useMe()
  const { modelName } = useModels()
  const [cancelling, setCancelling] = React.useState(false)
  if (!run) return <EmptyState icon={<SearchXIcon />} title="找不到这次运行" description="可能是网址里的运行编号写错了。" />
  const toolCalls = run.events.filter((event) => event.kind === "tool").length
  const ruleHits = run.events.filter((event) => event.kind === "rule").length
  const error = run.status === "failed" ? run.events.findLast((event) => event.kind === "error") : undefined
  return (
    <DetailPanel
      title={`${run.id} · ${task.title}`}
      badges={<><RunStatusBadge status={run.status} />{run.status === "running" && <span className="text-xs text-muted-foreground"><Elapsed since={run.startedAt} /></span>}</>}
      meta={`模型 ${modelName(run.modelId)} · 输入 ${num(run.tokensIn)} / 输出 ${num(run.tokensOut)} token · 花费 ${money(run.costUsd)} · 开始 ${fmtDateTime(run.startedAt)} · ${run.endedAt ? `结束 ${fmtDateTime(run.endedAt)}` : "还没结束"}`}
      actions={<>
        <RunBrowserButton run={run} />
        {run.status === "waiting" && can(user, "session.resume", { taskOwnerId: task.ownerId }) && <ResumeButton run={run} size="sm" />}
        {isActive(run) && can(user, "task.manage", { ownerId: task.ownerId }) && (
          <Button variant="outline" size="sm" onClick={() => setCancelling(true)}><CircleStopIcon data-icon="inline-start" />取消运行</Button>
        )}
      </>}
    >
      <CancelRunDialog key={`${run.id}-${cancelling}`} run={run} open={cancelling} onOpenChange={setCancelling} />
      <WaitingAlert run={run} />
      {error && (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>这次运行失败：{error.title}</AlertTitle>
          {error.detail && <AlertDescription>{error.detail}</AlertDescription>}
        </Alert>
      )}
      <DetailSection title={`检查点 · ${checkpointSummary(run.checkpoints)}`}>
        <CheckpointGrid run={run} />
      </DetailSection>
      {run.verification && <VerificationSection run={run} verification={run.verification} />}
      {run.exploredSteps && run.exploredSteps.length > 0 && (
        <AgentSteps task={task} run={run} steps={run.exploredSteps} canSave={can(user, "task.manage", { ownerId: task.ownerId })} />
      )}
      <DetailSection title="附件和产物" description="点下载。agent 存下的文件、这次运行带的附件都在这里，新产物会自动出现。">
        <SessionFiles run={run} />
      </DetailSection>
      <DetailSection title="过程" description={`${run.events.length} 条记录 · 工具调用 ${toolCalls} 次${ruleHits ? ` · 规则命中 ${ruleHits} 次` : ""}${run.status === "running" ? " · 实时更新" : ""}。点工具调用看输入和输出。`}>
        <Trace className="gap-3">
          {run.events.map((event, index) => <EventRow key={event.seq} event={event} run={run} running={run.status === "running" && index === run.events.length - 1} />)}
        </Trace>
      </DetailSection>
    </DetailPanel>
  )
}

/** 过程里几类 M3 的事件加个小标签，一眼分清：规则命中、agent 写下步骤、上下文压缩、验收 */
function eventTag(event: RunEvent): { label: string; variant: "outline" | "secondary"; icon?: LucideIcon } | undefined {
  if (event.kind === "rule") return { label: "规则", variant: "outline" }
  if (event.kind === "verify") return { label: "验收", variant: "outline" }
  if (event.kind === "plan" && event.toolId === "plan.set") return { label: "步骤", variant: "secondary" }
  // 压缩也写成 plan 事件，按标题区分（api.md 11.6）
  if (event.kind === "plan" && event.title.startsWith("上下文压缩")) return { label: "压缩", variant: "secondary", icon: FoldVerticalIcon }
  return undefined
}

function EventRow({ event, run, running }: { event: RunEvent; run: SessionRun; running: boolean }) {
  const toolName = useToolName()
  const Icon = EVENT_ICON[event.kind]
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
  const tag = eventTag(event)
  const RowIcon = tag?.icon ?? Icon
  const line = (
    <TraceLine status={running ? "running" : event.kind === "error" ? "error" : undefined}>
      <TraceIcon><RowIcon /></TraceIcon>
      {tag && <Badge variant={tag.variant}>{tag.label}</Badge>}
      <TraceTitle>{event.title}</TraceTitle>
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
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent className="flex flex-col gap-2 text-xs">
        <span>工具：{toolName(event.toolId ?? "")}（{event.toolId}）{meta && ` · ${meta}`}</span>
        {event.detail && <span>{event.detail}</span>}
        {event.input && <IoBlock title="输入" text={event.input} />}
        {event.output && <IoBlock title="输出" text={event.output} />}
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

/** agent 用「写下步骤」（plan.set）定的最后一版步骤；负责人或主管可以整体覆盖到任务的步骤里 */
function AgentSteps({ task, run, steps, canSave }: { task: TaskDef; run: SessionRun; steps: string[]; canSave: boolean }) {
  const [confirming, setConfirming] = React.useState(false)
  const save = useAction(trpc.tasks.saveStepsFromSession.mutationOptions({ onSuccess: () => setConfirming(false) }), {
    success: (result) => `已存为任务 ${result.id} 的步骤（${result.steps.length} 步），下一次运行照这些步骤做`,
    errorTitle: "没存成",
  })
  const same = task.steps.length === steps.length && task.steps.every((step, index) => step.text === steps[index])
  const updates = run.events.filter((event) => event.kind === "plan" && event.toolId === "plan.set").length
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

function VerificationSection({ run, verification }: { run: SessionRun; verification: Verification }) {
  const { modelName, defaults } = useModels()
  const item = useHumanItems().find((human) => human.runId === run.id && human.kind === "verify")
  const model = modelName(verification.modelId ?? defaults.verify)
  return (
    <DetailSection
      title={`验收 · ${VERDICT[verification.status]}`}
      description={`三方 AI（${model}，不参与执行）逐条核对检查点${verification.round ? ` · 第 ${verification.round} 轮` : ""} · ${eventTimeText(verification.at, run)}`}
      action={item && <Button variant="outline" size="sm" nativeButton={false} render={<a href={href("todos", { id: item.id })} />}>去待办处理 →</Button>}
    >
      <VerificationReport verification={verification} />
    </DetailSection>
  )
}
