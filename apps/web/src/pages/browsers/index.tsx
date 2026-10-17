import * as React from "react"
import { AppWindowIcon, CircleCheckIcon, EllipsisIcon, GaugeIcon, LogInIcon, PencilIcon, PlusIcon, Trash2Icon, TriangleAlertIcon, UserPlusIcon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { toast } from "@/components/ui/toast"
import { accountStatusLabel, can, findById, fmtDateTime, type BrowserSite } from "@heyagent/shared"

import { useBrowsersQuery, usePlatformsQuery, useSessionsQuery, useStaffName, useStaffQuery, useTasksQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { trpc } from "@/lib/trpc"
import { useMe } from "@/lib/session"

import { AccountDialog } from "./account-dialog"
import { BrowserDialog } from "./browser-dialog"
import { BrowserViewDialog, type Login } from "./browser-view-dialog"
import { limitText, problemCount, proxyRows, proxyText, recentRunsUsing, siteKey, usePlatformName, vaultRows, type Chrome } from "./data"
import { SiteLimitDialog } from "./site-limit-dialog"

const LINK = "underline underline-offset-4 hover:text-foreground"

// 写操作（M1 接通）：新建 / 编辑 / 删除 Chrome，加账号、改并发上限、删账号（都只有主管）。
// 远程画面里的「保存登录状态」要真的起 Chrome，M2 才接通，现在点了只提示。
function saveLoginLater() {
  toast.add({ title: "保存登录状态 M2 接通", description: "现在的远程画面是模拟的，登录态还存不进保险箱。", type: "info" })
}

export default function BrowsersPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  const { params } = useRoute()
  const browsersQuery = useBrowsersQuery()
  // 平台名、登录人、最近选用它的运行
  const queries = [browsersQuery, usePlatformsQuery(), useStaffQuery(), useSessionsQuery(), useTasksQuery()]
  const list = browsersQuery.data ?? []
  const [dialog, setDialog] = React.useState<"new" | "edit" | null>(null)
  const [view, setView] = React.useState<{ site?: Login } | null>(null)
  const [limitSite, setLimitSite] = React.useState<BrowserSite | null>(null)
  const [deleteSite, setDeleteSite] = React.useState<BrowserSite | null>(null)
  const [addAccount, setAddAccount] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const selected = findById(list, params.get("id"))
  const platformName = usePlatformName()
  // 有 session 正占着它的账号时后端会拒绝（CONFLICT），toast 里显示原因
  const removeProfile = useAction(trpc.browsers.delete.mutationOptions({ onSuccess: () => setParams({ id: null }) }), { success: "Chrome 已删除" })
  const removeAccount = useAction(trpc.browsers.deleteAccount.mutationOptions(), { success: "账号已删除" })

  function remove() {
    setConfirmDelete(false)
    if (selected) removeProfile.mutate({ id: selected.id })
  }

  function removeSite() {
    if (deleteSite) removeAccount.mutate({ id: deleteSite.accountId })
    setDeleteSite(null)
  }

  const newButton = <Button onClick={() => setDialog("new")}><PlusIcon data-icon="inline-start" />新建 Chrome</Button>

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
        queries={queries}
        isEmpty={list.length === 0}
        header={
          <SimpleHeader
            title="浏览器"
            description="服务器上的 Chrome：各有自己的代理和一份登录态，所有 agent 共用。"
            learnId="browsers"
            action={isAdmin && newButton}
          />
        }
        empty={
          isAdmin ? (
            <EmptyState icon={<AppWindowIcon />} title="还没有 Chrome" action={newButton}
              description="点右上角「新建 Chrome」，填好代理，然后加要登录的平台账号。登录一次以后，所有 agent 都能带着登录态用它。" />
          ) : (
            <EmptyState icon={<AppWindowIcon />} title="还没有 Chrome" description="还没有 Chrome，由主管新建。建好、登录过账号以后，agent 就能用它上网干活。" />
          )
        }
      >
        <MasterDetail
          hasSelection={!!selected}
          list={
            <PickGroup>
              {list.map((profile) => (
                <PickItem key={profile.id} to={href("browsers", { id: profile.id })} selected={profile.id === selected?.id} title={profile.name}
                  description={`${proxyText(profile.proxy)} · ${profile.exitIp}`}
                  badge={problemCount(profile) > 0 && <Badge variant="destructive">{problemCount(profile)} 个要登录</Badge>}
                />
              ))}
            </PickGroup>
          }
          detail={
            selected && (
              <DetailPanel
                title={selected.name}
                badges={<Badge variant={selected.running ? "secondary" : "outline"}>{selected.running ? `开着 ${selected.running} 个 session` : "空闲"}</Badge>}
                meta={`出口 ${selected.exitIp} · 保险箱 v${selected.vaultVersion} · 更新于 ${fmtDateTime(selected.updatedAt)}`}
                actions={
                  <>
                    <Button onClick={() => setView({})}><AppWindowIcon data-icon="inline-start" />打开浏览器</Button>
                    {isAdmin && menu}
                  </>
                }
              >
                <AgentNote profile={selected} />
                <DetailSection title="代理">
                  {selected.proxy.kind === "socks5" ? <Facts rows={proxyRows(selected)} /> : <p>不用代理，直接出网。出口 IP：{selected.exitIp}。</p>}
                </DetailSection>
                <DetailSection title="登录过的网站"
                  description="人在远程画面里登录一次，保存后所有 agent 都能用。并发上限按账号设：同一账号多处同时登录容易被平台风控，不同账号互不影响。"
                  action={isAdmin && <Button size="sm" variant="outline" onClick={() => setAddAccount(true)}><UserPlusIcon data-icon="inline-start" />加账号</Button>}>
                  {selected.sites.length === 0 ? (
                    <p className="text-muted-foreground">
                      {isAdmin ? "还没有账号。点「加账号」选平台、填账号，再在远程画面里登录一次。" : "还没有账号，由主管来加。"}
                    </p>
                  ) : (
                    <ItemGroup className="gap-2">
                      {selected.sites.map((site) => (
                        <SiteRow key={siteKey(site)} site={site} onLogin={() => setView({ site })}
                          admin={isAdmin ? { onLimit: () => setLimitSite(site), onDelete: () => setDeleteSite(site) } : undefined} />
                      ))}
                    </ItemGroup>
                  )}
                </DetailSection>
                <DetailSection title="登录态保险箱" description="所有 agent 共用这份 cookie 和 session，用完把变化合并回来。">
                  <div className="flex flex-col gap-3">
                    <Facts rows={vaultRows(selected)} />
                    <p className="text-xs text-muted-foreground">
                      每个任务临时起一个干净的 Chrome，先装进这份登录态；用完只把变了的 cookie 合并回来，再关掉浏览器。
                      某个账号同时在用的 session 满了，要用它的任务排队。cookie 不会给 agent 看。
                    </p>
                  </div>
                </DetailSection>
              </DetailPanel>
            )
          }
        />
      </PageFrame>
      {dialog && (
        <BrowserDialog profile={dialog === "edit" ? selected : undefined} onClose={() => setDialog(null)} />
      )}
      {view && selected && (
        <BrowserViewDialog profile={selected} site={view.site} onSave={saveLoginLater} onClose={() => setView(null)} />
      )}
      {limitSite && selected && <SiteLimitDialog site={limitSite} onClose={() => setLimitSite(null)} />}
      {addAccount && selected && <AccountDialog profile={selected} onClose={() => setAddAccount(false)} />}
      <AlertDialog open={!!deleteSite} onOpenChange={(open) => !open && setDeleteSite(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除账号「{deleteSite && `${platformName(deleteSite.platformId)} · ${deleteSite.account}`}」？</AlertDialogTitle>
            <AlertDialogDescription>
              这个账号会从「{selected?.name}」里去掉，要用它的 agent 找不到登录态就会停下来等人。保险箱里其他账号不受影响。
              以后还要用，得重新加账号、重新登录。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={removeSite}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{selected?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              保险箱里的 {selected?.cookieCount} 个 cookie 和 {selected?.sites.length} 个账号会一起删除，不能撤销，以后要重新加账号、重新登录。
              选用它的 agent 会换别的 Chrome，没有合适的就停下来等人。正有 session 在用它时删不了，等用完再删。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function AgentNote({ profile }: { profile: Chrome }) {
  const recent = recentRunsUsing(profile.id, useSessionsQuery().data ?? [], useTasksQuery().data ?? [])
  return (
    <DetailSection title="给 agent 的说明" description="agent 靠这句话自己选用哪个 Chrome。">
      <div className="flex flex-col gap-2">
        <p>{profile.description || "（还没写说明，agent 不会主动选它）"}</p>
        {recent.length > 0 && (
          <p className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
            最近选用它的运行：
            {recent.map(({ run, task }) => (
              <a key={run.id} href={href("tasks", { id: run.taskId, run: run.id })} className={LINK}>{run.id} {task?.title}</a>
            ))}
          </p>
        )}
      </div>
    </DetailSection>
  )
}

/** admin 只有主管有：「⋯」里改这个账号的并发上限、删除账号 */
function SiteRow({ site, onLogin, admin }: { site: BrowserSite; onLogin: () => void; admin?: { onLimit: () => void; onDelete: () => void } }) {
  const staffName = useStaffName()
  const platformName = usePlatformName()
  const ok = site.status === "ok"
  return (
    <Item size="sm" variant="outline">
      <ItemContent className="min-w-0">
        <ItemTitle>{platformName(site.platformId)} · {site.account}</ItemTitle>
        <ItemDescription>上次登录 {fmtDateTime(site.lastLoginAt)} · {staffName(site.loggedInById)}</ItemDescription>
        <ItemDescription>{limitText(site)}</ItemDescription>
      </ItemContent>
      <ItemActions className="basis-full sm:basis-auto">
        <Badge variant={ok ? "outline" : "destructive"}>
          {ok ? <CircleCheckIcon data-icon="inline-start" /> : <TriangleAlertIcon data-icon="inline-start" />}
          {accountStatusLabel[site.status]}
        </Badge>
        {!ok && <Button size="sm" variant="outline" onClick={onLogin}><LogInIcon data-icon="inline-start" />去登录</Button>}
        {admin && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="这个账号的更多操作" />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={admin.onLimit}><GaugeIcon />改并发上限</DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={admin.onDelete}><Trash2Icon />删除账号</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </ItemActions>
    </Item>
  )
}

function Facts({ rows }: { rows: [string, string][] }) {
  return (
    <dl className="flex flex-wrap gap-x-10 gap-y-3">
      {rows.map(([label, value]) => (
        <div key={label} className="flex flex-col gap-0.5"><dt className="text-xs text-muted-foreground">{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  )
}
