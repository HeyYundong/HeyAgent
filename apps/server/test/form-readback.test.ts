// browser.fill_form 读回实际的值（browser/form-readback.ts，docs/dev/routine-library.md 18.6 第 3 条）：假页面，不开 Chrome。
import { describe, expect, it } from "vitest"

import { readBackForm, readBackTyped, recordedFieldLocators, type FilledField } from "../src/browser/form-readback.js"

interface FakeElement {
  value?: string
  checked?: boolean
  password?: boolean
  autocomplete?: string
  name?: string
  id?: string
  select?: string[] | null
}

/** 假的 Playwright 定位：按调用链（getByRole:textbox:名称）找元素；找不到的读的时候抛错（和页面上没有一样） */
class FakeLocator {
  readonly key: string
  private readonly element: FakeElement | undefined
  constructor(key: string, element: FakeElement | undefined) {
    this.key = key
    this.element = element
  }
  private get el() {
    if (!this.element) throw new Error(`找不到 ${this.key}`)
    return this.element
  }
  first() {
    return this
  }
  async evaluate() {
    const el = this.el
    return { password: Boolean(el.password), autocomplete: el.autocomplete ?? "", name: el.name ?? "", id: el.id ?? "", select: el.select ?? null }
  }
  async isChecked() {
    return Boolean(this.el.checked)
  }
  async inputValue() {
    return this.el.value ?? ""
  }
  async innerText() {
    return this.el.value ?? ""
  }
}

function fakePage(elements: Record<string, FakeElement>) {
  const find = (key: string) => new FakeLocator(key, elements[key])
  return {
    getByRole: (role: string, options?: { name?: string }) => find(`role:${role}:${options?.name ?? ""}`),
    getByLabel: (text: string) => find(`label:${text}`),
    locator: (css: string) => find(`css:${css}`),
  }
}

describe("fill_form 读回实际的值", () => {
  it("录下的代码一个字段一行：取出定位，标出用了密钥的", () => {
    const code = [
      "await page.getByRole('textbox', { name: '名称' }).fill('折叠椅');",
      "await page.getByRole('combobox', { name: '分类' }).selectOption('户外');",
      "await page.getByRole('checkbox', { name: '加急' }).check();",
      "await page.getByLabel('口令').fill('SECRET_pin');",
    ].join("\n")
    expect(recordedFieldLocators(code)).toEqual([
      { locator: "page.getByRole('textbox', { name: '名称' })", secret: false },
      { locator: "page.getByRole('combobox', { name: '分类' })", secret: false },
      { locator: "page.getByRole('checkbox', { name: '加急' })", secret: false },
      { locator: "page.getByLabel('口令')", secret: true },
    ])
    expect(recordedFieldLocators(undefined)).toEqual([])
  })

  it("输入框的值（多行用 JSON 写法）、下拉选中的文字、勾选框；和要填的不一样的标出来；密码框、名字像密钥的、用了占位符的不显示", async () => {
    const page = fakePage({
      "role:textbox:名称": { value: "折叠椅" },
      "role:textbox:备注": { value: "第一行\n第二行" },
      "role:textbox:编号": { value: "AB-1" },
      "role:combobox:分类": { select: ["户外"] },
      "role:checkbox:加急": { checked: false },
      "label:口令": { value: "pin-42", password: true },
      "role:textbox:API Token": { value: "tok-9" },
      "role:textbox:账号密码": { value: "real-password" },
    })
    const fields: FilledField[] = [
      { name: "名称", type: "textbox", value: "折叠椅" },
      { name: "备注", type: "textbox", value: "第一行\r\n第二行" },
      { name: "编号", type: "textbox", value: "ab-1" },
      { name: "分类", type: "combobox", value: "户外" },
      { name: "加急", type: "checkbox", value: "true" },
      { name: "口令", type: "textbox", value: "pin-42" },
      { name: "API Token", type: "textbox", value: "tok-9" },
      { name: "账号", type: "textbox", value: "{{password}}" },
    ]
    const code = [
      "await page.getByRole('textbox', { name: '名称' }).fill('折叠椅');",
      "await page.getByRole('textbox', { name: '备注' }).fill('第一行\\n第二行');",
      "await page.getByRole('textbox', { name: '编号' }).fill('ab-1');",
      "await page.getByRole('combobox', { name: '分类' }).selectOption('户外');",
      "await page.getByRole('checkbox', { name: '加急' }).check();",
      "await page.getByLabel('口令').fill('pin-42');",
      "await page.getByRole('textbox', { name: 'API Token' }).fill('tok-9');",
      "await page.getByRole('textbox', { name: '账号密码' }).fill('real-password');",
    ].join("\n")
    const lines = await readBackForm(page as never, fields, code)
    expect(lines).toEqual([
      "填进去的值（从页面上读回来的）：",
      '- 名称："折叠椅"',
      '- 备注："第一行\\n第二行"',
      '- 编号："AB-1"（和要填的不一样）',
      '- 分类：选中 "户外"',
      "- 加急：没勾（和要填的不一样）",
      "- 口令：已填（密码类，不显示）",
      "- API Token：已填（密码类，不显示）",
      "- 账号：已填（密码类，不显示）",
    ])
    const text = lines.join("\n")
    for (const secret of ["pin-42", "tok-9", "real-password"]) expect(text).not.toContain(secret)
  })

  it("录下的代码和字段对不上：target 是选择器的照它找，是快照 ref 的写「读不出来」；页面上找不到的也不抛错", async () => {
    const page = fakePage({ "css:#qty": { value: "3" } })
    const fields: FilledField[] = [
      { name: "数量", type: "textbox", target: "#qty", value: "3" },
      { name: "单价", type: "textbox", target: "e12", value: "9" },
      { name: "折扣", type: "textbox", target: "#gone", value: "1" },
    ]
    expect(await readBackForm(page as never, fields, undefined)).toEqual([
      "填进去的值（从页面上读回来的）：",
      '- 数量："3"',
      "- 单价：读不出来",
      "- 折扣：读不出来（页面上找不到这个字段了，可能已经跳转）",
    ])
    expect(await readBackForm(page as never, [], undefined)).toEqual([])
  })

  it("长的值截短，写出一共几个字", async () => {
    const long = "字".repeat(400)
    const page = fakePage({ "css:#note": { value: long } })
    const [, line] = await readBackForm(page as never, [{ name: "备注", type: "textbox", target: "#note", value: long }], undefined)
    expect(line).toContain("…（共 400 字）")
    expect(line!.length).toBeLessThan(330)
  })
})

describe("type 读回实际的值（sub-agents.md 21.6.5 第 5 条：以前只有「（没有返回内容）」）", () => {
  it("多行文字读回来；页面改过的标出来；慢慢打（pressSequentially）的也认", async () => {
    const summary = "甲厂,0571-1,4.6\n乙厂,0571-2,4.8"
    const page = fakePage({ "role:textbox:汇总": { value: summary }, "role:textbox:单号": { value: "PSS-001" }, "role:textbox:搜索": { value: "前缀 关键词" } })
    expect(await readBackTyped(page as never, { element: "汇总", ref: "e5", text: summary }, "await page.getByRole('textbox', { name: '汇总' }).fill('甲厂,0571-1,4.6\\n乙厂,0571-2,4.8');")).toEqual([
      "填进去的值（从页面上读回来的）：",
      '- 汇总："甲厂,0571-1,4.6\\n乙厂,0571-2,4.8"',
    ])
    expect(await readBackTyped(page as never, { element: "单号", text: "pss-001" }, "await page.getByRole('textbox', { name: '单号' }).fill('pss-001');")).toEqual([
      "填进去的值（从页面上读回来的）：",
      '- 单号："PSS-001"（和要填的不一样）',
    ])
    expect(await readBackTyped(page as never, { element: "搜索", text: "关键词", slowly: true }, "await page.getByRole('textbox', { name: '搜索' }).pressSequentially('关键词');")).toEqual([
      "填进去的值（从页面上读回来的）：",
      '- 搜索："前缀 关键词"（和要填的不一样）',
    ])
    // 没有 element、录下的代码对不上时，target 是选择器的照它找
    expect(await readBackTyped(fakePage({ "css:#qty": { value: "3" } }) as never, { target: "#qty", text: "3" }, undefined)).toEqual(["填进去的值（从页面上读回来的）：", '- 输入框："3"'])
  })

  it("密码类照样打码：密码框、名字像密钥的、用了 {{password}} 占位符的、MCP 标了 SECRET_ 的", async () => {
    const page = fakePage({
      "role:textbox:密码": { value: "real-1", password: true },
      "role:textbox:API Token": { value: "tok-2" },
      "role:textbox:账号": { value: "real-3" },
      "role:textbox:口令": { value: "real-4" },
    })
    const cases: [Record<string, unknown>, string][] = [
      [{ element: "密码", text: "real-1" }, "await page.getByRole('textbox', { name: '密码' }).fill('real-1');"],
      [{ element: "API Token", text: "tok-2" }, "await page.getByRole('textbox', { name: 'API Token' }).fill('tok-2');"],
      [{ element: "账号", text: "{{password}}" }, "await page.getByRole('textbox', { name: '账号' }).fill('{{password}}');"],
      [{ element: "口令", text: "x" }, "await page.getByRole('textbox', { name: '口令' }).fill('SECRET_x');"],
    ]
    for (const [input, code] of cases) {
      const lines = await readBackTyped(page as never, input, code)
      expect(lines[1]).toBe(`- ${input.element as string}：已填（密码类，不显示）`)
      for (const secret of ["real-1", "tok-2", "real-3", "real-4"]) expect(lines.join("\n")).not.toContain(secret)
    }
  })

  it("submit 的不读（按了回车，页面多半已经变了）；没有 text 不读", async () => {
    const page = fakePage({ "role:textbox:搜索": { value: "" } })
    expect(await readBackTyped(page as never, { element: "搜索", text: "关键词", submit: true }, "await page.getByRole('textbox', { name: '搜索' }).fill('关键词');")).toEqual([])
    expect(await readBackTyped(page as never, { element: "搜索" }, undefined)).toEqual([])
  })
})
