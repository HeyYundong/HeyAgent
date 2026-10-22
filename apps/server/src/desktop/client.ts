// 连一台桌面：读配置（密钥只在这里解密）、调桌面服务的 HTTP 接口（健康检查、截图、传文件）、连 Windows-MCP。
// 两个服务都带 Authorization: Bearer <密钥>（docs/dev/desktop.md 第 0、6 节）。
import { createMCPClient, type MCPClient } from "@ai-sdk/mcp"
import type { DesktopHealth } from "@heyagent/shared"
import { eq } from "drizzle-orm"
import sharp from "sharp"

import * as t from "../db/schema.js"
import type { DbLike } from "../engine/records.js"
import { decryptText, type Keyring } from "../lib/crypto.js"

export interface DesktopTarget {
  id: string
  name: string
  mcpUrl: string
  agentUrl: string
  /** 密钥原文：只在请求头里用，不写日志、不进工具输出 */
  key: string
}

/** 桌面连不上（网络不通、服务没起、密钥不对）：工具结果报错，不挂起 */
export class DesktopUnreachableError extends Error {}

const AGENT_TIMEOUT_MS = 30_000
const FILE_TIMEOUT_MS = 300_000
const MAX_FILE_BYTES = 200 * 1024 * 1024

/** 读一台桌面的配置和密钥。找不到返回 undefined；没存密钥时 key 为空串（请求会被桌面拒绝） */
export async function loadDesktopTarget(db: DbLike, keyring: Keyring, desktopId: string): Promise<DesktopTarget | undefined> {
  const [row] = await db
    .select({ desktop: t.desktops, secret: t.secrets })
    .from(t.desktops)
    .leftJoin(t.secrets, eq(t.secrets.id, t.desktops.keySecretId))
    .where(eq(t.desktops.id, desktopId))
  if (!row) return undefined
  const { desktop, secret } = row
  const key = secret ? decryptText(keyring, secret.enc, { table: "secrets", id: secret.id, version: secret.version }) : ""
  return { id: desktop.id, name: desktop.name, mcpUrl: desktop.mcpUrl, agentUrl: desktop.agentUrl, key }
}

const base = (url: string) => url.replace(/\/+$/, "")
const authHeader = (target: Pick<DesktopTarget, "key">) => ({ Authorization: `Bearer ${target.key}` })

/** 桌面服务的远程画面地址（ws / wss） */
export const desktopViewUrl = (target: Pick<DesktopTarget, "agentUrl">) => `${base(target.agentUrl).replace(/^http/, "ws")}/view`

/** 报错信息里去掉密钥原文（万一服务把请求头写进了错误里） */
const clean = (message: string, key: string) => (key ? message.split(key).join("[已隐藏]") : message)

async function agentFetch(target: DesktopTarget, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  let res: Response
  try {
    res = await fetch(`${base(target.agentUrl)}${path}`, {
      ...init,
      headers: { ...authHeader(target), ...(init.headers as Record<string, string> | undefined) },
      redirect: "error",
      signal: AbortSignal.timeout(init.timeoutMs ?? AGENT_TIMEOUT_MS),
    })
  } catch (error) {
    const cause = (error as { cause?: { code?: string; message?: string } }).cause
    throw new DesktopUnreachableError(clean(`桌面服务连不上（${cause?.code ?? cause?.message ?? (error as Error).message}）`, target.key))
  }
  // 401 只表示密钥不对；403 是桌面服务不让取这个路径（不在用户目录、C:\HeyAgent\files 下面），按普通错误报
  if (res.status === 401) throw new DesktopUnreachableError("桌面服务拒绝了请求：密钥不对（请在「桌面」页检查密钥）")
  if (!res.ok) throw new Error(clean(await agentErrorText(res), target.key))
  return res
}

/** 桌面服务的错误都是 { error: "…" }（apps/desktop-agent/heyagent_desktop_agent/app.py）：取出原因，取不到就给状态码 */
async function agentErrorText(res: Response): Promise<string> {
  const text = (await res.text().catch(() => "")).slice(0, 1000)
  let reason = text.slice(0, 300)
  try {
    const body = JSON.parse(text) as { error?: unknown }
    if (typeof body.error === "string" && body.error) reason = body.error.slice(0, 300)
  } catch {
    // 不是 JSON：用原文
  }
  return reason ? `${reason}（桌面服务返回 ${res.status}）` : `桌面服务返回 ${res.status}`
}

/**
 * 取文件时的文件名：X-File-Name 是 UTF-8 百分号编码（同 encodeURIComponent），没有就看 Content-Disposition 的 filename*=UTF-8''…，
 * 都没有用路径的最后一段
 */
export function downloadName(headers: Headers, path: string): string {
  const decode = (value: string) => {
    try {
      return decodeURIComponent(value)
    } catch {
      return value
    }
  }
  const header = headers.get("x-file-name")
  if (header) return decode(header)
  const disposition = headers.get("content-disposition") ?? ""
  const star = /filename\*\s*=\s*(?:UTF-8|utf-8)''([^;]+)/.exec(disposition)
  if (star) return decode(star[1]!.trim())
  const plain = /filename\s*=\s*"([^"]+)"/.exec(disposition)
  if (plain) return plain[1]!
  return path.split(/[\\/]/).pop() || "file"
}

export async function agentHealth(target: DesktopTarget, timeoutMs = AGENT_TIMEOUT_MS): Promise<{ version?: string; screen?: { width: number; height: number } }> {
  const res = await agentFetch(target, "/health", { timeoutMs })
  const body = (await res.json().catch(() => ({}))) as { version?: unknown; screen?: { width?: unknown; height?: unknown } }
  const width = Number(body.screen?.width)
  const height = Number(body.screen?.height)
  return {
    ...(typeof body.version === "string" ? { version: body.version } : {}),
    ...(width > 0 && height > 0 ? { screen: { width, height } } : {}),
  }
}

export interface DesktopScreenshot {
  data: Buffer
  /** 图片的宽高（缩过的） */
  width: number
  height: number
  /** 屏幕的物理像素（坐标按它） */
  screenWidth: number
  screenHeight: number
}

/** 截当前屏幕（JPEG）。maxWidth：最宽多少像素（桌面服务等比缩，0 = 不缩）。锁屏、UAC 安全桌面时桌面服务回 503，这里抛错 */
export async function agentScreenshot(target: DesktopTarget, options: { maxWidth?: number; quality?: number } = {}): Promise<DesktopScreenshot> {
  const res = await agentFetch(target, `/screenshot?maxWidth=${options.maxWidth ?? 1280}&quality=${options.quality ?? 70}`)
  const data = Buffer.from(await res.arrayBuffer())
  const meta = await sharp(data).metadata().catch(() => undefined)
  const size = { width: meta?.width ?? 0, height: meta?.height ?? 0 }
  const screenWidth = Number(res.headers.get("x-screen-width")) || size.width
  const screenHeight = Number(res.headers.get("x-screen-height")) || size.height
  return { data, width: size.width, height: size.height, screenWidth, screenHeight }
}

/** 把文件传到桌面上，返回桌面上的路径 */
export async function agentUpload(target: DesktopTarget, name: string, data: Buffer): Promise<{ path: string; size: number }> {
  // 桌面服务收到超过 200 MB 的会回 413，先挡住免得白传
  if (data.length > MAX_FILE_BYTES) throw new Error(`文件太大（${Math.round(data.length / 1024 / 1024)} MB），最多 200 MB`)
  const res = await agentFetch(target, `/files?name=${encodeURIComponent(name)}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: new Uint8Array(data),
    timeoutMs: FILE_TIMEOUT_MS,
  })
  const body = (await res.json()) as { path?: unknown; size?: unknown }
  if (typeof body.path !== "string") throw new Error("桌面服务没有返回文件路径")
  return { path: body.path, size: Number(body.size) || data.length }
}

/**
 * 让桌面服务输入一段文字（POST /type，中文等非 ASCII 的字走这里：Windows-MCP 0.8.8 的 Type 报「打好了」但中文没上屏）。
 * 桌面服务自己处理换行、长文字（剪贴板）。返回输入了几个字；旧版桌面服务没有这个接口时报错说清楚
 */
export async function agentType(target: DesktopTarget, text: string): Promise<number> {
  let res: Response
  try {
    res = await agentFetch(target, "/type", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
      timeoutMs: FILE_TIMEOUT_MS,
    })
  } catch (error) {
    if (!(error instanceof DesktopUnreachableError) && /（桌面服务返回 (404|405)）$|^桌面服务返回 (404|405)$/.test((error as Error).message))
      throw new Error("这台桌面的桌面服务版本太旧，没有输入文字的接口（/type），输入不了中文。请管理员更新桌面服务（重新运行 install.ps1）", { cause: error })
    throw error
  }
  const body = (await res.json().catch(() => ({}))) as { ok?: unknown; chars?: unknown }
  if (body.ok !== true) throw new Error("桌面服务没有确认输入成功")
  return Number(body.chars) || text.length
}

/** 从桌面上取一个文件（≤200 MB） */
export async function agentDownload(target: DesktopTarget, path: string): Promise<{ name: string; data: Buffer }> {
  const res = await agentFetch(target, `/files?path=${encodeURIComponent(path)}`, { timeoutMs: FILE_TIMEOUT_MS })
  const length = Number(res.headers.get("content-length"))
  if (length > MAX_FILE_BYTES) throw new Error(`文件太大（${Math.round(length / 1024 / 1024)} MB），最多 200 MB`)
  const data = Buffer.from(await res.arrayBuffer())
  if (data.length > MAX_FILE_BYTES) throw new Error("文件太大，最多 200 MB")
  return { name: downloadName(res.headers, path), data }
}

/** 连 Windows-MCP（streamable HTTP）。连不上抛 DesktopUnreachableError */
export async function connectDesktopMcp(target: DesktopTarget, timeoutMs = 20_000): Promise<MCPClient> {
  try {
    return await createMCPClient({
      transport: { type: "http", url: target.mcpUrl, headers: authHeader(target), redirect: "error" },
      clientName: "heyagent",
      initializationOptions: { timeout: timeoutMs },
    })
  } catch (error) {
    throw new DesktopUnreachableError(clean(`Windows-MCP 连不上（${errorText(error)}）`, target.key))
  }
}

/** 错误信息：fetch 失败时带上底层原因（ECONNREFUSED 等） */
export function errorText(error: unknown): string {
  const cause = (error as { cause?: { code?: string; message?: string } }).cause
  const message = (error as Error).message ?? String(error)
  return cause?.code || cause?.message ? `${message}：${cause.code ?? cause.message}` : message
}

/** 看起来是连接出了问题（不是工具本身报错）：网络不通、超时、被拒绝 */
export function isConnectionError(error: unknown): boolean {
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|ENOTFOUND|EPIPE|socket hang up|other side closed|network|timed? ?out|aborted|401|403|Unauthorized/i.test(errorText(error))
}

/** 「测试连接」：MCP 列一次工具、桌面服务调 /health，各自最多 10 秒 */
export async function testDesktop(target: DesktopTarget, timeoutMs = 10_000): Promise<DesktopHealth> {
  const mcp = (async (): Promise<DesktopHealth["mcp"]> => {
    const started = Date.now()
    const connecting = connectDesktopMcp(target, timeoutMs)
    try {
      const toolCount = await withTimeout(
        connecting.then(async (client) => (await client.listTools({ options: { timeout: timeoutMs } })).tools.length),
        timeoutMs
      )
      return { ok: true, ms: Date.now() - started, toolCount }
    } catch (error) {
      return { ok: false, ms: Date.now() - started, error: clean(errorText(error), target.key).slice(0, 500) }
    } finally {
      // 超时了也要等它连上以后关掉，不留连接
      void connecting.then((client) => client.close()).catch(() => {})
    }
  })()
  const agent = (async (): Promise<DesktopHealth["agent"]> => {
    const started = Date.now()
    try {
      const health = await agentHealth(target, timeoutMs)
      return { ok: true, ms: Date.now() - started, ...health }
    } catch (error) {
      return { ok: false, ms: Date.now() - started, error: clean((error as Error).message, target.key).slice(0, 500) }
    }
  })()
  return { mcp: await mcp, agent: await agent }
}

async function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`超过 ${Math.round(ms / 1000)} 秒没有响应`)), ms)
      }),
    ])
  } finally {
    clearTimeout(timer)
  }
}
