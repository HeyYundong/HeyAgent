// 「派活」分区：最多几层、一次运行最多派几张、一个任务每天最多被派几张、一个任务最多排队几张（docs/dev/dispatch-p1.md 3.8 节）。
// 表单：React Hook Form + shared 的 settingsDispatchInputSchema；保存调 settings.updateDispatch，派活时每次重新读。
import { zodResolver } from "@hookform/resolvers/zod"
import { SaveIcon } from "lucide-react"
import { useForm, type FieldError as FormFieldError } from "react-hook-form"
import { SETTINGS_DEFAULTS, settingsDispatchInputSchema, type SettingsDispatchInput } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

/** 数字框清空时 zod 报的是英文的类型错误，换成一句人话 */
const numberError = (error?: FormFieldError) => (error?.type === "invalid_type" ? { message: "填一个数字" } : error)

const DISPATCH_DEFAULTS: SettingsDispatchInput = {
  maxDepth: SETTINGS_DEFAULTS.dispatchMaxDepth,
  maxPerSession: SETTINGS_DEFAULTS.dispatchMaxPerSession,
  maxPerTaskPerDay: SETTINGS_DEFAULTS.dispatchMaxPerTaskPerDay,
  maxQueued: SETTINGS_DEFAULTS.dispatchMaxQueued,
}

const FIELDS: { name: keyof SettingsDispatchInput; label: string; unit: string; hint: string }[] = [
  {
    name: "maxDepth",
    label: "最多几层",
    unit: "层",
    hint: `被派来的运行再派活算一层，超过就整次拒绝，防止任务互相派个没完。默认 ${SETTINGS_DEFAULTS.dispatchMaxDepth}。`,
  },
  {
    name: "maxPerSession",
    label: "一次运行最多派几张",
    unit: "张",
    hint: `一次运行新建的单超过这个数，多出来的被拒（同一件事已经有单的不算）。默认 ${SETTINGS_DEFAULTS.dispatchMaxPerSession}。`,
  },
  {
    name: "maxPerTaskPerDay",
    label: "一个任务每天最多被派几张",
    unit: "张",
    hint: `按上海时间算一天。超过的被拒，当天第一次超时通知被派任务的负责人。默认 ${SETTINGS_DEFAULTS.dispatchMaxPerTaskPerDay}。`,
  },
  {
    name: "maxQueued",
    label: "一个任务最多排队几张",
    unit: "张",
    hint: `排队的单超过这个数，新派的被拒，等前面的办掉再派。默认 ${SETTINGS_DEFAULTS.dispatchMaxQueued}。`,
  },
]

export function DispatchSection({ values }: { values?: SettingsDispatchInput }) {
  const initial = values ?? DISPATCH_DEFAULTS
  const form = useForm<SettingsDispatchInput>({ resolver: zodResolver(settingsDispatchInputSchema), defaultValues: initial })
  const { errors, isDirty } = form.formState
  const save = useAction(trpc.settings.updateDispatch.mutationOptions(), { success: "派活上限已保存，之后派活按新上限算" })

  const submit = form.handleSubmit(async (next) => {
    if (await save.submit(next)) form.reset(next)
  })

  return (
    <DetailSection title="派活" description="一个任务派活给另一个任务时的几道上限，防止 agent 派个没完。对所有任务生效。">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldGroup>
          {FIELDS.map((item) => {
            const error = numberError(errors[item.name])
            const id = `dispatch-${item.name}`
            return (
              <Field key={item.name} data-invalid={!!error}>
                <FieldLabel htmlFor={id}>{item.label}</FieldLabel>
                <InputGroup className="sm:w-64">
                  <InputGroupInput id={id} type="number" inputMode="numeric" step="1" aria-invalid={!!error} {...form.register(item.name, { valueAsNumber: true })} />
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
