// 加 / 编辑通知渠道：名字、类型（飞书 / 企业微信 / 通用 webhook）、webhook 地址、启用。
// 地址加密存在服务器上，读回来只有掩码；编辑时地址留空表示不改。表单：shared 的 notifyChannelInputSchema。
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { notifyChannelInputSchema, type NotifyChannelInput, type SettingsView } from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

export type Channel = SettingsView["channels"][number]
type Kind = Channel["kind"]

export const KIND_LABEL: Record<Kind, string> = { feishu: "飞书", wecom: "企业微信", webhook: "通用 webhook" }
const KIND_HINT: Record<Kind, string> = {
  feishu: "飞书群里加一个「自定义机器人」，把它给的 webhook 地址贴进来。",
  wecom: "企业微信群里加一个「群机器人」，把它给的 webhook 地址贴进来。",
  webhook: "任意能接收 POST 请求的地址，通知内容以 JSON 发过去。",
}

export function ChannelDialog({ channel, onClose }: { channel?: Channel; onClose: () => void }) {
  const form = useForm<NotifyChannelInput>({
    resolver: zodResolver(notifyChannelInputSchema),
    defaultValues: { id: channel?.id, name: channel?.name ?? "", kind: channel?.kind ?? "feishu", url: "", enabled: channel?.enabled ?? true },
  })
  const { errors } = form.formState
  const save = useAction(trpc.settings.saveChannel.mutationOptions(), { success: channel ? "渠道已保存" : "渠道加好了" })

  const submit = form.handleSubmit(async (values) => {
    // 新加的渠道必须填地址（后端也会拦）；编辑时留空 = 不改
    if (!channel && !values.url) {
      form.setError("url", { message: "填 webhook 地址" })
      return
    }
    if (await save.submit({ ...values, url: values.url || undefined })) onClose()
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{channel ? `编辑「${channel.name}」` : "加通知渠道"}</DialogTitle>
            <DialogDescription>agent 发通知时，除了站内通知，还会推送到启用的渠道。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="channel-name">名字</FieldLabel>
              <Input id="channel-name" autoComplete="off" placeholder="例如：项目通知群" aria-invalid={!!errors.name} {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>

            <Controller
              control={form.control}
              name="kind"
              render={({ field }) => (
                <Field>
                  <FieldLabel>类型</FieldLabel>
                  <ToggleGroup
                    variant="outline"
                    spacing={0}
                    value={[field.value]}
                    onValueChange={(next) => next[0] && field.onChange(next[0] as Kind)}
                    aria-label="类型"
                  >
                    {(Object.keys(KIND_LABEL) as Kind[]).map((kind) => (
                      <ToggleGroupItem key={kind} value={kind}>
                        {KIND_LABEL[kind]}
                      </ToggleGroupItem>
                    ))}
                  </ToggleGroup>
                  <FieldDescription>{KIND_HINT[field.value]}</FieldDescription>
                </Field>
              )}
            />

            <Field data-invalid={!!errors.url}>
              <FieldLabel htmlFor="channel-url">webhook 地址</FieldLabel>
              <Input
                id="channel-url"
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
                placeholder={channel ? "不改就留空" : "https://…"}
                aria-invalid={!!errors.url}
                {...form.register("url")}
              />
              <FieldDescription>
                {channel?.urlMasked ? `现在的地址：${channel.urlMasked}。` : ""}地址加密保存，保存后只显示前后几位。
              </FieldDescription>
              <FieldError errors={[errors.url]} />
            </Field>

            <Controller
              control={form.control}
              name="enabled"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <FieldContent>
                    <FieldLabel htmlFor="channel-enabled">启用</FieldLabel>
                    <FieldDescription>关掉后先不往这个渠道推，配置留着。</FieldDescription>
                  </FieldContent>
                  <Switch id="channel-enabled" checked={field.value ?? true} onCheckedChange={field.onChange} />
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}
              {channel ? "保存" : "加渠道"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
