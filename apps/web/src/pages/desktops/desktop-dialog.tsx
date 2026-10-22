// 新建 / 编辑桌面（只有主管）：名字、给 agent 看的说明、Windows-MCP 地址、桌面服务地址、密钥。
// 表单：React Hook Form + shared 的 desktopCreateSchema（新建，密钥必填）/ desktopUpdateSchema（编辑，密钥留空 = 不改）。密钥只进不出。
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm, type Resolver } from "react-hook-form"
import { desktopCreateSchema, desktopUpdateSchema, type Desktop, type DesktopInput } from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Textarea } from "@/components/ui/textarea"

import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

type Values = DesktopInput & { id?: string }

/** desktop 不传就是新建 */
export function DesktopDialog({ desktop, onClose }: { desktop?: Desktop; onClose: () => void }) {
  const form = useForm<Values>({
    resolver: zodResolver(desktop ? desktopUpdateSchema : desktopCreateSchema) as unknown as Resolver<Values>,
    defaultValues: {
      ...(desktop ? { id: desktop.id } : {}),
      name: desktop?.name ?? "",
      description: desktop?.description ?? "",
      mcpUrl: desktop?.mcpUrl ?? "",
      agentUrl: desktop?.agentUrl ?? "",
      key: "",
    },
  })
  const { errors } = form.formState
  const create = useAction(trpc.desktops.create.mutationOptions(), { success: "桌面登记好了。下一步：点「测试连接」看看两个服务通不通" })
  const update = useAction(trpc.desktops.update.mutationOptions(), { success: "已保存" })
  const pending = create.isPending || update.isPending

  const submit = form.handleSubmit(async (values) => {
    const input = { name: values.name, description: values.description ?? "", mcpUrl: values.mcpUrl, agentUrl: values.agentUrl }
    const key = values.key?.trim()
    if (desktop) {
      // 编辑时密钥留空 = 不改。desktops.update 不返回内容，不能用 submit 的返回值判断成没成功；失败时 useAction 已经弹了 toast
      try {
        await update.mutateAsync({ ...input, id: desktop.id, ...(key ? { key } : {}) })
        onClose()
      } catch {
        // 留着弹窗给人改
      }
      return
    }
    const created = await create.submit({ ...input, key: key ?? "" })
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
            <DialogTitle>{desktop ? `编辑「${desktop.name}」` : "登记桌面"}</DialogTitle>
            <DialogDescription>一台装好了 Windows-MCP 和桌面服务的 Windows 电脑（虚拟机或实体机都行）。同一时间只给一个运行用；任务要用桌面时，系统从任务允许的桌面里挑一台空着的。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="dk-name">名字</FieldLabel>
              <Input id="dk-name" placeholder="例如：运营 1 号机" aria-invalid={!!errors.name} {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.description}>
              <FieldLabel htmlFor="dk-desc">给 agent 看的说明</FieldLabel>
              <Textarea id="dk-desc" placeholder="例如：装了聊天软件和表格软件，登的是运营部的公共账号" aria-invalid={!!errors.description} {...form.register("description")} />
              <FieldDescription>写清楚装了哪些软件、登的哪个账号。任务允许好几台桌面时，agent 靠这段话挑。</FieldDescription>
              <FieldError errors={[errors.description]} />
            </Field>
            <Field data-invalid={!!errors.mcpUrl}>
              <FieldLabel htmlFor="dk-mcp">Windows-MCP 地址</FieldLabel>
              <Input id="dk-mcp" className="font-mono" spellCheck={false} placeholder="http://10.0.0.21:8000/mcp" aria-invalid={!!errors.mcpUrl} {...form.register("mcpUrl")} />
              <FieldDescription>agent 读界面、点击、输入走这个服务，默认端口 8000，路径 /mcp。</FieldDescription>
              <FieldError errors={[errors.mcpUrl]} />
            </Field>
            <Field data-invalid={!!errors.agentUrl}>
              <FieldLabel htmlFor="dk-agent">桌面服务地址</FieldLabel>
              <Input id="dk-agent" className="font-mono" spellCheck={false} placeholder="http://10.0.0.21:8001" aria-invalid={!!errors.agentUrl} {...form.register("agentUrl")} />
              <FieldDescription>远程画面、截图、传文件走这个服务，默认端口 8001。</FieldDescription>
              <FieldError errors={[errors.agentUrl]} />
            </Field>
            <Field data-invalid={!!errors.key}>
              <FieldLabel htmlFor="dk-key">密钥</FieldLabel>
              <Input id="dk-key" type="password" autoComplete="new-password" className="font-mono"
                placeholder={desktop?.keyMask ? `已存过（${desktop.keyMask}），不改就留空` : "装桌面服务时填的那个，至少 16 位"}
                aria-invalid={!!errors.key} {...form.register("key")} />
              <FieldDescription>两个服务共用，和在那台电脑上运行 install.ps1 时 -Key 填的一样。只加密存在服务器上，页面上不再显示。</FieldDescription>
              <FieldError errors={[errors.key]} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Spinner data-icon="inline-start" />}
              {desktop ? "保存" : "登记"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
