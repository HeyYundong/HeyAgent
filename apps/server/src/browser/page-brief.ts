// 浏览器动作做完附上的页面概况（docs/dev/browser-speed.md B、C）：标题和网址、看得见的弹窗 / 遮罩和它们的按钮、
// MCP 输出里的 ### Modal state（文件选择框、网页弹框）翻成中文提示；被弹窗挡住时认出无害的关闭按钮、点掉它。
// 用编排器自己的 Playwright 连接读（不经 MCP），限时 1 秒，读不到就不加，不影响动作本身。
import type { Page } from "playwright-core"

/** 读概况最多等多久 */
export const BRIEF_TIMEOUT_MS = 1000
/** 最多报几个弹窗、每个弹窗报几个按钮 */
const MAX_OVERLAYS = 2
const MAX_BUTTONS = 5

/** 无害的关闭类按钮：文字正好是这些才自动点（不点「接受」「同意」「确定」「OK」这类有含义的） */
export const HARMLESS_CLOSE_TEXTS = ["我知道了", "知道了", "关闭", "×", "✕", "稍后再说", "以后再说", "暂不", "跳过", "Got it", "Close", "Dismiss", "Not now", "No thanks"]

/** 自动点的按钮打这个记号，编排器的 Playwright 按它找元素，点完去掉 */
export const DISMISS_ATTR = "data-heyagent-dismiss"

export interface Overlay {
  /** aria-label，没有就取里面第一个标题或前 30 个字 */
  name: string
  /** 前几个按钮的文字 */
  buttons: string[]
}

export interface PageBrief {
  title: string
  url: string
  overlays: Overlay[]
  /** 要找关闭按钮时：找到并打了记号的那个 */
  dismiss?: { overlay: string; button: string }
}

/**
 * 在页面里跑的函数（浏览器环境，不是 Node），用字符串免得类型检查要求 DOM 库。mark：找一个无害的关闭按钮、打上记号。
 * 弹窗：看得见的 [role=dialog]、[role=alertdialog]、[aria-modal=true]、dialog[open]，以及盖住视口 25% 以上的 position: fixed 元素
 * （5×5 个点上找：这么大的矩形至少盖住一个点）；有大遮罩时，视口正中最上面的 fixed 元素也算（遮罩和弹框是兄弟元素的写法）。
 * 互相包含的只留最里面的（遮罩里的对话框），没字没按钮的空遮罩在有别的弹窗时不报。
 */
const briefScript = (mark: boolean) => `((mark) => {
  const vw = innerWidth, vh = innerHeight
  const styles = new Map()
  const style = (el) => { let s = styles.get(el); if (!s) { s = getComputedStyle(el); styles.set(el, s) } return s }
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2 || r.right <= 0 || r.bottom <= 0 || r.left >= vw || r.top >= vh) return false
    const s = style(el)
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05
  }
  const clean = (value) => (value || "").replace(/\\s+/g, " ").trim()
  const found = new Set()
  for (const el of document.querySelectorAll('[role=dialog],[role=alertdialog],[aria-modal=true],dialog[open]')) if (visible(el)) found.add(el)
  const fixedOf = (el) => {
    for (let node = el; node && node !== document.body && node !== document.documentElement; node = node.parentElement)
      if (style(node).position === "fixed") return node
    return undefined
  }
  // 大的 fixed 元素要真的盖着别的内容（它下面还有不在它里面的元素）才算遮罩：整个应用包在一个全屏 fixed 容器里的网页（在线文档常这样）不算
  const big = new Map()
  const covering = new Set()
  for (const fx of [0.1, 0.3, 0.5, 0.7, 0.9])
    for (const fy of [0.1, 0.3, 0.5, 0.7, 0.9]) {
      const stack = document.elementsFromPoint(vw * fx, vh * fy)
      for (const [index, el] of stack.entries()) {
        const fixed = fixedOf(el)
        if (!fixed) continue
        if (!big.has(fixed)) {
          const r = fixed.getBoundingClientRect()
          const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0))
          big.set(fixed, area >= 0.25 * vw * vh && visible(fixed))
        }
        if (big.get(fixed) && stack.slice(index + 1).some((other) => !fixed.contains(other) && !other.contains(fixed))) covering.add(fixed)
      }
    }
  for (const fixed of covering) found.add(fixed)
  const mask = covering.size > 0
  if (mask) {
    const top = document.elementFromPoint(vw / 2, vh / 2)
    const fixed = top && fixedOf(top)
    if (fixed && visible(fixed)) found.add(fixed)
  }
  const label = (el) => clean(el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("title"))
  const BUTTON = 'button,[role=button],a,input[type=button],input[type=submit],[onclick]'
  const CLOSE_TEXTS = ${JSON.stringify(HARMLESS_CLOSE_TEXTS.map((text) => text.toLowerCase()))}
  const buttonsOf = (el) => {
    const out = []
    const seen = new Set()
    const add = (node, text) => {
      if (!text || text.length > 20 || seen.has(text) || !visible(node)) return
      seen.add(text)
      out.push({ node, text })
    }
    for (const node of el.querySelectorAll(BUTTON)) add(node, label(node))
    // 不是按钮元素、文字正好是关闭类的（「×」常是带点击监听的 span）：只认最里面那层，不在按钮里面也不包着按钮
    for (const node of el.querySelectorAll("span,i,div")) {
      const raw = clean(node.textContent)
      if (!raw || raw.length > 20 || !CLOSE_TEXTS.includes(raw.toLowerCase())) continue
      const inside = node.closest(BUTTON)
      if ((inside && inside !== el && el.contains(inside)) || node.querySelector(BUTTON) || [...node.children].some((child) => clean(child.textContent) === raw)) continue
      add(node, raw)
    }
    return out
  }
  const nameOf = (el) => {
    const aria = clean(el.getAttribute("aria-label"))
    if (aria) return aria
    const by = el.getAttribute("aria-labelledby")
    const labelled = by && document.getElementById(by.split(" ")[0])
    if (labelled && clean(labelled.innerText)) return clean(labelled.innerText).slice(0, 30)
    const heading = el.querySelector('h1,h2,h3,h4,h5,h6,[role=heading]')
    if (heading && clean(heading.innerText)) return clean(heading.innerText).slice(0, 30)
    return clean(el.innerText).slice(0, 30)
  }
  let list = [...found].filter((el) => ![...found].some((other) => other !== el && el.contains(other)))
  let items = list.map((el) => ({ el, name: nameOf(el), buttons: buttonsOf(el) }))
  if (items.some((item) => item.name || item.buttons.length)) items = items.filter((item) => item.name || item.buttons.length)
  let dismiss
  if (mark) {
    document.querySelectorAll("[${DISMISS_ATTR}]").forEach((node) => node.removeAttribute("${DISMISS_ATTR}"))
    for (const item of items) {
      const hit = item.buttons.find((button) => CLOSE_TEXTS.includes(button.text.toLowerCase()))
      if (hit) { hit.node.setAttribute("${DISMISS_ATTR}", "1"); dismiss = { overlay: item.name, button: hit.text }; break }
    }
  }
  return {
    title: document.title,
    overlays: items.slice(0, ${MAX_OVERLAYS}).map((item) => ({ name: item.name || "（没有标题）", buttons: item.buttons.slice(0, ${MAX_BUTTONS}).map((button) => button.text) })),
    dismiss,
  }
})(${mark})`

const withTimeout = <T>(promise: Promise<T>, ms: number, fallback: T) =>
  Promise.race([promise, new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms))])

/** 读页面概况；页面上开着网页弹框（renderer 阻塞，读不了）时只给网址。读不到返回 undefined */
export async function readPageBrief(page: Page, options: { dialogOpen?: boolean; findClose?: boolean } = {}): Promise<PageBrief | undefined> {
  const url = page.url()
  if (options.dialogOpen) return { title: "", url, overlays: [] }
  const value = await withTimeout(
    page.evaluate(briefScript(Boolean(options.findClose))).then((value) => value as Omit<PageBrief, "url">).catch(() => undefined),
    BRIEF_TIMEOUT_MS,
    undefined
  )
  return value ? { ...value, url: page.url() } : undefined
}

export const overlayText = (overlay: Overlay) => `「${overlay.name}」${overlay.buttons.length ? `（按钮：${overlay.buttons.join("、")}）` : ""}`

/**
 * MCP 输出里的 ### Modal state 翻成中文提示（0.0.83：「- [File chooser]: can be handled by browser_file_upload」、
 * 「- ["alert" dialog with message "…"]: can be handled by browser_handle_dialog」）
 */
export function modalGuidance(mcpOutput: string): string[] {
  const section = /### Modal state\n([\s\S]*?)(?=\n### |$)/.exec(mcpOutput)?.[1] ?? ""
  const lines: string[] = []
  for (const line of section.split("\n")) {
    if (/\[File chooser\]/.test(line))
      lines.push("页面打开了文件选择框：要上传就调 browser_file_upload（fileIds 填文件 id）；不上传就不带 fileIds 调一次 browser_file_upload 取消。选择框开着时别的浏览器动作都会报错。")
    const dialog = /\["(\w+)" dialog with message "([\s\S]*)"\]/.exec(line)
    if (dialog)
      lines.push(`页面弹出了网页弹框（${dialog[1]}）：「${dialog[2]!.slice(0, 200)}」。用 browser_handle_dialog 处理（accept: true 是确定，false 是取消）；处理之前别的浏览器动作都会报错。`)
  }
  return lines
}

/** MCP 输出里和页面概况重复的段（### Page、### Modal state）、「没有返回内容」的占位去掉；概况读不到时保留原文 */
export function stripPageSections(mcpOutput: string): string {
  return mcpOutput
    // 段里每行都是「- 」开头：只去掉这些行，后面网关自己加的文字留着
    .replace(/(^|\n)### (Page|Modal state)(?:\n- [^\n]*)*/g, "")
    .replace(/^（没有返回内容）$/m, "")
    .trim()
}

/** Playwright 出错时的调用日志带终端颜色码：去掉（模型看着是乱码，还占字数） */
// eslint-disable-next-line no-control-regex
export const stripAnsi = (text: string) => text.replace(/\u001b\[[0-9;]*m/g, "")

/** 页面概况的几行（附在动作输出末尾） */
export function formatBrief(brief: PageBrief | undefined, mcpOutput = ""): string[] {
  const lines: string[] = []
  if (brief) lines.push(`现在的页面：${brief.title ? `「${brief.title}」 ` : ""}${brief.url}`)
  for (const overlay of brief?.overlays ?? [])
    lines.push(`页面上有弹窗「${overlay.name}」${overlay.buttons.length ? `，按钮：${overlay.buttons.join("、")}` : "（没认出按钮）"}`)
  lines.push(...modalGuidance(mcpOutput))
  return lines
}

/** 出错文字补一句怎么办：旧 ref 失效、选择器没找到、有没处理的选择框 / 弹框 */
export function explainError(output: string): string | undefined {
  if (/Ref \S+ not found in the current page snapshot/.test(output)) return "页面变了，旧的 ref 失效：用选择器（例如 role=button[name=\"继续录入\"]、text=继续录入）或重新快照。"
  if (/does not match any elements/.test(output)) return "选择器没找到元素：换个写法（role=…[name=\"…\"]、text=…），或者先快照看看页面。"
  if (/does not handle the modal state/.test(output)) return "页面上有文件选择框或网页弹框没处理，先处理它（见下面的提示）。"
  return undefined
}

/** 动作失败是不是被别的元素挡住了：Playwright 的 intercepts pointer events；超时的要再看页面上有没有弹窗 */
export function blockedKind(output: string): "intercepted" | "timeout" | undefined {
  if (/intercepts pointer events/.test(output)) return "intercepted"
  if (/Timeout \d+ms exceeded/.test(output)) return "timeout"
  return undefined
}
