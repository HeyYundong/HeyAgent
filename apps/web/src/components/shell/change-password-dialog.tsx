// 侧边栏用户菜单「修改密码」：输入现在的密码和两次新密码。改完当前这个浏览器保持登录，其他设备上的登录会失效。
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { changePasswordFormSchema, PASSWORD_MIN, type ChangePasswordForm } from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

export function ChangePasswordDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const form = useForm<ChangePasswordForm>({ resolver: zodResolver(changePasswordFormSchema), defaultValues: { currentPassword: "", newPassword: "", confirm: "" } })
  const change = useAction(trpc.me.changePassword.mutationOptions(), { success: "密码改好了，其他设备上的登录已失效" })
  const { errors } = form.formState

  const submit = form.handleSubmit(async ({ currentPassword, newPassword }) => {
    if (await change.submit({ currentPassword, newPassword })) onOpenChange(false)
  })

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>修改密码</DialogTitle>
            <DialogDescription>改完这个浏览器保持登录，其他设备上的登录会失效。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.currentPassword}>
              <FieldLabel htmlFor="pw-current">现在的密码</FieldLabel>
              <Input id="pw-current" type="password" autoComplete="current-password" aria-invalid={!!errors.currentPassword} {...form.register("currentPassword")} />
              <FieldError errors={[errors.currentPassword]} />
            </Field>
            <Field data-invalid={!!errors.newPassword}>
              <FieldLabel htmlFor="pw-new">新密码</FieldLabel>
              <Input id="pw-new" type="password" autoComplete="new-password" aria-invalid={!!errors.newPassword} {...form.register("newPassword")} />
              <FieldDescription>至少 {PASSWORD_MIN} 位。</FieldDescription>
              <FieldError errors={[errors.newPassword]} />
            </Field>
            <Field data-invalid={!!errors.confirm}>
              <FieldLabel htmlFor="pw-confirm">再输一次新密码</FieldLabel>
              <Input id="pw-confirm" type="password" autoComplete="new-password" aria-invalid={!!errors.confirm} {...form.register("confirm")} />
              <FieldError errors={[errors.confirm]} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={change.isPending}>
              {change.isPending && <Spinner data-icon="inline-start" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
