import * as React from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { blankProfile, type Chrome } from "./data"

/** profile 不传就是新建 */
type BrowserDialogProps = { profile?: Chrome; onSave: (profile: Chrome) => void; onClose: () => void }

/** 新建 / 编辑 Chrome（只有主管）：名称、给 agent 的说明、代理（不用 / SOCKS5）。并发上限按账号设，不在这里 */
export function BrowserDialog({ profile, onSave, onClose }: BrowserDialogProps) {
  const base = profile ?? blankProfile()
  const socks = base.proxy.kind === "socks5" ? base.proxy : undefined
  const [form, setForm] = React.useState({
    name: base.name,
    description: base.description,
    kind: base.proxy.kind as string,
    host: socks?.host ?? "",
    port: socks ? String(socks.port) : "1080",
    username: socks?.username ?? "",
    password: "",
  })
  const [submitted, setSubmitted] = React.useState(false)
  const set = (key: keyof typeof form) => (value: string) => setForm({ ...form, [key]: value })
  const socks5 = form.kind === "socks5"
  const errors = {
    name: !form.name.trim() && "起个名字，例如「英国 Chrome」",
    host: socks5 && !form.host.trim() && "填代理地址",
    port: socks5 && !/^\d{1,5}$/.test(form.port) && "填数字",
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (Object.values(errors).some(Boolean)) return
    onSave({
      ...base,
      name: form.name.trim(),
      description: form.description.trim(),
      proxy: socks5
        ? { kind: "socks5", host: form.host.trim(), port: Number(form.port), username: form.username.trim() || undefined }
        : { kind: "none" },
    })
  }

  const text = (key: "name" | "host" | "port" | "username" | "password", label: string, extra = {}) => (
    <TextField id={`br-${key}`} label={label} value={form[key]} onChange={set(key)}
      error={submitted ? (errors as Record<string, string | false>)[key] : false} {...extra} />
  )

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{profile ? `编辑「${profile.name}」` : "新建 Chrome"}</DialogTitle>
            <DialogDescription>每个 Chrome 有自己的出口 IP 和一份登录态保险箱，agent 干活时按说明自己选用。每个账号的并发上限在「登录过的网站」里改。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            {text("name", "名称", { placeholder: "例如：英国 Chrome" })}
            <Field>
              <FieldLabel htmlFor="br-desc">给 agent 的说明</FieldLabel>
              <Textarea id="br-desc" placeholder="例如：英国 IP，用于亚马逊英国站" value={form.description} onChange={(event) => set("description")(event.target.value)} />
              <FieldDescription>agent 靠这句话自己选用哪个 Chrome：写清楚 IP 在哪、用于哪些平台。</FieldDescription>
            </Field>
            <Field>
              <FieldLabel>代理</FieldLabel>
              <ToggleGroup variant="outline" spacing={0} value={[form.kind]} onValueChange={(next) => next[0] && set("kind")(String(next[0]))}>
                <ToggleGroupItem value="none">不用代理</ToggleGroupItem>
                <ToggleGroupItem value="socks5">SOCKS5</ToggleGroupItem>
              </ToggleGroup>
              <FieldDescription>同一个账号要一直走同一个出口 IP，和人登录时一致，不容易被平台风控。</FieldDescription>
            </Field>
            {socks5 && (
              <div className="grid grid-cols-3 gap-3">
                <div className="col-span-2">{text("host", "主机", { placeholder: "10.0.8.23" })}</div>
                {text("port", "端口", { inputMode: "numeric" })}
                <div className="col-span-3 sm:col-span-1">{text("username", "用户名（可选）")}</div>
                <div className="col-span-3 sm:col-span-2">
                  {text("password", "密码（可选）", { type: "password", placeholder: profile ? "不改就留空" : undefined })}
                </div>
              </div>
            )}
          </FieldGroup>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>取消</Button>
            <Button type="submit">{profile ? "保存" : "创建"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type TextFieldProps = Omit<React.ComponentProps<typeof Input>, "onChange"> & { label: string; error: string | false; onChange: (value: string) => void }

function TextField({ id, label, error, onChange, ...input }: TextFieldProps) {
  return (
    <Field data-invalid={!!error}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Input id={id} aria-invalid={!!error} onChange={(event) => onChange(event.target.value)} {...input} />
      {error && <FieldError>{error}</FieldError>}
    </Field>
  )
}
