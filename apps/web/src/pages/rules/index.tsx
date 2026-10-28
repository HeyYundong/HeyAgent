// 规则 v3：没有全局开关、没有阶段。规则 = 名称 + 一句话触发条件 + 命中后怎么办 + 会调用的工具，
// 建任务时在「用哪些」里手动选上才生效。
// M3：保存后翻译成程序能执行的结构，显示「系统理解为……」，主管确认后才生效（compile.tsx）；没生效的建任务时选不了。
// 删除（原型定的）：没人用的直接删，不弹确认，toast 里可以撤销；被任务用着的不能删，弹窗说清楚被哪些任务用着。
import * as React from "react"
import { EllipsisIcon, PencilIcon, PlusIcon, ScrollTextIcon, Trash2Icon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogCancel, AlertDialogContent } from "@/components/ui/alert-dialog"
import { AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { can, findById, isRoutineToolId, riskLabel, tasksUsing, toolSourceLabel } from "@heyagent/shared"

import { useRoutineLibraryQuery, useRulesQuery, useTasksQuery, useToolName, useToolsQuery } from "@/lib/data"
import { toastWithUndo, useAction } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { trpc } from "@/lib/trpc"
import { useMe } from "@/lib/session"

import { CompileBody, RuleStatusBadge, compileOf } from "./compile"
import { RuleDialog } from "./rule-dialog"

const LINK = "underline underline-offset-4 hover:text-muted-foreground"

export default function RulesPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  const { params } = useRoute()
  const toolName = useToolName()
  const rulesQuery = useRulesQuery()
  const tasksQuery = useTasksQuery()
  const toolsQuery = useToolsQuery()
  const queries = [rulesQuery, tasksQuery, toolsQuery]
  const list = rulesQuery.data ?? []
  const tasks = tasksQuery.data ?? []
  const tools = toolsQuery.data?.tools ?? []
  const library = useRoutineLibraryQuery().data ?? []
  const [dialog, setDialog] = React.useState<"new" | "edit" | null>(null)
  const [blocked, setBlocked] = React.useState(false)

  const selected = findById(list, params.get("id"))
  const usedBy = selected ? tasksUsing(tasks, "ruleIds", selected.id) : []
  const restore = useAction(trpc.rules.restore.mutationOptions(), { success: (_data, rule) => `已恢复规则「${rule.name}」` })
  const del = useAction(
    trpc.rules.delete.mutationOptions({
      onSuccess: (rule) => {
        setParams({ id: null })
        toastWithUndo(`已删除规则「${rule.name}」`, () => restore.mutate(rule))
      },
    })
  )

  function remove() {
    if (!selected) return
    // 被任务用着的不能删：说清楚是哪些任务（后端也会拦）
    if (usedBy.length > 0) setBlocked(true)
    else del.mutate({ id: selected.id })
  }

  return (
    <>
      <PageFrame
        queries={queries}
        isEmpty={list.length === 0}
        header={
          <SimpleHeader
            title="规则"
            description="agent 干活时必须守的规矩：一句话写好，系统翻译成程序执行，主管确认后生效。建任务时选上哪条，那个任务就守哪条。"
            learnId="rules"
            action={
              isAdmin && list.length > 0 && (
                <Button onClick={() => setDialog("new")}>
                  <PlusIcon data-icon="inline-start" />
                  新建规则
                </Button>
              )
            }
          />
        }
        empty={
          <EmptyState
            icon={<ScrollTextIcon />}
            title="还没有规则"
            description={
              isAdmin
                ? "规则用一句话写清「什么时候起作用」和「命中后怎么办」，例如对外发消息前先让负责人确认。点下面新建第一条。"
                : "还没有规则。规则由主管新建，建任务时选上才生效。"
            }
            action={
              isAdmin && (
                <Button onClick={() => setDialog("new")}>
                  <PlusIcon data-icon="inline-start" />
                  新建规则
                </Button>
              )
            }
          />
        }
      >
        <MasterDetail
          hasSelection={!!selected}
          list={
            <PickGroup label={`共 ${list.length} 条规则`}>
              {list.map((rule) => {
                const count = tasksUsing(tasks, "ruleIds", rule.id).length
                return (
                  <PickItem
                    key={rule.id}
                    to={href("rules", { id: rule.id })}
                    selected={rule.id === selected?.id}
                    title={rule.name}
                    description={`${count > 0 ? `${count} 个任务选用` : "没人选用"} · ${compileOf(rule).understood ?? rule.trigger}`}
                    badge={<RuleStatusBadge rule={rule} />}
                  />
                )
              })}
            </PickGroup>
          }
          detail={
            selected && (
              <DetailPanel
                title={selected.name}
                badges={<RuleStatusBadge rule={selected} />}
                meta={usedBy.length > 0 ? `被 ${usedBy.length} 个任务选用 · 只对选了它的任务生效` : "建任务时在「用哪些 → 规则」里选上它才生效"}
                actions={
                  isAdmin && (
                    <>
                      <Button variant="outline" onClick={() => setDialog("edit")}>
                        <PencilIcon data-icon="inline-start" />
                        编辑
                      </Button>
                      <DropdownMenu>
                        <DropdownMenuTrigger
                          render={<Button variant="ghost" size="icon" aria-label="更多操作" />}
                        >
                          <EllipsisIcon />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end">
                          <DropdownMenuItem variant="destructive" onClick={remove}>
                            <Trash2Icon />
                            删除
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </>
                  )
                }
              >
                <DetailSection
                  title="系统理解为"
                  description="一句话翻译成程序能执行的规则，人确认后生效。运行时程序照它执行，agent 绕不过；翻译不进去的不会生效，也不会交给 agent 自己判断。"
                >
                  <CompileBody rule={selected} canManage={isAdmin} />
                </DetailSection>

                <DetailSection title="原文" description="主管写的那句话。改了文字要重新翻译、确认。">
                  <dl className="flex flex-col gap-3">
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">触发条件</dt>
                      <dd>{selected.trigger}</dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">命中后怎么办</dt>
                      <dd>{selected.action}</dd>
                    </div>
                    <div className="flex flex-col gap-1">
                      <dt className="text-muted-foreground">提到的工具</dt>
                      <dd>
                        {selected.toolIds.length === 0 ? (
                          <span className="text-muted-foreground">没指定。翻译时按文字里写的工具名找。</span>
                        ) : (
                          <ul className="flex flex-col gap-2">
                            {selected.toolIds.map((id) => {
                              const tool = findById(tools, id)
                              // 库流程链到流程页（工具页不列它）
                              const routine = isRoutineToolId(id) ? library.find((entry) => entry.toolId === id) : undefined
                              return (
                                <li key={id} className="flex flex-wrap items-center gap-2">
                                  <a href={routine ? href("routines", { id: routine.routineId }) : isRoutineToolId(id) ? href("routines") : href("tools", { id })} className={LINK}>
                                    {toolName(id)}
                                  </a>
                                  {isRoutineToolId(id) && <Badge variant="secondary">{toolSourceLabel.routine}</Badge>}
                                  {tool && <Badge variant="outline">{riskLabel[tool.risk]}</Badge>}
                                  {tool && <span className="text-muted-foreground">{tool.summary}</span>}
                                </li>
                              )
                            })}
                          </ul>
                        )}
                      </dd>
                    </div>
                  </dl>
                </DetailSection>

                <DetailSection
                  title="哪些任务选用了"
                  description="要让别的任务也守这条规则，去任务里编辑「用哪些 → 规则」。只有已经生效的规则能选。"
                >
                  {usedBy.length === 0 ? (
                    <p className="text-muted-foreground">还没有任务选用，这条规则现在不管任何事。</p>
                  ) : (
                    <ul className="flex flex-col gap-1">
                      {usedBy.map((task) => (
                        <li key={task.id} className="flex gap-2">
                          <span className="shrink-0 text-muted-foreground">{task.id}</span>
                          <span>
                            <a href={href("tasks", { id: task.id })} className={LINK}>{task.title}</a>
                            {!task.enabled && <Badge variant="ghost">未启动</Badge>}
                          </span>
                        </li>
                      ))}
                    </ul>
                  )}
                  {usedBy.length > 0 && !compileOf(selected).effective && (
                    <p className="mt-2 text-xs text-muted-foreground">这条规则还没生效，这些任务运行时不执行它（运行开始时会在过程里写明）。</p>
                  )}
                </DetailSection>
              </DetailPanel>
            )
          }
        />
      </PageFrame>
      {dialog && (
        <RuleDialog
          rule={dialog === "edit" ? selected : undefined}
          onClose={() => setDialog(null)}
        />
      )}

      <AlertDialog open={blocked} onOpenChange={setBlocked}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>规则「{selected?.name}」正在被使用，不能删除</AlertDialogTitle>
            <AlertDialogDescription>
              有 {usedBy.length} 个任务选用了它：{usedBy.map((task) => `${task.id}「${task.title}」`).join("、")}。
              先到这些任务里编辑「用哪些 → 规则」把它去掉，再回来删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>知道了</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
