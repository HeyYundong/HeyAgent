// 派活页的弹窗：派一张（按被派任务声明的参数生成表单）、改参数（只有排队的单）、不办了 / 重办的确认。
// 「派一张」任务页的抽屉里也用（能被派活的任务，「立即运行」换成「派一张」）。
// 表单用 React Hook Form + Field（docs/ui-rules.md 第 8 节登记过的写法）；参数按声明顺序放在一个数组里，免得参数名里的「.」被当成路径。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useForm, useWatch } from "react-hook-form"
import { ArrowRightIcon, InfoIcon } from "lucide-react"
import { workDedupeKey, workDefaultTitle, type TaskDef, type TaskDispatchParam, type WorkItem, type WorkItemDetail } from "@heyagent/shared"

import { HelpTip } from "@/components/shell/simple-page"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { WorkItemBadge, timeText, useWorkTaskStats } from "./parts"

/** 按声明把表单里的数组换成参数对象：去掉首尾空白，空的不带 */
function toParams(declared: TaskDispatchParam[], values: string[] = []) {
  return Object.fromEntries(declared.flatMap((param, index) => (values[index]?.trim() ? [[param.name, values[index].trim()]] : [])))
}

/** 停一会儿再用（填参数时查「已经有了吗」，不每敲一个字查一次） */
function useDebounced<T>(value: T, ms = 400) {
  const [debounced, setDebounced] = React.useState(value)
  React.useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms)
    return () => clearTimeout(timer)
  }, [value, ms])
  return debounced
}

interface DispatchForm {
  taskId: string
  values: string[]
  title: string
  note: string
}

export function DispatchDialog({
  open,
  onOpenChange,
  taskOptions,
  initialTaskId,
  onDone,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 能被派活、而且自己有权限的任务 */
  taskOptions: TaskDef[]
  initialTaskId?: string
  /** 派出去了（或者同一件事已经有单）：页面决定去哪 */
  onDone: (item: WorkItem, existing: boolean) => void
}) {
  const form = useForm<DispatchForm>({ defaultValues: { taskId: initialTaskId ?? taskOptions[0]?.id ?? "", values: [], title: "", note: "" } })
  const [taskId, values] = useWatch({ control: form.control, name: ["taskId", "values"] })
  const task = taskOptions.find((each) => each.id === taskId)
  const declared = task?.dispatch?.params ?? []
  const params = toParams(declared, values)
  const key = task?.dispatch ? workDedupeKey(task.dispatch, params) : null
  // 同一件事已经有单了吗：去重参数都填了才查；查不了（后端没做完、出错）就当没有，派的时候后端还会再判一次
  const lookupInput = useDebounced({ taskId, params })
  const lookupKey = task?.dispatch ? workDedupeKey(task.dispatch, lookupInput.params) : null
  const lookup = useQuery(trpc.work.lookup.queryOptions(lookupInput, { enabled: open && Boolean(task) && Boolean(lookupKey?.replace(/\|/g, "")), retry: false }))
  const duplicate = key && key === lookupKey && !lookup.isError ? lookup.data : undefined
  const stats = useWorkTaskStats(task?.id, open && Boolean(task))
  const taskItems = taskOptions.map((each) => ({ value: each.id, label: `${each.id} ${each.title}` }))
  const { errors } = form.formState

  const send = useAction(trpc.work.dispatch.mutationOptions(), { errorTitle: "没派出去" })
  const submit = form.handleSubmit(async (form) => {
    if (!task?.dispatch || duplicate) return
    const filled = toParams(declared, form.values)
    const result = await send.submit({ taskId: task.id, params: filled, title: form.title.trim() || undefined, note: form.note.trim() || undefined })
    if (result) onDone(result.item, result.existing)
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>派一张</DialogTitle>
          <DialogDescription>手动派一件事给能被派活的任务。参数按那个任务要的填，派出去以后排队，轮到了开一次运行。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field>
              <FieldLabel htmlFor="dispatch-task">派给哪个任务</FieldLabel>
              <Select
                items={taskItems}
                value={taskId}
                onValueChange={(next) => {
                  if (!next) return
                  form.reset({ taskId: String(next), values: [], title: form.getValues("title"), note: form.getValues("note") })
                }}
              >
                <SelectTrigger id="dispatch-task" className="w-full">
                  <SelectValue placeholder="没有你能派活的任务" />
                </SelectTrigger>
                <SelectContent>
                  {taskItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {task && (
                <FieldDescription>
                  {!task.enabled
                    ? "这个任务停用了：单会先排着，重新启用后自动开始办"
                    : stats.data
                      ? `同时最多 ${stats.data.maxRunning} 个在跑 · 现在排队 ${stats.data.queued} 张`
                      : `同时最多 ${task.dispatch?.maxRunning ?? 1} 个在跑`}
                </FieldDescription>
              )}
            </Field>
            {declared.map((param, index) => {
              const id = `dispatch-param-${index}`
              const error = errors.values?.[index]
              return (
                <Field key={`${task?.id}-${param.name}`} data-invalid={!!error}>
                  <FieldLabel htmlFor={id}>
                    {param.name}
                    {!param.required && <span className="font-normal text-muted-foreground">（可以不填）</span>}
                    {param.dedupe && <Badge variant="outline">去重</Badge>}
                  </FieldLabel>
                  <Input
                    id={id}
                    aria-invalid={!!error}
                    {...form.register(`values.${index}`, { validate: (value) => !param.required || Boolean(value?.trim()) || `${param.name}要填` })}
                  />
                  {param.description && <FieldDescription>{param.description}</FieldDescription>}
                  <FieldError errors={[error]} />
                </Field>
              )
            })}
            {duplicate && <DuplicateAlert item={duplicate} />}
            <FieldSeparator />
            <Field>
              <FieldLabel htmlFor="dispatch-title">
                标题<span className="font-normal text-muted-foreground">（可以不写）</span>
              </FieldLabel>
              <Input id="dispatch-title" placeholder={task?.dispatch && Object.keys(params).length ? workDefaultTitle(task.dispatch, params) : "一句话：这件事是什么"} {...form.register("title")} />
            </Field>
            <Field>
              <FieldLabel htmlFor="dispatch-note">
                补充说明<span className="font-normal text-muted-foreground">（可以不写）</span>
              </FieldLabel>
              <Textarea id="dispatch-note" placeholder="例如：急，先看这张" {...form.register("note")} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={!task || !!duplicate || send.isPending}>
              {send.isPending && <Spinner data-icon="inline-start" />}
              派出去
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 同一件事已经有单了：只告诉现状，不重开（重开只能在那张单上点「重办」） */
function DuplicateAlert({ item }: { item: WorkItem }) {
  const ended = item.status === "done" || item.status === "failed" || item.status === "cancelled"
  const when = ended ? `（${timeText(item.finishedAt)}）` : item.sessionId ? `（${item.sessionId}）` : ""
  return (
    <Alert>
      <InfoIcon />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        {item.id} 已经有了 <WorkItemBadge item={item} long />
        {when && <span className="font-normal text-muted-foreground">{when}</span>}
      </AlertTitle>
      <AlertDescription>同一件事只办一次。{ended ? "要再办一次，去那张单上点「重办」。" : "已经在排队或在办了，不用再派。"}</AlertDescription>
      <AlertAction>
        <Button variant="outline" size="sm" nativeButton={false} render={<a href={href("work", { id: item.id })} />}>
          去看 {item.id}
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      </AlertAction>
    </Alert>
  )
}

/** 派出去以后的提示：排第几位；任务停用了写「先排着」；已经有了写现状 */
export function dispatchedToast(item: WorkItem, existing: boolean, taskEnabled: boolean, action?: { label: string; onClick: () => void }) {
  const actionProps = action && { children: action.label, onClick: action.onClick }
  if (existing) {
    toast.add({ title: `${item.id} 已经有了`, description: "同一件事只办一次，没有新建。要再办一次，去那张单上点「重办」。", actionProps })
    return
  }
  toast.add({
    title: `已派出 ${item.id}`,
    description: taskEnabled ? `排队第 ${item.queuePosition ?? 1} 位，轮到了开一次运行。` : "任务停用了，单先排着，重新启用后开始办。",
    type: "success",
    actionProps,
  })
}

interface EditForm {
  values: string[]
  title: string
  note: string
}

/** 改参数：只有排队的单能改。去重的参数不能改（改了就是另一件事） */
export function EditParamsDialog({ item, onClose }: { item: WorkItemDetail | null; onClose: () => void }) {
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">{item && <EditParamsForm key={item.id} item={item} onDone={onClose} />}</DialogContent>
    </Dialog>
  )
}

function EditParamsForm({ item, onDone }: { item: WorkItemDetail; onDone: () => void }) {
  const declared = item.taskDispatch?.params ?? []
  const form = useForm<EditForm>({ defaultValues: { values: declared.map((param) => item.params[param.name] ?? ""), title: item.title, note: item.note } })
  const save = useAction(trpc.work.updateParams.mutationOptions(), { success: `已改 ${item.id} 的参数，轮到它时按新的参数办`, errorTitle: "没改成" })
  const submit = form.handleSubmit(async (values) => {
    // 去重的参数原样带上（输入框是灰的，后端也会拦）
    const params = toParams(declared, values.values.map((value, index) => (declared[index]?.dedupe ? (item.params[declared[index].name] ?? "") : value)))
    if (await save.submit({ id: item.id, params, title: values.title.trim() || item.title, note: values.note.trim() })) onDone()
  })
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>改参数 · {item.id}</DialogTitle>
        <DialogDescription>还在排队，改了以后轮到它时按新的参数办。</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        {declared.map((param, index) => {
          const id = `edit-param-${index}`
          return (
            <Field key={param.name} data-disabled={param.dedupe}>
              <FieldLabel htmlFor={id}>
                {param.name}
                {param.dedupe && <Badge variant="outline">去重</Badge>}
                {param.dedupe && <HelpTip>去重的参数决定「是不是同一件事」，不能改。要换成另一件事，就「不办了」再重新派一张。</HelpTip>}
              </FieldLabel>
              <Input id={id} disabled={param.dedupe} {...form.register(`values.${index}`)} />
              {param.description && <FieldDescription>{param.description}</FieldDescription>}
            </Field>
          )
        })}
        <Field>
          <FieldLabel htmlFor="edit-title">标题</FieldLabel>
          <Input id="edit-title" {...form.register("title")} />
        </Field>
        <Field>
          <FieldLabel htmlFor="edit-note">补充说明</FieldLabel>
          <Textarea id="edit-note" {...form.register("note")} />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
        <Button type="submit" disabled={save.isPending}>
          {save.isPending && <Spinner data-icon="inline-start" />}
          保存
        </Button>
      </DialogFooter>
    </form>
  )
}

/** 不办了：排队的直接不开始；在办的会取消正在跑的运行 */
export function CancelDialog({ item, onClose }: { item: WorkItemDetail | null; onClose: () => void }) {
  const form = useForm<{ reason: string }>({ defaultValues: { reason: "" } })
  const running = item?.status === "running"
  const cancel = useAction(trpc.work.cancel.mutationOptions(), { errorTitle: "没取消成" })
  const submit = form.handleSubmit(async ({ reason }) => {
    if (!item) return
    const done = await cancel.submit({ id: item.id, reason: reason.trim() || undefined })
    if (!done) return
    toast.add({ title: `${item.id} 不办了`, description: running && item.sessionId ? `已取消运行 ${item.sessionId}。` : "不会再开始。" })
    form.reset()
    onClose()
  })
  return (
    <AlertDialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <form onSubmit={submit} className="contents">
          <AlertDialogHeader>
            <AlertDialogTitle>{item?.id} 不办了？</AlertDialogTitle>
            <AlertDialogDescription>
              {running
                ? `这张单正在办。不办了会取消正在跑的运行${item?.sessionId ? ` ${item.sessionId}` : ""}；已经对外做过的事（发过的消息、建好的数据）不会撤回。`
                : "这张单还在排队，不办了就不会开始。"}
              以后同一件事再派进来，也只会返回「不办了」；要办的话在这张单上点「重办」。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <Field>
            <FieldLabel htmlFor="cancel-reason">
              原因<span className="font-normal text-muted-foreground">（可以不写）</span>
            </FieldLabel>
            <Textarea id="cancel-reason" placeholder="例如：对方撤回了这件事" {...form.register("reason")} />
          </Field>
          <AlertDialogFooter>
            <AlertDialogCancel type="button">先不动</AlertDialogCancel>
            <Button type="submit" variant="destructive" disabled={cancel.isPending}>
              {cancel.isPending && <Spinner data-icon="inline-start" />}
              {running ? "取消运行，不办了" : "不办了"}
            </Button>
          </AlertDialogFooter>
        </form>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/** 重办：没办成、不办了的直接重办；办完的先弹确认（会再对外做一遍） */
export function useRedo(onDone?: () => void) {
  return useAction(
    trpc.work.redo.mutationOptions({
      onSuccess: (item) => {
        toast.add({ title: `已重办 ${item.id}`, description: `排队等第 ${item.attempts + 1} 次运行；以前的运行都留着。`, type: "success" })
        onDone?.()
      },
    }),
    { errorTitle: "没重办成" }
  )
}

export function RedoDoneDialog({ item, onClose }: { item: WorkItemDetail | null; onClose: () => void }) {
  const redo = useRedo(onClose)
  return (
    <AlertDialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{item?.id} 已经办完了，还要再办一次？</AlertDialogTitle>
          <AlertDialogDescription>会按同样的参数再开一次运行，可能把已经对外做过的事再做一遍。上一次的结果和运行都留着。</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>先不动</AlertDialogCancel>
          <Button disabled={redo.isPending} onClick={() => item && redo.mutate({ id: item.id })}>
            {redo.isPending && <Spinner data-icon="inline-start" />}
            再办一次
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
