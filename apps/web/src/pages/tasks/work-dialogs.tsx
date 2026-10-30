// 派活单的弹窗：派一张（按被派任务声明的参数生成表单）、改参数（只有排队的单）、不办了 / 重办的确认。
// 「派一张」在任务抽屉里用（能被派活的任务，「立即运行」换成「派一张」；「派来的活」右上角也有）。2026-10-21 从 pages/work/dialogs.tsx 搬来。
// 表单用 React Hook Form + Field（docs/ui-rules.md 第 8 节登记过的写法）；参数按声明顺序放在一个数组里，免得参数名里的「.」被当成路径。
// 派活第三期（docs/dev/dispatch-p3.md 6.2、6.3 节）：派一张、改参数都加「优先级」「什么时候办」；等自动重试的单不能改时间。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { useForm, useWatch } from "react-hook-form"
import { ArrowRightIcon, InfoIcon } from "lucide-react"
import { workDedupeKey, workDefaultTitle, workWaitKind, type TaskDef, type TaskDispatchParam, type WorkItem, type WorkItemDetail, type WorkPriority } from "@heyagent/shared"

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
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { WORK_DELAY_ITEMS, WORK_PRIORITY_ITEMS, WorkItemBadge, scheduledAt, timeText, useWorkTaskStats, workLink } from "./work-parts"

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

/** 一个 Select 选一项（优先级、什么时候办） */
function PlainSelect({ id, items, value, onChange }: { id: string; items: { value: string; label: string }[]; value: string; onChange: (value: string) => void }) {
  return (
    <Select items={items} value={value} onValueChange={(next) => next && onChange(String(next))}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

/** 「优先级」「什么时候办」一行两个（派一张、改参数） */
function PriorityDelayFields({
  idPrefix,
  priority,
  onPriority,
  delay,
  onDelay,
  delayItems,
}: {
  idPrefix: string
  priority: WorkPriority
  onPriority: (value: WorkPriority) => void
  /** 不传 = 不显示「什么时候办」（等自动重试的单不能改时间） */
  delay?: string
  onDelay?: (value: string) => void
  delayItems?: { value: string; label: string }[]
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor={`${idPrefix}-priority`} className="flex items-center gap-1">
          优先级
          <HelpTip>只影响这个任务自己的排队：先领高的，同一级按派进来的先后。</HelpTip>
        </FieldLabel>
        <PlainSelect id={`${idPrefix}-priority`} items={WORK_PRIORITY_ITEMS} value={priority} onChange={(value) => onPriority(value as WorkPriority)} />
      </Field>
      {delay !== undefined && onDelay && (
        <Field>
          <FieldLabel htmlFor={`${idPrefix}-delay`} className="flex items-center gap-1">
            什么时候办
            <HelpTip>到点以前不开始、不占排队的位子，到点后才排进队里。最长 30 天。</HelpTip>
          </FieldLabel>
          <PlainSelect id={`${idPrefix}-delay`} items={delayItems ?? WORK_DELAY_ITEMS} value={delay} onChange={onDelay} />
        </Field>
      )}
    </div>
  )
}

interface DispatchForm {
  taskId: string
  values: string[]
  title: string
  note: string
  priority: WorkPriority
  /** 过多久再办（分钟），文字形式给 Select 用；"0" = 马上 */
  delay: string
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
  const form = useForm<DispatchForm>({ defaultValues: { taskId: initialTaskId ?? taskOptions[0]?.id ?? "", values: [], title: "", note: "", priority: "normal", delay: "0" } })
  const [taskId, values, priority, delay] = useWatch({ control: form.control, name: ["taskId", "values", "priority", "delay"] })
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
    const result = await send.submit({
      taskId: task.id,
      params: filled,
      title: form.title.trim() || undefined,
      note: form.note.trim() || undefined,
      // 普通、马上都是默认，不写
      priority: form.priority === "normal" ? undefined : form.priority,
      delayMinutes: Number(form.delay) || undefined,
    })
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
                  form.reset({ ...form.getValues(), taskId: String(next), values: [] })
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
            <PriorityDelayFields
              idPrefix="dispatch"
              priority={priority}
              onPriority={(value) => form.setValue("priority", value)}
              delay={delay}
              onDelay={(value) => form.setValue("delay", value)}
            />
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
        <Button variant="outline" size="sm" nativeButton={false} render={<a href={workLink(item)} />}>
          去看 {item.id}
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      </AlertAction>
    </Alert>
  )
}

/** 派出去以后的提示：排第几位；定了时间的写「定在 18:00 以后办」（第三期）；任务停用了写「先排着」；已经有了写现状 */
export function dispatchedToast(item: WorkItem, existing: boolean, taskEnabled: boolean, action?: { label: string; onClick: () => void }) {
  const actionProps = action && { children: action.label, onClick: action.onClick }
  if (existing) {
    toast.add({ title: `${item.id} 已经有了`, description: "同一件事只办一次，没有新建。要再办一次，去那张单上点「重办」。", actionProps })
    return
  }
  toast.add({
    title: `已派出 ${item.id}`,
    description:
      workWaitKind(item) === "scheduled"
        ? `定在 ${timeText(item.notBefore)} 以后办，到点后排进队里。${taskEnabled ? "" : "任务停用了，重新启用后才开始办。"}`
        : taskEnabled
          ? `排队第 ${item.queuePosition ?? 1} 位，轮到了开一次运行。`
          : "任务停用了，单先排着，重新启用后开始办。",
    type: "success",
    actionProps,
  })
}

interface EditForm {
  values: string[]
  title: string
  note: string
  priority: WorkPriority
  /** "keep" = 不改；其余是从现在起过多久（分钟），"0" = 马上 */
  delay: string
}

/** 改参数：只有排队的单能改。去重的参数不能改（改了就是另一件事）。第三期：也能改优先级、什么时候办（等自动重试的单不能改时间） */
export function EditParamsDialog({ item, onClose }: { item: WorkItemDetail | null; onClose: () => void }) {
  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">{item && <EditParamsForm key={item.id} item={item} onDone={onClose} />}</DialogContent>
    </Dialog>
  )
}

function EditParamsForm({ item, onDone }: { item: WorkItemDetail; onDone: () => void }) {
  const declared = item.taskDispatch?.params ?? []
  const form = useForm<EditForm>({
    defaultValues: { values: declared.map((param) => item.params[param.name] ?? ""), title: item.title, note: item.note, priority: item.priority, delay: "keep" },
  })
  const [priority, delay] = useWatch({ control: form.control, name: ["priority", "delay"] })
  const waitKind = workWaitKind(item)
  const scheduled = scheduledAt(item)
  // 「什么时候办」第一项是不改（写现在是什么）；现在已经是马上的，不再单列「马上」
  const delayItems = [
    { value: "keep", label: `不改（现在：${scheduled ? `${timeText(scheduled)} 以后` : "马上"}）` },
    ...WORK_DELAY_ITEMS.filter((each) => scheduled || each.value !== "0"),
  ]
  const save = useAction(trpc.work.updateParams.mutationOptions(), { success: `已改 ${item.id}，轮到它时按新的办`, errorTitle: "没改成" })
  const submit = form.handleSubmit(async (values) => {
    // 去重的参数原样带上（输入框是灰的，后端也会拦）
    const params = toParams(declared, values.values.map((value, index) => (declared[index]?.dedupe ? (item.params[declared[index].name] ?? "") : value)))
    const done = await save.submit({
      id: item.id,
      params,
      title: values.title.trim() || item.title,
      note: values.note.trim(),
      // 没改的不写
      priority: values.priority === item.priority ? undefined : values.priority,
      delayMinutes: values.delay === "keep" ? undefined : Number(values.delay),
    })
    if (done) onDone()
  })
  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>改参数 · {item.id}</DialogTitle>
        <DialogDescription>还在排队，改了以后轮到它时按新的参数办。{waitKind === "retry" && "这张单在等自动重试，不能改时间。"}</DialogDescription>
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
        <PriorityDelayFields
          idPrefix="edit"
          priority={priority}
          onPriority={(value) => form.setValue("priority", value)}
          // 等自动重试的单不能改时间：要马上办就「不办了」再「重办」
          delay={waitKind === "retry" ? undefined : delay}
          onDelay={(value) => form.setValue("delay", value)}
          delayItems={delayItems}
        />
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

/** 现在就办：排队的单马上开运行（不管任务停用、名额、花费上限、定的时间，只这一张）。成功后提示开了哪次运行，可以直接去看 */
export function useStartNow(onDone?: () => void) {
  return useAction(
    trpc.work.startNow.mutationOptions({
      onSuccess: (item) => {
        const sessionId = item.sessionId
        toast.add({
          title: `${item.id} 开始办了`,
          description: sessionId ? `开了运行 ${sessionId}。` : undefined,
          type: "success",
          ...(sessionId ? { actionProps: { children: "去看运行", onClick: () => navigate("sessions", { id: sessionId }) } } : {}),
        })
        onDone?.()
      },
    }),
    { errorTitle: "没开始成" }
  )
}

/** 要「现在就办」的单，和要跳过什么（startNowBypass 的那句话） */
export interface StartNowTarget {
  id: string
  bypass: string
}

/** 现在就办的确认：单是因为任务停用、名额满了等原因在排队时，先说清楚跳过的是什么 */
export function StartNowDialog({ target, onClose }: { target: StartNowTarget | null; onClose: () => void }) {
  const start = useStartNow(onClose)
  return (
    <AlertDialog open={target !== null} onOpenChange={(open) => !open && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{target?.id} 现在就办？</AlertDialogTitle>
          <AlertDialogDescription>{target?.bypass}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>先不动</AlertDialogCancel>
          <Button disabled={start.isPending} onClick={() => target && start.mutate({ id: target.id })}>
            {start.isPending && <Spinner data-icon="inline-start" />}
            现在就办
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
