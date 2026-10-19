// 自动过简单的验证码（2026-10-19 用户定的：很多内部系统要 agent 帮忙过简单的验证码；所有网站都一样，设置里一个开关）。
// 做法：在页面（含各个 frame）里给可能有关的元素（小图、输入框、按钮、勾选框）编号，截一张页面图、验证码小图放大图，
// 连同编号列表交给设置里选的视觉模型，让它只回 JSON：
// - 图片字符（字母数字、简单算式）：哪张图、填到哪个框、答案、点哪个按钮提交；
// - 点一下就行的（「我不是机器人」勾选框、「点击验证」按钮）：点哪个；
// - 别的（滑块拼图、按顺序点字、选图、短信 / 邮箱验证码、扫码……）或看不清：不试，交给人。
// 两种用法：submit = true（检测到验证码页时）填好就提交，再看还是不是验证码页，最多试几次；
// submit = false（表单里的验证码，agent 或登录小 agent 调工具时）只填不提交，提交由它们自己点。
// 规则是通用的（常见的属性名、尺寸），不针对任何具体网站。
import type { Frame, Page } from "playwright-core"

import type { Db } from "../db/client.js"
import { callModel, resolveModel } from "../engine/model.js"
import type { BrowserInstance } from "./instance.js"

/** 每个页面最多试几次 */
export const CAPTCHA_MAX_TRIES = 3
const ATTR = "data-ha-cap"
/** 最多给模型看几张验证码放大图 */
const MAX_CROPS = 3
const ACTION_TIMEOUT = 5000

/** 页面里给元素编号（浏览器环境跑的函数，用字符串免得类型检查要求 DOM 库）；参数是编号从几开始 */
const TAG_SCRIPT = `(start) => {
  const ATTR = ${JSON.stringify(ATTR)}
  for (const el of document.querySelectorAll("[" + ATTR + "]")) el.removeAttribute(ATTR)
  const HINT = /captcha|verif|check.?code|v.?code|yzm|validate|valid.?code|auth.?code|security.?code|rand.?code|img.?code|kaptcha|robot|human|验证|校验|人机|机器人/i
  const visible = (el) => {
    const r = el.getBoundingClientRect()
    const s = getComputedStyle(el)
    return r.width > 4 && r.height > 4 && s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05
  }
  const attrs = (el) => [...new Set(["aria-label", "alt", "title", "placeholder", "name", "id", "class", "src"]
    .map((name) => (el.getAttribute(name) || "").slice(0, 80)).filter(Boolean))].join(" ")
  const clean = (text) => (text || "").replace(/\\s+/g, " ").trim().slice(0, 80)
  const found = []
  const push = (el, role, text) => found.push({ el, role, text: clean(text), hint: HINT.test(attrs(el) + " " + text) })
  for (const el of document.querySelectorAll("img, canvas, svg")) {
    if (!visible(el)) continue
    const r = el.getBoundingClientRect()
    const hint = HINT.test(attrs(el))
    // 验证码图一般是横着的小图
    const shaped = r.width >= 40 && r.width <= 360 && r.height >= 16 && r.height <= 140 && r.width >= r.height
    if (!hint && (el.tagName === "svg" || !shaped)) continue
    push(el, "image", attrs(el))
  }
  for (const el of document.querySelectorAll("input:not([type]), input[type=text], input[type=tel], input[type=number], input[type=search], input[type=email]")) {
    if (!visible(el) || el.disabled || el.readOnly) continue
    const label = el.labels && el.labels[0] ? el.labels[0].innerText : ""
    push(el, "input", label + " " + attrs(el) + (el.value ? " 已填：" + el.value.slice(0, 20) : ""))
  }
  for (const el of document.querySelectorAll("button, input[type=submit], input[type=button], input[type=image], input[type=checkbox], [role=button], [role=checkbox], a[href]")) {
    if (!visible(el)) continue
    const checkbox = el.type === "checkbox" || el.getAttribute("role") === "checkbox"
    const text = (el.innerText || el.value || "") + " " + attrs(el)
    // 链接太多：只要像验证、提交的
    if (el.tagName === "A" && !HINT.test(text) && !/提交|确定|确认|登录|submit|verify|continue|继续/i.test(text)) continue
    push(el, checkbox ? "checkbox" : "button", text)
  }
  const pick = (role, max) => found.filter((each) => each.role === role).sort((a, b) => Number(b.hint) - Number(a.hint)).slice(0, max)
  const kept = [...pick("image", 6), ...pick("input", 10), ...pick("checkbox", 6), ...pick("button", 14)]
  let n = start
  return kept.map((each) => {
    const r = each.el.getBoundingClientRect()
    each.el.setAttribute(ATTR, String(++n))
    return {
      id: n, role: each.role, tag: each.el.tagName.toLowerCase(), text: each.text, hint: each.hint,
      filled: each.role === "input" ? Boolean(each.el.value) : undefined,
      x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height),
    }
  })
}`

export interface CaptchaElement {
  id: number
  role: "image" | "input" | "checkbox" | "button"
  tag: string
  text: string
  hint: boolean
  filled?: boolean
  x: number
  y: number
  w: number
  h: number
}

interface Tagged extends CaptchaElement {
  frame: Frame
}

/** 模型的回答 */
export type CaptchaPlan =
  | { type: "text"; image?: number; input: number; answer: string; submit?: number }
  | { type: "click"; target: number }
  | { type: "other"; reason: string }

/** 一次尝试（记成 session 的一条过程） */
export interface CaptchaTry {
  /** 填了 / 点了（submit 模式下还要提交后不再是验证码页） */
  ok: boolean
  /** 只填不提交（agent 调工具时）：ok 只表示填好了 */
  fillOnly: boolean
  plan?: CaptchaPlan
  /** 给人看的一句话（含答案） */
  detail: string
  tokensIn: number
  tokensOut: number
  costUsd: number
  ms: number
}

export interface CaptchaResult {
  ok: boolean
  /** 验证码在表单里，表单还有别的没填的输入框：不提交，让 agent 先填别的再调工具填验证码 */
  form?: boolean
  /** 不是简单验证码（模型说的原因）：不用再试 */
  unsupported?: string
  /** 没试（例如第三方人机验证）：原因，给人和 agent 看 */
  skipped?: string
  tries: CaptchaTry[]
  detail: string
  tokensIn: number
  tokensOut: number
  costUsd: number
}

export interface SolveCaptchaInput {
  db: Db
  instance: BrowserInstance
  page: Page
  /** 设置里选的视觉模型 */
  modelId: string
  /** true：填好就提交，再看还是不是验证码；false：只填不提交 */
  submit: boolean
  /** 最多试几次（submit 模式才会试多次） */
  maxTries?: number
  /** submit 模式：提交后还是验证码吗（不给就当过了） */
  stillCaptcha?: () => Promise<boolean>
  /** 每试一次调一次（记过程） */
  onTry?: (each: CaptchaTry, index: number) => Promise<void>
}

const ROLE_NAMES: Record<CaptchaElement["role"], string> = { image: "图片", input: "输入框", checkbox: "勾选框", button: "按钮" }

export function captchaPrompt(elements: CaptchaElement[], submit: boolean): string {
  const lines = elements.map(
    (each) => `#${each.id} ${ROLE_NAMES[each.role]} <${each.tag}>${each.text ? ` 「${each.text}」` : ""}${each.filled === false ? "（空）" : ""} 位置 ${each.x},${each.y} 大小 ${each.w}x${each.h}`
  )
  return [
    "第一张图是网页的截图，页面上有验证码；后面的图（如果有）是页面上几张小图的放大图，前面写了编号。下面是页面上的元素（编号、种类、文字、位置）。",
    "判断验证码是哪一种，只输出 JSON，不要别的文字：",
    `- 图片里是字母、数字（或简单算式），照着填进输入框：{"type": "text", "image": 图片编号, "input": 验证码输入框编号, "answer": "图片里的字符（算式填结果）"${submit ? ', "submit": 提交按钮编号（没有就 null，会在输入框里按回车）' : ""}}`,
    '- 只要点一下就行（「我不是机器人」勾选框、「点击验证」「点击按钮开始验证」这类按钮）：{"type": "click", "target": 元素编号}',
    '- 别的（滑块、拼图、按顺序点字、选图、短信或邮箱验证码、扫码等）或者看不清：{"type": "other", "reason": "一句话"}',
    "字母照图里的大小写填，不要加空格；看不清就选 other，不要乱猜。",
    "",
    "元素：",
    ...(lines.length ? lines : ["（没找到）"]),
  ].join("\n")
}

/** 模型回答 → CaptchaPlan；格式不对返回 undefined */
export function parseCaptchaPlan(text: string): CaptchaPlan | undefined {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return undefined
  let value: Record<string, unknown>
  try {
    value = JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return undefined
  }
  const id = (raw: unknown) => {
    const n = typeof raw === "string" ? Number(raw.replace(/^#/, "")) : raw
    return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined
  }
  if (value.type === "text") {
    const input = id(value.input)
    const answer = typeof value.answer === "string" ? value.answer.trim() : typeof value.answer === "number" ? String(value.answer) : ""
    if (!input || !answer || answer.length > 16) return undefined
    return { type: "text", input, answer, image: id(value.image), submit: id(value.submit) }
  }
  if (value.type === "click") {
    const target = id(value.target)
    return target ? { type: "click", target } : undefined
  }
  if (value.type === "other") return { type: "other", reason: typeof value.reason === "string" ? value.reason : "" }
  return undefined
}

/** 给页面（主 frame 和各个子 frame）里的元素编号 */
async function tagElements(page: Page): Promise<Tagged[]> {
  const out: Tagged[] = []
  for (const frame of page.frames()) {
    const start = out.length ? out.at(-1)!.id : 0
    const found = await Promise.race([
      frame.evaluate(`(${TAG_SCRIPT})(${start})`).catch(() => []) as Promise<CaptchaElement[]>,
      new Promise<CaptchaElement[]>((resolve) => setTimeout(() => resolve([]), 4000)),
    ])
    for (const each of found) out.push({ ...each, frame })
  }
  return out
}

const locate = (each: Tagged) => each.frame.locator(`[${ATTR}="${each.id}"]`).first()

/** 页面上有弹框（例如「验证码错误」的 alert）：点掉，返回弹框的话 */
async function closeDialog(instance: BrowserInstance, page: Page): Promise<string | undefined> {
  const dialog = instance.dialogs.get(page)
  if (!dialog) return undefined
  const message = dialog.message()
  await dialog.accept().catch(() => {})
  instance.dialogs.delete(page)
  return message
}

/** 做完动作等页面安定下来（跳转了就等加载完，没跳转就等一会儿让脚本跑完） */
async function settle(page: Page, act: () => Promise<void>) {
  const navigated = page.waitForEvent("framenavigated", { predicate: (frame) => frame === page.mainFrame(), timeout: 4000 }).catch(() => undefined)
  await act()
  await navigated
  await page.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => {})
  await page.waitForTimeout(600).catch(() => {})
}

export async function solveCaptcha(input: SolveCaptchaInput): Promise<CaptchaResult> {
  const { db, instance, page, submit } = input
  const maxTries = submit ? (input.maxTries ?? CAPTCHA_MAX_TRIES) : 1
  const result: CaptchaResult = { ok: false, tries: [], detail: "", tokensIn: 0, tokensOut: 0, costUsd: 0 }
  const resolved = await resolveModel(db, input.modelId)
  for (let index = 0; index < maxTries; index++) {
    instance.touch()
    await closeDialog(instance, page)
    const elements = await tagElements(page)
    // 要提交时：页面上不止一个空着的输入框，验证码就是表单里的一项（还有账号、单号之类没填），不问模型、不提交，让 agent 先填别的
    if (submit && index === 0 && elements.filter((each) => each.role === "input" && !each.filled).length >= 2) {
      result.form = true
      result.detail = "验证码在表单里，表单还有别的没填的框"
      break
    }
    const shot = await instance.screenshot(page)
    if (!shot) {
      result.detail = "截不了页面的图（页面上可能有弹框），没法认验证码"
      break
    }
    // 像验证码的小图放大给模型看（截图里太小，字符看不清）
    const crops: { id: number; data: Buffer }[] = []
    for (const each of elements.filter((item) => item.role === "image").sort((a, b) => Number(b.hint) - Number(a.hint))) {
      if (crops.length >= MAX_CROPS) break
      const data = await locate(each).screenshot({ type: "png", timeout: ACTION_TIMEOUT }).catch(() => undefined)
      if (data) crops.push({ id: each.id, data })
    }
    const reply = await callModel(resolved, {
      system: "你帮人过网页上的简单验证码，只输出 JSON。",
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: captchaPrompt(elements, submit) },
            { type: "file", data: shot.toString("base64"), mediaType: "image/jpeg" },
            ...crops.flatMap((crop) => [
              { type: "text" as const, text: `#${crop.id} 的放大图：` },
              { type: "file" as const, data: crop.data.toString("base64"), mediaType: "image/png" },
            ]),
          ],
        },
      ],
      tools: {},
    })
    result.tokensIn += reply.tokensIn
    result.tokensOut += reply.tokensOut
    result.costUsd += reply.costUsd
    const attempt: CaptchaTry = { ok: false, fillOnly: !submit, detail: "", tokensIn: reply.tokensIn, tokensOut: reply.tokensOut, costUsd: reply.costUsd, ms: reply.ms }
    const plan = parseCaptchaPlan(reply.text)
    attempt.plan = plan
    const byId = (id: number | undefined) => (id === undefined ? undefined : elements.find((each) => each.id === id))
    const record = async (detail: string, ok = false) => {
      attempt.detail = detail
      attempt.ok = ok
      result.tries.push(attempt)
      result.detail = detail
      await input.onTry?.(attempt, index)
    }

    if (!plan) {
      await record(`模型的回答看不懂：${reply.text.slice(0, 200) || "（没回话）"}`)
      continue
    }
    if (plan.type === "other") {
      result.unsupported = plan.reason || "不是简单的验证码"
      await record(`不是能自动过的验证码：${result.unsupported}`)
      break
    }
    let done: string
    if (plan.type === "text") {
      const box = byId(plan.input)
      if (!box || box.role !== "input") {
        await record(`模型说的输入框 #${plan.input} 不对`)
        continue
      }
      // 检测到验证码页时要提交：表单里还有别的没填的框（账号、搜索词……）就不提交，让 agent 先填好
      const others = elements.filter((each) => each.role === "input" && each.id !== box.id && each.frame === box.frame && !each.filled)
      if (submit && others.length) {
        result.form = true
        await record(`验证码在表单里（答案 ${plan.answer}），表单还有 ${others.length} 个没填的框，先不提交`)
        break
      }
      const filled = await locate(box).fill(plan.answer, { timeout: ACTION_TIMEOUT }).then(() => true, () => false)
      if (!filled) {
        await record(`验证码 ${plan.answer} 没填进输入框 #${box.id}`)
        continue
      }
      done = `认出验证码 ${plan.answer}，填进了输入框 #${box.id}${box.text ? `（${box.text.slice(0, 30)}）` : ""}`
      if (!submit) {
        await record(done, true)
        break
      }
      const button = byId(plan.submit)
      await settle(page, async () => {
        if (button && button.role !== "image") await locate(button).click({ timeout: ACTION_TIMEOUT }).catch(() => {})
        else await locate(box).press("Enter", { timeout: ACTION_TIMEOUT }).catch(() => {})
      })
      done += button ? `，点了 #${button.id}${button.text ? `（${button.text.slice(0, 20)}）` : ""}` : "，按了回车"
    } else {
      const target = byId(plan.target)
      if (!target || target.role === "input") {
        await record(`模型说的元素 #${plan.target} 不对`)
        continue
      }
      const clicked = await settle(page, () => locate(target).click({ timeout: ACTION_TIMEOUT })).then(() => true, () => false)
      if (!clicked) {
        await record(`点 #${target.id} 没点上`)
        continue
      }
      done = `点了 #${target.id}${target.text ? `（${target.text.slice(0, 30)}）` : ""}`
      // 只填不提交：点完就算做了
      if (!submit) {
        await record(done, true)
        break
      }
      await page.waitForTimeout(1500).catch(() => {})
    }
    const alert = await closeDialog(instance, page)
    const still = input.stillCaptcha ? await input.stillCaptcha().catch(() => true) : false
    if (!still) {
      await record(`${done}，过了`, true)
      break
    }
    await record(`${done}，还是验证码页${alert ? `（弹框：${alert.slice(0, 60)}）` : ""}`)
  }
  result.ok = result.tries.at(-1)?.ok ?? false
  return result
}
