// 任务弹窗「用哪些」里的「流程」（docs/dev/routine-library.md 6.1、9.2）：选项是流程库里在用的流程（routineLibrary.list 的 listed，
// 编辑时原来选着的停用、撤下的也列出来），提示写「什么时候用」（列表里的 summary）。选的存进同一个 toolIds（routine.<短名>），界面上和工具分开显示。
// 选了一个流程，自动勾上它要的工具（requires.toolIds，只对选了的取 routineLibrary.get），下面一行写「流程『…』要：浏览器（已帮你选上）」；
// 要打开的开关（允许直接调网站接口、允许看画面）也写在这一行，不自动打开，由人决定。后端保存时不拦（6.1），统一在开始运行时判断。
import * as React from "react"
import { useWatch, type UseFormReturn } from "react-hook-form"
import { isRoutineToolId, missingRoutineRequires, routineBrowserFlagLabel, routineLibraryStatusLabel, type TaskInput } from "@heyagent/shared"

import { useRoutineLibraryQuery, useToolName } from "@/lib/data"
import { useLibraryDetails } from "@/pages/routines/parts"

import { MultiPick } from "./multi-pick"

export function RoutinePick({ form, initialToolIds }: { form: UseFormReturn<TaskInput>; initialToolIds: string[] }) {
  const toolName = useToolName()
  const library = useRoutineLibraryQuery()
  const [toolIds, allowBrowserFetch, allowBrowserVision] = useWatch({ control: form.control, name: ["toolIds", "allowBrowserFetch", "allowBrowserVision"] })
  const chosen = React.useMemo(() => (toolIds ?? []).filter(isRoutineToolId), [toolIds])
  const entries = (library.data ?? []).filter((entry) => entry.status === "listed" || chosen.includes(entry.toolId))
  // 要的工具只在详情里：只取选了的
  const details = useLibraryDetails(entries.filter((entry) => chosen.includes(entry.toolId)).map((entry) => entry.routineId))
  // 打开弹窗时已经选着的不再自动补工具（人可能故意没选）；这次新选的，取到要的工具后补上一次
  const applied = React.useRef(new Set(initialToolIds.filter(isRoutineToolId)))

  React.useEffect(() => {
    for (const toolId of chosen) {
      if (applied.current.has(toolId)) continue
      const entry = entries.find((each) => each.toolId === toolId)
      const detail = entry && details.get(entry.routineId)
      if (!detail) continue
      applied.current.add(toolId)
      const current = form.getValues("toolIds") ?? []
      const missing = detail.requires.toolIds.filter((id) => !current.includes(id))
      if (missing.length) form.setValue("toolIds", [...current, ...missing], { shouldDirty: true })
    }
  }, [chosen, entries, details, form])

  const options = entries.map((entry) => ({
    value: entry.toolId,
    label: entry.status === "listed" ? entry.title : `${entry.title}（${routineLibraryStatusLabel[entry.status]}）`,
    hint: entry.summary || `${entry.toolId} · 第 ${entry.publishedVersion} 版`,
  }))
  const notes = chosen.flatMap((toolId) => {
    const entry = entries.find((each) => each.toolId === toolId)
    if (!entry) return [`「${toolId}」流程库里没有了，运行时用不了`]
    if (entry.status !== "listed") return [`流程「${entry.title}」${routineLibraryStatusLabel[entry.status]}了，运行时用不了`]
    const detail = details.get(entry.routineId)
    if (!detail) return []
    const { requires } = detail
    const missing = missingRoutineRequires(requires, { toolIds: toolIds ?? [], allowBrowserFetch: Boolean(allowBrowserFetch), allowBrowserVision: Boolean(allowBrowserVision) })
    const parts: string[] = []
    if (requires.toolIds.length) {
      const names = requires.toolIds.map(toolName).join("、")
      parts.push(
        missing.toolIds.length
          ? `${names}，还没选${missing.toolIds.map((id) => `「${toolName(id)}」`).join("、")}（不选运行时用不了它）`
          : `${names}（${requires.toolIds.some((id) => !initialToolIds.includes(id)) ? "已帮你选上" : "已选"}）`
      )
    }
    for (const flag of missing.browser) parts.push(`还要在「浏览器」里打开「${routineBrowserFlagLabel[flag]}」`)
    return parts.length ? [`流程「${entry.title}」要：${parts.join("；")}`] : []
  })

  return (
    <MultiPick
      id="task-routines"
      label="流程"
      options={options}
      value={chosen}
      onChange={(next) => form.setValue("toolIds", [...(form.getValues("toolIds") ?? []).filter((id) => !isRoutineToolId(id)), ...next], { shouldDirty: true })}
      description={
        library.isError
          ? "流程库没取到，现在选不了流程。"
          : "流程库里固化好的流程：agent 一次调用跑完一段固定操作，几秒拿回结果。选了会自动带上它要的工具。"
      }
      notes={notes}
    />
  )
}
