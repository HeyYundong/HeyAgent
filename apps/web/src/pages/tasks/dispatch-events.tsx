// 「被派活」一组里的「收到事件就派一张」（派活第三期，docs/dev/dispatch-p3.md 3.2、6.1 节）：每条一行 Item（事件名 + 参数从哪取 + 什么时候办 + 优先级），
// 「改」「删」；点「加一个事件 / 改」打开小弹窗：事件名、每个参数从事件数据的哪个字段取（空着取同名字段）、没有去重参数时的去重键、优先级、什么时候办，
// 下面「试一下」贴一段事件数据，用 shared 的 workItemFromEvent 当场算会派出什么（纯前端，不保存这段数据）。
// 在任务弹窗的表单里用 useFieldArray 管 dispatch.events；保存时的校验（事件名重复、保留前缀、缺去重键、参数改名后对不上）显示在那一行下面。
import * as React from "react"
import { useFieldArray, useForm, useWatch, type Control, type FieldErrors } from "react-hook-form"
import { CircleCheckIcon, CircleXIcon, PencilIcon, PlusIcon, XIcon, ZapIcon } from "lucide-react"
import {
  taskDispatchEventSchema,
  workItemFromEvent,
  workPriorityLabel,
  WORK_EVENT_BINDINGS_MAX,
  type TaskDispatchEvent,
  type TaskDispatchParam,
  type TaskInput,
  type WorkPriority,
} from "@heyagent/shared"

import { HelpTip } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"

import { WORK_DELAY_ITEMS, WORK_PRIORITY_ITEMS, workDelayLabel } from "./work-parts"

type Binding = TaskDispatchEvent

/** 一条配置压成一行：「单号 ← orderNo · 买家 ← buyer.name · 30 分钟以后办 · 优先级高」；没写路径的参数不列，一个都没写的写「参数取同名字段」 */
export function eventBindingText(binding: Binding, hasDedupe: boolean) {
  const paths = Object.entries(binding.params ?? {}).filter(([, path]) => path.trim())
  return [
    paths.length ? paths.map(([name, path]) => `${name} ← ${path}`).join(" · ") : "参数取同名字段",
    !hasDedupe && binding.keyPath ? `去重键 ← ${binding.keyPath}` : "",
    binding.delayMinutes ? `${workDelayLabel(binding.delayMinutes)}办` : "",
    binding.priority && binding.priority !== "normal" ? `优先级${workPriorityLabel[binding.priority]}` : "",
  ]
    .filter(Boolean)
    .join(" · ")
}

/** 校验错误（taskDispatchSchema 报在 events.<i>.event / params / keyPath 上）取第一条 */
function bindingError(errors: FieldErrors<TaskInput>, index: number) {
  const each = errors.dispatch?.events?.[index] as { event?: { message?: string }; params?: { message?: string }; keyPath?: { message?: string }; message?: string } | undefined
  return each?.event?.message ?? each?.params?.message ?? each?.keyPath?.message ?? each?.message
}

export function DispatchEvents({ id, control, errors }: { id: string; control: Control<TaskInput>; errors: FieldErrors<TaskInput> }) {
  const events = useFieldArray({ control, name: "dispatch.events" })
  const values = (useWatch({ control, name: "dispatch.events" }) ?? []) as Binding[]
  const params = ((useWatch({ control, name: "dispatch.params" }) ?? []) as TaskDispatchParam[]).filter((param) => param.name?.trim())
  const hasDedupe = params.some((param) => param.dedupe)
  /** 正在改哪一条：null = 新加一条；undefined = 没打开 */
  const [editing, setEditing] = React.useState<number | null | undefined>(undefined)
  const rootError = errors.dispatch?.events?.message ?? errors.dispatch?.events?.root?.message
  const full = events.fields.length >= WORK_EVENT_BINDINGS_MAX

  return (
    <Field data-invalid={!!rootError}>
      <FieldLabel className="flex items-center gap-1">
        收到事件就派一张
        <HelpTip>外部系统发 POST /api/events（令牌在「设置 → 外部事件令牌」），事件名一样时从事件数据里取参数派一张；同一件事（去重参数一样）只派一张。缺字段的这一张不派，当天第一次通知负责人。</HelpTip>
      </FieldLabel>
      <div className="flex flex-col gap-2">
        {events.fields.length > 0 && (
          <ItemGroup className="gap-2">
            {events.fields.map((field, index) => {
              const binding = values[index] ?? (field as unknown as Binding)
              const error = bindingError(errors, index)
              return (
                <div key={field.id} className="flex flex-col gap-1">
                  <Item variant="outline" size="sm" aria-invalid={!!error}>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="font-mono">
                        <ZapIcon className="size-3.5 text-muted-foreground" />
                        {binding.event}
                      </ItemTitle>
                      <ItemDescription className="line-clamp-2">{eventBindingText(binding, hasDedupe)}</ItemDescription>
                    </ItemContent>
                    <ItemActions>
                      <Button type="button" variant="ghost" size="icon-xs" aria-label={`改事件 ${binding.event}`} onClick={() => setEditing(index)}>
                        <PencilIcon />
                      </Button>
                      <Button type="button" variant="ghost" size="icon-xs" aria-label={`删除事件 ${binding.event}`} onClick={() => events.remove(index)}>
                        <XIcon />
                      </Button>
                    </ItemActions>
                  </Item>
                  {error && <FieldError>{error}</FieldError>}
                </div>
              )
            })}
          </ItemGroup>
        )}
        <Button type="button" variant="outline" size="sm" className="self-start" disabled={full} onClick={() => setEditing(null)}>
          <PlusIcon data-icon="inline-start" />
          {full ? `最多 ${WORK_EVENT_BINDINGS_MAX} 个事件` : "加一个事件"}
        </Button>
      </div>
      {rootError && <FieldError>{rootError}</FieldError>}
      <EventDialog
        key={editing === undefined ? "closed" : `edit-${editing}`}
        id={`${id}-event`}
        open={editing !== undefined}
        onOpenChange={(open) => !open && setEditing(undefined)}
        params={params}
        initial={editing == null ? undefined : values[editing]}
        others={values.filter((_, index) => index !== editing).map((each) => each.event)}
        onSave={(binding) => {
          if (editing == null) events.append(binding)
          else events.update(editing, binding)
          setEditing(undefined)
        }}
      />
    </Field>
  )
}

interface EventForm {
  event: string
  /** 参数从哪取：按参数声明的顺序放在数组里（参数名里可能有「.」） */
  paths: string[]
  keyPath: string
  priority: WorkPriority
  /** 过多久再办（分钟），"0" = 马上 */
  delay: string
  /** 「试一下」贴的事件数据，不保存 */
  sample: string
}

/** 表单 → 一条配置：空的路径不写，有去重参数时不写去重键，普通、马上不写 */
function toBinding(form: EventForm, params: TaskDispatchParam[], hasDedupe: boolean): Binding {
  const paths = Object.fromEntries(params.flatMap((param, index) => (form.paths[index]?.trim() ? [[param.name, form.paths[index].trim()]] : [])))
  return {
    event: form.event.trim(),
    ...(Object.keys(paths).length ? { params: paths } : {}),
    ...(!hasDedupe && form.keyPath.trim() ? { keyPath: form.keyPath.trim() } : {}),
    ...(form.priority !== "normal" ? { priority: form.priority } : {}),
    ...(Number(form.delay) ? { delayMinutes: Number(form.delay) } : {}),
  }
}

/** 「试一下」：贴的数据按现在填的配置算一遍，结果和后端派单时一样（同一个 workItemFromEvent） */
function trySample(sample: string, params: TaskDispatchParam[], binding: Binding) {
  if (!sample.trim()) return null
  let data: unknown
  try {
    data = JSON.parse(sample)
  } catch {
    return { problem: "不是 JSON 对象" }
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) return { problem: "不是 JSON 对象" }
  return workItemFromEvent({ params }, binding, data as Record<string, unknown>)
}

function EventDialog({
  id,
  open,
  onOpenChange,
  params,
  initial,
  others,
  onSave,
}: {
  id: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 任务现在声明的参数（表单里正在填的，名字是空的已经去掉） */
  params: TaskDispatchParam[]
  /** 改哪一条；新加的没有 */
  initial?: Binding
  /** 别的几条的事件名（不能重复） */
  others: string[]
  onSave: (binding: Binding) => void
}) {
  const hasDedupe = params.some((param) => param.dedupe)
  const form = useForm<EventForm>({
    defaultValues: {
      event: initial?.event ?? "",
      paths: params.map((param) => initial?.params?.[param.name] ?? ""),
      keyPath: initial?.keyPath ?? "",
      priority: initial?.priority ?? "normal",
      delay: String(initial?.delayMinutes ?? 0),
      sample: "",
    },
  })
  const { errors } = form.formState
  const watched = useWatch({ control: form.control }) as EventForm
  const draft = toBinding({ ...form.getValues(), ...watched }, params, hasDedupe)
  const trial = trySample(watched.sample ?? "", params, draft)

  const submit = form.handleSubmit((values) => {
    const binding = toBinding(values, params, hasDedupe)
    const parsed = taskDispatchEventSchema.safeParse(binding)
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0] === "keyPath" ? "keyPath" : "event"
        form.setError(field, { message: issue.message })
      }
      return
    }
    if (others.includes(parsed.data.event)) return form.setError("event", { message: `事件「${parsed.data.event}」已经配过了` })
    if (!hasDedupe && !parsed.data.keyPath) return form.setError("keyPath", { message: "任务没有标「去重」的参数，要写去重键从哪个字段取" })
    onSave(parsed.data)
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-lg">
        {/* 这个弹窗在任务弹窗的表单里（portal 出去了，但 React 的事件照样往上冒），提交不能冒到外面那个表单 */}
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.stopPropagation()
            void submit(event)
          }}
        >
          <DialogHeader>
            <DialogTitle>收到事件就派一张</DialogTitle>
            <DialogDescription>外部系统发来这个事件时，从事件数据里取参数，给这个任务派一张单。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.event}>
              <FieldLabel htmlFor={`${id}-name`} className="flex items-center gap-1">
                事件名
                <HelpTip>和外部系统发的完全一样才算（区分大小写），例如 order.created。不能用 work.done:、browser.、desktop: 开头，那是平台自己用的。</HelpTip>
              </FieldLabel>
              <Input id={`${id}-name`} className="font-mono" placeholder="例如：order.created" aria-invalid={!!errors.event} {...form.register("event")} />
              <FieldError errors={[errors.event]} />
            </Field>
            {params.length > 0 && (
              <FieldSet>
                <FieldLegend variant="label" className="flex items-center gap-1">
                  参数从事件数据的哪个字段取
                  <HelpTip>写字段的路径，例如 orderNo、order.id、items.0.sku（数字是数组的第几个，从 0 开始）。空着取和参数同名的字段。</HelpTip>
                </FieldLegend>
                {params.map((param, index) => (
                  <Field key={param.name}>
                    <FieldLabel htmlFor={`${id}-path-${index}`} className="flex flex-wrap items-center gap-1">
                      {param.name}
                      {param.required && <Badge variant="outline">必填</Badge>}
                      {param.dedupe && <Badge variant="outline">去重</Badge>}
                    </FieldLabel>
                    <Input id={`${id}-path-${index}`} className="font-mono" placeholder={`同名字段：${param.name}`} {...form.register(`paths.${index}`)} />
                  </Field>
                ))}
              </FieldSet>
            )}
            {!hasDedupe && (
              <Field data-invalid={!!errors.keyPath}>
                <FieldLabel htmlFor={`${id}-key`} className="flex items-center gap-1">
                  去重键取哪个字段
                  <HelpTip>这个任务没有标「去重」的参数，要指定事件数据里哪个字段代表「同一件事」（例如订单号）：同一个值只派一张。</HelpTip>
                </FieldLabel>
                <Input id={`${id}-key`} className="font-mono" placeholder="例如：orderNo" aria-invalid={!!errors.keyPath} {...form.register("keyPath")} />
                <FieldError errors={[errors.keyPath]} />
              </Field>
            )}
            <div className="grid gap-4 sm:grid-cols-2">
              <Field>
                <FieldLabel htmlFor={`${id}-priority`}>优先级</FieldLabel>
                <Select items={WORK_PRIORITY_ITEMS} value={watched.priority} onValueChange={(value) => value && form.setValue("priority", value as WorkPriority)}>
                  <SelectTrigger id={`${id}-priority`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WORK_PRIORITY_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor={`${id}-delay`}>什么时候办</FieldLabel>
                <Select items={WORK_DELAY_ITEMS} value={watched.delay} onValueChange={(value) => value && form.setValue("delay", String(value))}>
                  <SelectTrigger id={`${id}-delay`} className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WORK_DELAY_ITEMS.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor={`${id}-sample`} className="flex items-center gap-1">
                试一下
                <HelpTip>贴一段外部系统会发来的事件数据（data 那一段 JSON），按上面填的当场算会派出什么。只在这里算，不保存、不派单。</HelpTip>
              </FieldLabel>
              <Textarea id={`${id}-sample`} rows={3} className="font-mono" placeholder={'{ "orderNo": "ORD-1", "buyer": { "name": "…" } }'} {...form.register("sample")} />
              {trial && <TrialResult trial={trial} />}
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit">{initial ? "保存" : "加上"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 「试一下」的结果：会派出什么（参数、去重键），或者为什么派不了 */
function TrialResult({ trial }: { trial: ReturnType<typeof workItemFromEvent> }) {
  if ("problem" in trial)
    return (
      <Alert variant="destructive">
        <CircleXIcon />
        <AlertTitle>不会派</AlertTitle>
        <AlertDescription className="break-all">{trial.problem}</AlertDescription>
      </Alert>
    )
  const params = Object.entries(trial.params)
  return (
    <Alert>
      <CircleCheckIcon />
      <AlertTitle>会派一张：{trial.title}</AlertTitle>
      <AlertDescription className="break-all">
        {params.length ? params.map(([name, value]) => `${name} ${value}`).join("，") : "没有参数"}（去重键 {trial.key}）
      </AlertDescription>
    </Alert>
  )
}
