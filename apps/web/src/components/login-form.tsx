// 登录表单：来自 registry 区块 login-01（npx shadcn@latest add login-01），改成中文、邮箱 + 密码，用山羊 logo。
// 公开注册已关闭，账号由管理员建，所以去掉了区块里的「注册」「用 Google 登录」。
import * as React from "react"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { SignInError, signIn } from "@/lib/auth"

export function LoginForm({
  className,
  onSignedIn,
  ...props
}: React.ComponentProps<"div"> & { onSignedIn: () => void }) {
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    try {
      await signIn(String(form.get("email") ?? "").trim(), String(form.get("password") ?? ""))
      onSignedIn()
    } catch (cause) {
      setError(cause instanceof SignInError ? cause.message : "连不上服务器，请稍后再试")
      setPending(false)
    }
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <div className="flex items-center gap-3 self-center">
        <img src="./logo-64.png" alt="" className="size-10" />
        <span className="font-heading text-xl font-semibold">HeyAgent</span>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>登录控制台</CardTitle>
          <CardDescription>用管理员给你的公司邮箱和密码登录</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit}>
            <FieldGroup>
              <Field data-invalid={error ? true : undefined}>
                <FieldLabel htmlFor="email">邮箱</FieldLabel>
                <Input
                  id="email"
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="linzhou@heyagent.local"
                  aria-invalid={error ? true : undefined}
                  required
                />
              </Field>
              <Field data-invalid={error ? true : undefined}>
                <FieldLabel htmlFor="password">密码</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  aria-invalid={error ? true : undefined}
                  required
                />
                <FieldError>{error}</FieldError>
              </Field>
              <Field>
                <Button type="submit" disabled={pending}>
                  {pending && <Spinner data-icon="inline-start" />}
                  登录
                </Button>
                <FieldDescription className="text-center">
                  没有账号或忘了密码，请找管理员。
                </FieldDescription>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
