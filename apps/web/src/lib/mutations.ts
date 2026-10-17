// 写操作（M1 P2 起接通）：tRPC mutation + TanStack Query 的 useMutation，统一处理三件事：
// - 成功后让所有查询重新拉（实时推送也会推，但自己先拉一次，页面马上看到变化）；
// - 出错时弹 toast，文案用后端给的中文说明（例如「正被 2 个任务选用：……」）；
// - submit()：表单里用，出错时不抛异常（toast 已经说了），返回 undefined，弹窗保持打开让人改。
import { useMutation, type UseMutationOptions } from "@tanstack/react-query"
import { TRPCClientError } from "@trpc/client"

import { toast } from "@/components/ui/toast"
import { queryClient } from "@/lib/trpc"

/** 把接口的报错变成一句给人看的话。输入校验失败时 tRPC 给的是 zod 的 issue 列表（JSON），取出里面的 message */
export function errorMessage(error: unknown): string {
  if (error instanceof TRPCClientError) {
    const message = String(error.message ?? "")
    if (message.trim().startsWith("[")) {
      try {
        const issues = JSON.parse(message) as { message?: string }[]
        const texts = [...new Set(issues.map((issue) => issue.message).filter(Boolean))]
        if (texts.length) return texts.join("；")
      } catch {
        // 不是 JSON，原样显示
      }
    }
    if (error.data?.code === "INTERNAL_SERVER_ERROR") return "服务器出错了，请稍后再试"
    return message || "操作没成功"
  }
  if (error instanceof Error && /fetch/i.test(error.message)) return "连不上服务器，请检查网络"
  return error instanceof Error ? error.message : "操作没成功"
}

/** 删掉没人用的规则、工具：不弹确认，toast 里给「撤销」（原型定的） */
export function toastWithUndo(title: string, onUndo: () => void) {
  const id = toast.add({
    title,
    type: "success",
    timeout: 8000,
    actionProps: {
      children: "撤销",
      onClick: () => {
        toast.close(id)
        onUndo()
      },
    },
  })
}

interface ActionOptions<TData, TVars> {
  /** 成功后的提示；返回 undefined 不提示 */
  success?: string | ((data: TData, vars: TVars) => string | undefined)
  /** 出错时 toast 的标题 */
  errorTitle?: string
}

export function useAction<TData, TError, TVars, TContext>(options: UseMutationOptions<TData, TError, TVars, TContext>, extra: ActionOptions<TData, TVars> = {}) {
  const mutation = useMutation({
    ...options,
    onSuccess: async (data, vars, ...rest) => {
      await queryClient.invalidateQueries()
      const message = typeof extra.success === "function" ? extra.success(data, vars) : extra.success
      if (message) toast.add({ title: message, type: "success" })
      await options.onSuccess?.(data, vars, ...rest)
    },
    onError: (error, vars, ...rest) => {
      toast.add({ title: extra.errorTitle ?? "没成功", description: errorMessage(error), type: "error" })
      options.onError?.(error, vars, ...rest)
    },
  })
  /** 表单提交用：成功返回结果，失败返回 undefined（已经弹了 toast） */
  const submit = (vars: TVars) => mutation.mutateAsync(vars).catch(() => undefined)
  return Object.assign(mutation, { submit })
}
