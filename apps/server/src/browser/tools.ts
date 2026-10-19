// 「浏览器」工具组（m2.md 第 1、5、6、7 条）：任务选了系统自带的「浏览器」工具，工具网关就开放这一组：
// - browser.use({ profileId })：选用哪个 Chrome 配置（只允许一个时第一次调浏览器工具自动选上）；
// - Playwright MCP 的工具，browser_xxx 统一换成 browser.xxx（给模型的名字把点换成下划线，又变回 browser_xxx）；
//   一律屏蔽 browser_run_code_unsafe，browser_evaluate 要任务里打开「允许执行脚本」才给。
// 每次调用：调之前查导航参数（白名单、账号租约）→ 交给 MCP → 调完后兜底扫一遍页面、取走被拦下的导航、
// 截图存成 session 文件、检测验证码和登录页。验证码先自己试着过（设置里的开关，captcha.ts），
// 过不了的和登录页（存了密码的先自动登录）截图、生成「登录」类要人办的事、session 等人处理，Chrome 保留着。
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { extname, join } from "node:path"

import { eq, lt, sql } from "drizzle-orm"
import {
  browserActionLabel,
  browserActionTag,
  hostOf,
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
import { judgePage, parseVisionAnswer, VISION_PROMPT, type Verdict } from "./detect.js"
import { autoLogin, loadAccountPassword, loginModelId, type AutoLoginCaptcha } from "./auto-login.js"
import { CAPTCHA_MAX_TRIES, solveCaptcha, type CaptchaResult, type CaptchaTry } from "./captcha.js"
import { ProfileFullError, type BlockedNavigation, type BrowserInstance } from "./instance.js"
import { accountForHost } from "./leases.js"
import { getBrowserManager } from "./manager.js"
import { BLOCKED_MCP_TOOLS, EVALUATE_TOOL, listBrowserMcpTools } from "./mcp.js"

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
const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg"])
const PROXY_ERROR = /ERR_(SOCKS_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|SOCKS_CONNECTION_HOST_UNREACHABLE|PROXY_AUTH_UNSUPPORTED)/

export const browserToolId = (mcpName: string) => `browser.${mcpName.replace(/^browser_/, "")}`

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
  private selected?: string
  private instance?: BrowserInstance
  private proxyWarned = false
  /** 每个页面自动过验证码试了几次（问一次视觉模型算一次） */
  private readonly captchaTries = new Map<string, number>()
  /** 验证码在表单里的页面：等 agent 填好别的再调 browser_fill_captcha，检测到时不再自己提交、也不交给人 */
  private readonly captchaForms = new Set<string>()
  /** 遇到验证码 / 登录页挂起时：Chrome 保留多少分钟（gateway 关闭时交给 manager） */
  holdMinutes?: number

  private constructor(ctx: Ctx, mcpTools: McpToolInfo[]) {
    this.ctx = ctx
    this.mcpTools = mcpTools
    this.selected = ctx.session.browserProfileId ?? undefined
  }

  static async create(ctx: Ctx): Promise<BrowserTools> {
    const tools = await listBrowserMcpTools()
    const group = new BrowserTools(ctx, tools)
    // 等人处理时保留着的 Chrome：session 继续了，接着用同一个（取消保留）
    const manager = getBrowserManager()
    const held = manager?.forSession(ctx.session.id)
    if (manager && held) {
      if (held.state === "held") await manager.claim(held)
      group.instance = held
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
          name: "浏览器：选用 Chrome",
          summary: "选用哪个 Chrome 配置（代理、登录态、时区语言都跟着配置走）",
          description: `选用哪个 Chrome 配置，之后的浏览器工具都在这个 Chrome 里操作。本任务允许的：${this.profiles.map((profile) => `${profile.id}「${profile.name}」${profile.description ? `：${profile.description}` : ""}`).join("；") || "无"}。只允许一个时不用调，第一次用浏览器工具会自动选上。`,
          source: "builtin",
          risk: "read",
        },
        jsonSchema: useSchema,
        validator: z.object({ profileId: z.string().min(1) }),
        execute: (input) => this.use((input as { profileId: string }).profileId),
      },
    ]
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
    for (const tool of this.mcpTools) {
      if (BLOCKED_MCP_TOOLS.has(tool.name)) continue
      if (tool.name === EVALUATE_TOOL && !browser?.allowEvaluate) continue
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
    return entries
  }

  private async use(profileId: string): Promise<ToolOutcome> {
    if (!this.profiles.some((profile) => profile.id === profileId))
      return fail(`本任务不允许用 Chrome 配置 ${profileId}。可选：${this.profiles.map((profile) => profile.id).join("、") || "无"}`)
    this.selected = profileId
    await this.ctx.db.update(t.sessions).set({ browserProfileId: profileId }).where(eq(t.sessions.id, this.ctx.session.id))
    const switching = this.instance && this.instance.profileId !== profileId
    return { output: `已选用 Chrome「${this.profileName(profileId)}」（${profileId}）。${switching ? "之前开着的 Chrome 会写回登录态后关掉，" : ""}下一次调浏览器工具时打开。` }
  }

  /** 现在用哪个 Chrome 配置：选过的，或者只允许一个时自动选上（并记到 session 上） */
  private async profileId(): Promise<string | undefined> {
    if (this.selected) return this.selected
    if (this.profiles.length === 1) {
      this.selected = this.profiles[0]!.id
      await this.ctx.db.update(t.sessions).set({ browserProfileId: this.selected }).where(eq(t.sessions.id, this.ctx.session.id))
      return this.selected
    }
    return undefined
  }

  /** 懒启动：第一次真正调浏览器工具时才起 Chrome 和 MCP */
  private async ensure(): Promise<BrowserInstance | ToolOutcome> {
    const profileId = await this.profileId()
    if (!profileId)
      return fail(
        this.profiles.length
          ? `先用 browser_use 选一个 Chrome 配置。可选：${this.profiles.map((profile) => `${profile.id}「${profile.name}」`).join("、")}`
          : "本任务没有可用的 Chrome 配置（任务里允许的 Chrome 配置都不在了），请让负责人检查任务设置"
      )
    const manager = getBrowserManager()
    if (!manager) return fail("这个进程不能开浏览器（只有带 Chrome 的 worker 能开）")
    if (this.instance && this.instance.state !== "closing" && this.instance.profileId === profileId) return this.instance
    const { db, session, snapshot } = this.ctx
    try {
      const fresh = !manager.forSession(session.id)
      this.instance = await manager.acquireForSession({
        sessionId: session.id,
        profileId,
        allowedDomains: snapshot.browser?.allowedDomains ?? [],
        onQueued: async (used, max) => {
          await appendEvent(db, session.id, {
            kind: "wait",
            title: "等待浏览器",
            detail: `这台 worker 同时最多开 ${max} 个 Chrome，现在已经开了 ${used} 个，排队等空位。`,
          })
        },
      })
      await this.instance.ensureMcp()
      if (fresh)
        await appendEvent(db, session.id, {
          kind: "plan",
          title: `打开了 Chrome「${this.profileName(profileId)}」`,
          detail: `浏览器 ${this.instance.id}${snapshot.browser?.allowedDomains.length ? `；网址白名单：${snapshot.browser.allowedDomains.join("、")}` : ""}`,
        })
      return this.instance
    } catch (error) {
      if (error instanceof ProfileFullError) return this.profileFullOutcome(profileId, error)
      const message = (error as Error).message
      if (/gost|代理/.test(message)) await this.warnProxy(message)
      return fail(`浏览器起不来：${message}`)
    }
  }

  /** 这个 Chrome 配置同时在用的运行满了：session 挂起「等待浏览器」，有运行用完关掉 Chrome 时叫醒 */
  private async profileFullOutcome(profileId: string, error: ProfileFullError): Promise<ToolOutcome> {
    const settings = await loadEngineSettings(this.ctx.db)
    return {
      output: `Chrome「${error.profileName}」同时最多 ${error.max} 个运行在用，现在已经满了，已排队等空位。先挂起，轮到时会叫你继续（网页需要重新打开）。`,
      suspend: {
        kind: "wait",
        input: {
          what: `等待浏览器：Chrome「${error.profileName}」同时最多 ${error.max} 个运行在用`,
          triggerKind: "event",
          event: profileEventName(profileId),
          fallbackDays: settings.eventFallbackDays,
          deadlineAt: new Date(Date.now() + settings.eventFallbackDays * 24 * 60 * 60 * 1000),
        },
      },
    }
  }

  /** 代理挂了：报错 + 告警（通知任务负责人），绝不退回直连 */
  private async warnProxy(detail: string) {
    if (this.proxyWarned) return
    this.proxyWarned = true
    const { db, session, snapshot } = this.ctx
    const name = this.selected ? this.profileName(this.selected) : ""
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

  private async callMcp(name: string, input: Record<string, unknown>): Promise<ToolOutcome> {
    // 白名单不用等 Chrome 起来就能查
    const target = this.navigationUrl(name, input)
    if (target) {
      const allowed = urlAllowed(target, this.ctx.snapshot.browser?.allowedDomains ?? [])
      if (!allowed.ok) {
        await this.record(name, true, target)
        return fail(`被拦下：${allowed.reason}。只能打开白名单里的网址。`)
      }
    }
    const ready = await this.ensure()
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
    const result = await executeMcpTool(this.connection(instance, mcp.client), name, args)
    const lines: string[] = [result.output]
    await this.record(name, Boolean(result.isError), instance.currentPage()?.url() ?? url)
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

    if (READ_ONLY_TOOLS.has(name)) return { ...result, output: lines.join("\n") }

    // 调完：兜底扫一遍页面，取走被拦下的导航
    await instance.sweepPages()
    const blocked = instance.drainBlocked()
    if (blocked.length) return this.blockedOutcome(blocked, lines.join("\n"))

    let facts: ToolOutcome["facts"]
    if ((NAVIGATION_TOOLS.has(name) || (name === "browser_tabs" && args.action === "new")) && !result.isError) {
      const shot = await instance.screenshot()
      if (shot) {
        const row = await saveFile(db, { data: shot, name: `page-${Date.now()}.jpg`, mime: "image/jpeg", kind: "screenshot", sessionId: session.id })
        lines.push(`（已自动截图存档：${row.id}）`)
      }
      // 给规则「自动记录检查点」用：打开的是哪个网页
      const page = instance.currentPage()
      if (page) facts = { url: page.url(), title: await page.title().catch(() => "") }
    }

    let hit = await this.detect(instance)
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
      else if (solved) captchaNote = `自动过验证码没成功：${solved.detail}`
    }
    if (hit) {
      // 登录页：账号存了密码就先让登录小 agent 用它登录，登不上再交给人
      const login = hit.verdict.kind === "login" ? await this.tryAutoLogin(instance, hit) : undefined
      if (login?.ok) return { output: [...lines, login.text].join("\n"), isError: result.isError, facts }
      return { ...(await this.humanOutcome(instance, hit, lines.join("\n"), login?.text ?? captchaNote)), facts }
    }
    return { output: lines.join("\n"), isError: result.isError, facts }
  }

  /** 操作历史记一行（浏览器页看）。记不上不影响工具本身 */
  private async record(name: string, failed: boolean, url: string | undefined) {
    const profileId = this.selected
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
    if (solved.unsupported || (this.captchaTries.get(pageKey(page.url())) ?? 0) >= CAPTCHA_MAX_TRIES)
      return this.humanOutcome(instance, await hit("页面上的验证码要人过"), "", `自动过验证码没成功：${solved.detail}`)
    return fail(`没认出验证码：${solved.detail}`)
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

  /** gateway 关闭（session 结束、挂起、交接）：要保留就保留（等人处理验证码），否则写回登录态、关掉 Chrome、释放租约 */
  async close(reason = "运行停下了") {
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
