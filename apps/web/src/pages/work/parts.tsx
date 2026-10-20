// 派活页、任务页、运行详情共用的小块：派活单的状态徽章、时间、短任务名、参数表、报的结果、被派任务的一行数字。
import { useQuery } from "@tanstack/react-query"
import { CircleCheckIcon, CircleSlashIcon, CircleXIcon, HandIcon, HourglassIcon, ListOrderedIcon, RotateCwIcon, ScanSearchIcon } from "lucide-react"
import { fmtClock, relativeDayText, sameShanghaiDay, workItemOutcome, type TaskDispatchParam, type WorkItem, type WorkReportValue } from "@heyagent/shared"

import { OutcomeBadge } from "@/components/shell/outcome-badge"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { trpc } from "@/lib/trpc"

/** 「16:00」（今天）「昨天 10:05」「10-14 15:00」；没有就是「—」 */
export function timeText(at?: string | null) {
  if (!at) return "—"
  return sameShanghaiDay(at, new Date()) ? fmtClock(at) : relativeDayText(at)
}

/** 列表、meta 里放不下长任务名：取第一个词，太长就取前 6 个字 */
export function shortName(title?: string | null) {
  if (!title) return ""
  const first = title.split(/\s/)[0] ?? title
  return first.length <= 6 ? first : `${title.slice(0, 6)}…`
}

/** 排队等自动重试的单：什么时候以后才会开（已经到点的不算，派活第二期） */
export function retryAt(item: Pick<WorkItem, "status" | "notBefore">) {
  return item.status === "queued" && item.notBefore && Date.parse(item.notBefore) > Date.now() ? item.notBefore : undefined
}

/** 报的结果的一个值：是 / 否、千分位数字、文字 */
export const reportValue = (value: WorkReportValue) => (typeof value === "boolean" ? (value ? "是" : "否") : typeof value === "number" ? value.toLocaleString("zh-CN") : value)

/** 报的结果压成一行（还在办时「已报：」用）：「源商品数 3 · 后台已回填 是」 */
export const reportText = (data: Record<string, WorkReportValue>) =>
  Object.entries(data)
    .map(([name, value]) => `${name} ${reportValue(value)}`)
    .join(" · ")

/** 被派的运行用「报结果」写的字段（字段、值），派活第二期 */
export function ReportTable({ data }: { data: Record<string, WorkReportValue> }) {
  return (
    <div className="border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-32">字段</TableHead>
            <TableHead>值</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {Object.entries(data).map(([name, value]) => (
            <TableRow key={name}>
              <TableCell className="text-muted-foreground">{name}</TableCell>
              <TableCell className="whitespace-normal tabular-nums">{reportValue(value)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

const RUNNING_STATE = {
  running: { label: "执行中", icon: null },
  waiting: { label: "挂起等待", icon: HourglassIcon },
  needs_human: { label: "等人处理", icon: HandIcon },
  verifying: { label: "验收中", icon: ScanSearchIcon },
} as const

/**
 * 派活单状态。按 ui-rules 第 4 节的映射，不加新颜色：排队 outline、在办 secondary（执行中加转圈）、办完 outline + 勾、没办成 destructive、不办了 ghost。
 * 在办的直接写运行此刻的状态（执行中 / 挂起等待 / 等人处理 / 验收中）；long = 详情里写成「在办 · 挂起等待」「排队 · 第 2 位」。
 * 排队等自动重试的写「排队 · 16:38 重试」（第二期）。
 */
export function WorkStatusBadge({ item, long }: { item: Pick<WorkItem, "status" | "sessionStatus" | "queuePosition" | "notBefore">; long?: boolean }) {
  if (item.status === "running") {
    const state = RUNNING_STATE[item.sessionStatus as keyof typeof RUNNING_STATE] ?? RUNNING_STATE.running
    return (
      <Badge variant="secondary">
        {state.icon ? <state.icon data-icon="inline-start" /> : <Spinner data-icon="inline-start" />}
        {long ? `在办 · ${state.label}` : state.label}
      </Badge>
    )
  }
  const retry = retryAt(item)
  if (retry)
    return (
      <Badge variant="outline">
        <RotateCwIcon data-icon="inline-start" />
        排队 · {timeText(retry)} 重试
      </Badge>
    )
  if (item.status === "queued")
    return (
      <Badge variant="outline">
        <ListOrderedIcon data-icon="inline-start" />
        {long && item.queuePosition ? `排队 · 第 ${item.queuePosition} 位` : "排队"}
      </Badge>
    )
  if (item.status === "done")
    return (
      <Badge variant="outline">
        <CircleCheckIcon data-icon="inline-start" />
        办完
      </Badge>
    )
  if (item.status === "failed")
    return (
      <Badge variant="destructive">
        <CircleXIcon data-icon="inline-start" />
        没办成
      </Badge>
    )
  return (
    <Badge variant="ghost">
      <CircleSlashIcon data-icon="inline-start" />
      不办了
    </Badge>
  )
}

/** 单的徽章：没结束的写排队 / 在办；结束了的只写结果（办成 / 没办成），人点了「不办了」的写「不办了」。reason：悬停看结果的原因 */
export function WorkItemBadge({ item, long, reason }: { item: Pick<WorkItem, "status" | "outcome" | "outcomeReason" | "sessionStatus" | "queuePosition" | "notBefore">; long?: boolean; reason?: boolean }) {
  const outcome = workItemOutcome(item)
  if (!outcome || (item.status === "cancelled" && outcome === "not_achieved")) return <WorkStatusBadge item={item} long={long} />
  return <OutcomeBadge outcome={outcome} reason={reason ? item.outcomeReason : undefined} />
}

/** 没办成的原因去掉后端加的「agent 判断办不成：」前缀（提示标题里已经写了是哪种） */
export const failReason = (text?: string | null) => text?.replace(/^agent 判断办不成[：:]\s*/, "")

/** 参数表：两列（参数、值）。按声明的顺序列；声明里没有、单上有的（任务后来改了参数）跟在后面 */
export function ParamsTable({ declared, values, showDedupe = false }: { declared: TaskDispatchParam[]; values: Record<string, string>; showDedupe?: boolean }) {
  const extra = Object.keys(values).filter((name) => !declared.some((param) => param.name === name))
  const rows = [...declared.map((param) => ({ name: param.name, dedupe: param.dedupe })), ...extra.map((name) => ({ name, dedupe: false }))]
  if (rows.length === 0) return <p className="text-muted-foreground">这张单没有参数。</p>
  return (
    <div className="border">
      <Table>
        <TableBody>
          {rows.map((row) => (
            <TableRow key={row.name}>
              <TableCell className="w-28 text-muted-foreground">{row.name}</TableCell>
              <TableCell className="whitespace-normal">
                <span className="inline-flex flex-wrap items-center gap-2">
                  {values[row.name] ? <span className="font-mono break-all">{values[row.name]}</span> : <span className="text-muted-foreground">没填</span>}
                  {showDedupe && row.dedupe && <Badge variant="outline">去重</Badge>}
                </span>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}

/** 被派任务的一行数字（排队、在办、占名额、今天办完、没办成）；任务不能被派活时不查 */
export function useWorkTaskStats(taskId: string | undefined, enabled = true) {
  return useQuery(trpc.work.taskStats.queryOptions({ taskId: taskId ?? "" }, { enabled: enabled && Boolean(taskId) }))
}
