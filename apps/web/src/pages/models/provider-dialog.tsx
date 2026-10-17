// 添加 / 编辑模型服务：类型（Ollama / OpenRouter，编辑时不能改）、地址、API Key。
// 保存前后端先真的连一次（OpenRouter 还会核对 key），连不上就报错、不保存，弹窗保持打开让人改。
// 表单：React Hook Form + shared 的 providerInputSchema；编辑时提交前去掉 kind（接口是 providerUpdateSchema）。
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch } from "react-hook-form"
import { providerInputSchema, type ModelProviderKind, type ProviderCheck, type ProviderInput } from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { DEFAULT_URL, KIND_LABEL, type Provider } from "./data"

/** provider 不传就是添加 */
type ProviderDialogProps = { provider?: Provider; onClose: () => void }

/** 成功提示：OpenRouter 只留能调工具的模型（agent 每一步都要调工具），Ollama 是全部本地模型 */
function readText(kind: ModelProviderKind, check: ProviderCheck) {
  const what = kind === "openrouter" ? "能调工具的模型" : "模型"
  return check.models !== undefined ? `读到 ${check.models} 个${what}` : check.message
}

export function ProviderDialog({ provider, onClose }: ProviderDialogProps) {
  const form = useForm<ProviderInput>({
    resolver: zodResolver(providerInputSchema),
    defaultValues: { kind: provider?.kind ?? "openrouter", baseUrl: provider?.baseUrl || DEFAULT_URL[provider?.kind ?? "openrouter"], apiKey: "" },
  })
  const { errors } = form.formState
  const kind = useWatch({ control: form.control, name: "kind" })
  const create = useAction(trpc.models.createProvider.mutationOptions(), { success: (data, vars) => `已添加，${readText(vars.kind, data.check)}` })
  const update = useAction(trpc.models.updateProvider.mutationOptions(), { success: (data) => `已保存，${readText(provider?.kind ?? "openrouter", data.check)}` })
  const pending = create.isPending || update.isPending

  const submit = form.handleSubmit(async ({ kind: picked, ...values }) => {
    const apiKey = values.apiKey?.trim() || undefined
    if (provider) {
      // 编辑：key 留空 = 不改
      if (await update.submit({ ...values, apiKey, id: provider.id })) onClose()
      return
    }
    if (picked === "openrouter" && !apiKey) {
      form.setError("apiKey", { message: "填 OpenRouter 的 API Key" })
      return
    }
    const created = await create.submit({ ...values, kind: picked, apiKey })
    if (created) {
      onClose()
      navigate("models", { id: created.id })
    }
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{provider ? `编辑「${provider.name}」` : "添加模型服务"}</DialogTitle>
            <DialogDescription>保存前会先连一次，读出这家能用的模型；连不上或 Key 不对会告诉你原因。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field>
              <FieldLabel>类型</FieldLabel>
              <Controller
                control={form.control}
                name="kind"
                render={({ field }) => (
                  <ToggleGroup variant="outline" spacing={0} disabled={!!provider} value={[field.value]}
                    onValueChange={(next) => {
                      const picked = next[0] as ModelProviderKind | undefined
                      if (!picked) return
                      field.onChange(picked)
                      form.setValue("baseUrl", DEFAULT_URL[picked])
                      form.clearErrors()
                    }}>
                    {(["ollama", "openrouter"] as const).map((k) => <ToggleGroupItem key={k} value={k}>{KIND_LABEL[k]}</ToggleGroupItem>)}
                  </ToggleGroup>
                )}
              />
              <FieldDescription>
                {kind === "ollama" ? "公司自己机器上跑的开源模型，免费，数据不出内网。" : "一个 Key 用上 Claude 等云端模型，按 token 付费。"}
                {provider && " 类型不能改，要换类型就新加一个服务。"}
              </FieldDescription>
            </Field>
            <Field data-invalid={!!errors.baseUrl}>
              <FieldLabel htmlFor="mp-url">地址</FieldLabel>
              <Input id="mp-url" aria-invalid={!!errors.baseUrl} {...form.register("baseUrl")} />
              <FieldError errors={[errors.baseUrl]} />
            </Field>
            {kind === "openrouter" ? (
              <Field data-invalid={!!errors.apiKey}>
                <FieldLabel htmlFor="mp-key">API Key</FieldLabel>
                <Input id="mp-key" type="password" autoComplete="off" placeholder={provider ? "不改就留空" : "sk-or-v1-…"} aria-invalid={!!errors.apiKey} {...form.register("apiKey")} />
                {errors.apiKey ? <FieldError errors={[errors.apiKey]} /> : <FieldDescription>保存后只显示前后几位。</FieldDescription>}
              </Field>
            ) : (
              <FieldDescription>Ollama 不需要 API Key。</FieldDescription>
            )}
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {provider ? "测试并保存" : "连接并添加"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
