// 新建 / 编辑记忆：两个字段（内容、适用于）。「适用于」可以直接输入新的，输入后就多一个下拉选项。
// 表单：React Hook Form + shared 的 memoryInputSchema。
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm } from "react-hook-form"
import { memoryInputSchema, type MemoryInput, type MemoryRef } from "@heyagent/shared"

import { CreatableCombobox } from "@/components/shell/creatable-combobox"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription } from "@/components/ui/dialog"
import { DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

export function MemoryDialog({
  open,
  onOpenChange,
  memory,
  appliesToOptions,
  onCreateAppliesTo,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 不传就是新建 */
  memory?: MemoryRef
  /** 「适用于」已有的选项 */
  appliesToOptions: string[]
  /** 输入了新的「适用于」：页面记住它 */
  onCreateAppliesTo: (value: string) => void
}) {
  const form = useForm<MemoryInput>({
    resolver: zodResolver(memoryInputSchema),
    defaultValues: { content: memory?.content ?? "", appliesTo: memory?.appliesTo ?? "" },
  })
  const { errors } = form.formState
  const create = useAction(trpc.memories.create.mutationOptions(), { success: "记忆建好了，已经生效" })
  const update = useAction(trpc.memories.update.mutationOptions(), { success: "记忆已保存" })
  const pending = create.isPending || update.isPending

  const submit = form.handleSubmit(async (values) => {
    if (memory) {
      if (await update.submit({ ...values, id: memory.id })) onOpenChange(false)
      return
    }
    const created = await create.submit(values)
    if (created) {
      onOpenChange(false)
      navigate("memory", { id: created.id })
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{memory ? "编辑记忆" : "新建记忆"}</DialogTitle>
          <DialogDescription>保存后直接生效。建任务时选用了它，agent 每次运行开始时就会读到。</DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <Field data-invalid={!!errors.content}>
              <FieldLabel htmlFor="memory-content">内容</FieldLabel>
              <Textarea id="memory-content" rows={4} placeholder="例如：给这位客户的报价单要带含税价" aria-invalid={!!errors.content} {...form.register("content")} />
              <FieldDescription>一句话写清一条经验或偏好，可以用 Markdown。订单、报价这类数据不要写进来。</FieldDescription>
              <FieldError errors={[errors.content]} />
            </Field>
            <Field data-invalid={!!errors.appliesTo}>
              <FieldLabel htmlFor="memory-applies-to">适用于</FieldLabel>
              <Controller
                control={form.control}
                name="appliesTo"
                render={({ field }) => (
                  <CreatableCombobox
                    id="memory-applies-to"
                    value={field.value}
                    onValueChange={field.onChange}
                    options={appliesToOptions}
                    onCreate={onCreateAppliesTo}
                    placeholder="选一个，或输入新的"
                    aria-invalid={!!errors.appliesTo}
                  />
                )}
              />
              <FieldDescription>写成「分类 · 对象」，例如「客户偏好 · 某客户」；左边列表按「·」前面的分类分组。没有合适的就直接输入。</FieldDescription>
              <FieldError errors={[errors.appliesTo]} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
