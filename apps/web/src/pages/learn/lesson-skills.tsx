import { useState } from "react"
import { BookOpenIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { ItemGroup } from "@/components/ui/item"
import { href } from "@/lib/router"
import { findById, skills, tasks } from "./demo-data/prototype"

import { skillFullChars, skillScenarios, skillTaskId } from "./demo-data/lessons"
import { Code, Lesson, Step, TextLink } from "./parts"

const task = findById(tasks, skillTaskId)!
const catalog = skills.filter((skill) => task.skillIds.includes(skill.id))
const options = skillScenarios.map((item) => ({ id: item.id, label: item.label }))

export function SkillsLesson() {
  const [scenarioId, setScenarioId] = useState(skillScenarios[0].id)
  const scenario = skillScenarios.find((item) => item.id === scenarioId) ?? skillScenarios[0]
  const index = catalog.findIndex((item) => item.id === scenario.skillId)
  const skill = catalog[index]

  return (
    <Lesson
      title="技能：只看目录，用到才读全文"
      meta={`技能是操作手册，建任务时选几本。就像先看书的目录，需要哪章再翻到哪章，agent 的注意力留给真正的活。下面以 ${task.id}（${task.title}）为例。`}
      choice={{ label: "选一个常见情况", value: scenario.id, options, onChange: setScenarioId }}
    >
      <DetailSection title={`情况：${scenario.situation}`} description="运行开始时，agent 收到的技能就只有这几行目录">
        <Code
          icon={<BookOpenIcon />}
          title={`技能目录（${task.id} 选了 ${catalog.length} 本，每本一行）`}
          lines={catalog.map((item, i) => `- ${item.name}：${item.description}${i === index ? "   ← 这一句对得上" : ""}`)}
          highlight={index}
        />
      </DetailSection>

      <DetailSection title="接下来">
        <ItemGroup className="gap-1">
          <Step tone="run" title={`调用「读取技能」，翻开「${skill.name}」读全文`} text={`约 ${skillFullChars[skill.id]} 字，只用在这一次运行里`} />
          <Step tone="skip" title={`目录里其他 ${catalog.length - 1} 本，这次一个字也没读`} text={`没选的 ${skills.length - catalog.length} 本连目录都看不到`} />
          {skill.suggestion && (
            <Step
              tone="wait"
              title={`agent 提议改这本：${skill.suggestion.summary}`}
              text={
                <>
                  手册不会被 agent 直接改，提议进「会话」的「等人处理」等人审核。 <TextLink to={href("sessions", { status: "human", id: skill.id })}>看这件事 →</TextLink>
                </>
              }
            />
          )}
        </ItemGroup>
      </DetailSection>
    </Lesson>
  )
}
