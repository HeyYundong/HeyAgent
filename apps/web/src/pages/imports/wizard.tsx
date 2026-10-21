// 确认导入的向导：总览 → 任务 → 技能 → 记忆 → 规则 → 工具 → 确认导入。
// AI 的方案默认都勾好了，一路点「下一步」就能导入；没有内容的步骤自动跳过。
// 方案放在页面状态里，改了以后防抖 0.6 秒连同步骤一起存（imports.savePlan），离开再回来接着确认；导入前什么都不建。
import * as React from "react"
import {
  ArrowLeftIcon,
  ArrowRightIcon,
  BookOpenIcon,
  BrainIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  EllipsisIcon,
  FileTextIcon,
  GlobeIcon,
  InboxIcon,
  KeyRoundIcon,
  LayoutGridIcon,
  PackageCheckIcon,
  PaperclipIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SendIcon,
  ShieldAlertIcon,
  ShieldCheckIcon,
  TerminalIcon,
  TriangleAlertIcon,
  WrenchIcon,
} from "lucide-react"
import type { ImportDetail, ImportPlan, ImportStep, PlanMemory, PlanMemoryTarget, PlanRule, PlanSecret, PlanSkill, PlanSkillResolution, PlanTask, PlanTool } from "@heyagent/shared"

import { ModelCombobox } from "@/components/shell/model-combobox"
import { DetailSection, HelpTip } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Textarea } from "@/components/ui/textarea"
import { toast } from "@/components/ui/toast"

import { useBrowsersQuery, useModels, useStaffName, useStaffQuery, useToolsQuery } from "@/lib/data"
import { errorMessage, useAction } from "@/lib/mutations"
import { trpc, trpcClient } from "@/lib/trpc"

import { cronText } from "@/pages/tasks/cron"
import { retriesOf } from "@/pages/tasks/dispatch-fields"
import { MultiPick } from "@/pages/tasks/multi-pick"

import { RuleEditDialog, SkillDiffDialog, SkillEditDialog, syncSecrets, TaskEditDialog, ToolEditDialog } from "./edit-dialogs"
import { baseName, memoryOn, missingLogins, planCounts, STEP_LABEL, stepsOf, taskUsesBrowser, toolTitle } from "./parts"

type UpdatePlan = (change: (plan: ImportPlan) => ImportPlan) => void

// ---------- 方案草稿：页面状态 + 防抖存 ----------

interface Draft {
  plan: ImportPlan
  step: ImportStep
  visited: ImportStep[]
}

const SAVE_DELAY_MS = 600

/** 方案、步骤放在页面状态里；改了以后 0.6 秒没再改就存。一次只发一个保存，按顺序存；卸载时把没存的存掉 */
function usePlanDraft(id: string, initial: Draft) {
  const [draft, setDraft] = React.useState(initial)
  const latest = React.useRef(draft)
  const saved = React.useRef(JSON.stringify(initial))
  const chain = React.useRef<Promise<boolean>>(Promise.resolve(true))
  const lastError = React.useRef<string | null>(null)

  React.useEffect(() => {
    latest.current = draft
  }, [draft])

  /** 把现在的草稿存上；返回存没存成（没改动也算成） */
  const flush = React.useCallback(() => {
    chain.current = chain.current.then(async () => {
      const current = latest.current
      const json = JSON.stringify(current)
      if (json === saved.current) return true
      try {
        await trpcClient.imports.savePlan.mutate({ id, plan: current.plan, step: current.step, visited: current.visited })
        saved.current = json
        lastError.current = null
        return true
      } catch (error) {
        const message = errorMessage(error)
        // 同一个原因只提示一次，免得每改一下都弹
        if (lastError.current !== message) toast.add({ title: "改动没存上", description: message, type: "error" })
        lastError.current = message
        return false
      }
    })
    return chain.current
  }, [id])

  React.useEffect(() => {
    const timer = window.setTimeout(() => void flush(), SAVE_DELAY_MS)
    return () => window.clearTimeout(timer)
  }, [draft, flush])
  React.useEffect(() => () => void flush(), [flush])

  const updatePlan: UpdatePlan = React.useCallback((change) => setDraft((current) => ({ ...current, plan: change(current.plan) })), [])
  const setStep = React.useCallback(
    (step: ImportStep) => setDraft((current) => (current.step === step ? current : { ...current, step, visited: [...new Set([...current.visited, current.step])] })),
    []
  )
  return { draft, updatePlan, setStep, flush }
}

// ---------- 向导 ----------

/**
 * 向导只在第一次拿到详情时用里面的方案，之后以页面上的草稿为准。实时推送会让详情（可能几百 KB）在每次保存后重新拉一遍，
 * 这里按 id 比较，不让它把整个向导重画一遍（大方案时勾一下也不卡）
 */
export const Wizard = React.memo(WizardBody, (before, after) => before.detail.id === after.detail.id)

function WizardBody({ detail }: { detail: ImportDetail & { plan: ImportPlan } }) {
  const { draft, updatePlan, setStep, flush } = usePlanDraft(detail.id, { plan: detail.plan, step: detail.step, visited: detail.visited })
  const { plan, visited } = draft
  const steps = stepsOf(plan)
  const step = steps.includes(draft.step) ? draft.step : "overview"
  const index = steps.indexOf(step)
  const counts = planCounts(plan)
  const countOf: Partial<Record<ImportStep, number>> = { tasks: counts.tasks, skills: counts.skills, memories: counts.memories, rules: counts.rules, tools: counts.tools }
  const prev = steps[index - 1]
  const next = steps[index + 1]
  const topRef = React.useRef<HTMLDivElement>(null)
  const commit = useAction(trpc.imports.commit.mutationOptions(), { errorTitle: "没导入成" })

  const go = (target: ImportStep) => {
    setStep(target)
    // 从底栏点「下一步」时，新的一步从头看起
    if ((topRef.current?.getBoundingClientRect().top ?? 0) < 0) topRef.current?.scrollIntoView({ block: "start" })
  }

  async function doImport() {
    if (!(await flush())) return
    const result = await commit.submit({ id: detail.id })
    if (!result) return
    const parts = [
      counts.tasks && `${counts.tasks} 个任务`,
      counts.skillsNew && `${counts.skillsNew} 个技能`,
      counts.memories && `${counts.memories} 条记忆`,
      counts.rulesNew && `${counts.rulesNew} 条规则`,
      counts.toolsNew && `${counts.toolsNew} 个工具`,
    ].filter(Boolean)
    toast.add({
      title: "导入好了",
      description: `新建了 ${parts.join("、") || "所选的配置"}。${result.followUps.some((item) => !item.done) ? "还有几件事要你做，列在详情里。" : ""}`,
      type: "success",
    })
  }

  return (
    <div ref={topRef} className="flex scroll-mt-4 flex-col gap-4">
      <Tabs value={step} onValueChange={(value) => go(value as ImportStep)}>
        <TabsList variant="line" className="no-scrollbar w-full justify-start overflow-x-auto">
          {steps.map((id) => (
            <TabsTrigger key={id} value={id} className="flex-none">
              {visited.includes(id) && id !== step && <CircleCheckIcon data-icon="inline-start" />}
              {STEP_LABEL[id]}
              {countOf[id] !== undefined && <span className="text-muted-foreground tabular-nums">{countOf[id]}</span>}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {step === "overview" && <OverviewStep plan={plan} />}
      {step === "tasks" && <TasksStep plan={plan} updatePlan={updatePlan} />}
      {step === "skills" && <SkillsStep plan={plan} updatePlan={updatePlan} />}
      {step === "memories" && <MemoriesStep plan={plan} updatePlan={updatePlan} />}
      {step === "rules" && <RulesStep importId={detail.id} plan={plan} updatePlan={updatePlan} />}
      {step === "tools" && <ToolsStep importId={detail.id} plan={plan} updatePlan={updatePlan} />}
      {step === "confirm" && <ConfirmStep plan={plan} onStep={go} />}

      {/* 底栏一直在：上一步 / 下一步（写明下一步是什么）；最后一步是「导入」 */}
      <div className="sticky bottom-0 flex flex-wrap items-center justify-between gap-2 border-t bg-background py-3">
        <Button variant="outline" disabled={!prev} onClick={() => prev && go(prev)}>
          <ArrowLeftIcon data-icon="inline-start" />
          上一步
        </Button>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs text-muted-foreground">
            第 {index + 1} / {steps.length} 步 · 改动自动保存
          </span>
          {step === "overview" && (
            <Button variant="outline" onClick={() => go("confirm")}>
              直接去确认
            </Button>
          )}
          {next ? (
            <Button onClick={() => go(next)}>
              下一步：{STEP_LABEL[next]}
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          ) : (
            <Button disabled={counts.nothing || commit.isPending} onClick={() => void doImport()}>
              {commit.isPending ? <Spinner data-icon="inline-start" /> : <PackageCheckIcon data-icon="inline-start" />}
              导入
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}

// ---------- 1 总览 ----------

const WARNING_ICON = { secret: <KeyRoundIcon />, script: <TerminalIcon />, suspicious: <ShieldAlertIcon />, other: <TriangleAlertIcon /> }

/** 任务怎么开始的一句话：定时 / 被派活 / 按需（派活第二期） */
const runText = (task: PlanTask) => (task.schedule ? `定时：${task.schedule.text}` : task.dispatch ? "被派活，不定时" : "按需运行")
/** 不写 = 启用 */
export const taskEnabled = (task: PlanTask) => task.enabled !== false
export const DISABLED_TEXT = "导入后先停用"

function OverviewStep({ plan }: { plan: ImportPlan }) {
  const staffName = useStaffName()
  return (
    <>
      <DetailSection title="AI 读懂的" description="AI 读完整个包以后的理解。后面每一步的每一项都写了来自包里哪个文件，可以对照着看。">
        <div className="flex flex-col gap-3">
          <p className="leading-relaxed whitespace-pre-line">{plan.summary}</p>
          {plan.tasks.length ? (
            <ItemGroup className="gap-2">
              {plan.tasks.map((task) => (
                <Item key={task.key} variant="outline" size="xs">
                  <ItemMedia variant="icon">
                    <LayoutGridIcon />
                  </ItemMedia>
                  <ItemContent className="min-w-0">
                    <ItemTitle>{task.title}</ItemTitle>
                    <ItemDescription>
                      {runText(task)} · 负责人 {staffName(task.ownerId)} · {task.steps.length} 步{taskEnabled(task) ? "" : ` · ${DISABLED_TEXT}`}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          ) : (
            <p className="text-muted-foreground">包里没有任务说明，不建任务，只导入技能、记忆这些配置。</p>
          )}
        </div>
      </DetailSection>
      {plan.warnings.length > 0 && (
        <DetailSection title={`要注意的（${plan.warnings.length}）`}>
          <div className="flex flex-col gap-2">
            {plan.warnings.map((warning, index) => (
              <Alert key={index}>
                {WARNING_ICON[warning.kind]}
                <AlertTitle>{warning.title}</AlertTitle>
                <AlertDescription>{warning.text}</AlertDescription>
              </Alert>
            ))}
          </div>
        </DetailSection>
      )}
      {plan.unused.length > 0 && (
        <DetailSection title={`没用上的文件（${plan.unused.length}）`} description="这些文件不导入。觉得哪个有用，导入后可以手动加到任务附件里。">
          <UnusedFiles files={plan.unused} />
        </DetailSection>
      )}
    </>
  )
}

const UNUSED_SHOWN = 10

function UnusedFiles({ files }: { files: ImportPlan["unused"] }) {
  const [more, setMore] = React.useState(false)
  const row = (file: ImportPlan["unused"][number], index: number) => (
    <Item key={`${file.path}-${index}`} size="xs">
      <ItemMedia variant="icon">
        <FileTextIcon />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle className="font-mono">{file.path}</ItemTitle>
      </ItemContent>
      <ItemActions className="text-muted-foreground">{file.reason}</ItemActions>
    </Item>
  )
  const rest = files.length - UNUSED_SHOWN
  return (
    <div className="flex flex-col gap-1">
      <ItemGroup className="gap-1">{files.slice(0, UNUSED_SHOWN).map(row)}</ItemGroup>
      {rest > 0 && (
        <Collapsible open={more} onOpenChange={setMore}>
          <CollapsibleContent>{more && <ItemGroup className="gap-1">{files.slice(UNUSED_SHOWN).map((file, index) => row(file, index + UNUSED_SHOWN))}</ItemGroup>}</CollapsibleContent>
          <CollapsibleTrigger render={<Button variant="ghost" size="sm" />}>
            {more ? <ChevronDownIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
            {more ? "收起" : `还有 ${rest} 项`}
          </CollapsibleTrigger>
        </Collapsible>
      )}
    </div>
  )
}

// ---------- 2 任务 ----------

/** 「默认 Chrome」/「全部 Chrome」 */
function useProfileLabel() {
  const profiles = useBrowsersQuery().data ?? []
  return (ids: string[]) => (ids.length ? ids.map((id) => profiles.find((profile) => profile.id === id)?.name ?? id).join("、") : "全部 Chrome")
}

/** 任务卡片上选 Chrome：不选 = 全部都能用 */
function ChromePick({ task, onChange }: { task: PlanTask; onChange: (ids: string[]) => void }) {
  const profiles = useBrowsersQuery().data ?? []
  const options = profiles.map((profile) => ({ value: profile.id, label: profile.name, hint: profile.description }))
  return <MultiPick id={`import-chrome-${task.key}`} label="Chrome 配置" hideLabel options={options} value={task.browserProfileIds} onChange={onChange} />
}

function TasksStep({ plan, updatePlan }: { plan: ImportPlan; updatePlan: UpdatePlan }) {
  const [editing, setEditing] = React.useState<PlanTask | null>(null)
  const staff = useStaffQuery().data ?? []
  const { models, defaults, modelName } = useModels()
  const profileLabel = useProfileLabel()
  const profiles = useBrowsersQuery().data
  const setTask = (key: string, patch: Partial<PlanTask>) => updatePlan((current) => ({ ...current, tasks: current.tasks.map((task) => (task.key === key ? { ...task, ...patch } : task)) }))
  const ownerItems = staff.map((person) => ({ value: person.id, label: person.title ? `${person.name}（${person.title}）` : person.name }))

  return (
    <>
      {plan.tasks.map((task) => {
        const browser = taskUsesBrowser(plan, task) || task.browserProfileIds.length > 0 || task.allowedDomains.length > 0
        const missing = missingLogins(task, profiles)
        return (
          <Card key={task.key} size="sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Checkbox aria-label={`导入任务「${task.title}」`} checked={task.include} onCheckedChange={(checked) => setTask(task.key, { include: Boolean(checked) })} />
                {task.title}
                {task.include && !taskEnabled(task) && (
                  <Badge variant="outline">
                    <PauseIcon data-icon="inline-start" />
                    {DISABLED_TEXT}
                  </Badge>
                )}
              </CardTitle>
              <CardAction>
                <Button variant="outline" size="sm" disabled={!task.include} onClick={() => setEditing(task)}>
                  <PencilIcon data-icon="inline-start" />
                  修改
                </Button>
              </CardAction>
            </CardHeader>
            {task.include && (
              <CardContent className="flex flex-col gap-4 text-sm">
                <div className="flex flex-col gap-1">
                  <span className="text-xs text-muted-foreground">目标</span>
                  <p>{task.goal}</p>
                </div>
                {task.steps.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <span className="text-xs text-muted-foreground">步骤</span>
                    <ol className="flex flex-col gap-2">
                      {task.steps.map((step, index) => (
                        <li key={index} className="flex gap-2">
                          <span className="w-4 shrink-0 text-muted-foreground tabular-nums">{index + 1}</span>
                          <span className="flex min-w-0 flex-col gap-0.5">
                            <span>
                              {step.text}
                              {step.wait && (
                                <Badge variant="secondary" className="ml-2">
                                  可以等
                                </Badge>
                              )}
                            </span>
                            {step.checkpoint && (
                              <span className="flex gap-1 text-xs text-muted-foreground">
                                <CircleCheckIcon className="mt-0.5 size-3 shrink-0" />
                                {step.checkpoint}
                              </span>
                            )}
                          </span>
                        </li>
                      ))}
                    </ol>
                  </div>
                )}
                <DispatchLines plan={plan} task={task} />
                <Separator />
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
                  <Meta label="运行" hint={task.schedule ? `cron ${task.schedule.cron}` : task.dispatch ? DISPATCH_RUN_HINT : undefined}>
                    <span className="flex flex-col gap-2">
                      <span>{task.schedule ? `定时：${cronText(task.schedule.cron) ?? task.schedule.cron}` : task.dispatch ? "被派活：有单就开始，没单不跑" : "按需运行（点「立即运行」才跑）"}</span>
                      <Field orientation="horizontal" className="w-auto">
                        <Checkbox id={`import-enable-${task.key}`} checked={taskEnabled(task)} onCheckedChange={(checked) => setTask(task.key, { enabled: Boolean(checked) })} />
                        <FieldLabel htmlFor={`import-enable-${task.key}`} className="font-normal">
                          导入后就启用
                        </FieldLabel>
                      </Field>
                    </span>
                  </Meta>
                  <Meta label="负责人">
                    <Select items={ownerItems} value={task.ownerId} onValueChange={(value) => value && setTask(task.key, { ownerId: String(value) })}>
                      <SelectTrigger size="sm" aria-label="负责人" className="w-full">
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
                  </Meta>
                  <Meta label="模型" hint={task.modelNote}>
                    <ModelCombobox
                      className="w-full"
                      models={models}
                      value={task.modelId ?? ""}
                      onValueChange={(value) => {
                        const modelId = value || null
                        // 换了模型，AI 写的「为什么用这个模型」就不对了
                        if (modelId !== task.modelId) setTask(task.key, { modelId, modelNote: undefined })
                      }}
                      clearable
                      placeholder={defaults.run ? `默认执行模型（${modelName(defaults.run)}）` : "搜模型名"}
                    />
                  </Meta>
                  {browser && (
                    <Meta label="浏览器" hint="不选 = 全部 Chrome 都能用，agent 按每个配置的说明自己选。网址白名单在「修改」里设。">
                      <span className="flex flex-col gap-1">
                        <ChromePick task={task} onChange={(ids) => setTask(task.key, { browserProfileIds: ids })} />
                        <span className="text-xs text-muted-foreground">{task.allowedDomains.length ? `只许打开 ${task.allowedDomains.join("、")}` : "网址不限"}</span>
                      </span>
                    </Meta>
                  )}
                  <Meta label="用到的配置" hint="在后面几步确认。哪一项不导入，这里就跟着去掉。">
                    {usesOf(plan, task)}
                  </Meta>
                  {task.attachments.length > 0 && (
                    <Meta label="附件">
                      <span className="flex flex-wrap items-center gap-1">
                        {task.attachments.map((path) => (
                          <Badge key={path} variant="outline" title={path}>
                            <PaperclipIcon data-icon="inline-start" />
                            {baseName(path)}
                          </Badge>
                        ))}
                      </span>
                    </Meta>
                  )}
                </dl>
                {missing.length > 0 && (
                  <Alert>
                    <GlobeIcon />
                    <AlertTitle>
                      「{profileLabel(task.browserProfileIds)}」里还没有 {missing.map((login) => login.name).join("、")} 的账号
                    </AlertTitle>
                    <AlertDescription>可以先导入。导入后到「浏览器」页登录，不然 agent 打开要登录的页面时会停下来等人。</AlertDescription>
                  </Alert>
                )}
                {task.source && (
                  <p className="truncate text-xs text-muted-foreground" title={task.source}>
                    来自 {task.source}
                  </p>
                )}
              </CardContent>
            )}
          </Card>
        )
      })}
      <TaskEditDialog
        plan={plan}
        task={editing}
        onClose={() => setEditing(null)}
        onSave={(task) => {
          setTask(task.key, task)
          setEditing(null)
        }}
      />
    </>
  )
}

const DISPATCH_RUN_HINT = "被派来的运行才带着这件事的参数，按定时跑出来的不知道该办哪件，所以导入时去掉了包里的定时（「总览」的「要注意的」里写了原来的）。要的话点「修改」把定时加回来。"

/**
 * 任务卡片上的派活关系（派活第二期，导入时自动配好）。
 * 接受派活的：「接受派活：参数 单号（必填，去重）· 同时最多 1 个 · 来自「巡检」」；派活方：「派活给「处理…」」。
 * 只算勾上的任务：派活方没勾上时写「来自：（没有勾上的任务）」。
 */
function DispatchLines({ plan, task }: { plan: ImportPlan; task: PlanTask }) {
  const included = (key: string) => plan.tasks.find((each) => each.key === key && each.include)
  const targets = plan.tasks.filter((each) => each.include && each.key !== task.key && each.dispatch?.fromKeys.includes(task.key))
  const dispatch = task.dispatch
  if (!dispatch && !targets.length) return null
  const from = dispatch?.fromKeys.flatMap((key) => included(key) ?? [])
  const { retries } = retriesOf(dispatch)
  return (
    <div className="flex flex-col gap-1.5">
      {dispatch && (
        <p className="flex items-start gap-2">
          <InboxIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>
            接受派活：参数 {dispatch.params.map((p) => `${p.name}（${[p.required ? "必填" : "可选", p.dedupe && "去重"].filter(Boolean).join("，")}）`).join("、") || "（没写，派的时候自己填）"}
            {" · "}同时最多 {dispatch.maxRunning} 个
            {!!retries && ` · 没办成自动重试 ${retries} 次`}
            {" · "}
            {from?.length ? `来自${from.map((each) => `「${each.title}」`).join("、")}` : dispatch.fromKeys.length ? "来自：（没有勾上的任务）" : "来自：（还没有任务派活给它，只能人派）"}
          </span>
        </p>
      )}
      {targets.map((target) => (
        <p key={target.key} className="flex items-start gap-2">
          <SendIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <span>派活给「{target.title}」（导入时给它选上内置工具「派活」）</span>
        </p>
      ))}
    </div>
  )
}

function Meta({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="flex items-center gap-1 text-xs text-muted-foreground">
        {label}
        {hint && <HelpTip>{hint}</HelpTip>}
      </dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  )
}

/** 任务用到哪些（只算会导入的）：「技能 3 个 · 任务记忆 2 条 · 共用记忆 3 条 · 规则 4 条 · 工具 3 个」 */
function usesOf(plan: ImportPlan, task: PlanTask) {
  const on = <T extends { key: string; include: boolean }>(list: T[], keys: string[], extra: (item: T) => boolean = () => true) =>
    list.filter((item) => keys.includes(item.key) && item.include && extra(item)).length
  const skills = on(plan.skills, task.skillKeys)
  const taskMemories = plan.memories.filter((memory) => memoryOn(plan, memory) && memory.target.kind === "task" && memory.target.taskKey === task.key).length
  const shared = on(plan.memories, task.memoryKeys, (memory) => memory.target.kind === "shared")
  const rules = on(plan.rules, task.ruleKeys, (rule) => rule.kind !== "unsupported")
  const tools = on(plan.tools, task.toolKeys)
  return `技能 ${skills} 个 · 任务记忆 ${taskMemories} 条 · 共用记忆 ${shared} 条 · 规则 ${rules} 条 · 工具 ${tools} 个`
}

// ---------- 3 技能 ----------

const RESOLUTION_ITEMS: { value: PlanSkillResolution; label: string }[] = [
  { value: "use_existing", label: "用已有的" },
  { value: "new_version", label: "更新成新一版" },
  { value: "save_as_new", label: "另存为新技能" },
]

const usedByText = (plan: ImportPlan, key: string, pick: (task: PlanTask) => string[]) => {
  const users = plan.tasks.filter((task) => task.include && pick(task).includes(key))
  return users.length ? `${users.map((task) => `「${task.title}」`).join("、")}用` : "没有任务用"
}

/** 没写分组的技能归到哪：方案里有分组就是「其他」，一个分组都没有（旧方案）就是「新建」 */
const OTHER_GROUP = "其他"
const groupOf = (skill: PlanSkill, grouped: boolean) => skill.group?.trim() || (grouped ? OTHER_GROUP : "新建")

/** 新建的技能按 group 分组（按方案里第一次出现的顺序，「其他」放最后）；同名的不在这里 */
function skillGroups(skills: PlanSkill[]) {
  const fresh = skills.filter((skill) => !skill.existing)
  const grouped = fresh.some((skill) => skill.group?.trim())
  const groups = new Map<string, PlanSkill[]>()
  for (const skill of fresh) {
    const name = groupOf(skill, grouped)
    groups.set(name, [...(groups.get(name) ?? []), skill])
  }
  const list = [...groups].map(([name, items]) => ({ name, skills: items }))
  return { grouped, list: [...list.filter((group) => group.name !== OTHER_GROUP), ...list.filter((group) => group.name === OTHER_GROUP)] }
}

interface SkillRowProps {
  skill: PlanSkill
  usedBy: string
  /** 说明最多两行（大组里用），悬停看全文 */
  clamp?: boolean
  onToggle: (key: string, include: boolean) => void
  onEdit?: (skill: PlanSkill) => void
  children?: React.ReactNode
}

/** 一个技能一行。memo：几百个技能时勾一个只重画那一行 */
const SkillRow = React.memo(function SkillRow({ skill, usedBy, clamp = false, onToggle, onEdit, children }: SkillRowProps) {
  const detail = `${skill.source}${skill.merged.length ? `，合并了 ${skill.merged.join("、")}` : ""} · ${usedBy}`
  return (
    <Item variant="outline" size="sm">
      <ItemMedia>
        <Checkbox aria-label={`导入技能「${skill.name}」`} checked={skill.include} onCheckedChange={(checked) => onToggle(skill.key, Boolean(checked))} />
      </ItemMedia>
      {/* 同名技能那行按钮多：窄屏时让按钮换到下一行，说明不被挤成一列 */}
      <ItemContent className={children ? "min-w-0 basis-48" : "min-w-0"}>
        <ItemTitle className="flex flex-wrap items-center gap-2">
          {skill.name}
          {skill.dept && <Badge variant="ghost">{skill.dept}</Badge>}
        </ItemTitle>
        <ItemDescription className={clamp ? "line-clamp-2" : "line-clamp-none"} title={clamp ? `${skill.description}\n${detail}` : undefined}>
          {skill.description}
          <br />
          <span className="font-mono">{skill.source}</span>
          {skill.merged.length ? `，合并了 ${skill.merged.join("、")}` : ""} · {usedBy}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="flex-wrap">
        {children}
        {onEdit && (
          <Button variant="ghost" size="sm" disabled={!skill.include} onClick={() => onEdit(skill)}>
            <BookOpenIcon data-icon="inline-start" />
            看 / 改
          </Button>
        )}
      </ItemActions>
    </Item>
  )
})

/** 一组技能：可以收起（收起时不渲染里面的行），标题旁「全选」「全不选」 */
function SkillGroupCard({
  name,
  skills,
  usedBy,
  open,
  onOpenChange,
  onToggle,
  onSetAll,
  onEdit,
}: {
  name: string
  skills: PlanSkill[]
  usedBy: Map<string, string>
  open: boolean
  onOpenChange: (open: boolean) => void
  onToggle: (key: string, include: boolean) => void
  onSetAll: (group: string, include: boolean) => void
  onEdit: (skill: PlanSkill) => void
}) {
  const picked = skills.filter((skill) => skill.include).length
  return (
    <Card size="sm">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-1">
            <CollapsibleTrigger render={<Button variant="ghost" size="sm" aria-label={`${open ? "收起" : "展开"}「${name}」`} />}>
              {open ? <ChevronDownIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
              {name}
            </CollapsibleTrigger>
            <span className="text-xs text-muted-foreground tabular-nums">
              已选 {picked} / 共 {skills.length}
            </span>
          </CardTitle>
          <CardAction className="flex gap-1">
            <Button variant="ghost" size="xs" disabled={picked === skills.length} onClick={() => onSetAll(name, true)}>
              全选
            </Button>
            <Button variant="ghost" size="xs" disabled={picked === 0} onClick={() => onSetAll(name, false)}>
              全不选
            </Button>
          </CardAction>
        </CardHeader>
        <CollapsibleContent>
          {open && (
            <CardContent className="text-sm">
              <ItemGroup className="gap-2">
                {skills.map((skill) => (
                  <SkillRow key={skill.key} skill={skill} usedBy={usedBy.get(skill.key) ?? "没有任务用"} clamp onToggle={onToggle} onEdit={onEdit} />
                ))}
              </ItemGroup>
            </CardContent>
          )}
        </CollapsibleContent>
      </Collapsible>
    </Card>
  )
}

function SkillsStep({ plan, updatePlan }: { plan: ImportPlan; updatePlan: UpdatePlan }) {
  const [editing, setEditing] = React.useState<PlanSkill | null>(null)
  const [diffing, setDiffing] = React.useState<PlanSkill | null>(null)
  const setSkill = React.useCallback(
    (key: string, patch: Partial<PlanSkill>) => updatePlan((current) => ({ ...current, skills: current.skills.map((skill) => (skill.key === key ? { ...skill, ...patch } : skill)) })),
    [updatePlan]
  )
  const toggle = React.useCallback((key: string, include: boolean) => setSkill(key, { include }), [setSkill])
  const setAll = React.useCallback(
    (group: string, include: boolean) =>
      updatePlan((current) => {
        const { grouped } = skillGroups(current.skills)
        return { ...current, skills: current.skills.map((skill) => (!skill.existing && groupOf(skill, grouped) === group && skill.include !== include ? { ...skill, include } : skill)) }
      }),
    [updatePlan]
  )
  const groups = skillGroups(plan.skills).list
  const clashes = plan.skills.filter((skill) => skill.existing)
  // 哪些任务用这个技能：算一次，行里只拿字符串（memo 才有用）
  const usedBy = new Map<string, string>()
  for (const skill of plan.skills) usedBy.set(skill.key, usedByText(plan, skill.key, (task) => task.skillKeys))
  // 有勾上的组默认展开，一个都没勾的默认收起；之后由人决定
  const [open, setOpen] = React.useState<Record<string, boolean>>(() => Object.fromEntries(groups.map((group) => [group.name, group.skills.some((skill) => skill.include)])))

  return (
    <>
      {groups.map((group) => (
        <SkillGroupCard
          key={group.name}
          name={group.name}
          skills={group.skills}
          usedBy={usedBy}
          open={open[group.name] ?? group.skills.some((skill) => skill.include)}
          onOpenChange={(next) => setOpen((current) => ({ ...current, [group.name]: next }))}
          onToggle={toggle}
          onSetAll={setAll}
          onEdit={setEditing}
        />
      ))}
      {clashes.length > 0 && (
        <DetailSection title={`已经有同名的（${clashes.length}）`} description="默认用已有的，不改它。包里的版本更好就选「更新成新一版」（旧版本留在历史里），两个都要就「另存为新技能」。">
          <ItemGroup className="gap-2">
            {clashes.map((skill) => (
              <div key={skill.key} className="flex flex-col gap-1">
                <SkillRow skill={skill} usedBy={usedBy.get(skill.key) ?? ""} onToggle={toggle} onEdit={skill.resolution !== "use_existing" ? setEditing : undefined}>
                  <Button variant="ghost" size="sm" onClick={() => setDiffing(skill)}>
                    看差别
                  </Button>
                  <Select items={RESOLUTION_ITEMS} value={skill.resolution} onValueChange={(value) => value && setSkill(skill.key, { resolution: value as PlanSkillResolution })}>
                    <SelectTrigger size="sm" aria-label={`「${skill.name}」怎么处理`} className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {RESOLUTION_ITEMS.map((item) => (
                        <SelectItem key={item.value} value={item.value}>
                          {item.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </SkillRow>
                <p className="px-1 text-xs text-muted-foreground">
                  AI：{skill.existing?.note}（已有的是第 {skill.existing?.version} 版
                  {skill.existing?.status === "published" ? "" : skill.existing?.status === "draft" ? "，还是草稿，导入时会发布它" : "，已停用，导入时会发布它"}）
                </p>
              </div>
            ))}
          </ItemGroup>
        </DetailSection>
      )}
      <SkillEditDialog
        plan={plan}
        skill={editing}
        onClose={() => setEditing(null)}
        onSave={(skill) => {
          setSkill(skill.key, skill)
          setEditing(null)
        }}
      />
      <SkillDiffDialog skill={diffing} onClose={() => setDiffing(null)} />
    </>
  )
}

// ---------- 4 记忆 ----------

const FLAG_LABEL: Record<NonNullable<PlanMemory["flag"]>["kind"], string> = { duplicate: "重复：", suspicious: "可疑：", outdated: "过时：" }

const SHARED_DEFAULT = "通用"

/**
 * 挪记忆，任务的「用到的共用记忆」跟着对上：
 * 任务记忆改成共用 → 原来那个任务的 memoryKeys 加上它；共用改成某个任务的任务记忆 → 从所有任务的 memoryKeys 里去掉
 */
function moveMemory(plan: ImportPlan, key: string, target: PlanMemoryTarget): ImportPlan {
  const memory = plan.memories.find((each) => each.key === key)
  if (!memory) return plan
  let tasks = plan.tasks
  if (target.kind === "shared" && memory.target.kind === "task") {
    const from = memory.target.taskKey
    tasks = tasks.map((task) => (task.key === from && !task.memoryKeys.includes(key) ? { ...task, memoryKeys: [...task.memoryKeys, key] } : task))
  }
  if (target.kind === "task") tasks = tasks.map((task) => (task.memoryKeys.includes(key) ? { ...task, memoryKeys: task.memoryKeys.filter((each) => each !== key) } : task))
  return { ...plan, tasks, memories: plan.memories.map((each) => (each.key === key ? { ...each, target } : each)) }
}

function MemoriesStep({ plan, updatePlan }: { plan: ImportPlan; updatePlan: UpdatePlan }) {
  const [editingKey, setEditingKey] = React.useState<string | null>(null)
  const setMemory = (key: string, patch: Partial<PlanMemory>) => updatePlan((current) => ({ ...current, memories: current.memories.map((memory) => (memory.key === key ? { ...memory, ...patch } : memory)) }))
  const flagged = plan.memories.filter((memory) => memory.flag)
  const normal = plan.memories.filter((memory) => !memory.flag)
  const included = plan.tasks.filter((task) => task.include)
  const skipped = plan.tasks.filter((task) => !task.include)
  const groups: { key: string; title: string; help: string; list: PlanMemory[]; dim?: boolean }[] = [
    ...included.map((task) => ({
      key: task.key,
      title: `「${task.title}」的任务记忆`,
      help: "只给这个任务用的经验，每次运行开始时全部交给 agent。导入后在任务详情里能看到、能改。",
      list: normal.filter((memory) => memory.target.kind === "task" && memory.target.taskKey === task.key),
    })),
    {
      key: "shared",
      title: "共用的记忆",
      help: "放进「记忆」页，别的任务也能选。这次导入的任务会自动选上。",
      list: normal.filter((memory) => memory.target.kind === "shared"),
    },
    ...skipped.map((task) => ({
      key: task.key,
      title: `「${task.title}」的任务记忆`,
      help: "这个任务这次不导入，它的任务记忆也不导入。要留下来，就从「⋯」改成共用的记忆。",
      list: normal.filter((memory) => memory.target.kind === "task" && memory.target.taskKey === task.key),
      dim: true,
    })),
  ]
  const moveTargets: { label: string; target: PlanMemoryTarget }[] = [
    ...included.map((task) => ({ label: `挪到「${task.title}」的任务记忆`, target: { kind: "task" as const, taskKey: task.key } })),
    { label: "改成共用的记忆", target: { kind: "shared", appliesTo: SHARED_DEFAULT } },
  ]
  const sameTarget = (a: PlanMemoryTarget, b: PlanMemoryTarget) => a.kind === b.kind && (a.kind === "shared" || (b.kind === "task" && a.taskKey === b.taskKey))

  const row = (memory: PlanMemory) => {
    const editing = editingKey === memory.key
    return (
      <Item key={memory.key} variant="outline" size="xs">
        <ItemMedia>
          <Checkbox aria-label={`导入「${memory.text}」`} checked={memory.include} onCheckedChange={(checked) => setMemory(memory.key, { include: Boolean(checked) })} />
        </ItemMedia>
        <ItemContent className="min-w-0">
          {editing ? (
            <Textarea rows={2} maxLength={1000} aria-label="记忆内容" value={memory.text} onChange={(event) => setMemory(memory.key, { text: event.target.value })} onBlur={() => setEditingKey(null)} autoFocus />
          ) : (
            <ItemTitle className="line-clamp-none">{memory.text}</ItemTitle>
          )}
          <ItemDescription className="line-clamp-none">
            {memory.flag ? (
              <span className={memory.flag.kind === "suspicious" ? "text-destructive" : undefined}>
                {FLAG_LABEL[memory.flag.kind]}
                {memory.flag.text}
              </span>
            ) : (
              <>
                来自 {memory.source}
                {memory.target.kind === "shared" && ` · 适用于：${memory.target.appliesTo}`}
              </>
            )}
          </ItemDescription>
        </ItemContent>
        <ItemActions>
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" aria-label="这条记忆的操作" />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-60">
              <DropdownMenuItem onClick={() => setEditingKey(memory.key)}>
                <PencilIcon />
                改文字
              </DropdownMenuItem>
              {moveTargets
                .filter((option) => !sameTarget(option.target, memory.target))
                .map((option) => (
                  <DropdownMenuItem key={option.label} onClick={() => updatePlan((current) => moveMemory(current, memory.key, option.target))}>
                    <BrainIcon />
                    {option.label}
                  </DropdownMenuItem>
                ))}
            </DropdownMenuContent>
          </DropdownMenu>
        </ItemActions>
      </Item>
    )
  }

  return (
    <>
      {groups
        .filter((group) => group.list.length > 0)
        .map((group) => (
          <DetailSection key={group.key} title={`${group.title}（${group.list.length}）`} description={group.help}>
            <ItemGroup className={group.dim ? "gap-2 opacity-60" : "gap-2"}>{group.list.map(row)}</ItemGroup>
          </DetailSection>
        ))}
      {flagged.length > 0 && (
        <DetailSection title={`不建议导入（${flagged.length}）`} description="和已有的重复、看着像混进来的指令，或者包里写明已经过时了。默认不勾；确认没问题可以勾上。">
          <ItemGroup className="gap-2">{flagged.map(row)}</ItemGroup>
        </DetailSection>
      )}
    </>
  )
}

// ---------- 5 规则 ----------

/** 新规则要人留意的那一行：要等导入后翻译的、文字改过还没翻译的、还没翻译的。翻译好了不显示（和「触发 → 动作」说的是一回事） */
function Understood({ plan, rule }: { plan: ImportPlan; rule: PlanRule }) {
  const stale = rule.compile && (rule.compile.trigger !== rule.trigger || rule.compile.action !== rule.action)
  if (!rule.needsNewTools && rule.compile && !stale) return null
  return (
    <ItemDescription className="line-clamp-none">
      {rule.needsNewTools
        ? `用到这次才导入的工具（${rule.toolKeys.map((key) => toolTitle(plan, key)).join("、")}），导入后到「规则」页确认才生效。`
        : `${stale ? "文字改过，还没重新翻译" : "还没翻译"}：点「修改」翻译，或者导入后到「规则」页确认。`}
    </ItemDescription>
  )
}

function RulesStep({ importId, plan, updatePlan }: { importId: string; plan: ImportPlan; updatePlan: UpdatePlan }) {
  const [editing, setEditing] = React.useState<PlanRule | null>(null)
  const setRule = (key: string, patch: Partial<PlanRule>) => updatePlan((current) => ({ ...current, rules: current.rules.map((rule) => (rule.key === key ? { ...rule, ...patch } : rule)) }))
  const fresh = plan.rules.filter((rule) => rule.kind === "new")
  const existing = plan.rules.filter((rule) => rule.kind === "existing")
  const unsupported = plan.rules.filter((rule) => rule.kind === "unsupported")

  const check = (rule: PlanRule) => (
    <ItemMedia>
      <Checkbox aria-label={`用规则「${rule.name}」`} checked={rule.include} onCheckedChange={(checked) => setRule(rule.key, { include: Boolean(checked) })} />
    </ItemMedia>
  )

  return (
    <>
      {fresh.length > 0 && (
        <DetailSection title={`新建（${fresh.length}）`} description="读包时已经用「规划」模型翻译好了，勾上导入后直接生效；不对就「修改」文字，会重新翻译。">
          <ItemGroup className="gap-2">
            {fresh.map((rule) => (
              <Item key={rule.key} variant="outline" size="sm">
                {check(rule)}
                <ItemContent className="min-w-0">
                  <ItemTitle>{rule.name}</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {rule.trigger} → {rule.action}
                  </ItemDescription>
                  <Understood plan={plan} rule={rule} />
                  {rule.source && <ItemDescription className="font-mono">{rule.source}</ItemDescription>}
                </ItemContent>
                <ItemActions>
                  <Button variant="ghost" size="sm" disabled={!rule.include} onClick={() => setEditing(rule)}>
                    <PencilIcon data-icon="inline-start" />
                    修改
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </DetailSection>
      )}
      {existing.length > 0 && (
        <DetailSection title={`用已有的（${existing.length}）`} description="已经生效的规则，不新建，导入的任务直接选上。">
          <ItemGroup className="gap-2">
            {existing.map((rule) => (
              <Item key={rule.key} variant="outline" size="sm">
                {check(rule)}
                <ItemContent className="min-w-0">
                  <ItemTitle className="flex flex-wrap items-center gap-2">
                    {rule.name}
                    {rule.suggested ? (
                      <Badge variant="secondary">AI 建议加上</Badge>
                    ) : (
                      <Badge variant="outline">
                        <ShieldCheckIcon data-icon="inline-start" />
                        已生效
                      </Badge>
                    )}
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none">{rule.reason ?? `${rule.trigger} → ${rule.action}`}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </DetailSection>
      )}
      {unsupported.length > 0 && (
        <DetailSection title={`导入不了（${unsupported.length}）`}>
          <ItemGroup className="gap-2">
            {unsupported.map((rule) => (
              <Item key={rule.key} variant="muted" size="sm">
                <ItemMedia variant="icon">
                  <CircleSlashIcon />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle>
                    {rule.name}
                    {rule.source && `（${rule.source}）`}
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none">{rule.reason}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </DetailSection>
      )}
      <RuleEditDialog
        importId={importId}
        rule={editing}
        onClose={() => setEditing(null)}
        onSaved={(rule) => {
          updatePlan((current) => ({ ...current, rules: current.rules.map((each) => (each.key === rule.key ? rule : each)) }))
          setEditing(null)
          toast.add({
            title: rule.kind === "unsupported" ? "这条规则 v1 管不了" : "翻译好了",
            description: rule.kind === "unsupported" ? (rule.reason ?? "挪到了「导入不了」，不导入") : rule.compile?.understood,
            type: rule.kind === "unsupported" ? "warning" : "success",
          })
        }}
      />
    </>
  )
}

// ---------- 6 工具 ----------

const TOOL_KIND = { http: "HTTP 接口", mcp: "MCP 服务器" } as const

const toolDetail = (tool: PlanTool) => (tool.http ? `${tool.http.method} ${tool.http.url}` : tool.mcp ? (tool.mcp.transport === "http" ? tool.mcp.url : tool.mcp.command) : undefined)

function ToolsStep({ importId, plan, updatePlan }: { importId: string; plan: ImportPlan; updatePlan: UpdatePlan }) {
  const [editing, setEditing] = React.useState<PlanTool | null>(null)
  const savedSecrets = useToolsQuery().data?.savedSecrets ?? {}
  const setTool = (key: string, patch: Partial<PlanTool>) => updatePlan((current) => ({ ...current, tools: current.tools.map((tool) => (tool.key === key ? { ...tool, ...patch } : tool)) }))
  const external = plan.tools.filter((tool) => tool.kind === "http" || tool.kind === "mcp")
  const builtin = plan.tools.filter((tool) => tool.kind === "builtin")
  const existing = plan.tools.filter((tool) => tool.kind === "existing")

  const simpleRow = (tool: PlanTool) => (
    <Item key={tool.key} variant="outline" size="xs">
      <ItemMedia>
        <Checkbox aria-label={`选上「${tool.name}」`} checked={tool.include} onCheckedChange={(checked) => setTool(tool.key, { include: Boolean(checked) })} />
      </ItemMedia>
      <ItemContent className="min-w-0">
        <ItemTitle>{tool.name}</ItemTitle>
        <ItemDescription className="line-clamp-none">{tool.why || tool.summary}</ItemDescription>
      </ItemContent>
    </Item>
  )

  return (
    <>
      {external.length > 0 && (
        <DetailSection title={`接口和 MCP（${external.length}）`} description="新建到「工具」页。请求里的密钥已经换成 {{名字}}，值在下面「密钥」里。">
          <ItemGroup className="gap-2">
            {external.map((tool) => (
              <Item key={tool.key} variant="outline" size="sm">
                <ItemMedia>
                  <Checkbox aria-label={`导入工具「${tool.name}」`} checked={tool.include} onCheckedChange={(checked) => setTool(tool.key, { include: Boolean(checked) })} />
                </ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="flex flex-wrap items-center gap-2">
                    {tool.name}
                    <Badge variant="ghost">{TOOL_KIND[tool.kind as keyof typeof TOOL_KIND]}</Badge>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    {tool.summary}
                    {tool.source && (
                      <>
                        {" "}
                        · 来自 <span className="font-mono">{tool.source}</span>
                      </>
                    )}
                  </ItemDescription>
                  {toolDetail(tool) && (
                    <code className="mt-1 block truncate text-xs" title={toolDetail(tool)}>
                      {toolDetail(tool)}
                    </code>
                  )}
                  {tool.kind === "mcp" && <ItemDescription className="line-clamp-none">导入后要在「工具」页连接一次，勾选要用的工具</ItemDescription>}
                </ItemContent>
                <ItemActions>
                  <Button variant="ghost" size="sm" disabled={!tool.include} onClick={() => setEditing(tool)}>
                    <PencilIcon data-icon="inline-start" />
                    修改
                  </Button>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </DetailSection>
      )}
      {builtin.length > 0 && (
        <DetailSection title={`内置工具（${builtin.length}）`} description="系统自带的，不用新建，导入的任务直接选上。有附件会自动带上「读附件」。">
          <ItemGroup className="gap-2">{builtin.map(simpleRow)}</ItemGroup>
        </DetailSection>
      )}
      {existing.length > 0 && (
        <DetailSection title={`用已有的（${existing.length}）`} description="「工具」页里已经有的，不新建，导入的任务直接选上。">
          <ItemGroup className="gap-2">{existing.map(simpleRow)}</ItemGroup>
        </DetailSection>
      )}
      {plan.secrets.length > 0 && (
        <DetailSection title={`密钥（${plan.secrets.length}）`} description="值加密存在服务器上，agent 和模型只看到 {{名字}}。没有的可以先空着，导入后在「工具」页补。">
          <div className="flex flex-col gap-3">
            {plan.secrets.map((secret) => (
              <SecretField
                key={secret.name}
                importId={importId}
                secret={secret}
                usedBy={secret.toolKeys.map((key) => toolTitle(plan, key)).join("」「")}
                onFilled={() => updatePlan((current) => ({ ...current, secrets: current.secrets.map((each) => (each.name === secret.name ? { ...each, filled: true } : each)) }))}
              />
            ))}
          </div>
        </DetailSection>
      )}
      <ToolEditDialog
        tool={editing}
        onClose={() => setEditing(null)}
        onSave={(tool) => {
          updatePlan((current) => {
            const next = { ...current, tools: current.tools.map((each) => (each.key === tool.key ? tool : each)) }
            return { ...next, secrets: syncSecrets(next, savedSecrets) }
          })
          setEditing(null)
        }}
      />
    </>
  )
}

/**
 * 一个密钥：包里有的、已经有同名的不用填；缺的在密码框里填，失焦就交给 imports.setSecret（加密存进这次导入）。
 * 值只在这个密码框里，存好就清掉，不进方案、不进别的状态
 */
function SecretField({ importId, secret, usedBy, onFilled }: { importId: string; secret: PlanSecret; usedBy: string; onFilled: () => void }) {
  const [value, setValue] = React.useState("")
  const [replacing, setReplacing] = React.useState(false)
  const setSecret = useAction(trpc.imports.setSecret.mutationOptions(), { errorTitle: `${secret.name} 没存上` })
  const id = `import-secret-${secret.name}`

  async function submit() {
    if (!value.trim() || setSecret.isPending) return
    if (await setSecret.submit({ id: importId, name: secret.name, value })) {
      setValue("")
      setReplacing(false)
      onFilled()
    }
  }

  const fixed = (text: string, note: React.ReactNode, action?: React.ReactNode) => (
    <InputGroup>
      <InputGroupInput id={id} type="password" value={text} readOnly />
      <InputGroupAddon align="inline-end">
        <InputGroupText>
          <CircleCheckIcon />
          {note}
        </InputGroupText>
        {action}
      </InputGroupAddon>
    </InputGroup>
  )

  return (
    <Field>
      <FieldLabel htmlFor={id} className="font-mono">
        {secret.name}
      </FieldLabel>
      {secret.found
        ? fixed("已经从包里取到", `来自 ${secret.where}`)
        : secret.exists
          ? fixed("用已有的值", "已经有同名的，用已有的值")
          : secret.filled && !replacing
            ? fixed(
                "已经填好了",
                "已存好",
                <InputGroupButton size="xs" onClick={() => setReplacing(true)}>
                  换一个
                </InputGroupButton>
              )
            : (
              <InputGroup>
                <InputGroupInput
                  id={id}
                  type="password"
                  autoComplete="new-password"
                  value={value}
                  disabled={setSecret.isPending}
                  placeholder={`包里没有（${secret.where}），可以现在填，也可以以后填`}
                  onChange={(event) => setValue(event.target.value)}
                  onBlur={() => void submit()}
                  onKeyDown={(event) => event.key === "Enter" && void submit()}
                />
                {setSecret.isPending && (
                  <InputGroupAddon align="inline-end">
                    <Spinner />
                  </InputGroupAddon>
                )}
              </InputGroup>
            )}
      <p className="text-xs text-muted-foreground">{usedBy ? `「${usedBy}」用` : "没有勾上的工具用它"}</p>
    </Field>
  )
}

// ---------- 7 确认导入 ----------

function ConfirmStep({ plan, onStep }: { plan: ImportPlan; onStep: (step: ImportStep) => void }) {
  const todos = useFollowUpPreview(plan)
  return (
    <>
      <DetailSection title="会导入这些" description="导入前什么都不会建。导入后，在这次导入的详情里可以一键撤销。">
        <PlanSummary plan={plan} onStep={onStep} />
      </DetailSection>
      {todos.length > 0 && (
        <DetailSection title={`导入以后还要你做的（${todos.length}）`} description="不影响导入。导入后这些会列在这次导入的详情里，每件都有直达按钮。">
          <ItemGroup className="gap-2">
            {todos.map((todo) => (
              <Item key={todo.key} variant="muted" size="xs">
                <ItemMedia variant="icon">{todo.icon}</ItemMedia>
                <ItemContent className="min-w-0">
                  <ItemTitle className="line-clamp-none">{todo.title}</ItemTitle>
                  <ItemDescription className="line-clamp-none">{todo.description}</ItemDescription>
                </ItemContent>
              </Item>
            ))}
          </ItemGroup>
        </DetailSection>
      )}
    </>
  )
}

export const SUMMARY_ICON = {
  tasks: <LayoutGridIcon />,
  skills: <BookOpenIcon />,
  memories: <BrainIcon />,
  rules: <ShieldCheckIcon />,
  tools: <WrenchIcon />,
  secrets: <KeyRoundIcon />,
  files: <PaperclipIcon />,
}

export interface SummaryRow {
  key: keyof typeof SUMMARY_ICON
  title: string
  description: React.ReactNode
}

/** 每类一行；onStep 传了就带「改」跳回那一步 */
export function SummaryRows({ rows, onStep }: { rows: SummaryRow[]; onStep?: (step: ImportStep) => void }) {
  return (
    <ItemGroup className="gap-2">
      {rows.map((row) => {
        const target: ImportStep = row.key === "secrets" ? "tools" : row.key === "files" ? "tasks" : row.key
        return (
          <Item key={row.key} variant="outline" size="xs">
            <ItemMedia variant="icon">{SUMMARY_ICON[row.key]}</ItemMedia>
            <ItemContent className="min-w-0">
              <ItemTitle>{row.title}</ItemTitle>
              <ItemDescription className="line-clamp-none">{row.description}</ItemDescription>
            </ItemContent>
            {onStep && (
              <ItemActions>
                <Button variant="ghost" size="sm" onClick={() => onStep(target)}>
                  改
                </Button>
              </ItemActions>
            )}
          </Item>
        )
      })}
    </ItemGroup>
  )
}

/** 方案的一览：每类一行，写明新建几个、用已有的几个、不导入几个 */
function PlanSummary({ plan, onStep }: { plan: ImportPlan; onStep: (step: ImportStep) => void }) {
  const staffName = useStaffName()
  const steps = stepsOf(plan)
  const tasks = plan.tasks.filter((task) => task.include)
  const skills = plan.skills.filter((skill) => skill.include)
  const memories = plan.memories.filter((memory) => memoryOn(plan, memory))
  const rules = plan.rules.filter((rule) => rule.include && rule.kind !== "unsupported")
  const tools = plan.tools.filter((tool) => tool.include)
  const names = <T,>(list: T[], name: (item: T) => string) => list.map(name).join("、")
  const part = (label: string, text: string) => (text ? `${label}：${text}` : "")
  const join = (...parts: string[]) => parts.filter(Boolean).join("；") || "无"
  const skipped = (count: number, unit: string) => (count ? `不导入 ${count} ${unit}` : "")
  const secrets = plan.secrets.filter((secret) => secret.toolKeys.some((key) => tools.some((tool) => tool.key === key)))
  const attachments = tasks.flatMap((task) => task.attachments.map((path) => `${baseName(path)} → 「${task.title}」`))

  const rows: SummaryRow[] = [
    {
      key: "tasks",
      title: `任务 ${tasks.length} 个`,
      description: tasks.length
        ? names(tasks, (task) => `「${task.title}」（${task.schedule ? task.schedule.text : task.dispatch ? "被派活" : "按需"}，负责人 ${staffName(task.ownerId)}${taskEnabled(task) ? "" : `，${DISABLED_TEXT}`}）`) + (plan.tasks.length > tasks.length ? `；不导入 ${plan.tasks.length - tasks.length} 个` : "")
        : "不建任务，只导入下面的配置",
    },
    {
      key: "skills",
      title: `技能 ${skills.length} 个`,
      description: join(
        part("新建并发布", names(skills.filter((s) => s.resolution === "new" || s.resolution === "save_as_new"), (s) => s.name)),
        part("更新成新一版", names(skills.filter((s) => s.resolution === "new_version"), (s) => s.name)),
        part("用已有的", names(skills.filter((s) => s.resolution === "use_existing"), (s) => s.name)),
        skipped(plan.skills.length - skills.length, "个")
      ),
    },
    {
      key: "memories",
      title: `记忆 ${memories.length} 条`,
      description: join(
        `任务记忆 ${memories.filter((m) => m.target.kind === "task").length} 条，共用记忆 ${memories.filter((m) => m.target.kind === "shared").length} 条`,
        skipped(plan.memories.length - memories.length, "条")
      ),
    },
    {
      key: "rules",
      title: `规则 ${rules.length} 条`,
      description: join(
        part("新建并生效", names(rules.filter((r) => r.kind === "new" && !r.needsNewTools && r.compile), (r) => r.name)),
        part("新建，导入后再确认", names(rules.filter((r) => r.kind === "new" && (r.needsNewTools || !r.compile)), (r) => r.name)),
        part("用已有的", names(rules.filter((r) => r.kind === "existing"), (r) => r.name)),
        skipped(plan.rules.length - rules.length, "条")
      ),
    },
    {
      key: "tools",
      title: `工具 ${tools.length} 个`,
      description: join(
        part("新建", names(tools.filter((t) => t.kind === "http" || t.kind === "mcp"), (t) => t.name)),
        part("内置", names(tools.filter((t) => t.kind === "builtin"), (t) => t.name)),
        part("用已有的", names(tools.filter((t) => t.kind === "existing"), (t) => t.name)),
        skipped(plan.tools.length - tools.length, "个")
      ),
    },
  ]
  if (secrets.length)
    rows.push({
      key: "secrets",
      title: `密钥 ${secrets.length} 个`,
      description: names(secrets, (s) => (s.found || s.filled ? s.name : s.exists ? `${s.name}（用已有的）` : `${s.name}（没填，导入后补）`)),
    })
  if (attachments.length) rows.push({ key: "files", title: `附件 ${attachments.length} 个`, description: attachments.join("、") })

  return <SummaryRows rows={rows.filter((row) => row.key === "secrets" || row.key === "files" || steps.includes(row.key) || row.key === "tasks")} onStep={onStep} />
}

interface FollowUpPreview {
  key: string
  icon: React.ReactNode
  title: string
  description: string
}

/** 导入以后还要人做的事（确认这一步预告；导入后由服务端按库里的状态算，列在详情里） */
function useFollowUpPreview(plan: ImportPlan): FollowUpPreview[] {
  const profiles = useBrowsersQuery().data ?? []
  const profileLabel = (ids: string[]) => (ids.length ? ids.map((id) => profiles.find((profile) => profile.id === id)?.name ?? id).join("、") : "全部 Chrome")
  const tasks = plan.tasks.filter((task) => task.include)
  const tools = plan.tools.filter((tool) => tool.include)
  const list: FollowUpPreview[] = []

  const logins = new Map<string, { profile: string; name: string; tasks: number }>()
  for (const task of tasks)
    for (const login of missingLogins(task, profiles)) {
      const key = `${profileLabel(task.browserProfileIds)}|${login.name}`
      const current = logins.get(key)
      logins.set(key, { profile: profileLabel(task.browserProfileIds), name: login.name, tasks: (current?.tasks ?? 0) + 1 })
    }
  for (const [key, login] of logins)
    list.push({
      key: `login-${key}`,
      icon: <GlobeIcon />,
      title: `在「${login.profile}」里登录 ${login.name}`,
      description: `${login.tasks} 个任务${login.tasks > 1 ? "都" : ""}要打开 ${login.name}，没登录 agent 会停下来等人。`,
    })
  for (const secret of plan.secrets) {
    const users = secret.toolKeys.filter((key) => tools.some((tool) => tool.key === key))
    if (!users.length || secret.found || secret.filled || secret.exists) continue
    list.push({ key: `secret-${secret.name}`, icon: <KeyRoundIcon />, title: `填密钥 ${secret.name}`, description: `包里没有它的值，「${users.map((key) => toolTitle(plan, key)).join("」「")}」要用。` })
  }
  for (const tool of tools.filter((each) => each.kind === "mcp"))
    list.push({ key: `mcp-${tool.key}`, icon: <WrenchIcon />, title: `连接 MCP 服务器「${tool.name}」`, description: "连上后勾选要用的工具，任务才用得上。" })
  for (const rule of plan.rules.filter((each) => each.include && each.kind === "new" && (each.needsNewTools || !each.compile)))
    list.push({ key: `rule-${rule.key}`, icon: <ShieldCheckIcon />, title: `翻译并确认规则「${rule.name}」`, description: "导入后到「规则」页看「系统理解为」，确认了才生效。" })
  for (const task of tasks)
    list.push(task.dispatch ? {
      // 派活第二期：被派活的任务不定时，导入后在详情里点「派一张试试」打开任务详情的「派一张」（#/tasks?id=<id>&dispatch=1）
      key: `run-${task.key}`,
      icon: <SendIcon />,
      title: `派一张试试「${task.title}」`,
      description: "被派活的任务不定时，有单才跑。先手动派一张（例如填一个真实的参数）看结果对不对；这个任务名下有过一张单就算办完。",
    } : {
      key: `run-${task.key}`,
      icon: <PlayIcon />,
      title: `试跑一次「${task.title}」`,
      description: !taskEnabled(task)
        ? "导入后先停用，不会自动跑。到任务页看过、试跑没问题再启用。"
        : task.schedule
          ? `导入后按定时（${task.schedule.text}）自动跑。想先看看效果，可以现在跑一次。`
          : "按需运行的任务，导入后还没跑过。先跑一次看看结果对不对。",
    })
  return list
}

