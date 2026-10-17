// 远程画面（自定义组件，登记在 docs/ui-rules.md 第 8 节）：看、操作服务器上的 Chrome。
// 组件库没有「远程桌面 / 画面」类组件，这里用 canvas 画 JPEG 帧，外面全部用 registry 组件组合：
// 工具栏 Button + Input、标签页 Tabs、状态 Badge、网页弹框 AlertDialog、加载 Spinner、关闭后 Empty。
// - 坐标按 meta.width/height（页面视口的 CSS 像素）换算；
// - 键盘和输入法：焦点放在一个看不见的 textarea 上，组好的中文和粘贴的文字发 { t: "text" }，其余按键发 key 消息；
// - 没有操作权限（meta.canControl = false）时只读：不发任何输入，工具栏和标签页都禁用。
import * as React from "react"
import { ArrowLeftIcon, ArrowRightIcon, EyeIcon, MonitorOffIcon, RotateCwIcon, XIcon } from "lucide-react"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Input } from "@/components/ui/input"
import { Spinner } from "@/components/ui/spinner"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

import { buttonOf, keyDownMessage, keyUpMessage, modifiersOf, normalizeAddress, pressedButton, textChunks, toPage, wheelDelta } from "./input"
import { useRemoteView, type PageDialog, type RemoteViewState } from "./use-remote-view"

export interface RemoteViewProps {
  browserId: string
  className?: string
  /** Chrome 关了（服务端发了 closed，或一直连不上） */
  onClosed?: (reason: string) => void
  /** 只看不操作 */
  viewOnly?: boolean
}

export function RemoteView({ browserId, className, onClosed, viewOnly }: RemoteViewProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null)
  const view = useRemoteView(browserId, canvasRef, viewOnly)
  const { status, meta, send } = view
  const canControl = status === "open" && Boolean(meta?.canControl)
  const closedReason = status === "closed" ? (view.reason ?? "远程画面已断开") : undefined

  React.useEffect(() => {
    if (closedReason) onClosed?.(closedReason)
  }, [closedReason, onClosed])

  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)}>
      <Toolbar view={view} canControl={canControl} />
      {meta && meta.tabs.length > 1 && <BrowserTabs view={view} canControl={canControl} />}
      <Screen view={view} canvasRef={canvasRef} canControl={canControl} closedReason={closedReason} />
      <p className="text-xs text-muted-foreground">
        {canControl
          ? "点一下画面就能直接操作：打字、回车、滚动都会发到服务器上的 Chrome。中文用本机输入法，粘贴用 Ctrl+V。看不到 Chrome 自己的地址栏，用上面的地址栏。"
          : meta && !meta.canControl
            ? "只读：你能看，不能操作。只有任务负责人、被分配处理的人和主管（登录用的 Chrome 是打开它的人）能操作。"
            : "连上以后显示服务器上这个 Chrome 的实时画面。"}
      </p>
      <PageDialogPrompt dialog={view.dialog} canControl={canControl} onDismiss={view.dismissDialog} onAnswer={(accept, promptText) => {
        send({ t: "dialog", accept, ...(promptText !== undefined ? { promptText } : {}) })
        view.dismissDialog()
      }} />
    </div>
  )
}

type View = ReturnType<typeof useRemoteView>

const STATUS_TEXT: Record<RemoteViewState["status"], string> = { connecting: "连接中", open: "已连接", reconnecting: "重连中", closed: "已断开" }

function StatusBadge({ view, canControl }: { view: View; canControl: boolean }) {
  if (view.status === "open" && view.meta && !view.meta.canControl)
    return <Badge variant="outline"><EyeIcon data-icon="inline-start" />只读</Badge>
  if (view.status === "connecting" || view.status === "reconnecting")
    return <Badge variant="secondary"><Spinner data-icon="inline-start" />{STATUS_TEXT[view.status]}</Badge>
  if (view.status === "closed") return <Badge variant="destructive">已断开</Badge>
  return <Badge variant="outline">{canControl ? "可以操作" : STATUS_TEXT[view.status]}</Badge>
}

/** 后退 / 前进 / 刷新 + 地址栏 + 连接状态 */
function Toolbar({ view, canControl }: { view: View; canControl: boolean }) {
  const url = view.meta?.url ?? ""
  const [draft, setDraft] = React.useState(url)
  const [editing, setEditing] = React.useState(false)
  // 没在改的时候，地址栏跟着页面走
  if (!editing && draft !== url) setDraft(url)

  function go(event: React.FormEvent) {
    event.preventDefault()
    const next = normalizeAddress(draft)
    if (next) view.send({ t: "nav", action: "goto", url: next })
    setEditing(false)
    ;(document.activeElement as HTMLElement | null)?.blur()
  }

  const nav = [
    { label: "后退", icon: <ArrowLeftIcon />, action: "back" as const },
    { label: "前进", icon: <ArrowRightIcon />, action: "forward" as const },
    { label: "刷新", icon: <RotateCwIcon />, action: "reload" as const },
  ]
  return (
    <div className="flex items-center gap-1">
      {nav.map((button) => (
        <Tooltip key={button.action}>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label={button.label} disabled={!canControl} onClick={() => view.send({ t: "nav", action: button.action })} />}>
            {button.icon}
          </TooltipTrigger>
          <TooltipContent>{button.label}</TooltipContent>
        </Tooltip>
      ))}
      <form onSubmit={go} className="min-w-0 flex-1">
        <Input
          aria-label="地址栏"
          className="font-mono"
          spellCheck={false}
          value={draft}
          disabled={!canControl}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation()
              setDraft(url)
              event.currentTarget.blur()
            }
          }}
        />
      </form>
      <StatusBadge view={view} canControl={canControl} />
    </div>
  )
}

/** Chrome 里开着好几个标签页时才显示：切换、关掉当前这个（最后一个不能关） */
function BrowserTabs({ view, canControl }: { view: View; canControl: boolean }) {
  const tabs = view.meta?.tabs ?? []
  const active = tabs.find((tab) => tab.active)
  return (
    <div className="flex min-w-0 items-center gap-1">
      <Tabs value={active ? String(active.id) : null} onValueChange={(value) => view.send({ t: "tab", id: Number(value) })} className="min-w-0 flex-1">
        <TabsList variant="line" className="w-full justify-start overflow-x-auto no-scrollbar">
          {tabs.map((tab) => (
            <TabsTrigger key={tab.id} value={String(tab.id)} disabled={!canControl} title={tab.url} className="max-w-48 flex-none">
              <span className="truncate">{tab.title || tab.url || "新标签页"}</span>
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      {active && (
        <Tooltip>
          <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="关闭当前标签页" disabled={!canControl || tabs.length < 2} onClick={() => view.send({ t: "closeTab", id: active.id })} />}>
            <XIcon />
          </TooltipTrigger>
          <TooltipContent>关闭当前标签页</TooltipContent>
        </Tooltip>
      )}
    </div>
  )
}

/** 画面 + 输入：鼠标在 canvas 上，键盘和输入法在看不见的 textarea 上 */
function Screen({ view, canvasRef, canControl, closedReason }: { view: View; canvasRef: React.RefObject<HTMLCanvasElement | null>; canControl: boolean; closedReason?: string }) {
  const { send, meta } = view
  const stageRef = React.useRef<HTMLDivElement | null>(null)
  const imeRef = React.useRef<HTMLTextAreaElement | null>(null)
  const [focused, setFocused] = React.useState(false)
  const composing = React.useRef(false)
  // 刚组好的字：有的浏览器（Safari）组字结束后还会再来一次 insertText，别发两遍
  const lastComposed = React.useRef({ text: "", at: 0 })
  const pressedKeys = React.useRef(new Set<string>())
  // 不按键时的鼠标移动每帧只发一次；按着键拖动（例如拖滑块）每个事件都发
  const hover = React.useRef<{ frame: number; message?: Parameters<typeof send>[0] }>({ frame: 0 })

  const size = () => {
    const canvas = canvasRef.current
    return meta && meta.width > 0 && meta.height > 0 ? { width: meta.width, height: meta.height } : { width: canvas?.width ?? 0, height: canvas?.height ?? 0 }
  }
  const point = (event: { clientX: number; clientY: number }) => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    return toPage(event.clientX, event.clientY, canvas.getBoundingClientRect(), size())
  }

  // 滚轮要能 preventDefault（不让外面的弹窗跟着滚），React 的 onWheel 是 passive 的，只能自己挂
  React.useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || !canControl) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      const box = canvas.getBoundingClientRect()
      const target = meta && meta.width > 0 ? { width: meta.width, height: meta.height } : { width: canvas.width, height: canvas.height }
      send({ t: "mouse", type: "mouseWheel", ...toPage(event.clientX, event.clientY, box, target), ...wheelDelta(event), modifiers: modifiersOf(event) })
    }
    canvas.addEventListener("wheel", onWheel, { passive: false })
    return () => canvas.removeEventListener("wheel", onWheel)
  }, [canvasRef, canControl, meta, send])

  React.useEffect(() => () => cancelAnimationFrame(hover.current.frame), [])

  /** 把输入框挪到点的位置（输入法候选框会出现在这里），再把焦点给它 */
  function focusInput(event: React.PointerEvent) {
    const ime = imeRef.current
    const stage = stageRef.current
    if (!ime || !stage) return
    const box = stage.getBoundingClientRect()
    // 只是挪一个看不见的 1px 输入框，不是样式
    ime.style.left = `${Math.round(event.clientX - box.left)}px`
    ime.style.top = `${Math.round(event.clientY - box.top)}px`
    ime.focus({ preventScroll: true })
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canControl) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    focusInput(event)
    send({ t: "mouse", type: "mousePressed", ...point(event), button: buttonOf(event.button), buttons: event.buttons, clickCount: Math.min(Math.max(event.detail, 1), 3), modifiers: modifiersOf(event) })
  }
  const onPointerUp = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canControl) return
    send({ t: "mouse", type: "mouseReleased", ...point(event), button: buttonOf(event.button), buttons: event.buttons, clickCount: Math.min(Math.max(event.detail, 1), 3), modifiers: modifiersOf(event) })
  }
  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>) => {
    if (!canControl) return
    const message = { t: "mouse" as const, type: "mouseMoved" as const, ...point(event), button: pressedButton(event.buttons), buttons: event.buttons, modifiers: modifiersOf(event) }
    if (event.buttons) {
      send(message)
      return
    }
    hover.current.message = message
    if (hover.current.frame) return
    hover.current.frame = requestAnimationFrame(() => {
      hover.current.frame = 0
      if (hover.current.message) send(hover.current.message)
    })
  }

  const sendText = (text: string) => textChunks(text).forEach((chunk) => send({ t: "text", text: chunk }))

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // 输入法正在组字：交给输入法，组好了在 compositionend 里发
    if (event.nativeEvent.isComposing || event.keyCode === 229) return
    // 不让外面的弹窗收到（Esc 会关掉弹窗、Tab 会把焦点移走）
    event.stopPropagation()
    if (!canControl) return
    const command = event.ctrlKey || event.metaKey
    // Ctrl+V：让 paste 事件拿本机剪贴板的文字
    if (command && event.key.toLowerCase() === "v") return
    event.preventDefault()
    send(keyDownMessage(event))
    pressedKeys.current.add(event.code)
  }
  const onKeyUp = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    event.stopPropagation()
    if (!canControl || !pressedKeys.current.has(event.code)) return
    pressedKeys.current.delete(event.code)
    send(keyUpMessage(event))
  }

  return (
    <div ref={stageRef} className={cn("relative overflow-hidden border bg-muted", focused && canControl && "ring-1 ring-ring")}>
      <canvas
        ref={canvasRef}
        width={960}
        height={540}
        aria-label={canControl ? "远程画面（可以操作）" : "远程画面（只读）"}
        // 页面视口的 CSS 像素尺寸：自动化测试按它算点哪里
        data-page-width={meta?.width}
        data-page-height={meta?.height}
        className={cn("block h-auto w-full touch-none select-none", !view.hasFrame && "invisible")}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerMove={onPointerMove}
        onContextMenu={(event) => event.preventDefault()}
      />
      <textarea
        ref={imeRef}
        aria-label="远程画面的键盘输入"
        tabIndex={-1}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        className="pointer-events-none absolute top-0 left-0 size-px resize-none overflow-hidden border-0 p-0 opacity-0"
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onCompositionStart={() => (composing.current = true)}
        onCompositionEnd={(event) => {
          composing.current = false
          if (canControl && event.data) sendText(event.data)
          lastComposed.current = { text: event.data, at: performance.now() }
          event.currentTarget.value = ""
        }}
        onInput={(event) => {
          const native = event.nativeEvent as InputEvent
          // 不经过 keydown 的直接输入（部分软键盘）兜底；输入法组字过程中的不管
          const repeat = native.data === lastComposed.current.text && performance.now() - lastComposed.current.at < 100
          if (canControl && !composing.current && !native.isComposing && !repeat && native.inputType === "insertText" && native.data) sendText(native.data)
          if (!composing.current) event.currentTarget.value = ""
        }}
        onPaste={(event) => {
          event.preventDefault()
          const text = event.clipboardData.getData("text/plain")
          if (canControl && text) sendText(text)
        }}
      />
      {!view.hasFrame && !closedReason && (
        <div className="absolute inset-0 flex items-center justify-center gap-2 text-sm text-muted-foreground">
          <Spinner />
          {view.status === "open" ? "等第一帧画面…" : "正在连接远程画面…"}
        </div>
      )}
      {closedReason && (
        <Empty className="absolute inset-0 bg-background/90">
          <EmptyHeader>
            <EmptyMedia variant="icon"><MonitorOffIcon /></EmptyMedia>
            <EmptyTitle>远程画面已断开</EmptyTitle>
            <EmptyDescription>{closedReason}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      )}
    </div>
  )
}

const DIALOG_KIND: Record<string, string> = { alert: "网页提示", confirm: "网页确认", prompt: "网页要你输入", beforeunload: "离开这个页面？" }

/** 网页弹出的 alert / confirm / prompt：Chrome 自己的弹框看不到，显示成这里的对话框 */
function PageDialogPrompt({ dialog, canControl, onAnswer, onDismiss }: { dialog?: PageDialog; canControl: boolean; onAnswer: (accept: boolean, promptText?: string) => void; onDismiss: () => void }) {
  const [text, setText] = React.useState("")
  const [shown, setShown] = React.useState<PageDialog | undefined>(dialog)
  if (dialog && dialog !== shown) {
    setShown(dialog)
    setText(dialog.defaultValue ?? "")
  }
  const current = dialog ?? shown
  const isPrompt = current?.kind === "prompt"
  return (
    // Esc：能操作的人等于点「取消」；只读的人只是在本地收起来，网页上的弹框还在
    <AlertDialog open={Boolean(dialog)} onOpenChange={(open) => !open && (canControl ? onAnswer(false) : onDismiss())}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{DIALOG_KIND[current?.kind ?? ""] ?? "网页弹框"}</AlertDialogTitle>
          <AlertDialogDescription className="whitespace-pre-wrap">{current?.message || "（没有文字）"}</AlertDialogDescription>
        </AlertDialogHeader>
        {isPrompt && <Input aria-label="要填的内容" value={text} disabled={!canControl} onChange={(event) => setText(event.target.value)} />}
        {!canControl && <p className="text-xs text-muted-foreground">你没有操作权限，等能操作的人处理。</p>}
        <AlertDialogFooter>
          {current?.kind !== "alert" && <AlertDialogCancel disabled={!canControl} onClick={() => onAnswer(false)}>取消</AlertDialogCancel>}
          <AlertDialogAction disabled={!canControl} onClick={() => onAnswer(true, isPrompt ? text : undefined)}>确定</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
