// 看懂架构：所有讲解和演示都在这一页。左边 11 条，右边一次只讲一件事。
import { GraduationCapIcon } from "lucide-react"

import { EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { href, useRoute } from "@/lib/router"

import { LESSON_ALIASES, LESSON_IDS, lessonGroups, type LessonId } from "./demo-data/lessons"
import { BrowsersLesson } from "./lesson-browsers"
import { CheckpointLesson } from "./lesson-checkpoint"
import { FlowLesson } from "./lesson-flow"
import { LoopLesson } from "./lesson-loop"
import { MemoryLesson } from "./lesson-memory"
import { ModelsLesson } from "./lesson-models"
import { RulesLesson } from "./lesson-rules"
import { SkillsLesson } from "./lesson-skills"
import { TaskLesson } from "./lesson-task"
import { TodoLesson } from "./lesson-todo"
import { ToolsLesson } from "./lesson-tools"

const LESSONS: Record<LessonId, () => React.ReactNode> = {
  loop: LoopLesson,
  task: TaskLesson,
  checkpoint: CheckpointLesson,
  todo: TodoLesson,
  memory: MemoryLesson,
  skills: SkillsLesson,
  rules: RulesLesson,
  tools: ToolsLesson,
  browsers: BrowsersLesson,
  models: ModelsLesson,
  flow: FlowLesson,
}

const toLessonId = (raw: string | null): LessonId | null =>
  LESSON_IDS.includes(raw as LessonId) ? (raw as LessonId) : (LESSON_ALIASES[raw ?? ""] ?? null)

export default function LearnPage() {
  const { params } = useRoute()
  const picked = toLessonId(params.get("id"))
  // 没选中时大屏默认讲「循环」；窄屏只显示列表
  const current = picked ?? "loop"
  const Lesson = LESSONS[current]

  return (
    <PageFrame
      queries={[]}
      header={<SimpleHeader title="看懂架构" description="HeyAgent 是怎么干活的。每条只讲一件事，从上往下看就行。" />}
      empty={<EmptyState icon={<GraduationCapIcon />} title="还没有讲解" description="讲解内容准备好之后会显示在这里。" />}
    >
      <MasterDetail
        hasSelection={picked !== null}
        list={lessonGroups.map((group) => (
          <PickGroup key={group.label} label={group.label}>
            {group.items.map((item) => (
              <PickItem key={item.id} to={href("learn", { id: item.id })} selected={item.id === current} title={item.title} description={item.hint} />
            ))}
          </PickGroup>
        ))}
        detail={<Lesson key={current} />}
      />
    </PageFrame>
  )
}
