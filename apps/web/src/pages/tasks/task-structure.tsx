// 任务抽屉的「结构图」视图（docs/dev/task-structure.md，2026-10-30 用户定的设计稿 C）：照 agent 主循环把任务画成一张图——
// 目标（起点）→ agent 循环（模型 + 步骤）→ 交付物（终点）；循环上面是「带进提示词」的记忆、技能、规则、附件，下面是「能伸出去的手」工具、固化流程；
// 目标上面是什么时候跑，交付物下面是验收和复核。点任意一块，详情栏说明它是什么、这个任务里怎么配的，能改的给入口。
// 宽屏（lg 起）横着画、详情栏在右边；窄一些竖着排、详情在图下面；手机宽度点一块从底部弹出详情。
// 详情里直接用列表视图的那批区块（task-config.tsx、TaskScheduleSection、TaskMemorySection……），列表里有的这里都看得到。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import {
  ArrowDownIcon,
  ArrowRightIcon,
  BookOpenIcon,
  CircleCheckIcon,
  ClockIcon,
  CpuIcon,
  DatabaseIcon,
  ExternalLinkIcon,
  FlagIcon,
  ListOrderedIcon,
  PackageIcon,
  PaperclipIcon,
  PencilIcon,
  RefreshCwIcon,
  ShieldIcon,
  TargetIcon,
  WrenchIcon,
  ZapIcon,
  type LucideIcon,
} from "lucide-react"
import { alwaysOnToolIds, isRoutineToolId, WORK_DISPATCH_TOOL_ID, BROWSER_TOOL_ID, DESKTOP_TOOL_ID, type TaskDef } from "@heyagent/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemTitle } from "@/components/ui/item"
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useIsMobile } from "@/hooks/use-mobile"
import { useBoardQuery, useModels, useRoutineLibraryQuery, useRulesQuery, useSkillsQuery, useToolName, useToolsQuery } from "@/lib/data"
import { href, type PageId } from "@/lib/router"
import { trpc } from "@/lib/trpc"
import { cn } from "@/lib/utils"

import { ruleVerifies } from "@/pages/rules/compile"

import type { TasksState } from "./parts"
import { TaskAttachments } from "./run-actions"
import {
  BrowserConfig, ConfigLine, DeliverablesView, DesktopConfig, DispatchOutSection, MemoryBadges, ModelBadge, named, resultsText, RoutineBadges, RuleBadges, SkillBadges, StepsView,
  SubagentModelLine, ToolBadges, VerifyReviewLines,
} from "./task-config"
import { TaskDialog } from "./task-dialog"
import { TaskMemorySection } from "./task-memory"
import { TaskRoutineSection } from "./task-routine"
import { TaskScheduleSection } from "./task-schedule"
import { DispatchInSection } from "./work-section"

export type StructureBlock = "trigger" | "goal" | "model" | "steps" | "memory" | "skills" | "rules" | "attach" | "tools" | "routine" | "deliver" | "review"

/** 每一块：名字、在图里的角色、图标、「它是什么」、改的按钮上写什么、相关的页面。说法照着现在系统真的怎么做（engine/prompt.ts、review.ts、verify.ts） */
const INFO: Record<StructureBlock, { name: string; kind: string; icon: LucideIcon; what: (task: TaskDef) => string; edit?: string; page?: { id: PageId; label: string } }> = {
  trigger: {
    name: "什么时候跑", kind: "开工", icon: ClockIcon, edit: "改定时",
    what: () => "谁叫 agent 开工。定时到点、人加的待办到点或等到事件、别的任务派活过来、有人点「立即运行」，都会让 agent 开工：一般是开一次新的运行，待办遇到挂起等着的运行就叫它接着做。",
  },
  goal: {
    name: "目标", kind: "起点", icon: TargetIcon, edit: "编辑目标",
    what: () => "整个循环围着它转：agent 每一轮都对照目标看办完没有，结束时按它报「办成」或「没办成」；复核、三方验收也拿它来对照。",
  },
  model: {
    name: "模型", kind: "循环的发动机", icon: CpuIcon, edit: "换模型", page: { id: "models", label: "去模型页" },
    what: () => "每一轮把现在的情况读一遍（目标、步骤、之前工具返回的结果），决定下一步调哪个工具；觉得办完了就调「收尾报结果」交结果。选了「拆给子 agent」时，拆出去的子 agent 用子 agent 模型。",
  },
  steps: {
    name: "步骤", kind: "参考路线", icon: ListOrderedIcon, edit: "编辑步骤",
    what: () => "写给 agent 的路线，它照着走，也可以变通。带检查点（⚑）的步骤做完要勾上、写结果，没勾的这次记没办成，跳过的要写理由、由复核判断；标「可以等待」的步骤可以挂起等回复。不写步骤就让 agent 自己探索。",
  },
  memory: {
    name: "记忆", kind: "带进提示词", icon: DatabaseIcon, edit: "改选的记忆", page: { id: "memory", label: "去记忆页" },
    what: () => "开工时写进提示词的背景知识，整次运行都看得到。手选的每次都带；开了自动挑选，运行开始时按这次要办的事从记忆库里再挑几条；任务记忆是这个任务自己攒下的经验，每次全部带上。",
  },
  skills: {
    name: "技能", kind: "按需翻的手册", icon: BookOpenIcon, edit: "改选的技能", page: { id: "skills", label: "去技能页" },
    what: () => "写好的操作手册。提示词里只放名字和一句简介，agent 要按某个技能做事时，用「读取技能」打开全文读，不占每一轮的篇幅。只有已发布的技能会给 agent。",
  },
  rules: {
    name: "规则", kind: "必须守的", icon: ShieldIcon, edit: "改选的规则", page: { id: "rules", label: "去规则页" },
    what: () => "人写的硬规定，主管确认过「系统理解为」才生效。由系统在对应的时候执行（调某个工具前后、花费超了、agent 说做完了……），拦下、问人、截图都由系统做，agent 绕不过；生效的规则也写进提示词让它知道。标「三方验收」的，agent 说做完时交给另一家的模型逐条核对。",
  },
  attach: {
    name: "附件", kind: "带进提示词", icon: PaperclipIcon,
    what: (task) => `每次运行都带上的文件。提示词里只列文件名，agent 用自带工具「读附件」打开读。${task.dispatch ? "" : "只想这一次带的，用「⋯ → 带附件运行」。"}`,
  },
  tools: {
    name: "工具", kind: "能伸出去的手", icon: WrenchIcon, edit: "改选的工具", page: { id: "tools", label: "去工具页" },
    what: () => "agent 每一轮只能从这里挑工具来调，没列出来的碰不到。标「自带」的每个任务都有；有的工具会自动带上别的（例如选了技能自动带「读取技能」）。",
  },
  routine: {
    name: "固化流程", kind: "现成的做法", icon: ZapIcon, edit: "改选的流程", page: { id: "routines", label: "去流程页" },
    what: () => "以前办成过的做法存成的脚本，快，也省钱。任务自己的固化流程打开「先跑流程」后，运行先跑脚本，跑不通交给 agent 接着做；从流程库选的流程当工具给 agent，调一次跑完一整段。",
  },
  deliver: {
    name: "交付物", kind: "终点", icon: PackageIcon, edit: "改交付物",
    what: () => "这次运行要交出来的东西。agent 结束时要逐项交齐，在总结里写明每一样在哪；存成文件的在这次运行的空间里，会话页能看、能下载。被派的活还要用「报结果」把「交回」的几项交回派活单，必填的没交，这张单记没办成。",
  },
  review: {
    name: "验收和复核", kind: "办成没有", icon: CircleCheckIcon, edit: "换模型",
    what: () => "运行结束后，另一个模型对照目标、交付物、检查点和证据，判「办成」还是「没办成」，原因写在会话里。选了「交给三方验收」规则的，agent 说做完时先由另一家的模型逐条核对，通过的直接算办成、不再复核。",
  },
}

/** 屏幕至少多宽（matchMedia）。和抽屉加宽用同一个断点（lg = 1024px） */
function useMinWidth(px: number) {
  const query = `(min-width: ${px}px)`
  return React.useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query)
      mql.addEventListener("change", onChange)
      return () => mql.removeEventListener("change", onChange)
    },
    () => window.matchMedia(query).matches
  )
}

const Muted = ({ children }: { children: React.ReactNode }) => <span className="text-muted-foreground">{children}</span>

/** 每一块上的一句话摘要：数量、名字；没选的写灰字，结构图上每一块都一直在 */
function useSummaries(task: TaskDef, state: TasksState): Record<StructureBlock, React.ReactNode> {
  const { modelName } = useModels()
  const toolName = useToolName()
  const tools = useToolsQuery().data?.tools ?? []
  const alwaysOn = alwaysOnToolIds(tools)
  const skills = useSkillsQuery().data ?? []
  const rules = named(useRulesQuery().data ?? [], task.ruleIds)
  const todos = (useBoardQuery().data?.humanTodos ?? []).filter((todo) => todo.taskId === task.id)
  const taskMemory = useQuery(trpc.taskMemory.list.queryOptions({ taskId: task.id })).data ?? []
  const attachments = useQuery(trpc.engine.taskAttachments.queryOptions({ taskId: task.id })).data
  const ownRoutine = useQuery(trpc.routine.get.queryOptions({ taskId: task.id })).data
  const library = useRoutineLibraryQuery().data
  const explored = state.runsOf(task.id)[0]?.exploredSteps

  const join = (parts: (string | false | undefined | null)[]) => parts.filter(Boolean).join(" · ")
  const names = (list: string[], max = 2) => (list.length > max ? `${list.slice(0, max).join("、")} 等 ${list.length} 个` : list.join("、"))

  const chosenTools = task.toolIds.filter((id) => !isRoutineToolId(id) && !alwaysOn.includes(id))
  const libraryTitles = task.toolIds.filter(isRoutineToolId).map((id) => library?.find((entry) => entry.toolId === id)?.title ?? toolName(id))
  const routineNames = [ownRoutine ? `${ownRoutine.name}${ownRoutine.mode === "first" ? "" : "（没开）"}` : "", ...libraryTitles].filter(Boolean)
  const verifyCount = rules.filter(ruleVerifies).length
  const results = resultsText(task)
  const memoryText = join([task.memoryIds.length > 0 && `手选 ${task.memoryIds.length} 条`, task.autoMemory && `自动挑 ≤${task.autoMemoryLimit}`, taskMemory.length > 0 && `任务记忆 ${taskMemory.length} 条`])

  return {
    trigger: join([task.schedule?.text, todos.length > 0 && `人加的待办 ${todos.length} 条`, task.dispatch && "被派活", "手动"]),
    goal: task.goal,
    model: modelName(task.modelId),
    steps: task.steps.length ? (
      <span className="flex flex-col gap-1">
        {task.steps.slice(0, 4).map((step, index) => (
          <span key={step.id} className="flex gap-2">
            <Muted>{index + 1}</Muted>
            <span className="line-clamp-1 min-w-0 flex-1">{step.text}</span>
            {step.checkpoint && <FlagIcon className="size-3 shrink-0 text-muted-foreground" aria-label="有检查点" />}
          </span>
        ))}
        {task.steps.length > 4 && <Muted>还有 {task.steps.length - 4} 步</Muted>}
      </span>
    ) : <Muted>没写，agent 自己探索{explored ? `（最近一次走了 ${explored.length} 步）` : ""}</Muted>,
    memory: memoryText || <Muted>没选</Muted>,
    skills: task.skillIds.length ? names(named(skills, task.skillIds).map((skill) => skill.name)) || `${task.skillIds.length} 份` : <Muted>没选</Muted>,
    rules: rules.length ? join([`${rules.length} 条`, verifyCount > 0 && `${verifyCount} 条三方验收`]) : <Muted>没选</Muted>,
    attach: attachments === undefined ? <Muted>…</Muted> : attachments.length ? `${attachments.length} 个` : <Muted>没有</Muted>,
    tools: (
      <span className="flex flex-wrap gap-1">
        {chosenTools.slice(0, 4).map((id) => <Badge key={id} variant="outline">{toolName(id)}</Badge>)}
        {chosenTools.length > 4 && <Badge variant="ghost">+{chosenTools.length - 4}</Badge>}
        {alwaysOn.length > 0 && <Badge variant="ghost">{chosenTools.length ? `+${alwaysOn.length} 自带` : `只有自带的 ${alwaysOn.length} 个`}</Badge>}
      </span>
    ),
    routine: routineNames.length ? names(routineNames) : <Muted>没有</Muted>,
    deliver: task.deliverables.length || results || task.toolIds.includes(WORK_DISPATCH_TOOL_ID) ? (
      <span className="flex flex-col gap-1">
        {task.deliverables.slice(0, 3).map((each, index) => <span key={`${index}-${each.name}`} className="line-clamp-1 text-foreground">{each.name}</span>)}
        {task.deliverables.length > 3 && <Muted>还有 {task.deliverables.length - 3} 项</Muted>}
        {task.deliverables.length === 0 && <Muted>没写交付物</Muted>}
        {results && <Muted>交回：{results}</Muted>}
        {task.toolIds.includes(WORK_DISPATCH_TOOL_ID) && <Muted>会派活出去</Muted>}
      </span>
    ) : <Muted>没写交付物</Muted>,
    review: join([verifyCount > 0 && "三方验收", `复核 · ${task.reviewModelId ? modelName(task.reviewModelId) : "默认复核模型"}`]),
  }
}

/** 图上的一块：键盘能点（Item 渲染成 button），选中的描主色边 */
function Block({ id, selected, onSelect, summary, className, emphasis = false }: {
  id: StructureBlock
  selected: StructureBlock
  onSelect: (id: StructureBlock) => void
  summary: React.ReactNode
  className?: string
  /** 目标、交付物：起点和终点，标题写成「目标 · 起点」，摘要用正文色 */
  emphasis?: boolean
}) {
  const info = INFO[id]
  const Icon = info.icon
  const active = selected === id
  return (
    <Item
      variant="outline"
      size="sm"
      render={<button type="button" aria-pressed={active} onClick={() => onSelect(id)} />}
      className={cn("items-start bg-card text-left hover:bg-muted", active && "border-primary bg-primary/10 hover:bg-primary/10", className)}
    >
      <ItemContent className="min-w-0">
        <ItemTitle className={emphasis ? "font-normal text-muted-foreground" : undefined}>
          <Icon className="size-3.5" />
          {emphasis ? `${info.name} · ${info.kind}` : info.name}
        </ItemTitle>
        <ItemDescription className={cn("line-clamp-none", emphasis && "text-sm/relaxed text-foreground")}>
          {summary}
        </ItemDescription>
      </ItemContent>
    </Item>
  )
}

/** 图里的小标题（「带进提示词 · …」） */
const GroupLabel = ({ children }: { children: React.ReactNode }) => <span className="text-muted-foreground">{children}</span>

/** 竖线：实线连开工 / 复核，虚线连循环和两组扩展 */
const VLine = ({ dashed = false }: { dashed?: boolean }) => <div className={cn("mx-auto h-5 w-px", dashed ? "border-l border-dashed" : "bg-border")} aria-hidden />

export function TaskStructure({ task, state, canEdit }: { task: TaskDef; state: TasksState; canEdit: boolean }) {
  const wide = useMinWidth(1024)
  const phone = useIsMobile()
  const [selected, setSelected] = React.useState<StructureBlock>("goal")
  const [phoneOpen, setPhoneOpen] = React.useState(false)
  const [editing, setEditing] = React.useState(false)
  const summaries = useSummaries(task, state)
  const select = (id: StructureBlock) => {
    setSelected(id)
    if (phone) setPhoneOpen(true)
  }
  const block = (id: StructureBlock, className?: string) => <Block id={id} selected={selected} onSelect={select} summary={summaries[id]} className={className} emphasis={id === "goal" || id === "deliver"} />
  const detail = <BlockDetail block={selected} task={task} state={state} canEdit={canEdit} onEdit={() => setEditing(true)} />
  const dialog = canEdit && <TaskDialog key={editing ? "structure-edit" : "structure-closed"} open={editing} onOpenChange={setEditing} task={task} />

  const loopHeader = (
    <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
      <RefreshCwIcon className="size-3.5" />
      <span className="font-medium">agent 循环</span>
      <Muted>看情况 → 选工具 → 做 → 看结果，一轮一轮跑到办完</Muted>
    </span>
  )

  if (wide) {
    // 横着画：五列（开工 / 目标 / 交付物在两边，箭头，中间是循环和两组扩展），每行用同样宽的两边列对齐
    const side = "w-36 shrink-0 xl:w-44"
    const gap = "flex w-6 shrink-0 items-center justify-center"
    return (
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col justify-center overflow-y-auto p-6">
          <div className="flex items-end">
            <div className={side}>{block("trigger")}</div>
            <div className={gap} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <GroupLabel>带进提示词 · 开工时写进提示词，整次运行都看得到</GroupLabel>
              <div className="grid grid-cols-2 gap-2 xl:grid-cols-4">
                {block("memory")}
                {block("skills")}
                {block("rules")}
                {block("attach")}
              </div>
            </div>
            <div className={gap} />
            <div className={side} />
          </div>
          <div className="flex">
            <div className={side}><VLine /></div>
            <div className={gap} />
            <div className="flex-1"><VLine dashed /></div>
            <div className={gap} />
            <div className={side} />
          </div>
          <div className="flex items-stretch">
            {block("goal", side)}
            <div className={gap}><ArrowRightIcon className="size-4 text-muted-foreground" /></div>
            <div className="flex min-w-0 flex-1 flex-col gap-3 border border-dashed p-3">
              {loopHeader}
              <div className="flex gap-2">
                {block("model", "w-28 shrink-0")}
                {block("steps", "min-w-0 flex-1")}
              </div>
            </div>
            <div className={gap}><ArrowRightIcon className="size-4 text-muted-foreground" /></div>
            {block("deliver", side)}
          </div>
          <div className="flex">
            <div className={side} />
            <div className={gap} />
            <div className="flex-1"><VLine dashed /></div>
            <div className={gap} />
            <div className={side}><VLine /></div>
          </div>
          <div className="flex items-start">
            <div className={side} />
            <div className={gap} />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <div className="grid grid-cols-2 gap-2">
                {block("tools")}
                {block("routine")}
              </div>
              <GroupLabel>能伸出去的手 · 循环里每一轮从这里挑来用</GroupLabel>
            </div>
            <div className={gap} />
            <div className={side}>{block("review")}</div>
          </div>
        </div>
        <aside className="flex w-80 shrink-0 flex-col gap-3 overflow-y-auto border-l bg-muted/30 p-4 xl:w-96" aria-label="选中的那一块">
          <Muted>点左边任意一块，这里说明它</Muted>
          {detail}
        </aside>
        {dialog}
      </div>
    )
  }

  // 窄一些：竖着排（开工 → 目标 → 循环（三栏）→ 交付物 + 复核），详情在下面；手机宽度点了从底部弹出
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-0 overflow-y-auto p-4 *:shrink-0">
      <p className="pb-3 text-muted-foreground">点任意一块，{phone ? "会弹出" : "下面会"}说明它是什么、这个任务里怎么配的。</p>
      {block("trigger")}
      <VLine />
      {block("goal")}
      <VLine />
      <div className="flex flex-col gap-3 border border-dashed p-3">
        {loopHeader}
        <div className="grid gap-3 sm:grid-cols-3">
          <div className="flex flex-col gap-2">
            <GroupLabel>带进提示词</GroupLabel>
            {block("memory")}
            {block("skills")}
            {block("rules")}
            {block("attach")}
          </div>
          <div className="flex flex-col gap-2">
            <GroupLabel>发动机</GroupLabel>
            {block("model")}
            {block("steps")}
          </div>
          <div className="flex flex-col gap-2">
            <GroupLabel>能伸出去的手</GroupLabel>
            {block("tools")}
            {block("routine")}
          </div>
        </div>
      </div>
      <div className="flex justify-center py-1 text-muted-foreground" aria-hidden><ArrowDownIcon className="size-4" /></div>
      <div className="grid gap-3 sm:grid-cols-3">
        {block("deliver", "sm:col-span-2")}
        {block("review")}
      </div>
      {phone ? (
        <Sheet open={phoneOpen} onOpenChange={setPhoneOpen}>
          <SheetContent side="bottom" className="max-h-11/12">
            <SheetHeader className="sr-only">
              <SheetTitle>{INFO[selected].name}</SheetTitle>
              <SheetDescription>这一块是什么、这个任务里怎么配的</SheetDescription>
            </SheetHeader>
            <div className="min-h-0 overflow-y-auto p-4">{detail}</div>
          </SheetContent>
        </Sheet>
      ) : (
        <div className="mt-6 flex flex-col gap-2">
          <Muted>选中的那一块</Muted>
          <div className="border bg-muted/30 p-4">{detail}</div>
        </div>
      )}
      {dialog}
    </div>
  )
}

/** 详情：名字和角色、「它是什么」、「这个任务里」（直接用列表视图的区块）、改的入口 */
function BlockDetail({ block, task, state, canEdit, onEdit }: { block: StructureBlock; task: TaskDef; state: TasksState; canEdit: boolean; onEdit: () => void }) {
  const info = INFO[block]
  const Icon = info.icon
  const runs = state.runsOf(task.id)
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-2">
        <Icon className="size-4" />
        <h3 className="font-heading text-sm font-medium">{info.name}</h3>
        <Badge variant="outline">{info.kind}</Badge>
      </div>
      <div className="flex flex-col gap-1">
        <Muted>它是什么</Muted>
        <p className="leading-relaxed">{info.what(task)}</p>
      </div>
      <div className="flex flex-col gap-3">
        <Muted>这个任务里</Muted>
        <BlockConfig block={block} task={task} runs={runs} canEdit={canEdit} />
      </div>
      {(canEdit && info.edit) || info.page ? (
        <div className="flex flex-wrap gap-2">
          {canEdit && info.edit && <Button variant="outline" size="sm" onClick={onEdit}><PencilIcon data-icon="inline-start" />{info.edit}</Button>}
          {info.page && (
            <Button variant="ghost" size="sm" nativeButton={false} render={<a href={href(info.page.id)} />}>
              <ExternalLinkIcon data-icon="inline-start" />{info.page.label}
            </Button>
          )}
        </div>
      ) : null}
    </div>
  )
}

/** 「这个任务里」：每一块对应的配置，用列表视图同样的区块 */
function BlockConfig({ block, task, runs, canEdit }: { block: StructureBlock; task: TaskDef; runs: ReturnType<TasksState["runsOf"]>; canEdit: boolean }) {
  switch (block) {
    case "trigger":
      return (
        <>
          <TaskScheduleSection task={task} canEdit={canEdit} />
          {task.dispatch && <DispatchInSection task={task} />}
          <ConfigLine label="手动">{task.dispatch ? "抽屉底部的「派一张」：填好参数派一张单" : "抽屉底部的「立即运行」，或者「⋯ → 带附件运行」"}</ConfigLine>
        </>
      )
    case "goal":
      return (
        <>
          <p className="leading-relaxed whitespace-pre-line">{task.goal}</p>
          {task.dispatch && (
            <ConfigLine label="参数">
              {task.dispatch.params.length ? task.dispatch.params.map((param) => `${param.name}${param.required ? "（必填）" : ""}`).join("、") : "没有参数"} · 派活单带来，第一条消息里交给 agent
            </ConfigLine>
          )}
        </>
      )
    case "steps":
      return <StepsView task={task} latest={runs[0]} />
    case "model":
      return (
        <>
          <ModelBadge task={task} />
          <SubagentModelLine task={task} />
        </>
      )
    case "memory":
      return (
        <>
          <MemoryBadges task={task} />
          <ConfigLine label="自动挑">{task.autoMemory ? `开，最多 ${task.autoMemoryLimit} 条` : "关"}</ConfigLine>
          <TaskMemorySection task={task} runs={runs} canEdit={canEdit} />
        </>
      )
    case "skills":
      return <SkillBadges task={task} />
    case "rules":
      return <RuleBadges task={task} withVerify />
    case "attach":
      return <TaskAttachments task={task} canEdit={canEdit} />
    case "tools":
      return (
        <>
          <ToolBadges task={task} />
          {task.toolIds.includes(BROWSER_TOOL_ID) && <BrowserConfig task={task} />}
          {task.toolIds.includes(DESKTOP_TOOL_ID) && <DesktopConfig task={task} />}
        </>
      )
    case "routine":
      return <RoutineConfig task={task} canEdit={canEdit} />
    case "deliver":
      return (
        <>
          <DeliverablesView task={task} empty="没写交付物：按目标判断办成没有。" />
          {task.dispatch && <ConfigLine label="交回">{resultsText(task) || "不要求交回结果"}</ConfigLine>}
          {task.toolIds.includes(WORK_DISPATCH_TOOL_ID) && <DispatchOutSection task={task} />}
        </>
      )
    case "review":
      return <VerifyReviewLines task={task} />
  }
}


/** 固化流程：任务自己的（有才有那张卡；没有的写一句怎么来）+ 从流程库选的 */
function RoutineConfig({ task, canEdit }: { task: TaskDef; canEdit: boolean }) {
  const own = useQuery(trpc.routine.get.queryOptions({ taskId: task.id }))
  return (
    <>
      {own.isSuccess && !own.data && <ConfigLine label="自己的">还没有。办成的运行可以在运行详情里「固化成流程」；开了「办成后自动固化」的会自动写，人审核过才启用。</ConfigLine>}
      <TaskRoutineSection task={task} canEdit={canEdit} />
      <RoutineBadges task={task} />
    </>
  )
}
