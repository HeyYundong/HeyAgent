// 流程库（docs/dev/routine-library.md 第 9 节）几处共用的小块：登记状态、一次调用的结局徽章，「要什么」的一句话，
// 选用它的任务这次用不用得了（任务详情、任务弹窗都用）。全部是 registry 组件（Badge）和 shared 的纯函数。
import { useQueries } from "@tanstack/react-query"
import { CircleCheckIcon, CircleMinusIcon, CirclePauseIcon, CircleStopIcon, CircleXIcon, Undo2Icon } from "lucide-react"
import {
  missingRoutineRequires,
  routineBrowserFlagLabel,
  routineCallResultLabel,
  routineLibraryStatusLabel,
  routineToolId,
  type RoutineCallResult,
  type RoutineLibraryDetail,
  type RoutineLibraryItem,
  type RoutineLibraryStatus,
  type RoutineRequires,
} from "@heyagent/shared"

import { Badge } from "@/components/ui/badge"
import { trpc } from "@/lib/trpc"

/** 登记状态：在库里 outline、停用 ghost、撤下 ghost（9.1） */
export function LibraryStatusBadge({ status }: { status: RoutineLibraryStatus }) {
  if (status === "listed") return <Badge variant="outline"><CircleCheckIcon data-icon="inline-start" />{routineLibraryStatusLabel.listed}</Badge>
  if (status === "paused") return <Badge variant="ghost"><CirclePauseIcon data-icon="inline-start" />{routineLibraryStatusLabel.paused}</Badge>
  return <Badge variant="ghost"><Undo2Icon data-icon="inline-start" />{routineLibraryStatusLabel.withdrawn}</Badge>
}

/** 一次调用的结局：办成 outline、没办成 secondary（查不到不算出错）、输入不对 outline、停下 destructive */
export function CallResultBadge({ result }: { result: RoutineCallResult }) {
  if (result === "achieved") return <Badge variant="outline"><CircleCheckIcon data-icon="inline-start" />{routineCallResultLabel.achieved}</Badge>
  if (result === "not_achieved") return <Badge variant="secondary"><CircleMinusIcon data-icon="inline-start" />{routineCallResultLabel.not_achieved}</Badge>
  if (result === "bad_input") return <Badge variant="outline"><CircleXIcon data-icon="inline-start" />{routineCallResultLabel.bad_input}</Badge>
  return <Badge variant="destructive"><CircleStopIcon data-icon="inline-start" />{routineCallResultLabel.stopped}</Badge>
}

/** 「6.2 秒」「1.4 分钟」 */
export function secondsText(ms: number | null | undefined) {
  if (ms === null || ms === undefined) return "—"
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} 秒`
  return `${(ms / 60_000).toFixed(1)} 分钟`
}

/** 任务里的一个库流程这次（下一次运行）用不用得了：不行写原因（停用、撤下、缺工具、缺开关），行就是 undefined */
export function unavailableReason(
  entry: Pick<RoutineLibraryItem, "status"> | undefined,
  detail: Pick<RoutineLibraryDetail, "requires" | "pausedReason"> | undefined,
  task: { toolIds: readonly string[]; allowBrowserFetch: boolean; allowBrowserVision: boolean },
  toolName: (id: string) => string
): string | undefined {
  if (!entry) return "流程库里没有它了"
  if (entry.status === "withdrawn") return "撤下了，新的运行用不了"
  if (entry.status === "paused") return `停用了${detail?.pausedReason ? `：${detail.pausedReason}` : ""}，新的运行用不了`
  if (!detail) return undefined
  const missing = missingRoutineRequires(detail.requires, task)
  const parts = [
    ...(missing.toolIds.length ? [`任务没选${missing.toolIds.map((id) => `「${toolName(id)}」`).join("、")}`] : []),
    ...missing.browser.map((flag) => `没打开「${routineBrowserFlagLabel[flag]}」`),
  ]
  return parts.length ? `${parts.join("，")}，新的运行用不了` : undefined
}

/** 要的工具、开关写成一句：「浏览器；要打开『允许直接调网站接口』；还调流程 routine.login_inbox」 */
export function requiresText(requires: RoutineRequires, toolName: (id: string) => string) {
  const flags = (["fetch", "vision"] as const).filter((flag) => requires.browser[flag])
  return [
    requires.toolIds.length ? requires.toolIds.map(toolName).join("、") : "不用别的工具",
    ...flags.map((flag) => `要打开「${routineBrowserFlagLabel[flag]}」`),
    ...(requires.routines.length ? [`还调流程 ${requires.routines.map(routineToolId).join("、")}`] : []),
  ].join("；")
}

/** 一组库流程的详情（要的工具在详情里）：任务弹窗、任务详情按选了哪几个取 */
export function useLibraryDetails(routineIds: string[]) {
  return useQueries({
    queries: routineIds.map((routineId) => trpc.routineLibrary.get.queryOptions({ routineId })),
    combine: (results) => {
      const map = new Map<string, RoutineLibraryDetail>()
      results.forEach((result, index) => result.data && map.set(routineIds[index]!, result.data))
      return map
    },
  })
}
