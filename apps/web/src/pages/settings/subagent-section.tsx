// 「子 agent」分区（docs/dev/sub-agents.md 6.1、11.4）：每次运行同时几个、一共几个，全系统同时几个，每个子 agent 的花费、步数上限。
// 表单：React Hook Form + shared 的 settingsSubagentInputSchema；保存调 settings.updateSubagent（后端改完会重新放行排队的子 agent）。照 dispatch-section.tsx 的写法。
import { zodResolver } from "@hookform/resolvers/zod"
import { SaveIcon } from "lucide-react"
import { useForm, type FieldError as FormFieldError } from "react-hook-form"
import { SETTINGS_DEFAULTS, settingsSubagentInputSchema, type SettingsSubagentInput } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

/** 数字框清空时 zod 报的是英文的类型错误，换成一句人话 */
const numberError = (error?: FormFieldError) => (error?.type === "invalid_type" ? { message: "填一个数字" } : error)

const SUBAGENT_DEFAULTS: SettingsSubagentInput = {
  maxParallel: SETTINGS_DEFAULTS.subagentMaxParallel,
  maxPerRun: SETTINGS_DEFAULTS.subagentMaxPerRun,
  maxRunningGlobal: SETTINGS_DEFAULTS.subagentMaxRunningGlobal,
  maxCostUsd: SETTINGS_DEFAULTS.subagentMaxCostUsd,
  maxSteps: SETTINGS_DEFAULTS.subagentMaxSteps,
}

const FIELDS: { name: keyof SettingsSubagentInput; label: string; unit: string; step: string; hint: string }[] = [
  {
    name: "maxParallel",
    label: "每次运行同时最多几个",
    unit: "个",
    step: "1",
    hint: `多的排队，前面的做完自动开始。等浏览器、等桌面的也占名额，等人处理的不占。默认 ${SETTINGS_DEFAULTS.subagentMaxParallel}。`,
  },
  {
    name: "maxPerRun",
    label: "每次运行一共最多拆几个",
    unit: "个",
    step: "1",
    hint: `含补拆的，超过的整次拒绝，防 agent 一直拆。默认 ${SETTINGS_DEFAULTS.subagentMaxPerRun}。`,
  },
  {
    name: "maxRunningGlobal",
    label: "全系统同时最多几个",
    unit: "个",
    step: "1",
    hint: `几次运行同时拆时一起算，防钱一下子花出去。默认 ${SETTINGS_DEFAULTS.subagentMaxRunningGlobal}。`,
  },
  {
    name: "maxCostUsd",
    label: "每个子 agent 的花费上限",
    unit: "美元",
    step: "0.01",
    hint: `到了直接结束、记没办成，不问人；父运行拿到结果自己决定怎么办。默认 ${SETTINGS_DEFAULTS.subagentMaxCostUsd} 美元。`,
  },
  {
    name: "maxSteps",
    label: "每个子 agent 的步数上限",
    unit: "步",
    step: "1",
    hint: `同上，到了记没办成。默认 ${SETTINGS_DEFAULTS.subagentMaxSteps}。`,
  },
]

const HELP =
  "任务选了内置工具「拆给子 agent」时，agent 能把事情拆给几个子 agent 同时做。这几个上限对所有任务生效，改了以后排队的子 agent 按新上限放行。父运行的花费上限按「父 + 全部子 agent」合计算。每个子 agent 自己开 Chrome：调高「同时最多几个」时，每台 worker 的 Chrome 上限（「浏览器」一组）也要跟着调。"

export function SubagentSection({ values }: { values?: SettingsSubagentInput }) {
  const initial = values ?? SUBAGENT_DEFAULTS
  const form = useForm<SettingsSubagentInput>({ resolver: zodResolver(settingsSubagentInputSchema), defaultValues: initial })
  const { errors, isDirty } = form.formState
  const save = useAction(trpc.settings.updateSubagent.mutationOptions(), { success: "子 agent 上限已保存，排队的子 agent 按新上限放行" })

  const submit = form.handleSubmit(async (next) => {
    if (await save.submit(next)) form.reset(next)
  })

  return (
    <DetailSection title="子 agent" description={HELP}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldGroup>
          {FIELDS.map((item) => {
            const error = numberError(errors[item.name])
            const id = `subagent-${item.name}`
            return (
              <Field key={item.name} data-invalid={!!error}>
                <FieldLabel htmlFor={id}>{item.label}</FieldLabel>
                <InputGroup className="sm:w-64">
                  <InputGroupInput id={id} type="number" inputMode={item.step === "1" ? "numeric" : "decimal"} step={item.step} aria-invalid={!!error} {...form.register(item.name, { valueAsNumber: true })} />
                  <InputGroupAddon align="inline-end">
                    <InputGroupText>{item.unit}</InputGroupText>
                  </InputGroupAddon>
                </InputGroup>
                <FieldDescription>{item.hint}</FieldDescription>
                <FieldError errors={[error]} />
              </Field>
            )
          })}
        </FieldGroup>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!isDirty || save.isPending}>
            {save.isPending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
            保存
          </Button>
          {isDirty && (
            <Button type="button" variant="ghost" onClick={() => form.reset(initial)}>
              撤销修改
            </Button>
          )}
        </div>
      </form>
    </DetailSection>
  )
}
