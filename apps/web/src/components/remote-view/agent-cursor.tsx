// agent 的虚拟光标（自定义组件，登记在 docs/ui-rules.md 第 8 节）：叠在远程画面上，显示 agent 的鼠标在哪、点了哪、在做什么。
// 组件库没有光标类组件：箭头用 lucide 的 MousePointer2Icon，动作说明用 Badge，点击的波纹是 rounded-full + animate-ping。
// - 位置按画面坐标（Chrome 是页面视口的 CSS 像素，桌面是屏幕的物理像素）换算成百分比，在 ref 上改 left/top（和输入框的定位一样，不走 React 渲染，JSX 里不写 style）；
// - 移动有 200 毫秒的过渡：有人看时服务端会在按下前等 200 毫秒，光标先到、再点下去；
// - 能操作的人自己点画面时先把它收起来，agent 再动时再出来。
import * as React from "react"
import { MousePointer2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"

import type { AgentMessage } from "./use-remote-view"

/** 动作说明显示多久 */
const LABEL_MS = 2500
/** 波纹显示多久（animate-ping 一圈 1 秒） */
const RIPPLE_MS = 900

export interface AgentCursorProps {
  onAgent: (listener: (message: AgentMessage) => void) => () => void
  /** 页面视口的 CSS 像素尺寸（meta.width/height）；还没收到时不画 */
  width?: number
  height?: number
  canControl: boolean
}

export function AgentCursor({ onAgent, width, height, canControl }: AgentCursorProps) {
  const anchorRef = React.useRef<HTMLDivElement | null>(null)
  const rippleRef = React.useRef<HTMLSpanElement | null>(null)
  const nearRef = React.useRef<HTMLDivElement | null>(null)
  const nearTextRef = React.useRef<HTMLSpanElement | null>(null)
  const cornerRef = React.useRef<HTMLDivElement | null>(null)
  const cornerTextRef = React.useRef<HTMLSpanElement | null>(null)
  const point = React.useRef<{ x: number; y: number } | null>(null)
  const sizeRef = React.useRef({ width: width ?? 0, height: height ?? 0 })
  const timers = React.useRef<{ label?: ReturnType<typeof setTimeout>; ripple?: ReturnType<typeof setTimeout> }>({})

  /** 把光标放到 point 上；animate = false 时直接跳过去（第一次出现、尺寸变了） */
  const place = React.useCallback((animate: boolean) => {
    const anchor = anchorRef.current
    const at = point.current
    const box = sizeRef.current
    if (!anchor) return
    if (!at || box.width <= 0 || box.height <= 0) {
      anchor.hidden = true
      return
    }
    const wasHidden = anchor.hidden
    if (!animate || wasHidden) anchor.classList.remove("transition-all")
    anchor.hidden = false
    // 只是定位一个叠在画面上的标记，不是样式
    anchor.style.left = `${(at.x / box.width) * 100}%`
    anchor.style.top = `${(at.y / box.height) * 100}%`
    // 靠右、靠下时说明放到光标另一边，免得被画面边缘裁掉
    const near = nearRef.current
    if (near) {
      const right = at.x / box.width > 0.7
      const bottom = at.y / box.height > 0.85
      near.classList.toggle("left-3", !right)
      near.classList.toggle("right-3", right)
      near.classList.toggle("top-6", !bottom)
      near.classList.toggle("bottom-3", bottom)
    }
    if (!animate || wasHidden) {
      void anchor.offsetWidth
      anchor.classList.add("transition-all")
    }
  }, [])

  const hideLabels = React.useCallback(() => {
    if (nearRef.current) nearRef.current.hidden = true
    if (cornerRef.current) cornerRef.current.hidden = true
  }, [])

  const hide = React.useCallback(() => {
    point.current = null
    if (anchorRef.current) anchorRef.current.hidden = true
    hideLabels()
  }, [hideLabels])

  React.useEffect(() => {
    sizeRef.current = { width: width ?? 0, height: height ?? 0 }
    place(false)
  }, [width, height, place])

  React.useEffect(() => {
    const current = timers.current
    const unsubscribe = onAgent((message) => {
      if (message.t === "cursorHidden") {
        hide()
        return
      }
      if (message.t === "agentAction") {
        // 光标在画面上就跟着光标，否则放在左上角
        const nearby = Boolean(point.current) && anchorRef.current?.hidden === false
        hideLabels()
        const box = nearby ? nearRef.current : cornerRef.current
        const text = nearby ? nearTextRef.current : cornerTextRef.current
        if (!box || !text) return
        text.textContent = message.label
        box.hidden = false
        clearTimeout(current.label)
        current.label = setTimeout(hideLabels, LABEL_MS)
        return
      }
      point.current = { x: message.x, y: message.y }
      place(true)
      // 说明比光标先到（第一个动作）：光标出来了就挪到光标旁边
      const corner = cornerRef.current
      if (corner && !corner.hidden && nearRef.current && nearTextRef.current && cornerTextRef.current) {
        nearTextRef.current.textContent = cornerTextRef.current.textContent
        corner.hidden = true
        nearRef.current.hidden = false
      }
      if (message.kind === "press" && rippleRef.current) {
        const ripple = rippleRef.current
        // 重新挂上才会从头播一遍
        ripple.hidden = true
        void ripple.offsetWidth
        ripple.hidden = false
        clearTimeout(current.ripple)
        current.ripple = setTimeout(() => (ripple.hidden = true), RIPPLE_MS)
      }
    })
    return () => {
      unsubscribe()
      clearTimeout(current.label)
      clearTimeout(current.ripple)
    }
  }, [onAgent, place, hide, hideLabels])

  // 人自己点画面：收起 agent 的光标
  React.useEffect(() => {
    const stage = anchorRef.current?.parentElement
    if (!stage || !canControl) return
    stage.addEventListener("pointerdown", hide)
    return () => stage.removeEventListener("pointerdown", hide)
  }, [canControl, hide])

  return (
    <>
      <div ref={anchorRef} hidden aria-hidden className="pointer-events-none absolute top-0 left-0 z-10 select-none transition-all duration-200 ease-out">
        <span ref={rippleRef} hidden className="absolute -top-3 -left-3 size-6 animate-ping rounded-full bg-primary/50" />
        <MousePointer2Icon className="absolute -top-1 -left-1 size-6 fill-primary stroke-primary-foreground" />
        <div ref={nearRef} hidden className="absolute top-6 left-3">
          <Badge>
            <span ref={nearTextRef} />
          </Badge>
        </div>
      </div>
      <div ref={cornerRef} hidden aria-hidden className="pointer-events-none absolute top-2 left-2 z-10 select-none">
        <Badge>
          <span ref={cornerTextRef} />
        </Badge>
      </div>
    </>
  )
}
