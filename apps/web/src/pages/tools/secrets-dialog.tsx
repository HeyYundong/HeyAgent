// 密钥：HTTP 接口模板里的 {{名字}}。新建、换值、删除；值只加密存在服务器上，任何页面都看不到原文。
// 还有工具模板引用的密钥删不了（后端拦，toast 说明被哪些工具用着）。
import * as React from "react"
import { zodResolver } from "@hookform/resolvers/zod"
import { useForm } from "react-hook-form"
import { KeyRoundIcon, PencilIcon, Trash2Icon } from "lucide-react"
import { fmtShort, secretInputSchema, templatePlaceholders, type SavedSecret, type Tool } from "@heyagent/shared"

import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel, FieldSeparator } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import { Spinner } from "@/components/ui/spinner"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

type SecretForm = { name: string; value: string }

/** 哪些 HTTP 工具的模板用了这个密钥 */
function usedBy(tools: Tool[], name: string) {
  return tools.filter((tool) => tool.http && templatePlaceholders(`${tool.http.url} ${JSON.stringify(tool.http.headers ?? {})} ${tool.http.body ?? ""}`).secrets.includes(name))
}

export function SecretsDialog({ saved, tools, onClose }: { saved: Record<string, SavedSecret>; tools: Tool[]; onClose: () => void }) {
  const names = Object.keys(saved).sort()
  const [changing, setChanging] = React.useState<string | null>(null)
  const [removing, setRemoving] = React.useState<string | null>(null)
  const remove = useAction(trpc.tools.deleteSecret.mutationOptions(), { success: (_data, vars) => `已删除密钥 ${vars.name}` })

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>密钥</DialogTitle>
          <DialogDescription>HTTP 接口模板里写 {"{{名字}}"}，执行时才换成这里存的值。值只加密存在服务器上，模型和页面都看不到原文。</DialogDescription>
        </DialogHeader>
        {names.length === 0 ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon"><KeyRoundIcon /></EmptyMedia>
              <EmptyDescription>还没有密钥。在下面新建，或者接入 HTTP 接口时填。</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-1">
            {names.map((name) => {
              const users = usedBy(tools, name)
              return (
                <Item key={name} size="sm" variant="outline" className="flex-wrap">
                  <ItemContent className="min-w-0">
                    <ItemTitle className="font-mono">{name}</ItemTitle>
                    <ItemDescription>
                      {saved[name]!.by} {fmtShort(saved[name]!.at)} 存的 · {users.length ? `${users.length} 个工具在用：${users.map((tool) => tool.name).join("、")}` : "没有工具在用"}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <Button variant="ghost" size="sm" onClick={() => setChanging(changing === name ? null : name)}><PencilIcon data-icon="inline-start" />换值</Button>
                    <Button variant="ghost" size="icon-sm" aria-label={`删除 ${name}`} onClick={() => setRemoving(name)}><Trash2Icon /></Button>
                  </ItemActions>
                  {changing === name && (
                    <div className="basis-full">
                      <SecretValueForm name={name} onDone={() => setChanging(null)} />
                    </div>
                  )}
                </Item>
              )
            })}
          </ItemGroup>
        )}
        <FieldSeparator />
        <NewSecretForm taken={names} />
        <AlertDialog open={removing !== null} onOpenChange={(open) => !open && setRemoving(null)}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>删除密钥 {removing}？</AlertDialogTitle>
              <AlertDialogDescription>
                {removing && usedBy(tools, removing).length
                  ? `还有工具的模板在用它（${usedBy(tools, removing).map((tool) => tool.name).join("、")}），先改掉这些工具，否则删不了。`
                  : "删除后值就没了，不能恢复。以后要用得重新填。"}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>先不删</AlertDialogCancel>
              <AlertDialogAction variant="destructive" onClick={() => removing && remove.mutate({ name: removing })}>删除密钥</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  )
}

/** 换一个已存密钥的值 */
function SecretValueForm({ name, onDone }: { name: string; onDone: () => void }) {
  const form = useForm<SecretForm>({ resolver: zodResolver(secretInputSchema), defaultValues: { name, value: "" } })
  const update = useAction(trpc.tools.updateSecret.mutationOptions(), { success: `已换掉 ${name} 的值` })
  const error = form.formState.errors.value
  const submit = form.handleSubmit(async (values) => {
    if (await update.submit(values)) onDone()
  })
  return (
    <form onSubmit={submit} className="flex items-start gap-2 pt-2">
      <Field data-invalid={!!error}>
        <Input type="password" aria-label={`${name} 的新值`} placeholder="填新的值" aria-invalid={!!error} {...form.register("value")} />
        <FieldError errors={[error]} />
      </Field>
      <Button type="submit" size="sm" disabled={update.isPending}>{update.isPending && <Spinner data-icon="inline-start" />}保存</Button>
    </form>
  )
}

function NewSecretForm({ taken }: { taken: string[] }) {
  const form = useForm<SecretForm>({ resolver: zodResolver(secretInputSchema), defaultValues: { name: "", value: "" } })
  const { errors } = form.formState
  const create = useAction(trpc.tools.createSecret.mutationOptions(), { success: (_data, vars) => `已存好密钥 ${vars.name}` })
  const submit = form.handleSubmit(async (values) => {
    if (taken.includes(values.name)) {
      form.setError("name", { message: "已经有这个名字了，要换值请点上面的「换值」" })
      return
    }
    if (await create.submit(values)) form.reset({ name: "", value: "" })
  })
  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <FieldGroup>
        <Field data-invalid={!!errors.name}>
          <FieldLabel htmlFor="secret-name">新建密钥</FieldLabel>
          <Input id="secret-name" className="font-mono" placeholder="例如 API_TOKEN" aria-invalid={!!errors.name} {...form.register("name", { setValueAs: (value: string) => value.trim().toUpperCase() })} />
          <FieldDescription>名字用大写字母、数字和下划线，模板里写成 {"{{API_TOKEN}}"}。</FieldDescription>
          <FieldError errors={[errors.name]} />
        </Field>
        <Field data-invalid={!!errors.value}>
          <FieldLabel htmlFor="secret-value">值</FieldLabel>
          <Input id="secret-value" type="password" placeholder="填真正的值" aria-invalid={!!errors.value} {...form.register("value")} />
          <FieldError errors={[errors.value]} />
        </Field>
      </FieldGroup>
      <Button type="submit" className="self-end" disabled={create.isPending}>
        {create.isPending && <Spinner data-icon="inline-start" />}
        存好密钥
      </Button>
    </form>
  )
}
