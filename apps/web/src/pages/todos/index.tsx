// 待办（v3）：看板。每次运行一张卡，随状态在五列之间移动；每件要人办的事、每条人加的待办单独一张卡。
// 吸收了原来的「待我处理」：在「等人处理」列点开就能批 / 拒 / 审。
// 要等的时候 session 挂起，等到了继续同一个 session，不新开。卡住运行的事全处理完，这次运行以运行卡回到看板。
// 人加的待办：新建、编辑、删除接通后端（M1 P2）；记忆审核、技能修改在这里也能批。
// 立即继续、立即执行、处理审批 / 验收 / 登录、主管手动触发事件接引擎（M1 P3）。
import * as React from "react"
import { KanbanIcon, PlusIcon } from "lucide-react"

import { EmptyState, PageFrame, SimpleHeader } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { boardCards, can, findById, type HumanTodo, type TaskDef } from "@heyagent/shared"

import { useBoardQuery, useModelsQuery, useRulesQuery, useSessionsQuery, useStaffQuery, useTasksQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { setParams, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { Board, type Card } from "./board"
import { HumanSheet } from "./human-sheet"
import { RunSheet, TodoSheet } from "./sheets"
import { TodoDialog } from "./todo-dialog"

export default function TodosPage() {
  const { user } = useMe()
  const { params } = useRoute()
  const boardQuery = useBoardQuery()
  const sessionsQuery = useSessionsQuery()
  const tasksQuery = useTasksQuery()
  // Sheet 里还要：人名、模型名、拦下它的规则
  const queries = [boardQuery, sessionsQuery, tasksQuery, useStaffQuery(), useModelsQuery(), useRulesQuery()]
  const runs = sessionsQuery.data ?? []
  const tasks = tasksQuery.data ?? []
  const [editing, setEditing] = React.useState<HumanTodo | "new" | null>(null) // "new" 表示新加
  const [deleting, setDeleting] = React.useState<HumanTodo | null>(null)
  const removeTodo = useAction(trpc.todos.delete.mutationOptions({ onSuccess: () => setParams({ id: null }) }), { success: "待办已删除" })

  const ownerOf = (taskId: string) => findById(tasks, taskId)?.ownerId ?? ""
  const cards: Card[] = boardCards({ runs, tasks, humanItems: boardQuery.data?.humanItems ?? [], humanTodos: boardQuery.data?.humanTodos ?? [] })
  // 员工也看全部卡片（只读），只能操作分给自己的；「等人处理」的运行不在看板上，但 ?id= 能直接打开它的 Sheet
  const blocked = runs.find((run) => run.id === params.get("id") && run.status === "needs_human")
  const blockedTask = blocked && findById(tasks, blocked.taskId)
  const selected = cards.find((card) => card.id === params.get("id")) ?? (blocked && blockedTask && { kind: "run", id: blocked.id, run: blocked, task: blockedTask, column: "needs_human" } as Card)
  const [shown, setShown] = React.useState(selected) // 关 Sheet 时 ?id= 先清掉了，留着上一张卡，让关闭动画有内容
  if (selected && selected.id !== shown?.id) setShown(selected)
  const card = selected ?? shown
  const open = Boolean(selected)
  const close = () => setParams({ id: null })
  // 「等哪个事件」的选项：数据里已经在等的事件（人加的待办、挂起的 session），不在代码里写死
  const eventOptions = [
    ...(boardQuery.data?.humanTodos ?? []).map((todo) => todo.trigger),
    ...runs.flatMap((run) => (run.waiting ? [run.waiting.trigger] : [])),
  ].flatMap((trigger) => ("event" in trigger ? [trigger.event] : []))
  // 只能给自己负责的任务加待办（主管全部能加）
  const taskOptions: TaskDef[] = tasks.filter((task) => can(user, "todo.create", { taskOwnerId: task.ownerId }))

  const needsMe = cards.filter((each) => each.kind === "human" && (user.isAdmin || each.item.assigneeId === user.id)).length // 员工只算分给自己的
  const header = (
    <SimpleHeader title="待办" learnId="todo" description={`每次运行一张卡，随状态移动；要等就挂起，等到了继续同一个 session。${needsMe > 0 ? `等你处理 ${needsMe} 件。` : ""}`}
      action={taskOptions.length > 0 && <Button onClick={() => setEditing("new")}><PlusIcon data-icon="inline-start" />加一条待办</Button>} />
  )
  const empty = (
    <EmptyState
      icon={<KanbanIcon />}
      title="看板是空的"
      description={tasks.length === 0 ? "还没有任务。先去「任务」页建一个任务，运行后每次运行会作为一张卡出现在这里。" : "任务开始运行后，每次运行会作为一张卡出现在这里；要人办的事会放进「等人处理」。也可以点下面给任务加一条待办，到点让 agent 去做。"}
      action={taskOptions.length > 0 && <Button onClick={() => setEditing("new")}><PlusIcon data-icon="inline-start" />加一条待办</Button>}
    />
  )

  return (
    <>
      <PageFrame header={header} queries={queries} isEmpty={cards.length === 0} empty={empty} skeleton="board"><Board cards={cards} userId={user.id} /></PageFrame>
      {card?.kind === "run" && (
        <RunSheet run={card.run} task={card.task} column={card.column} note={card.note} canAct={can(user, "session.resume", { taskOwnerId: card.task.ownerId })} isAdmin={user.isAdmin} open={open} onClose={close} />
      )}
      {card?.kind === "human" && (
        <HumanSheet key={card.id} item={card.item} runs={runs} open={open} userId={user.id} canAct={can(user, "humanItem.resolve", { assigneeId: card.item.assigneeId })} onClose={close} />
      )}
      {card?.kind === "todo" && (
        <TodoSheet todo={card.todo} runs={runs} tasks={tasks} open={open} canRun={can(user, "todo.run", { createdById: card.todo.createdById, taskOwnerId: ownerOf(card.todo.taskId) })}
          canManage={can(user, "todo.manage", { createdById: card.todo.createdById })} isAdmin={user.isAdmin} onClose={close}
          onEdit={() => setEditing(card.todo)} onDelete={() => setDeleting(card.todo)} />
      )}
      <TodoDialog key={editing === "new" ? "new" : (editing?.id ?? "closed")} open={editing !== null} onOpenChange={(next) => !next && setEditing(null)}
        todo={editing === "new" ? undefined : (editing ?? undefined)} taskOptions={editing && editing !== "new" ? [...taskOptions, ...tasks.filter((task) => task.id === editing.taskId && !taskOptions.includes(task))] : taskOptions} eventOptions={eventOptions} />
      <AlertDialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条待办？</AlertDialogTitle>
            <AlertDialogDescription>「{deleting?.title}」删除后就不会再触发，不能恢复。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不删</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => deleting && removeTodo.mutate({ id: deleting.id })}>删除待办</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
