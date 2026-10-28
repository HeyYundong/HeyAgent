// 「API 密钥」分区：外部系统调图库的 HTTP 接口和 MCP、派活接口（派活第三期，POST /api/work-items）时带的密钥（Authorization: Bearer <密钥>），可以有多把，各自删。
// 库里只存哈希，页面只看到尾号；原文只在新建那一刻显示一次。用密钥做的事算在建它的人头上。
import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { zodResolver } from "@hookform/resolvers/zod"
import { KeyRoundIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { useForm } from "react-hook-form"
import { apiKeyCreateSchema, fmtDateTime, type ApiKey, type ApiKeyCreateInput } from "@heyagent/shared"

import { DetailSection, HelpTip } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton } from "@/components/ui/code-block"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldError, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"

import { useStaffName } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

export function ApiKeysSection() {
  const keysQuery = useQuery(trpc.apiKeys.list.queryOptions())
  const keys = keysQuery.data ?? []
  const staffName = useStaffName()
  const [creating, setCreating] = React.useState(false)
  const [revealed, setRevealed] = React.useState<{ name: string; key: string } | null>(null)
  const [deleting, setDeleting] = React.useState<ApiKey | null>(null)
  const remove = useAction(trpc.apiKeys.delete.mutationOptions({ onSuccess: () => setDeleting(null) }), { success: "密钥已删除，用它的外部系统马上就调不通了" })

  return (
    <DetailSection
      title="API 密钥"
      description="外部系统（别的业务系统、脚本、Claude Desktop 之类的 MCP 客户端）调图库的 HTTP 接口和 MCP、派活接口时带的密钥。用密钥做的事都算在建它的人头上。派活只能派给打开了「外部系统能派活」的任务。"
      action={
        <Button size="sm" variant="outline" onClick={() => setCreating(true)}>
          <PlusIcon data-icon="inline-start" />
          新建密钥
        </Button>
      }
    >
      {keysQuery.isPending ? (
        <Spinner />
      ) : keys.length === 0 ? (
        <p className="text-muted-foreground">还没有密钥。没有密钥时，外部系统只能登录以后调。</p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>名字</TableHead>
              <TableHead>尾号</TableHead>
              <TableHead>建的人</TableHead>
              <TableHead>最近用过</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {keys.map((key) => (
              <TableRow key={key.id}>
                <TableCell>{key.name}</TableCell>
                <TableCell className="font-mono">{key.hint}</TableCell>
                <TableCell>
                  {staffName(key.createdById)}
                  <div className="text-xs text-muted-foreground">{fmtDateTime(key.createdAt)}</div>
                </TableCell>
                <TableCell>{key.lastUsedAt ? fmtDateTime(key.lastUsedAt) : <span className="text-muted-foreground">还没用过</span>}</TableCell>
                <TableCell className="text-right">
                  <Button variant="ghost" size="icon-sm" aria-label={`删除密钥 ${key.name}`} onClick={() => setDeleting(key)}>
                    <Trash2Icon />
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}

      {creating && (
        <CreateDialog
          onClose={() => setCreating(false)}
          onCreated={(created) => {
            setCreating(false)
            setRevealed(created)
          }}
        />
      )}
      {revealed && <RevealDialog name={revealed.name} apiKey={revealed.key} onClose={() => setRevealed(null)} />}
      <AlertDialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除密钥「{deleting?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>删了立刻失效，还在用它（尾号 {deleting?.hint}）的外部系统会调不通。用它传过的图留着。不能撤销。</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>保留</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={remove.isPending} onClick={() => deleting && remove.mutate({ id: deleting.id })}>
              {remove.isPending && <Spinner data-icon="inline-start" />}
              确认删除
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailSection>
  )
}

type CreateForm = ApiKeyCreateInput

function CreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (created: { name: string; key: string }) => void }) {
  const form = useForm<CreateForm>({ resolver: zodResolver(apiKeyCreateSchema), defaultValues: { name: "" } })
  const { errors } = form.formState
  const create = useAction(trpc.apiKeys.create.mutationOptions())
  const submit = form.handleSubmit(async (values) => {
    const created = await create.submit(values)
    if (created) onCreated(created)
  })
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>新建 API 密钥</DialogTitle>
            <DialogDescription>给每个外部系统单独建一把，哪个不用了删哪个。</DialogDescription>
          </DialogHeader>
          <Field data-invalid={Boolean(errors.name)}>
            <FieldLabel htmlFor="api-key-name">名字</FieldLabel>
            <Input id="api-key-name" placeholder="例如：ERP 同步" aria-invalid={Boolean(errors.name)} {...form.register("name")} />
            <FieldError errors={[errors.name]} />
          </Field>
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

/** 新密钥只显示这一次：复制密钥，以及 HTTP 接口和 MCP 怎么用 */
function RevealDialog({ name, apiKey, onClose }: { name: string; apiKey: string; onClose: () => void }) {
  const origin = window.location.origin
  const curl = [
    `curl -X POST ${origin}/api/gallery/images \\`,
    `  -H "Authorization: Bearer ${apiKey}" \\`,
    `  -F image=@photo.jpg -F 'text={"名称": "…"}' -F 'tags=["标签"]'`,
    "",
    `curl -X POST ${origin}/api/gallery/search \\`,
    `  -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" \\`,
    `  -d '{"tags": ["标签"], "where": [{"path": "价格", "op": "lt", "value": 10}]}'`,
  ].join("\n")
  // 派活第三期（docs/dev/dispatch-p3.md 2.5 节）：派一张、用自己的编号查单。任务 id、参数名换成自己的
  const work = [
    `curl -X POST ${origin}/api/work-items \\`,
    `  -H "Authorization: Bearer ${apiKey}" -H "Content-Type: application/json" \\`,
    `  -d '{"task": "T-1042", "params": {"单号": "ORD-1018-0012"}, "priority": "high"}'`,
    "",
    `curl "${origin}/api/work-items?task=T-1042&key=ORD-1018-0012" \\`,
    `  -H "Authorization: Bearer ${apiKey}"`,
  ].join("\n")
  const mcp = `claude mcp add --transport http heyagent-gallery ${origin}/api/gallery/mcp --header "Authorization: Bearer ${apiKey}"`

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>密钥「{name}」已建好</DialogTitle>
          <DialogDescription>现在就复制下来交给外部系统。</DialogDescription>
        </DialogHeader>
        <div className="flex min-w-0 flex-col gap-4 text-sm">
          <Alert>
            <KeyRoundIcon />
            <AlertTitle>只显示这一次</AlertTitle>
            <AlertDescription>关掉后就看不到了，系统里只留尾号。丢了就删掉它再建一把。</AlertDescription>
          </Alert>
          <Code text={apiKey} label="复制密钥" />
          <p className="font-medium">HTTP 接口：传图、检索</p>
          <Code text={curl} label="复制示例命令" />
          <p className="flex items-center gap-1 font-medium">
            HTTP 接口：派活、查单
            <HelpTip>只能派给打开了「外部系统能派活」的任务（任务弹窗的「被派活」一组）。同一件事（去重参数一样，或者同一个 key）再派只返回已有的单，不会办两次。结果用 GET /api/work-items/单号 查，status、outcome、result 都在里面。</HelpTip>
          </p>
          <Code text={work} label="复制派活示例命令" />
          <p className="font-medium">MCP（Streamable HTTP）：例如加到 Claude Code</p>
          <Code text={mcp} label="复制 MCP 命令" />
        </div>
        <DialogFooter>
          <DialogClose render={<Button />}>我已经复制好了</DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Code({ text, label }: { text: string; label: string }) {
  return (
    <CodeBlock size="sm">
      <CodeBlockActions>
        <CodeBlockCopyButton value={text} aria-label={label} />
      </CodeBlockActions>
      <CodeBlockContent wrap className="break-all">
        {text}
      </CodeBlockContent>
    </CodeBlock>
  )
}
