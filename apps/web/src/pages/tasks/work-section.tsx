// 任务详情里的「派来的活」（能被派活的任务，2026-10-21 派活页并进来，docs/dev/work-into-tasks.md）：
// 名额一行 + 参数、谁能派一行；三个标签 没结束 / 办成 / 没办成（带张数）+ 搜单号、参数；派给这个任务的单，一张一行，点了在抽屉里看单详情（?work=W-…）；
// 「再看更多」往下翻。右上角「派一张」（负责人和主管）。
// 第三期（docs/dev/dispatch-p3.md 6.4 节）：名额那行加每天花费；设置那行加「外部系统能派活」「收到事件 … 派一张」；谁派的用 workFromText；优先级徽章。
// 还有抽屉里的「派一张」弹窗（任务已经选好），派出去以后提示，带「去看 W-…」。
import * as React from "react"
import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query"
import { SearchIcon, SendIcon } from "lucide-react"
import { can, type TaskDef, type WorkListView } from "@heyagent/shared"

import { DetailSection, HelpTip, PickItem } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group"
import { ItemGroup } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useStaffName, useTasksQuery } from "@/lib/data"
import { navigate } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { retryText } from "./dispatch-fields"
import { quotaText } from "./work-detail"
import { DispatchDialog, dispatchedToast } from "./work-dialogs"
import { WorkItemBadge, WorkPriorityBadge, timeText, useWorkTaskStats, workFromText, workLink } from "./work-parts"

// 没有「全部」：默认看没结束的；出错、「不办了」的单算在「没办成」里（按单的结果分，见 workItemOutcome）
const VIEWS: { id: WorkListView; name: string; count: "open" | "achieved" | "notAchieved" }[] = [
  { id: "open", name: "没结束", count: "open" },
  { id: "achieved", name: "办成", count: "achieved" },
  { id: "not_achieved", name: "没办成", count: "notAchieved" },
]

const PAGE_SIZE = 20

/** 搜索框停 300 ms 再查，不每敲一个字查一次 */
function useDebouncedText(text: string) {
  const [value, setValue] = React.useState(text)
  React.useEffect(() => {
    const timer = setTimeout(() => setValue(text), 300)
    return () => clearTimeout(timer)
  }, [text])
  return value
}

/** 能被派活的任务：派来的活 */
export function DispatchInSection({ task }: { task: TaskDef }) {
  const { user } = useMe()
  const staffName = useStaffName()
  const tasks = useTasksQuery().data ?? []
  const stats = useWorkTaskStats(task.id).data
  const [view, setView] = React.useState<WorkListView>("open")
  const [query, setQuery] = React.useState("")
  const [dispatching, setDispatching] = React.useState(false)
  const q = useDebouncedText(query.trim())
  const list = useInfiniteQuery(
    trpc.work.list.infiniteQueryOptions(
      { taskId: task.id, view, q: q || undefined, days: 0, limit: PAGE_SIZE },
      { getNextPageParam: (page) => page.nextCursor ?? undefined, placeholderData: keepPreviousData }
    )
  )
  const pages = list.data?.pages ?? []
  const items = pages.flatMap((page) => page.items)
  const counts = pages[0]?.counts
  const dispatch = task.dispatch!
  const title = (id: string) => tasks.find((each) => each.id === id)?.title ?? id
  const canManage = can(user, "task.manage", { ownerId: task.ownerId })

  return (
    <DetailSection
      title="派来的活"
      description="别的任务（或人）把一件件事派给这个任务，一件一张派活单，一张单开一次运行，办完把结果写回单上。同一件事只办一次。点一张单看参数、结果和每次运行。"
      action={
        canManage && (
          <Button size="sm" onClick={() => setDispatching(true)}>
            <SendIcon data-icon="inline-start" />
            派一张
          </Button>
        )
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1 text-xs text-muted-foreground">
          <p className="flex flex-wrap items-center gap-x-1">
            {stats ? quotaText(task, stats) : `同时最多 ${dispatch.maxRunning} 个在跑`} · {retryText(dispatch)}
            <HelpTip>执行中、验收中、等浏览器的运行占名额；agent 自己挂起等待、等人处理的不占，空出来的位子给下一张单。挂起的被叫醒继续时不卡名额，所以偶尔会比上限多。</HelpTip>
          </p>
          <p>
            参数：{dispatch.params.map((p) => `${p.name}（${[p.required ? "必填" : "可选", p.dedupe && "去重"].filter(Boolean).join("，")}）`).join("、") || "没有"}
            {dispatch.results?.length ? ` · 要交回：${dispatch.results.map((r) => `${r.name}${r.required ? "（必填）" : ""}`).join("、")}` : ""}
            {" · "}谁能派活给它：{task.dispatchFrom.length ? task.dispatchFrom.map((id) => `「${title(id)}」`).join("、") : "只能人派"}
            {dispatch.allowApi && " · 外部系统能派活"}
            {dispatch.events?.length ? ` · 收到事件 ${dispatch.events.map((each) => each.event).join("、")} 派一张` : ""}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <ToggleGroup variant="outline" size="sm" spacing={0} value={[view]} onValueChange={(value) => value[0] && setView(value[0] as WorkListView)} aria-label="派来的活按结果筛选">
            {VIEWS.map((each) => (
              <ToggleGroupItem key={each.id} value={each.id}>
                {each.name}
                <span className="tabular-nums text-muted-foreground">{counts?.[each.count] ?? 0}</span>
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          <InputGroup className="w-full sm:w-56">
            <InputGroupAddon>
              <SearchIcon />
            </InputGroupAddon>
            <InputGroupInput placeholder="搜单号、参数" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="搜派来的活" />
            {list.isFetching && !list.isFetchingNextPage && (
              <InputGroupAddon align="inline-end">
                <Spinner />
              </InputGroupAddon>
            )}
          </InputGroup>
        </div>
        {list.isPending ? (
          <Spinner />
        ) : items.length > 0 ? (
          <ItemGroup className="gap-1">
            {items.map((item) => (
              <PickItem
                key={item.id}
                to={workLink(item)}
                selected={false}
                title={item.title}
                description={[
                  item.id,
                  timeText(item.createdAt),
                  workFromText(item, staffName),
                  item.sessionId,
                ]
                  .filter(Boolean)
                  .join(" · ")}
                badge={
                  <>
                    <WorkPriorityBadge priority={item.priority} />
                    <WorkItemBadge item={item} long />
                  </>
                }
              />
            ))}
          </ItemGroup>
        ) : (
          <p className="text-muted-foreground">
            {q ? `没找到「${q}」，换个单号或参数试试。` : view === "open" ? "现在没有排队、在办的单。" : `还没有${VIEWS.find((each) => each.id === view)?.name}的单。`}
          </p>
        )}
        {list.hasNextPage && (
          <Button variant="outline" size="sm" className="self-center" disabled={list.isFetchingNextPage} onClick={() => void list.fetchNextPage()}>
            {list.isFetchingNextPage && <Spinner data-icon="inline-start" />}
            再看更多
          </Button>
        )}
      </div>
      {canManage && <TaskDispatchDialog task={task} open={dispatching} onOpenChange={setDispatching} />}
    </DetailSection>
  )
}

/** 抽屉里的「派一张」：任务已经选好；派出去以后提示，带「去看 W-…」（在这个任务的抽屉里打开那张单） */
export function TaskDispatchDialog({ task, open, onOpenChange }: { task: TaskDef; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user } = useMe()
  const tasks = useTasksQuery().data ?? []
  const options = tasks.filter((each) => each.dispatch && can(user, "task.manage", { ownerId: each.ownerId }))
  return (
    <DispatchDialog
      key={open ? "open" : "closed"}
      open={open}
      onOpenChange={onOpenChange}
      taskOptions={options.some((each) => each.id === task.id) ? options : [task, ...options]}
      initialTaskId={task.id}
      onDone={(item, existing) => {
        onOpenChange(false)
        dispatchedToast(item, existing, tasks.find((each) => each.id === item.taskId)?.enabled ?? true, {
          label: `去看 ${item.id}`,
          onClick: () => navigate("tasks", { id: item.taskId, work: item.id }),
        })
      }}
    />
  )
}
