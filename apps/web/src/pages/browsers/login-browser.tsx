// 「打开 Chrome」（m2.md 第 8 条）：服务器上起一个不挂 session 的 Chrome，装上这个配置的登录态，人在远程画面里登录。
// 关弹窗（右上角、Esc）就是保存：登录态合并进保险箱（谁最后写谁的算），再探测账号。空闲 30 分钟自动关，也会保存。
// 浏览器页和「登录」类要人办的事（Chrome 过了保留时间时）都用这里。
import * as React from "react"
import { LogInIcon } from "lucide-react"
import { useMutation } from "@tanstack/react-query"

import { RemoteViewDialog } from "@/components/remote-view/remote-view-dialog"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { toast } from "@/components/ui/toast"
import type { SaveLoginResult } from "@heyagent/shared"

import { errorMessage, useAction } from "@/lib/mutations"
import { queryClient, trpc } from "@/lib/trpc"

export interface LoginTarget {
  profileId: string
  accountId?: string
  /** 「立刻登录」没成功后交给人时：为什么没成功 */
  note?: string
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
}

export function LoginBrowserDialog({ browserId, title, description, accountName, onClose }: LoginBrowserDialogProps) {
  const [gone, setGone] = React.useState(false)
  const close = useMutation(trpc.browser.close.mutationOptions())

  /** 关就是保存：弹窗先关掉，保存和账号探测在后台做，结果用 toast 说 */
  async function closeBrowser() {
    onClose()
    // 已经关了（空闲超时，那时已经保存过）就不用再调
    if (gone) return
    const id = toast.add({ title: "正在保存登录状态…", type: "loading", timeout: 0 })
    try {
      const { saved } = await close.mutateAsync({ browserId })
      await queryClient.invalidateQueries()
      if (!saved) {
        toast.update(id, { title: "Chrome 已经关了", type: "info", timeout: 5000 })
        return
      }
      const allOk = saved.accounts.every((account) => account.ok)
      toast.update(id, { title: allOk ? "登录状态已保存" : "已保存，但有账号探测没通过", description: savedText(saved, accountName), type: allOk ? "success" : "warning", timeout: 10_000 })
    } catch (error) {
      toast.update(id, { title: "登录状态没保存上", description: errorMessage(error), type: "error", timeout: 10_000 })
    }
  }

  return (
    <RemoteViewDialog
      open
      browserId={browserId}
      title={title}
      description={description}
      onOpenChange={(open) => !open && void closeBrowser()}
      onClosed={() => setGone(true)}
    />
  )
}

/**
 * 「立刻登录」：worker 在后台开 Chrome，登录小 agent 用账号存的密码登录（要一会儿，toast 里转圈）。
 * 成功就已经存进保险箱；没成功时 Chrome 留着，交给 onHuman 打开远程画面让人接着登录。
 */
export function useAutoLogin(accountName: (accountId: string) => string, onHuman: (browserId: string, accountId: string, note: string) => void) {
  const mutation = useMutation(trpc.browser.autoLogin.mutationOptions())
  return {
    pendingAccountId: mutation.isPending ? mutation.variables?.accountId : undefined,
    start: async (accountId: string) => {
      const name = accountName(accountId)
      const id = toast.add({ title: `正在登录「${name}」…`, description: "agent 在后台打开登录网址，用存的密码登录", type: "loading", timeout: 0 })
      try {
        const result = await mutation.mutateAsync({ accountId })
        await queryClient.invalidateQueries()
        if (result.ok) {
          toast.update(id, { title: `「${name}」登录好了`, description: "登录态已存进保险箱，所有 agent 都能用", type: "success", timeout: 8000 })
          return
        }
        toast.update(id, { title: result.needHuman ? "要人处理，已打开 Chrome" : "自动登录没成功，已打开 Chrome", description: result.detail, type: "warning", timeout: 12_000 })
        if (result.browserId) onHuman(result.browserId, accountId, result.detail)
      } catch (error) {
        toast.update(id, { title: "自动登录没成功", description: errorMessage(error), type: "error", timeout: 12_000 })
      }
    },
  }
}

/** 「打开 Chrome」按钮：起 Chrome 时转圈 */
export function OpenLoginButton({ pending, label = "打开 Chrome", size = "default", variant = "default", onClick }: {
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
