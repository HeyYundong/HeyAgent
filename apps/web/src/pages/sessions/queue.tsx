// 会话页「排队中」（2026-10-21 派活页并进来，docs/dev/work-into-tasks.md）：全部任务里排队的派活单，还没开运行，所以没有 session。
// 宽屏是表格（状态 / 派活单 / 要办的事 / 被派的任务 / 谁派的 / 派的时间 / 在等什么），窄屏一条一个 Item；点一行从右侧打开单详情（?status=queue&id=W-…）。
// 「在等什么」和单详情最上面的提示同一套判断（queueWaitText）：等自动重试、任务停用了、名额满了（谁占着）。
import { startText, type WorkItem, type WorkQueueStats } from "@heyagent/shared"

import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useStaffName } from "@/lib/data"
import { WorkStatusBadge, queueWaitText, shortName } from "@/pages/tasks/work-parts"

interface QueueProps {
  items: WorkItem[]
  stats: WorkQueueStats[]
  selectedId?: string | null
  /** 点一行去哪：带上现在的筛选，只换 ?id= */
  linkTo: (id: string) => string
}

/** 谁派的：「巡检…派的」（agent）/「王悦派的」（人） */
function useFromText() {
  const staffName = useStaffName()
  return (item: WorkItem) => (item.via === "agent" ? `${shortName(item.fromTaskTitle)}派的` : `${staffName(item.fromUserId ?? undefined)}派的`)
}

export function QueueTable({ items, stats, selectedId, linkTo }: QueueProps) {
  const fromText = useFromText()
  return (
    <div className="hidden border md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>状态</TableHead>
            <TableHead>派活单</TableHead>
            <TableHead>要办的事</TableHead>
            <TableHead>被派的任务</TableHead>
            <TableHead>谁派的</TableHead>
            <TableHead>派的时间</TableHead>
            <TableHead>在等什么</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const wait = queueWaitText(item, stats.find((each) => each.taskId === item.taskId))
            return (
              <TableRow key={item.id} className="relative" data-state={item.id === selectedId ? "selected" : undefined}>
                <TableCell><WorkStatusBadge item={item} long /></TableCell>
                <TableCell className="font-mono">
                  {/* 整行可点：链接铺满这一行 */}
                  <a href={linkTo(item.id)} className="after:absolute after:inset-0 hover:underline">{item.id}</a>
                </TableCell>
                <TableCell className="max-w-64 truncate" title={item.title}>{item.title}</TableCell>
                <TableCell className="max-w-56 truncate" title={item.taskTitle}>{item.taskTitle}</TableCell>
                <TableCell className="text-muted-foreground">{fromText(item)}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">{startText(item.createdAt)}</TableCell>
                <TableCell className="max-w-72 truncate" title={wait}>{wait}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

/** 窄屏：一条一个 Item——单号和要办的事 / 在等什么 / 被派的任务、谁派的、时间；右边是状态 */
export function QueueItems({ items, stats, selectedId, linkTo }: QueueProps) {
  const fromText = useFromText()
  return (
    <ItemGroup className="gap-2 md:hidden">
      {items.map((item) => (
        <Item key={item.id} variant={item.id === selectedId ? "outline" : "muted"} render={<a href={linkTo(item.id)} />}>
          <ItemContent className="min-w-0">
            <ItemTitle className="w-full">
              <span className="shrink-0 font-mono">{item.id}</span>
              <span className="truncate">{item.title}</span>
            </ItemTitle>
            <ItemDescription className="line-clamp-1">{queueWaitText(item, stats.find((each) => each.taskId === item.taskId))}</ItemDescription>
            <ItemDescription className="line-clamp-1 tabular-nums">
              {shortName(item.taskTitle)} · {fromText(item)} · {startText(item.createdAt)}
            </ItemDescription>
          </ItemContent>
          <ItemActions className="flex-col items-end self-start">
            <WorkStatusBadge item={item} long />
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  )
}
