// 规则的翻译和确认（M3）：保存 → rules.compile 翻译成程序能执行的结构 → 显示「系统理解为……」→ 人确认（rules.confirm）才生效。
// 翻译不进去的标「未生效（v1 还不支持）」并写原因，建任务时选不了；绝不退回让模型运行时自己判断。
// 文字改过以后，旧版本继续执行，直到新文字翻译并确认（RuleRef.compile.outdated + enforced）。
import { CircleCheckIcon, CircleDashedIcon, CircleHelpIcon, CircleSlashIcon, HistoryIcon, LanguagesIcon, ShieldCheckIcon } from "lucide-react"
import { fmtDateTime, ruleCompileStatusLabel, type RuleCompileView, type RuleRef } from "@heyagent/shared"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"

import { useModels, useStaffName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

/** 老数据可能没有 compile（M3 之前的接口），按「未翻译」处理 */
const UNTRANSLATED: RuleCompileView = { status: "untranslated", effective: false }
export const compileOf = (rule: Pick<RuleRef, "compile">): RuleCompileView => rule.compile ?? UNTRANSLATED

/** 建任务时能不能选：有确认过的版本才行 */
export const ruleSelectable = (rule: Pick<RuleRef, "compile">) => compileOf(rule).effective

/** 为什么选不了 / 选了会怎样：建任务的下拉、任务详情里用 */
export function ruleHint(rule: Pick<RuleRef, "compile">): string | undefined {
  const compile = compileOf(rule)
  if (compile.effective) return compile.outdated ? `文字改过还没重新确认，运行时按旧版本执行：${compile.enforced?.understood ?? ""}` : undefined
  if (compile.status === "unsupported") return `未生效（v1 还不支持）：${compile.reason ?? compile.understood ?? "翻译不进去"}`
  if (compile.status === "pending") return "待确认：主管在「规则」页确认「系统理解为」之后才能选"
  return "还没翻译：主管在「规则」页翻译并确认之后才能选"
}

/** 规则的生效状态徽章。改过还没确认的写「按旧版本生效」 */
export function RuleStatusBadge({ rule }: { rule: Pick<RuleRef, "compile"> }) {
  const compile = compileOf(rule)
  if (compile.effective && compile.outdated) return <Badge variant="outline"><HistoryIcon data-icon="inline-start" />按旧版本生效</Badge>
  if (compile.status === "active") return <Badge variant="outline"><CircleCheckIcon data-icon="inline-start" />生效</Badge>
  if (compile.status === "pending") return <Badge><CircleHelpIcon data-icon="inline-start" />待确认</Badge>
  if (compile.status === "unsupported") return <Badge variant="destructive"><CircleSlashIcon data-icon="inline-start" />{ruleCompileStatusLabel.unsupported}</Badge>
  return <Badge variant="ghost"><CircleDashedIcon data-icon="inline-start" />未翻译</Badge>
}

/** 翻译 / 确认两个按钮的写操作。翻译要调「规划」模型，会花一点钱，只有主管能点。quiet：结果直接显示在弹窗里，翻译完不再弹 toast */
export function useCompileActions({ quiet = false }: { quiet?: boolean } = {}) {
  const compile = useAction(trpc.rules.compile.mutationOptions(), {
    success: (result) => (quiet ? undefined : result.supported ? "翻译好了，看一下「系统理解为」，没问题就点「确认生效」" : "翻译不进去：v1 还不支持这样的规则"),
    errorTitle: "没翻译成",
  })
  const confirm = useAction(trpc.rules.confirm.mutationOptions(), { success: "已确认，这条规则生效了。之后开始的运行按它执行" })
  return { compile, confirm, busy: compile.isPending || confirm.isPending }
}

/** 规则详情里的「系统理解为」：现在执行的是什么、新文字翻译成了什么、能不能确认 */
export function CompileBody({ rule, canManage }: { rule: RuleRef; canManage: boolean }) {
  const compile = compileOf(rule)
  const staffName = useStaffName()
  const { modelName } = useModels()
  const { compile: translate, confirm, busy } = useCompileActions()
  const translated = compile.status === "pending" || compile.status === "unsupported"
  const translateButton = (
    <Button variant={compile.status === "untranslated" ? "default" : "outline"} size="sm" disabled={busy} onClick={() => translate.mutate({ id: rule.id })}>
      {translate.isPending ? <Spinner data-icon="inline-start" /> : <LanguagesIcon data-icon="inline-start" />}
      {translated ? "重新翻译" : "翻译"}
    </Button>
  )
  const confirmButton = compile.status === "pending" && (
    <Button size="sm" disabled={busy} onClick={() => confirm.mutate({ id: rule.id })}>
      {confirm.isPending ? <Spinner data-icon="inline-start" /> : <ShieldCheckIcon data-icon="inline-start" />}确认生效
    </Button>
  )
  const by = compile.enforced?.confirmedById ? `${staffName(compile.enforced.confirmedById)} ` : ""
  const confirmedAt = compile.enforced?.confirmedAt ? `${fmtDateTime(compile.enforced.confirmedAt)} ` : ""

  return (
    <div className="flex flex-col gap-3">
      {compile.status === "active" && (
        <>
          <p className="text-base">{compile.understood}</p>
          <p className="text-xs text-muted-foreground">
            {by}{confirmedAt}确认{compile.modelId ? ` · 用 ${modelName(compile.modelId)} 翻译` : ""}。这句话由程序按翻译结果生成，程序照它执行，agent 绕不过。
          </p>
        </>
      )}

      {compile.effective && compile.outdated && (
        <Alert>
          <HistoryIcon />
          <AlertTitle>文字改过，现在仍按旧版本执行</AlertTitle>
          <AlertDescription>
            <p>正在执行：{compile.enforced?.understood}</p>
            <p>新文字翻译并确认之后才换成新的；在那之前，选了这条规则的任务照旧版本办。</p>
          </AlertDescription>
        </Alert>
      )}

      {compile.status === "pending" && (
        <div className="flex flex-col gap-1">
          <span className="text-muted-foreground">{compile.outdated ? "新文字系统理解为：" : "系统理解为："}</span>
          <p className="text-base">{compile.understood}</p>
          <p className="text-xs text-muted-foreground">
            {compile.translatedAt ? `${fmtDateTime(compile.translatedAt)} ` : ""}{compile.modelId ? `用 ${modelName(compile.modelId)} 翻译。` : ""}
            确认之后才生效、建任务时才能选上。理解得不对就改一下文字再翻译。
          </p>
        </div>
      )}

      {compile.status === "unsupported" && (
        <Alert variant="destructive">
          <CircleSlashIcon />
          <AlertTitle>{compile.outdated ? "新文字翻译不进去（v1 还不支持）" : "未生效（v1 还不支持）"}</AlertTitle>
          <AlertDescription>
            <p>{compile.reason ?? compile.understood}</p>
            <p>{compile.outdated ? "旧版本照常执行。" : "建任务时选不了这条规则，系统也不会让 agent 自己去判断。"}改一下文字（例如写清楚是哪个工具、交给谁），保存后再翻译。</p>
          </AlertDescription>
        </Alert>
      )}

      {compile.status === "untranslated" && (
        <p className="text-muted-foreground">
          {compile.outdated ? "新文字还没翻译。" : "还没翻译。"}翻译后这里显示「系统理解为……」，主管确认后才生效{compile.outdated ? "" : "、建任务时才能选上"}。
        </p>
      )}

      {canManage && compile.status !== "active" && (
        <div className="flex flex-wrap items-center gap-2">
          {confirmButton}
          {translateButton}
          {translate.isPending && <span className="text-xs text-muted-foreground">正在用「规划」模型翻译，一般十几秒…</span>}
        </div>
      )}
    </div>
  )
}
