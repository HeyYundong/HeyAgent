// 「做模板」（主管，docs/dev/desktop-vm.md 第 1、6 节）：系统自动装 Windows 和两个服务，装好后主管在画面里装常用软件，再点「做成模板」。
// 之后运营「新建桌面」都从模板复制。表单：React Hook Form + shared 的 desktopTemplateCreateSchema。
import { zodResolver } from "@hookform/resolvers/zod"
import { ClockIcon } from "lucide-react"
import { Controller, useForm, type FieldError as FormFieldError, type Resolver } from "react-hook-form"
import { desktopTemplateCreateSchema, type DesktopHost, type DesktopTemplateCreate } from "@heyagent/shared"

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldLegend, FieldSet } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupInput, InputGroupText } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

import { defaultStoragePath, StoragePicker } from "./vm-parts"

/** 数字框清空时 zod 报的是英文的类型错误，换成一句人话 */
const numberError = (error?: FormFieldError) => (error?.type === "invalid_type" ? { message: "填一个整数" } : error)

const NUMBERS: { name: "diskGb" | "memoryGb" | "cpus"; label: string; unit: string; hint: string }[] = [
  { name: "diskGb", label: "系统盘", unit: "GB", hint: "Windows 加软件够用就行，默认 64 GB。从模板建的桌面一样大，但只占实际用到的空间。" },
  { name: "memoryGb", label: "内存", unit: "GB", hint: "从它建的桌面默认用这么多，新建时可以改。" },
  { name: "cpus", label: "CPU", unit: "核", hint: "从它建的桌面默认用这么多，新建时可以改。" },
]

export function TemplateDialog({ host, onClose }: { host: DesktopHost; onClose: () => void }) {
  const form = useForm<DesktopTemplateCreate>({
    resolver: zodResolver(desktopTemplateCreateSchema) as unknown as Resolver<DesktopTemplateCreate>,
    defaultValues: { name: "", description: "", storagePath: defaultStoragePath(host.storages) ?? "", diskGb: 64, memoryGb: 6, cpus: 4 },
  })
  const { errors } = form.formState
  const create = useAction(trpc.desktops.createTemplate.mutationOptions(), { success: "开始装 Windows 了，装好了详情里会提示下一步" })

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
            <DialogTitle>做模板</DialogTitle>
            <DialogDescription>系统自动装好 Windows 和 agent 要用的两个服务。装好后你在画面里装上常用软件，点「做成模板」，以后大家「新建桌面」都从它复制。</DialogDescription>
          </DialogHeader>
          <Alert>
            <ClockIcon />
            <AlertTitle>要等比较久</AlertTitle>
            <AlertDescription>装 Windows 要从网上下载 8.5 GB 的安装包再自动安装：SSD 上估计 1 小时左右，机械硬盘上实测约 3 小时。装的时候不用守着，关掉页面也照样装。</AlertDescription>
          </Alert>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="tpl-name">名字</FieldLabel>
              <Input id="tpl-name" placeholder="例如：标准办公模板" aria-invalid={!!errors.name} {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="tpl-desc">说明</FieldLabel>
              <Textarea id="tpl-desc" placeholder="例如：装了聊天软件和表格软件，没有登录账号" aria-invalid={!!errors.description} {...form.register("description")} />
              <FieldDescription>新建桌面时选模板的人看这段话，写清楚装了哪些软件。</FieldDescription>
              <FieldError errors={[errors.description]} />
            </Field>
            <Controller
              control={form.control}
              name="storagePath"
              render={({ field }) => (
                <FieldSet data-invalid={!!errors.storagePath}>
                  <FieldLegend variant="label">存在哪块盘</FieldLegend>
                  <FieldDescription>模板做好后一直留着，从它建的桌面都要读它，放 SSD 上大家都快。</FieldDescription>
                  <StoragePicker id="tpl-storage" storages={host.storages} value={field.value} onChange={field.onChange} invalid={!!errors.storagePath} />
                  <FieldError errors={[errors.storagePath]} />
                </FieldSet>
              )}
            />
            <div className="grid gap-4 sm:grid-cols-3">
              {NUMBERS.map((item) => {
                const error = numberError(errors[item.name])
                const id = `tpl-${item.name}`
                return (
                  <Field key={item.name} data-invalid={!!error}>
                    <FieldLabel htmlFor={id}>{item.label}</FieldLabel>
                    <InputGroup>
                      <InputGroupInput id={id} type="number" inputMode="numeric" step="1" aria-invalid={!!error} {...form.register(item.name, { valueAsNumber: true })} />
                      <InputGroupAddon align="inline-end"><InputGroupText>{item.unit}</InputGroupText></InputGroupAddon>
                    </InputGroup>
                    <FieldDescription>{item.hint}</FieldDescription>
                    <FieldError errors={[error]} />
                  </Field>
                )
              })}
            </div>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner data-icon="inline-start" />}
              开始做
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
