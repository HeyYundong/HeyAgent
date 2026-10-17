// 「运行上限」分区：单个 session 的花费上限、最多步数、只等事件时的兜底天数。
// 表单：React Hook Form + shared 的 settingsLimitsInputSchema；改了才能点「保存」，保存后以新值为准。
import { zodResolver } from "@hookform/resolvers/zod"
import { SaveIcon } from "lucide-react"
import { useForm, type FieldError as FormFieldError } from "react-hook-form"
import { settingsLimitsInputSchema, type SettingsLimitsInput } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

/** 数字框清空时 zod 报的是英文的类型错误，换成一句人话 */
const numberError = (error?: FormFieldError) => (error?.type === "invalid_type" ? { message: "填一个数字" } : error)

const FIELDS: {
  name: keyof SettingsLimitsInput
  label: string
  unit: string
  step: string
  hint: string
}[] = [
  {
    name: "maxCostUsd",
    label: "单个 session 花费上限",
    unit: "美元",
    step: "0.01",
    hint: "一个 session 累计花的模型费用超过这个数，就生成一件「要人办的事」，session 挂起，等人决定要不要继续。",
  },
  {
    name: "maxSteps",
    label: "单个 session 最多步数",
    unit: "步",
    step: "1",
    hint: "一步 = 调一次模型。超过这个数，同样生成一件「要人办的事」，session 挂起，等人决定要不要继续。",
  },
  {
    name: "eventFallbackDays",
    label: "只等事件时的兜底天数",
    unit: "天",
    step: "1",
    hint: "挂起后只等某个外部事件、没设时间的，等满这么多天还没等到，就到期提醒负责人；不会自动继续。",
  },
]

export function LimitsSection({ limits }: { limits: SettingsLimitsInput }) {
  const form = useForm<SettingsLimitsInput>({
    resolver: zodResolver(settingsLimitsInputSchema),
    defaultValues: limits,
  })
  const { errors, isDirty } = form.formState
  const save = useAction(trpc.settings.updateLimits.mutationOptions(), { success: "运行上限已保存，之后的 session 按新上限算" })

  const submit = form.handleSubmit(async (values) => {
    // 保存成功后以新值为基准，「保存」按钮重新变灰
    if (await save.submit(values)) form.reset(values)
  })

  return (
    <DetailSection title="运行上限" description="防止 agent 跑飞：超过上限不会直接失败，而是停下来交给人决定。">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldGroup>
          {FIELDS.map((item) => {
            const error = numberError(errors[item.name])
            const id = `limit-${item.name}`
            return (
              <Field key={item.name} data-invalid={!!error}>
                <FieldLabel htmlFor={id}>{item.label}</FieldLabel>
                <InputGroup className="sm:w-64">
                  <InputGroupInput
                    id={id}
                    type="number"
                    inputMode="decimal"
                    step={item.step}
                    aria-invalid={!!error}
                    {...form.register(item.name, { valueAsNumber: true })}
                  />
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
            <Button type="button" variant="ghost" onClick={() => form.reset(limits)}>
              撤销修改
            </Button>
          )}
        </div>
      </form>
    </DetailSection>
  )
}
