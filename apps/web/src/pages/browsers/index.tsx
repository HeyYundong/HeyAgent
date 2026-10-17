import * as React from "react"
import { AppWindowIcon, CircleCheckIcon, EllipsisIcon, GaugeIcon, LogInIcon, PencilIcon, PlusIcon, Trash2Icon, TriangleAlertIcon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { accountStatusLabel, can, findById, fmtDateTime, type BrowserSite } from "@heyagent/shared"

import { useBrowsersQuery, usePlatformsQuery, useSessionsQuery, useStaffName, useStaffQuery, useTasksQuery } from "@/lib/data"
import { readOnlyToast } from "@/lib/readonly"
import { href, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"

import { BrowserDialog } from "./browser-dialog"
import { BrowserViewDialog, type Login } from "./browser-view-dialog"
import { limitText, problemCount, proxyRows, proxyText, recentRunsUsing, siteKey, usePlatformName, vaultRows, type Chrome } from "./data"
import { SiteLimitDialog } from "./site-limit-dialog"

const LINK = "underline underline-offset-4 hover:text-foreground"

// M0 只读：新建、编辑、删除、改并发上限、在远程画面里「保存登录状态」照原型显示，真正提交时弹「只读阶段」提示。
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
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const selected = findById(list, params.get("id"))

  function remove() {
    setConfirmDelete(false)
    readOnlyToast()
  }

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
    <PageFrame
      queries={queries}
      isEmpty={list.length === 0}
      header={
        <SimpleHeader
          title="浏览器"
          description="服务器上的 Chrome：各有自己的代理和一份登录态，所有 agent 共用。"
          learnId="browsers"
          action={isAdmin && <Button onClick={() => setDialog("new")}><PlusIcon data-icon="inline-start" />新建 Chrome</Button>}
        />
      }
      empty={
        <EmptyState icon={<AppWindowIcon />} title="还没有 Chrome" description="新建一个 Chrome，进去登录一次账号，之后所有 agent 都能带着登录态用它。" />
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
                description="人在远程画面里登录一次，保存后所有 agent 都能用。并发上限按账号设：同一账号多处同时登录容易被平台风控，不同账号互不影响。">
                {selected.sites.length === 0 ? (
                  <p className="text-muted-foreground">还没登录过网站。点「打开浏览器」进去登录，保存后会出现在这里。</p>
                ) : (
                  <ItemGroup className="gap-2">
                    {selected.sites.map((site) => (
                      <SiteRow key={siteKey(site)} site={site} onLogin={() => setView({ site })} onLimit={isAdmin ? () => setLimitSite(site) : undefined} />
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

      {dialog && (
        <BrowserDialog profile={dialog === "edit" ? selected : undefined} onClose={() => setDialog(null)}
          onSave={readOnlyToast} />
      )}
      {view && selected && (
        <BrowserViewDialog profile={selected} site={view.site} onSave={readOnlyToast} onClose={() => setView(null)} />
      )}
      {limitSite && selected && (
        <SiteLimitDialog site={limitSite} onSave={readOnlyToast} onClose={() => setLimitSite(null)} />
      )}
      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除「{selected?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              保险箱里的 {selected?.cookieCount} 个 cookie 会一起删除，登录过的网站都要重新登录。选用它的 agent
              会换别的 Chrome，没有合适的就停下来等人。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={remove}>确认删除</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageFrame>
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

/** onLimit 只有主管有：「⋯」里改这个账号的并发上限 */
function SiteRow({ site, onLogin, onLimit }: { site: BrowserSite; onLogin: () => void; onLimit?: () => void }) {
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
        {onLimit && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="这个账号的更多操作" />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onLimit}><GaugeIcon />改并发上限</DropdownMenuItem>
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
