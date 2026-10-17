// 加一条 / 编辑待办：人往看板里插一件事。选任务、要 agent 做什么、什么时候（定时一次 / cron / 等事件 / 先到先继续）。
// 表单：React Hook Form + shared 的 todoFormSchema，提交时转成接口的 trigger。保存后后端调引擎的 syncTodo。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch } from "react-hook-form"
import { InfoIcon } from "lucide-react"
import { addDaysIso, EVENT_FALLBACK_DAYS, fmtDate, fmtDateTime, todoFormSchema, type HumanTodo, type TaskDef, type TodoForm } from "@heyagent/shared"

import { CreatableCombobox } from "@/components/shell/creatable-combobox"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { useAction } from "@/lib/mutations"
import { setParams } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { cronText, nextRuns, shortTime } from "./cron"
import { MODES, cronPresets } from "./data"

// eventOptions：「等哪个事件」的已有选项（来自数据里已经在等的事件），可以输入新的
type Props = { open: boolean; onOpenChange: (open: boolean) => void; todo?: HumanTodo; taskOptions: TaskDef[]; eventOptions: string[] }

/** 新加待办默认的时间：明天 10:00（上海时间），datetime-local 要的格式是 2026-10-17T10:00 */
const defaultAt = () => `${fmtDate(addDaysIso(new Date().toISOString(), 1))}T10:00`

function initialValues(todo: HumanTodo | undefined, taskOptions: TaskDef[], eventOptions: string[]): TodoForm {
  const trigger = todo?.trigger
  return {
    taskId: todo?.taskId ?? taskOptions[0]?.id ?? "",
    title: todo?.title ?? "",
    mode: trigger?.kind ?? "time",
    at: trigger && "at" in trigger ? fmtDateTime(trigger.at).replace(" ", "T") : defaultAt(),
    cron: trigger?.kind === "cron" ? trigger.cron : "0 10 * * 1-5",
    event: trigger && "event" in trigger ? trigger.event : (eventOptions[0] ?? ""),
    fallbackDays: trigger?.kind === "event" ? trigger.fallbackDays : EVENT_FALLBACK_DAYS,
  }
}

export function TodoDialog({ open, onOpenChange, todo, taskOptions, eventOptions }: Props) {
  const form = useForm<TodoForm>({ resolver: zodResolver(todoFormSchema), defaultValues: initialValues(todo, taskOptions, eventOptions) })
  const { errors } = form.formState
  const [mode, cron] = useWatch({ control: form.control, name: ["mode", "cron"] })
  const [createdEvents, setCreatedEvents] = React.useState<string[]>([])
  const create = useAction(trpc.todos.create.mutationOptions(), { success: "待办加上了，到点就让 agent 去做" })
  const update = useAction(trpc.todos.update.mutationOptions(), { success: "待办已保存" })
  const pending = create.isPending || update.isPending

  const taskItems = taskOptions.map((task) => ({ value: task.id, label: `${task.id} ${task.title}` }))
  const needsTime = mode === "time" || mode === "time_or_event"
  const needsEvent = mode === "event" || mode === "time_or_event"
  const cronHuman = cronText(cron)
  const upcoming = nextRuns(cron, new Date())

  const submit = form.handleSubmit(async (values) => {
    const trigger =
      values.mode === "time"
        ? { kind: "time" as const, at: values.at }
        : values.mode === "cron"
          ? { kind: "cron" as const, cron: values.cron.trim(), text: cronText(values.cron) ?? undefined }
          : values.mode === "event"
            ? { kind: "event" as const, event: values.event.trim(), fallbackDays: values.fallbackDays }
            : { kind: "time_or_event" as const, at: values.at, event: values.event.trim() }
    const input = { taskId: values.taskId, title: values.title, trigger }
    if (todo) {
      if (await update.submit({ ...input, id: todo.id })) onOpenChange(false)
      return
    }
    const created = await create.submit(input)
    if (created) {
      onOpenChange(false)
      setParams({ id: created.id })
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{todo ? "编辑待办" : "加一条待办"}</DialogTitle><DialogDescription>往看板里插一件事：到点或等到事件，就让 agent 去做。</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-invalid={!!errors.taskId}>
              <FieldLabel htmlFor="todo-task">哪个任务</FieldLabel>
              <Controller control={form.control} name="taskId" render={({ field }) => <Picker id="todo-task" items={taskItems} value={field.value} onChange={field.onChange} className="w-full" />} />
              <FieldError errors={[errors.taskId]} />
            </Field>
            <Field data-invalid={!!errors.title}>
              <FieldLabel htmlFor="todo-title">要 agent 做什么</FieldLabel>
              <Textarea id="todo-title" rows={2} placeholder="例如：看一眼对方回了没有，没回就礼貌地催一次" aria-invalid={!!errors.title} {...form.register("title")} />
              <FieldError errors={[errors.title]} />
            </Field>
            <Field data-invalid={!!(errors.at || errors.event || errors.cron)}>
              <FieldLabel>什么时候</FieldLabel>
              <Controller
                control={form.control}
                name="mode"
                render={({ field }) => (
                  <ToggleGroup variant="outline" spacing={0} className="flex-wrap" value={[field.value]} onValueChange={(value) => value[0] && field.onChange(value[0])}>
                    {MODES.map((each) => <ToggleGroupItem key={each.value} value={each.value}>{each.label}</ToggleGroupItem>)}
                  </ToggleGroup>
                )}
              />
              <FieldDescription>{MODES.find((each) => each.value === mode)?.hint}</FieldDescription>
              {mode === "cron" && (
                <>
                  <Input aria-label="cron 表达式" placeholder="0 10 * * 1-5" aria-invalid={!!errors.cron} {...form.register("cron")} />
                  <div className="flex flex-wrap gap-1">
                    {cronPresets.map((preset) => <Button key={preset} type="button" variant="outline" size="xs" onClick={() => form.setValue("cron", preset, { shouldValidate: true })}>{preset}</Button>)}
                  </div>
                  {cronHuman && (
                    <div className="flex flex-col gap-1 border p-3 text-xs">
                      <p className="text-sm font-medium">{cronHuman}</p><p className="text-muted-foreground">接下来 3 次：{upcoming.map(shortTime).join("、")}</p>
                    </div>
                  )}
                </>
              )}
              {(needsTime || needsEvent) && (
                <div className="flex flex-wrap gap-2">
                  {needsTime && <Input aria-label="时间" type="datetime-local" className="w-auto" aria-invalid={!!errors.at} {...form.register("at")} />}
                  {needsEvent && (
                    <div className="min-w-48 flex-1">
                      <Controller
                        control={form.control}
                        name="event"
                        render={({ field }) => (
                          <CreatableCombobox value={field.value} onValueChange={field.onChange} options={[...eventOptions, ...createdEvents]}
                            onCreate={(value) => setCreatedEvents((list) => [...list, value])} placeholder="等哪个事件：选一个，或输入新的" aria-invalid={!!errors.event} />
                        )}
                      />
                    </div>
                  )}
                </div>
              )}
              <FieldError errors={[errors.at, errors.event, errors.cron]} />
            </Field>
            {mode === "event" && (
              <Field>
                <FieldLabel htmlFor="todo-fallback">最多等</FieldLabel>
                <Controller
                  control={form.control}
                  name="fallbackDays"
                  render={({ field }) => (
                    <Picker id="todo-fallback" items={[1, 3, 7, 14].map((days) => ({ value: String(days), label: `${days} 天` }))} value={String(field.value)} onChange={(value) => field.onChange(Number(value))} className="w-32" />
                  )}
                />
                <FieldDescription>到期还没等到，就提醒负责人。</FieldDescription>
              </Field>
            )}
          </FieldGroup>
          <Alert><InfoIcon /><AlertDescription>到点后：任务有挂起的 session 就继续它，没有就开始一次新的运行。</AlertDescription></Alert>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={pending}>{pending && <Spinner data-icon="inline-start" />}{todo ? "保存" : "加上"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 下拉选择的简写（Select 要传 items） */
type PickerProps = { id?: string; label?: string; className: string; items: { value: string; label: string }[]; value: string; onChange: (value: string) => void }
function Picker({ id, label, className, items, value, onChange }: PickerProps) {
  return (
    <Select items={items} value={value} onValueChange={(next) => next && onChange(next)}>
      <SelectTrigger id={id} aria-label={label} className={className}><SelectValue /></SelectTrigger>
      <SelectContent>{items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent>
    </Select>
  )
}
