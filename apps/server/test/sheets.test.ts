// 表格文件：SheetJS 读写的单元测试（概览、分页、日期、合并单元格、csv 编码、工作表名和行数检查），
// 以及走完整引擎的 file.save（sheets → xlsx / xls）+ file.read（概览、按行读）、页面预览接口 GET /api/files/:id/sheet。
import { and, desc, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as XLSX from "xlsx"

import * as t from "../src/db/schema.js"
import { saveFile } from "../src/files/service.js"
import { buildWorkbook, parseBook, previewOf, rangeText, overviewText, SheetError, XLS_MIME, XLSX_MIME } from "../src/files/sheets.js"
import { login, mutate } from "./helpers.js"
import { call, createTask, eventsOf, Script, setupEngine, step, text, useScript, waitStatus, type EngineTestContext } from "./engine-helpers.js"

/** 用 SheetJS 直接做一个带日期、多个工作表、合并单元格的文件（模拟别的系统导出的） */
function sampleBook(bookType: "xlsx" | "xls") {
  const book = XLSX.utils.book_new()
  const orders: unknown[][] = [["订单号", "下单日期", "金额", "备注"]]
  for (let i = 1; i <= 300; i++)
    orders.push([`A${String(i).padStart(4, "0")}`, new Date(Date.UTC(2026, 0, i % 28 + 1)), i * 1.5, i === 3 ? "第一行\n第二行\t带制表符" : null])
  const sheet = XLSX.utils.aoa_to_sheet(orders, { cellDates: true, UTC: true } as XLSX.AOA2SheetOpts)
  XLSX.utils.book_append_sheet(book, sheet, "订单")
  const summary = XLSX.utils.aoa_to_sheet([["汇总", null], ["合计", 67725], ["时间", new Date(Date.UTC(2026, 9, 19, 8, 30))]], { cellDates: true, UTC: true } as XLSX.AOA2SheetOpts)
  summary["!merges"] = [XLSX.utils.decode_range("A1:B1")]
  XLSX.utils.book_append_sheet(book, summary, "汇总")
  return XLSX.write(book, { type: "buffer", bookType }) as Buffer
}

describe("SheetJS 读写（不连库）", () => {
  for (const format of ["xlsx", "xls"] as const) {
    it(`${format}：概览有每个工作表的范围和前 20 行；日期、换行、合并单元格；按行分页`, () => {
      const book = parseBook(sampleBook(format), `报表.${format}`, format === "xls" ? XLS_MIME : XLSX_MIME)
      expect(book.sheets.map((sheet) => sheet.name)).toEqual(["订单", "汇总"])
      const overview = overviewText(book, `报表.${format}`, 20_000)
      expect(overview).toContain("2 个工作表")
      expect(overview).toContain("## 1.「订单」A1:D301，301 行 × 4 列")
      expect(overview).toContain("行\tA\tB\tC\tD")
      expect(overview).toContain("1\t订单号\t下单日期\t金额\t备注")
      expect(overview).toContain("2\tA0001\t2026-01-02\t1.5")
      expect(overview).toContain("4\tA0003\t2026-01-04\t4.5\t第一行\\n第二行\\t带制表符")
      expect(overview).toContain("20\tA0019")
      expect(overview).not.toContain("21\tA0020")
      expect(overview).toContain("后面还有 281 行")
      expect(overview).toContain("## 2.「汇总」A1:B3")
      expect(overview).toContain("合并单元格 1 处：A1:B1")
      expect(overview).toContain("3\t时间\t2026-10-19 08:30")

      const page = rangeText(book, "报表", { sheet: "订单", startRow: 101, rows: 50 }, 20_000)
      expect(page).toContain("1\t订单号")
      expect(page).toContain("101\tA0100")
      expect(page).toContain("150\tA0149")
      expect(page).not.toContain("151\tA0150")
      expect(page).toContain("用 startRow = 151 接着读")
      const last = rangeText(book, "报表", { sheet: 1, startRow: 290 }, 20_000)
      expect(last).toContain("301\tA0300")
      expect(last).toContain("（读完了）")
      expect(rangeText(book, "报表", { sheet: "2" }, 20_000)).toContain("2\t合计\t67725")
      expect(rangeText(book, "报表", { sheet: "订单", startRow: 999 }, 20_000)).toContain("没有第 999 行，内容到第 301 行为止")
      expect(() => rangeText(book, "报表", { sheet: "不存在" }, 20_000)).toThrow(/没有工作表「不存在」。有：1.「订单」、2.「汇总」/)
    })
  }

  it("字数上限：一段读不完时停在上限内，告诉从哪行接着读", () => {
    const rows = [["长文本"], ...Array.from({ length: 400 }, (_, i) => [`${i}-${"字".repeat(200)}`])]
    const book = parseBook(buildWorkbook([{ name: "长", rows }], "xlsx"), "长.xlsx", XLSX_MIME)
    const page = rangeText(book, "长.xlsx", { startRow: 2, rows: 500 }, 20_000)
    expect(page.length).toBeLessThanOrEqual(20_000)
    expect(page).toMatch(/字数到上限了；后面还有 \d+ 行，用 startRow = \d+ 接着读/)
    expect(overviewText(book, "长.xlsx", 20_000).length).toBeLessThanOrEqual(20_000)
  })

  it("csv：GBK 编码也能读；值照原文（前导 0 不丢）；tsv 按制表符分", () => {
    const gbk = Buffer.from([0xc3, 0xfb, 0xb3, 0xc6, 0x2c, 0xb1, 0xe0, 0xba, 0xc5, 0x0a, 0xc6, 0xbb, 0xb9, 0xfb, 0x2c, 0x30, 0x30, 0x31, 0x32, 0x33, 0x0a]) // 名称,编号\n苹果,00123
    const csv = parseBook(gbk, "导出.csv", "text/csv")
    expect(rangeText(csv, "导出.csv", {}, 20_000)).toContain("2\t苹果\t00123")
    const bom = parseBook(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("名称,数量\n苹果,3\n")]), "bom.csv", "text/csv")
    expect(rangeText(bom, "bom.csv", {}, 20_000)).toContain("\n1\t名称\t数量\n")
    const tsv = parseBook(Buffer.from("a,b\tc\n1,2\t3\n"), "x.tsv", "text/tab-separated-values")
    expect(rangeText(tsv, "x.tsv", {}, 20_000)).toContain("2\t1,2\t3")
  })

  it("写：工作表名不合规矩、重名、xls 超过 65536 行 / 256 列都报清楚的错；以 = 开头的文字不会变成公式", () => {
    const bad = (sheets: { name: string; rows: (string | number | null)[][] }[], format: "xlsx" | "xls" = "xlsx") => {
      try {
        buildWorkbook(sheets, format)
      } catch (error) {
        expect(error).toBeInstanceOf(SheetError)
        return (error as Error).message
      }
      throw new Error("没报错")
    }
    expect(bad([{ name: "a/b", rows: [] }])).toContain("不能有 [ ] : * ? / \\")
    expect(bad([{ name: "x".repeat(32), rows: [] }])).toContain("最多 31 个字")
    expect(bad([{ name: "表", rows: [] }, { name: "表", rows: [] }])).toContain("重复了")
    expect(bad([{ name: " ", rows: [] }])).toContain("不能是空的")
    expect(bad([{ name: "大", rows: Array.from({ length: 65_537 }, () => [1]) }], "xls")).toContain("xls 最多 65536 行（行多请用 xlsx）")
    expect(bad([{ name: "宽", rows: [Array.from({ length: 257 }, () => 1)] }], "xls")).toContain("xls 最多 256 列")
    const book = parseBook(buildWorkbook([{ name: "公式", rows: [["=1+1", 2, true, null, "末尾"]] }], "xlsx"), "f.xlsx", XLSX_MIME)
    expect(rangeText(book, "f.xlsx", {}, 20_000)).toContain("1\t=1+1\t2\tTRUE\t\t末尾")
  })

  it("坏文件：报「打不开」，不抛别的错", () => {
    expect(() => parseBook(Buffer.from("PK\u0003\u0004 不是真的 zip"), "坏.xlsx", XLSX_MIME)).toThrow(SheetError)
  })

  it("页面预览：每个工作表前 n 行，带列名和总行列数", () => {
    const preview = previewOf(parseBook(sampleBook("xlsx"), "报表.xlsx", XLSX_MIME), 5)
    expect(preview.rowLimit).toBe(5)
    expect(preview.sheets[0]).toMatchObject({ name: "订单", firstRow: 1, columns: ["A", "B", "C", "D"], totalRows: 301, totalCols: 4, merged: 0 })
    expect(preview.sheets[0]!.rows).toHaveLength(5)
    expect(preview.sheets[0]!.rows[1]).toEqual(["A0001", "2026-01-02", "1.5"])
    expect(preview.sheets[1]).toMatchObject({ name: "汇总", merged: 1, totalRows: 3 })
  })
})

describe("引擎里的 file.save / file.read 和预览接口", () => {
  let ctx: EngineTestContext
  let wang: string

  beforeAll(async () => {
    ctx = await setupEngine()
    wang = await login(ctx.app, "wangyue@heyagent.local")
  }, 120_000)

  afterAll(async () => {
    await ctx?.stop()
  })

  const savedFile = async (sessionName: string) => {
    const [row] = await ctx.db.select().from(t.files).where(and(eq(t.files.name, sessionName), eq(t.files.kind, "artifact"))).orderBy(desc(t.files.createdAt)).limit(1)
    return row!
  }

  it("存 xlsx 和 xls，读回来；附件里的 xls 按行读；不合规矩的报错；存的 Excel 能预览", async () => {
    const attached = await saveFile(ctx.db, { data: sampleBook("xls"), name: "系统导出.xls", kind: "upload" })
    const sheets = [
      { name: "结果", rows: [["名称", "数量", "日期"], ["苹果", 3, "2026-10-19"], ["梨", 1.25, null]] },
      { name: "说明", rows: [["这是第二个表"]] },
    ]
    useScript(
      "test/sheets",
      new Script([
        step([
          call("file.save", { name: "结果.xlsx", sheets }),
          call("file.save", { name: "老格式", sheets, format: "xls" }),
          call("file.save", { name: "错.xlsx", content: "a,b" }),
          call("file.save", { name: "错2.xlsx", sheets: [{ name: "a:b", rows: [] }] }),
          call("file.save", { name: "错3.csv", sheets }),
          call("file.read", { fileId: attached.id }),
          call("file.read", { fileId: attached.id, sheet: "订单", startRow: 200, rows: 3 }),
        ]),
        async () => {
          const xlsx = await savedFile("结果.xlsx")
          const xls = await savedFile("老格式.xls")
          return step([call("file.read", { fileId: xlsx.id }), call("file.read", { fileId: xls.id, sheet: 2 })])
        },
        step([text("好了")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/sheets", toolIds: ["file.read", "file.save"] })
    const res = await mutate(ctx.app, "engine.runNow", wang, { taskId, attachmentFileIds: [attached.id] })
    const sessionId = res.data!.sessionId as string
    await waitStatus(ctx.db, sessionId, "done")

    const outputs = (await eventsOf(ctx.db, sessionId)).filter((event) => event.kind === "tool").map((event) => `${event.toolId} ${event.output}`)
    const find = (needle: string) => outputs.find((output) => output.includes(needle))
    expect(find("已保存 Excel 文件 结果.xlsx")).toMatch(/2 个工作表、共 4 行/)
    expect(find("已保存 Excel 文件 老格式.xls")).toBeTruthy()
    expect(find("存 Excel 要给 sheets")).toBeTruthy()
    expect(find("工作表名「a:b」里不能有")).toBeTruthy()
    expect(find("文件名要以 .xlsx 或 .xls 结尾")).toBeTruthy()
    expect(find("系统导出.xls：2 个工作表")).toContain("2\tA0001\t2026-01-02\t1.5")
    const page = find("「订单」（A1:D301")!
    expect(page).toContain("200\tA0199")
    expect(page).toContain("202\tA0201")
    expect(page).toContain("用 startRow = 203 接着读")
    expect(find("结果.xlsx：2 个工作表")).toContain("3\t梨\t1.25")
    expect(find("老格式.xls 的「说明」")).toContain("1\t这是第二个表")

    const xlsx = await savedFile("结果.xlsx")
    const xls = await savedFile("老格式.xls")
    expect(xlsx.mime).toBe(XLSX_MIME)
    expect(xls.mime).toBe(XLS_MIME)
    expect(xlsx.sessionId).toBe(sessionId)

    // 预览接口：要登录；不是表格 415；输出每个工作表
    expect((await ctx.app.request(`/api/files/${xlsx.id}/sheet`)).status).toBe(401)
    expect((await ctx.app.request(`/api/files/f-nope/sheet`, { headers: { cookie: wang } })).status).toBe(404)
    const txt = await saveFile(ctx.db, { data: Buffer.from("hi"), name: "a.txt", kind: "artifact", sessionId })
    expect((await ctx.app.request(`/api/files/${txt.id}/sheet`, { headers: { cookie: wang } })).status).toBe(415)
    const broken = await saveFile(ctx.db, { data: Buffer.from("PK\u0003\u0004 不是真的 zip"), name: "坏.xlsx", kind: "artifact", sessionId })
    const brokenRes = await ctx.app.request(`/api/files/${broken.id}/sheet`, { headers: { cookie: wang } })
    expect(brokenRes.status).toBe(422)
    expect(((await brokenRes.json()) as { error: string }).error).toContain("坏.xlsx 打不开")
    const preview = await ctx.app.request(`/api/files/${xls.id}/sheet?rows=2`, { headers: { cookie: wang } })
    expect(preview.status).toBe(200)
    expect(await preview.json()).toEqual({
      rowLimit: 2,
      sheets: [
        { name: "结果", hidden: false, firstRow: 1, columns: ["A", "B", "C"], rows: [["名称", "数量", "日期"], ["苹果", "3", "2026-10-19"]], totalRows: 3, totalCols: 3, merged: 0 },
        { name: "说明", hidden: false, firstRow: 1, columns: ["A"], rows: [["这是第二个表"]], totalRows: 1, totalCols: 1, merged: 0 },
      ],
    })
  })
})
