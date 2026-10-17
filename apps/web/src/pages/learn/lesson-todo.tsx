import { useState } from "react"
import { LogInIcon, LogOutIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { ItemGroup } from "@/components/ui/item"
import { href } from "@/lib/router"
import { boardCards, boardColumns, type BoardColumn } from "./demo-data/prototype"

import { cardLine, columnLessons } from "./demo-data/lessons"
import { Lesson, Step, TextLink, Tiles } from "./parts"

const cards = boardCards()
const options = boardColumns.map((item) => ({ id: item.id, label: item.name }))
const tiles = boardColumns.map((item) => ({
  id: item.id,
  title: item.name,
  badge: String(cards.filter((card) => card.column === item.id).length),
  text: item.hint,
}))

export function TodoLesson() {
  const [columnId, setColumnId] = useState<BoardColumn>("waiting")
  const column = boardColumns.find((item) => item.id === columnId) ?? boardColumns[0]
  const lesson = columnLessons[column.id]
  const inColumn = cards.filter((card) => card.column === column.id)

  return (
    <Lesson
      title="待办看板：每次运行一张卡"
      meta="待办是一块看板，五列。每次运行是一张卡，随状态在列之间移动；每件要人办的事单独一张卡。人也能往里加一条：到点后任务有挂起的 session 就继续它，没有就开始一次新的运行。"
      choice={{ label: "选一列", value: column.id, options, onChange: setColumnId }}
    >
      <DetailSection
        title="五列，从左到右"
        description="一张运行卡常见的路线：执行中 ⇄ 等待中 → 验收中 → 已完成；中途要人办的事，另起一张卡放进「等人处理」"
      >
        <Tiles items={tiles} activeId={column.id} className="grid grid-cols-2 gap-1 sm:grid-cols-5" />
      </DetailSection>

      <DetailSection title={`「${column.name}」这一列`}>
        <ItemGroup className="gap-1">
          <Step tone="run" icon={<LogInIcon />} title="怎么进来" text={lesson.comes} />
          <Step tone="run" icon={<LogOutIcon />} title="怎么出去" text={lesson.goes} />
          <span className="pt-2 text-xs text-muted-foreground">现在这一列的卡（共 {inColumn.length} 张）</span>
          {inColumn.slice(0, 3).map((card) => {
            const line = cardLine(card)
            return (
              <Step
                key={card.id}
                tone={card.kind === "human" ? "wait" : card.column === "done" ? "pass" : "run"}
                title={<TextLink to={href("todos", { id: card.id })}>{line.title}</TextLink>}
                text={line.text}
                badge={line.badge}
              />
            )
          })}
          {inColumn.length > 3 && <span className="text-xs text-muted-foreground">还有 {inColumn.length - 3} 张，去待办里看</span>}
        </ItemGroup>
      </DetailSection>
    </Lesson>
  )
}
