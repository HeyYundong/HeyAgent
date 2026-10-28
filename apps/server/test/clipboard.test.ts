// 剪贴板工具里不需要 Chrome 的部分：TSV 编解码、表格整理和分段、MCP browser_evaluate 输出的解析、页面检查和报错文案。
// 真浏览器里的复制图片、读写剪贴板在 test-browser/clipboard.test.ts。
import { describe, expect, it } from "vitest"

import { clipboardPageProblem, friendlyClipboardError, parseEvaluateResult, pickByRefFunction, PICK_ATTR } from "../src/browser/clipboard.js"
import { encodeTsv, linesPage, looksLikeTable, parseTsv, tablePage } from "../src/browser/tsv.js"

describe("TSV", () => {
  it("编码：含制表符、换行、引号的格子加引号，引号写两遍；空格子留空", () => {
    expect(encodeTsv([["a", "b"], ["c", "d"]])).toBe("a\tb\nc\td")
    expect(encodeTsv([["有\t制表符", "两\n行", '说"好"'], ["", "x", ""]])).toBe('"有\t制表符"\t"两\n行"\t"说""好"""\n\tx\t')
    expect(encodeTsv([["a\r\nb"]])).toBe('"a\r\nb"')
    expect(encodeTsv([])).toBe("")
  })

  it("解码：Excel 的引号规则、\\r\\n、最后的换行、空格子、不等长的行", () => {
    expect(parseTsv("a\tb\r\nc\td\r\n")).toEqual([["a", "b"], ["c", "d"]])
    expect(parseTsv('"有\t制表符"\t"两\n行"\t"说""好"""\n\tx\t')).toEqual([["有\t制表符", "两\n行", '说"好"'], ["", "x", ""]])
    expect(parseTsv("a\tb\tc\nd\n\ne\tf")).toEqual([["a", "b", "c"], ["d"], [""], ["e", "f"]])
    expect(parseTsv("")).toEqual([])
    expect(parseTsv("\n")).toEqual([])
    expect(parseTsv("单独一格")).toEqual([["单独一格"]])
    expect(parseTsv("a\t")).toEqual([["a", ""]])
  })

  it("解码：不成对的引号、收尾引号后还有字的，照原文算", () => {
    expect(parseTsv('5" 屏幕\t2')).toEqual([['5" 屏幕', "2"]])
    expect(parseTsv('"没收尾\tx\ny')).toEqual([['"没收尾', "x"], ["y"]])
    expect(parseTsv('"引号"后面有字\tz')).toEqual([['"引号"后面有字', "z"]])
  })

  it("编了再解还是原样", () => {
    const table = [["名称", "说明", "数量"], ["苹果", '红的，"脆"\n产地：山东', "3"], ["", "\t前面有制表符", ""], ["只有一格"]]
    expect(parseTsv(encodeTsv(table))).toEqual(table)
  })

  it("像不像表格：有制表符而且多行", () => {
    const text = "a\tb\nc\td"
    expect(looksLikeTable(text, parseTsv(text))).toBe(true)
    expect(looksLikeTable("a\tb", parseTsv("a\tb"))).toBe(false)
    expect(looksLikeTable("a\nb", parseTsv("a\nb"))).toBe(false)
  })
})

describe("表格整理和分段", () => {
  it("每行带行号，格子里的换行、制表符转义，列数取最宽的一行", () => {
    const page = tablePage([["a", "b\nc"], ["d\te"], ["f", "g", "h"]], 0, 1000)
    expect(page).toMatchObject({ total: 3, cols: 3, next: 3 })
    expect(page.text).toBe("1\ta\tb\\nc\n2\td\\te\n3\tf\tg\th")
  })

  it("按字数分段，offset 接着看", () => {
    const rows = Array.from({ length: 100 }, (_, index) => [`第${index + 1}行`, "x".repeat(20)])
    const first = tablePage(rows, 0, 300)
    expect(first.next).toBeGreaterThan(1)
    expect(first.next).toBeLessThan(100)
    expect(first.text.length).toBeLessThanOrEqual(300)
    expect(first.text.split("\n")[0]).toBe(`1\t第1行\t${"x".repeat(20)}`)
    const second = tablePage(rows, first.next, 300)
    expect(second.text.split("\n")[0]!.startsWith(`${first.next + 1}\t第${first.next + 1}行`)).toBe(true)
    // 一行就超过上限也至少给一行
    expect(tablePage([["y".repeat(500)]], 0, 100).next).toBe(1)
    // offset 超过最后一行：什么都不给
    expect(tablePage(rows, 200, 300)).toMatchObject({ text: "", next: 200, total: 100 })
  })

  it("普通文字按行分段", () => {
    const page = linesPage("一\r\n二\n三", 1, 1000)
    expect(page).toMatchObject({ text: "2\t二\n3\t三", next: 3, total: 3 })
  })
})

describe("复制图片的辅助", () => {
  it("解析 MCP browser_evaluate 的输出", () => {
    expect(parseEvaluateResult('### Result\n{\n  "kind": "img",\n  "src": "http://a/b.png"\n}')).toEqual({ kind: "img", src: "http://a/b.png" })
    expect(parseEvaluateResult("### Error\nRef e9 not found")).toBeUndefined()
    // 按定位找图时，后面录下的代码里有花括号：只看 Result 那一段
    expect(
      parseEvaluateResult(`### Result\n{"kind":"img","src":"x"}\n### Ran Playwright code\nawait page.getByRole('img', { name: '大写字母 X' }).evaluate('(element) => {}');`)
    ).toEqual({ kind: "img", src: "x" })
  })

  it("给 MCP 的函数：带上记号和随机串，是一个接 element 的函数", () => {
    const source = pickByRefFunction("abc123")
    expect(source.startsWith("(element) =>")).toBe(true)
    expect(source).toContain(PICK_ATTR)
    expect(source).toContain('"abc123"')
    // 语法对（能编译成函数）
    expect(typeof new Function(`return ${source}`)()).toBe("function")
  })

  it("只有 http(s) 网页能用剪贴板", () => {
    const page = (url: string) => ({ url: () => url }) as Parameters<typeof clipboardPageProblem>[0]
    expect(clipboardPageProblem(undefined)).toBe("还没打开网页")
    expect(clipboardPageProblem(page("about:blank"))).toBe("还没打开网页")
    expect(clipboardPageProblem(page("chrome://settings"))).toContain("用不了剪贴板")
    expect(clipboardPageProblem(page("https://docs.example.com/sheet"))).toBeUndefined()
    expect(clipboardPageProblem(page("http://127.0.0.1:5180/"))).toBeUndefined()
    expect(clipboardPageProblem(page("http://docs.example.com/"))).toContain("不是 https")
  })

  it("剪贴板报错翻成看得懂的话", () => {
    expect(friendlyClipboardError("NotAllowedError: Document is not focused.")).toContain("没有拿到焦点")
    expect(friendlyClipboardError("NotAllowedError: Read permission denied.")).toContain("权限被拒绝")
    expect(friendlyClipboardError("TypeError: boom\n at x")).toBe("读写剪贴板出错：TypeError: boom")
  })
})
