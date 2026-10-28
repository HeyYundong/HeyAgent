// 「外部事件令牌」分区：外部系统 POST /api/events 时带的令牌。
// 库里只存哈希，页面只能看到尾号；原文只在生成那一刻显示一次（弹窗关掉就看不到了）。
// 重新生成：旧令牌立刻失效（已有令牌时先二次确认）。停用：删掉令牌，外部事件一律拒绝。
import * as React from "react"
import { KeyRoundIcon, PowerOffIcon, RefreshCwIcon } from "lucide-react"
import { fmtDateTime, type SettingsView } from "@heyagent/shared"

import { DetailSection } from "@/components/shell/simple-page"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent } from "@/components/ui/alert-dialog"
import { AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton } from "@/components/ui/code-block"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Spinner } from "@/components/ui/spinner"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

type Confirm = "regenerate" | "clear" | null

export function TokenSection({ token }: { token: SettingsView["eventToken"] }) {
  const [confirm, setConfirm] = React.useState<Confirm>(null)
  /** 刚生成的令牌原文：只在这次弹窗里显示 */
  const [revealed, setRevealed] = React.useState<string | null>(null)
  const regenerate = useAction(trpc.settings.regenerateEventToken.mutationOptions())
  const clear = useAction(trpc.settings.clearEventToken.mutationOptions(), { success: "外部事件已停用，旧令牌不能再用" })

  async function generate() {
    const result = await regenerate.submit()
    if (!result) return
    setConfirm(null)
    setRevealed(result.token)
  }

  async function stop() {
    if (await clear.submit()) setConfirm(null)
  }

  return (
    <DetailSection
      title="外部事件令牌"
      description="别的系统发生了某件事（例如审批通过、文件处理完），可以发一个事件过来，叫醒正在等这个事件的待办。任务上配了「收到事件就派一张」的，事件来了会派单。发事件时要带这个令牌。"
      action={token && <Badge variant="outline">已生成</Badge>}
    >
      <div className="flex flex-col gap-3">
        {token ? (
          <p>
            已生成 · 尾号 <span className="font-mono">{token.hint}</span> · 生成于 {fmtDateTime(token.createdAt)}
          </p>
        ) : (
          <p className="text-muted-foreground">还没生成。没有令牌时，外部系统发来的事件一律拒绝。</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button
            variant={token ? "outline" : "default"}
            disabled={regenerate.isPending}
            onClick={() => (token ? setConfirm("regenerate") : void generate())}
          >
            {regenerate.isPending && !confirm ? <Spinner data-icon="inline-start" /> : token ? <RefreshCwIcon data-icon="inline-start" /> : <KeyRoundIcon data-icon="inline-start" />}
            生成新令牌
          </Button>
          {token && (
            <Button variant="ghost" onClick={() => setConfirm("clear")}>
              <PowerOffIcon data-icon="inline-start" />
              停用
            </Button>
          )}
        </div>
      </div>

      <AlertDialog open={confirm === "regenerate"} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>生成新令牌？</AlertDialogTitle>
            <AlertDialogDescription>
              旧令牌（尾号 {token?.hint}）会立刻失效，还在用旧令牌的外部系统发来的事件会被拒绝，要把新令牌换上去。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不换</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={regenerate.isPending} onClick={() => void generate()}>
              {regenerate.isPending && <Spinner data-icon="inline-start" />}
              让旧令牌失效并生成
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirm === "clear"} onOpenChange={(open) => !open && setConfirm(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>停用外部事件？</AlertDialogTitle>
            <AlertDialogDescription>
              令牌会被删掉，之后外部系统发来的事件一律拒绝；等事件的待办只能等到兜底天数到期提醒负责人。以后要用，再生成一个新令牌。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不停用</AlertDialogCancel>
            <AlertDialogAction variant="destructive" disabled={clear.isPending} onClick={() => void stop()}>
              {clear.isPending && <Spinner data-icon="inline-start" />}
              停用
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {revealed && <RevealDialog token={revealed} onClose={() => setRevealed(null)} />}
    </DetailSection>
  )
}

/** 新令牌只显示这一次：复制令牌，以及外部系统怎么调用 */
function RevealDialog({ token, onClose }: { token: string; onClose: () => void }) {
  const endpoint = `${window.location.origin}/api/events`
  const example = [
    `curl -X POST ${endpoint} \\`,
    `  -H "Authorization: Bearer ${token}" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '{"event": "事件名", "data": {"id": "12345"}}'`,
  ].join("\n")

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-11/12 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>新令牌已生成</DialogTitle>
          <DialogDescription>现在就复制下来交给外部系统。</DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-4 text-sm">
          <Alert>
            <KeyRoundIcon />
            <AlertTitle>只显示这一次</AlertTitle>
            <AlertDescription>关掉后就看不到了，系统里只留尾号。丢了只能重新生成，旧的跟着失效。</AlertDescription>
          </Alert>
          <Code text={token} label="复制令牌" />
          <div className="flex flex-col gap-2">
            <p className="font-medium">外部系统怎么用</p>
            <ul className="flex list-disc flex-col gap-1 pl-4 text-muted-foreground">
              <li>
                发 <span className="font-mono text-foreground">POST /api/events</span>
              </li>
              <li>
                请求头 <span className="font-mono text-foreground">Authorization: Bearer &lt;令牌&gt;</span>
              </li>
              <li>
                内容 <span className="font-mono text-foreground">{`{"event": "事件名", "data": {...}}`}</span>，事件名和待办里填的要等的事件对上
              </li>
            </ul>
            <Code text={example} label="复制示例命令" />
          </div>
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
