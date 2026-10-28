// 任务详情的「固化流程」区块（docs/dev/solidify.md 第 9 节、15.4 第 1 条）：任务有固化流程才显示（routine.get）。
// 一行状态（试用 / 正式 / 停用、第几版）、「先跑流程」开关（routine.setMode）、最近几次的成绩、停用的原因、正在写 / 试跑 / 待审核的那一版；
// 「⋯」里：看脚本（启用的那一版）、版本记录（approved 过的能回到那一版，routine.restore）、停用（AlertDialog 确认）/ 重新启用（routine.setPaused）。
// 开关、停用、回旧版只有负责人和主管能点（后端也拦）。
// 第二期（第 17.1 节）：一行写任务的「办成后自动固化」「固化时不试跑」现在是什么（在编辑任务里改）；自动固化的版本加「自动固化」徽章。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { EllipsisIcon, FileCodeIcon, HistoryIcon, PauseIcon, PlayIcon, RotateCcwIcon, RotateCwIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react"
import { autoSolidifyDefault, fmtDateTime, ROUTINE_PAUSE_AFTER_FALLBACKS, ROUTINE_TRIAL_RUNS, type RoutineSummary, type TaskDef } from "@heyagent/shared"

import { DetailSection, HelpTip } from "@/components/shell/simple-page"
import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { useHumanItems, useModels } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { trpc } from "@/lib/trpc"
import { TextLink } from "@/pages/sessions/parts"

import { money } from "./parts"
import { AutoBadge, durationText, RoutineStatusBadge, RoutineVersionView, VersionStatusBadge } from "./routine-parts"

type VersionRow = RoutineSummary["versions"][number]

/** 停用原因后面补个句号（原因可能自带标点） */
const sentence = (text: string) => (/[。！？.!?]$/.test(text) ? text : `${text}。`)

const IN_PROGRESS = new Set<VersionRow["status"]>(["drafting", "testing", "review"])

export function TaskRoutineSection({ task, canEdit }: { task: TaskDef; canEdit: boolean }) {
  const query = useQuery(trpc.routine.get.queryOptions({ taskId: task.id }))
  // 大多数任务没有固化流程：取到之前不占位，免得闪一下空卡片
  if (query.isPending) return null
  if (query.isError) {
    return (
      <DetailSection title="固化流程">
        <Alert variant="destructive">
          <TriangleAlertIcon />
          <AlertTitle>固化流程没取到</AlertTitle>
          <AlertDescription>网络不稳定，稍后再试。运行不受影响。</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="sm" onClick={() => void query.refetch()}><RotateCwIcon data-icon="inline-start" />重试</Button>
          </AlertAction>
        </Alert>
      </DetailSection>
    )
  }
  if (!query.data) return null
  return <RoutineSection task={task} routine={query.data} canEdit={canEdit} />
}

function RoutineSection({ task, routine, canEdit }: { task: TaskDef; routine: RoutineSummary; canEdit: boolean }) {
  const [viewing, setViewing] = React.useState<string | null>(null)
  const [history, setHistory] = React.useState(false)
  const [pausing, setPausing] = React.useState(false)
  const active = routine.versions.find((each) => each.version === routine.activeVersion)
  const activeAuto = active?.auto ?? false
  const paused = routine.status === "paused"
  const setMode = useAction(trpc.routine.setMode.mutationOptions(), {
    success: (_data, vars) => (vars.mode === "first" ? "已打开：以后的运行先跑固化流程" : "已关掉：以后的运行都由 agent 做"),
    errorTitle: "开关没改成",
  })
  const setPaused = useAction(trpc.routine.setPaused.mutationOptions({ onSuccess: () => setPausing(false) }), {
    success: (_data, vars) => (vars.paused ? "固化流程已停用，之后的运行都由 agent 做" : `已重新启用，从试用期开始（连着 ${ROUTINE_TRIAL_RUNS} 次脚本直接办成转正式）`),
    errorTitle: (paused ? "没能重新启用" : "没能停用"),
  })
  // 最新的那一版还在写、试跑、等审核；或者最新的一版没成功（比启用的那一版新）
  const latest = routine.versions[0]
  const pending = latest && IN_PROGRESS.has(latest.status) ? latest : undefined
  const failed = latest && latest.status === "failed" && latest.version > (routine.activeVersion ?? 0) ? latest : undefined
  return (
    <DetailSection
      title="固化流程"
      description={`把办成过的一次运行写成脚本，以后的运行先照脚本做，不调执行模型；脚本跑不通就停下，agent 用同一个浏览器接着做完。新启用的版本先试用：连着 ${ROUTINE_TRIAL_RUNS} 次脚本直接办成转正式；连着 ${ROUTINE_PAUSE_AFTER_FALLBACKS} 次交给 agent 自动停用。在办成的运行详情里「⋯ → 固化成流程」做新的一版；开了「办成后自动固化」的任务，运行办成后系统自动做。`}
      action={
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="固化流程的更多操作" />}>
            {setPaused.isPending ? <Spinner /> : <EllipsisIcon />}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-40">
            <DropdownMenuItem disabled={!active} onClick={() => active && setViewing(active.id)}><FileCodeIcon />看脚本</DropdownMenuItem>
            <DropdownMenuItem onClick={() => setHistory(true)}><HistoryIcon />版本记录</DropdownMenuItem>
            {canEdit && routine.activeVersion !== null && (
              <>
                <DropdownMenuSeparator />
                {paused
                  ? <DropdownMenuItem onClick={() => setPaused.mutate({ routineId: routine.id, paused: false })}><PlayIcon />重新启用</DropdownMenuItem>
                  : <DropdownMenuItem variant="destructive" onClick={() => setPausing(true)}><PauseIcon />停用</DropdownMenuItem>}
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{routine.name || "（还没有名字）"}</span>
          <RoutineStatusBadge status={routine.status} />
          <span className="text-muted-foreground">{routine.activeVersion !== null ? `第 ${routine.activeVersion} 版` : "还没有启用的版本"}</span>
          {activeAuto && <AutoBadge />}
          {routine.status === "trial" && routine.activeVersion !== null && (
            <span className="text-muted-foreground">· 试用中，连着直接办成 {routine.directStreak} / {ROUTINE_TRIAL_RUNS} 次</span>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Switch
            id={`routine-mode-${task.id}`}
            checked={routine.mode === "first"}
            disabled={!canEdit || setMode.isPending || routine.activeVersion === null}
            onCheckedChange={(on) => setMode.mutate({ taskId: task.id, mode: on ? "first" : "off" })}
          />
          <label htmlFor={`routine-mode-${task.id}`}>先跑流程</label>
          <HelpTip>
            打开后，这个任务的每次运行先在沙箱里跑脚本，规则、白名单、审批照样每一步都管；跑通了直接收尾、照常复核，跑不通交给 agent 接着做。关掉就全部由 agent 做。
            {paused ? "现在固化流程停用着，开着也不会跑脚本。" : ""}
          </HelpTip>
          {paused && routine.mode === "first" && <span className="text-muted-foreground">（停用中，不会跑）</span>}
        </div>
        <RecentLine recent={routine.recent} />
        <SettingsLine task={task} />
        {paused && (
          <Alert>
            <PauseIcon />
            <AlertTitle>停用了</AlertTitle>
            <AlertDescription>{sentence(routine.pausedReason ?? "人停用了")}之后的运行都由 agent 做，在「⋯」里可以重新启用。</AlertDescription>
          </Alert>
        )}
        {pending && <PendingVersion version={pending} routineName={routine.name} />}
        {failed && (
          <Item variant="outline" size="xs">
            <ItemContent className="min-w-0">
              <ItemTitle>第 {failed.version} 版 <VersionStatusBadge status="failed" /></ItemTitle>
              <ItemDescription>{fmtDateTime(failed.createdAt)} 开始固化，没写成。</ItemDescription>
            </ItemContent>
            <ItemActions><Button variant="outline" size="sm" onClick={() => setViewing(failed.id)}>看原因</Button></ItemActions>
          </Item>
        )}
      </div>
      {viewing && <VersionDialog versionId={viewing} activeVersion={routine.activeVersion} onClose={() => setViewing(null)} />}
      {history && (
        <HistoryDialog routine={routine} canEdit={canEdit} onView={(id) => setViewing(id)} onClose={() => setHistory(false)} />
      )}
      <AlertDialog open={pausing} onOpenChange={setPausing}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>停用固化流程「{routine.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              停用后这个任务的运行不再先跑脚本，全部由 agent 一步一步做（慢一些、花执行模型的钱）。正在跑的运行不受影响。之后可以在「⋯」里重新启用，重新启用从试用期开始。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不停</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={setPaused.isPending} onClick={() => setPaused.mutate({ routineId: routine.id, paused: true })}>
              {setPaused.isPending ? <Spinner data-icon="inline-start" /> : <PauseIcon data-icon="inline-start" />}停用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSection>
  )
}

/** 最近几次的成绩一行：脚本直接办成 x · 交给 agent y · 平均 a 秒，agent 平均 b 秒 */
function RecentLine({ recent }: { recent: RoutineSummary["recent"] }) {
  if (recent.runs === 0) return <p className="text-muted-foreground">还没跑过脚本{recent.agentAvgMs !== null ? `；agent 自己办成平均 ${durationText(recent.agentAvgMs)}` : ""}。</p>
  return (
    <p className="flex flex-wrap items-center gap-x-1">
      <span className="text-muted-foreground">最近 {recent.runs} 次：</span>
      脚本直接办成 <span className="font-medium tabular-nums">{recent.direct}</span> · 交给 agent <span className="font-medium tabular-nums">{recent.fellBack}</span>
      {recent.avgMs !== null && <> · 平均 <span className="font-medium tabular-nums">{durationText(recent.avgMs)}</span></>}
      {recent.agentAvgMs !== null && <span className="text-muted-foreground">，agent 平均 {durationText(recent.agentAvgMs)}</span>}
      <HelpTip>只算跑过脚本的运行。「平均」是脚本直接办成的那几次从开始到结束的用时；「agent 平均」是同一个任务最近没跑脚本、办成的运行。</HelpTip>
    </p>
  )
}

/** 任务上两个固化设置现在是什么：「办成后自动固化：开（默认）· 固化时试跑」（在编辑任务里改） */
function SettingsLine({ task }: { task: TaskDef }) {
  // 后端还没带这两项时（undefined）按没单独设处理
  const own = task.autoSolidify ?? null
  const auto = own ?? autoSolidifyDefault(task)
  return (
    <p className="flex flex-wrap items-center gap-x-1">
      <span className="text-muted-foreground">办成后自动固化：</span>
      {auto ? "开" : "关"}{own === null && <span className="text-muted-foreground">（默认）</span>}
      <span className="text-muted-foreground">·</span>
      {task.routineSkipTest ? "固化时不试跑" : "固化时试跑"}
      <HelpTip>
        自动固化：普通运行办成后，系统自动把它写成新的一版（还没有固化流程时写第一版；脚本跑不通、agent 接着办成时修一版），照样要人审核才启用。没单独设时按默认：被派的任务、定时任务开，别的关。
        不试跑：会自动存草稿的网站选这个，写好直接交给人审核。两项都在「编辑任务」里改。
      </HelpTip>
    </p>
  )
}

/** 正在写、试跑、待审核的那一版：待审核的链到那件「审核固化流程」 */
function PendingVersion({ version, routineName }: { version: VersionRow; routineName: string }) {
  const item = useHumanItems().find((each) => each.kind === "routine" && each.detail.routine?.versionId === version.id)
  const auto = version.auto
  const text = version.status === "review" ? "写好、试跑过了，等你审核" : version.status === "testing" ? "脚本写好了，正在试跑（走到提交前停）" : "固化员在读运行的过程、写脚本"
  return (
    <Item variant="muted" size="xs">
      <ItemContent className="min-w-0">
        <ItemTitle className="flex-wrap">第 {version.version} 版{version.name && version.name !== routineName ? `「${version.name}」` : ""} <VersionStatusBadge status={version.status} />{auto && <AutoBadge />}</ItemTitle>
        <ItemDescription>
          {text} · {auto ? "自动" : ""}从运行 {version.sourceSessionId ? <TextLink to={href("sessions", { id: version.sourceSessionId })}>{version.sourceSessionId}</TextLink> : "—"} 固化 · {fmtDateTime(version.createdAt)}
        </ItemDescription>
      </ItemContent>
      {version.status === "review" && item && (
        <ItemActions>
          <Button size="sm" nativeButton={false} render={<a href={href("sessions", { status: "human", id: item.id })} />}>去审核</Button>
        </ItemActions>
      )}
    </Item>
  )
}

/** 「看脚本」：一版的全部内容（步骤说明、输入和交回、会改东西的步骤、假设、脚本，修的版本带对比） */
export function VersionDialog({ versionId, activeVersion, onClose }: { versionId: string; activeVersion: number | null; onClose: () => void }) {
  const query = useQuery(trpc.routine.version.queryOptions({ id: versionId }))
  const { modelName } = useModels()
  const version = query.data
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle className="flex flex-wrap items-center gap-2">
            {version ? <>第 {version.version} 版「{version.name || "没有名字"}」<VersionStatusBadge status={version.status} current={version.version === activeVersion} />{version.auto && <AutoBadge />}</> : "固化流程的脚本"}
          </DialogTitle>
          <DialogDescription>
            {version
              ? [
                  version.sourceSessionId ? `从运行 ${version.sourceSessionId} 固化` : "",
                  version.auto ? "运行办成后系统自动固化" : version.createdBy ? `${version.createdBy.name}点的` : "",
                  fmtDateTime(version.createdAt),
                  version.modelId ? `固化用 ${modelName(version.modelId)}，写了 ${version.round} 轮，花了 ${money(version.costUsd)}` : "",
                  version.approvedBy && version.approvedAt ? `${version.approvedBy.name} ${fmtDateTime(version.approvedAt)} 启用` : "",
                ].filter(Boolean).join(" · ")
              : "取这一版的内容……"}
          </DialogDescription>
        </DialogHeader>
        {query.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-20 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : query.isError ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>这一版没取到</AlertTitle>
            <AlertDescription>网络不稳定，稍后再试。</AlertDescription>
            <AlertAction><Button variant="outline" size="sm" onClick={() => void query.refetch()}><RotateCwIcon data-icon="inline-start" />重试</Button></AlertAction>
          </Alert>
        ) : (
          <div className="flex flex-col gap-4 text-sm">
            {query.data.failReason && (
              <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>没成功</AlertTitle><AlertDescription>{query.data.failReason}</AlertDescription></Alert>
            )}
            {query.data.rejectReason && (
              <Alert><Undo2Icon /><AlertTitle>审核时没用</AlertTitle><AlertDescription>{query.data.rejectReason}</AlertDescription></Alert>
            )}
            {query.data.code || query.data.description ? <RoutineVersionView version={query.data} /> : <p className="text-muted-foreground">这一版没写出脚本。</p>}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

/** 版本记录：每版一行（状态、来源运行、时间）；启用过、不是现在用的那一版能「回到这一版」（AlertDialog 确认） */
function HistoryDialog({ routine, canEdit, onView, onClose }: { routine: RoutineSummary; canEdit: boolean; onView: (id: string) => void; onClose: () => void }) {
  const [restoring, setRestoring] = React.useState<VersionRow | null>(null)
  const restore = useAction(trpc.routine.restore.mutationOptions({ onSuccess: () => setRestoring(null) }), {
    success: (result) => `已回到第 ${result.activeVersion} 版，从试用期开始`,
    errorTitle: "没能回到这一版",
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>「{routine.name}」的版本记录</DialogTitle>
          <DialogDescription>每次「固化成流程」、每次办成后自动固化都出一版，都要人审核启用。启用过的版本可以回去用，回去也从试用期开始。</DialogDescription>
        </DialogHeader>
        <ItemGroup className="gap-2">
          {routine.versions.map((version) => {
            const current = version.version === routine.activeVersion
            return (
              <Item key={version.id} variant="outline" size="xs">
                <ItemContent className="min-w-0">
                  <ItemTitle className="flex-wrap">第 {version.version} 版 <VersionStatusBadge status={version.status} current={current} />{version.auto && <AutoBadge />}</ItemTitle>
                  <ItemDescription>
                    {fmtDateTime(version.createdAt)}
                    {version.sourceSessionId && <> · 从 <TextLink to={href("sessions", { id: version.sourceSessionId })}>{version.sourceSessionId}</TextLink> 固化</>}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Button variant="ghost" size="sm" onClick={() => onView(version.id)}>看</Button>
                  {canEdit && version.status === "approved" && !current && (
                    <Button variant="outline" size="sm" disabled={restore.isPending} onClick={() => setRestoring(version)}>
                      <RotateCcwIcon data-icon="inline-start" />回到这一版
                    </Button>
                  )}
                </ItemActions>
              </Item>
            )
          })}
        </ItemGroup>
        <AlertDialog open={restoring !== null} onOpenChange={(open) => !open && setRestoring(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>回到第 {restoring?.version} 版？</AlertDialogTitle>
              <AlertDialogDescription>
                从下一次运行开始照第 {restoring?.version} 版的脚本做{routine.activeVersion !== null ? `，换下现在的第 ${routine.activeVersion} 版` : ""}。回去以后从试用期开始，正在跑的运行不受影响。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>先不换</AlertDialogCancel>
              <AlertDialogAction disabled={restore.isPending} onClick={() => restoring && restore.mutate({ routineId: routine.id, version: restoring.version })}>
                {restore.isPending ? <Spinner data-icon="inline-start" /> : <RotateCcwIcon data-icon="inline-start" />}回到这一版
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}
