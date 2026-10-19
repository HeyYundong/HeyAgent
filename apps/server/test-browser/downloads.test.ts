// 真浏览器 + 假模型：agent 在网页里点「导出」下载的文件都存成这次运行的文件（kind = download），工具输出里告诉 agent，
// agent 再用 file.read 读下载的 Excel。三种下载：<a download> 链接、新标签页里打开的附件（Content-Disposition）、网页用 blob: 生成的文件。
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { and, eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as XLSX from "xlsx"

import * as t from "../src/db/schema.js"
import { call, createTask, eventsOf, Script, setupEngine, step, text, useScript, waitStatus, type EngineTestContext } from "../test/engine-helpers.js"
import { login, mutate, query } from "../test/helpers.js"
import { createProfile } from "./fixtures.js"

let ctx: EngineTestContext
let wang: string
let profileId: string
let server: Server
let base = ""

function reportXlsx() {
  const book = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet([["名称", "数量"], ["苹果", 3], ["梨", 5]]), "导出")
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer
}

beforeAll(async () => {
  ctx = await setupEngine()
  wang = await login(ctx.app, "wangyue@heyagent.local")
  profileId = await createProfile(ctx.db, ctx.keyring)
  server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname
    if (path === "/report.xlsx") {
      res.writeHead(200, { "content-type": "application/octet-stream" })
      return res.end(reportXlsx())
    }
    if (path === "/export") {
      res.writeHead(200, { "content-type": "application/vnd.ms-excel", "content-disposition": "attachment; filename*=UTF-8''%E5%AF%BC%E5%87%BA.csv" })
      return res.end("名称,数量\n桃,7\n")
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" })
    res.end(
      `<!doctype html><html><head><meta charset="utf-8"><title>导出</title></head><body>` +
        `<a id="xlsx" href="/report.xlsx" download="报表.xlsx">导出 Excel</a> ` +
        `<a id="tab" href="/export" target="_blank">新标签页导出</a> ` +
        `<button id="blob" onclick="const a=document.createElement('a');a.href=window.URL.createObjectURL(new Blob(['x,y\\n1,2'],{type:'text/csv'}));a.download='网页生成.csv';a.click()">生成文件</button>` +
        `</body></html>`
    )
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await ctx?.stop()
  await new Promise((resolve) => server?.close(resolve))
})

describe("浏览器下载", () => {
  it("链接下载、新标签页附件、blob 文件都存成这次运行的文件；输出里告诉 agent；agent 能读下载的 Excel", async () => {
    let sessionId = ""
    const downloaded = async (name: string) => {
      const [row] = await ctx.db.select().from(t.files).where(and(eq(t.files.sessionId, sessionId), eq(t.files.name, name), eq(t.files.kind, "download")))
      return row
    }
    const script = useScript(
      "test/downloads",
      new Script([
        step([call("browser.navigate", { url: `${base}/` })]),
        step([call("browser.click", { element: "导出 Excel", target: "#xlsx" })]),
        step([call("browser.click", { element: "新标签页导出", target: "#tab" })]),
        step([call("browser.click", { element: "生成文件", target: "#blob" })]),
        async () => step([call("file.read", { fileId: (await downloaded("报表.xlsx"))!.id })]),
        step([text("读完了")]),
      ])
    )
    const taskId = await createTask(ctx.db, { modelId: "test/downloads", toolIds: ["browser"], ownerId: "u-wang" })
    await ctx.db.update(t.tasks).set({ browserProfileIds: [profileId], allowedDomains: [] }).where(eq(t.tasks.id, taskId))
    const res = await mutate(ctx.app, "engine.runNow", wang, { taskId })
    sessionId = res.data!.sessionId as string
    await waitStatus(ctx.db, sessionId, "done", 90_000)

    expect(script.promptText(2)).toMatch(/下载了 报表\.xlsx（文件 f-[0-9a-f]+，\d+ KB）/)
    expect(script.promptText(3)).toMatch(/下载了 导出\.csv（文件 f-[0-9a-f]+，\d+ 字节）/)
    expect(script.promptText(4)).toMatch(/下载了 网页生成\.csv/)
    // 下载的 Excel 能读（选了浏览器自动带上 file.read）
    expect(script.promptText(5)).toContain("2\\t苹果\\t3")
    const xlsx = await downloaded("报表.xlsx")
    expect(xlsx?.mime).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
    expect((await downloaded("导出.csv"))?.size).toBe(Buffer.byteLength("名称,数量\n桃,7\n"))
    expect((await downloaded("网页生成.csv"))?.size).toBe(7)
    const events = await eventsOf(ctx.db, sessionId)
    expect(events.filter((event) => event.title.startsWith("浏览器里下载了")).map((event) => event.title)).toEqual([
      "浏览器里下载了 报表.xlsx",
      "浏览器里下载了 导出.csv",
      "浏览器里下载了 网页生成.csv",
    ])
    const files = (await query(ctx.app, "engine.sessionFiles", wang, { sessionId })).data as { name: string; kind: string }[]
    expect(files.filter((file) => file.kind === "download").map((file) => file.name).sort()).toEqual(["导出.csv", "报表.xlsx", "网页生成.csv"].sort())
  })
})
