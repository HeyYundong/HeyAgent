// 会话页「排队中」（2026-10-21 派活页并进来，docs/dev/work-into-tasks.md）：全部任务里排队的派活单，还没开运行，所以没有 session。
// 宽屏是表格（状态 / 派活单 / 要办的事 / 被派的任务 / 谁派的 / 派的时间 / 在等什么），窄屏一条一个 Item；点一行从右侧打开单详情（?status=queue&id=W-…）。
// 「在等什么」和单详情最上面的提示同一套判断（queueWaitText）：等自动重试、定了时间、任务停用了、花费到了上限、名额满了（谁占着）。
// 谁派的用 workFromText（第三期加外部系统、外部事件）；优先级不是普通的，状态旁多一个徽章。
// 现在就办（2026-10-30 用户要求）：宽屏每行最后一个「⋯」菜单（负责人和主管），浮在整行链接上面（relative z-10，同 list.tsx 的 RowActions）；
// 任务停用了、名额满了等先确认跳过了什么。窄屏一条是整条链接，不放按钮，在抽屉（单详情）里点。
import * as React from "react"
import { EllipsisIcon, PlayIcon } from "lucide-react"
import { can, findById, startText, type TaskDef, type WorkItem, type WorkQueueStats } from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { useStaffName } from "@/lib/data"
import { useMe } from "@/lib/session"
import { StartNowDialog, useStartNow, type StartNowTarget } from "@/pages/tasks/work-dialogs"
import { WorkPriorityBadge, WorkStatusBadge, queueWaitText, shortName, startNowBypass, workFromText } from "@/pages/tasks/work-parts"

interface QueueProps {
  items: WorkItem[]
  stats: WorkQueueStats[]
  selectedId?: string | null
  /** 点一行去哪：带上现在的筛选，只换 ?id= */
  linkTo: (id: string) => string
}

/** 谁派的：「「巡检」派的」「王悦派的」「外部系统（密钥「…」）派的」「外部事件「…」派的」 */
function useFromText() {
  const staffName = useStaffName()
  return (item: WorkItem) => workFromText(item, staffName)
}

export function QueueTable({ items, stats, selectedId, linkTo, tasks }: QueueProps & { tasks: TaskDef[] }) {
  const fromText = useFromText()
  const { user } = useMe()
  const [starting, setStarting] = React.useState<StartNowTarget | null>(null)
  const startNow = useStartNow()
  const onStartNow = (item: WorkItem, itemStats?: WorkQueueStats) => {
    // 没取到名额数字时按停用、定时间算（任务列表里有没有停用）
    const task = findById(tasks, item.taskId)
    const bypass = startNowBypass(item, { enabled: itemStats?.enabled ?? task?.enabled ?? true, dispatchable: itemStats?.dispatchable ?? Boolean(task?.dispatch) }, itemStats)
    if (bypass) setStarting({ id: item.id, bypass })
    else startNow.mutate({ id: item.id })
  }
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
            <TableHead className="w-10"><span className="sr-only">操作</span></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => {
            const itemStats = stats.find((each) => each.taskId === item.taskId)
            const wait = queueWaitText(item, itemStats)
            const task = findById(tasks, item.taskId)
            return (
              <TableRow key={item.id} className="relative" data-state={item.id === selectedId ? "selected" : undefined}>
                <TableCell>
                  <span className="flex items-center gap-1">
                    <WorkStatusBadge item={item} long />
                    <WorkPriorityBadge priority={item.priority} />
                  </span>
                </TableCell>
                <TableCell className="font-mono">
                  {/* 整行可点：链接铺满这一行 */}
                  <a href={linkTo(item.id)} className="after:absolute after:inset-0 hover:underline">{item.id}</a>
                </TableCell>
                <TableCell className="max-w-64 truncate" title={item.title}>{item.title}</TableCell>
                <TableCell className="max-w-56 truncate" title={item.taskTitle}>{item.taskTitle}</TableCell>
                <TableCell className="text-muted-foreground">{fromText(item)}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">{startText(item.createdAt)}</TableCell>
                <TableCell className="max-w-72 truncate" title={wait}>{wait}</TableCell>
                <TableCell>
                  {task && can(user, "work.manage", { taskOwnerId: task.ownerId }) && (
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="relative z-10" aria-label={`${item.id} 的更多操作`} />}>
                        <EllipsisIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-40">
                        <DropdownMenuItem onClick={() => onStartNow(item, itemStats)}>
                          <PlayIcon />
                          现在就办
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
      <StartNowDialog target={starting} onClose={() => setStarting(null)} />
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
            <WorkPriorityBadge priority={item.priority} />
          </ItemActions>
        </Item>
      ))}
    </ItemGroup>
  )
}
