import { useState } from "react"
import { EyeIcon, EyeOffIcon, PlugIcon, ServerIcon, TerminalIcon } from "lucide-react"

import { DetailSection } from "@/components/shell/simple-page"
import { ItemGroup } from "@/components/ui/item"
import { href } from "@/lib/router"
import { ALWAYS_ON_TOOL_IDS, findById, mcpServers, tasksUsing, toolName, toolSourceLabel, tools, type ToolRef } from "./demo-data/prototype"

import { toolLessons, type ToolLesson } from "./demo-data/lessons"
import { Code, Lesson, Step, TextLink } from "./parts"

const options = toolLessons.map((item) => ({ id: item.source, label: toolSourceLabel[item.source] }))
const namesOf = (list: ToolRef[]) => list.map((item) => item.name).join("、")

function HowConnected({ tool }: { tool: ToolRef }) {
  if (tool.source === "mcp") {
    const server = findById(mcpServers, tool.serverId)!
    const siblings = tools.filter((item) => item.serverId === server.id)
    return (
      <ItemGroup className="gap-1">
        <Step tone="run" icon={<ServerIcon />} title={`MCP 服务器：${server.name}`} text={server.command ?? server.url} badge={server.status === "connected" ? "已连接" : "连不上"} />
        <Step tone="run" icon={<PlugIcon />} title={`连上以后自动读出 ${siblings.length} 个工具`} text={namesOf(siblings)} />
        <Step tone="skip" icon={<EyeOffIcon />} title={server.note} />
      </ItemGroup>
    )
  }
  if (tool.source === "http" && tool.http) {
    const { method, url, headers = {}, body } = tool.http
    const lines = [`${method} ${url}`, ...Object.entries(headers).map(([key, value]) => `${key}: ${value}`), ...(body ? [body] : [])]
    return (
      <div className="flex flex-col gap-2">
        <Code icon={<TerminalIcon />} title="系统实际发出的请求" lines={lines} />
        <p className="text-muted-foreground">
          新建时可以直接粘贴一条 cURL，自动填好方法、URL、请求头和请求体。{"{{…}}"} 是存在系统里的密钥，模型看不到。
        </p>
      </div>
    )
  }
  const optional = tools.filter((item) => item.source === "builtin" && !item.alwaysOn)
  return (
    <ItemGroup className="gap-1">
      <Step tone="run" icon={<ServerIcon />} title="系统提供，不能改" text="和系统本身打交道的事（挂起、勾检查点、问人、提议记忆……）都是内置工具" />
      <Step tone="pass" icon={<PlugIcon />} title={`${ALWAYS_ON_TOOL_IDS.map(toolName).join("、")}：每个任务都自带`} text="建任务时不用选，也去不掉" />
      <Step tone="skip" icon={<PlugIcon />} title={`其余 ${optional.length} 个内置工具照旧要选`} text={namesOf(optional)} />
    </ItemGroup>
  )
}

export function ToolsLesson() {
  const [source, setSource] = useState<ToolLesson["source"]>("mcp")
  const lesson = toolLessons.find((item) => item.source === source) ?? toolLessons[0]
  const tool = findById(tools, lesson.toolId)!

  return (
    <Lesson
      title="工具：三种来源，模型只看说明书"
      meta="工具从三个地方来：接一个 MCP 服务器、配一个 HTTP 接口，或者系统内置。不管从哪来，模型只读一份说明书，自己决定用不用、参数怎么填。"
      choice={{ label: "选一种来源", value: source, options, onChange: setSource }}
    >
      <DetailSection title={`模型看得到的：「${tool.name}」的说明书`}>
        <Code icon={<EyeIcon />} title={tool.id} lines={lesson.manual.split("\n")} />
      </DetailSection>

      <DetailSection title="模型看不到的：它是怎么接进来的" action={<TextLink to={href("tools", { id: tool.id })}>去工具页 →</TextLink>}>
        <HowConnected tool={tool} />
        <p className="mt-2 text-muted-foreground">
          {tool.alwaysOn
            ? "每个任务都自带它，不用选。"
            : `${tasksUsing("toolIds", tool.id).length} 个任务选用了它。建任务时没选的工具，模型连说明书都看不到。`}
        </p>
      </DetailSection>
    </Lesson>
  )
}
