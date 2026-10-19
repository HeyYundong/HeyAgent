// 任务记忆：任务抽屉里的一张卡，列出这个任务自己的经验（每次运行开始时全部交给 agent）。
// 负责人和主管能加、改、删；运行结束后三方 AI 提取的候选在运行详情里审核（run-digest.tsx），通过的出现在这里，标明来自哪次运行。
// 表单：React Hook Form + shared 的 taskMemoryAddSchema。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { EllipsisIcon, PencilIcon, PlusIcon, SparklesIcon, Trash2Icon } from "lucide-react"
import { fmtDateTime, TASK_MEMORY_MAX, taskMemoryAddSchema, type SessionSummary, type TaskDef, type TaskMemoryEntry } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Alert, AlertAction, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useStaffName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { trpc } from "@/lib/trpc"

const contentSchema = taskMemoryAddSchema.pick({ content: true })

/** 一次运行里还没审核的记忆候选有几条 */
export const pendingCandidates = (run: SessionSummary) => run.digest?.candidates.filter((candidate) => candidate.status === "pending").length ?? 0

export function TaskMemorySection({ task, runs, canEdit }: { task: TaskDef; runs: SessionSummary[]; canEdit: boolean }) {
  const list = useQuery(trpc.taskMemory.list.queryOptions({ taskId: task.id }))
  const staffName = useStaffName()
  const [editing, setEditing] = React.useState<TaskMemoryEntry | "new" | null>(null)
  const [deleting, setDeleting] = React.useState<TaskMemoryEntry | null>(null)
  const remove = useAction(trpc.taskMemory.delete.mutationOptions({ onSuccess: () => setDeleting(null) }), { success: "这条任务记忆已删除", errorTitle: "没删成" })
  const entries = list.data ?? []
  const toReview = canEdit ? runs.filter((run) => pendingCandidates(run) > 0) : []
  const full = entries.length >= TASK_MEMORY_MAX
  return (
    <DetailSection
      title={list.data ? `任务记忆（${entries.length}）` : "任务记忆"}
      description={`这个任务自己的经验，每次运行开始时全部交给 agent，最多 ${TASK_MEMORY_MAX} 条。可以直接写；也可以在运行结束后让三方 AI 总结那次运行、提取经验，你审核通过的才记进来。`}
      action={canEdit && (
        <Button variant="outline" size="sm" disabled={full} onClick={() => setEditing("new")}>
          <PlusIcon data-icon="inline-start" />加一条
        </Button>
      )}
    >
      <div className="flex flex-col gap-3">
        {toReview.map((run) => (
          <Alert key={run.id}>
            <SparklesIcon />
            <AlertTitle>运行 {run.id} 有 {pendingCandidates(run)} 条记忆等你审核</AlertTitle>
            <AlertAction>
              <Button variant="outline" size="sm" nativeButton={false} render={<a href={href("tasks", { id: task.id, run: run.id })} />}>去审核</Button>
            </AlertAction>
          </Alert>
        ))}
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <p className="text-destructive">任务记忆没取到，稍后再试。</p>
        ) : entries.length === 0 ? (
          <p className="text-muted-foreground">还没有任务记忆。{canEdit ? "点「加一条」直接写；运行结束后，也可以在运行详情里让三方 AI 总结、提取。" : ""}</p>
        ) : (
          <ItemGroup className="gap-2">
            {entries.map((entry) => (
              <Item key={entry.id} variant="outline" size="xs">
                <ItemContent className="min-w-0">
                  <ItemTitle className="line-clamp-none whitespace-pre-line">{entry.content}</ItemTitle>
                  <ItemDescription>
                    {entry.sourceSessionId ? (
                      <>来自运行 <a href={href("tasks", { id: task.id, run: entry.sourceSessionId })}>{entry.sourceSessionId}</a> · {staffName(entry.createdById)} 审核通过 · {fmtDateTime(entry.createdAt)}</>
                    ) : (
                      <>{staffName(entry.createdById)} 写的 · {fmtDateTime(entry.createdAt)}</>
                    )}
                    {entry.updatedAt !== entry.createdAt && ` · 改于 ${fmtDateTime(entry.updatedAt)}`}
                  </ItemDescription>
                </ItemContent>
                {canEdit && (
                  <ItemActions>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="这条记忆的操作" />}>
                        <EllipsisIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-32">
                        <DropdownMenuItem onClick={() => setEditing(entry)}><PencilIcon />编辑</DropdownMenuItem>
                        <DropdownMenuItem variant="destructive" onClick={() => setDeleting(entry)}><Trash2Icon />删除</DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </ItemActions>
                )}
              </Item>
            ))}
          </ItemGroup>
        )}
      </div>
      <TaskMemoryDialog key={editing === "new" ? "new" : (editing?.id ?? "closed")} task={task} entry={editing === "new" ? undefined : (editing ?? undefined)} open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} />
      <AlertDialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除这条任务记忆？</AlertDialogTitle>
            <AlertDialogDescription>「{deleting?.content}」删除后不能恢复，从下一次运行开始 agent 就读不到了。正在跑的运行不受影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不删</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate({ id: deleting.id })}>
              {remove.isPending ? <Spinner data-icon="inline-start" /> : <Trash2Icon data-icon="inline-start" />}删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSection>
  )
}

/** 加一条 / 编辑一条任务记忆 */
function TaskMemoryDialog({ task, entry, open, onOpenChange }: { task: TaskDef; entry?: TaskMemoryEntry; open: boolean; onOpenChange: (open: boolean) => void }) {
  const form = useForm<{ content: string }>({ resolver: zodResolver(contentSchema), defaultValues: { content: entry?.content ?? "" } })
  const { errors } = form.formState
  const add = useAction(trpc.taskMemory.add.mutationOptions(), { success: "已加进任务记忆，下一次运行开始生效" })
  const update = useAction(trpc.taskMemory.update.mutationOptions(), { success: "任务记忆已保存，下一次运行开始生效" })
  const pending = add.isPending || update.isPending
  const submit = form.handleSubmit(async ({ content }) => {
    const done = entry ? await update.submit({ id: entry.id, content }) : await add.submit({ taskId: task.id, content })
    if (done) onOpenChange(false)
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{entry ? "编辑任务记忆" : "加一条任务记忆"}</DialogTitle>
          <DialogDescription>只给任务 {task.id}「{task.title}」用，每次运行开始时交给 agent。正在跑的运行不受影响。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field data-invalid={!!errors.content}>
            <FieldLabel htmlFor="task-memory-content">内容</FieldLabel>
            <Textarea id="task-memory-content" rows={4} placeholder="例如：导出按钮要等表格加载完再点，不然没反应" aria-invalid={!!errors.content} {...form.register("content")} />
            <FieldDescription>一两句话写清一条做法或注意事项。只对这一次有效的数据、密码和密钥不要写进来。</FieldDescription>
            <FieldError errors={[errors.content]} />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
