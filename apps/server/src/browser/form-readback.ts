// browser.fill_form 做完以后，把每个字段实际的值从页面上读回来，写进给 agent 的结果（docs/dev/routine-library.md 18.6 第 3 条）：
// agent 看不到填进去的是什么，会不放心、再填再提交一遍；会改数据的表单提交两次可能办两次。
// - 字段的定位用这次录下的 Playwright 代码（MCP 的 ### Ran Playwright code，一个字段一行：fill / check / uncheck / selectOption），
//   和字段一一对应；对不上时，字段的 target 是选择器（不是快照 ref）的照它找；都不行写「读不出来」；
// - 输入框读 value，下拉框读选中的文字，勾选框、单选读勾没勾；
// - 密码框（type=password、autocomplete 是密码、验证码）和名字像密钥的（密码、token、secret、密钥……）、用了 {{password}} 占位符的打码。
import type { Locator, Page } from "playwright-core"

import { buildLocator } from "./extract.js"

export interface FilledField {
  name: string
  type: string
  value: string
  target?: string
}

/** 读一个字段最多等多久（字段已经填过了，只是取值） */
const READ_MS = 2000
/** 每个值最多给 agent 看多少字 */
const VALUE_CHARS = 300
/** 名字像密钥的字段 */
const SECRET_NAME = /密码|口令|密钥|秘钥|私钥|令牌|验证码|passw|pwd|passcode|secret|token|api[\s_-]?key|credential|otp/i
/** 快照 ref（e12）、aria-ref=…：只有 MCP 自己认得，这里找不到 */
const SNAPSHOT_REF = /^(?:aria-ref=)?[a-z]?\d+$/i
/** 录下的一个字段动作：await page.<定位>.fill(…) / check() / uncheck() / setChecked(…) / selectOption(…) */
const ACTION_LINE = /^(?:await\s+)?(page\..+)\.(fill|check|uncheck|setChecked|selectOption)\(.*\);?$/

/** 录下的代码里，每个字段动作的定位（按顺序） */
export function recordedFieldLocators(code: string | undefined): { locator: string; secret: boolean }[] {
  if (!code) return []
  const out: { locator: string; secret: boolean }[] = []
  for (const raw of code.split("\n")) {
    const match = ACTION_LINE.exec(raw.trim())
    if (match) out.push({ locator: match[1]!, secret: /SECRET_/.test(raw) })
  }
  return out
}

const quote = (value: string) => {
  const clipped = value.length > VALUE_CHARS ? `${value.slice(0, VALUE_CHARS)}…（共 ${value.length} 字）` : value
  // JSON 写法：多行、首尾空格看得出来
  return JSON.stringify(clipped)
}

interface ElementFacts {
  password: boolean
  autocomplete: string
  name: string
  id: string
  select: string[] | null
}

/** 在页面里看到的元素（服务器的类型里没有 DOM，只写用到的几个） */
interface PageElement {
  tagName: string
  type?: string
  id?: string
  selectedOptions?: ArrayLike<{ label: string; text: string }>
  getAttribute(name: string): string | null
}

/**
 * 在元素上读：是不是密码框、autocomplete、name、id、下拉框选中的文字（不是下拉框是 null）。
 * 这个函数被送进页面里跑：只能用参数，不能引用外面的东西
 */
async function factsOf(locator: Locator): Promise<ElementFacts | undefined> {
  return locator
    .evaluate(
      (node) => {
        const el = node as unknown as PageElement
        return {
          password: el.tagName === "INPUT" && String(el.type || "").toLowerCase() === "password",
          autocomplete: String(el.getAttribute("autocomplete") || "").toLowerCase(),
          name: el.getAttribute("name") || "",
          id: el.id || "",
          select: el.tagName === "SELECT" && el.selectedOptions ? Array.from(el.selectedOptions).map((option) => option.label || option.text) : null,
        }
      },
      undefined,
      { timeout: READ_MS }
    )
    .catch(() => undefined)
}

/** 一个字段的那一行（不带前面的「- 名字：」） */
async function readOne(locator: Locator, field: FilledField, recordedSecret: boolean, locatorText: string): Promise<string> {
  const facts = await factsOf(locator)
  if (!facts) return "读不出来（页面上找不到这个字段了，可能已经跳转）"
  const secret =
    recordedSecret ||
    facts.password ||
    /password|one-time-code/.test(facts.autocomplete) ||
    /\{\{\s*password\s*\}\}/i.test(field.value) ||
    [field.name, facts.name, facts.id, locatorText].some((text) => SECRET_NAME.test(text))
  const type = field.type
  if (type === "checkbox" || type === "radio") {
    const checked = await locator.isChecked({ timeout: READ_MS }).catch(() => undefined)
    if (checked === undefined) return "读不出来"
    const wanted = field.value === "true"
    return `${checked ? "勾上了" : "没勾"}${checked !== wanted ? "（和要填的不一样）" : ""}`
  }
  if (secret) return "已填（密码类，不显示）"
  if (type === "combobox") {
    const shown = facts.select ?? [await locator.inputValue({ timeout: READ_MS }).catch(async () => (await locator.innerText({ timeout: READ_MS }).catch(() => "")).trim())]
    const text = shown.join("、")
    return `选中 ${quote(text)}${shown.length && !shown.includes(field.value) ? "（和要选的不一样）" : ""}`
  }
  const value = await locator.inputValue({ timeout: READ_MS }).catch(async () => locator.innerText({ timeout: READ_MS }).catch(() => undefined))
  if (value === undefined) return "读不出来"
  // 换行写法不同（\r\n）不算不一样
  const same = value.replace(/\r\n/g, "\n") === field.value.replace(/\r\n/g, "\n")
  return `${quote(value)}${same || /\{\{.+\}\}/.test(field.value) ? "" : "（和要填的不一样）"}`
}

/**
 * fill_form 做完：每个字段一行「- 名字：实际的值」。读不了页面（关了、跳走了）的字段写「读不出来」，不抛错。
 * 返回空数组 = 没有字段
 */
export async function readBackForm(page: Page, fields: FilledField[], code: string | undefined): Promise<string[]> {
  if (!fields.length) return []
  const recorded = recordedFieldLocators(code)
  const lines: string[] = []
  for (const [index, field] of fields.entries()) {
    const fromCode = recorded.length === fields.length ? recorded[index] : undefined
    const text = fromCode?.locator ?? (field.target && !SNAPSHOT_REF.test(field.target.trim()) ? field.target : undefined)
    let line = "读不出来"
    if (text)
      try {
        line = await readOne(buildLocator(page, text).first(), field, fromCode?.secret ?? false, text)
      } catch {
        line = "读不出来"
      }
    lines.push(`- ${field.name || `第 ${index + 1} 个字段`}：${line}`)
  }
  return ["填进去的值（从页面上读回来的）：", ...lines]
}
