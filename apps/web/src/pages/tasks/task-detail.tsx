// 任务详情（放在右侧抽屉里）：分区卡 + 抽屉底部的操作。
import { ChevronRightIcon, FlagIcon, HourglassIcon, PlayIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Switch } from "@/components/ui/switch"
import { alwaysOnToolIds, findById, fmtDateTime, fmtShort, toolIdsOfTask, type SessionRun, type TaskDef } from "@heyagent/shared"

import { useMemoriesQuery, useModels, useRulesQuery, useRunNow, useSkillsQuery, useToolName, useToolsQuery } from "@/lib/data"
import { readOnlyToast } from "@/lib/readonly"
import { href, type PageId } from "@/lib/router"

import { CheckpointGrid, RunStatusBadge, StepList, WaitingAlert, checkpointSummary, money, tokens, type TasksState } from "./parts"

/** 抽屉底部的操作（主管）：启动开关 + 立即运行 / 立即继续 */
export function TaskActions({ task, state }: { task: TaskDef; state: TasksState }) {
  const latest = state.runsOf(task.id)[0]
  const suspended = latest && (latest.status === "waiting" || latest.status === "needs_human")
  return (
    <>
      <label className="flex items-center gap-2">
        <Switch checked={task.enabled} onCheckedChange={readOnlyToast} aria-label="启动这个任务" />
        {task.enabled ? "已启动" : "已停用"}
      </label>
      <Button disabled={!task.enabled || latest?.status === "running"} onClick={readOnlyToast}>
        <PlayIcon data-icon="inline-start" />{suspended ? "立即继续" : latest?.status === "running" ? "正在运行" : "立即运行"}
      </Button>
    </>
  )
}

/** 抽屉里的任务详情：四张分区卡（目标和步骤 / 检查点 / 运行记录 / 用到的配置）。标题和操作在抽屉的头和底。 */
export function TaskDetail({ task, state }: { task: TaskDef; state: TasksState }) {
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
