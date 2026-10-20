// 确认时「修改」打开的弹窗：改的是方案（导入前什么都不建），内容按 AI 的方案填好。
// 字段、文案和各页的「新建」表单一样：任务直接复用 pages/tasks/task-dialog.tsx 的步骤、浏览器、「用哪些」部件，以及「被派活」一组（dispatch-fields.tsx，
// 「谁能派活给它」只能选方案里的其他任务，值是方案里的 key）；
// 技能、规则、工具的表单照「新建技能 / 规则 / 工具」的字段写（那几个弹窗直接调接口，不能拿来改方案）。
// 规则改了文字要重新翻译：imports.compileRule，等十几秒拿到新的「系统理解为」。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useFieldArray, useForm, useWatch } from "react-hook-form"
import { FileTextIcon, LanguagesIcon, PaperclipIcon, PlusIcon } from "lucide-react"
import {
  hasPlainSecret,
  importCompileRuleInputSchema,
  moveSecrets,
  riskLabel,
  secretNameSchema,
  skillInputSchema,
  templatePlaceholders,
  type ImportPlan,
  type PlanRule,
  type PlanSkill,
  type PlanTask,
  type PlanTool,
  type Risk,
  type SkillInput,
  type TaskInput,
} from "@heyagent/shared"

import { CreatableCombobox } from "@/components/shell/creatable-combobox"
import { MarkdownView } from "@/components/markdown"
import { ModelCombobox } from "@/components/shell/model-combobox"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { CodeBlock, CodeBlockContent, CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { useModels, useSkillsQuery, useStaffQuery } from "@/lib/data"
import { domainsText, invalidDomainsMessage, parseDomains } from "@/lib/domains"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

import { cronText } from "@/pages/tasks/cron"
import { DispatchFields, retriesOf, taskResolver, type RetryFields } from "@/pages/tasks/dispatch-fields"
import { MultiPick, type Option } from "@/pages/tasks/multi-pick"
import { BrowserFields, StepEditor } from "@/pages/tasks/task-dialog"
import { DIALOG_TEXT } from "@/pages/tools/data"

import { baseName } from "./parts"

const DEFAULT_CRON = "0 9 * * *"
const clip = (text: string, size = 16) => (text.length > size ? `${text.slice(0, size)}…` : text)

// ---------- 任务 ----------

/** 「用哪些」的选项：方案里的技能、共用记忆、规则（能导入的）、工具。不导入的也列出来，写明「这次不导入」 */
function planOptions(plan: ImportPlan): Record<"skillIds" | "memoryIds" | "ruleIds" | "toolIds", { label: string; options: Option[] }> {
  const off = (include: boolean, hint: string) => (include ? hint : `这次不导入 · ${hint}`)
  return {
    skillIds: { label: "技能", options: plan.skills.map((s) => ({ value: s.key, label: s.name, hint: off(s.include, s.dept) })) },
    memoryIds: {
      label: "记忆",
      options: plan.memories.filter((m) => m.target.kind === "shared").map((m) => ({ value: m.key, label: clip(m.text), hint: off(m.include, m.target.kind === "shared" ? m.target.appliesTo : "") })),
    },
    ruleIds: { label: "规则", options: plan.rules.filter((r) => r.kind !== "unsupported").map((r) => ({ value: r.key, label: r.name, hint: off(r.include, r.compile?.understood ?? r.trigger) })) },
    toolIds: { label: "工具", options: plan.tools.map((t) => ({ value: t.key, label: t.name, hint: off(t.include, t.summary || t.why || "") })) },
  }
}

const PICKS = ["skillIds", "memoryIds", "ruleIds", "toolIds"] as const

/**
 * 方案里的 dispatch 和表单的互转。方案的形状（shared planTaskSchema.dispatch）现在只有 params / maxRunning / fromKeys；
 * 自动重试的两项照样带上（导入时建任务要用），等 shared 加上这两个可选字段就能存下来。
 */
type PlanDispatch = NonNullable<PlanTask["dispatch"]>
function toPlanDispatch(dispatch: TaskInput["dispatch"], fromKeys: string[]): PlanDispatch | null {
  if (!dispatch) return null
  const params = dispatch.params.map((param) => ({ name: param.name.trim(), description: (param.description ?? "").trim(), required: Boolean(param.required), dedupe: Boolean(param.dedupe) }))
  const shape: PlanDispatch & RetryFields = { params, maxRunning: dispatch.maxRunning ?? 1, fromKeys, retries: dispatch.retries, retryDelayMinutes: dispatch.retryDelayMinutes }
  return shape
}

/** 改任务：和「新建任务」同一个表单（任务、步骤、目标、用哪些、浏览器、模型、负责人、被派活、定时）。附件来自包里，这里只看 */
export function TaskEditDialog({ plan, task, onClose, onSave }: { plan: ImportPlan; task: PlanTask | null; onClose: () => void; onSave: (task: PlanTask) => void }) {
  return (
    <Dialog open={task !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="flex max-h-11/12 flex-col sm:max-w-2xl">{task && <TaskForm key={task.key} plan={plan} task={task} onSave={onSave} />}</DialogContent>
    </Dialog>
  )
}

function TaskForm({ plan, task, onSave }: { plan: ImportPlan; task: PlanTask; onSave: (task: PlanTask) => void }) {
  const staff = useStaffQuery().data ?? []
  const { models, defaults, modelName } = useModels()
  const form = useForm<TaskInput>({
    resolver: taskResolver,
    defaultValues: {
      title: task.title,
      goal: task.goal,
      steps: task.steps.map((step) => ({ text: step.text, wait: step.wait, checkpoint: step.checkpoint })),
      modelId: task.modelId ?? "",
      ownerId: task.ownerId,
      schedule: task.schedule,
      enabled: true,
      skillIds: task.skillKeys,
      memoryIds: task.memoryKeys,
      ruleIds: task.ruleKeys,
      toolIds: task.toolKeys,
      browserProfileIds: task.browserProfileIds,
      allowedDomains: task.allowedDomains,
      allowBrowserEvaluate: false,
      allowBrowserVision: false,
      verifyModelId: "",
      dispatch: task.dispatch ? { params: task.dispatch.params, maxRunning: task.dispatch.maxRunning, ...retriesOf(task.dispatch) } : null,
      dispatchFrom: task.dispatch?.fromKeys ?? [],
    },
  })
  const [domainText, setDomainText] = React.useState(() => domainsText(task.allowedDomains))
  const { errors } = form.formState
  const steps = useFieldArray({ control: form.control, name: "steps" })
  const [schedule, toolIds, modelId, dispatch] = useWatch({ control: form.control, name: ["schedule", "toolIds", "modelId", "dispatch"] })
  const usesBrowser = (toolIds ?? []).some((key) => plan.tools.find((tool) => tool.key === key)?.refId === "browser")
  const options = planOptions(plan)
  const cronHuman = schedule?.cron ? cronText(schedule.cron) : null
  const ownerItems = staff.map((person) => ({ value: person.id, label: `${person.name}${person.title ? ` · ${person.title}` : ""}` }))
  // 「谁能派活给它」：方案里的其他任务（没勾上的也列出来，写明不会导入）
  const fromOptions = plan.tasks
    .filter((other) => other.key !== task.key)
    .map((other) => ({ value: other.key, label: clip(other.title, 14), hint: other.include ? "导入时会给它选上内置工具「派活」" : "这个任务没勾上，不会导入" }))

  const submit = form.handleSubmit((values) => {
    const emptyCheckpoint = values.steps.findIndex((step) => step.checkpoint !== undefined && !step.checkpoint.trim())
    if (emptyCheckpoint >= 0) {
      form.setError(`steps.${emptyCheckpoint}.checkpoint`, { message: "写这一步做到什么算数，或者取消勾选「检查点」" })
      return
    }
    const parsedDomains = parseDomains(domainText)
    if (parsedDomains.invalid.length) {
      form.setError("allowedDomains", { message: invalidDomainsMessage(parsedDomains.invalid) })
      return
    }
    const nextModel = values.modelId || null
    onSave({
      ...task,
      title: values.title.trim(),
      goal: values.goal.trim(),
      steps: values.steps.map((step) => ({ text: step.text.trim(), wait: Boolean(step.wait), ...(step.checkpoint?.trim() ? { checkpoint: step.checkpoint.trim() } : {}) })),
      schedule: values.schedule ? { cron: values.schedule.cron.trim(), text: cronText(values.schedule.cron) ?? values.schedule.cron.trim() } : null,
      ownerId: values.ownerId ?? task.ownerId,
      modelId: nextModel,
      // 换了模型，「原来用的模型这里没有」那句就不对了
      modelNote: nextModel === task.modelId ? task.modelNote : undefined,
      skillKeys: values.skillIds ?? [],
      memoryKeys: values.memoryIds ?? [],
      ruleKeys: values.ruleIds ?? [],
      toolKeys: values.toolIds ?? [],
      browserProfileIds: values.browserProfileIds ?? [],
      allowedDomains: parsedDomains.domains,
      dispatch: toPlanDispatch(values.dispatch, values.dispatchFrom ?? []),
    })
  })

  return (
    <>
      <DialogHeader>
        <DialogTitle>修改要导入的任务</DialogTitle>
        <DialogDescription>和「新建任务」是同一个表单，已经按 AI 整理的填好。改完点「保存」，导入时按改过的建。</DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="flex min-h-0 flex-col gap-4">
        <div className="-mx-4 min-h-0 overflow-y-auto px-4 py-1">
          <FieldGroup>
            <Field data-invalid={!!errors.title}>
              <FieldLabel htmlFor="import-task-title">任务</FieldLabel>
              <Input id="import-task-title" aria-invalid={!!errors.title} {...form.register("title")} />
              <FieldError errors={[errors.title]} />
            </Field>
            <FieldSet>
              <FieldLegend variant="label">任务步骤（可以不写）</FieldLegend>
              <FieldDescription>「等待」= 这一步可以挂起 session，等到回复再继续；「检查点」= 这一步做到什么算数，三方 AI 验收时逐条核对。</FieldDescription>
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
                  <PlusIcon data-icon="inline-start" />
                  添加步骤
                </Button>
              </div>
            </FieldSet>
            <Field data-invalid={!!errors.goal}>
              <FieldLabel htmlFor="import-task-goal">目标</FieldLabel>
              <Textarea id="import-task-goal" rows={3} aria-invalid={!!errors.goal} {...form.register("goal")} />
              <FieldDescription>做到什么算完成。必填，三方验收按它判断。</FieldDescription>
              <FieldError errors={[errors.goal]} />
            </Field>
            <FieldSeparator />
            <FieldSet>
              <FieldLegend variant="label">用哪些</FieldLegend>
              <FieldDescription>从这次导入的方案里选。哪一项在后面几步没勾，就不会导入，任务里也跟着去掉。</FieldDescription>
              <div className="grid gap-4 sm:grid-cols-2">
                {PICKS.map((key) => (
                  <Controller
                    key={key}
                    control={form.control}
                    name={key}
                    render={({ field }) => <MultiPick id={`import-task-${key}`} label={options[key].label} options={options[key].options} value={field.value ?? []} onChange={field.onChange} />}
                  />
                ))}
                {usesBrowser && (
                  <BrowserFields
                    hideEvaluate
                    control={form.control}
                    domainText={domainText}
                    domainError={errors.allowedDomains?.message}
                    onDomainText={(text) => {
                      setDomainText(text)
                      form.clearErrors("allowedDomains")
                    }}
                  />
                )}
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="import-task-model">模型</FieldLabel>
                  <Controller
                    control={form.control}
                    name="modelId"
                    render={({ field }) => (
                      <ModelCombobox
                        id="import-task-model"
                        className="w-full sm:w-1/2"
                        models={models}
                        value={field.value ?? ""}
                        onValueChange={field.onChange}
                        clearable
                        placeholder={defaults.run ? `默认：${modelName(defaults.run)}` : "搜模型名"}
                      />
                    )}
                  />
                  <FieldDescription>不选就用「模型」页设置的执行模型。{(modelId || null) === task.modelId && task.modelNote ? task.modelNote : ""}</FieldDescription>
                </Field>
                <Field className="sm:col-span-2">
                  <FieldLabel htmlFor="import-task-owner">负责人</FieldLabel>
                  <Controller
                    control={form.control}
                    name="ownerId"
                    render={({ field }) => (
                      <Select items={ownerItems} value={field.value ?? task.ownerId} onValueChange={(value) => value && field.onChange(value)}>
                        <SelectTrigger id="import-task-owner" className="w-full sm:w-1/2">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {ownerItems.map((item) => (
                            <SelectItem key={item.value} value={item.value}>
                              {item.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    )}
                  />
                  <FieldDescription>负责人能开关、运行这个任务，要人办的事默认分给他。</FieldDescription>
                </Field>
              </div>
            </FieldSet>
            {task.attachments.length > 0 && (
              <>
                <FieldSeparator />
                <Field>
                  <FieldLabel>附件</FieldLabel>
                  <span className="flex flex-wrap gap-1">
                    {task.attachments.map((path) => (
                      <Badge key={path} variant="outline" title={path}>
                        <PaperclipIcon data-icon="inline-start" />
                        {baseName(path)}
                      </Badge>
                    ))}
                  </span>
                  <FieldDescription>来自包里，导入时挂到任务上。导入后可以在任务详情里增删。</FieldDescription>
                </Field>
              </>
            )}
            <FieldSeparator />
            <DispatchFields id="import-task-dispatch" control={form.control} register={form.register} errors={errors} fromOptions={fromOptions} fromNote="只能选这次要导入的任务；系统里已有的任务，导入后到它的任务弹窗里加。" hideResults />
            <FieldSeparator />
            <FieldSet>
              <Controller
                control={form.control}
                name="schedule"
                render={({ field }) => (
                  <Field orientation="horizontal">
                    <Checkbox id="import-task-scheduled" checked={field.value !== null} onCheckedChange={(on) => field.onChange(on ? { cron: DEFAULT_CRON, text: "" } : null)} />
                    <FieldLabel htmlFor="import-task-scheduled">定时运行</FieldLabel>
                  </Field>
                )}
              />
              {schedule ? (
                <Field data-invalid={!!errors.schedule?.cron}>
                  <FieldLabel htmlFor="import-task-cron" className="sr-only">
                    cron
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <InputGroupText>cron</InputGroupText>
                    </InputGroupAddon>
                    <InputGroupInput id="import-task-cron" className="font-mono" aria-invalid={!!errors.schedule?.cron} {...form.register("schedule.cron")} />
                  </InputGroup>
                  <FieldDescription>{cronHuman ? `${cronHuman}。导入后就按定时跑，每次触发是一次新的运行。` : "分 时 日 月 周，例如 0 9 * * *（每天 09:00）、0 10 * * 1（每周一 10:00）"}</FieldDescription>
                  {dispatch && <FieldDescription>能被派活的任务一般不用定时：按定时跑出来的运行不带参数，不知道该办哪件。</FieldDescription>}
                  <FieldError errors={[errors.schedule?.cron]} />
                </Field>
              ) : (
                <FieldDescription>{dispatch ? "不定时：有派活单就开始，没单不跑。原来包里的定时导入时会去掉（见「总览」里要注意的），勾上「定时运行」可以加回来。" : "不勾就只在点「立即运行」时跑。"}</FieldDescription>
              )}
            </FieldSet>
          </FieldGroup>
        </div>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
          <Button type="submit">保存</Button>
        </DialogFooter>
      </form>
    </>
  )
}

// ---------- 技能 ----------

/** 看 / 改技能：名称、岗位、什么时候用、用到的工具、操作手册（和「新建技能」同样的字段） */
export function SkillEditDialog({ plan, skill, onClose, onSave }: { plan: ImportPlan; skill: PlanSkill | null; onClose: () => void; onSave: (skill: PlanSkill) => void }) {
  return (
    <Dialog open={skill !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-2xl">{skill && <SkillForm key={skill.key} plan={plan} skill={skill} onSave={onSave} />}</DialogContent>
    </Dialog>
  )
}

function SkillForm({ plan, skill, onSave }: { plan: ImportPlan; skill: PlanSkill; onSave: (skill: PlanSkill) => void }) {
  const existingDepts = (useSkillsQuery().data ?? []).map((each) => each.dept)
  const [extraDepts, setExtraDepts] = React.useState<string[]>([])
  const deptOptions = [...new Set([...existingDepts, ...plan.skills.map((each) => each.dept), ...extraDepts].filter(Boolean))]
  const [view, setView] = React.useState<"edit" | "preview">("edit")
  const form = useForm<SkillInput>({
    resolver: zodResolver(skillInputSchema),
    defaultValues: { name: skill.name, dept: skill.dept, description: skill.description, body: skill.body, toolIds: skill.toolKeys },
  })
  const { errors } = form.formState
  const body = useWatch({ control: form.control, name: "body" })
  const toolOptions = planOptions(plan).toolIds.options

  const submit = form.handleSubmit((values) =>
    onSave({ ...skill, name: values.name.trim(), dept: values.dept.trim(), description: values.description.trim(), body: values.body, toolKeys: values.toolIds ?? [] })
  )

  return (
    <>
      <DialogHeader>
        <DialogTitle>技能「{skill.name}」</DialogTitle>
        <DialogDescription>
          来自 {skill.source}
          {skill.merged.length ? `，合并了 ${skill.merged.join("、")}` : ""}。和「新建技能」是同一个表单，导入后直接发布。
        </DialogDescription>
      </DialogHeader>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="import-skill-name">名称</FieldLabel>
              <Input id="import-skill-name" aria-invalid={!!errors.name} {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.dept}>
              <FieldLabel htmlFor="import-skill-dept">岗位</FieldLabel>
              <Controller
                control={form.control}
                name="dept"
                render={({ field }) => (
                  <CreatableCombobox
                    id="import-skill-dept"
                    value={field.value}
                    onValueChange={field.onChange}
                    options={deptOptions}
                    onCreate={(value) => setExtraDepts((list) => [...list, value])}
                    placeholder="选一个，或输入新岗位"
                    aria-invalid={!!errors.dept}
                  />
                )}
              />
              <FieldError errors={[errors.dept]} />
            </Field>
          </div>
          <Field data-invalid={!!errors.description}>
            <FieldLabel htmlFor="import-skill-description">什么时候用</FieldLabel>
            <Input id="import-skill-description" aria-invalid={!!errors.description} {...form.register("description")} />
            <FieldDescription>agent 平时只看到这一句，写清楚什么情况下该用。</FieldDescription>
            <FieldError errors={[errors.description]} />
          </Field>
          <Controller
            control={form.control}
            name="toolIds"
            render={({ field }) => (
              <MultiPick
                id="import-skill-tools"
                label="用到的工具（可选）"
                options={toolOptions}
                value={field.value ?? []}
                onChange={field.onChange}
                description="写进 SKILL.md 的头部，告诉 agent 这个技能要用哪些工具。"
              />
            )}
          />
          <Field data-invalid={!!errors.body}>
            <div className="flex items-center justify-between gap-2">
              <FieldLabel htmlFor="import-skill-body">操作手册（Markdown）</FieldLabel>
              <ToggleGroup variant="outline" size="sm" spacing={0} value={[view]} onValueChange={(next) => next[0] && setView(next[0] as "edit" | "preview")}>
                <ToggleGroupItem value="edit">编辑</ToggleGroupItem>
                <ToggleGroupItem value="preview">预览</ToggleGroupItem>
              </ToggleGroup>
            </div>
            {view === "edit" ? (
              <Textarea id="import-skill-body" rows={14} className="font-mono" aria-invalid={!!errors.body} {...form.register("body")} />
            ) : (
              <div className="max-h-96 overflow-y-auto border p-3">{body?.trim() ? <MarkdownView>{body}</MarkdownView> : <p className="text-muted-foreground">还没写内容</p>}</div>
            )}
            <FieldError errors={[errors.body]} />
          </Field>
        </FieldGroup>
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
          <Button type="submit">保存</Button>
        </DialogFooter>
      </form>
    </>
  )
}

/** 包里的技能和已有同名技能的差别 */
export function SkillDiffDialog({ skill, onClose }: { skill: PlanSkill | null; onClose: () => void }) {
  return (
    <Dialog open={skill !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>
            「{skill?.name}」和已有的第 {skill?.existing?.version} 版有什么不一样
          </DialogTitle>
          <DialogDescription>{skill?.existing?.note}</DialogDescription>
        </DialogHeader>
        <CodeBlock size="sm">
          <CodeBlockHeader>
            <CodeBlockTitle>
              <FileTextIcon />
              SKILL.md（+ 是包里多出来的）
            </CodeBlockTitle>
          </CodeBlockHeader>
          <CodeBlockContent wrap className="max-h-96 font-sans">
            {skill?.existing?.diff.map((line, index) => (
              <CodeBlockLine key={index} variant={line.variant}>
                {line.text}
              </CodeBlockLine>
            ))}
          </CodeBlockContent>
        </CodeBlock>
        <DialogFooter>
          <DialogClose render={<Button />}>知道了</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

// ---------- 规则 ----------

const ruleFormSchema = importCompileRuleInputSchema.pick({ name: true, trigger: true, action: true })
type RuleForm = { name: string; trigger: string; action: string }

/** 改规则：改了文字用「规划」模型重新翻译（imports.compileRule），结果写回方案 */
export function RuleEditDialog({ importId, rule, onClose, onSaved }: { importId: string; rule: PlanRule | null; onClose: () => void; onSaved: (rule: PlanRule) => void }) {
  const compile = useAction(trpc.imports.compileRule.mutationOptions(), { errorTitle: "没翻译成" })
  return (
    <Dialog open={rule !== null} onOpenChange={(open) => !open && !compile.isPending && onClose()}>
      <DialogContent className="sm:max-w-lg">
        {rule && (
          <RuleFormBody
            key={rule.key}
            rule={rule}
            pending={compile.isPending}
            onSubmit={async (values) => {
              const result = await compile.submit({ id: importId, key: rule.key, ...values })
              if (result) onSaved(result)
            }}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function RuleFormBody({ rule, pending, onSubmit }: { rule: PlanRule; pending: boolean; onSubmit: (values: RuleForm) => Promise<void> }) {
  const form = useForm<RuleForm>({ resolver: zodResolver(ruleFormSchema), defaultValues: { name: rule.name, trigger: rule.trigger, action: rule.action } })
  const { errors } = form.formState
  return (
    <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>修改规则</DialogTitle>
        <DialogDescription>和「新建规则」是同一个表单。改了文字会用「规划」模型重新翻译，看过新的「系统理解为」再导入。</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={!!errors.name}>
          <FieldLabel htmlFor="import-rule-name">名称</FieldLabel>
          <Input id="import-rule-name" disabled={pending} aria-invalid={!!errors.name} {...form.register("name")} />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field data-invalid={!!errors.trigger}>
          <FieldLabel htmlFor="import-rule-trigger">什么情况下</FieldLabel>
          <Textarea id="import-rule-trigger" rows={2} disabled={pending} aria-invalid={!!errors.trigger} {...form.register("trigger")} />
          <FieldError errors={[errors.trigger]} />
        </Field>
        <Field data-invalid={!!errors.action}>
          <FieldLabel htmlFor="import-rule-action">命中后怎么办</FieldLabel>
          <Textarea id="import-rule-action" rows={2} disabled={pending} aria-invalid={!!errors.action} {...form.register("action")} />
          <FieldError errors={[errors.action]} />
        </Field>
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>取消</DialogClose>
        <Button type="submit" disabled={pending}>
          {pending ? <Spinner data-icon="inline-start" /> : <LanguagesIcon data-icon="inline-start" />}
          {pending ? "正在翻译，一般十几秒" : "保存并翻译"}
        </Button>
      </DialogFooter>
    </form>
  )
}

// ---------- 工具 ----------

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const
const RISKS = (Object.keys(riskLabel) as Risk[]).map((value) => ({ value, label: riskLabel[value] }))
const SECRET_REF = /^\{\{[^{}]+\}\}$/

/** 工具表单（不用 zod resolver：web 不直接依赖 zod，校验在提交时做） */
interface ToolForm {
  name: string
  summary: string
  // HTTP
  method: (typeof METHODS)[number]
  url: string
  headers: string
  body: string
  description: string
  risk: Risk
  // MCP
  transport: "stdio" | "http"
  target: string
  env: string
}

const headerLines = (headers: Record<string, string>) =>
  Object.entries(headers)
    .map(([name, value]) => `${name}: ${value}`)
    .join("\n")
const parseHeaders = (text: string) =>
  Object.fromEntries(
    text
      .split("\n")
      .filter((line) => line.includes(":"))
      .map((line) => [line.slice(0, line.indexOf(":")).trim(), line.slice(line.indexOf(":") + 1).trim()])
  )
const parseEnv = (text: string) =>
  text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const at = line.indexOf("=")
      return { name: (at < 0 ? line : line.slice(0, at)).trim(), value: at < 0 ? "" : line.slice(at + 1).trim() }
    })

/** 改工具（HTTP 接口：请求模板；MCP 服务器：连接方式 + 环境变量）。密钥一律写 {{名字}}，值在「密钥」里填 */
export function ToolEditDialog({ tool, onClose, onSave }: { tool: PlanTool | null; onClose: () => void; onSave: (tool: PlanTool) => void }) {
  return (
    <Dialog open={tool !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-xl">{tool && <ToolFormBody key={tool.key} tool={tool} onSave={onSave} />}</DialogContent>
    </Dialog>
  )
}

function ToolFormBody({ tool, onSave }: { tool: PlanTool; onSave: (tool: PlanTool) => void }) {
  const isHttp = tool.kind === "http"
  const form = useForm<ToolForm>({
    defaultValues: {
      name: tool.name,
      summary: tool.summary,
      method: tool.http?.method ?? "GET",
      url: tool.http?.url ?? "",
      headers: headerLines(tool.http?.headers ?? {}),
      body: tool.http?.body ?? "",
      description: tool.http?.description ?? "",
      risk: tool.http?.risk ?? "read",
      transport: tool.mcp?.transport ?? "stdio",
      target: (tool.mcp?.transport === "http" ? tool.mcp.url : tool.mcp?.command) ?? "",
      env: (tool.mcp?.env ?? []).map((each) => `${each.name}=${each.value}`).join("\n"),
    },
  })
  const { errors } = form.formState
  const transport = useWatch({ control: form.control, name: "transport" })
  const stdio = transport === "stdio"

  const submit = form.handleSubmit((raw) => {
    const values = { ...raw, name: raw.name.trim(), summary: raw.summary.trim(), url: raw.url.trim(), description: raw.description.trim(), target: raw.target.trim() }
    if (!values.name) return form.setError("name", { message: "写个名字" })
    // 明文密钥不能留在模板里；{{名字}} 要是合规的密钥名
    const badName = (text: string) => templatePlaceholders(text).secrets.find((name) => !secretNameSchema.safeParse(name).success)
    if (isHttp) {
      const leaks = moveSecrets({ url: values.url, headers: values.headers, body: values.body }).moved
      if (leaks.length) {
        form.setError(leaks[0]!.where === "url" ? "url" : leaks[0]!.where === "headers" ? "headers" : "body", { message: `有明文密钥，${DIALOG_TEXT.leakHint}` })
        return
      }
      if (!values.url) return form.setError("url", { message: "填接口地址" })
      const wrong = badName(`${values.url} ${values.headers} ${values.body}`)
      if (wrong) return form.setError("headers", { message: `{{${wrong}}}：${secretNameSchema.safeParse(wrong).error?.issues[0]?.message ?? "密钥名不对"}` })
      if (!values.description) return form.setError("description", { message: "写一段给模型看的说明" })
      onSave({
        ...tool,
        name: values.name,
        summary: values.summary,
        http: { method: values.method, url: values.url, headers: parseHeaders(values.headers), body: values.body.trim() || undefined, description: values.description, risk: values.risk },
      })
      return
    }
    if (!values.target) return form.setError("target", { message: stdio ? "填启动命令" : "填服务地址" })
    if (hasPlainSecret(values.target)) return form.setError("target", { message: `${stdio ? "启动命令" : "地址"}里有明文密钥，放进${stdio ? "环境变量" : "请求头"}，写成 {{名字}}` })
    const env = parseEnv(values.env)
    const plain = env.find((each) => each.value && !SECRET_REF.test(each.value) && hasPlainSecret(each.value))
    if (plain) return form.setError("env", { message: `${plain.name} 的值像明文密钥，写成 {{名字}}，值在「密钥」里填` })
    const wrong = badName(values.env)
    if (wrong) return form.setError("env", { message: `{{${wrong}}}：${secretNameSchema.safeParse(wrong).error?.issues[0]?.message ?? "密钥名不对"}` })
    onSave({ ...tool, name: values.name, summary: values.summary, mcp: { transport: values.transport, ...(stdio ? { command: values.target } : { url: values.target }), env } })
  })

  return (
    <form onSubmit={submit} className="flex flex-col gap-4">
      <DialogHeader>
        <DialogTitle>修改工具「{tool.name}」</DialogTitle>
        <DialogDescription>和「新建工具」是同一个表单。密钥写成 {"{{名字}}"}，值在「密钥」里填。</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={!!errors.name}>
          <FieldLabel htmlFor="import-tool-name">名称</FieldLabel>
          <Input id="import-tool-name" aria-invalid={!!errors.name} {...form.register("name")} />
          <FieldError errors={[errors.name]} />
        </Field>
        <Field data-invalid={!!errors.summary}>
          <FieldLabel htmlFor="import-tool-summary">一句话：干什么用</FieldLabel>
          <Input id="import-tool-summary" aria-invalid={!!errors.summary} {...form.register("summary")} />
          <FieldError errors={[errors.summary]} />
        </Field>
        {isHttp ? (
          <>
            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="import-tool-description">给模型看的说明</FieldLabel>
              <Textarea id="import-tool-description" rows={3} placeholder={DIALOG_TEXT.descriptionPlaceholder} aria-invalid={!!errors.description} {...form.register("description")} />
              <FieldDescription>模型只靠这段话判断什么时候用、怎么用。</FieldDescription>
              <FieldError errors={[errors.description]} />
            </Field>
            <Field data-invalid={!!errors.url}>
              <FieldLabel htmlFor="import-tool-url">方法和 URL</FieldLabel>
              <div className="flex gap-2">
                <Controller
                  control={form.control}
                  name="method"
                  render={({ field }) => (
                    <Select items={METHODS.map((m) => ({ value: m, label: m }))} value={field.value} onValueChange={(value) => value && field.onChange(value)}>
                      <SelectTrigger aria-label="方法" className="w-28 shrink-0">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {METHODS.map((m) => (
                          <SelectItem key={m} value={m}>
                            {m}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <Input id="import-tool-url" className="font-mono" placeholder={DIALOG_TEXT.urlPlaceholder} aria-invalid={!!errors.url} {...form.register("url")} />
              </div>
              <FieldError errors={[errors.url]} />
            </Field>
            <Field data-invalid={!!errors.headers}>
              <FieldLabel htmlFor="import-tool-headers">请求头</FieldLabel>
              <Textarea id="import-tool-headers" rows={3} className="font-mono" placeholder="Content-Type: application/json" aria-invalid={!!errors.headers} {...form.register("headers")} />
              <FieldDescription>每行一个，写成「名字: 值」。</FieldDescription>
              <FieldError errors={[errors.headers]} />
            </Field>
            <Field data-invalid={!!errors.body}>
              <FieldLabel htmlFor="import-tool-body">请求体模板</FieldLabel>
              <Textarea id="import-tool-body" rows={4} className="font-mono" placeholder={DIALOG_TEXT.bodyPlaceholder} aria-invalid={!!errors.body} {...form.register("body")} />
              <FieldDescription>{DIALOG_TEXT.bodyHint}</FieldDescription>
              <FieldError errors={[errors.body]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="import-tool-risk">风险</FieldLabel>
              <Controller
                control={form.control}
                name="risk"
                render={({ field }) => (
                  <Select items={RISKS} value={field.value} onValueChange={(value) => value && field.onChange(value)}>
                    <SelectTrigger id="import-tool-risk" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RISKS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              />
              <FieldDescription>对外发送、涉及金钱的工具，建任务时最好配上审批规则。</FieldDescription>
            </Field>
          </>
        ) : (
          <>
            <Field data-invalid={!!errors.target}>
              <FieldLabel htmlFor="import-tool-target">连接方式</FieldLabel>
              <Controller
                control={form.control}
                name="transport"
                render={({ field }) => (
                  <ToggleGroup variant="outline" spacing={0} value={[field.value]} onValueChange={(value) => value[0] && field.onChange(value[0])}>
                    <ToggleGroupItem value="stdio">stdio 命令</ToggleGroupItem>
                    <ToggleGroupItem value="http">HTTP 地址</ToggleGroupItem>
                  </ToggleGroup>
                )}
              />
              <Input id="import-tool-target" className="font-mono" placeholder={stdio ? DIALOG_TEXT.stdioPlaceholder : DIALOG_TEXT.mcpUrlPlaceholder} aria-invalid={!!errors.target} {...form.register("target")} />
              <FieldDescription>{stdio ? DIALOG_TEXT.stdioHint : DIALOG_TEXT.mcpHttpHint}</FieldDescription>
              <FieldError errors={[errors.target]} />
            </Field>
            <Field data-invalid={!!errors.env}>
              <FieldLabel htmlFor="import-tool-env">{stdio ? "环境变量（可选）" : "请求头（可选）"}</FieldLabel>
              <Textarea id="import-tool-env" rows={3} className="font-mono" placeholder={stdio ? "APP_ID={{FEISHU_APP_ID}}" : "Authorization=Bearer {{API_TOKEN}}"} aria-invalid={!!errors.env} {...form.register("env")} />
              <FieldDescription>每行一个「名字=值」。密钥写成 {"{{名字}}"}，运行时从「密钥」里取值。导入后到「工具」页连接一次，勾选要用的工具。</FieldDescription>
              <FieldError errors={[errors.env]} />
            </Field>
          </>
        )}
      </FieldGroup>
      <DialogFooter>
        <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
        <Button type="submit">保存</Button>
      </DialogFooter>
    </form>
  )
}

/** 工具改过以后，方案里的密钥跟着对上：每个勾上的新工具用到的 {{名字}} 都要有一行；没有工具再用的去掉（包里取到的值留在服务器上，不影响） */
export function syncSecrets(plan: ImportPlan, saved: Record<string, unknown>): ImportPlan["secrets"] {
  const uses = new Map<string, string[]>()
  for (const tool of plan.tools) {
    if (tool.kind !== "http" && tool.kind !== "mcp") continue
    const text = tool.http ? `${tool.http.url} ${headerLines(tool.http.headers)} ${tool.http.body ?? ""}` : `${tool.mcp?.command ?? ""} ${tool.mcp?.url ?? ""} ${(tool.mcp?.env ?? []).map((each) => each.value).join(" ")}`
    for (const name of templatePlaceholders(text).secrets) uses.set(name, [...(uses.get(name) ?? []), tool.key])
  }
  const kept = plan.secrets.filter((secret) => uses.has(secret.name)).map((secret) => ({ ...secret, toolKeys: uses.get(secret.name)! }))
  const added = [...uses.keys()]
    .filter((name) => !plan.secrets.some((secret) => secret.name === name))
    .map((name) => ({ name, found: false, filled: false, exists: name in saved, where: "改工具时加的", toolKeys: uses.get(name)! }))
  return [...kept, ...added]
}
