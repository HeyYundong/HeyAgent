import { useState } from "react"
import { BotIcon, CompassIcon, ScaleIcon, TargetIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { Badge } from "@/components/ui/badge"
import { ItemGroup } from "@/components/ui/item"
import { recognizeCheckpoints } from "@heyagent/shared"
import { href } from "@/lib/router"
import { checkpointKindLabel, findById, humanItems, latestRun, modelDefaults, modelName, tasks, type RunCheckpoint } from "./demo-data/prototype"

import { checkpointTaskIds, type StepTone } from "./demo-data/lessons"
import { Lesson, Step, TextLink } from "./parts"

const toneOf: Record<RunCheckpoint["status"], StepTone> = { done: "pass", open: "skip", skipped: "block" }
const statusText: Record<RunCheckpoint["status"], string> = { done: "已勾", open: "未完成", skipped: "跳过" }
const options = checkpointTaskIds.map((id) => ({ id, label: findById(tasks, id)?.steps.length ? id : `${id}（没写步骤）` }))

/** 检查点输入框右边实时显示的那句：「访问 · 目标 3」 */
const recognized = (text: string) =>
  recognizeCheckpoints(text)
    .map((item) => `${checkpointKindLabel[item.kind]}${item.target ? ` · 目标 ${item.target}` : ""}`)
    .join("；")

function recordText(cp: RunCheckpoint) {
  if (cp.status === "skipped") return `跳过理由：${cp.skipReason}`
  if (cp.records.length === 0) return "还没有记录"
  const first = cp.records[0]
  const more = cp.records.length > 1 ? ` 等 ${cp.records.length} 条` : ""
  return `${first.synced ? "规则自动记下" : "agent 自己写"}：${first.text}${more}`
}

export function CheckpointLesson() {
  const [taskId, setTaskId] = useState(checkpointTaskIds[0])
  const task = findById(tasks, taskId)!
  const run = latestRun(taskId)!
  const open = run.checkpoints.filter((cp) => cp.status !== "done").length
  const verifyCard = humanItems.find((item) => item.kind === "verify" && item.runId === run.id)

  return (
    <Lesson
      title="步骤、检查点和三方验收"
      meta="新建任务时写一行任务、几个步骤（可以不写）和一个目标。每个步骤可以勾「等待」和「检查点」；检查点就是验收清单，最后由另一家的模型逐条核对。"
      choice={{ label: "选一个任务", value: taskId, options, onChange: setTaskId }}
    >
      <div className="grid items-start gap-4 lg:grid-cols-2">
        <DetailSection title="新建任务时这样写" description={`任务：${task.title}`}>
          <ItemGroup className="gap-1">
            {task.steps.map((step, index) => (
              <Step
                key={step.id}
                tone="run"
                icon={<Badge variant="outline">{index + 1}</Badge>}
                title={step.text}
                text={step.checkpoint && `检查点：${step.checkpoint} → 认出「${recognized(step.checkpoint)}」`}
                badge={step.wait ? "可以等待" : undefined}
              />
            ))}
            {task.steps.length === 0 && (
              <>
                <Step tone="skip" icon={<CompassIcon />} title="没写步骤：agent 自己探索" text="探索出的步骤记在运行记录里，主管可以存为任务步骤" />
                {run.exploredSteps?.map((text, index) => (
                  <Step key={text} tone="run" icon={<Badge variant="outline">{index + 1}</Badge>} title={text} text="agent 探索出的步骤" />
                ))}
              </>
            )}
            <Step tone="run" icon={<TargetIcon />} title={`目标：${task.goal}`} />
          </ItemGroup>
        </DetailSection>

        <DetailSection title={`${run.id} 的检查点`} description="agent 自己打勾；打开网页、发出消息这类记录由规则自动记下">
          <ItemGroup className="gap-1">
            {run.checkpoints.map((cp) => (
              <Step
                key={cp.title}
                tone={toneOf[cp.status]}
                title={cp.target ? `${cp.title}（${cp.progress ?? 0}/${cp.target}）` : cp.title}
                text={recordText(cp)}
                badge={statusText[cp.status]}
              />
            ))}
          </ItemGroup>
        </DetailSection>
      </div>

      <DetailSection
        title="三方 AI 验收"
        description={`执行用 ${modelName(run.modelId)}，验收用 ${modelName(modelDefaults.verify)}：不许同一家，不会自己说自己好`}
        action={verifyCard && <TextLink to={href("sessions", { status: "human", id: verifyCard.id })}>「等人处理」里的验收争议 →</TextLink>}
      >
        {run.verification ? (
          <ItemGroup className="gap-1">
            {run.verification.notes.map((note, index) => {
              const verifier = note.by === "verifier"
              const icon = verifier ? <ScaleIcon /> : <BotIcon />
              return <Step key={index} tone={verifier ? "wait" : "run"} icon={icon} title={note.text} badge={verifier ? "三方 AI" : "执行的 agent"} />
            })}
          </ItemGroup>
        ) : (
          <p>
            这次运行还没说做完（{run.waiting?.what ?? "还在跑"}），所以没到验收。到时三方 AI 会逐条核对：现在还有 {open} 条没完成，它会反问
            agent 为什么，agent 要么补做，要么说明理由。说做完了时检查点还有没勾的、或者有跳过的（三方验收通过的除外），结果记「没办成」。
          </p>
        )}
      </DetailSection>
      <DetailSection
        title="结束以后：结果"
        description="状态只管流程（已结束、出错），办没办成看结果，只有办成、没办成两种。只看目标要的东西拿没拿到：要找的东西没找到、确认「没有」、只拿到一部分，都是没办成。"
      >
        <ItemGroup className="gap-1">
          {OUTCOME_STEPS.map((step) => <Step key={step.badge} tone={step.tone} title={step.title} badge={step.badge} />)}
        </ItemGroup>
        <p className="mt-3 text-muted-foreground">
          agent 结束时用「报结果」报办成还是没办成，并写依据；只拿到一部分的报没办成，原因里写清拿到了什么、缺什么。每个任务都要选复核模型：agent 说办成了，结束后便宜的 AI 一定复核一遍（三方验收通过的除外），复核也判办成才算办成，复核结束前结果写「复核中」。负责人觉得不对，可以在运行详情或会话列表里「改结果」（出错、取消的运行也能改），要写理由。
        </p>
      </DetailSection>
    </Lesson>
  )
}

/** 两种结果什么时候出现（docs/dev/run-outcome.md 2.1 节，2026-10-20 简化成两种） */
const OUTCOME_STEPS: { tone: StepTone; title: string; badge: string }[] = [
  { tone: "pass", title: "三方验收通过；或者 agent 报办成、硬规则都过了、AI 复核也判办成", badge: "办成" },
  { tone: "block", title: "agent 报没办成（包括只拿到一部分）；检查点有没达成或有跳过的；缺必交的结果；复核判没办成、证据不足、复核出错；运行出错或被取消", badge: "没办成" },
]
