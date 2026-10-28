// 新建 / 编辑规则：名称、触发条件（一两句话）、命中后怎么办、提到的工具（可多选，可不选）。表单：React Hook Form + shared 的 ruleInputSchema。
// M3：保存后接着翻译（rules.compile），在同一个弹窗里显示「系统理解为……」，人点「确认生效」（rules.confirm）才生效；
// 翻译不进去的显示原因，可以回去改文字再试。改了文字时旧版本继续执行，直到新文字翻译并确认。
// 流程库（docs/dev/routine-library.md 9.4）：「提到的工具」里也列库里的流程（工具 id routine.<短名>），标「流程」。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { ArrowLeftIcon, CircleSlashIcon, HistoryIcon, LanguagesIcon, ShieldCheckIcon } from "lucide-react"
import { isRoutineToolId, ruleInputSchema, toolSourceLabel, type RuleCompileResult, type RuleInput, type RuleRef } from "@heyagent/shared"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent } from "@/components/ui/combobox"
import { ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxValue, useComboboxAnchor } from "@/components/ui/combobox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { useRoutineLibraryQuery, useToolName, useToolsQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { compileOf, useCompileActions } from "./compile"

interface RuleDialogProps {
  /** 不传就是新建 */
  rule?: RuleRef
  onClose: () => void
}

/** edit：填表；compiling：保存好了，正在翻译；result：显示翻译结果，等确认 */
type Stage = { step: "edit" } | { step: "compiling"; id: string } | { step: "result"; id: string; result: RuleCompileResult }

export function RuleDialog({ rule, onClose }: RuleDialogProps) {
  const name = useToolName()
  // 库流程不在工具页：从流程库取（撤下的没有工具，不列），名字后面标「流程」
  const routines = (useRoutineLibraryQuery().data ?? []).filter((entry) => entry.status !== "withdrawn")
  const toolIds = [...(useToolsQuery().data?.tools ?? []).filter((tool) => tool.source !== "routine" && !isRoutineToolId(tool.id)).map((tool) => tool.id), ...routines.map((entry) => entry.toolId)]
  const toolName = (id: string) => (isRoutineToolId(id) ? `${name(id)}（${toolSourceLabel.routine}）` : name(id))
  const anchor = useComboboxAnchor()
  const form = useForm<RuleInput>({
    resolver: zodResolver(ruleInputSchema),
    defaultValues: { name: rule?.name ?? "", trigger: rule?.trigger ?? "", action: rule?.action ?? "", toolIds: rule?.toolIds ?? [] },
  })
  const { errors } = form.formState
  // 新建后再回来改文字，就是改这条刚建好的规则
  const [savedId, setSavedId] = React.useState(rule?.id)
  const [stage, setStage] = React.useState<Stage>({ step: "edit" })
  const create = useAction(trpc.rules.create.mutationOptions())
  const update = useAction(trpc.rules.update.mutationOptions())
  const { compile, confirm } = useCompileActions({ quiet: true })
  const pending = create.isPending || update.isPending
  const wasEffective = rule ? compileOf(rule).effective : false

  async function translate(id: string) {
    setStage({ step: "compiling", id })
    const result = await compile.submit({ id })
    // 没翻译成（例如没设「规划」模型）：规则已经存好了，toast 说了原因，回规则页可以再点「翻译」
    if (!result) {
      onClose()
      return
    }
    setStage({ step: "result", id, result })
  }

  const submit = form.handleSubmit(async (values) => {
    const textChanged = !rule || values.trigger.trim() !== rule.trigger || values.action.trim() !== rule.action
    if (savedId) {
      const saved = await update.submit({ ...values, id: savedId })
      if (!saved) return
      // 只改了名字或工具、文字没变：翻译结果照旧，不用重新翻译
      if (!textChanged && rule && compileOf(rule).status === "active" && savedId === rule.id) {
        onClose()
        return
      }
      await translate(savedId)
      return
    }
    const created = await create.submit(values)
    if (!created) return
    setSavedId(created.id)
    navigate("rules", { id: created.id })
    await translate(created.id)
  })

  async function confirmRule(id: string) {
    if (await confirm.submit({ id })) onClose()
  }

  const title = stage.step === "edit" ? (rule ? "编辑规则" : "新建规则") : stage.step === "compiling" ? "正在翻译" : "系统理解为"

  return (
    <Dialog open onOpenChange={(open) => !open && stage.step !== "compiling" && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-lg">
        {stage.step === "edit" && (
          <form onSubmit={submit} className="flex flex-col gap-4">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                用大白话写清楚就行。保存后系统把它翻译成程序能执行的规则，你确认「系统理解为」之后才生效；建任务时选上它，那个任务才守这条规则。
              </DialogDescription>
            </DialogHeader>
            {wasEffective && (
              <Alert>
                <HistoryIcon />
                <AlertTitle>改了文字，旧版本继续执行</AlertTitle>
                <AlertDescription>新文字翻译并确认之前，选了这条规则的任务照旧版本办：{rule && compileOf(rule).enforced?.understood}</AlertDescription>
              </Alert>
            )}
            <FieldGroup>
              <Field data-invalid={!!errors.name}>
                <FieldLabel htmlFor="rule-name">名称</FieldLabel>
                <Input id="rule-name" placeholder="例如：对外发消息前由负责人确认" aria-invalid={!!errors.name} {...form.register("name")} />
                <FieldError errors={[errors.name]} />
              </Field>

              <Field data-invalid={!!errors.trigger}>
                <FieldLabel htmlFor="rule-trigger">触发条件</FieldLabel>
                <Textarea id="rule-trigger" rows={2} placeholder="例如：agent 要调用「通知员工」工具之前" aria-invalid={!!errors.trigger} {...form.register("trigger")} />
                <FieldDescription>一两句话：调用哪个工具之前 / 之后、打开不在白名单的网址、花费超过多少、agent 说做完了……写得越具体，翻译越准。</FieldDescription>
                <FieldError errors={[errors.trigger]} />
              </Field>

              <Field data-invalid={!!errors.action}>
                <FieldLabel htmlFor="rule-action">命中后怎么办</FieldLabel>
                <Textarea id="rule-action" rows={2} placeholder="例如：先拦下，交给任务负责人批准，批准了才执行" aria-invalid={!!errors.action} {...form.register("action")} />
                <FieldDescription>能做的：拦下、交给人审批、截图存证、通知某人、自动记录检查点、交给三方验收。</FieldDescription>
                <FieldError errors={[errors.action]} />
              </Field>

              <Field>
                <FieldLabel htmlFor="rule-tools">提到的工具（可选）</FieldLabel>
                <Controller
                  control={form.control}
                  name="toolIds"
                  render={({ field }) => (
                    <Combobox
                      multiple
                      items={toolIds}
                      value={field.value ?? []}
                      // Base UI 默认按 Esc 会清空全部已选，这里忽略，免得关下拉时把选好的工具丢掉
                      onValueChange={(next: string[], details) => details.reason !== "escape-key" && field.onChange(next)}
                      itemToStringLabel={toolName}
                    >
                      <ComboboxChips ref={anchor}>
                        <ComboboxValue>
                          {(values: string[]) => (
                            <>
                              {values.map((id) => (
                                <ComboboxChip key={id}>{toolName(id)}</ComboboxChip>
                              ))}
                              <ComboboxChipsInput id="rule-tools" placeholder={values.length === 0 ? "搜工具名，例如「通知」" : ""} />
                            </>
                          )}
                        </ComboboxValue>
                      </ComboboxChips>
                      <ComboboxContent anchor={anchor}>
                        <ComboboxEmpty>没有这个工具，先去「工具」页接入</ComboboxEmpty>
                        <ComboboxList>
                          {(id: string) => (
                            <ComboboxItem key={id} value={id}>
                              {toolName(id)}
                            </ComboboxItem>
                          )}
                        </ComboboxList>
                      </ComboboxContent>
                    </Combobox>
                  )}
                />
                <FieldDescription>触发条件或动作里提到的工具，选上能帮系统翻译得更准。不选也行。</FieldDescription>
              </Field>
            </FieldGroup>
            <DialogFooter>
              <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
              <Button type="submit" disabled={pending}>
                {pending ? <Spinner data-icon="inline-start" /> : <LanguagesIcon data-icon="inline-start" />}
                保存并翻译
              </Button>
            </DialogFooter>
          </form>
        )}

        {stage.step === "compiling" && (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>规则已保存。正在用「规划」模型把这句话翻译成程序能执行的规则，一般十几秒。</DialogDescription>
            </DialogHeader>
            <p className="flex items-center gap-2 text-sm text-muted-foreground"><Spinner />翻译中…</p>
          </>
        )}

        {stage.step === "result" && (
          <>
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>
                {stage.result.supported
                  ? "程序会照下面这句话执行，agent 绕不过。没问题就点「确认生效」；理解得不对，回去改文字再翻译。"
                  : "这条规则保存了，但现在不会生效，建任务时也选不了。"}
              </DialogDescription>
            </DialogHeader>
            {stage.result.supported ? (
              <Alert>
                <ShieldCheckIcon />
                <AlertTitle>系统理解为</AlertTitle>
                <AlertDescription className="text-sm text-foreground">{stage.result.understood}</AlertDescription>
              </Alert>
            ) : (
              <Alert variant="destructive">
                <CircleSlashIcon />
                <AlertTitle>未生效（v1 还不支持）</AlertTitle>
                <AlertDescription>
                  <p>{stage.result.reason ?? stage.result.understood}</p>
                  <p>系统不会退回让 agent 自己判断。可以改一下文字（例如写清楚是哪个工具、交给谁）再试。</p>
                </AlertDescription>
              </Alert>
            )}
            {wasEffective && stage.result.supported && (
              <p className="text-xs text-muted-foreground">确认之前，旧版本继续执行。</p>
            )}
            <DialogFooter>
              <Button type="button" variant="outline" disabled={confirm.isPending} onClick={() => setStage({ step: "edit" })}>
                <ArrowLeftIcon data-icon="inline-start" />改文字
              </Button>
              {stage.result.supported ? (
                <>
                  <DialogClose render={<Button type="button" variant="outline" disabled={confirm.isPending} />}>稍后再确认</DialogClose>
                  <Button type="button" disabled={confirm.isPending} onClick={() => void confirmRule(stage.id)}>
                    {confirm.isPending ? <Spinner data-icon="inline-start" /> : <ShieldCheckIcon data-icon="inline-start" />}确认生效
                  </Button>
                </>
              ) : (
                <DialogClose render={<Button type="button" />}>知道了</DialogClose>
              )}
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
