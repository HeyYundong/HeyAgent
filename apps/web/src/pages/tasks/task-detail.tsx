// 任务详情（放在右侧抽屉里）：分区卡 + 抽屉底部的操作。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { ArrowRightIcon, CircleStopIcon, EllipsisIcon, FlagIcon, HandIcon, HourglassIcon, PaperclipIcon, PencilIcon, PlayIcon, SendIcon, Trash2Icon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Switch } from "@/components/ui/switch"
import { alwaysOnToolIds, BROWSER_TOOL_ID, can, findById, sameShanghaiDay, toolIdsOfTask, WORK_DISPATCH_TOOL_ID, type SessionSummary, type TaskDef } from "@heyagent/shared"

import { useBrowsersQuery, useHumanItems, useMemoriesQuery, useModels, useRulesQuery, useSkillsQuery, useTasksQuery, useToolName, useToolsQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, navigate, setParams, type PageId } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"
import { DispatchDialog, dispatchedToast } from "@/pages/work/dialogs"
import { useWorkTaskStats } from "@/pages/work/parts"

import { compileOf, ruleSelectable } from "@/pages/rules/compile"

import { StepList, type TasksState } from "./parts"
import { CancelRunDialog, isActive, ResumeButton, RunWithFilesDialog, TaskAttachments, useStartRun } from "./run-actions"
import { retryText } from "./dispatch-fields"
import { TaskDialog } from "./task-dialog"
import { TaskMemorySection } from "./task-memory"

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
  const [dispatching, setDispatching] = React.useState(false)
  let primary: React.ReactNode
  // 能被派活的任务：「立即运行」换成「派一张」（不然开出来的运行没有参数，agent 不知道办哪件）；同时可能有好几个运行，不按最近一次变
  if (task.dispatch)
    primary = <Button onClick={() => setDispatching(true)}><SendIcon data-icon="inline-start" />派一张</Button>
  else if (latest?.status === "waiting") primary = <ResumeButton run={latest} />
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
            {!task.dispatch && <DropdownMenuItem disabled={!task.enabled || isActive(latest)} onClick={() => setWithFiles(true)}><PaperclipIcon />带附件运行…</DropdownMenuItem>}
            {latest && isActive(latest) && <DropdownMenuItem variant="destructive" onClick={() => setCancelling(true)}><CircleStopIcon />取消运行 {latest.id}</DropdownMenuItem>}
            <DropdownMenuItem variant="destructive" onClick={() => setDeleting(true)}><Trash2Icon />删除</DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {primary}
      </div>
      {task.dispatch && <TaskDispatchDialog task={task} open={dispatching} onOpenChange={setDispatching} />}
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

/** 抽屉里的任务详情：只说明任务，分区卡（目标和步骤 / 任务记忆 / 附件 / 用到的配置）。标题和操作在抽屉的头和底。
 * 不放运行状态和运行记录：每次运行在「会话」页看（抽屉头部的「会话」按钮带上这个任务筛好） */
export function TaskDetail({ task, state, canEdit }: { task: TaskDef; state: TasksState; canEdit: boolean }) {
  const taskRuns = state.runsOf(task.id)
  return (
    <>
      {task.dispatch && <DispatchSection task={task} />}
      {task.toolIds.includes(WORK_DISPATCH_TOOL_ID) && <DispatchOutSection task={task} />}
      <GoalAndSteps task={task} latest={taskRuns[0]} />
      <TaskMemorySection task={task} runs={taskRuns} canEdit={canEdit} />
      <DetailSection title="附件" description="任务附件每次运行都会带上，agent 用「读附件」工具读。只想这一次带的，用「⋯ → 带附件运行」。">
        <TaskAttachments task={task} canEdit={canEdit} />
      </DetailSection>
      <UsedConfig task={task} />
    </>
  )
}

function GoalAndSteps({ task, latest }: { task: TaskDef; latest?: SessionSummary }) {
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
            <p className="text-muted-foreground">没写步骤，agent 自己探索。{explored ? "agent 最近一次探索出的步骤：" : "运行后这里会列出 agent 探索出的步骤。"}</p>
            {explored && <StepList steps={explored} />}
          </div>
        )}
      </div>
    </DetailSection>
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
  const { modelName, providers, defaults } = useModels()
  const providerId = providers.find((provider) => provider.models.some((model) => model.id === task.modelId))?.id ?? task.modelId.split("/")[0]
  const toolName = useToolName()
  const memories = useMemoriesQuery().data ?? []
  const skills = useSkillsQuery().data ?? []
  const rules = useRulesQuery().data ?? []
  const alwaysOn = alwaysOnToolIds(useToolsQuery().data?.tools ?? [])
  return (
  <DetailSection title="用到的配置" description="建任务时选的，外加每个任务都自带的几个工具；agent 只能用这里列出的。点徽章去对应页面。">
    <div className="flex flex-col gap-3">
      <LinkBadges label="模型" page="models" items={[{ id: providerId, name: modelName(task.modelId) }]} />
      <ConfigLine label="验收">{task.verifyModelId ? modelName(task.verifyModelId) : `默认验收模型（${modelName(defaults.verify)}）`} · 任务选了「交给三方验收」的规则时才用</ConfigLine>
      <LinkBadges label="记忆" page="memory" items={task.memoryIds.flatMap((id) => findById(memories, id) ?? []).map((m) => ({ id: m.id, name: clip(m.content) }))} />
      <LinkBadges label="技能" page="skills" items={named(skills, task.skillIds)} />
      <LinkBadges label="工具" page="tools" items={toolIdsOfTask(task, alwaysOn).map((id) => ({ id, name: alwaysOn.includes(id) ? `${toolName(id)} · 自带` : toolName(id) }))} />
      <LinkBadges label="规则" page="rules" items={named(rules, task.ruleIds).map((rule) => ({ id: rule.id, name: ruleSelectable(rule) ? (compileOf(rule).outdated ? `${rule.name} · 按旧版本` : rule.name) : `${rule.name} · 未生效，不执行` }))} />
      {task.toolIds.includes(BROWSER_TOOL_ID) && <BrowserConfig task={task} />}
    </div>
  </DetailSection>
  )
}

/** 选了「浏览器」工具时：允许的 Chrome 配置、网址白名单、是否允许执行脚本 */
function BrowserConfig({ task }: { task: TaskDef }) {
  const profiles = useBrowsersQuery().data ?? []
  return (
    <>
      {task.browserProfileIds.length > 0
        ? <LinkBadges label="Chrome" page="browsers" items={named(profiles, task.browserProfileIds)} />
        : <ConfigLine label="Chrome">全部 Chrome 配置都能用，agent 自己选</ConfigLine>}
      <ConfigLine label="白名单">{task.allowedDomains.length ? task.allowedDomains.join("、") : "不限制"}</ConfigLine>
      <ConfigLine label="脚本">{task.allowBrowserEvaluate ? "允许在网页里执行脚本" : "不允许在网页里执行脚本"}</ConfigLine>
    </>
  )
}

const ConfigLine = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
    <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
    <span className="min-w-0 break-all">{children}</span>
  </div>
)

/** 抽屉里的「派一张」：任务已经选好；派出去以后提示，带「去派活页」 */
function TaskDispatchDialog({ task, open, onOpenChange }: { task: TaskDef; open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user } = useMe()
  const tasks = useTasksQuery().data ?? []
  const options = tasks.filter((each) => each.dispatch && can(user, "task.manage", { ownerId: each.ownerId }))
  return (
    <DispatchDialog
      key={open ? "open" : "closed"}
      open={open}
      onOpenChange={onOpenChange}
      taskOptions={options.some((each) => each.id === task.id) ? options : [task, ...options]}
      initialTaskId={task.id}
      onDone={(item, existing) => {
        onOpenChange(false)
        dispatchedToast(item, existing, tasks.find((each) => each.id === item.taskId)?.enabled ?? true, { label: "去派活页", onClick: () => navigate("work", { task: item.taskId, id: item.id }) })
      }}
    />
  )
}

/** 能被派活的任务：一行数字（点了去派活页并筛好）+ 参数、名额、谁能派 */
function DispatchSection({ task }: { task: TaskDef }) {
  const tasks = useTasksQuery().data ?? []
  const stats = useWorkTaskStats(task.id).data
  const dispatch = task.dispatch!
  const link = (status?: string) => href("work", { task: task.id, status })
  const numbers = [
    { label: "排队", value: stats?.queued, status: "queued" },
    { label: "在办", value: stats?.running, status: "running" },
    { label: "今天办完", value: stats?.doneToday, status: "done" },
    { label: "没办成", value: stats?.failed, status: "failed" },
  ]
  const title = (id: string) => tasks.find((each) => each.id === id)?.title ?? id
  return (
    <DetailSection
      title="派活"
      description="别的任务（或人）把一件件事派给这个任务，一件事开一次运行。点数字去派活页看那些单。"
      action={<Button variant="outline" size="sm" nativeButton={false} render={<a href={link()} />}>去派活页<ArrowRightIcon data-icon="inline-end" /></Button>}
    >
      <div className="flex flex-col gap-3">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1">
          {numbers.map((n, i) => (
            <span key={n.label} className="inline-flex items-center gap-2">
              {i > 0 && <span className="text-muted-foreground">·</span>}
              <a href={link(n.status)} className="underline-offset-4 hover:underline">
                <span className="text-muted-foreground">{n.label}</span> <span className="font-medium tabular-nums">{n.value ?? "—"}</span>
              </a>
            </span>
          ))}
        </p>
        <p className="text-muted-foreground">
          参数：{dispatch.params.map((p) => `${p.name}（${[p.required ? "必填" : "可选", p.dedupe && "去重"].filter(Boolean).join("，")}）`).join("、") || "没有"} · 同时最多 {dispatch.maxRunning} 个在跑 ·
          谁能派活给它：{task.dispatchFrom.length ? task.dispatchFrom.map((id) => `「${title(id)}」`).join("、") : "只能人派"} · {retryText(dispatch)}
        </p>
      </div>
    </DetailSection>
  )
}

/** 选了内置工具「派活」的任务：派给谁、今天派了几张、一共几张 */
function DispatchOutSection({ task }: { task: TaskDef }) {
  const tasks = useTasksQuery().data ?? []
  const page = useQuery(trpc.work.list.queryOptions({ fromTaskId: task.id, days: 0, limit: 200 })).data
  const mine = page?.items ?? []
  const now = new Date()
  const today = mine.filter((item) => sameShanghaiDay(item.createdAt, now)).length
  const targets = tasks.filter((each) => each.dispatchFrom.includes(task.id))
  const lastRun = mine.find((item) => item.fromSessionId)?.fromSessionId
  const lastCount = lastRun ? mine.filter((item) => item.fromSessionId === lastRun).length : 0
  return (
    <DetailSection
      title="派出去的活"
      description="这个任务的 agent 用内置工具「派活」派出去的单。同一件事重复派不会重复办。"
      action={<Button variant="outline" size="sm" nativeButton={false} render={<a href={href("work", { from: task.id })} />}>去派活页<ArrowRightIcon data-icon="inline-end" /></Button>}
    >
      {targets.length === 0 && mine.length === 0 ? (
        <p className="text-muted-foreground">还没有任务允许它派活：去要接活的任务上打开「可以被派活」，把它加进「谁能派活给它」。</p>
      ) : (
        <p>
          派给 {targets.map((each) => `「${each.title}」`).join("、") || "（现在没有任务允许它派活）"} · 今天派了 <span className="font-medium tabular-nums">{today}</span> 张 · 一共{" "}
          <span className="font-medium tabular-nums">{page?.counts.all ?? "—"}</span> 张
          {lastRun && <span className="text-muted-foreground"> · 最近一次有新单的运行 {lastRun}（派了 {lastCount} 张）</span>}
        </p>
      )}
    </DetailSection>
  )
}
