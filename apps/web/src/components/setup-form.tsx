// 首次设置管理员：还没有任何账号时代替登录页，布局和 login-form.tsx 一样（registry 区块 login-01）。
// 填名字、邮箱和两次密码 → POST /api/setup 建管理员 → 用同一组邮箱密码登录，直接进控制台。
// 表单照已登记的写法：React Hook Form + zodResolver，schema 在 @heyagent/shared 的 config.ts。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { PASSWORD_MIN, setupAdminFormSchema, type SetupAdminForm } from "@heyagent/shared"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { SetupError, setupAdmin, signIn } from "@/lib/auth"

export function SetupForm({
  className,
  onSignedIn,
  onNeedSignIn,
  ...props
}: React.ComponentProps<"div"> & {
  /** 建好并登录了 */
  onSignedIn: () => void
  /** 管理员已经有了（别人先设置了，或者建好了但没登录上）：换成登录页 */
  onNeedSignIn: () => void
}) {
  const form = useForm<SetupAdminForm>({
    resolver: zodResolver(setupAdminFormSchema),
    defaultValues: { name: "", email: "", password: "", confirm: "" },
  })
  const [error, setError] = React.useState<string | null>(null)
  const { errors, isSubmitting } = form.formState

  const submit = form.handleSubmit(async ({ name, email, password }) => {
    setError(null)
    try {
      await setupAdmin({ name, email, password })
    } catch (cause) {
      if (cause instanceof SetupError && cause.alreadyDone) {
        toast.add({ title: "已经有人设置过管理员了", description: "请用管理员给你的账号登录。", type: "info" })
        onNeedSignIn()
        return
      }
      setError(cause instanceof SetupError ? cause.message : "连不上服务器，请稍后再试")
      return
    }
    try {
      await signIn(email, password)
    } catch {
      toast.add({ title: "管理员账号建好了", description: "请用刚才填的邮箱和密码登录。", type: "success" })
      onNeedSignIn()
      return
    }
    toast.add({ title: "管理员账号建好了", description: "可以在「用户」页给同事建账号。", type: "success", timeout: 10000 })
    onSignedIn()
  })

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <div className="flex items-center gap-3 self-center">
        <img src="./logo-64.png" alt="" className="size-10" />
        <span className="font-heading text-xl font-semibold">HeyAgent</span>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>设置管理员</CardTitle>
          <CardDescription>第一次使用，先建管理员账号。之后用它登录，给同事建账号。</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field data-invalid={!!errors.name}>
                <FieldLabel htmlFor="setup-name">名字</FieldLabel>
                <Input id="setup-name" autoComplete="name" placeholder="例如：张三" aria-invalid={!!errors.name} {...form.register("name")} />
                <FieldError errors={[errors.name]} />
              </Field>
              <Field data-invalid={!!errors.email}>
                <FieldLabel htmlFor="setup-email">邮箱</FieldLabel>
                <Input id="setup-email" type="email" autoComplete="username" placeholder="例如：name@example.com" aria-invalid={!!errors.email} {...form.register("email")} />
                <FieldDescription>登录用，建好后不能改。</FieldDescription>
                <FieldError errors={[errors.email]} />
              </Field>
              <Field data-invalid={!!errors.password}>
                <FieldLabel htmlFor="setup-password">密码</FieldLabel>
                <Input id="setup-password" type="password" autoComplete="new-password" aria-invalid={!!errors.password} {...form.register("password")} />
                <FieldDescription>至少 {PASSWORD_MIN} 位。</FieldDescription>
                <FieldError errors={[errors.password]} />
              </Field>
              <Field data-invalid={!!errors.confirm}>
                <FieldLabel htmlFor="setup-confirm">再输一次密码</FieldLabel>
                <Input id="setup-confirm" type="password" autoComplete="new-password" aria-invalid={!!errors.confirm} {...form.register("confirm")} />
                <FieldError errors={[errors.confirm]} />
              </Field>
              <Field data-invalid={error ? true : undefined}>
                <Button type="submit" disabled={isSubmitting}>
                  {isSubmitting && <Spinner data-icon="inline-start" />}
                  建好并登录
                </Button>
                <FieldError>{error}</FieldError>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
