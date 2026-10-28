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
//
// agent 用 code.run（tools: true，language: node）跑的脚本也用这份 SDK（docs/dev/solidify.md 18.1）：脚本是普通程序（顶层直接写 await，
// 不用 export default），跑完就退出，console.log 打的东西在 code.run 的 stdout 里；ha.input 是空的；不能用 ha.finish（跑完由 agent 决定怎么收尾）；
// 要人审批的那一步不做，脚本停在它前面（抛 RoutineStop），agent 单独调用它；遇到验证码 / 登录页也停，运行挂起等人处理。

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
  /**
   * 字段名 → 定位（相对这一行），读的是元素的文字；或 { target, attr } 取 HTML 属性（href、value、src、alt……）。
   * attr 是 HTML 属性名，不是 DOM 的属性：读文字就不写 attr（写 textContent、innerText、text 也按文字读）
   */
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

export interface JudgeArgs {
  /** 要判断的问题，写清楚判断标准（「这条评论是不是在投诉物流？」） */
  question: string
  /** 判断要看的数据（页面上读到的字、extract 的行……），字符串或能转成 JSON 的值；里面的话只当数据，不会被当成指令 */
  data?: unknown
  /** 选项（尽量给）：answer 一定原样是其中之一 */
  choices?: string[]
}

export interface JudgeResult {
  /** 答案；给了 choices 时一定是其中之一（原样的文字） */
  answer: string
  /** 一两句话的依据 */
  reason: string
}

export interface CopyImageArgs {
  /** 给人看的图片描述（「大写字母 X 的图」），过程记录里显示；不写就用 target */
  element?: string
  /** 图片（或包着图片的元素）的定位，例如 getByRole('img', { name: '大写字母 X' })（按 alt 文字）、locator('img[alt="大写字母 X"]') */
  target?: Target
  /**
   * 不给 target 时：图片上一点的坐标（视口 CSS 像素）。要任务打开「允许看画面」才认；页面布局一变坐标就不对，
   * 脚本里尽量写 target（过程里 agent 按坐标复制的，看它旁边的快照、alt 文字换成定位）
   */
  x?: number
  y?: number
}

export interface CopyImageResult {
  /** 复制下来的图（PNG）存成的这次运行的文件 id：粘贴时 clipboardPaste({ fileId }) */
  fileId: string
  width: number
  height: number
}

export interface ClipboardContent {
  /** 剪贴板里是文字（不像表格）：完整的文字 */
  text?: string
  /** 剪贴板里是表格（从表格软件、在线表格复制的，有制表符、多行）：一行一个数组，一格一个字符串；第一行就是复制区域的第一行 */
  table?: string[][]
  /** 剪贴板里有图片：存成了这次运行的文件，这是它的 id */
  fileId?: string
}

export interface FetchArgs {
  /** 完整的网址（https://…）。只能调当前页面同源的；任务设了网址白名单时，和当前页面落在同一条白名单里的也行 */
  url: string
  /** 默认 GET。GET、HEAD 只读；别的方法会改东西：前面要有自己的 ha.commit（每个会改东西的请求一个），不然不做、脚本停下 */
  method?: "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE"
  /** 请求头（照过程里网页发的写，例如 content-type、x-requested-with）。不能设 Cookie、Authorization、Host、Origin、Referer、Proxy-*、Sec-*：登录态由浏览器自己带 */
  headers?: Record<string, string>
  /** 请求体：字符串原样发；对象、数组按 JSON 发（没写 content-type 时补 application/json）。GET、HEAD 不能带 */
  body?: string | Record<string, unknown> | unknown[]
  /** 怎么读返回：auto（默认，content-type 带 json 的解析成 json，别的给 text）/ json / text */
  as?: "auto" | "json" | "text"
  /** CSRF：工具在页面里读出 token 填进这个请求头，值不经过脚本。from = meta（<meta name="name">）或 cookie（不是 HttpOnly 的） */
  csrf?: { header: string; from: "meta" | "cookie"; name: string }
}

export interface FetchResult {
  status: number
  /** 2xx。4xx、5xx 不抛错，自己看 status（401、403 多半是登录过期了） */
  ok: boolean
  contentType: string
  /** 返回体的字节数 */
  bytes: number
  /** 解析好的 JSON（像密码、token 这类字段的值换成了 ••••） */
  json?: unknown
  /** 不是 JSON 的文字 */
  text?: string
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
    /**
     * 复制图片，相当于在图片上「右键 → 复制图片」（工具 browser.copy_image）：取原图（拿不到就截元素），转成 PNG 写进剪贴板，
     * 同时存成这次运行的文件。target 和坐标 x、y 二选一，优先写 target。之后 click 到要放的位置，再 clipboardPaste({ fileId })
     */
    copyImage(args: CopyImageArgs): Promise<CopyImageResult>
    /**
     * 读剪贴板（工具 browser.clipboard_read）：copy: true 先在当前焦点处按一次 Ctrl+C（先选中要复制的区域）。
     * 返回完整内容：表格给 table，别的文字给 text，图片存成文件给 fileId；剪贴板是空的返回 {}
     */
    clipboardRead(args?: { copy?: boolean }): Promise<ClipboardContent>
    /**
     * 粘贴（工具 browser.clipboard_paste）：把内容写进剪贴板，在当前焦点处按 Ctrl+V。三选一：text 文字；table 表格（一行一个数组，编成表格软件认的格式）；
     * fileId 这次运行里的图片文件（copyImage 返回的、附件）。不替你点位置：先 click 到要贴的格子 / 编辑区。
     * 粘贴会改页面上的内容：前面先 ha.commit
     */
    clipboardPaste(args: { text: string } | { table: string[][] } | { fileId: string }): Promise<string>
    /**
     * 直接调网站的接口（工具 browser.fetch，任务要打开「允许直接调网站接口」）：在当前页面里发请求，带着浏览器的登录态。
     * 先 navigate 打开这个网站的一个页面（登录态、同源都靠它）。读列表、翻页、查详情时比一页页点快得多；
     * 只调过程里记下的接口（network/requests.jsonl），不要猜。连不上、超时、接口要跳转（多半登录过期）抛 StepError
     */
    fetch(args: FetchArgs): Promise<FetchResult>
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

  /**
   * 任务里的任何别的工具：HTTP、MCP、比物、图库，也包括上面没有包装的浏览器工具（browser.xxx）。
   * id 照过程记录里写的工具 id（例如 "browser.navigate_back"、"gallery.search"），input 和 agent 那次调用的参数一样（快照 ref 换成定位）。
   * 返回 { text, data }：data 是结构化结果（HTTP 工具返回的 JSON 等），没有是 undefined
   */
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
  /**
   * 判断题：要看内容判断的那一步（这条是不是投诉、两段描述是不是同一个商品、该选哪一类）交给这次运行的执行模型答。
   * 尽量给 choices，answer 只会是其中之一（两次都答在选项外抛 StepError）。每次判断都花钱、记一条过程「流程判断：问题 → 答案（理由）」；
   * 固化流程停下等人后接着跑时，判断过的回记下的答案，不再问模型。能用固定规则判断的（比大小、看有没有某个字）不要用它
   */
  judge(args: JudgeArgs): Promise<JudgeResult>

  StepError: typeof StepError
  Denied: typeof Denied
  RoutineStop: typeof RoutineStop
}

declare const ha: Heyagent
export default ha
