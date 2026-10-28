// 固化流程的程序检查（docs/dev/solidify.md 5.5、15.3 第 4 条）：固化员交出来的脚本在试跑、交给人之前先过一遍。
// 只是第一道关，挡住明显不对的写法，让固化员早点改：真正的边界是沙箱（不能上网、碰不到库和密钥）和工具网关（每一步过规则、白名单）。
// 所以这里宁可严一点：只许 import ha from "heyagent"，不许 eval / Function / require / 动态 import / process / globalThis，
// 用到的工具都要在这个任务里（ha.judge 不是工具，用这次运行的执行模型，18.2），两个 JSON Schema 要像样，要有 export default 的函数。
// ha.browser.fetch（直接调网站的接口，19.6）还要源快照打开了「允许直接调网站接口」。
// ha.routine("短名", 输入)（流程库，docs/dev/routine-library.md 5.6）：短名要直接写字符串，routine.<短名> 要在任务的工具里；
// 库流程不能用 ha.tool("routine.…") 调。脚本的 AST 分析（analyzeScript）也给流程库发布时算「要的工具」用（library/analyze.ts）。
import { BROWSER_FETCH_TOOL, isRoutineToolId, ROUTINE_TOOL_PREFIX, routineSlugOfToolId, routineToolId, withPropertyOrder } from "@heyagent/shared"
import { parse, type Node } from "acorn"
import { z } from "zod"

/** 脚本里不许出现的名字：能绕开 SDK 执行任意代码、读环境、拿到全局对象 */
const FORBIDDEN_NAMES = new Set(["eval", "Function", "require", "process", "globalThis", "global"])
/** 不许访问的属性：(async () => {}).constructor("…") 一样能造出 Function */
const FORBIDDEN_PROPS = new Set(["constructor", "__proto__"])

/**
 * SDK 的浏览器函数 → 它调的工具 id（docs/dev/solidify.md 15.2 第 4 条；剪贴板三个见 sandbox-sdk/heyagent/index.js）。
 * 都属于「浏览器」这一组：任务里要有 browser。材料（material.ts）按它写「SDK 里怎么调」
 */
export const SDK_BROWSER_TOOLS: Readonly<Record<string, string>> = {
  navigate: "browser.navigate",
  click: "browser.click",
  type: "browser.type",
  fillForm: "browser.fill_form",
  select: "browser.select_option",
  press: "browser.press_key",
  pressSequentially: "browser.press_sequentially",
  hover: "browser.hover",
  check: "browser.check",
  uncheck: "browser.uncheck",
  drag: "browser.drag",
  upload: "browser.file_upload",
  tabs: "browser.tabs",
  waitFor: "browser.wait_for",
  handleDialog: "browser.handle_dialog",
  waitAny: "browser.wait_any",
  extract: "browser.extract",
  copyImage: "browser.copy_image",
  clipboardRead: "browser.clipboard_read",
  clipboardPaste: "browser.clipboard_paste",
  // 直接调网站的接口（docs/dev/solidify.md 19.5）：还要任务打开「允许直接调网站接口」（RoutineCheckInput.allowFetch）
  fetch: BROWSER_FETCH_TOOL,
}
export const SDK_BROWSER_FUNCTIONS = Object.keys(SDK_BROWSER_TOOLS)

/** ha 上的东西：值是要用到的工具（任务里没有就不过）；null = 不是工具（标记、输入、记一句话） */
const SDK_TOP: Record<string, string | null> = {
  input: null,
  commit: null,
  verified: null,
  fail: null,
  log: null,
  now: null,
  // 判断题（18.2）：工具桥用这次运行的执行模型答，不是任务里的工具
  judge: null,
  // 错误的类型（catch 里 error instanceof ha.StepError）
  StepError: null,
  Denied: null,
  RoutineStop: null,
  // 库流程里 ha.fail 抛给调用方的错（docs/dev/routine-library.md 5.6）
  RoutineFailed: null,
  finish: "run.finish",
  // 流程库（docs/dev/routine-library.md 5.6）：ha.routine("短名", 输入)，要的工具是 routine.<短名>，看第一个参数
  routine: null,
  // 下面这几个要看后面的函数名
  browser: null,
  file: null,
  checkpoint: null,
  work: null,
  tool: null,
}
const SDK_NESTED: Record<string, Record<string, string>> = {
  file: { read: "file.read", save: "file.save" },
  checkpoint: { mark: "checkpoint.mark" },
  work: { report: "work.report" },
}

/** 展开成一组的内置工具（快照里只有组的 id，例如 browser；调用时是 browser.click、gallery.search） */
export const GROUP_TOOLS = ["browser", "desktop", "gallery", "compare"]

export interface RoutineCheckInput {
  code: string
  /** 固化员给的 JSON Schema（原样的 JSON 文字，或者已经解析好的对象） */
  inputSchema: string | Record<string, unknown>
  outputSchema: string | Record<string, unknown>
  /** 任务的工具 id（源运行快照里的 tools） */
  toolIds: string[]
  /** 被派的任务：声明的参数、要交回的结果（输入输出格式要包含它们） */
  dispatch?: { params: { name: string; required: boolean }[]; results: { name: string; required: boolean }[] }
  /** 原来那次运行的输入（routineInputOf）：试跑、以后的运行都按 inputSchema 校验它，现在先对一遍 */
  sampleInput?: Record<string, unknown>
  /** 源快照的 browser.allowFetch（任务打开了「允许直接调网站接口」）：关着时脚本里不能用 ha.browser.fetch（19.6） */
  allowFetch?: boolean
}

/** 用了 browser.fetch、任务没打开开关时的问题（ha.browser.fetch、ha.tool("browser.fetch") 都算） */
export const FETCH_NOT_ALLOWED = "任务没打开「允许直接调网站接口」，脚本里不能用 ha.browser.fetch"

export interface RoutineCheckResult {
  problems: string[]
  inputSchema?: Record<string, unknown>
  outputSchema?: Record<string, unknown>
  /** 脚本用到的工具（给人看、给测试断言） */
  usedTools: string[]
}

type AnyNode = Node & Record<string, unknown>

const isNode = (value: unknown): value is AnyNode => Boolean(value) && typeof value === "object" && typeof (value as { type?: unknown }).type === "string"

/** 把 AST 走一遍：每个节点带上它的父节点和它在父节点里的字段名 */
function walk(node: AnyNode, visit: (node: AnyNode, parent: AnyNode | undefined, key: string | undefined) => void, parent?: AnyNode, key?: string) {
  visit(node, parent, key)
  for (const [field, value] of Object.entries(node)) {
    if (field === "type" || field === "start" || field === "end" || field === "loc" || field === "range") continue
    if (Array.isArray(value)) {
      for (const child of value) if (isNode(child)) walk(child, visit, node, field)
    } else if (isNode(value)) walk(value, visit, node, field)
  }
}

/** 这个 Identifier 是不是「用了这个名字」（不是 a.b 里的 b、{ b: 1 } 里的 b） */
function isReference(parent: AnyNode | undefined, key: string | undefined) {
  if (!parent) return true
  if (parent.type === "MemberExpression" && key === "property" && !parent.computed) return false
  if ((parent.type === "Property" || parent.type === "PropertyDefinition" || parent.type === "MethodDefinition") && key === "key" && !parent.computed)
    return parent.type === "Property" && Boolean(parent.shorthand)
  if ((parent.type === "LabeledStatement" || parent.type === "BreakStatement" || parent.type === "ContinueStatement") && key === "label") return false
  if (parent.type === "ImportDefaultSpecifier" || parent.type === "ImportSpecifier" || parent.type === "ExportSpecifier") return false
  return true
}

/** a.b.c 的属性名（不是写死的名字就是 undefined） */
function propName(member: AnyNode): string | undefined {
  const property = member.property as AnyNode
  if (!member.computed && property.type === "Identifier") return property.name as string
  if (member.computed && property.type === "Literal" && typeof property.value === "string") return property.value
  return undefined
}

/** 对象字面量里一项的键名（{ question: … }、{ "question": … }）；算出来的键是 undefined */
function propKey(property: AnyNode): string | undefined {
  const keyNode = property.key as AnyNode
  if (!property.computed && keyNode.type === "Identifier") return keyNode.name as string
  if (keyNode.type === "Literal" && typeof keyNode.value === "string") return keyNode.value
  return undefined
}

const lineOf = (code: string, offset: number) => code.slice(0, offset).split("\n").length

/** 解析固化员给的 JSON Schema：要是对象类型（脚本的输入、交回的结果都是一个对象），properties、required 的形状要对；属性顺序记进 x-order */
export function parseJsonSchema(value: string | Record<string, unknown>, what: string): { schema?: Record<string, unknown>; problems: string[] } {
  let schema: unknown = value
  if (typeof value === "string") {
    // 没有输入、没有要交回的结果时，固化员常写空串：当成没有字段的对象
    if (!value.trim()) schema = {}
    else
      try {
        schema = JSON.parse(value)
      } catch (error) {
        return { problems: [`${what}不是合法的 JSON：${(error as Error).message}`] }
      }
  }
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return { problems: [`${what}要是一个 JSON Schema 对象`] }
  const object = { ...(schema as Record<string, unknown>) }
  // 没写 type、又看得出是对象的（空的 {}，或者有 properties）：补上 "type": "object"（基准 B 有一轮就因为写了 {} 三轮都没过）
  if (object.type === undefined && (Object.keys(object).length === 0 || "properties" in object)) object.type = "object"
  const problems: string[] = []
  if (object.type !== "object") problems.push(`${what}最外层要是 "type": "object"`)
  const properties = object.properties
  if (properties !== undefined && (!properties || typeof properties !== "object" || Array.isArray(properties))) problems.push(`${what}的 properties 要是对象`)
  else if (properties)
    for (const [name, each] of Object.entries(properties as Record<string, unknown>))
      if (!each || typeof each !== "object" || Array.isArray(each)) problems.push(`${what}的字段「${name}」要是一个 JSON Schema 对象`)
  const required = object.required
  if (required !== undefined && !(Array.isArray(required) && required.every((each) => typeof each === "string"))) problems.push(`${what}的 required 要是字段名的数组`)
  if (!problems.length) {
    try {
      z.fromJSONSchema(object as Parameters<typeof z.fromJSONSchema>[0])
    } catch (error) {
      problems.push(`${what}不是合法的 JSON Schema：${(error as Error).message}`)
    }
  }
  // 属性顺序记进 x-order：存进 jsonb 后属性按键长短重排，工具参数 p1、p2 和界面的输入表要照作者写的顺序（shared 的 SCHEMA_ORDER_KEY）
  return problems.length ? { problems } : { schema: withPropertyOrder(object), problems }
}

/** 按 JSON Schema 校验一个值，不合格返回原因（几条） */
export function schemaProblems(schema: Record<string, unknown>, value: unknown): string[] {
  let validator: z.ZodType
  try {
    validator = z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
  } catch (error) {
    return [(error as Error).message]
  }
  const parsed = validator.safeParse(value)
  if (parsed.success) return []
  return parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.length ? issue.path.join(".") : "（整个输入）"}：${issue.message}`)
}

function toolAvailable(toolId: string, toolIds: Set<string>) {
  if (toolIds.has(toolId)) return true
  const group = toolId.split(".")[0]!
  return GROUP_TOOLS.includes(group) && toolIds.has(group)
}

/** 按坐标的工具（「允许看画面」才有）：ha.tool("browser.mouse_click_xy") 这类、browser.look */
export const isVisionToolId = (toolId: string) => /^browser\.(mouse_|look$)/.test(toolId)

/** 复制图片的工具：参数里写了 x / y（按坐标复制）也要「允许看画面」 */
const COPY_IMAGE_TOOL = SDK_BROWSER_TOOLS.copyImage!

/**
 * 脚本里看出来的一样东西（按在脚本里出现的顺序）：
 * - problem：写法上的问题（和任务无关：解析不了、不许用的名字、ha 的用法不对……）；
 * - tool：用到的工具（how 是给人看的写法）；fetch = ha.browser.fetch（还要「允许直接调网站接口」）；
 * - routine：ha.routine 调的库流程（短名）
 */
export type ScriptItem = { problem: string } | { tool: string; how: string; fetch?: boolean } | { routine: string; how: string }

export interface ScriptAnalysis {
  items: ScriptItem[]
  /** 有没有 ha.commit */
  usesCommit: boolean
  /** 有没有按坐标的操作（坐标工具、copyImage 写 x / y）：要「允许看画面」 */
  vision: boolean
}

/** 写死的字符串（"x"、`x`）就给出来 */
function literalString(node: AnyNode | undefined): string | undefined {
  if (node?.type === "Literal" && typeof node.value === "string") return node.value
  if (node?.type === "TemplateLiteral" && (node.expressions as AnyNode[]).length === 0) return ((node.quasis as AnyNode[])[0]!.value as { cooked: string }).cooked
  return undefined
}

/** 对象字面量里写了 x 或 y（按坐标） */
const hasPointKeys = (node: AnyNode | undefined) =>
  node?.type === "ObjectExpression" && (node.properties as AnyNode[]).some((each) => each.type === "Property" && ["x", "y"].includes(propKey(each) ?? ""))

/** ha.browser.copyImage(…) 这个调用：callee 是 ha.browser.copyImage */
function isCopyImageCall(node: AnyNode): boolean {
  const callee = node.callee as AnyNode
  if (callee.type !== "MemberExpression" || propName(callee) !== "copyImage") return false
  const object = callee.object as AnyNode
  return object.type === "MemberExpression" && propName(object) === "browser" && (object.object as AnyNode).type === "Identifier" && (object.object as AnyNode).name === "ha"
}

/**
 * 把脚本读一遍（不看任务）：写法上的问题、用到的工具、ha.routine 调的库流程、有没有 ha.commit、按坐标的操作。
 * checkRoutine 拿它对任务的工具；流程库发布时（library/analyze.ts 的 analyzeLibraryCode）拿它算要的工具和风险
 */
export function analyzeScript(code: string): ScriptAnalysis {
  const items: ScriptItem[] = []
  const problem = (text: string) => items.push({ problem: text })
  let usesCommit = false
  let vision = false

  let ast: AnyNode | undefined
  if (!code.trim()) problem("脚本是空的")
  else {
    try {
      ast = parse(code, { ecmaVersion: "latest", sourceType: "module", allowHashBang: false }) as unknown as AnyNode
    } catch (error) {
      problem(`脚本解析不了（要是 ES module）：${(error as Error).message}`)
    }
  }
  if (!ast) return { items, usesCommit, vision }

  let haImports = 0
  let exportDefault: AnyNode | undefined
  const tool = (id: string, how: string, extra: { fetch?: boolean } = {}) => {
    items.push({ tool: id, how, ...extra })
    if (isVisionToolId(id)) vision = true
  }
  const at = (node: AnyNode) => `第 ${lineOf(code, node.start)} 行`

  for (const statement of ast.body as AnyNode[]) {
    if (statement.type === "ImportDeclaration") {
      const specifiers = statement.specifiers as AnyNode[]
      const source = (statement.source as AnyNode).value
      const ok =
        source === "heyagent" &&
        specifiers.length === 1 &&
        specifiers[0]!.type === "ImportDefaultSpecifier" &&
        (specifiers[0]!.local as AnyNode).name === "ha"
      if (ok) haImports++
      else problem(`${at(statement)}：只许写 import ha from "heyagent"，不能 import 别的（${String(source)}）`)
    }
    if ((statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") && statement.source)
      problem(`${at(statement)}：不能从别的模块导出（export … from）`)
    if (statement.type === "ExportDefaultDeclaration") exportDefault = statement
  }
  if (haImports > 1) problem(`import ha from "heyagent" 只要写一次`)
  if (!exportDefault) problem("要有 export default async function run(input) { … }")
  else {
    const declaration = exportDefault.declaration as AnyNode
    if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(declaration.type))
      problem("export default 要是一个函数：export default async function run(input) { … }")
  }

  walk(ast, (node, parent, key) => {
    if (node.type === "ImportExpression") problem(`${at(node)}：不能用动态 import()`)
    if (node.type === "MetaProperty") problem(`${at(node)}：不能用 import.meta / new.target`)
    if (node.type === "WithStatement") problem(`${at(node)}：不能用 with`)
    // 按坐标复制图片（copyImage 写 x、y）：要「允许看画面」
    if (node.type === "CallExpression" && isCopyImageCall(node) && hasPointKeys((node.arguments as AnyNode[])[0])) vision = true
    if (node.type === "Identifier" && FORBIDDEN_NAMES.has(node.name as string) && isReference(parent, key))
      problem(`${at(node)}：不能用 ${String(node.name)}（脚本只能通过 ha 做事）`)
    if (node.type === "MemberExpression") {
      const name = propName(node)
      if (name && FORBIDDEN_PROPS.has(name)) problem(`${at(node)}：不能访问 .${name}`)
      if (node.computed && !name && (node.object as AnyNode).type === "Identifier" && (node.object as AnyNode).name === "ha")
        problem(`${at(node)}：ha 的属性要写死（ha.browser.click），不能用 ha[变量]`)
    }
    // ha 只能写成 ha.xxx：传来传去、解构以后，这里就看不出用了哪些工具
    if (node.type === "Identifier" && node.name === "ha" && isReference(parent, key)) {
      const isObject = parent?.type === "MemberExpression" && key === "object"
      if (!isObject) problem(`${at(node)}：ha 要写成 ha.browser.click(…) 这样直接用，不要赋给别的变量、解构或传来传去`)
    }
    // ha.xxx、ha.xxx.yyy：认得的函数、用到的工具
    if (node.type === "MemberExpression" && (node.object as AnyNode).type === "Identifier" && (node.object as AnyNode).name === "ha") {
      const top = propName(node)
      if (!top) return
      if (!(top in SDK_TOP)) {
        problem(`${at(node)}：SDK 里没有 ha.${top}`)
        return
      }
      if (top === "commit") usesCommit = true
      const direct = SDK_TOP[top]
      if (direct) tool(direct, `ha.${top}`)
      const outer = parent?.type === "MemberExpression" && key === "object" ? parent : undefined
      const sub = outer ? propName(outer) : undefined
      if (top === "browser") {
        if (!sub) {
          problem(`${at(node)}：ha.browser 要接具体的函数，例如 ha.browser.click(…)`)
          return
        }
        const toolId = Object.hasOwn(SDK_BROWSER_TOOLS, sub) ? SDK_BROWSER_TOOLS[sub] : undefined
        if (!toolId) {
          problem(`${at(node)}：SDK 里没有 ha.browser.${sub}（有的是：${SDK_BROWSER_FUNCTIONS.join("、")}；别的浏览器工具用 ha.tool("browser.xxx", { … })）`)
          return
        }
        // 浏览器工具在快照里只有组的 id：要求任务里有 browser
        tool("browser", `ha.browser.${sub}（${toolId}）`, toolId === BROWSER_FETCH_TOOL ? { fetch: true } : {})
      }
      if (top in SDK_NESTED) {
        const toolId = sub ? SDK_NESTED[top]![sub] : undefined
        if (!toolId) {
          problem(`${at(node)}：SDK 里没有 ha.${top}.${sub ?? "…"}（有的是：${Object.keys(SDK_NESTED[top]!).map((name) => `ha.${top}.${name}`).join("、")}）`)
          return
        }
        tool(toolId, `ha.${top}.${sub}`)
      }
      if (top === "tool") {
        const call = parent?.type === "CallExpression" && key === "callee" ? parent : undefined
        const args = call?.arguments as AnyNode[] | undefined
        const id = literalString(args?.[0])
        if (!call) problem(`${at(node)}：ha.tool 要直接调用：ha.tool("工具 id", { … })`)
        else if (!id) problem(`${at(node)}：ha.tool 的第一个参数要直接写工具 id 的字符串`)
        else if (isRoutineToolId(id))
          problem(`${at(node)}：ha.tool("${id}") 不行：流程库里的流程用 ha.routine("${routineSlugOfToolId(id) ?? id.slice(ROUTINE_TOOL_PREFIX.length)}", 输入) 调`)
        else {
          tool(id, `ha.tool("${id}")`)
          if (id === COPY_IMAGE_TOOL && hasPointKeys(args?.[1])) vision = true
        }
      }
      if (top === "routine") {
        const call = parent?.type === "CallExpression" && key === "callee" ? parent : undefined
        const slug = literalString((call?.arguments as AnyNode[] | undefined)?.[0])
        if (!call) problem(`${at(node)}：ha.routine 要直接调用：ha.routine("短名", { … })`)
        else if (!slug) problem(`${at(node)}：ha.routine 的第一个参数要直接写流程的短名（字符串，例如 "order_status"）`)
        else items.push({ routine: slug, how: `ha.routine("${slug}")` })
      }
      if (top === "judge") {
        const call = parent?.type === "CallExpression" && key === "callee" ? parent : undefined
        const first = (call?.arguments as AnyNode[] | undefined)?.[0]
        if (!call) problem(`${at(node)}：ha.judge 要直接调用：ha.judge({ question, data, choices })`)
        else if (!first) problem(`${at(node)}：ha.judge 要给参数 { question, data, choices }`)
        else if (first.type === "ObjectExpression") {
          // { ...args }、{ [name]: … } 看不出有没有 question，不报
          const keys = (first.properties as AnyNode[]).map((each) => (each.type === "Property" ? propKey(each) : undefined))
          if (!keys.includes("question") && !keys.includes(undefined)) problem(`${at(node)}：ha.judge 要写 question（判断什么、按什么标准）`)
          const choices = (first.properties as AnyNode[]).find((each) => each.type === "Property" && propKey(each) === "choices")?.value as AnyNode | undefined
          const list = choices?.type === "ArrayExpression" ? (choices.elements as (AnyNode | null)[]) : undefined
          if (list && !list.some((each) => each?.type === "SpreadElement") && list.length < 2)
            problem(`${at(node)}：ha.judge 的 choices 至少要两个选项（不给选项就不写 choices）`)
        }
      }
      if (top === "fail") {
        const call = parent?.type === "CallExpression" && key === "callee" ? parent : undefined
        const first = (call?.arguments as AnyNode[] | undefined)?.[0]
        if (first?.type === "Literal" && first.value !== "input" && first.value !== "page")
          problem(`${at(node)}：ha.fail 的第一个参数只能是 "input"（输入有问题）或 "page"（页面和预期不一样）`)
      }
    }
  })
  return { items, usesCommit, vision }
}

/** 程序检查。problems 为空 = 过了 */
export function checkRoutine(input: RoutineCheckInput): RoutineCheckResult {
  const problems: string[] = []
  const used = new Set<string>()
  const toolIds = new Set(input.toolIds)
  const missing = new Set<string>()
  // browser.fetch 要任务打开开关：只报一次
  const fetchUsed = () => {
    if (!input.allowFetch && !problems.includes(FETCH_NOT_ALLOWED)) problems.push(FETCH_NOT_ALLOWED)
  }
  for (const item of analyzeScript(input.code).items) {
    if ("problem" in item) {
      problems.push(item.problem)
      continue
    }
    if ("routine" in item) {
      // 调用方脚本里 ha.routine 的流程也要在任务里选上（docs/dev/routine-library.md 6.2），同「用到的工具都在任务里」
      const toolId = routineToolId(item.routine)
      used.add(toolId)
      if (!toolIds.has(toolId) && !missing.has(toolId)) {
        missing.add(toolId)
        problems.push(`${item.how}：任务没选流程「${toolId}」（流程库里的流程要在任务里选上才能调）`)
      }
      continue
    }
    used.add(item.tool)
    if (item.tool === BROWSER_FETCH_TOOL) fetchUsed()
    if (!toolAvailable(item.tool, toolIds) && !missing.has(item.tool)) {
      missing.add(item.tool)
      problems.push(`${item.how} 要用工具 ${item.tool}，这个任务里没有这个工具`)
    }
    if (item.fetch) fetchUsed()
  }

  const inputParsed = parseJsonSchema(input.inputSchema, "输入格式（inputSchema）")
  const outputParsed = parseJsonSchema(input.outputSchema, "交回的结果格式（outputSchema）")
  problems.push(...inputParsed.problems, ...outputParsed.problems)
  const propertiesOf = (schema: Record<string, unknown> | undefined) => Object.keys((schema?.properties as Record<string, unknown> | undefined) ?? {})
  if (input.dispatch && inputParsed.schema) {
    const names = propertiesOf(inputParsed.schema)
    const absent = input.dispatch.params.filter((param) => !names.includes(param.name)).map((param) => param.name)
    if (absent.length) problems.push(`被派的任务：输入格式要包含声明的参数「${absent.join("」「")}」`)
  }
  if (input.dispatch && outputParsed.schema) {
    const names = propertiesOf(outputParsed.schema)
    const absent = input.dispatch.results.filter((result) => !names.includes(result.name)).map((result) => result.name)
    if (absent.length) problems.push(`被派的任务：交回的结果格式要包含声明的结果「${absent.join("」「")}」`)
  }
  if (inputParsed.schema && input.sampleInput) {
    const issues = schemaProblems(inputParsed.schema, input.sampleInput)
    if (issues.length) problems.push(`原来那次运行的输入不符合输入格式（以后的运行会被当成输入不对）：${issues.join("；")}`)
  }

  return {
    problems: [...new Set(problems)],
    ...(inputParsed.schema ? { inputSchema: inputParsed.schema } : {}),
    ...(outputParsed.schema ? { outputSchema: outputParsed.schema } : {}),
    usedTools: [...used].sort(),
  }
}
