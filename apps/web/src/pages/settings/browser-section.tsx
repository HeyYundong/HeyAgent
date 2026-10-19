// 「浏览器」分区（M2）：每个 worker 同时最多开几个 Chrome、遇到验证码时 Chrome 保留多久、视觉模型（只列能看图的，和比物同一个列表）、
// 遇到验证码先自己试着过、拿不准时要不要让视觉模型看截图。
// 表单：React Hook Form + shared 的 settingsBrowserInputSchema；worker 每次用到时重新读，保存后马上生效。
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery } from "@tanstack/react-query"
import { SaveIcon } from "lucide-react"
import { Controller, useForm, type FieldError as FormFieldError } from "react-hook-form"
import { settingsBrowserInputSchema, type SettingsBrowserInput } from "@heyagent/shared"

import { ModelCombobox } from "@/components/shell/model-combobox"
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

const SWITCHES: { name: "captchaSolve" | "visionCheck"; label: string; hint: string }[] = [
  {
    name: "captchaSolve",
    label: "遇到验证码先自己试着过",
    hint: "所有网站都一样。图片里的字母数字、「我不是机器人」这类点一下的，让上面的视觉模型认出来、填好提交，每个页面最多试 3 次（每次花一点钱）；滑块、拼图、短信验证码，reCAPTCHA、Cloudflare 这类第三方人机验证，或者试完还没过，交给负责人在远程画面里处理。关掉后 agent 也没有「填验证码」工具。",
  },
  {
    name: "visionCheck",
    label: "拿不准时让视觉模型看截图",
    hint: "每次操作网页后先按规则判断是不是验证码页、登录页；规则拿不准时，把截图交给上面的视觉模型再判断一次（每次花一点钱）。",
  },
]

export function BrowserSection({ values }: { values: SettingsBrowserInput }) {
  const form = useForm<SettingsBrowserInput>({ resolver: zodResolver(settingsBrowserInputSchema), defaultValues: values })
  const modelsQuery = useQuery({ ...trpc.compare.models.queryOptions(), retry: false })
  const models = (modelsQuery.data ?? []).map((model) => ({ ...model, note: "", contextK: 0, vision: true }))
  const { errors, isDirty } = form.formState
  const save = useAction(trpc.settings.updateBrowser.mutationOptions(), { success: "浏览器设置已保存" })

  const submit = form.handleSubmit(async (next) => {
    if (await save.submit(next)) form.reset(next)
  })

  return (
    <DetailSection title="浏览器" description="服务器上的 Chrome 开多少、验证码怎么过、等人处理时留多久。">
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
            name="visionModel"
            render={({ field }) => (
              <Field data-invalid={!!errors.visionModel}>
                <FieldLabel htmlFor="browser-visionModel">视觉模型</FieldLabel>
                <ModelCombobox
                  id="browser-visionModel"
                  className="w-full sm:w-96"
                  models={models}
                  value={field.value}
                  onValueChange={field.onChange}
                  aria-invalid={!!errors.visionModel}
                  placeholder={modelsQuery.isPending ? "正在取模型列表" : models.length ? "搜模型名" : "还没有能看图的模型：先去「模型」页接入"}
                />
                <FieldDescription>{modelsQuery.isError ? "视觉模型列表没取到。" : "过验证码、拿不准时看截图都用它。只列能看图的模型，便宜的在前。"}</FieldDescription>
                <FieldError errors={[errors.visionModel]} />
              </Field>
            )}
          />
          {SWITCHES.map((item) => (
            <Controller
              key={item.name}
              control={form.control}
              name={item.name}
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Switch id={`browser-${item.name}`} checked={field.value} onCheckedChange={(on) => field.onChange(Boolean(on))} />
                  <FieldContent>
                    <FieldLabel htmlFor={`browser-${item.name}`}>{item.label}</FieldLabel>
                    <FieldDescription>{item.hint}</FieldDescription>
                  </FieldContent>
                </Field>
              )}
            />
          ))}
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
