// 新建 / 编辑技能：名称、岗位、什么时候用、用到的工具、操作手册（SKILL.md 正文，Markdown）。「岗位」可以直接输入新的。
// 表单：React Hook Form + shared 的 skillInputSchema。每次保存后端都记一个新版本。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { Controller, useForm, useWatch } from "react-hook-form"
import { skillInputSchema, type Skill, type SkillInput } from "@heyagent/shared"

import { CreatableCombobox } from "@/components/shell/creatable-combobox"
import { MarkdownView } from "@/components/markdown"
import { Button } from "@/components/ui/button"
import { Combobox, ComboboxChip, ComboboxChips, ComboboxChipsInput, ComboboxContent } from "@/components/ui/combobox"
import { ComboboxEmpty, ComboboxItem, ComboboxList, ComboboxValue, useComboboxAnchor } from "@/components/ui/combobox"
import { Dialog, DialogClose, DialogContent, DialogDescription } from "@/components/ui/dialog"
import { DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { useToolName, useToolsQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

export function SkillDialog({ open, onOpenChange, skill, template, deptOptions, onCreateDept }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 不传就是新建 */
  skill?: Skill
  /** 新建时操作手册的模板 */
  template: string
  /** 「岗位」已有的选项 */
  deptOptions: string[]
  /** 输入了新岗位：页面记住它 */
  onCreateDept: (value: string) => void
}) {
  const toolName = useToolName()
  const toolIds = (useToolsQuery().data?.tools ?? []).map((tool) => tool.id)
  const anchor = useComboboxAnchor()
  const [view, setView] = React.useState<"edit" | "preview">("edit")
  const form = useForm<SkillInput>({
    resolver: zodResolver(skillInputSchema),
    defaultValues: { name: skill?.name ?? "", dept: skill?.dept ?? "", description: skill?.description ?? "", body: skill?.body ?? template, toolIds: skill?.toolIds ?? [] },
  })
  const { errors } = form.formState
  const body = useWatch({ control: form.control, name: "body" })
  const create = useAction(trpc.skills.create.mutationOptions(), { success: "技能建好了，先存为草稿；发布后建任务时才能选用" })
  const update = useAction(trpc.skills.update.mutationOptions(), { success: (data) => `已保存为第 ${data.version} 版` })
  const pending = create.isPending || update.isPending

  const submit = form.handleSubmit(async (values) => {
    if (skill) {
      if (await update.submit({ ...values, id: skill.id })) onOpenChange(false)
      return
    }
    const created = await create.submit(values)
    if (created) {
      onOpenChange(false)
      navigate("skills", { id: created.id })
    }
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{skill ? "编辑技能" : "新建技能"}</DialogTitle>
          <DialogDescription>
            {skill ? `保存后记为第 ${skill.version + 1} 版，下一次运行开始用新版。` : "新建的技能先存为草稿，发布后建任务时才能选用。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!errors.name}>
                <FieldLabel htmlFor="skill-name">名称</FieldLabel>
                <Input id="skill-name" aria-invalid={!!errors.name} {...form.register("name")} />
                <FieldError errors={[errors.name]} />
              </Field>
              <Field data-invalid={!!errors.dept}>
                <FieldLabel htmlFor="skill-dept">岗位</FieldLabel>
                <Controller
                  control={form.control}
                  name="dept"
                  render={({ field }) => (
                    <CreatableCombobox id="skill-dept" value={field.value} onValueChange={field.onChange} options={deptOptions} onCreate={onCreateDept} placeholder="选一个，或输入新岗位" aria-invalid={!!errors.dept} />
                  )}
                />
                <FieldDescription>左边列表按岗位分组。没有合适的就直接输入。</FieldDescription>
                <FieldError errors={[errors.dept]} />
              </Field>
            </div>
            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="skill-description">什么时候用</FieldLabel>
              <Input id="skill-description" placeholder="例如：需要整理周报时使用" aria-invalid={!!errors.description} {...form.register("description")} />
              <FieldDescription>agent 平时只看到这一句，写清楚什么情况下该用。</FieldDescription>
              <FieldError errors={[errors.description]} />
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-tools">用到的工具（可选）</FieldLabel>
              <Controller
                control={form.control}
                name="toolIds"
                render={({ field }) => (
                  <Combobox multiple items={toolIds} value={field.value ?? []} onValueChange={(next: string[], details) => details.reason !== "escape-key" && field.onChange(next)} itemToStringLabel={toolName}>
                    <ComboboxChips ref={anchor}>
                      <ComboboxValue>
                        {(values: string[]) => (
                          <>
                            {values.map((id) => <ComboboxChip key={id}>{toolName(id)}</ComboboxChip>)}
                            <ComboboxChipsInput id="skill-tools" placeholder={values.length === 0 ? "搜工具名" : ""} />
                          </>
                        )}
                      </ComboboxValue>
                    </ComboboxChips>
                    <ComboboxContent anchor={anchor}>
                      <ComboboxEmpty>没有这个工具，先去「工具」页接入</ComboboxEmpty>
                      <ComboboxList>{(id: string) => <ComboboxItem key={id} value={id}>{toolName(id)}</ComboboxItem>}</ComboboxList>
                    </ComboboxContent>
                  </Combobox>
                )}
              />
              <FieldDescription>写进 SKILL.md 的头部，告诉 agent 这个技能要用哪些工具。任务里还要选上这些工具，agent 才调得到。</FieldDescription>
            </Field>
            <Field data-invalid={!!errors.body}>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="skill-body">操作手册（Markdown）</FieldLabel>
                <ToggleGroup variant="outline" size="sm" spacing={0} value={[view]} onValueChange={(next) => next[0] && setView(next[0] as "edit" | "preview")}>
                  <ToggleGroupItem value="edit">编辑</ToggleGroupItem>
                  <ToggleGroupItem value="preview">预览</ToggleGroupItem>
                </ToggleGroup>
              </div>
              {view === "edit" ? (
                <Textarea id="skill-body" rows={12} className="font-mono" aria-invalid={!!errors.body} {...form.register("body")} />
              ) : (
                <div className="max-h-96 overflow-y-auto border p-3">
                  {body?.trim() ? <MarkdownView>{body}</MarkdownView> : <p className="text-muted-foreground">还没写内容</p>}
                </div>
              )}
              <FieldError errors={[errors.body]} />
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
