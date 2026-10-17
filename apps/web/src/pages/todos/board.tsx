// 看板：五列横排，列宽固定，放不下就横向滚动，可以按住鼠标左右拖动或用方向键平移。每张卡是一个链接（?id=），点开右侧 Sheet。
import type { ReactNode } from "react"
import { BanknoteIcon, CircleCheckIcon, PauseIcon, ShieldQuestionIcon, UserPenIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemFooter, ItemHeader, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { href } from "@/lib/router"
import { cn } from "@/lib/utils"
import { boardColumns, fmtShort, humanItemKindLabel, type BoardCard } from "@heyagent/shared"

import { useStaffName } from "@/lib/data"

import { isoShortTime, triggerHeadline, waitText } from "./sheets"
import { useDragScroll } from "./use-drag-scroll"

export type Card = BoardCard & { note?: string } // note：卡住它的事处理完（或手动继续）后，写「谁做了什么」（M1 接通写操作后由后端给）

const LANE = "flex w-64 shrink-0 grow flex-col gap-2" // 列宽固定；宽屏放得下时撑满，放不下不压缩

export function Board({ cards, userId }: { cards: Card[]; userId: string }) {
  const { ref, overflow, handlers } = useDragScroll<HTMLDivElement>()
  return (
    <div className="flex w-0 min-w-full flex-col gap-2">
      {overflow && <p className="text-xs text-muted-foreground">列放不下：按住左右拖动查看，也可以用 ← → 键</p>}
      {/* cursor-grab 是本页唯一的 cursor 类：只在看板溢出、可以拖动时出现，告诉人「这里能抓着推」 */}
      <div ref={ref} tabIndex={0} role="region" aria-label="待办看板，左右方向键平移" {...handlers} className={cn("-mx-4 scroll-fade-x overflow-x-auto px-4 pb-2 outline-none focus-visible:ring-1 focus-visible:ring-ring/50 md:-mx-6 md:px-6", overflow && "cursor-grab select-none active:cursor-grabbing")}>
        <div className="flex w-max min-w-full gap-3">
          {boardColumns.map((column) => {
            const laneCards = cards.filter((card) => card.column === column.id)
            return (
              <section key={column.id} aria-label={column.name} className={LANE}>
                <header className="flex flex-col gap-0.5 border-b pb-2">
                  <h2 className="flex items-center gap-2 font-heading text-sm font-medium">{column.name}<Badge variant={column.id === "needs_human" && laneCards.length > 0 ? "default" : "secondary"}>{laneCards.length}</Badge></h2>
                  <p className="text-xs text-muted-foreground">{column.hint}</p>
                </header>
                {laneCards.length === 0 && <p className="border border-dashed p-4 text-center text-xs text-muted-foreground">现在没有</p>}
                {laneCards.map((card) => <CardLink key={card.id} card={card} userId={userId} />)}
              </section>
            )
          })}
        </div>
      </div>
    </div>
  )
}

/** 一张卡：头部一行徽章，中间标题和说明，底部一行灰字 */
const Shell = ({ id, head, title, children, foot }: { id: string; head: ReactNode; title: string; children: ReactNode; foot?: ReactNode }) => (
  <Item variant="muted" size="sm" render={<a href={href("todos", { id })} data-board-card="" draggable={false} />}>
    <ItemHeader className="flex-wrap justify-start gap-1">{head}</ItemHeader>
    <ItemContent className="min-w-0"><ItemTitle className="line-clamp-2">{title}</ItemTitle>{children}</ItemContent>
    {foot && <ItemFooter className="text-muted-foreground">{foot}</ItemFooter>}
  </Item>
)

/** 卡上的一行：灰色标签在上、内容在下；或者图标 + 内容 */
const Line = ({ label, icon, children }: { label?: string; icon?: ReactNode; children: ReactNode }) => (
  <p className="text-xs/relaxed">
    {label && <span className="block text-muted-foreground">{label}</span>}{icon && <span className="mr-1.5 inline-flex align-middle text-muted-foreground">{icon}</span>}{children}
  </p>
)

function CardLink({ card, userId }: { card: Card; userId: string }) {
  const staffName = useStaffName()
  const who = (id: string) => (id === userId ? "你" : staffName(id))
  if (card.kind === "human") {
    const { item } = card
    const money = item.detail.pay && <Badge variant="destructive"><BanknoteIcon data-icon="inline-start" />涉及金钱</Badge>
    const head = <><Badge variant="outline">{humanItemKindLabel[item.kind]}</Badge>{money}</>
    return (
      <Shell id={card.id} title={item.title} head={head} foot={<><span>{item.taskId ?? "不属于任务"}</span><span>分给 {who(item.assigneeId)}</span></>}>
        <ItemDescription>{item.summary}</ItemDescription>
      </Shell>
    )
  }
  if (card.kind === "todo") {
    const { todo } = card
    const head = <><Badge variant="outline"><UserPenIcon data-icon="inline-start" />人加的</Badge><span className="text-muted-foreground">{todo.taskId}</span></>
    return (
      <Shell id={card.id} title={todo.title} head={head} foot={<span>{who(todo.createdById)}加的</span>}>
        {todo.trigger.kind === "cron" ? <Line label="下次：">{isoShortTime(todo.trigger.next)}</Line> : <Line label="什么时候：">{triggerHeadline(todo.trigger, todo.createdAt)}</Line>}
      </Shell>
    )
  }

  const { run, task, column, note } = card
  return (
    <Shell id={card.id} title={task.title} head={<span className="text-muted-foreground">{run.id} · {who(task.ownerId)}负责</span>}>
      {column === "running" && <Line icon={<Spinner className="size-3" />}>{!note ? `正在：${run.events.at(-1)?.title}` : run.status === "waiting" ? "已手动继续同一个 session" : "已处理，继续同一个 session"}</Line>}
      {column === "waiting" && run.waiting && <>
        <Line label="在等：">{run.waiting.what}</Line>
        <Line label="什么时候继续：">{waitText(run.waiting.trigger, run.waiting.since)}</Line>
        <Line icon={<PauseIcon className="size-3" />}><span className="text-muted-foreground">{fmtShort(run.waiting.since)} 挂起，到了继续同一个 session</span></Line>
      </>}
      {column === "verifying" && <Line icon={<ShieldQuestionIcon className="size-3" />}>{run.verification?.headline}</Line>}
      {column === "done" && <Line icon={<CircleCheckIcon className="size-3" />}>{note ? "验收通过（同意跳过）" : `${run.endedAt ? fmtShort(run.endedAt) : ""} 完成 · 验收通过`}</Line>}
      {note && <p className="text-xs/relaxed text-muted-foreground">{note}</p>}
    </Shell>
  )
}
