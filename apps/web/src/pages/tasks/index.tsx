// 任务页（v3.1）：卡片墙一直是主画面；点卡片从右边打开抽屉看任务详情（?id=），抽屉里再看某次运行的 session（?id=&run=）、派给它的一张单（?id=&work=W-…）。
// 能被派活的任务，卡片上多一行「排队 3 · 在办 2」（work.queueStats 一次取全部）；只有 ?work=W-…、没有 ?id= 时（旧的 #/work?id=W-… 跳过来的）先查这张单派给了谁再打开。
// 卡片和抽屉只说明任务（目标、步骤、定时、负责人），不显示运行状态；运行记录在「会话」页看（抽屉头部「会话」按钮带上这个任务筛好）。
// 卡片按创建时间排，新建的在最前。
// 主管能新建任务、开关任务；员工能看全部任务，只能开关、运行自己负责的。
// 新建、编辑、开关、删除接通后端（M1 P2）；立即运行（可带附件）、立即继续、取消、任务附件接引擎（M1 P3）。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowLeftIcon, HistoryIcon, ListChecksIcon, PlusIcon } from "lucide-react"

import { EmptyState, PageFrame, SimpleHeader } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Switch } from "@/components/ui/switch"
import { toast } from "@/components/ui/toast"
import { can, fmtDateTime, fmtShort, runsOfTask, type TaskDef, type WorkQueueStats } from "@heyagent/shared"

import {
  useBoardQuery, useMemoriesQuery, useModelsQuery, useRulesQuery, useSessionsQuery, useSkillsQuery, useStaffName, useStaffQuery, useTasksQuery, useToolsQuery,
} from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { TaskDialog } from "./task-dialog"
import type { TasksState } from "./parts"
import { RunDetail } from "./run-detail"
import { TaskActions, TaskDetail } from "./task-detail"
import { WorkItemView } from "./work-detail"
import { useWorkQueueStats } from "./work-parts"

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
  const workId = params.get("work")
  const [shown, setShown] = React.useState({ id: taskId, run: runId, work: workId })
  if (taskId && (taskId !== shown.id || runId !== shown.run || workId !== shown.work)) setShown({ id: taskId, run: runId, work: workId })
  const task = taskList.find((each) => each.id === (taskId ?? shown.id))
  const shownRun = taskId ? runId : shown.run
  const shownWork = taskId ? workId : shown.work
  // 卡片上的「排队 · 在办」
  const queueStats = useWorkQueueStats().data ?? []
  // 卡片墙按创建时间，新建的排最前
  const visible = taskList.toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
  // 员工能看全部任务，只能操作自己负责的；主管能操作全部
  const canManage = (each: TaskDef) => can(user, "task.manage", { ownerId: each.ownerId })
  const setEnabled = useAction(trpc.tasks.setEnabled.mutationOptions(), { success: (_data, vars) => (vars.enabled ? "任务已启动" : "任务已停用，不会再自动运行") })

  const header = (
    <SimpleHeader
      title="任务"
      description={isAdmin ? "每个任务一张卡，说明这个任务做什么。点卡片从右边看详情；每次运行的过程在「会话」页看。" : "全部任务，点卡片看详情；每次运行的过程在「会话」页看。你只能开关、运行自己负责的。"}
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
          {visible.map((each) => (
            <TaskCard key={each.id} task={each} queue={queueStats.find((stats) => stats.taskId === each.id)} canToggle={canManage(each)} onToggle={(enabled) => setEnabled.mutate({ id: each.id, enabled })} />
          ))}
        </div>
        {workId && !taskId && <WorkRedirect id={workId} />}
        <Sheet open={Boolean(taskId)} onOpenChange={(next) => !next && setParams({ id: null, run: null, work: null })}>
          <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
            {task ? <TaskSheetBody task={task} runId={shownRun} workId={shownWork} state={state} canEdit={canManage(task)} />
              : <SheetHeader><SheetTitle>找不到这个任务</SheetTitle><SheetDescription>{taskId ?? shown.id} 可能已经被删除。</SheetDescription></SheetHeader>}
          </SheetContent>
        </Sheet>
      </PageFrame>
      {can(user, "task.create", {}) && <TaskDialog key={creating ? "open" : "closed"} open={creating} onOpenChange={setCreating} />}
    </>
  )
}

/** 只知道单号（旧的 #/work?id=W-… 跳过来的）：查这张单派给了哪个任务，换成那个任务的抽屉里看这张单；查不到就提示一下 */
function WorkRedirect({ id }: { id: string }) {
  const item = useQuery(trpc.work.get.queryOptions({ id }, { retry: false }))
  React.useEffect(() => {
    // location.replace：不留这一步的历史记录
    if (item.data) window.location.replace(href("tasks", { id: item.data.taskId, work: id }))
    if (item.isError) {
      toast.add({ title: `找不到派活单 ${id}`, description: "可能是链接里的单号写错了。", type: "error" })
      window.location.replace(href("tasks"))
    }
  }, [item.data, item.isError, id])
  return null
}

/** 抽屉：头部是任务（编号、标题、负责人，定时在详情的「什么时候跑」里；右边「会话」按钮去会话页只看这个任务的 session），中间是任务详情、某次 session 或派给它的一张单，底部是主管操作 */
function TaskSheetBody({ task, runId, workId, state, canEdit }: { task: TaskDef; runId: string | null; workId: string | null; state: TasksState; canEdit: boolean }) {
  const staffName = useStaffName()
  const runs = state.runsOf(task.id)
  return (
    <>
      <SheetHeader className="pr-12">
        <div className="flex flex-wrap items-center gap-2 pb-1 text-muted-foreground">
          <span className="font-mono">{task.id}</span>
          <Button variant="outline" size="sm" className="ml-auto" nativeButton={false} render={<a href={href("sessions", { task: task.id })} />}>
            <HistoryIcon data-icon="inline-start" />会话（{runs.length}）
          </Button>
        </div>
        <SheetTitle>{task.title}</SheetTitle>
        <SheetDescription>
          负责人 {staffName(task.ownerId)} · 创建于 {fmtDateTime(task.createdAt)}
        </SheetDescription>
      </SheetHeader>
      <Separator />
      <div key={runId ?? workId ?? task.id} className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4 *:shrink-0">
        {runId ? (
          <>
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setParams({ run: null })}><ArrowLeftIcon data-icon="inline-start" />{workId ? `派活单 ${workId}` : `${task.id} 任务详情`}</Button>
            <RunDetail task={task} run={runs.find((run) => run.id === runId)} />
          </>
        ) : workId ? (
          <>
            <Button variant="ghost" size="sm" className="self-start" onClick={() => setParams({ work: null })}><ArrowLeftIcon data-icon="inline-start" />返回任务 {task.id}</Button>
            <WorkItemView id={workId} />
          </>
        ) : <TaskDetail task={task} state={state} canEdit={canEdit} />}
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
  // 能被派活、不定时的：写名额，不写「只跑一次」
  if (task.dispatch && !task.schedule) return [`被派活 · 同时最多 ${task.dispatch.maxRunning} 个`, !task.enabled && "已停用", task.steps.length ? `${task.steps.length} 步` : "agent 自己探索"].filter(Boolean).join(" · ")
  const next = !task.enabled ? "已停用" : task.nextRunAt ? `下次 ${fmtShort(task.nextRunAt)}` : task.schedule ? "下次按 cron 算" : ""
  const marks = task.steps.filter((step) => step.checkpoint).length
  const steps = task.steps.length ? `${task.steps.length} 步${marks ? ` · ${marks} 检查点` : ""}` : "agent 自己探索"
  return [task.schedule?.text ?? "只跑一次", next, steps].filter(Boolean).join(" · ")
}

/** 被派任务的「排队 3 · 在办 2」：只写不是 0 的，都是 0 不写 */
function queueLine(stats?: WorkQueueStats) {
  if (!stats) return ""
  return [stats.queued > 0 && `排队 ${stats.queued}`, stats.running > 0 && `在办 ${stats.running}`].filter(Boolean).join(" · ")
}

/** 任务卡片：只说明任务（标题、目标、定时和步骤、负责人、开关），不显示运行状态；被派任务多一行排队、在办的单数 */
function TaskCard({ task, queue, canToggle, onToggle }: { task: TaskDef; queue?: WorkQueueStats; canToggle: boolean; onToggle: (enabled: boolean) => void }) {
  const queued = queueLine(queue)
  const staffName = useStaffName()
  return (
    <Card size="sm" className="relative">
      <CardContent className="flex flex-1 flex-col gap-1.5">
        <div className="flex items-start gap-2">
          {/* 整张卡可点：链接铺满卡片，开关浮在上面 */}
          <a href={href("tasks", { id: task.id })} className="line-clamp-2 min-w-0 flex-1 text-sm font-medium after:absolute after:inset-0 hover:underline">{task.title}</a>
          <span className="shrink-0 pt-0.5 font-mono text-muted-foreground">{task.id}</span>
        </div>
        <p className="line-clamp-2 text-muted-foreground">目标：{task.goal}</p>
        <p className="mt-auto truncate pt-1 text-muted-foreground">{metaLine(task)}</p>
        {queued && <p className="truncate text-muted-foreground tabular-nums">{queued}</p>}
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
