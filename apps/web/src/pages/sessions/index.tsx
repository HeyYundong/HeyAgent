// Session（v3）：一个列表看全部 session——正在跑的、挂起的、跑完的。任务每运行一次就是一个 session；
// 要等的时候挂起（不占模型、不花钱），等到了继续同一个 session。点一行从右侧打开这次运行的完整详情（?id=）。
import * as React from "react"
import { ArrowRightIcon, HistoryIcon, SearchIcon, SearchXIcon } from "lucide-react"

import { EmptyState, PageFrame, SimpleHeader } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Separator } from "@/components/ui/separator"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { href, setParams, useRoute } from "@/lib/router"
import { findById, groupOf, isToday, sessionGroups as groups, sortRuns, type SessionGroup as Group, type SessionRun } from "@heyagent/shared"

import { useBoardQuery, useModelsQuery, useSessionsQuery, useStaffQuery, useTasksQuery, useToolsQuery } from "@/lib/data"
import { money } from "@/pages/tasks/parts"
import { RunDetail } from "@/pages/tasks/run-detail"

import { SOURCE_LABEL, SessionItems, SessionTable } from "./list"

const SOURCE_ITEMS = [{ value: "all", label: "全部来源" }, ...Object.entries(SOURCE_LABEL).map(([value, label]) => ({ value, label }))]

export default function SessionsPage() {
  const { params } = useRoute()
  const [group, setGroup] = React.useState<Group>("all")
  const [query, setQuery] = React.useState(() => params.get("q") ?? "") // 别的页面可以带 ?q= 过来
  // 来源：手动 / 定时 / 待办 / 事件 / 派活（派活加的，可以只看派活触发的）
  const [source, setSource] = React.useState(() => params.get("source") ?? "all")

  const sessionsQuery = useSessionsQuery()
  const tasksQuery = useTasksQuery()
  // 列表和抽屉里还要：人名、模型名、挡住运行的事、工具名
  const queries = [sessionsQuery, tasksQuery, useStaffQuery(), useModelsQuery(), useBoardQuery(), useToolsQuery()]
  const tasks = tasksQuery.data ?? []

  // 已定：员工也能看全部 session（只读）。这一页本来就没有操作，主管和员工看到的一样
  const allRuns = sortRuns(sessionsQuery.data ?? [])
  const count = (id: Group) => (id === "all" ? allRuns.length : allRuns.filter((run) => groupOf(run) === id).length)
  const q = query.trim().toLowerCase()
  const shownList = allRuns.filter((run) => {
    if (group !== "all" && groupOf(run) !== group) return false
    if (source !== "all" && run.source !== source) return false
    if (!q) return true
    const title = findById(tasks, run.taskId)?.title ?? ""
    return run.id.toLowerCase().includes(q) || run.taskId.toLowerCase().includes(q) || title.toLowerCase().includes(q) || Boolean(run.workItemId?.toLowerCase().includes(q))
  })
  const spentToday = allRuns.filter(isToday).reduce((sum, run) => sum + run.costUsd, 0)

  const selected = findById(allRuns, params.get("id"))
  // 关抽屉时 ?id= 先清掉了，留着上一个 session，让关闭动画有内容
  const [shown, setShown] = React.useState<SessionRun | undefined>(selected)
  if (selected && selected.id !== shown?.id) setShown(selected)
  const run = selected ?? shown
  const task = run && findById(tasks, run.taskId)
  const clear = () => {
    setGroup("all")
    setSource("all")
    setQuery("")
  }

  const header = (
    <SimpleHeader title="会话" description="每次运行就是一个 session：正在跑的、挂起的、跑完的都在这里。" learnId="task" />
  )
  const empty = (
    <EmptyState icon={<HistoryIcon />} title="还没有 session" description="任务运行一次就是一个 session。要等的时候 session 挂起，等到了继续同一个，不会新开。" />
  )

  return (
    <PageFrame header={header} queries={queries} isEmpty={allRuns.length === 0} empty={empty} skeleton="table">
      {allRuns.length === 0 ? (
        empty
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <ToggleGroup variant="outline" spacing={0} value={[group]} onValueChange={(value) => value[0] && setGroup(value[0] as Group)} aria-label="按状态筛选">
              {groups.map((each) => (
                <ToggleGroupItem key={each.id} value={each.id}>
                  {each.name}
                  <span className="tabular-nums text-muted-foreground">{count(each.id)}</span>
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            <Select items={SOURCE_ITEMS} value={source} onValueChange={(value) => value && setSource(String(value))}>
              <SelectTrigger className="w-32" aria-label="按来源筛选"><SelectValue /></SelectTrigger>
              <SelectContent>
                {SOURCE_ITEMS.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}
              </SelectContent>
            </Select>
            <InputGroup className="w-full sm:w-72">
              <InputGroupAddon><SearchIcon /></InputGroupAddon>
              <InputGroupInput value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜 session 编号、任务名或派活单号" aria-label="搜索 session" />
            </InputGroup>
            <p className="text-xs tabular-nums text-muted-foreground lg:ml-auto">
              进行中 {count("active")} · 挂起 {count("paused")} · 今天花了 {money(spentToday)}
            </p>
          </div>
          {shownList.length > 0 ? (
            <>
              <SessionTable list={shownList} tasks={tasks} selectedId={selected?.id} />
              <SessionItems list={shownList} tasks={tasks} selectedId={selected?.id} />
              <p className="text-xs text-muted-foreground">挂起的 session 不占模型、不花钱；等到了从挂起的地方继续，前面的上下文都还在。</p>
            </>
          ) : (
            <EmptyState
              icon={<SearchXIcon />}
              title="没有符合条件的 session"
              description={q ? `没找到「${query.trim()}」，换个编号或任务名试试。` : "这一类现在没有 session。"}
              action={<Button variant="outline" onClick={clear}>清空筛选</Button>}
            />
          )}
        </div>
      )}
      <Sheet open={Boolean(selected)} onOpenChange={(next) => !next && setParams({ id: null })}>
        <SheetContent className="gap-0 data-[side=right]:w-full data-[side=right]:sm:max-w-3xl">
          {run && task && (
            <>
              <SheetHeader className="flex-row flex-wrap items-center justify-between gap-2 pr-12">
                <div className="flex min-w-0 flex-col gap-0.5">
                  <SheetTitle>Session 详情</SheetTitle>
                  <SheetDescription>任务 {task.id} 的一次运行：检查点、每次工具调用、验收都在下面。</SheetDescription>
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
          )}
        </SheetContent>
      </Sheet>
    </PageFrame>
  )
}
