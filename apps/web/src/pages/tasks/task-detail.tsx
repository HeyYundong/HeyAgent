// 任务详情（放在右侧抽屉里）：分区卡 + 抽屉底部的操作。
import * as React from "react"
import { CircleStopIcon, EllipsisIcon, HandIcon, PaperclipIcon, PencilIcon, PlayIcon, SendIcon, Trash2Icon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { BROWSER_TOOL_ID, DESKTOP_TOOL_ID, WORK_DISPATCH_TOOL_ID, type TaskDef } from "@heyagent/shared"

import { useAction } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import type { TasksState } from "./parts"
import { CancelRunDialog, isActive, ResumeButton, RunWithFilesDialog, TaskAttachments, useStartRun } from "./run-actions"
import {
  BrowserConfig, ConfigLine, DeliverablesView, DesktopConfig, DispatchOutSection, MemoryBadges, ModelBadge, resultsText, RoutineBadges, RuleBadges, SkillBadges, StepsView, ToolBadges, VerifyReviewLines,
} from "./task-config"
import { TaskDialog } from "./task-dialog"
import { TaskMemorySection } from "./task-memory"
import { TaskRoutineSection } from "./task-routine"
import { TaskScheduleSection } from "./task-schedule"
import { DispatchInSection, TaskDispatchDialog } from "./work-section"

/** 抽屉底部的操作（负责人和主管）：启动开关 + 编辑 / 带附件运行 / 取消 / 删除 + 主按钮。
 * 主按钮按最近一次运行的状态变：挂起等待 → 立即继续；等人处理 → 去处理（会话页打开这次运行，顶上就能处理）；执行中 → 正在运行；其他 → 立即运行 */
export function TaskActions({ task, state }: { task: TaskDef; state: TasksState }) {
  const runs = state.runsOf(task.id)
  const latest = runs[0]
  const [editing, setEditing] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [withFiles, setWithFiles] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)
  const setEnabled = useAction(trpc.tasks.setEnabled.mutationOptions(), { success: (_data, vars) => (vars.enabled ? "任务已启动" : "任务已停用，不会再自动运行") })
  const remove = useAction(trpc.tasks.delete.mutationOptions({ onSuccess: () => setParams({ id: null, run: null }) }), { success: `任务 ${task.id} 已删除` })
  const start = useStartRun(task)
  const [dispatching, setDispatching] = React.useState(false)
  // ?dispatch=1（导入后的「派一张试试」、旧的 #/work?task=…&new=1）直接打开「派一张」；关掉时从网址里去掉
  const { params } = useRoute()
  const dispatchFromUrl = Boolean(task.dispatch) && params.get("dispatch") === "1"
  const closeDispatch = (open: boolean) => {
    setDispatching(open)
    if (!open && dispatchFromUrl) setParams({ dispatch: null })
  }
  let primary: React.ReactNode
  // 能被派活的任务：「立即运行」换成「派一张」（不然开出来的运行没有参数，agent 不知道办哪件）；同时可能有好几个运行，不按最近一次变
  if (task.dispatch)
    primary = <Button onClick={() => setDispatching(true)}><SendIcon data-icon="inline-start" />派一张</Button>
  else if (latest?.status === "waiting") primary = <ResumeButton run={latest} />
  else if (latest?.status === "needs_human")
    primary = <Button nativeButton={false} render={<a href={href("sessions", { status: "human", id: latest.id })} />}><HandIcon data-icon="inline-start" />去处理</Button>
  else if (latest?.status === "running" || latest?.status === "verifying") primary = <Button disabled><Spinner data-icon="inline-start" />正在运行</Button>
  else
    primary = (
      <Button disabled={start.isPending} onClick={() => start.mutate({ taskId: task.id })}>
        {start.isPending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}立即运行
      </Button>
    )
  return (
    <>
      <label className="flex items-center gap-2">
        <Switch checked={task.enabled} disabled={setEnabled.isPending} onCheckedChange={(on) => setEnabled.mutate({ id: task.id, enabled: Boolean(on) })} aria-label="启动这个任务" />
        {task.enabled ? "已启动" : "已停用"}
      </label>
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="任务的更多操作" />}>
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => setEditing(true)}><PencilIcon />编辑</DropdownMenuItem>
            {!task.dispatch && <DropdownMenuItem disabled={isActive(latest)} onClick={() => setWithFiles(true)}><PaperclipIcon />带附件运行…</DropdownMenuItem>}
            {latest && isActive(latest) && <DropdownMenuItem variant="destructive" onClick={() => setCancelling(true)}><CircleStopIcon />取消运行 {latest.id}</DropdownMenuItem>}
            <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}><Trash2Icon />删除</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {primary}
      </div>
      {task.dispatch && <TaskDispatchDialog task={task} open={dispatching || dispatchFromUrl} onOpenChange={closeDispatch} />}
      <RunWithFilesDialog key={withFiles ? "files-open" : "files-closed"} task={task} open={withFiles} onOpenChange={setWithFiles} />
      {latest && <CancelRunDialog key={`${latest.id}-${cancelling}`} run={latest} open={cancelling} onOpenChange={setCancelling} />}
      <TaskDialog key={editing ? "edit" : "closed"} open={editing} onOpenChange={setEditing} task={task} />
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          {runs.length > 0 ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>这个任务不能删除</AlertDialogTitle>
                <AlertDialogDescription>它已经有 {runs.length} 次运行记录，运行记录要留着查。不想让它再运行，就把它停用。</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>知道了</AlertDialogCancel>
                {task.enabled && <AlertDialogAction onClick={() => setEnabled.mutate({ id: task.id, enabled: false })}>停用这个任务</AlertDialogAction>}
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>删除任务 {task.id}「{task.title}」？</AlertDialogTitle>
                <AlertDialogDescription>它还没运行过。删除后步骤、检查点和选用的配置都会清掉，不能恢复；挂在它上面的人加的待办也会一起删除。</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>先不删</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => remove.mutate({ id: task.id })}>删除任务</AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** 抽屉里的任务详情（「列表」视图）：只说明任务，分区卡（目标和步骤 / 交付物 / 固化流程（有才显示）/ 什么时候跑 / 任务记忆 / 附件 / 用到的配置）。标题和操作在抽屉的头和底。
 * 不放运行状态和运行记录：每次运行在「会话」页看（抽屉头部的「会话」按钮带上这个任务筛好）。「结构图」视图在 task-structure.tsx，两边用同一批小块（task-config.tsx） */
export function TaskDetail({ task, state, canEdit }: { task: TaskDef; state: TasksState; canEdit: boolean }) {
  const taskRuns = state.runsOf(task.id)
  return (
    <>
      {task.dispatch && <DispatchInSection task={task} />}
      {task.toolIds.includes(WORK_DISPATCH_TOOL_ID) && <DispatchOutSection task={task} />}
      <DetailSection title="目标和步骤">
        <div className="flex flex-col gap-4">
          <p><span className="text-muted-foreground">目标：</span>{task.goal}</p>
          <StepsView task={task} latest={taskRuns[0]} />
        </div>
      </DetailSection>
      <DetailSection title="交付物" description="每次运行要交出来的东西。agent 结束时要逐项交齐、在总结里写明在哪，复核逐项核对，缺一项记没办成。在「编辑」里改。">
        <div className="flex flex-col gap-3">
          <DeliverablesView task={task} empty="没写交付物：按目标判断办成没有。" />
          {task.dispatch && (task.dispatch.results ?? []).length > 0 && <ConfigLine label="交回">{resultsText(task)}</ConfigLine>}
        </div>
      </DetailSection>
      <TaskRoutineSection task={task} canEdit={canEdit} />
      <TaskScheduleSection task={task} canEdit={canEdit} />
      <TaskMemorySection task={task} runs={taskRuns} canEdit={canEdit} />
      <DetailSection title="附件" description="任务附件每次运行都会带上，agent 用「读附件」工具读。只想这一次带的，用「⋯ → 带附件运行」。">
        <TaskAttachments task={task} canEdit={canEdit} />
      </DetailSection>
      <UsedConfig task={task} />
    </>
  )
}

function UsedConfig({ task }: { task: TaskDef }) {
  return (
    <DetailSection title="用到的配置" description="建任务时选的，外加每个任务都自带的几个工具；agent 只能用这里列出的。点徽章去对应页面。">
      <div className="flex flex-col gap-3">
        <ModelBadge task={task} />
        <VerifyReviewLines task={task} />
        <MemoryBadges task={task} />
        <SkillBadges task={task} />
        <ToolBadges task={task} />
        <RoutineBadges task={task} />
        <RuleBadges task={task} />
        {task.toolIds.includes(BROWSER_TOOL_ID) && <BrowserConfig task={task} />}
        {task.toolIds.includes(DESKTOP_TOOL_ID) && <DesktopConfig task={task} />}
      </div>
    </DetailSection>
  )
}
