// 给某个 Chrome 加一个要登录的平台账号（只有主管）：平台（选已有的或输入新名字）、账号、并发上限、登录探测网址、要不要连 IndexedDB 一起存。
// 表单：React Hook Form + shared 的 browserAccountInputSchema。表单里 platformId 先放平台「名字」，
// 提交时换成真正的 id：平台表里有就用它的 id，没有就先调 platforms.create 新建平台。
// 新账号的状态是「要登录」：M2 起在远程画面里登录一次，登录态进保险箱后 agent 才能用。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { browserAccountInputSchema, type BrowserAccountInput } from "@heyagent/shared"

import { CreatableCombobox } from "@/components/shell/creatable-combobox"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { usePlatformsQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

import { MAX_ITEMS, type Chrome } from "./data"

type AccountDialogProps = { profile: Chrome; onClose: () => void }

export function AccountDialog({ profile, onClose }: AccountDialogProps) {
  const platforms = usePlatformsQuery().data ?? []
  // 刚输入的新平台名，还没建到平台表里，先放在下拉选项里
  const [typedNames, setTypedNames] = React.useState<string[]>([])
  const form = useForm<BrowserAccountInput>({
    resolver: zodResolver(browserAccountInputSchema),
    defaultValues: { profileId: profile.id, platformId: "", account: "", maxConcurrent: 1, probeUrl: "", saveIndexedDb: false },
  })
  const { errors } = form.formState
  const createPlatform = useAction(trpc.platforms.create.mutationOptions())
  const createAccount = useAction(trpc.browsers.createAccount.mutationOptions(), {
    success: "账号加好了，状态是「要登录」。M2 起在远程画面里登录一次，agent 就能带着登录态用它",
  })
  const pending = createPlatform.isPending || createAccount.isPending

  const submit = form.handleSubmit(async (values) => {
    const name = values.platformId.trim()
    let platformId = platforms.find((platform) => platform.name === name)?.id
    if (!platformId) {
      // 平台表里没有：先建平台。建好了但账号没建成也没关系，下次直接能选到这个平台
      const created = await createPlatform.submit({ name })
      if (!created) return
      platformId = created.id
    }
    if (await createAccount.submit({ ...values, platformId })) onClose()
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>给「{profile.name}」加账号</DialogTitle>
            <DialogDescription>同一个平台可以加多个账号，并发上限按账号算。加好后要有人在远程画面里登录一次（M2 接通）。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.platformId}>
              <FieldLabel htmlFor="acc-platform">平台</FieldLabel>
              <Controller
                control={form.control}
                name="platformId"
                render={({ field }) => (
                  <CreatableCombobox id="acc-platform" value={field.value} onValueChange={field.onChange} aria-invalid={!!errors.platformId}
                    options={[...platforms.map((platform) => platform.name), ...typedNames]}
                    onCreate={(name) => setTypedNames([...typedNames, name])}
                    placeholder={platforms.length ? "选已有平台，或输入新平台名" : "输入平台（网站）名，例如「示例商城」"} />
                )}
              />
              <FieldDescription>没有的平台直接输入名字，保存时一起建好。</FieldDescription>
              <FieldError errors={[errors.platformId]} />
            </Field>
            <Field data-invalid={!!errors.account}>
              <FieldLabel htmlFor="acc-account">账号</FieldLabel>
              <Input id="acc-account" placeholder="例如：店铺后台（美国站）" autoComplete="off" aria-invalid={!!errors.account} {...form.register("account")} />
              <FieldDescription>写人能认出来的名字就行，不用填密码。</FieldDescription>
              <FieldError errors={[errors.account]} />
            </Field>
            <Field data-invalid={!!errors.maxConcurrent}>
              <FieldLabel>这个账号同时最多几个 session</FieldLabel>
              <Controller
                control={form.control}
                name="maxConcurrent"
                render={({ field }) => (
                  <ToggleGroup variant="outline" spacing={0} value={[String(field.value ?? 1)]} onValueChange={(next) => next[0] && field.onChange(Number(next[0]))}>
                    {MAX_ITEMS.map((n) => <ToggleGroupItem key={n} value={n}>{n}</ToggleGroupItem>)}
                  </ToggleGroup>
                )}
              />
              <FieldDescription>同一个账号在多处同时登录容易触发风控，风控严的网站建议 1 个。以后可以在账号的「⋯」里改。</FieldDescription>
              <FieldError errors={[errors.maxConcurrent]} />
            </Field>
            <Field data-invalid={!!errors.probeUrl}>
              <FieldLabel htmlFor="acc-probe">登录网址（可选）</FieldLabel>
              <Input id="acc-probe" placeholder="https://example.com/login" aria-invalid={!!errors.probeUrl} {...form.register("probeUrl")} />
              <FieldDescription>「去登录」时远程画面先打开这里；也用它检查登录态还在不在。</FieldDescription>
              <FieldError errors={[errors.probeUrl]} />
            </Field>
            <Controller
              control={form.control}
              name="saveIndexedDb"
              render={({ field }) => (
                <Field orientation="horizontal">
                  <Checkbox id="acc-idb" checked={!!field.value} onCheckedChange={field.onChange} />
                  <FieldContent>
                    <FieldLabel htmlFor="acc-idb">连 IndexedDB 一起存</FieldLabel>
                    <FieldDescription>有的网站把登录态存在 IndexedDB 里，只存 cookie 会掉登录。不确定就先不勾。</FieldDescription>
                  </FieldContent>
                </Field>
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              加账号
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
