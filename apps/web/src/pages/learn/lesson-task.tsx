import { useState } from "react"
import { CalendarClockIcon, CircleCheckIcon, CirclePauseIcon, CirclePlayIcon, PlayIcon, ShieldIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { ItemGroup } from "@/components/ui/item"
import { href } from "@/lib/router"
import { findById, runStatusLabel, runsOfTask, tasks, triggerText, type RunEventKind, type SessionRun } from "./demo-data/prototype"

import { sessionTaskIds, type StepTone } from "./demo-data/lessons"
import { Lesson, Step, TextLink } from "./parts"

const tokens = (run: SessionRun) => `${((run.tokensIn + run.tokensOut) / 1000).toFixed(1)}k token`
const options = sessionTaskIds.map((id) => ({ id, label: findById(tasks, id)?.schedule ? `${id}（定时）` : id }))

type Row = { tone: StepTone; icon: React.ReactNode; title: string; text?: string; badge?: string; tools: number }
const rowOf: Partial<Record<RunEventKind, Omit<Row, "title" | "tools">>> = {
  plan: { tone: "run", icon: <PlayIcon /> },
  rule: { tone: "block", icon: <ShieldIcon />, badge: "规则拦下" },
  wait: { tone: "wait", icon: <CirclePauseIcon />, badge: "挂起" },
  resume: { tone: "pass", icon: <CirclePlayIcon />, badge: "同一个 session" },
  done: { tone: "pass", icon: <CircleCheckIcon />, badge: "已完成" },
}

/** 把一次运行的事件压成几行：开始 → 挂起 → 继续 → …… → 现在；中间调了几次工具写在上一行 */
function SessionTimeline({ run }: { run: SessionRun }) {
  const rows: Row[] = []
  for (const event of run.events) {
    const last = rows.at(-1)
    if (event.kind === "tool" && last) last.tools++
    const kind = rowOf[event.kind]
    if (kind) rows.push({ ...kind, title: `${event.at} ${event.title}`, text: event.detail, tools: 0 })
  }
  return (
    <ItemGroup className="gap-1">
      {rows.map((row, index) => {
        const text = [row.text, row.tools ? `接着调了 ${row.tools} 次工具` : ""].filter(Boolean).join(" · ")
        return <Step key={index} tone={row.tone} icon={row.icon} title={row.title} text={text || undefined} badge={row.badge} />
      })}
      {run.waiting && (
        <Step tone="skip" title={`现在挂起中：${run.waiting.what}`} text={`什么时候继续：${triggerText(run.waiting.trigger)}。到时候接着这个 session，不新开。`} />
      )}
    </ItemGroup>
  )
}

export function TaskLesson() {
  const [taskId, setTaskId] = useState(sessionTaskIds[0])
  const task = findById(tasks, taskId)!
  const taskRuns = runsOfTask(taskId)
  const run = taskRuns[0]

  return (
    <Lesson
      title="任务和 session：挂起后接着跑"
      meta="任务只是写好的要求。每运行一次是一个 session。要等商家回复、等人审批时，session 挂起：不占模型、不花钱；等到了，继续原来那个 session。"
      choice={{ label: "选一个任务", value: taskId, options, onChange: setTaskId }}
    >
      {task.schedule ? (
        <DetailSection
          title={`${task.id} ${task.schedule.text}运行一次`}
          description={`${task.title}。定时任务每触发一次，是一次新的运行（新的 session）。`}
        >
          <ItemGroup className="gap-1">
            {taskRuns.map((item) => (
              <Step
                key={item.id}
                tone={item.status === "done" ? "pass" : "run"}
                icon={<CalendarClockIcon />}
                title={<TextLink to={href("tasks", { id: task.id, run: item.id })}>{`${item.id} · ${item.startedAt} 触发`}</TextLink>}
                text={`一个独立的 session · ${tokens(item)}${item.verification ? ` · ${item.verification.headline}` : ""}`}
                badge={runStatusLabel[item.status]}
              />
            ))}
            <Step tone="skip" icon={<CalendarClockIcon />} title={`下一次：${task.nextRunAt}`} text="到点开一次新的运行，和前几天的互不相干" />
          </ItemGroup>
        </DetailSection>
      ) : (
        <DetailSection
          title={`${run.id}：从头到尾只有这一个 session`}
          description={`${task.title} · ${tokens(run)} · $${run.costUsd.toFixed(2)}`}
          action={<TextLink to={href("tasks", { id: task.id, run: run.id })}>看完整运行记录 →</TextLink>}
        >
          <SessionTimeline run={run} />
        </DetailSection>
      )}

      <DetailSection title={task.schedule ? "定时运行里也能挂起" : "为什么是挂起，而不是新开一个"}>
        <p>
          {task.schedule
            ? "某一天的运行要等，就挂起当天这个 session，等到了接着它跑；第二天到点，是另一次新的运行。"
            : "挂起时，看过的页面、发过的消息、勾过的检查点都原样留在 session 里，继续时不用从头再读一遍。"}
          待办看板上，每次运行是一张卡，在「执行中」和「等待中」之间来回移动，卡上写着在等什么。{" "}
          <TextLink to={href("learn", { id: "todo" })}>看待办看板 →</TextLink>
        </p>
      </DetailSection>
    </Lesson>
  )
}
