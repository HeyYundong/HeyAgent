// 新建 / 编辑记忆：两个字段（内容、适用于）。「适用于」可以直接输入新的，输入后就多一个下拉选项。
import * as React from "react"

import { CreatableCombobox } from "@/components/shell/creatable-combobox"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription } from "@/components/ui/dialog"
import { DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Textarea } from "@/components/ui/textarea"
import type { MemoryRef } from "@heyagent/shared"

export type MemoryFormValues = Pick<MemoryRef, "content" | "appliesTo">

export function MemoryDialog({
  open,
  onOpenChange,
  memory,
  appliesToOptions,
  onCreateAppliesTo,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 不传就是新建 */
  memory?: MemoryRef
  /** 「适用于」已有的选项 */
  appliesToOptions: string[]
  /** 输入了新的「适用于」：页面记住它 */
  onCreateAppliesTo: (value: string) => void
  onSubmit: (values: MemoryFormValues) => void
}) {
  const [content, setContent] = React.useState(memory?.content ?? "")
  const [appliesTo, setAppliesTo] = React.useState(memory?.appliesTo ?? "")
  const [submitted, setSubmitted] = React.useState(false)
  const contentError = submitted && !content.trim() ? "请写下这条记忆" : undefined
  const appliesToError = submitted && !appliesTo.trim() ? "请选择或输入适用于哪里" : undefined

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (!content.trim() || !appliesTo.trim()) return
    onSubmit({ content: content.trim(), appliesTo: appliesTo.trim() })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{memory ? "编辑记忆" : "新建记忆"}</DialogTitle>
          <DialogDescription>保存后直接生效。建任务时选用了它，agent 每次运行开始时就会读到。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-invalid={!!contentError}>
              <FieldLabel htmlFor="memory-content">内容</FieldLabel>
              <Textarea
                id="memory-content"
                rows={3}
                value={content}
                onChange={(event) => setContent(event.target.value)}
                placeholder="例如：Nova Home 只要工厂，不要贸易商"
                aria-invalid={!!contentError}
              />
              <FieldDescription>一句话写清一条经验或偏好。订单、报价这类数据不要写进来。</FieldDescription>
              <FieldError>{contentError}</FieldError>
            </Field>
            <Field data-invalid={!!appliesToError}>
              <FieldLabel htmlFor="memory-applies-to">适用于</FieldLabel>
              <CreatableCombobox
                id="memory-applies-to"
                value={appliesTo}
                onValueChange={setAppliesTo}
                options={appliesToOptions}
                onCreate={onCreateAppliesTo}
                placeholder="选一个，或输入新的"
                aria-invalid={!!appliesToError}
              />
              <FieldDescription>
                写成「分类 · 对象」，例如「客户偏好 · Nova Home」；左边列表按「·」前面的分类分组。没有合适的就直接输入。
              </FieldDescription>
              <FieldError>{appliesToError}</FieldError>
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit">保存</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
