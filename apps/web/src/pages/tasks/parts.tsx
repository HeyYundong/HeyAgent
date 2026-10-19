// 任务页几处共用的小块：运行状态徽章、「现在在干什么 / 在等什么」、检查点卡片网格。Session 页也直接用这里的导出。
import * as React from "react"
import { CircleAlertIcon, CircleCheckIcon, CircleDashedIcon, CircleDotIcon, CircleMinusIcon, CircleXIcon, HandIcon, HourglassIcon, ScanSearchIcon } from "lucide-react"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Item, ItemActions, ItemContent, ItemTitle } from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import { Spinner } from "@/components/ui/spinner"
import { fmtShort, isRunEnded, nextRunText as sharedNextRunText, runStatusLabel } from "@heyagent/shared"
import type { RunCheckpoint, RunStatus, SessionRun, TaskDef } from "@heyagent/shared"

import { useRunNow } from "@/lib/data"

// 「一次运行此刻的一句话」「检查点完成几条」「预计下次运行」已经搬到 shared，这里转出去，页面照旧从这里拿
export { checkpointSummary } from "@heyagent/shared"

/** 预计下次运行。能被派活、不定时的任务：有派活单就开始；停用时派来的单先排着 */
export function nextRunText(task: TaskDef, latest?: SessionRun) {
  if (task.dispatch && !task.enabled) return "已停用：派来的单先排着"
  if (task.dispatch && !task.schedule) return "有派活单就开始"
  return sharedNextRunText(task, latest)
}

/** 分档：执行中 = 实心主色 + 转圈（全墙唯一红色实心、唯一会动的）；等人处理 = 实心灰；失败 = 浅红底、没完成 = 描边加感叹号（同一档：都要人看一眼）；等待中 / 验收中 = 描边；已完成 = 无框 */
export function RunStatusBadge({ status }: { status: RunStatus }) {
  if (status === "running") return <Badge><Spinner data-icon="inline-start" />{runStatusLabel.running}</Badge>
  if (status === "needs_human") return <Badge variant="secondary"><HandIcon data-icon="inline-start" />{runStatusLabel.needs_human}</Badge>
  if (status === "waiting") return <Badge variant="outline"><HourglassIcon data-icon="inline-start" />{runStatusLabel.waiting}</Badge>
  if (status === "verifying") return <Badge variant="outline"><ScanSearchIcon data-icon="inline-start" />{runStatusLabel.verifying}</Badge>
  if (status === "done") return <Badge variant="ghost"><CircleCheckIcon data-icon="inline-start" />{runStatusLabel.done}</Badge>
  if (status === "incomplete") return <Badge variant="outline"><CircleAlertIcon data-icon="inline-start" />{runStatusLabel.incomplete}</Badge>
  return <Badge variant="destructive"><CircleXIcon data-icon="inline-start" />{runStatusLabel.failed}</Badge>
}

const pad = (n: number) => String(n).padStart(2, "0")

/** 「已运行 20:05」：从开始到现在，每秒跳一下 */
export function Elapsed({ since }: { since: string }) {
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [])
  const s = Math.max(0, Math.floor((now - Date.parse(since)) / 1000))
  return <span className="tabular-nums">已运行 {s >= 3600 ? `${Math.floor(s / 3600)}:` : ""}{pad(Math.floor(s / 60) % 60)}:{pad(s % 60)}</span>
}

/** 「18.2 万」 */
export const tokens = (n: number) => (n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万` : n.toLocaleString("en-US"))
/** 「$0.12」；不到一分钱的（便宜模型跑一次常常这样）多给两位，免得显示成 $0.00 */
export const money = (usd: number) => `$${usd > 0 && usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`

const STATUS = { done: { icon: CircleCheckIcon, label: "完成", variant: "outline" }, open: { icon: CircleDashedIcon, label: "未完成", variant: "ghost" }, skipped: { icon: CircleMinusIcon, label: "已跳过", variant: "destructive" } } as const

/**
 * agent 用 checkpoint.mark(status = "doing") 最近指定的「正在做」的检查点（序号从 0 开始）。
 * 同类型的检查点有好几个时，规则自动写的记录记到它上面（M3）。运行结束了就不算
 */
export function focusedCheckpoint(run: Pick<SessionRun, "status" | "events">): number | undefined {
  if (isRunEnded(run.status)) return undefined
  for (let index = run.events.length - 1; index >= 0; index--) {
    const event = run.events[index]!
    if (event.kind !== "tool" || event.toolId !== "checkpoint.mark" || !event.input) continue
    try {
      const input = JSON.parse(event.input) as { checkpoint?: unknown; status?: unknown }
      if (input.status === "doing" && typeof input.checkpoint === "number") return input.checkpoint - 1
    } catch {
      // 输入不是 JSON（被截断等），跳过
    }
  }
  return undefined
}

function checkpointStatus(cp: RunCheckpoint, doing: boolean) {
  return doing && cp.status === "open" ? { icon: CircleDotIcon, label: "正在做", variant: "secondary" as const } : STATUS[cp.status]
}

/** 一个检查点的进度、记录（每条先一行时间，下面一行内容）和跳过理由 */
function CheckpointDetail({ cp }: { cp: RunCheckpoint }) {
  const progress = cp.target ? `${cp.progress ?? 0}/${cp.target}` : undefined
  return (
    <>
      {progress && (
        <Progress value={Math.min(100, ((cp.progress ?? 0) / cp.target!) * 100)} aria-label={`进度 ${progress}`}>
          <span className="text-xs tabular-nums text-muted-foreground">进度 {progress}</span>
        </Progress>
      )}
      {cp.records.length > 0 ? (
        <ul className="flex flex-col gap-2 text-xs">
          {cp.records.map((record, index) => (
            <li key={index} className="flex flex-col gap-0.5">
              <span className="flex items-center gap-2 tabular-nums text-muted-foreground">
                {fmtShort(record.at)}
                {record.synced && <Badge variant="secondary">自动</Badge>}
              </span>
              <span className="wrap-break-word">{record.text}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-muted-foreground">还没有记录</p>
      )}
      {cp.skipReason && <p className="border-t pt-2 text-xs">跳过理由：{cp.skipReason}</p>}
    </>
  )
}

function CheckpointCard({ cp, doing }: { cp: RunCheckpoint; doing: boolean }) {
  const status = checkpointStatus(cp, doing)
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle>{cp.title}</CardTitle>
        <CardAction className="flex flex-wrap justify-end gap-1">
          {!cp.stepId && <Badge variant="outline">agent 自己加的</Badge>}
          <Badge variant={status.variant}><status.icon data-icon="inline-start" />{status.label}</Badge>
        </CardAction>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <CheckpointDetail cp={cp} />
      </CardContent>
    </Card>
  )
}

/** 检查点：每条一张小卡片，网格排列。每条记录先一行时间（带日期），下面一行内容 */
export function CheckpointGrid({ run }: { run: SessionRun }) {
  const { checkpoints } = run
  const focused = focusedCheckpoint(run)
  if (checkpoints.length === 0) return <p className="text-muted-foreground">这次运行还没有检查点。没写步骤的任务，agent 会边做边加。</p>
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {checkpoints.map((cp, index) => <CheckpointCard key={cp.title} cp={cp} doing={index === focused} />)}
      </div>
      {checkpoints.some((cp) => cp.records.some((record) => record.synced)) && (
        <p className="text-xs text-muted-foreground">标「自动」的记录是规则在工具调用后按工具类别自动写的（访问网页、对外发消息、存文件），agent 改不了。</p>
      )}
    </div>
  )
}

/** 检查点的紧凑列表：每条一行（标题、状态、最近一条记录的时间），记录等详情鼠标放上去才显示。Session 详情用 */
export function CheckpointList({ run }: { run: SessionRun }) {
  const { checkpoints } = run
  const focused = focusedCheckpoint(run)
  if (checkpoints.length === 0) return <p className="text-muted-foreground">这次运行还没有检查点。没写步骤的任务，agent 会边做边加。</p>
  return (
    <div className="flex flex-col gap-1">
      {checkpoints.map((cp, index) => {
        const status = checkpointStatus(cp, index === focused)
        const last = cp.records.at(-1)
        return (
          <HoverCard key={cp.title}>
            <HoverCardTrigger render={<Item variant="outline" size="xs" tabIndex={0} />}>
              <ItemContent className="min-w-0">
                <ItemTitle className="w-full truncate">{cp.title}</ItemTitle>
              </ItemContent>
              <ItemActions>
                {cp.target && <span className="tabular-nums text-muted-foreground">{cp.progress ?? 0}/{cp.target}</span>}
                <Badge variant={status.variant}><status.icon data-icon="inline-start" />{status.label}</Badge>
                <span className="w-24 text-right tabular-nums text-muted-foreground">{last ? fmtShort(last.at) : "—"}</span>
              </ItemActions>
            </HoverCardTrigger>
            <HoverCardContent side="left" align="start" className="flex max-h-96 w-80 flex-col gap-2 overflow-y-auto">
              <p className="font-medium wrap-break-word">{cp.title}</p>
              {!cp.stepId && <p className="text-muted-foreground">agent 自己加的检查点</p>}
              <CheckpointDetail cp={cp} />
            </HoverCardContent>
          </HoverCard>
        )
      })}
    </div>
  )
}

export interface TasksState {
  runsOf: (taskId: string) => SessionRun[]
}

/** 运行挂起时的醒目提示：在等什么、什么时候继续 */
export function WaitingAlert({ run, link }: { run: SessionRun; link?: string }) {
  const now = useRunNow()(run)
  if (now.label !== "在等") return null
  return (
    <Alert>
      <HourglassIcon />
      <AlertTitle>{link ? "最近一次运行" : "session 已挂起，"}在等：{now.text}</AlertTitle>
      <AlertDescription>
        {now.when ? `什么时候继续：${now.when}。` : ""}等到了继续同一个 session，前面的上下文都还在。
        {link && <a href={link} className="ml-1 font-medium text-foreground underline underline-offset-4">看这次运行 →</a>}
      </AlertDescription>
    </Alert>
  )
}

export const StepList = ({ steps }: { steps: string[] }) => (
  <ol className="flex list-decimal flex-col gap-1 pl-5">{steps.map((text) => <li key={text}>{text}</li>)}</ol>
)
