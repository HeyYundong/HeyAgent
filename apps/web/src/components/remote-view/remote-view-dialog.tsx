// 远程画面放进一个大弹窗：session 的「看浏览器」、要人办的事里的「去浏览器里处理」、浏览器页的「打开 Chrome」都用它，
// 区别只在底部的按钮（footer）。
// 弹窗能缩成小窗（Card，默认在右上角，按住标题栏拖到任意位置），小窗不挡页面，还能接着看、接着操作；点「放大」回到弹窗。
// 弹窗和小窗之间切换不重连：RemoteView 只渲染一份（portal 到一个固定的 div 里），切换时只把这个 div 挪到弹窗或小窗里。
import * as React from "react"
import { createPortal } from "react-dom"
import { Maximize2Icon, Minimize2Icon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

import { RemoteView } from "."

interface RemoteViewDialogProps {
  browserId: string
  title: React.ReactNode
  description?: React.ReactNode
  /** 底部按钮；不传就只有右上角的关闭 */
  footer?: React.ReactNode
  open: boolean
  onOpenChange: (open: boolean) => void
  onClosed?: (reason: string) => void
  /** 只看不操作 */
  viewOnly?: boolean
}

type Point = { x: number; y: number }

export function RemoteViewDialog({ browserId, title, description, footer, open, onOpenChange, onClosed, viewOnly }: RemoteViewDialogProps) {
  const [minimized, setMinimized] = React.useState(false)
  // 小窗拖到的位置；没拖过就在右上角。缩小、放大几次都记着
  const [position, setPosition] = React.useState<Point | null>(null)
  const [host] = React.useState(() => document.createElement("div"))
  // 把放 RemoteView 的 div 挪进弹窗或小窗
  const slot = React.useCallback((element: HTMLDivElement | null) => {
    if (element && host.parentElement !== element) element.appendChild(host)
  }, [host])
  // 关掉以后下次打开是大弹窗
  if (!open && minimized) setMinimized(false)

  return (
    <>
      {/* 点弹窗外面不关：人在画面里拖滑块时很容易拖出边界 */}
      <Dialog open={open && !minimized} onOpenChange={(next, details) => (next || details.reason !== "outside-press") && onOpenChange(next)}>
        <DialogContent showCloseButton={false} className="max-h-svh overflow-y-auto sm:max-w-5xl">
          <div className="absolute top-2 right-2 flex gap-1">
            <Tooltip>
              <TooltipTrigger render={<Button variant="ghost" size="icon-sm" aria-label="缩成小窗" onClick={() => setMinimized(true)} />}>
                <Minimize2Icon />
              </TooltipTrigger>
              <TooltipContent>缩成小窗</TooltipContent>
            </Tooltip>
            <DialogClose render={<Button variant="ghost" size="icon-sm" aria-label="关闭" />}>
              <XIcon />
            </DialogClose>
          </div>
          <DialogHeader className="pr-16">
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          <div ref={slot} />
          {footer && <DialogFooter className="sm:items-center">{footer}</DialogFooter>}
        </DialogContent>
      </Dialog>
      {open && minimized && (
        <MiniWindow title={title} initial={position} onMoved={setPosition} slot={slot} onRestore={() => setMinimized(false)} onClose={() => onOpenChange(false)} />
      )}
      {open && createPortal(<RemoteView browserId={browserId} onClosed={onClosed} viewOnly={viewOnly} compact={minimized} />, host)}
    </>
  )
}

/** 把小窗放到 point（左上角），不让它跑出窗口；返回实际放到的位置 */
function moveTo(element: HTMLElement, point: Point): Point {
  const x = Math.round(Math.min(Math.max(point.x, 0), Math.max(window.innerWidth - element.offsetWidth, 0)))
  const y = Math.round(Math.min(Math.max(point.y, 0), Math.max(window.innerHeight - element.offsetHeight, 0)))
  // 只是挪小窗的位置，不是样式
  element.style.left = `${x}px`
  element.style.top = `${y}px`
  element.style.right = "auto"
  return { x, y }
}

/** 小窗：默认在右上角，按住标题栏拖动 */
function MiniWindow({ title, initial, onMoved, slot, onRestore, onClose }: {
  title: React.ReactNode
  /** 上次拖到的位置；null 就在右上角 */
  initial: Point | null
  onMoved: (point: Point) => void
  slot: (element: HTMLDivElement | null) => void
  onRestore: () => void
  onClose: () => void
}) {
  const boxRef = React.useRef<HTMLDivElement | null>(null)
  const drag = React.useRef<{ dx: number; dy: number } | null>(null)
  const position = React.useRef(initial)

  React.useLayoutEffect(() => {
    const box = boxRef.current
    if (box && position.current) position.current = moveTo(box, position.current)
    // 浏览器窗口变小了：拖过的小窗挪回窗口里
    const onResize = () => {
      if (boxRef.current && position.current) position.current = moveTo(boxRef.current, position.current)
    }
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const box = boxRef.current
    // 标题栏上的按钮照常点
    if (!box || event.button !== 0 || (event.target as HTMLElement).closest("button")) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    const rect = box.getBoundingClientRect()
    drag.current = { dx: event.clientX - rect.left, dy: event.clientY - rect.top }
  }
  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!drag.current || !boxRef.current) return
    position.current = moveTo(boxRef.current, { x: event.clientX - drag.current.dx, y: event.clientY - drag.current.dy })
  }
  const endDrag = () => {
    if (drag.current && position.current) onMoved(position.current)
    drag.current = null
  }

  return createPortal(
    <Card ref={boxRef} size="sm" role="dialog" aria-label="远程画面小窗" className="fixed top-4 right-4 z-50 w-80 sm:w-md">
      <CardHeader className="cursor-move touch-none select-none" onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={endDrag} onPointerCancel={endDrag}>
        <CardTitle className="truncate">{title}</CardTitle>
        <CardAction className="flex gap-1">
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="放大" onClick={onRestore} />}>
              <Maximize2Icon />
            </TooltipTrigger>
            <TooltipContent>放大</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger render={<Button variant="ghost" size="icon-xs" aria-label="关闭" onClick={onClose} />}>
              <XIcon />
            </TooltipTrigger>
            <TooltipContent>关闭</TooltipContent>
          </Tooltip>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div ref={slot} />
      </CardContent>
    </Card>,
    document.body,
  )
}
