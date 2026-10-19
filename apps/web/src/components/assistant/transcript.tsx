// 面板里的对话记录：人说的（靠右）、助手说的（Markdown）、查了什么（Trace，连着的几次合成一组）、改动确认卡、停下来的原因。
// 每一行包一个 MessageScrollerItem：人发的那条是锚点，新一轮从顶上开始，回答往下长（官方 Message Scroller 的用法）。
import * as React from "react"
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, LoaderCircleIcon, XIcon } from "lucide-react"
import type { AssistantEntry } from "@heyagent/shared"

import { MarkdownView } from "@/components/markdown"
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert"
import { Bubble, BubbleContent } from "@/components/ui/bubble"
import { Button } from "@/components/ui/button"
import { CodeBlock, CodeBlockContent } from "@/components/ui/code-block"
import { Marker, MarkerContent, MarkerIcon } from "@/components/ui/marker"
import { Message, MessageContent } from "@/components/ui/message"
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
  useMessageScroller,
} from "@/components/ui/message-scroller"
import { Trace, TraceCollapsible, TraceCollapsibleContent, TraceCollapsibleTrigger, TraceIcon, TraceLine, TraceTitle } from "@/components/ui/trace"

import { ProposalCard } from "./proposal-card"

type ToolEntry = Extract<AssistantEntry, { kind: "tool" }>
type Row = { kind: "tools"; id: string; tools: ToolEntry[] } | { kind: "entry"; entry: Exclude<AssistantEntry, ToolEntry> }

/** 连着的几次工具调用合成一组 Trace */
function toRows(entries: AssistantEntry[]): Row[] {
  const rows: Row[] = []
  for (const entry of entries) {
    if (entry.kind === "tool") {
      const last = rows.at(-1)
      if (last?.kind === "tools") last.tools.push(entry)
      else rows.push({ kind: "tools", id: entry.id, tools: [entry] })
    } else {
      rows.push({ kind: "entry", entry })
    }
  }
  return rows
}

interface TranscriptProps {
  entries: AssistantEntry[]
  busy: null | "send" | "apply"
  /** 这次请求本身出错（连不上、卡已经处理过……） */
  error: string | null
  onDismissError: () => void
  onDecide: (proposalId: string, accept: boolean, note?: string) => void
  onNavigate?: () => void
}

/** 换一段对话时由外面换 key 重新挂上：打开时停在最后一轮（last-anchor），之后跟着新字往下走（autoScroll） */
export default function Transcript(props: TranscriptProps) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor">
      <TranscriptView {...props} />
    </MessageScrollerProvider>
  )
}

function TranscriptView({ entries, busy, error, onDismissError, onDecide, onNavigate }: TranscriptProps) {
  const rows = React.useMemo(() => toRows(entries), [entries])
  // 点了「应用 / 不要」：结果和接着的回答在最下面，滚过去并重新跟着走（人点按钮时滚动容器会停止自动跟随）
  const scroller = useMessageScroller()
  const lastBusy = React.useRef(busy)
  React.useEffect(() => {
    if (busy === "apply" && lastBusy.current !== "apply") scroller.scrollToEnd({ behavior: "smooth" })
    lastBusy.current = busy
  }, [busy, scroller])
  const last = entries.at(-1)
  // 请求进行中、还没有字在出来、也没有正在跑的工具：显示「在想」
  const thinking = !!busy && !(last?.kind === "assistant" && last.text) && !(last?.kind === "tool" && last.status === "running")

  return (
    <MessageScroller>
      <MessageScrollerViewport aria-label="对话记录">
        <MessageScrollerContent aria-busy={!!busy} className="gap-4 p-3">
          {rows.map((row) =>
            row.kind === "tools" ? (
              <MessageScrollerItem key={row.id} messageId={row.id}>
                <Trace>
                  {row.tools.map((tool) => (
                    <ToolRow key={tool.id} tool={tool} />
                  ))}
                </Trace>
              </MessageScrollerItem>
            ) : (
              <MessageScrollerItem key={row.entry.id} messageId={row.entry.id} scrollAnchor={row.entry.kind === "user"}>
                <EntryView entry={row.entry} busy={busy} onDecide={onDecide} onNavigate={onNavigate} />
              </MessageScrollerItem>
            )
          )}
          {thinking && (
            <MessageScrollerItem>
              <TraceLine status="running">
                <TraceIcon>
                  <LoaderCircleIcon className="animate-spin" />
                </TraceIcon>
                <TraceTitle>{busy === "apply" ? "正在改" : "在想"}</TraceTitle>
              </TraceLine>
            </MessageScrollerItem>
          )}
          {error && (
            <MessageScrollerItem>
              <Alert variant="destructive">
                <CircleAlertIcon />
                <AlertDescription>{error}</AlertDescription>
                <AlertAction>
                  <Button variant="ghost" size="icon-xs" aria-label="关掉" onClick={onDismissError}>
                    <XIcon />
                  </Button>
                </AlertAction>
              </Alert>
            </MessageScrollerItem>
          )}
        </MessageScrollerContent>
      </MessageScrollerViewport>
      <MessageScrollerButton aria-label="到最新" />
    </MessageScroller>
  )
}

const EntryView = React.memo(function EntryView({
  entry,
  busy,
  onDecide,
  onNavigate,
}: {
  entry: Exclude<AssistantEntry, ToolEntry>
  busy: null | "send" | "apply"
  onDecide: TranscriptProps["onDecide"]
  onNavigate?: () => void
}) {
  switch (entry.kind) {
    case "user":
      return (
        <Message align="end">
          <MessageContent>
            <Bubble align="end" variant="muted">
              <BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )
    case "assistant":
      if (!entry.text) return null
      return (
        <Message>
          <MessageContent>
            <Bubble variant="ghost">
              <BubbleContent>
                <MarkdownView>{entry.text}</MarkdownView>
              </BubbleContent>
            </Bubble>
          </MessageContent>
        </Message>
      )
    case "proposal":
      return (
        <ProposalCard
          proposal={entry.proposal}
          busy={!!busy}
          deciding={busy === "apply" && entry.proposal.status === "pending"}
          onDecide={(accept, note) => onDecide(entry.proposal.id, accept, note)}
          onNavigate={onNavigate}
        />
      )
    case "notice":
      return entry.tone === "error" ? (
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>{entry.text}</AlertDescription>
        </Alert>
      ) : (
        <Marker>
          <MarkerIcon>
            <InfoIcon />
          </MarkerIcon>
          <MarkerContent>{entry.text}</MarkerContent>
        </Marker>
      )
  }
})

const ToolRow = React.memo(function ToolRow({ tool }: { tool: ToolEntry }) {
  const status = tool.status === "running" ? "running" : tool.status === "error" ? "error" : undefined
  const line = (
    <TraceLine status={status}>
      <TraceIcon>{tool.status === "running" ? <LoaderCircleIcon className="animate-spin" /> : tool.status === "error" ? <CircleAlertIcon /> : <CircleCheckIcon />}</TraceIcon>
      <TraceTitle>{tool.label}</TraceTitle>
    </TraceLine>
  )
  if (!tool.detail) return line
  return (
    <TraceCollapsible>
      <TraceCollapsibleTrigger>{line}</TraceCollapsibleTrigger>
      <TraceCollapsibleContent>
        <CodeBlock size="sm" variant={tool.status === "error" ? "destructive" : "default"}>
          <CodeBlockContent wrap className="max-h-64">
            {tool.detail}
          </CodeBlockContent>
        </CodeBlock>
      </TraceCollapsibleContent>
    </TraceCollapsible>
  )
})
