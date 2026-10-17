// 给某个 Chrome 加 / 编辑一个要登录的平台账号（只有主管）：平台（选已有的或输入新名字）、账号、密码、登录网址、并发上限、
// 要不要连 IndexedDB 一起存。传了 site 就是编辑（平台不能改）。
// 表单：React Hook Form + shared 的 browserAccountInputSchema。表单里 platformId 先放平台「名字」，
// 提交时换成真正的 id：平台表里有就用它的 id，没有就先调 platforms.create 新建平台。新平台可以顺手填域名。
// 密码只进不出：编辑时留空 = 不改，勾「去掉已存的密码」才删。存了密码能「立刻登录」，运行中遇到登录页 agent 也自己登录。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch } from "react-hook-form"
import { browserAccountInputSchema, type BrowserAccountInput, type BrowserSite } from "@heyagent/shared"

import { CreatableCombobox } from "@/components/shell/creatable-combobox"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { usePlatformsQuery } from "@/lib/data"
import { invalidDomainsMessage, parseDomains } from "@/lib/domains"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

import { MAX_ITEMS, type Chrome } from "./data"

/** site 不传就是新建 */
type AccountDialogProps = { profile: Chrome; site?: BrowserSite; onClose: () => void }

export function AccountDialog({ profile, site, onClose }: AccountDialogProps) {
  const platforms = usePlatformsQuery().data ?? []
  const editPlatformName = site ? (platforms.find((platform) => platform.id === site.platformId)?.name ?? site.platformId) : ""
  const [clearPassword, setClearPassword] = React.useState(false)
  // 刚输入的新平台名，还没建到平台表里，先放在下拉选项里
  const [typedNames, setTypedNames] = React.useState<string[]>([])
  // 新平台的域名（只在平台表里还没有这个平台时显示、提交）
  const [domainText, setDomainText] = React.useState("")
  const [domainError, setDomainError] = React.useState<string>()
  const form = useForm<BrowserAccountInput>({
    resolver: zodResolver(browserAccountInputSchema),
    defaultValues: site
      ? { profileId: profile.id, platformId: editPlatformName || site.platformId, account: site.account, password: "", maxConcurrent: site.maxConcurrent, probeUrl: site.probeUrl ?? "", saveIndexedDb: Boolean(site.saveIndexedDb) }
      : { profileId: profile.id, platformId: "", account: "", password: "", maxConcurrent: 1, probeUrl: "", saveIndexedDb: false },
  })
  const { errors } = form.formState
  const createPlatform = useAction(trpc.platforms.create.mutationOptions())
  const createAccount = useAction(trpc.browsers.createAccount.mutationOptions(), {
    success: (_data, vars) => (vars.password ? "账号加好了。点「立刻登录」让 agent 用这个密码登录一次" : "账号加好了。点「人工登录」在远程画面里登录一次"),
  })
  const updateAccount = useAction(trpc.browsers.updateAccount.mutationOptions(), { success: "账号已保存" })
  const pending = createPlatform.isPending || createAccount.isPending || updateAccount.isPending
  const typedPlatform = (useWatch({ control: form.control, name: "platformId" }) ?? "").trim()
  const isNewPlatform = !site && Boolean(typedPlatform) && !platforms.some((platform) => platform.name === typedPlatform)

  const submit = form.handleSubmit(async (values) => {
    if (site) {
      const saved = await updateAccount.submit({
        id: site.accountId,
        account: values.account,
        ...(values.password ? { password: values.password } : clearPassword ? { clearPassword: true } : {}),
        maxConcurrent: values.maxConcurrent,
        probeUrl: values.probeUrl ?? "",
        saveIndexedDb: values.saveIndexedDb,
      })
      if (saved) onClose()
      return
    }
    const name = values.platformId.trim()
    let platformId = platforms.find((platform) => platform.name === name)?.id
    if (!platformId) {
      const { domains, invalid } = parseDomains(domainText)
      if (invalid.length) {
        setDomainError(invalidDomainsMessage(invalid))
        return
      }
      setDomainError(undefined)
      // 平台表里没有：先建平台。建好了但账号没建成也没关系，下次直接能选到这个平台
      const created = await createPlatform.submit({ name, domains })
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
            <DialogTitle>{site ? `编辑账号：${editPlatformName}` : `给「${profile.name}」加账号`}</DialogTitle>
            <DialogDescription>同一个平台可以加多个账号，并发上限按账号算。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {!site && <Field data-invalid={!!errors.platformId}>
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
            </Field>}
            {isNewPlatform && (
              <Field data-invalid={!!domainError}>
                <FieldLabel htmlFor="acc-domains">新平台的域名（可选）</FieldLabel>
                <Textarea id="acc-domains" rows={2} className="font-mono" placeholder="example.com" value={domainText} aria-invalid={!!domainError} onChange={(event) => setDomainText(event.target.value)} />
                <FieldDescription>每行一个，子域名也算。agent 打开这些域名下的网址时，占用这个平台账号的并发名额。以后可以在账号的「⋯ → 改平台域名」里改。</FieldDescription>
                <FieldError>{domainError}</FieldError>
              </Field>
            )}
            <Field data-invalid={!!errors.account}>
              <FieldLabel htmlFor="acc-account">账号</FieldLabel>
              <Input id="acc-account" placeholder="登录用的用户名、邮箱或手机号" autoComplete="off" aria-invalid={!!errors.account} {...form.register("account")} />
              <FieldError errors={[errors.account]} />
            </Field>
            <Field data-invalid={!!errors.password}>
              <FieldLabel htmlFor="acc-password">密码（可选）</FieldLabel>
              <Input id="acc-password" type="password" autoComplete="new-password" disabled={clearPassword}
                placeholder={site?.hasPassword ? "已存过密码，不改就留空" : "不填就只能人工登录"} aria-invalid={!!errors.password} {...form.register("password")} />
              <FieldDescription>只加密存，页面和 agent 都看不到原文。存了密码能「立刻登录」，运行中遇到登录页 agent 也会自己登录。</FieldDescription>
              <FieldError errors={[errors.password]} />
            </Field>
            {site?.hasPassword && (
              <Field orientation="horizontal">
                <Checkbox id="acc-clear-password" checked={clearPassword} onCheckedChange={(checked) => setClearPassword(Boolean(checked))} />
                <FieldContent>
                  <FieldLabel htmlFor="acc-clear-password">去掉已存的密码</FieldLabel>
                  <FieldDescription>去掉后只能人工登录。</FieldDescription>
                </FieldContent>
              </Field>
            )}
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
              <FieldDescription>同一个账号在多处同时登录容易触发风控，风控严的网站建议 1 个。</FieldDescription>
              <FieldError errors={[errors.maxConcurrent]} />
            </Field>
            <Field data-invalid={!!errors.probeUrl}>
              <FieldLabel htmlFor="acc-probe">登录网址</FieldLabel>
              <Input id="acc-probe" placeholder="https://example.com/login" aria-invalid={!!errors.probeUrl} {...form.register("probeUrl")} />
              <FieldDescription>「立刻登录」「人工登录」都先打开这里；也用它检查登录态还在不在。</FieldDescription>
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
              {site ? "保存" : "加账号"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
