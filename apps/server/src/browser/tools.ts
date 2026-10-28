// 「浏览器」工具组（m2.md 第 1、5、6、7 条）：任务选了系统自带的「浏览器」工具，工具网关就开放这一组：
// - Chrome 配置由系统分配：第一次调浏览器工具时从任务允许的里挑一个空闲的（每个 Chrome 同一时间只给一个运行用），
//   全被占着就挂起「等待浏览器」，有一个空出来时按挂起的先后叫醒；
// - 一个运行从头到尾只用一个 Chrome，绝不切换：分到以后（记在 sessions.browser_profile_id）挂起再继续时它被占着，就等它；
// - browser.use({ profileId })：可选，只能在还没分到 Chrome 时调，任务要求用某个特定 Chrome 时才用（被占着就等它）；
// - Playwright MCP 的工具，browser_xxx 统一换成 browser.xxx（给模型的名字把点换成下划线，又变回 browser_xxx）；
//   一律屏蔽 browser_run_code_unsafe，browser_evaluate 要任务里打开「允许执行脚本」才给；
//   按坐标操作的工具（browser_mouse_click_xy 等）和 browser.look（截当前画面发给模型）要打开「允许看画面」才给；
// - 剪贴板工具 browser.copy_image / clipboard_read / clipboard_paste（browser/clipboard.ts），在线表格、文档大块读写数据、贴图用；
// - browser.batch：连着做几步（docs/dev/browser-speed.md A），定义在这里，在工具网关里展开（每一步走一次普通调用）；
// - browser.extract / browser.wait_any：按定位读页面、等几种结果里的一个（docs/dev/solidify.md 4.5，browser/extract.ts），只读；
// - browser.fetch：在当前页面里带着登录态直接调网站的接口（docs/dev/solidify.md 19.4，browser/site-api.ts），任务打开「允许直接调网站接口」才有；
//   开着时还记下网页自己调的接口（browser/network-log.ts），每次浏览器工具调用结束时写进 network/requests.jsonl，网关把这一步记下的 seq 范围写进 trace.network；
// - 录（docs/dev/solidify.md 3.1）：MCP 输出里的 ### Ran Playwright code 从给模型的输出里拿掉，连同动作前后的网址放进 ToolOutcome，网关存进过程记录。
// 每次调用：调之前查导航参数（白名单、账号租约）→ 交给 MCP（被弹窗挡住时认得出的无害关闭按钮点掉、再做一次）→ 调完后兜底扫一遍页面、
// 取走被拦下的导航、跳转后在后台截图存档、检测验证码和登录页 → 末尾附上页面概况（标题网址、弹窗、文件选择框，page-brief.ts）。验证码先自己试着过（设置里的开关，captcha.ts），
// 过不了的和登录页（存了密码的先自动登录）截图、生成「登录」类要人办的事、session 等人处理，Chrome 保留着。
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { extname, join } from "node:path"

import { eq, lt, sql } from "drizzle-orm"
import {
  BROWSER_FETCH_TOOL,
  browserFetchInputSchema,
  FETCH_MAX_BYTES,
  FETCH_OUTPUT_MAX_CHARS,
  FETCH_TIMEOUT_MS,
  NETWORK_LOG_PATH,
  type BrowserFetchInput,
  browserActionLabel,
  browserActionTag,
  hostOf,
  ANY_PROFILE_EVENT,
  leaseEventName,
  profileEventName,
  urlAllowed,
  type HumanDetail,
  type McpToolInfo,
  type SessionSnapshot,
  type SnapshotTool,
} from "@heyagent/shared"
import { z } from "zod"

import { readBrowserSettings } from "../data/config/settings.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { getFileRow, readFileData, saveFile, safeFileName } from "../files/service.js"
import { callModel, resolveModel } from "../engine/model.js"
import { notifyUsers, sessionLink } from "../engine/notify.js"
import { appendEvent } from "../engine/records.js"
import { getKeyring } from "../engine/runtime.js"
import { loadEngineSettings } from "../engine/settings.js"
import type { SessionRow, ToolOutcome } from "../engine/tools/builtin.js"
import { executeMcpTool, type McpConnection } from "../engine/tools/mcp.js"
import { judgePage, parseVisionAnswer, providerCaptchaNote, VISION_PROMPT, type Verdict } from "./detect.js"
import { autoLogin, loadAccountPassword, loginModelId, type AutoLoginCaptcha } from "./auto-login.js"
import { CAPTCHA_MAX_TRIES, solveCaptcha, type CaptchaResult, type CaptchaTry } from "./captcha.js"
import { ClipboardTools, imageSize } from "./clipboard.js"
import {
  EXTRACT_DEFAULT_ROWS,
  EXTRACT_MAX_ROWS,
  extractRows,
  formatExtract,
  WAIT_ANY_DEFAULT_SECONDS,
  WAIT_ANY_MAX_SECONDS,
  waitAnyOutcome,
  type ExtractInput,
} from "./extract.js"
import { ProfileFullError, type BlockedNavigation, type BrowserInstance } from "./instance.js"
import { accountForHost, busyProfileIds } from "./leases.js"
import { getBrowserManager } from "./manager.js"
import { BLOCKED_MCP_TOOLS, EVALUATE_TOOL, listBrowserMcpTools, VISION_MCP_TOOLS } from "./mcp.js"
import { blockedKind, DISMISS_ATTR, explainError, formatBrief, modalGuidance, overlayText, readPageBrief, stripAnsi, stripPageSections } from "./page-brief.js"
import { fetchAuthHint, fetchTargetAllowed, maskBody, maskJson, maskNetworkOutput, maskUrl, NEED_PAGE, sendInPage } from "./site-api.js"
import { phaseTimer, recordBrowserTiming } from "./timing.js"

/** 一次 MCP 动作录下的：代码、做之前的网址（callMcp 收尾时再读做之后的网址、标题） */
interface Recorded {
  instance?: BrowserInstance
  urlBefore?: string
  code?: string
}

export interface BrowserToolEntry {
  id: string
  def: SnapshotTool
  jsonSchema: Record<string, unknown>
  validator: z.ZodType
  execute: (input: unknown) => Promise<ToolOutcome>
}

interface Ctx {
  db: Db
  session: SessionRow
  snapshot: SessionSnapshot
}

const fail = (output: string): ToolOutcome => ({ output, isError: true })

type Hit = NonNullable<Awaited<ReturnType<BrowserInstance["detect"]>>>
/** 检测到的验证码 / 登录页；byVision：规则拿不准、视觉模型判断的 */
type HumanHit = Omit<Hit, "verdict"> & { verdict: Exclude<Verdict, { kind: "none" | "uncertain" }>; byVision?: boolean }

const FILL_CAPTCHA_TOOL = "browser.fill_captcha"
const LOOK_TOOL = "browser.look"
export const BATCH_TOOL = "browser.batch"
export const EXTRACT_TOOL = "browser.extract"
export const WAIT_ANY_TOOL = "browser.wait_any"
/** 批里一次最多几步 */
export const BATCH_MAX_STEPS = 20
/** 批做完附的快照默认多深 */
export const BATCH_SNAPSHOT_DEPTH = 6

/** 同一个页面（主机名 + 路径）：自动过验证码按页面数次数 */
function pageKey(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`
  } catch {
    return url
  }
}

/** 会改变页面、调完要截图存档的工具 */
const NAVIGATION_TOOLS = new Set(["browser_navigate", "browser_navigate_back"])
/** 只读的工具：调完不用扫页面、不用检测 */
const READ_ONLY_TOOLS = new Set(["browser_snapshot", "browser_find", "browser_console_messages", "browser_network_requests", "browser_network_request", "browser_take_screenshot"])
/** 看网页请求的：输出里请求头、返回头的值按名字打码（maskNetworkOutput） */
const NETWORK_TOOLS = new Set(["browser_network_requests", "browser_network_request"])
/** 点元素的动作：被弹窗挡住时（Playwright 的 intercepts pointer events，或超时且认出了弹窗）先试着关掉弹窗再做一次 */
const POINTER_TOOLS = new Set(["browser_click", "browser_hover", "browser_type", "browser_fill_form", "browser_select_option", "browser_check", "browser_uncheck", "browser_drag", "browser_press_sequentially"])
/** 不能放进 browser.batch 的：batch 自己、指定 Chrome、只读的（看页面的放最后由 snapshot 参数做） */
const NOT_BATCHABLE = new Set([BATCH_TOOL, "browser.use", LOOK_TOOL, EXTRACT_TOOL, WAIT_ANY_TOOL, BROWSER_FETCH_TOOL, "browser.clipboard_read", ...[...READ_ONLY_TOOLS].map((name) => browserToolIdOf(name))])

function browserToolIdOf(mcpName: string) {
  return `browser.${mcpName.replace(/^browser_/, "")}`
}

/** 批里的 tool 写法（click、browser_click、browser.click 都认）→ 工具 id */
export function batchToolId(tool: string) {
  return `browser.${tool.trim().replace(/^browser[._]/, "")}`
}

/** 这个工具能不能放进 browser.batch（还要是这个任务给了的） */
export const batchable = (toolId: string) => toolId.startsWith("browser.") && !NOT_BATCHABLE.has(toolId)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** 浏览器工具调用结束时，最多等这么久让这一步触发的网页请求记完（算进这一步的 trace.network） */
const NETWORK_DRAIN_MS = 800

/** 字节数写成给人看的（512 B、17.9 KB、1.2 MB） */
export function sizeText(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** MCP 输出里的 ### Ran Playwright code 段（--codegen typescript：```js 代码框） */
const CODE_SECTION = /(^|\n)### Ran Playwright code\n```[a-z]*\n([\s\S]*?)\n```[ \t]*(?=\n|$)/

/** 把录下的 Playwright 代码从输出里拿出来（给模型的输出和关着 codegen 时一样，不多花 token） */
export function takeCode(output: string): { output: string; code?: string } {
  const match = CODE_SECTION.exec(output)
  if (!match) return { output }
  const rest = (output.slice(0, match.index) + output.slice(match.index + match[0].length)).trim()
  return { output: rest || "（没有返回内容）", code: match[2]!.trim() || undefined }
}

/** 定位：JS 写法或选择器字符串（docs/dev/solidify.md 15.2 第 2 条） */
const TARGET_HELP =
  "定位的写法和动作的 target 一样：选择器字符串（role=button[name=\"查询\"]、text=暂无数据、CSS），或者 Playwright 的写法（getByRole('row').nth(1)、getByText('暂无数据')、getByLabel('单号')、locator('css')，可以接 .first() .last() .nth(n) .filter({ hasText })）。不能用快照 ref（e12）"
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"])
const PROXY_ERROR = /ERR_(SOCKS_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_HOST_UNREACHABLE|PROXY_AUTH_UNSUPPORTED)/

export const browserToolId = browserToolIdOf

function zodFromJsonSchema(schema: Record<string, unknown>): z.ZodType {
  try {
    return z.fromJSONSchema(schema as Parameters<typeof z.fromJSONSchema>[0])
  } catch {
    return z.record(z.string(), z.unknown())
  }
}

/** MCP 的参数 schema 改成我们的：文件用 session 文件 id（网关换成路径）；去掉「存到文件」的参数（agent 读不到 MCP 的目录） */
export function adaptSchema(tool: McpToolInfo): Record<string, unknown> {
  const schema = structuredClone(tool.inputSchema) as { properties?: Record<string, unknown>; required?: string[]; $schema?: unknown }
  delete schema.$schema
  const properties = (schema.properties ??= {})
  const drop = (name: string) => {
    delete properties[name]
    if (schema.required) schema.required = schema.required.filter((each) => each !== name)
  }
  if (tool.name !== "browser_take_screenshot") drop("filename")
  if (tool.name === "browser_file_upload" || tool.name === "browser_drop") {
    const required = schema.required?.includes("paths")
    drop("paths")
    properties.fileIds = {
      type: "array",
      items: { type: "string" },
      description:
        tool.name === "browser_file_upload"
          ? "要上传的文件 id（这次运行的附件或产物，见系统提示或工具输出里的文件 id）。不给就取消文件选择框"
          : "要拖进去的文件 id（这次运行的附件或产物）",
    }
    if (required) schema.required = [...(schema.required ?? []), "fileIds"]
  }
  if (tool.name === "browser_take_screenshot") {
    const filename = properties.filename as { description?: string } | undefined
    if (filename) filename.description = "截图的文件名（可不填）。截图只存档留证（存成这次运行的文件），不会发给你"
  }
  return schema
}

function listImages(dir: string, out: string[] = []): string[] {
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of entries) {
    const path = join(dir, name)
    try {
      const stat = statSync(path)
      if (stat.isDirectory()) {
        if (name !== "uploads") listImages(path, out)
      } else if (IMAGE_EXT.has(extname(name).toLowerCase())) out.push(path)
    } catch {
      // 刚被删掉
    }
  }
  return out
}

export class BrowserTools {
  private readonly ctx: Ctx
  private readonly mcpTools: McpToolInfo[]
  /** 这次运行分到的 Chrome（系统挑的或 browser.use 指定的）。分到以后从头到尾只用它 */
  private assigned?: string
  private instance?: BrowserInstance
  private proxyWarned = false
  /** 每个页面自动过验证码试了几次（问一次视觉模型算一次） */
  private readonly captchaTries = new Map<string, number>()
  /** 验证码在表单里的页面：等 agent 填好别的再调 browser_fill_captcha，检测到时不再自己提交、也不交给人 */
  private readonly captchaForms = new Set<string>()
  /** 起的时候设置里开着「遇到验证码先自己试着过」：开着才给 agent 填验证码的工具 */
  private captchaTool = false
  /** 遇到验证码 / 登录页挂起时：Chrome 保留多少分钟（gateway 关闭时交给 manager） */
  holdMinutes?: number
  private readonly clipboard: ClipboardTools
  /** 在 browser.batch 里：中间的步骤不读页面概况，批做完由网关统一附一次 */
  private batching = false
  /** 跳转后在后台存的存档截图（网关关闭时等它们存完） */
  private readonly pendingSaves = new Set<Promise<void>>()

  private constructor(ctx: Ctx, mcpTools: McpToolInfo[]) {
    this.ctx = ctx
    this.mcpTools = mcpTools
    this.assigned = ctx.session.browserProfileId ?? undefined
    this.clipboard = new ClipboardTools({
      db: ctx.db,
      session: ctx.session,
      attachmentIds: () => ctx.snapshot.attachments.map((file) => file.id),
      allowVision: () => this.allowVision,
      ensure: () => this.ensure(),
      // 网关内部用（找 ref 指的图）：不受「允许执行脚本」开关限制，也不给 agent
      evaluate: async (instance, input) => executeMcpTool(this.connection(instance, (await instance.ensureMcp()).client), EVALUATE_TOOL, input),
      record: (name, failed, url) => this.record(name, failed, url),
    })
  }

  /** 任务打开了「允许直接调网站接口」：browser.fetch + 记接口 */
  private get allowFetch() {
    return Boolean(this.ctx.snapshot.browser?.allowFetch)
  }

  /** 任务打开了「允许看画面」：browser.look + 坐标工具 */
  private get allowVision() {
    return Boolean(this.ctx.snapshot.browser?.allowVision)
  }

  static async create(ctx: Ctx): Promise<BrowserTools> {
    const tools = await listBrowserMcpTools()
    const group = new BrowserTools(ctx, tools)
    group.captchaTool = (await readBrowserSettings(ctx.db)).captchaSolve
    // 等人处理时保留着的 Chrome：session 继续了，接着用同一个（取消保留）
    const manager = getBrowserManager()
    const held = manager?.forSession(ctx.session.id)
    if (manager && held) {
      if (held.state === "held") await manager.claim(held)
      group.instance = held
      group.assigned ??= held.profileId
    }
    return group
  }

  private get profiles() {
    return this.ctx.snapshot.browser?.profiles ?? []
  }

  private profileName(id: string) {
    return this.profiles.find((profile) => profile.id === id)?.name ?? id
  }

  entries(): BrowserToolEntry[] {
    const browser = this.ctx.snapshot.browser
    const profileIds = this.profiles.map((profile) => profile.id)
    const useSchema = {
      type: "object",
      properties: {
        profileId: {
          type: "string",
          ...(profileIds.length ? { enum: profileIds } : {}),
          description: `Chrome 配置的 id。可选：${this.profiles.map((profile) => `${profile.id}（${profile.name}${profile.description ? `：${profile.description}` : ""}）`).join("；") || "无"}`,
        },
      },
      required: ["profileId"],
      additionalProperties: false,
    }
    const entries: BrowserToolEntry[] = [
      {
        id: "browser.use",
        def: {
          id: "browser.use",
          name: "浏览器：指定 Chrome",
          summary: "指定用哪个 Chrome 配置（一般不用调，系统会自动分配一个空闲的）",
          description: `一般不用调：第一次用浏览器工具时，系统会从本任务允许的 Chrome 里自动分配一个空闲的。只有任务要求用某个特定 Chrome 时才调，而且必须在第一次用浏览器工具之前调；它正被别的运行用着时会挂起，等它空出来。一次运行从头到尾只用一个 Chrome，分到（或指定）以后不能再换。本任务允许的：${this.profiles.map((profile) => `${profile.id}「${profile.name}」${profile.description ? `：${profile.description}` : ""}`).join("；") || "无"}。`,
          source: "builtin",
          risk: "read",
        },
        jsonSchema: useSchema,
        validator: z.object({ profileId: z.string().min(1) }),
        execute: (input) => this.use((input as { profileId: string }).profileId),
      },
    ]
    if (this.captchaTool)
      entries.push({
        id: FILL_CAPTCHA_TOOL,
        def: {
          id: FILL_CAPTCHA_TOOL,
          name: "浏览器：填验证码",
          summary: "让系统认出页面上的图片验证码（字母、数字）并填进验证码输入框，不提交",
          description: `页面表单里有图片验证码（字母、数字、简单算式）时调用：系统让视觉模型认出来，填进验证码输入框（不提交）；「我不是机器人」这类点一下的也能点。先填好表单的别的项，调完再点提交。提交后提示验证码不对就再调一次，每个页面最多 ${CAPTCHA_MAX_TRIES} 次；滑块、拼图、短信验证码这类过不了的会交给人处理。`,
          source: "builtin",
          risk: "external",
        },
        jsonSchema: { type: "object", properties: {}, additionalProperties: false },
        validator: z.object({}).passthrough(),
        execute: () => this.fillCaptcha(),
      })
    entries.push(...this.clipboard.entries())
    if (this.allowVision)
      entries.push({
        id: LOOK_TOOL,
        def: {
          id: LOOK_TOOL,
          name: "浏览器：看画面",
          summary: "截当前标签页的可见区域，作为图片发给你看（坐标和按坐标操作的工具一致）",
          description:
            "截当前标签页的可见区域，作为图片发给你看；截图里的像素和页面坐标一比一（视口 CSS 像素，原点在左上角），可以直接用于 browser_mouse_click_xy 等坐标工具。找菜单、确认操作结果、canvas 画出来的页面（在线表格的格子等）快照看不到时用；每看一次多一张图的费用，别每步都看。",
          source: "builtin",
          risk: "read",
        },
        jsonSchema: { type: "object", properties: {}, additionalProperties: false },
        validator: z.object({}).passthrough(),
        execute: () => this.look(),
      })
    entries.push(...this.readEntries())
    if (this.allowFetch) entries.push(this.fetchEntry())
    for (const tool of this.mcpTools) {
      if (BLOCKED_MCP_TOOLS.has(tool.name)) continue
      if (tool.name === EVALUATE_TOOL && !browser?.allowEvaluate) continue
      if (VISION_MCP_TOOLS.has(tool.name) && !this.allowVision) continue
      const id = browserToolId(tool.name)
      const schema = adaptSchema(tool)
      entries.push({
        id,
        def: {
          id,
          name: `浏览器：${tool.name.replace(/^browser_/, "")}`,
          summary: tool.description.split("\n")[0]!.slice(0, 200),
          description: tool.description,
          source: "builtin",
          risk: tool.name === EVALUATE_TOOL ? "write" : "external",
        },
        jsonSchema: schema,
        validator: zodFromJsonSchema(schema),
        execute: (input) => this.callMcp(tool.name, (input ?? {}) as Record<string, unknown>),
      })
    }
    const batchTools = entries.filter((entry) => batchable(entry.id)).map((entry) => entry.id.replace(/^browser\./, ""))
    entries.push({
      id: BATCH_TOOL,
      def: {
        id: BATCH_TOOL,
        name: "浏览器：连着做几步",
        summary: "按顺序连着做几步浏览器动作（哪一步出错就停），返回每步结果、页面概况和页面快照",
        description: `按顺序连着做 actions 里的几步浏览器动作，每一步和单独调用那个工具一样（规则、网址白名单、验证码 / 登录页检测都照常），哪一步出错就停，后面的不做。返回每步的结果、现在的页面概况和页面快照（默认 depth ${BATCH_SNAPSHOT_DEPTH}，snapshot: false 不要），不用再单独看页面。同一页面上能预见的几步（填表、点按钮、关弹窗、翻页）用它一次做完。tool 写工具名（click、browser_click 都行），input 和单独调用那个工具的参数一样；一次最多 ${BATCH_MAX_STEPS} 步。能放进来的：${batchTools.join("、")}；snapshot、find 这类只读的不能放（最后的页面由 snapshot 参数给）。跳转以后快照里的 ref 失效：跨页面的步骤用选择器当 target（role=button[name="继续录入"]、text=继续录入）。某一步要人审批时停在那一步之前，那一步要单独调用。`,
        source: "builtin",
        risk: "external",
      },
      jsonSchema: {
        type: "object",
        properties: {
          actions: {
            type: "array",
            minItems: 1,
            maxItems: BATCH_MAX_STEPS,
            description: "按顺序做的动作",
            items: {
              type: "object",
              properties: {
                tool: { type: "string", description: `工具名，例如 click、type、fill_form、press_key、navigate（能放的：${batchTools.join("、")}）` },
                input: { type: "object", description: "这个工具的参数（和单独调用时一样）", additionalProperties: true },
              },
              required: ["tool"],
              additionalProperties: false,
            },
          },
          snapshot: {
            description: `做完后附上的页面快照，默认 { "depth": ${BATCH_SNAPSHOT_DEPTH} }；false 不要`,
            anyOf: [{ type: "boolean", enum: [false] }, { type: "object", properties: { depth: { type: "integer", minimum: 1, maximum: 30 } }, additionalProperties: false }],
          },
        },
        required: ["actions"],
        additionalProperties: false,
      },
      validator: z.object({
        actions: z
          .array(z.object({ tool: z.string().min(1), input: z.record(z.string(), z.unknown()).optional() }))
          .min(1)
          .max(BATCH_MAX_STEPS),
        snapshot: z.union([z.literal(false), z.object({ depth: z.number().int().min(1).max(30).optional() })]).optional(),
      }),
      // 网关展开（每一步走一次普通调用），不会走到这里
      execute: async () => fail("browser.batch 要由工具网关展开"),
    })
    return entries
  }

  /** browser.extract、browser.wait_any：编排器自己的 Playwright 读页面，只读，不能放进 batch */
  private readEntries(): BrowserToolEntry[] {
    const target = { type: "string", minLength: 1 }
    const field = {
      anyOf: [
        { ...target, description: "字段的定位（相对这一行）" },
        {
          type: "object",
          properties: { target: { ...target, description: "字段的定位（相对这一行）" }, attr: { type: "string", minLength: 1, description: "取 HTML 属性而不是文字，例如 href、value、src。读文字就不写 attr" } },
          required: ["target"],
          additionalProperties: false,
        },
      ],
    }
    const fieldSchema = z.union([z.string().min(1), z.object({ target: z.string().min(1), attr: z.string().min(1).optional() })])
    return [
      {
        id: EXTRACT_TOOL,
        def: {
          id: EXTRACT_TOOL,
          name: "浏览器：读列表",
          summary: "按定位读页面上的字，一行一个对象（读表格、列表比看快照省事）",
          description: `按定位读页面上的字，返回一张小表（结构化的行也给脚本用）。list 是每一行的定位（例如 getByRole('row')、css=.item），fields 是行里每个字段的定位（相对这一行，例如 getByRole('cell').nth(2)），{ target, attr } 取 HTML 属性（href、value；读文字不写 attr）；不给 list 就是整页一行。limit 默认 ${EXTRACT_DEFAULT_ROWS}、最多 ${EXTRACT_MAX_ROWS} 行；文字里最多列 50 行。一行也没有不算出错。${TARGET_HELP}。只读，不改页面。`,
          source: "builtin",
          risk: "read",
        },
        jsonSchema: {
          type: "object",
          properties: {
            list: { ...target, description: "每一行的定位；不给 = 整页一行" },
            fields: { type: "object", minProperties: 1, maxProperties: 30, additionalProperties: field, description: "字段名 → 定位（相对这一行），或 { target, attr }" },
            limit: { type: "integer", minimum: 1, maximum: EXTRACT_MAX_ROWS, description: `最多读几行，默认 ${EXTRACT_DEFAULT_ROWS}` },
          },
          required: ["fields"],
          additionalProperties: false,
        },
        validator: z.object({
          list: z.string().min(1).optional(),
          fields: z
            .record(z.string().min(1).max(60), fieldSchema)
            .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 30, "fields 要有 1～30 个字段"),
          limit: z.number().int().min(1).max(EXTRACT_MAX_ROWS).optional(),
        }),
        execute: (input) => this.extract(input as ExtractInput),
      },
      {
        id: WAIT_ANY_TOOL,
        def: {
          id: WAIT_ANY_TOOL,
          name: "浏览器：等结果",
          summary: "等页面上出现几种结果里的一个（结果页、「暂无数据」、报错提示），返回是哪个",
          description: `等页面上出现 outcomes 里的其中一个（看得见的），返回它的名字；同时出现时取前面的。把可能的结果都列出来（成功的、「暂无数据」、报错提示），不要只等成功的那个。定位写 url=片段 表示网址里包含这一段。timeout 单位是秒，默认 ${WAIT_ANY_DEFAULT_SECONDS}、最多 ${WAIT_ANY_MAX_SECONDS}；等不到算出错。${TARGET_HELP}。只读，不改页面。`,
          source: "builtin",
          risk: "read",
        },
        jsonSchema: {
          type: "object",
          properties: {
            outcomes: { type: "object", minProperties: 1, maxProperties: 10, additionalProperties: { ...target }, description: "结果名 → 定位，例如 { \"found\": \"getByRole('row').nth(1)\", \"empty\": \"getByText('暂无数据')\" }" },
            timeout: { type: "number", minimum: 0.5, maximum: WAIT_ANY_MAX_SECONDS, description: `最多等几秒，默认 ${WAIT_ANY_DEFAULT_SECONDS}` },
          },
          required: ["outcomes"],
          additionalProperties: false,
        },
        validator: z.object({
          outcomes: z
            .record(z.string().min(1).max(60), z.string().min(1))
            .refine((value) => Object.keys(value).length >= 1 && Object.keys(value).length <= 10, "outcomes 要有 1～10 种结果"),
          timeout: z.number().min(0.5).max(WAIT_ANY_MAX_SECONDS).optional(),
        }),
        execute: (input) => this.waitAny(input as { outcomes: Record<string, string>; timeout?: number }),
      },
    ]
  }

  /** browser.fetch（docs/dev/solidify.md 19.4）：在当前页面里带着登录态调网站的接口；不能放进 batch */
  private fetchEntry(): BrowserToolEntry {
    const methods = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
    return {
      id: BROWSER_FETCH_TOOL,
      def: {
        id: BROWSER_FETCH_TOOL,
        name: "浏览器：调网站接口",
        summary: "在当前页面里带着浏览器的登录态直接调网站自己的接口（读列表、翻页、查详情比一页页点快）",
        description: `在当前标签页里发一个请求，带着浏览器的登录态（cookie 由浏览器自己带），返回状态码和返回体（JSON 排好版）。先用 browser.navigate 打开这个网站的页面再调。url 要写完整的 http(s) 网址；只能调和当前页面同源的，任务设了网址白名单时和页面落在同一条白名单里的也行。不能设 Cookie、Authorization、Host、Origin、Referer、Proxy-*、Sec-* 这类请求头；网站要 CSRF 的，给 csrf（{ header, from: meta | cookie, name }），工具在页面里读出 token 填进去。body 是对象、数组时按 JSON 发；GET、HEAD 不能带 body。4xx、5xx 不算出错，看状态码；接口要跳转（多半登录过期）、连不上、超时（${FETCH_TIMEOUT_MS / 1000} 秒）、返回体超过 ${FETCH_MAX_BYTES / 1024 / 1024} MB 算出错。网页自己调过的接口记在 ${NETWORK_LOG_PATH}，先看一眼照着调，不要猜。返回里像密码、token 的字段值换成了 ••••。`,
        source: "builtin",
        risk: "external",
      },
      jsonSchema: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, description: "完整的 http(s) 网址（https://…），不认相对路径" },
          method: { type: "string", enum: methods, description: "默认 GET。GET、HEAD 只读；别的会改东西" },
          headers: { type: "object", additionalProperties: { type: "string" }, description: "请求头（照网页发的写，例如 content-type、x-requested-with）" },
          body: { description: "请求体：字符串原样发；对象、数组按 JSON 发（没写 content-type 时补 application/json）" },
          as: { type: "string", enum: ["auto", "json", "text"], description: "怎么读返回：auto（默认，content-type 带 json 的解析成 JSON）、json、text" },
          csrf: {
            type: "object",
            properties: {
              header: { type: "string", description: "要填的请求头，例如 x-csrf-token" },
              from: { type: "string", enum: ["meta", "cookie"], description: "从页面的 <meta name> 读，还是从（不是 HttpOnly 的）cookie 读" },
              name: { type: "string", description: "meta 的 name 或 cookie 的名字" },
            },
            required: ["header", "from", "name"],
            additionalProperties: false,
            description: `CSRF：工具在页面里读出 token 填进这个请求头（值不经过你）。照 ${NETWORK_LOG_PATH} 里记下的 csrf 填`,
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
      validator: browserFetchInputSchema,
      execute: (input) => this.fetch(input as BrowserFetchInput),
    }
  }

  /** browser.fetch：在当前页面的隔离环境里发请求（页面脚本改不了、看不到） */
  private async fetch(input: BrowserFetchInput): Promise<ToolOutcome> {
    const target = input.url.trim()
    const method = input.method
    const shown = `${method} ${maskUrl(target)}`
    if (!/^https?:\/\//i.test(target)) return fail(`要写完整的 http(s) 网址（https://…），不认相对路径：${target.slice(0, 200)}`)
    // 白名单不用等 Chrome 起来就能查
    const listed = urlAllowed(target, this.ctx.snapshot.browser?.allowedDomains ?? [])
    if (!listed.ok) {
      await this.record("browser_fetch", true, target)
      return fail(`被拦下：${listed.reason}。只能调白名单里的网址。`)
    }
    const ready = await this.ensure()
    if (!("id" in ready)) return ready
    const instance = ready
    instance.touch()
    // 前台的标签页拿不准时（例如前台是个空白页）退回 agent 最近导航的那个
    const isWeb = (each: ReturnType<BrowserInstance["currentPage"]>) => Boolean(each && /^https?:/i.test(each.url()))
    const front = await instance.frontPage()
    const page = isWeb(front) ? front : isWeb(instance.currentPage()) ? instance.currentPage() : undefined
    const pageUrl = page?.url()
    if (!page || !pageUrl) return fail(NEED_PAGE)
    const trace = { urlBefore: pageUrl }
    if (instance.dialogs.has(page)) return { ...fail("页面上开着网页弹框，先用 browser_handle_dialog 处理"), trace }
    const allowed = fetchTargetAllowed(target, pageUrl, instance.allowedDomains)
    if (!allowed.ok) {
      await this.record("browser_fetch", true, target)
      return { ...fail(`不让调：${allowed.reason}`), trace }
    }
    // 和打开网址同一个函数：白名单 + 平台域名的账号租约（租约满了照 navigate 的处理：挂起等）
    const blocked = await instance.checkNavigation(target)
    if (blocked) {
      await this.record("browser_fetch", true, target)
      return { ...(await this.blockedOutcome([blocked], "")), trace }
    }
    const headers: Record<string, string> = { ...(input.headers ?? {}) }
    let body: string | undefined
    if (input.body !== undefined) {
      if (typeof input.body === "string") body = input.body
      else {
        body = JSON.stringify(input.body)
        if (!Object.keys(headers).some((name) => name.toLowerCase() === "content-type")) headers["content-type"] = "application/json"
      }
    }
    instance.viewer.announce(browserActionLabel("browser_fetch", {}))
    // 自己发的不记进 network/requests.jsonl（过程记录里有）
    const unexpect = instance.network?.expectOwn(method, target)
    let result: Awaited<ReturnType<typeof sendInPage>>
    try {
      result = await sendInPage(page, { url: target, method, headers, ...(body !== undefined ? { body } : {}), ...(input.csrf ? { csrf: input.csrf } : {}) })
    } catch (error) {
      result = { ok: false, error: "network", message: stripAnsi((error as Error).message).split("\n")[0] ?? "出错了", ms: 0 }
    } finally {
      // 请求事件可能比结果晚一点到：等一会儿再撤销登记（发不出去的请求不会留下登记）
      setTimeout(() => unexpect?.(), 2000)
    }
    await this.record("browser_fetch", !result.ok, target)
    if (!result.ok) {
      const why =
        result.error === "csrf"
          ? `CSRF 读不到：${result.message}。先打开有这个 token 的页面，或者照 ${NETWORK_LOG_PATH} 里记下的 csrf 填`
          : result.error === "redirect"
            ? "接口要跳转（多半登录过期了）：先用 browser.navigate 打开网站的页面看看"
            : result.error === "timeout"
              ? `超时：${FETCH_TIMEOUT_MS / 1000} 秒没收完`
              : result.error === "too_big"
                ? `返回体超过 ${FETCH_MAX_BYTES / 1024 / 1024} MB，停了。要文件用下载`
                : `连不上，或者被浏览器的跨域规则拦下了（目标不同源、网站没允许）：${result.message}`
      return { ...fail(`${shown} → 出错：${why}`), trace }
    }
    const contentType = result.contentType
    let json: unknown
    let text: string | undefined
    if (result.text !== undefined) {
      const wantJson = input.as === "json" || (input.as === "auto" && /json/i.test(contentType))
      if (wantJson) {
        try {
          json = maskJson(JSON.parse(result.text))
        } catch {
          if (input.as === "json") return { ...fail(`${shown} → ${result.status}：返回不是 JSON（${contentType || "没有 content-type"}）`), trace }
          text = maskBody(result.text, contentType).text
        }
      } else text = maskBody(result.text, /json/i.test(contentType) ? "text/plain" : contentType).text
    }
    const ok = result.status >= 200 && result.status < 300
    const lines = [`${shown} → ${result.status} ${contentType || "（没有 content-type）"}（${sizeText(result.bytes)}，${result.ms} 毫秒）`]
    if (result.status === 401 || result.status === 403) {
      const cookies = await page
        .context()
        .cookies(target)
        .then((list) => list.length)
        .catch(() => 1)
      lines.push(fetchAuthHint({ authenticate: result.authenticate, cookies, tokenApi: instance.network?.usesToken(target) ?? false }))
    }
    let shownBody = json !== undefined ? JSON.stringify(json, null, 2) : text
    if (shownBody === undefined) lines.push(method === "HEAD" ? "（HEAD 没有返回体）" : `（返回不是文字：只给大小 ${sizeText(result.bytes)}。要文件用下载）`)
    else if (shownBody === "") lines.push("（返回体是空的）")
    else {
      if (shownBody.length > FETCH_OUTPUT_MAX_CHARS) shownBody = `${shownBody.slice(0, FETCH_OUTPUT_MAX_CHARS)}\n…（返回体一共 ${shownBody.length} 字，这里截到前 ${FETCH_OUTPUT_MAX_CHARS} 字）`
      lines.push("", shownBody)
    }
    return {
      output: lines.join("\n"),
      data: { status: result.status, ok, contentType, bytes: result.bytes, ...(json !== undefined ? { json } : {}), ...(text !== undefined ? { text } : {}) },
      trace,
    }
  }


  /** 读页面的工具要的页面：开着 Chrome、打开了网页、没有网页弹框挡着 */
  private async readablePage(): Promise<{ instance: BrowserInstance; page: NonNullable<ReturnType<BrowserInstance["currentPage"]>> } | ToolOutcome> {
    const ready = await this.ensure()
    if (!("id" in ready)) return ready
    const instance = ready
    instance.touch()
    const page = instance.currentPage()
    if (!page || page.url() === "about:blank") return fail("还没打开网页")
    if (instance.dialogs.has(page)) return fail("页面上开着网页弹框，先用 browser_handle_dialog 处理")
    return { instance, page }
  }

  private async extract(input: ExtractInput): Promise<ToolOutcome> {
    const ready = await this.readablePage()
    if (!("page" in ready)) return ready
    const { instance, page } = ready
    instance.viewer.announce(browserActionLabel("browser_extract", {}))
    try {
      const result = await extractRows(page, input)
      await this.record("browser_extract", false, page.url())
      return { output: formatExtract(input, result), data: result, trace: { urlAfter: page.url() } }
    } catch (error) {
      await this.record("browser_extract", true, page.url())
      return { ...fail(`读不了：${stripAnsi((error as Error).message).split("\n")[0]}`), trace: { urlAfter: page.url() } }
    }
  }

  private async waitAny(input: { outcomes: Record<string, string>; timeout?: number }): Promise<ToolOutcome> {
    const ready = await this.readablePage()
    if (!("page" in ready)) return ready
    const { instance } = ready
    const seconds = Math.min(WAIT_ANY_MAX_SECONDS, input.timeout ?? WAIT_ANY_DEFAULT_SECONDS)
    instance.viewer.announce(browserActionLabel("browser_wait_any", {}))
    const urlBefore = instance.currentPage()?.url()
    let result: Awaited<ReturnType<typeof waitAnyOutcome>>
    try {
      result = await waitAnyOutcome(() => instance.currentPage(), input.outcomes, seconds * 1000, (page) => instance.dialogs.has(page))
    } catch (error) {
      return { ...fail(stripAnsi((error as Error).message)), trace: urlBefore ? { urlBefore } : {} }
    }
    const page = instance.currentPage()
    const urlAfter = page?.url()
    const brief = page ? formatBrief(await readPageBrief(page, { dialogOpen: instance.dialogs.has(page) })) : []
    const trace = { ...(urlBefore ? { urlBefore } : {}), ...(urlAfter ? { urlAfter } : {}) }
    if (!result.matched) {
      const names = Object.keys(input.outcomes).map((name) => `「${name}」`).join("、")
      return { ...fail([`等了 ${seconds} 秒，页面上没出现${names}里的任何一个。`, ...brief].join("\n")), trace }
    }
    const title = urlAfter !== urlBefore && page ? await page.title().catch(() => "") : ""
    return {
      output: [`等到了「${result.matched}」（${(result.ms / 1000).toFixed(1)} 秒）。`, ...brief].join("\n"),
      data: { matched: result.matched },
      trace: { ...trace, ...(title ? { title } : {}) },
    }
  }

  /** browser.batch 开始 / 结束：中间的步骤不读页面概况 */
  setBatching(on: boolean) {
    this.batching = on
  }

  /** browser.batch 做完：页面概况的几行（lastOutput：最后一步的输出，里面的 ### Modal state 翻成中文） */
  async briefLines(lastOutput = ""): Promise<string[]> {
    const instance = this.instance
    const page = instance?.currentPage()
    if (!instance || !page) return modalGuidance(lastOutput)
    return formatBrief(await readPageBrief(page, { dialogOpen: instance.dialogs.has(page) }), lastOutput)
  }

  /** browser.batch 做完附的快照（直接调 MCP，不再单独记一条过程）；拿不到（选择框、网页弹框开着）返回 undefined */
  async batchSnapshot(depth: number): Promise<string | undefined> {
    if (!this.instance) return undefined
    const result = await this.callMcp("browser_snapshot", { depth })
    return result.isError ? undefined : result.output
  }

  private async use(profileId: string): Promise<ToolOutcome> {
    if (!this.profiles.some((profile) => profile.id === profileId))
      return fail(`本任务不允许用 Chrome 配置 ${profileId}。可选：${this.profiles.map((profile) => profile.id).join("、") || "无"}`)
    // 一个运行从头到尾只用一个 Chrome：分到以后不再切换
    if (this.assigned === profileId) return { output: `这次运行已经在用 Chrome「${this.profileName(profileId)}」（${profileId}），不用再指定。` }
    if (this.assigned)
      return fail(`一次运行只能用一个 Chrome：这次运行已经在用 Chrome「${this.profileName(this.assigned)}」（${this.assigned}），不能换成 ${profileId}。接着用现在这个就行。`)
    await this.assign(profileId)
    return { output: `已指定 Chrome「${this.profileName(profileId)}」（${profileId}），这次运行之后都用它。下一次调浏览器工具时打开；它正被别的运行用着的话会挂起等它。` }
  }

  /** 记下这次运行分到的 Chrome（页面显示用的哪个；挂起再继续时只用它） */
  private async assign(profileId: string) {
    if (this.assigned === profileId) return
    this.assigned = profileId
    await this.ctx.db.update(t.sessions).set({ browserProfileId: profileId }).where(eq(t.sessions.id, this.ctx.session.id))
  }

  /** 还没分到 Chrome 时可以挑的：允许的里现在空闲的，按配置的顺序（position、创建时间）。空数组 = 都被占着 */
  private async freeProfiles(): Promise<string[]> {
    const ids = this.profiles.map((profile) => profile.id)
    const busy = await busyProfileIds(this.ctx.db, ids)
    return ids.filter((id) => !busy.has(id))
  }

  /** 懒启动：第一次真正调浏览器工具时才分配 Chrome、起 Chrome 和 MCP */
  private async ensure(): Promise<BrowserInstance | ToolOutcome> {
    if (!this.profiles.length) return fail("本任务没有可用的 Chrome 配置（任务里允许的 Chrome 配置都不在了），请让负责人检查任务设置")
    const manager = getBrowserManager()
    if (!manager) return fail("这个进程不能开浏览器（只有带 Chrome 的 worker 能开）")
    // 开着的（包括等人处理时保留着的）接着用
    if (this.instance && this.instance.state !== "closing" && (!this.assigned || this.instance.profileId === this.assigned)) return this.instance
    // 已经分到了：只用它，被别的运行占着就等它
    if (this.assigned) {
      const profileId = this.assigned
      try {
        return await this.open(manager, profileId)
      } catch (error) {
        if (error instanceof ProfileFullError) return this.busyOutcome(profileId)
        return this.startFailed(error, profileId)
      }
    }
    // 第一次分配：按顺序挑空闲的；挑的时候还空着、登记时被别的运行抢先了，就换下一个（这时还没真正用上任何 Chrome）
    for (const profileId of await this.freeProfiles()) {
      try {
        return await this.open(manager, profileId)
      } catch (error) {
        if (error instanceof ProfileFullError) continue
        return this.startFailed(error, profileId)
      }
    }
    // 都被占着：任务只允许一个就等它，否则等任一允许的空出来（叫醒后重新挑）
    return this.busyOutcome(this.profiles.length === 1 ? this.profiles[0]!.id : undefined)
  }

  /** 登记上了、Chrome 没起来：也算分到了这个 Chrome（下次还用它，不换） */
  private async startFailed(error: unknown, profileId: string): Promise<ToolOutcome> {
    await this.assign(profileId).catch(() => {})
    const message = (error as Error).message
    if (/gost|代理/.test(message)) await this.warnProxy(message, profileId)
    return fail(`浏览器起不来：${message}`)
  }

  private async open(manager: NonNullable<ReturnType<typeof getBrowserManager>>, profileId: string): Promise<BrowserInstance> {
    const { db, session, snapshot } = this.ctx
    const fresh = !manager.forSession(session.id)
    // 登记成功（没抛 ProfileFullError）就算分到了这个 Chrome：排队等 worker 空位时、起好以后都记下
    this.instance = await manager.acquireForSession({
      sessionId: session.id,
      profileId,
      allowedDomains: snapshot.browser?.allowedDomains ?? [],
      recordNetwork: this.allowFetch,
      onQueued: async (used, max) => {
        await this.assign(profileId)
        await appendEvent(db, session.id, {
          kind: "wait",
          title: "等待浏览器",
          detail: `这台 worker 同时最多开 ${max} 个 Chrome，现在已经开了 ${used} 个，排队等空位。`,
        })
      },
    })
    await this.assign(profileId)
    await this.instance.ensureMcp()
    if (fresh)
      await appendEvent(db, session.id, {
        kind: "plan",
        title: `打开了 Chrome「${this.profileName(profileId)}」`,
        // 「Chrome 配置 <id>；」开头：浏览器页「最近用它的运行」按这个认（shared 的 recentRunsUsing）
        detail: `Chrome 配置 ${profileId}；浏览器 ${this.instance.id}${snapshot.browser?.allowedDomains.length ? `；网址白名单：${snapshot.browser.allowedDomains.join("、")}` : ""}`,
      })
    return this.instance
  }

  /**
   * Chrome 被别的运行占着：session 挂起「等待浏览器」，有 Chrome 空出来时按挂起的先后叫醒。
   * profileId：只等这一个（agent 指定的、任务只允许一个）；不给就等任一允许的。
   */
  private async busyOutcome(profileId?: string): Promise<ToolOutcome> {
    const settings = await loadEngineSettings(this.ctx.db)
    const what = profileId ? `Chrome「${this.profileName(profileId)}」正在被别的运行用` : `本任务允许的 ${this.profiles.length} 个 Chrome 都在被别的运行用`
    return {
      output: `${what}，已排队等它空出来。先挂起，轮到时会叫你继续（网页需要重新打开）。`,
      suspend: {
        kind: "wait",
        input: {
          what: `等待浏览器：${what}`,
          triggerKind: "event",
          event: profileId ? profileEventName(profileId) : ANY_PROFILE_EVENT,
          fallbackDays: settings.eventFallbackDays,
          deadlineAt: new Date(Date.now() + settings.eventFallbackDays * 24 * 60 * 60 * 1000),
        },
      },
    }
  }

  /** 代理挂了：报错 + 告警（通知任务负责人），绝不退回直连 */
  private async warnProxy(detail: string, profileId = this.instance?.profileId) {
    if (this.proxyWarned) return
    this.proxyWarned = true
    const { db, session, snapshot } = this.ctx
    const name = profileId ? this.profileName(profileId) : ""
    await notifyUsers(db, {
      userIds: [snapshot.task.ownerId],
      title: `Chrome「${name}」的代理连不上`,
      body: `运行 ${session.id} 用这个 Chrome 时代理出错（不会改成直连）：${detail.slice(0, 300)}。请检查浏览器页里这个 Chrome 的代理配置。`,
      link: sessionLink(snapshot.task.id, session.id),
      taskId: snapshot.task.id,
      sessionId: session.id,
    }).catch(() => {})
  }

  private connection(instance: BrowserInstance, client: Awaited<ReturnType<BrowserInstance["ensureMcp"]>>["client"]): McpConnection {
    return { serverId: `browser:${instance.id}`, serverName: "Playwright MCP", client, secrets: [], tools: this.mcpTools }
  }

  /** 文件 id → MCP 能读到的路径（拷进 session 的临时目录） */
  private async filePaths(instance: BrowserInstance, fileIds: string[]): Promise<string[] | ToolOutcome> {
    const paths: string[] = []
    const dir = join(instance.workDir, "uploads")
    mkdirSync(dir, { recursive: true })
    for (const fileId of fileIds) {
      const row = await getFileRow(this.ctx.db, fileId)
      const allowed = row && (row.sessionId === this.ctx.session.id || this.ctx.snapshot.attachments.some((file) => file.id === row.id))
      if (!row || !allowed) return fail(`这次运行里没有文件 ${fileId}`)
      // 每个文件一个子目录，网页看到的还是原来的文件名
      const folder = join(dir, row.id)
      mkdirSync(folder, { recursive: true })
      const target = join(folder, safeFileName(row.name))
      writeFileSync(target, await readFileData(row))
      paths.push(target)
    }
    return paths
  }

  private navigationUrl(name: string, input: Record<string, unknown>): string | undefined {
    if (name === "browser_navigate" && typeof input.url === "string") return input.url
    if (name === "browser_tabs" && input.action === "new" && typeof input.url === "string") return input.url
    return undefined
  }

  /** MCP 的工具：分段计时（docs/dev/browser-speed.md D），网关记下来 */
  private async callMcp(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    const timer = phaseTimer()
    const recorded: Recorded = {}
    const outcome = await this.runMcp(name, input, timer, recorded)
    return { ...outcome, ...(await this.traceOf(recorded)), timings: timer.phases }
  }

  /** 录下的代码、动作前后的网址、跳转后的标题（读不到就不记；标题限时 1 秒） */
  private async traceOf(recorded: Recorded): Promise<Pick<ToolOutcome, "code" | "trace">> {
    if (!recorded.instance) return {}
    const page = recorded.instance.currentPage()
    const urlAfter = page?.url()
    const moved = urlAfter !== undefined && urlAfter !== recorded.urlBefore
    const title = moved && page ? await Promise.race([page.title().catch(() => ""), sleep(1000).then(() => "")]) : ""
    const trace = {
      ...(recorded.urlBefore ? { urlBefore: recorded.urlBefore } : {}),
      ...(urlAfter ? { urlAfter } : {}),
      ...(title ? { title } : {}),
    }
    return { ...(recorded.code ? { code: recorded.code } : {}), ...(Object.keys(trace).length ? { trace } : {}) }
  }

  private async runMcp(name: string, input: Record<string, unknown>, timer: ReturnType<typeof phaseTimer>, recorded: Recorded): Promise<ToolOutcome> {
    // 白名单不用等 Chrome 起来就能查
    const target = this.navigationUrl(name, input)
    if (target) {
      const allowed = urlAllowed(target, this.ctx.snapshot.browser?.allowedDomains ?? [])
      if (!allowed.ok) {
        await this.record(name, true, target)
        return fail(`被拦下：${allowed.reason}。只能打开白名单里的网址。`)
      }
    }
    const ready = await timer.time("ensure", () => this.ensure())
    if (!("id" in ready)) return ready
    const instance = ready
    instance.touch()
    const { db, session } = this.ctx

    // 调之前：导航参数查白名单、账号租约
    const url = this.navigationUrl(name, input)
    if (url) {
      const blocked = await instance.checkNavigation(url)
      if (blocked) {
        await this.record(name, true, url)
        return this.blockedOutcome([blocked], "")
      }
    }
    const args = { ...input }
    if (name === "browser_file_upload" || name === "browser_drop") {
      const ids = Array.isArray(args.fileIds) ? (args.fileIds as string[]) : []
      delete args.fileIds
      if (ids.length) {
        const paths = await this.filePaths(instance, ids)
        if (!Array.isArray(paths)) return paths
        args.paths = paths
      }
    }
    // 关掉最后一个标签页 Chrome 就退出了：先开一个空白页
    if ((name === "browser_close" || (name === "browser_tabs" && args.action === "close")) && instance.pages().length <= 1)
      await instance.context?.newPage().catch(() => {})

    const before = new Set(listImages(instance.workDir))
    const mcp = await instance.ensureMcp()
    instance.viewer.announce(browserActionLabel(name, input))
    recorded.instance = instance
    recorded.urlBefore = instance.currentPage()?.url()
    // 录下的 Playwright 代码：从给模型的输出里拿掉（被弹窗挡住重试的，留最后一次的）
    const run = () =>
      timer.time("mcp", async () => {
        const outcome = await executeMcpTool(this.connection(instance, mcp.client), name, args)
        const taken = takeCode(outcome.output)
        recorded.code = taken.code
        const output = outcome.isError ? stripAnsi(taken.output) : taken.output
        // 看网页请求的：认证头、cookie 的值打码，不进模型上下文和过程记录
        return { ...outcome, output: NETWORK_TOOLS.has(name) ? maskNetworkOutput(output) : output }
      })
    let result = await run()
    // 被弹窗挡住：认得出无害的关闭按钮就点掉、再做一次；认不出就写清楚是哪个弹窗挡着
    let unblocked: string | undefined
    if (result.isError && POINTER_TOOLS.has(name)) ({ result, note: unblocked } = await this.unblock(instance, result, run, timer))
    const hint = result.isError ? explainError(result.output) : undefined
    // 补的说明放在 MCP 原文前面（原文的 ### 段可能被去掉）
    const lines: string[] = [...(unblocked ? [unblocked] : []), ...(hint ? [hint] : []), result.output]
    const raw = lines.length - 1
    // 这次（或之前在后台）下载的文件已经存成运行的文件：告诉 agent（browser/downloads.ts）
    const downloads = (await timer.time("downloads", async () => instance.downloads?.collect(name, args))) ?? []
    await timer.time("record", () => this.record(name, Boolean(result.isError), instance.currentPage()?.url() ?? url))
    if (PROXY_ERROR.test(result.output)) await this.warnProxy(PROXY_ERROR.exec(result.output)![0])

    // 截图：存成 session 文件（证据），不交给模型
    const shots = listImages(instance.workDir).filter((path) => !before.has(path))
    if (shots.length) {
      const saved: string[] = []
      for (const path of shots) {
        const data = readFileSync(path)
        const row = await saveFile(db, { data, name: `screenshot-${Date.now()}${extname(path)}`, kind: "screenshot", sessionId: session.id })
        saved.push(row.id)
        rmSync(path, { force: true })
      }
      lines.splice(0, lines.length, `截图已存为这次运行的文件 ${saved.join("、")}（只存档留证，没有发给你；要读页面内容用 browser_snapshot）。`)
    }
    lines.push(...downloads)

    if (READ_ONLY_TOOLS.has(name)) return { ...result, output: lines.join("\n") }

    // 调完：兜底扫一遍页面，取走被拦下的导航
    await timer.time("sweep", () => instance.sweepPages())
    const blocked = instance.drainBlocked()
    if (blocked.length) return this.blockedOutcome(blocked, lines.join("\n"))

    let facts: ToolOutcome["facts"]
    if ((NAVIGATION_TOOLS.has(name) || (name === "browser_tabs" && args.action === "new")) && !result.isError) {
      // 存档截图在后台存，不让模型等（网关关闭时等它存完）
      this.archiveScreenshot(instance)
      lines.push("（已自动截图存档）")
      // 给规则「自动记录检查点」用：打开的是哪个网页
      const page = instance.currentPage()
      if (page) facts = { url: page.url(), title: await timer.time("facts", () => page.title().catch(() => "")) }
    }

    let hit = await timer.time("detect", () => this.detect(instance))
    let captchaNote: string | undefined
    if (hit?.verdict.kind === "captcha") {
      // 验证码：先自己试着过（设置里开着时），过了再看一遍页面（过了可能是登录页）；再遇到验证码就不试了，交给人
      const solved = await this.trySolveCaptcha(instance, hit, true)
      if (solved?.ok) {
        lines.push(`检测到验证码（${hit.verdict.reason}），已自动过了：${solved.detail}。现在的页面：${hit.page.url()}。接着做之前先看一下页面。`)
        hit = await this.detect(instance)
      } else if (solved?.form)
        return {
          output: [...lines, `页面上有验证码（${hit.verdict.reason}），和别的输入框在一个表单里：先填好别的项，再调 browser_fill_captcha 让系统认出验证码、填进去，然后提交。`].join("\n"),
          isError: result.isError,
          facts,
        }
      else if (solved) captchaNote = solved.skipped ?? `自动过验证码没成功：${solved.detail}`
    }
    if (hit) {
      // 登录页：账号存了密码就先让登录小 agent 用它登录，登不上再交给人
      const login = hit.verdict.kind === "login" ? await this.tryAutoLogin(instance, hit) : undefined
      if (login?.ok) return { output: [...lines, login.text].join("\n"), isError: result.isError, facts }
      return { ...(await this.humanOutcome(instance, hit, lines.join("\n"), login?.text ?? captchaNote)), facts }
    }
    // 页面概况：批里的中间步骤不读（批做完网关统一附一次），MCP 原文留着给网关翻 ### Modal state
    let briefLines: string[] = []
    if (!this.batching) {
      const page = instance.currentPage()
      const brief = page ? await timer.time("brief", () => readPageBrief(page, { dialogOpen: instance.dialogs.has(page) })) : undefined
      if (brief) lines[raw] = stripPageSections(lines[raw]!)
      briefLines = formatBrief(brief, result.output)
    }
    const body = lines.filter(Boolean).join("\n")
    return { output: [body, briefLines.join("\n")].filter(Boolean).join("\n\n"), isError: result.isError, facts }
  }

  /**
   * 动作被别的元素挡住（intercepts pointer events，或超时且页面上认出了弹窗）：弹窗里有文字正好是无害关闭类的按钮
   * （page-brief.ts 的 HARMLESS_CLOSE_TEXTS）就点掉它、等 300 毫秒、再做一次（只重试一次），过程里记一条；
   * 否则出错文字写清楚被哪个弹窗挡着、有哪些按钮。不点「接受」「同意」「确定」「OK」这类有含义的按钮。
   */
  private async unblock(
    instance: BrowserInstance,
    result: ToolOutcome,
    retry: () => Promise<ToolOutcome>,
    timer: ReturnType<typeof phaseTimer>
  ): Promise<{ result: ToolOutcome; note?: string }> {
    const kind = blockedKind(result.output)
    const page = instance.currentPage()
    if (!kind || !page || instance.dialogs.has(page)) return { result }
    const brief = await timer.time("overlay", () => readPageBrief(page, { findClose: true }))
    if (!brief?.overlays.length) return { result }
    const blockedBy = (overlays: typeof brief.overlays) => `点不到：被弹窗${overlays.map(overlayText).join("、")}挡住了，先处理弹窗。`
    if (!brief.dismiss) return { result: { ...result, output: `${blockedBy(brief.overlays)}\n${result.output}` } }
    const { overlay, button } = brief.dismiss
    const target = page.locator(`[${DISMISS_ATTR}]`).first()
    instance.viewer.announce(browserActionLabel("browser_click", { element: button }))
    const clicked = await timer.time("overlay", async () => {
      try {
        await target.click({ timeout: 2000 })
        return true
      } catch {
        // 点不了（例如又被别的挡着）：直接在元素上触发 click
        return target
          .evaluate("(el) => { el.click(); return true }", undefined, { timeout: 1000 })
          .then(Boolean)
          .catch(() => false)
      } finally {
        await target.evaluate(`(el) => el.removeAttribute(${JSON.stringify(DISMISS_ATTR)})`, undefined, { timeout: 1000 }).catch(() => {})
      }
    })
    if (!clicked) return { result: { ...result, output: `${blockedBy(brief.overlays)}\n${result.output}` } }
    await sleep(300)
    await appendEvent(this.ctx.db, this.ctx.session.id, {
      kind: "plan",
      title: `自动关掉了弹窗「${overlay}」（点了「${button}」）`,
      detail: "动作被弹窗挡住了，弹窗里有无害的关闭按钮，系统点掉它后把原来的动作再做了一次。",
    }).catch(() => {})
    const again = await retry()
    const note = `（动作被弹窗「${overlay}」挡住，系统点了「${button}」关掉它，再做了一次${again.isError ? "，还是没成功" : ""}）`
    if (again.isError && blockedKind(again.output)) {
      const still = await timer.time("overlay", () => readPageBrief(page))
      if (still?.overlays.length) return { result: { ...again, output: `${blockedBy(still.overlays)}\n${again.output}` }, note }
    }
    return { result: again, note }
  }

  /** 跳转后的存档截图：后台截、存成 session 文件，出错只记日志；用时也记一条（看原来在关键路径上占多少） */
  private archiveScreenshot(instance: BrowserInstance) {
    const { db, session } = this.ctx
    const job: Promise<void> = (async () => {
      const timer = phaseTimer()
      const started = Date.now()
      const shot = await timer.time("screenshot", () => instance.screenshot())
      if (shot) await timer.time("save", () => saveFile(db, { data: shot, name: `page-${Date.now()}.jpg`, mime: "image/jpeg", kind: "screenshot", sessionId: session.id }))
      recordBrowserTiming({ at: started, sessionId: session.id, toolId: "browser.archive_screenshot", totalMs: Date.now() - started, phases: timer.phases })
    })()
      .catch((error: unknown) => console.warn(`[browser] 跳转后的存档截图没存上：${(error as Error).message}`))
      .finally(() => this.pendingSaves.delete(job))
    this.pendingSaves.add(job)
  }

  /** 操作历史记一行（浏览器页看）。记不上不影响工具本身 */
  private async record(name: string, failed: boolean, url: string | undefined) {
    const profileId = this.instance?.profileId ?? this.assigned
    if (!profileId || !url || url === "about:blank") return
    await this.ctx.db
      .insert(t.browserActions)
      .values({ profileId, sessionId: this.ctx.session.id, url, action: browserActionTag(name), failed })
      .catch((error) => console.warn(`[browser] 操作历史没记上：${(error as Error).message}`))
  }

  /** 视觉判断、自动登录、自动过验证码的花费算进这次运行 */
  private async addCost(usage: { tokensIn: number; tokensOut: number; costUsd: number }) {
    await this.ctx.db
      .update(t.sessions)
      .set({
        tokensIn: sql`${t.sessions.tokensIn} + ${usage.tokensIn}`,
        tokensOut: sql`${t.sessions.tokensOut} + ${usage.tokensOut}`,
        costUsd: sql`${t.sessions.costUsd} + ${usage.costUsd}`,
      })
      .where(eq(t.sessions.id, this.ctx.session.id))
  }

  /** 自动过验证码的一次尝试记一条过程（答案也写在里面，给人看） */
  private async recordCaptchaTry(each: CaptchaTry, index: number, url: string | undefined, where = "") {
    await appendEvent(this.ctx.db, this.ctx.session.id, {
      kind: "plan",
      title: `${where}自动过验证码（第 ${index + 1} 次）：${each.ok ? (each.fillOnly ? "填好了" : "过了") : each.fillOnly ? "没填上" : "没过"}`,
      detail: each.detail,
      tokensIn: each.tokensIn,
      tokensOut: each.tokensOut,
      ms: each.ms,
      output: `花费 ${each.costUsd.toFixed(6)} 美元`,
    })
    await this.record("browser_captcha", !each.ok, url)
  }

  /**
   * 运行中遇到登录页：这个网站对应的账号存了密码，就用登录小 agent 登录（模型只看到占位符）。
   * 没存密码、没设默认模型时返回 undefined（照旧交给人）；花费算进这次运行，过程里记一条。
   * 设置里开了「遇到验证码先自己试着过」时，登录表单里的验证码它也能填。
   */
  private async tryAutoLogin(instance: BrowserInstance, hit: { facts: { url: string }; verdict: { reason: string } }): Promise<{ ok: boolean; text: string } | undefined> {
    const host = hostOf(hit.facts.url) ?? ""
    // 平台没填域名时，按账号的登录网址认
    const account = accountForHost(instance.accounts, host) ?? instance.accounts.find((each) => each.probeUrl && hostOf(each.probeUrl) === host)
    if (!account) return undefined
    const { db, session } = this.ctx
    const password = await loadAccountPassword(db, getKeyring(), account.accountId).catch(() => undefined)
    const modelId = password ? await loginModelId(db) : undefined
    if (!password || !modelId) return undefined
    const who = `${account.platformName} 账号 ${account.account}`
    const settings = await readBrowserSettings(db)
    const captcha: AutoLoginCaptcha | undefined = settings.captchaSolve
      ? { modelId: settings.visionModel, onTry: (each, index) => this.recordCaptchaTry(each, index, instance.currentPage()?.url(), "登录时") }
      : undefined
    const started = Date.now()
    const result = await autoLogin({ db, instance, account, credentials: { username: account.account, password }, modelId, captcha }).catch((error: unknown) => ({
      ok: false,
      needHuman: false,
      detail: `出错了：${(error as Error).message}`,
      steps: 0,
      tokensIn: 0,
      tokensOut: 0,
      costUsd: 0,
    }))
    // 登录时过验证码的花费也在 result 里
    await this.addCost(result)
    await appendEvent(db, session.id, {
      kind: "plan",
      title: result.ok ? `遇到登录页，用存的密码自动登录了 ${who}` : `遇到登录页，自动登录 ${who} 没成功`,
      detail: `${result.detail}（${result.steps} 步）`,
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      ms: Date.now() - started,
      output: `花费 ${result.costUsd.toFixed(6)} 美元`,
    })
    await this.record("browser_login", !result.ok, instance.currentPage()?.url())
    if (result.ok) {
      await instance.setAccountStatus([account.accountId], "ok")
      return { ok: true, text: `检测到登录页（${hit.verdict.reason}），已用 ${who} 存的密码自动登录。现在的页面：${instance.currentPage()?.url() ?? ""}。接着做之前先看一下页面。` }
    }
    return { ok: false, text: `用 ${who} 存的密码自动登录没成功：${result.detail}` }
  }

  /** 检测验证码 / 登录页；规则拿不准时（设置打开了视觉判断）交给视觉模型 */
  private async detect(instance: BrowserInstance): Promise<HumanHit | undefined> {
    const found = await instance.detect()
    if (!found) return undefined
    if (found.verdict.kind === "captcha" || found.verdict.kind === "login") return found as HumanHit
    const settings = await readBrowserSettings(this.ctx.db)
    if (!settings.visionCheck) return undefined
    const answer = await this.askVision(instance, found.page, settings.visionModel).catch((error) => {
      console.warn(`[browser] 视觉判断失败：${(error as Error).message}`)
      return undefined
    })
    if (!answer || (!answer.captcha && !answer.login)) return undefined
    return {
      ...found,
      byVision: true,
      verdict: { kind: answer.captcha ? ("captcha" as const) : ("login" as const), reason: `视觉模型判断${answer.captcha ? "是验证码页" : "是登录页"}：${answer.reason}（规则拿不准：${"reason" in found.verdict ? found.verdict.reason : ""}）` },
    }
  }

  private async askVision(instance: BrowserInstance, page: Parameters<BrowserInstance["screenshot"]>[0], modelId: string) {
    const shot = await instance.screenshot(page)
    if (!shot) return undefined
    const resolved = await resolveModel(this.ctx.db, modelId)
    const result = await callModel(resolved, {
      system: "你是网页分类器，只输出 JSON。",
      messages: [{ role: "user", content: [{ type: "text", text: VISION_PROMPT }, { type: "file", data: shot.toString("base64"), mediaType: "image/jpeg" }] }],
      tools: {},
    })
    await this.addCost(result)
    await appendEvent(this.ctx.db, this.ctx.session.id, {
      kind: "think",
      title: "让视觉模型看截图：是不是验证码页或登录页",
      detail: result.text.slice(0, 500),
      tokensIn: result.tokensIn,
      tokensOut: result.tokensOut,
      ms: result.ms,
      output: `花费 ${result.costUsd.toFixed(6)} 美元`,
    })
    return parseVisionAnswer(result.text)
  }

  /**
   * 遇到验证码先自己试着过（设置里的开关，所有网站都一样）：视觉模型认图里的字符或找到要点的勾选框，填好、提交（submit）或只填（agent 调工具时）。
   * 每个页面最多试 CAPTCHA_MAX_TRIES 次，每次记一条过程，花费算进这次运行。开关关着返回 undefined；
   * 出错、次数用完、不是简单验证码都返回 ok: false（交给人）
   */
  private async trySolveCaptcha(instance: BrowserInstance, hit: Pick<HumanHit, "page" | "byVision">, submit: boolean): Promise<CaptchaResult | undefined> {
    const settings = await readBrowserSettings(this.ctx.db)
    if (!settings.captchaSolve) return undefined
    const key = pageKey(hit.page.url())
    const used = this.captchaTries.get(key) ?? 0
    const empty: CaptchaResult = { ok: false, tries: [], detail: "", tokensIn: 0, tokensOut: 0, costUsd: 0 }
    if (used >= CAPTCHA_MAX_TRIES) return { ...empty, detail: `这个页面已经自动试过 ${used} 次了` }
    if (submit && this.captchaForms.has(key)) return { ...empty, form: true, detail: "验证码在表单里" }
    // 第三方人机验证（reCAPTCHA 等的框架）：不自己试，不问模型，直接交给人
    const facts = await instance.pageFacts(hit.page)
    const verdict = facts ? judgePage(facts) : undefined
    if (verdict?.kind === "captcha" && verdict.provider) {
      const note = providerCaptchaNote(verdict.provider)
      return { ...empty, skipped: note, detail: note }
    }
    // 提交后还是不是验证码页：规则说是就是；原来是视觉模型认出来的，规则拿不准时再问一次视觉模型
    const stillCaptcha = async () => {
      const facts = await instance.pageFacts(hit.page)
      if (!facts) return true
      const verdict = judgePage(facts)
      if (verdict.kind === "captcha") return true
      if (hit.byVision && verdict.kind === "uncertain") return Boolean((await this.askVision(instance, hit.page, settings.visionModel))?.captcha)
      return false
    }
    instance.viewer.announce(browserActionLabel("browser_captcha", {}))
    try {
      const result = await solveCaptcha({
        db: this.ctx.db,
        instance,
        page: hit.page,
        modelId: settings.visionModel,
        submit,
        maxTries: CAPTCHA_MAX_TRIES - used,
        stillCaptcha,
        onTry: async (each, index) => {
          this.captchaTries.set(key, used + index + 1)
          await this.addCost(each)
          await this.recordCaptchaTry(each, used + index, hit.page.url())
        },
      })
      // 不是简单验证码：这个页面不用再试了
      if (result.unsupported) this.captchaTries.set(key, CAPTCHA_MAX_TRIES)
      if (result.form) this.captchaForms.add(key)
      return result
    } catch (error) {
      const detail = `出错了：${(error as Error).message}`
      await appendEvent(this.ctx.db, this.ctx.session.id, { kind: "plan", title: "自动过验证码没成功", detail })
      return { ...empty, detail }
    }
  }

  /** agent 调 browser_fill_captcha：认出当前页面的验证码、填进去（不提交）；关着开关、过不了的交给人 */
  private async fillCaptcha(): Promise<ToolOutcome> {
    const ready = await this.ensure()
    if (!("id" in ready)) return ready
    const instance = ready
    instance.touch()
    const page = instance.currentPage()
    if (!page || page.url() === "about:blank") return fail("还没打开网页")
    const hit = async (reason: string): Promise<HumanHit> => ({
      page,
      facts: { url: page.url(), title: await page.title().catch(() => ""), frameUrls: [], text: "", hasPasswordInput: false },
      verdict: { kind: "captcha", reason },
    })
    const solved = await this.trySolveCaptcha(instance, { page }, false)
    if (!solved) return this.humanOutcome(instance, await hit("agent 要填验证码，设置里没打开「遇到验证码先自己试着过」"), "")
    if (solved.ok)
      return { output: `${solved.detail}。接着提交（点提交或登录按钮）；提交后提示验证码不对就再调一次（每个页面最多 ${CAPTCHA_MAX_TRIES} 次）。` }
    if (solved.skipped) return this.humanOutcome(instance, await hit("页面上的验证码要人过"), "", solved.skipped)
    if (solved.unsupported || (this.captchaTries.get(pageKey(page.url())) ?? 0) >= CAPTCHA_MAX_TRIES)
      return this.humanOutcome(instance, await hit("页面上的验证码要人过"), "", `自动过验证码没成功：${solved.detail}`)
    return fail(`没认出验证码：${solved.detail}`)
  }

  /**
   * agent 调 browser.look：截当前标签页可见区域发给模型（只有这个工具发图，别的截图照旧只存档）。
   * 按视口 CSS 像素截（scale: css），DPR 不是 1 时也和坐标工具对得上；同时存成运行文件。
   */
  private async look(): Promise<ToolOutcome> {
    const ready = await this.ensure()
    if (!("id" in ready)) return ready
    const instance = ready
    instance.touch()
    const page = await instance.frontPage()
    if (!page || page.url() === "about:blank") return fail("还没打开网页")
    if (instance.dialogs.has(page)) return fail("页面上开着弹框（截不了图），先用 browser_handle_dialog 处理")
    instance.viewer.announce(browserActionLabel("browser_look", {}))
    // 后台标签页不出画面：先拿到前台（它本来就是 agent 在操作的页面）
    await page.bringToFront().catch(() => {})
    const shot = await page.screenshot({ type: "jpeg", quality: 70, scale: "css", timeout: 10_000 }).catch(() => undefined)
    if (!shot) {
      await this.record("browser_look", true, page.url())
      return fail("截图没成功（页面可能卡住了），稍后再试")
    }
    const { width, height } = await imageSize(shot)
    const name = `look-${Date.now()}.jpg`
    const row = await saveFile(this.ctx.db, { data: shot, name, mime: "image/jpeg", kind: "screenshot", sessionId: this.ctx.session.id })
    await this.record("browser_look", false, page.url())
    const title = await page.title().catch(() => "")
    return {
      output: `当前标签页（${title ? `「${title}」` : ""}${page.url()}）可见区域的截图已作为下一条消息发给你：宽 ${width}、高 ${height}，单位是视口 CSS 像素，原点在左上角，x 向右、y 向下，可以直接用于 browser_mouse_click_xy 等坐标工具。截图也存成了这次运行的文件 ${row.id}。`,
      images: [{ name, mime: "image/jpeg", base64: shot.toString("base64") }],
    }
  }

  /** 导航被拦下：白名单的告诉 agent 原因；账号租约满了的，session 挂起「等待浏览器」 */
  private async blockedOutcome(blocked: BlockedNavigation[], prefix: string): Promise<ToolOutcome> {
    const lines = prefix ? [prefix] : []
    const lease = blocked.find((each) => each.kind === "lease")
    for (const each of blocked) {
      if (each.kind === "allowlist") lines.push(`被拦下：${each.reason}。只能打开白名单里的网址。`)
      else if (each.kind === "error") lines.push(`被拦下：${each.reason}`)
    }
    if (lease && lease.kind === "lease") {
      const settings = await loadEngineSettings(this.ctx.db)
      const who = `${lease.account.platformName} 的账号 ${lease.account.account}`
      lines.push(`没有打开 ${lease.url}：${who}现在有 ${lease.used}/${lease.max} 个运行在用，已排队等它空出来。先挂起，轮到时会叫你继续（刚才的网页需要重新打开）。`)
      return {
        output: lines.join("\n"),
        suspend: {
          kind: "wait",
          input: {
            what: `等待浏览器：${who}正被其他运行占用`,
            triggerKind: "event",
            event: leaseEventName(lease.account.accountId),
            fallbackDays: settings.eventFallbackDays,
            deadlineAt: new Date(Date.now() + settings.eventFallbackDays * 24 * 60 * 60 * 1000),
          },
        },
      }
    }
    return { output: lines.join("\n"), isError: true }
  }

  /** 命中验证码 / 登录页：截图存证、生成「登录」类要人办的事给任务负责人、session 等人处理；Chrome 保留着 */
  private async humanOutcome(
    instance: BrowserInstance,
    hit: { page: NonNullable<ReturnType<BrowserInstance["currentPage"]>>; facts: { url: string; title: string }; verdict: { kind: "captcha" | "login"; reason: string } },
    prefix: string,
    /** 自动登录、自动过验证码试过但没成功：原因写给人看 */
    note?: string
  ): Promise<ToolOutcome> {
    const { db, session, snapshot } = this.ctx
    const shot = await instance.screenshot(hit.page)
    const file = shot ? await saveFile(db, { data: shot, name: `needs-human-${Date.now()}.jpg`, mime: "image/jpeg", kind: "screenshot", sessionId: session.id }) : undefined
    const host = hostOf(hit.facts.url) ?? hit.facts.url
    const account = accountForHost(instance.accounts, host)
    if (account) await instance.setAccountStatus([account.accountId], hit.verdict.kind === "captcha" ? "captcha" : "expired")
    const settings = await readBrowserSettings(db)
    this.holdMinutes = settings.humanHoldMinutes
    const what = hit.verdict.kind === "captcha" ? "验证码" : "登录页"
    const who = account ? `${account.platformName} 账号 ${account.account}` : host
    const title = `${who}：遇到${what}，要人处理`
    const summary = `运行 ${session.id} 打开 ${hit.facts.url} 时遇到${what}（${hit.verdict.reason}）。请打开这次运行的浏览器远程画面处理，好了点「已处理好了」，agent 会在同一个 Chrome 里接着做。Chrome 保留 ${settings.humanHoldMinutes} 分钟。`
    const detail: HumanDetail = {
      sections: [
        { title: "为什么到了你这里", text: `${hit.verdict.reason}。${note ? `${note}。` : ""}${hit.verdict.kind === "captcha" ? "系统过不了这个验证码" : "要登录"}，要人在远程画面里处理。` },
        { title: "网址", text: hit.facts.url },
        {
          title: "怎么处理",
          text: `在这次运行的「看浏览器」里打开远程画面（浏览器 ${instance.id}），处理好验证码或登录后点「已处理好了」。Chrome 保留 ${settings.humanHoldMinutes} 分钟；过了时间会写回登录态并关掉，到时请在浏览器页「打开 Chrome」处理，再回来点「已处理好了」。`,
        },
        { title: "来自", text: `任务「${snapshot.task.title}」的运行 ${session.id}` },
      ],
      primary: "已处理好了",
      secondary: "处理不了",
      link: { page: "browsers", id: instance.profileId },
      browser: {
        browserId: instance.id,
        sessionId: session.id,
        profileId: instance.profileId,
        ...(account ? { accountId: account.accountId } : {}),
        url: hit.facts.url,
        reason: hit.verdict.reason,
        ...(file ? { screenshotFileId: file.id } : {}),
      },
    }
    return {
      output: `${prefix ? `${prefix}\n\n` : ""}检测到${what}：${hit.verdict.reason}。${note ? `${note}。` : ""}已交给负责人在远程画面里处理，处理好后会叫你继续；继续后先看一下页面现状再接着做。${file ? `截图：${file.id}` : ""}`,
      signals: ["page_needs_human"],
      suspend: {
        kind: "human",
        item: {
          kind: "login",
          title,
          summary,
          assigneeId: snapshot.task.ownerId,
          taskId: snapshot.task.id,
          sessionId: session.id,
          urgency: 1,
          detail,
          what: `等人处理：${title}`,
        },
      },
    }
  }

  /** 规则要求「截图存证」（M3）：这次运行开着 Chrome 时截当前页面，存成 session 文件；没开着就返回 undefined */
  async evidenceScreenshot(): Promise<{ fileId: string } | undefined> {
    const instance = this.instance
    if (!instance || instance.state === "closing") return undefined
    const shot = await instance.screenshot().catch(() => undefined)
    if (!shot) return undefined
    const row = await saveFile(this.ctx.db, { data: shot, name: `rule-${Date.now()}.jpg`, mime: "image/jpeg", kind: "screenshot", sessionId: this.ctx.session.id })
    return { fileId: row.id }
  }

  /**
   * 记接口（docs/dev/solidify.md 19.3）：一次浏览器工具调用开始时记下 seq 走到哪了（还没开 Chrome 就是 undefined）。
   * 网关在调用前后各调一次，把这一步记下的请求的 seq 范围写进过程记录的 trace.network
   */
  networkMark(): number | undefined {
    return this.instance?.network?.seq
  }

  /** 一次浏览器工具调用结束：等一小会儿让这一步触发的请求记完，有新行就写文件；返回这一步记下的 seq 范围（没有就 undefined） */
  async networkSettle(mark: number | undefined): Promise<{ first: number; last: number } | undefined> {
    const log = this.instance?.network
    if (!log) return undefined
    await log.drain(NETWORK_DRAIN_MS)
    await log.flush()
    // 调用前还没开 Chrome：这次开的，读完已有文件以后的都算这一步
    const first = (mark ?? log.loadedSeq) + 1
    return log.seq >= first ? { first, last: log.seq } : undefined
  }

  /** gateway 关闭（session 结束、挂起、交接）：要保留就保留（等人处理验证码），否则写回登录态、关掉 Chrome、释放租约 */
  async close(reason = "运行停下了") {
    // 后台的存档截图先存完（关 Chrome 之前）；记下的接口写一次（两次调用之间页面自己发的）
    await Promise.allSettled([...this.pendingSaves])
    await this.instance?.network?.recordResponded()
    await this.instance?.network?.flush()
    const manager = getBrowserManager()
    const { db, session } = this.ctx
    if (!manager || !manager.forSession(session.id)) return
    // 顺手清掉 90 天前的操作历史
    await db.delete(t.browserActions).where(lt(t.browserActions.at, new Date(Date.now() - 90 * 24 * 60 * 60 * 1000))).catch(() => {})
    const holdMinutes = this.holdMinutes
    this.holdMinutes = undefined
    this.instance = undefined
    try {
      const outcome = await manager.releaseSession(session.id, { holdMinutes, reason })
      if (outcome.held)
        await appendEvent(db, session.id, { kind: "wait", title: `Chrome 保留 ${holdMinutes} 分钟，等人在远程画面里处理` })
      else if (outcome.summary)
        await appendEvent(db, session.id, {
          kind: "plan",
          title: outcome.summary.vaultVersion ? "关掉了 Chrome，登录态已写回保险箱" : "关掉了 Chrome",
          detail: outcome.summary.skipped ?? (outcome.summary.vaultVersion ? `保险箱 v${outcome.summary.vaultVersion}` : null),
        })
    } catch (error) {
      console.warn(`[browser] 关 session ${session.id} 的 Chrome 出错：${(error as Error).message}`)
    }
  }
}
