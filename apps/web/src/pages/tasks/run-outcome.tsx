// 运行详情的「结果」区块（docs/dev/run-outcome.md 第 8 节）：结果徽章、原因、是谁定的，复核报告收在可以展开的 Collapsible 里。
// 负责人和主管能点「改结果」：Dialog 里 RadioGroup 选四种结果、Textarea 写理由（必填），调 sessions.setOutcome。
// 改结果只改结果列，不重开运行；被派来的运行，派活单的结果跟着改，单的状态不变（后端负责）。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { ChevronDownIcon, ChevronRightIcon, PencilIcon } from "lucide-react"
import {
  fmtDateTime,
  outcomeOf,
  outcomeReasonOf,
  runOutcomeByLabel,
  runOutcomeLabel,
  setOutcomeInputSchema,
  type ReviewVerdict,
  type RunOutcome,
  type RunReview,
  type SessionSummary,
  type SetOutcomeInput,
} from "@heyagent/shared"

import { OutcomeBadge } from "@/components/shell/outcome-badge"
import { DetailSection } from "@/components/shell/simple-page"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useModels } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

import { money } from "./parts"

const VERDICT: Record<ReviewVerdict, string> = { achieved: "办成", partial: "部分办成", not_achieved: "没办成", unsure: "说不准" }

/** 改结果时每种结果下面的一句话：只看任务目标要的东西拿没拿到 */
const OUTCOME_HINT: Record<RunOutcome, string> = {
  achieved: "任务目标要的东西都拿到了。",
  partial: "只拿到一部分。",
  not_achieved: "没拿到，确认「没有」也算没办成。",
  unverified: "说不准办没办成，先标出来。",
}
const OUTCOMES = Object.keys(OUTCOME_HINT) as RunOutcome[]

export function RunOutcomeSection({ run, canEdit }: { run: SessionSummary; canEdit: boolean }) {
  const [editing, setEditing] = React.useState(false)
  const outcome = outcomeOf(run)
  const reason = outcomeReasonOf(run)
  return (
    <DetailSection
      title={outcome ? `结果 · ${runOutcomeLabel[outcome]}` : "结果"}
      description="只看任务目标要的东西拿没拿到，不看 agent 多努力：要找的东西没找到（包括确认「没有」）就是没办成。agent 说办成了但没有依据（没设检查点、没有复核或者复核说不准）的记「没核实」。"
      action={canEdit && (
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          <PencilIcon data-icon="inline-start" />改结果
        </Button>
      )}
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <OutcomeBadge outcome={outcome} />
          {run.outcomeBy && <span className="text-muted-foreground">{runOutcomeByLabel[run.outcomeBy]}</span>}
        </div>
        {reason ? <p className="whitespace-pre-line wrap-break-word">{reason}</p> : <p className="text-muted-foreground">{outcome ? "没写原因。" : "这次运行还没有结果。"}</p>}
        {run.review && <ReviewReport review={run.review} />}
      </div>
      {canEdit && <SetOutcomeDialog key={`${run.id}-${editing}`} run={run} open={editing} onOpenChange={setEditing} />}
    </DetailSection>
  )
}

/** 复核报告：默认收起，一行写结论；展开看理由、模型、带没带截图、花费，复核出错时写原因 */
function ReviewReport({ review }: { review: RunReview }) {
  const { modelName } = useModels()
  const [open, setOpen] = React.useState(false)
  const headline = review.verdict ? `复核结论：${VERDICT[review.verdict]}` : "复核没跑成"
  const rows: [string, React.ReactNode][] = [
    ["结论", review.verdict ? VERDICT[review.verdict] : "没有（复核出错）"],
    ["理由", review.reason || "（没写）"],
    ["模型", modelName(review.modelId)],
    ["截图", review.screenshot ? "带了最后一张截图" : "没带截图"],
    ["花费", `${money(review.costUsd)} · 输入 ${review.tokensIn.toLocaleString("en-US")} / 输出 ${review.tokensOut.toLocaleString("en-US")} token`],
    ["时间", fmtDateTime(review.at)],
  ]
  if (review.error) rows.push(["出错", review.error])
  return (
    <Collapsible open={open} onOpenChange={setOpen} className="flex flex-col gap-2 border-t pt-3">
      <CollapsibleTrigger render={<Button variant="ghost" size="sm" className="self-start" />}>
        {open ? <ChevronDownIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
        {headline}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="flex flex-col gap-1.5 text-xs">
          {rows.map(([label, value]) => (
            <div key={label} className="flex flex-col gap-0.5 sm:flex-row sm:gap-4">
              <dt className="w-12 shrink-0 text-muted-foreground">{label}</dt>
              <dd className={label === "出错" ? "min-w-0 wrap-break-word text-destructive" : "min-w-0 whitespace-pre-line wrap-break-word"}>{value}</dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  )
}

function SetOutcomeDialog({ run, open, onOpenChange }: { run: SessionSummary; open: boolean; onOpenChange: (open: boolean) => void }) {
  const current = outcomeOf(run)
  const form = useForm<SetOutcomeInput>({
    resolver: zodResolver(setOutcomeInputSchema),
    defaultValues: { id: run.id, outcome: current ?? "achieved", reason: "" },
  })
  const { errors } = form.formState
  const save = useAction(trpc.sessions.setOutcome.mutationOptions(), {
    success: (_data, vars) => `${run.id} 的结果改成了「${runOutcomeLabel[vars.outcome]}」`,
    errorTitle: "结果没改成",
  })
  const submit = form.handleSubmit(async (values) => {
    if (await save.submit(values)) onOpenChange(false)
  })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>改 {run.id} 的结果</DialogTitle>
          <DialogDescription>
            只改结果，不重开运行；改动和理由记进过程记录。{run.workItemId ? `派活单 ${run.workItemId} 的结果跟着改，单的状态不变。` : ""}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Controller
              control={form.control}
              name="outcome"
              render={({ field }) => (
                <FieldSet data-invalid={!!errors.outcome}>
                  <FieldLegend variant="label">结果{current ? `（现在是「${runOutcomeLabel[current]}」）` : ""}</FieldLegend>
                  <RadioGroup value={field.value} onValueChange={(value) => field.onChange(value)} aria-invalid={!!errors.outcome}>
                    {OUTCOMES.map((value) => (
                      <Field key={value} orientation="horizontal">
                        <RadioGroupItem value={value} id={`outcome-${run.id}-${value}`} />
                        <FieldContent>
                          <FieldLabel htmlFor={`outcome-${run.id}-${value}`} className="font-normal">{runOutcomeLabel[value]}</FieldLabel>
                          <FieldDescription>{OUTCOME_HINT[value]}</FieldDescription>
                        </FieldContent>
                      </Field>
                    ))}
                  </RadioGroup>
                  <FieldError errors={[errors.outcome]} />
                </FieldSet>
              )}
            />
            <Field data-invalid={!!errors.reason}>
              <FieldLabel htmlFor={`outcome-reason-${run.id}`}>理由</FieldLabel>
              <Textarea id={`outcome-reason-${run.id}`} rows={3} placeholder="例如：看了产物，价格和链接都对" aria-invalid={!!errors.reason} {...form.register("reason")} />
              <FieldDescription>必填，最多 500 个字。别人看运行详情时能看到。</FieldDescription>
              <FieldError errors={[errors.reason]} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={save.isPending}>
              {save.isPending && <Spinner data-icon="inline-start" />}改结果
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
