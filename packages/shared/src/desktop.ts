// 桌面（docs/dev/desktop.md）：和「浏览器」平级的第二种运行环境。一台桌面 = 一台装了「桌面服务」的 Windows 电脑（虚拟机或实体机）：
// - Windows-MCP（锁定 0.8.8，streamable-http）给 agent 读界面控件、点击、输入；
// - 我们自己的桌面服务（apps/desktop-agent）推画面、回传键鼠、截图、传文件。
// 两个服务用同一个密钥（Authorization: Bearer），密钥只存密文。同一时间一台桌面只给一个运行用。
import { z } from "zod"

import { viewerClientMessageSchema } from "./browser-runtime.js"

const text = (message: string, max: number) => z.string({ error: message }).trim().min(1, message).max(max, `最多 ${max} 个字`)
const httpUrl = (message: string) =>
  z
    .string({ error: message })
    .trim()
    .min(1, message)
    .max(500)
    .regex(/^https?:\/\/[^\s/]+(\/\S*)?$/, "以 http:// 或 https:// 开头，例如 http://10.0.0.21:8000/mcp")

/** 系统自带的「桌面」工具（来源 builtin）：任务选了它，就开放整组 desktop.* 工具 */
export const DESKTOP_TOOL_ID = "desktop"

// ---------- 配置 ----------

export const desktopInputSchema = z.object({
  name: text("起个名字，例如「运营 1 号机」", 100),
  /** 给 agent 看的说明：装了哪些软件、登的哪个账号，agent 按它挑桌面 */
  description: z.string().trim().max(1000, "最多 1000 个字").default(""),
  /** Windows-MCP 的地址（streamable-http），例如 http://10.0.0.21:8000/mcp */
  mcpUrl: httpUrl("填 Windows-MCP 的地址"),
  /** 桌面服务的地址，例如 http://10.0.0.21:8001 */
  agentUrl: httpUrl("填桌面服务的地址"),
  /** 两个服务共用的密钥；编辑时不填 = 不改 */
  key: z.string().trim().max(500).optional(),
})
export type DesktopInput = z.input<typeof desktopInputSchema>
export const desktopCreateSchema = desktopInputSchema.extend({ key: z.string().trim().min(16, "密钥至少 16 位").max(500) })
export const desktopUpdateSchema = desktopInputSchema.extend({ id: z.string().min(1) })

/** 桌面现在的占用情况：free 空着；running 有运行在用；held 等人处理（转人工时保留给原来的运行） */
export const desktopUseStateSchema = z.enum(["free", "running", "held"])
export type DesktopUseState = z.infer<typeof desktopUseStateSchema>

export const desktopSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  mcpUrl: z.string(),
  agentUrl: z.string(),
  /** 密钥掩码，例如 ••••3f2a；没存 = 空串 */
  keyMask: z.string(),
  use: z.object({
    state: desktopUseStateSchema,
    sessionId: z.string().optional(),
    taskTitle: z.string().optional(),
    since: z.string().optional(),
    /** held 时保留到什么时候 */
    holdUntil: z.string().optional(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Desktop = z.infer<typeof desktopSchema>

/** 「测试连接」的结果：两个服务分开报 */
export const desktopHealthSchema = z.object({
  mcp: z.object({ ok: z.boolean(), ms: z.number(), error: z.string().optional(), toolCount: z.number().optional() }),
  agent: z.object({
    ok: z.boolean(),
    ms: z.number(),
    error: z.string().optional(),
    version: z.string().optional(),
    screen: z.object({ width: z.number(), height: z.number() }).optional(),
  }),
})
export type DesktopHealth = z.infer<typeof desktopHealthSchema>

/** 运行详情 / 要人办的事：这个运行有没有占着桌面，当前用户能不能操作 */
export const sessionDesktopSchema = z.object({
  open: z.boolean(),
  desktopId: z.string().optional(),
  desktopName: z.string().optional(),
  state: desktopUseStateSchema.optional(),
  canControl: z.boolean(),
})
export type SessionDesktop = z.infer<typeof sessionDesktopSchema>

// ---------- 运行时 ----------

/** 等某台桌面空出来（session_waits.event） */
export const desktopEventName = (desktopId: string) => `desktop:${desktopId}`
/** 等任务允许的任意一台桌面空出来 */
export const ANY_DESKTOP_EVENT = "desktop:any"

/** 运行快照里的「桌面」一节：任务选了「桌面」工具才有 */
export const sessionDesktopSnapshotSchema = z.object({
  desktops: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() })),
  /** 允许看画面：desktop.look 截图发给模型、desktop.snapshot 带截图 */
  allowVision: z.boolean().default(false),
})
export type SessionDesktopSnapshot = z.infer<typeof sessionDesktopSnapshotSchema>

/**
 * 开放给 agent 的 Windows-MCP 工具（白名单，锁定 Windows-MCP 0.8.8 的工具名）。
 * 不在表里的一律不开放：PowerShell、FileSystem、Registry、Process、Scrape、Notification 能直接改系统或上网，
 * Screenshot 由 desktop.look 代替（要「允许看画面」），ControlStatus / DisplayInventory 对 agent 没用
 */
export const DESKTOP_MCP_TOOLS = {
  "desktop.snapshot": "Snapshot",
  "desktop.click": "Click",
  "desktop.type": "Type",
  "desktop.scroll": "Scroll",
  "desktop.move": "Move",
  "desktop.shortcut": "Shortcut",
  "desktop.wait": "Wait",
  "desktop.wait_for": "WaitFor",
  "desktop.app": "App",
  "desktop.clipboard": "Clipboard",
  "desktop.multi_select": "MultiSelect",
  "desktop.multi_edit": "MultiEdit",
} as const
export type DesktopMcpToolId = keyof typeof DESKTOP_MCP_TOOLS

/** 我们自己的桌面工具 */
export const DESKTOP_OWN_TOOLS = ["desktop.use", "desktop.look", "desktop.send_file", "desktop.fetch_file", "desktop.ask_human"] as const

/** 会改桌面状态的工具（规则「调工具前审批」按 risk 判断）。调完不额外截图（免得文件太多）：截图只在 desktop.look、desktop.ask_human 和规则「截图存证」时存 */
export const DESKTOP_WRITE_TOOLS: ReadonlySet<string> = new Set([
  "desktop.click",
  "desktop.type",
  "desktop.scroll",
  "desktop.move",
  "desktop.shortcut",
  "desktop.app",
  "desktop.clipboard",
  "desktop.multi_select",
  "desktop.multi_edit",
  "desktop.send_file",
])

// ---------- 远程画面（桌面服务 ⇄ API ⇄ 控制台） ----------
// 二进制消息 = 一帧 JPEG（缩到最宽 1280）。坐标一律是桌面屏幕的物理像素（meta.width / height），控制台按它换算。
// 浏览器 → 服务端的鼠标、键盘、文字消息沿用 viewerClientMessageSchema 的 mouse / key / text 三种；另加 combo（组合键按钮）。

export type DesktopViewerServerMessage =
  | { t: "meta"; width: number; height: number; canControl: boolean }
  | { t: "closed"; reason: string }
  /** 桌面上鼠标的位置（agent 或人动的都算），控制台画虚拟光标 */
  | { t: "cursor"; x: number; y: number; kind: "move" | "press" }
  | { t: "agentAction"; label: string }

/** 浏览器里按不出来的组合键（会被本机系统截走），工具栏上用按钮发。Ctrl+Alt+Del 是安全键，模拟不了，不提供 */
export const desktopComboSchema = z.enum(["win", "alt+tab", "alt+f4", "win+d", "win+r"])
export type DesktopCombo = z.infer<typeof desktopComboSchema>
export const desktopComboMessageSchema = z.object({ t: z.literal("combo"), keys: desktopComboSchema })

const [mouseMessage, keyMessage, textMessage] = viewerClientMessageSchema.options
/** 控制台 → 桌面的消息：浏览器那套的 mouse / key / text，加 combo。API 和桌面服务都按它校验，不认识的丢弃 */
export const desktopViewerClientMessageSchema = z.discriminatedUnion("t", [mouseMessage, keyMessage, textMessage, desktopComboMessageSchema])
export type DesktopViewerClientMessage = z.infer<typeof desktopViewerClientMessageSchema>
