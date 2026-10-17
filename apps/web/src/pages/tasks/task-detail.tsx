// 任务详情（放在右侧抽屉里）：分区卡 + 抽屉底部的操作。
import * as React from "react"
import { ChevronRightIcon, CircleStopIcon, EllipsisIcon, FlagIcon, HandIcon, HourglassIcon, PaperclipIcon, PencilIcon, PlayIcon, Trash2Icon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { alwaysOnToolIds, findById, fmtDateTime, fmtShort, toolIdsOfTask, type SessionRun, type TaskDef } from "@heyagent/shared"

import { useHumanItems, useMemoriesQuery, useModels, useRulesQuery, useRunNow, useSkillsQuery, useToolName, useToolsQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, setParams, type PageId } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { CheckpointGrid, RunStatusBadge, StepList, WaitingAlert, checkpointSummary, money, tokens, type TasksState } from "./parts"
import { CancelRunDialog, isActive, ResumeButton, RunWithFilesDialog, TaskAttachments, useStartRun } from "./run-actions"
import { TaskDialog } from "./task-dialog"

/** 抽屉底部的操作（负责人和主管）：启动开关 + 编辑 / 带附件运行 / 取消 / 删除 + 主按钮。
 * 主按钮按最近一次运行的状态变：挂起等待 → 立即继续；等人处理 → 去待办处理；执行中 → 正在运行；其他 → 立即运行 */
export function TaskActions({ task, state }: { task: TaskDef; state: TasksState }) {
  const runs = state.runsOf(task.id)
  const latest = runs[0]
  const blocker = useHumanItems().find((item) => latest && item.runId === latest.id && ["approval", "verify", "login"].includes(item.kind))
  const [editing, setEditing] = React.useState(false)
  const [deleting, setDeleting] = React.useState(false)
  const [withFiles, setWithFiles] = React.useState(false)
  const [cancelling, setCancelling] = React.useState(false)
  const setEnabled = useAction(trpc.tasks.setEnabled.mutationOptions(), { success: (_data, vars) => (vars.enabled ? "任务已启动" : "任务已停用，不会再运行") })
  const remove = useAction(trpc.tasks.delete.mutationOptions({ onSuccess: () => setParams({ id: null, run: null }) }), { success: `任务 ${task.id} 已删除` })
  const start = useStartRun(task)
  let primary: React.ReactNode
  if (latest?.status === "waiting") primary = <ResumeButton run={latest} />
  else if (latest?.status === "needs_human")
    primary = <Button nativeButton={false} render={<a href={href("todos", { id: blocker?.id ?? latest.id })} />}><HandIcon data-icon="inline-start" />去待办处理</Button>
  else if (latest?.status === "running" || latest?.status === "verifying") primary = <Button disabled><Spinner data-icon="inline-start" />正在运行</Button>
  else
    primary = (
      <Button disabled={!task.enabled || start.isPending} onClick={() => start.mutate({ taskId: task.id })}>
        {start.isPending ? <Spinner data-icon="inline-start" /> : <PlayIcon data-icon="inline-start" />}立即运行
      </Button>
    )
  return (
    <>
      <label className="flex items-center gap-2">
        <Switch checked={task.enabled} disabled={setEnabled.isPending} onCheckedChange={(on) => setEnabled.mutate({ id: task.id, enabled: Boolean(on) })} aria-label="启动这个任务" />
        {task.enabled ? "已启动" : "已停用"}
      </label>
      <div className="flex items-center gap-2">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="任务的更多操作" />}>
            <EllipsisIcon />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-44">
            <DropdownMenuItem onClick={() => setEditing(true)}><PencilIcon />编辑</DropdownMenuItem>
            <DropdownMenuItem disabled={!task.enabled || isActive(latest)} onClick={() => setWithFiles(true)}><PaperclipIcon />带附件运行…</DropdownMenuItem>
            {latest && isActive(latest) && <DropdownMenuItem variant="destructive" onClick={() => setCancelling(true)}><CircleStopIcon />取消运行 {latest.id}</DropdownMenuItem>}
            <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}><Trash2Icon />删除</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {primary}
      </div>
      <RunWithFilesDialog key={withFiles ? "files-open" : "files-closed"} task={task} open={withFiles} onOpenChange={setWithFiles} />
      {latest && <CancelRunDialog key={`${latest.id}-${cancelling}`} run={latest} open={cancelling} onOpenChange={setCancelling} />}
      <TaskDialog key={editing ? "edit" : "closed"} open={editing} onOpenChange={setEditing} task={task} />
      <AlertDialog open={deleting} onOpenChange={setDeleting}>
        <AlertDialogContent>
          {runs.length > 0 ? (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>这个任务不能删除</AlertDialogTitle>
                <AlertDialogDescription>它已经有 {runs.length} 次运行记录，运行记录要留着查。不想让它再运行，就把它停用。</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>知道了</AlertDialogCancel>
                {task.enabled && <AlertDialogAction onClick={() => setEnabled.mutate({ id: task.id, enabled: false })}>停用这个任务</AlertDialogAction>}
              </AlertDialogFooter>
            </>
          ) : (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>删除任务 {task.id}「{task.title}」？</AlertDialogTitle>
                <AlertDialogDescription>它还没运行过。删除后步骤、检查点和选用的配置都会清掉，不能恢复；挂在它上面的待办也会一起删除。</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>先不删</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => remove.mutate({ id: task.id })}>删除任务</AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** 抽屉里的任务详情：分区卡（目标和步骤 / 检查点 / 运行记录 / 附件 / 用到的配置）。标题和操作在抽屉的头和底。 */
export function TaskDetail({ task, state, canEdit }: { task: TaskDef; state: TasksState; canEdit: boolean }) {
  const taskRuns = state.runsOf(task.id)
  const latest = taskRuns[0]
  return (
    <>
      {latest && <WaitingAlert run={latest} link={href("tasks", { id: task.id, run: latest.id })} />}
      <GoalAndSteps task={task} latest={latest} />
      <DetailSection title={latest ? `检查点 · ${checkpointSummary(latest.checkpoints)}` : "检查点"} description={latest && `最近一次运行 ${latest.id} 的检查点，每条一张卡`}>
        {latest ? <CheckpointGrid run={latest} /> : <p className="text-muted-foreground">还没运行过。运行后，每个检查点的进度和记录会显示在这里。</p>}
      </DetailSection>
      <DetailSection title={`运行记录（${taskRuns.length}）`} description="一次运行 = 一个 session：要等时挂起，等到了继续同一个 session；定时任务每次触发是一次新的运行。点一行看完整过程。">
        {taskRuns.length ? <RunList task={task} taskRuns={taskRuns} /> : <p className="text-muted-foreground">还没运行过。</p>}
      </DetailSection>
      <DetailSection title="附件" description="任务附件每次运行都会带上，agent 用「读附件」工具读。只想这一次带的，用「⋯ → 带附件运行」。">
        <TaskAttachments task={task} canEdit={canEdit} />
      </DetailSection>
      <UsedConfig task={task} />
    </>
  )
}

function GoalAndSteps({ task, latest }: { task: TaskDef; latest?: SessionRun }) {
  const explored = latest?.exploredSteps
  return (
    <DetailSection title="目标和步骤">
      <div className="flex flex-col gap-4">
        <p><span className="text-muted-foreground">目标：</span>{task.goal}</p>
        {task.steps.length > 0 ? (
          <ItemGroup className="gap-2">
            {task.steps.map((step, index) => (
              <Item key={step.id} variant="outline" size="xs">
                <ItemMedia variant="icon">{index + 1}</ItemMedia>
                <ItemContent>
                  <ItemTitle>{step.text}</ItemTitle>
                  {step.checkpoint && <ItemDescription><FlagIcon className="mr-1 inline size-3" />检查点：{step.checkpoint}</ItemDescription>}
                </ItemContent>
                {step.wait && <ItemActions><Badge variant="outline"><HourglassIcon data-icon="inline-start" />可以等待</Badge></ItemActions>}
              </Item>
            ))}
          </ItemGroup>
        ) : (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground">没写步骤，agent 自己探索。{explored ? `最近一次运行（${latest.id}）里 agent 探索出的步骤：` : "运行后这里会列出 agent 探索出的步骤。"}</p>
            {explored && <StepList steps={explored} />}
          </div>
        )}
      </div>
    </DetailSection>
  )
}

function RunList({ task, taskRuns }: { task: TaskDef; taskRuns: SessionRun[] }) {
  const runNow = useRunNow()
  const { modelName } = useModels()
  return (
    <ItemGroup className="gap-2">
      {taskRuns.map((run) => {
        const now = runNow(run)
        return (
          <Item key={run.id} variant="outline" size="sm" render={<a href={href("tasks", { id: task.id, run: run.id })} />}>
            <ItemContent className="min-w-0">
              <ItemTitle className="flex-wrap">
                <span className="font-mono">{run.id}</span>
                <RunStatusBadge status={run.status} />
                <span className="font-normal tabular-nums text-muted-foreground">{fmtDateTime(run.startedAt)}{run.endedAt ? ` – ${fmtShort(run.endedAt)}` : " 起"}</span>
              </ItemTitle>
              <ItemDescription className="line-clamp-2">{modelName(run.modelId)} · {tokens(run.tokensIn + run.tokensOut)} token · {money(run.costUsd)} · {now.label}：{now.text}</ItemDescription>
            </ItemContent>
            <ItemActions><ChevronRightIcon className="size-4 text-muted-foreground" /></ItemActions>
          </Item>
        )
      })}
    </ItemGroup>
  )
}

const LinkBadges = ({ label, page, items }: { label: string; page: PageId; items: { id: string; name: string }[] }) => (
  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
    <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
    <div className="flex flex-wrap gap-1.5">
      {items.length === 0 && <span className="text-muted-foreground">没选</span>}
      {items.map((item) => <Badge key={item.id} variant="outline" render={<a href={href(page, { id: item.id })} />}>{item.name}</Badge>)}
    </div>
  </div>
)

const clip = (text: string) => (text.length > 18 ? `${text.slice(0, 18)}…` : text)
const named = <T extends { id: string; name: string }>(list: T[], ids: string[]) => ids.flatMap((id) => findById(list, id) ?? [])

function UsedConfig({ task }: { task: TaskDef }) {
  const { modelName, providers } = useModels()
  const providerId = providers.find((provider) => provider.models.some((model) => model.id === task.modelId))?.id ?? task.modelId.split("/")[0]
  const toolName = useToolName()
  const memories = useMemoriesQuery().data ?? []
  const skills = useSkillsQuery().data ?? []
  const rules = useRulesQuery().data ?? []
  const alwaysOn = alwaysOnToolIds(useToolsQuery().data?.tools ?? [])
  return (
  <DetailSection title="用到的配置" description="建任务时选的，外加每个任务都自带的 3 个工具；agent 只能用这里列出的。点徽章去对应页面。">
    <div className="flex flex-col gap-3">
      <LinkBadges label="模型" page="models" items={[{ id: providerId, name: modelName(task.modelId) }]} />
      <LinkBadges label="记忆" page="memory" items={task.memoryIds.flatMap((id) => findById(memories, id) ?? []).map((m) => ({ id: m.id, name: clip(m.content) }))} />
      <LinkBadges label="技能" page="skills" items={named(skills, task.skillIds)} />
      <LinkBadges label="工具" page="tools" items={toolIdsOfTask(task, alwaysOn).map((id) => ({ id, name: alwaysOn.includes(id) ? `${toolName(id)} · 自带` : toolName(id) }))} />
      <LinkBadges label="规则" page="rules" items={named(rules, task.ruleIds)} />
    </div>
  </DetailSection>
  )
}
