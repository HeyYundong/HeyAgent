// 「打开 Chrome 登录」（m2.md 第 8 条）：服务器上起一个不挂 session 的 Chrome，装上这个配置的登录态，人在远程画面里登录。
// - 保存登录状态：整份导出、替换保险箱（版本号 +1），再探测账号；
// - 关闭：不保存。关弹窗（右上角、Esc）也等于关闭。
// 浏览器页和「登录」类要人办的事（Chrome 过了保留时间时）都用这里。
import * as React from "react"
import { LogInIcon, SaveIcon } from "lucide-react"

import { RemoteViewDialog } from "@/components/remote-view/remote-view-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import type { SaveLoginResult } from "@heyagent/shared"

import { useAction } from "@/lib/mutations"
import { trpc } from "@/lib/trpc"

export interface LoginTarget {
  profileId: string
  accountId?: string
}

/** 起一个登录用的 Chrome。返回 open(target) 和起好以后的 browserId */
export function useOpenLogin() {
  const [opened, setOpened] = React.useState<{ browserId: string; target: LoginTarget } | null>(null)
  const open = useAction(trpc.browser.openForLogin.mutationOptions(), { errorTitle: "没能打开 Chrome" })
  return {
    opened,
    pending: open.isPending,
    pendingTarget: open.isPending ? open.variables : undefined,
    start: async (target: LoginTarget) => {
      const result = await open.submit(target)
      if (result) setOpened({ browserId: result.browserId, target })
    },
    /** 已经开着的登录 Chrome（浏览器页「开着的 Chrome」里点的） */
    show: (browserId: string, target: LoginTarget) => setOpened({ browserId, target }),
    clear: () => setOpened(null),
  }
}

function savedText(result: SaveLoginResult, accountName: (id: string) => string) {
  const probes = result.accounts.map((account) => `${accountName(account.accountId)}：${account.ok ? "已登录" : `没通过（${account.detail}）`}`)
  return [`保险箱 v${result.vaultVersion}，${result.cookieCount} 个 cookie。`, ...probes].join("\n")
}

interface LoginBrowserDialogProps {
  browserId: string
  title: string
  description?: React.ReactNode
  /** 账号 id → 给人看的名字（探测结果里用） */
  accountName: (accountId: string) => string
  onClose: () => void
  /** 保存成功以后（例如回到要人办的事里点「已处理好了」） */
  onSaved?: (result: SaveLoginResult) => void
}

export function LoginBrowserDialog({ browserId, title, description, accountName, onClose, onSaved }: LoginBrowserDialogProps) {
  const [saved, setSaved] = React.useState(false)
  const [gone, setGone] = React.useState(false)
  const save = useAction(trpc.browser.saveLogin.mutationOptions(), { errorTitle: "登录状态没保存上" })
  const close = useAction(trpc.browser.close.mutationOptions(), { errorTitle: "Chrome 没关上" })

  async function saveLogin() {
    const result = await save.submit({ browserId })
    if (!result) return
    setSaved(true)
    const allOk = result.accounts.every((account) => account.ok)
    toast.add({ title: allOk ? "登录状态已保存" : "已保存，但有账号探测没通过", description: savedText(result, accountName), type: allOk ? "success" : "warning", timeout: 10_000 })
    onSaved?.(result)
  }

  async function closeBrowser() {
    // 已经关了（空闲超时）就不用再调
    if (!gone) await close.submit({ browserId })
    onClose()
  }

  return (
    <RemoteViewDialog
      open
      browserId={browserId}
      title={title}
      description={description}
      onOpenChange={(open) => !open && void closeBrowser()}
      onClosed={() => setGone(true)}
      footer={
        <>
          <p className="text-xs text-muted-foreground sm:mr-auto">
            {saved ? "已保存。还可以接着操作，再保存一次会覆盖。" : "登录好以后点「保存登录状态」，整份登录态替换进保险箱；直接关闭就不保存。空闲 30 分钟会自动关掉。"}
          </p>
          <Button variant="outline" disabled={close.isPending} onClick={() => void closeBrowser()}>
            {close.isPending && <Spinner data-icon="inline-start" />}
            {saved ? "关闭" : "不保存，关闭"}
          </Button>
          <Button disabled={save.isPending || gone} onClick={() => void saveLogin()}>
            {save.isPending ? <Spinner data-icon="inline-start" /> : <SaveIcon data-icon="inline-start" />}
            保存登录状态
          </Button>
        </>
      }
    />
  )
}

/** 「打开 Chrome 登录」按钮：起 Chrome 时转圈 */
export function OpenLoginButton({ pending, label = "打开 Chrome 登录", size = "default", variant = "default", onClick }: {
  pending: boolean
  label?: string
  size?: "sm" | "default"
  variant?: "default" | "outline"
  onClick: () => void
}) {
  return (
    <Button size={size} variant={variant} disabled={pending} onClick={onClick}>
      {pending ? <Spinner data-icon="inline-start" /> : <LogInIcon data-icon="inline-start" />}
      {pending ? "正在打开 Chrome…" : label}
    </Button>
  )
}
