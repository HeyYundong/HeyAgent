// 规则 v3：没有全局开关、没有阶段。规则 = 名称 + 一句话触发条件 + 命中后怎么办 + 会调用的工具，
// 建任务时在「用哪些」里手动选上才生效。M0 只读：新建、编辑、删除照原型显示，真正提交时弹「只读阶段」提示。
import * as React from "react"
import { EllipsisIcon, PencilIcon, PlusIcon, ScrollTextIcon, Trash2Icon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent } from "@/components/ui/alert-dialog"
import { AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { can, findById, riskLabel, tasksUsing } from "@heyagent/shared"

import { useRulesQuery, useTasksQuery, useToolName, useToolsQuery } from "@/lib/data"
import { readOnlyToast } from "@/lib/readonly"
import { href, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"

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
  const [dialog, setDialog] = React.useState<"new" | "edit" | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  const selected = findById(list, params.get("id"))
  const usedBy = selected ? tasksUsing(tasks, "ruleIds", selected.id) : []

  function remove() {
    setConfirmDelete(false)
    readOnlyToast()
  }

  return (
    <PageFrame
      queries={queries}
      isEmpty={list.length === 0}
      header={
        <SimpleHeader
          title="规则"
          description="agent 干活时必须守的规矩。不会自动生效，建任务时选上哪条，那个任务就守哪条。"
          learnId="rules"
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
      empty={
        <EmptyState
          icon={<ScrollTextIcon />}
          title="还没有规则"
          description="规则用一句话写清「什么时候起作用」和「命中后怎么办」，例如给客户发消息前先让 AM 确认。"
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
                  description={
                    rule.toolIds.length > 0
                      ? `会调用：${rule.toolIds.map(toolName).join("、")}`
                      : "不调用工具，只拦下或提醒"
                  }
                  badge={
                    count > 0 ? (
                      <Badge variant="outline">{count} 个任务选用</Badge>
                    ) : (
                      <Badge variant="ghost">没人选用</Badge>
                    )
                  }
                />
              )
            })}
          </PickGroup>
        }
        detail={
          selected && (
            <DetailPanel
              title={selected.name}
              badges={
                usedBy.length === 0 && <Badge variant="outline">还没有任务选用</Badge>
              }
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
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() =>
                            usedBy.length > 0 ? setConfirmDelete(true) : remove()
                          }
                        >
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
                title="触发条件"
                description="agent 每走一步都会对照这句话，判断这条规则是不是该起作用了。"
              >
                <p>{selected.trigger}</p>
              </DetailSection>

              <DetailSection title="命中后怎么办">
                <p>{selected.action}</p>
              </DetailSection>

              <DetailSection title="会调用的工具" description="命中后，规则自己去调这些工具。">
                {selected.toolIds.length === 0 ? (
                  <p className="text-muted-foreground">不调用工具：只拦下或提醒 agent。</p>
                ) : (
                  <ul className="flex flex-col gap-2">
                    {selected.toolIds.map((id) => {
                      const tool = findById(tools, id)
                      return (
                        <li key={id} className="flex flex-wrap items-center gap-2">
                          <a href={href("tools", { id })} className={LINK}>
                            {toolName(id)}
                          </a>
                          {tool && <Badge variant="outline">{riskLabel[tool.risk]}</Badge>}
                          {tool && <span className="text-muted-foreground">{tool.summary}</span>}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </DetailSection>

              <DetailSection
                title="哪些任务选用了"
                description="要让别的任务也守这条规则，去任务里编辑「用哪些 → 规则」。"
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
              </DetailSection>
            </DetailPanel>
          )
        }
      />

      {dialog && (
        <RuleDialog
          rule={dialog === "edit" ? selected : undefined}
          onClose={() => setDialog(null)}
          onSave={readOnlyToast}
        />
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除规则「{selected?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              有 {usedBy.length} 个任务正在用它：{usedBy.map((task) => task.title).join("；")}。
              删除后这些任务不再守这条规则，已经在跑的运行也会立刻失去这层保护。删除后不能恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不删</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={remove}
            >
              删除规则
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageFrame>
  )
}
