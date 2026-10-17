// 加一条 / 编辑待办：人往看板里插一件事。选任务、要 agent 做什么、什么时候（定时一次 / cron / 等事件 / 先到先继续）。
import * as React from "react"
import { InfoIcon } from "lucide-react"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { addDaysIso, EVENT_FALLBACK_DAYS, fmtDate, fmtDateTime, type HumanTodo, type TaskDef, type Trigger } from "@heyagent/shared"

import { cronText, nextRuns, shortTime } from "./cron"
import { CreatableCombobox } from "@/components/shell/creatable-combobox"

import { MODES, cronPresets } from "./data"

// onSubmit：表单校验通过后调用。M0 只读，页面传进来的是统一的只读提示（新待办的 id、时间以后由后端生成）
// eventOptions：「等哪个事件」的已有选项（来自数据里已经在等的事件），可以输入新的
type Props = { open: boolean; onOpenChange: (open: boolean) => void; todo?: HumanTodo; taskOptions: TaskDef[]; eventOptions: string[]; onSubmit: () => void }

/** 新加待办默认的时间：明天 10:00（上海时间），datetime-local 要的格式是 2026-10-17T10:00 */
const defaultAt = () => `${fmtDate(addDaysIso(new Date().toISOString(), 1))}T10:00`

export function TodoDialog({ open, onOpenChange, todo, taskOptions, eventOptions, onSubmit }: Props) {
  const initial = todo?.trigger
  const [taskId, setTaskId] = React.useState(todo?.taskId ?? taskOptions[0]?.id ?? "")
  const [title, setTitle] = React.useState(todo?.title ?? "")
  const [mode, setMode] = React.useState<Trigger["kind"]>(initial?.kind ?? "time")
  // datetime-local 要的格式是 2026-10-17T10:00
  const [at, setAt] = React.useState(initial && "at" in initial ? fmtDateTime(initial.at).replace(" ", "T") : defaultAt)
  const [cron, setCron] = React.useState(initial?.kind === "cron" ? initial.cron : "0 10 * * 1-5")
  const [event, setEvent] = React.useState(initial && "event" in initial ? initial.event : (eventOptions[0] ?? ""))
  const [fallbackDays, setFallbackDays] = React.useState(String(initial?.kind === "event" ? initial.fallbackDays : EVENT_FALLBACK_DAYS))
  const [submitted, setSubmitted] = React.useState(false)

  const taskItems = taskOptions.map((task) => ({ value: task.id, label: `${task.id} ${task.title}` }))
  const [createdEvents, setCreatedEvents] = React.useState<string[]>([])
  const needsTime = mode === "time" || mode === "time_or_event"
  const needsEvent = mode === "event" || mode === "time_or_event"
  const cronHuman = cronText(cron)
  const upcoming = nextRuns(cron, new Date())
  const titleError = submitted && !title.trim() ? "写一句要 agent 做什么" : undefined
  const timeError = submitted && needsTime && !at ? "选一个时间" : undefined
  const eventError = submitted && needsEvent && !event.trim() ? "选一个事件，或者输入一句话描述要等的事" : undefined
  const cronError = mode === "cron" && !cronHuman ? "看不懂这个表达式：要 5 段（分 时 日 月 周），例如 0 9 * * 1-5" : undefined

  function submit(formEvent: React.FormEvent) {
    formEvent.preventDefault()
    setSubmitted(true)
    if (!title.trim() || timeError || eventError || cronError || (needsTime && !at) || (needsEvent && !event.trim())) return
    onSubmit()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-lg">
        <DialogHeader><DialogTitle>{todo ? "编辑待办" : "加一条待办"}</DialogTitle><DialogDescription>往看板里插一件事：到点或等到事件，就让 agent 去做。</DialogDescription></DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field><FieldLabel htmlFor="todo-task">哪个任务</FieldLabel><Picker id="todo-task" items={taskItems} value={taskId} onChange={setTaskId} className="w-full" /></Field>
            <Field data-invalid={!!titleError}>
              <FieldLabel htmlFor="todo-title">要 agent 做什么</FieldLabel>
              <Textarea id="todo-title" rows={2} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="例如：看一眼两家工厂回了没有，没回就礼貌地催一次" aria-invalid={!!titleError} />
              <FieldError>{titleError}</FieldError>
            </Field>
            <Field data-invalid={!!(timeError || eventError || (submitted && cronError))}>
              <FieldLabel>什么时候</FieldLabel>
              <ToggleGroup variant="outline" spacing={0} className="flex-wrap" value={[mode]} onValueChange={(value) => value[0] && setMode(value[0] as Trigger["kind"])}>
                {MODES.map((each) => <ToggleGroupItem key={each.value} value={each.value}>{each.label}</ToggleGroupItem>)}
              </ToggleGroup>
              <FieldDescription>{MODES.find((each) => each.value === mode)?.hint}</FieldDescription>
              {mode === "cron" && (
                <>
                  <Input aria-label="cron 表达式" value={cron} onChange={(e) => setCron(e.target.value)} placeholder="0 10 * * 1-5" aria-invalid={!!cronError} />
                  <div className="flex flex-wrap gap-1">
                    {cronPresets.map((preset) => <Button key={preset} type="button" variant="outline" size="xs" onClick={() => setCron(preset)}>{preset}</Button>)}
                  </div>
                  {cronHuman ? <div className="flex flex-col gap-1 border p-3 text-xs">
                    <p className="text-sm font-medium">{cronHuman}</p><p className="text-muted-foreground">接下来 3 次：{upcoming.map(shortTime).join("、")}</p>
                  </div> : <FieldError>{cronError}</FieldError>}
                </>
              )}
              {(needsTime || needsEvent) && (
                <div className="flex flex-wrap gap-2">
                  {needsTime && <Input aria-label="时间" type="datetime-local" className="w-auto" value={at} onChange={(e) => setAt(e.target.value)} aria-invalid={!!timeError} />}
                  {needsEvent && (
                    <div className="min-w-48 flex-1">
                      <CreatableCombobox value={event} onValueChange={setEvent} options={[...eventOptions, ...createdEvents]}
                        onCreate={(value) => setCreatedEvents((list) => [...list, value])} placeholder="等哪个事件：选一个，或输入新的" aria-invalid={!!eventError} />
                    </div>
                  )}
                </div>
              )}
              <FieldError>{timeError ?? eventError}</FieldError>
            </Field>
            {mode === "event" && (
              <Field>
                <FieldLabel htmlFor="todo-fallback">最多等</FieldLabel>
                <Picker id="todo-fallback" items={[1, 3, 7, 14].map((days) => ({ value: String(days), label: `${days} 天` }))} value={fallbackDays} onChange={setFallbackDays} className="w-32" />
                <FieldDescription>到期还没等到，就提醒负责人。</FieldDescription>
              </Field>
            )}
          </FieldGroup>
          <Alert><InfoIcon /><AlertDescription>到点后：任务有挂起的 session 就继续它，没有就开始一次新的运行。</AlertDescription></Alert>
          <DialogFooter><DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose><Button type="submit">{todo ? "保存" : "加上"}</Button></DialogFooter>
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
