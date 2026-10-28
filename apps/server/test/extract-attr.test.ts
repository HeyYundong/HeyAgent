// browser.extract 的 attr（docs/dev/solidify.md 21.3 第 2 条）：attr 是 HTML 属性；写 textContent、innerText、text 的按文字读，
// 不再读出 null。不开 Chrome：假的 page / locator。
import type { Page } from "playwright-core"
import { describe, expect, it } from "vitest"

import { extractRows, formatExtract } from "../src/browser/extract.js"

interface FakeElement {
  attrs: Record<string, string>
  innerText: string
  textContent: string
  value?: string
  /** 定位匹配到几处（默认 1） */
  count?: number
}

/** 只认 css=… 这种写法（parseLocatorChain 认不出，走 root.locator） */
function fakePage(elements: Record<string, FakeElement>): Page {
  const locator = (selector: string) => {
    const element = elements[selector]
    return {
      count: async () => (element ? (element.count ?? 1) : 0),
      first: () => ({
        getAttribute: async (name: string) => element?.attrs[name] ?? null,
        inputValue: async () => element?.value ?? "",
        innerText: async () => element?.innerText ?? "",
        textContent: async () => element?.textContent ?? null,
      }),
    }
  }
  return { url: () => "https://shop.test/e/report", locator } as unknown as Page
}

describe("browser.extract 的 attr", () => {
  const page = fakePage({
    "css=.done": { attrs: { class: "done", title: "提示" }, innerText: "已提交 6 条", textContent: "已提交 6 条 （隐藏的说明）" },
    "css=a": { attrs: { href: "/detail/1" }, innerText: "详情", textContent: "详情" },
  })

  it("textContent、innerText、text 按文字读（以前读 HTML 属性，读出 null）", async () => {
    const { rows } = await extractRows(page, {
      fields: {
        a: { target: "css=.done", attr: "textContent" },
        b: { target: "css=.done", attr: "innerText" },
        c: { target: "css=.done", attr: "text" },
        d: { target: "css=.done", attr: "TEXTCONTENT" },
        e: "css=.done",
      },
    })
    expect(rows[0]).toEqual({ a: "已提交 6 条 （隐藏的说明）", b: "已提交 6 条", c: "已提交 6 条", d: "已提交 6 条 （隐藏的说明）", e: "已提交 6 条" })
  })

  it("别的 attr 照旧取 HTML 属性；网址类的换成完整网址；没有的属性是 null", async () => {
    const { rows } = await extractRows(page, {
      fields: { title: { target: "css=.done", attr: "title" }, link: { target: "css=a", attr: "href" }, none: { target: "css=.done", attr: "data-x" } },
    })
    expect(rows[0]).toEqual({ title: "提示", link: "https://shop.test/detail/1", none: null })
  })
})

describe("browser.extract 不给 list（docs/dev/sub-agents.md 21.7.4 第 2 条）", () => {
  const page = fakePage({
    "css=th": { attrs: {}, innerText: "联系人", textContent: "联系人", count: 4 },
    "css=td": { attrs: {}, innerText: "李强", textContent: "李强", count: 4 },
    "css=h1": { attrs: {}, innerText: "供应商详情", textContent: "供应商详情" },
  })

  it("字段的定位匹配到好几处：只读第一处，输出里说找到几处、要读全部用 list；数据（脚本拿到的）不变", async () => {
    const input = { fields: { field: "css=th", value: "css=td", title: "css=h1" } }
    const result = await extractRows(page, input)
    expect(result.rows).toEqual([{ field: "联系人", value: "李强", title: "供应商详情" }])
    expect(result.multiple).toEqual([
      { field: "field", target: "css=th", count: 4 },
      { field: "value", target: "css=td", count: 4 },
    ])
    const text = formatExtract(input, result)
    expect(text).toContain("注意：「field」的定位 css=th 在页面上找到 4 处，只读了第一处。要读全部，给 list（每一行的定位，例如 getByRole('row')）")
    expect(text).toContain("注意：「value」的定位 css=td 在页面上找到 4 处")
    expect(text).not.toContain("「title」的定位")
    expect(text).not.toContain("limit")
  })

  it("给了 limit 没给 list：提示 limit 不起作用；只匹配到一处、没给 limit 的不提示", async () => {
    const one = { fields: { title: "css=h1" } }
    expect(formatExtract(one, await extractRows(page, one))).not.toContain("注意")
    const limited = { fields: { title: "css=h1" }, limit: 20 }
    const result = await extractRows(page, limited)
    expect(result.multiple).toBeUndefined()
    expect(formatExtract(limited, result)).toContain("注意：没给 list 时 limit 不起作用，整页只读一行（每个字段读第一处）。要读多行，给 list（每一行的定位）。")
    const both = { fields: { value: "css=td" }, limit: 20 }
    const text = formatExtract(both, await extractRows(page, both))
    expect(text).toContain("找到 4 处，只读了第一处")
    expect(text).toContain("（没给 list 时 limit 不起作用。）")
  })
})
