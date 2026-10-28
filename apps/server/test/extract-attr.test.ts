// browser.extract 的 attr（docs/dev/solidify.md 21.3 第 2 条）：attr 是 HTML 属性；写 textContent、innerText、text 的按文字读，
// 不再读出 null。不开 Chrome：假的 page / locator。
import type { Page } from "playwright-core"
import { describe, expect, it } from "vitest"

import { extractRows } from "../src/browser/extract.js"

interface FakeElement {
  attrs: Record<string, string>
  innerText: string
  textContent: string
  value?: string
}

/** 只认 css=… 这种写法（parseLocatorChain 认不出，走 root.locator） */
function fakePage(elements: Record<string, FakeElement>): Page {
  const locator = (selector: string) => {
    const element = elements[selector]
    return {
      count: async () => (element ? 1 : 0),
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
