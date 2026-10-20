// 运行 / 派活单的「结果」徽章（docs/dev/run-outcome.md 第 8 节）：会话列表、运行详情、派活页、看板都用这一个。
// 按 ui-rules 第 4 节的映射，不加新颜色，图标和文字都不一样，不只靠颜色：
// 办成 outline + 勾、部分办成 secondary + 圆点、没办成 destructive + 叉、没核实 outline + 问号；还没结束写「—」。
// 有原因的，鼠标放上去（或键盘聚焦）用 Tooltip 显示原因。
import { CircleCheckIcon, CircleDotIcon, CircleHelpIcon, CircleXIcon } from "lucide-react"
import { runOutcomeLabel, type RunOutcome } from "@heyagent/shared"

import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const OUTCOME = {
  achieved: { variant: "outline", icon: CircleCheckIcon },
  partial: { variant: "secondary", icon: CircleDotIcon },
  not_achieved: { variant: "destructive", icon: CircleXIcon },
  unverified: { variant: "outline", icon: CircleHelpIcon },
} as const

/** 结果筛选的选项（会话页、派活页共用） */
export const OUTCOME_FILTERS: { value: RunOutcome; label: string }[] = (Object.keys(OUTCOME) as RunOutcome[]).map((value) => ({ value, label: runOutcomeLabel[value] }))

export function OutcomeBadge({ outcome, reason, className }: { outcome?: RunOutcome | null; reason?: string | null; className?: string }) {
  if (!outcome) return <span className="text-muted-foreground" aria-label="还没有结果">—</span>
  const { variant, icon: Icon } = OUTCOME[outcome]
  const badge = (
    <Badge variant={variant} className={className}>
      <Icon data-icon="inline-start" />
      {runOutcomeLabel[outcome]}
    </Badge>
  )
  if (!reason) return badge
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge variant={variant} className={className} tabIndex={0} aria-label={`${runOutcomeLabel[outcome]}：${reason}`} />}>
        <Icon data-icon="inline-start" />
        {runOutcomeLabel[outcome]}
      </TooltipTrigger>
      <TooltipContent className="whitespace-pre-line">{reason}</TooltipContent>
    </Tooltip>
  )
}
