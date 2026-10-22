// 桌面页（docs/dev/desktop.md 第 7 节）：登记好的 Windows 电脑，agent 在上面操作电脑软件。左边列表、右边详情（照浏览器页）。
// 写操作（登记、编辑、删除、测试连接、放开）只有主管；「看画面」主管能操作，其他人只在有运行占着时能看（服务端再按运行判断）。
// 占用情况（现在）随实时推送刷新（desktop_leases → desktops.list）。
import * as React from "react"
import { CircleCheckIcon, CircleXIcon, EllipsisIcon, MonitorIcon, PencilIcon, PlugZapIcon, PlusIcon, Trash2Icon, UnlockIcon } from "lucide-react"
import { can, findById, fmtShort, type Desktop, type DesktopHealth, type DesktopUseState } from "@heyagent/shared"

import { RemoteViewDialog } from "@/components/remote-view/remote-view-dialog"
import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"

import { useDesktopsQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { DesktopDialog } from "./desktop-dialog"

const LINK = "underline underline-offset-4 hover:text-foreground"

export const DESKTOP_STATE: Record<DesktopUseState, { label: string; variant: "outline" | "secondary" | "default" }> = {
  free: { label: "空着", variant: "outline" },
  running: { label: "运行中", variant: "secondary" },
  held: { label: "等人处理", variant: "default" },
}

export default function DesktopsPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  const { params } = useRoute()
  const query = useDesktopsQuery()
  const list = [...(query.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "zh"))
  const selected = findById(list, params.get("id"))
  const [dialog, setDialog] = React.useState<"new" | "edit" | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [confirmRelease, setConfirmRelease] = React.useState(false)
  const [watching, setWatching] = React.useState<Desktop | null>(null)
  // 被运行占着时后端拒绝（CONFLICT），toast 里显示原因
  const remove = useAction(trpc.desktops.delete.mutationOptions({ onSuccess: () => setParams({ id: null }) }), { success: "桌面已删除" })
  const release = useAction(trpc.desktop.release.mutationOptions(), { success: "已放开，等着的运行会被叫醒" })

  const newButton = <Button onClick={() => setDialog("new")}><PlusIcon data-icon="inline-start" />登记桌面</Button>
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多操作" />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setDialog("edit")}><PencilIcon />编辑</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2Icon />删除</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <>
      <PageFrame
        queries={[query]}
        isEmpty={list.length === 0}
        header={
          <SimpleHeader
            title="桌面"
            description="装了桌面服务的 Windows 电脑：agent 在上面操作电脑软件，人可以看画面、帮忙扫码登录。"
            action={isAdmin && newButton}
          />
        }
        empty={
          isAdmin ? (
            <EmptyState icon={<MonitorIcon />} title="还没有桌面" action={newButton}
              description="先在 Windows 电脑（虚拟机或实体机）上装好 Windows-MCP 和桌面服务（见运维手册「桌面」一节），再点右上角「登记桌面」填两个地址和密钥。" />
          ) : (
            <EmptyState icon={<MonitorIcon />} title="还没有桌面" description="还没有登记桌面，由主管来登记。登记好以后，任务选了「桌面」工具，agent 就能在上面操作电脑软件。" />
          )
        }
      >
        <MasterDetail
          hasSelection={!!selected}
          list={
            <PickGroup>
              {list.map((desktop) => (
                <PickItem key={desktop.id} to={href("desktops", { id: desktop.id })} selected={desktop.id === selected?.id} title={desktop.name}
                  description={desktop.description || desktop.agentUrl}
                  badge={<StateBadge state={desktop.use.state} />} />
              ))}
            </PickGroup>
          }
          detail={
            selected && (
              <DetailPanel
                title={selected.name}
                badges={<StateBadge state={selected.use.state} />}
                meta={`登记于 ${fmtShort(selected.createdAt)} · 改于 ${fmtShort(selected.updatedAt)}`}
                actions={
                  <>
                    {(isAdmin || selected.use.state !== "free") && (
                      <Button onClick={() => setWatching(selected)}><MonitorIcon data-icon="inline-start" />看画面</Button>
                    )}
                    {isAdmin && menu}
                  </>
                }
              >
                <DetailSection title="给 agent 看的说明" description="任务允许好几台桌面时，agent 按这段话挑用哪台。">
                  <p className="whitespace-pre-wrap">{selected.description || "（还没写说明）"}</p>
                </DetailSection>
                <ConnectionSection key={selected.id} desktop={selected} isAdmin={isAdmin} />
                <DetailSection title="现在" description="同一时间一台桌面只给一个运行用。等人处理（例如扫码登录）时桌面保留给原来的运行，到时间没处理就自动放开。"
                  action={isAdmin && selected.use.state !== "free" && (
                    <Button size="sm" variant="outline" disabled={release.isPending} onClick={() => setConfirmRelease(true)}>
                      {release.isPending ? <Spinner data-icon="inline-start" /> : <UnlockIcon data-icon="inline-start" />}放开
                    </Button>
                  )}>
                  <UseText desktop={selected} />
                </DetailSection>
              </DetailPanel>
            )
          }
        />
      </PageFrame>
      {dialog && <DesktopDialog desktop={dialog === "edit" ? selected : undefined} onClose={() => setDialog(null)} />}
      {watching && (
        <RemoteViewDialog
          open
          target={{ kind: "desktop", id: watching.id, name: watching.name }}
          title={`桌面「${watching.name}」`}
          description={isAdmin ? "你是主管，可以直接操作。正有运行在用时，别和 agent 抢着点。" : "只能看，不能操作。"}
          viewOnly={!isAdmin}
          onOpenChange={(open) => !open && setWatching(null)}
        />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{selected?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              这台桌面的登记和密钥会一起删掉，不能撤销；那台电脑上的软件和登录不受影响，以后可以重新登记。
              正有运行占着它时删不了，等用完或先「放开」再删。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              setConfirmDelete(false)
              if (selected) remove.mutate({ id: selected.id })
            }}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmRelease} onOpenChange={setConfirmRelease}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>强制放开「{selected?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {selected?.use.sessionId ? `运行 ${selected.use.sessionId} 现在占着它。` : ""}
              放开后等着的运行会马上占过去；原来的运行下一次操作桌面时要重新排队，画面上做到一半的事可能被别的运行打断。
              {selected?.use.state === "held" ? "它正在等人处理，放开后保留的画面状态（例如扫码页）可能被别的运行改掉。" : ""}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>不放开</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              setConfirmRelease(false)
              if (selected) release.mutate({ desktopId: selected.id })
            }}>确认放开</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function StateBadge({ state }: { state: DesktopUseState }) {
  const { label, variant } = DESKTOP_STATE[state]
  return <Badge variant={variant}>{label}</Badge>
}

/** 现在：空着 / 哪个运行在用、从什么时候 / 等人处理、保留到什么时候 */
function UseText({ desktop }: { desktop: Desktop }) {
  const { use } = desktop
  if (use.state === "free") return <p className="text-muted-foreground">空着，没有运行在用。</p>
  const run = use.sessionId && (
    <a href={href("sessions", { id: use.sessionId })} className={LINK}>{use.taskTitle ? `${use.taskTitle} · ${use.sessionId}` : `运行 ${use.sessionId}`}</a>
  )
  if (use.state === "running")
    return <p>{run ?? "有运行"} 正在用{use.since ? `，从 ${fmtShort(use.since)} 开始` : ""}。</p>
  return (
    <p>
      {run ?? "有运行"} 在等人处理{use.holdUntil ? `，桌面保留到 ${fmtShort(use.holdUntil)}` : ""}。
      处理好后在那件事上点「已处理好了」，同一个运行接着用这台桌面。
    </p>
  )
}

/** 连接：两个地址、密钥掩码；主管能「测试连接」，两个服务分开报结果 */
function ConnectionSection({ desktop, isAdmin }: { desktop: Desktop; isAdmin: boolean }) {
  const [health, setHealth] = React.useState<DesktopHealth | null>(null)
  const test = useAction(trpc.desktops.test.mutationOptions({ onSuccess: (result) => setHealth(result) }), { errorTitle: "测试没做成" })
  return (
    <DetailSection title="连接" description="Windows-MCP 给 agent 读界面、点击、输入；桌面服务推画面、截图、传文件。两个服务用同一个密钥。"
      action={isAdmin && (
        <Button size="sm" variant="outline" disabled={test.isPending} onClick={() => test.mutate({ id: desktop.id })}>
          {test.isPending ? <Spinner data-icon="inline-start" /> : <PlugZapIcon data-icon="inline-start" />}
          {test.isPending ? "正在测试…" : "测试连接"}
        </Button>
      )}>
      <div className="flex flex-col gap-4">
        <dl className="flex flex-col gap-3">
          <Fact label="Windows-MCP 地址" value={desktop.mcpUrl} mono />
          <Fact label="桌面服务地址" value={desktop.agentUrl} mono />
          <Fact label="密钥" value={desktop.keyMask || "没存"} mono />
        </dl>
        {health && (
          <ItemGroup className="gap-2">
            <HealthRow name="Windows-MCP" ok={health.mcp.ok}
              detail={health.mcp.ok ? [health.mcp.toolCount !== undefined && `${health.mcp.toolCount} 个工具`, `${health.mcp.ms} 毫秒`] : [health.mcp.error ?? "连不上", `${health.mcp.ms} 毫秒`]} />
            <HealthRow name="桌面服务" ok={health.agent.ok}
              detail={health.agent.ok
                ? [health.agent.version && `版本 ${health.agent.version}`, health.agent.screen && `屏幕 ${health.agent.screen.width}×${health.agent.screen.height}`, `${health.agent.ms} 毫秒`]
                : [health.agent.error ?? "连不上", `${health.agent.ms} 毫秒`]} />
          </ItemGroup>
        )}
      </div>
    </DetailSection>
  )
}

function HealthRow({ name, ok, detail }: { name: string; ok: boolean; detail: (string | false | undefined)[] }) {
  return (
    <Item size="sm" variant="outline">
      <ItemContent className="min-w-0">
        <ItemTitle>
          {name}
          <Badge variant={ok ? "outline" : "destructive"}>
            {ok ? <CircleCheckIcon data-icon="inline-start" /> : <CircleXIcon data-icon="inline-start" />}
            {ok ? "连得上" : "连不上"}
          </Badge>
        </ItemTitle>
        <ItemDescription className="break-all">{detail.filter(Boolean).join(" · ")}</ItemDescription>
      </ItemContent>
    </Item>
  )
}

function Fact({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className={mono ? "font-mono break-all" : "break-all"}>{value}</dd>
    </div>
  )
}
