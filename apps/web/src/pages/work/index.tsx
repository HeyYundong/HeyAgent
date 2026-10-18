// 派活页（docs/dev/dispatch.md 第 9.2 节，设计稿 design/BRIEF-dispatch.md）：一个任务的 agent 用内置工具「派活」，把一件件事（派活单 W-57）派给另一个任务；
// 平台按被派任务的名额一张单开一次运行，办完把结果写回单上。同一件事只办一次，没办成的由人点「重办」。
// 左边是派活单列表（搜索、按状态、按被派的任务筛，默认最近 7 天，再往前翻页），右边是一张单的详情：参数、结果、处理记录。右上角「派一张」。
// 筛选放在网址里（?task=&status=&from=&id=），任务抽屉点「排队 5」能直接跳过来并筛好。
import * as React from "react"
import { keepPreviousData, useInfiniteQuery, useQuery } from "@tanstack/react-query"
import {
  ArrowRightIcon,
  BotIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CircleXIcon,
  EllipsisIcon,
  HandIcon,
  HourglassIcon,
  ListOrderedIcon,
  PencilIcon,
  RotateCwIcon,
  ScanSearchIcon,
  SearchIcon,
  SearchXIcon,
  SendIcon,
  UserIcon,
  XIcon,
} from "lucide-react"
import {
  can,
  runStatusLabel,
  sameShanghaiDay,
  WORK_LIST_DEFAULT_DAYS,
  type RunStatus,
  type SessionRun,
  type TaskDef,
  type WorkItemDetail,
  type WorkItemStatus,
  type WorkLogEntry,
  type WorkRun,
} from "@heyagent/shared"

import { FileList } from "@/components/files"
import { MarkdownView } from "@/components/markdown"
import { DetailPanel, DetailSection, EmptyState, HelpTip, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Progress } from "@/components/ui/progress"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { useBoardQuery, useHumanItems, useRunNow, useSessionsQuery, useStaffName, useStaffQuery, useTasksQuery } from "@/lib/data"
import { href, navigate, setParams, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"
import { WaitingAlert, money } from "@/pages/tasks/parts"

import { CancelDialog, DispatchDialog, EditParamsDialog, RedoDoneDialog, dispatchedToast, useRedo } from "./dialogs"
import { ParamsTable, WorkStatusBadge, shortName, timeText, useWorkTaskStats } from "./parts"

type Filter = "all" | Exclude<WorkItemStatus, "cancelled">

const FILTERS: { id: Filter; name: string }[] = [
  { id: "all", name: "全部" },
  { id: "queued", name: "排队" },
  { id: "running", name: "在办" },
  { id: "done", name: "办完" },
  { id: "failed", name: "没办成" },
]

const PAGE_SIZE = 50

export default function WorkPage() {
  const { user } = useMe()
  const { params } = useRoute()
  const staffName = useStaffName()
  const [query, setQuery] = React.useState("")
  // 默认只列最近 7 天；翻到 7 天的底再点「再看更早的」就不限天数
  const [allTime, setAllTime] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [editing, setEditing] = React.useState<WorkItemDetail | null>(null)
  const [cancelling, setCancelling] = React.useState<WorkItemDetail | null>(null)
  const [redoing, setRedoing] = React.useState<WorkItemDetail | null>(null)
  const redo = useRedo()

  const filter = (FILTERS.some((each) => each.id === params.get("status")) ? params.get("status") : "all") as Filter
  const taskFilter = params.get("task") ?? "all"
  const fromFilter = params.get("from")
  const selectedId = params.get("id")
  const urlFilters = { status: filter === "all" ? null : filter, task: taskFilter === "all" ? null : taskFilter, from: fromFilter }

  const q = useDebouncedText(query.trim())
  const tasksQuery = useTasksQuery()
  const tasks = tasksQuery.data ?? []
  const anyQuery = useQuery(trpc.work.list.queryOptions({ days: 0, limit: 1 }))
  const listQuery = useInfiniteQuery(
    trpc.work.list.infiniteQueryOptions(
      {
        q: q || undefined,
        status: filter === "all" ? undefined : filter,
        taskId: taskFilter === "all" ? undefined : taskFilter,
        fromTaskId: fromFilter ?? undefined,
        days: allTime ? 0 : WORK_LIST_DEFAULT_DAYS,
        limit: PAGE_SIZE,
      },
      { getNextPageParam: (page) => page.nextCursor ?? undefined, placeholderData: keepPreviousData }
    )
  )
  // 详情里要：人名、正在跑的运行（检查点、在等什么）、挡住运行的要人办的事
  const queries = [anyQuery, listQuery, tasksQuery, useStaffQuery(), useSessionsQuery(), useBoardQuery()]

  const pages = listQuery.data?.pages ?? []
  const items = pages.flatMap((page) => page.items)
  const counts = pages[0]?.counts
  const dispatchable = tasks.filter((task) => task.dispatch)
  const manageable = dispatchable.filter((task) => can(user, "task.manage", { ownerId: task.ownerId }))
  const scopedTask = tasks.find((task) => task.id === taskFilter)
  const taskOptions = scopedTask && !scopedTask.dispatch ? [...dispatchable, scopedTask] : dispatchable
  const now = new Date()
  const today = items.filter((item) => sameShanghaiDay(item.createdAt, now))
  const earlier = items.filter((item) => !sameShanghaiDay(item.createdAt, now))
  const filtered = Boolean(q) || filter !== "all" || taskFilter !== "all" || Boolean(fromFilter)
  const canMore = listQuery.hasNextPage || (!allTime && !q)

  const header = (
    <SimpleHeader
      title="派活"
      description="一个任务找出要办的事，一件一张单派给另一个任务；轮到了开一次运行，办完把结果写回单上。同一件事只办一次。"
      action={
        manageable.length > 0 && (
          <Button onClick={() => setCreating(true)}>
            <SendIcon data-icon="inline-start" />
            派一张
          </Button>
        )
      }
    />
  )

  return (
    <>
      <PageFrame
        header={header}
        queries={queries}
        isEmpty={anyQuery.data?.counts.all === 0}
        empty={
          <EmptyState
            icon={<SendIcon />}
            title="还没有派活单"
            description="在要接活的任务上打开「可以被派活」、写好参数，再把派活的任务加进「谁能派活给它」，那个任务的 agent 就能派活了。也可以点「派一张」手动派。"
          />
        }
      >
        <MasterDetail
          hasSelection={Boolean(selectedId)}
          emptyHint="从左边选一张单看详情"
          list={
            <>
              <div className="flex flex-col gap-2">
                <InputGroup>
                  <InputGroupAddon>
                    <SearchIcon />
                  </InputGroupAddon>
                  <InputGroupInput placeholder="搜单号、标题、参数" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜派活单" />
                  {listQuery.isFetching && !listQuery.isFetchingNextPage && (
                    <InputGroupAddon align="inline-end">
                      <Spinner />
                    </InputGroupAddon>
                  )}
                </InputGroup>
                <ToggleGroup variant="outline" size="sm" spacing={0} className="w-full" value={[filter]} onValueChange={(value) => value[0] && setParams({ status: value[0] === "all" ? null : value[0] })} aria-label="按状态筛选">
                  {FILTERS.map((each) => (
                    <ToggleGroupItem key={each.id} value={each.id} className="flex-1">
                      {each.name}
                      <span className="tabular-nums text-muted-foreground">{counts?.[each.id] ?? 0}</span>
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
                <Select
                  items={[{ value: "all", label: "全部被派的任务" }, ...taskOptions.map((task) => ({ value: task.id, label: `${task.id} ${task.title}` }))]}
                  value={taskFilter}
                  onValueChange={(value) => value && setParams({ task: value === "all" ? null : String(value) })}
                >
                  <SelectTrigger className="w-full" aria-label="按被派的任务筛选">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部被派的任务</SelectItem>
                    {taskOptions.map((task) => (
                      <SelectItem key={task.id} value={task.id}>
                        {task.id} {task.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {fromFilter && (
                  <Button variant="outline" size="xs" className="self-start" onClick={() => setParams({ from: null })}>
                    只看「{shortName(tasks.find((task) => task.id === fromFilter)?.title) || fromFilter}」派的
                    <XIcon data-icon="inline-end" />
                  </Button>
                )}
                {scopedTask?.dispatch && <QuotaLine task={scopedTask} />}
              </div>
              {items.length > 0 ? (
                <>
                  {[
                    { label: "今天派的", list: today },
                    { label: "更早", list: earlier },
                  ].map(
                    (group) =>
                      group.list.length > 0 && (
                        <PickGroup key={group.label} label={group.label}>
                          {group.list.map((item) => (
                            <PickItem
                              key={item.id}
                              to={href("work", { ...urlFilters, id: item.id })}
                              selected={item.id === selectedId}
                              title={item.title}
                              description={`${item.id} · ${timeText(item.createdAt)} · ${item.via === "agent" ? `${shortName(item.fromTaskTitle)}派的` : `${staffName(item.fromUserId ?? undefined)}派的`} → ${shortName(item.taskTitle)}`}
                              badge={<WorkStatusBadge item={item} />}
                            />
                          ))}
                        </PickGroup>
                      )
                  )}
                  {canMore && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={listQuery.isFetchingNextPage}
                      onClick={() => (listQuery.hasNextPage ? void listQuery.fetchNextPage() : setAllTime(true))}
                    >
                      {listQuery.isFetchingNextPage && <Spinner data-icon="inline-start" />}
                      再看更早的
                    </Button>
                  )}
                  {!allTime && !q && !listQuery.hasNextPage && <p className="px-1 text-xs text-muted-foreground">上面是最近 {WORK_LIST_DEFAULT_DAYS} 天派的；搜索不限天数。</p>}
                </>
              ) : (
                <EmptyState
                  icon={<SearchXIcon />}
                  title={filtered ? "没有符合条件的单" : `最近 ${WORK_LIST_DEFAULT_DAYS} 天没有派活单`}
                  description={q ? `没找到「${q}」，换个单号或参数试试。` : filtered ? "这一类现在没有单。" : "更早派的单点下面看。"}
                  action={
                    filtered ? (
                      <Button
                        variant="outline"
                        onClick={() => {
                          setQuery("")
                          setParams({ status: null, task: null, from: null })
                        }}
                      >
                        清空筛选
                      </Button>
                    ) : (
                      !allTime && (
                        <Button variant="outline" onClick={() => setAllTime(true)}>
                          再看更早的
                        </Button>
                      )
                    )
                  }
                />
              )}
            </>
          }
          detail={
            selectedId && (
              <WorkDetail
                key={selectedId}
                id={selectedId}
                onEdit={setEditing}
                onCancel={setCancelling}
                onRedo={(item) => (item.status === "done" ? setRedoing(item) : redo.mutate({ id: item.id }))}
              />
            )
          }
        />
      </PageFrame>
      <DispatchDialog
        key={creating ? "open" : "closed"}
        open={creating}
        onOpenChange={setCreating}
        taskOptions={manageable}
        initialTaskId={scopedTask?.dispatch && manageable.includes(scopedTask) ? scopedTask.id : undefined}
        onDone={(item, existing) => {
          setCreating(false)
          dispatchedToast(item, existing, tasks.find((task) => task.id === item.taskId)?.enabled ?? true)
          navigate("work", { ...urlFilters, id: item.id })
        }}
      />
      <EditParamsDialog item={editing} onClose={() => setEditing(null)} />
      <CancelDialog item={cancelling} onClose={() => setCancelling(null)} />
      <RedoDoneDialog item={redoing} onClose={() => setRedoing(null)} />
    </>
  )
}

/** 搜索框停 300 ms 再查，不每敲一个字查一次 */
function useDebouncedText(text: string) {
  const [value, setValue] = React.useState(text)
  React.useEffect(() => {
    const timer = setTimeout(() => setValue(text), 300)
    return () => clearTimeout(timer)
  }, [text])
  return value
}

/** 选了某个任务时，列表上面一行：名额和占用 */
function QuotaLine({ task }: { task: TaskDef }) {
  const stats = useWorkTaskStats(task.id).data
  if (!stats) return null
  return (
    <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground">
      {task.enabled ? `同时最多 ${stats.maxRunning} 个在跑 · 现在占 ${stats.occupied} 个 · 排队 ${stats.queued} 张` : `任务停用了，排队的 ${stats.queued} 张先不开始`}
      <HelpTip>执行中、验收中、等浏览器的运行占名额；agent 自己挂起等待、等人处理的不占，空出来的位子给下一张单。挂起的被叫醒继续时不卡名额，所以偶尔会比上限多。</HelpTip>
    </p>
  )
}

const RUN_ICON: Record<RunStatus, typeof CircleCheckIcon> = { running: BotIcon, waiting: HourglassIcon, needs_human: HandIcon, verifying: ScanSearchIcon, done: CircleCheckIcon, failed: CircleXIcon }
const RUN_TEXT: Record<RunStatus, string> = { ...runStatusLabel, waiting: "挂起等待", done: "办完", failed: "失败" }

function WorkDetail({ id, onEdit, onCancel, onRedo }: { id: string; onEdit: (item: WorkItemDetail) => void; onCancel: (item: WorkItemDetail) => void; onRedo: (item: WorkItemDetail) => void }) {
  const { user } = useMe()
  const staffName = useStaffName()
  const detail = useQuery(trpc.work.get.queryOptions({ id }))
  const run = useSessionsQuery().data?.find((each) => each.id === detail.data?.sessionId)
  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }
  if (detail.isError) return <EmptyState icon={<SearchXIcon />} title={`找不到派活单 ${id}`} description="可能是网址里的单号写错了。" />
  const item = detail.data
  const canManage = can(user, "work.manage", { taskOwnerId: item.taskOwnerId })
  const ended = item.status === "done" || item.status === "failed" || item.status === "cancelled"
  const attempt = item.status === "queued" && item.attempts > 0 ? item.attempts + 1 : item.attempts

  return (
    <DetailPanel
      title={`${item.id} · ${item.title}`}
      badges={
        <>
          <WorkStatusBadge item={item} long />
          {attempt >= 2 && <Badge variant="outline">第 {attempt} 次</Badge>}
        </>
      }
      meta={
        <span className="inline-flex flex-wrap items-center gap-x-1">
          派给
          <a className="underline underline-offset-4" href={href("tasks", { id: item.taskId })}>
            「{item.taskTitle}」
          </a>
          ·
          {item.via === "agent" && item.fromTaskId ? (
            <>
              <BotIcon className="size-3" />
              来自
              <a className="underline underline-offset-4" href={href("tasks", { id: item.fromTaskId })}>
                「{shortName(item.fromTaskTitle)}」
              </a>
              {item.fromSessionId && (
                <a className="font-mono underline underline-offset-4" href={href("sessions", { id: item.fromSessionId })}>
                  {item.fromSessionId}
                </a>
              )}
            </>
          ) : (
            <>
              <UserIcon className="size-3" />
              {staffName(item.fromUserId ?? undefined)}在派活页派的
            </>
          )}
          <span>· 派于 {timeText(item.createdAt)}</span>
          <span>· 开始 {timeText(item.startedAt)}</span>
          <span>
            · {item.status === "cancelled" ? "不办了" : item.status === "failed" ? "结束" : "办完"} {ended ? timeText(item.finishedAt) : "—"}
          </span>
        </span>
      }
      actions={
        <>
          {item.sessionId && (
            <Button variant="outline" size="sm" nativeButton={false} render={<a href={href("sessions", { id: item.sessionId })} />}>
              去看运行
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          )}
          {canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="更多操作" />}>
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem disabled={item.status !== "queued" || !item.taskDispatch} onClick={() => onEdit(item)}>
                  <PencilIcon />
                  改参数{item.status !== "queued" && "（只有排队的能改）"}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!ended} onClick={() => onRedo(item)}>
                  <RotateCwIcon />
                  重办
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={ended} onClick={() => onCancel(item)}>
                  <CircleSlashIcon />
                  不办了
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="text-xs text-muted-foreground">负责人是 {staffName(item.taskOwnerId)}，你只能查看</span>
          )}
        </>
      }
    >
      <StatusAlert item={item} run={run} canManage={canManage} />

      <DetailSection title="参数" description="派活时带的参数，被派的运行在第一条消息里拿到。标「去重」的用来判断是不是同一件事：同一个值只办一次。">
        <div className="flex flex-col gap-2">
          <ParamsTable declared={item.taskDispatch?.params ?? []} values={item.params} showDedupe />
          {item.note && (
            <p>
              <span className="text-muted-foreground">补充说明：</span>
              {item.note}
            </p>
          )}
        </div>
      </DetailSection>

      <DetailSection title="结果" description="被派的运行办完后，agent 最后那段总结写回这里；有验收的，验收通过才算办完。">
        <ResultBody item={item} run={run} canManage={canManage} />
      </DetailSection>

      <DetailSection title={`处理记录（运行 ${item.runs.length} 次）`} description="一张单一次运行；重办会再开一次，以前的运行都留着。点一行看那次运行的完整过程。">
        <History item={item} />
      </DetailSection>
    </DetailPanel>
  )
}

/** 详情最上面：现在卡在哪 */
function StatusAlert({ item, run, canManage }: { item: WorkItemDetail; run?: SessionRun; canManage: boolean }) {
  const staffName = useStaffName()
  const humanItems = useHumanItems()
  const runNow = useRunNow()
  if (item.status === "queued") return <QueuedAlert item={item} canManage={canManage} />
  if (item.status === "running" && run?.status === "needs_human") {
    const human = humanItems.find((each) => each.runId === run.id)
    return (
      <Alert>
        <HandIcon />
        <AlertTitle>等人处理：{human ? `${human.title}（${staffName(human.assigneeId)}）` : runNow(run).text}</AlertTitle>
        <AlertDescription>
          运行 {run.id} 挂起了，不占名额；处理完继续同一个 session，单还是「在办」。
          {human && (
            <a href={href("todos", { id: human.id })} className="ml-1 font-medium text-foreground underline underline-offset-4">
              去待办处理 →
            </a>
          )}
        </AlertDescription>
      </Alert>
    )
  }
  if (item.status === "running" && run) return <WaitingAlert run={run} link={href("sessions", { id: run.id })} />
  if (item.status === "cancelled") {
    const cancel = item.log.findLast((entry) => entry.kind === "cancelled")
    // 有处理记录时原因只看人填的（error 里是「某某点了不办了」，再拼一遍就重复了）；老数据没有记录才用 error
    const reason = cancel ? cancel.note : item.error
    return (
      <Alert>
        <CircleSlashIcon />
        <AlertTitle>{cancel?.byId ? `${staffName(cancel.byId)} ${timeText(cancel.at)} 点了「不办了」${reason ? `：${reason}` : ""}` : `不办了${reason ? `：${reason}` : ""}`}</AlertTitle>
        <AlertDescription>同一件事再派进来也不会重开，只会返回「不办了」。{canManage && "要办的话点右上角「⋯ → 重办」。"}</AlertDescription>
      </Alert>
    )
  }
  return null
}

/** 排队的单：排第几位、谁在占名额；任务停用了（或关了被派活）写「单先排着」 */
function QueuedAlert({ item, canManage }: { item: WorkItemDetail; canManage: boolean }) {
  const stats = useWorkTaskStats(item.taskId).data
  // 在办的单里执行中、验收中的就是占名额的（等浏览器的也占，但列表上看不出来，数字以 stats 为准）
  const running = useQuery(trpc.work.list.queryOptions({ taskId: item.taskId, status: "running", days: 0, limit: 50 })).data
  const busy = (running?.items ?? []).filter((each) => each.sessionStatus === "running" || each.sessionStatus === "verifying").map((each) => each.id)
  const holders = stats && busy.length === stats.occupied ? (busy.length ? `${busy.join("、")} 在占着` : "没有单在占着") : `占着 ${stats?.occupied ?? 0} 个`
  let text: string
  if (!item.taskDispatch) text = `「${item.taskTitle}」关了被派活，单先排着；重新打开后接着办。`
  else if (!item.taskEnabled) text = `「${item.taskTitle}」停用了，单先排着；${canManage ? "重新启用任务后" : "负责人重新启用后"}自动开始办。`
  else text = `「${item.taskTitle}」同时最多 ${item.taskDispatch.maxRunning} 个在跑，现在${holders}。前面的办完或者挂起等待，就轮到它。`
  return (
    <Alert>
      <ListOrderedIcon />
      <AlertTitle>排队第 {item.queuePosition ?? "—"} 位</AlertTitle>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  )
}

function ResultBody({ item, run, canManage }: { item: WorkItemDetail; run?: SessionRun; canManage: boolean }) {
  const runNow = useRunNow()
  if (item.status === "done" && item.result) return <ResultSummary item={item} />
  if (item.status === "failed") {
    return (
      <div className="flex flex-col gap-2">
        <Alert variant="destructive">
          <CircleXIcon />
          <AlertTitle>没办成</AlertTitle>
          <AlertDescription>{item.error ?? item.runs.at(-1)?.error ?? "运行失败了，详情看那次运行。"}</AlertDescription>
        </Alert>
        <p className="text-xs text-muted-foreground">
          负责人已经收到通知。{canManage ? "处理好以后点右上角「⋯ → 重办」，会再开一次运行；" : ""}
          {item.via === "agent" ? `「${shortName(item.fromTaskTitle)}」` : "派活方"}再派同一件事，只会收到「没办成」，不会自己重开。
        </p>
      </div>
    )
  }
  if (item.status === "running" && run) {
    const done = run.checkpoints.filter((cp) => cp.status === "done").length
    const now = runNow(run)
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground">还在办，办完了结果写在这里。</p>
        {run.checkpoints.length > 0 && (
          <Progress value={(done / run.checkpoints.length) * 100} aria-label={`检查点完成 ${done}/${run.checkpoints.length}`}>
            <span className="text-xs tabular-nums text-muted-foreground">
              检查点 完成 {done}/{run.checkpoints.length}
            </span>
          </Progress>
        )}
        {now.label !== "在等" && (
          <p className="line-clamp-2">
            <span className="text-muted-foreground">{now.label}：</span>
            {now.text}
          </p>
        )}
      </div>
    )
  }
  if (item.status === "running") return <p className="text-muted-foreground">还在办，办完了结果写在这里。</p>
  if (item.status === "queued") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground">{item.attempts > 0 ? "重办了，还没开始；新的运行办完后结果换成新的。" : "还没开始，办完了结果写在这里。"}</p>
        {item.result && <ResultSummary item={item} previous />}
      </div>
    )
  }
  return <p className="text-muted-foreground">不办了，没有结果。</p>
}

/** 办完的总结（Markdown）、验收结论、产物（这次运行存下的文件） */
function ResultSummary({ item, previous = false }: { item: WorkItemDetail; previous?: boolean }) {
  const result = item.result!
  const files = useQuery(trpc.engine.sessionFiles.queryOptions({ sessionId: item.sessionId ?? "" }, { enabled: Boolean(item.sessionId) && result.fileIds.length > 0 }))
  const shown = (files.data ?? []).filter((file) => result.fileIds.includes(file.id))
  return (
    <div className="flex flex-col gap-3">
      {previous && <span className="text-xs text-muted-foreground">上一次的结果：</span>}
      <MarkdownView>{result.summary}</MarkdownView>
      {result.verification && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ScanSearchIcon className="size-3.5" />
          {result.verification}
        </p>
      )}
      {result.fileIds.length > 0 && (files.isPending ? <Spinner /> : <FileList files={shown} empty={<p className="text-xs text-muted-foreground">产物文件取不到了。</p>} />)}
    </div>
  )
}

/** 处理记录：派进来 → 每次运行 → 人点的重办 / 不办了 / 改参数 → 还在排队 */
function History({ item }: { item: WorkItemDetail }) {
  const runs = item.runs
  const logged = new Set(item.log.flatMap((entry) => (entry.kind === "run_started" && entry.sessionId ? [entry.sessionId] : [])))
  // 处理记录里没写「开始运行」的运行（不该有，兜底）跟在最后
  const unlogged = runs.filter((run) => !logged.has(run.sessionId))
  return (
    <Trace className="gap-3">
      {item.log.map((entry, index) => {
        if (entry.kind === "run_ended") return null
        if (entry.kind === "run_started") {
          const run = runs.find((each) => each.sessionId === entry.sessionId)
          return run ? <RunLine key={index} run={run} attempt={runs.indexOf(run) + 1} /> : null
        }
        return <EventLine key={index} item={item} entry={entry} />
      })}
      {unlogged.map((run) => (
        <RunLine key={run.sessionId} run={run} attempt={runs.indexOf(run) + 1} />
      ))}
      {item.status === "queued" && (
        <div>
          <TraceLine status="pending">
            <TraceIcon>
              <ListOrderedIcon />
            </TraceIcon>
            <TraceTitle>
              排队中 · 第 {item.queuePosition ?? "—"} 位，轮到了开第 {runs.length + 1} 次运行
            </TraceTitle>
          </TraceLine>
        </div>
      )}
    </Trace>
  )
}

function RunLine({ run, attempt }: { run: WorkRun; attempt: number }) {
  const Icon = RUN_ICON[run.status]
  const active = run.status === "running"
  return (
    <a href={href("sessions", { id: run.sessionId })} className="flex flex-col gap-0.5">
      <TraceLine status={active ? "running" : run.status === "failed" ? "error" : undefined}>
        <TraceIcon>{active ? <Spinner /> : <Icon />}</TraceIcon>
        <TraceTitle className="text-foreground">
          第 {attempt} 次 · <span className="font-mono">{run.sessionId}</span> · {RUN_TEXT[run.status]}
        </TraceTitle>
        <TraceDescription>
          {timeText(run.startedAt)}
          {run.endedAt ? ` – ${timeText(run.endedAt)}` : " 起"}
        </TraceDescription>
      </TraceLine>
      <span className="pl-5.5 text-xs text-muted-foreground">
        检查点 完成 {run.checkpointsDone}/{run.checkpointsTotal} · 花费 {money(run.costUsd)}
        {run.status === "failed" && run.error ? ` · ${run.error}` : ""}
        {run.waitingWhat ? ` · 在等：${run.waitingWhat.replace(/^等/, "")}` : ""}
      </span>
    </a>
  )
}

function EventLine({ item, entry }: { item: WorkItemDetail; entry: WorkLogEntry }) {
  const staffName = useStaffName()
  const who = staffName(entry.byId)
  const line = (() => {
    if (entry.kind === "created")
      return {
        icon: item.via === "agent" ? <BotIcon /> : <UserIcon />,
        title:
          item.via === "agent"
            ? `派进来：「${shortName(item.fromTaskTitle)}」的运行 ${item.fromSessionId ?? ""} 用「派活」派的`
            : `派进来：${staffName(entry.byId ?? item.fromUserId ?? undefined)}在派活页手动派的`,
      }
    if (entry.kind === "redo") return { icon: <RotateCwIcon />, title: `${who} 点了「重办」` }
    if (entry.kind === "params_changed") return { icon: <PencilIcon />, title: entry.byId ? `${who} 改了参数` : "参数改了（派活方用新参数覆盖）" }
    return { icon: <CircleSlashIcon />, title: `${entry.byId ? who : ""} 点了「不办了」${entry.note ? `：${entry.note}` : ""}`.trim() }
  })()
  return (
    <div>
      <TraceLine>
        <TraceIcon>{line.icon}</TraceIcon>
        <TraceTitle>{line.title}</TraceTitle>
        <TraceDescription>{timeText(entry.at)}</TraceDescription>
      </TraceLine>
    </div>
  )
}

