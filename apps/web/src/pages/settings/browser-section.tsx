// 「浏览器」分区（M2）：每个 worker 同时最多开几个 Chrome、遇到验证码时 Chrome 保留多久、拿不准时要不要让视觉模型看截图。
// 表单：React Hook Form + shared 的 settingsBrowserInputSchema；worker 每次用到时重新读，保存后马上生效。
import { zodResolver } from "@hookform/resolvers/zod"
import { SaveIcon } from "lucide-react"
import { Controller, useForm, type FieldError as FormFieldError } from "react-hook-form"
import { settingsBrowserInputSchema, type SettingsBrowserInput } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

/** 数字框清空时 zod 报的是英文的类型错误，换成一句人话 */
const numberError = (error?: FormFieldError) => (error?.type === "invalid_type" ? { message: "填一个整数" } : error)

const NUMBERS: { name: "maxPerWorker" | "humanHoldMinutes"; label: string; unit: string; hint: string }[] = [
  {
    name: "maxPerWorker",
    label: "每个 worker 同时最多开几个 Chrome",
    unit: "个",
    hint: "每个 Chrome 大约要 1 核 CPU、几百 MB 内存。满了以后，要用浏览器的运行排队，显示「等待浏览器」。",
  },
  {
    name: "humanHoldMinutes",
    label: "遇到验证码时 Chrome 保留多久",
    unit: "分钟",
    hint: "这段时间里人在远程画面里处理完，agent 用同一个 Chrome 接着做；过了时间就写回登录态、关掉 Chrome，人处理时再新开一个。",
  },
]

export function BrowserSection({ values }: { values: SettingsBrowserInput }) {
  const form = useForm<SettingsBrowserInput>({ resolver: zodResolver(settingsBrowserInputSchema), defaultValues: values })
  const { errors, isDirty } = form.formState
  const save = useAction(trpc.settings.updateBrowser.mutationOptions(), { success: "浏览器设置已保存" })

  const submit = form.handleSubmit(async (next) => {
    if (await save.submit(next)) form.reset(next)
  })

  return (
    <DetailSection title="浏览器" description="服务器上的 Chrome 开多少、等人处理验证码时留多久。">
      <form onSubmit={submit} className="flex flex-col gap-4">
        <FieldGroup>
          {NUMBERS.map((item) => {
            const error = numberError(errors[item.name])
            const id = `browser-${item.name}`
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
          <Controller
            control={form.control}
            name="visionCheck"
            render={({ field }) => (
              <Field orientation="horizontal">
                <Switch id="browser-visionCheck" checked={field.value} onCheckedChange={(on) => field.onChange(Boolean(on))} />
                <FieldContent>
                  <FieldLabel htmlFor="browser-visionCheck">拿不准时让视觉模型看截图</FieldLabel>
                  <FieldDescription>
                    每次操作网页后先按规则判断是不是验证码页、登录页；规则拿不准时，把截图交给便宜的视觉模型再判断一次（每次花一点钱）。只检测，不破解。
                  </FieldDescription>
                </FieldContent>
              </Field>
            )}
          />
        </FieldGroup>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!isDirty || save.isPending}>
            {save.isPending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
            保存
          </Button>
          {isDirty && (
            <Button type="button" variant="ghost" onClick={() => form.reset(values)}>
              撤销修改
            </Button>
          )}
        </div>
      </form>
    </DetailSection>
  )
}
