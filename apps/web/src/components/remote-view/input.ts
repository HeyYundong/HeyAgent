// 远程画面的输入换算（纯函数）：本机的鼠标、键盘事件 → 发给服务端的消息（格式见 shared 的 ViewerClientMessage）。
// 坐标按 meta.width/height 换算：Chrome 是页面视口的 CSS 像素，桌面是屏幕的物理像素，都不是画面图片的尺寸（图片缩过）。
import type { ViewerClientMessage } from "@heyagent/shared"

type Modifiers = { altKey: boolean; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }

/** CDP 的修饰键位：Alt=1 Ctrl=2 Meta=4 Shift=8 */
export function modifiersOf(event: Modifiers) {
  return (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0)
}

const BUTTONS = ["left", "middle", "right", "back", "forward"] as const
type MouseButton = "none" | (typeof BUTTONS)[number]

/** PointerEvent.button（0 左 1 中 2 右）→ CDP 的按键名 */
export function buttonOf(button: number): MouseButton {
  return BUTTONS[button] ?? "left"
}

/** 拖动时按着哪个键（PointerEvent.buttons 的位：1 左 2 右 4 中） */
export function pressedButton(buttons: number): MouseButton {
  if (buttons & 1) return "left"
  if (buttons & 2) return "right"
  if (buttons & 4) return "middle"
  return "none"
}

export interface Box {
  left: number
  top: number
  width: number
  height: number
}

/** 画布上的点 → 页面视口的 CSS 像素。size 是 meta 的 width/height（还没收到 meta 时用画布本身的尺寸） */
export function toPage(clientX: number, clientY: number, box: Box, size: { width: number; height: number }) {
  if (box.width <= 0 || box.height <= 0) return { x: 0, y: 0 }
  const x = ((clientX - box.left) / box.width) * size.width
  const y = ((clientY - box.top) / box.height) * size.height
  const clamp = (value: number, max: number) => Math.round(Math.min(Math.max(value, 0), Math.max(max - 1, 0)) * 100) / 100
  return { x: clamp(x, size.width), y: clamp(y, size.height) }
}

/** 滚轮的 deltaMode：按行、按页的换成像素 */
export function wheelDelta(event: { deltaX: number; deltaY: number; deltaMode: number }) {
  const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 800 : 1
  return { deltaX: event.deltaX * unit, deltaY: event.deltaY * unit }
}

type KeyLike = Modifiers & { key: string; code: string; keyCode: number }

/**
 * 按下一个键 → key 消息。能打出字的键带 text（Chrome 会据此插入字符），回车带 "\r"；
 * 其余（方向键、退格、Ctrl+A 这类组合键）用 rawKeyDown，只触发按键事件。
 */
export function keyDownMessage(event: KeyLike): Extract<ViewerClientMessage, { t: "key" }> {
  const command = event.ctrlKey || event.metaKey || event.altKey
  const printable = event.key.length === 1 && !command
  const text = printable ? event.key : event.key === "Enter" ? "\r" : undefined
  return {
    t: "key",
    type: text ? "keyDown" : "rawKeyDown",
    key: event.key.slice(0, 40),
    code: event.code.slice(0, 40),
    keyCode: Math.min(Math.max(event.keyCode, 0), 1000),
    ...(text ? { text } : {}),
    modifiers: modifiersOf(event),
  }
}

export function keyUpMessage(event: KeyLike): Extract<ViewerClientMessage, { t: "key" }> {
  return { t: "key", type: "keyUp", key: event.key.slice(0, 40), code: event.code.slice(0, 40), keyCode: Math.min(Math.max(event.keyCode, 0), 1000), modifiers: modifiersOf(event) }
}

/** 粘贴的长文字按 1 万字一段发（服务端每条最多 1 万字） */
export function textChunks(text: string, size = 10_000) {
  const chunks: string[] = []
  for (let index = 0; index < text.length; index += size) chunks.push(text.slice(index, index + size))
  return chunks
}

/** 地址栏里没写协议的，补上 https:// */
export function normalizeAddress(value: string) {
  const text = value.trim()
  if (!text) return ""
  // localhost:8080 这种不算协议，只认「xxx://」和 about: / data:
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(about|data):/i.test(text) ? text : `https://${text}`
}
