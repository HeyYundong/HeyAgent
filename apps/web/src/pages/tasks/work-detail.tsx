// 一张派活单的详情（docs/dev/dispatch.md 第 9.2 节；2026-10-21 派活页去掉后从 pages/work/index.tsx 搬来，见 docs/dev/work-into-tasks.md）。
// 放在被派任务的抽屉里（#/tasks?id=T-…&work=W-…）和会话页「排队中」的抽屉里（#/sessions?status=queue&id=W-…）。
// 标题卡（状态和结果、第几次、派给谁、谁派的、时间；「去看运行」「⋯」：改参数 / 重办 / 不办了）+ 最上面一条提示（现在卡在哪）+ 参数 + 结果 + 处理记录。
// 第二期（docs/dev/dispatch-p2.md 3.4、4.4 节）：结果区块加「报结果」写的字段表、在办时「已报：…」；没办成按 failKind 分「运行出错」「agent 判断办不成」；
// 排队等自动重试的单徽章写「排队 · 16:38 重试」，顶部提示和处理记录里写第几次重试。
// 运行结果（docs/dev/run-outcome.md 第 6.2、8 节）：单的结果跟着最后那次运行的结果（办成 / 没办成）；没办成多一种：缺要交回的结果（missing_result）。
// 2026-10-20 以前的旧单可能是 failKind = partial（部分办成），或者办完 + 结果没办成（原来「没核实」的，迁移 0026 改的），照样显示。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowRightIcon,
  BotIcon,
  CircleCheckIcon,
  CircleSlashIcon,
  CircleAlertIcon,
  CircleXIcon,
  EllipsisIcon,
  HandIcon,
  HourglassIcon,
  ListOrderedIcon,
  PencilIcon,
  RotateCwIcon,
  ScanSearchIcon,
  SearchXIcon,
  TimerIcon,
  UserIcon,
} from "lucide-react"
import {
  can,
  runStatusLabel,
  WORK_RETRY_DELAY_DEFAULT,
  runOutcomeLabel,
  workItemOutcome,
  type RunStatus,
  type SessionSummary,
  type WorkItemDetail,
  type WorkLogEntry,
  type WorkRun,
} from "@heyagent/shared"

import { FileList } from "@/components/files"
import { MarkdownView } from "@/components/markdown"
import { DetailPanel, DetailSection, EmptyState } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Trace, TraceDescription, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"
import { useHumanItems, useRunNow, useSessionsQuery, useStaffName } from "@/lib/data"
import { href } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { delayText } from "./dispatch-fields"
import { WaitingAlert, money } from "./parts"
import { CancelDialog, EditParamsDialog, RedoDoneDialog, useRedo } from "./work-dialogs"
import { ParamsTable, ReportTable, WorkItemBadge, failReason, reportText, retryAt, shortName, timeText, useWorkTaskStats } from "./work-parts"

/** 一张单的详情，带「⋯」里三个操作的弹窗（改参数、不办了、办完的重办先确认） */
export function WorkItemView({ id }: { id: string }) {
  const [editing, setEditing] = React.useState<WorkItemDetail | null>(null)
  const [cancelling, setCancelling] = React.useState<WorkItemDetail | null>(null)
  const [redoing, setRedoing] = React.useState<WorkItemDetail | null>(null)
  const redo = useRedo()
  return (
    <>
      <WorkDetail
        key={id}
        id={id}
        onEdit={setEditing}
        onCancel={setCancelling}
        onRedo={(item) => (item.status === "done" ? setRedoing(item) : redo.mutate({ id: item.id }))}
      />
      <EditParamsDialog item={editing} onClose={() => setEditing(null)} />
      <CancelDialog item={cancelling} onClose={() => setCancelling(null)} />
      <RedoDoneDialog item={redoing} onClose={() => setRedoing(null)} />
    </>
  )
}

/** 名额的一行（任务详情「派来的活」）：同时最多几个在跑、现在占几个、排队几张；停用了写「先不开始」 */
export function quotaText(task: { enabled: boolean }, stats: { maxRunning: number; occupied: number; queued: number }) {
  return task.enabled ? `同时最多 ${stats.maxRunning} 个在跑 · 现在占 ${stats.occupied} 个 · 排队 ${stats.queued} 张` : `任务停用了，排队的 ${stats.queued} 张先不开始`
}

const RUN_ICON: Record<RunStatus, typeof CircleCheckIcon> = { running: BotIcon, waiting: HourglassIcon, needs_human: HandIcon, verifying: ScanSearchIcon, done: CircleCheckIcon, incomplete: CircleAlertIcon, failed: CircleXIcon }
const RUN_TEXT: Record<RunStatus, string> = { ...runStatusLabel, waiting: "挂起等待" }

function WorkDetail({ id, onEdit, onCancel, onRedo }: { id: string; onEdit: (item: WorkItemDetail) => void; onCancel: (item: WorkItemDetail) => void; onRedo: (item: WorkItemDetail) => void }) {
  const { user } = useMe()
  const staffName = useStaffName()
  const detail = useQuery(trpc.work.get.queryOptions({ id }))
  const run = useSessionsQuery().data?.find((each) => each.id === detail.data?.sessionId)
  if (detail.isPending) {
    return (
      <div className="flex flex-col gap-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-32 w-full" />
        <Skeleton className="h-20 w-full" />
      </div>
    )
  }
  if (detail.isError) return <EmptyState icon={<SearchXIcon />} title={`找不到派活单 ${id}`} description="可能是网址里的单号写错了。" />
  const item = detail.data
  const canManage = can(user, "work.manage", { taskOwnerId: item.taskOwnerId })
  const ended = item.status === "done" || item.status === "failed" || item.status === "cancelled"
  const attempt = item.status === "queued" && item.attempts > 0 ? item.attempts + 1 : item.attempts

  return (
    <DetailPanel
      title={`${item.id} · ${item.title}`}
      badges={
        <>
          <WorkItemBadge item={item} long reason />
          {attempt >= 2 && <Badge variant="outline">第 {attempt} 次</Badge>}
        </>
      }
      meta={
        <span className="inline-flex flex-wrap items-center gap-x-1">
          派给
          <a className="underline underline-offset-4" href={href("tasks", { id: item.taskId })}>
            「{item.taskTitle}」
          </a>
          ·
          {item.via === "agent" && item.fromTaskId ? (
            <>
              <BotIcon className="size-3" />
              来自
              <a className="underline underline-offset-4" href={href("tasks", { id: item.fromTaskId })}>
                「{shortName(item.fromTaskTitle)}」
              </a>
              {item.fromSessionId && (
                <a className="font-mono underline underline-offset-4" href={href("sessions", { id: item.fromSessionId })}>
                  {item.fromSessionId}
                </a>
              )}
            </>
          ) : (
            <>
              <UserIcon className="size-3" />
              {staffName(item.fromUserId ?? undefined)}手动派的
            </>
          )}
          <span>· 派于 {timeText(item.createdAt)}</span>
          <span>· 开始 {timeText(item.startedAt)}</span>
          <span>
            · {item.status === "cancelled" ? "不办了" : item.status === "failed" ? "结束" : "办完"} {ended ? timeText(item.finishedAt) : "—"}
          </span>
        </span>
      }
      actions={
        <>
          {item.sessionId && (
            <Button variant="outline" size="sm" nativeButton={false} render={<a href={href("sessions", { id: item.sessionId })} />}>
              去看运行
              <ArrowRightIcon data-icon="inline-end" />
            </Button>
          )}
          {canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="更多操作" />}>
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-52">
                <DropdownMenuItem disabled={item.status !== "queued" || !item.taskDispatch} onClick={() => onEdit(item)}>
                  <PencilIcon />
                  改参数{item.status !== "queued" && "（只有排队的能改）"}
                </DropdownMenuItem>
                <DropdownMenuItem disabled={!ended} onClick={() => onRedo(item)}>
                  <RotateCwIcon />
                  重办
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" disabled={ended} onClick={() => onCancel(item)}>
                  <CircleSlashIcon />
                  不办了
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : (
            <span className="text-xs text-muted-foreground">负责人是 {staffName(item.taskOwnerId)}，你只能查看</span>
          )}
        </>
      }
    >
      <StatusAlert item={item} run={run} canManage={canManage} />

      <DetailSection title="参数" description="派活时带的参数，被派的运行在第一条消息里拿到。标「去重」的用来判断是不是同一件事：同一个值只办一次。">
        <div className="flex flex-col gap-2">
          <ParamsTable declared={item.taskDispatch?.params ?? []} values={item.params} showDedupe />
          {item.note && (
            <p>
              <span className="text-muted-foreground">补充说明：</span>
              {item.note}
            </p>
          )}
        </div>
      </DetailSection>

      <DetailSection title={workItemOutcome(item) ? `结果 · ${runOutcomeLabel[workItemOutcome(item)!]}` : "结果"} description="被派的运行结束后，agent 最后那段总结写回这里。结果跟着那次运行，只有办成、没办成：只看要的东西拿没拿到，只拿到一部分、证据不足也是没办成，原因里写缺了什么。派活方会看到，要自己判断要不要重派或者报给人。">
        <ResultBody item={item} run={run} canManage={canManage} />
      </DetailSection>

      <DetailSection title={`处理记录（运行 ${item.runs.length} 次）`} description="一张单一次运行；重办会再开一次，以前的运行都留着。点一行看那次运行的完整过程。">
        <History item={item} />
      </DetailSection>
    </DetailPanel>
  )
}

/** 详情最上面：现在卡在哪 */
function StatusAlert({ item, run, canManage }: { item: WorkItemDetail; run?: SessionSummary; canManage: boolean }) {
  const staffName = useStaffName()
  const humanItems = useHumanItems()
  const runNow = useRunNow()
  if (retryAt(item)) return <RetryAlert item={item} canManage={canManage} />
  if (item.status === "queued") return <QueuedAlert item={item} canManage={canManage} />
  if (item.status === "running" && run?.status === "needs_human") {
    const human = humanItems.find((each) => each.runId === run.id)
    return (
      <Alert>
        <HandIcon />
        <AlertTitle>等人处理：{human ? `${human.title}（${staffName(human.assigneeId)}）` : runNow(run).text}</AlertTitle>
        <AlertDescription>
          运行 {run.id} 挂起了，不占名额；处理完继续同一个 session，单还是「在办」。
          <a href={href("sessions", { status: "human", id: run.id })} className="ml-1 font-medium text-foreground underline underline-offset-4">
            去处理 →
          </a>
        </AlertDescription>
      </Alert>
    )
  }
  if (item.status === "running" && run) return <WaitingAlert run={run} link={href("sessions", { id: run.id })} />
  if (item.status === "cancelled") {
    const cancel = item.log.findLast((entry) => entry.kind === "cancelled")
    // 有处理记录时原因只看人填的（error 里是「某某点了不办了」，再拼一遍就重复了）；老数据没有记录才用 error
    const reason = cancel ? cancel.note : item.error
    return (
      <Alert>
        <CircleSlashIcon />
        <AlertTitle>{cancel?.byId ? `${staffName(cancel.byId)} ${timeText(cancel.at)} 点了「不办了」${reason ? `：${reason}` : ""}` : `不办了${reason ? `：${reason}` : ""}`}</AlertTitle>
        <AlertDescription>同一件事再派进来也不会重开，只会返回「不办了」。{canManage && "要办的话点右上角「⋯ → 重办」。"}</AlertDescription>
      </Alert>
    )
  }
  return null
}

/** 自动重试这一轮的第几次（处理记录里最后一条 retry_scheduled）和一共几次 */
function lastRetry(item: WorkItemDetail) {
  const entry = item.log.findLast((each) => each.kind === "retry_scheduled")
  return { n: entry?.retry ?? item.autoRetries, of: item.taskDispatch?.retries }
}

/** 排队等自动重试（第二期）：第几次运行出错、什么时候重试、这次没通知 */
function RetryAlert({ item, canManage }: { item: WorkItemDetail; canManage: boolean }) {
  const { n, of } = lastRetry(item)
  const runCount = item.runs.length
  return (
    <Alert>
      <TimerIcon />
      <AlertTitle>
        第 {runCount} 次运行出错{item.error ? `（${item.error}）` : ""}，{delayText(item.taskDispatch?.retryDelayMinutes ?? WORK_RETRY_DELAY_DEFAULT)}后自动重试
        {n > 0 && `（第 ${n}${of ? ` / ${of}` : ""} 次）`}
      </AlertTitle>
      <AlertDescription>
        {timeText(retryAt(item))} 到点后排进队里，轮到了开第 {runCount + 1} 次运行。这次失败没有通知负责人，自动重试都用完还没办成才通知；等结果的派活方也要等到最后才被叫醒。
        {canManage && "不想等可以点右上角「⋯ → 不办了」。"}
      </AlertDescription>
    </Alert>
  )
}

/** 排队的单：排第几位、谁在占名额；任务停用了（或关了被派活）写「单先排着」 */
function QueuedAlert({ item, canManage }: { item: WorkItemDetail; canManage: boolean }) {
  const stats = useWorkTaskStats(item.taskId).data
  // 在办的单里执行中、验收中的就是占名额的（等浏览器的也占，但列表上看不出来，数字以 stats 为准）
  const running = useQuery(trpc.work.list.queryOptions({ taskId: item.taskId, status: "running", days: 0, limit: 50 })).data
  const busy = (running?.items ?? []).filter((each) => each.sessionStatus === "running" || each.sessionStatus === "verifying").map((each) => each.id)
  const holders = stats && busy.length === stats.occupied ? (busy.length ? `${busy.join("、")} 在占着` : "没有单在占着") : `占着 ${stats?.occupied ?? 0} 个`
  let text: string
  if (!item.taskDispatch) text = `「${item.taskTitle}」关了被派活，单先排着；重新打开后接着办。`
  else if (!item.taskEnabled) text = `「${item.taskTitle}」停用了，单先排着；${canManage ? "重新启用任务后" : "负责人重新启用后"}自动开始办。`
  else text = `「${item.taskTitle}」同时最多 ${item.taskDispatch.maxRunning} 个在跑，现在${holders}。前面的办完或者挂起等待，就轮到它。`
  return (
    <Alert>
      <ListOrderedIcon />
      <AlertTitle>排队第 {item.queuePosition ?? "—"} 位</AlertTitle>
      <AlertDescription>{text}</AlertDescription>
    </Alert>
  )
}

/** 运行正常结束、但事情没办成的几种（agent 报的、规则判的、复核判的）：都不自动重试。partial 只有旧单有 */
const JUDGED_FAILS = ["not_done", "partial", "missing_result"] as const
const isJudgedFail = (item: Pick<WorkItemDetail, "failKind">) => (JUDGED_FAILS as readonly string[]).includes(item.failKind ?? "")

/** 没办成的几种（failKind）：提示的标题和下面那句解释 */
function failText(item: WorkItemDetail) {
  if (item.failKind === "not_done")
    return { title: "没办成 · 要的东西没拿到", why: "运行是正常结束的，但任务要的东西没拿到或者只拿到一部分（agent 自己报的、检查点没达成或有跳过的，或者 AI 复核判的、复核没能确认办成），所以不自动重试。" }
  // 2026-10-20 以前的旧单
  if (item.failKind === "partial")
    return { title: "没办成 · 只办成了一部分", why: "运行是正常结束的，但只拿到一部分，所以不自动重试。剩下的要不要再派由派活方或人决定。" }
  if (item.failKind === "missing_result")
    return { title: "没办成 · 缺要交回的结果", why: "被派的任务声明了要交回的结果，必填的有没交的（agent 没用「报结果」交），所以不自动重试。" }
  if (item.failKind === "cancelled_run")
    return { title: "没办成 · 运行被人停了", why: "有人取消了运行、选了不继续，或者判了验收不通过，所以不自动重试。" }
  if (item.autoRetries > 0)
    return { title: `没办成 · 运行出错，自动重试了 ${item.autoRetries} 次都没办成`, why: "每次都是运行出错（模型、浏览器、程序的问题），不是这件事办不成。" }
  return { title: "没办成 · 运行出错", why: "运行出错（模型、浏览器、程序的问题），不是这件事办不成。" }
}

/**
 * 办完的单，结果却是没办成时放在总结上面。只有旧单会这样：补旧数据（迁移 0024），或者原来「没核实」的（迁移 0026 改成没办成），
 * 单的状态都没改；人在运行详情里改了结果的也一样
 */
function OutcomeAlert({ item }: { item: WorkItemDetail }) {
  if (!item.outcome || item.outcome === "achieved") return null
  const reason = item.outcomeReason
  return (
    <Alert variant="destructive">
      <CircleXIcon />
      <AlertTitle>结果：{runOutcomeLabel[item.outcome]}</AlertTitle>
      <AlertDescription>
        {reason && <p>{reason}</p>}
        <p>
          结果是后来补的或者改的（这张单原来记的是办完）。{item.via === "agent" ? `「${shortName(item.fromTaskTitle)}」` : "派活方"}看得到这个结果；确认其实办成了可以在运行详情里点「改结果」。
        </p>
      </AlertDescription>
    </Alert>
  )
}

function ResultBody({ item, run, canManage }: { item: WorkItemDetail; run?: SessionSummary; canManage: boolean }) {
  const runNow = useRunNow()
  const data = item.result?.data && Object.keys(item.result.data).length > 0 ? item.result.data : undefined
  if (item.status === "done" && item.result) {
    return (
      <div className="flex flex-col gap-3">
        <OutcomeAlert item={item} />
        <ResultSummary item={item} />
      </div>
    )
  }
  if (item.status === "failed") {
    const fail = failText(item)
    const retried = item.failKind === "error" ? item.autoRetries : 0
    const notDone = isJudgedFail(item)
    return (
      <div className="flex flex-col gap-3">
        <Alert variant="destructive">
          <CircleXIcon />
          <AlertTitle>{fail.title}</AlertTitle>
          <AlertDescription>
            {/* 没办成的原因先用结果的原因；老数据退回 error（agent 报的办不成带「agent 判断办不成：」前缀，去掉） */}
            <p>{failReason(item.outcomeReason) ?? (notDone ? failReason(item.error) : item.error) ?? item.runs.at(-1)?.error ?? "运行出错了，详情看那次运行。"}</p>
            <p>{fail.why}</p>
          </AlertDescription>
        </Alert>
        {data && (
          <div className="flex flex-col gap-1.5">
            <span className="text-xs text-muted-foreground">agent 报的结果</span>
            <ReportTable data={data} />
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          负责人已经收到通知{retried ? `（只在最后一次没办成时通知了一次，中间 ${retried} 次重试没有通知）` : ""}。
          {canManage ? (notDone ? "确实要再试，点右上角「⋯ → 重办」；" : `处理好以后点右上角「⋯ → 重办」，会再开一次运行${item.taskDispatch?.retries ? "，自动重试的次数也重新算" : ""}；`) : ""}
          {item.via === "agent" ? `「${shortName(item.fromTaskTitle)}」` : "派活方"}再派同一件事，只会收到「没办成」，不会自己重开。
        </p>
      </div>
    )
  }
  if (item.status === "running" && run) {
    const done = run.checkpoints.filter((cp) => cp.status === "done").length
    const now = runNow(run)
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground">还在办，办完了结果写在这里。</p>
        {data && (
          <p>
            <span className="text-muted-foreground">已报：</span>
            {reportText(data)}
          </p>
        )}
        {run.checkpoints.length > 0 && (
          <Progress value={(done / run.checkpoints.length) * 100} aria-label={`检查点完成 ${done}/${run.checkpoints.length}`}>
            <span className="text-xs tabular-nums text-muted-foreground">
              检查点 完成 {done}/{run.checkpoints.length}
            </span>
          </Progress>
        )}
        {now.label !== "在等" && (
          <p className="line-clamp-2">
            <span className="text-muted-foreground">{now.label}：</span>
            {now.text}
          </p>
        )}
      </div>
    )
  }
  if (item.status === "running")
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground">还在办，办完了结果写在这里。</p>
        {data && (
          <p>
            <span className="text-muted-foreground">已报：</span>
            {reportText(data)}
          </p>
        )}
      </div>
    )
  if (retryAt(item)) return <p className="text-muted-foreground">上一次运行出错，还没有结果；{timeText(retryAt(item))} 自动重试，办完了结果写在这里。</p>
  if (item.status === "queued") {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground">{item.attempts > 0 ? "重办了，还没开始；新的运行办完后结果换成新的。" : "还没开始，办完了结果写在这里。"}</p>
        {item.result?.summary && <ResultSummary item={item} previous />}
      </div>
    )
  }
  return <p className="text-muted-foreground">不办了，没有结果。</p>
}

/** 办完的总结（Markdown）、验收结论、产物（这次运行存下的文件） */
function ResultSummary({ item, previous = false }: { item: WorkItemDetail; previous?: boolean }) {
  const result = item.result!
  const files = useQuery(trpc.engine.sessionFiles.queryOptions({ sessionId: item.sessionId ?? "" }, { enabled: Boolean(item.sessionId) && result.fileIds.length > 0 }))
  const shown = (files.data ?? []).filter((file) => result.fileIds.includes(file.id))
  return (
    <div className="flex flex-col gap-3">
      {previous && <span className="text-xs text-muted-foreground">上一次的结果：</span>}
      <MarkdownView>{result.summary}</MarkdownView>
      {result.data && Object.keys(result.data).length > 0 && <ReportTable data={result.data} />}
      {result.verification && (
        <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
          <ScanSearchIcon className="size-3.5" />
          {result.verification}
        </p>
      )}
      {result.fileIds.length > 0 && (files.isPending ? <Spinner /> : <FileList files={shown} empty={<p className="text-xs text-muted-foreground">产物文件取不到了。</p>} />)}
    </div>
  )
}

/** 处理记录：派进来 → 每次运行 → 人点的重办 / 不办了 / 改参数 → 还在排队 */
function History({ item }: { item: WorkItemDetail }) {
  const runs = item.runs
  const logged = new Set(item.log.flatMap((entry) => (entry.kind === "run_started" && entry.sessionId ? [entry.sessionId] : [])))
  // 处理记录里没写「开始运行」的运行（不该有，兜底）跟在最后
  const unlogged = runs.filter((run) => !logged.has(run.sessionId))
  return (
    <Trace className="gap-3">
      {item.log.map((entry, index) => {
        // reported：agent 报了结果，结果区块里看；处理记录里不单列（原型如此）
        if (entry.kind === "run_ended" || entry.kind === "reported") return null
        if (entry.kind === "run_started") {
          const run = runs.find((each) => each.sessionId === entry.sessionId)
          return run ? <RunLine key={index} run={run} attempt={runs.indexOf(run) + 1} /> : null
        }
        if (entry.kind === "retry_scheduled") return <RetryLine key={index} item={item} entry={entry} />
        return <EventLine key={index} item={item} entry={entry} />
      })}
      {unlogged.map((run) => (
        <RunLine key={run.sessionId} run={run} attempt={runs.indexOf(run) + 1} />
      ))}
      {item.status === "queued" && (
        <div>
          <TraceLine status="pending">
            <TraceIcon>
              <ListOrderedIcon />
            </TraceIcon>
            <TraceTitle>
              {retryAt(item)
                ? `等自动重试：${timeText(retryAt(item))} 到点后排队，轮到了开第 ${runs.length + 1} 次运行`
                : `排队中 · 第 ${item.queuePosition ?? "—"} 位，轮到了开第 ${runs.length + 1} 次运行`}
            </TraceTitle>
          </TraceLine>
        </div>
      )}
      {item.status === "failed" && item.failKind === "error" && item.autoRetries > 0 && (
        <div>
          <TraceLine status="error">
            <TraceIcon>
              <CircleXIcon />
            </TraceIcon>
            <TraceTitle>自动重试 {item.autoRetries} 次都没办成，单记成没办成，通知了负责人</TraceTitle>
            <TraceDescription>{timeText(item.finishedAt)}</TraceDescription>
          </TraceLine>
        </div>
      )}
    </Trace>
  )
}

/** 一次运行出错后排队等自动重试：「10 分钟后自动重试（第 1 / 2 次）」 */
function RetryLine({ item, entry }: { item: WorkItemDetail; entry: WorkLogEntry }) {
  const minutes = entry.notBefore ? Math.round((Date.parse(entry.notBefore) - Date.parse(entry.at)) / 60_000) : (item.taskDispatch?.retryDelayMinutes ?? WORK_RETRY_DELAY_DEFAULT)
  const of = item.taskDispatch?.retries
  return (
    <div>
      <TraceLine>
        <TraceIcon>
          <TimerIcon />
        </TraceIcon>
        <TraceTitle>
          {delayText(minutes)}后自动重试{entry.retry ? `（第 ${entry.retry}${of ? ` / ${of}` : ""} 次）` : ""}
        </TraceTitle>
        <TraceDescription>{entry.notBefore ? `${timeText(entry.notBefore)} 再排进队里` : timeText(entry.at)} · 这次没通知负责人</TraceDescription>
      </TraceLine>
    </div>
  )
}

/** 一次运行：第几次、编号、状态（已结束 / 出错……）、结果（办成 / 没办成……） */
function RunLine({ run, attempt }: { run: WorkRun; attempt: number }) {
  const Icon = RUN_ICON[run.status]
  const active = run.status === "running"
  return (
    <a href={href("sessions", { id: run.sessionId })} className="flex flex-col gap-0.5">
      <TraceLine status={active ? "running" : run.status === "failed" ? "error" : undefined}>
        <TraceIcon>{active ? <Spinner /> : <Icon />}</TraceIcon>
        <TraceTitle className="text-foreground">
          第 {attempt} 次 · <span className="font-mono">{run.sessionId}</span> · {RUN_TEXT[run.status]}
          {run.outcome && ` · ${runOutcomeLabel[run.outcome]}`}
        </TraceTitle>
        <TraceDescription>
          {timeText(run.startedAt)}
          {run.endedAt ? ` – ${timeText(run.endedAt)}` : " 起"}
        </TraceDescription>
      </TraceLine>
      <span className="pl-5.5 text-xs text-muted-foreground">
        {run.checkpointsTotal ? `检查点 完成 ${run.checkpointsDone}/${run.checkpointsTotal}` : "没有检查点"} · 花费 {money(run.costUsd)}
        {(run.status === "failed" || run.status === "incomplete") && run.error ? ` · ${run.error}` : ""}
        {run.waitingWhat ? ` · 在等：${run.waitingWhat.replace(/^等/, "")}` : ""}
      </span>
    </a>
  )
}

function EventLine({ item, entry }: { item: WorkItemDetail; entry: WorkLogEntry }) {
  const staffName = useStaffName()
  const who = staffName(entry.byId)
  const line = (() => {
    if (entry.kind === "created")
      return {
        icon: item.via === "agent" ? <BotIcon /> : <UserIcon />,
        title:
          item.via === "agent"
            ? `派进来：「${shortName(item.fromTaskTitle)}」的运行 ${item.fromSessionId ?? ""} 用「派活」派的`
            : `派进来：${staffName(entry.byId ?? item.fromUserId ?? undefined)}手动派的`,
      }
    if (entry.kind === "redo") return { icon: <RotateCwIcon />, title: `${who} 点了「重办」` }
    if (entry.kind === "params_changed") return { icon: <PencilIcon />, title: entry.byId ? `${who} 改了参数` : "参数改了（派活方用新参数覆盖）" }
    if (entry.kind !== "cancelled") return null
    return { icon: <CircleSlashIcon />, title: `${entry.byId ? who : ""} 点了「不办了」${entry.note ? `：${entry.note}` : ""}`.trim() }
  })()
  if (!line) return null
  return (
    <div>
      <TraceLine>
        <TraceIcon>{line.icon}</TraceIcon>
        <TraceTitle>{line.title}</TraceTitle>
        <TraceDescription>{timeText(entry.at)}</TraceDescription>
      </TraceLine>
    </div>
  )
}

