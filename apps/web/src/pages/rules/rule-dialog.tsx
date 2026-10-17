// 新建 / 编辑规则：名称、触发条件（一两句话）、命中后怎么办、会调用的工具（可多选，可不选）。
// 不需要指定「管哪个工具」：触发条件那句话里写清楚就行。
import * as React from "react"

import { Button } from "@/components/ui/button"
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent } from "@/components/ui/combobox"
import { ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxValue, useComboboxAnchor } from "@/components/ui/combobox"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { RuleRef } from "@heyagent/shared"

import { useToolName, useToolsQuery } from "@/lib/data"

interface RuleDialogProps {
  /** 不传就是新建 */
  rule?: RuleRef
  /** 校验通过后调用（M0 只读：页面传进来的是统一的只读提示） */
  onSave: () => void
  onClose: () => void
}

export function RuleDialog({ rule, onSave, onClose }: RuleDialogProps) {
  const toolName = useToolName()
  const TOOL_IDS = (useToolsQuery().data?.tools ?? []).map((tool) => tool.id)
  const [name, setName] = React.useState(rule?.name ?? "")
  const [trigger, setTrigger] = React.useState(rule?.trigger ?? "")
  const [action, setAction] = React.useState(rule?.action ?? "")
  const [toolIds, setToolIds] = React.useState<string[]>(rule?.toolIds ?? [])
  const [submitted, setSubmitted] = React.useState(false)
  const anchor = useComboboxAnchor()

  const problems = {
    name: !name.trim() ? "给规则起个名字，例如「改价前由主管确认」" : undefined,
    trigger: !trigger.trim() ? "写一句话：什么情况下这条规则起作用" : undefined,
    action: !action.trim() ? "写一句话：命中后 agent 该怎么做" : undefined,
  }
  const errors: Partial<typeof problems> = submitted ? problems : {}

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (Object.values(problems).some(Boolean)) return
    onSave()
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>{rule ? "编辑规则" : "新建规则"}</DialogTitle>
            <DialogDescription>
              用大白话写清楚就行。规则不会自动生效，建任务时选上它，那个任务才守这条规则。
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="rule-name">名称</FieldLabel>
              <Input
                id="rule-name"
                value={name}
                placeholder="例如：改价前由主管确认"
                aria-invalid={!!errors.name}
                onChange={(event) => setName(event.target.value)}
              />
              <FieldError>{errors.name}</FieldError>
            </Field>

            <Field data-invalid={!!errors.trigger}>
              <FieldLabel htmlFor="rule-trigger">触发条件</FieldLabel>
              <Textarea
                id="rule-trigger"
                rows={2}
                value={trigger}
                placeholder="例如：agent 要修改 Shopify 商品价格时"
                aria-invalid={!!errors.trigger}
                onChange={(event) => setTrigger(event.target.value)}
              />
              <FieldDescription>一两句话。agent 每走一步都会对照它，判断是不是该起作用了。</FieldDescription>
              <FieldError>{errors.trigger}</FieldError>
            </Field>

            <Field data-invalid={!!errors.action}>
              <FieldLabel htmlFor="rule-action">命中后怎么办</FieldLabel>
              <Textarea
                id="rule-action"
                rows={2}
                value={action}
                placeholder="例如：先拦下，把改价原因和新旧价格交给运营主管批准"
                aria-invalid={!!errors.action}
                onChange={(event) => setAction(event.target.value)}
              />
              <FieldError>{errors.action}</FieldError>
            </Field>

            <Field>
              <FieldLabel htmlFor="rule-tools">会调用的工具（可选）</FieldLabel>
              <Combobox
                multiple
                items={TOOL_IDS}
                value={toolIds}
                // Base UI 默认按 Esc 会清空全部已选，这里忽略，免得关下拉时把选好的工具丢掉
                onValueChange={(next: string[], details) => details.reason !== "escape-key" && setToolIds(next)}
                itemToStringLabel={toolName}
              >
                <ComboboxChips ref={anchor}>
                  <ComboboxValue>
                    {(values: string[]) => (
                      <>
                        {values.map((id) => (
                          <ComboboxChip key={id}>{toolName(id)}</ComboboxChip>
                        ))}
                        <ComboboxChipsInput
                          id="rule-tools"
                          placeholder={values.length === 0 ? "搜工具名，例如「截图」" : ""}
                        />
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
              <FieldDescription>命中后规则自己去调这些工具，例如截图、通知负责人。只拦下就不用选。</FieldDescription>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit">{rule ? "保存" : "新建规则"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
