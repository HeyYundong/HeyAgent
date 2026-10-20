// 面板里的对话记录：人说的（靠右）、助手说的（Markdown）、查了什么（Trace，连着的几次合成一组）、改动确认卡、停下来的原因。
// 每一行包一个 MessageScrollerItem。不用锚点（scrollAnchor）：锚点模式会把人发的那句钉在顶上、回答长了也不跟着往下走，
// 看起来像「每次回答都跳到顶上」（先显示的那条换成服务器回来的那条时还会再定位一次）。改成普通聊天的跟随：
// 跟着新字到最底下，人往上翻时不打扰；发新消息、点「应用 / 不要」时滚到最底下。
// 图（2026-10-20）：人发的图在那句话上面靠右，助手用 view_image 看过的图在那行 Trace 下面；都是缩略图，点了看大图（components/files 的 FileViewer）。
// 文件（第 12 节）：人发的文件在图下面靠右，一个一张小卡（图标、名字、大小），文本点了看内容（FileViewer），PDF、Word 点了下载。
import * as React from "react"
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, LoaderCircleIcon, XIcon } from "lucide-react"
import type { AssistantEntry, AssistantFile, AssistantImage } from "@heyagent/shared"

import { canPreviewFile, FileViewer, fileTypeIcon } from "@/components/files"
import { MarkdownView } from "@/components/markdown"
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert"
import { Attachment, AttachmentContent, AttachmentDescription, AttachmentMedia, AttachmentTitle, AttachmentTrigger } from "@/components/ui/attachment"
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
import { fmtSize } from "@/lib/files"
import { cn } from "@/lib/utils"

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

/** 换一段对话时由外面换 key 重新挂上：打开时停在最底下，之后跟着新字往下走（autoScroll） */
export default function Transcript(props: TranscriptProps) {
  return (
    <MessageScrollerProvider autoScroll defaultScrollPosition="end">
      <TranscriptView {...props} />
    </MessageScrollerProvider>
  )
}

function TranscriptView({ entries, busy, error, onDismissError, onDecide, onNavigate }: TranscriptProps) {
  const rows = React.useMemo(() => toRows(entries), [entries])
  // 发了新消息、点了「应用 / 不要」：滚到最下面并重新跟着走（人往上翻过、点过按钮时滚动容器会停止自动跟随）
  const scroller = useMessageScroller()
  const lastBusy = React.useRef(busy)
  React.useEffect(() => {
    if (busy && busy !== lastBusy.current) scroller.scrollToEnd({ behavior: "smooth" })
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
              <MessageScrollerItem key={row.entry.id} messageId={row.entry.id}>
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
            {entry.images && entry.images.length > 0 && <ImageThumbs images={entry.images} align="end" />}
            {entry.files && entry.files.length > 0 && <FileCards files={entry.files} />}
            {/* 只发了图、文件时没有字，不显示空气泡 */}
            {entry.text && (
              <Bubble align="end" variant="muted">
                <BubbleContent className="whitespace-pre-wrap">{entry.text}</BubbleContent>
              </Bubble>
            )}
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
  // 看过的图：缩略图放在这一行下面，和标题对齐
  const images = tool.images && tool.images.length > 0 && (
    <div className="pl-6">
      <ImageThumbs images={tool.images} small />
    </div>
  )
  if (!tool.detail)
    return (
      <>
        {line}
        {images}
      </>
    )
  return (
    <>
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
      {images}
    </>
  )
})

/** 一组图的缩略图，点了看大图（同一组里 ← → 切换）。人发的大一点、靠右；助手看过的（small）小一点 */
function ImageThumbs({ images, align = "start", small }: { images: AssistantImage[]; align?: "start" | "end"; small?: boolean }) {
  // 记 id：看大图时左右切换
  const [viewingId, setViewingId] = React.useState<string | null>(null)
  const viewing = images.find((image) => image.id === viewingId)
  return (
    <div className={cn("flex flex-wrap gap-1", align === "end" && "justify-end")}>
      {images.map((image) => (
        <Attachment key={image.id} orientation="vertical" title={image.name} className={small ? "w-16" : undefined}>
          <AttachmentMedia variant="image">
            <img src={image.url} alt={image.name} loading="lazy" />
          </AttachmentMedia>
          <AttachmentTrigger aria-label={`看大图：${image.name}`} onClick={() => setViewingId(image.id)} />
        </Attachment>
      ))}
      {viewing && <FileViewer file={viewing} images={images} onShow={(file) => setViewingId(file.id)} onClose={() => setViewingId(null)} />}
    </div>
  )
}

/** 人发的文件：一个一张小卡，靠右。能预览的（文本）点了看内容，PDF、Word 点了下载 */
function FileCards({ files }: { files: AssistantFile[] }) {
  const [viewingId, setViewingId] = React.useState<string | null>(null)
  const viewing = files.find((file) => file.id === viewingId)
  return (
    <div className="flex flex-wrap justify-end gap-1">
      {files.map((file) => {
        const Icon = fileTypeIcon(file)
        return (
          <Attachment key={file.id} size="sm" className="max-w-full sm:max-w-64">
            <AttachmentMedia>
              <Icon />
            </AttachmentMedia>
            <AttachmentContent>
              <AttachmentTitle title={file.name}>{file.name}</AttachmentTitle>
              <AttachmentDescription>{fmtSize(file.size)}</AttachmentDescription>
            </AttachmentContent>
            {canPreviewFile(file) ? (
              <AttachmentTrigger aria-label={`看内容：${file.name}`} onClick={() => setViewingId(file.id)} />
            ) : (
              <AttachmentTrigger aria-label={`下载 ${file.name}`} render={<a href={file.url} download={file.name} />} />
            )}
          </Attachment>
        )
      })}
      {viewing && <FileViewer file={viewing} images={[]} onShow={(file) => setViewingId(file.id)} onClose={() => setViewingId(null)} />}
    </div>
  )
}
