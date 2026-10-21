// 会话：一个列表看全部 session（任务每运行一次就是一个），按状态分标签：排队中 / 执行中（默认）/ 等人处理 / 等待中 / 验收中 / 已结束。
// 「排队中」是还没开运行的派活单（2026-10-21 派活页并进来，docs/dev/work-into-tasks.md）：全部任务的，work.list 按页码取，个数只跟着任务和搜索变（来源、结果对它不适用，这个标签里不显示这两个下拉）；
// 点一行打开单详情（?status=queue&id=W-…），能改参数、不办了，「去任务看全部」到被派任务的抽屉里。
// 原来的「待办」页并进来了：要人办的事在「等人处理」里——等人处理的运行，加上不挡运行的事（记忆审核、技能修改等）；「只看等我处理」只列分给我的（主管看全部，和侧边栏数字一样）。
// 列表在服务端筛、数、翻页（sessions.page，一页 50 个）；不挡运行的事从 todos.board 来，只在「等人处理」（和「只看等我处理」）的第 1 页、列表最上面，不算进翻页。
// 点一行从右侧打开详情（?id=）：运行是完整的运行详情，顶上就能处理挡着它的事；不挡运行的事是它的处理面板。打开的运行不在这一页也行（按 id 取）。
// 网址：?status=queue|human|waiting|verifying|ended（执行中不写）、?mine=1、?page=（第 1 页不写；换标签、筛选、搜索、排序都回第 1 页）、?id=、
// ?sort=ended&dir=asc（点「开始」「结束」表头排序，默认按开始倒序不写）；别的页面还能带 ?q= ?source= ?task= ?outcome= 过来。旧的 #/todos 跳到 ?status=human，旧的 #/work 跳到 ?status=queue。
// 右上角一行：排队 · 执行中 · 等人处理 · 今天花了；看「已结束」时再加 办成 · 没办成 · 成功率（同样的筛选，服务端算）。
// 人加的待办（到点、等事件让 agent 去做）在任务详情的「什么时候跑」里。
import * as React from "react"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { ArrowRightIcon, HistoryIcon, SearchIcon, SearchXIcon, UserIcon } from "lucide-react"

import { EmptyState, PageFrame, SimpleHeader } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Toggle } from "@/components/ui/toggle"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { href, setParams, useRoute } from "@/lib/router"
import { findById, isNeedsMe, sessionGroups as groups, type HumanItem, type RunOutcome, type SessionGroup as Group, type SessionPageInput, type SessionSummary, type TaskDef, type WorkListInput } from "@heyagent/shared"

import { OUTCOME_FILTERS } from "@/components/shell/outcome-badge"

import { useBoardQuery, useModelsQuery, useRulesQuery, useSessionQuery, useStaffQuery, useTasksQuery, useToolsQuery } from "@/lib/data"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"
import { money } from "@/pages/tasks/parts"
import { RunDetail } from "@/pages/tasks/run-detail"
import { WorkItemView } from "@/pages/tasks/work-detail"
import { useWorkQueueStats, workLink } from "@/pages/tasks/work-parts"

import { HumanItemPanel } from "./human-item"
import { SOURCE_LABEL, SessionItems, SessionPager, SessionTable, type Row, type SessionSort } from "./list"
import { QueueItems, QueueTable } from "./queue"
import { TaskFilter } from "./task-filter"

const SOURCE_ITEMS = [{ value: "all", label: "全部来源" }, ...Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label }))]
const OUTCOME_ITEMS = [{ value: "all", label: "全部结果" }, ...OUTCOME_FILTERS]
const DEFAULT_GROUP: Group = "running"
/** 「排队中」（还没开运行的派活单）放在最前面，其余是运行的五个状态 */
const TABS: { id: Group | "queue"; name: string }[] = [{ id: "queue", name: "排队中" }, ...groups]
const PAGE_SIZE = 50
/** 挡住运行的几种事：算在等人处理的运行那一行里（服务端「只看等我处理」也按这几种筛）；别的（记忆审核、技能修改）不挡运行，单独一行 */
const BLOCKING = new Set<HumanItem["kind"]>(["approval", "verify", "login"])
const isLoose = (item: HumanItem) => !(item.runId && BLOCKING.has(item.kind))

export default function SessionsPage() {
  const { user } = useMe()
  const { params } = useRoute()
  const statusParam = params.get("status")
  const group: Group = groups.find((each) => each.id === statusParam)?.id ?? DEFAULT_GROUP
  const mine = params.get("mine") === "1"
  // 排队中：只看等我处理开着时让给它
  const queueMode = statusParam === "queue" && !mine
  const sort: SessionSort["by"] = params.get("sort") === "ended" ? "ended" : "started"
  const dir: SessionSort["dir"] = params.get("dir") === "asc" ? "asc" : "desc"
  const pageParam = Math.max(1, Number.parseInt(params.get("page") ?? "1", 10) || 1)
  const [query, setQuery] = React.useState(() => params.get("q") ?? "") // 别的页面可以带 ?q= 过来
  // 搜索框停下 0.3 秒再去服务端搜
  const [q, setQ] = React.useState(() => query.trim())
  React.useEffect(() => {
    const timer = setTimeout(() => setQ(query.trim()), 300)
    return () => clearTimeout(timer)
  }, [query])
  // 来源：手动 / 定时 / 人加的 / 事件 / 派活（派活加的，可以只看派活触发的）
  const [source, setSource] = React.useState(() => params.get("source") ?? "all")
  // 任务：只看某个任务的 session（别的页面可以带 ?task=T-… 过来）
  const [taskId, setTaskId] = React.useState(() => params.get("task") ?? "all")
  // 结果：办成 / 没办成（别的页面可以带 ?outcome= 过来）
  const [outcome, setOutcome] = React.useState(() => params.get("outcome") ?? "all")

  // 排队中时这一页只用来拿各标签个数、花费，列表不显示：取第 1 页
  const input: SessionPageInput = {
    group,
    mine: mine || undefined,
    source: source !== "all" && source in SOURCE_LABEL ? (source as SessionPageInput["source"]) : undefined,
    taskId: taskId !== "all" ? taskId : undefined,
    outcome: outcome !== "all" ? (outcome as RunOutcome) : undefined,
    q: q || undefined,
    sort,
    dir,
    page: queueMode ? 1 : pageParam,
    pageSize: PAGE_SIZE,
  }
  // 翻页、换标签时先留着上一页，不闪骨架屏
  const pageQuery = useQuery(trpc.sessions.page.queryOptions(input, { placeholderData: keepPreviousData }))
  // 排队的派活单：个数（counts.queued）一直要；排队中时按页码取这一页，别的标签只取 1 张（运行一变它就重新拉）。来源、结果对它不适用，只跟着任务和搜索
  const queueInput: WorkListInput = {
    status: "queued",
    taskId: taskId !== "all" ? taskId : undefined,
    q: q || undefined,
    days: 0,
    limit: queueMode ? PAGE_SIZE : 1,
    offset: queueMode ? (pageParam - 1) * PAGE_SIZE : 0,
  }
  const queueQuery = useQuery(trpc.work.list.queryOptions(queueInput, { placeholderData: keepPreviousData }))
  const queueStats = useWorkQueueStats(queueMode).data ?? []
  const queued = queueQuery.data?.counts.queued ?? 0
  const queueItems = queueMode ? (queueQuery.data?.items ?? []) : []
  const tasksQuery = useTasksQuery()
  const boardQuery = useBoardQuery()
  // 列表和抽屉里还要：人名、模型名、拦下它的规则、工具名
  const queries = [pageQuery, queueQuery, tasksQuery, boardQuery, useStaffQuery(), useModelsQuery(), useRulesQuery(), useToolsQuery()]
  const tasks = tasksQuery.data ?? []
  const humanItems = boardQuery.data?.humanItems ?? []
  const data = pageQuery.data
  const counts = data?.counts ?? { running: 0, human: 0, waiting: 0, verifying: 0, ended: 0 }
  const page = data?.page ?? 1

  // 已定：员工也能看全部 session 和要人办的事（只读）；分给自己的（主管全部）才能处理
  // 不挡运行的事：来源、结果筛选时不列（它们没有来源和结果）；按任务、搜索照样筛
  const looseItems = humanItems.filter((item) => {
    if (!isLoose(item) || source !== "all" || outcome !== "all") return false
    if (taskId !== "all" && item.taskId !== taskId) return false
    if (!q) return true
    const title = findById(tasks, item.taskId)?.title ?? ""
    return [item.id, item.title, item.taskId ?? "", item.runId ?? "", title].some((text) => text.toLowerCase().includes(q.toLowerCase()))
  }).toSorted((a, b) => b.createdAt.localeCompare(a.createdAt))
  const myItems = humanItems.filter((item) => isNeedsMe(item, user.id, user.isAdmin))
  const shownLoose = (mine ? looseItems.filter((item) => isNeedsMe(item, user.id, user.isAdmin)) : group === "human" ? looseItems : []).filter(() => page === 1)
  const runRow = (run: SessionSummary): Row => ({
    kind: "run",
    id: run.id,
    run,
    items: run.status === "needs_human" ? humanItems.filter((item) => item.runId === run.id && BLOCKING.has(item.kind)) : [],
  })
  const rows: Row[] = [...shownLoose.map((item): Row => ({ kind: "item", id: item.id, item })), ...(data?.items ?? []).map(runRow)]
  const count = (id: Group | "queue") => (id === "queue" ? queued : id === "human" ? counts.human + looseItems.length : counts[id])
  const filtered = Boolean(q || source !== "all" || taskId !== "all" || outcome !== "all")
  const nothingAtAll = !filtered && Object.values(counts).every((n) => n === 0) && humanItems.length === 0 && queued === 0
  // 排队中的页码超出（单刚开始办、少了一页）：回到最后一页
  const queueLast = Math.max(1, Math.ceil(queued / PAGE_SIZE))
  React.useEffect(() => {
    if (queueMode && queueQuery.data && !queueQuery.isPlaceholderData && pageParam > queueLast) setParams({ page: queueLast > 1 ? String(queueLast) : null })
  }, [queueMode, queueQuery.data, queueQuery.isPlaceholderData, pageParam, queueLast])

  // 打开的：派活单（W-…，排队中点开的）；这一页上的运行、没处理的事，都不是就按 id 取那次运行（可能在别的页）
  const rawId = params.get("id")
  const workId = rawId?.startsWith("W-") ? rawId : null
  const id = workId ? null : rawId
  const pageRun = findById(data?.items ?? [], id)
  const pickedItem = pageRun ? undefined : findById(humanItems, id)
  const fetched = useSessionQuery(id && !pageRun && !pickedItem && !boardQuery.isPending ? id : undefined)
  const selected: SessionSummary | HumanItem | undefined = pageRun ?? pickedItem ?? fetched.data
  // 关抽屉时 ?id= 先清掉了，留着上一个，让关闭动画有内容（派活单只留单号）
  const [shown, setShown] = React.useState<SessionSummary | HumanItem | string | undefined>(selected)
  if (selected && selected.id !== (typeof shown === "string" ? shown : shown?.id)) setShown(selected)
  if (workId && workId !== shown) setShown(workId)
  const current = workId ?? selected ?? shown
  const shownWork = typeof current === "string" ? current : undefined
  const run = current && typeof current !== "string" && "startedAt" in current ? current : undefined
  const item = current && typeof current !== "string" && !("startedAt" in current) ? current : undefined
  const task = run && findById(tasks, run.taskId)
  const close = () => setParams({ id: null })

  // 点一行：带上现在的标签、页码，只换 ?id=；翻页：只换 ?page=（第 1 页不写）
  const linkTo = (rowId: string) => href("sessions", { ...Object.fromEntries(params.entries()), id: rowId })
  const pageLink = (next: number) => href("sessions", { ...Object.fromEntries(params.entries()), page: next > 1 ? String(next) : null })
  // 换标签、只看等我处理、来源、结果、任务、搜索：回到第 1 页
  const firstPage = () => params.has("page") && setParams({ page: null })
  const pickGroup = (next: Group | "queue") => setParams({ status: next === DEFAULT_GROUP ? null : next, mine: null, page: null })
  // 点「开始」「结束」表头：换一列从新到旧，同一列再点换方向；默认的（开始、倒序）不写进网址
  const sortBy: SessionSort = {
    by: sort,
    dir,
    onSort: (column) => {
      const next = column === sort && dir === "desc" ? "asc" : "desc"
      setParams({ sort: column === "started" ? null : column, dir: next === "desc" ? null : next, page: null })
    },
  }
  // 已结束：办成、没办成、成功率（复核中的两边都不算）
  const { achieved, notAchieved } = data?.endedOutcome ?? { achieved: 0, notAchieved: 0 }
  const rate = achieved + notAchieved > 0 ? `${Math.round((achieved / (achieved + notAchieved)) * 100)}%` : "—"
  const filter = <T,>(set: (value: T) => void) => (value: T) => {
    set(value)
    firstPage()
  }
  const clear = () => {
    setSource("all")
    setTaskId("all")
    setOutcome("all")
    setQuery("")
    setParams({ status: null, mine: null, page: null })
  }
  // 排队中的「清空筛选」：只清任务和搜索，留在排队中
  const clearQueue = () => {
    setTaskId("all")
    setQuery("")
    firstPage()
  }

  const header = (
    <SimpleHeader title="会话" description="每次运行就是一个 session：正在跑的、等人处理的、挂起的、跑完的都在这里；要你处理的事也在「等人处理」里，派来还没开始办的单在「排队中」。" learnId="todo" />
  )
  const empty = (
    <EmptyState icon={<HistoryIcon />} title="还没有 session" description="任务运行一次就是一个 session。要等的时候 session 挂起，等到了继续同一个，不会新开。" />
  )

  return (
    <PageFrame header={header} queries={queries} isEmpty={nothingAtAll} empty={empty} skeleton="table">
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <ToggleGroup variant="outline" spacing={0} value={mine ? [] : [queueMode ? "queue" : group]} onValueChange={(value) => value[0] && pickGroup(value[0] as Group | "queue")} aria-label="按状态筛选">
            {TABS.map((each) => (
              <ToggleGroupItem key={each.id} value={each.id}>
                {each.name}
                <span className="tabular-nums text-muted-foreground">{count(each.id)}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <Toggle variant="outline" pressed={mine} onPressedChange={(on) => setParams({ mine: on ? "1" : null, page: null })} aria-label="只看等我处理的事">
            <UserIcon />
            只看等我处理
            <span className="tabular-nums text-muted-foreground">{myItems.length}</span>
          </Toggle>
          {/* 排队的单还没有运行：没有来源（都是派活）、没有结果，这两个下拉不显示 */}
          {!queueMode && (
            <>
              <Select items={SOURCE_ITEMS} value={source} onValueChange={(value) => value && filter(setSource)(String(value))}>
                <SelectTrigger className="w-32" aria-label="按来源筛选"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {SOURCE_ITEMS.map((each) => <SelectItem key={each.value} value={each.value}>{each.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <Select items={OUTCOME_ITEMS} value={outcome} onValueChange={(value) => value && filter(setOutcome)(String(value))}>
                <SelectTrigger className="w-32" aria-label="按结果筛选"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {OUTCOME_ITEMS.map((each) => <SelectItem key={each.value} value={each.value}>{each.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </>
          )}
          <TaskFilter value={taskId} onValueChange={filter(setTaskId)} tasks={tasks} />
          <InputGroup className="w-full sm:w-72">
            <InputGroupAddon><SearchIcon /></InputGroupAddon>
            <InputGroupInput
              value={query}
              onChange={(event) => filter(setQuery)(event.target.value)}
              placeholder={queueMode ? "搜单号、要办的事或参数" : "搜 session 编号、任务名或派活单号"}
              aria-label={queueMode ? "搜索排队的派活单" : "搜索 session"}
            />
          </InputGroup>
          <p className="text-xs tabular-nums text-muted-foreground lg:ml-auto">
            排队 {count("queue")} · 执行中 {count("running")} · 等人处理 {count("human")} · 今天花了 {money(data?.spentToday ?? 0)}
            {!mine && !queueMode && group === "ended" && ` · 办成 ${achieved} · 没办成 ${notAchieved} · 成功率 ${rate}`}
          </p>
        </div>
        {queueMode ? (
          queueItems.length > 0 ? (
            <>
              <QueueTable items={queueItems} stats={queueStats} selectedId={workId} linkTo={linkTo} />
              <QueueItems items={queueItems} stats={queueStats} selectedId={workId} linkTo={linkTo} />
              <SessionPager page={Math.min(pageParam, queueLast)} pageSize={PAGE_SIZE} total={queued} linkTo={pageLink} />
              <p className="text-xs text-muted-foreground">排队的派活单还没开运行。轮到了开一次运行，这张单就从这里消失，运行出现在「执行中」，来源写「派活 W-…」。</p>
            </>
          ) : (
            <EmptyState
              icon={<SearchXIcon />}
              title={q || taskId !== "all" ? "没有符合条件的单" : "没有排队的派活单"}
              description={q ? `没找到「${q}」，换个单号或参数试试。` : "派来的单有空位就马上开始办，排不上队的才在这里。"}
              action={(q || taskId !== "all") && <Button variant="outline" onClick={clearQueue}>清空筛选</Button>}
            />
          )
        ) : rows.length > 0 ? (
          <>
            <SessionTable rows={rows} tasks={tasks} selectedId={selected?.id} linkTo={linkTo} sort={sortBy} />
            <SessionItems rows={rows} tasks={tasks} selectedId={selected?.id} linkTo={linkTo} />
            <SessionPager page={page} pageSize={data?.pageSize ?? PAGE_SIZE} total={data?.total ?? 0} linkTo={pageLink} />
            <p className="text-xs text-muted-foreground">{footnote(mine ? "human" : group)}</p>
          </>
        ) : (
          <EmptyState
            icon={<SearchXIcon />}
            title={mine ? "没有等你处理的事" : "没有符合条件的 session"}
            description={q ? `没找到「${q}」，换个编号或任务名试试。` : mine ? "分给你的事都处理完了。" : "这一类现在没有 session。"}
            action={<Button variant="outline" onClick={clear}>清空筛选</Button>}
          />
        )}
      </div>
      <Sheet open={Boolean(selected) || Boolean(workId)} onOpenChange={(next) => !next && close()}>
        <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
          {shownWork && <WorkSheetBody id={shownWork} />}
          {run && task && <RunSheetBody run={run} task={task} />}
          {item && (
            <>
              <SheetHeader className="pr-12">
                <SheetTitle>要人办的事</SheetTitle>
                <SheetDescription>{item.runId ? `运行 ${item.runId} 里提出的，不挡着运行。` : "不属于哪次运行。"}批了或拒了，就从「等人处理」里去掉。</SheetDescription>
              </SheetHeader>
              <Separator />
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
                <HumanItemPanel key={item.id} item={item} onDone={close} />
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </PageFrame>
  )
}

/** 列表下面的一行小字 */
function footnote(group: Group) {
  if (group === "human") return "点一行就能处理：批准、拒绝、登录、验收争议都在打开的详情顶上。处理完，挂起的 session 接着跑，不会新开。"
  if (group === "waiting") return "挂起的 session 不占模型、不花钱；等到了从挂起的地方继续，前面的上下文都还在。"
  return "每次运行一行，点开看结果、检查点、验收和每次工具调用。"
}

/** 派活单的抽屉（排队中点开的）：头部右边「去任务看全部」到被派任务的抽屉里看这张单（返回就是任务的「派来的活」）；内容是单详情，能改参数、不办了 */
function WorkSheetBody({ id }: { id: string }) {
  const item = useQuery(trpc.work.get.queryOptions({ id })).data
  return (
    <>
      <SheetHeader className="flex-row flex-wrap items-center justify-between gap-2 pr-12">
        <div className="flex min-w-0 flex-col gap-0.5">
          <SheetTitle>派活单详情</SheetTitle>
          <SheetDescription>{item?.status === "queued" ? "还没开运行。轮到了开一次运行，单上会记下每次运行。" : "派给一个任务的一件事：参数、结果和每次运行。"}</SheetDescription>
        </div>
        {item && (
          <Button variant="outline" size="sm" nativeButton={false} render={<a href={workLink(item)} />}>
            去任务看全部
            <ArrowRightIcon data-icon="inline-end" />
          </Button>
        )}
      </SheetHeader>
      <Separator />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <WorkItemView id={id} />
      </div>
    </>
  )
}

/** 运行的抽屉：头部写是哪个任务的一次运行，右上角去任务；内容是完整的运行详情（等人处理的，处理面板在最上面） */
function RunSheetBody({ run, task }: { run: SessionSummary; task: TaskDef }) {
  return (
    <>
      <SheetHeader className="flex-row flex-wrap items-center justify-between gap-2 pr-12">
        <div className="flex min-w-0 flex-col gap-0.5">
          <SheetTitle>Session 详情</SheetTitle>
          <SheetDescription>任务 {task.id} 的一次运行：{run.status === "needs_human" ? "要你处理的事在最上面，" : ""}结果、检查点、验收、每次工具调用都在下面。</SheetDescription>
        </div>
        <Button variant="outline" size="sm" nativeButton={false} render={<a href={href("tasks", { id: task.id })} />}>
          查看任务 {task.id}
          <ArrowRightIcon data-icon="inline-end" />
        </Button>
      </SheetHeader>
      <Separator />
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">
        <RunDetail task={task} run={run} />
      </div>
    </>
  )
}
