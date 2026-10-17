import { CirclePauseIcon, ExternalLinkIcon, HandIcon, ShuffleIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { ItemGroup } from "@/components/ui/item"

import { flowLesson } from "./demo-data/lessons"
import { Lesson, Step } from "./parts"

export function FlowLesson() {
  return (
    <Lesson
      title={flowLesson.title}
      meta={flowLesson.meta}
    >
      <DetailSection title="动画里重点看三件事">
        <ItemGroup className="gap-1">
          <Step tone="run" icon={<ShuffleIcon />} title="流程不写死" text={flowLesson.points.flexible} />
          <Step tone="run" icon={<HandIcon />} title="规矩写死" text={flowLesson.points.rules} />
          <Step tone="run" icon={<CirclePauseIcon />} title="等的时候挂起" text={flowLesson.points.suspend} />
        </ItemGroup>
        <Button size="lg" className="mt-3" nativeButton={false} render={<a href="/flow/index.html" target="_blank" rel="noreferrer" />}>
          <ExternalLinkIcon data-icon="inline-start" />
          打开流程动画
        </Button>
      </DetailSection>
    </Lesson>
  )
}
