// 比对标准：名称 + 打分要求 + 合格线 + 模型；有一个默认的。页面、agent、外部接口都按标准（名字或 id）比，结果才前后一致。
// 在「新比对」弹窗里点「管理标准」打开。新建、修改、删除、设默认只有主管（config.manage）；员工只能看。
// 表单：React Hook Form + shared 的 compareStandardInputSchema。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useQuery } from "@tanstack/react-query"
import { EllipsisIcon, PencilIcon, PlusIcon, StarIcon, Trash2Icon } from "lucide-react"
import { Controller, useForm, useWatch } from "react-hook-form"
import { can, compareStandardInputSchema, type CompareStandard, type CompareStandardInput } from "@heyagent/shared"

import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { useModels } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

/** 正在编辑的标准；id 为空是新建 */
type Editing = Pick<CompareStandard, "id" | "name" | "prompt" | "passScore" | "modelId">

export function StandardsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { user } = useMe()
  const canManage = can(user, "config.manage", {})
  const standardsQuery = useQuery(trpc.compare.standards.queryOptions())
  const { modelName } = useModels()
  const [editing, setEditing] = React.useState<Editing | null>(null)
  const [deleting, setDeleting] = React.useState<CompareStandard | null>(null)
  const setDefault = useAction(trpc.compare.setDefaultStandard.mutationOptions(), { success: "默认标准换好了", errorTitle: "没设成默认" })
  const remove = useAction(trpc.compare.deleteStandard.mutationOptions(), { success: "标准删掉了", errorTitle: "没删成" })
  const list = standardsQuery.data ?? []
  const fallbackModel = list.find((each) => each.isDefault)?.modelId ?? list[0]?.modelId ?? ""

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next)
        if (!next) setEditing(null)
      }}
    >
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-xl">
        {editing ? (
          <StandardForm key={editing.id || "new"} standard={editing} onDone={() => setEditing(null)} />
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>比对标准</DialogTitle>
              <DialogDescription>
                每个标准是一段打分要求加一条合格线。页面、agent、外部接口都按标准比，结果才前后一致。{canManage ? "" : "标准由主管维护。"}
              </DialogDescription>
            </DialogHeader>
            {standardsQuery.isPending ? (
              <div className="flex flex-col gap-2">
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-16 w-full" />
              </div>
            ) : standardsQuery.isError ? (
              <p className="text-sm text-destructive">标准没取到，关掉再试一次。</p>
            ) : list.length === 0 ? (
              <p className="text-sm text-muted-foreground">还没有标准。{canManage ? "点「新标准」建一个；" : ""}没有标准时，新比对要自己写要求。</p>
            ) : (
              <ItemGroup className="gap-2">
                {list.map((each) => (
                  <Item key={each.id} variant="outline" size="sm">
                    <ItemContent className="min-w-0">
                      <ItemTitle className="flex items-center gap-2">
                        {each.name}
                        {each.isDefault && (
                          <Badge variant="outline">
                            <StarIcon data-icon="inline-start" />
                            默认
                          </Badge>
                        )}
                      </ItemTitle>
                      <ItemDescription>
                        合格线 {each.passScore} · {modelName(each.modelId)} · id：{each.id}
                      </ItemDescription>
                    </ItemContent>
                    {canManage && (
                      <ItemActions>
                        <Button variant="ghost" size="sm" onClick={() => setEditing(each)}>
                          <PencilIcon data-icon="inline-start" />
                          修改
                        </Button>
                        {!each.isDefault && (
                          <DropdownMenu>
                            <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label={`标准「${each.name}」的更多操作`} />}>
                              {setDefault.isPending && setDefault.variables?.id === each.id ? <Spinner /> : <EllipsisIcon />}
                            </DropdownMenuTrigger>
                            <DropdownMenuContent align="end" className="w-36">
                              <DropdownMenuItem onClick={() => setDefault.mutate({ id: each.id })}>
                                <StarIcon />
                                设为默认
                              </DropdownMenuItem>
                              <DropdownMenuItem variant="destructive" onClick={() => setDeleting(each)}>
                                <Trash2Icon />
                                删除
                              </DropdownMenuItem>
                            </DropdownMenuContent>
                          </DropdownMenu>
                        )}
                      </ItemActions>
                    )}
                  </Item>
                ))}
              </ItemGroup>
            )}
            <DialogFooter>
              {canManage && (
                <Button variant="outline" onClick={() => setEditing({ id: "", name: "", prompt: "", passScore: 90, modelId: fallbackModel })}>
                  <PlusIcon data-icon="inline-start" />
                  新标准
                </Button>
              )}
              <DialogClose render={<Button />}>好了</DialogClose>
            </DialogFooter>
          </>
        )}
        <AlertDialog open={deleting !== null} onOpenChange={(next) => !next && setDeleting(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除标准「{deleting?.name}」？</AlertDialogTitle>
              <AlertDialogDescription>
                以后页面、agent、接口都不能再按这个标准比；还在按名字或 id 用它的任务、外部系统会报错。以前用它比过的记录还在，显示的是当时的要求。删掉后不能恢复。
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>先不</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                onClick={async () => {
                  const target = deleting
                  setDeleting(null)
                  if (target) await remove.submit({ id: target.id })
                }}
              >
                <Trash2Icon data-icon="inline-start" />
                删除
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}

/** 新建 / 修改一个标准（在同一个弹窗里换成表单，「返回」回到列表） */
function StandardForm({ standard, onDone }: { standard: Editing; onDone: () => void }) {
  const modelsQuery = useQuery({ ...trpc.compare.models.queryOptions(), retry: false })
  const { modelName } = useModels()
  const form = useForm<CompareStandardInput>({
    resolver: zodResolver(compareStandardInputSchema),
    defaultValues: { name: standard.name, prompt: standard.prompt, passScore: standard.passScore, modelId: standard.modelId },
  })
  const { errors } = form.formState
  const create = useAction(trpc.compare.createStandard.mutationOptions(), { success: "标准建好了", errorTitle: "没建成" })
  const update = useAction(trpc.compare.updateStandard.mutationOptions(), { success: "标准已保存", errorTitle: "没保存成" })
  const pending = create.isPending || update.isPending

  // 选中的模型不在视觉模型列表里（列表没取到、模型下架了）也要显示出来，让人知道要换
  const models = modelsQuery.data ?? []
  const modelItems = models.map((model) => ({ value: model.id, label: model.name }))
  const currentModel = useWatch({ control: form.control, name: "modelId" })
  if (currentModel && !modelItems.some((item) => item.value === currentModel)) modelItems.unshift({ value: currentModel, label: modelName(currentModel) })

  const submit = form.handleSubmit(async (values) => {
    const saved = standard.id ? await update.submit({ ...values, id: standard.id }) : await create.submit(values)
    if (saved) onDone()
  })

  return (
    <form onSubmit={submit} className="flex min-w-0 flex-col gap-4">
      <DialogHeader>
        <DialogTitle>{standard.id ? `修改标准「${standard.name}」` : "新标准"}</DialogTitle>
        <DialogDescription>改了以后，之后的比对按新的要求；以前的比对记录还是当时的要求。</DialogDescription>
      </DialogHeader>
      <FieldGroup>
        <Field data-invalid={!!errors.name}>
          <FieldLabel htmlFor="std-name">名称</FieldLabel>
          <Input id="std-name" maxLength={50} placeholder="例如：同款判断" aria-invalid={!!errors.name} {...form.register("name")} />
          {errors.name ? <FieldError errors={[errors.name]} /> : <FieldDescription>agent 和接口按名字（或 id）用它，起个一看就懂的。</FieldDescription>}
        </Field>
        <Field data-invalid={!!errors.prompt}>
          <FieldLabel htmlFor="std-prompt">打分要求</FieldLabel>
          <Textarea id="std-prompt" rows={7} aria-invalid={!!errors.prompt} {...form.register("prompt")} />
          {errors.prompt ? <FieldError errors={[errors.prompt]} /> : <FieldDescription>写清楚什么算像、看哪些方面（每一项会单独打分）、哪些差异不算。</FieldDescription>}
        </Field>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Field data-invalid={!!errors.passScore}>
            <FieldLabel htmlFor="std-pass">合格线</FieldLabel>
            <Input id="std-pass" type="number" inputMode="numeric" min={0} max={100} step={1} aria-invalid={!!errors.passScore} {...form.register("passScore", { valueAsNumber: true })} />
            <FieldError errors={[errors.passScore]} />
          </Field>
          <Field data-invalid={!!errors.modelId}>
            <FieldLabel htmlFor="std-model">模型</FieldLabel>
            <Controller
              control={form.control}
              name="modelId"
              render={({ field }) => (
                <Select items={modelItems} value={field.value || null} onValueChange={(value) => value && field.onChange(String(value))}>
                  <SelectTrigger id="std-model" className="w-full" aria-invalid={!!errors.modelId}>
                    <SelectValue placeholder="选一个视觉模型" />
                  </SelectTrigger>
                  <SelectContent>
                    {modelItems.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            />
            {errors.modelId ? <FieldError errors={[errors.modelId]} /> : modelsQuery.isError ? <FieldDescription>视觉模型列表没取到。</FieldDescription> : null}
          </Field>
        </div>
      </FieldGroup>
      <DialogFooter>
        <Button type="button" variant="outline" disabled={pending} onClick={onDone}>
          返回
        </Button>
        <Button type="submit" disabled={pending}>
          {pending && <Spinner data-icon="inline-start" />}
          保存
        </Button>
      </DialogFooter>
    </form>
  )
}
