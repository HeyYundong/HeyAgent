// 新建 / 编辑任务（按用户草图）：一行任务 → 步骤（每步可勾「等待」「检查点」，可以一步都不写）→ 目标 → 用哪些 → 模型 → 定时运行。
// 表单：React Hook Form + shared 的 taskInputSchema；执行模型和三方验收模型不许同一家（前端先拦，后端也拦）。
// M3：规则只能选已经生效的（没生效的列出来但选不了，写明原因）；可以给任务单独选验收模型。
// tasks.update 是整体替换：verifyModelId、浏览器的三项都要带上，不然会被清空。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useFieldArray, useForm, useWatch, type Control, type UseFormRegister } from "react-hook-form"
import { PlayIcon, PlusIcon, XIcon } from "lucide-react"
import {
  alwaysOnToolIds,
  BROWSER_TOOL_ID,
  can,
  checkpointKindLabel,
  modelFamily,
  recognizeCheckpoints,
  sameFamily,
  taskInputSchema,
  type TaskDef,
  type TaskInput,
  type UploadedFile,
} from "@heyagent/shared"

import { FileList, UploadButton } from "@/components/files"
import { ModelCombobox } from "@/components/shell/model-combobox"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent, ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxValue, useComboboxAnchor } from "@/components/ui/combobox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { useBrowsersQuery, useMemoriesQuery, useModels, useRulesQuery, useSkillsQuery, useStaffQuery, useToolName, useToolsQuery } from "@/lib/data"
import { domainsText, invalidDomainsMessage, parseDomains } from "@/lib/domains"
import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { compileOf, ruleHint, ruleSelectable } from "@/pages/rules/compile"

import { cronText } from "./cron"
import { PLACEHOLDER } from "./data"
import { TaskAttachments } from "./run-actions"

export type Option = { value: string; label: string; hint?: string; disabled?: boolean }
type PickKey = "memoryIds" | "skillIds" | "toolIds" | "ruleIds"
const PICK_KEYS: PickKey[] = ["memoryIds", "skillIds", "toolIds", "ruleIds"]

/** 引擎生成运行快照时自动加上的两个工具（apps/server/src/engine/sessions.ts） */
const IMPLIED_TOOLS_NOTE = "选了技能会自动带上「读取技能」；有附件会自动带上「读附件」。"

/** 「用哪些」的选项：生效的记忆、已发布的技能、不是自带的工具、全部规则；编辑时已经选上的（哪怕后来归档、停用了）也列出来。
 * 规则：没生效的也列出来但选不了（灰掉，写原因）；编辑时原来就选着的照样留着（后端也保留） */
function usePickOptions(picked: Partial<Record<PickKey, string[]>>, originalRuleIds: string[]): Record<PickKey, { label: string; options: Option[] }> {
  const memories = useMemoriesQuery().data ?? []
  const skills = useSkillsQuery().data ?? []
  const tools = useToolsQuery().data?.tools ?? []
  const rules = useRulesQuery().data ?? []
  const keep = (key: PickKey, id: string) => picked[key]?.includes(id) ?? false
  const clip = (text: string) => (text.length > 16 ? `${text.slice(0, 16)}…` : text)
  return {
    memoryIds: { label: "记忆", options: memories.filter((m) => m.status === "active" || keep("memoryIds", m.id)).map((m) => ({ value: m.id, label: clip(m.content), hint: m.appliesTo })) },
    skillIds: { label: "技能", options: skills.filter((s) => s.status === "published" || keep("skillIds", s.id)).map((s) => ({ value: s.id, label: s.name, hint: s.dept })) },
    toolIds: { label: "工具", options: tools.filter((t) => !t.alwaysOn).map((t) => ({ value: t.id, label: t.name, hint: t.summary })) },
    ruleIds: {
      label: "规则",
      options: rules.map((r) => ({
        value: r.id,
        label: ruleSelectable(r) ? r.name : `${r.name}（${compileOf(r).status === "unsupported" ? "未生效" : compileOf(r).status === "pending" ? "待确认" : "未翻译"}）`,
        hint: ruleHint(r) ?? compileOf(r).understood ?? r.trigger,
        disabled: !ruleSelectable(r) && !originalRuleIds.includes(r.id),
      })),
    },
  }
}

export function MultiPick({ id, label, options, value, onChange, description, notes }: { id: string; label: string; options: Option[]; value: string[]; onChange: (value: string[]) => void; description?: string; notes?: string[] }) {
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
                <ComboboxChipsInput id={id} placeholder={selected.length ? "" : options.length ? `选${label}，可以多选` : `还没有可选的${label}`} />
              </>
            )}
          </ComboboxValue>
        </ComboboxChips>
        <ComboboxContent anchor={anchor}>
          <ComboboxEmpty>没有匹配的{label}</ComboboxEmpty>
          <ComboboxList>
            {(v: string) => (
              <ComboboxItem key={v} value={v} disabled={options.find((o) => o.value === v)?.disabled}>
                <span className="flex min-w-0 flex-col">
                  <span>{labelOf(v)}</span>
                  <span className="line-clamp-2 text-muted-foreground">{options.find((o) => o.value === v)?.hint}</span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
      {description && <FieldDescription>{description}</FieldDescription>}
      {notes?.map((note) => <FieldDescription key={note}>{note}</FieldDescription>)}
    </Field>
  )
}

export function StepEditor({ index, control, register, error, checkpointError, onRemove }: {
  index: number
  control: Control<TaskInput>
  register: UseFormRegister<TaskInput>
  error?: string
  checkpointError?: string
  onRemove: () => void
}) {
  const checkpoint = useWatch({ control, name: `steps.${index}.checkpoint` })
  const checkpointOn = checkpoint !== undefined
  const found = recognizeCheckpoints(checkpoint ?? "")
  return (
    <div className="flex flex-col gap-2 border-l-2 pl-3">
      <Field data-invalid={!!error}>
        <div className="flex items-center gap-2">
          <InputGroup>
            <InputGroupAddon><InputGroupText>步骤 {index + 1}</InputGroupText></InputGroupAddon>
            <InputGroupInput aria-label={`步骤 ${index + 1}`} aria-invalid={!!error} placeholder={PLACEHOLDER.steps[index % PLACEHOLDER.steps.length]} {...register(`steps.${index}.text`)} />
          </InputGroup>
          <Button type="button" variant="ghost" size="icon-sm" aria-label={`删除步骤 ${index + 1}`} onClick={onRemove}><XIcon /></Button>
        </div>
        {error && <FieldError>{error}</FieldError>}
      </Field>
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <Controller
          control={control}
          name={`steps.${index}.wait`}
          render={({ field }) => (
            <Field orientation="horizontal" className="w-auto">
              <Checkbox id={`step-${index}-wait`} checked={field.value} onCheckedChange={(on) => field.onChange(Boolean(on))} />
              <FieldLabel htmlFor={`step-${index}-wait`} className="font-normal">等待</FieldLabel>
            </Field>
          )}
        />
        <Controller
          control={control}
          name={`steps.${index}.checkpoint`}
          render={({ field }) => (
            <Field orientation="horizontal" className="w-auto">
              <Checkbox id={`step-${index}-cp`} checked={checkpointOn} onCheckedChange={(on) => field.onChange(on ? "" : undefined)} />
              <FieldLabel htmlFor={`step-${index}-cp`} className="font-normal">检查点</FieldLabel>
            </Field>
          )}
        />
      </div>
      {checkpointOn && (
        <Field data-invalid={!!checkpointError}>
          <div className="flex flex-wrap items-center gap-2">
            <Input className="min-w-0 flex-1 basis-56" aria-label={`步骤 ${index + 1} 的检查点`} aria-invalid={!!checkpointError} placeholder={PLACEHOLDER.checkpoint} {...register(`steps.${index}.checkpoint`)} />
            <span className="flex flex-wrap gap-1" aria-live="polite">
              {found.length === 0 && <span className="text-xs text-muted-foreground">写完自动认类型</span>}
              {found.map((cp) => <Badge key={cp.title} variant="secondary">{checkpointKindLabel[cp.kind]}{cp.target ? ` · 目标 ${cp.target}` : ""}</Badge>)}
            </span>
          </div>
          {checkpointError && <FieldError>{checkpointError}</FieldError>}
        </Field>
      )}
    </div>
  )
}

/** 选了「浏览器」工具才出现：允许用哪些 Chrome 配置、网址白名单、是否允许执行脚本（导入时改任务没有这一项：hideEvaluate） */
export function BrowserFields({ control, domainText, domainError, onDomainText, hideEvaluate = false }: { control: Control<TaskInput>; domainText: string; domainError?: string; onDomainText: (text: string) => void; hideEvaluate?: boolean }) {
  const profiles = useBrowsersQuery().data ?? []
  const options = profiles.map((profile) => ({ value: profile.id, label: profile.name, hint: profile.description }))
  return (
    <FieldSet className="sm:col-span-2">
      <FieldLegend variant="label">浏览器</FieldLegend>
      <FieldDescription>选了「浏览器」工具才有这几项。agent 用服务器上的 Chrome 操作网页；遇到验证码、登录页会停下来交给负责人。</FieldDescription>
      <div className="grid gap-4 sm:grid-cols-2">
        <Controller
          control={control}
          name="browserProfileIds"
          render={({ field }) => (
            <MultiPick id="task-browserProfileIds" label="Chrome 配置" options={options} value={field.value ?? []} onChange={field.onChange}
              description={profiles.length ? "不选 = 全部都能用，agent 按每个配置的说明自己选。只允许一个时自动用它。" : "还没有 Chrome 配置：先去「浏览器」页新建。"} />
          )}
        />
        <Field data-invalid={!!domainError}>
          <FieldLabel htmlFor="task-allowedDomains">网址白名单（可以不填）</FieldLabel>
          <Textarea id="task-allowedDomains" rows={2} className="font-mono" placeholder={"example.com\nwikipedia.org"} value={domainText} aria-invalid={!!domainError} onChange={(event) => onDomainText(event.target.value)} />
          <FieldDescription>每行一个域名，子域名也算。不填就不限制；填了，名单外的网页打不开，agent 会收到原因。</FieldDescription>
          <FieldError>{domainError}</FieldError>
        </Field>
        {!hideEvaluate && <Controller
          control={control}
          name="allowBrowserEvaluate"
          render={({ field }) => (
            <Field orientation="horizontal" className="sm:col-span-2">
              <Checkbox id="task-allowEvaluate" checked={!!field.value} onCheckedChange={(on) => field.onChange(Boolean(on))} />
              <FieldContent>
                <FieldLabel htmlFor="task-allowEvaluate">允许在网页里执行脚本</FieldLabel>
                <FieldDescription>打开后 agent 可以在页面里运行 JavaScript（读数据更快，但也能改页面、发请求）。不确定就别开。</FieldDescription>
              </FieldContent>
            </Field>
          )}
        />}
      </div>
    </FieldSet>
  )
}

const DEFAULT_CRON = "0 9 * * *"

export function TaskDialog({ open, onOpenChange, task }: { open: boolean; onOpenChange: (open: boolean) => void; task?: TaskDef }) {
  const { user } = useMe()
  const staff = useStaffQuery().data ?? []
  const { models, defaults, modelName } = useModels()
  const toolName = useToolName()
  const alwaysOn = alwaysOnToolIds(useToolsQuery().data?.tools ?? [])
  const form = useForm<TaskInput>({
    resolver: zodResolver(taskInputSchema),
    defaultValues: task
      ? {
          title: task.title,
          goal: task.goal,
          steps: task.steps.map((step) => ({ id: step.id, text: step.text, wait: step.wait, checkpoint: step.checkpoint })),
          modelId: task.modelId,
          ownerId: task.ownerId,
          schedule: task.schedule ?? null,
          enabled: task.enabled,
          memoryIds: task.memoryIds,
          skillIds: task.skillIds,
          toolIds: task.toolIds.filter((id) => !alwaysOn.includes(id)),
          ruleIds: task.ruleIds,
          browserProfileIds: task.browserProfileIds,
          allowedDomains: task.allowedDomains,
          allowBrowserEvaluate: task.allowBrowserEvaluate,
          verifyModelId: task.verifyModelId ?? "",
        }
      : {
          title: "", goal: "", steps: [{ text: "", wait: false }], modelId: defaults.run, ownerId: user.id, schedule: null, enabled: true,
          memoryIds: [], skillIds: [], toolIds: [], ruleIds: [], browserProfileIds: [], allowedDomains: [], allowBrowserEvaluate: false, verifyModelId: "",
        },
  })
  // 网址白名单在表单里是一段文字（每行一个），提交时拆成数组
  const [domainText, setDomainText] = React.useState(() => domainsText(task?.allowedDomains ?? []))
  const { errors } = form.formState
  const steps = useFieldArray({ control: form.control, name: "steps" })
  const [modelId, schedule, memoryIds, skillIds, toolIds, ruleIds, verifyModelId] = useWatch({ control: form.control, name: ["modelId", "schedule", "memoryIds", "skillIds", "toolIds", "ruleIds", "verifyModelId"] })
  const usesBrowser = (toolIds ?? []).includes(BROWSER_TOOL_ID)
  const options = usePickOptions({ memoryIds: memoryIds ?? [], skillIds: skillIds ?? [] }, task?.ruleIds ?? [])
  const rules = useRulesQuery().data ?? []
  // 选着的规则里没生效 / 改过还没确认的：写清楚运行时会怎样
  const ruleNotes = (ruleIds ?? []).flatMap((id) => {
    const rule = rules.find((each) => each.id === id)
    const hint = rule && ruleHint(rule)
    return rule && hint ? [`「${rule.name}」${ruleSelectable(rule) ? hint : `${hint}。这次保存会留着它，但运行时不执行`}`] : []
  })
  const create = useAction(trpc.tasks.create.mutationOptions(), { success: (data) => `任务 ${data.id} 建好了` })
  const update = useAction(trpc.tasks.update.mutationOptions(), { success: "任务已保存" })
  const attach = useAction(trpc.engine.attachToTask.mutationOptions(), { errorTitle: "附件没加上" })
  const runNow = useAction(trpc.engine.runNow.mutationOptions(), { success: ({ sessionId }) => `已开始运行 ${sessionId}`, errorTitle: "任务建好了，但没能开始运行" })
  // 新建时先上传的附件：任务建好以后再挂上去（编辑时直接用 TaskAttachments，改动马上生效）
  const [files, setFiles] = React.useState<UploadedFile[]>([])
  const [starting, setStarting] = React.useState(false)
  const pending = create.isPending || update.isPending || starting
  const canAssign = can(user, "task.create", {})

  const cronValue = schedule?.cron ?? ""
  const cronHuman = cronValue ? cronText(cronValue) : null
  const effectiveModel = modelId || defaults.run
  const effectiveVerify = verifyModelId || defaults.verify
  // 不是提醒，是不允许：验收和执行同一家，就不算第三方
  const modelClash = effectiveModel && effectiveVerify && sameFamily(effectiveModel, effectiveVerify)
    ? `执行和三方验收（${modelName(effectiveVerify)}${verifyModelId ? "" : "，默认的验收模型"}）是同一家（${modelFamily(effectiveModel)}），验收就不算第三方了。换一个执行模型，或者换一家的验收模型。`
    : undefined

  const submitWith = (startAfter: boolean) => form.handleSubmit(async (values) => {
    // 勾了「检查点」就要写内容
    const emptyCheckpoint = values.steps.findIndex((step) => step.checkpoint !== undefined && !step.checkpoint.trim())
    if (emptyCheckpoint >= 0) {
      form.setError(`steps.${emptyCheckpoint}.checkpoint`, { message: "写这一步做到什么算数，或者取消勾选「检查点」" })
      return
    }
    if (modelClash) return
    const parsedDomains = parseDomains(domainText)
    if (parsedDomains.invalid.length) {
      form.setError("allowedDomains", { message: invalidDomainsMessage(parsedDomains.invalid) })
      return
    }
    const input = {
      ...values,
      // 浏览器的三项只在选了「浏览器」工具时起作用；没选时也原样保留，免得关掉再打开要重填
      allowedDomains: parsedDomains.domains,
      steps: values.steps.map((step) => ({ ...step, checkpoint: step.checkpoint?.trim() || undefined })),
      // 空 = 用默认验收模型
      verifyModelId: values.verifyModelId || undefined,
      schedule: values.schedule ? { cron: values.schedule.cron.trim(), text: cronText(values.schedule.cron) ?? values.schedule.cron.trim() } : null,
    }
    if (task) {
      if (await update.submit({ ...input, id: task.id })) onOpenChange(false)
      return
    }
    setStarting(true)
    try {
      const created = await create.submit(input)
      if (!created) return
      for (const file of files) await attach.submit({ taskId: created.id, fileId: file.id })
      const started = startAfter ? await runNow.submit({ taskId: created.id }) : undefined
      onOpenChange(false)
      navigate("tasks", { id: created.id, run: started?.sessionId })
    } finally {
      setStarting(false)
    }
  })
  const submit = submitWith(!task)

  const ownerItems = staff.map((person) => ({ value: person.id, label: `${person.name}${person.title ? ` · ${person.title}` : ""}` }))

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-11/12 flex-col sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{task ? `编辑任务 ${task.id}` : "新建任务"}</DialogTitle>
          <DialogDescription>写一句话任务和目标就能开始；步骤、检查点、用哪些配置都可以补充。{task ? "改动从下一次运行开始生效，正在跑的不受影响。" : ""}</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex min-h-0 flex-col gap-4">
          <div className="-mx-4 min-h-0 overflow-y-auto px-4 py-1">
            <FieldGroup>
              <Field data-invalid={!!errors.title}>
                <FieldLabel htmlFor="task-title">任务</FieldLabel>
                <Input id="task-title" placeholder={PLACEHOLDER.title} aria-invalid={!!errors.title} {...form.register("title")} />
                <FieldError errors={[errors.title]} />
              </Field>
              <FieldSet>
                <FieldLegend variant="label">任务步骤（可以不写）</FieldLegend>
                <FieldDescription>
                  不写步骤，agent 会自己探索，探索出的步骤记在运行记录里，之后可以存为任务步骤。
                  「等待」= 这一步可以挂起 session，等到回复再继续；「检查点」= 这一步做到什么算数，三方 AI 验收时逐条核对。
                </FieldDescription>
                <div className="flex flex-col gap-4">
                  {steps.fields.map((step, index) => (
                    <StepEditor
                      key={step.id}
                      index={index}
                      control={form.control}
                      register={form.register}
                      error={errors.steps?.[index]?.text?.message}
                      checkpointError={errors.steps?.[index]?.checkpoint?.message}
                      onRemove={() => steps.remove(index)}
                    />
                  ))}
                  <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => steps.append({ text: "", wait: false })}>
                    <PlusIcon data-icon="inline-start" />添加步骤
                  </Button>
                </div>
              </FieldSet>
              <Field data-invalid={!!errors.goal}>
                <FieldLabel htmlFor="task-goal">目标</FieldLabel>
                <Input id="task-goal" placeholder={PLACEHOLDER.goal} aria-invalid={!!errors.goal} {...form.register("goal")} />
                <FieldDescription>做到什么算完成。必填，三方验收按它判断。</FieldDescription>
                <FieldError errors={[errors.goal]} />
              </Field>
              <FieldSeparator />
              <FieldSet>
                <FieldLegend variant="label">用哪些</FieldLegend>
                <FieldDescription>agent 只能用这里选的。规则没有默认的，要手动选。</FieldDescription>
                <div className="grid gap-4 sm:grid-cols-2">
                  {PICK_KEYS.map((key) => (
                    <Controller
                      key={key}
                      control={form.control}
                      name={key}
                      render={({ field }) => (
                        <MultiPick
                          id={`task-${key}`}
                          label={options[key].label}
                          options={options[key].options}
                          value={field.value ?? []}
                          onChange={field.onChange}
                          description={key === "toolIds" ? `${alwaysOn.length ? `每个任务都自带：${alwaysOn.map(toolName).join("、")}。` : ""}${IMPLIED_TOOLS_NOTE}`
                            : key === "ruleIds" ? "只能选已经生效的（主管在「规则」页确认过「系统理解为」）；没生效的灰着，写了原因。" : undefined}
                          notes={key === "ruleIds" ? ruleNotes : undefined}
                        />
                      )}
                    />
                  ))}
                  {usesBrowser && (
                    <BrowserFields control={form.control} domainText={domainText} domainError={errors.allowedDomains?.message} onDomainText={(text) => {
                      setDomainText(text)
                      form.clearErrors("allowedDomains")
                    }} />
                  )}
                  <Field data-invalid={!!modelClash} className="sm:col-span-2">
                    <FieldLabel htmlFor="task-model">模型</FieldLabel>
                    <Controller
                      control={form.control}
                      name="modelId"
                      render={({ field }) => (
                        <ModelCombobox id="task-model" className="w-full sm:w-1/2" models={models} value={field.value ?? ""} onValueChange={field.onChange} aria-invalid={!!modelClash} placeholder={models.length ? "搜模型名" : "还没有模型：先去「模型」页接入"} />
                      )}
                    />
                    <FieldDescription>默认是「模型」页设置的执行模型。</FieldDescription>
                  </Field>
                  <Field data-invalid={!!modelClash} className="sm:col-span-2">
                    <FieldLabel htmlFor="task-verifyModel">三方验收模型</FieldLabel>
                    <Controller
                      control={form.control}
                      name="verifyModelId"
                      render={({ field }) => (
                        <ModelCombobox id="task-verifyModel" className="w-full sm:w-1/2" models={models} value={field.value ?? ""} onValueChange={field.onChange} clearable aria-invalid={!!modelClash}
                          placeholder={defaults.verify ? `默认：${modelName(defaults.verify)}` : "搜模型名"} />
                      )}
                    />
                    <FieldDescription>任务选了「交给三方验收」的规则时，agent 说做完了由它逐条核对检查点。不能和执行模型同一家；不选就用「模型」页的默认验收模型。</FieldDescription>
                    {modelClash && <FieldError>{modelClash}</FieldError>}
                  </Field>
                  {canAssign && (
                    <Field className="sm:col-span-2">
                      <FieldLabel htmlFor="task-owner">负责人</FieldLabel>
                      <Controller
                        control={form.control}
                        name="ownerId"
                        render={({ field }) => (
                          <Select items={ownerItems} value={field.value ?? user.id} onValueChange={(v) => v && field.onChange(v)}>
                            <SelectTrigger id="task-owner" className="w-full sm:w-1/2"><SelectValue /></SelectTrigger>
                            <SelectContent>
                              {ownerItems.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                            </SelectContent>
                          </Select>
                        )}
                      />
                      <FieldDescription>负责人能开关、运行这个任务，要人办的事默认分给他。</FieldDescription>
                    </Field>
                  )}
                </div>
              </FieldSet>
              <FieldSeparator />
              <Field>
                <FieldLabel>附件（可以不加）</FieldLabel>
                {task ? (
                  <TaskAttachments task={task} canEdit />
                ) : (
                  <>
                    <FileList files={files} onRemove={(file) => setFiles((list) => list.filter((each) => each.id !== file.id))} />
                    <div><UploadButton onUploaded={(file) => setFiles((list) => [...list, file])} /></div>
                  </>
                )}
                <FieldDescription>每次运行都会带上，agent 用「读附件」工具读。{task ? "上传、移除马上生效，不用点保存。" : ""}</FieldDescription>
              </Field>
              <FieldSeparator />
              <FieldSet>
                <Controller
                  control={form.control}
                  name="schedule"
                  render={({ field }) => (
                    <Field orientation="horizontal">
                      <Checkbox id="task-scheduled" checked={field.value !== null} onCheckedChange={(on) => field.onChange(on ? { cron: DEFAULT_CRON, text: "" } : null)} />
                      <FieldLabel htmlFor="task-scheduled">定时运行</FieldLabel>
                    </Field>
                  )}
                />
                {schedule ? (
                  <Field data-invalid={!!errors.schedule?.cron}>
                    <FieldLabel htmlFor="task-cron" className="sr-only">cron</FieldLabel>
                    <InputGroup>
                      <InputGroupAddon><InputGroupText>cron</InputGroupText></InputGroupAddon>
                      <InputGroupInput id="task-cron" className="font-mono" aria-invalid={!!errors.schedule?.cron} {...form.register("schedule.cron")} />
                    </InputGroup>
                    <FieldDescription>{cronHuman ? `${cronHuman}。每次触发是一次新的运行。` : "分 时 日 月 周，例如 0 9 * * *（每天 09:00）、0 10 * * 1（每周一 10:00）"}</FieldDescription>
                    <FieldError errors={[errors.schedule?.cron]} />
                  </Field>
                ) : (
                  <FieldDescription>不勾就只在点「立即运行」时跑。</FieldDescription>
                )}
              </FieldSet>
            </FieldGroup>
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            {task ? (
              <Button type="submit" disabled={pending}>
                {pending && <Spinner data-icon="inline-start" />}保存
              </Button>
            ) : (
              <>
                <Button type="button" variant="outline" disabled={pending} onClick={() => void submitWith(false)()}>只创建</Button>
                <Button type="submit" disabled={pending}>
                  {pending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}创建并启动
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
