// Session 列表：宽屏是表格（一行一个 session），窄屏是一条一个 Item。点一行打开右侧抽屉（?id=）。
// 「等人处理」里除了运行，还有不挡运行的「要人办的事」（记忆审核、技能修改，或运行已经不在等人的），它们也是一行：点开是这件事的处理面板。
// 等人处理的运行，状态徽章写清是哪种事挡着（「等人处理 · 登录」），「在等什么」写那件事的标题。
// 宽屏每一行的结果徽章旁边有「更多」菜单：已经结束的运行（已结束、出错、取消的），负责人和主管能直接「改结果」（和运行详情同一个弹窗）。
// 窄屏一条就是一个链接，里面不放按钮：点开抽屉，在「结果」区块里改。
// 翻页在服务端（sessions.page），这里只画列表下面的页码；页码在网址 ?page=，第 1 页不写。
import * as React from "react"
import { EllipsisIcon, HandIcon, PencilIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Pagination, PaginationContent, PaginationEllipsis, PaginationItem, PaginationLink, PaginationNext, PaginationPrevious } from "@/components/ui/pagination"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { can, endedText, findById, groupOf, isReviewing, isRunEnded, outcomeOf, outcomeReasonOf, startText, type HumanItem, type SessionSummary, type TaskDef } from "@heyagent/shared"

import { OutcomeBadge } from "@/components/shell/outcome-badge"

import { useModels, useRunNow, useStaffName } from "@/lib/data"
import { useMe } from "@/lib/session"
import { Elapsed, RunStatusBadge, money, tokens } from "@/pages/tasks/parts"
import { SetOutcomeDialog } from "@/pages/tasks/run-outcome"

import { HUMAN_KIND_LABEL } from "./human-item"

/** 列表的一行：一次运行（items = 挡住它的事，只有等人处理的运行有），或一件不挡运行的「要人办的事」 */
export type Row = { kind: "run"; id: string; run: SessionSummary; items: HumanItem[] } | { kind: "item"; id: string; item: HumanItem }

/** 「时长或在等什么」：执行中跳秒（和任务页同一个 Elapsed）；验收中写验收到哪；等人处理写挡着的事；挂起写在等什么；已结束写总时长（挂起过的带上挂起多久） */
export function NowText({ run, items = [] }: { run: SessionSummary; items?: HumanItem[] }) {
  const runNow = useRunNow()
  if (run.status === "running") return <Elapsed since={run.startedAt} />
  const group = groupOf(run)
  const text = group === "ended" ? endedText(run) : group === "human" && items.length ? items.map((item) => item.title).join("；") : `${group === "verifying" ? "验收中" : "在等"}：${runNow(run).text}`
  return <span title={text} className={group === "waiting" || group === "human" ? "text-foreground" : "text-muted-foreground"}>{text}</span>
}

/** 「等人处理 · 登录」：等人处理的运行写挡着的是哪种事（几种不同的用「、」连），不挡运行的事写它自己的种类 */
export function HumanBadge({ items }: { items: HumanItem[] }) {
  const kinds = [...new Set(items.map((item) => HUMAN_KIND_LABEL[item.kind]))]
  return <Badge variant="secondary"><HandIcon data-icon="inline-start" />等人处理{kinds.length > 0 && ` · ${kinds.join("、")}`}</Badge>
}

/** 一次运行的结果徽章：还没结束写「—」，复核还在跑写「复核中」，悬停看原因 */
export const RunOutcome = ({ run, className }: { run: SessionSummary; className?: string }) => (
  <OutcomeBadge outcome={outcomeOf(run)} reason={outcomeReasonOf(run)} reviewing={isReviewing(run)} className={className} />
)

/** 运行的状态徽章：等人处理且知道挡着的是什么事时写清楚 */
const StatusOf = ({ run, items }: { run: SessionSummary; items: HumanItem[] }) => (run.status === "needs_human" && items.length ? <HumanBadge items={items} /> : <RunStatusBadge status={run.status} />)

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

/** 来源（怎么开始的）：手动 / 定时 / 人加的（待办到点）/ 事件 / 派活。老数据没有来源 */
export const SOURCE_LABEL: Record<string, string> = { manual: "手动", cron: "定时", todo: "人加的", event: "事件", dispatch: "派活" }

/** 「定时」「派活 W-57」 */
export const sourceText = (run: SessionSummary) => `${(run.source && SOURCE_LABEL[run.source]) || "—"}${run.workItemId ? ` ${run.workItemId}` : ""}`

/** 分给谁：分给自己的加个「我」 */
function Assignee({ item }: { item: HumanItem }) {
  const { user } = useMe()
  const staffName = useStaffName()
  return (
    <span className="inline-flex items-center gap-1">
      {staffName(item.assigneeId)}
      {item.assigneeId === user.id && <Badge variant="outline">我</Badge>}
    </span>
  )
}

interface ListProps {
  rows: Row[]
  tasks: TaskDef[]
  selectedId?: string
  /** 点一行去哪：带上现在的筛选，只换 ?id= */
  linkTo: (id: string) => string
}

export function SessionTable({ rows, tasks, selectedId, linkTo }: ListProps) {
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
          {rows.map((row) => {
            if (row.kind === "item") {
              const { item } = row
              const task = findById(tasks, item.taskId)
              return (
                <TableRow key={row.id} className="relative" data-state={row.id === selectedId ? "selected" : undefined}>
                  <TableCell><HumanBadge items={[item]} /></TableCell>
                  <TableCell className="text-muted-foreground">—</TableCell>
                  <TableCell className="font-mono">
                    {/* 整行可点：链接铺满这一行 */}
                    <a href={linkTo(item.id)} className="after:absolute after:inset-0 hover:underline" aria-label={`处理「${item.title}」`}>{item.runId ?? "—"}</a>
                  </TableCell>
                  <TableCell className={task ? "max-w-64 truncate" : "text-muted-foreground"} title={task?.title}>{task?.title ?? item.taskId ?? "不属于任务"}</TableCell>
                  <TableCell className="text-muted-foreground">—</TableCell>
                  <TableCell><Assignee item={item} /></TableCell>
                  <TableCell className="text-muted-foreground">—</TableCell>
                  <TableCell className="tabular-nums text-muted-foreground">{startText(item.createdAt)}</TableCell>
                  <TableCell className="max-w-72 truncate" title={item.title}>{item.title}</TableCell>
                  <TableCell className="text-right text-muted-foreground">—</TableCell>
                  <TableCell className="text-right text-muted-foreground">—</TableCell>
                </TableRow>
              )
            }
            const { run, items } = row
            const task = findById(tasks, run.taskId)
            return (
              <TableRow key={row.id} className="relative" data-state={row.id === selectedId ? "selected" : undefined}>
                <TableCell><StatusOf run={run} items={items} /></TableCell>
                {/* 结果徽章浮在整行链接上面，鼠标放上去能看到原因 */}
                <TableCell>
                  <div className="flex items-center gap-1">
                    <RunOutcome run={run} className="relative z-10" />
                    <RowActions run={run} task={task} />
                  </div>
                </TableCell>
                <TableCell className="font-mono">
                  {/* 整行可点：链接铺满这一行 */}
                  <a href={linkTo(run.id)} className="after:absolute after:inset-0 hover:underline">{run.id}</a>
                </TableCell>
                <TableCell className="max-w-64 truncate" title={task?.title}>{task?.title ?? run.taskId}</TableCell>
                <TableCell className="text-muted-foreground">{sourceText(run)}</TableCell>
                <TableCell>{staffName(task?.ownerId)}</TableCell>
                <TableCell className="text-muted-foreground">{shortModel(run.modelId)}</TableCell>
                <TableCell className="tabular-nums text-muted-foreground">{startText(run.startedAt)}</TableCell>
                <TableCell className="max-w-72 truncate"><NowText run={run} items={items} /></TableCell>
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
export function SessionItems({ rows, tasks, selectedId, linkTo }: ListProps) {
  const staffName = useStaffName()
  return (
    <ItemGroup className="gap-2 md:hidden">
      {rows.map((row) => {
        if (row.kind === "item") {
          const { item } = row
          const task = findById(tasks, item.taskId)
          return (
            <Item key={row.id} variant={row.id === selectedId ? "outline" : "muted"} render={<a href={linkTo(item.id)} />}>
              <ItemContent className="min-w-0">
                <ItemTitle className="w-full"><span className="truncate">{item.title}</span></ItemTitle>
                <ItemDescription className="line-clamp-1">{task?.title ?? item.taskId ?? "不属于任务"}{item.runId && ` · ${item.runId}`}</ItemDescription>
                <ItemDescription className="tabular-nums">分给 <Assignee item={item} /> · {startText(item.createdAt)}</ItemDescription>
              </ItemContent>
              <ItemActions className="flex-col items-end self-start">
                <HumanBadge items={[item]} />
              </ItemActions>
            </Item>
          )
        }
        const { run, items } = row
        const task = findById(tasks, run.taskId)
        return (
          <Item key={row.id} variant={row.id === selectedId ? "outline" : "muted"} render={<a href={linkTo(run.id)} />}>
            <ItemContent className="min-w-0">
              <ItemTitle className="w-full">
                <span className="shrink-0 font-mono">{run.id}</span>
                <span className="truncate">{task?.title ?? run.taskId}</span>
              </ItemTitle>
              <ItemDescription className="line-clamp-1"><NowText run={run} items={items} /></ItemDescription>
              <ItemDescription className="tabular-nums">
                {sourceText(run)} · {staffName(task?.ownerId)} · {startText(run.startedAt)} · {money(run.costUsd)}
              </ItemDescription>
            </ItemContent>
            <ItemActions className="flex-col items-end self-start">
              <StatusOf run={run} items={items} />
              {(outcomeOf(run) || isReviewing(run)) && <RunOutcome run={run} />}
            </ItemActions>
          </Item>
        )
      })}
    </ItemGroup>
  )
}

/** 要显示的页码：第一页、最后一页、当前页前后各一页，中间断开的地方是 null（显示省略号） */
function pageNumbers(page: number, count: number): (number | null)[] {
  const keep = [...new Set([1, page - 1, page, page + 1, count])].filter((n) => n >= 1 && n <= count).sort((a, b) => a - b)
  return keep.flatMap((n, index) => (index > 0 && n - keep[index - 1]! > 1 ? [null, n] : [n]))
}

/** 列表下面的翻页：上一页 / 页码 / 下一页，和「第 1–50 条，共 132 条」。只有一页时不显示 */
export function SessionPager({ page, pageSize, total, linkTo }: { page: number; pageSize: number; total: number; linkTo: (page: number) => string }) {
  const count = Math.ceil(total / pageSize)
  if (count <= 1) return null
  const from = (page - 1) * pageSize + 1
  const to = Math.min(total, page * pageSize)
  return (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs tabular-nums text-muted-foreground">第 {from}–{to} 条，共 {total} 条</p>
      <Pagination className="mx-0 w-auto">
        <PaginationContent>
          {page > 1 && <PaginationItem><PaginationPrevious href={linkTo(page - 1)} text="上一页" aria-label="上一页" /></PaginationItem>}
          {pageNumbers(page, count).map((n, index) => (
            <PaginationItem key={n ?? `gap-${index}`}>
              {n === null ? <PaginationEllipsis /> : <PaginationLink href={linkTo(n)} isActive={n === page} aria-label={`第 ${n} 页`}>{n}</PaginationLink>}
            </PaginationItem>
          ))}
          {page < count && <PaginationItem><PaginationNext href={linkTo(page + 1)} text="下一页" aria-label="下一页" /></PaginationItem>}
        </PaginationContent>
      </Pagination>
    </div>
  )
}
