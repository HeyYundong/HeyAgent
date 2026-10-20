// 右下角助手（docs/dev/copilot.md 第 2、9.4 节）：每一页右下角一个圆按钮，点开是对话面板。
// 用中文说要新建、修改、删除什么，助手查清楚后列成改动确认卡，人点「应用」才改；改了库，开着的页面由 LiveSync 刷新。
// 面板：宽屏是固定在右下角的 Card（不挡整页，可以边看边说），窄屏是全屏的 Sheet。开关和当前对话记在 localStorage。
// 「浮动面板」registry 里没有，用 Card 加 fixed 定位，只是定位、不改外观（docs/ui-rules.md 第 8 节登记）。
// 可以发图和文件（2026-10-20）：输入框左下「加附件」、在输入框里粘贴、拖到面板上，见 composer-images.tsx。
// 文件是文本（md、txt、html、csv、json……）和 PDF、Word（.docx），服务器抽出文字给模型（docs/dev/copilot.md 第 12 节）。
import * as React from "react"
import { ArrowUpIcon, BotIcon, CircleAlertIcon, Maximize2Icon, Minimize2Icon, MinusIcon, PaperclipIcon, SquareIcon, SquarePenIcon } from "lucide-react"
import { ASSISTANT_MAX_FILES, ASSISTANT_MAX_IMAGES, ASSISTANT_MAX_MESSAGE } from "@heyagent/shared"

import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { InputGroup, InputGroupAddon, InputGroupButton, InputGroupText, InputGroupTextarea } from "@/components/ui/input-group"
import { Sheet, SheetContent, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { Skeleton } from "@/components/ui/skeleton"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useIsMobile } from "@/hooks/use-mobile"

import { errorMessage } from "@/lib/mutations"
import { cn } from "@/lib/utils"

import { ATTACHMENT_ACCEPT, hasFiles, PendingAttachmentList, usePendingAttachments, type PendingAttachments } from "./composer-images"
import { HistoryButton } from "./history"
import { ChatSettingsButton } from "./settings"
import { useAssistant, useStoredExpanded, useStoredOpen, type AssistantState } from "./use-assistant"

// 记录（Markdown、代码块、滚动容器）按需加载：不打开面板就不下载
const Transcript = React.lazy(() => import("./transcript"))

/** 空对话时的示例，点了填进输入框（界面举例，可以是业务例子） */
const EXAMPLES = ["把这个任务的定时改成每天早上 9 点", "新建一个技能，教 agent 怎么导出订单表", "新建一个任务，每天早上 9 点检查新订单", "哪些任务还在用旧的模型？都换成默认的"]

export function AssistantWidget() {
  const [open, setOpen] = useStoredOpen()
  const [expanded, setExpanded] = useStoredExpanded()
  const assistant = useAssistant()
  const isMobile = useIsMobile()
  const buttonRef = React.useRef<HTMLButtonElement>(null)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)
  const [draft, setDraft] = React.useState("")
  const attachments = usePendingAttachments()
  const [dragging, setDragging] = React.useState(false)

  const close = () => {
    setOpen(false)
    // 收起后焦点回到按钮（按钮这时才重新出现，等它渲染出来）
    requestAnimationFrame(() => buttonRef.current?.focus())
  }
  const pickExample = (text: string) => {
    setDraft(text)
    inputRef.current?.focus()
  }

  const body = <PanelBody assistant={assistant} onExample={pickExample} onNavigate={isMobile ? close : undefined} />
  const composer = <Composer assistant={assistant} draft={draft} onDraft={setDraft} attachments={attachments} dragging={dragging} inputRef={inputRef} />
  // 图片、文件拖到面板上任何地方都算（不然拖到记录上松手，浏览器会打开那个文件、离开当前页）
  const dropProps = {
    onDragOver: (event: React.DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setDragging(true)
    },
    onDragLeave: (event: React.DragEvent) => {
      // 移到面板里的子元素上也会触发，真离开面板才算
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
    },
    onDrop: (event: React.DragEvent) => {
      if (!hasFiles(event)) return
      event.preventDefault()
      setDragging(false)
      attachments.add(event.dataTransfer.files)
    },
  }

  if (isMobile) {
    return (
      <>
        {!open && <LauncherButton ref={buttonRef} onClick={() => setOpen(true)} />}
        <Sheet open={open} onOpenChange={(next) => (next ? setOpen(true) : close())}>
          <SheetContent side="bottom" showCloseButton={false} className="gap-0 data-[side=bottom]:h-dvh" {...dropProps}>
            <SheetHeader className="flex-row items-center gap-1 border-b p-3">
              <SheetTitle className="mr-auto">助手</SheetTitle>
              <HeaderActions assistant={assistant} onClose={close} />
            </SheetHeader>
            <div className="flex min-h-0 flex-1 flex-col">{body}</div>
            <SheetFooter className="mt-0 border-t p-3">{composer}</SheetFooter>
          </SheetContent>
        </Sheet>
      </>
    )
  }

  if (!open) return <LauncherButton ref={buttonRef} onClick={() => setOpen(true)} />

  // 放大：占右边一半宽、上下撑满（长的确认卡、技能正文看得全）；还原：右下角的小面板
  return (
    <Card
      size="sm"
      role="dialog"
      aria-label="助手"
      className={cn("fixed right-4 bottom-4 z-50 gap-0 shadow-lg", expanded ? "top-4 w-1/2 min-w-96" : "h-160 max-h-11/12 w-96")}
      {...dropProps}
    >
      <CardHeader className="flex items-center gap-1 border-b">
        <CardTitle className="mr-auto">助手</CardTitle>
        <CardAction className="flex items-center gap-1">
          <HeaderActions assistant={assistant} onClose={close} expanded={expanded} onToggleExpanded={() => setExpanded(!expanded)} />
        </CardAction>
      </CardHeader>
      <CardContent className="flex min-h-0 flex-1 flex-col overflow-hidden p-0">{body}</CardContent>
      <CardFooter>{composer}</CardFooter>
    </Card>
  )
}

function LauncherButton({ ref, onClick }: { ref: React.Ref<HTMLButtonElement>; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button ref={ref} size="icon-lg" className="fixed right-4 bottom-4 z-50 rounded-full shadow-lg" aria-label="助手" onClick={onClick} />}>
        <BotIcon />
      </TooltipTrigger>
      <TooltipContent side="left">助手：说要改什么，我来改</TooltipContent>
    </Tooltip>
  )
}

/** 标题栏右边：以前的对话、本对话的设置（模型、上限）、新对话、放大 / 还原（宽屏才有）、收起 */
function HeaderActions({ assistant, onClose, expanded, onToggleExpanded }: { assistant: AssistantState; onClose: () => void; expanded?: boolean; onToggleExpanded?: () => void }) {
  const busy = !!assistant.busy
  return (
    <>
      <HistoryButton currentId={assistant.chatId} disabled={busy} onOpenChat={assistant.openChat} onDeleted={assistant.forget} />
      <ChatSettingsButton key={assistant.chatId ?? "new"} chatId={assistant.chatId} settings={assistant.settings} disabled={busy} onDraft={assistant.setDraftSettings} />
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="新对话" disabled={busy || !assistant.chatId} onClick={assistant.newChat} />}>
          <SquarePenIcon />
        </TooltipTrigger>
        <TooltipContent>新对话</TooltipContent>
      </Tooltip>
      {onToggleExpanded && (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={expanded ? "还原" : "放大"} onClick={onToggleExpanded} />}>
            {expanded ? <Minimize2Icon /> : <Maximize2Icon />}
          </TooltipTrigger>
          <TooltipContent>{expanded ? "还原" : "放大"}</TooltipContent>
        </Tooltip>
      )}
      <Tooltip>
        <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="收起" onClick={onClose} />}>
          <MinusIcon />
        </TooltipTrigger>
        <TooltipContent>收起</TooltipContent>
      </Tooltip>
    </>
  )
}

function PanelBody({ assistant, onExample, onNavigate }: { assistant: AssistantState; onExample: (text: string) => void; onNavigate?: () => void }) {
  // 记录里每一行（memo）拿到的 onDecide 保持同一个函数，流式接字时不跟着重画
  const decideRef = React.useRef(assistant.decide)
  React.useEffect(() => {
    decideRef.current = assistant.decide
  })
  const onDecide = React.useCallback((proposalId: string, accept: boolean, note?: string) => void decideRef.current(proposalId, accept, note), [])

  if (assistant.loading) return <TranscriptSkeleton />
  if (assistant.loadError) {
    return (
      <div className="p-3">
        <Alert variant="destructive">
          <CircleAlertIcon />
          <AlertDescription>没读到这段对话：{errorMessage(assistant.loadError)}</AlertDescription>
          <AlertAction>
            <Button variant="outline" size="xs" onClick={assistant.reload}>
              重试
            </Button>
          </AlertAction>
        </Alert>
      </div>
    )
  }
  const entries = assistant.chat?.entries ?? []
  if (entries.length === 0 && !assistant.busy) {
    return (
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <BotIcon />
            </EmptyMedia>
            <EmptyTitle>要改点什么？</EmptyTitle>
            <EmptyDescription>说要新建、修改或删除什么，也可以发截图、文件给我看。我先列出改动，你点「应用」才会改。</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            {EXAMPLES.map((text) => (
              <Button key={text} variant="outline" size="sm" className="w-full justify-start" onClick={() => onExample(text)}>
                <span className="truncate">{text}</span>
              </Button>
            ))}
          </EmptyContent>
        </Empty>
        {assistant.error && (
          <div className="p-3">
            <Alert variant="destructive">
              <CircleAlertIcon />
              <AlertDescription>{assistant.error}</AlertDescription>
            </Alert>
          </div>
        )}
      </div>
    )
  }
  return (
    // key：换一段对话时重新挂上滚动容器，打开时停在最底下
    <React.Suspense fallback={<TranscriptSkeleton />}>
      <Transcript key={assistant.viewKey} entries={entries} busy={assistant.busy} error={assistant.error} onDismissError={assistant.dismissError} onDecide={onDecide} onNavigate={onNavigate} />
    </React.Suspense>
  )
}

function TranscriptSkeleton() {
  return (
    <div className="flex flex-col gap-3 p-3">
      <Skeleton className="h-8 w-2/3 self-end" />
      <Skeleton className="h-16 w-full" />
      <Skeleton className="h-8 w-1/2 self-end" />
    </div>
  )
}

const costText = (usd: number) => `$${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(2)}`

/**
 * 输入框：回车发送，Shift+回车换行，输入法组字时回车不发送；请求进行中发送按钮变「停止」。
 * 上面一排是要一起发的图和文件：有字或有传好的附件才能发；还在上传、有没传上去的（先移除）时不能发
 */
function Composer({
  assistant,
  draft,
  onDraft,
  attachments,
  dragging,
  inputRef,
}: {
  assistant: AssistantState
  draft: string
  onDraft: React.Dispatch<React.SetStateAction<string>>
  attachments: PendingAttachments
  dragging: boolean
  inputRef: React.Ref<HTMLTextAreaElement>
}) {
  const pickRef = React.useRef<HTMLInputElement>(null)
  const busy = !!assistant.busy
  const cost = assistant.chat?.costUsd ?? 0
  const canSend = !busy && !assistant.loading && (draft.trim().length > 0 || attachments.ready > 0) && !attachments.uploading && !attachments.failed
  const problem = attachments.notice ?? (attachments.failed ? "有附件没传上去，移除后才能发。" : null)

  const submit = async () => {
    if (!canSend) return
    const text = draft
    const sent = attachments.take()
    onDraft("")
    const result = await assistant.send(text, sent.images, sent.files)
    // 没发出去（例如这个模型不能看图、文件不是文本）：原文、图和文件放回输入框（人这期间又打了字、加了附件就不覆盖）
    if (!result.ok) {
      onDraft((current) => (current.trim() ? current : result.restore.text))
      attachments.restore(result.restore)
    }
  }

  return (
    <form
      className="w-full"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      <input
        ref={pickRef}
        type="file"
        accept={ATTACHMENT_ACCEPT}
        multiple
        className="hidden"
        aria-label="选择图片或文件"
        onChange={(event) => {
          attachments.add(event.target.files ?? [])
          event.target.value = ""
        }}
      />
      <InputGroup>
        {(attachments.items.length > 0 || dragging || problem) && (
          <InputGroupAddon align="block-start" className="flex-col items-start">
            {attachments.items.length > 0 && <PendingAttachmentList attachments={attachments} />}
            {dragging ? (
              <InputGroupText>
                <PaperclipIcon />
                松开就加上
              </InputGroupText>
            ) : (
              problem && <span className="text-destructive">{problem}</span>
            )}
          </InputGroupAddon>
        )}
        <InputGroupTextarea
          ref={inputRef}
          autoFocus
          rows={2}
          maxLength={ASSISTANT_MAX_MESSAGE}
          className="max-h-40"
          value={draft}
          placeholder="说要改什么（可以贴图、加文件），回车发送"
          aria-label="给助手的话"
          onChange={(event) => onDraft(event.target.value)}
          onPaste={(event) => {
            // 截图、「复制图片」、复制的文件只有文件没有文字：加成附件；同时带文字的（例如从表格里复制）照常粘贴文字
            const files = [...event.clipboardData.files]
            if (files.length === 0 || event.clipboardData.getData("text/plain")) return
            event.preventDefault()
            attachments.add(files)
          }}
          onKeyDown={(event) => {
            // 输入法组字时的回车是选字（Safari 上 isComposing 已经是 false，但 keyCode 是 229）
            if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || event.keyCode === 229) return
            event.preventDefault()
            void submit()
          }}
        />
        <InputGroupAddon align="block-end">
          <Tooltip>
            <TooltipTrigger render={<InputGroupButton variant="ghost" size="icon-sm" aria-label="加附件" disabled={attachments.full} onClick={() => pickRef.current?.click()} />}>
              <PaperclipIcon />
            </TooltipTrigger>
            <TooltipContent>{attachments.full ? `最多 ${ASSISTANT_MAX_IMAGES} 张图、${ASSISTANT_MAX_FILES} 个文件` : "加附件（图片、文本文件、PDF、Word）"}</TooltipContent>
          </Tooltip>
          {cost > 0 && <InputGroupText>这段对话花了 {costText(cost)}</InputGroupText>}
          {busy ? (
            <InputGroupButton type="button" variant="outline" size="sm" className="ml-auto" onClick={assistant.stop}>
              <SquareIcon data-icon="inline-start" />
              停止
            </InputGroupButton>
          ) : (
            <InputGroupButton type="submit" variant="default" size="icon-sm" className="ml-auto" aria-label="发送" disabled={!canSend}>
              <ArrowUpIcon />
            </InputGroupButton>
          )}
        </InputGroupAddon>
      </InputGroup>
    </form>
  )
}
