// 某次运行的 session 详情：标题卡 + 检查点 / 过程 / 验收 / agent 自己探索的步骤。
// 不带页面级布局和返回链接，放进任何 768px 宽的抽屉都能用（任务页、Session 页的抽屉都直接放它）。
import * as React from "react"
import { BrainIcon, CircleCheckIcon, CircleStopIcon, FlagIcon, ListTreeIcon, PauseIcon, PlayIcon, SaveIcon, ScanSearchIcon, SearchXIcon, ShieldIcon, TriangleAlertIcon, UserIcon, WrenchIcon, type LucideIcon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent, MessageGroup, MessageHeader } from "@/components/ui/message"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { can, eventTimeText, fmtDateTime } from "@heyagent/shared"
import type { RunEvent, RunEventKind, SessionRun, TaskDef, Verification } from "@heyagent/shared"

import { MarkdownView } from "@/components/markdown"
import { useHumanItems, useModels, useToolName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { CheckpointGrid, Elapsed, RunStatusBadge, StepList, WaitingAlert, checkpointSummary, money } from "./parts"
import { CancelRunDialog, isActive, ResumeButton, SessionFiles } from "./run-actions"

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
  const saveSteps = useAction(trpc.tasks.update.mutationOptions(), { success: "已存为任务步骤，下一次运行照这些步骤做" })
  const [cancelling, setCancelling] = React.useState(false)
  if (!run) return <EmptyState icon={<SearchXIcon />} title="找不到这次运行" description="可能是网址里的运行编号写错了。" />
  const toolCalls = run.events.filter((event) => event.kind === "tool").length
  const error = run.status === "failed" ? run.events.findLast((event) => event.kind === "error") : undefined
  return (
    <DetailPanel
      title={`${run.id} · ${task.title}`}
      badges={<><RunStatusBadge status={run.status} />{run.status === "running" && <span className="text-xs text-muted-foreground"><Elapsed since={run.startedAt} /></span>}</>}
      meta={`模型 ${modelName(run.modelId)} · 输入 ${num(run.tokensIn)} / 输出 ${num(run.tokensOut)} token · 花费 ${money(run.costUsd)} · 开始 ${fmtDateTime(run.startedAt)} · ${run.endedAt ? `结束 ${fmtDateTime(run.endedAt)}` : "还没结束"}`}
      actions={<>
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
      <DetailSection title="附件和产物" description="点下载。agent 存下的文件、这次运行带的附件都在这里，新产物会自动出现。">
        <SessionFiles run={run} />
      </DetailSection>
      <DetailSection title="过程" description={`${run.events.length} 条记录 · 工具调用 ${toolCalls} 次${run.status === "running" ? " · 实时更新" : ""}。点工具调用看输入和输出。`}>
        <Trace className="gap-3">
          {run.events.map((event, index) => <EventRow key={event.seq} event={event} run={run} running={run.status === "running" && index === run.events.length - 1} />)}
        </Trace>
      </DetailSection>
      {run.verification && <VerificationSection run={run} verification={run.verification} />}
      {run.exploredSteps && (
        <DetailSection title="agent 自己探索的步骤" description="任务没写步骤，这是 agent 这次自己定的做法。" action={can(user, "task.manage", { ownerId: task.ownerId }) && (
            <Button
              variant="outline"
              size="sm"
              disabled={saveSteps.isPending}
              onClick={() =>
                saveSteps.mutate({
                  id: task.id,
                  title: task.title,
                  goal: task.goal,
                  steps: (run.exploredSteps ?? []).map((text) => ({ text, wait: false })),
                  modelId: task.modelId,
                  ownerId: task.ownerId,
                  schedule: task.schedule ?? null,
                  enabled: task.enabled,
                  memoryIds: task.memoryIds,
                  skillIds: task.skillIds,
                  toolIds: task.toolIds,
                  ruleIds: task.ruleIds,
                })
              }
            >
              <SaveIcon data-icon="inline-start" />存为任务步骤
            </Button>
          )}>
          <StepList steps={run.exploredSteps} />
        </DetailSection>
      )}
    </DetailPanel>
  )
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
  const line = (
    <TraceLine status={running ? "running" : event.kind === "error" ? "error" : undefined}>
      <TraceIcon><Icon /></TraceIcon>
      <TraceTitle>{event.title}</TraceTitle>
      <TraceDescription>{at}</TraceDescription>
      {meta && <TraceDescription className="hidden sm:inline">· {meta}</TraceDescription>}
    </TraceLine>
  )
  // agent 的答复、思考可能是 Markdown（列表、表格），按 Markdown 显示
  const prose = event.kind === "done" || event.kind === "think"
  if (event.kind !== "tool") {
    return (
      <div className="flex flex-col gap-0.5">
        {line}
        {event.detail && (prose ? <MarkdownView className="pl-5.5 text-xs">{event.detail}</MarkdownView> : <p className="pl-5.5 text-xs text-muted-foreground">{event.detail}</p>)}
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

const VERDICT = { passed: "通过", asking: "在反问", disputed: "有争议，交给人" } as const

function VerificationSection({ run, verification }: { run: SessionRun; verification: Verification }) {
  const { modelName, defaults } = useModels()
  const item = useHumanItems().find((human) => human.runId === run.id && human.kind === "verify")
  return (
    <DetailSection title={`验收 · ${VERDICT[verification.status]}`} description={`三方 AI（${modelName(defaults.verify)}，不参与执行）逐条核对检查点 · ${eventTimeText(verification.at, run)}`}
      action={item && <Button variant="outline" size="sm" nativeButton={false} render={<a href={href("todos", { id: item.id })} />}>去待办处理 →</Button>}>
      <div className="flex flex-col gap-3">
        <p className="font-medium">{verification.headline}</p>
        <MessageGroup className="gap-3">
          {verification.notes.map((note, index) => (
            <Message key={index} align={note.by === "verifier" ? "start" : "end"}>
              <MessageContent>
                <MessageHeader>{note.by === "verifier" ? "三方 AI" : "执行 agent"}</MessageHeader>
                <Bubble variant={note.by === "verifier" ? "muted" : "outline"}><BubbleContent>{note.text}</BubbleContent></Bubble>
              </MessageContent>
            </Message>
          ))}
        </MessageGroup>
      </div>
    </DetailSection>
  )
}
