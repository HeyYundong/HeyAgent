// 开放给 agent 的 Windows-MCP（锁定 0.8.8）工具：白名单见 shared 的 DESKTOP_MCP_TOOLS。
// 参数 schema 写死在这里（照 0.8.8 的 inputSchema 抄，类型收窄成简单的：布尔就是布尔、坐标就是 [x, y]），
// 不用连上桌面就能建工具组。说明改成简短中文。坐标一律是桌面屏幕的像素，原点在左上角。
import { DESKTOP_MCP_TOOLS, type DesktopMcpToolId, type Risk } from "@heyagent/shared"
import { z } from "zod"

const point = (what: string) => z.array(z.number().int()).length(2).describe(what)
const loc = point("屏幕坐标 [x, y]（像素，原点在左上角）。和 label 二选一")
const label = z.number().int().min(0).describe("desktop_snapshot 列出的控件编号（label）。和 loc 二选一，优先用它")

export interface DesktopMcpToolDef {
  id: DesktopMcpToolId
  /** Windows-MCP 上的工具名 */
  mcpName: string
  name: string
  summary: string
  description: string
  risk: Risk
  /** 给模型的参数；vision：任务打开了「允许看画面」 */
  schema: (vision: boolean) => z.ZodObject
  /** 我们的参数 → Windows-MCP 的参数（不给 = 原样） */
  toArgs?: (input: Record<string, unknown>, vision: boolean) => Record<string, unknown>
}

const snapshotBase = {
  use_ui_tree: z.boolean().default(true).describe("读界面控件树（窗口、按钮、输入框和它们的编号），默认读"),
  use_dom: z.boolean().default(false).describe("前台是浏览器时读网页内容（DOM）。一般不用"),
  display: z.array(z.number().int().min(0)).optional().describe("只看哪几块屏幕（编号从 0 开始），不填 = 全部"),
  region: z.array(z.number().int()).length(4).optional().describe("只看屏幕上的一块：[左, 上, 右, 下]（像素）"),
}

const visionSnapshot = {
  use_vision: z.boolean().default(false).describe("同时截一张图发给你看（多一张图的费用，控件树看不到内容时才用）"),
  use_annotation: z.boolean().default(true).describe("截图上标出控件编号（use_vision 时才有用）"),
  width_reference_line: z.number().int().min(1).optional().describe("截图上画几条竖的参考线，帮你估坐标（use_vision 时才有用）"),
  height_reference_line: z.number().int().min(1).optional().describe("截图上画几条横的参考线（use_vision 时才有用）"),
}

export const DESKTOP_MCP_TOOL_DEFS: DesktopMcpToolDef[] = [
  {
    id: "desktop.snapshot",
    mcpName: DESKTOP_MCP_TOOLS["desktop.snapshot"],
    name: "桌面：看界面",
    summary: "读桌面现在的样子：打开的窗口、前台窗口里的控件（按钮、输入框、列表项）和它们的编号 label、坐标",
    description:
      "读桌面现在的样子：打开了哪些窗口、前台窗口里有哪些控件（名字、类型、编号 label、坐标）、能滚动的区域。点击、输入前先调它，再按 label 操作。界面变了（打开窗口、切换页面）要重新调。",
    risk: "read",
    schema: (vision) => z.object(vision ? { ...snapshotBase, ...visionSnapshot } : snapshotBase),
    // 没有「允许看画面」：一律不截图
    toArgs: (input, vision) => (vision ? input : { ...input, use_vision: false }),
  },
  {
    id: "desktop.click",
    mcpName: DESKTOP_MCP_TOOLS["desktop.click"],
    name: "桌面：点击",
    summary: "点一个控件（按 label）或屏幕上的一个点（按坐标）：左键 / 右键 / 中键，单击 / 双击 / 只移过去",
    description: "点一个控件或屏幕上的一个点。label（desktop_snapshot 给的编号）和 loc（坐标）二选一，优先用 label。clicks：1 单击、2 双击、0 只把鼠标移过去（悬停）。",
    risk: "external",
    schema: () =>
      z.object({
        loc: loc.optional(),
        label: label.optional(),
        button: z.enum(["left", "right", "middle"]).default("left").describe("哪个键，默认左键"),
        clicks: z.number().int().min(0).max(3).default(1).describe("点几下：0 悬停、1 单击、2 双击"),
      }),
  },
  {
    id: "desktop.type",
    mcpName: DESKTOP_MCP_TOOLS["desktop.type"],
    name: "桌面：输入文字",
    summary: "先点一下输入框（按 label 或坐标），再输入文字；可以先清空、输完按回车",
    description:
      "在输入框里输入文字：先点 label 或 loc 指的位置，再输入 text（中文也行）。clear：先清空原来的内容；caret_position：光标先放到开头（start）、结尾（end）或不动（idle）；press_enter：输完按回车（发送消息、提交搜索时用，注意有的软件回车就是发送）。",
    risk: "external",
    schema: () =>
      z.object({
        text: z.string().min(1).max(10_000).describe("要输入的文字（最多 1 万字）"),
        loc: loc.optional(),
        label: label.optional(),
        clear: z.boolean().default(false).describe("先清空输入框原来的内容"),
        caret_position: z.enum(["start", "idle", "end"]).default("idle").describe("输入前光标放哪：start 开头、end 结尾、idle 不动"),
        press_enter: z.boolean().default(false).describe("输完按回车"),
      }),
  },
  {
    id: "desktop.scroll",
    mcpName: DESKTOP_MCP_TOOLS["desktop.scroll"],
    name: "桌面：滚动",
    summary: "在一个控件或位置上滚动鼠标滚轮：上下或左右，滚几格",
    description: "在 label 或 loc 指的位置滚动（都不给就在鼠标现在的位置）。type：vertical 上下、horizontal 左右；direction：up / down / left / right；wheel_times：滚几格。",
    risk: "external",
    schema: () =>
      z.object({
        loc: loc.optional(),
        label: label.optional(),
        type: z.enum(["horizontal", "vertical"]).default("vertical").describe("上下（vertical）还是左右（horizontal）"),
        direction: z.enum(["up", "down", "left", "right"]).default("down").describe("往哪滚"),
        wheel_times: z.number().int().min(1).max(50).default(1).describe("滚几格"),
      }),
  },
  {
    id: "desktop.move",
    mcpName: DESKTOP_MCP_TOOLS["desktop.move"],
    name: "桌面：移动 / 拖动鼠标",
    summary: "把鼠标移到一个控件或位置；drag 时按住左键拖过去（拖文件、拖滑块）",
    description: "把鼠标移到 label 或 loc 指的位置。drag = true 时按住左键拖过去：从 from_loc（不给就从鼠标现在的位置）拖到目标。duration：移动用几秒（拖得太快有的软件认不出来）。",
    risk: "external",
    schema: () =>
      z.object({
        loc: loc.optional(),
        label: label.optional(),
        drag: z.boolean().default(false).describe("按住左键拖过去"),
        from_loc: point("拖动的起点 [x, y]，不给就从鼠标现在的位置").optional(),
        duration: z.number().min(0).max(10).optional().describe("移动用几秒"),
      }),
  },
  {
    id: "desktop.shortcut",
    mcpName: DESKTOP_MCP_TOOLS["desktop.shortcut"],
    name: "桌面：按快捷键",
    summary: "按一个键或组合键，例如 enter、esc、ctrl+c、ctrl+v、alt+tab、win+d",
    description: "按一个键或组合键：几个键用 + 连起来，例如 enter、esc、tab、ctrl+a、ctrl+c、ctrl+v、ctrl+s、alt+tab、alt+f4、win+d。",
    risk: "external",
    schema: () => z.object({ shortcut: z.string().min(1).max(100).describe("键或组合键，例如 ctrl+c") }),
  },
  {
    id: "desktop.wait",
    mcpName: DESKTOP_MCP_TOOLS["desktop.wait"],
    name: "桌面：等几秒",
    summary: "等几秒（等软件打开、页面加载）",
    description: "等 duration 秒再接着做（等软件打开、窗口加载、消息发出去）。等某个东西出现用 desktop_wait_for 更准。",
    risk: "read",
    schema: () => z.object({ duration: z.number().int().min(1).max(120).describe("等几秒") }),
  },
  {
    id: "desktop.wait_for",
    mcpName: DESKTOP_MCP_TOOLS["desktop.wait_for"],
    name: "桌面：等到出现",
    summary: "等到某个条件成立：屏幕上出现某段文字、某个窗口到了前台、某个控件出现或能点、焦点到了某处",
    description:
      "一直查，直到条件成立或超时：text_exists 出现文字 text；active_window 前台窗口的标题包含 window_name；element_exists / element_enabled 名字是 text 的控件出现 / 能点；focused_element 焦点在名字是 text 的控件上。timeout 最多等几秒（默认 10），interval 几秒查一次。",
    risk: "read",
    schema: () =>
      z.object({
        condition: z.enum(["text_exists", "active_window", "element_exists", "element_enabled", "focused_element"]).describe("等什么"),
        text: z.string().optional().describe("文字或控件名字"),
        window_name: z.string().optional().describe("窗口标题（condition = active_window 时）"),
        timeout: z.number().min(0.5).max(120).default(10).describe("最多等几秒"),
        interval: z.number().min(0.1).max(10).default(0.25).describe("几秒查一次"),
        use_dom: z.boolean().default(false).describe("前台是浏览器时在网页内容里找。一般不用"),
      }),
  },
  {
    id: "desktop.app",
    mcpName: DESKTOP_MCP_TOOLS["desktop.app"],
    name: "桌面：打开 / 切换窗口",
    summary: "按名字打开软件（开始菜单里的名字）、切换到已经打开的窗口、调整窗口位置和大小",
    description:
      "mode：launch 按名字打开软件（开始菜单里搜得到的名字，例如「记事本」或 notepad）；switch 把名字是 name 的窗口切到前台；resize 调整窗口（window_loc 左上角位置、window_size 宽高）。打开后用 desktop_wait_for 或 desktop_snapshot 确认窗口出来了。",
    risk: "external",
    schema: () =>
      z.object({
        mode: z.enum(["launch", "switch", "resize"]).default("launch").describe("launch 打开、switch 切换、resize 调整窗口"),
        name: z.string().optional().describe("软件或窗口的名字"),
        window_loc: point("窗口左上角 [x, y]（resize 时）").optional(),
        window_size: point("窗口宽高 [宽, 高]（resize 时）").optional(),
      }),
  },
  {
    id: "desktop.clipboard",
    mcpName: DESKTOP_MCP_TOOLS["desktop.clipboard"],
    name: "桌面：剪贴板",
    summary: "读桌面的剪贴板（get），或把一段文字放进剪贴板（set），配合 ctrl+c / ctrl+v 大块复制粘贴",
    description: "mode = get 读剪贴板里的文字（先选中内容按 ctrl+c）；mode = set 把 text 放进剪贴板（再按 ctrl+v 粘贴，大段文字比逐字输入快、不受输入法影响）。",
    risk: "external",
    schema: () =>
      z.object({
        mode: z.enum(["get", "set"]).describe("get 读、set 写"),
        text: z.string().optional().describe("要放进剪贴板的文字（set 时）"),
      }),
  },
  {
    id: "desktop.multi_select",
    mcpName: DESKTOP_MCP_TOOLS["desktop.multi_select"],
    name: "桌面：多选",
    summary: "按住 Ctrl 依次点几个控件或位置，一次选中多个（文件、列表项）",
    description: "依次点 labels（控件编号）或 locs（坐标）里的每一个，默认按住 Ctrl（一次选中多个文件、列表项）。",
    risk: "external",
    schema: () =>
      z.object({
        labels: z.array(z.number().int().min(0)).optional().describe("控件编号，和 locs 二选一"),
        locs: z.array(point("[x, y]")).optional().describe("坐标列表"),
        press_ctrl: z.boolean().default(true).describe("点的时候按住 Ctrl"),
      }),
  },
  {
    id: "desktop.multi_edit",
    mcpName: DESKTOP_MCP_TOOLS["desktop.multi_edit"],
    name: "桌面：填多个输入框",
    summary: "一次往几个输入框里填文字（填表单）",
    description: "items 里每一项是一个输入框：label（控件编号）或 loc（坐标）二选一，加上要填的 text。按顺序点一下再输入。",
    risk: "external",
    schema: () =>
      z.object({
        items: z
          .array(z.object({ label: label.optional(), loc: loc.optional(), text: z.string() }))
          .min(1)
          .max(50)
          .describe("要填的输入框"),
      }),
    // Windows-MCP 的格式：labels = [[label, text]]，locs = [[x, y, text]]
    toArgs: (input) => {
      const items = (input.items ?? []) as { label?: number; loc?: number[]; text: string }[]
      const labels = items.filter((item) => item.label !== undefined).map((item) => [item.label!, item.text])
      const locs = items.filter((item) => item.label === undefined && item.loc).map((item) => [item.loc![0], item.loc![1], item.text])
      return { ...(labels.length ? { labels } : {}), ...(locs.length ? { locs } : {}) }
    },
  },
]
