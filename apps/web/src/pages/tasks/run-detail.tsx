// 某次运行的 session 详情：标题卡 + 检查点 / 验收 / 总结和记忆（结束后）/ agent 的步骤 / 空间文件 / 过程。
// 右上角「空间文件」（run-space.tsx）弹窗按来源、名字筛这次运行的全部文件。
// M3：过程里标出规则命中、agent 写下步骤（plan.set）、上下文压缩；验收逐条显示结论和理由；agent 的步骤可以「存为任务步骤」（tasks.saveStepsFromSession）。
// 派活：meta 前面写怎么开始的（派活触发写清哪张单、谁派的）；被派来的加「派来的活」，派过活的加「派出去的活」（docs/dev/dispatch.md 9.4 节）。
// 不带页面级布局和返回链接，放进任何 768px 宽的抽屉都能用（任务页、Session 页的抽屉都直接放它）。
// 传进来的 run 是 sessions.list 的摘要（不带过程）：标题、检查点、验收先显示；过程按 id 另取（sessions.get），取到前是骨架屏。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { BrainIcon, ChevronRightIcon, CircleAlertIcon, CircleCheckIcon, CircleStopIcon, FlagIcon, FoldVerticalIcon, ListTreeIcon, PauseIcon, PlayIcon, SaveIcon, ScanSearchIcon, SearchXIcon, SendIcon, ShieldIcon, TriangleAlertIcon, UserIcon, WrenchIcon, type LucideIcon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { can, eventTimeText, fmtDateTime, incompleteReason, isRunEnded, WORK_DISPATCH_TOOL_ID } from "@heyagent/shared"
import type { RunEvent, RunEventKind, SessionSummary, TaskDef, Verification } from "@heyagent/shared"

import { MarkdownView } from "@/components/markdown"
import { useHumanItems, useModels, useSessionQuery, useStaffName, useToolName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"
import { ParamsTable, WorkStatusBadge, shortName, timeText } from "@/pages/work/parts"

import { VerificationReport } from "./verification"
import { CheckpointList, Elapsed, RunStatusBadge, StepList, WaitingAlert, checkpointSummary, focusedCheckpoint, money } from "./parts"
import { CancelRunDialog, isActive, ResumeButton, SessionFiles } from "./run-actions"
import { RunBrowserButton } from "./run-browser"
import { RunSpaceButton } from "./run-space"
import { RunDigestSection } from "./run-digest"

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
  const detail = useSessionQuery(run?.id)
  if (!run) return <EmptyState icon={<SearchXIcon />} title="找不到这次运行" description="可能是网址里的运行编号写错了。" />
  const events = detail.data?.events
  const toolCalls = events?.filter((event) => event.kind === "tool").length ?? 0
  const ruleHits = events?.filter((event) => event.kind === "rule").length ?? 0
  // 失败原因先用摘要里的标题，详情等过程取到再补上
  const error = run.status === "failed" && run.lastError ? { ...run.lastError, detail: events?.findLast((event) => event.kind === "error")?.detail } : undefined
  const notDone = incompleteReason(run)
  return (
    <DetailPanel
      title={`${run.id} · ${task.title}`}
      badges={<><RunStatusBadge status={run.status} />{run.status === "running" && <span className="text-xs text-muted-foreground"><Elapsed since={run.startedAt} /></span>}</>}
      meta={<RunMeta run={run} rest={`模型 ${modelName(run.modelId)} · 输入 ${num(run.tokensIn)} / 输出 ${num(run.tokensOut)} token · 花费 ${money(run.costUsd)} · 开始 ${fmtDateTime(run.startedAt)} · ${run.endedAt ? `结束 ${fmtDateTime(run.endedAt)}` : "还没结束"}`} />}
      actions={<>
        <RunSpaceButton run={run} />
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
      {run.status === "incomplete" && (
        <Alert>
          <CircleAlertIcon />
          <AlertTitle>这次运行没完成</AlertTitle>
          {notDone && <AlertDescription>{notDone}</AlertDescription>}
        </Alert>
      )}
      {run.workItemId && <DispatchedIn run={run} itemId={run.workItemId} />}
      {task.toolIds.includes(WORK_DISPATCH_TOOL_ID) && <DispatchedOut run={run} events={events} />}
      <DetailSection title={`检查点 · ${checkpointSummary(run.checkpoints)}`}>
        <CheckpointList run={run} focused={detail.data && focusedCheckpoint(detail.data)} />
      </DetailSection>
      {run.verification && <VerificationSection run={run} verification={run.verification} />}
      {isRunEnded(run.status) && <RunDigestSection task={task} run={run} canEdit={can(user, "task.manage", { ownerId: task.ownerId })} />}
      {run.exploredSteps && run.exploredSteps.length > 0 && (
        <AgentSteps task={task} run={run} steps={run.exploredSteps} events={events} canSave={can(user, "task.manage", { ownerId: task.ownerId })} />
      )}
      <DetailSection title="空间文件" description="这次运行的文件空间：agent 存的文件、浏览器下载、截图、带的附件都在这里，新文件会自动出现。点文件看内容或下载；要按来源筛、按名字搜，点右上角「空间文件」。">
        <SessionFiles run={run} />
      </DetailSection>
      <DetailSection
        title="过程"
        description={events
          ? `${events.length} 条记录 · 工具调用 ${toolCalls} 次${ruleHits ? ` · 规则命中 ${ruleHits} 次` : ""}${run.status === "running" ? " · 实时更新" : ""}。点工具调用看输入和输出。`
          : `${run.eventCount} 条记录`}
      >
        {events ? (
          <Trace className="gap-3">
            {events.map((event, index) => <EventRow key={event.seq} event={event} run={run} running={run.status === "running" && index === events.length - 1} />)}
          </Trace>
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

/** 过程里几类 M3 的事件加个小标签，一眼分清：规则命中、agent 写下步骤、上下文压缩、验收 */
function eventTag(event: RunEvent): { label: string; variant: "outline" | "secondary"; icon?: LucideIcon } | undefined {
  if (event.kind === "rule") return { label: "规则", variant: "outline" }
  if (event.kind === "verify") return { label: "验收", variant: "outline" }
  if (event.kind === "plan" && event.toolId === "plan.set") return { label: "步骤", variant: "secondary" }
  // 压缩也写成 plan 事件，按标题区分（api.md 11.6）
  if (event.kind === "plan" && event.title.startsWith("上下文压缩")) return { label: "压缩", variant: "secondary", icon: FoldVerticalIcon }
  return undefined
}

function EventRow({ event, run, running }: { event: RunEvent; run: SessionSummary; running: boolean }) {
  const toolName = useToolName()
  // 没完成的运行：结束事件（kind = done）用感叹号，不用打勾
  const Icon = event.kind === "done" && run.status === "incomplete" ? CircleAlertIcon : EVENT_ICON[event.kind]
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

// ---------- 派活 ----------

const SOURCE_TEXT: Record<string, string> = { manual: "手动触发", cron: "定时触发", todo: "待办触发", event: "外部事件触发", dispatch: "派活触发" }

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
      <a className="font-mono underline underline-offset-4" href={href("work", { id: run.workItemId })}>{run.workItemId}</a>
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
      action={<Button variant="outline" size="sm" nativeButton={false} render={<a href={href("work", { id: itemId })} />}>看派活单 {itemId}</Button>}
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
            <WorkStatusBadge item={item} />
            {item.runs.length >= 2 && nth > 0 && <Badge variant="outline">这是第 {nth} 次</Badge>}
          </p>
          <ParamsTable declared={item.taskDispatch?.params ?? []} values={item.params} />
          {item.note && <p><span className="text-muted-foreground">补充说明：</span>{item.note}</p>}
        </div>
      )}
    </DetailSection>
  )
}

/** 派过活的运行：派出去的活，每行一张单，点了去派活页 */
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
            <Item key={item.id} variant="outline" size="sm" render={<a href={href("work", { id: item.id })} />}>
              <ItemContent className="min-w-0">
                <ItemTitle><span className="font-mono">{item.id}</span>{item.title}</ItemTitle>
                <ItemDescription className="line-clamp-1">派给「{item.taskTitle}」 · {timeText(item.createdAt)}</ItemDescription>
              </ItemContent>
              <ItemActions>
                <WorkStatusBadge item={item} />
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
