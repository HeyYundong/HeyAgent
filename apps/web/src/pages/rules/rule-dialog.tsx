// 新建 / 编辑规则：名称、触发条件（一两句话）、命中后怎么办、会调用的工具（可多选，可不选）。
// 不需要指定「管哪个工具」：触发条件那句话里写清楚就行。表单：React Hook Form + shared 的 ruleInputSchema。
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { ruleInputSchema, type RuleInput, type RuleRef } from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent } from "@/components/ui/combobox"
import { ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxValue, useComboboxAnchor } from "@/components/ui/combobox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { useToolName, useToolsQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

interface RuleDialogProps {
  /** 不传就是新建 */
  rule?: RuleRef
  onClose: () => void
}

export function RuleDialog({ rule, onClose }: RuleDialogProps) {
  const toolName = useToolName()
  const toolIds = (useToolsQuery().data?.tools ?? []).map((tool) => tool.id)
  const anchor = useComboboxAnchor()
  const form = useForm<RuleInput>({
    resolver: zodResolver(ruleInputSchema),
    defaultValues: { name: rule?.name ?? "", trigger: rule?.trigger ?? "", action: rule?.action ?? "", toolIds: rule?.toolIds ?? [] },
  })
  const { errors } = form.formState
  const create = useAction(trpc.rules.create.mutationOptions(), { success: "规则建好了。建任务时选上它才生效" })
  const update = useAction(trpc.rules.update.mutationOptions(), { success: "规则已保存" })
  const pending = create.isPending || update.isPending

  const submit = form.handleSubmit(async (values) => {
    if (rule) {
      if (await update.submit({ ...values, id: rule.id })) onClose()
      return
    }
    const created = await create.submit(values)
    if (created) {
      onClose()
      navigate("rules", { id: created.id })
    }
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{rule ? "编辑规则" : "新建规则"}</DialogTitle>
            <DialogDescription>用大白话写清楚就行。规则不会自动生效，建任务时选上它，那个任务才守这条规则。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="rule-name">名称</FieldLabel>
              <Input id="rule-name" placeholder="例如：改价前由主管确认" aria-invalid={!!errors.name} {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>

            <Field data-invalid={!!errors.trigger}>
              <FieldLabel htmlFor="rule-trigger">触发条件</FieldLabel>
              <Textarea id="rule-trigger" rows={2} placeholder="例如：agent 要修改商品价格时" aria-invalid={!!errors.trigger} {...form.register("trigger")} />
              <FieldDescription>一两句话。agent 每走一步都会对照它，判断是不是该起作用了。</FieldDescription>
              <FieldError errors={[errors.trigger]} />
            </Field>

            <Field data-invalid={!!errors.action}>
              <FieldLabel htmlFor="rule-action">命中后怎么办</FieldLabel>
              <Textarea id="rule-action" rows={2} placeholder="例如：先拦下，把改价原因和新旧价格交给运营主管批准" aria-invalid={!!errors.action} {...form.register("action")} />
              <FieldError errors={[errors.action]} />
            </Field>

            <Field>
              <FieldLabel htmlFor="rule-tools">会调用的工具（可选）</FieldLabel>
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
                            <ComboboxChipsInput id="rule-tools" placeholder={values.length === 0 ? "搜工具名，例如「截图」" : ""} />
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
              <FieldDescription>命中后规则自己去调这些工具，例如截图、通知负责人。只拦下就不用选。</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {rule ? "保存" : "新建规则"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
