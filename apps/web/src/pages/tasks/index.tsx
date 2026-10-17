// 任务页（v3.1）：卡片墙一直是主画面；点卡片从右边打开抽屉看任务详情（?id=），抽屉里再看某次运行的 session（?id=&run=）。
// 执行中的排最前，而且是全墙唯一会动的卡（转圈、当前在做的那句闪光、已运行时间每秒跳）。
// 主管能新建任务、开关任务；员工能看全部任务，只能开关、运行自己负责的。
// 新建、编辑、开关、删除接通后端（M1 P2）；「立即运行」「立即继续」由 P3 接引擎。
import * as React from "react"
import { ArrowLeftIcon, ListChecksIcon, PlusIcon } from "lucide-react"

import { EmptyState, PageFrame, SimpleHeader } from "@/components/shell/simple-page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Progress } from "@/components/ui/progress"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { can, fmtDateTime, fmtShort, runsOfTask, type RunStatus, type SessionRun, type TaskDef } from "@heyagent/shared"

import {
  useBoardQuery, useMemoriesQuery, useModelsQuery, useRulesQuery, useRunNow, useSessionsQuery, useSkillsQuery, useStaffName, useStaffQuery, useTasksQuery, useToolsQuery,
} from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { cn } from "@/lib/utils"
import { href, setParams, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { TaskDialog } from "./task-dialog"
import { Elapsed, RunStatusBadge, nextRunText, type TasksState } from "./parts"
import { RunDetail } from "./run-detail"
import { TaskActions, TaskDetail } from "./task-detail"

/** 卡片墙的顺序：执行中 → 等人处理 → 挂起等待 → 验收中 → 其他 */
const ORDER: Partial<Record<RunStatus, number>> = { running: 0, needs_human: 1, waiting: 2, verifying: 3 }

export default function TasksPage() {
  const { isAdmin, user } = useMe()
  const { params } = useRoute()
  const tasksQuery = useTasksQuery()
  const sessionsQuery = useSessionsQuery()
  // 卡片和抽屉里要用：人名、挡住运行的事、模型名，详情里「用到的配置」还要记忆、技能、工具、规则。
  // httpBatchLink 会把同时发出的查询合成一个请求
  const queries = [tasksQuery, sessionsQuery, useStaffQuery(), useBoardQuery(), useModelsQuery(), useMemoriesQuery(), useSkillsQuery(), useToolsQuery(), useRulesQuery()]
  const taskList = tasksQuery.data ?? []
  const runList = sessionsQuery.data ?? []
  const [creating, setCreating] = React.useState(false)

  const state: TasksState = {
    runsOf: (taskId) => runsOfTask(runList, taskId),
  }

  // 关抽屉时 ?id= 先清掉了，留着上一次的 id / run，让关闭动画有内容
  const taskId = params.get("id")
  const runId = params.get("run")
  const [shown, setShown] = React.useState({ id: taskId, run: runId })
  if (taskId && (taskId !== shown.id || runId !== shown.run)) setShown({ id: taskId, run: runId })
  const task = taskList.find((each) => each.id === (taskId ?? shown.id))
  const shownRun = taskId ? runId : shown.run
  const latestOf = (id: string) => state.runsOf(id)[0]
  const rank = (id: string) => ORDER[latestOf(id)?.status as RunStatus] ?? 9
  const visible = taskList.toSorted((a, b) => rank(a.id) - rank(b.id))
  // 员工能看全部任务，只能操作自己负责的；主管能操作全部
  const canManage = (each: TaskDef) => can(user, "task.manage", { ownerId: each.ownerId })
  const setEnabled = useAction(trpc.tasks.setEnabled.mutationOptions(), { success: (_data, vars) => (vars.enabled ? "任务已启动" : "任务已停用，不会再运行") })

  const header = (
    <SimpleHeader
      title="任务"
      description={isAdmin ? "每个任务一张卡，执行中的排最前。点卡片从右边看详情。" : "全部任务，执行中的排最前。你只能开关、运行自己负责的。"}
      learnId="task"
      action={can(user, "task.create", {}) && taskList.length > 0 && <Button onClick={() => setCreating(true)}><PlusIcon data-icon="inline-start" />新建任务</Button>}
    />
  )

  return (
    <>
      <PageFrame
        skeleton="grid"
        header={header}
        queries={queries}
        isEmpty={taskList.length === 0}
        empty={
          <EmptyState
            icon={<ListChecksIcon />}
            title="还没有任务"
            description={can(user, "task.create", {}) ? "点下面「新建任务」：写一句话任务和目标，步骤可以不写。建之前最好先在「模型」页接好模型，在「工具」「技能」页配好要用的东西。" : "还没有任务。任务由主管新建，分给你负责的会出现在这里。"}
            action={can(user, "task.create", {}) && <Button onClick={() => setCreating(true)}><PlusIcon data-icon="inline-start" />新建任务</Button>}
          />
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {visible.map((each) => <TaskCard key={each.id} task={each} latest={latestOf(each.id)} canToggle={canManage(each)} onToggle={(enabled) => setEnabled.mutate({ id: each.id, enabled })} />)}
        </div>
        <Sheet open={Boolean(taskId)} onOpenChange={(next) => !next && setParams({ id: null, run: null })}>
          <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
            {task ? <TaskSheetBody task={task} runId={shownRun} state={state} canEdit={canManage(task)} />
              : <SheetHeader><SheetTitle>找不到这个任务</SheetTitle><SheetDescription>{taskId ?? shown.id} 可能已经被删除。</SheetDescription></SheetHeader>}
          </SheetContent>
        </Sheet>
      </PageFrame>
      {can(user, "task.create", {}) && <TaskDialog key={creating ? "open" : "closed"} open={creating} onOpenChange={setCreating} />}
    </>
  )
}

/** 抽屉：头部是任务（状态、标题、负责人和定时），中间是任务详情或某次 session，底部是主管操作 */
function TaskSheetBody({ task, runId, state, canEdit }: { task: TaskDef; runId: string | null; state: TasksState; canEdit: boolean }) {
  const staffName = useStaffName()
  const latest = state.runsOf(task.id)[0]
  return (
    <>
      <SheetHeader className="pr-12">
        <div className="flex flex-wrap items-center gap-2 pb-1 text-muted-foreground">
          {latest && <RunStatusBadge status={latest.status} />}
          {latest?.status === "running" && <Elapsed since={latest.startedAt} />}
          <span className="font-mono">{task.id}</span>
        </div>
        <SheetTitle>{task.title}</SheetTitle>
        <SheetDescription>
          负责人 {staffName(task.ownerId)} · 创建于 {fmtDateTime(task.createdAt)} · {task.schedule ? `定时：${task.schedule.text}（${task.schedule.cron}）` : "只跑一次"} · 预计下次运行：{nextRunText(task, latest)}
        </SheetDescription>
      </SheetHeader>
      <Separator />
      <div key={runId ?? task.id} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 *:shrink-0">
        {runId ? (
          <>
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setParams({ run: null })}><ArrowLeftIcon data-icon="inline-start" />{task.id} 任务详情</Button>
            <RunDetail task={task} run={state.runsOf(task.id).find((run) => run.id === runId)} />
          </>
        ) : <TaskDetail task={task} state={state} />}
      </div>
      <Separator />
      <SheetFooter className="mt-0 flex-row items-center justify-between">
        {canEdit ? <TaskActions task={task} state={state} /> : <p className="text-muted-foreground">负责人是 {staffName(task.ownerId)}，你只能查看。</p>}
      </SheetFooter>
    </>
  )
}

/** 卡片里的一行小字：定时 · 下次 · 步骤 */
function metaLine(task: TaskDef) {
  const next = !task.enabled ? "已停用" : task.nextRunAt ? `下次 ${fmtShort(task.nextRunAt)}` : task.schedule ? "下次按 cron 算" : ""
  const marks = task.steps.filter((step) => step.checkpoint).length
  const steps = task.steps.length ? `${task.steps.length} 步${marks ? ` · ${marks} 检查点` : ""}` : "agent 自己探索"
  return [task.schedule?.text ?? "只跑一次", next, steps].filter(Boolean).join(" · ")
}

function TaskCard({ task, latest, canToggle, onToggle }: { task: TaskDef; latest?: SessionRun; canToggle: boolean; onToggle: (enabled: boolean) => void }) {
  const staffName = useStaffName()
  const runNow = useRunNow()
  const now = latest && runNow(latest)
  const running = latest?.status === "running"
  const checkpoints = latest?.checkpoints ?? []
  const done = checkpoints.filter((cp) => cp.status === "done").length
  return (
    <Card size="sm" className="relative">
      <CardContent className="flex flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2 text-muted-foreground">
          {latest ? <RunStatusBadge status={latest.status} /> : <Badge variant="ghost">还没运行过</Badge>}
          {running ? <span className="text-foreground"><Elapsed since={latest.startedAt} /></span> : latest && <span className="tabular-nums">{fmtShort(latest.startedAt)}</span>}
          <span className="ml-auto font-mono">{task.id}</span>
        </div>
        {/* 整张卡可点：链接铺满卡片，开关浮在上面 */}
        <a href={href("tasks", { id: task.id })} className="line-clamp-2 text-sm font-medium after:absolute after:inset-0 hover:underline">{task.title}</a>
        {now && (
          <div className={cn("flex min-w-0 flex-col border-l-2 pl-2", running ? "border-primary" : "border-border")}>
            <p className={now.when || running ? "truncate" : "line-clamp-2"}>
              <span className="text-muted-foreground">{now.label}：</span><span className={cn(running && "shimmer")}>{now.text}</span>
            </p>
            {now.when && <p className="truncate text-muted-foreground">继续：{now.when}</p>}
          </div>
        )}
        {running && checkpoints.length > 0 && (
          <Progress value={(done / checkpoints.length) * 100} aria-label={`检查点完成 ${done}/${checkpoints.length}`}>
            <span className="text-muted-foreground tabular-nums">检查点 {done}/{checkpoints.length}</span>
          </Progress>
        )}
        <p className="mt-auto truncate pt-1 text-muted-foreground">{metaLine(task)}</p>
        <div className="flex items-center justify-between gap-2">
          <span className="text-muted-foreground">负责人 {staffName(task.ownerId)}</span>
          {canToggle ? (
            <label className="relative z-10 flex items-center gap-2">
              {task.enabled ? "已启动" : "已停用"}
              <Switch size="sm" checked={task.enabled} onCheckedChange={(on) => onToggle(Boolean(on))} aria-label={`启动 ${task.id}`} />
            </label>
          ) : (
            <span className={task.enabled ? undefined : "text-muted-foreground"}>{task.enabled ? "已启动" : "已停用"}</span>
          )}
        </div>
      </CardContent>
    </Card>
  )
}
