// 记忆页（v3）：左边按「适用于」的分类分组，右边一条记忆的详情（标题卡 + 分区卡）。
// 只负责「看」和主管的「新建 / 编辑 / 归档 / 删除」；agent 提议的记忆在「待办」里审核（审核人也可以在这里直接批）。
// 被任务选用的记忆不能删（后端拦，页面先说明），归档前提醒哪些任务会读不到。
import * as React from "react"
import { BrainIcon, CheckIcon, EllipsisIcon, InboxIcon, ListChecksIcon, PencilIcon, PlusIcon, XIcon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState, MasterDetail } from "@/components/shell/simple-page"
import { PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent } from "@/components/ui/alert-dialog"
import { AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { can, evidenceLabel, findById, fmtDate, fmtDateTime, memoryCategory, memoryStatusLabel, tasksUsing } from "@heyagent/shared"
import type { MemoryRef, TaskDef } from "@heyagent/shared"

import { MarkdownView } from "@/components/markdown"
import { useMemoriesQuery, useStaffName, useStaffQuery, useTasksQuery } from "@/lib/data"
import { useAction } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { MemoryDialog } from "./memory-dialog"


// ---------- 文案 ----------

/** 「客户偏好 · Nova Home」→「Nova Home」；只有分类的返回空 */
function objectPart(appliesTo: string) {
  return appliesTo.split(" · ").slice(1).join(" · ")
}

type StaffName = (id: string | undefined) => string

/** 谁加的：「人工添加 · 王悦」或「agent 提议 · T-1024」 */
function who(memory: MemoryRef, staffName: StaffName) {
  const { source } = memory
  return source.kind === "human" ? `人工添加 · ${staffName(source.byId)}` : `agent 提议 · ${source.taskId}`
}

function sourceText(memory: MemoryRef, staffName: StaffName) {
  const { source } = memory
  if (source.kind === "human") return `${staffName(source.byId)} 手动添加，直接生效。`
  const reviewed = memory.status === "active" ? `，${staffName(memory.reviewerId)} 审核通过` : ""
  return `agent 在任务 ${source.taskId} 里根据${evidenceLabel[source.evidence]}提议${reviewed}。`
}

// ---------- 页面 ----------

export default function MemoryPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  const { params } = useRoute()
  const staffName = useStaffName()
  const memoriesQuery = useMemoriesQuery()
  const tasksQuery = useTasksQuery()
  const queries = [memoriesQuery, tasksQuery, useStaffQuery()]
  const items = memoriesQuery.data ?? []
  // 在弹窗里输入过的新「适用于」，页面内记住
  const [createdAppliesTo, setCreatedAppliesTo] = React.useState<string[]>([])
  // 正在编辑哪条；"new" 表示新建
  const [editing, setEditing] = React.useState<MemoryRef | "new" | null>(null)

  const visible = items.filter((m) => m.status === "active" || m.status === "pending")
  const selected = findById(visible, params.get("id"))
  const appliesToOptions = [...new Set([...items.map((m) => m.appliesTo), ...createdAppliesTo])].sort((a, b) => a.localeCompare(b, "zh"))
  // 分类完全来自数据（平台通用，代码里不写业务分类），按名字排
  const categories = [...new Set(visible.map((m) => memoryCategory(m.appliesTo)))].sort((a, b) => a.localeCompare(b, "zh"))

  const header = (
    <SimpleHeader
      title="记忆"
      description="agent 记住的经验和偏好。建任务时选用哪几条，运行开始时 agent 就读到哪几条。"
      learnId="memory"
      action={
        isAdmin && visible.length > 0 && (
          <Button onClick={() => setEditing("new")}>
            <PlusIcon data-icon="inline-start" />
            新建记忆
          </Button>
        )
      }
    />
  )

  return (
    <>
      <PageFrame
        header={header}
        queries={queries}
        isEmpty={visible.length === 0}
        empty={
          <EmptyState
            icon={<BrainIcon />}
            title="还没有记忆"
            description={
              isAdmin
                ? "记忆是 agent 要记住的经验和偏好。点下面新建一条；agent 在任务里学到的经验，审核通过后也会出现在这里。"
                : "还没有记忆。主管新建的、agent 学到并审核通过的经验会出现在这里。"
            }
            action={
              isAdmin && (
                <Button onClick={() => setEditing("new")}>
                  <PlusIcon data-icon="inline-start" />
                  新建记忆
                </Button>
              )
            }
          />
        }
      >
        <MasterDetail
          hasSelection={!!selected}
          list={categories.map((category) => {
            const group = visible.filter((m) => memoryCategory(m.appliesTo) === category)
            if (group.length === 0) return null
            return (
              <PickGroup key={category} label={`${category} · ${group.length}`}>
                {group.map((m) => (
                  <PickItem
                    key={m.id}
                    to={href("memory", { id: m.id })}
                    selected={m.id === selected?.id}
                    title={m.content}
                    description={objectPart(m.appliesTo) || who(m, staffName)}
                    badge={m.status === "pending" && <Badge>待审核</Badge>}
                  />
                ))}
              </PickGroup>
            )
          })}
          detail={
            selected ? (
              <MemoryDetail
                memory={selected}
                tasks={tasksQuery.data ?? []}
                isAdmin={isAdmin}
                canReview={!!selected.reviewerId && can(user, "humanItem.resolve", { assigneeId: selected.reviewerId })}
                onEdit={() => setEditing(selected)}
              />
            ) : null
          }
        />
      </PageFrame>
      <MemoryDialog
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        memory={editing === "new" ? undefined : (editing ?? undefined)}
        appliesToOptions={appliesToOptions}
        onCreateAppliesTo={(value) => setCreatedAppliesTo((list) => [...list, value])}
      />
    </>
  )
}

// ---------- 详情 ----------

function MemoryDetail({
  memory,
  tasks,
  isAdmin,
  canReview,
  onEdit,
}: {
  memory: MemoryRef
  tasks: TaskDef[]
  isAdmin: boolean
  canReview: boolean
  onEdit: () => void
}) {
  const [confirming, setConfirming] = React.useState<"archive" | "delete" | "blocked" | null>(null)
  const staffName = useStaffName()
  const archive = useAction(trpc.memories.archive.mutationOptions({ onSuccess: () => setParams({ id: null }) }), { success: "已归档，不再给任务用" })
  const remove = useAction(trpc.memories.delete.mutationOptions({ onSuccess: () => setParams({ id: null }) }), { success: "记忆已删除" })
  const approve = useAction(trpc.memories.approve.mutationOptions(), { success: "已通过，这条记忆生效了" })
  const reject = useAction(trpc.memories.reject.mutationOptions(), { success: "已拒绝，agent 以后读不到它" })
  const note = memory.note
  const pending = memory.status === "pending"
  const usedBy = tasksUsing(tasks, "memoryIds", memory.id)

  const actions = isAdmin && !pending && (
    <>
      <Button variant="outline" onClick={onEdit}>
        <PencilIcon data-icon="inline-start" />
        编辑
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多操作" />}>
          <EllipsisIcon />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={() => (usedBy.length > 0 ? setConfirming("archive") : archive.mutate({ id: memory.id }))}>归档</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={() => setConfirming(usedBy.length > 0 ? "blocked" : "delete")}>删除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )

  return (
    <DetailPanel
      title={memory.content}
      badges={<Badge variant={pending ? "default" : "secondary"}>{memoryStatusLabel[memory.status]}</Badge>}
      meta={`${who(memory, staffName)} · ${pending ? fmtDateTime(memory.createdAt) : fmtDate(memory.createdAt)}`}
      actions={actions}
    >
      {pending && (
        <Item variant="outline">
          <ItemMedia variant="icon">
            <InboxIcon />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>等 {staffName(memory.reviewerId)} 审核</ItemTitle>
            <ItemDescription>agent 提议的记忆要在「待办」里审核，通过后才生效、才能被任务选用。</ItemDescription>
          </ItemContent>
          {canReview && (
            <ItemActions>
              <Button size="sm" disabled={approve.isPending} onClick={() => approve.mutate({ id: memory.id })}>
                <CheckIcon data-icon="inline-start" />
                通过
              </Button>
              <Button size="sm" variant="outline" disabled={reject.isPending} onClick={() => reject.mutate({ id: memory.id })}>
                <XIcon data-icon="inline-start" />
                拒绝
              </Button>
            </ItemActions>
          )}
        </Item>
      )}
      <DetailSection title="内容" description="agent 运行开始时读到的就是这段话。">
        <MarkdownView>{memory.content}</MarkdownView>
      </DetailSection>
      <DetailSection title="适用于" description="决定它在列表里放哪一组；建任务时按这个找。">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline">{memory.appliesTo}</Badge>
          <span className="text-muted-foreground">分组：{memoryCategory(memory.appliesTo)}</span>
        </div>
      </DetailSection>
      <div className="grid gap-4 lg:grid-cols-2">
        <DetailSection title="来源">
          <div className="flex flex-col gap-2">
            <p>{sourceText(memory, staffName)}</p>
            {memory.webUnverified && (
              <div>
                <Badge variant="destructive">来自网页，可能不实</Badge>
              </div>
            )}
            {note.evidence && <p className="text-muted-foreground">证据：{note.evidence}</p>}
          </div>
        </DetailSection>
        <DetailSection title={`哪些任务选用了 · ${usedBy.length}`} description={note.lastUsed}>
          <TaskLinks tasks={usedBy} empty={pending ? "审核通过后才能被任务选用。" : "还没有任务选用这条记忆。"} />
        </DetailSection>
      </div>
      <AlertDialog open={confirming !== null} onOpenChange={(open) => !open && setConfirming(null)}>
        <AlertDialogContent>
          {confirming === "archive" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>归档这条记忆？</AlertDialogTitle>
                <AlertDialogDescription>
                  有 {usedBy.length} 个任务选用了它。归档后这些任务的下一次运行就读不到了，需要的话请先在任务里换一条。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => archive.mutate({ id: memory.id })}>
                  归档
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
          {confirming === "delete" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>删除这条记忆？</AlertDialogTitle>
                <AlertDialogDescription>删除后不能恢复。只是暂时不想让任务用，可以改成归档。</AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>取消</AlertDialogCancel>
                <AlertDialogAction variant="destructive" onClick={() => remove.mutate({ id: memory.id })}>
                  删除记忆
                </AlertDialogAction>
              </AlertDialogFooter>
            </>
          )}
          {confirming === "blocked" && (
            <>
              <AlertDialogHeader>
                <AlertDialogTitle>这条记忆正在被使用，不能删除</AlertDialogTitle>
                <AlertDialogDescription>
                  有 {usedBy.length} 个任务选用了它：{usedBy.map((task) => `${task.id}「${task.title}」`).join("、")}。先在这些任务里去掉它，或者改成归档。
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>知道了</AlertDialogCancel>
              </AlertDialogFooter>
            </>
          )}
        </AlertDialogContent>
      </AlertDialog>
    </DetailPanel>
  )
}

/** 选用了它的任务：每个一行，点了去任务详情 */
function TaskLinks({ tasks, empty }: { tasks: TaskDef[]; empty: string }) {
  const staffName = useStaffName()
  if (tasks.length === 0) return <p className="text-muted-foreground">{empty}</p>
  return (
    <ItemGroup className="gap-1">
      {tasks.map((task) => (
        <Item key={task.id} size="xs" variant="muted" render={<a href={href("tasks", { id: task.id })} />}>
          <ItemMedia variant="icon">
            <ListChecksIcon />
          </ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="line-clamp-1">{task.title}</ItemTitle>
            <ItemDescription>
              {task.id} · {staffName(task.ownerId)}
              {task.enabled ? "" : " · 未启动"}
            </ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}
