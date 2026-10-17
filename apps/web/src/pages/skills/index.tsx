// 技能页（v3）：左边按岗位分组，右边一个技能的详情（标题卡 + 分区卡：什么时候用、用到的工具、哪些任务选用了、操作手册）。
// 只负责「看」和主管的「新建 / 编辑 / 发布 / 停用」；agent 提的修改建议在「待办」里审核。
// M0 只读：新建、编辑、发布、停用照原型显示，真正提交时弹「只读阶段」提示。
import * as React from "react"
import { BookOpenIcon, EllipsisIcon, FileTextIcon, InboxIcon, ListChecksIcon, PencilIcon, PlusIcon, WrenchIcon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState, MasterDetail } from "@/components/shell/simple-page"
import { PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton } from "@/components/ui/code-block"
import { CodeBlockHeader, CodeBlockLine, CodeBlockTitle } from "@/components/ui/code-block"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Item, ItemActions, ItemContent, ItemDescription, ItemGroup, ItemMedia, ItemTitle } from "@/components/ui/item"
import { useHighlightedCode } from "@/hooks/use-highlighted-code"
import { can, findById, fmtDate, fmtDateTime, riskLabel, skillStatusLabel, tasksUsing, type Skill, type TaskDef, type Tool } from "@heyagent/shared"

import { useSkillsQuery, useStaffName, useStaffQuery, useTasksQuery, useToolsQuery } from "@/lib/data"
import { readOnlyToast } from "@/lib/readonly"
import { href, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"

import { BODY_TEMPLATE } from "./data"
import { SkillDialog } from "./skill-dialog"


const statusVariant = { published: "secondary", draft: "outline", disabled: "ghost" } as const

export default function SkillsPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  const { params } = useRoute()
  const skillsQuery = useSkillsQuery()
  const tasksQuery = useTasksQuery()
  const toolsQuery = useToolsQuery()
  const queries = [skillsQuery, tasksQuery, toolsQuery, useStaffQuery()]
  const items = skillsQuery.data ?? []
  // 在弹窗里输入过的新岗位，页面内记住
  const [createdDepts, setCreatedDepts] = React.useState<string[]>([])
  // 正在编辑哪个；"new" 表示新建
  const [editing, setEditing] = React.useState<Skill | "new" | null>(null)

  const selected = findById(items, params.get("id"))
  // 岗位完全来自数据（平台通用，代码里不写岗位），按名字排；弹窗里新输入的排在后面
  const depts = [...new Set([...[...new Set(items.map((s) => s.dept))].sort((a, b) => a.localeCompare(b, "zh")), ...createdDepts])]

  const header = (
    <SimpleHeader
      title="技能"
      description="agent 的操作手册：遇到什么情况、按什么步骤做。建任务时选用哪些，agent 就能用哪些。"
      learnId="skills"
      action={
        isAdmin && (
          <Button onClick={() => setEditing("new")}>
            <PlusIcon data-icon="inline-start" />
            新建技能
          </Button>
        )
      }
    />
  )

  return (
    <PageFrame
      header={header}
      queries={queries}
      isEmpty={items.length === 0}
      empty={<EmptyState icon={<BookOpenIcon />} title="还没有技能" description="把员工做事的步骤写成技能，agent 就能照着做。" />}
    >
      <MasterDetail
        hasSelection={!!selected}
        list={depts.map((dept) => {
          const group = items.filter((s) => s.dept === dept)
          if (group.length === 0) return null
          return (
            <PickGroup key={dept} label={`${dept} · ${group.length}`}>
              {group.map((s) => (
                <PickItem
                  key={s.id}
                  to={href("skills", { id: s.id })}
                  selected={s.id === selected?.id}
                  title={s.name}
                  description={s.description}
                  badge={
                    s.suggestion ? (
                      <Badge>有修改建议</Badge>
                    ) : (
                      s.status !== "published" && <Badge variant={statusVariant[s.status]}>{skillStatusLabel[s.status]}</Badge>
                    )
                  }
                />
              ))}
            </PickGroup>
          )
        })}
        detail={
          selected ? (
            <SkillDetail
              skill={selected}
              tasks={tasksQuery.data ?? []}
              tools={toolsQuery.data?.tools ?? []}
              isAdmin={isAdmin}
              canReview={!!selected.suggestion && can(user, "humanItem.resolve", { assigneeId: selected.suggestion.reviewerId })}
              onEdit={() => setEditing(selected)}
              onSetStatus={readOnlyToast}
            />
          ) : null
        }
      />
      <SkillDialog
        key={editing === "new" ? "new" : (editing?.id ?? "closed")}
        open={editing !== null}
        onOpenChange={(open) => !open && setEditing(null)}
        skill={editing === "new" ? undefined : (editing ?? undefined)}
        template={BODY_TEMPLATE}
        deptOptions={depts}
        onCreateDept={(value) => setCreatedDepts((list) => [...list, value])}
        onSubmit={readOnlyToast}
      />
    </PageFrame>
  )
}

// ---------- 详情 ----------

function SkillDetail({ skill, tasks, tools, isAdmin, canReview, onEdit, onSetStatus }: {
  skill: Skill
  tasks: TaskDef[]
  tools: Tool[]
  isAdmin: boolean
  canReview: boolean
  onEdit: () => void
  /** 发布 / 停用（M0 只读：弹提示） */
  onSetStatus: () => void
}) {
  const staffName = useStaffName()
  const skillTools = skill.toolIds.map((id) => findById(tools, id)).filter((t) => t !== undefined)
  const usedBy = tasksUsing(tasks, "skillIds", skill.id)
  const { suggestion } = skill

  const actions = isAdmin && (
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
          {skill.status === "published" ? (
            <DropdownMenuItem onClick={onSetStatus}>停用</DropdownMenuItem>
          ) : (
            <DropdownMenuItem onClick={onSetStatus}>发布</DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )

  return (
    <DetailPanel
      title={skill.name}
      badges={
        <>
          <Badge variant="outline">{skill.dept}</Badge>
          <Badge variant={statusVariant[skill.status]}>{skillStatusLabel[skill.status]}</Badge>
        </>
      }
      meta={`负责人 ${staffName(skill.ownerId)} · 第 ${skill.version} 版 · ${fmtDate(skill.updatedAt)} 更新`}
      actions={actions}
    >
      {suggestion && (
        <Item variant="outline">
          <ItemMedia variant="icon">
            <InboxIcon />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>agent 提了修改建议：{suggestion.summary}</ItemTitle>
            <ItemDescription>
              来自 {suggestion.taskId} · {fmtDateTime(suggestion.createdAt)} · 等 {staffName(suggestion.reviewerId)} 在「待办」里审核，通过后记为第 {skill.version + 1} 版。
            </ItemDescription>
          </ItemContent>
          {canReview && (
            <ItemActions>
              <Button size="sm" nativeButton={false} render={<a href={href("todos", { id: suggestion.itemId ?? skill.id })} />}>
                去待办处理 →
              </Button>
            </ItemActions>
          )}
        </Item>
      )}
      <DetailSection title="什么时候用" description="agent 平时只看到这一句，判断用得上才读下面的操作手册。">
        <p>{skill.description}</p>
      </DetailSection>
      <div className="grid gap-4 lg:grid-cols-2">
        <DetailSection title={`用到的工具 · ${skillTools.length}`}>
          {skillTools.length === 0 ? (
            <p className="text-muted-foreground">还没有指定工具。</p>
          ) : (
            <LinkList
              rows={skillTools.map((tool) => ({
                key: tool.id,
                to: href("tools", { id: tool.id }),
                icon: <WrenchIcon />,
                title: tool.name,
                description: riskLabel[tool.risk],
              }))}
            />
          )}
        </DetailSection>
        <DetailSection title={`哪些任务选用了 · ${usedBy.length}`}>
          {usedBy.length === 0 ? (
            <p className="text-muted-foreground">还没有任务选用这个技能。</p>
          ) : (
            <LinkList
              rows={usedBy.map((task) => ({
                key: task.id,
                to: href("tasks", { id: task.id }),
                icon: <ListChecksIcon />,
                title: task.title,
                description: `${task.id} · ${staffName(task.ownerId)}${task.enabled ? "" : " · 未启动"}`,
              }))}
            />
          )}
        </DetailSection>
      </div>
      <DetailSection title="操作手册" description="agent 调「读取技能」拿到的就是这段文字。">
        <SkillMarkdown skill={skill} />
      </DetailSection>
    </DetailPanel>
  )
}

/** 一列可点的行：图标 + 标题 + 一行灰字 */
function LinkList({ rows }: { rows: { key: string; to: string; icon: React.ReactNode; title: string; description: string }[] }) {
  return (
    <ItemGroup className="gap-1">
      {rows.map((row) => (
        <Item key={row.key} size="xs" variant="muted" render={<a href={row.to} />}>
          <ItemMedia variant="icon">{row.icon}</ItemMedia>
          <ItemContent className="min-w-0">
            <ItemTitle className="line-clamp-1">{row.title}</ItemTitle>
            <ItemDescription>{row.description}</ItemDescription>
          </ItemContent>
        </Item>
      ))}
    </ItemGroup>
  )
}

/** SKILL.md 源码：头部（名称、描述、工具）+ 正文 */
function SkillMarkdown({ skill }: { skill: Skill }) {
  const code = ["---", `name: ${skill.name}`, `description: ${skill.description}`, `tools: [${skill.toolIds.join(", ")}]`, "---", "", skill.body].join("\n")
  const lines = useHighlightedCode(code, "markdown")

  return (
    <CodeBlock size="sm">
      <CodeBlockHeader>
        <CodeBlockTitle>
          <FileTextIcon />
          SKILL.md
        </CodeBlockTitle>
        <CodeBlockActions>
          <CodeBlockCopyButton value={code} />
        </CodeBlockActions>
      </CodeBlockHeader>
      <CodeBlockContent lineNumbers wrap className="max-h-96">
        {lines.map((line, index) => (
          <CodeBlockLine key={index}>{line}</CodeBlockLine>
        ))}
      </CodeBlockContent>
    </CodeBlock>
  )
}
