// 运行（session）里的「看浏览器」：这次运行开着 Chrome 时（browser.sessionBrowser 的 open），打开远程画面实时看。
// 能不能操作由服务端定（任务负责人、被分配处理的人、主管）；遇到验证码等人处理时，画面下面直接给「已处理好了」。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { CheckIcon, MonitorIcon } from "lucide-react"
import { can, fmtShort, isRunEnded, type HumanItem, type SessionSummary } from "@heyagent/shared"

import { RemoteViewDialog } from "@/components/remote-view/remote-view-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useBrowsersQuery, useHumanItems } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"
import { LIVE_STATE, useLiveBrowsersQuery } from "@/pages/browsers/data"

/** 这次运行现在开着的 Chrome（没结束的运行才查） */
export function useSessionBrowser(sessionId: string, enabled = true) {
  return useQuery({ ...trpc.browser.sessionBrowser.queryOptions({ sessionId }), enabled })
}

/** 「已处理好了」：resolveHumanItem(how: done)，session 在同一个 Chrome 里接着跑 */
export function useResolveDone(onDone?: () => void) {
  return useAction(trpc.engine.resolveHumanItem.mutationOptions({ onSuccess: () => onDone?.() }), {
    success: (result) => (result.resumedSessionId ? `已处理，${result.resumedSessionId} 接着在同一个 Chrome 里做` : "已处理"),
    errorTitle: "没处理成功",
  })
}

/** 运行详情右上角的「看浏览器」：只在这次运行开着 Chrome 时出现 */
export function RunBrowserButton({ run }: { run: SessionSummary }) {
  const active = !isRunEnded(run.status)
  const query = useSessionBrowser(run.id, active)
  const [open, setOpen] = React.useState(false)
  const browser = query.data
  if (!active || !browser?.open || !browser.browserId) return null
  const held = browser.state === "held"
  return (
    <>
      <Button size="sm" variant={held ? "default" : "outline"} onClick={() => setOpen(true)}>
        <MonitorIcon data-icon="inline-start" />
        {held ? "看浏览器（等人处理）" : "看浏览器"}
      </Button>
      {open && <SessionBrowserDialog runId={run.id} browserId={browser.browserId} onClose={() => setOpen(false)} />}
    </>
  )
}

/** 运行的远程画面。这次运行有「登录」类的事在等，而且分给了自己（或自己是主管），底部给「已处理好了」 */
export function SessionBrowserDialog({ runId, browserId, item, onClose, onResolved }: { runId: string; browserId: string; item?: HumanItem; onClose: () => void; onResolved?: () => void }) {
  const { user } = useMe()
  const items = useHumanItems()
  const pending = item ?? items.find((each) => each.runId === runId && each.kind === "login")
  const canResolve = pending ? can(user, "humanItem.resolve", { assigneeId: pending.assigneeId }) : false
  const live = useLiveBrowsersQuery().data?.find((each) => each.browserId === browserId)
  const profiles = useBrowsersQuery().data ?? []
  const profileName = live?.profileName ?? profiles.find((profile) => profile.id === pending?.detail.browser?.profileId)?.name
  const resolve = useResolveDone(() => {
    onClose()
    onResolved?.()
  })
  const description = [
    profileName,
    live && LIVE_STATE[live.state],
    live?.holdUntil && `保留到 ${fmtShort(live.holdUntil)}`,
    pending && `在等：${pending.title}`,
  ].filter(Boolean).join(" · ")
  return (
    <RemoteViewDialog
      open
      browserId={browserId}
      title={`运行 ${runId} 的浏览器`}
      description={description || "这次运行正在用的 Chrome"}
      onOpenChange={(open) => !open && onClose()}
      footer={
        pending && canResolve ? (
          <>
            <p className="text-xs text-muted-foreground sm:mr-auto">在画面里处理好验证码或登录，再点「已处理好了」，agent 会在同一个 Chrome 里接着做。</p>
            <Button disabled={resolve.isPending} onClick={() => resolve.mutate({ itemId: pending.id, how: "done" })}>
              {resolve.isPending ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}
              已处理好了
            </Button>
          </>
        ) : undefined
      }
    />
  )
}
