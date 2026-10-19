// 内网用 http 访问（不是 https，也不是 localhost）时，浏览器不给 navigator.clipboard。
// 组件库的复制按钮（CodeBlockCopyButton）和页面里的复制都直接调 navigator.clipboard.writeText，这时点了没反应。
// 启动时补一个只有 writeText 的替身：看不见的 textarea + document.execCommand("copy")。浏览器自带的照常用，不动它。

/** 弹窗会把焦点拦在里面，textarea 要放进弹窗才选得中 */
function containerOf(active: HTMLElement | null) {
  const dialog = active?.closest<HTMLElement>("[role=dialog],[role=alertdialog]")
  if (dialog) return dialog
  const open = document.querySelectorAll<HTMLElement>("[role=dialog],[role=alertdialog]")
  return open[open.length - 1] ?? document.body
}

function copyWithTextarea(text: string) {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null
  const textarea = document.createElement("textarea")
  textarea.value = text
  textarea.readOnly = true
  textarea.className = "fixed top-0 left-0 size-px opacity-0"
  containerOf(active).append(textarea)
  textarea.select()
  textarea.setSelectionRange(0, text.length)
  try {
    return document.execCommand("copy")
  } finally {
    textarea.remove()
    active?.focus({ preventScroll: true })
  }
}

export function installClipboardFallback() {
  if ((navigator as Partial<Navigator>).clipboard) return
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: {
      writeText: (text: string) => (copyWithTextarea(String(text)) ? Promise.resolve() : Promise.reject(new DOMException("复制失败", "NotAllowedError"))),
    },
  })
}
