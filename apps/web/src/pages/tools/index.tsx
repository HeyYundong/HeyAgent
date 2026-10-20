// 工具 v3：来源分三种——MCP 服务器（每个服务器一组）、HTTP 接口（可从 cURL 导入）、内置（系统提供，不能改）。
// 主管可以新建、编辑、删除；员工只读。另有「密钥」：HTTP 模板里的 {{名字}}，值只加密存在服务器上。
// 删除（原型定的）：没人用的 HTTP 工具直接删，不弹确认，toast 里可以撤销；被任务、规则、技能用着的不能删，弹窗说清楚。
// MCP 服务器连同环境变量的密文一起删，不能撤销，所以要确认。
import * as React from "react"
import { EllipsisIcon, KeyRoundIcon, PencilIcon, PlugZapIcon, PlusIcon, ServerIcon, Trash2Icon, WrenchIcon } from "lucide-react"

import { DetailPanel, DetailSection, EmptyState, MasterDetail, PageFrame, PickGroup, PickItem, SimpleHeader } from "@/components/shell/simple-page"
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent } from "@/components/ui/alert-dialog"
import { AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockActions, CodeBlockContent, CodeBlockCopyButton } from "@/components/ui/code-block"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { alwaysOnToolIds, can, findById, fmtShort, httpParamsOf, riskLabel, riskNotes, tasksUsing, toolSourceLabel, type SavedSecret, type Skill } from "@heyagent/shared"

import { useRulesQuery, useSkillsQuery, useTasksQuery, useToolsQuery } from "@/lib/data"
import { toastWithUndo, useAction } from "@/lib/mutations"
import { href, setParams, useRoute } from "@/lib/router"
import { useMe } from "@/lib/session"
import { trpc } from "@/lib/trpc"

import { placeholders } from "./curl"
import { SecretsDialog } from "./secrets-dialog"
import { ToolDialog, type Server, type Tool } from "./tool-dialog"

const LINK = "underline underline-offset-4 hover:text-muted-foreground"
const loud = (tool: Tool) => tool.risk === "external" || tool.risk === "money"
const riskBadge = (tool: Tool) => <Badge variant={loud(tool) ? "destructive" : "outline"}>{riskLabel[tool.risk]}</Badge>
const listBadge = (tool: Tool) => (tool.alwaysOn ? <Badge variant="secondary">每个任务都自带</Badge> : loud(tool) && riskBadge(tool))

type Dialog = { kind: "new" } | { kind: "edit"; tool?: Tool; server?: Server } | { kind: "secrets" } | null

export default function ToolsPage() {
  const { user } = useMe()
  const isAdmin = can(user, "config.manage", {})
  const { params } = useRoute()
  const toolsQuery = useToolsQuery()
  const tasksQuery = useTasksQuery()
  const rulesQuery = useRulesQuery()
  const skillsQuery = useSkillsQuery()
  const queries = [toolsQuery, tasksQuery, rulesQuery, skillsQuery]
  const list = toolsQuery.data?.tools ?? []
  const servers = toolsQuery.data?.mcpServers ?? []
  const saved: Record<string, SavedSecret> = toolsQuery.data?.savedSecrets ?? {} // 服务器上已存的密钥（只有名字和谁存的）
  const [dialog, setDialog] = React.useState<Dialog>(null)

  const id = params.get("id")
  const selected = findById(list, id)
  // MCP 服务器也能直接选中（还没读取工具的服务器，列表里只有它自己）
  const selectedServer = findById(servers, selected?.serverId ?? id)
  const groups = [
    ...servers.map((s) => ({ key: s.id, label: `MCP · ${s.name}`, server: s, items: list.filter((t) => t.serverId === s.id) })),
    { key: "http", label: "HTTP 接口", server: undefined, items: list.filter((t) => t.source === "http") },
    // 内置工具不加组标题（用户要求），说明在详情里
    { key: "builtin", label: undefined, server: undefined, items: list.filter((t) => t.source === "builtin") },
  ].filter((group) => group.items.length > 0 || group.server)
  const empty = list.length === 0 && servers.length === 0

  const header = (
    <SimpleHeader
      title="工具"
      description="agent 能调用的能力：接 MCP 服务器、填一个外部接口，或用系统内置的。建任务时选上才能用。"
      learnId="tools"
      action={
        isAdmin && (
          <div className="flex flex-wrap gap-2">
            <Button variant="outline" onClick={() => setDialog({ kind: "secrets" })}><KeyRoundIcon data-icon="inline-start" />密钥</Button>
            <Button onClick={() => setDialog({ kind: "new" })}><PlusIcon data-icon="inline-start" />新建工具</Button>
          </div>
        )
      }
    />
  )

  return (
    <>
      <PageFrame
        queries={queries}
        isEmpty={empty}
        header={header}
        empty={
          <EmptyState
            icon={<WrenchIcon />}
            title="还没有工具"
            description={isAdmin ? "粘贴一条 curl 命令接入外部接口，或者接一个 MCP 服务器。系统内置的工具在引擎启动后会自动出现在这里。" : "还没有工具。工具由主管接入，系统内置的工具在引擎启动后自动出现。"}
            action={isAdmin && <Button onClick={() => setDialog({ kind: "new" })}><PlusIcon data-icon="inline-start" />新建工具</Button>}
          />
        }
      >
        <MasterDetail
          hasSelection={!!selected || !!selectedServer}
          list={groups.map((group) => (
            <PickGroup key={group.key} label={group.label}>
              {group.server && group.items.length === 0 && (
                <PickItem to={href("tools", { id: group.server.id })} selected={id === group.server.id} title={group.server.name} description="还没读取工具" badge={<Badge variant="outline">服务器</Badge>} />
              )}
              {group.items.map((tool) => (
                <PickItem key={tool.id} to={href("tools", { id: tool.id })} selected={tool.id === selected?.id} title={tool.name} description={tool.summary} badge={listBadge(tool)} />
              ))}
            </PickGroup>
          ))}
          detail={
            selected ? (
              <ToolDetail
                key={selected.id}
                tool={selected}
                server={selectedServer}
                saved={saved}
                isAdmin={isAdmin}
                onEdit={() => setDialog({ kind: "edit", tool: selected, server: selectedServer })}
              />
            ) : selectedServer ? (
              <ServerDetail key={selectedServer.id} server={selectedServer} isAdmin={isAdmin} onEdit={() => setDialog({ kind: "edit", server: selectedServer })} />
            ) : null
          }
        />
      </PageFrame>
      {(dialog?.kind === "new" || dialog?.kind === "edit") && (
        <ToolDialog
          tool={dialog.kind === "edit" ? dialog.tool : undefined}
          server={dialog.kind === "edit" ? dialog.server : undefined}
          serverTools={list.filter((t) => dialog.kind === "edit" && dialog.server && t.serverId === dialog.server.id)}
          saved={saved}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === "secrets" && <SecretsDialog saved={saved} tools={list} onClose={() => setDialog(null)} />}
    </>
  )
}

/** 被谁用着：任务（自带的工具算全部任务）、规则、技能 */
function useUsage(tool: Tool) {
  const tools = useToolsQuery().data?.tools ?? []
  const tasks = tasksUsing(useTasksQuery().data ?? [], "toolIds", tool.id, alwaysOnToolIds(tools))
  const rules = (useRulesQuery().data ?? []).filter((rule) => rule.toolIds.includes(tool.id))
  const skills = (useSkillsQuery().data ?? []).filter((skill: Skill) => skill.toolIds.includes(tool.id))
  return { tasks, rules, skills, inUse: tasks.length + rules.length + skills.length > 0 }
}

function ToolDetail({ tool, server, saved, isAdmin, onEdit }: { tool: Tool; server?: Server; saved: Record<string, SavedSecret>; isAdmin: boolean; onEdit: () => void }) {
  const usage = useUsage(tool)
  const [blocked, setBlocked] = React.useState(false)
  const note = riskNotes[tool.risk]
  const restore = useAction(trpc.tools.restoreHttp.mutationOptions(), { success: (_data, vars) => `已恢复工具「${vars.name}」` })
  const del = useAction(
    trpc.tools.deleteHttp.mutationOptions({
      onSuccess: (removed) => {
        setParams({ id: null })
        if (removed.http) toastWithUndo(`已删除工具「${removed.name}」`, () => restore.mutate({ id: removed.id, name: removed.name, summary: removed.summary, description: removed.description, http: removed.http!, risk: removed.risk }))
      },
    })
  )

  function remove() {
    if (usage.inUse) setBlocked(true)
    else del.mutate({ id: tool.id })
  }

  const actions =
    isAdmin && tool.source !== "builtin" ? (
      <>
        <Button variant="outline" onClick={onEdit}><PencilIcon data-icon="inline-start" />{tool.source === "mcp" ? "编辑服务器" : "编辑"}</Button>
        {tool.source === "http" && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多操作" />}>
              <EllipsisIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem variant="destructive" onClick={remove}><Trash2Icon />删除</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </>
    ) : undefined

  return (
    <DetailPanel
      title={tool.name}
      badges={<Badge variant="secondary">{toolSourceLabel[tool.source]}</Badge>}
      meta={`模型里的名字：${tool.id} · ${tool.alwaysOn ? "每个任务都自带" : `被 ${usage.tasks.length} 个任务选用`}`}
      actions={actions}
    >
      <DetailSection title="给模型看的说明" description="模型只靠这段话判断什么时候用、怎么用这个工具。">
        <p>{tool.description}</p>
      </DetailSection>
      <DetailSection title="怎么调用">
        <HowToCall tool={tool} server={server} saved={saved} />
      </DetailSection>
      <DetailSection title="风险">
        <p className="flex flex-wrap items-center gap-2">
          {riskBadge(tool)}
          {note?.text}
        </p>
      </DetailSection>
      <DetailSection title="哪些任务选用了">
        {tool.alwaysOn && <p>每个任务都自带，建任务时不用选。</p>}
        {usage.tasks.length === 0 && <p className="text-muted-foreground">还没有任务选用。</p>}
        <ul className="flex flex-col gap-1">
          {!tool.alwaysOn && usage.tasks.map((task) => (
            <li key={task.id} className="flex gap-2">
              <span className="shrink-0 text-muted-foreground">{task.id}</span>
              <a href={href("tasks", { id: task.id })} className={LINK}>{task.title}</a>
            </li>
          ))}
        </ul>
        {usage.rules.length > 0 && <p className="mt-3 text-muted-foreground">规则命中后也会调用它：{usage.rules.map((r) => r.name).join("、")}</p>}
        {usage.skills.length > 0 && <p className="mt-1 text-muted-foreground">技能里用到它：{usage.skills.map((s) => s.name).join("、")}</p>}
      </DetailSection>
      <AlertDialog open={blocked} onOpenChange={setBlocked}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>工具「{tool.name}」正在被使用，不能删除</AlertDialogTitle>
            <AlertDialogDescription>
              {[
                usage.tasks.length ? `有 ${usage.tasks.length} 个任务选用了它：${usage.tasks.map((t) => `${t.id}「${t.title}」`).join("、")}。` : "",
                usage.rules.length ? `规则「${usage.rules.map((r) => r.name).join("」「")}」命中后会调用它。` : "",
                usage.skills.length ? `技能「${usage.skills.map((s) => s.name).join("」「")}」用到了它。` : "",
              ].join("")}
              先去掉这些引用，再回来删除。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>知道了</AlertDialogCancel>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailPanel>
  )
}

/** MCP 服务器本身：连接方式、环境变量名、加入的工具；编辑、删除 */
function ServerDetail({ server, isAdmin, onEdit }: { server: Server; isAdmin: boolean; onEdit: () => void }) {
  const tools = (useToolsQuery().data?.tools ?? []).filter((tool) => tool.serverId === server.id)
  const [confirming, setConfirming] = React.useState(false)
  const remove = useAction(trpc.tools.deleteMcpServer.mutationOptions({ onSuccess: () => setParams({ id: null }) }), { success: `已删除服务器「${server.name}」` })
  const envKeys = (server.env ?? "").split("\n").map((line) => line.split("=")[0]!.trim()).filter(Boolean)
  return (
    <DetailPanel
      title={server.name}
      badges={<Badge variant="secondary">MCP 服务器</Badge>}
      meta={`${server.transport === "stdio" ? "stdio 命令" : "HTTP 地址"} · ${tools.length ? `加入了 ${tools.length} 个工具` : "还没读取工具"}`}
      actions={
        isAdmin && (
          <>
            <Button variant="outline" onClick={onEdit}><PencilIcon data-icon="inline-start" />编辑服务器</Button>
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button variant="ghost" size="icon" aria-label="更多操作" />}>
                <EllipsisIcon />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onClick={() => setConfirming(true)}><Trash2Icon />删除服务器</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </>
        )
      }
    >
      <DetailSection title="怎么连接">
        <div className="flex flex-col gap-3">
          <Code text={(server.transport === "stdio" ? server.command : server.url) ?? ""} />
          <p className="text-muted-foreground">
            {server.note && `${server.note}。`}{server.transport === "stdio" ? "环境变量" : "请求头"}：{envKeys.join("、") || "无"}（值存在服务器上，模型看不到）
          </p>
        </div>
      </DetailSection>
      <DetailSection title="加入的工具" description="连上服务器后读出它提供的工具，勾选的才会给 agent。">
        {tools.length === 0 ? (
          <p className="flex items-center gap-2 text-muted-foreground"><PlugZapIcon className="size-4" />还没读取工具。</p>
        ) : (
          <ul className="flex flex-col gap-1">
            {tools.map((tool) => (
              <li key={tool.id} className="flex flex-wrap gap-2">
                <a href={href("tools", { id: tool.id })} className={LINK}>{tool.name}</a>
                <span className="font-mono text-muted-foreground">{tool.id}</span>
              </li>
            ))}
          </ul>
        )}
      </DetailSection>
      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>删除服务器「{server.name}」？</AlertDialogTitle>
            <AlertDialogDescription>
              它加入的 {tools.length} 个工具和存在服务器上的{server.transport === "stdio" ? "环境变量" : "请求头"}值会一起删除，不能恢复。工具被任务、规则或技能用着时删不了。
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>先不删</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => remove.mutate({ id: server.id })}>删除服务器</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </DetailPanel>
  )
}

/** 「怎么调用」：MCP 写服务器和连接；HTTP 显示请求模板（复制得到 cURL）；内置不能改 */
function HowToCall({ tool, server, saved }: { tool: Tool; server?: Server; saved: Record<string, SavedSecret> }) {
  if (tool.source === "builtin") return <p>系统提供，不能改。参数和实现都由 HeyAgent 自己维护。</p>
  if (tool.source === "mcp" && server) {
    const envKeys = (server.env ?? "").split("\n").map((line) => line.split("=")[0]!.trim()).filter(Boolean)
    return (
      <div className="flex flex-col gap-3">
        <p className="flex flex-wrap items-center gap-2">
          <ServerIcon className="size-4" />
          <a href={href("tools", { id: server.id })} className={LINK}>{server.name}</a> · {server.transport === "stdio" ? "stdio 命令" : "HTTP 地址"}
        </p>
        <Code text={(server.transport === "stdio" ? server.command : server.url) ?? ""} />
        <p className="text-muted-foreground">
          {server.note && `${server.note}。`}{server.transport === "stdio" ? "环境变量" : "请求头"}：{envKeys.join("、") || "无"}（值存在服务器上，模型看不到）
        </p>
      </div>
    )
  }
  if (!tool.http) return null
  const { method, url, headers = {}, body = "" } = tool.http
  const headerLines = Object.entries(headers).map(([key, value]) => `${key}: ${value}`)
  const request = [`${method} ${url}`, ...headerLines, ...(body ? ["", pretty(body)] : [])].join("\n")
  const curl = [`curl -X ${method} '${url}'`, ...headerLines.map((h) => `-H '${h}'`), ...(body ? [`-d '${body}'`] : [])].join(" \\\n  ")
  const { secrets } = placeholders(`${url} ${headerLines.join(" ")} ${body}`)
  const params = httpParamsOf(tool.http)
  return (
    <div className="flex flex-col gap-3">
      <Code text={request} copy={curl} />
      <p className="text-muted-foreground">模型要填的参数：{params.length === 0 && "无"}</p>
      {params.length > 0 && (
        <ul className="flex flex-col gap-1">
          {params.map((param) => (
            <li key={param.name} className="flex flex-wrap items-center gap-2">
              <span className="font-mono">{`{${param.name}}`}</span>
              <Badge variant="outline">{param.type === "json" ? "JSON" : "文本"}</Badge>
              <span className="text-muted-foreground">
                {[param.required ? "必填" : "可选", param.omitIfAbsent && "没传就去掉", param.description].filter(Boolean).join(" · ")}
              </span>
            </li>
          ))}
        </ul>
      )}
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
