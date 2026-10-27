// HeyAgent 固化脚本的 SDK（docs/dev/solidify.md 4.4）。
//
// 脚本是一个 ES module：只许 `import ha from "heyagent"`，写 `export default async function run(input) { … }`。
// 脚本在沙箱里跑，不能上网、不能读写文件系统；所有事情都通过 ha.* 做，每个调用都是一次工具调用，
// 和 agent 调用时一样过规则、白名单、审批、验证码 / 登录页检测，记过程记录。
//
// 定位（Target）的两种写法，和浏览器动作的 target 一样：
// - Playwright 的写法（过程记录里录下的就是这种）：getByRole('button', { name: '查询' })、getByText('暂无数据')、
//   getByLabel('单号')、getByPlaceholder('…')、getByTestId('…')、locator('css')，可以接 .first()、.last()、.nth(n)、
//   .filter({ hasText: '…' })。参数只能写字面量（字符串、数字、正则、对象），不能写变量；要用变量就拼成字符串，例如
//   `getByRole('row').filter({ hasText: '${单号}' })`（单号里有引号时先转义）。
// - 选择器字符串：role=button[name="查询"]、text=暂无数据、CSS 选择器。
// 不能用快照里的 ref（e12）：脚本每次跑页面都是新的。
//
// 出错：工具出错抛 StepError（脚本可以接住，例如可有可无的弹窗）；被规则拦下抛 Denied；
// 要停下（要人审批、遇到验证码 / 登录页、ha.fail、报了结果以后、试跑走到提交前、运行被取消、调用次数或时间到了上限）抛 RoutineStop，
// 接住也没用：之后的调用一律再抛 RoutineStop。没接住的 StepError / Denied、脚本自己的错，都会让这次运行交给 agent 接着做。

/** 定位：Playwright 写法或选择器字符串（见文件开头） */
export type Target = string

export interface ElementArgs {
  /** 给人看的元素名字（「查询按钮」），过程记录和远程画面上显示 */
  element?: string
  /** 元素的定位 */
  target: Target
}

export interface FormField {
  /** 给人看的字段名 */
  name: string
  type: "textbox" | "checkbox" | "radio" | "combobox" | "slider"
  target: Target
  /** textbox 填的字；checkbox / radio 写 "true" / "false"；combobox 写选项的文字 */
  value: string
}

export interface ExtractArgs {
  /** 每一行的定位，例如 getByRole('row')；不给 = 整页算一行 */
  list?: Target
  /** 字段名 → 定位（相对这一行），或 { target, attr } 取属性（href、value、src） */
  fields: Record<string, Target | { target: Target; attr?: string }>
  /** 最多读几行，默认 50，最多 500 */
  limit?: number
}

export interface ExtractResult {
  /** 一行一个对象；某个字段在这一行里没找到是 null */
  rows: Record<string, string | null>[]
  /** 列表一共几行（可能比 rows 多：limit 限着） */
  total: number
}

export interface SheetData {
  sheet: string
  /** 第一行（表头） */
  header: string[]
  /** 表头以下的行，一行一个对象（键是表头） */
  rows: Record<string, string>[]
  /** 表头以下一共几行 */
  total: number
}

export interface FinishArgs {
  /** achieved = 办成（目标要的都拿到了）；not_achieved = 没办成 */
  outcome: "achieved" | "not_achieved"
  /** 做了什么、结果在哪（给人看的总结） */
  summary: string
  /** 对照目标逐条写依据：拿到了什么、在哪能看到 */
  evidence: string
  /** not_achieved 必填：拿到了什么、缺了什么、为什么 */
  reason?: string
}

export interface ToolResult {
  /** 工具返回的文字 */
  text: string
  /** 结构化结果（HTTP 工具返回的 JSON 等）；没有是 undefined */
  data?: unknown
}

export declare class StepError extends Error {
  name: "StepError"
}
export declare class Denied extends Error {
  name: "Denied"
}
export declare class RoutineStop extends Error {
  name: "RoutineStop"
}

export interface Heyagent {
  /**
   * 这次的输入（跑之前按 inputSchema 校验过）：派活参数原样放（例如 input.单号）；
   * $attachments：这次运行能读的附件 [{ id, name, mime }]（用 ha.file.read({ fileId }) 读）；$note：附加说明
   */
  readonly input: Record<string, unknown> & {
    $attachments?: { id: string; name: string; mime: string }[]
    $note?: string
  }

  browser: {
    /** 打开网址（要在网址白名单里） */
    navigate(args: { url: string }): Promise<string>
    click(args: ElementArgs & { doubleClick?: boolean; button?: "left" | "right" | "middle"; modifiers?: ("Alt" | "Control" | "ControlOrMeta" | "Meta" | "Shift")[] }): Promise<string>
    /** 往输入框里填字（清掉原来的）；submit: true 填完按回车 */
    type(args: ElementArgs & { text: string; submit?: boolean; slowly?: boolean }): Promise<string>
    /** 一次填多个输入框、下拉、勾选 */
    fillForm(args: { fields: FormField[] }): Promise<string>
    /** 下拉框选选项（values 写选项的值或文字） */
    select(args: ElementArgs & { values: string[] }): Promise<string>
    /** 按键，例如 Enter、ArrowDown、Control+A */
    press(args: { key: string }): Promise<string>
    /** 往现在有焦点的元素里一个字一个字地敲（先 click 到输入框；输入框要响应每个按键时用） */
    pressSequentially(args: { text: string; submit?: boolean }): Promise<string>
    hover(args: ElementArgs): Promise<string>
    check(args: ElementArgs): Promise<string>
    uncheck(args: ElementArgs): Promise<string>
    drag(args: { startElement?: string; startTarget: Target; endElement?: string; endTarget: Target }): Promise<string>
    /** 文件选择框开着时上传：fileIds 是这次运行的附件或产物的文件 id；不给就取消选择框 */
    upload(args: { fileIds?: string[] }): Promise<string>
    /** 标签页：list / new（可带 url）/ close / select（index） */
    tabs(args: { action: "list" | "new" | "close" | "select"; index?: number; url?: string }): Promise<string>
    /** 等文字出现（text）、消失（textGone），或者等几秒（time） */
    waitFor(args: { time?: number; text?: string; textGone?: string }): Promise<string>
    /** 处理网页弹框（alert / confirm / prompt）：accept 确定还是取消 */
    handleDialog(args: { accept: boolean; promptText?: string }): Promise<string>
    /**
     * 等页面上出现其中一个（看得见的），返回它的名字；同时出现时取前面的。
     * 把所有可能的结果都列出来：结果页、「暂无数据」、报错提示，不要只等成功的那个。
     * 定位写 "url=片段" 表示网址里包含这一段。timeout 单位是秒，默认 10，最多 60；等不到抛 StepError
     */
    waitAny<K extends string>(outcomes: Record<K, Target>, options?: { timeout?: number }): Promise<K>
    /** 按定位读页面上的字（只读）。一行也没有不算出错：rows 是空数组 */
    extract(args: ExtractArgs): Promise<ExtractResult>
  }

  file: {
    /**
     * 读文件：fileId（附件、产物的 id）或 path（这次运行空间里的路径）二选一。
     * 表格（xlsx、csv……）返回 SheetData（sheet、startRow、rows 选工作表和范围）；文本返回文字
     */
    read(args: { fileId?: string; path?: string; sheet?: string | number; startRow?: number; rows?: number; offset?: number }): Promise<SheetData | string>
    /** 存文件到这次运行的空间：文本给 content；Excel 给 sheets（[{ name, rows: 二维数组 }]） */
    save(args: { path: string; content?: string; sheets?: { name: string; rows: (string | number | boolean | null)[][] }[] }): Promise<string>
  }

  checkpoint: {
    /** 勾任务的检查点：第几个（从 1 开始）、done / skipped（要写 reason）/ doing */
    mark(args: { checkpoint: number; status: "done" | "skipped" | "doing"; record?: string; reason?: string; progress?: string }): Promise<string>
  }

  work: {
    /** 被派来的运行交回结果（字段按任务声明的结果写） */
    report(args: { data?: Record<string, string | number | boolean>; outcome?: "done" | "not_done"; reason?: string }): Promise<string>
  }

  /** 任务里的任何别的工具（HTTP、MCP、比物、图库……），id 写工具 id */
  tool(id: string, input: Record<string, unknown>): Promise<ToolResult>

  /**
   * 标记：下一步会真的改东西（提交、保存、发送）。会改东西的动作前都要先调它，写清楚这一步做什么（「保存第 3 个商品」）。
   * 试跑走到这里就停（不做这一步）；试用期在这里截图存证；过了这里再出错，交给 agent 时会写明「可能已经生效」
   */
  commit(label: string): Promise<void>
  /** 标记：改完读回来核对过了（写核对了什么，「页面提示保存成功」） */
  verified(note: string): Promise<void>
  /** 主动停：input = 输入本身有问题（记没办成，不交 agent）；page = 页面和预期不一样（交给 agent）。总是抛 RoutineStop */
  fail(kind: "input" | "page", reason: string): Promise<never>
  /** 结束，报结果（照常按硬规则核、复核）。之后的调用一律停；用 return ha.finish(...) 结束 run */
  finish(result: FinishArgs): Promise<void>
  /** 记一条过程给人看 */
  log(text: string): Promise<void>
  /** 现在的时间（上海时间，ISO 格式）。要取时间一律用它，不要用 Date */
  now(): Promise<string>

  StepError: typeof StepError
  Denied: typeof Denied
  RoutineStop: typeof RoutineStop
}

declare const ha: Heyagent
export default ha
