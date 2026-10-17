import { useState } from "react"

import { AgentLoopStrip } from "@/components/shell/agent-loop-strip"
import { DetailSection } from "@/components/shell/simple-page"
import { href } from "@/lib/router"
import { loopStages } from "./demo-data/prototype"

import { loopParts, type LoopPart } from "./demo-data/lessons"
import { Lesson, TextLink } from "./parts"

export function LoopLesson() {
  const [partId, setPartId] = useState<LoopPart["id"]>(loopParts[0].id)
  const part = loopParts.find((item) => item.id === partId) ?? loopParts[0]
  const where = part.stages.map((id) => `「${loopStages.find((stage) => stage.id === id)?.name}」`).join("")
  const options = loopParts.map((item) => ({ id: item.id, label: item.name }))

  return (
    <Lesson
      title="一个 agent 怎么干活"
      meta="任务每运行一次，就开一个 session，跑下面这同一个循环。记忆、技能、规则、工具都是建任务时选的。一句话记住：流程不写死，规矩写死——每一步怎么做由 agent 决定，必须遵守的事写成规则，由代码执行。"
      choice={{ label: "选一样东西，看它在循环的哪一步起作用", value: part.id, options, onChange: setPartId }}
    >
      <DetailSection
        title={`${part.name}：在${where}起作用（带框的几步）`}
        description={
          <>
            {part.what} <TextLink to={href("learn", { id: part.lesson })}>细看 →</TextLink>
          </>
        }
      >
        <AgentLoopStrip vertical highlight={part.stages} notes={part.notes} badge={part.name} />
      </DetailSection>
    </Lesson>
  )
}
