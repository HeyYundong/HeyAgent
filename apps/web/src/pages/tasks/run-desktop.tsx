// 运行（session）里的「看桌面」：这次运行占着一台桌面时（desktop.sessionDesktop 的 open），打开远程画面实时看（照 run-browser.tsx）。
// 能不能操作由服务端定（主管、任务负责人、被分配处理的人）；agent 请人在桌面上处理（desktop.ask_human）时，画面下面直接给「已处理好了」。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { CheckIcon, MonitorIcon } from "lucide-react"
import { can, isRunEnded, type HumanItem, type SessionSummary } from "@heyagent/shared"

import { RemoteViewDialog } from "@/components/remote-view/remote-view-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useHumanItems } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

/** 这次运行现在占着的桌面 */
export function useSessionDesktop(sessionId: string, enabled = true) {
  return useQuery({ ...trpc.desktop.sessionDesktop.queryOptions({ sessionId }), enabled })
}

/** 运行详情右上角的「看桌面」：只在这次运行占着桌面时出现 */
export function RunDesktopButton({ run }: { run: SessionSummary }) {
  const active = !isRunEnded(run.status)
  const query = useSessionDesktop(run.id, active)
  const [open, setOpen] = React.useState(false)
  const desktop = query.data
  if (!active || !desktop?.open || !desktop.desktopId) return null
  const held = desktop.state === "held"
  return (
    <>
      <Button size="sm" variant={held ? "default" : "outline"} onClick={() => setOpen(true)}>
        <MonitorIcon data-icon="inline-start" />
        {held ? "看桌面（等人处理）" : "看桌面"}
      </Button>
      {open && (
        <SessionDesktopDialog runId={run.id} desktopId={desktop.desktopId} desktopName={desktop.desktopName} viewOnly={!desktop.canControl} onClose={() => setOpen(false)} />
      )}
    </>
  )
}

/** 运行的桌面远程画面。这次运行有请人在桌面上处理的事（detail.desktop），而且分给了自己（或自己是主管），底部给「已处理好了」 */
export function SessionDesktopDialog({ runId, desktopId, desktopName, item, viewOnly, onClose, onResolved }: {
  runId: string
  desktopId: string
  desktopName?: string
  item?: HumanItem
  viewOnly?: boolean
  onClose: () => void
  onResolved?: () => void
}) {
  const { user } = useMe()
  const items = useHumanItems()
  const pending = item ?? items.find((each) => each.runId === runId && each.detail.desktop?.desktopId === desktopId)
  const canResolve = pending ? can(user, "humanItem.resolve", { assigneeId: pending.assigneeId }) : false
  const resolve = useAction(trpc.engine.resolveHumanItem.mutationOptions({ onSuccess: () => { onClose(); onResolved?.() } }), {
    success: (result) => (result.resumedSessionId ? `已处理，${result.resumedSessionId} 接着在同一台桌面上做` : "已处理"),
    errorTitle: "没处理成功",
  })
  const description = [desktopName && `桌面「${desktopName}」`, pending && `在等：${pending.title}`].filter(Boolean).join(" · ")
  return (
    <RemoteViewDialog
      open
      target={{ kind: "desktop", id: desktopId, name: desktopName }}
      title={`运行 ${runId} 的桌面`}
      description={description || "这次运行正在用的桌面"}
      viewOnly={viewOnly}
      onOpenChange={(open) => !open && onClose()}
      footer={
        pending && canResolve ? (
          <>
            <p className="text-xs text-muted-foreground sm:mr-auto">在画面里处理好（例如扫码登录、关掉弹框），再点「已处理好了」，agent 会在同一台桌面上接着做。</p>
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
