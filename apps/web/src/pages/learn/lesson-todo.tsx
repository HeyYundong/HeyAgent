// 「会话的五个状态」一课（id 还叫 todo：各页「这是什么？」链接过来）。原来讲待办看板，看板去掉后按会话页的五个状态讲。
import { useState } from "react"
import { LogInIcon, LogOutIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { ItemGroup } from "@/components/ui/item"
import { href } from "@/lib/router"
import { boardCards, boardColumns, type BoardCard, type BoardColumn } from "./demo-data/prototype"

import { cardLine, columnLessons } from "./demo-data/lessons"
import { Lesson, Step, TextLink, Tiles } from "./parts"

const cards = boardCards()
const options = boardColumns.map((item) => ({ id: item.id, label: item.name }))
const tiles = boardColumns.map((item) => ({
  id: item.id,
  title: item.name,
  badge: String(cards.filter((card) => card.column === item.id && card.kind !== "todo").length),
  text: item.hint,
}))

/** 会话页的 ?status=（执行中是默认，不写） */
const STATUS_PARAM: Record<BoardColumn, string | undefined> = { running: undefined, needs_human: "human", waiting: "waiting", verifying: "verifying", done: "ended" }

/** 演示里的一条去哪看：人加的待办在任务详情「什么时候跑」里，其余在会话页对应的状态下 */
const linkOf = (card: BoardCard) => (card.kind === "todo" ? href("tasks", { id: card.todo.taskId }) : href("sessions", { status: STATUS_PARAM[card.column], id: card.id }))

export function TodoLesson() {
  const [columnId, setColumnId] = useState<BoardColumn>("waiting")
  const column = boardColumns.find((item) => item.id === columnId) ?? boardColumns[0]
  const lesson = columnLessons[column.id]
  // 人加的待办不是运行，不在会话页，只在讲「等待中」时提一句
  const inColumn = cards.filter((card) => card.column === column.id && card.kind !== "todo")
  const todos = column.id === "waiting" ? cards.filter((card) => card.kind === "todo") : []

  return (
    <Lesson
      title="会话：每次运行在哪个状态"
      meta="「会话」页按状态分五个标签：执行中、等人处理、等待中、验收中、已结束。每次运行一行，随状态换标签；要人办的事在「等人处理」里，点开就能处理。人加的待办（到点、等事件让 agent 去做）在任务详情的「什么时候跑」里。"
      choice={{ label: "选一个状态", value: column.id, options, onChange: setColumnId }}
    >
      <DetailSection
        title="五个状态，从左到右"
        description="一次运行常见的路线：执行中 ⇄ 等待中 → 验收中 → 已结束（写结果）；中途有要人办的事，运行换到「等人处理」，处理完接着跑"
      >
        <Tiles items={tiles} activeId={column.id} className="grid grid-cols-2 gap-1 sm:grid-cols-5" />
      </DetailSection>

      <DetailSection title={`「${column.name}」`}>
        <ItemGroup className="gap-1">
          <Step tone="run" icon={<LogInIcon />} title="怎么进来" text={lesson.comes} />
          <Step tone="run" icon={<LogOutIcon />} title="怎么出去" text={lesson.goes} />
          <span className="pt-2 text-xs text-muted-foreground">现在这个状态下的（共 {inColumn.length} 条）</span>
          {inColumn.slice(0, 3).map((card) => {
            const line = cardLine(card)
            return (
              <Step
                key={card.id}
                tone={card.kind === "human" ? "wait" : card.column === "done" ? "pass" : "run"}
                title={<TextLink to={linkOf(card)}>{line.title}</TextLink>}
                text={line.text}
                badge={line.badge}
              />
            )
          })}
          {inColumn.length > 3 && <span className="text-xs text-muted-foreground">还有 {inColumn.length - 3} 条，去「会话」页看</span>}
          {todos.length > 0 && (
            <span className="pt-2 text-xs text-muted-foreground">
              另有 {todos.length} 条人加的待办在等，比如「<TextLink to={linkOf(todos[0]!)}>{cardLine(todos[0]!).title}</TextLink>」：它们不是运行，在任务详情的「什么时候跑」里，到点后任务有挂起的 session 就继续它，没有就开始一次新的运行。
            </span>
          )}
        </ItemGroup>
      </DetailSection>
    </Lesson>
  )
}
