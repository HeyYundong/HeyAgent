// 页面常用的几样数据和由它们派生的小函数。查询结果由 TanStack Query 缓存，多个组件用同一个查询只发一次请求。
// 页面外框（PageFrame）先等这些查询拿到数据再渲染内容，所以内容里的 `?? []` 只是兜底，正常不会走到。
import { useQuery } from "@tanstack/react-query"
import {
  allModels,
  modelName,
  runNow,
  staffName,
  toolName,
  type HumanItem,
  type ModelDefaults,
  type ModelProvider,
  type SessionSummary,
} from "@heyagent/shared"

import { trpc } from "@/lib/trpc"

const EMPTY_MODELS: { providers: ModelProvider[]; defaults: ModelDefaults } = {
  providers: [],
  defaults: { run: "", plan: "", verify: "" },
}
const NO_ITEMS: HumanItem[] = []

export const useStaffQuery = () => useQuery(trpc.staff.list.queryOptions())
export const useTasksQuery = () => useQuery(trpc.tasks.list.queryOptions())
/** 全部运行的摘要（不带过程） */
export const useSessionsQuery = () => useQuery(trpc.sessions.list.queryOptions())
/** 一次运行的全部过程（带工具的输入、输出）：sessions.list 只有摘要，看过程时才按 id 取。实时推送只让这一个 id 的失效 */
export const useSessionQuery = (id: string | undefined, enabled = true) =>
  useQuery(trpc.sessions.get.queryOptions({ id: id ?? "" }, { enabled: Boolean(id) && enabled }))
export const useBoardQuery = () => useQuery(trpc.todos.board.queryOptions())
export const useMemoriesQuery = () => useQuery(trpc.memories.list.queryOptions())
export const useSkillsQuery = () => useQuery(trpc.skills.list.queryOptions())
export const useRulesQuery = () => useQuery(trpc.rules.list.queryOptions())
export const useToolsQuery = () => useQuery(trpc.tools.list.queryOptions())
export const useBrowsersQuery = () => useQuery(trpc.browsers.list.queryOptions())
export const useDesktopsQuery = () => useQuery(trpc.desktops.list.queryOptions())
export const usePlatformsQuery = () => useQuery(trpc.platforms.list.queryOptions())
export const useModelsQuery = () => useQuery(trpc.models.overview.queryOptions())

/** 按 id 显示人名（原型 staffName(id)） */
export function useStaffName() {
  const staff = useStaffQuery().data
  return (id: string | undefined) => staffName(staff ?? [], id)
}

/** 按 id 显示工具名（原型 toolName(id)） */
export function useToolName() {
  const tools = useToolsQuery().data?.tools
  return (id: string) => toolName(tools ?? [], id)
}

/** 模型服务和默认模型，加上按 id 显示模型名（原型 modelName(id)） */
export function useModels() {
  const overview = useModelsQuery().data ?? EMPTY_MODELS
  const models = allModels(overview.providers)
  return { ...overview, models, modelName: (id: string | undefined) => modelName(models, id) }
}

/** 还没处理的「要人办的事」 */
export function useHumanItems() {
  return useBoardQuery().data?.humanItems ?? NO_ITEMS
}

/** 一次运行此刻的一句话（原型 tasks/parts.tsx 的 runNow(run)）：要用到「要人办的事」和人名 */
export function useRunNow() {
  const humanItems = useHumanItems()
  const staff = useStaffQuery().data
  return (run: SessionSummary) => runNow(run, humanItems, staff ?? [])
}
