// 新建任务（按用户草图）：一行任务 → 步骤（每步可勾「等待」「检查点」，可以一步都不写）→ 目标 → 用哪些 → 定时运行。
import * as React from "react"
import { PlusIcon, XIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent, ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxValue, useComboboxAnchor } from "@/components/ui/combobox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { alwaysOnToolIds, checkpointKindLabel, modelFamily, recognizeCheckpoints, sameFamily } from "@heyagent/shared"

import { useMemoriesQuery, useModels, useRulesQuery, useSkillsQuery, useToolName, useToolsQuery } from "@/lib/data"
import { readOnlyToast } from "@/lib/readonly"

import { cronText } from "./cron"
import { PLACEHOLDER } from "./data"

type Option = { value: string; label: string; hint?: string }
type StepDraft = { key: number; text: string; wait: boolean; checkpointOn: boolean; checkpoint: string }

type PickKey = "memoryIds" | "skillIds" | "toolIds" | "ruleIds"
const PICK_KEYS: PickKey[] = ["memoryIds", "skillIds", "toolIds", "ruleIds"]

/** 「用哪些」的选项：生效的记忆、已发布的技能、不是自带的工具、全部规则 */
function usePickOptions(): Record<PickKey, { label: string; options: Option[] }> {
  const memories = useMemoriesQuery().data ?? []
  const skills = useSkillsQuery().data ?? []
  const tools = useToolsQuery().data?.tools ?? []
  const rules = useRulesQuery().data ?? []
  return {
    memoryIds: { label: "记忆", options: memories.filter((m) => m.status === "active").map((m) => ({ value: m.id, label: m.content.length > 16 ? `${m.content.slice(0, 16)}…` : m.content, hint: m.appliesTo })) },
    skillIds: { label: "技能", options: skills.filter((s) => s.status === "published").map((s) => ({ value: s.id, label: s.name, hint: s.dept })) },
    toolIds: { label: "工具", options: tools.filter((t) => !t.alwaysOn).map((t) => ({ value: t.id, label: t.name, hint: t.summary })) },
    ruleIds: { label: "规则", options: rules.map((r) => ({ value: r.id, label: r.name, hint: r.trigger })) },
  }
}

function MultiPick({ id, label, options, value, onChange, description }: { id: string; label: string; options: Option[]; value: string[]; onChange: (value: string[]) => void; description?: string }) {
  const anchor = useComboboxAnchor()
  const labelOf = (v: string) => options.find((o) => o.value === v)?.label ?? v
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {/* Base UI 默认按 Esc 会清空全部已选，这里忽略，免得关下拉时把选好的丢掉 */}
      <Combobox multiple items={options.map((o) => o.value)} value={value} onValueChange={(next: string[], details) => details.reason !== "escape-key" && onChange(next)} itemToStringLabel={labelOf}>
        <ComboboxChips ref={anchor}>
          <ComboboxValue>
            {(selected: string[]) => (
              <>
                {selected.map((v) => <ComboboxChip key={v}>{labelOf(v)}</ComboboxChip>)}
                <ComboboxChipsInput id={id} placeholder={selected.length ? "" : `选${label}，可以多选`} />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>没有匹配的{label}</ComboboxEmpty>
          <ComboboxList>
            {(v: string) => (
              <ComboboxItem key={v} value={v}>
                <span className="flex min-w-0 flex-col">
                  <span>{labelOf(v)}</span>
                  <span className="truncate text-muted-foreground">{options.find((o) => o.value === v)?.hint}</span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {description && <FieldDescription>{description}</FieldDescription>}
    </Field>
  )
}

function StepEditor({ step, index, onChange, onRemove }: { step: StepDraft; index: number; onChange: (patch: Partial<StepDraft>) => void; onRemove: () => void }) {
  const found = recognizeCheckpoints(step.checkpoint)
  const id = `step-${step.key}`
  return (
    <div className="flex flex-col gap-2 border-l-2 pl-3">
      <div className="flex items-center gap-2">
        <InputGroup>
          <InputGroupAddon><InputGroupText>步骤 {index + 1}</InputGroupText></InputGroupAddon>
          <InputGroupInput aria-label={`步骤 ${index + 1}`} value={step.text} onChange={(e) => onChange({ text: e.target.value })} placeholder={PLACEHOLDER.steps[index % PLACEHOLDER.steps.length]} />
        </InputGroup>
        <Button type="button" variant="ghost" size="icon-sm" aria-label={`删除步骤 ${index + 1}`} onClick={onRemove}><XIcon /></Button>
      </div>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        {(["wait", "checkpointOn"] as const).map((key) => (
          <Field key={key} orientation="horizontal" className="w-auto">
            <Checkbox id={`${id}-${key}`} checked={step[key]} onCheckedChange={(on) => onChange({ [key]: on })} />
            <FieldLabel htmlFor={`${id}-${key}`} className="font-normal">{key === "wait" ? "等待" : "检查点"}</FieldLabel>
          </Field>
        ))}
      </div>
      {step.checkpointOn && (
        <div className="flex flex-wrap items-center gap-2">
          <Input className="min-w-0 flex-1 basis-56" aria-label={`步骤 ${index + 1} 的检查点`} value={step.checkpoint} onChange={(e) => onChange({ checkpoint: e.target.value })} placeholder={PLACEHOLDER.checkpoint} />
          <span className="flex flex-wrap gap-1" aria-live="polite">
            {found.length === 0 && <span className="text-xs text-muted-foreground">写完自动认类型</span>}
            {found.map((cp) => <Badge key={cp.title} variant="secondary">{checkpointKindLabel[cp.kind]}{cp.target ? ` · 目标 ${cp.target}` : ""}</Badge>)}
          </span>
        </div>
      )}
    </div>
  )
}

/** 只读阶段：表单照原型能填、能校验，点「创建并启动」弹只读提示（新任务的编号以后由后端生成） */
export function NewTaskDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const OPTIONS = usePickOptions()
  const { models, defaults, modelName } = useModels()
  const toolName = useToolName()
  const alwaysOn = alwaysOnToolIds(useToolsQuery().data?.tools ?? [])
  const modelItems = models.map((m) => ({ value: m.id, label: `${m.name} · ${m.note}` }))
  const [title, setTitle] = React.useState("")
  const [goal, setGoal] = React.useState("")
  const [steps, setSteps] = React.useState<StepDraft[]>([{ key: 0, text: "", wait: false, checkpointOn: false, checkpoint: "" }])
  const [picked, setPicked] = React.useState({ memoryIds: [] as string[], skillIds: [] as string[], toolIds: [] as string[], ruleIds: [] as string[] })
  const [modelId, setModelId] = React.useState(defaults.run)
  const [scheduled, setScheduled] = React.useState(false)
  const [cron, setCron] = React.useState("0 9 * * *")
  const [submitted, setSubmitted] = React.useState(false)
  const nextKey = React.useRef(1)

  const cronHuman = cronText(cron)
  const errors = {
    title: submitted && !title.trim() ? "写一句话：要 agent 做什么" : undefined,
    goal: submitted && !goal.trim() ? "写一句话：做到什么算完成（三方 AI 按它验收）" : undefined,
    cron: submitted && scheduled && !cronHuman ? "这个写法认不出来，换成常见写法，例如 0 9 * * *" : undefined,
    // 不是提醒，是不允许：验收和执行同一家，就不算第三方
    model: sameFamily(modelId, defaults.verify) ? `执行和三方验收（${modelName(defaults.verify)}）是同一家（${modelFamily(modelId)}），验收就不算第三方了。换一个执行模型，或去「模型」页换验收模型。` : undefined,
  }

  const patchStep = (key: number, patch: Partial<StepDraft>) => setSteps((list) => list.map((s) => (s.key === key ? { ...s, ...patch } : s)))

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (!title.trim() || !goal.trim() || (scheduled && !cronHuman) || errors.model) return
    readOnlyToast()
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-11/12 flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>新建任务</DialogTitle>
          <DialogDescription>写一句话任务和目标就能开始；步骤、检查点、用哪些配置都可以补充。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-col gap-4">
          <div className="-mx-4 min-h-0 overflow-y-auto px-4 py-1">
            <FieldGroup>
              <Field data-invalid={!!errors.title}>
                <FieldLabel htmlFor="task-title">任务</FieldLabel>
                <Input id="task-title" value={title} onChange={(e) => setTitle(e.target.value)} placeholder={PLACEHOLDER.title} aria-invalid={!!errors.title} />
                <FieldError>{errors.title}</FieldError>
              </Field>
              <FieldSet>
                <FieldLegend variant="label">任务步骤（可以不写）</FieldLegend>
                <FieldDescription>
                  不写步骤，agent 会自己探索，探索出的步骤记在运行记录里，之后可以存为任务步骤。
                  「等待」= 这一步可以挂起 session，等到回复再继续；「检查点」= 这一步做到什么算数，三方 AI 验收时逐条核对。
                </FieldDescription>
                <div className="flex flex-col gap-4">
                  {steps.map((step, index) => (
                    <StepEditor key={step.key} step={step} index={index} onChange={(patch) => patchStep(step.key, patch)} onRemove={() => setSteps((list) => list.filter((s) => s.key !== step.key))} />
                  ))}
                  <Button type="button" variant="outline" size="sm" className="self-start"
                    onClick={() => setSteps((list) => [...list, { key: nextKey.current++, text: "", wait: false, checkpointOn: false, checkpoint: "" }])}>
                    <PlusIcon data-icon="inline-start" />添加步骤
                  </Button>
                </div>
              </FieldSet>
              <Field data-invalid={!!errors.goal}>
                <FieldLabel htmlFor="task-goal">目标</FieldLabel>
                <Input id="task-goal" value={goal} onChange={(e) => setGoal(e.target.value)} placeholder={PLACEHOLDER.goal} aria-invalid={!!errors.goal} />
                <FieldDescription>做到什么算完成。必填，三方验收按它判断。</FieldDescription>
                <FieldError>{errors.goal}</FieldError>
              </Field>
              <FieldSeparator />
              <FieldSet>
                <FieldLegend variant="label">用哪些</FieldLegend>
                <FieldDescription>agent 只能用这里选的。规则没有默认的，要手动选。</FieldDescription>
                <div className="grid gap-4 sm:grid-cols-2">
                  {PICK_KEYS.map((key) => (
                    <MultiPick key={key} id={`task-${key}`} label={OPTIONS[key].label} options={OPTIONS[key].options} value={picked[key]} onChange={(value) => setPicked((p) => ({ ...p, [key]: value }))}
                      description={key === "toolIds" ? `每个任务都自带：${alwaysOn.map(toolName).join("、")}` : undefined} />
                  ))}
                  <Field data-invalid={!!errors.model} className="sm:col-span-2">
                    <FieldLabel htmlFor="task-model">模型</FieldLabel>
                    <Select items={modelItems} value={modelId} onValueChange={(v) => v && setModelId(v)}>
                      <SelectTrigger id="task-model" className="w-full sm:w-1/2" aria-invalid={!!errors.model}><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {modelItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                      </SelectContent>
                    </Select>
                    <FieldError>{errors.model}</FieldError>
                  </Field>
                </div>
              </FieldSet>
              <FieldSeparator />
              <FieldSet>
                <Field orientation="horizontal">
                  <Checkbox id="task-scheduled" checked={scheduled} onCheckedChange={setScheduled} />
                  <FieldLabel htmlFor="task-scheduled">定时运行</FieldLabel>
                </Field>
                {scheduled ? (
                  <Field data-invalid={!!errors.cron}>
                    <FieldLabel htmlFor="task-cron" className="sr-only">cron</FieldLabel>
                    <InputGroup>
                      <InputGroupAddon><InputGroupText>cron</InputGroupText></InputGroupAddon>
                      <InputGroupInput id="task-cron" className="font-mono" value={cron} onChange={(e) => setCron(e.target.value)} aria-invalid={!!errors.cron} />
                    </InputGroup>
                    <FieldDescription>{cronHuman ? `${cronHuman}。每次触发是一次新的运行。` : "分 时 日 月 周，例如 0 9 * * *（每天 09:00）、0 10 * * 1（每周一 10:00）"}</FieldDescription>
                    <FieldError>{errors.cron}</FieldError>
                  </Field>
                ) : (
                  <FieldDescription>不勾就只跑一次：创建后马上开始。</FieldDescription>
                )}
              </FieldSet>
            </FieldGroup>
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit">创建并启动</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
