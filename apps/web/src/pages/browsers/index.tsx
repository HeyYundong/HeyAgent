import * as React from "react"
import { AppWindowIcon, CircleCheckIcon, EllipsisIcon, EyeIcon, GaugeIcon, GlobeIcon, MonitorIcon, PencilIcon, PlusIcon, Trash2Icon, TriangleAlertIcon, UserPlusIcon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { RemoteViewDialog } from "@/components/remote-view/remote-view-dialog"
import { accountStatusLabel, can, findById, fmtDateTime, fmtShort, type BrowserSite, type LiveBrowser, type Platform } from "@heyagent/shared"

import { useQuery } from "@tanstack/react-query"

import { useBrowsersQuery, usePlatformsQuery, useSessionsQuery, useStaffName, useStaffQuery, useTasksQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { trpc } from "@/lib/trpc"
import { useMe } from "@/lib/session"

import { AccountDialog } from "./account-dialog"
import { BrowserDialog } from "./browser-dialog"
import {
  LIVE_STATE, problemCount, profileRows, proxyText, recentRunsUsing, siteKey, usageText, useAccountStatusQuery, useLiveBrowsersQuery, usePlatformName, type Chrome,
} from "./data"
import { LoginBrowserDialog, OpenLoginButton, useOpenLogin } from "./login-browser"
import { PlatformDialog } from "./platform-dialog"
import { SiteLimitDialog } from "./site-limit-dialog"

const LINK = "underline underline-offset-4 hover:text-foreground"

// 写操作：新建 / 编辑 / 删除 Chrome，加账号、改并发上限、改平台域名、删账号（都只有主管）。
// M2 起：「打开 Chrome」真的在服务器上起 Chrome（远程画面），保存登录状态进保险箱；开着的 Chrome、账号使用情况随实时推送刷新。

export default function BrowsersPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  const { params } = useRoute()
  const browsersQuery = useBrowsersQuery()
  const liveQuery = useLiveBrowsersQuery()
  const platformsQuery = usePlatformsQuery()
  // 平台名、登录人、最近选用它的运行、开着的 Chrome、账号使用情况
  const queries = [browsersQuery, platformsQuery, useStaffQuery(), useSessionsQuery(), useTasksQuery(), liveQuery, useAccountStatusQuery()]
  const list = browsersQuery.data ?? []
  const live = liveQuery.data ?? []
  const [dialog, setDialog] = React.useState<"new" | "edit" | null>(null)
  const [limitSite, setLimitSite] = React.useState<BrowserSite | null>(null)
  const [deleteSite, setDeleteSite] = React.useState<BrowserSite | null>(null)
  const [editPlatform, setEditPlatform] = React.useState<Platform | null>(null)
  const [watching, setWatching] = React.useState<LiveBrowser | null>(null)
  const [addAccount, setAddAccount] = React.useState(false)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const selected = findById(list, params.get("id"))
  const platformName = usePlatformName()
  const login = useOpenLogin()
  const staffName = useStaffName()
  // 有 session 正占着它的账号时后端会拒绝（CONFLICT），toast 里显示原因
  const removeProfile = useAction(trpc.browsers.delete.mutationOptions({ onSuccess: () => setParams({ id: null }) }), { success: "Chrome 已删除" })
  const removeAccount = useAction(trpc.browsers.deleteAccount.mutationOptions(), { success: "账号已删除" })
  const liveOf = (profileId: string) => live.filter((each) => each.profileId === profileId)
  const tasks = useTasksQuery().data ?? []
  const taskTitle = (taskId?: string) => (taskId ? findById(tasks, taskId)?.title : undefined)
  const accountName = (accountId: string) => {
    const site = list.flatMap((profile) => profile.sites).find((each) => each.accountId === accountId)
    return site ? `${platformName(site.platformId)} · ${site.account}` : accountId
  }

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

  const selectedLive = selected ? liveOf(selected.id) : []
  const openedProfile = login.opened && findById(list, login.opened.target.profileId)

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
              {list.map((profile) => {
                return (
                  <PickItem key={profile.id} to={href("browsers", { id: profile.id })} selected={profile.id === selected?.id} title={profile.name}
                    description={[proxyText(profile.proxy), profile.exitIp].filter(Boolean).join(" · ")}
                    badge={
                      <>
                        {problemCount(profile) > 0 && <Badge variant="destructive">{problemCount(profile)} 个要登录</Badge>}
                        <SessionCount profile={profile} live={liveOf(profile.id)} />
                      </>
                    }
                  />
                )
              })}
            </PickGroup>
          }
          detail={
            selected && (
              <DetailPanel
                title={selected.name}
                badges={<SessionCount profile={selected} live={selectedLive} />}
                actions={
                  <>
                    <OpenLoginButton pending={login.pending && !login.pendingTarget?.accountId} onClick={() => void login.start({ profileId: selected.id })} />
                    {isAdmin && menu}
                  </>
                }
              >
                <AgentNote profile={selected} />
                <DetailSection title="当前的 session" description="正在运行的 Chrome 窗口。「查看」只看画面，不能操作。">
                  {selectedLive.length === 0 ? (
                    <p className="text-muted-foreground">现在没有开着的 Chrome。</p>
                  ) : (
                    <ItemGroup className="gap-2">
                      {selectedLive.map((browser) => (
                        <LiveRow key={browser.browserId} browser={browser} taskTitle={taskTitle(browser.taskId)} openedBy={staffName(browser.openedById)} onWatch={() => setWatching(browser)} />
                      ))}
                    </ItemGroup>
                  )}
                </DetailSection>
                <DetailSection title="登录过的网站"
                  action={isAdmin && <Button size="sm" variant="outline" onClick={() => setAddAccount(true)}><UserPlusIcon data-icon="inline-start" />加账号</Button>}>
                  {selected.sites.length === 0 ? (
                    <p className="text-muted-foreground">
                      {isAdmin ? "还没有账号。点「加账号」选平台、填账号，再点「打开 Chrome」在远程画面里登录一次。" : "还没有账号，由主管来加。"}
                    </p>
                  ) : (
                    <ItemGroup className="gap-2">
                      {selected.sites.map((site) => (
                        <SiteRow key={siteKey(site)} site={site}
                          login={{ pending: login.pending && login.pendingTarget?.accountId === site.accountId, onClick: () => void login.start({ profileId: selected.id, accountId: site.accountId }) }}
                          admin={isAdmin ? {
                            onLimit: () => setLimitSite(site),
                            onPlatform: () => setEditPlatform(findById(platformsQuery.data ?? [], site.platformId) ?? null),
                            onDelete: () => setDeleteSite(site),
                          } : undefined} />
                      ))}
                    </ItemGroup>
                  )}
                </DetailSection>
                <DetailSection title="代理、时区和登录态">
                  <Facts rows={profileRows(selected)} />
                </DetailSection>
                <History profileId={selected.id} />
              </DetailPanel>
            )
          }
        />
      </PageFrame>
      {dialog && (
        <BrowserDialog profile={dialog === "edit" ? selected : undefined} onClose={() => setDialog(null)} />
      )}
      {login.opened && (
        <LoginBrowserDialog
          key={login.opened.browserId}
          browserId={login.opened.browserId}
          title={openedProfile ? openedProfile.name : login.opened.target.profileId}
          description={
            login.opened.target.accountId
              ? `在画面里登录「${accountName(login.opened.target.accountId)}」，关掉就保存。`
              : "关掉就保存 cookie 和登录状态。"
          }
          accountName={accountName}
          onClose={login.clear}
        />
      )}
      {watching && (
        <RemoteViewDialog
          open
          browserId={watching.browserId}
          title={watching.kind === "session" ? `运行 ${watching.sessionId ?? ""}` : `${staffName(watching.openedById)} 打开的 Chrome`}
          description={`${LIVE_STATE[watching.state]}${watching.holdUntil ? `，保留到 ${fmtShort(watching.holdUntil)}` : ""} · 只能看`}
          viewOnly
          onOpenChange={(open) => !open && setWatching(null)}
        />
      )}
      {limitSite && selected && <SiteLimitDialog site={limitSite} onClose={() => setLimitSite(null)} />}
      {editPlatform && <PlatformDialog platform={editPlatform} onClose={() => setEditPlatform(null)} />}
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
    <DetailSection title="给 agent 的说明">
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

const HISTORY_ROWS = 50

/** 操作历史：agent 在这个 Chrome 里做过什么。同一次运行在同一个网址上连着做的动作合成一行 */
function History({ profileId }: { profileId: string }) {
  const query = useQuery(trpc.browser.history.queryOptions({ profileId }))
  const rows = query.data ?? []
  return (
    <DetailSection title="操作历史">
      {query.isPending ? (
        <Skeleton className="h-24 w-full" />
      ) : query.isError ? (
        <p className="text-destructive">操作历史没取到：{query.error.message}</p>
      ) : rows.length === 0 ? (
        <p className="text-muted-foreground">还没有操作记录。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow><TableHead>时间</TableHead><TableHead>网站 URL</TableHead><TableHead>动作</TableHead></TableRow>
          </TableHeader>
          <TableBody>
            {rows.slice(0, HISTORY_ROWS).map((row) => (
              <TableRow key={`${row.at}-${row.url}-${row.sessionId ?? ""}`}>
                <TableCell>{fmtDateTime(row.at)}</TableCell>
                <TableCell className="w-full max-w-0"><div className="truncate" title={row.url}>{row.url}</div></TableCell>
                <TableCell>
                  <div className="flex gap-1">
                    {row.actions.map((action) => (
                      <Badge key={action.tag} variant={action.failed ? "destructive" : "outline"}>
                        {action.tag}{action.count > 1 ? ` ×${action.count}` : ""}
                      </Badge>
                    ))}
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </DetailSection>
  )
}

/** 现在有几个运行（session）在用这个 Chrome / 同时最多几个。人「打开 Chrome」开的不算 */
function SessionCount({ profile, live }: { profile: Chrome; live: LiveBrowser[] }) {
  const used = live.filter((each) => each.kind === "session" && each.state !== "closing").length
  return <Badge variant={used ? "secondary" : "outline"}>{used}/{profile.maxSessions} 个 session 在用</Badge>
}

/** 开着的一个 Chrome：哪个任务的哪次运行在用（点了去任务）或谁打开的、现在在哪个页面、状态、几个人在看 */
function LiveRow({ browser, taskTitle, openedBy, onWatch }: { browser: LiveBrowser; taskTitle?: string; openedBy: string; onWatch: () => void }) {
  const ready = browser.state === "running" || browser.state === "held"
  const page = [browser.title, browser.url].filter(Boolean).join(" · ") || "空白页"
  return (
    <Item size="sm" variant="outline">
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">
          {browser.kind === "session" && browser.sessionId ? (
            <a href={browser.taskId ? href("tasks", { id: browser.taskId, run: browser.sessionId }) : href("sessions", { id: browser.sessionId })} className={LINK}>
              {taskTitle ? `${taskTitle} · ${browser.sessionId}` : `运行 ${browser.sessionId}`}
            </a>
          ) : (
            <span>{openedBy} 打开的</span>
          )}
          <Badge variant={browser.state === "held" ? "default" : "secondary"}>{LIVE_STATE[browser.state]}</Badge>
        </ItemTitle>
        <ItemDescription className="truncate" title={page}>{page}</ItemDescription>
        <ItemDescription>
          开始 {fmtShort(browser.startedAt)}
          {browser.holdUntil && ` · 保留到 ${fmtShort(browser.holdUntil)}`}
          {` · ${browser.viewers.length ? `${browser.viewers.length} 人在看` : "没人在看"}`}
        </ItemDescription>
      </ItemContent>
      <ItemActions className="basis-full sm:basis-auto">
        <Button size="sm" variant="outline" disabled={!ready} onClick={onWatch}><EyeIcon data-icon="inline-start" />查看</Button>
      </ItemActions>
    </Item>
  )
}

/** admin 只有主管有：「⋯」里改这个账号的并发上限、改平台域名、删除账号 */
function SiteRow({ site, login, admin }: {
  site: BrowserSite
  login: { pending: boolean; onClick: () => void }
  admin?: { onLimit: () => void; onPlatform: () => void; onDelete: () => void }
}) {
  const staffName = useStaffName()
  const platformName = usePlatformName()
  const platform = findById(usePlatformsQuery().data ?? [], site.platformId)
  const usage = useAccountStatusQuery().data?.find((each) => each.accountId === site.accountId)
  const ok = site.status === "ok"
  return (
    <Item size="sm" variant="outline">
      <ItemContent className="min-w-0">
        <ItemTitle>{platformName(site.platformId)} · {site.account}</ItemTitle>
        <ItemDescription>上次登录 {fmtDateTime(site.lastLoginAt)} · {staffName(site.loggedInById)}</ItemDescription>
        <ItemDescription>
          {usageText(usage ?? { used: site.running, max: site.maxConcurrent, waiting: 0 })}
          {usage && usage.sessionIds.length > 0 && (
            <>
              {" · 在用："}
              {usage.sessionIds.map((id, index) => (
                <React.Fragment key={id}>{index > 0 && "、"}<a href={href("sessions", { id })} className={LINK}>{id}</a></React.Fragment>
              ))}
            </>
          )}
        </ItemDescription>
        <ItemDescription className="truncate">{platform?.domains.length ? `域名：${platform.domains.join("、")}` : "平台没填域名（打开网址时不占这个账号的名额）"}</ItemDescription>
      </ItemContent>
      <ItemActions className="basis-full sm:basis-auto">
        <Badge variant={ok ? "outline" : "destructive"}>
          {ok ? <CircleCheckIcon data-icon="inline-start" /> : <TriangleAlertIcon data-icon="inline-start" />}
          {accountStatusLabel[site.status]}
        </Badge>
        {!ok && <OpenLoginButton size="sm" variant="outline" label="去登录" pending={login.pending} onClick={login.onClick} />}
        {admin && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="这个账号的更多操作" />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {ok && <DropdownMenuItem onClick={login.onClick}><MonitorIcon />重新登录</DropdownMenuItem>}
              <DropdownMenuItem onClick={admin.onLimit}><GaugeIcon />改并发上限</DropdownMenuItem>
              <DropdownMenuItem onClick={admin.onPlatform}><GlobeIcon />改平台域名</DropdownMenuItem>
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
