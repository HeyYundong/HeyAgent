// 工具 v3：来源分三种——MCP 服务器（每个服务器一组）、HTTP 接口（可从 cURL 导入）、内置（系统提供，不能改）。
// 主管可以新建、编辑、删除；员工只读。M0 只读：弹窗照原型显示，真正提交时弹「只读阶段」提示。
import * as React from "react"
import { EllipsisIcon, PencilIcon, PlusIcon, Trash2Icon, WrenchIcon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent } from "@/components/ui/alert-dialog"
import { AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton } from "@/components/ui/code-block"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { alwaysOnToolIds, can, findById, fmtShort, riskLabel, riskNotes, tasksUsing, toolSourceLabel, type SavedSecret } from "@heyagent/shared"

import { useRulesQuery, useTasksQuery, useToolsQuery } from "@/lib/data"
import { readOnlyToast } from "@/lib/readonly"
import { href, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"

import { placeholders } from "./curl"
import { ToolDialog, type Server, type Tool } from "./tool-dialog"

const LINK = "underline underline-offset-4 hover:text-muted-foreground"
const loud = (tool: Tool) => tool.risk === "external" || tool.risk === "money"
const riskBadge = (tool: Tool) => <Badge variant={loud(tool) ? "destructive" : "outline"}>{riskLabel[tool.risk]}</Badge>
const listBadge = (tool: Tool) => (tool.alwaysOn ? <Badge variant="secondary">每个任务都自带</Badge> : loud(tool) && riskBadge(tool))

export default function ToolsPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  const { params } = useRoute()
  const toolsQuery = useToolsQuery()
  const tasksQuery = useTasksQuery()
  const rulesQuery = useRulesQuery()
  const queries = [toolsQuery, tasksQuery, rulesQuery]
  const list = toolsQuery.data?.tools ?? []
  const servers = toolsQuery.data?.mcpServers ?? []
  const saved: Record<string, SavedSecret> = toolsQuery.data?.savedSecrets ?? {} // 服务器上已存的密钥（只有名字和谁存的）
  const rules = rulesQuery.data ?? []
  const [dialog, setDialog] = React.useState<"new" | "edit" | null>(null)
  const [confirmDelete, setConfirmDelete] = React.useState(false)

  const selected = findById(list, params.get("id"))
  const server = findById(servers, selected?.serverId)
  // 每个任务都自带的工具算全部任务
  const usedBy = selected ? tasksUsing(tasksQuery.data ?? [], "toolIds", selected.id, alwaysOnToolIds(list)) : []
  const calledBy = rules.filter((rule) => selected && rule.toolIds.includes(selected.id))
  const note = selected && riskNotes[selected.risk]
  const groups = [
    ...servers.map((s) => ({ label: `MCP · ${s.name}`, items: list.filter((t) => t.serverId === s.id) })),
    { label: "HTTP 接口", items: list.filter((t) => t.source === "http") },
    { label: "内置 · 系统提供", items: list.filter((t) => t.source === "builtin") },
  ].filter((group) => group.items.length > 0)

  function remove() {
    setConfirmDelete(false)
    readOnlyToast()
  }

  return (
    <PageFrame
      queries={queries}
      isEmpty={list.length === 0}
      header={
        <SimpleHeader title="工具" description="agent 能调用的能力：接 MCP 服务器、填一个外部接口，或用系统内置的。建任务时选上才能用。" learnId="tools" action={
          isAdmin && <Button onClick={() => setDialog("new")}><PlusIcon data-icon="inline-start" />新建工具</Button>
        } />
      }
      empty={<EmptyState icon={<WrenchIcon />} title="还没有工具" description="接一个 MCP 服务器，或者粘贴一条 curl 命令接入外部接口。" />}
    >
      <MasterDetail
        hasSelection={!!selected}
        list={groups.map((group) => (
          <PickGroup key={group.label} label={group.label}>
            {group.items.map((tool) => (
              <PickItem key={tool.id} to={href("tools", { id: tool.id })} selected={tool.id === selected?.id} title={tool.name} description={tool.summary} badge={listBadge(tool)} />
            ))}
          </PickGroup>
        ))}
        detail={
          selected && (
            <DetailPanel
              title={selected.name}
              badges={<Badge variant="secondary">{toolSourceLabel[selected.source]}</Badge>}
              meta={`模型里的名字：${selected.id} · ${selected.alwaysOn ? "每个任务都自带" : `被 ${usedBy.length} 个任务选用`}`}
              actions={
                isAdmin &&
                selected.source !== "builtin" && (
                  <>
                    <Button variant="outline" onClick={() => setDialog("edit")}><PencilIcon data-icon="inline-start" />{selected.source === "mcp" ? "编辑服务器" : "编辑"}</Button>
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多操作" />}>
                        <EllipsisIcon />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem variant="destructive" onClick={() => (usedBy.length + calledBy.length > 0 ? setConfirmDelete(true) : remove())}>
                          <Trash2Icon />删除
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                )
              }
            >
              <DetailSection title="给模型看的说明" description="模型只靠这段话判断什么时候用、怎么用这个工具。">
                <p>{selected.description}</p>
              </DetailSection>
              <DetailSection title="怎么调用">
                <HowToCall tool={selected} server={server} saved={saved} />
              </DetailSection>
              <DetailSection title="风险">
                <p className="flex flex-wrap items-center gap-2">
                  {riskBadge(selected)}
                  {note?.text}
                </p>
              </DetailSection>
              <DetailSection title="哪些任务选用了">
                {selected.alwaysOn && <p>每个任务都自带，建任务时不用选。</p>}
                {usedBy.length === 0 && <p className="text-muted-foreground">还没有任务选用。</p>}
                <ul className="flex flex-col gap-1">
                  {!selected.alwaysOn && usedBy.map((task) => (
                    <li key={task.id} className="flex gap-2">
                      <span className="shrink-0 text-muted-foreground">{task.id}</span>
                      <a href={href("tasks", { id: task.id })} className={LINK}>{task.title}</a>
                    </li>
                  ))}
                </ul>
                {calledBy.length > 0 && <p className="mt-3 text-muted-foreground">规则命中后也会调用它：{calledBy.map((r) => r.name).join("、")}</p>}
              </DetailSection>
            </DetailPanel>
          )
        }
      />

      {dialog && (
        <ToolDialog tool={dialog === "edit" ? selected : undefined} server={dialog === "edit" ? server : undefined}
          serverTools={list.filter((t) => server && t.serverId === server.id)} saved={saved} onClose={() => setDialog(null)} onSaveHttp={readOnlyToast} onSaveMcp={readOnlyToast} />
      )}

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除工具「{selected?.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              {usedBy.length > 0 && `有 ${usedBy.length} 个任务选用了它：${usedBy.map((t) => t.title).join("；")}。`}
              {calledBy.length > 0 && `规则「${calledBy.map((r) => r.name).join("」「")}」命中后会调用它。`}
              删除后这些任务和规则就调不到它了，可能会卡住。删除后不能恢复。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不删</AlertDialogCancel><AlertDialogAction variant="destructive" onClick={remove}>删除工具</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </PageFrame>
  )
}

/** 「怎么调用」：MCP 写服务器和连接；HTTP 显示请求模板（复制得到 cURL）；内置不能改 */
function HowToCall({ tool, server, saved }: { tool: Tool; server?: Server; saved: Record<string, SavedSecret> }) {
  if (tool.source === "builtin") return <p>系统提供，不能改。参数和实现都由 HeyAgent 自己维护。</p>
  if (tool.source === "mcp" && server) {
    const envKeys = (server.env ?? "").split("\n").map((line) => line.split("=")[0].trim()).filter(Boolean)
    const ok = server.status === "connected"
    return (
      <div className="flex flex-col gap-3">
        <p className="flex flex-wrap items-center gap-2">
          {server.name} · {server.transport === "stdio" ? "stdio 命令" : "HTTP 地址"}
          <Badge variant={ok ? "outline" : "destructive"}>{ok ? "已连接" : "连不上"}</Badge>
        </p>
        <Code text={(server.transport === "stdio" ? server.command : server.url) ?? ""} />
        <p className="text-muted-foreground">
          {server.note && `${server.note}。`}环境变量：{envKeys.join("、") || "无"}（值存在服务器上，模型看不到）
        </p>
      </div>
    )
  }
  if (!tool.http) return null
  const { method, url, headers = {}, body = "" } = tool.http
  const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`)
  const request = [`${method} ${url}`, ...headerLines, ...(body ? ["", pretty(body)] : [])].join("\n")
  const curl = [`curl -X ${method} '${url}'`, ...headerLines.map((h) => `-H '${h}'`), ...(body ? [`-d '${body}'`] : [])].join(" \\\n  ")
  const { params, secrets } = placeholders(`${url} ${headerLines.join(" ")} ${body}`)
  return (
    <div className="flex flex-col gap-3">
      <Code text={request} copy={curl} />
      <p className="text-muted-foreground">模型要填的参数：{params.join("、") || "无"}</p>
      {secrets.map((n) => (
        <p key={n} className="flex flex-wrap items-center gap-2"><span className="font-mono">{n}</span>
          {saved[n] ? <><Badge variant="outline">已保存在服务器</Badge><span className="text-muted-foreground">{saved[n].by} {fmtShort(saved[n].at).slice(0, 5)} · 模型和页面都看不到原文</span></> : <Badge variant="destructive">还没有值</Badge>}</p>
      ))}
    </div>
  )
}

function pretty(body: string) {
  try { return JSON.stringify(JSON.parse(body), null, 2) } catch { return body }
}

/** 用 code-block 显示命令或请求；copy 不传就复制原文 */
function Code({ text, copy }: { text: string; copy?: string }) {
  return (
    <CodeBlock size="sm">
      <CodeBlockActions>
        <CodeBlockCopyButton value={copy ?? text} aria-label={copy ? "复制为 cURL" : "复制"} />
      </CodeBlockActions>
      <CodeBlockContent wrap className="max-h-80 break-all">{text}</CodeBlockContent>
    </CodeBlock>
  )
}
