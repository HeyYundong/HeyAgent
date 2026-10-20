// 看板卡片的详情 Sheet：外壳 + 运行（session）详情 + 人加的待办详情 + 收起的被派运行（派活第二期）。「要人办的事」在 human-sheet.tsx。
import { Fragment, createElement, type ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowRightIcon, BrainIcon, CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CircleSlashIcon, EllipsisIcon, FlagIcon, ListTodoIcon, PauseIcon } from "lucide-react"
import { PlayIcon, ShieldIcon, ShieldQuestionIcon, TriangleAlertIcon, UserIcon, UserPenIcon, WrenchIcon, ZapIcon, type LucideIcon } from "lucide-react"

import { OutcomeBadge } from "@/components/shell/outcome-badge"
import { DetailSection } from "@/components/shell/simple-page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockTitle } from "@/components/ui/code-block"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { Separator } from "@/components/ui/separator"
import { Skeleton } from "@/components/ui/skeleton"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Spinner } from "@/components/ui/spinner"
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { trpc } from "@/lib/trpc"
import { focusedCheckpoint, money } from "@/pages/tasks/parts"
import { VerificationReport } from "@/pages/tasks/verification"
import { ResumeButton } from "@/pages/tasks/run-actions"
import { addDaysIso, boardColumns, eventTimeText, findById, fmtDateTime, fmtShort, isReviewing, outcomeOf, outcomeReasonOf, suspendedRun, triggerText } from "@heyagent/shared"
import type { BoardColumn, HumanTodo, RunEventKind, SessionSummary, TaskDef, Trigger } from "@heyagent/shared"

import { useModels, useSessionQuery, useStaffName } from "@/lib/data"

import { nextRuns, shortTime } from "./cron"

/** ISO 时间 →「10-17 周六 10:00」（按上海时间） */
export const isoShortTime = (iso: string) => shortTime(fmtDateTime(iso))

type SheetProps = { open: boolean; onClose: () => void; title: ReactNode; badges: ReactNode; meta: ReactNode; footer?: ReactNode; children: ReactNode }

/** 外壳：标题 + 分区卡（可滚动）+ 底部操作（最多两个可见按钮，其余放「⋯」） */
export function DetailSheet({ open, onClose, title, badges, meta, footer, children }: SheetProps) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-lg">
        <SheetHeader className="pr-12">
          <div className="flex flex-wrap items-center gap-2 pb-1">{badges}</div>
          <SheetTitle>{title}</SheetTitle><SheetDescription>{meta}</SheetDescription>
        </SheetHeader>
        <Separator />
        {/* 内容多了在这里滚动，卡片不被压扁（*:shrink-0） */}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 *:shrink-0">{children}</div>
        {footer && <><Separator /><SheetFooter className="mt-0 flex-row flex-wrap items-center">{footer}</SheetFooter></>}
      </SheetContent>
    </Sheet>
  )
}

export const TextLink = ({ to, children }: { to: string; children: ReactNode }) => <a href={to} className="underline underline-offset-4 hover:text-foreground">{children}</a>

/** 一块原文：要发的消息、订单、证据、diff */
export const Block = ({ title, children }: { title: string; children: ReactNode }) => (
  <CodeBlock size="sm">
    <CodeBlockHeader><CodeBlockTitle>{title}</CodeBlockTitle></CodeBlockHeader>
    <CodeBlockContent wrap>{children}</CodeBlockContent>
  </CodeBlock>
)

/** 几样东西用 · 隔开（空的跳过） */
export const dots = (...parts: ReactNode[]) => parts.filter(Boolean).map((part, index) => <Fragment key={index}>{index > 0 && " · "}{part}</Fragment>)

const EVENT_ICON: Record<RunEventKind, LucideIcon> = { plan: ListTodoIcon, think: BrainIcon, tool: WrenchIcon, checkpoint: FlagIcon, rule: ShieldIcon,
  wait: PauseIcon, resume: PlayIcon, human: UserIcon, verify: ShieldQuestionIcon, done: CircleCheckIcon, error: TriangleAlertIcon }
const CHECK_ICON = { done: CircleCheckIcon, open: CircleDashedIcon, skipped: CircleSlashIcon }

/** 等的事件：只等事件、或时间和事件先到先继续 */
const eventOf = (trigger: Trigger) => ("event" in trigger ? trigger.event : undefined)

/** 主管手动触发一个事件（engine.fireEvent，和外部系统 POST /api/events 一样）：在等它的 session 继续、等它的待办触发 */
export function FireEventButton({ event }: { event: string }) {
  const fire = useAction(trpc.engine.fireEvent.mutationOptions(), {
    success: (result) => `已触发「${event}」：继续了 ${result.resumedSessionIds.length} 个 session，触发了 ${result.firedTodoIds.length} 条待办`,
    errorTitle: "没能触发事件",
  })
  return (
    <Button variant="outline" disabled={fire.isPending} onClick={() => fire.mutate({ event })}>
      {fire.isPending ? <Spinner data-icon="inline-start" /> : <ZapIcon data-icon="inline-start" />}手动触发事件
    </Button>
  )
}

type RunProps = { run: SessionSummary; task: TaskDef; column: BoardColumn; note?: string; canAct: boolean; isAdmin: boolean; open: boolean; onClose: () => void }

/** 员工看别人的任务只读：canAct 为 false 时没有「立即继续」。「等人处理」的运行（?id= 直接打开）也不能手动继续。
 * 在等事件的，主管可以手动触发这个事件 */
export function RunSheet({ run, task, column, note, canAct, isAdmin, open, onClose }: RunProps) {
  const { modelName } = useModels()
  const waiting = note ? undefined : run.waiting
  const doneCount = run.checkpoints.filter((checkpoint) => checkpoint.status === "done").length
  // 摘要不带过程：最近几条过程、正在做的检查点要按 id 取全部过程（Sheet 开着才取）
  const detail = useSessionQuery(run.id, open)
  const focused = detail.data && focusedCheckpoint(detail.data)
  const last = detail.data?.events.slice(-4)
  const k = (n: number) => `${(n / 1000).toFixed(1)}k`
  return (
    <DetailSheet
      open={open} onClose={onClose} title={task.title}
      badges={<>
        <Badge variant={column === "done" ? "outline" : "secondary"}>{findById(boardColumns, column)?.name}</Badge>
        {column === "done" && <OutcomeBadge outcome={outcomeOf(run)} reason={outcomeReasonOf(run)} reviewing={isReviewing(run)} />}
      </>}
      meta={dots(run.id, modelName(run.modelId), `开始 ${fmtShort(run.startedAt)}`, `${k(run.tokensIn)} / ${k(run.tokensOut)} token`, money(run.costUsd))}
      footer={<>
        {waiting && column === "waiting" && run.status === "waiting" && canAct && <ResumeButton run={run} />}
        {waiting && run.status === "waiting" && isAdmin && eventOf(waiting.trigger) && <FireEventButton event={eventOf(waiting.trigger)!} />}
        <Button variant="outline" nativeButton={false} render={<a href={href("tasks", { id: task.id, run: run.id })} />}>看完整运行记录 →</Button>
      </>}
    >
      {waiting && (
        <DetailSection title="在等什么" description={`${fmtShort(waiting.since)} 挂起，session 不占着资源`}>
          <p className="text-base">{waiting.what}</p>
          <p className="mt-2"><span className="text-muted-foreground">什么时候继续：</span>{waitText(waiting.trigger, waiting.since)}</p>
          <p className="mt-2 text-muted-foreground">等到了就继续这个 session（{run.id}），之前的上下文和检查点都还在，不会新开一个。</p>
        </DetailSection>
      )}
      {run.status === "running" && <DetailSection title="正在做什么"><p className="flex items-center gap-2"><Spinner />{run.lastEvent?.title ?? "刚开始"}</p></DetailSection>}
      {note && (
        <DetailSection title={column === "done" ? "已结束" : run.status === "waiting" ? "已手动继续同一个 session" : "已处理，继续同一个 session"} description="没有新开 session">
          <p className="flex items-center gap-2 text-base">{column === "running" && <Spinner />}{note}</p>
          <p className="mt-2 text-muted-foreground">{column === "done" ? "验收通过（同意跳过），这次运行结束。" : `agent 从挂起的地方接着做（${run.id}），之前的上下文和检查点都还在。`}</p>
        </DetailSection>
      )}
      {run.verification && (
        <DetailSection title={column === "done" ? "验收结果" : column === "verifying" ? "三方 AI 正在验收" : "验收记录"} description={run.verification.round ? `第 ${run.verification.round} 轮` : undefined}>
          <VerificationReport verification={run.verification} showNotes={false} />
        </DetailSection>
      )}
      <DetailSection title={run.checkpoints.length > 0 ? `检查点 · 完成 ${doneCount} / ${run.checkpoints.length}` : "检查点"}>
        {run.checkpoints.length === 0 && <p className="text-muted-foreground">这次运行没有检查点。{run.exploredSteps?.length ? `agent 的步骤：${run.exploredSteps.join(" → ")}` : ""}</p>}
        <ul className="flex flex-col gap-1.5">
          {run.checkpoints.map(({ title, status, target, progress, skipReason }, index) => (
            <li key={title} className="flex items-start gap-2">
              {createElement(index === focused && status === "open" ? CircleDotIcon : CHECK_ICON[status], { className: "mt-0.5 size-3.5 shrink-0 text-muted-foreground" })}
              <span className="min-w-0 flex-1">{title}{index === focused && status === "open" && <Badge variant="secondary" className="ml-2">正在做</Badge>}{skipReason && <span className="block text-xs text-muted-foreground">跳过：{skipReason}</span>}</span>
              {target !== undefined && <span className="text-muted-foreground tabular-nums">{progress ?? 0}/{target}</span>}
            </li>
          ))}
        </ul>
      </DetailSection>
      <DetailSection title="最近的过程" description={`共 ${run.eventCount} 条，这里显示最后 ${Math.min(run.eventCount, 4)} 条`}>
        {last ? (
          <Trace>
            {last.map((event, index) => (
              <TraceLine key={event.seq} status={run.status === "running" && index === last.length - 1 ? "running" : undefined}>
                <TraceIcon>{createElement(EVENT_ICON[event.kind])}</TraceIcon>
                <TraceTitle>{event.title}</TraceTitle>
                <TraceDescription>{eventTimeText(event.at, run)}</TraceDescription>
              </TraceLine>
            ))}
          </Trace>
        ) : detail.isError ? (
          <p className="text-muted-foreground">过程没取到，稍后再试。</p>
        ) : (
          <div className="flex flex-col gap-2">
            {Array.from({ length: Math.min(run.eventCount, 4) }, (_, index) => <Skeleton key={index} className="h-4 w-full" />)}
          </div>
        )}
      </DetailSection>
    </DetailSheet>
  )
}

/** 「什么时候」的大字：cron 只写人话，表达式和下几次另起一行 */
export const triggerHeadline = (trigger: Trigger, since: string) => trigger.kind === "cron" ? trigger.text : trigger.kind === "time" ? `${isoShortTime(trigger.at)} 到点` : waitText(trigger, since)

/** 触发说明；只等事件的写出最晚时间（since + fallbackDays），到期提醒负责人 */
export const waitText = (trigger: Trigger, since: string) => trigger.kind !== "event" ? triggerText(trigger)
  : `等到「${trigger.event}」；最多等到 ${isoShortTime(addDaysIso(since, trigger.fallbackDays))}，到期提醒负责人`

type TodoProps = { todo: HumanTodo; runs: SessionSummary[]; tasks: TaskDef[]; open: boolean; canRun: boolean; canManage: boolean; isAdmin: boolean; onClose: () => void; onEdit: () => void; onDelete: () => void }

/** canRun：主管、加这条的人、任务负责人能「立即执行」；canManage：只有主管和加这条的人能编辑、删除。
 * 立即执行和到点一样（engine.runTodoNow）：任务有挂起的 session 就继续它，没有就新开一次运行；一次性的待办执行后就结束 */
export function TodoSheet({ todo, runs, tasks, open, canRun, canManage, isAdmin, onClose, onEdit, onDelete }: TodoProps) {
  const staffName = useStaffName()
  const run = useAction(trpc.engine.runTodoNow.mutationOptions({ onSuccess: () => onClose() }), {
    success: (result) => (result.resumedSessionId ? `已继续挂起的 ${result.resumedSessionId}` : `已开始运行 ${result.startedSessionId}`),
    errorTitle: "没能执行",
  })
  const task = findById(tasks, todo.taskId)
  const suspended = suspendedRun(runs, todo.taskId)
  const { trigger } = todo
  return (
    <DetailSheet
      open={open} onClose={onClose} title={todo.title}
      badges={<Badge variant="outline"><UserPenIcon data-icon="inline-start" />人加的</Badge>}
      meta={dots(`${staffName(todo.createdById)} 加的`, fmtShort(todo.createdAt))}
      footer={(canRun || (isAdmin && eventOf(trigger))) && <>
        {canRun && <Button disabled={run.isPending} onClick={() => run.mutate({ todoId: todo.id })}>{run.isPending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}立即执行</Button>}
        {isAdmin && eventOf(trigger) && <FireEventButton event={eventOf(trigger)!} />}
        {canManage && <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多操作" />}><EllipsisIcon /></DropdownMenuTrigger>
          <DropdownMenuContent align="end"><DropdownMenuItem onClick={onEdit}>编辑</DropdownMenuItem><DropdownMenuItem variant="destructive" onClick={onDelete}>删除</DropdownMenuItem></DropdownMenuContent>
        </DropdownMenu>}
      </>}
    >
      <DetailSection title="什么时候">
        <p className="text-base">{triggerHeadline(trigger, todo.createdAt)}</p>
        {trigger.kind === "cron" && <p className="mt-2 flex flex-wrap items-center gap-2 text-muted-foreground">cron <Kbd>{trigger.cron}</Kbd>接下来 3 次：{nextRuns(trigger.cron, new Date()).map(shortTime).join("、")}</p>}
      </DetailSection>
      <DetailSection title="到点后做什么">
        <p>{todo.title}</p>
        <p className="mt-2 text-muted-foreground">{suspended
          ? `${todo.taskId} 现在有一个挂起的 session（${suspended.id}，在等：${suspended.waiting?.what}），到点会继续它，不会新开。`
          : `${todo.taskId} 现在没有挂起的 session，到点会开始一次新的运行。`}</p>
      </DetailSection>
      {task && (
        <DetailSection title="关联的任务" description={`负责人 ${staffName(task.ownerId)}${task.schedule ? ` · 任务本身也定时：${task.schedule.text}` : ""}`}>
          <TextLink to={href("tasks", { id: task.id })}>{task.id} {task.title} →</TextLink>
        </DetailSection>
      )}
    </DetailSheet>
  )
}

/** 挂起的运行最早什么时候继续：定时的是那个时间，只等事件的是兜底期限（since + fallbackDays） */
export function dueAt(run: SessionSummary) {
  const waiting = run.waiting
  if (!waiting) return run.startedAt
  const trigger = waiting.trigger
  if (trigger.kind === "time" || trigger.kind === "time_or_event") return trigger.at
  if (trigger.kind === "cron") return trigger.next
  return addDaysIso(waiting.since, trigger.fallbackDays)
}

const byTime = (a: string, b: string) => Date.parse(a) - Date.parse(b)

type GroupProps = { task: TaskDef; runs: SessionSummary[]; open: boolean; onClose: () => void }

/**
 * 派活第二期：收起的卡片点开，列出同一个任务被派来、在等的运行（按什么时候继续排），点一行去 Session 页看那次运行；底部去派活页看全部。
 * 派活单的标题从派活页的接口取（这个任务在办的单）。
 */
export function GroupSheet({ task, runs: list, open, onClose }: GroupProps) {
  const staffName = useStaffName()
  const items = useQuery(trpc.work.list.queryOptions({ taskId: task.id, status: "running", days: 0, limit: 200 }, { enabled: open })).data?.items ?? []
  const titleOf = (run: SessionSummary) => items.find((item) => item.id === run.workItemId || item.sessionId === run.id)?.title
  const sorted = [...list].sort((a, b) => byTime(dueAt(a), dueAt(b)))
  return (
    <DetailSheet
      open={open} onClose={onClose} title={task.title}
      badges={<><Badge variant="secondary">等待中</Badge><Badge variant="outline">派来的活 · {list.length} 个在等</Badge></>}
      meta={dots(task.id, `${staffName(task.ownerId)}负责`, "挂起等待的不占名额，到点或等到回复就继续各自的 session")}
      footer={<Button nativeButton={false} render={<a href={href("work", { task: task.id, status: "running" })} />}>去派活页看全部<ArrowRightIcon data-icon="inline-end" /></Button>}
    >
      <ItemGroup className="gap-2">
        {sorted.map((run) => (
          <Item key={run.id} variant="outline" size="sm" render={<a href={href("sessions", { id: run.id })} />}>
            <ItemContent className="min-w-0">
              <ItemTitle className="line-clamp-1">
                <span className="font-mono text-muted-foreground">{run.id}</span>
                {run.workItemId && ` · ${run.workItemId}`}
                {titleOf(run) && ` · ${titleOf(run)}`}
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                在等：{run.waiting?.what ?? "—"}
                <br />
                继续：{isoShortTime(dueAt(run))} 到点{run.waiting?.trigger.kind === "time_or_event" ? "，或等到回复先继续" : run.waiting?.trigger.kind === "event" ? `（最晚），或等到「${run.waiting.trigger.event}」先继续` : ""}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </DetailSheet>
  )
}
