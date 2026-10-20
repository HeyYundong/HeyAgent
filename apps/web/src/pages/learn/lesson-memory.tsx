import { useState } from "react"
import { BookmarkIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { ItemGroup } from "@/components/ui/item"
import { href } from "@/lib/router"
import { findById, memories, memoryStatusLabel, tasks } from "./demo-data/prototype"

import { memoryTaskIds } from "./demo-data/lessons"
import { Lesson, Step, TextLink } from "./parts"

export function MemoryLesson() {
  const [taskId, setTaskId] = useState(memoryTaskIds[0])
  const task = findById(tasks, taskId)!
  const picked = memories.filter((memory) => task.memoryIds.includes(memory.id))
  const readable = picked.filter((memory) => memory.status === "active")
  const options = memoryTaskIds.map((id) => ({ id, label: id }))

  return (
    <Lesson
      title="记忆：选了哪几条就读哪几条"
      meta="记忆是 agent 记住的事实和偏好。建任务时选几条，运行一开始就读入。没选的不会读，不会把别的客户的偏好混进来。"
      choice={{ label: "选一个任务", value: taskId, options, onChange: setTaskId }}
    >
      <DetailSection title={`${task.id} 选了 ${picked.length} 条，运行开始时读到 ${readable.length} 条`} description={task.title}>
        <ItemGroup className="gap-1">
          {picked.map((memory) => {
            const ok = memory.status === "active"
            return (
              <Step
                key={memory.id}
                tone={ok ? "pass" : "block"}
                icon={ok ? <BookmarkIcon /> : undefined}
                title={memory.content}
                text={ok ? memory.appliesTo : `${memory.appliesTo} · 还在待审核，选了也读不到，审核通过后下次运行才读得到`}
                badge={memoryStatusLabel[memory.status]}
              />
            )
          })}
        </ItemGroup>
      </DetailSection>

      <DetailSection title="新记忆从哪来">
        <p>
          其余 {memories.length - picked.length} 条这个任务没选，agent 一个字也看不到。运行中 agent 学到新东西，只能调「提议记忆」：「会话」的「等人处理」里多一件记忆审核，人通过后它才能被任务选用。来自网页、没核实的会标出来，提醒审核的人「可能不实」。{" "}
          <TextLink to={href("memory")}>去记忆页 →</TextLink>
        </p>
      </DetailSection>
    </Lesson>
  )
}
