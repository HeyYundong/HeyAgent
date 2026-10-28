// 流程库的约定（docs/dev/routine-library.md）：工具参数怎么从 inputSchema 转、模型给的参数怎么转回脚本的输入、
// 两版之间的不兼容改动、要的工具、跑不通的计数、短名。
import { describe, expect, it } from "vitest"

import {
  compareRoutineSchemas,
  defaultLibrarySummary,
  defaultRoutineSlug,
  inputOfToolArgs,
  libraryStreakChange,
  mergeRoutineRequires,
  missingRoutineRequires,
  routineObjectSchema,
  routineRequiresAdded,
  routineSlugOfToolId,
  routineSlugSchema,
  routineToolId,
  schemaPropertyNames,
  toolSchemaOf,
  withDeclaredDescriptions,
  withPropertyOrder,
} from "../src/index.js"

describe("toolSchemaOf：inputSchema → 给模型的工具参数", () => {
  it("英文参数原样，中文参数换成 p<n>、说明里写原来的名字，必填照旧", () => {
    const { jsonSchema, params } = toolSchemaOf({
      type: "object",
      properties: {
        orderNo: { type: "string", description: "单号" },
        关键词: { type: "string", description: "要查的词" },
        limit: { type: "integer" },
      },
      required: ["orderNo", "关键词"],
    })
    expect(params).toEqual([
      { key: "orderNo", name: "orderNo", required: true },
      { key: "p2", name: "关键词", required: true },
      { key: "limit", name: "limit", required: false },
    ])
    expect(jsonSchema).toEqual({
      type: "object",
      properties: {
        orderNo: { type: "string", description: "单号" },
        p2: { type: "string", description: "参数名：关键词。要查的词" },
        limit: { type: "integer" },
      },
      required: ["orderNo", "p2"],
      additionalProperties: false,
    })
  })

  it("$attachments → attachments（文件 id 数组），$note → note，必填照 inputSchema", () => {
    const { jsonSchema, params } = toolSchemaOf({
      type: "object",
      properties: {
        $attachments: { type: "array", description: "要核对的表格" },
        $note: { type: "string" },
      },
      required: ["$attachments"],
    })
    expect(params).toEqual([
      { key: "attachments", name: "$attachments", required: true },
      { key: "note", name: "$note", required: false },
    ])
    const properties = jsonSchema.properties as Record<string, Record<string, unknown>>
    expect(properties.attachments).toMatchObject({ type: "array", items: { type: "string" } })
    expect(String(properties.attachments!.description)).toContain("要核对的表格")
    expect(properties.note).toMatchObject({ type: "string" })
    expect(jsonSchema.required).toEqual(["attachments"])
  })

  it("换的名字和已有的参数撞了就往后加 _2", () => {
    const { params } = toolSchemaOf({
      properties: { attachments: { type: "string" }, $attachments: { type: "array" }, p3: { type: "string" }, 名字: { type: "string" } },
    })
    expect(params.map((param) => param.key)).toEqual(["attachments", "attachments_2", "p3", "p4"])
    const again = toolSchemaOf({ properties: { p2: { type: "string" }, 名字: { type: "string" } } })
    expect(again.params.map((param) => param.key)).toEqual(["p2", "p2_2"])
  })

  it("没声明输入（空串、{}、没写 type）是空对象；有 properties 没写 type 也当对象", () => {
    for (const schema of ["", {}, null, undefined, { type: "object" }]) {
      const { jsonSchema, params } = toolSchemaOf(schema)
      expect(params).toEqual([])
      expect(jsonSchema).toEqual({ type: "object", properties: {}, required: [], additionalProperties: false })
    }
    expect(toolSchemaOf({ properties: { q: { type: "string" } } }).params).toEqual([{ key: "q", name: "q", required: false }])
  })

  it("去掉属性里的 $schema；required 里不存在的名字不认", () => {
    expect(routineObjectSchema({ properties: { a: { type: "string" } }, required: ["a", "b", "a"] }).required).toEqual(["a"])
    const { jsonSchema } = toolSchemaOf({ properties: { a: { $schema: "x", type: "string" } } })
    expect((jsonSchema.properties as Record<string, unknown>).a).toEqual({ type: "string" })
  })
})

describe("属性顺序（x-order）", () => {
  // jsonb 存进去以后的样子：键按长短重排了，作者写的是「工厂链接、商品名称、数量」
  const stored = {
    type: "object",
    properties: { 数量: { type: "integer" }, 工厂链接: { type: "string" }, 商品名称: { type: "string" } },
    required: ["工厂链接"],
    "x-order": ["工厂链接", "商品名称", "数量"],
  }

  it("withPropertyOrder 记下现在的顺序；已有的照它、补上漏的、去掉不存在的；没有属性的不加", () => {
    const schema = withPropertyOrder({ type: "object", properties: { 工厂链接: {}, 商品名称: {}, 数量: {} } })
    expect(schema["x-order"]).toEqual(["工厂链接", "商品名称", "数量"])
    expect(withPropertyOrder({ properties: { a: {}, b: {}, c: {} }, "x-order": ["c", "x", "a"] })["x-order"]).toEqual(["c", "a", "b"])
    expect(withPropertyOrder({ type: "object", "x-order": ["a"] })).toEqual({ type: "object" })
  })

  it("p1、p2 和 routineObjectSchema 的 names 按 x-order 排；没有 x-order 的老数据照对象里的顺序", () => {
    expect(toolSchemaOf(stored).params.map((param) => [param.key, param.name])).toEqual([
      ["p1", "工厂链接"],
      ["p2", "商品名称"],
      ["p3", "数量"],
    ])
    expect(routineObjectSchema(stored).names).toEqual(["工厂链接", "商品名称", "数量"])
    const { "x-order": _order, ...old } = stored
    expect(schemaPropertyNames(old)).toEqual(["数量", "工厂链接", "商品名称"])
    expect(toolSchemaOf(old).params[0]).toEqual({ key: "p1", name: "数量", required: false })
  })

  it("inputOfToolArgs 按排好的参数名转回去", () => {
    const { params } = toolSchemaOf(stored)
    expect(inputOfToolArgs({ p1: "https://a", p2: "篮子", p3: 3 }, params, [])).toEqual({ ok: true, input: { 工厂链接: "https://a", 商品名称: "篮子", 数量: 3 } })
  })
})

describe("inputOfToolArgs：模型给的参数 → ha.input", () => {
  const { params } = toolSchemaOf({
    properties: { 单号: { type: "string" }, $attachments: { type: "array" }, $note: { type: "string" }, extra: { type: "string" } },
  })
  const files = [
    { id: "F-1", name: "a.xlsx", mime: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
    { id: "F-2", name: "b.png", mime: "image/png" },
  ]

  it("换回 inputSchema 的名字，文件 id 展开成 { id, name, mime }，null 和多余的参数不放", () => {
    const result = inputOfToolArgs({ p1: "A-100", attachments: ["F-2", { id: "F-1" }], note: "看一下", extra: null, unknown: 1 }, params, files)
    expect(result).toEqual({
      ok: true,
      input: {
        单号: "A-100",
        $attachments: [
          { id: "F-2", name: "b.png", mime: "image/png" },
          { id: "F-1", name: "a.xlsx", mime: files[0]!.mime },
        ],
        $note: "看一下",
      },
    })
  })

  it("文件不是调用方能读的 → 出错", () => {
    const result = inputOfToolArgs({ attachments: ["F-9"] }, params, files)
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error).toContain("F-9")
    expect(inputOfToolArgs({ attachments: [""] }, params, files).ok).toBe(false)
  })

  it("没声明输入的流程：什么都不放", () => {
    expect(inputOfToolArgs({ anything: 1 }, toolSchemaOf({}).params, files)).toEqual({ ok: true, input: {} })
  })
})

describe("compareRoutineSchemas：两版之间的不兼容改动", () => {
  const before = {
    inputSchema: {
      type: "object",
      properties: { no: { type: "string" }, page: { type: "integer" }, mode: { type: "string" }, old: { type: "string" } },
      required: ["no"],
    },
    outputSchema: { type: "object", properties: { status: { type: "string" }, count: { type: "number" }, gone: { type: "string" } } },
  }

  it("加可选的参数、放宽类型、多交回字段都不算", () => {
    const after = {
      inputSchema: {
        type: "object",
        properties: { no: { type: ["string", "number"] }, page: { type: "number" }, mode: { type: "string" }, old: {}, extra: { type: "string" } },
        required: ["no"],
      },
      outputSchema: { type: "object", properties: { status: { type: "string" }, count: { type: "integer" }, gone: { type: "string" }, more: { type: "string" } } },
    }
    expect(compareRoutineSchemas(before, after)).toEqual([])
  })

  it("新加必填、可选变必填、去掉参数、类型收紧、少交回、交回类型变了都列出来", () => {
    const after = {
      inputSchema: {
        type: "object",
        properties: { no: { type: "number" }, page: { type: "integer" }, mode: { type: "string" }, region: { type: "string" } },
        required: ["no", "mode", "region"],
      },
      outputSchema: { type: "object", properties: { status: { type: "number" }, count: { type: "number" } } },
    }
    const issues = compareRoutineSchemas(before, after)
    expect(issues.map((issue) => [issue.kind, issue.field])).toEqual([
      ["input_type_changed", "no"],
      ["input_now_required", "mode"],
      ["input_added_required", "region"],
      ["input_removed", "old"],
      ["output_type_changed", "status"],
      ["output_removed", "gone"],
    ])
    expect(issues.every((issue) => issue.text.length > 0)).toBe(true)
  })

  it("原来没写类型、现在写了类型的参数算收紧", () => {
    const issues = compareRoutineSchemas(
      { inputSchema: { properties: { q: {} } }, outputSchema: {} },
      { inputSchema: { properties: { q: { type: "string" } } }, outputSchema: {} }
    )
    expect(issues.map((issue) => issue.kind)).toEqual(["input_type_changed"])
  })
})

describe("要的工具", () => {
  it("合并取并集，开关有一个要就要", () => {
    expect(
      mergeRoutineRequires(
        { toolIds: ["browser"], browser: { fetch: true }, routines: ["a"] },
        { toolIds: ["browser", "http.x"], browser: { vision: true }, routines: ["b", "a"] }
      )
    ).toEqual({ toolIds: ["browser", "http.x"], browser: { fetch: true, vision: true }, routines: ["a", "b"] })
  })

  it("任务缺什么：没选的工具、没打开的开关", () => {
    const requires = { toolIds: ["browser", "http.x"], browser: { fetch: true, vision: true }, routines: [] }
    expect(missingRoutineRequires(requires, { toolIds: ["browser"], allowBrowserFetch: false, allowBrowserVision: true })).toEqual({
      toolIds: ["http.x"],
      browser: ["fetch"],
    })
    expect(missingRoutineRequires(requires, { toolIds: ["http.x", "browser"], allowBrowserFetch: true, allowBrowserVision: true })).toEqual({
      toolIds: [],
      browser: [],
    })
  })

  it("新版多要的：工具、开关、调的库流程", () => {
    const issues = routineRequiresAdded(
      { toolIds: ["browser"], browser: {}, routines: [] },
      { toolIds: ["browser", "http.x"], browser: { fetch: true }, routines: ["login_view"] }
    )
    expect(issues.map((issue) => [issue.kind, issue.field])).toEqual([
      ["requires_added", "http.x"],
      ["requires_added", "fetch"],
      ["requires_added", "login_view"],
    ])
  })
})

describe("跑不通的计数（6.6）", () => {
  it("报了结果清零；页面、脚本的毛病 +1；调用方的配置、输入不动", () => {
    expect(libraryStreakChange("achieved")).toBe("reset")
    expect(libraryStreakChange("not_achieved")).toBe("reset")
    for (const kind of ["step_error", "page", "script_error", "timeout", "limit"] as const) expect(libraryStreakChange("stopped", kind)).toBe("fail")
    for (const kind of ["denied", "approval", "suspend", "cancelled", "input", "bad_input"] as const) expect(libraryStreakChange("stopped", kind)).toBe("keep")
    expect(libraryStreakChange("bad_input", "input")).toBe("keep")
    expect(libraryStreakChange("stopped")).toBe("keep")
  })
})

describe("短名、工具 id", () => {
  it("工具 id 和短名互转，不是库流程的返回 undefined", () => {
    expect(routineToolId("order_status")).toBe("routine.order_status")
    expect(routineSlugOfToolId("routine.order_status")).toBe("order_status")
    expect(routineSlugOfToolId("browser.click")).toBeUndefined()
    expect(routineSlugOfToolId("routine.Bad-Name")).toBeUndefined()
  })

  it("默认短名：名字里的英文转小写加下划线，转不出来用 rt<n>", () => {
    expect(defaultRoutineSlug("Order Status 查询", "RT-12")).toBe("order_status")
    expect(defaultRoutineSlug("查订单状态", "RT-12")).toBe("rt12")
    expect(defaultRoutineSlug("2026 report!", "RT-3")).toBe("report")
    expect(routineSlugSchema.safeParse(defaultRoutineSlug("x", "RT-7")).success).toBe(true)
  })

  it("短名的格式", () => {
    for (const ok of ["ab", "order_status", "rt12", "a1_b2"]) expect(routineSlugSchema.safeParse(ok).success).toBe(true)
    for (const bad of ["a", "1abc", "Order", "order-status", "订单", "_ab", "a".repeat(41)]) expect(routineSlugSchema.safeParse(bad).success).toBe(false)
  })
})

describe("发布时的默认值、说明（4.2）", () => {
  it("「什么时候用」默认是流程的名字，没有就用来源任务的标题", () => {
    expect(defaultLibrarySummary({ name: " 查一条记录的状态 ", taskTitle: "查记录" })).toBe("查一条记录的状态")
    expect(defaultLibrarySummary({ name: "", taskTitle: "查记录" })).toBe("查记录")
    expect(defaultLibrarySummary({ name: null })).toBe("")
  })

  it("被派任务声明的参数、结果的说明补进 schema：只补没写说明的，声明里没有、说明是空的不动", () => {
    const schema = {
      type: "object",
      properties: { 编号: { type: "string" }, 备注: { type: "string", description: "自己写的" }, 页数: { type: "integer" } },
      required: ["编号"],
    }
    const filled = withDeclaredDescriptions(schema, [
      { name: "编号", description: "要查的记录编号" },
      { name: "备注", description: "声明里的" },
      { name: "页数", description: "  " },
      { name: "没有的", description: "不在 schema 里" },
    ])
    expect(filled).toEqual({
      type: "object",
      properties: { 编号: { type: "string", description: "要查的记录编号" }, 备注: { type: "string", description: "自己写的" }, 页数: { type: "integer" } },
      required: ["编号"],
    })
    // 原对象不改；什么都没补时原样返回
    expect(schema.properties.编号).toEqual({ type: "string" })
    expect(withDeclaredDescriptions(schema, [{ name: "页数", description: "" }])).toBe(schema)
    expect(withDeclaredDescriptions({}, [{ name: "编号", description: "x" }])).toEqual({})
    // 补过的说明进给模型的参数
    expect(JSON.stringify(toolSchemaOf(filled).jsonSchema)).toContain("要查的记录编号")
  })
})
