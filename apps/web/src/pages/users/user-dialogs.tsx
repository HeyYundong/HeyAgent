// 用户页的三个弹窗：新建用户、编辑（名字 / 职位 / 角色）、重置密码。
// 表单：React Hook Form + shared 的 userCreateSchema / userUpdateSchema / userResetPasswordSchema。
import { zodResolver } from "@hookform/resolvers/zod"
import { DicesIcon } from "lucide-react"
import type * as React from "react"
import { Controller, useForm } from "react-hook-form"
import {
  PASSWORD_MIN,
  userCreateSchema,
  userResetPasswordSchema,
  userUpdateSchema,
  type UserAccount,
  type UserCreateInput,
} from "@heyagent/shared"

import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupInput } from "@/components/ui/input-group"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"

import { useAction } from "@/lib/mutations"
import { navigate } from "@/lib/router"
import { trpc } from "@/lib/trpc"

type Role = "admin" | "user"

export const ROLE_LABEL: Record<Role, string> = { admin: "主管", user: "员工" }
export const ROLE_HINT: Record<Role, string> = {
  admin: "能建任务，能管理用户、设置和所有配置，能处理所有人的事。",
  user: "什么都能看，能处理分给自己的事、管自己负责的任务；不能建任务、不能改配置。",
}

// 随机密码：去掉容易看错的字符（0 O 1 l I），方便口头或手抄转告
const PASSWORD_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789"
const RANDOM_LENGTH = 14

/** 用 crypto.getRandomValues 生成随机密码；丢弃超出整倍数的随机数，保证每个字符概率相同 */
export function randomPassword(length = RANDOM_LENGTH) {
  const limit = 256 - (256 % PASSWORD_CHARS.length)
  let out = ""
  while (out.length < length) {
    const bytes = crypto.getRandomValues(new Uint8Array(length * 2))
    for (const byte of bytes) {
      if (byte < limit && out.length < length) out += PASSWORD_CHARS[byte % PASSWORD_CHARS.length]
    }
  }
  return out
}

/** 角色选择：主管 / 员工（表单里用 Controller 接上） */
function RoleField({ value, onChange, disabled, note }: { value: Role; onChange: (role: Role) => void; disabled?: boolean; note?: string }) {
  return (
    <Field>
      <FieldLabel>角色</FieldLabel>
      <ToggleGroup
        variant="outline"
        spacing={0}
        disabled={disabled}
        value={[value]}
        onValueChange={(next) => next[0] && onChange(next[0] as Role)}
        aria-label="角色"
      >
        {(["user", "admin"] as const).map((role) => (
          <ToggleGroupItem key={role} value={role}>
            {ROLE_LABEL[role]}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <FieldDescription>{note ?? ROLE_HINT[value]}</FieldDescription>
    </Field>
  )
}

/** 密码输入：明文显示（要转告本人），右侧「随机生成」 */
function PasswordInput({ id, invalid, onRandom, ...props }: React.ComponentProps<"input"> & { invalid: boolean; onRandom: () => void }) {
  return (
    <InputGroup>
      <InputGroupInput id={id} autoComplete="off" spellCheck={false} className="font-mono" aria-invalid={invalid} {...props} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton onClick={onRandom}>
          <DicesIcon data-icon="inline-start" />
          随机生成
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  )
}

// ---------- 新建用户 ----------

export function CreateUserDialog({ onClose }: { onClose: () => void }) {
  const form = useForm<UserCreateInput>({
    resolver: zodResolver(userCreateSchema),
    defaultValues: { email: "", name: "", title: "", role: "user", password: randomPassword() },
  })
  const { errors } = form.formState
  const create = useAction(trpc.users.create.mutationOptions())

  const submit = form.handleSubmit(async (values) => {
    const created = await create.submit(values)
    if (!created) return
    toast.add({
      title: `已建好「${values.name}」的账号`,
      description: "把初始密码告诉本人，登录后让他在用户菜单里修改。",
      type: "success",
      timeout: 10000,
    })
    onClose()
    navigate("users", { id: created.id })
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>新建用户</DialogTitle>
            <DialogDescription>建好后把邮箱和初始密码告诉本人，用邮箱登录。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.email}>
              <FieldLabel htmlFor="user-email">邮箱</FieldLabel>
              <Input id="user-email" type="email" autoComplete="off" placeholder="例如：name@example.com" aria-invalid={!!errors.email} {...form.register("email")} />
              <FieldDescription>登录用，建好后不能改。</FieldDescription>
              <FieldError errors={[errors.email]} />
            </Field>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="user-name">名字</FieldLabel>
              <Input id="user-name" autoComplete="off" placeholder="例如：张三" aria-invalid={!!errors.name} {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.title}>
              <FieldLabel htmlFor="user-title">职位（可选）</FieldLabel>
              <Input id="user-title" autoComplete="off" placeholder="可以不填" aria-invalid={!!errors.title} {...form.register("title")} />
              <FieldError errors={[errors.title]} />
            </Field>
            <Controller
              control={form.control}
              name="role"
              render={({ field }) => <RoleField value={field.value} onChange={field.onChange} />}
            />
            <Field data-invalid={!!errors.password}>
              <FieldLabel htmlFor="user-password">初始密码</FieldLabel>
              <PasswordInput
                id="user-password"
                invalid={!!errors.password}
                onRandom={() => form.setValue("password", randomPassword(), { shouldValidate: true, shouldDirty: true })}
                {...form.register("password")}
              />
              <FieldDescription>至少 {PASSWORD_MIN} 位。已经随机生成了一个，也可以自己改。</FieldDescription>
              <FieldError errors={[errors.password]} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={create.isPending}>
              {create.isPending && <Spinner data-icon="inline-start" />}
              新建用户
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------- 编辑用户 ----------

type EditForm = { id: string; name: string; title: string; role: Role }

export function EditUserDialog({ user, isSelf, onClose }: { user: UserAccount; isSelf: boolean; onClose: () => void }) {
  const form = useForm<EditForm>({
    resolver: zodResolver(userUpdateSchema),
    defaultValues: { id: user.id, name: user.name, title: user.title, role: user.isAdmin ? "admin" : "user" },
  })
  const { errors } = form.formState
  const update = useAction(trpc.users.update.mutationOptions(), { success: "已保存" })
  // 自己是主管时不能把自己改成员工（后端也会拒绝），直接锁住角色
  const lockRole = isSelf && user.isAdmin

  const submit = form.handleSubmit(async (values) => {
    if (await update.submit(values)) onClose()
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>编辑「{user.name}」</DialogTitle>
            <DialogDescription>邮箱是登录用的，不能改。</DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="user-edit-name">名字</FieldLabel>
              <Input id="user-edit-name" autoComplete="off" aria-invalid={!!errors.name} {...form.register("name")} />
              <FieldError errors={[errors.name]} />
            </Field>
            <Field data-invalid={!!errors.title}>
              <FieldLabel htmlFor="user-edit-title">职位（可选）</FieldLabel>
              <Input id="user-edit-title" autoComplete="off" aria-invalid={!!errors.title} {...form.register("title")} />
              <FieldError errors={[errors.title]} />
            </Field>
            <Controller
              control={form.control}
              name="role"
              render={({ field }) => (
                <RoleField
                  value={field.value}
                  onChange={field.onChange}
                  disabled={lockRole}
                  note={lockRole ? "不能取消自己的主管身份，要改请另一位主管来改。" : undefined}
                />
              )}
            />
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={update.isPending}>
              {update.isPending && <Spinner data-icon="inline-start" />}
              保存
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

// ---------- 重置密码 ----------

type ResetForm = { id: string; password: string }

export function ResetPasswordDialog({ user, isSelf, onClose }: { user: UserAccount; isSelf: boolean; onClose: () => void }) {
  const form = useForm<ResetForm>({
    resolver: zodResolver(userResetPasswordSchema),
    defaultValues: { id: user.id, password: randomPassword() },
  })
  const { errors } = form.formState
  const reset = useAction(trpc.users.resetPassword.mutationOptions())

  const submit = form.handleSubmit(async (values) => {
    if (!(await reset.submit(values))) return
    toast.add({
      title: `已重置「${user.name}」的密码`,
      description: isSelf ? "下次登录用新密码。" : "把新密码告诉本人，登录后让他在用户菜单里修改。",
      type: "success",
      timeout: 10000,
    })
    onClose()
  })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>重置「{user.name}」的密码</DialogTitle>
            <DialogDescription>
              {isSelf
                ? "改自己的密码更建议用用户菜单里的「修改密码」。"
                : "重置后旧密码不能再用，他已登录的设备会立刻退出，要用新密码重新登录。"}
            </DialogDescription>
          </DialogHeader>
          <FieldGroup>
            <Field data-invalid={!!errors.password}>
              <FieldLabel htmlFor="user-reset-password">新密码</FieldLabel>
              <PasswordInput
                id="user-reset-password"
                invalid={!!errors.password}
                onRandom={() => form.setValue("password", randomPassword(), { shouldValidate: true, shouldDirty: true })}
                {...form.register("password")}
              />
              <FieldDescription>至少 {PASSWORD_MIN} 位。已经随机生成了一个，也可以自己改。</FieldDescription>
              <FieldError errors={[errors.password]} />
            </Field>
          </FieldGroup>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" />}>取消</DialogClose>
            <Button type="submit" disabled={reset.isPending}>
              {reset.isPending && <Spinner data-icon="inline-start" />}
              重置密码
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
