// 流程页（docs/dev/routine-library.md 9.1）：流程库里的流程。左边两组「在库里」「停用 / 撤下」，右边一个流程的详情：
// 标题卡（名字、状态、第几版 · 来源任务；「⋯」改名字和说明、发布新版本、版本记录、看脚本、停用 / 重新启用、撤下）、
// 有转正式的新版本时的提示、停用的原因，分区卡：什么时候用、做什么、输入 / 交回、要的工具、谁在用、成绩。
// 读谁都能读；发布、改、停用、撤下只有主管（config.manage，后端也拦）。布局照技能页。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  EllipsisIcon,
  FileCodeIcon,
  HistoryIcon,
  ListChecksIcon,
  PauseIcon,
  PencilIcon,
  PlayIcon,
  SearchXIcon,
  TriangleAlertIcon,
  Undo2Icon,
  UploadIcon,
  WorkflowIcon,
} from "lucide-react"
import { can, fmtDateTime, riskLabel, routineBrowserFlagLabel, routineStopKindLabel, routineToolId, type RoutineLibraryDetail, type RoutineLibraryItem } from "@heyagent/shared"

import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useRoutineLibraryQuery, useToolName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"
import { TextLink } from "@/pages/sessions/parts"
import { schemaFields } from "@/pages/tasks/routine-parts"
import { VersionDialog } from "@/pages/tasks/task-routine"

import { CallsDialog, EditDialog, HistoryDialog } from "./dialogs"
import { CallResultBadge, LibraryStatusBadge, secondsText } from "./parts"
import { PublishDialog } from "./publish-dialog"

export default function RoutinesPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  const { params } = useRoute()
  const query = useRoutineLibraryQuery()
  const items = query.data ?? []
  const [publishing, setPublishing] = React.useState(false)
  const selected = items.find((item) => item.routineId === params.get("id"))
  const listed = items.filter((item) => item.status === "listed")
  const others = items.filter((item) => item.status !== "listed")

  const publishButton = (
    <Button onClick={() => setPublishing(true)}>
      <UploadIcon data-icon="inline-start" />
      发布到流程库
    </Button>
  )
  const header = (
    <SimpleHeader
      title="流程"
      description="固化好、转过正式的流程发布进库以后，别的任务选上就能当工具用：几秒做完一段固定操作。"
      action={isAdmin && items.length > 0 && publishButton}
    />
  )

  return (
    <>
      <PageFrame
        header={header}
        queries={[query]}
        isEmpty={items.length === 0}
        empty={
          <EmptyState
            icon={<WorkflowIcon />}
            title="还没有库里的流程"
            description="在任务的「固化流程」里转了正式的流程，主管可以发布到这里，给别的任务当工具用。"
            action={isAdmin && publishButton}
          />
        }
      >
        <MasterDetail
          hasSelection={!!selected}
          list={
            <>
              {[{ label: "在库里", group: listed }, { label: "停用 / 撤下", group: others }].map(({ label, group }) =>
                group.length === 0 ? null : (
                  <PickGroup key={label} label={`${label} · ${group.length}`}>
                    {group.map((item) => (
                      <PickItem
                        key={item.routineId}
                        to={href("routines", { id: item.routineId })}
                        selected={item.routineId === selected?.routineId}
                        title={item.title}
                        description={`${item.toolId} · 第 ${item.publishedVersion} 版 · ${item.taskCount} 个任务在用`}
                        badge={item.status !== "listed" && <LibraryStatusBadge status={item.status} />}
                      />
                    ))}
                  </PickGroup>
                )
              )}
            </>
          }
          detail={selected ? <RoutineDetailLoader key={selected.routineId} item={selected} isAdmin={isAdmin} /> : null}
        />
      </PageFrame>
      {publishing && <PublishDialog open onOpenChange={setPublishing} />}
    </>
  )
}

/** 详情另取（routineLibrary.get）：取到前骨架屏，出错写清楚 */
function RoutineDetailLoader({ item, isAdmin }: { item: RoutineLibraryItem; isAdmin: boolean }) {
  const query = useQuery(trpc.routineLibrary.get.queryOptions({ routineId: item.routineId }))
  if (query.isPending)
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-20 w-full" />
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    )
  if (query.isError)
    return (
      <Alert variant="destructive">
        <TriangleAlertIcon />
        <AlertTitle>这个流程的详情没取到</AlertTitle>
        <AlertDescription>{query.error.message}</AlertDescription>
        <AlertAction><Button variant="outline" size="sm" onClick={() => void query.refetch()}>重试</Button></AlertAction>
      </Alert>
    )
  return <RoutineDetail entry={query.data} isAdmin={isAdmin} />
}

type Dialogs = "edit" | "history" | "script" | "calls" | "pause" | "withdraw" | { publish: number }

/** 原因后面补个句号（原因可能自带标点） */
const sentence = (text: string) => (/[。！？.!?]$/.test(text) ? text : `${text}。`)

function RoutineDetail({ entry, isAdmin }: { entry: RoutineLibraryDetail; isAdmin: boolean }) {
  const [open, setOpen] = React.useState<Dialogs | null>(null)
  const close = (next: boolean) => !next && setOpen(null)
  const setPaused = useAction(trpc.routineLibrary.setPaused.mutationOptions({ onSuccess: () => setOpen(null) }), {
    success: (_data, vars) => (vars.paused ? "已停用，新的运行用不了它" : "已重新启用，连着跑不通的次数清零"),
    errorTitle: "没改成",
  })
  const withdraw = useAction(trpc.routineLibrary.withdraw.mutationOptions({ onSuccess: () => setOpen(null) }), { success: "已撤下，任务里选不到了；以后可以重新发布", errorTitle: "没撤下" })
  const newer = entry.newerVersions[0]
  const inUse = entry.usedBy.tasks.length + entry.usedBy.routines.length

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="流程的更多操作" />}>
        {setPaused.isPending ? <Spinner /> : <EllipsisIcon />}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-44">
        <DropdownMenuItem onClick={() => setOpen("script")}><FileCodeIcon />看脚本</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setOpen("history")}><HistoryIcon />版本记录</DropdownMenuItem>
        {isAdmin && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => setOpen("edit")}><PencilIcon />改名字和说明</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setOpen({ publish: newer ?? entry.publishedVersion })}><UploadIcon />{entry.status === "withdrawn" ? "重新发布" : "发布新版本"}</DropdownMenuItem>
            {entry.status !== "withdrawn" && (
              <>
                <DropdownMenuSeparator />
                {entry.status === "paused" ? (
                  <DropdownMenuItem onClick={() => setPaused.mutate({ routineId: entry.routineId, paused: false })}><PlayIcon />重新启用</DropdownMenuItem>
                ) : (
                  <DropdownMenuItem variant="destructive" onClick={() => setOpen("pause")}><PauseIcon />停用</DropdownMenuItem>
                )}
                <DropdownMenuItem variant="destructive" onClick={() => setOpen("withdraw")}><Undo2Icon />撤下</DropdownMenuItem>
              </>
            )}
          </>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  )

  return (
    <DetailPanel
      title={entry.title}
      badges={<LibraryStatusBadge status={entry.status} />}
      meta={
        <>
          <span className="font-mono">{entry.toolId}</span> · 第 {entry.publishedVersion} 版 · 来源{" "}
          <TextLink to={href("tasks", { id: entry.source.taskId })}>{entry.source.taskId}「{entry.source.title}」</TextLink>
          {entry.publishedBy ? ` · ${entry.publishedBy.name} ${fmtDateTime(entry.publishedAt)} 发布` : ` · ${fmtDateTime(entry.publishedAt)} 发布`}
        </>
      }
      actions={menu}
    >
      {newer !== undefined && entry.status !== "withdrawn" && (
        <Alert>
          <UploadIcon />
          <AlertTitle>来源任务上第 {newer} 版已转正式</AlertTitle>
          <AlertDescription>库里还是第 {entry.publishedVersion} 版。{isAdmin ? "发布前会列出不兼容的改动和受影响的任务。" : "主管可以发布到流程库。"}</AlertDescription>
          {isAdmin && (
            <AlertAction>
              <Button size="sm" onClick={() => setOpen({ publish: newer })}>发布第 {newer} 版</Button>
            </AlertAction>
          )}
        </Alert>
      )}
      {entry.status === "paused" && (
        <Alert variant="destructive">
          <PauseIcon />
          <AlertTitle>停用了，新的运行用不了它</AlertTitle>
          <AlertDescription>
            {sentence(entry.pausedReason ?? "主管停用的")}修还是在来源任务上修：转了正式以后发布新版本，再重新启用。
          </AlertDescription>
        </Alert>
      )}
      {entry.status === "withdrawn" && (
        <Alert>
          <Undo2Icon />
          <AlertTitle>撤下了</AlertTitle>
          <AlertDescription>任务里选不到它。主管可以在「⋯」里重新发布，短名不变。</AlertDescription>
        </Alert>
      )}
      <DetailSection title="什么时候用" description="给模型看的一句话：agent 平时靠它决定用不用。在别的任务里跑时，按那个任务的规则、白名单和 Chrome 配置。">
        <p>{entry.summary}</p>
      </DetailSection>
      <div className="grid gap-4 lg:grid-cols-2">
        <DetailSection title="做什么" description="发布的那一版的步骤说明，一步一行。标了「提交」的会真的改东西。">
          <Steps description={entry.version.description} commits={entry.version.commits} />
        </DetailSection>
        <DetailSection title="输入 / 交回" description="给模型的参数按输入转：中文名字换成 p1、p2……，说明里写原来的名字。附件、附加说明是文件 id、一句话。">
          <div className="flex flex-col gap-3">
            <FieldTable caption="输入" schema={entry.version.inputSchema} empty="不要输入：调一下就把这段固定操作做一遍。" />
            <FieldTable caption="交回" schema={entry.version.outputSchema} empty="不交回数据，只报办成没有。" />
          </div>
        </DetailSection>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Requires entry={entry} />
        <UsedBy entry={entry} />
      </div>
      <Stats entry={entry} onAll={() => setOpen("calls")} />

      {open === "script" && <VersionDialog versionId={entry.version.versionId} activeVersion={entry.publishedVersion} onClose={() => setOpen(null)} />}
      {open === "edit" && <EditDialog entry={entry} open onOpenChange={close} />}
      {open === "history" && <HistoryDialog entry={entry} isAdmin={isAdmin} open onOpenChange={close} />}
      {open === "calls" && <CallsDialog entry={entry} open onOpenChange={close} />}
      {typeof open === "object" && open !== null && <PublishDialog open onOpenChange={close} routineId={entry.routineId} version={open.publish} />}
      <AlertDialog open={open === "pause"} onOpenChange={close}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>停用「{entry.title}」？</AlertDialogTitle>
            <AlertDialogDescription>
              停用后选了它的 {entry.usedBy.tasks.length} 个任务新的运行里没有这个工具，agent 只能自己一步步做；脚本里调它的流程会跑不通、交给 agent。正在跑的运行不受影响。之后可以在「⋯」里重新启用。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不停</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={setPaused.isPending} onClick={() => setPaused.mutate({ routineId: entry.routineId, paused: true })}>
              {setPaused.isPending ? <Spinner data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}停用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <AlertDialog open={open === "withdraw"} onOpenChange={close}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>撤下「{entry.title}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {inUse > 0
                ? `还有 ${[entry.usedBy.tasks.length ? `${entry.usedBy.tasks.length} 个任务选用它` : "", entry.usedBy.routines.length ? `${entry.usedBy.routines.length} 个库里的流程调它` : ""].filter(Boolean).join("、")}，现在撤不了：先在这些任务里去掉它，或者先停用。`
                : "撤下后任务里选不到它，工具也删掉；库里的登记留着，以后可以重新发布，短名不变。"}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {inUse > 0 && (
            <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
              {entry.usedBy.tasks.map((task) => <li key={task.taskId}>任务 {task.taskId}「{task.title}」</li>)}
              {entry.usedBy.routines.map((routine) => <li key={routine.routineId}>流程「{routine.title}」（{routineToolId(routine.slug)}）</li>)}
            </ul>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel>先不撤</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={withdraw.isPending || inUse > 0} onClick={() => withdraw.mutate({ routineId: entry.routineId })}>
              {withdraw.isPending ? <Spinner data-icon="inline-start" /> : <Undo2Icon data-icon="inline-start" />}撤下
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailPanel>
  )
}

/** 步骤说明一步一行；提到会改东西的步骤（commits 的名字、「会改东西」）后面标「提交」 */
function Steps({ description, commits }: { description: string; commits: string[] }) {
  const steps = description.split("\n").map((line) => line.trim()).filter(Boolean)
  const commitOf = (line: string) => commits.find((label) => line.includes(label)) ?? (/会改东西|提交/.test(line) ? commits[0] ?? "提交" : undefined)
  const unmatched = commits.filter((label) => !steps.some((line) => line.includes(label)))
  if (steps.length === 0) return <p className="text-muted-foreground">没写步骤说明。</p>
  return (
    <div className="flex flex-col gap-2">
      <ol className="flex list-decimal flex-col gap-1 pl-5">
        {steps.map((line, index) => (
          <li key={index}>
            {line}
            {commitOf(line) && <Badge variant="secondary" className="ml-2">提交</Badge>}
          </li>
        ))}
      </ol>
      {unmatched.length > 0 && !steps.some((line) => commitOf(line)) && (
        <p className="flex flex-wrap items-center gap-1.5 text-muted-foreground">会改东西的步骤：{unmatched.map((label) => <Badge key={label} variant="secondary">{label}</Badge>)}</p>
      )}
    </div>
  )
}

/** 输入 / 交回的一张小表：名字、说明、必填 */
function FieldTable({ caption, schema, empty }: { caption: string; schema: Record<string, unknown>; empty: string }) {
  const fields = schemaFields(schema)
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{caption}</span>
      {fields.length === 0 ? (
        <p className="text-muted-foreground">{empty}</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名字</TableHead>
              <TableHead>说明</TableHead>
              <TableHead>必填</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fields.map((field) => (
              <TableRow key={field.name}>
                <TableCell className="font-medium">{field.label}</TableCell>
                <TableCell className="whitespace-normal text-muted-foreground">{field.description ?? "—"}</TableCell>
                <TableCell>{field.required ? "必填" : "可以不填"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  )
}

/** 要的工具：一排徽章（工具、要打开的开关、调的库流程）+ 风险 */
function Requires({ entry }: { entry: RoutineLibraryDetail }) {
  const toolName = useToolName()
  const library = useRoutineLibraryQuery().data ?? []
  const { requires } = entry
  const flags = (["fetch", "vision"] as const).filter((flag) => requires.browser[flag])
  return (
    <DetailSection title="要的工具" description="选用它的任务要选上这些工具、打开这些开关，不然新的运行用不了它。在任务弹窗里选它时会自动选上工具，开关要人自己开。">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap gap-1.5">
          {requires.toolIds.map((id) => <Badge key={id} variant="outline" render={<a href={href("tools", { id })} />}>{toolName(id)}</Badge>)}
          {flags.map((flag) => <Badge key={flag} variant="secondary">要打开「{routineBrowserFlagLabel[flag]}」</Badge>)}
          {requires.routines.map((slug) => {
            const called = library.find((each) => each.slug === slug)
            return (
              <Badge key={slug} variant="outline" render={called ? <a href={href("routines", { id: called.routineId })} /> : undefined}>
                <WorkflowIcon data-icon="inline-start" />{called?.title ?? routineToolId(slug)}
              </Badge>
            )
          })}
          {requires.toolIds.length + flags.length + requires.routines.length === 0 && <span className="text-muted-foreground">不用别的工具</span>}
        </div>
        <p className="flex flex-wrap items-center gap-2">
          <span className="text-muted-foreground">风险</span>
          <Badge variant="outline">{riskLabel[entry.risk]}</Badge>
          <span className="text-muted-foreground">按脚本会不会改东西算；规则照这个风险和工具 id 管它。</span>
        </p>
      </div>
    </DetailSection>
  )
}

/** 谁在用：选了它的任务（最近一次调用）、调它的库流程 */
function UsedBy({ entry }: { entry: RoutineLibraryDetail }) {
  const { tasks, routines } = entry.usedBy
  return (
    <DetailSection title={`谁在用 · ${tasks.length + routines.length}`} description="任务在「用哪些 → 流程」里选了它；库里别的流程在脚本里调它。">
      {tasks.length + routines.length === 0 ? (
        <p className="text-muted-foreground">还没有任务选用它。</p>
      ) : (
        <ItemGroup className="gap-1">
          {tasks.map((task) => (
            <Item key={task.taskId} size="xs" variant="muted" render={<a href={href("tasks", { id: task.taskId })} />}>
              <ItemMedia variant="icon"><ListChecksIcon /></ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="line-clamp-1">{task.title}</ItemTitle>
                <ItemDescription>{task.taskId} · {task.lastCall ? `最近一次 ${fmtDateTime(task.lastCall.at)}` : "还没调过"}</ItemDescription>
              </ItemContent>
              {task.lastCall && <ItemActions><CallResultBadge result={task.lastCall.result} /></ItemActions>}
            </Item>
          ))}
          {routines.map((routine) => (
            <Item key={routine.routineId} size="xs" variant="muted" render={<a href={href("routines", { id: routine.routineId })} />}>
              <ItemMedia variant="icon"><WorkflowIcon /></ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="line-clamp-1">{routine.title}</ItemTitle>
                <ItemDescription>{routineToolId(routine.slug)} · 脚本里调它</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </DetailSection>
  )
}

/** 成绩：一行总数，按任务一张表，最近几次停下的（停在第几步、原因、哪次运行） */
function Stats({ entry, onAll }: { entry: RoutineLibraryDetail; onAll: () => void }) {
  const { stats } = entry
  const finished = stats.achieved + stats.notAchieved
  return (
    <DetailSection
      title="成绩"
      description="最近 50 次调用（agent 调、脚本调都算）。连着 3 次停在页面变了、脚本出错、超时这几种原因上，自动停用；被拦下、要审批、等人处理、输入不对不算。"
      action={stats.calls > 0 && <Button variant="ghost" size="sm" onClick={onAll}>全部调用记录</Button>}
    >
      {stats.calls === 0 ? (
        <p className="text-muted-foreground">还没被调过。</p>
      ) : (
        <div className="flex flex-col gap-4">
          <p className="flex flex-wrap items-center gap-x-1">
            <span className="text-muted-foreground">最近 {stats.calls} 次：</span>
            跑完 <span className="font-medium tabular-nums">{finished}</span>（办成 <span className="tabular-nums">{stats.achieved}</span>）
            · 停下 <span className="font-medium tabular-nums">{stats.stopped}</span>
            {stats.badInput > 0 && <> · 输入不对 <span className="tabular-nums">{stats.badInput}</span></>}
            {stats.avgMs !== null && <> · 平均 <span className="font-medium tabular-nums">{secondsText(stats.avgMs)}</span></>}
            {entry.failStreak > 0 && entry.status === "listed" && <span className="text-muted-foreground">· 现在连着跑不通 {entry.failStreak} 次</span>}
          </p>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>调用的任务</TableHead>
                <TableHead className="text-right">次数</TableHead>
                <TableHead className="text-right">办成</TableHead>
                <TableHead className="text-right">没办成</TableHead>
                <TableHead className="text-right">停下</TableHead>
                <TableHead className="text-right">平均</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {stats.byTask.map((row) => (
                <TableRow key={row.taskId}>
                  <TableCell className="max-w-56 truncate" title={row.title}><TextLink to={href("tasks", { id: row.taskId })}>{row.title}</TextLink></TableCell>
                  <TableCell className="text-right tabular-nums">{row.calls}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.achieved}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.notAchieved}</TableCell>
                  <TableCell className="text-right tabular-nums">{row.stopped}</TableCell>
                  <TableCell className="text-right tabular-nums">{secondsText(row.avgMs)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {stats.recentStops.length > 0 && (
            <div className="flex flex-col gap-1.5">
              <span className="text-xs text-muted-foreground">最近停下的</span>
              <ItemGroup className="gap-1">
                {stats.recentStops.map((call) => (
                  <Item key={call.id} size="xs" variant="outline" render={<a href={href("sessions", { id: call.sessionId })} />}>
                    <ItemMedia variant="icon"><SearchXIcon /></ItemMedia>
                    <ItemContent className="min-w-0">
                      <ItemTitle className="line-clamp-2">
                        {call.stopStep ? `停在第 ${call.stopStep} 步：` : ""}{call.stopReason ?? (call.stopKind ? routineStopKindLabel[call.stopKind] : "停下了")}
                      </ItemTitle>
                      <ItemDescription>{call.sessionId} · {call.taskTitle} · {fmtDateTime(call.at)}</ItemDescription>
                    </ItemContent>
                  </Item>
                ))}
              </ItemGroup>
            </div>
          )}
        </div>
      )}
    </DetailSection>
  )
}
