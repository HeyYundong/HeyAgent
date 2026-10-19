// 「助手」分区：右下角助手一次请求（发一条消息或应用一张改动卡之后）最多几步、最多花多少美元（docs/dev/copilot.md 9.4）。
// 表单：React Hook Form + shared 的 settingsAssistantInputSchema；保存调 settings.updateAssistant，每次请求重新读。
import { zodResolver } from "@hookform/resolvers/zod"
import { SaveIcon } from "lucide-react"
import { useForm, type FieldError as FormFieldError } from "react-hook-form"
import { SETTINGS_DEFAULTS, settingsAssistantInputSchema, type SettingsAssistantInput } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

/** 数字框清空时 zod 报的是英文的类型错误，换成一句人话 */
const numberError = (error?: FormFieldError) => (error?.type === "invalid_type" ? { message: "填一个数字" } : error)

const ASSISTANT_DEFAULTS: SettingsAssistantInput = {
  maxSteps: SETTINGS_DEFAULTS.assistantMaxSteps,
  maxCostUsd: SETTINGS_DEFAULTS.assistantMaxCostUsd,
}

const FIELDS: { name: keyof SettingsAssistantInput; label: string; unit: string; step: string; inputMode: "numeric" | "decimal"; hint: string }[] = [
  {
    name: "maxSteps",
    label: "一次最多几步",
    unit: "步",
    step: "1",
    inputMode: "numeric",
    hint: `一步 = 调一次模型。到了就停下来告诉人，要继续再说一句。默认 ${SETTINGS_DEFAULTS.assistantMaxSteps}。`,
  },
  {
    name: "maxCostUsd",
    label: "一次最多花多少",
    unit: "美元",
    step: "0.01",
    inputMode: "decimal",
    hint: `一次请求累计的模型费用超过这个数就停下。默认 ${SETTINGS_DEFAULTS.assistantMaxCostUsd}。`,
  },
]

export function AssistantSection({ values }: { values?: SettingsAssistantInput }) {
  const initial = values ?? ASSISTANT_DEFAULTS
  const form = useForm<SettingsAssistantInput>({ resolver: zodResolver(settingsAssistantInputSchema), defaultValues: initial })
  const { errors, isDirty } = form.formState
  const save = useAction(trpc.settings.updateAssistant.mutationOptions(), { success: "助手上限已保存，下一次请求按新上限算" })

  const submit = form.handleSubmit(async (next) => {
    if (await save.submit(next)) form.reset(next)
  })

  return (
    <DetailSection title="助手" description="右下角的助手一次请求（发一条消息，或应用一张改动卡之后）最多走几步、花多少钱，防止它停不下来。对所有人生效。">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldGroup>
          {FIELDS.map((item) => {
            const error = numberError(errors[item.name])
            const id = `assistant-${item.name}`
            return (
              <Field key={item.name} data-invalid={!!error}>
                <FieldLabel htmlFor={id}>{item.label}</FieldLabel>
                <InputGroup className="sm:w-64">
                  <InputGroupInput id={id} type="number" inputMode={item.inputMode} step={item.step} aria-invalid={!!error} {...form.register(item.name, { valueAsNumber: true })} />
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
