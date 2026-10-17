import * as React from "react"

import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import type { BrowserSite } from "@heyagent/shared"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

import { MAX_ITEMS, usePlatformName } from "./data"

type SiteLimitDialogProps = { site: BrowserSite; onClose: () => void }

/** 主管改某个「平台 × 账号」同时最多几个 session（只有一个选项，不用表单库） */
export function SiteLimitDialog({ site, onClose }: SiteLimitDialogProps) {
  const platformName = usePlatformName()
  const [max, setMax] = React.useState(String(site.maxConcurrent))
  const update = useAction(trpc.browsers.updateAccount.mutationOptions(), { success: (_data, vars) => `并发上限改成 ${vars.maxConcurrent} 个了` })

  async function save() {
    if (await update.submit({ id: site.accountId, maxConcurrent: Number(max) })) onClose()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>改并发上限</DialogTitle>
          <DialogDescription>{platformName(site.platformId)} · {site.account}，现在 {site.running} 个 session 在用。</DialogDescription>
        </DialogHeader>
        <Field>
          <FieldLabel>这个账号同时最多几个 session</FieldLabel>
          <ToggleGroup variant="outline" spacing={0} value={[max]} onValueChange={(next) => next[0] && setMax(String(next[0]))}>
            {MAX_ITEMS.map((n) => <ToggleGroupItem key={n} value={n}>{n}</ToggleGroupItem>)}
          </ToggleGroup>
          <FieldDescription>
            为什么按账号设：同一个账号在多处同时登录，平台容易判定异常、触发风控；不同账号互不影响。满了以后，要用这个账号的任务排队。风控严的网站建议 1 个。
          </FieldDescription>
          {Number(max) < site.running && <FieldDescription>正在用的 session 不会被打断，用完后按新上限来。</FieldDescription>}
        </Field>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
          <Button disabled={update.isPending || Number(max) === site.maxConcurrent} onClick={save}>
            {update.isPending && <Spinner data-icon="inline-start" />}
            保存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
