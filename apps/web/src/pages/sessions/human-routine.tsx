// 「等人处理」里的「审核固化流程」（kind = routine，docs/dev/solidify.md 5.7、15.4 第 3 条）：内容用 routine.version 取。
// 步骤说明、要的输入和交回、试跑结果（最后一轮的每一步、停在哪、结果对比、停下时的截图）、会改东西的步骤、假设、脚本（收起）、修的版本和旧版的对比。
// 「启用」→ routine.review(approve)，进试用期；「不用」→ 写理由（必填，固化员下次看得到）→ routine.review(reject)。
// 运行办成后系统自动固化的版本（auto，第 17.1 节）加「自动固化」徽章。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { CheckIcon, EyeIcon, RotateCwIcon, TriangleAlertIcon, XIcon } from "lucide-react"
import { can, fmtShort, ROUTINE_TRIAL_RUNS, routineReviewInputSchema, routineVersionStatusLabel, type HumanItem } from "@heyagent/shared"

import { Alert, AlertAction, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { useModels, useStaffName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"
import { money } from "@/pages/tasks/parts"
import { AutoBadge, RoutineVersionView, VersionStatusBadge } from "@/pages/tasks/routine-parts"

import { TextLink, dots } from "./parts"

export function RoutineReviewPanel({ item, inRun = false, onDone }: { item: HumanItem; inRun?: boolean; onDone?: () => void }) {
  const { user } = useMe()
  const staffName = useStaffName()
  const { modelName } = useModels()
  const ref = item.detail.routine
  const query = useQuery(trpc.routine.version.queryOptions({ id: ref?.versionId ?? "" }, { enabled: Boolean(ref) }))
  const version = query.data
  const canAct = can(user, "humanItem.resolve", { assigneeId: item.assigneeId })
  const review = useAction(trpc.routine.review.mutationOptions({ onSuccess: () => onDone?.() }), {
    success: (result) =>
      result.status === "approved"
        ? `已启用第 ${version?.version ?? ref?.version} 版：先试用，接下来 ${ROUTINE_TRIAL_RUNS} 次运行每次都会通知你结果`
        : "已记下：这一版不用，理由固化员下次看得到",
    errorTitle: "没审核成功",
  })
  const open = version?.status === "review"
  return (
    <Card size="sm">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">等人处理 · 审核固化流程</Badge>
          {version && <VersionStatusBadge status={version.status} />}
          {version?.auto && <AutoBadge />}
        </div>
        <CardTitle>{item.title}</CardTitle>
        <CardDescription>
          {dots(
            !inRun && item.taskId && <TextLink to={href("tasks", { id: item.taskId })}>{item.taskId}</TextLink>,
            item.summary,
            `提出 ${fmtShort(item.createdAt)}`,
            `分给 ${item.assigneeId === user.id ? "你" : staffName(item.assigneeId)}`,
          )}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 text-sm">
        {!canAct && <Alert><EyeIcon /><AlertDescription>这件事分给了 {staffName(item.assigneeId)}，你只能查看。</AlertDescription></Alert>}
        {!ref ? (
          <Alert variant="destructive"><TriangleAlertIcon /><AlertTitle>没带固化流程的版本</AlertTitle><AlertDescription>这件事的内容不全，看不了也审不了。可以到任务详情的「固化流程 → 版本记录」里看。</AlertDescription></Alert>
        ) : query.isPending ? (
          <div className="flex flex-col gap-3">
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-32 w-full" />
          </div>
        ) : query.isError ? (
          <Alert variant="destructive">
            <TriangleAlertIcon />
            <AlertTitle>第 {ref.version} 版的内容没取到</AlertTitle>
            <AlertDescription>网络不稳定，稍后再试。</AlertDescription>
            <AlertAction><Button variant="outline" size="sm" onClick={() => void query.refetch()}><RotateCwIcon data-icon="inline-start" />重试</Button></AlertAction>
          </Alert>
        ) : (
          <>
            <p className="text-muted-foreground">
              {dots(
                query.data.sourceSessionId && <>从运行 <TextLink to={href("sessions", { id: query.data.sourceSessionId })}>{query.data.sourceSessionId}</TextLink> 固化</>,
                query.data.baseVersion !== null && `修的是第 ${query.data.baseVersion} 版`,
                query.data.auto ? "运行办成后系统自动固化" : query.data.createdBy && `${query.data.createdBy.name}点的`,
                query.data.modelId && `固化用 ${modelName(query.data.modelId)}，写了 ${query.data.round} 轮，花了 ${money(query.data.costUsd)}`,
              )}
            </p>
            {!open && (
              <Alert>
                <CheckIcon />
                <AlertTitle>这一版现在是「{routineVersionStatusLabel[query.data.status]}」</AlertTitle>
                <AlertDescription>{query.data.status === "approved" || query.data.status === "rejected" ? "已经审核过了，不用再处理。" : "还没写好、试跑完，好了再来审核。"}</AlertDescription>
              </Alert>
            )}
            <RoutineVersionView version={query.data} review />
          </>
        )}
      </CardContent>
      {canAct && open && version && (
        <CardFooter className="flex-wrap gap-2">
          <Button disabled={review.isPending} onClick={() => review.mutate({ versionId: version.id, approve: true })}>
            {review.isPending && review.variables?.approve ? <Spinner data-icon="inline-start" /> : <CheckIcon data-icon="inline-start" />}启用
          </Button>
          <RejectRoutineButton versionId={version.id} version={version.version} disabled={review.isPending} onReject={(reason) => review.submit({ versionId: version.id, approve: false, reason })} />
        </CardFooter>
      )}
    </Card>
  )
}

/** 「不用」：弹窗写理由（必填），提交成功才关 */
function RejectRoutineButton({ versionId, version, disabled, onReject }: { versionId: string; version: number; disabled: boolean; onReject: (reason: string) => Promise<unknown> }) {
  const [open, setOpen] = React.useState(false)
  // 和接口同一个 schema：不用的话理由必填（refine 报在 reason 上）
  const empty = { versionId, approve: false, reason: "" }
  const form = useForm({ resolver: zodResolver(routineReviewInputSchema), defaultValues: empty })
  const { errors, isSubmitting } = form.formState
  const submit = form.handleSubmit(async ({ reason }) => {
    if (await onReject((reason ?? "").trim())) setOpen(false)
  })
  return (
    <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) form.reset(empty) }}>
      <Button variant="outline" disabled={disabled} onClick={() => setOpen(true)}><XIcon data-icon="inline-start" />不用</Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>第 {version} 版不用？</DialogTitle>
          <DialogDescription>这一版记成「不用」，现在用的版本照旧。理由会交给固化员，下次固化时照着改。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <Field data-invalid={!!errors.reason}>
            <FieldLabel htmlFor={`routine-reject-${versionId}`}>理由</FieldLabel>
            <Textarea id={`routine-reject-${versionId}`} rows={3} placeholder="例如：日报要 Markdown，不要表格" aria-invalid={!!errors.reason} {...form.register("reason")} />
            <FieldDescription>必填，最多 1000 个字。</FieldDescription>
            <FieldError errors={[errors.reason]} />
          </Field>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" variant="destructive" disabled={isSubmitting}>
              {isSubmitting ? <Spinner data-icon="inline-start" /> : <XIcon data-icon="inline-start" />}不用这一版
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
