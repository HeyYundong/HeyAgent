// 「agent」分区（M3）：三方验收最多几轮、发给模型的历史超过多少 token 就压缩上下文。
// 表单：React Hook Form + shared 的 settingsAgentInputSchema；保存调 settings.updateAgent，引擎每次用到时重新读。
import { zodResolver } from "@hookform/resolvers/zod"
import { SaveIcon } from "lucide-react"
import { useForm, type FieldError as FormFieldError } from "react-hook-form"
import { SETTINGS_DEFAULTS, settingsAgentInputSchema, type SettingsAgentInput } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

/** 数字框清空时 zod 报的是英文的类型错误，换成一句人话 */
const numberError = (error?: FormFieldError) => (error?.type === "invalid_type" ? { message: "填一个数字" } : error)

const DEFAULTS: SettingsAgentInput = { verifyMaxRounds: SETTINGS_DEFAULTS.verifyMaxRounds, compactMaxTokens: SETTINGS_DEFAULTS.compactMaxTokens }

export function AgentSection({ values }: { values?: SettingsAgentInput }) {
  const initial = values ?? DEFAULTS
  const form = useForm<SettingsAgentInput>({ resolver: zodResolver(settingsAgentInputSchema), defaultValues: initial })
  const { errors, isDirty } = form.formState
  const save = useAction(trpc.settings.updateAgent.mutationOptions(), { success: "agent 设置已保存，之后的验收和压缩按新值算" })
  const roundsError = numberError(errors.verifyMaxRounds)
  const tokensError = numberError(errors.compactMaxTokens)

  const submit = form.handleSubmit(async (next) => {
    if (await save.submit(next)) form.reset(next)
  })

  return (
    <DetailSection title="agent" description="三方验收问几轮、上下文多长就压缩。对所有任务生效，正在跑的运行下一次用到时就按新值。">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldGroup>
          <Field data-invalid={!!roundsError}>
            <FieldLabel htmlFor="agent-verifyMaxRounds">三方验收最多几轮</FieldLabel>
            <InputGroup className="sm:w-64">
              <InputGroupInput id="agent-verifyMaxRounds" type="number" inputMode="numeric" step="1" aria-invalid={!!roundsError} {...form.register("verifyMaxRounds", { valueAsNumber: true })} />
              <InputGroupAddon align="inline-end"><InputGroupText>轮</InputGroupText></InputGroupAddon>
            </InputGroup>
            <FieldDescription>
              有检查点没通过或存疑时，前几轮把问题交给执行的 agent 说明或补做；到最后一轮还说不清，就生成一件「验收争议」交给任务负责人。默认 {SETTINGS_DEFAULTS.verifyMaxRounds}：反问一次，还不行就交给人。填 1 = 不反问，直接交给人。
            </FieldDescription>
            <FieldError errors={[roundsError]} />
          </Field>
          <Field data-invalid={!!tokensError}>
            <FieldLabel htmlFor="agent-compactMaxTokens">上下文超过多少就压缩</FieldLabel>
            <InputGroup className="sm:w-64">
              <InputGroupInput id="agent-compactMaxTokens" type="number" inputMode="numeric" step="1000" aria-invalid={!!tokensError} {...form.register("compactMaxTokens", { valueAsNumber: true })} />
              <InputGroupAddon align="inline-end"><InputGroupText>token</InputGroupText></InputGroupAddon>
            </InputGroup>
            <FieldDescription>
              发给模型的历史超过这个数，就把较早的大块工具输出换成摘要（全文另存成文件，检查点、结论和人的回复保留原文）。填 0 = 只按模型上下文的 60% 算；填了数字就取两者中小的。
            </FieldDescription>
            <FieldError errors={[tokensError]} />
          </Field>
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
