// 固化流程的程序检查（docs/dev/solidify.md 5.5、15.3 第 4 条）：固化员交出来的脚本在试跑、交给人之前先过一遍。
// 只是第一道关，挡住明显不对的写法，让固化员早点改：真正的边界是沙箱（不能上网、碰不到库和密钥）和工具网关（每一步过规则、白名单）。
// 所以这里宁可严一点：只许 import ha from "heyagent"，不许 eval / Function / require / 动态 import / process / globalThis，
// 用到的工具都要在这个任务里（ha.judge 不是工具，用这次运行的执行模型，18.2），两个 JSON Schema 要像样，要有 export default 的函数。
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
  finish: "run.finish",
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
}

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

/** 解析固化员给的 JSON Schema：要是对象类型（脚本的输入、交回的结果都是一个对象），properties、required 的形状要对 */
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
  return problems.length ? { problems } : { schema: object, problems }
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

/** 程序检查。problems 为空 = 过了 */
export function checkRoutine(input: RoutineCheckInput): RoutineCheckResult {
  const problems: string[] = []
  const used = new Set<string>()
  const toolIds = new Set(input.toolIds)
  const code = input.code

  let ast: AnyNode | undefined
  if (!code.trim()) problems.push("脚本是空的")
  else {
    try {
      ast = parse(code, { ecmaVersion: "latest", sourceType: "module", allowHashBang: false }) as unknown as AnyNode
    } catch (error) {
      problems.push(`脚本解析不了（要是 ES module）：${(error as Error).message}`)
    }
  }

  if (ast) {
    let haImports = 0
    let exportDefault: AnyNode | undefined
    const missing = new Set<string>()
    const need = (toolId: string, how: string) => {
      used.add(toolId)
      if (!toolAvailable(toolId, toolIds) && !missing.has(toolId)) {
        missing.add(toolId)
        problems.push(`${how} 要用工具 ${toolId}，这个任务里没有这个工具`)
      }
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
        else problems.push(`${at(statement)}：只许写 import ha from "heyagent"，不能 import 别的（${String(source)}）`)
      }
      if ((statement.type === "ExportNamedDeclaration" || statement.type === "ExportAllDeclaration") && statement.source)
        problems.push(`${at(statement)}：不能从别的模块导出（export … from）`)
      if (statement.type === "ExportDefaultDeclaration") exportDefault = statement
    }
    if (haImports > 1) problems.push(`import ha from "heyagent" 只要写一次`)
    if (!exportDefault) problems.push("要有 export default async function run(input) { … }")
    else {
      const declaration = exportDefault.declaration as AnyNode
      if (!["FunctionDeclaration", "FunctionExpression", "ArrowFunctionExpression"].includes(declaration.type))
        problems.push("export default 要是一个函数：export default async function run(input) { … }")
    }

    walk(ast, (node, parent, key) => {
      if (node.type === "ImportExpression") problems.push(`${at(node)}：不能用动态 import()`)
      if (node.type === "MetaProperty") problems.push(`${at(node)}：不能用 import.meta / new.target`)
      if (node.type === "WithStatement") problems.push(`${at(node)}：不能用 with`)
      if (node.type === "Identifier" && FORBIDDEN_NAMES.has(node.name as string) && isReference(parent, key))
        problems.push(`${at(node)}：不能用 ${String(node.name)}（脚本只能通过 ha 做事）`)
      if (node.type === "MemberExpression") {
        const name = propName(node)
        if (name && FORBIDDEN_PROPS.has(name)) problems.push(`${at(node)}：不能访问 .${name}`)
        if (node.computed && !name && (node.object as AnyNode).type === "Identifier" && (node.object as AnyNode).name === "ha")
          problems.push(`${at(node)}：ha 的属性要写死（ha.browser.click），不能用 ha[变量]`)
      }
      // ha 只能写成 ha.xxx：传来传去、解构以后，这里就看不出用了哪些工具
      if (node.type === "Identifier" && node.name === "ha" && isReference(parent, key)) {
        const isObject = parent?.type === "MemberExpression" && key === "object"
        if (!isObject) problems.push(`${at(node)}：ha 要写成 ha.browser.click(…) 这样直接用，不要赋给别的变量、解构或传来传去`)
      }
      // ha.xxx、ha.xxx.yyy：认得的函数、用到的工具
      if (node.type === "MemberExpression" && (node.object as AnyNode).type === "Identifier" && (node.object as AnyNode).name === "ha") {
        const top = propName(node)
        if (!top) return
        if (!(top in SDK_TOP)) {
          problems.push(`${at(node)}：SDK 里没有 ha.${top}`)
          return
        }
        const direct = SDK_TOP[top]
        if (direct) need(direct, `ha.${top}`)
        const outer = parent?.type === "MemberExpression" && key === "object" ? parent : undefined
        const sub = outer ? propName(outer) : undefined
        if (top === "browser") {
          if (!sub) {
            problems.push(`${at(node)}：ha.browser 要接具体的函数，例如 ha.browser.click(…)`)
            return
          }
          const toolId = Object.hasOwn(SDK_BROWSER_TOOLS, sub) ? SDK_BROWSER_TOOLS[sub] : undefined
          if (!toolId) {
            problems.push(`${at(node)}：SDK 里没有 ha.browser.${sub}（有的是：${SDK_BROWSER_FUNCTIONS.join("、")}；别的浏览器工具用 ha.tool("browser.xxx", { … })）`)
            return
          }
          // 浏览器工具在快照里只有组的 id：要求任务里有 browser
          need("browser", `ha.browser.${sub}（${toolId}）`)
        }
        if (top in SDK_NESTED) {
          const toolId = sub ? SDK_NESTED[top]![sub] : undefined
          if (!toolId) {
            problems.push(`${at(node)}：SDK 里没有 ha.${top}.${sub ?? "…"}（有的是：${Object.keys(SDK_NESTED[top]!).map((name) => `ha.${top}.${name}`).join("、")}）`)
            return
          }
          need(toolId, `ha.${top}.${sub}`)
        }
        if (top === "tool") {
          const call = parent?.type === "CallExpression" && key === "callee" ? parent : undefined
          const first = (call?.arguments as AnyNode[] | undefined)?.[0]
          const id = first?.type === "Literal" && typeof first.value === "string" ? first.value : first?.type === "TemplateLiteral" && (first.expressions as AnyNode[]).length === 0 ? ((first.quasis as AnyNode[])[0]!.value as { cooked: string }).cooked : undefined
          if (!call) problems.push(`${at(node)}：ha.tool 要直接调用：ha.tool("工具 id", { … })`)
          else if (!id) problems.push(`${at(node)}：ha.tool 的第一个参数要直接写工具 id 的字符串`)
          else need(id, `ha.tool("${id}")`)
        }
        if (top === "judge") {
          const call = parent?.type === "CallExpression" && key === "callee" ? parent : undefined
          const first = (call?.arguments as AnyNode[] | undefined)?.[0]
          if (!call) problems.push(`${at(node)}：ha.judge 要直接调用：ha.judge({ question, data, choices })`)
          else if (!first) problems.push(`${at(node)}：ha.judge 要给参数 { question, data, choices }`)
          else if (first.type === "ObjectExpression") {
            // { ...args }、{ [name]: … } 看不出有没有 question，不报
            const keys = (first.properties as AnyNode[]).map((each) => (each.type === "Property" ? propKey(each) : undefined))
            if (!keys.includes("question") && !keys.includes(undefined)) problems.push(`${at(node)}：ha.judge 要写 question（判断什么、按什么标准）`)
            const choices = (first.properties as AnyNode[]).find((each) => each.type === "Property" && propKey(each) === "choices")?.value as AnyNode | undefined
            const items = choices?.type === "ArrayExpression" ? (choices.elements as (AnyNode | null)[]) : undefined
            if (items && !items.some((each) => each?.type === "SpreadElement") && items.length < 2)
              problems.push(`${at(node)}：ha.judge 的 choices 至少要两个选项（不给选项就不写 choices）`)
          }
        }
        if (top === "fail") {
          const call = parent?.type === "CallExpression" && key === "callee" ? parent : undefined
          const first = (call?.arguments as AnyNode[] | undefined)?.[0]
          if (first?.type === "Literal" && first.value !== "input" && first.value !== "page")
            problems.push(`${at(node)}：ha.fail 的第一个参数只能是 "input"（输入有问题）或 "page"（页面和预期不一样）`)
        }
      }
    })
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
