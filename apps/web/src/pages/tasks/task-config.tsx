// 任务配置的小块：列表视图（task-detail.tsx 的分区卡）和结构图（task-structure.tsx 的详情栏）共用，两边显示的是同一份东西。
// 步骤、交付物、模型、验收和复核、记忆、技能、工具（含浏览器、桌面）、流程、规则，以及「派出去的活」。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { FlagIcon, HourglassIcon } from "lucide-react"
import { alwaysOnToolIds, findById, isRoutineToolId, sameShanghaiDay, SUBAGENT_START_TOOL_ID, toolIdsOfTask, type SessionSummary, type TaskDef } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Badge } from "@/components/ui/badge"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useBrowsersQuery, useDesktopsQuery, useMemoriesQuery, useModels, useRoutineLibraryQuery, useRulesQuery, useSkillsQuery, useTasksQuery, useToolName, useToolsQuery } from "@/lib/data"
import { href, type PageId } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { compileOf, ruleSelectable, ruleVerifies } from "@/pages/rules/compile"
import { unavailableReason, useLibraryDetails } from "@/pages/routines/parts"

import { StepList } from "./parts"

export const LinkBadges = ({ label, page, items }: { label: string; page: PageId; items: { id: string; name: string }[] }) => (
  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
    <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
    <div className="flex flex-wrap gap-1.5">
      {items.length === 0 && <span className="text-muted-foreground">没选</span>}
      {items.map((item) => <Badge key={item.id} variant="outline" render={<a href={href(page, { id: item.id })} />}>{item.name}</Badge>)}
    </div>
  </div>
)

export const ConfigLine = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
    <span className="w-12 shrink-0 text-muted-foreground">{label}</span>
    <span className="min-w-0 break-all">{children}</span>
  </div>
)

const clip = (text: string) => (text.length > 18 ? `${text.slice(0, 18)}…` : text)
export const named = <T extends { id: string; name: string }>(list: T[], ids: string[]) => ids.flatMap((id) => findById(list, id) ?? [])

/** 步骤：写了的一步一行（检查点、可以等待）；没写的说 agent 自己探索，附上最近一次探索出的步骤 */
export function StepsView({ task, latest }: { task: TaskDef; latest?: SessionSummary }) {
  const explored = latest?.exploredSteps
  if (task.steps.length === 0)
    return (
      <div className="flex flex-col gap-2">
        <p className="text-muted-foreground">没写步骤，agent 自己探索。{explored ? "agent 最近一次探索出的步骤：" : "运行后这里会列出 agent 探索出的步骤。"}</p>
        {explored && <StepList steps={explored} />}
      </div>
    )
  return (
    <ItemGroup className="gap-2">
      {task.steps.map((step, index) => (
        <Item key={step.id} variant="outline" size="xs">
          <ItemMedia variant="icon">{index + 1}</ItemMedia>
          <ItemContent>
            <ItemTitle className="line-clamp-none">{step.text}</ItemTitle>
            {step.checkpoint && <ItemDescription><FlagIcon className="mr-1 inline size-3" />检查点：{step.checkpoint}</ItemDescription>}
          </ItemContent>
          {step.wait && <ItemActions><Badge variant="outline"><HourglassIcon data-icon="inline-start" />可以等待</Badge></ItemActions>}
        </Item>
      ))}
    </ItemGroup>
  )
}

/** 交付物：一项一行（名字 + 说明）；没写的一行灰字 */
export function DeliverablesView({ task, empty = "没写交付物。" }: { task: TaskDef; empty?: string }) {
  if (task.deliverables.length === 0) return <p className="text-muted-foreground">{empty}</p>
  return (
    <ItemGroup className="gap-2">
      {task.deliverables.map((each, index) => (
        <Item key={`${index}-${each.name}`} variant="outline" size="xs">
          <ItemContent>
            <ItemTitle className="line-clamp-none">{each.name}</ItemTitle>
            {each.description && <ItemDescription className="line-clamp-none whitespace-pre-line">{each.description}</ItemDescription>}
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}

/** 被派的活要交回的结果：「价格（必填）、备注」 */
export const resultsText = (task: TaskDef) => (task.dispatch?.results ?? []).map((result) => `${result.name}${result.required ? "（必填）" : ""}`).join("、")

/** 执行模型（徽章，点了去模型页） */
export function ModelBadge({ task }: { task: TaskDef }) {
  const { modelName, providers } = useModels()
  const providerId = providers.find((provider) => provider.models.some((model) => model.id === task.modelId))?.id ?? task.modelId.split("/")[0]
  return <LinkBadges label="模型" page="models" items={[{ id: providerId, name: modelName(task.modelId) }]} />
}

/** 子 agent 用的模型：没选「拆给子 agent」时用不上 */
export function SubagentModelLine({ task }: { task: TaskDef }) {
  const { modelName } = useModels()
  const text = !task.toolIds.includes(SUBAGENT_START_TOOL_ID)
    ? "没选「拆给子 agent」，用不上"
    : task.subagentModelId ? modelName(task.subagentModelId) : "和执行模型一样"
  return <ConfigLine label="子 agent">{text}</ConfigLine>
}

/** 「结束后 AI 复核 · DeepSeek V4.1 Flash」；有三方验收、旧任务没选复核模型（用默认的 / 没有默认的不能运行）的写清楚 */
function reviewText(task: TaskDef, verifies: boolean, modelName: (id: string) => string, defaultReview?: string) {
  const model = task.reviewModelId ? modelName(task.reviewModelId) : defaultReview ? `${modelName(defaultReview)}（没选，用默认的）` : undefined
  if (!model) return "还没选复核模型：运行不了，先改任务选一个"
  return verifies ? `三方验收通过的直接办成，其余结束后 AI 复核 · ${model}` : `结束后 AI 复核 · ${model}`
}

/** 验收、复核两行 */
export function VerifyReviewLines({ task }: { task: TaskDef }) {
  const { modelName, defaults } = useModels()
  const rules = useRulesQuery().data ?? []
  return (
    <>
      <ConfigLine label="验收">{task.verifyModelId ? modelName(task.verifyModelId) : `默认验收模型（${modelName(defaults.verify)}）`} · 任务选了「交给三方验收」的规则时才用</ConfigLine>
      <ConfigLine label="复核">{reviewText(task, named(rules, task.ruleIds).some(ruleVerifies), modelName, defaults.review)}</ConfigLine>
    </>
  )
}

export function MemoryBadges({ task }: { task: TaskDef }) {
  const memories = useMemoriesQuery().data ?? []
  return <LinkBadges label="记忆" page="memory" items={task.memoryIds.flatMap((id) => findById(memories, id) ?? []).map((m) => ({ id: m.id, name: clip(m.content) }))} />
}

export function SkillBadges({ task }: { task: TaskDef }) {
  const skills = useSkillsQuery().data ?? []
  return <LinkBadges label="技能" page="skills" items={named(skills, task.skillIds)} />
}

/** 工具（不含库流程，自带的标「自带」） */
export function ToolBadges({ task }: { task: TaskDef }) {
  const toolName = useToolName()
  const alwaysOn = alwaysOnToolIds(useToolsQuery().data?.tools ?? [])
  return <LinkBadges label="工具" page="tools" items={toolIdsOfTask(task, alwaysOn).filter((id) => !isRoutineToolId(id)).map((id) => ({ id, name: alwaysOn.includes(id) ? `${toolName(id)} · 自带` : toolName(id) }))} />
}

/** 规则：没生效的、按旧版本执行的写在徽章上；withVerify 时把「交给三方验收」也标出来 */
export function RuleBadges({ task, withVerify = false }: { task: TaskDef; withVerify?: boolean }) {
  const rules = useRulesQuery().data ?? []
  const items = named(rules, task.ruleIds).map((rule) => {
    const name = ruleSelectable(rule) ? (compileOf(rule).outdated ? `${rule.name} · 按旧版本` : rule.name) : `${rule.name} · 未生效，不执行`
    return { id: rule.id, name: withVerify && ruleVerifies(rule) ? `${name} · 三方验收` : name }
  })
  return <LinkBadges label="规则" page="rules" items={items} />
}

/** 选了的库流程（docs/dev/routine-library.md 9.2）：每个一个徽章，点了去流程页；停用、撤下、缺工具或开关（新的运行用不了）的用 ghost，悬停看原因 */
export function RoutineBadges({ task }: { task: TaskDef }) {
  const toolName = useToolName()
  const library = useRoutineLibraryQuery().data
  const chosen = task.toolIds.filter(isRoutineToolId)
  const entries = chosen.map((toolId) => ({ toolId, entry: library?.find((each) => each.toolId === toolId) }))
  const details = useLibraryDetails(entries.flatMap(({ entry }) => (entry ? [entry.routineId] : [])))
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-start sm:gap-4">
      <span className="w-12 shrink-0 text-muted-foreground">流程</span>
      <div className="flex flex-wrap gap-1.5">
        {chosen.length === 0 && <span className="text-muted-foreground">没选</span>}
        {entries.map(({ toolId, entry }) => {
          const name = entry?.title ?? toolName(toolId)
          const to = entry ? href("routines", { id: entry.routineId }) : href("routines")
          // 流程库还没取到（或取不到）时不判断，照常显示
          const reason = library ? unavailableReason(entry, entry && details.get(entry.routineId), task, toolName) : undefined
          if (!reason) return <Badge key={toolId} variant="outline" render={<a href={to} />}>{name}</Badge>
          return (
            <Tooltip key={toolId}>
              <TooltipTrigger render={<Badge variant="ghost" render={<a href={to} />} />}>
                {name} · {entry?.status === "paused" ? "停用" : entry?.status === "withdrawn" ? "撤下" : "用不了"}
              </TooltipTrigger>
              <TooltipContent>{reason}</TooltipContent>
            </Tooltip>
          )
        })}
      </div>
    </div>
  )
}

/** 选了「浏览器」工具时：允许的 Chrome 配置、网址白名单、是否允许执行脚本 */
export function BrowserConfig({ task }: { task: TaskDef }) {
  const profiles = useBrowsersQuery().data ?? []
  return (
    <>
      {task.browserProfileIds.length > 0
        ? <LinkBadges label="Chrome" page="browsers" items={named(profiles, task.browserProfileIds)} />
        : <ConfigLine label="Chrome">全部 Chrome 配置都能用，agent 自己选</ConfigLine>}
      <ConfigLine label="白名单">{task.allowedDomains.length ? task.allowedDomains.join("、") : "不限制"}</ConfigLine>
      <ConfigLine label="脚本">{task.allowBrowserEvaluate ? "允许在网页里执行脚本" : "不允许在网页里执行脚本"}</ConfigLine>
      <ConfigLine label="看画面">{task.allowBrowserVision ? "允许截图看画面、按坐标点" : "不允许看画面"}</ConfigLine>
      <ConfigLine label="接口">{task.allowBrowserFetch ? "允许直接调网站接口" : "不允许直接调网站接口"}</ConfigLine>
    </>
  )
}

/** 选了「桌面」工具时：允许的桌面、是否允许看画面 */
export function DesktopConfig({ task }: { task: TaskDef }) {
  const desktops = useDesktopsQuery().data ?? []
  return (
    <>
      {task.desktopIds.length > 0
        ? <LinkBadges label="桌面" page="desktops" items={named(desktops, task.desktopIds)} />
        : <ConfigLine label="桌面">全部桌面都能用，agent 自己挑</ConfigLine>}
      <ConfigLine label="看桌面">{task.allowDesktopVision ? "允许截桌面画面给模型看" : "不允许看画面，只读界面控件"}</ConfigLine>
    </>
  )
}

/** 选了内置工具「派活」的任务：派给谁、今天派了几张、一共几张 */
export function DispatchOutSection({ task }: { task: TaskDef }) {
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
      description="这个任务的 agent 用内置工具「派活」派出去的单。同一件事重复派不会重复办。每张单在被派任务详情的「派来的活」里看。"
    >
      {targets.length === 0 && mine.length === 0 ? (
        <p className="text-muted-foreground">还没有任务允许它派活：去要接活的任务上打开「可以被派活」，把它加进「谁能派活给它」。</p>
      ) : (
        <p>
          派给 {targets.length ? targets.map((each, index) => (
            <React.Fragment key={each.id}>
              {index > 0 && "、"}
              <a className="underline underline-offset-4" href={href("tasks", { id: each.id })}>「{each.title}」</a>
            </React.Fragment>
          )) : "（现在没有任务允许它派活）"} · 今天派了 <span className="font-medium tabular-nums">{today}</span> 张 · 一共{" "}
          <span className="font-medium tabular-nums">{page?.counts.all ?? "—"}</span> 张
          {lastRun && (
            <span className="text-muted-foreground">
              {" "}· 最近一次有新单的运行 <a className="font-mono underline underline-offset-4" href={href("sessions", { id: lastRun })}>{lastRun}</a>（派了 {lastCount} 张）
            </span>
          )}
        </p>
      )}
    </DetailSection>
  )
}
