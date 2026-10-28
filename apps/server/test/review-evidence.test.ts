// 复核的证据（docs/dev/run-outcome.md 第 5 节）：过程记录覆盖整次运行（最近 30 条详细、更早的压成一行、有上限、中间省略）；
// 工具参数写成人看得懂的样子（browser.batch 逐个动作带值、批里的步骤和汇总认得出来）；固化流程跑的运行多一节「固化流程的记录」；
// 三方验收的证据（verify.ts 的 loadEvidence、buildVerifyPrompt）和复核一样用 reviewLog；读数据的工具（接口、HTTP 工具、code.run、file.read 等）
// 结果多给字数、合计有上限。真实的测试库，直接在库里写运行和过程记录，不调模型。
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import type { SessionRoutineState, SessionSnapshot } from "@heyagent/shared"
import { eq } from "drizzle-orm"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import * as t from "../src/db/schema.js"
import {
  batchSnapshotText,
  compactSnapshot,
  DATA_OUTPUT_BUDGET,
  DATA_OUTPUT_MAX,
  DATA_OUTPUT_MIN,
  describeCodeRunOutput,
  describeToolInput,
  describeToolOutput,
  EVIDENCE_PROMPT_MAX,
  REVIEW_LOG,
  reviewLog,
  shareBudget,
} from "../src/engine/log-text.js"
import { buildReviewPrompt } from "../src/engine/review.js"
import { configureEngine } from "../src/engine/runtime.js"
import { buildSnapshot } from "../src/engine/sessions.js"
import { buildVerifyPrompt, loadCheckpoints, loadEvidence } from "../src/engine/verify.js"
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
    // 批里的步骤标出来，批那条是汇总、逐个动作带值、结果给逐步的 ✓ / ✗，附压过的页面快照（不要原样的快照）
    expect(prompt).toContain("browser.fill_form ✓（第 1 批第 2 步） 编号=P-106")
    const batch = prompt.split("\n").find((line) => line.includes("（browser.batch）"))!
    expect(batch).toMatch(/^- #31 调用 连着做几步（browser\.batch）（第 1 批的汇总：这一批的 9 步上面已逐条记过，不是又做了一遍）：参数 1\. click「继续录入」 2\. fill_form 编号=P-106、名称=防水登山背包 30L、单价（元）=89\.00/)
    expect(batch).toContain("5. fill_form 编号=P-107、名称=便携炉头")
    expect(batch).toContain("8. fill_form 编号=P-108、名称=睡袋 -5℃")
    expect(batch).toContain("→ 结果 1. click「继续录入」 ✓（0.4 秒）")
    expect(batch).toContain("9. click「提交」 ✓（0.4 秒）")
    expect(batch).toContain("9. click「提交」 ✓（0.4 秒） 最后的页面快照：继续录入")
    expect(batch).not.toContain("页面：商品录入")
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

describe("读数据的工具：结果的 JSON 压成一行、多给字数（基准 E：复核只看到每页第一条）", () => {
  const items = (page: number) => Array.from({ length: 8 }, (_, i) => ({ code: `E-${page}${i}`, name: `商品${page}-${i}`, spec: i % 2 ? "加大款" : "标准款", price: 10 + i, supplier: `供应商${i}` }))
  const fetchOutput = (page: number) =>
    [`GET https://shop.test/e/api/items?page=${page}&size=8 → 200 application/json（1.2 KB，35 毫秒）`, "", JSON.stringify({ page, total: 40, items: items(page) }, null, 2)].join("\n")
  const rowsOf = (sessionId: string, list: { kind: string; title: string; toolId: string; input: string; output: string }[]) =>
    list.map((row, index) => ({ id: index + 1, sessionId, seq: index + 1, at: new Date(), detail: null, trace: null, ...row })) as unknown as (typeof t.sessionEvents.$inferSelect)[]

  it("排好版的 JSON 压成一行再截：300 字里能看到好几条，不只第一条", () => {
    const text = describeToolOutput("browser.fetch", fetchOutput(1), 300)
    expect(text).toContain("GET https://shop.test/e/api/items?page=1&size=8 → 200")
    expect(text).toContain('{"page": 1,"total": 40,"items": [{"code": "E-10"')
    expect(text).toContain('"code": "E-11"')
    // 不是 JSON 的结果照旧
    expect(describeToolOutput("browser.snapshot", "第一行\n  第二行", 300)).toBe("第一行 ⏎ 第二行")
  })

  it("详细的几条里 browser.fetch 的结果多给：5 页每页 8 条都看得到；很多次时每条少给，合计有上限", () => {
    const rows = rowsOf("R-z", [
      { kind: "tool", title: "打开网页", toolId: "browser.navigate", input: JSON.stringify({ url: "https://shop.test/e/list" }), output: "好" },
      ...[1, 2, 3, 4, 5].map((page) => ({ kind: "tool", title: "调网站接口", toolId: "browser.fetch", input: JSON.stringify({ url: `https://shop.test/e/api/items?page=${page}&size=8` }), output: fetchOutput(page) })),
      { kind: "tool", title: "报结果", toolId: "run.finish", input: JSON.stringify({ outcome: "achieved" }), output: "好" },
    ])
    const text = reviewLog(rows, { recent: 30, budget: 12_000 }).lines.join("\n")
    for (const page of [1, 2, 3, 4, 5]) for (const item of items(page)) expect(text).toContain(`"code": "${item.code}"`)

    const many = rowsOf(
      "R-w",
      Array.from({ length: 30 }, (_, index) => ({ kind: "tool", title: "调网站接口", toolId: "browser.fetch", input: "{}", output: fetchOutput(index) }))
    )
    const results = reviewLog(many, { recent: 30, budget: 12_000 }).lines.map((line) => line.slice(line.indexOf("→ 结果 ") + 5))
    // 30 条都要得多：平分，每条 400 字（不比原来的 300 字少），合计不超过份额
    expect(DATA_OUTPUT_BUDGET / 30).toBe(400)
    expect(Math.max(...results.map((line) => line.length))).toBeLessThanOrEqual(402)
    expect(results.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(DATA_OUTPUT_BUDGET + 30 * 2)
  })

  it("份额按需分：短的拿多少用多少，省下的给长的；每条不少于 300、不多于 4000", () => {
    const caps = shareBudget([100, 100, 100, 20_000], 12_000, DATA_OUTPUT_MIN, DATA_OUTPUT_MAX)
    expect(caps[3]).toBe(4000)
    expect(caps.slice(0, 3).every((cap) => cap >= 100)).toBe(true)
    expect(shareBudget([5000, 5000, 5000, 5000], 12_000, 300, 4000)).toEqual([3000, 3000, 3000, 3000])
    expect(shareBudget([500, 9000, 9000], 12_000, 300, 4000)).toEqual([4000, 4000, 4000])
    // 省下的给长的：平分是每条 2400，短的只用 500，其余四条各 2875
    expect(shareBudget([500, 9000, 9000, 9000, 9000], 12_000, 300, 4000)).toEqual([2400, 2875, 2875, 2875, 2875])
    expect(shareBudget([], 12_000, 300, 4000)).toEqual([])
    // 条数 × 300 超过份额：每条照样 300
    expect(shareBudget(new Array(50).fill(1000), 12_000, 300, 4000).every((cap) => cap === 300)).toBe(true)
  })
})

describe("批里的页面快照：值只在批的快照里读到（sub-agents.md 21.6.5 第 4 条：复核看不到，把对的运行判成没办成）", () => {
  const SUPPLIERS = [
    ["S-1", "甲地第一日用品厂", "李一", "0571-80000001", "4.6"],
    ["S-2", "乙地第二五金厂", "李二", "0571-80000002", "4.8"],
    ["S-3", "丙地第三照明厂", "李三", "0571-80000003", "4.4"],
    ["S-4", "丁地第四纺织厂", "李四", "0571-80000004", "4.1"],
    ["S-5", "戊地第五包装厂", "李五", "0571-80000005", "4.9"],
    ["S-6", "己地第六玩具厂", "李六", "0571-80000006", "4.3"],
  ] as const
  /** gateway.ts 的批输出：逐步 ✓、页面概况、「页面快照：」+ Playwright MCP 的快照原文 */
  const batchOutput = (steps: string[], title: string, url: string, tree: string[]) =>
    [
      ...steps.map((step, index) => `${index + 1}. ${step} ✓（0.3 秒）`),
      "",
      `现在的页面：「${title}」 ${url}`,
      "",
      "页面快照：",
      "### Page",
      `- Page URL: ${url}`,
      `- Page Title: ${title}`,
      "### Snapshot",
      "```yaml",
      ...tree,
      "```",
    ].join("\n")
  const detailTree = ([, name, contact, phone, score]: readonly string[]) => [
    "- generic [active] [ref=f4e1]:",
    `  - heading "${name}" [level=1] [ref=f4e2]`,
    "  - table [ref=f4e3]:",
    "    - rowgroup [ref=f4e4]:",
    ...[["联系人", contact], ["电话", phone], ["评分", score]].flatMap(([key, value], index) => [
      `      - row [ref=f4e${10 + index * 3}]:`,
      `        - rowheader "${key}" [ref=f4e${11 + index * 3}]`,
      `        - cell "${value}" [ref=f4e${12 + index * 3}]`,
    ]),
    "  - paragraph [ref=f4e30]:",
    '    - link "返回搜索" [ref=f4e31] [cursor=pointer]:',
    "      - /url: /b/search",
  ]

  /** 6 家各一次「搜索」批、一次「点进详情」批（批里每一步网关也单独记了一条，只有页面标题），中间又看了很多次别的；最后 type 填汇总、提交 */
  function supplierRun(): EventInput[] {
    const events: EventInput[] = [{ kind: "tool", title: "打开网页", toolId: "browser.navigate", input: { url: "http://site.test/b/search" }, output: "现在的页面：「供应商搜索」" }]
    for (const supplier of SUPPLIERS) {
      const [id, name] = supplier
      const search = [
        { tool: "type", input: { element: "搜索框", target: "role=textbox", text: name } },
        { tool: "click", input: { element: "搜索按钮", target: "role=button[name=\"搜索\"]" } },
      ]
      events.push({ kind: "tool", title: "输入文字", toolId: "browser.type", input: search[0]!.input, output: "（没有返回内容）" })
      events.push({ kind: "tool", title: "点击", toolId: "browser.click", input: search[1]!.input, output: "现在的页面：「供应商搜索」" })
      events.push({
        kind: "tool",
        title: "连着做几步",
        toolId: "browser.batch",
        input: { actions: search },
        output: batchOutput(["type「搜索框」", "click「搜索按钮」"], "供应商搜索", "http://site.test/b/search", [
          "- generic [active] [ref=f1e1]:",
          '  - textbox "搜索供应商" [ref=f1e4]: ' + name,
          "  - list [ref=f1e7]:",
          "    - listitem [ref=f1e8]:",
          `      - link "${name}" [ref=f1e9] [cursor=pointer]:`,
          `        - /url: /b/s/${id}`,
        ]),
      })
      const open = [{ tool: "click", input: { element: name, target: `text=${name}` } }]
      events.push({ kind: "tool", title: "点击", toolId: "browser.click", input: open[0]!.input, output: `现在的页面：「${name}」` })
      events.push({ kind: "tool", title: "连着做几步", toolId: "browser.batch", input: { actions: open }, output: batchOutput([`click「${name}」`], name, `http://site.test/b/s/${id}`, detailTree(supplier)) })
      for (let i = 0; i < 3; i++) events.push({ kind: "tool", title: "看日志", toolId: "file.list", input: {}, output: "没有文件" })
    }
    const summary = SUPPLIERS.map(([, name, , phone, score]) => `${name},${phone},${score}`).join("\n")
    events.push({ kind: "tool", title: "输入文字", toolId: "browser.type", input: { element: "汇总", text: summary }, output: "（没有返回内容）" })
    events.push({ kind: "tool", title: "点击", toolId: "browser.click", input: { element: "提交" }, output: "现在的页面：「已提交」" })
    events.push({ kind: "tool", title: "报结果", toolId: "run.finish", input: { outcome: "achieved", summary: "6 家都查到并提交了" }, output: "好" })
    return events
  }

  it("快照压成文字行：去掉 ### Page、代码块、ref；表格一行连成「电话 | 0571-…」；输入框写「名字=值」", () => {
    const output = batchOutput(["click「乙地第二五金厂」"], "乙地第二五金厂", "http://site.test/b/s/S-2", detailTree(SUPPLIERS[1]))
    expect(batchSnapshotText(output)).toBe("乙地第二五金厂 ⏎ 联系人 | 李二 ⏎ 电话 | 0571-80000002 ⏎ 评分 | 4.8 ⏎ 返回搜索")
    expect(describeToolOutput("browser.batch", output, 300, 2000)).toBe("1. click「乙地第二五金厂」 ✓（0.3 秒） 最后的页面快照：乙地第二五金厂 ⏎ 联系人 | 李二 ⏎ 电话 | 0571-80000002 ⏎ 评分 | 4.8 ⏎ 返回搜索")
    expect(compactSnapshot('- generic [ref=e1]:\n  - textbox "数量" [ref=e2]: "12"\n  - checkbox "加急" [checked] [ref=e3]\n  - text: 合计 36 元')).toBe("数量=12 ⏎ 加急=[checked] ⏎ 合计 36 元")
    // 没带快照（snapshot: false、挂起了）的批照旧只有逐步的 ✓
    expect(describeToolOutput("browser.batch", "1. click「提交」 ✓（0.3 秒）\n\n现在的页面：「已提交」", 300, 2000)).toBe("1. click「提交」 ✓（0.3 秒）")
    // browser.snapshot 一样压
    expect(describeToolOutput("browser.snapshot", ["### Page", "- Page URL: http://site.test/", "### Snapshot", "```yaml", ...detailTree(SUPPLIERS[2]), "```"].join("\n"), 2000)).toContain("电话 | 0571-80000003 ⏎ 评分 | 4.4")
  })

  it("一次运行的电话、评分只在批的快照里读到：复核材料里 6 家的值都看得到（较早的压成一行的也在）", async () => {
    const events = supplierRun()
    expect(events.length).toBeGreaterThan(40)
    const { session, snapshot } = await insertRun(events)
    const { prompt } = await buildReviewPrompt(ctx.db, session, snapshot, "6 家都查到并提交了", false)
    expect(prompt).toContain("较早的记录")
    for (const [, name, contact, phone, score] of SUPPLIERS) {
      expect(prompt).toContain(`${name} ⏎ 联系人 | ${contact} ⏎ 电话 | ${phone} ⏎ 评分 | ${score}`)
    }
    // 第一家在较早的那一段（压成一行）
    const first = prompt.split("\n").find((line) => line.includes("电话 | 0571-80000001"))!
    expect(first).toMatch(/^- #\d+ browser\.batch ✓/)
    expect(prompt).not.toContain("[ref=")
    expect(prompt).not.toContain("```yaml")
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

describe("三方验收和复核看同样的过程记录：读数据的工具（HTTP 工具、code.run、file.read）结果看得到", () => {
  /** 一个 HTTP 工具（任务配置的，id 是主管起的）：返回 12 张订单，要的那张在后面 */
  const HTTP_TOOL = { id: "erp.orders", name: "查订单", summary: "查订单", description: "查订单", source: "http", risk: "read" }
  const orders = Array.from({ length: 12 }, (_, i) => ({
    orderNo: `SO-2026-${String(i + 1).padStart(4, "0")}`,
    buyer: `买家${i + 1}`,
    status: i === 10 ? "已发货" : "待付款",
    amount: (i + 1) * 101.5,
    tracking: i === 10 ? "YT-88442211" : null,
  }))
  const httpOutput = `HTTP 200\n${JSON.stringify({ total: 12, orders }, null, 2)}`
  /** code.run：stdout 前面是一大段过程，最后一行是算出来的合计 */
  const codeOutput = [
    "退出码 0 · 用时 1.2 秒",
    "写回空间：新建 result.csv",
    "--- stdout ---",
    ...Array.from({ length: 40 }, (_, i) => `处理第 ${i + 1} 行：单价 ${(i + 1) * 3.5} 元 × 数量 ${i + 2}`),
    "合计金额：87654.32 元，共 40 行",
    "--- stderr ---",
    "DeprecationWarning: 某个包要升级",
  ].join("\n")
  /** file.read：附件里的说明，要的值在第 600 字以后 */
  const fileOutput = `供货说明.txt（共 1400 字，从第 0 字开始）：\n${"这一段是说明文字，没有要核对的数据。".repeat(40)}\n结算账号：6222-0000-1111-2222，联系人周敏`

  function dataRun(): EventInput[] {
    return [
      { kind: "tool", title: "读附件", toolId: "file.read", input: { path: "attachments/供货说明.txt" }, output: fileOutput },
      { kind: "tool", title: "查订单", toolId: "erp.orders", input: { buyer: "买家11" }, output: httpOutput },
      { kind: "tool", title: "运行代码", toolId: "code.run", input: { language: "python", file: "scripts/sum.py" }, output: codeOutput },
      ...Array.from({ length: 6 }, () => ({ kind: "tool" as const, title: "列出文件", toolId: "file.list", input: {}, output: "result.csv" })),
      { kind: "tool", title: "报结果", toolId: "run.finish", input: { outcome: "achieved", summary: "都查到了" }, output: "好" },
    ]
  }
  const KEYS = ["YT-88442211", "SO-2026-0011", "合计金额：87654.32 元", "6222-0000-1111-2222"]
  const withHttpTool = { snapshotPatch: { tools: [HTTP_TOOL] as unknown as SessionSnapshot["tools"] } }

  it("要核对的值都在 300 字以外（以前三方验收每条结果截到 300 字，看不到）", () => {
    for (const [output, key] of [
      [httpOutput, "YT-88442211"],
      [codeOutput, "87654.32"],
      [fileOutput, "6222-0000-1111-2222"],
    ] as const)
      expect(output.indexOf(key)).toBeGreaterThan(300)
  })

  it("code.run：给退出码、写回的文件和 stdout（太长的留开头和结尾），stderr 另起", () => {
    const text = describeCodeRunOutput(codeOutput, 600)
    expect(text).toMatch(/^退出码 0 · 用时 1\.2 秒 ⏎ 写回空间：新建 result\.csv stdout：处理第 1 行/)
    expect(text).toContain("合计金额：87654.32 元，共 40 行")
    expect(text).toContain("…（中间省略")
    expect(text).toContain("stderr：DeprecationWarning")
    expect(text.length).toBeLessThan(650)
    // 沙箱没起来这种只有一行的
    expect(describeToolOutput("code.run", "沙箱没起来：没有 bwrap", 300)).toBe("沙箱没起来：没有 bwrap")
    // stdout 是排好版的 JSON：压成一行
    expect(describeCodeRunOutput(`退出码 0 · 用时 0.1 秒\n--- stdout ---\n${JSON.stringify({ a: 1, b: [1, 2] }, null, 2)}`, 600)).toBe('退出码 0 · 用时 0.1 秒 stdout：{"a": 1,"b": [1,2]}')
  })

  it("复核的输入、三方验收的输入里都看得到 HTTP 工具、code.run、file.read 读到的值", async () => {
    const { session, snapshot } = await insertRun(dataRun(), withHttpTool)
    const review = (await buildReviewPrompt(ctx.db, session, snapshot, "都查到了", false)).prompt
    for (const key of KEYS) expect(review).toContain(key)
    // HTTP 工具的 JSON 压成一行
    expect(review).toContain('"orderNo": "SO-2026-0011","buyer": "买家11","status": "已发货"')

    const evidence = await loadEvidence({ db: ctx.db, session }, false)
    const verify = buildVerifyPrompt({
      ctx: { snapshot },
      checkpoints: await loadCheckpoints({ db: ctx.db, session }),
      finalText: "都查到了",
      notes: [],
      artifacts: evidence.artifacts,
      log: evidence.log,
      logInfo: evidence.logInfo,
      imageNames: [],
    })
    for (const key of KEYS) expect(verify).toContain(key)
    expect(verify).toContain("整次运行共 10 条，其中工具调用 10 次）")
    expect(verify).toContain('- #2 调用 查订单（erp.orders）：参数 {"buyer":"买家11"} → 结果 HTTP 200 ⏎ {"total": 12')
  })

  it("HTTP 工具要从快照里认：不知道它是 HTTP 工具时照旧只给 300 字", () => {
    const rows = [{ kind: "tool", title: "查订单", toolId: "erp.orders", input: "{}", output: httpOutput }].map((row, index) => ({
      id: index + 1,
      sessionId: "R-h",
      seq: index + 1,
      at: new Date(),
      detail: null,
      trace: null,
      ...row,
    })) as unknown as (typeof t.sessionEvents.$inferSelect)[]
    expect(reviewLog(rows, REVIEW_LOG).lines.join("\n")).not.toContain("YT-88442211")
    expect(reviewLog(rows, { ...REVIEW_LOG, dataTools: new Set(["erp.orders"]) }).lines.join("\n")).toContain("YT-88442211")
  })

  it("很长的运行：读数据的结果合计不超过份额，较早的不超过 1.2 万字，复核和三方验收的输入都在上限里", async () => {
    const big = (n: number) =>
      `HTTP 200\n${JSON.stringify({ page: n, rows: Array.from({ length: 80 }, (_, i) => ({ id: `${n}-${i}`, name: `记录${n}-${i}`, note: "说明".repeat(10) })) }, null, 2)}`
    const hugeCode = ["退出码 0 · 用时 3 秒", "--- stdout ---", ...Array.from({ length: 2000 }, (_, i) => `第 ${i} 行输出`), "--- stderr ---", "警告".repeat(500)].join("\n")
    const events: EventInput[] = []
    for (let i = 0; i < 60; i++) {
      events.push({ kind: "tool", title: "查订单", toolId: "erp.orders", input: { page: i }, output: big(i) })
      events.push({ kind: "tool", title: "运行代码", toolId: "code.run", input: { language: "python", code: "print(1)\n".repeat(200) }, output: hugeCode })
      events.push({ kind: "tool", title: "读附件", toolId: "file.read", input: { path: `a${i}.txt` }, output: `a${i}.txt（共 10000 字）：\n${"内容".repeat(5000)}` })
      events.push({ kind: "tool", title: "调网站接口", toolId: "browser.fetch", input: { url: `https://shop.test/api?p=${i}` }, output: big(i) })
    }
    const { session, snapshot } = await insertRun(events, withHttpTool)
    const evidence = await loadEvidence({ db: ctx.db, session }, false)
    expect(evidence.logInfo).toMatchObject({ total: 240, tools: 240, recent: 30, earlier: 210 })
    const lines = evidence.log
    const split = lines.indexOf("（以下是最近的 30 条，详细）")
    expect(lines.slice(1, split).join("\n").length).toBeLessThanOrEqual(REVIEW_LOG.budget + 200)
    const results = lines.slice(split + 1).map((line) => line.slice(line.indexOf("→ 结果 ") + 5))
    expect(results).toHaveLength(30)
    // 30 条全是读数据的：每条 400 字左右（不少于 300），合计不超过份额（code.run 的省略标记多几个字）
    for (const line of results) expect(line.length).toBeGreaterThanOrEqual(DATA_OUTPUT_MIN)
    expect(results.reduce((sum, line) => sum + line.length, 0)).toBeLessThanOrEqual(DATA_OUTPUT_BUDGET + 30 * 30)
    // 整段过程记录：较早的 1.2 万 + 最近 30 条（参数最多 600 字）+ 读数据的份额
    expect(lines.join("\n").length).toBeLessThanOrEqual(REVIEW_LOG.budget + DATA_OUTPUT_BUDGET + 30 * 30 + 30 * 700)

    const review = (await buildReviewPrompt(ctx.db, session, snapshot, "都做完了", false)).prompt
    expect(review.length).toBeLessThanOrEqual(EVIDENCE_PROMPT_MAX + 20)
    const verify = buildVerifyPrompt({ ctx: { snapshot }, checkpoints: [], finalText: "都做完了", notes: [], artifacts: evidence.artifacts, log: evidence.log, logInfo: evidence.logInfo, imageNames: [] })
    expect(verify.length).toBeLessThanOrEqual(EVIDENCE_PROMPT_MAX + 20)
    // 以前的三方验收只有最近 60 条；现在整次运行都覆盖到（第 1 条压成一行也在）
    expect(verify).toContain("- #1 erp.orders ✓")
    expect(verify).toContain("- #240 调用 调网站接口（browser.fetch）")
  })
})
