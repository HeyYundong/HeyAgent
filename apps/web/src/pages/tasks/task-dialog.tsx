// 新建 / 编辑任务（按用户草图）：一行任务 → 步骤（每步可勾「等待」「检查点」，可以一步都不写）→ 目标 → 用哪些 → 模型 → 定时运行。
// 表单：React Hook Form + shared 的 taskInputSchema；执行模型和三方验收模型不许同一家（前端先拦，后端也拦）。
// M3：规则只能选已经生效的（没生效的列出来但选不了，写明原因）；可以给任务单独选验收模型。
// tasks.update 是整体替换：verifyModelId、浏览器的三项、桌面的两项（desktopIds、allowDesktopVision）、派活的三项（dispatch、dispatchFrom、cronSkipIfRunning）都要带上，不然会被清空。
// 运行结果（docs/dev/run-outcome.md 5.4 节）：「完成」一组放三方验收模型和复核模型。复核一定做（2026-10-20 去掉了开关），复核模型必填，
// 新任务和以前没选的旧任务都先填上默认复核模型；选了「交给三方验收」的规则时，验收通过的不再复核。
// 固化（docs/dev/solidify.md 17.1）：「用哪些」里放「办成后自动固化」（跟默认 / 开 / 关，存 autoSolidify：null / true / false）和「固化时不试跑」（routineSkipTest），说明在 label 的「?」里。
// 自动挑选记忆（docs/dev/memory-retrieval.md 6.1 节）：「用哪些 → 记忆」下面一个开关 + 开着时「最多几条」；没设 embedding 模型时提醒开着也不会挑。
// 子 agent（docs/dev/sub-agents.md 11.3）：选了内置工具「拆给子 agent」才出现「子 agent 用的模型」（subagentModelId，空 = 和执行模型一样，整体替换要带上）；只允许 1 个 Chrome 时浏览器那里提醒一句。
// 派活（docs/dev/dispatch.md 9.1 节）：「被派活」一组（参数、名额、谁能派活给它，第二期加自动重试，组件在 dispatch-fields.tsx，导入向导也用）；定时那里「上一次还没跑完就跳过」；选了内置工具「派活」时写能派给谁。
import * as React from "react"
import { Controller, useFieldArray, useForm, useWatch, type Control, type UseFormRegister } from "react-hook-form"
import { PlayIcon, PlusIcon, XIcon } from "lucide-react"
import {
  alwaysOnToolIds,
  AUTO_MEMORY_DEFAULT,
  AUTO_MEMORY_LIMIT_DEFAULT,
  AUTO_MEMORY_LIMIT_OPTIONS,
  autoSolidifyDefault,
  BROWSER_TOOL_ID,
  can,
  checkpointKindLabel,
  DESKTOP_TOOL_ID,
  modelFamily,
  recognizeCheckpoints,
  sameFamily,
  SUBAGENT_START_TOOL_ID,
  WORK_DISPATCH_TOOL_ID,
  type TaskDef,
  type TaskInput,
  type UploadedFile,
} from "@heyagent/shared"

import { FileList, UploadButton } from "@/components/files"
import { ModelCombobox } from "@/components/shell/model-combobox"
import { HelpTip } from "@/components/shell/simple-page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSeparator, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"

import { useBrowsersQuery, useDesktopsQuery, useMemoriesQuery, useModels, useModelsQuery, useRulesQuery, useSkillsQuery, useStaffQuery, useTasksQuery, useToolName, useToolsQuery } from "@/lib/data"
import { domainsText, invalidDomainsMessage, parseDomains } from "@/lib/domains"
import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { compileOf, ruleHint, ruleSelectable, ruleVerifies } from "@/pages/rules/compile"

import { cronText } from "./cron"
import { DispatchFields, retriesOf, taskResolver } from "./dispatch-fields"
import { MultiPick, type Option } from "./multi-pick"
import { PLACEHOLDER } from "./data"
import { TaskAttachments } from "./run-actions"

type PickKey = "memoryIds" | "skillIds" | "toolIds" | "ruleIds"
const PICK_KEYS: PickKey[] = ["memoryIds", "skillIds", "toolIds", "ruleIds"]

/** 引擎生成运行快照时自动加上的工具（apps/server/src/engine/sessions.ts） */
const IMPLIED_TOOLS_NOTE = "选了技能会自动带上「读取技能」；有附件会自动带上「读附件」。选了「读附件」「存文件」「运行代码」会自动带上「列出文件」，选了「存文件」「运行代码」会自动带上「改文件」「删文件」，「运行代码」还会带上「存文件」「读附件」。"

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

/** 选了「浏览器」工具才出现：允许用哪些 Chrome 配置、网址白名单、是否允许执行脚本、看画面、直接调网站接口（导入时改任务没有这三项：hideEvaluate） */
/** subagents：任务也选了「拆给子 agent」，只允许 1 个 Chrome 时提醒用浏览器的子 agent 会一个一个做（docs/dev/sub-agents.md 6.3） */
export function BrowserFields({ control, domainText, domainError, onDomainText, hideEvaluate = false, subagents = false }: { control: Control<TaskInput>; domainText: string; domainError?: string; onDomainText: (text: string) => void; hideEvaluate?: boolean; subagents?: boolean }) {
  const profiles = useBrowsersQuery().data ?? []
  const options = profiles.map((profile) => ({ value: profile.id, label: profile.name, hint: profile.description }))
  return (
    <FieldSet className="sm:col-span-2">
      <FieldLegend variant="label">浏览器</FieldLegend>
      <FieldDescription>选了「浏览器」工具才有这几项。agent 用服务器上的 Chrome 操作网页；遇到简单的验证码先自己试着过（「设置 → 浏览器」里能关），过不了的验证码和登录页停下来交给负责人。</FieldDescription>
      <div className="grid gap-4 sm:grid-cols-2">
        <Controller
          control={control}
          name="browserProfileIds"
          render={({ field }) => (
            <MultiPick id="task-browserProfileIds" label="Chrome 配置" options={options} value={field.value ?? []} onChange={field.onChange}
              description={profiles.length ? "不选 = 全部都能用，agent 按每个配置的说明自己选。只允许一个时自动用它。" : "还没有 Chrome 配置：先去「浏览器」页新建。"}
              notes={subagents && ((field.value ?? []).length === 1 || (!field.value?.length && profiles.length === 1)) ? ["只允许 1 个 Chrome：用浏览器的子 agent 会一个一个做。"] : undefined} />
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
        {!hideEvaluate && <Controller
          control={control}
          name="allowBrowserVision"
          render={({ field }) => (
            <Field orientation="horizontal" className="sm:col-span-2">
              <Checkbox id="task-allowVision" checked={!!field.value} onCheckedChange={(on) => field.onChange(Boolean(on))} />
              <FieldContent>
                <FieldLabel htmlFor="task-allowVision">允许看画面</FieldLabel>
                <FieldDescription>agent 可以截当前画面给模型看、按坐标点击（在线表格、画布类网页用得上）。每看一次多花一张图的模型费用。</FieldDescription>
              </FieldContent>
            </Field>
          )}
        />}
        {!hideEvaluate && <Controller
          control={control}
          name="allowBrowserFetch"
          render={({ field }) => (
            <Field orientation="horizontal" className="sm:col-span-2">
              <Checkbox id="task-allowFetch" checked={!!field.value} onCheckedChange={(on) => field.onChange(Boolean(on))} />
              <FieldContent>
                <FieldLabel htmlFor="task-allowFetch">允许直接调网站接口</FieldLabel>
                <FieldDescription>agent 和固化流程可以带着登录态直接调网站自己用的接口，读列表、翻页快得多；运行时会记下网页调的接口，给固化用。只能调当前网站的；会改东西的请求照常过规则。</FieldDescription>
              </FieldContent>
            </Field>
          )}
        />}
      </div>
    </FieldSet>
  )
}

/** 选了「桌面」工具才出现：允许用哪些桌面、是否允许看画面（docs/dev/desktop.md 第 7 节） */
export function DesktopFields({ control }: { control: Control<TaskInput> }) {
  // 模板不是给 agent 用的（docs/dev/desktop-vm.md 第 0 节），不列出来
  const desktops = (useDesktopsQuery().data ?? []).filter((desktop) => desktop.kind !== "template")
  const options = desktops.map((desktop) => ({ value: desktop.id, label: desktop.name, hint: desktop.description }))
  return (
    <FieldSet className="sm:col-span-2">
      <FieldLegend variant="label">桌面</FieldLegend>
      <FieldDescription>选了「桌面」工具才有这两项。agent 在「桌面」页里的 Windows 电脑上操作电脑软件：先读界面上的控件再点；要扫码、登录这类只有人能做的事，停下来交给负责人在远程画面里处理。</FieldDescription>
      <div className="grid gap-4 sm:grid-cols-2">
        <Controller
          control={control}
          name="desktopIds"
          render={({ field }) => (
            <MultiPick id="task-desktopIds" label="能用哪些桌面" options={options} value={field.value ?? []} onChange={field.onChange}
              description={desktops.length ? "不选 = 全部都能用，agent 按每台的说明自己挑（关着的分不到）。都被占着时运行会排队等。" : "还没有桌面：先去「桌面」页新建一台。"} />
          )}
        />
        <Controller
          control={control}
          name="allowDesktopVision"
          render={({ field }) => (
            <Field orientation="horizontal" className="sm:col-span-2">
              <Checkbox id="task-allowDesktopVision" checked={!!field.value} onCheckedChange={(on) => field.onChange(Boolean(on))} />
              <FieldContent>
                <FieldLabel htmlFor="task-allowDesktopVision">允许看画面</FieldLabel>
                <FieldDescription>agent 可以截桌面画面给模型看（读不到控件的软件、图片里的字用得上）。不开时只能读界面控件。每看一次多花一张图的模型费用。</FieldDescription>
              </FieldContent>
            </Field>
          )}
        />
      </div>
    </FieldSet>
  )
}

/** 「办成后自动固化」三种：跟默认（null）/ 开（true）/ 关（false）。Select 的值只能是字符串，这里来回换 */
const AUTO_SOLIDIFY_VALUES = { default: null, on: true, off: false } as const
type AutoSolidifyChoice = keyof typeof AUTO_SOLIDIFY_VALUES
const autoSolidifyChoice = (value: boolean | null | undefined): AutoSolidifyChoice => (value === true ? "on" : value === false ? "off" : "default")

/** 固化的两项设置（docs/dev/solidify.md 17.1）：办成后自动固化、固化时不试跑。autoDefault = 没单独设时按什么（被派的、定时的开） */
function SolidifyFields({ control, autoDefault }: { control: Control<TaskInput>; autoDefault: boolean }) {
  const items = [
    { value: "default", label: `跟默认（${autoDefault ? "开" : "关"}）` },
    { value: "on", label: "开" },
    { value: "off", label: "关" },
  ]
  return (
    <>
      <Controller
        control={control}
        name="autoSolidify"
        render={({ field }) => (
          <Field>
            <FieldLabel htmlFor="task-autoSolidify" className="flex items-center gap-1">
              办成后自动固化
              <HelpTip>
                普通运行办成后，系统自动把这次的做法写成固化流程的新一版：还没有固化流程时写第一版；脚本跑不通、agent 接着办成时修一版。写好照样要人审核才启用。
                「跟默认」：被派的任务、定时任务开，别的关（这个任务现在是{autoDefault ? "开" : "关"}）。
              </HelpTip>
            </FieldLabel>
            <Select items={items} value={autoSolidifyChoice(field.value)} onValueChange={(value) => value && field.onChange(AUTO_SOLIDIFY_VALUES[value as AutoSolidifyChoice])}>
              <SelectTrigger id="task-autoSolidify" className="w-full"><SelectValue /></SelectTrigger>
              <SelectContent>
                {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
              </SelectContent>
            </Select>
          </Field>
        )}
      />
      <Controller
        control={control}
        name="routineSkipTest"
        render={({ field }) => (
          <Field orientation="horizontal" className="self-end">
            <Switch id="task-routineSkipTest" checked={!!field.value} onCheckedChange={(on) => field.onChange(Boolean(on))} />
            {/* 「?」放在 label 里：点 label 里的按钮不会切换开关（HTML 的 label 不转发交互元素上的点击） */}
            <FieldLabel htmlFor="task-routineSkipTest" className="items-center gap-1">
              固化时不试跑
              <HelpTip>会自动存草稿的网站打开，固化时不试跑、直接交给你审核（写好、程序检查过了就交）。自动固化照它；手动「固化成流程」时「不试跑」默认勾上。</HelpTip>
            </FieldLabel>
          </Field>
        )}
      />
    </>
  )
}

/** 「最多几条」的选项；任务上存的值不在选项里（助手可以设 1～20 的任意数）时也列出来，免得显示空白 */
function autoMemoryLimitItems(current: number | undefined) {
  const values = [...new Set([...AUTO_MEMORY_LIMIT_OPTIONS, ...(current ? [current] : [])])].sort((a, b) => a - b)
  return values.map((value) => ({ value: String(value), label: `最多 ${value} 条` }))
}

/** 自动挑选记忆（docs/dev/memory-retrieval.md 6.1 节）：开关 + 开着时右边「最多几条」；没设 embedding 模型时下面一行提醒 */
function AutoMemoryFields({ control }: { control: Control<TaskInput> }) {
  const [on, limit] = useWatch({ control, name: ["autoMemory", "autoMemoryLimit"] })
  const modelsQuery = useModelsQuery()
  // 模型设置取到了、默认里没有 embed 才提醒（没取到前不闪一下）
  const noEmbedModel = modelsQuery.isSuccess && !modelsQuery.data.defaults.embed
  const items = autoMemoryLimitItems(limit)
  return (
    <div className="flex flex-col gap-2">
      <Field orientation="horizontal">
        <Controller
          control={control}
          name="autoMemory"
          render={({ field }) => <Switch id="task-autoMemory" checked={!!field.value} onCheckedChange={(next) => field.onChange(Boolean(next))} />}
        />
        {/* 「?」放在 label 里：点 label 里的按钮不会切换开关 */}
        <FieldLabel htmlFor="task-autoMemory" className="items-center gap-1">
          自动挑选记忆
          <HelpTip>运行开始时按任务标题、目标、步骤和这次的说明，从记忆库里再挑几条相关的给 agent。手选的一定会给。来自网页、没核实的记忆不会被自动挑。</HelpTip>
        </FieldLabel>
        {on && (
          <Controller
            control={control}
            name="autoMemoryLimit"
            render={({ field }) => (
              <Select items={items} value={String(field.value ?? AUTO_MEMORY_LIMIT_DEFAULT)} onValueChange={(value) => value && field.onChange(Number(value))}>
                <SelectTrigger id="task-autoMemoryLimit" size="sm" aria-label="自动挑的最多几条"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
                </SelectContent>
              </Select>
            )}
          />
        )}
      </Field>
      {on && noEmbedModel && <FieldDescription>还没设 embedding 模型，开着也不会挑（模型页 → 默认设置）</FieldDescription>}
    </div>
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
    resolver: taskResolver,
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
          allowBrowserVision: task.allowBrowserVision,
          allowBrowserFetch: task.allowBrowserFetch,
          desktopIds: task.desktopIds,
          allowDesktopVision: task.allowDesktopVision,
          verifyModelId: task.verifyModelId ?? "",
          // 复核模型必填（2026-10-20）：以前没选的旧任务先填上默认复核模型
          reviewModelId: task.reviewModelId ?? defaults.review ?? "",
          dispatch: task.dispatch ? { ...task.dispatch, ...retriesOf(task.dispatch) } : null,
          dispatchFrom: task.dispatchFrom,
          cronSkipIfRunning: task.cronSkipIfRunning,
          // 后端还没带这两项时（undefined）按没单独设、要试跑
          autoSolidify: task.autoSolidify ?? null,
          routineSkipTest: task.routineSkipTest ?? false,
          // 自动挑选记忆（docs/dev/memory-retrieval.md 第 4 节）：改任务时带上原来的值（不带会变回默认的「开」）
          autoMemory: task.autoMemory ?? false,
          autoMemoryLimit: task.autoMemoryLimit ?? AUTO_MEMORY_LIMIT_DEFAULT,
          // 子 agent 用的模型（docs/dev/sub-agents.md 11.3）：改任务时带上原来的值（不带会被清空）；空 = 和执行模型一样
          subagentModelId: task.subagentModelId ?? "",
        }
      : {
          title: "", goal: "", steps: [{ text: "", wait: false }], modelId: defaults.run, ownerId: user.id, schedule: null, enabled: true,
          memoryIds: [], skillIds: [], toolIds: [], ruleIds: [], browserProfileIds: [], allowedDomains: [], allowBrowserEvaluate: false, allowBrowserVision: false, allowBrowserFetch: false, desktopIds: [], allowDesktopVision: false, verifyModelId: "",
          reviewModelId: defaults.review ?? "",
          dispatch: null, dispatchFrom: [], cronSkipIfRunning: true,
          autoSolidify: null, routineSkipTest: false,
          autoMemory: AUTO_MEMORY_DEFAULT, autoMemoryLimit: AUTO_MEMORY_LIMIT_DEFAULT,
          subagentModelId: "",
        },
  })
  // 网址白名单在表单里是一段文字（每行一个），提交时拆成数组
  const [domainText, setDomainText] = React.useState(() => domainsText(task?.allowedDomains ?? []))
  const { errors } = form.formState
  const steps = useFieldArray({ control: form.control, name: "steps" })
  const [modelId, schedule, memoryIds, skillIds, toolIds, ruleIds, verifyModelId, dispatch] = useWatch({ control: form.control, name: ["modelId", "schedule", "memoryIds", "skillIds", "toolIds", "ruleIds", "verifyModelId", "dispatch"] })
  const allTasks = useTasksQuery().data ?? []
  // 「谁能派活给它」：系统里的其他任务
  const clip = (title: string) => (title.length > 12 ? `${title.slice(0, 12)}…` : title)
  const fromOptions = allTasks.filter((each) => each.id !== task?.id).map((each) => ({
    value: each.id,
    label: `${each.id} ${clip(each.title)}`,
    hint: each.toolIds.includes(WORK_DISPATCH_TOOL_ID) ? "已选了内置工具「派活」" : "还没选内置工具「派活」，选上才能派",
  }))
  // 选了内置工具「派活」：能派给谁（被派的任务在「谁能派活给它」里加了它才行）
  const dispatchTargets = task ? allTasks.filter((each) => each.dispatch && each.dispatchFrom.includes(task.id)) : []
  const toolNotes = (toolIds ?? []).includes(WORK_DISPATCH_TOOL_ID)
    ? [dispatchTargets.length
        ? `「派活」：可以派给 ${dispatchTargets.map((each) => `${each.id}「${each.title}」（参数 ${each.dispatch!.params.map((p) => p.name).join("、") || "没有"}）`).join("；")}`
        : `「派活」：还没有任务允许它派活。去要接活的任务上打开「可以被派活」，把${task ? "它" : "这个任务（建好以后）"}加进「谁能派活给它」。`]
    : undefined
  const usesBrowser = (toolIds ?? []).includes(BROWSER_TOOL_ID)
  const usesDesktop = (toolIds ?? []).includes(DESKTOP_TOOL_ID)
  const usesSubagents = (toolIds ?? []).includes(SUBAGENT_START_TOOL_ID)
  const options = usePickOptions({ memoryIds: memoryIds ?? [], skillIds: skillIds ?? [] }, task?.ruleIds ?? [])
  const rules = useRulesQuery().data ?? []
  // 选着的规则里没生效 / 改过还没确认的：写清楚运行时会怎样
  const ruleNotes = (ruleIds ?? []).flatMap((id) => {
    const rule = rules.find((each) => each.id === id)
    const hint = rule && ruleHint(rule)
    return rule && hint ? [`「${rule.name}」${ruleSelectable(rule) ? hint : `${hint}。这次保存会留着它，但运行时不执行`}`] : []
  })
  // 选了「交给三方验收」的规则：结果按验收定，复核不起作用
  const verifyRule = (ruleIds ?? []).map((id) => rules.find((each) => each.id === id)).find((rule) => rule && ruleVerifies(rule))
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
      // 空 = 和执行模型一样
      subagentModelId: values.subagentModelId || undefined,
      schedule: values.schedule ? { cron: values.schedule.cron.trim(), text: cronText(values.schedule.cron) ?? values.schedule.cron.trim() } : null,
      // 不能被派活时，「谁能派活给它」留着也没用，一起清掉
      dispatchFrom: values.dispatch ? values.dispatchFrom : [],
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
      // 能被派活的任务建好不马上跑：有派活单才跑
      const started = startAfter && !input.dispatch ? await runNow.submit({ taskId: created.id }) : undefined
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
                <Textarea id="task-goal" rows={3} placeholder={PLACEHOLDER.goal} aria-invalid={!!errors.goal} {...form.register("goal")} />
                <FieldDescription>做到什么算完成。必填，三方验收按它判断。</FieldDescription>
                <FieldError errors={[errors.goal]} />
              </Field>
              <FieldSeparator />
              <FieldSet>
                <FieldLegend variant="label">用哪些</FieldLegend>
                <FieldDescription>agent 只能用这里选的。规则没有默认的，要手动选。</FieldDescription>
                <div className="grid gap-4 sm:grid-cols-2">
                  {PICK_KEYS.map((key) => {
                    const pick = (
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
                            notes={key === "ruleIds" ? ruleNotes : key === "toolIds" ? toolNotes : undefined}
                          />
                        )}
                      />
                    )
                    // 记忆下面紧跟「自动挑选记忆」，放在同一格里
                    return key === "memoryIds" ? (
                      <div key={key} className="flex flex-col gap-3">
                        {pick}
                        <AutoMemoryFields control={form.control} />
                      </div>
                    ) : pick
                  })}
                  {usesBrowser && (
                    <BrowserFields control={form.control} subagents={usesSubagents} domainText={domainText} domainError={errors.allowedDomains?.message} onDomainText={(text) => {
                      setDomainText(text)
                      form.clearErrors("allowedDomains")
                    }} />
                  )}
                  {usesDesktop && <DesktopFields control={form.control} />}
                  <SolidifyFields control={form.control} autoDefault={autoSolidifyDefault({ dispatch, schedule })} />
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
                  {usesSubagents && (
                    <Field data-invalid={!!errors.subagentModelId} className="sm:col-span-2">
                      <FieldLabel htmlFor="task-subagentModel">子 agent 用的模型</FieldLabel>
                      <Controller
                        control={form.control}
                        name="subagentModelId"
                        render={({ field }) => (
                          <ModelCombobox id="task-subagentModel" className="w-full sm:w-1/2" models={models} value={field.value ?? ""} onValueChange={field.onChange} clearable aria-invalid={!!errors.subagentModelId}
                            placeholder={effectiveModel ? `和执行模型一样：${modelName(effectiveModel)}` : "和执行模型一样"} />
                        )}
                      />
                      <FieldDescription>拆出去的子 agent 用这个模型；可以选便宜些的，父 agent 用执行模型来拆、核对和汇总。不选就和执行模型一样。</FieldDescription>
                      <FieldError errors={[errors.subagentModelId]} />
                    </Field>
                  )}
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
              <FieldSet>
                <FieldLegend variant="label" className="flex items-center gap-1">
                  完成
                  <HelpTip>运行结束时 agent 要报结果：办成还是没办成。只看任务目标要的东西拿没拿到，只拿到一部分也算没办成。检查点没达成或有跳过、缺了要交回的结果，直接记没办成；agent 说办成了，再由三方验收或 AI 复核核一遍，证据不足也记没办成。</HelpTip>
                </FieldLegend>
                <div className="grid gap-4 sm:grid-cols-2">
                <Field data-invalid={!!modelClash}>
                  <FieldLabel htmlFor="task-verifyModel">三方验收模型</FieldLabel>
                  <Controller
                    control={form.control}
                    name="verifyModelId"
                    render={({ field }) => (
                      <ModelCombobox id="task-verifyModel" className="w-full" models={models} value={field.value ?? ""} onValueChange={field.onChange} clearable aria-invalid={!!modelClash}
                        placeholder={defaults.verify ? `默认：${modelName(defaults.verify)}` : "搜模型名"} />
                    )}
                  />
                  <FieldDescription>任务选了「交给三方验收」的规则时，agent 说做完了由它逐条核对检查点。不能和执行模型同一家；不选就用「模型」页的默认验收模型。</FieldDescription>
                  {modelClash && <FieldError>{modelClash}</FieldError>}
                </Field>
                <Field data-invalid={!!errors.reviewModelId}>
                  <FieldLabel htmlFor="task-reviewModel" className="flex items-center gap-1">
                    复核模型
                    <HelpTip>运行结束后一定由 AI 复核：用便宜的模型看一遍目标、检查点、agent 的报告、最后几步和最后一张截图，复核也判办成才算办成，证据不足、复核出错都记没办成。每次不到 0.001 美元，记在这次运行上。</HelpTip>
                  </FieldLabel>
                  <Controller
                    control={form.control}
                    name="reviewModelId"
                    render={({ field }) => (
                      <ModelCombobox id="task-reviewModel" className="w-full" models={models} value={field.value ?? ""} onValueChange={field.onChange} aria-invalid={!!errors.reviewModelId}
                        placeholder="搜模型名" />
                    )}
                  />
                  <FieldDescription>
                    {verifyRule ? `必填。选了规则「${verifyRule.name}」：三方验收通过的直接记办成，不再复核。` : "必填。新任务先填上「模型」页的默认复核模型，可以换。"}
                  </FieldDescription>
                  <FieldError errors={[errors.reviewModelId]} />
                </Field>
                </div>
              </FieldSet>
              <FieldSeparator />
              <DispatchFields id="task-dispatch" control={form.control} register={form.register} errors={errors} fromOptions={fromOptions} />
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
                    {dispatch && <FieldDescription>能被派活的任务一般不用定时：有单就会开始，没单不跑。</FieldDescription>}
                    <FieldError errors={[errors.schedule?.cron]} />
                  </Field>
                ) : (
                  <FieldDescription>{dispatch ? "不定时：有派活单就开始，没单不跑。" : "不勾就只在点「立即运行」时跑。"}</FieldDescription>
                )}
                {schedule && (
                  <Controller
                    control={form.control}
                    name="cronSkipIfRunning"
                    render={({ field }) => (
                      <Field orientation="horizontal">
                        <Checkbox id="task-cronSkip" checked={field.value ?? true} onCheckedChange={(on) => field.onChange(Boolean(on))} />
                        <FieldContent>
                          <FieldLabel htmlFor="task-cronSkip">上一次还没跑完就跳过</FieldLabel>
                          <FieldDescription>到点时上一次运行还在执行中或验收中，这次就不开；挂起等待的不算没跑完。不勾就照样再开一次。</FieldDescription>
                        </FieldContent>
                      </Field>
                    )}
                  />
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
                {dispatch ? (
                  // 能被派活的任务建好不马上跑，没有「创建并启动」
                  <Button type="submit" disabled={pending}>
                    {pending && <Spinner data-icon="inline-start" />}创建
                  </Button>
                ) : (
                  <>
                    <Button type="button" variant="outline" disabled={pending} onClick={() => void submitWith(false)()}>只创建</Button>
                    <Button type="submit" disabled={pending}>
                      {pending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}创建并启动
                    </Button>
                  </>
                )}
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
