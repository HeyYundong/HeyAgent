// Session 列表：宽屏是表格（一行一个 session），窄屏是一条一个 Item。点一行打开右侧抽屉（?id=）。
// 宽屏每一行的结果徽章旁边有「更多」菜单：已经结束的运行（已结束、出错、取消的），负责人和主管能直接「改结果」（和运行详情同一个弹窗）。
// 窄屏一条就是一个链接，里面不放按钮：点开抽屉，在「结果」区块里改。
import * as React from "react"
import { EllipsisIcon, PencilIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { href } from "@/lib/router"
import { can, endedText, findById, groupOf, isReviewing, isRunEnded, outcomeOf, outcomeReasonOf, startText, type SessionSummary, type TaskDef } from "@heyagent/shared"

import { OutcomeBadge } from "@/components/shell/outcome-badge"

import { useModels, useRunNow, useStaffName } from "@/lib/data"
import { useMe } from "@/lib/session"
import { Elapsed, RunStatusBadge, money, tokens } from "@/pages/tasks/parts"
import { SetOutcomeDialog } from "@/pages/tasks/run-outcome"

/** 「时长或在等什么」：执行中跳秒（和任务页同一个 Elapsed）；验收中写验收到哪；挂起写在等什么；已结束写总时长（挂起过的带上挂起多久） */
export function NowText({ run }: { run: SessionSummary }) {
  const runNow = useRunNow()
  if (run.status === "running") return <Elapsed since={run.startedAt} />
  const group = groupOf(run)
  const text = group === "ended" ? endedText(run) : `${group === "active" ? "验收中" : "在等"}：${runNow(run).text}`
  return <span title={text} className={group === "paused" ? "text-foreground" : "text-muted-foreground"}>{text}</span>
}

/** 一次运行的结果徽章：还没结束写「—」，复核还在跑写「复核中」，悬停看原因 */
export const RunOutcome = ({ run, className }: { run: SessionSummary; className?: string }) => (
  <OutcomeBadge outcome={outcomeOf(run)} reason={outcomeReasonOf(run)} reviewing={isReviewing(run)} className={className} />
)

/** 一行的「更多」菜单：现在只有「改结果」，只给已经结束的运行、负责人和主管。浮在整行链接上面（relative z-10） */
function RowActions({ run, task }: { run: SessionSummary; task?: TaskDef }) {
  const { user } = useMe()
  const [editing, setEditing] = React.useState(false)
  if (!task || !isRunEnded(run.status) || !can(user, "task.manage", { ownerId: task.ownerId })) return null
  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" className="relative z-10" aria-label={`${run.id} 的更多操作`} />}>
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          <DropdownMenuItem onClick={() => setEditing(true)}>
            <PencilIcon />
            改结果
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SetOutcomeDialog key={`${run.id}-${editing}`} run={run} open={editing} onOpenChange={setEditing} />
    </>
  )
}

const link = (run: SessionSummary) => href("sessions", { id: run.id })

/** 来源（怎么开始的）：手动 / 定时 / 待办 / 事件 / 派活。老数据没有来源 */
export const SOURCE_LABEL: Record<string, string> = { manual: "手动", cron: "定时", todo: "待办", event: "事件", dispatch: "派活" }

/** 「定时」「派活 W-57」 */
export const sourceText = (run: SessionSummary) => `${(run.source && SOURCE_LABEL[run.source]) || "—"}${run.workItemId ? ` ${run.workItemId}` : ""}`

interface ListProps {
  list: SessionSummary[]
  tasks: TaskDef[]
  selectedId?: string
}

export function SessionTable({ list, tasks, selectedId }: ListProps) {
  const staffName = useStaffName()
  const { modelName } = useModels()
  const shortModel = (id: string) => modelName(id).replace(/^Claude /, "")
  return (
    <div className="hidden border md:block">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>状态</TableHead>
            <TableHead>结果</TableHead>
            <TableHead>Session</TableHead>
            <TableHead>任务</TableHead>
            <TableHead>来源</TableHead>
            <TableHead>负责人</TableHead>
            <TableHead>模型</TableHead>
            <TableHead>开始</TableHead>
            <TableHead>时长 / 在等什么</TableHead>
            <TableHead className="text-right">token</TableHead>
            <TableHead className="text-right">花费</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {list.map((run) => {
            const task = findById(tasks, run.taskId)
            return (
              <TableRow key={run.id} className="relative" data-state={run.id === selectedId ? "selected" : undefined}>
                <TableCell><RunStatusBadge status={run.status} /></TableCell>
                {/* 结果徽章浮在整行链接上面，鼠标放上去能看到原因 */}
                <TableCell>
                  <div className="flex items-center gap-1">
                    <RunOutcome run={run} className="relative z-10" />
                    <RowActions run={run} task={task} />
                  </div>
                </TableCell>
                <TableCell className="font-mono">
                  {/* 整行可点：链接铺满这一行 */}
                  <a href={link(run)} className="after:absolute after:inset-0 hover:underline">{run.id}</a>
                </TableCell>
                <TableCell className="max-w-64 truncate" title={task?.title}>{task?.title ?? run.taskId}</TableCell>
                <TableCell className="text-muted-foreground">{sourceText(run)}</TableCell>
                <TableCell>{staffName(task?.ownerId)}</TableCell>
                <TableCell className="text-muted-foreground">{shortModel(run.modelId)}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">{startText(run.startedAt)}</TableCell>
                <TableCell className="max-w-72 truncate"><NowText run={run} /></TableCell>
                <TableCell className="text-right tabular-nums">{tokens(run.tokensIn + run.tokensOut)}</TableCell>
                <TableCell className="text-right tabular-nums">{money(run.costUsd)}</TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}

/** 窄屏：一条一个 Item，三行——编号和任务 / 在等什么或时长 / 负责人、开始、花费；右边是状态和结果 */
export function SessionItems({ list, tasks, selectedId }: ListProps) {
  const staffName = useStaffName()
  return (
    <ItemGroup className="gap-2 md:hidden">
      {list.map((run) => {
        const task = findById(tasks, run.taskId)
        return (
          <Item key={run.id} variant={run.id === selectedId ? "outline" : "muted"} render={<a href={link(run)} />}>
            <ItemContent className="min-w-0">
              <ItemTitle className="w-full">
                <span className="shrink-0 font-mono">{run.id}</span>
                <span className="truncate">{task?.title ?? run.taskId}</span>
              </ItemTitle>
              <ItemDescription className="line-clamp-1"><NowText run={run} /></ItemDescription>
              <ItemDescription className="tabular-nums">
                {sourceText(run)} · {staffName(task?.ownerId)} · {startText(run.startedAt)} · {money(run.costUsd)}
              </ItemDescription>
            </ItemContent>
            <ItemActions className="flex-col items-end self-start">
              <RunStatusBadge status={run.status} />
              {(outcomeOf(run) || isReviewing(run)) && <RunOutcome run={run} />}
            </ItemActions>
          </Item>
        )
      })}
    </ItemGroup>
  )
}
