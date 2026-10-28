// 子 agent（docs/dev/sub-agents.md 11.1）：运行详情里的两个区块和几样小东西。
// - 父运行（拆过子 agent 的）：「子 agent · 3 / 4 结束」区块，每个子 agent 一行（编号和标题、目标第一行、花费和用时，右边状态），点了打开那个子运行的详情；
//   数据是 sessions.subagents，区块标题的数字、花费合计用父运行摘要上的 subagents。
// - 子运行：「子目标」区块（sessions.get 的 subGoal）：目标、输入、要交回的字段（交了的打勾）、给它读的文件。
// - meta 一行：子运行写「第 2 个子 agent · 父运行 R-12-3」，父运行的花费写「含子 agent」。
import type { ReactNode } from "react"
import { useQuery } from "@tanstack/react-query"
import { ChevronRightIcon, CircleCheckIcon, GitForkIcon } from "lucide-react"
import { duration, isSubagentQueueEvent, startText, subagentStateLabel, type SessionSummary, type SubagentGoalView, type SubagentRow } from "@heyagent/shared"

import { MarkdownView } from "@/components/markdown"
import { FileList } from "@/components/files"
import { OutcomeBadge } from "@/components/shell/outcome-badge"
import { DetailSection } from "@/components/shell/simple-page"
import { Badge } from "@/components/ui/badge"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Progress } from "@/components/ui/progress"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { href } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { money } from "./parts"
import { ParamsTable } from "./work-parts"

/** 子运行（父运行拆出来的） */
export const isSubRun = (run: Pick<SessionSummary, "kind">) => run.kind === "sub"

/** 排队中的子运行（等名额，「立即继续」会被后端拒绝，页面上不给这个按钮） */
export const isQueuedSubRun = (run: SessionSummary) => isSubRun(run) && run.status === "waiting" && isSubagentQueueEvent(eventOfTrigger(run))

const eventOfTrigger = (run: SessionSummary) => {
  const trigger = run.waiting?.trigger
  return trigger && "event" in trigger ? trigger.event : undefined
}

/** 父运行连同子 agent 的花费 */
export const familyCost = (run: Pick<SessionSummary, "costUsd" | "subagents">) => run.costUsd + (run.subagents?.costUsd ?? 0)

/** 「花费 $0.42（含子 agent $0.31）」；没拆过的就是「花费 $0.11」 */
export const costText = (run: Pick<SessionSummary, "costUsd" | "subagents">) =>
  run.subagents?.total ? `花费 ${money(familyCost(run))}（含子 agent ${money(run.subagents.costUsd)}）` : `花费 ${money(run.costUsd)}`

/** 子运行 meta 一行的开头：「第 2 个子 agent · 父运行 R-12-3」（父运行编号是链接） */
export function SubRunSource({ run }: { run: SessionSummary }) {
  return (
    <>
      <GitForkIcon className="size-3" />
      <span>{run.sub ? `第 ${run.sub.n} 个子 agent` : "子 agent"}</span>
      {run.parentSessionId && (
        <>
          <span>· 父运行</span>
          <a className="font-mono underline underline-offset-4" href={href("sessions", { id: run.parentSessionId })}>{run.parentSessionId}</a>
        </>
      )}
    </>
  )
}

// ---------- 父运行：子 agent 区块 ----------

const SECTION_HELP = "这次运行拆出去的子 agent，每个是一次单独的运行，做完把结果交回给这次运行。子 agent 不复核，结果是它们自报的。点一行看那个子 agent 的过程。"

/** 父运行详情的「子 agent」区块：拆过才有（摘要上有 subagents） */
export function SubagentsSection({ run }: { run: SessionSummary }) {
  const stats = run.subagents
  const active = Boolean(stats && stats.ended < stats.total)
  // 子运行变了不会推到 sessions.subagents：还有没结束的就每 5 秒取一次
  const list = useQuery(trpc.sessions.subagents.queryOptions({ parentId: run.id }, { enabled: Boolean(stats?.total), refetchInterval: active ? 5000 : false }))
  if (!stats?.total) return null
  return (
    <DetailSection
      title={`子 agent · ${stats.ended} / ${stats.total} 结束 · 花费 ${money(stats.costUsd)}`}
      description={SECTION_HELP}
      action={active && <Progress value={(stats.ended / stats.total) * 100} aria-label={`结束了 ${stats.ended} / ${stats.total} 个`} className="w-24" />}
    >
      {list.isPending ? (
        <div className="flex flex-col gap-2">
          {Array.from({ length: Math.min(stats.total, 4) }, (_, index) => <Skeleton key={index} className="h-12 w-full" />)}
        </div>
      ) : list.isError ? (
        <p className="text-muted-foreground">子 agent 列表没取到，稍后再试。</p>
      ) : list.data.length === 0 ? (
        <p className="text-muted-foreground">还没有子 agent。</p>
      ) : (
        <ItemGroup className="gap-2">
          {list.data.map((row) => <SubagentItem key={row.id} row={row} />)}
        </ItemGroup>
      )}
    </DetailSection>
  )
}

/** 一个子 agent：整行是链接（链接铺满这一行），结果徽章浮在链接上面，悬停能看原因 */
function SubagentItem({ row }: { row: SubagentRow }) {
  const goal = row.goal.split("\n").find((line) => line.trim())?.trim() ?? ""
  const time = row.state === "queued" ? undefined : row.endedAt ? `用时 ${duration(Date.parse(row.endedAt) - Date.parse(row.startedAt))}` : `${startText(row.startedAt)} 开始`
  return (
    <Item variant="outline" size="sm" className="relative">
      <ItemContent className="min-w-0">
        <ItemTitle className="w-full">
          <a href={href("sessions", { id: row.id })} className="shrink-0 font-mono after:absolute after:inset-0 hover:underline">{row.id}</a>
          <span className="truncate">{row.title}</span>
        </ItemTitle>
        <ItemDescription className="line-clamp-1" title={row.goal}>{goal}</ItemDescription>
        <ItemDescription className="tabular-nums">{[`花费 ${money(row.costUsd)}`, time].filter(Boolean).join(" · ")}</ItemDescription>
      </ItemContent>
      <ItemActions>
        <SubagentStateBadge row={row} />
        <ChevronRightIcon className="size-4 text-muted-foreground" />
      </ItemActions>
    </Item>
  )
}

/** 状态徽章：排队 outline；在跑 / 等资源 secondary + 转圈（等资源写在等什么）；等人处理 default；结束了是结果徽章 */
function SubagentStateBadge({ row }: { row: SubagentRow }) {
  if (row.state === "ended") return <OutcomeBadge outcome={row.outcome} reason={row.outcomeReason} className="relative z-10" />
  if (row.state === "queued") return <Badge variant="outline">{subagentStateLabel.queued}</Badge>
  if (row.state === "needs_human") return <Badge>{subagentStateLabel.needs_human}</Badge>
  const text = row.state === "waiting" ? (row.waitingWhat ?? subagentStateLabel.waiting) : subagentStateLabel.running
  return <Badge variant="secondary"><Spinner data-icon="inline-start" />{text}</Badge>
}

// ---------- 子运行：子目标区块 ----------

const GOAL_HELP = "父运行拆给这个子 agent 的事：目标、交给它的输入、要它用「交回结果」交的字段、给它读的文件（只读）。子 agent 看不到父运行的对话，只照这些做。"

/** 子运行详情的「子目标」区块（在检查点的位置）。goal 取到前是骨架屏 */
export function SubGoalSection({ goal, loading }: { goal?: SubagentGoalView; loading: boolean }) {
  return (
    <DetailSection title="子目标" description={GOAL_HELP}>
      {goal ? (
        <SubGoalView goal={goal} />
      ) : loading ? (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-2/3" />
        </div>
      ) : (
        <p className="text-muted-foreground">子目标没取到，稍后再试。</p>
      )}
    </DetailSection>
  )
}

const Label = ({ children }: { children: ReactNode }) => <p className="text-xs text-muted-foreground">{children}</p>

function SubGoalView({ goal }: { goal: SubagentGoalView }) {
  const inputs = Object.keys(goal.input).length
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <Label>目标</Label>
        <MarkdownView className="text-sm">{goal.goal}</MarkdownView>
      </div>
      <div className="flex flex-col gap-1">
        <Label>输入</Label>
        {inputs ? <ParamsTable declared={[]} values={goal.input} /> : <p className="text-muted-foreground">没给输入。</p>}
      </div>
      <div className="flex flex-col gap-1">
        <Label>要交回的字段</Label>
        {goal.results.length ? (
          <div className="flex flex-wrap gap-2">
            {goal.results.map((result) =>
              result.value === undefined ? (
                <Badge key={result.name} variant="ghost" title="还没交">{result.name}</Badge>
              ) : (
                <Badge key={result.name} variant="outline" className="max-w-full" title={`${result.name} = ${String(result.value)}`}>
                  <CircleCheckIcon data-icon="inline-start" />
                  <span className="truncate">{result.name} = {String(result.value)}</span>
                </Badge>
              )
            )}
          </div>
        ) : (
          <p className="text-muted-foreground">没要求交回字段，看它报的总结。</p>
        )}
      </div>
      {goal.files.length > 0 && (
        <div className="flex flex-col gap-1">
          <Label>给它读的文件</Label>
          <FileList files={goal.files} />
        </div>
      )}
    </div>
  )
}
