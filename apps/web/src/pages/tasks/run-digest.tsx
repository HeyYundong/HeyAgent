// 运行结束后（完成或失败）的「总结和记忆」：让三方 AI（任务的验收模型，和执行模型不是同一家）读这次运行的全部过程，
// 写一段总结，再提取以后用得上的经验作为任务记忆的候选。候选由负责人或主管审核（可以先改字），通过的记进任务记忆（task-memory.tsx）。
import * as React from "react"
import { CircleCheckIcon, ClipboardCheckIcon, RotateCwIcon, SparklesIcon } from "lucide-react"
import { fmtDateTime, type DigestCandidateStatus, type SessionDigest, type SessionRun, type TaskDef } from "@heyagent/shared"

import { MarkdownView } from "@/components/markdown"
import { DetailSection } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useModels, useStaffName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

import { money } from "./parts"
import { pendingCandidates } from "./task-memory"

/** 待审核 / 已记入 / 没采用：不只靠颜色，文字和图标都不一样 */
function CandidateBadge({ status }: { status: DigestCandidateStatus }) {
  if (status === "accepted") return <Badge variant="outline"><CircleCheckIcon data-icon="inline-start" />已记入</Badge>
  if (status === "rejected") return <Badge variant="ghost">没采用</Badge>
  return <Badge>待审核</Badge>
}

export function RunDigestSection({ task, run, canEdit }: { task: TaskDef; run: SessionRun; canEdit: boolean }) {
  const { modelName, defaults } = useModels()
  const [reviewing, setReviewing] = React.useState(false)
  const [confirming, setConfirming] = React.useState(false)
  const summarize = useAction(
    trpc.taskMemory.summarize.mutationOptions({
      onSuccess: (digest) => {
        setConfirming(false)
        if (digest.candidates.length) setReviewing(true)
      },
    }),
    {
      success: (digest) => (digest.candidates.length ? `三方 AI 总结好了，提取出 ${digest.candidates.length} 条记忆，请审核` : "三方 AI 总结好了，没有提取出新的经验"),
      errorTitle: "没能总结",
    }
  )
  const digest = run.digest
  const pending = pendingCandidates(run)
  const start = () => summarize.mutate({ sessionId: run.id })
  const busy = summarize.isPending

  const action = canEdit && (
    <div className="flex items-center gap-2">
      {pending > 0 && !busy && (
        <Button size="sm" onClick={() => setReviewing(true)}><ClipboardCheckIcon data-icon="inline-start" />审核 {pending} 条</Button>
      )}
      <Button variant={digest ? "outline" : "default"} size="sm" disabled={busy} onClick={() => (pending > 0 ? setConfirming(true) : start())}>
        {busy ? <Spinner data-icon="inline-start" /> : digest ? <RotateCwIcon data-icon="inline-start" /> : <SparklesIcon data-icon="inline-start" />}
        {busy ? "正在总结…" : digest ? "重新总结" : "让三方 AI 总结"}
      </Button>
    </div>
  )

  return (
    <DetailSection
      title="总结和记忆"
      description="让三方 AI（任务的验收模型，和执行模型不是同一家）读这次运行的全部过程，写一段总结，再提取以后运行这个任务用得上的经验。提取出的只是候选，审核通过的才记进任务记忆。花费记在这次运行上。"
      action={action}
    >
      {busy ? (
        <p className="text-muted-foreground">三方 AI 正在读这次运行的过程，一般要十几秒到一分钟。</p>
      ) : !digest ? (
        <p className="text-muted-foreground">
          还没总结。{canEdit ? `会用 ${modelName(task.verifyModelId ?? defaults.verify)} 读这次运行的过程。` : "任务负责人可以让三方 AI 总结这次运行、提取经验。"}
        </p>
      ) : (
        <DigestView digest={digest} />
      )}
      {digest && (
        <DigestReviewDialog key={`${digest.at}-${reviewing}`} task={task} run={run} digest={digest} open={reviewing} onOpenChange={setReviewing} />
      )}
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>重新总结运行 {run.id}？</AlertDialogTitle>
            <AlertDialogDescription>还没审核的 {pending} 条候选会作废，换成新的总结和候选；会再调一次三方模型（花一点钱）。已经记进任务记忆的不受影响。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不</AlertDialogCancel>
            <AlertDialogAction disabled={busy} onClick={start}>重新总结</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSection>
  )
}

/** 三方 AI 的总结和提取出的记忆（每条的状态） */
function DigestView({ digest }: { digest: SessionDigest }) {
  const { modelName } = useModels()
  const staffName = useStaffName()
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted-foreground">
        三方 AI（{modelName(digest.modelId)}）· {staffName(digest.byId)} 点的 · {fmtDateTime(digest.at)} · 花费 {money(digest.costUsd)}
        {digest.reviewedAt && digest.reviewedById && ` · ${staffName(digest.reviewedById)} 审核于 ${fmtDateTime(digest.reviewedAt)}`}
      </p>
      <MarkdownView>{digest.summary}</MarkdownView>
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground">{digest.candidates.length ? `提取出的记忆（${digest.candidates.length}）` : "没有提取出新的经验。"}</span>
        {digest.candidates.length > 0 && (
          <ItemGroup className="gap-2">
            {digest.candidates.map((candidate, index) => (
              <Item key={index} variant="outline" size="xs">
                <ItemContent className="min-w-0">
                  <ItemTitle className="line-clamp-none whitespace-pre-line">{candidate.text}</ItemTitle>
                  <ItemDescription className="line-clamp-none">依据：{candidate.reason || "（没写）"}</ItemDescription>
                </ItemContent>
                <ItemActions><CandidateBadge status={candidate.status} /></ItemActions>
              </Item>
            ))}
          </ItemGroup>
        )}
      </div>
    </div>
  )
}

/** 审核候选：默认全勾上，可以改字；勾上的记进任务记忆，没勾的标为没采用 */
function DigestReviewDialog({ task, run, digest, open, onOpenChange }: { task: TaskDef; run: SessionRun; digest: SessionDigest; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [rows, setRows] = React.useState(() =>
    digest.candidates.flatMap((candidate, index) => (candidate.status === "pending" ? [{ index, accept: true, text: candidate.text, reason: candidate.reason }] : []))
  )
  const review = useAction(trpc.taskMemory.review.mutationOptions({ onSuccess: () => onOpenChange(false) }), {
    success: ({ accepted, rejected }) => (accepted ? `已记进任务记忆 ${accepted} 条${rejected ? `，${rejected} 条没采用` : ""}，下一次运行开始生效` : `${rejected} 条都没采用`),
    errorTitle: "没审核成",
  })
  const chosen = rows.filter((row) => row.accept).length
  const invalid = rows.some((row) => row.accept && !row.text.trim())
  const set = (index: number, patch: Partial<(typeof rows)[number]>) => setRows((list) => list.map((row) => (row.index === index ? { ...row, ...patch } : row)))
  const submit = () => review.mutate({ sessionId: run.id, items: rows.map((row) => ({ index: row.index, accept: row.accept, text: row.text.trim() })) })
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>审核运行 {run.id} 提取的记忆</DialogTitle>
          <DialogDescription>
            勾上的记进任务 {task.id} 的记忆（可以先改字），以后每次运行都会交给 agent；没勾的标为没采用。网页里可能藏着写给 AI 的话，看着像指令、来路不明的别勾。
          </DialogDescription>
        </DialogHeader>
        {rows.length === 0 ? (
          <p className="text-muted-foreground">没有等审核的候选了。</p>
        ) : (
          <FieldGroup className="max-h-96 gap-4 overflow-y-auto">
            {rows.map((row, position) => (
              <Field key={row.index} orientation="horizontal" data-invalid={row.accept && !row.text.trim()}>
                <Checkbox id={`digest-${run.id}-${row.index}`} checked={row.accept} onCheckedChange={(checked) => set(row.index, { accept: Boolean(checked) })} />
                <FieldContent>
                  <FieldLabel htmlFor={`digest-${run.id}-${row.index}`}>记下第 {position + 1} 条</FieldLabel>
                  <Textarea rows={2} value={row.text} disabled={!row.accept} aria-label={`第 ${position + 1} 条的内容`} aria-invalid={row.accept && !row.text.trim()} onChange={(event) => set(row.index, { text: event.target.value })} />
                  <FieldDescription>依据：{row.reason || "（没写）"}</FieldDescription>
                  {row.accept && !row.text.trim() && <FieldError>要记的那条不能是空的，不要就取消勾选</FieldError>}
                </FieldContent>
              </Field>
            ))}
          </FieldGroup>
        )}
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>以后再审</DialogClose>
          <Button disabled={rows.length === 0 || invalid || review.isPending} onClick={submit}>
            {review.isPending && <Spinner data-icon="inline-start" />}
            {chosen ? `记进任务记忆（${chosen} 条）` : "都不采用"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
