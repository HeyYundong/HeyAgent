// 「新建桌面」（所有人，docs/dev/desktop-vm.md 第 6 节）：从做好的模板复制一台 Windows 桌面，系统自己开机、登记好，人只要在画面里扫码登录软件。
// 用的人大多不懂电脑：只问名字、说明、用哪个模板、存在哪块盘；内存、CPU 收在「更多」里，不填 = 和模板一样。
// 表单：React Hook Form + shared 的 desktopVmCreateSchema。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import { Controller, useForm, useWatch, type Resolver } from "react-hook-form"
import { desktopVmCreateSchema, type Desktop, type DesktopHost, type DesktopVmCreate } from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { defaultStoragePath, StoragePicker } from "./vm-parts"

/** 数字框：空着 = 不填（用模板的），不是 0 */
const optionalNumber = { setValueAs: (value: unknown) => (value === "" || value === null || value === undefined ? undefined : Number(value)) }

export function NewDesktopDialog({ templates, host, onClose }: { templates: Desktop[]; host: DesktopHost; onClose: () => void }) {
  const [more, setMore] = React.useState(false)
  const form = useForm<DesktopVmCreate>({
    resolver: zodResolver(desktopVmCreateSchema) as unknown as Resolver<DesktopVmCreate>,
    defaultValues: {
      name: "",
      description: "",
      templateId: templates.length === 1 ? templates[0]!.id : "",
      storagePath: defaultStoragePath(host.storages),
    },
  })
  const { errors } = form.formState
  const create = useAction(trpc.desktops.createVm.mutationOptions(), { success: "开始建了：大约 1～2 分钟开好机，好了状态会变成「开着」" })
  const templateId = useWatch({ control: form.control, name: "templateId" })
  const template = templates.find((each) => each.id === templateId)
  const templateItems = templates.map((each) => ({ value: each.id, label: each.name }))

  const submit = form.handleSubmit(async (values) => {
    const created = await create.submit(values)
    if (created) {
      onClose()
      navigate("desktops", { id: created.id })
    }
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-svh overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>新建桌面</DialogTitle>
            <DialogDescription>系统照着模板复制一台 Windows 电脑，自动开机。开好以后点「看画面」，用手机扫码登录要用的软件就行。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="vm-name">名字</FieldLabel>
              <Input id="vm-name" placeholder="例如：运营 1 号" aria-invalid={!!errors.name} {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="vm-desc">给 agent 看的说明</FieldLabel>
              <Textarea id="vm-desc" placeholder="例如：登的是运营部的公共账号" aria-invalid={!!errors.description} {...form.register("description")} />
              <FieldDescription>可以先空着，登录好软件后再写：登的哪个账号、用来干什么。</FieldDescription>
              <FieldError errors={[errors.description]} />
            </Field>
            <Controller
              control={form.control}
              name="templateId"
              render={({ field }) => (
                <Field data-invalid={!!errors.templateId}>
                  <FieldLabel htmlFor="vm-template">模板</FieldLabel>
                  <Select items={templateItems} value={field.value || null} onValueChange={(value) => value && field.onChange(String(value))}>
                    <SelectTrigger id="vm-template" className="w-full" aria-invalid={!!errors.templateId}>
                      <SelectValue placeholder="选一个模板" />
                    </SelectTrigger>
                    <SelectContent>
                      {templateItems.map((item) => (
                        <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <FieldDescription>{template?.description || "模板里装好了常用软件，新桌面和它一模一样。"}</FieldDescription>
                  <FieldError errors={[errors.templateId]} />
                </Field>
              )}
            />
            <Controller
              control={form.control}
              name="storagePath"
              render={({ field }) => (
                <FieldSet data-invalid={!!errors.storagePath}>
                  <FieldLegend variant="label">存在哪块盘</FieldLegend>
                  <FieldDescription>一台桌面开始只占几 GB，用久了会变大。SSD 快，机械硬盘上 Windows 会很慢。</FieldDescription>
                  <StoragePicker id="vm-storage" storages={host.storages} value={field.value} onChange={field.onChange} invalid={!!errors.storagePath} />
                  <FieldError errors={[errors.storagePath]} />
                </FieldSet>
              )}
            />
            <Collapsible open={more} onOpenChange={setMore}>
              <CollapsibleTrigger render={<Button type="button" variant="ghost" size="sm" />}>
                {more ? <ChevronDownIcon data-icon="inline-start" /> : <ChevronRightIcon data-icon="inline-start" />}
                更多
              </CollapsibleTrigger>
              <CollapsibleContent className="pt-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field data-invalid={!!errors.memoryGb}>
                    <FieldLabel htmlFor="vm-memory">内存</FieldLabel>
                    <InputGroup>
                      <InputGroupInput id="vm-memory" type="number" inputMode="numeric" step="1" placeholder={template?.vm ? String(template.vm.memoryGb) : ""}
                        aria-invalid={!!errors.memoryGb} {...form.register("memoryGb", optionalNumber)} />
                      <InputGroupAddon align="inline-end"><InputGroupText>GB</InputGroupText></InputGroupAddon>
                    </InputGroup>
                    <FieldError errors={[errors.memoryGb]} />
                  </Field>
                  <Field data-invalid={!!errors.cpus}>
                    <FieldLabel htmlFor="vm-cpus">CPU</FieldLabel>
                    <InputGroup>
                      <InputGroupInput id="vm-cpus" type="number" inputMode="numeric" step="1" placeholder={template?.vm ? String(template.vm.cpus) : ""}
                        aria-invalid={!!errors.cpus} {...form.register("cpus", optionalNumber)} />
                      <InputGroupAddon align="inline-end"><InputGroupText>核</InputGroupText></InputGroupAddon>
                    </InputGroup>
                    <FieldError errors={[errors.cpus]} />
                  </Field>
                  <FieldDescription className="sm:col-span-2">
                    不填 = 和模板一样{template?.vm ? `（${template.vm.memoryGb} GB 内存、${template.vm.cpus} 核）` : ""}。
                    本机内存 {Math.round(host.memoryGb)} GB，开着的虚拟机已经用了 {Math.round(host.usedMemoryGb)} GB。
                  </FieldDescription>
                </div>
              </CollapsibleContent>
            </Collapsible>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner data-icon="inline-start" />}
              新建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
