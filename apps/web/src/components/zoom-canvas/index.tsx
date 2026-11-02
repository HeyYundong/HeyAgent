// 能缩放、拖动的画布 `ZoomCanvas`（docs/ui-rules.md 第 8 节登记，2026-11-02）：任务抽屉的「结构图」用。
// 默认「适应」：把里面的图整个缩放进可用的地方，不出滚动条；画布的宽度跟着地方变（minWidth ～ maxWidth 之间挑一个让字最大的宽度；默认不放大，最多 100%，地方大时画布排宽一些、多出来的地方留白），
// 地方变了（拖窗口、开全屏）、内容变高了就重新适应。人缩放、拖过以后就保持人定的样子，点「适应」回去。
// 缩放：右上角的按钮、Ctrl / ⌘ + 滚轮（触控板捏合也是这个）、两指捏合；键盘焦点在图里时 + / - 缩放、0 适应。
// 拖动：按住拖（动了 5 px 以上才算拖，不然还是点击）、不按 Ctrl 的滚轮在图比地方大时平移；Tab 到看不见的块会自动挪进来。
// 位置和缩放写在画布 ref 的 style.transform 上（和 RemoteView、AgentCursor 一样在 ref 上改，JSX 里没有 style={{}}）；
// 地方用 overflow-clip：既不出滚动条，也不会被浏览器聚焦时偷偷滚动。
import * as React from "react"
import { ScanIcon, ZoomInIcon, ZoomOutIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const MIN_SCALE = 0.3
const MAX_SCALE = 3
const STEP = 1.25
/** 图和地方边上留的空 */
const PAD = 16
/** 按下后动了这么多 px 才算拖，不然是点击 */
const DRAG_THRESHOLD = 5

type View = { scale: number; x: number; y: number; manual: boolean }

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value))

/** 工具栏上的一个小按钮：图标 + 悬停提示 */
export function ZoomToolButton({ label, hint, onClick, disabled, children }: { label: string; hint?: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Button type="button" variant="outline" size="icon-sm" aria-label={label} onClick={onClick} disabled={disabled} />}>{children}</TooltipTrigger>
      <TooltipContent>{hint ?? label}</TooltipContent>
    </Tooltip>
  )
}

export function ZoomCanvas({ children, label, minWidth, maxWidth, maxFit = 1, actions, className }: {
  children: React.ReactNode
  /** 读屏用的名字，例如「任务结构图」 */
  label: string
  /** 画布最窄、最宽排多少 px（缩放前）；适应时在这中间挑 */
  minWidth: number
  maxWidth: number
  /** 适应时最多放大到多少；默认 1（只缩小不放大：放大了字、图标都傻大，2026-11-02 用户反馈） */
  maxFit?: number
  /** 工具栏右边多放的按钮（例如全屏） */
  actions?: React.ReactNode
  className?: string
}) {
  const viewportRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLDivElement>(null)
  const view = React.useRef<View>({ scale: 1, x: PAD, y: PAD, manual: false })
  /** 上一次适应时的尺寸：没变就不用重新适应（也避免 ResizeObserver 自己触发自己） */
  const fitted = React.useRef({ roomWidth: 0, roomHeight: 0, height: 0 })
  const pointers = React.useRef(new Map<number, { x: number; y: number }>())
  const drag = React.useRef<{ startX: number; startY: number; moved: boolean } | null>(null)
  const swallowClick = React.useRef(false)
  const [scale, setScale] = React.useState(1)

  const apply = React.useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const { scale: s, x, y } = view.current
    canvas.style.transform = `translate(${x}px, ${y}px) scale(${s})`
    setScale(s)
  }, [])

  /** 不让图跑出去：比地方小的整个留在里面，比地方大的不留出空边 */
  const clampPan = React.useCallback(() => {
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    if (!viewport || !canvas) return
    const v = view.current
    const keep = (pos: number, size: number, room: number) => (size <= room - 2 * PAD ? clamp(pos, PAD, room - size - PAD) : clamp(pos, room - size - PAD, PAD))
    v.x = keep(v.x, canvas.offsetWidth * v.scale, viewport.clientWidth)
    v.y = keep(v.y, canvas.offsetHeight * v.scale, viewport.clientHeight)
  }, [])

  /** 适应：挑一个画布宽度，让整张图放得下、字又尽量大（最多放大到 maxFit） */
  const fit = React.useCallback(() => {
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    if (!viewport || !canvas) return
    const roomWidth = viewport.clientWidth - 2 * PAD
    const roomHeight = viewport.clientHeight - 2 * PAD
    if (roomWidth <= 0 || roomHeight <= 0) return
    const measure = (width: number) => {
      canvas.style.width = `${width}px`
      return canvas.offsetHeight
    }
    const scaleAt = (width: number, height: number) => Math.min(maxFit, roomWidth / width, roomHeight / height)
    // 画布越宽越矮：宽度卡住的比例（roomWidth / 宽）越来越小，高度卡住的比例（roomHeight / 高）越来越大，二分找两条线交叉的宽度
    let low = minWidth
    let high = Math.max(minWidth, maxWidth)
    for (let round = 0; round < 10; round++) {
      const mid = (low + high) / 2
      if (roomHeight / measure(mid) < roomWidth / mid) low = mid
      else high = mid
    }
    // 候选：交叉点两边，和「放到最大比例时刚好占满宽度」的宽度；比例一样大的挑宽的（横着铺开，和屏幕一样扁）
    let width = low
    let height = measure(low)
    for (const candidate of [high, clamp(roomWidth / maxFit, minWidth, maxWidth)]) {
      const candidateHeight = measure(candidate)
      const better = scaleAt(candidate, candidateHeight) - scaleAt(width, height)
      if (better > 0.001 || (better > -0.001 && candidate > width)) {
        width = candidate
        height = candidateHeight
      }
    }
    height = measure(width)
    const s = Math.max(MIN_SCALE, scaleAt(width, height))
    view.current = { scale: s, x: PAD + (roomWidth - width * s) / 2, y: PAD + Math.max(0, (roomHeight - height * s) / 2), manual: false }
    fitted.current = { roomWidth, roomHeight, height }
    apply()
  }, [minWidth, maxWidth, maxFit, apply])

  /** 缩放到 next，(px, py) 这一点（相对地方左上角）不动；不传就是地方中间 */
  const zoomTo = React.useCallback((next: number, px?: number, py?: number) => {
    const viewport = viewportRef.current
    if (!viewport) return
    const v = view.current
    const target = clamp(next, MIN_SCALE, MAX_SCALE)
    const cx = px ?? viewport.clientWidth / 2
    const cy = py ?? viewport.clientHeight / 2
    v.x = cx - (cx - v.x) * (target / v.scale)
    v.y = cy - (cy - v.y) * (target / v.scale)
    v.scale = target
    v.manual = true
    clampPan()
    apply()
  }, [clampPan, apply])

  const panBy = React.useCallback((dx: number, dy: number) => {
    const v = view.current
    v.x += dx
    v.y += dy
    v.manual = true
    clampPan()
    apply()
  }, [clampPan, apply])

  // 第一次画之前适应好；之后地方、内容大小变了：没手动缩放过就重新适应，缩放过就只管别跑出去
  React.useLayoutEffect(() => {
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    if (!viewport || !canvas) return
    fit()
    let frame = 0
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        const last = fitted.current
        if (!view.current.manual) {
          if (viewport.clientWidth - 2 * PAD !== last.roomWidth || viewport.clientHeight - 2 * PAD !== last.roomHeight || canvas.offsetHeight !== last.height) fit()
        } else {
          clampPan()
          apply()
        }
      })
    })
    observer.observe(viewport)
    observer.observe(canvas)
    return () => {
      cancelAnimationFrame(frame)
      observer.disconnect()
    }
  }, [fit, clampPan, apply])

  // 滚轮要能 preventDefault（不让浏览器整页缩放），React 的 onWheel 是 passive 的，只能自己挂
  React.useEffect(() => {
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    if (!viewport || !canvas) return
    const onWheel = (event: WheelEvent) => {
      const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1
      if (event.ctrlKey || event.metaKey) {
        event.preventDefault()
        const rect = viewport.getBoundingClientRect()
        zoomTo(view.current.scale * Math.exp(-event.deltaY * unit * 0.002), event.clientX - rect.left, event.clientY - rect.top)
        return
      }
      // 不按 Ctrl：图比地方大时平移，放得下就不管
      const s = view.current.scale
      const overflows = canvas.offsetWidth * s > viewport.clientWidth - 2 * PAD + 1 || canvas.offsetHeight * s > viewport.clientHeight - 2 * PAD + 1
      if (!overflows) return
      event.preventDefault()
      const sideways = event.shiftKey && event.deltaX === 0
      panBy(-(sideways ? event.deltaY : event.deltaX) * unit, -(sideways ? 0 : event.deltaY) * unit)
    }
    viewport.addEventListener("wheel", onWheel, { passive: false })
    return () => viewport.removeEventListener("wheel", onWheel)
  }, [zoomTo, panBy])

  const onPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || (event.target as Element).closest("[data-zoom-toolbar]")) return
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 1) drag.current = { startX: event.clientX, startY: event.clientY, moved: false }
  }

  const onPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const viewport = viewportRef.current
    const before = pointers.current.get(event.pointerId)
    const current = drag.current
    if (!viewport || !before || !current) return
    if (!current.moved) {
      if (pointers.current.size < 2 && Math.hypot(event.clientX - current.startX, event.clientY - current.startY) < DRAG_THRESHOLD) return
      current.moved = true
      viewport.dataset.panning = ""
    }
    if (!viewport.hasPointerCapture(event.pointerId)) viewport.setPointerCapture(event.pointerId)
    if (pointers.current.size >= 2) {
      // 两指捏合：两点的中点跟着手走，距离变了多少就缩放多少
      const [a, b] = [...pointers.current.values()]
      pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
      const [c, d] = [...pointers.current.values()]
      const rect = viewport.getBoundingClientRect()
      const distBefore = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const mid = { x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 }
      view.current.x += mid.x - (a.x + b.x) / 2
      view.current.y += mid.y - (a.y + b.y) / 2
      zoomTo(view.current.scale * (Math.hypot(c.x - d.x, c.y - d.y) / distBefore), mid.x - rect.left, mid.y - rect.top)
      return
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    panBy(event.clientX - before.x, event.clientY - before.y)
  }

  const onPointerEnd = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId) || pointers.current.size > 0) return
    if (drag.current?.moved) {
      // 拖完松手的那一下不算点击（不然会选中松手处的块）
      swallowClick.current = true
      window.setTimeout(() => {
        swallowClick.current = false
      }, 0)
    }
    drag.current = null
    if (viewportRef.current) delete viewportRef.current.dataset.panning
  }

  const onClickCapture = (event: React.MouseEvent) => {
    if (!swallowClick.current) return
    swallowClick.current = false
    event.preventDefault()
    event.stopPropagation()
  }

  // 键盘 Tab 到画面外的块：挪进来
  const onFocus = (event: React.FocusEvent) => {
    const viewport = viewportRef.current
    const canvas = canvasRef.current
    const target = event.target as HTMLElement
    if (!viewport || !canvas || !canvas.contains(target) || !target.matches(":focus-visible")) return
    const room = viewport.getBoundingClientRect()
    const box = target.getBoundingClientRect()
    const shift = (start: number, end: number, roomStart: number, roomEnd: number) =>
      start < roomStart + PAD ? roomStart + PAD - start : end > roomEnd - PAD ? roomEnd - PAD - end : 0
    const dx = shift(box.left, box.right, room.left, room.right)
    const dy = shift(box.top, box.bottom, room.top, room.bottom)
    if (dx || dy) panBy(dx, dy)
  }

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return
    if (event.key === "+" || event.key === "=") zoomTo(view.current.scale * STEP)
    else if (event.key === "-" || event.key === "_") zoomTo(view.current.scale / STEP)
    else if (event.key === "0") fit()
    else return
    event.preventDefault()
  }

  return (
    <div className={cn("relative", className)} onKeyDown={onKeyDown}>
      <div
        ref={viewportRef}
        data-zoom-viewport=""
        role="group"
        aria-label={label}
        className="absolute inset-0 touch-none overflow-clip select-none data-panning:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
        onClickCapture={onClickCapture}
        onFocus={onFocus}
      >
        <div ref={canvasRef} data-zoom-canvas="" className="@container absolute top-0 left-0 origin-top-left">
          {children}
        </div>
      </div>
      <div data-zoom-toolbar="" className="absolute top-3 right-3 z-10 flex gap-2">
        <ButtonGroup aria-label="缩放">
          <ZoomToolButton label="缩小" hint="缩小（-，或 Ctrl + 滚轮）" onClick={() => zoomTo(view.current.scale / STEP)} disabled={scale <= MIN_SCALE + 0.001}>
            <ZoomOutIcon />
          </ZoomToolButton>
          <Tooltip>
            <TooltipTrigger render={<Button type="button" variant="outline" size="sm" className="tabular-nums" aria-label="按 100% 显示" onClick={() => zoomTo(1)} />}>
              {Math.round(scale * 100)}%
            </TooltipTrigger>
            <TooltipContent>按 100% 显示</TooltipContent>
          </Tooltip>
          <ZoomToolButton label="放大" hint="放大（+，或 Ctrl + 滚轮）；放大后按住拖动" onClick={() => zoomTo(view.current.scale * STEP)} disabled={scale >= MAX_SCALE - 0.001}>
            <ZoomInIcon />
          </ZoomToolButton>
          <ZoomToolButton label="适应" hint="适应：整张图放进来（0）" onClick={fit}>
            <ScanIcon />
          </ZoomToolButton>
        </ButtonGroup>
        {actions}
      </div>
    </div>
  )
}
