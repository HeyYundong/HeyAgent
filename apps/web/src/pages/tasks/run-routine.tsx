// 运行详情里和固化流程有关的几样（docs/dev/solidify.md 第 9 节、15.4 第 2 条）：
// - 头部一行：「按固化流程第 3 版跑：14 步 · 9 秒 · 没调执行模型」「固化流程第 3 版停在第 5 步（原因），agent 接着做完」「固化试跑（第 5 版第 2 轮）：…停在提交前」；
// - 「⋯ → 固化成流程」的弹窗（routine.compile）：一句话说明 + 「不试跑」勾选；只有已结束、办成的普通运行，负责人和主管能点。
import * as React from "react"
import { FlaskConicalIcon, WorkflowIcon } from "lucide-react"
import { isRunEnded, outcomeOf, type SessionSummary } from "@heyagent/shared"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldContent, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

import { routineRunText } from "./routine-parts"

/** 固化试跑的运行（不进会话列表、不复核、不算结果） */
export const isRoutineTest = (run: Pick<SessionSummary, "kind">) => run.kind === "routine_test"

/** 能「固化成流程」：已结束、办成的普通运行 */
export const canSolidify = (run: SessionSummary) => !isRoutineTest(run) && isRunEnded(run.status) && outcomeOf(run) === "achieved"

/** 头部的一行（放在 DetailPanel 的 meta 里，自己占一行）：跑过脚本的运行、固化试跑才有 */
export function RoutineRunLine({ run }: { run: SessionSummary }) {
  if (!run.routine) return null
  const test = run.routine.mode === "test"
  return (
    <span className="mt-1 flex flex-wrap items-center gap-1.5 text-foreground">
      <Badge variant={test ? "secondary" : "outline"}>
        {test ? <FlaskConicalIcon data-icon="inline-start" /> : <WorkflowIcon data-icon="inline-start" />}
        {test ? "试跑" : "流程"}
      </Badge>
      {routineRunText(run.routine, run.id, isRunEnded(run.status))}
    </span>
  )
}

/** 「固化成流程」：固化员读这次运行的过程写成脚本，试跑到第一次提交前，好了在「等人处理」里叫人审核 */
export function SolidifyDialog({ run, open, onOpenChange }: { run: SessionSummary; open: boolean; onOpenChange: (open: boolean) => void }) {
  const [skipTest, setSkipTest] = React.useState(false)
  const repair = run.routine?.state === "fell_back"
  const compile = useAction(trpc.routine.compile.mutationOptions(), {
    success: (_data, vars) => (vars.skipTest ? "开始固化：写好会在「等人处理」里叫你审核" : "开始固化：写好、试跑完会在「等人处理」里叫你审核"),
    errorTitle: "没能开始固化",
  })
  const start = async () => {
    if (await compile.submit({ sessionId: run.id, skipTest })) onOpenChange(false)
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{repair ? `按 ${run.id} 重新固化` : `把 ${run.id} 固化成流程`}</DialogTitle>
          <DialogDescription>
            {repair
              ? "这次脚本停下后 agent 接着办成了。固化员对照 agent 的做法修一版新脚本，试跑到第一次提交前停下，好了在「等人处理」里叫你审核；启用前还是用现在的版本。"
              : "固化员读这次运行的过程，写成脚本和步骤说明，试跑到第一次提交前停下，好了在「等人处理」里叫你审核。启用以后，这个任务的运行先照脚本做，不调执行模型。"}
          </DialogDescription>
        </DialogHeader>
        <Field orientation="horizontal">
          <Checkbox id={`solidify-skip-${run.id}`} checked={skipTest} onCheckedChange={(on) => setSkipTest(Boolean(on))} />
          <FieldContent>
            <FieldLabel htmlFor={`solidify-skip-${run.id}`} className="font-normal">不试跑（填表就会自动存草稿的网站选这个）</FieldLabel>
            {skipTest && <FieldDescription>写好、程序检查过了直接交给你审核；没真跑过，启用后头几次运行要多看看。</FieldDescription>}
          </FieldContent>
        </Field>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>取消</DialogClose>
          <Button disabled={compile.isPending} onClick={() => void start()}>
            {compile.isPending ? <Spinner data-icon="inline-start" /> : <WorkflowIcon data-icon="inline-start" />}开始固化
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
