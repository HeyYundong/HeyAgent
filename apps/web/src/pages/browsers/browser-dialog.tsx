// 新建 / 编辑 Chrome（只有主管）：名称、给 agent 的说明、代理（不用 / SOCKS5）、出口地、时区、语言。并发上限按账号设，不在这里。
// 表单：React Hook Form + shared 的 browserProfileInputSchema；代理密码只进不出，编辑时留空 = 不改。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch, type FieldError as FormFieldError } from "react-hook-form"
import { browserProfileInputSchema, DEFAULT_BROWSER_LOCALE, DEFAULT_BROWSER_TIMEZONE, type BrowserProfileInput } from "@heyagent/shared"

import { CreatableCombobox } from "@/components/shell/creatable-combobox"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { LOCALE_OPTIONS, type Chrome } from "./data"
import { TimeZoneCombobox } from "./timezone-combobox"

/** profile 不传就是新建 */
type BrowserDialogProps = { profile?: Chrome; onClose: () => void }

type Socks5 = Extract<BrowserProfileInput["proxy"], { kind: "socks5" }>
type ProxyErrors = Partial<Record<keyof Socks5, FormFieldError>>

const DEFAULT_PORT = 1080

/** 表单初始值。不用代理时也带上 SOCKS5 的几个空字段：切到 SOCKS5 时输入框有值可绑；提交时 schema 会把它们去掉 */
function initialValues(profile?: Chrome): BrowserProfileInput {
  const socks = profile?.proxy.kind === "socks5" ? profile.proxy : undefined
  const proxy = {
    kind: socks ? "socks5" : "none",
    host: socks?.host ?? "",
    port: socks?.port ?? DEFAULT_PORT,
    username: socks?.username ?? "",
    password: "",
    clearPassword: false,
  } as BrowserProfileInput["proxy"]
  // 没填过时区、语言的，表单里直接显示默认值（Chrome 本来就按默认值启动），保存时一起存下
  return {
    name: profile?.name ?? "",
    description: profile?.description ?? "",
    proxy,
    exitIp: profile?.exitIp ?? "",
    timezone: profile?.timezone || DEFAULT_BROWSER_TIMEZONE,
    locale: profile?.locale || DEFAULT_BROWSER_LOCALE,
  }
}

export function BrowserDialog({ profile, onClose }: BrowserDialogProps) {
  const form = useForm<BrowserProfileInput>({ resolver: zodResolver(browserProfileInputSchema), defaultValues: initialValues(profile) })
  const { errors } = form.formState
  const proxyErrors = (errors.proxy ?? {}) as ProxyErrors
  const socks5 = useWatch({ control: form.control, name: "proxy.kind" }) === "socks5"
  const clearPassword = useWatch({ control: form.control, name: "proxy.clearPassword" })
  // 语言下拉里新输入的，加进选项
  const [createdLocales, setCreatedLocales] = React.useState<string[]>([])
  const create = useAction(trpc.browsers.create.mutationOptions(), { success: "Chrome 建好了。下一步：在「登录过的网站」里加要登录的平台账号" })
  const update = useAction(trpc.browsers.update.mutationOptions(), { success: "已保存" })
  const pending = create.isPending || update.isPending

  const submit = form.handleSubmit(async (values) => {
    if (profile) {
      if (await update.submit({ ...values, id: profile.id })) onClose()
      return
    }
    const created = await create.submit(values)
    if (created) {
      onClose()
      navigate("browsers", { id: created.id })
    }
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{profile ? `编辑「${profile.name}」` : "新建 Chrome"}</DialogTitle>
            <DialogDescription>每个 Chrome 有自己的出口 IP 和一份登录态保险箱，agent 干活时按说明自己选用。每个账号的并发上限在「登录过的网站」里改。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="br-name">名称</FieldLabel>
              <Input id="br-name" placeholder="例如：英国 Chrome" aria-invalid={!!errors.name} {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="br-desc">给 agent 的说明</FieldLabel>
              <Textarea id="br-desc" placeholder="例如：英国 IP，用于英国站的店铺后台" aria-invalid={!!errors.description} {...form.register("description")} />
              <FieldDescription>agent 靠这句话自己选用哪个 Chrome：写清楚 IP 在哪、用于哪些平台。</FieldDescription>
              <FieldError errors={[errors.description]} />
            </Field>
            <Field>
              <FieldLabel>代理</FieldLabel>
              <Controller
                control={form.control}
                name="proxy.kind"
                render={({ field }) => (
                  <ToggleGroup variant="outline" spacing={0} value={[field.value]} onValueChange={(next) => next[0] && field.onChange(String(next[0]))}>
                    <ToggleGroupItem value="none">不用代理</ToggleGroupItem>
                    <ToggleGroupItem value="socks5">SOCKS5</ToggleGroupItem>
                  </ToggleGroup>
                )}
              />
              <FieldDescription>同一个账号要一直走同一个出口 IP，和人登录时一致，不容易被平台风控。</FieldDescription>
            </Field>
            {socks5 && (
              <div className="grid grid-cols-3 gap-3">
                <Field data-invalid={!!proxyErrors.host} className="col-span-2">
                  <FieldLabel htmlFor="br-host">主机</FieldLabel>
                  <Input id="br-host" placeholder="10.0.8.23" aria-invalid={!!proxyErrors.host} {...form.register("proxy.host")} />
                  <FieldError errors={[proxyErrors.host]} />
                </Field>
                <Field data-invalid={!!proxyErrors.port}>
                  <FieldLabel htmlFor="br-port">端口</FieldLabel>
                  <Input id="br-port" inputMode="numeric" aria-invalid={!!proxyErrors.port} {...form.register("proxy.port", { valueAsNumber: true })} />
                  {/* 没填或填了字母时 zod 给的是英文提示，这里统一换成中文 */}
                  {proxyErrors.port && <FieldError>填 1～65535 的数字</FieldError>}
                </Field>
                <Field data-invalid={!!proxyErrors.username} className="col-span-3 sm:col-span-1">
                  <FieldLabel htmlFor="br-user">用户名（可选）</FieldLabel>
                  <Input id="br-user" autoComplete="off" aria-invalid={!!proxyErrors.username} {...form.register("proxy.username")} />
                  <FieldError errors={[proxyErrors.username]} />
                </Field>
                <Field data-invalid={!!proxyErrors.password} className="col-span-3 sm:col-span-2">
                  <FieldLabel htmlFor="br-password">密码（可选）</FieldLabel>
                  <Input id="br-password" type="password" autoComplete="new-password" disabled={!!clearPassword}
                    placeholder={profile?.proxy.kind === "socks5" && profile.proxy.hasPassword ? "已存过密码，不改就留空" : undefined}
                    aria-invalid={!!proxyErrors.password} {...form.register("proxy.password")} />
                  <FieldError errors={[proxyErrors.password]} />
                </Field>
                {profile?.proxy.kind === "socks5" && profile.proxy.hasPassword && (
                  <Controller
                    control={form.control}
                    name="proxy.clearPassword"
                    render={({ field }) => (
                      <Field orientation="horizontal" className="col-span-3">
                        <Checkbox id="br-clear-password" checked={!!field.value} onCheckedChange={field.onChange} />
                        <FieldContent>
                          <FieldLabel htmlFor="br-clear-password">去掉已存的密码</FieldLabel>
                          <FieldDescription>代理不再需要密码时勾上，保存后服务器上存的密码会删掉。</FieldDescription>
                        </FieldContent>
                      </Field>
                    )}
                  />
                )}
              </div>
            )}
            <Field data-invalid={!!errors.exitIp}>
              <FieldLabel htmlFor="br-exit">出口地（可选）</FieldLabel>
              <Input id="br-exit" placeholder="例如：英国 · 伦敦（住宅 IP）" aria-invalid={!!errors.exitIp} {...form.register("exitIp")} />
              <FieldDescription>一句话写这个 Chrome 从哪里出网，给人看的，系统不会去检测。</FieldDescription>
              <FieldError errors={[errors.exitIp]} />
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Controller
                control={form.control}
                name="timezone"
                render={({ field }) => (
                  <Field data-invalid={!!errors.timezone}>
                    <FieldLabel htmlFor="br-timezone">时区</FieldLabel>
                    <TimeZoneCombobox id="br-timezone" value={field.value ?? ""} onValueChange={field.onChange} aria-invalid={!!errors.timezone} />
                    <FieldDescription>网页看到的本地时间。和出口地一致，不容易被风控。</FieldDescription>
                    <FieldError errors={[errors.timezone]} />
                  </Field>
                )}
              />
              <Controller
                control={form.control}
                name="locale"
                render={({ field }) => (
                  <Field data-invalid={!!errors.locale}>
                    <FieldLabel htmlFor="br-locale">语言</FieldLabel>
                    <CreatableCombobox id="br-locale" value={field.value ?? ""} onValueChange={field.onChange} aria-invalid={!!errors.locale}
                      options={[...LOCALE_OPTIONS, ...createdLocales]} onCreate={(value) => setCreatedLocales((list) => [...list, value])} placeholder="例如 en-US" />
                    <FieldDescription>浏览器界面和发给网站的语言。列表里没有的直接输入。</FieldDescription>
                    <FieldError errors={[errors.locale]} />
                  </Field>
                )}
              />
            </div>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {profile ? "保存" : "创建"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
