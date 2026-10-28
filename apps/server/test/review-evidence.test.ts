// 复核的证据（docs/dev/run-outcome.md 第 5 节）：过程记录覆盖整次运行（最近 30 条详细、更早的压成一行、有上限、中间省略）；
// 工具参数写成人看得懂的样子（browser.batch 逐个动作带值、批里的步骤和汇总认得出来）；固化流程跑的运行多一节「固化流程的记录」；
// 三方验收的证据（loadEvidence 不带 fullLog）照旧。真实的测试库，直接在库里写运行和过程记录，不调模型。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SessionRoutineState, SessionSnapshot } from "@heyagent/shared"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import { describeToolInput, reviewLog } from "../src/engine/log-text.js"
import { buildReviewPrompt } from "../src/engine/review.js"
import { configureEngine } from "../src/engine/runtime.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { loadEvidence } from "../src/engine/verify.js"
import { createTask } from "./engine-helpers.js"
import { setupApp, type TestApp } from "./helpers.js"

let ctx: TestApp

beforeAll(async () => {
  ctx = await setupApp()
  configureEngine({ keyring: ctx.keyring, filesDir: mkdtempSync(join(tmpdir(), "heyagent-files-")) })
  await ctx.db.insert(t.models).values({ id: "test/review-exec", providerId: "openrouter", name: "测试执行模型", contextK: 128 })
}, 120_000)

afterAll(async () => {
  await ctx?.close()
})

type EventInput = { kind: "tool" | "rule" | "plan"; title: string; toolId?: string; input?: unknown; output?: string; trace?: Record<string, unknown> }

const PRODUCTS = [
  ["P-101", "折叠露营椅", "45.00"],
  ["P-102", "不锈钢保温杯 500ml", "32.50"],
  ["P-103", "户外头灯", "28.00"],
  ["P-104", "速干毛巾", "15.80"],
  ["P-105", "登山杖（一对）", "66.00"],
  ["P-106", "防水登山背包 30L", "89.00"],
  ["P-107", "便携炉头", "52.00"],
  ["P-108", "睡袋 -5℃", "128.00"],
] as const

const fields = ([code, name, price]: readonly string[]) => [
  { name: "编号", type: "textbox", ref: "e11", value: code },
  { name: "名称", type: "textbox", ref: "e12", value: name },
  { name: "单价（元）", type: "textbox", ref: "e13", value: price },
  { name: "库存", type: "textbox", ref: "e14", value: "20" },
  { name: "分类", type: "combobox", ref: "e15", value: "户外用品" },
  { name: "备注", type: "textbox", ref: "e16", value: "新品，请仔细核对规格和包装上的说明文字是否一致" },
]

/** 一个商品的三步：继续录入 → 填表 → 提交 */
const entry = (product: readonly string[]) => [
  { tool: "click", input: { element: "继续录入", target: "role=button[name=\"继续录入\"]" } },
  { tool: "fill_form", input: { fields: fields(product) } },
  { tool: "click", input: { element: "提交", ref: "e20" } },
]

/** 录 8 个商品：P-101～P-105 一步一步录，P-106～P-108 一次 browser.batch（每一步网关也单独记了一条，批那条在后面），之后又看了很多次页面 */
function longRunEvents(): EventInput[] {
  const events: EventInput[] = [{ kind: "tool", title: "打开网页", toolId: "browser.navigate", input: { url: "http://shop.test/admin/products/new" }, output: "### Page\n- Page URL: http://shop.test/admin/products/new" }]
  for (const product of PRODUCTS.slice(0, 5)) {
    for (const action of entry(product)) events.push({ kind: "tool", title: action.tool === "click" ? "点击" : "填表单", toolId: `browser.${action.tool}`, input: action.input, output: "### Ran Playwright code\n```js\nawait page.click()\n```" })
    events.push({ kind: "tool", title: "看页面", toolId: "browser.snapshot", input: {}, output: `已保存：${product[0]}` })
  }
  const actions = PRODUCTS.slice(5).flatMap((product) => entry(product))
  for (const action of actions) events.push({ kind: "tool", title: action.tool === "click" ? "点击" : "填表单", toolId: `browser.${action.tool}`, input: action.input, output: "完成" })
  events.push({
    kind: "tool",
    title: "连着做几步",
    toolId: "browser.batch",
    input: { actions },
    output: [...actions.map((action, index) => `${index + 1}. ${action.tool}「${action.tool === "fill_form" ? "编号、名称、单价（元）、库存、分类、备注" : action.input.element}」 ✓（0.4 秒）`), "", "页面：商品录入", "", "页面快照：", "- button \"继续录入\""].join("\n"),
  })
  for (let i = 0; i < 22; i++) events.push({ kind: "tool", title: "看页面", toolId: "browser.snapshot", input: {}, output: `商品列表第 ${i + 1} 次看：共 8 条` })
  events.push({ kind: "tool", title: "报结果", toolId: "run.finish", input: { outcome: "achieved", summary: "8 个商品都录好了", evidence: "列表里 8 条" }, output: "好" })
  return events
}

let runCounter = 0

async function insertRun(events: EventInput[], options: { routine?: SessionRoutineState; snapshotPatch?: Partial<SessionSnapshot> } = {}) {
  const taskId = await createTask(ctx.db, { modelId: "test/review-exec", title: "录 8 个商品", goal: "把表里的 8 个商品都录进后台，每个只录一次" })
  const snapshot = { ...(await buildSnapshot(ctx.db, taskId, { source: "manual", runAttachments: [] })), ...options.snapshotPatch }
  const id = `R-review-evidence-${++runCounter}`
  const now = new Date()
  await ctx.db.insert(t.sessions).values({ id, taskId, status: "done", modelId: "test/review-exec", triggeredBy: "manual", startedAt: now, endedAt: now, snapshot, routine: options.routine ?? null })
  await ctx.db.insert(t.sessionEvents).values(
    events.map((event, index) => ({
      sessionId: id,
      seq: index + 1,
      at: now,
      kind: event.kind,
      title: event.title,
      toolId: event.toolId ?? null,
      input: event.input === undefined ? null : JSON.stringify(event.input),
      output: event.output ?? null,
      trace: event.trace ?? null,
    }))
  )
  const [session] = await ctx.db.select().from(t.sessions).where(eq(t.sessions.id, id))
  return { session: session!, snapshot }
}

describe("工具参数写成人看得懂的样子", () => {
  it("browser.batch：逐个动作列出来，fill_form 带每个字段的值（截 40 字左右），快照 ref 不给", () => {
    const text = describeToolInput("browser.batch", JSON.stringify({ actions: entry(PRODUCTS[5]) }), 2000)
    expect(text).toContain("1. click「继续录入」 2. fill_form 编号=P-106、名称=防水登山背包 30L、单价（元）=89.00、库存=20、分类=户外用品、备注=")
    expect(text).toContain("3. click「提交」")
    expect(text).not.toContain("e20")
    // 值太长的截断
    expect(text).toContain("新品，请仔细核对规格和包装上的说明文字是否一致".slice(0, 20))
  })

  it("别的浏览器动作：元素、定位、网址、填的值；其它工具照旧截 JSON；存的时候截断了的也照旧截", () => {
    expect(describeToolInput("browser.type", JSON.stringify({ element: "单号输入框", ref: "e3", text: "PSS-001", submit: true }), 300)).toBe("「单号输入框」 填「PSS-001」 submit=true")
    expect(describeToolInput("browser.click", JSON.stringify({ target: "getByRole('button', { name: '查询' })" }), 300)).toBe("定位 getByRole('button', { name: '查询' })")
    expect(describeToolInput("browser.navigate", JSON.stringify({ url: "https://erp.example.com/orders" }), 300)).toBe("https://erp.example.com/orders")
    expect(describeToolInput("browser.select_option", JSON.stringify({ element: "分类", ref: "e9", values: ["户外", "露营"] }), 300)).toBe("「分类」 选「户外、露营」")
    expect(describeToolInput("file.save", JSON.stringify({ path: "a.csv", content: "x".repeat(400) }), 300)).toBe(`${JSON.stringify({ path: "a.csv", content: "x".repeat(400) }).slice(0, 300)}…`)
    expect(describeToolInput("browser.batch", '{"actions":[{"tool":"click","input":{"elem', 300)).toBe('{"actions":[{"tool":"click","input":{"elem')
  })
})

describe("复核看的过程记录", () => {
  it("54 次工具调用：前面的也在（压成一行、带值），最近 30 条详细；批的每一步和汇总认得出来，结果里有逐步的 ✓", async () => {
    const events = longRunEvents()
    expect(events.length).toBeGreaterThan(50)
    const { session, snapshot } = await insertRun(events)
    const { prompt } = await buildReviewPrompt(ctx.db, session, snapshot, "8 个商品都录好了", false)
    expect(prompt).toContain(`整次运行共 ${events.length} 条，其中工具调用 ${events.length} 次；最近 30 条详细，更早的 ${events.length - 30} 条每条压成一行`)
    // 前半段（P-101～P-105）都在
    for (const [code] of PRODUCTS) expect(prompt).toContain(`编号=${code}`)
    expect(prompt).toContain("- #1 browser.navigate ✓ http://shop.test/admin/products/new")
    expect(prompt).toContain("- #3 browser.fill_form ✓ 编号=P-101、名称=折叠露营椅、单价（元）=45.00")
    // 批里的步骤标出来，批那条是汇总、逐个动作带值、结果给逐步的 ✓ / ✗（不要页面快照）
    expect(prompt).toContain("browser.fill_form ✓（第 1 批第 2 步） 编号=P-106")
    const batch = prompt.split("\n").find((line) => line.includes("（browser.batch）"))!
    expect(batch).toMatch(/^- #31 调用 连着做几步（browser\.batch）（第 1 批的汇总：这一批的 9 步上面已逐条记过，不是又做了一遍）：参数 1\. click「继续录入」 2\. fill_form 编号=P-106、名称=防水登山背包 30L、单价（元）=89\.00/)
    expect(batch).toContain("5. fill_form 编号=P-107、名称=便携炉头")
    expect(batch).toContain("8. fill_form 编号=P-108、名称=睡袋 -5℃")
    expect(batch).toContain("→ 结果 1. click「继续录入」 ✓（0.4 秒）")
    expect(batch).toContain("9. click「提交」 ✓（0.4 秒）")
    expect(batch).not.toContain("页面快照")
    // 最近 30 条照原来的详细程度
    expect(prompt).toContain(`- #${events.length} 调用 报结果（run.finish）：参数 {"outcome":"achieved"`)
    // 系统提示（批和固化流程的说明）在 review.ts 的 REVIEW_SYSTEM，这里只看输入
  })

  it("很长的运行：更早的部分有上限，留最早的一段和较近的一段，中间写省略了几条；最近 30 条都在", () => {
    const now = new Date()
    const rows = Array.from({ length: 400 }, (_, index) => ({
      id: index + 1,
      sessionId: "R-x",
      seq: index + 1,
      at: now,
      kind: "tool",
      title: "填表单",
      toolId: "browser.fill_form",
      input: JSON.stringify({ fields: fields([`P-${1000 + index}`, "商品".repeat(30), "1.00"]) }),
      output: "完成".repeat(100),
      detail: null,
      trace: null,
    })) as unknown as (typeof t.sessionEvents.$inferSelect)[]
    const log = reviewLog(rows, { recent: 30, budget: 12_000 })
    const earlier = log.lines.slice(1, log.lines.indexOf("（以下是最近的 30 条，详细）"))
    expect(earlier.join("\n").length).toBeLessThanOrEqual(12_000 + 200)
    const gap = earlier.find((line) => /^……中间 \d+ 条省略……$/.test(line))
    expect(gap).toBeDefined()
    const skipped = Number(/中间 (\d+) 条/.exec(gap!)![1])
    expect(earlier.length - 1 + skipped).toBe(370)
    expect(earlier[0]).toContain("#1 browser.fill_form ✓ 编号=P-1000")
    expect(earlier.at(-1)).toContain("#370 browser.fill_form")
    expect(log.lines.at(-1)).toContain("#400 调用 填表单（browser.fill_form）")
    expect(log).toMatchObject({ total: 400, tools: 400, recent: 30, earlier: 370 })
  })

  it("较早的条数少时每行多给些：读到的电话不被截掉；详细的几条里提交的整段内容给全（基准 B：复核说义乌那家的电话被截断）", () => {
    const now = new Date()
    const detail = "义乌市晨光日用品有限公司 联系人 陈晓 电话 0579-85512301 评分 4.6 所在地 义乌"
    const rows = [
      { kind: "tool", title: "读取列表", toolId: "browser.extract", input: JSON.stringify({ list: "table tr" }), output: `| 字段 | 值 |\n|---|---|\n${"| 说明 | 很长的说明文字 |\n".repeat(3)}| 详情 | ${detail} |` },
      ...Array.from({ length: 40 }, () => ({ kind: "tool", title: "看页面", toolId: "browser.snapshot", input: "{}", output: "好" })),
    ].map((row, index) => ({ id: index + 1, sessionId: "R-y", seq: index + 1, at: now, detail: null, trace: null, ...row })) as unknown as (typeof t.sessionEvents.$inferSelect)[]
    const log = reviewLog(rows, { recent: 30, budget: 12_000 })
    expect(log.earlier).toBe(11)
    expect(log.lines.join("\n")).toContain("0579-85512301 评分 4.6")
    const summary = ["义乌市晨光日用品有限公司,0579-85512301,4.6", "永康市铭泰五金制品厂,0579-87120456,4.8", "深圳市光源照明科技有限公司,0755-26651188,4.4"].join("\n")
    expect(describeToolInput("browser.type", JSON.stringify({ element: "汇总", text: summary }), 600, 300)).toContain("深圳市光源照明科技有限公司,0755-26651188,4.4")
  })

  it("不到 30 条：全部详细，不加「较早的」那一段", async () => {
    const { session, snapshot } = await insertRun(longRunEvents().slice(0, 5))
    const { prompt } = await buildReviewPrompt(ctx.db, session, snapshot, "报告", false)
    expect(prompt).toContain("整次运行共 5 条，其中工具调用 5 次）")
    expect(prompt).not.toContain("较早的记录")
    expect(prompt).toContain("- #3 调用 填表单（browser.fill_form）：参数 编号=P-101、名称=折叠露营椅")
  })
})

describe("固化流程跑的运行", () => {
  const routine = (patch: Partial<SessionRoutineState> = {}): SessionRoutineState => ({
    routineId: "RT-1",
    versionId: "RV-1",
    version: 2,
    mode: "run",
    state: "finished",
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    ms: 41_000,
    steps: 36,
    commits: [{ step: 35, label: "提交询价单", verified: "列表第一行是刚提交的询价单，三家报价都在" }],
    logs: ["义乌那家详情页：单价 3.2 元", "临沂那家详情页：单价 3.5 元"],
    ...patch,
  })
  const routineSnapshot = { id: "RT-1", versionId: "RV-1", version: 2, name: "三家比价后提交询价单", status: "active" as const, code: "", inputSchema: {}, outputSchema: {}, commits: ["提交询价单"] }

  it("多一节「固化流程的记录」：第几版、状态、步数、ha.commit 和 ha.verified、ha.log；脚本做的步骤标「流程第 n 步」，前面的也在", async () => {
    const events: EventInput[] = Array.from({ length: 36 }, (_, index) => ({
      kind: "tool" as const,
      title: "打开网页",
      toolId: "browser.navigate",
      input: { url: index === 2 ? "https://yiwu.example.com/item/88" : `https://shop.example.com/p/${index}` },
      output: "好",
      trace: { routineStep: index + 1 },
    }))
    const { session, snapshot } = await insertRun(events, { routine: routine(), snapshotPatch: { routine: routineSnapshot } })
    const { prompt } = await buildReviewPrompt(ctx.db, session, snapshot, "脚本办成了", false)
    expect(prompt).toContain("## 固化流程的记录\n这次运行先跑了固化流程「三家比价后提交询价单」第 2 版（脚本）。过程记录里标「流程第 n 步」的是脚本做的")
    expect(prompt).toContain("- 状态：脚本跑完了，报了结果（ha.finish）")
    expect(prompt).toContain("- 脚本调了 36 次工具，用了 41 秒")
    expect(prompt).toContain("  - 「提交询价单」（做完流程第 35 步之后），之后核对（ha.verified）：列表第一行是刚提交的询价单，三家报价都在")
    expect(prompt).toContain("  - 义乌那家详情页：单价 3.2 元")
    expect(prompt).not.toContain("- 停在")
    // 第 3 步（义乌那家的详情页）在最近 30 条之外，也看得到
    expect(prompt).toContain("- #3 browser.navigate ✓（流程第 3 步） https://yiwu.example.com/item/88")
    expect(prompt).toContain("- #36 调用 打开网页（browser.navigate）（流程第 36 步）：参数 https://shop.example.com/p/35")
  })

  it("交给 agent 的：写停在哪、为什么；固化试跑（mode = test）和没跑脚本的运行没有这一节", async () => {
    const fell = await insertRun(longRunEvents().slice(0, 3), {
      routine: routine({ state: "fell_back", steps: 7, commits: [], logs: [], stoppedAt: { step: 7, kind: "step_error", tool: "browser.click", label: "click「提交」", reason: "定位找不到" } }),
      snapshotPatch: { routine: routineSnapshot },
    })
    const prompt = (await buildReviewPrompt(ctx.db, fell.session, fell.snapshot, "", false)).prompt
    expect(prompt).toContain("- 状态：脚本没跑通，停下后交给 agent 接着做")
    expect(prompt).toContain("- 提交（ha.commit）：没有")
    expect(prompt).toContain("- 停在流程第 7 步（这一步出错：click「提交」）：定位找不到")

    const test = await insertRun(longRunEvents().slice(0, 3), { routine: routine({ mode: "test" }) })
    expect((await buildReviewPrompt(ctx.db, test.session, test.snapshot, "", false)).prompt).not.toContain("固化流程的记录")
    const plain = await insertRun(longRunEvents().slice(0, 3))
    expect((await buildReviewPrompt(ctx.db, plain.session, plain.snapshot, "", false)).prompt).not.toContain("固化流程的记录")
  })
})

describe("三方验收的证据照旧", () => {
  it("loadEvidence 不带 fullLog：最近 events 条（默认 60），参数和结果各截原样 JSON 300 字", async () => {
    const events = longRunEvents()
    const { session } = await insertRun(events)
    const evidence = await loadEvidence({ db: ctx.db, session }, false)
    expect(evidence.logInfo).toBeUndefined()
    expect(evidence.log.length).toBe(Math.min(60, events.length))
    expect(evidence.log[0]).toBe('- 调用 打开网页（browser.navigate）：参数 {"url":"http://shop.test/admin/products/new"} → 结果 ### Page\n- Page URL: http://shop.test/admin/products/new')
    const batch = evidence.log.find((line) => line.includes("（browser.batch）"))!
    expect(batch).toContain('参数 {"actions":[{"tool":"click"')
    expect(batch.split("→ 结果")[0]!.length).toBeLessThan(360)
    const limited = await loadEvidence({ db: ctx.db, session }, false, { events: 30 })
    expect(limited.log.length).toBe(30)
    expect(limited.log.at(-1)).toContain("- 调用 报结果（run.finish）")
  })
})
