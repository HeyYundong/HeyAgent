import { useState } from "react"
import { ShieldIcon, ShieldOffIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { ItemGroup } from "@/components/ui/item"
import { href } from "@/lib/router"
import { findById, rules, tasks, toolName, type RuleRef } from "./demo-data/prototype"

import { ruleScenarios } from "./demo-data/lessons"
import { Lesson, Step, TextLink } from "./parts"

const options = ruleScenarios.map((item) => ({ id: item.id, label: item.label }))
const callsText = (rule: RuleRef) => (rule.toolIds.length ? `，会调用：${rule.toolIds.map(toolName).join("、")}` : "")

export function RulesLesson() {
  const [scenarioId, setScenarioId] = useState(ruleScenarios[0].id)
  const scenario = ruleScenarios.find((item) => item.id === scenarioId) ?? ruleScenarios[0]
  const task = findById(tasks, scenario.taskId)!
  const picked = rules.filter((rule) => task.ruleIds.includes(rule.id))
  const missing = findById(rules, scenario.missing)

  return (
    <Lesson
      title="规则：选上的才管用"
      meta="一条规则 = 名称 + 一句话写的触发条件和命中后怎么办。保存后系统把它翻译成程序能执行的规则，显示「系统理解为……」，主管确认后才生效；翻译不进去的不生效。规则没有全局开关，建任务时选上哪几条，这次运行就只受这几条管。命中了由代码执行，模型绕不过。"
      choice={{ label: "选一个情况", value: scenario.id, options, onChange: setScenarioId }}
    >
      <DetailSection
        title={`${task.id} 建任务时选了 ${picked.length} 条规则，命中 ${Object.keys(scenario.hits).length} 条`}
        description={`情况：${scenario.call}`}
      >
        <ItemGroup className="gap-1">
          {picked.map((rule) => {
            const hit = scenario.hits[rule.id]
            return (
              <Step
                key={rule.id}
                tone={hit ? "wait" : "skip"}
                icon={<ShieldIcon />}
                title={rule.name}
                text={hit ? `${rule.trigger} → ${hit}${callsText(rule)}` : `触发条件：${rule.trigger}`}
                badge={hit ? "命中" : "没命中"}
              />
            )
          })}
          {missing && (
            <Step tone="block" icon={<ShieldOffIcon />} title={`没选：${missing.name}`} text={`触发条件：${missing.trigger}。它本来能管这件事，但这个任务没选`} badge="没选" />
          )}
        </ItemGroup>
      </DetailSection>

      <DetailSection title="结果">
        <p>
          {scenario.result}{" "}
          {scenario.todoId && <TextLink to={href("sessions", { status: "human", id: scenario.todoId })}>看「等人处理」里这件事 →</TextLink>}
        </p>
      </DetailSection>
    </Lesson>
  )
}
