// 改平台的名字和域名（只有主管，platforms.update）。域名用来认「session 打开的网址属于哪个平台」，
// 打开这些域名（含子域名）下的网址时，按这个 Chrome 配置在该平台的账号申请并发租约。
import * as React from "react"
import type { Platform } from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { domainsText, invalidDomainsMessage, parseDomains } from "@/lib/domains"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

export function PlatformDialog({ platform, onClose }: { platform: Platform; onClose: () => void }) {
  const [name, setName] = React.useState(platform.name)
  const [text, setText] = React.useState(domainsText(platform.domains))
  const [submitted, setSubmitted] = React.useState(false)
  const update = useAction(trpc.platforms.update.mutationOptions(), { success: "平台已保存" })
  const parsed = parseDomains(text)
  const nameError = submitted && !name.trim() ? "填平台（网站）名" : undefined
  const domainError = parsed.invalid.length ? invalidDomainsMessage(parsed.invalid) : undefined

  async function save(event: React.FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (!name.trim() || domainError) return
    if (await update.submit({ id: platform.id, name: name.trim(), domains: parsed.domains })) onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={save} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>改平台「{platform.name}」</DialogTitle>
            <DialogDescription>所有 Chrome 配置共用这个平台。域名决定 agent 打开哪些网址时算用了这个平台的账号。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!nameError}>
              <FieldLabel htmlFor="platform-name">名字</FieldLabel>
              <Input id="platform-name" value={name} aria-invalid={!!nameError} onChange={(event) => setName(event.target.value)} />
              <FieldError>{nameError}</FieldError>
            </Field>
            <Field data-invalid={!!domainError}>
              <FieldLabel htmlFor="platform-domains">域名</FieldLabel>
              <Textarea id="platform-domains" rows={4} className="font-mono" placeholder={"example.com\nshop.example.com"} value={text} aria-invalid={!!domainError} onChange={(event) => setText(event.target.value)} />
              <FieldDescription>每行一个，子域名也算（填 example.com 就包含 www.example.com）。不填的话，agent 打开网址时不会占这个平台账号的并发名额。</FieldDescription>
              <FieldError>{domainError}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending && <Spinner data-icon="inline-start" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
