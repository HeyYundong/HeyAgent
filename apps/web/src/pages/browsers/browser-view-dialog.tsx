import * as React from "react"
import { ArrowLeftIcon, ArrowRightIcon, MonitorIcon, RotateCwIcon, SaveIcon } from "lucide-react"

import { CreatableCombobox } from "@/components/shell/creatable-combobox"
import { AspectRatio } from "@/components/ui/aspect-ratio"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import type { BrowserSite } from "@heyagent/shared"

import { usePlatformsQuery } from "@/lib/data"

import { HOME_URL, platformIdOf, proxyText, usePlatformName, type Chrome } from "./data"

// probeUrl：这个账号配置的登录网址（平台通用：不在代码里按平台写死登录页）
export type Login = Pick<BrowserSite, "platformId" | "account" | "probeUrl">

/** site：从「去登录」打开时要重新登录的网站。onSave 的 login：这次登录的网站（没填就只保存 cookie 变化） */
type BrowserViewDialogProps = { profile: Chrome; site?: Login; onSave: (login?: Login) => void; onClose: () => void }

/** 模拟远程画面：服务器上临时起一个带着保险箱登录态的 Chrome，人在画面里登录，保存后合并回保险箱。主管和员工都能用 */
export function BrowserViewDialog({ profile, site, onSave, onClose }: BrowserViewDialogProps) {
  const platforms = usePlatformsQuery().data ?? []
  const platformName = usePlatformName()
  const siteId = site?.platformId
  const [history, setHistory] = React.useState([site?.probeUrl || HOME_URL])
  const [index, setIndex] = React.useState(0)
  const [draft, setDraft] = React.useState(history[0])
  const [loading, setLoading] = React.useState(false)
  const [names, setNames] = React.useState(() => [...platforms.map((p) => p.name), ...profile.sites.map((s) => platformName(s.platformId))])
  const [login, setLogin] = React.useState({ name: "", account: "" })
  const [submitted, setSubmitted] = React.useState(false)
  const accountMissing = !!login.name && !login.account.trim()

  function save() {
    setSubmitted(true)
    if (site) onSave(site)
    else if (!accountMissing) onSave(login.name ? { platformId: platformIdOf(platforms, login.name), account: login.account.trim() } : undefined)
  }

  function reload() {
    setLoading(true)
    window.setTimeout(() => setLoading(false), 600)
  }

  function go(nextIndex: number, nextHistory = history) {
    setHistory(nextHistory)
    setIndex(nextIndex)
    setDraft(nextHistory[nextIndex])
    reload()
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const next = draft.trim()
    if (next) go(index + 1, [...history.slice(0, index + 1), /^[a-z]+:\/\//.test(next) ? next : `https://${next}`])
  }

  const nav = [
    { label: "后退", icon: <ArrowLeftIcon />, disabled: index === 0, onClick: () => go(index - 1) },
    { label: "前进", icon: <ArrowRightIcon />, disabled: index === history.length - 1, onClick: () => go(index + 1) },
    { label: "刷新", icon: <RotateCwIcon />, disabled: false, onClick: reload },
  ]

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{profile.name} · 远程画面</DialogTitle>
          <DialogDescription>
            出口 {profile.exitIp} · {proxyText(profile.proxy)} · 已带上保险箱 v{profile.vaultVersion} 的登录态
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-1">
          {nav.map((button) => (
            <Button key={button.label} variant="ghost" size="icon-sm" aria-label={button.label} disabled={button.disabled} onClick={button.onClick}>
              {button.icon}
            </Button>
          ))}
          <form onSubmit={submit} className="flex-1">
            <Input aria-label="地址栏" value={draft} onChange={(event) => setDraft(event.target.value)} />
          </form>
        </div>

        <AspectRatio ratio={16 / 9}>
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 border bg-muted/40 p-4 text-center">
            {loading ? (
              <Spinner />
            ) : (
              <>
                <MonitorIcon className="size-6 text-muted-foreground" />
                <p className="font-mono text-xs break-all">{history[index]}</p>
                <p className="text-sm">这是服务器上这个 Chrome 的实时画面（原型里是模拟）</p>
                <p className="text-xs text-muted-foreground">
                  {siteId
                    ? `在画面里登录「${platformName(siteId)} · ${site?.account}」，验证码、短信码也在这里完成。`
                    : "可以像平时一样点击、输入、进入页面、登录账号；登录了新网站就在下面填上。"}
                </p>
              </>
            )}
          </div>
        </AspectRatio>

        {!site && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="view-site">登录了哪个网站（可选）</FieldLabel>
              <CreatableCombobox id="view-site" value={login.name} options={names} placeholder="选或输入网站，例如「示例商城」"
                onValueChange={(name) => setLogin({ ...login, name })} onCreate={(name) => setNames([...names, name])} />
              <FieldDescription>新网站保存后出现在「登录过的网站」里，默认同时最多 1 个 session。</FieldDescription>
            </Field>
            <Field data-invalid={submitted && accountMissing}>
              <FieldLabel htmlFor="view-account">用的哪个账号</FieldLabel>
              <Input id="view-account" placeholder="例如：店铺后台（美国站）" value={login.account} aria-invalid={submitted && accountMissing}
                onChange={(event) => setLogin({ ...login, account: event.target.value })} />
              {submitted && accountMissing && <FieldError>填一下账号，同一网站可以登录多个账号，并发按账号算。</FieldError>}
            </Field>
          </div>
        )}

        <DialogFooter className="sm:items-center">
          <p className="text-xs text-muted-foreground sm:mr-auto">
            登录好以后点保存，cookie 和 session 会合并进保险箱；直接关掉就不保存。
          </p>
          <Button variant="outline" onClick={onClose}>关闭</Button>
          <Button onClick={save}><SaveIcon data-icon="inline-start" />保存登录状态</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
