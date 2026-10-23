// 桌面页（docs/dev/desktop.md 第 7 节、docs/dev/desktop-vm.md 第 6 节）：agent 操作电脑软件用的 Windows 电脑。左边列表、右边详情（照浏览器页）。
// 三种桌面：系统开的（vm，所有人能「新建桌面」，建的人和主管能开关、重置、删除）、模板（template，主管做）、手动登记的（manual，主管登记）。
// 列表分两组：桌面（vm + manual）、模板。占用情况和虚拟机状态随实时推送刷新（desktops.list）。
// 「看画面」：手动登记的照旧（主管能操作，其他人只在有运行占着时能看）；系统开的只在开着时能点，建的人和主管能操作。
import * as React from "react"
import {
  CircleCheckIcon, CircleXIcon, EllipsisIcon, MonitorIcon, PencilIcon, PlugZapIcon, PlusIcon, PowerIcon, PowerOffIcon,
  RotateCcwIcon, RotateCwIcon, StampIcon, Trash2Icon, TriangleAlertIcon, UnlockIcon,
} from "lucide-react"
import { can, findById, fmtShort, type Desktop, type DesktopHealth, type DesktopHost, type DesktopUseState, type DesktopVmAction } from "@heyagent/shared"

import { RemoteViewDialog } from "@/components/remote-view/remote-view-dialog"
import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"

import { useDesktopHostQuery, useDesktopsQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { DesktopDialog } from "./desktop-dialog"
import { NewDesktopDialog } from "./new-desktop-dialog"
import { TemplateDialog } from "./template-dialog"
import { DISK_LABEL, durationText, useMinutesSince, vmBusy, VmStateBadge, vmStateLabel } from "./vm-parts"

const LINK = "underline underline-offset-4 hover:text-foreground"

export const DESKTOP_STATE: Record<DesktopUseState, { label: string; variant: "outline" | "secondary" | "default" }> = {
  free: { label: "空着", variant: "outline" },
  running: { label: "运行中", variant: "secondary" },
  held: { label: "等人处理", variant: "default" },
}

type User = ReturnType<typeof useMe>["user"]

/** 能不能开关、重置、删除、改名：模板和手动登记的只有主管；系统开的桌面是建的人和主管 */
function canManage(user: User, desktop: Desktop) {
  if (desktop.kind === "vm") return can(user, "desktop.manage", { createdById: desktop.createdById ?? "" })
  return can(user, "config.manage", {})
}

/** 系统开的和模板：开着（模板装好等装软件时也算）才能看画面 */
const powered = (desktop: Desktop) => !desktop.vm || desktop.vm.state === "running" || desktop.vm.state === "setup"

/** 「新建桌面」为什么点不了；能点 = undefined */
function newDisabledReason(host: DesktopHost | undefined, hostFailed: boolean, templates: Desktop[], isAdmin: boolean) {
  if (hostFailed) return "没查到这台服务器的情况，刷新一下页面再试。"
  if (!host) return "正在查这台服务器能不能开桌面…"
  if (!host.available) return isAdmin ? `这台服务器现在开不了新桌面：${host.problem ?? "虚拟机服务没开"}` : "这台服务器现在开不了新桌面，请联系主管。"
  if (!templates.some((each) => each.vm?.state === "ready")) {
    if (templates.length) return isAdmin ? "模板还没做好，做好后才能新建。" : "模板还没做好，等主管做好就能新建。"
    return isAdmin ? "还没有模板，先点左边的「做模板」。" : "还没有模板，请主管先做一个。"
  }
  return undefined
}

export default function DesktopsPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  const { params } = useRoute()
  const query = useDesktopsQuery()
  const hostQuery = useDesktopHostQuery()
  const host = hostQuery.data
  const all = [...(query.data ?? [])].sort((a, b) => a.name.localeCompare(b.name, "zh"))
  const machines = all.filter((each) => each.kind !== "template")
  const templates = all.filter((each) => each.kind === "template")
  const readyTemplates = templates.filter((each) => each.vm?.state === "ready")
  const selected = findById(all, params.get("id"))
  const [dialog, setDialog] = React.useState<"new" | "template" | "register" | "edit" | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const [confirmRelease, setConfirmRelease] = React.useState(false)
  const [watching, setWatching] = React.useState<Desktop | null>(null)
  // 被运行占着、模板还有桌面在用时后端拒绝（CONFLICT），toast 里显示原因
  const remove = useAction(trpc.desktops.delete.mutationOptions({ onSuccess: () => setParams({ id: null }) }), {
    success: (_data, vars) => (findById(all, vars.id)?.kind === "manual" ? "桌面已删除" : "正在删除，关机、删磁盘要一会儿"),
  })
  const release = useAction(trpc.desktop.release.mutationOptions(), { success: "已放开，等着的运行会被叫醒" })

  const disabledReason = newDisabledReason(host, hostQuery.isError, templates, isAdmin)
  const canCreate = can(user, "desktop.create", {})
  const canMakeTemplate = isAdmin && Boolean(host?.available)
  const newButton = (
    <Button disabled={!!disabledReason} onClick={() => setDialog("new")}>
      <PlusIcon data-icon="inline-start" />新建桌面
    </Button>
  )
  const registerButton = <Button variant="outline" onClick={() => setDialog("register")}>登记已有电脑</Button>
  const templateButton = (size: "xs" | "default") => (
    <Button size={size} variant={size === "xs" ? "ghost" : "default"} disabled={!canMakeTemplate} onClick={() => setDialog("template")}>
      <PlusIcon data-icon="inline-start" />做模板
    </Button>
  )
  const headerAction = (canCreate || isAdmin) && (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap justify-end gap-2">
        {isAdmin && registerButton}
        {canCreate && newButton}
      </div>
      {canCreate && disabledReason && <p className="max-w-sm text-right text-xs text-muted-foreground">{disabledReason}</p>}
    </div>
  )

  const manageable = selected ? canManage(user, selected) : false
  const viewable = selected ? (selected.kind === "manual" ? isAdmin || selected.use.state !== "free" : manageable || selected.use.state !== "free") : false
  const menu = selected && manageable && (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多操作" />}>
        <EllipsisIcon />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={() => setDialog("edit")}><PencilIcon />{selected.kind === "manual" ? "编辑" : "改名字、说明"}</DropdownMenuItem>
        <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}><Trash2Icon />删除</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <>
      <PageFrame
        queries={[query]}
        isEmpty={all.length === 0}
        header={
          <SimpleHeader
            title="桌面"
            description="agent 操作电脑软件用的 Windows 电脑。新建一台、扫码登录好软件，任务就能用它。"
            action={headerAction}
          />
        }
        empty={
          isAdmin ? (
            host && !host.available ? (
              <EmptyState icon={<MonitorIcon />} title="还没有桌面" action={registerButton}
                description={`这台服务器现在开不了虚拟机（${host.problem ?? "虚拟机服务没开"}），可以先登记已经装好桌面服务的电脑（见运维手册「桌面」一节）。`} />
            ) : (
              <EmptyState icon={<MonitorIcon />} title="还没有桌面" action={<div className="flex flex-wrap justify-center gap-2">{templateButton("default")}{registerButton}</div>}
                description="先做一个模板：系统自动装好 Windows，你在里面装好常用软件。之后大家点「新建桌面」就能自己开一台。已经有装好桌面服务的电脑，也可以直接登记。" />
            )
          ) : (
            <EmptyState icon={<MonitorIcon />} title="还没有桌面" description="还没有模板，请主管先做一个。做好以后，你在这里点「新建桌面」就能自己开一台，扫码登录软件后 agent 就能用。" />
          )
        }
      >
        <MasterDetail
          hasSelection={!!selected}
          list={
            <>
              {machines.length > 0 && (
                <PickGroup label="桌面">
                  {machines.map((desktop) => (
                    <PickItem key={desktop.id} to={href("desktops", { id: desktop.id })} selected={desktop.id === selected?.id} title={desktop.name}
                      description={desktop.description || (desktop.vm?.templateName ? `从「${desktop.vm.templateName}」建的` : desktop.agentUrl)}
                      badge={<ListBadge desktop={desktop} />} />
                  ))}
                </PickGroup>
              )}
              {(templates.length > 0 || isAdmin) && (
                <PickGroup label="模板" action={isAdmin && templateButton("xs")}>
                  {templates.map((desktop) => (
                    <PickItem key={desktop.id} to={href("desktops", { id: desktop.id })} selected={desktop.id === selected?.id} title={desktop.name}
                      description={desktop.description || (desktop.vm ? `存在 ${desktop.vm.storagePath}` : "")}
                      badge={<ListBadge desktop={desktop} />} />
                  ))}
                  {templates.length === 0 && <p className="px-1 text-xs text-muted-foreground">还没有模板。点「做模板」，系统自动装好 Windows。</p>}
                </PickGroup>
              )}
            </>
          }
          detail={
            selected && (
              <DetailPanel
                title={selected.name}
                badges={<ListBadge desktop={selected} />}
                meta={metaOf(selected)}
                actions={
                  (viewable || menu) && (
                    <>
                      {viewable && (
                        <Button disabled={!powered(selected)} onClick={() => setWatching(selected)}><MonitorIcon data-icon="inline-start" />看画面</Button>
                      )}
                      {menu}
                    </>
                  )
                }
              >
                <DetailSection title={selected.kind === "template" ? "说明" : "给 agent 看的说明"}
                  description={selected.kind === "template" ? "新建桌面时选模板的人看这段话。" : "任务允许好几台桌面时，agent 按这段话挑用哪台。"}>
                  <p className="whitespace-pre-wrap">{selected.description || "（还没写说明）"}</p>
                </DetailSection>
                {selected.kind === "template" && <TemplateNowSection key={`now-${selected.id}`} desktop={selected} canManage={manageable} />}
                {selected.vm && <VmSection key={`vm-${selected.id}`} desktop={selected} canManage={manageable} all={all} />}
                {selected.kind === "manual" && <ConnectionSection key={`conn-${selected.id}`} desktop={selected} isAdmin={isAdmin} />}
                {selected.kind !== "template" && (
                  <DetailSection title="现在" description="同一时间一台桌面只给一个运行用。等人处理（例如扫码登录）时桌面保留给原来的运行，到时间没处理就自动放开。"
                    action={isAdmin && selected.use.state !== "free" && (
                      <Button size="sm" variant="outline" disabled={release.isPending} onClick={() => setConfirmRelease(true)}>
                        {release.isPending ? <Spinner data-icon="inline-start" /> : <UnlockIcon data-icon="inline-start" />}放开
                      </Button>
                    )}>
                    <UseText desktop={selected} />
                  </DetailSection>
                )}
              </DetailPanel>
            )
          }
        />
      </PageFrame>
      {dialog === "new" && host && <NewDesktopDialog templates={readyTemplates} host={host} onClose={() => setDialog(null)} />}
      {dialog === "template" && host && <TemplateDialog host={host} onClose={() => setDialog(null)} />}
      {(dialog === "register" || (dialog === "edit" && selected)) && (
        <DesktopDialog desktop={dialog === "edit" ? selected : undefined} onClose={() => setDialog(null)} />
      )}
      {watching && (
        <RemoteViewDialog
          open
          target={{ kind: "desktop", id: watching.id, name: watching.name }}
          title={`${watching.kind === "template" ? "模板" : "桌面"}「${watching.name}」`}
          description={watchingHint(watching, canManage(user, watching) || (watching.kind === "manual" && isAdmin))}
          viewOnly={!(watching.kind === "manual" ? isAdmin : canManage(user, watching))}
          onOpenChange={(open) => !open && setWatching(null)}
        />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除{selected?.kind === "template" ? "模板" : ""}「{selected?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>{selected && deleteText(selected)}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={!!selected?.vm?.usedBy} onClick={() => {
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

function metaOf(desktop: Desktop) {
  const changed = `改于 ${fmtShort(desktop.updatedAt)}`
  if (desktop.kind === "template") return `做于 ${fmtShort(desktop.createdAt)} · ${changed}`
  if (desktop.kind === "vm") return `${desktop.vm?.templateName ? `从模板「${desktop.vm.templateName}」建的 · ` : ""}建于 ${fmtShort(desktop.createdAt)}`
  return `登记于 ${fmtShort(desktop.createdAt)} · ${changed}`
}

function watchingHint(desktop: Desktop, canOperate: boolean) {
  if (!canOperate) return "只能看，不能操作。"
  if (desktop.kind === "template") return "在这里把大家要用的软件装好。不要登录任何账号：登录是每台桌面自己扫码。"
  return "可以直接操作：扫码登录软件、关掉弹框。正有运行在用时，别和 agent 抢着点。"
}

function deleteText(desktop: Desktop) {
  if (desktop.kind === "manual")
    return "这台桌面的登记和密钥会一起删掉，不能撤销；那台电脑上的软件和登录不受影响，以后可以重新登记。正有运行占着它时删不了，等用完或先「放开」再删。"
  if (desktop.kind === "template") {
    const usedBy = desktop.vm?.usedBy ?? 0
    if (usedBy > 0) return `有 ${usedBy} 台桌面是用这个模板建的，要先把它们都删掉，才能删模板。`
    return "模板会关机并删掉，不能撤销。以后要新建桌面，得重新做一个模板（又要装 1～3 小时）。"
  }
  const inUse = desktop.use.state !== "free" ? "它正被运行用着，删不了：等用完，或请主管先「放开」。" : ""
  return `${inUse}这台桌面会关机并删掉：里面装的软件、存的文件、软件的登录全都没了，不能撤销。`
}

/** 列表和标题旁的徽章：有运行在用时显示占用（运行中 / 等人处理），否则系统开的显示开着 / 关着…，手动登记的显示空着 */
function ListBadge({ desktop }: { desktop: Desktop }) {
  if (desktop.vm && desktop.use.state === "free") return <VmStateBadge state={desktop.vm.state} />
  const { label, variant } = DESKTOP_STATE[desktop.use.state]
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

// ---------- 系统开的桌面、模板 ----------

/** 桌面这时候是什么情况、要等多久（只给系统开的桌面；模板的在 TemplateNowSection） */
function vmStatusText(desktop: Desktop, canManage: boolean): string | undefined {
  switch (desktop.vm?.state) {
    case "creating": return "正在准备这台桌面（照着模板复制），一般不到 1 分钟，好了会自动开机。"
    case "starting": return "正在开机，大约 1～2 分钟。开好后状态变成「开着」，就能看画面了。"
    case "running": return desktop.use.state === "free" ? (canManage ? "开着。要登录软件就点右上角「看画面」，用手机扫码。" : "开着。") : undefined
    case "stopping": return "正在关机…"
    case "stopped": return canManage ? "关着。agent 用不了关着的桌面，要用就点「开机」。" : "关着，agent 用不了。建这台桌面的人或主管可以开机。"
    case "deleting": return "正在删除…"
    default: return undefined
  }
}

const ACTION_DONE: Record<DesktopVmAction["action"], string> = {
  start: "正在开机，大约 1～2 分钟",
  stop: "正在关机",
  restart: "正在重启，大约 1～2 分钟",
  reset: "正在重置，好了会自动开机。记得重新扫码登录软件",
  seal: "正在关机、做成模板，好了就能用它新建桌面",
}

/** 「这台虚拟机」：状态、存在哪里、内存、CPU、磁盘占用、从哪个模板建的；系统开的桌面在这里开机、关机、重启、重置 */
function VmSection({ desktop, canManage, all }: { desktop: Desktop; canManage: boolean; all: Desktop[] }) {
  const vm = desktop.vm!
  const [confirm, setConfirm] = React.useState<"stop" | "restart" | "reset" | null>(null)
  const act = useAction(trpc.desktops.vmAction.mutationOptions(), { success: (_data, vars) => ACTION_DONE[vars.action] })
  const inUse = desktop.use.state !== "free"
  const isVm = desktop.kind === "vm"
  const busy = vmBusy(vm.state) || act.isPending
  const template = vm.templateId ? findById(all, vm.templateId) : undefined
  const status = isVm ? vmStatusText(desktop, canManage) : undefined

  // 关机、重启：有运行在用时先确认（会打断它，带 force）；没人用就直接做。重置一律确认
  const run = (action: "start" | "stop" | "restart" | "reset") => {
    if (action === "reset" || (action !== "start" && inUse)) return setConfirm(action)
    act.mutate({ id: desktop.id, action })
  }
  const interrupt = inUse ? `它正被运行${desktop.use.taskTitle ? `「${desktop.use.taskTitle}」` : ""}用着，这样做会打断正在用它的运行。` : ""

  return (
    <DetailSection title="这台虚拟机" description="系统在这台服务器上开的 Windows 虚拟机。地址和密钥由系统管，不用填。">
      <div className="flex flex-col gap-4">
        {vm.state === "error" && isVm && (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>出错了</AlertTitle>
            <AlertDescription>
              {vm.message ?? "这台桌面出了问题。"}
              {canManage ? " 可以点「开机」再试一次；还不行就删掉，重新建一台。" : " 请建这台桌面的人或主管处理。"}
            </AlertDescription>
          </Alert>
        )}
        {status && <p className="flex items-center gap-2">{vmBusy(vm.state) && <Spinner />}{status}</p>}
        <dl className="grid gap-3 sm:grid-cols-2">
          <Fact label="状态" value={`${vmStateLabel(vm.state)} · 从 ${fmtShort(vm.stateSince)} 起`} />
          <Fact label="存在哪里" value={`${vm.storagePath} · ${DISK_LABEL[vm.diskKind]}`} />
          <Fact label="内存" value={`${vm.memoryGb} GB`} />
          <Fact label="CPU" value={`${vm.cpus} 核`} />
          {vm.diskUsedGb !== undefined && <Fact label="磁盘占用" value={`${vm.diskUsedGb.toFixed(1)} GB`} />}
          {isVm && (
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">从哪个模板建的</dt>
              <dd>{template ? <a href={href("desktops", { id: template.id })} className={LINK}>{template.name}</a> : vm.templateName ?? "（模板已经删了）"}</dd>
            </div>
          )}
          {!isVm && vm.usedBy !== undefined && <Fact label="用它建的桌面" value={`${vm.usedBy} 台`} />}
        </dl>
        {isVm && canManage && (
          <div className="flex flex-wrap gap-2">
            {(vm.state === "stopped" || vm.state === "error") && (
              <Button size="sm" disabled={busy} onClick={() => run("start")}><PowerIcon data-icon="inline-start" />开机</Button>
            )}
            {vm.state === "running" && (
              <>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run("stop")}><PowerOffIcon data-icon="inline-start" />关机</Button>
                <Button size="sm" variant="outline" disabled={busy} onClick={() => run("restart")}><RotateCwIcon data-icon="inline-start" />重启</Button>
              </>
            )}
            {(vm.state === "running" || vm.state === "stopped" || vm.state === "error") && (
              <Button size="sm" variant="outline" disabled={busy} onClick={() => run("reset")}><RotateCcwIcon data-icon="inline-start" />重置</Button>
            )}
          </div>
        )}
      </div>
      <AlertDialog open={confirm !== null} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirm === "reset" ? `重置「${desktop.name}」？` : confirm === "stop" ? `关掉「${desktop.name}」？` : `重启「${desktop.name}」？`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {interrupt && <>{interrupt}<br /></>}
              {confirm === "reset"
                ? "重置 = 恢复成刚从模板复制出来的样子：后来装的软件、存的文件都没了，软件的登录会没掉，要重新扫码。不能撤销。"
                : confirm === "stop"
                  ? "关机后 agent 用不了它，要用时再点「开机」。软件的登录不会没掉。"
                  : "重启大约要 1～2 分钟，这段时间 agent 用不了它。软件的登录不会没掉。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => {
              if (confirm) act.mutate({ id: desktop.id, action: confirm, ...(inUse ? { force: true } : {}) })
              setConfirm(null)
            }}>
              {confirm === "reset" ? "确认重置" : confirm === "stop" ? (inUse ? "仍然关机" : "关机") : inUse ? "仍然重启" : "重启"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSection>
  )
}

/** 模板的「现在」：在装 Windows（装了多久）/ 等装软件（两步 +「做成模板」）/ 做好了（几台桌面在用） */
function TemplateNowSection({ desktop, canManage }: { desktop: Desktop; canManage: boolean }) {
  const vm = desktop.vm!
  const minutes = useMinutesSince(vm.stateSince)
  const [confirmSeal, setConfirmSeal] = React.useState(false)
  const seal = useAction(trpc.desktops.vmAction.mutationOptions(), { success: ACTION_DONE.seal })
  const expect = vm.diskKind === "hdd" ? "放在机械硬盘上，大约要 3 小时" : vm.diskKind === "ssd" ? "SSD 上大约 1 小时" : "SSD 上大约 1 小时，机械硬盘上约 3 小时"

  let body: React.ReactNode
  switch (vm.state) {
    case "creating":
      body = <p className="flex items-center gap-2"><Spinner />正在准备，马上开始装 Windows。</p>
      break
    case "installing":
      body = (
        <div className="flex flex-col gap-1">
          <p className="flex items-center gap-2"><Spinner />正在自动安装 Windows，已经 {durationText(minutes)}（{expect}）。</p>
          <p className="text-muted-foreground">不用守着，关掉页面也照样装。装好了会自动开机，这里会提示下一步。</p>
        </div>
      )
      break
    case "setup":
      body = !canManage ? (
        <p>Windows 装好了，等主管把常用软件装好、做成模板，就能用它新建桌面。</p>
      ) : (
        <div className="flex flex-col gap-3">
          <p>Windows 装好了，还差两步：</p>
          <ol className="flex list-decimal flex-col gap-1 pl-5">
            <li>点右上角「看画面」，把大家要用的软件装好。<strong>不要登录任何账号</strong>：登录是每台桌面自己扫码。</li>
            <li>都装好后，点下面的「做成模板」。系统会关机，之后这个模板就不能再改了。</li>
          </ol>
          {canManage && (
            <Button className="self-start" variant="outline" disabled={seal.isPending} onClick={() => setConfirmSeal(true)}>
              {seal.isPending ? <Spinner data-icon="inline-start" /> : <StampIcon data-icon="inline-start" />}做成模板
            </Button>
          )}
        </div>
      )
      break
    case "stopping":
      body = <p className="flex items-center gap-2"><Spinner />正在关机、做成模板，一般几分钟。</p>
      break
    case "ready":
      body = (
        <p className="flex items-center gap-2">
          <CircleCheckIcon className="text-muted-foreground" />
          做好了，有 {vm.usedBy ?? 0} 台桌面用它。大家点「新建桌面」、选这个模板，就能复制一台。
        </p>
      )
      break
    case "error":
      body = (
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>出错了</AlertTitle>
          <AlertDescription>{vm.message ?? "做模板时出了问题。"} 删掉这个模板，重新做一个。</AlertDescription>
        </Alert>
      )
      break
    default:
      body = <p className="flex items-center gap-2">{vmBusy(vm.state) && <Spinner />}{vmStateLabel(vm.state)}</p>
  }

  return (
    <DetailSection title="现在" description="做模板分三步：系统自动装 Windows → 你在画面里装常用软件 → 点「做成模板」。做好后只读，大家从它复制新桌面。">
      {body}
      <AlertDialog open={confirmSeal} onOpenChange={setConfirmSeal}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>把「{desktop.name}」做成模板？</AlertDialogTitle>
            <AlertDialogDescription>
              系统会让这台 Windows 关机，模板从此只读、不能再装软件；要改得重新做一个模板。软件都装好了吗？没有登录任何账号吧？
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>还没装好</AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setConfirmSeal(false)
              seal.mutate({ id: desktop.id, action: "seal" })
            }}>做成模板</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSection>
  )
}

// ---------- 手动登记的 ----------

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
