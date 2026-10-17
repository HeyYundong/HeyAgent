import { Fragment } from "react"
import { ArrowRightIcon, RotateCcwIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { loopStages, type LoopStage } from "@heyagent/shared"

interface AgentLoopStripProps {
  /** 起作用的阶段，会高亮 */
  highlight: LoopStage[]
  /** 高亮阶段下面的说明，不填就用默认描述 */
  notes?: Partial<Record<LoopStage, string>>
  /** 高亮阶段旁的徽章文字，false 表示不显示 */
  badge?: string | false
  /** 竖排：放在窄的区域里（例如右边详情）时用，一步一行 */
  vertical?: boolean
}

const LOOP_NOTE = "「调工具后」会回到「调模型」，一直循环到模型不再需要工具，才进入「说做完了」（交给三方 AI 验收）。"

/** agent 循环示意：运行开始 → 调模型 → 调工具前 → 执行工具 → 调工具后 → 说做完了（名字取自 loopStages） */
export function AgentLoopStrip({ highlight, notes, badge = "本页", vertical = false }: AgentLoopStripProps) {
  if (vertical) {
    return (
      <div className="flex flex-col gap-2">
        <ItemGroup className="gap-1">
          {loopStages.map((stage, index) => {
            const active = highlight.includes(stage.id)
            return (
              <Item key={stage.id} size="xs" variant={active ? "outline" : "muted"}>
                <ItemMedia>
                  <Badge variant={active ? "default" : "outline"}>{index + 1}</Badge>
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{stage.name}</ItemTitle>
                  <ItemDescription>{(active && notes?.[stage.id]) || stage.description}</ItemDescription>
                </ItemContent>
                {active && badge && (
                  <ItemActions>
                    <Badge variant="secondary">{badge}</Badge>
                  </ItemActions>
                )}
              </Item>
            )
          })}
        </ItemGroup>
        <LoopNote />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-stretch gap-1">
        {loopStages.map((stage, index) => {
          const active = highlight.includes(stage.id)
          return (
            <Fragment key={stage.id}>
              {index > 0 && (
                <ArrowRightIcon className="size-4 shrink-0 self-center text-muted-foreground" />
              )}
              <Item
                size="xs"
                variant={active ? "outline" : "muted"}
                className="w-auto min-w-28 flex-1 items-start"
              >
                <ItemContent>
                  <ItemTitle>
                    {stage.name}
                    {active && badge && <Badge>{badge}</Badge>}
                  </ItemTitle>
                  <ItemDescription>
                    {(active && notes?.[stage.id]) || stage.description}
                  </ItemDescription>
                </ItemContent>
              </Item>
            </Fragment>
          )
        })}
      </div>
      <LoopNote />
    </div>
  )
}

function LoopNote() {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <RotateCcwIcon className="size-3.5 shrink-0" />
      {LOOP_NOTE}
    </p>
  )
}
