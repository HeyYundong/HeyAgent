// 自定义服务手动加 / 改模型：模型名（调接口时传的，加好不能改）、显示名、上下文长度、能不能看图、输入 / 输出单价。
// 表单：React Hook Form + shared 的 manualModelInputSchema；编辑时提交前去掉 providerId、modelName（接口是 manualModelUpdateSchema）。
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, type FieldError as FormFieldError } from "react-hook-form"
import { manualModelInputSchema, type ManualModelInput, type ModelInfo } from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

import type { Provider } from "./data"

/** model 不传就是添加 */
type ModelDialogProps = { provider: Provider; model?: ModelInfo; onClose: () => void }

/** 数字框清空当 0（= 不知道） */
const asNumber = (value: unknown) => (value === "" || value === null || value === undefined ? 0 : Number(value))
/** 数字框里填了不是数字的东西：zod 报的是英文的类型错误，换成一句人话 */
const numberError = (error?: FormFieldError) => (error?.type === "invalid_type" ? { message: "填一个数字" } : error)

const PRICES = [
  { name: "priceIn", label: "输入单价" },
  { name: "priceOut", label: "输出单价" },
] as const

export function ModelDialog({ provider, model, onClose }: ModelDialogProps) {
  const modelName = model ? model.id.slice(provider.id.length + 1) : ""
  const form = useForm<ManualModelInput>({
    resolver: zodResolver(manualModelInputSchema),
    defaultValues: {
      providerId: provider.id,
      modelName,
      // 显示名和模型名一样时留空（不填就用模型名）
      displayName: model && model.name !== modelName ? model.name : "",
      contextK: model?.contextK ?? 0,
      vision: model?.vision ?? false,
      priceIn: model?.priceIn ?? 0,
      priceOut: model?.priceOut ?? 0,
    },
  })
  const { errors } = form.formState
  const add = useAction(trpc.models.addModel.mutationOptions(), { success: (_, vars) => `已添加模型 ${vars.modelName}` })
  const update = useAction(trpc.models.updateModel.mutationOptions(), { success: "模型已保存" })
  const pending = add.isPending || update.isPending

  const submit = form.handleSubmit(async ({ providerId, modelName: name, ...values }) => {
    const done = model ? await update.submit({ ...values, id: model.id }) : await add.submit({ ...values, providerId, modelName: name })
    if (done) onClose()
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{model ? `编辑「${model.name}」` : `给「${provider.name}」添加模型`}</DialogTitle>
            <DialogDescription>服务列表里没有、或要填单价的模型，在这里手动加。刷新模型列表时手动加的不会被删掉。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.modelName}>
              <FieldLabel htmlFor="mm-name">模型名</FieldLabel>
              <Input id="mm-name" className="font-mono" placeholder="例如 qwen3-max" disabled={!!model} aria-invalid={!!errors.modelName} {...form.register("modelName")} />
              {errors.modelName ? (
                <FieldError errors={[errors.modelName]} />
              ) : (
                <FieldDescription>{model ? "模型名不能改：任务和默认设置按它找模型，要换就删了重新加。" : "调接口时传的 model，照服务的文档原样填，大小写也要一样。"}</FieldDescription>
              )}
            </Field>
            <Field data-invalid={!!errors.displayName}>
              <FieldLabel htmlFor="mm-display">显示名</FieldLabel>
              <Input id="mm-display" placeholder="不填就用模型名" aria-invalid={!!errors.displayName} {...form.register("displayName")} />
              <FieldError errors={[errors.displayName]} />
            </Field>
            <Field data-invalid={!!errors.contextK}>
              <FieldLabel htmlFor="mm-context">上下文长度</FieldLabel>
              <InputGroup className="sm:w-48">
                <InputGroupInput id="mm-context" type="number" inputMode="numeric" step="1" min={0} aria-invalid={!!errors.contextK} {...form.register("contextK", { setValueAs: asNumber })} />
                <InputGroupAddon align="inline-end">
                  <InputGroupText>K token</InputGroupText>
                </InputGroupAddon>
              </InputGroup>
              {errors.contextK ? <FieldError errors={[numberError(errors.contextK)]} /> : <FieldDescription>0 表示不知道。</FieldDescription>}
            </Field>
            <div className="grid gap-4 sm:grid-cols-2">
              {PRICES.map((item) => {
                const error = numberError(errors[item.name])
                const id = `mm-${item.name}`
                return (
                  <Field key={item.name} data-invalid={!!error}>
                    <FieldLabel htmlFor={id}>{item.label}</FieldLabel>
                    <InputGroup>
                      <InputGroupAddon>
                        <InputGroupText>$</InputGroupText>
                      </InputGroupAddon>
                      <InputGroupInput id={id} type="number" inputMode="decimal" step="0.0001" min={0} aria-invalid={!!error} {...form.register(item.name, { setValueAs: asNumber })} />
                    </InputGroup>
                    <FieldError errors={[error]} />
                  </Field>
                )
              })}
            </div>
            <FieldDescription>单价是每百万 token 多少美元，按人民币计价的服务自己换算一下。都填 0 显示「未知」：花费按 0 算，花费上限管不住。</FieldDescription>
            <Controller
              control={form.control}
              name="vision"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="mm-vision">能看图</FieldLabel>
                    <FieldDescription>能看截图、图片的模型才打开，比物、浏览器看画面都要用。</FieldDescription>
                  </FieldContent>
                  <Switch id="mm-vision" checked={field.value} onCheckedChange={field.onChange} />
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {model ? "保存" : "添加"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
