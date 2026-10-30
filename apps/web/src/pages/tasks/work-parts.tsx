// 派活单的小块（任务详情「派来的活」、单详情、会话页「排队中」、运行详情共用）：状态徽章、时间、短任务名、参数表、报的结果、被派任务的数字、单的链接。
// 2026-10-21 派活页去掉了（docs/dev/work-into-tasks.md），从 pages/work/parts.tsx 搬来。
// 派活第三期（docs/dev/dispatch-p3.md 6.4 节）：「谁派的」统一用 workFromText（agent / 人 / 外部系统 / 外部事件）、优先级徽章、
// 定了时间的排队（「排队 · 10-28 18:00 以后办」）、「在等什么」加定了时间和花费到了上限。
import { useQuery } from "@tanstack/react-query"
import {
  BotIcon,
  CalendarClockIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CircleXIcon,
  HandIcon,
  HourglassIcon,
  KeyRoundIcon,
  ListOrderedIcon,
  RotateCwIcon,
  ScanSearchIcon,
  UserIcon,
  ZapIcon,
} from "lucide-react"
import {
  fmtClock,
  relativeDayText,
  sameShanghaiDay,
  workItemOutcome,
  workPriorityLabel,
  workWaitKind,
  type TaskDispatchParam,
  type WorkItem,
  type WorkPriority,
  type WorkQueueStats,
  type WorkReportValue,
  type WorkVia,
} from "@heyagent/shared"

import { OutcomeBadge } from "@/components/shell/outcome-badge"
import { Badge } from "@/components/ui/badge"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { href } from "@/lib/router"
import { trpc } from "@/lib/trpc"

/** 一张单在哪看：被派任务的抽屉里（#/tasks?id=T-…&work=W-…） */
export const workLink = (item: { id: string; taskId: string }) => href("tasks", { id: item.taskId, work: item.id })

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

type WaitFields = Pick<WorkItem, "status" | "notBefore" | "autoRetries">

/** 排队等自动重试的单：什么时候以后才会开（已经到点的不算，派活第二期） */
export function retryAt(item: WaitFields) {
  return workWaitKind(item) === "retry" ? item.notBefore! : undefined
}

/** 派的时候说了「过多久再办」、还没到点的单：什么时候以后才办（第三期） */
export function scheduledAt(item: WaitFields) {
  return workWaitKind(item) === "scheduled" ? item.notBefore! : undefined
}

/** 「过多久再办」的选项（第三期，派一张、改参数、事件配置共用）：马上 / 10 分钟 … 7 天以后 */
export const WORK_DELAY_CHOICES = [0, 10, 30, 60, 120, 360, 720, 1440, 4320, 10080]

/** 0 →「马上」，30 →「30 分钟以后」，120 →「2 小时以后」，1440 →「1 天以后」 */
export function workDelayLabel(minutes: number) {
  if (!minutes) return "马上"
  if (minutes % 1440 === 0) return `${minutes / 1440} 天以后`
  if (minutes % 60 === 0) return `${minutes / 60} 小时以后`
  return `${minutes} 分钟以后`
}

export const WORK_DELAY_ITEMS = WORK_DELAY_CHOICES.map((minutes) => ({ value: String(minutes), label: workDelayLabel(minutes) }))

/** 优先级的选项（普通在前，是默认） */
export const WORK_PRIORITY_ITEMS = (["normal", "high", "low"] as const).map((value) => ({ value, label: workPriorityLabel[value] }))

/** 谁派的：图标（agent 机器人、人、外部系统钥匙、外部事件闪电） */
export const WORK_VIA_ICON: Record<WorkVia, typeof BotIcon> = { agent: BotIcon, human: UserIcon, api: KeyRoundIcon, event: ZapIcon }

/**
 * 谁派的（第三期统一一个函数，单详情、派来的活、会话页「排队中」、运行详情都用它）：
 * 「「巡检」派的」「张三派的」「外部系统（密钥「ERP 同步」）派的」「外部事件「order.created」派的」
 */
export function workFromText(
  item: Pick<WorkItem, "via" | "fromTaskTitle" | "fromUserId" | "apiKeyName" | "fromEvent">,
  staffName: (id?: string) => string
) {
  if (item.via === "agent") return `「${shortName(item.fromTaskTitle)}」派的`
  if (item.via === "api") return item.apiKeyName ? `外部系统（密钥「${item.apiKeyName}」）派的` : "外部系统（密钥已删除）派的"
  if (item.via === "event") return `外部事件「${item.fromEvent ?? ""}」派的`
  return `${staffName(item.fromUserId ?? undefined)}派的`
}

/** 优先级徽章：普通的不显示；高 secondary「优先」、低 ghost「靠后」（第三期） */
export function WorkPriorityBadge({ priority }: { priority: WorkPriority }) {
  if (priority === "high") return <Badge variant="secondary">优先</Badge>
  if (priority === "low") return <Badge variant="ghost">靠后</Badge>
  return null
}

/** 今天被派来的运行花到了每天的上限（第三期）：不再开新的运行，排队的单明天 0 点以后接着办 */
export const budgetHit = (stats?: { spentTodayUsd: number; dailyBudgetUsd: number | null }) =>
  Boolean(stats && stats.dailyBudgetUsd != null && stats.spentTodayUsd >= stats.dailyBudgetUsd)

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
 * 排队等自动重试的写「排队 · 16:38 重试」（第二期）；定了时间的写「排队 · 10-28 18:00 以后办」（第三期）。
 */
export function WorkStatusBadge({ item, long }: { item: Pick<WorkItem, "status" | "sessionStatus" | "queuePosition" | "notBefore" | "autoRetries">; long?: boolean }) {
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
  const scheduled = scheduledAt(item)
  if (scheduled)
    return (
      <Badge variant="outline">
        <CalendarClockIcon data-icon="inline-start" />
        排队 · {timeText(scheduled)} 以后办
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
export function WorkItemBadge({ item, long, reason }: { item: Pick<WorkItem, "status" | "outcome" | "outcomeReason" | "sessionStatus" | "queuePosition" | "notBefore" | "autoRetries">; long?: boolean; reason?: boolean }) {
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

/** 全部被派任务的名额和排队，一次取（任务页卡片、会话页「排队中」用） */
export function useWorkQueueStats(enabled = true) {
  return useQuery(trpc.work.queueStats.queryOptions(undefined, { enabled }))
}

/**
 * 排队的单在等什么（会话页「排队中」一列，和单详情最上面的提示同一套判断）：等自动重试 / 定了时间（第三期）/ 关了被派活 / 任务停用了 /
 * 今天的花费到了上限（第三期）/ 名额满了（谁占着）/ 有空位马上开始
 */
export function queueWaitText(item: Pick<WorkItem, "status" | "notBefore" | "autoRetries" | "attempts" | "queuePosition">, stats?: WorkQueueStats) {
  const retry = retryAt(item)
  if (retry) return `第 ${Math.max(1, item.attempts)} 次出错，${timeText(retry)} 自动重试`
  const scheduled = scheduledAt(item)
  if (scheduled) return `定在 ${timeText(scheduled)} 以后办`
  if (!stats) return "排队"
  if (!stats.dispatchable) return "任务关了被派活，单先排着"
  if (!stats.enabled) return "任务停用了，单先排着"
  if (budgetHit(stats)) return "今天的花费到了上限，明天接着办"
  if (stats.occupied >= stats.maxRunning) {
    const ahead = (item.queuePosition ?? 1) - 1
    const shown = stats.holders.slice(0, 3).join("、")
    const holders = stats.holders.length > 3 ? `${shown} 等 ${stats.holders.length} 个` : shown
    return `名额满了：${holders || `占着 ${stats.occupied} 个`} 在跑${ahead > 0 ? `，前面还有 ${ahead} 张` : ""}`
  }
  return "有空位，马上开始"
}

/**
 * 「现在就办」要跳过什么（确认弹窗里的一句话）：排队的单现在不会开始的原因，加「只开始这一张」和点完以后还是什么样。
 * 有空位、马上就会开始的返回 null（不用确认）。task：被派任务现在停没停用、开没开着被派活；stats：名额和花费（没取到就不算这两条）
 */
export function startNowBypass(
  item: WaitFields,
  task: { enabled: boolean; dispatchable: boolean },
  stats?: { maxRunning: number; occupied: number; spentTodayUsd: number; dailyBudgetUsd: number | null }
): string | null {
  const why: string[] = []
  const after: string[] = []
  if (!task.dispatchable) {
    why.push("任务关了被派活")
    after.push("任务仍然关着被派活")
  }
  if (!task.enabled) {
    why.push("任务停用了")
    after.push("任务仍然是停用的")
  }
  const retry = retryAt(item)
  const scheduled = scheduledAt(item)
  if (retry) why.push(`这张单在等自动重试（${timeText(retry)}）`)
  if (scheduled) why.push(`这张单定在 ${timeText(scheduled)} 以后办`)
  // 关了被派活时名额、花费上限都不算数，不再提
  if (task.dispatchable && stats) {
    if (budgetHit(stats)) {
      why.push("今天的花费到了上限")
      after.push("这次花的也算进今天")
    }
    if (stats.occupied >= stats.maxRunning) {
      why.push("名额满了")
      after.push("它也占一个名额")
    }
  }
  if (!why.length) return null
  return `${why.join("，")}。只开始这一张，别的单还排着${after.length ? `；${after.join("，")}` : ""}。`
}
