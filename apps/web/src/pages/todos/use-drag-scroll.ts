// 看板按住鼠标左右拖动平移（只管鼠标，触屏保持原生滑动）；左右方向键也能平移。放得下（不溢出）时不拖。
// 移动超过 5px 才算拖动，拖完吞掉这次点击，免得误开卡片；按在卡片里的按钮、菜单、输入框上不进入拖动。
import * as React from "react"

export function useDragScroll<T extends HTMLElement>() {
  const ref = React.useRef<T>(null)
  const drag = React.useRef<{ id: number; x: number; left: number; moved: boolean } | null>(null)
  const swallowClick = React.useRef(false)
  const [overflow, setOverflow] = React.useState(false)

  React.useEffect(() => {
    const el = ref.current!
    const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1)
    const observer = new ResizeObserver(check)
    ;[el, el.firstElementChild].forEach((each) => each && observer.observe(each))
    check()
    return () => observer.disconnect()
  }, [])

  function end() {
    if (drag.current?.moved) {
      swallowClick.current = true
      setTimeout(() => (swallowClick.current = false)) // click 没来的话，下一轮复位
    }
    drag.current = null
  }

  const handlers = {
    onPointerDown(event: React.PointerEvent<T>) {
      if (event.pointerType !== "mouse" || event.button !== 0 || !overflow) return
      const hit = (event.target as HTMLElement).closest("a, button, input, textarea, select, [role=menuitem]")
      if (hit && !hit.hasAttribute("data-board-card")) return // 卡片本身可以拖，卡片里的控件不行
      drag.current = { id: event.pointerId, x: event.clientX, left: event.currentTarget.scrollLeft, moved: false }
    },
    onPointerMove(event: React.PointerEvent<T>) {
      const state = drag.current
      if (!state || state.id !== event.pointerId || (!state.moved && Math.abs(event.clientX - state.x) < 5)) return
      if (!state.moved) {
        state.moved = true
        event.currentTarget.setPointerCapture(event.pointerId) // 指针移出看板、移出窗口也继续跟着
      }
      event.currentTarget.scrollLeft = state.left - (event.clientX - state.x)
    },
    onPointerUp: end,
    onPointerCancel: end,
    onLostPointerCapture: end,
    onClickCapture(event: React.MouseEvent<T>) {
      if (!swallowClick.current) return
      event.preventDefault() // 刚拖完：这次点击不算，不打开卡片
      event.stopPropagation()
    },
    onDragStart: (event: React.DragEvent<T>) => event.preventDefault(), // 链接的原生拖拽会打断平移
    onKeyDown(event: React.KeyboardEvent<T>) {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      event.preventDefault()
      event.currentTarget.scrollBy({ left: event.key === "ArrowLeft" ? -272 : 272, behavior: "smooth" }) // 一次大约一列
    },
  }
  return { ref, overflow, handlers }
}
