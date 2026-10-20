// 任务详情的「什么时候跑」：先一行任务自己的定时（「改」打开编辑任务），再每条人加的待办一行（原来在「待办」页）。
// 人加的待办：到点、按 cron 或等到事件，就让这个任务的 agent 去做一件事；任务有挂起的 session 就继续它，没有就新开一次运行。
// 权限照 shared 的 can()：加 = todo.create（自己负责的任务），立即执行 = todo.run（加的人、任务负责人），改 / 删 = todo.manage（加的人）；主管全部能做，还能手动触发待办在等的事件。
import * as React from "react"
import { EllipsisIcon, PencilIcon, PlayIcon, PlusIcon, Trash2Icon, ZapIcon } from "lucide-react"
import { addDaysIso, can, fmtDateTime, type HumanTodo, type TaskDef, type Trigger } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Kbd } from "@/components/ui/kbd"
import { useBoardQuery, useSessionsQuery, useStaffName, useTasksQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { shortTime } from "./cron"
import { nextRunText } from "./parts"
import { eventOf, useFireEvent } from "./run-actions"
import { TaskDialog } from "./task-dialog"
import { TodoDialog } from "./todo-dialog"

const KIND_LABEL: Record<Trigger["kind"], string> = { time: "跑一次", cron: "cron", event: "等事件", time_or_event: "先到先继续" }

/** ISO 时间 →「10-17 周六 10:00」（按上海时间） */
const isoShortTime = (iso: string) => shortTime(fmtDateTime(iso))

/** 人加的待办「什么时候」：cron 写人话和下次；只等事件的写出最晚等到什么时候（加的时间 + fallbackDays），到期提醒负责人 */
function todoWhen(trigger: Trigger, since: string) {
  if (trigger.kind === "time") return `${isoShortTime(trigger.at)} 做一次`
  if (trigger.kind === "cron") return `${trigger.text}，下次 ${isoShortTime(trigger.next)}`
  if (trigger.kind === "event") return `等到「${trigger.event}」；最多等到 ${isoShortTime(addDaysIso(since, trigger.fallbackDays))}，到期提醒负责人`
  return `等到「${trigger.event}」先做，最晚 ${isoShortTime(trigger.at)}`
}

export function TaskScheduleSection({ task, canEdit }: { task: TaskDef; canEdit: boolean }) {
  const { user } = useMe()
  const tasks = useTasksQuery().data ?? []
  const runs = useSessionsQuery().data ?? []
  const allTodos = useBoardQuery().data?.humanTodos ?? []
  const todos = allTodos.filter((todo) => todo.taskId === task.id)
  const [editingTask, setEditingTask] = React.useState(false)
  const [editing, setEditing] = React.useState<HumanTodo | "new" | null>(null) // "new" 表示新加
  const [deleting, setDeleting] = React.useState<HumanTodo | null>(null)
  const remove = useAction(trpc.todos.delete.mutationOptions({ onSuccess: () => setDeleting(null) }), { success: "待办已删掉" })

  // 只能给自己负责的任务加待办（主管全部能加）；改的时候可以换到别的任务
  const taskOptions = tasks.filter((each) => can(user, "todo.create", { taskOwnerId: each.ownerId }))
  const canCreate = can(user, "todo.create", { taskOwnerId: task.ownerId })
  // 「等哪个事件」的选项：数据里已经在等的事件（人加的待办、挂起的 session），不在代码里写死
  const eventOptions = [...allTodos.map((todo) => todo.trigger), ...runs.flatMap((run) => (run.waiting ? [run.waiting.trigger] : []))].flatMap((trigger) => eventOf(trigger) ?? [])
  const editingTodo = editing === "new" ? undefined : (editing ?? undefined)
  const dialogTasks = editingTodo && !taskOptions.some((each) => each.id === editingTodo.taskId) ? [...taskOptions, ...tasks.filter((each) => each.id === editingTodo.taskId)] : taskOptions
  const { schedule } = task

  return (
    <DetailSection
      title="什么时候跑"
      description="任务自己的定时在「编辑任务」里改。下面「人加的待办」是到点、按 cron 或等到某个事件时，让这个任务的 agent 去做一件事：任务有挂起的 session 就继续它，没有就开始一次新的运行。"
      action={canCreate && <Button variant="outline" size="sm" onClick={() => setEditing("new")}><PlusIcon data-icon="inline-start" />加一条</Button>}
    >
      {!schedule && todos.length === 0 ? (
        <p className="text-muted-foreground">{task.dispatch ? "有派活单就开始跑，不定时；也可以点「派一张」。" : "只在点「运行」时跑。"}</p>
      ) : (
        <ItemGroup className="gap-2">
          {schedule && (
            <Item variant="outline" size="sm">
              <ItemContent className="min-w-0">
                <ItemTitle><Badge variant="secondary">任务设置</Badge>{schedule.text}</ItemTitle>
                <ItemDescription className="flex flex-wrap items-center gap-1">cron <Kbd>{schedule.cron}</Kbd> · 下次 {nextRunText(task)}</ItemDescription>
              </ItemContent>
              {canEdit && <ItemActions><Button variant="ghost" size="sm" onClick={() => setEditingTask(true)}><PencilIcon data-icon="inline-start" />改</Button></ItemActions>}
            </Item>
          )}
          {todos.map((todo) => (
            <TodoRow key={todo.id} todo={todo} task={task} onEdit={() => setEditing(todo)} onDelete={() => setDeleting(todo)} />
          ))}
        </ItemGroup>
      )}
      {canEdit && <TaskDialog key={editingTask ? "task-edit" : "task-closed"} open={editingTask} onOpenChange={setEditingTask} task={task} />}
      <TodoDialog key={editing === "new" ? "todo-new" : `todo-${editing?.id ?? "closed"}`} open={editing !== null} onOpenChange={(next) => !next && setEditing(null)}
        todo={editingTodo} taskOptions={dialogTasks} initialTaskId={task.id} eventOptions={eventOptions} />
      <AlertDialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删掉这条待办？</AlertDialogTitle>
            <AlertDialogDescription>「{deleting?.title}」删掉后就不会再触发，不能恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不删</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate({ id: deleting.id })}>删掉</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSection>
  )
}

/** 一条人加的待办：触发方式、要做的事和什么时候、谁加的；「⋯」里立即执行 / 改 / 删掉，主管还能手动触发它在等的事件 */
function TodoRow({ todo, task, onEdit, onDelete }: { todo: HumanTodo; task: TaskDef; onEdit: () => void; onDelete: () => void }) {
  const { user } = useMe()
  const staffName = useStaffName()
  const event = eventOf(todo.trigger)
  const canRun = can(user, "todo.run", { createdById: todo.createdById, taskOwnerId: task.ownerId })
  const canManage = can(user, "todo.manage", { createdById: todo.createdById })
  const canFire = user.isAdmin && Boolean(event)
  // 立即执行和到点一样（engine.runTodoNow）：任务有挂起的 session 就继续它，没有就新开一次运行；一次性的待办执行后就结束
  const run = useAction(trpc.engine.runTodoNow.mutationOptions(), {
    success: (result) => (result.resumedSessionId ? `已继续挂起的 ${result.resumedSessionId}` : `已开始运行 ${result.startedSessionId}`),
    errorTitle: "没能执行",
  })
  const fire = useFireEvent(event ?? "")
  return (
    <Item variant="outline" size="sm">
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full"><Badge variant="outline">{KIND_LABEL[todo.trigger.kind]}</Badge><span className="min-w-0 truncate">{todo.title}</span></ItemTitle>
        <ItemDescription className="line-clamp-2">{todoWhen(todo.trigger, todo.createdAt)} · {staffName(todo.createdById)} 加的</ItemDescription>
      </ItemContent>
      {(canRun || canManage || canFire) && (
        <ItemActions>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`待办「${todo.title}」的更多操作`} />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-40">
              {canRun && <DropdownMenuItem disabled={run.isPending} onClick={() => run.mutate({ todoId: todo.id })}><PlayIcon />立即执行</DropdownMenuItem>}
              {canFire && event && <DropdownMenuItem disabled={fire.isPending} onClick={() => fire.mutate({ event })}><ZapIcon />手动触发事件</DropdownMenuItem>}
              {canManage && (
                <>
                  {(canRun || canFire) && <DropdownMenuSeparator />}
                  <DropdownMenuItem onClick={onEdit}><PencilIcon />改</DropdownMenuItem>
                  <DropdownMenuItem variant="destructive" onClick={onDelete}><Trash2Icon />删掉</DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </ItemActions>
      )}
    </Item>
  )
}
