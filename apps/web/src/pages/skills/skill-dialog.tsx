// 新建 / 编辑技能：四个字段（名称、岗位、什么时候用、操作手册）。「岗位」可以直接输入新的，输入后就多一个下拉选项。
import * as React from "react"

import { CreatableCombobox } from "@/components/shell/creatable-combobox"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription } from "@/components/ui/dialog"
import { DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import type { Skill } from "@heyagent/shared"

export type SkillFormValues = Pick<Skill, "name" | "dept" | "description"> & { body: string }

export function SkillDialog({ open, onOpenChange, skill, template, deptOptions, onCreateDept, onSubmit }: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 不传就是新建 */
  skill?: SkillFormValues
  /** 新建时操作手册的模板 */
  template: string
  /** 「岗位」已有的选项 */
  deptOptions: string[]
  /** 输入了新岗位：页面记住它 */
  onCreateDept: (value: string) => void
  onSubmit: (values: SkillFormValues) => void
}) {
  const [name, setName] = React.useState(skill?.name ?? "")
  const [dept, setDept] = React.useState(skill?.dept ?? "")
  const [description, setDescription] = React.useState(skill?.description ?? "")
  const [body, setBody] = React.useState(skill?.body ?? template)
  const [submitted, setSubmitted] = React.useState(false)

  const error = (value: string, message: string) => (submitted && !value.trim() ? message : undefined)
  const nameError = error(name, "请填写名称")
  const deptError = error(dept, "请选择或输入岗位")
  const descriptionError = error(description, "请写一句什么时候用")

  function submit(event: React.FormEvent) {
    event.preventDefault()
    setSubmitted(true)
    if (!name.trim() || !dept.trim() || !description.trim()) return
    onSubmit({ name: name.trim(), dept: dept.trim(), description: description.trim(), body })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{skill ? "编辑技能" : "新建技能"}</DialogTitle>
          <DialogDescription>
            {skill ? "保存后记为新版本，下一次运行开始用新版。" : "新建的技能先存为草稿，发布后建任务时才能选用。"}
          </DialogDescription>
        </DialogHeader>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <FieldGroup>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field data-invalid={!!nameError}>
                <FieldLabel htmlFor="skill-name">名称</FieldLabel>
                <Input id="skill-name" value={name} onChange={(e) => setName(e.target.value)} aria-invalid={!!nameError} />
                <FieldError>{nameError}</FieldError>
              </Field>
              <Field data-invalid={!!deptError}>
                <FieldLabel htmlFor="skill-dept">岗位</FieldLabel>
                <CreatableCombobox
                  id="skill-dept"
                  value={dept}
                  onValueChange={setDept}
                  options={deptOptions}
                  onCreate={onCreateDept}
                  placeholder="选一个，或输入新岗位"
                  aria-invalid={!!deptError}
                />
                <FieldDescription>左边列表按岗位分组。没有合适的就直接输入。</FieldDescription>
                <FieldError>{deptError}</FieldError>
              </Field>
            </div>
            <Field data-invalid={!!descriptionError}>
              <FieldLabel htmlFor="skill-description">什么时候用</FieldLabel>
              <Input
                id="skill-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="例如：需要找同款或货源时使用"
                aria-invalid={!!descriptionError}
              />
              <FieldDescription>agent 平时只看到这一句，写清楚什么情况下该用。</FieldDescription>
              <FieldError>{descriptionError}</FieldError>
            </Field>
            <Field>
              <FieldLabel htmlFor="skill-body">操作手册</FieldLabel>
              <Textarea id="skill-body" rows={10} value={body} onChange={(e) => setBody(e.target.value)} />
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
