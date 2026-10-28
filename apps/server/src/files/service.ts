// 文件的读写：上传、agent 产出、太长的工具输出全文、附件。
// 归属：task_id 有值且 session_id 为空 = 任务附件（跨运行一直有效）；session_id 有值 = 只属于那次运行。
import { randomBytes } from "node:crypto"
import { extname } from "node:path"

import { and, asc, eq, inArray, isNull, or, sql } from "drizzle-orm"
import type { SessionFile } from "@heyagent/shared"

import * as t from "../db/schema.js"
import type { DbLike } from "../engine/records.js"
import { runtime } from "../engine/runtime.js"
import { LocalDiskStorage, sha256Hex, type FileStorage } from "./storage.js"

/**
 * gallery / gallery_thumb：图库的原图和缩略图（归 gallery_images 管，删图时一起删）；
 * compare：比物的两张图（归 comparisons 管，删记录时没人再用就一起删）；
 * import：要导入的 zip 包（归 imports 管，放弃导入时一起删；里面可能有明文密钥，只有主管能下载）；
 * download：agent 在浏览器里下载的文件（browser/downloads.ts，属于那次运行）；
 * clipboard：浏览器剪贴板工具存的（复制的网页图片、读到的剪贴板图片和长内容，browser/clipboard.ts，属于那次运行）；
 * network：记下的网页请求 network/requests.jsonl（docs/dev/solidify.md 19.3，属于那次运行，一次运行一个，记的过程中覆盖写）
 */
export type FileKind =
  "upload" | "attachment" | "artifact" | "tool_output" | "screenshot" | "gallery" | "gallery_thumb" | "import" | "compare" | "download" | "clipboard" | "network"
export type FileRow = typeof t.files.$inferSelect

let storageInstance: { root: string; storage: FileStorage } | undefined

export function fileStorage(): FileStorage {
  if (!storageInstance || storageInstance.root !== runtime.filesDir)
    storageInstance = {
      root: runtime.filesDir,
      storage: new LocalDiskStorage(runtime.filesDir),
    }
  return storageInstance.storage
}

const MIME_BY_EXT: Record<string, string> = {
  ".csv": "text/csv",
  ".tsv": "text/tab-separated-values",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".json": "application/json",
  ".txt": "text/plain",
  ".log": "text/plain",
  ".html": "text/html",
  ".htm": "text/html",
  ".xml": "application/xml",
  ".yaml": "application/yaml",
  ".yml": "application/yaml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".zip": "application/zip",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".xlsm": "application/vnd.ms-excel.sheet.macroEnabled.12",
  ".xlsb": "application/vnd.ms-excel.sheet.binary.macroEnabled.12",
  ".xls": "application/vnd.ms-excel",
  ".ods": "application/vnd.oasis.opendocument.spreadsheet",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  // 代码和配置（docs/dev/session-space.md 3.1，界面按同一张表高亮）：全部 text/*，isTextMime 不用改
  ".py": "text/x-python",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".cjs": "text/javascript",
  ".ts": "text/x-typescript",
  ".sh": "text/x-shellscript",
  ".bash": "text/x-shellscript",
  ".sql": "text/x-sql",
  ".toml": "text/x-toml",
  ".ini": "text/plain",
  ".cfg": "text/plain",
  ".jsonl": "text/plain",
}

export const mimeFromName = (name: string) =>
  MIME_BY_EXT[extname(name).toLowerCase()] ?? "application/octet-stream"

/** agent 能存的文本格式 */
export const TEXT_SAVE_EXTENSIONS = [
  ".csv",
  ".tsv",
  ".md",
  ".markdown",
  ".json",
  ".txt",
  ".html",
  ".htm",
  ".xml",
  ".yaml",
  ".yml",
  ".log",
  // 代码和配置（session 空间）。.env 不加，免得养成存密钥的习惯
  ".py",
  ".js",
  ".mjs",
  ".cjs",
  ".ts",
  ".sh",
  ".bash",
  ".sql",
  ".toml",
  ".ini",
  ".cfg",
  ".jsonl",
]

export const isTextMime = (mime: string) =>
  mime.startsWith("text/") ||
  ["application/json", "application/xml", "application/yaml"].includes(mime)
export const isImageMime = (mime: string) =>
  ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(mime)

export const fileUrl = (id: string) => `/api/files/${id}`

const newFileId = () => `f-${randomBytes(8).toString("hex")}`

/** 文件名只留安全的字符，避免下载时的头注入和路径问题 */
export function safeFileName(name: string) {
  const cleaned = name.replace(/[\\/\r\n"\0]/g, "_").trim()
  return (cleaned || "file").slice(0, 200)
}

export interface SaveFileInput {
  data: Buffer
  name: string
  mime?: string
  kind: FileKind
  sessionId?: string | null
  taskId?: string | null
  createdById?: string | null
  /** session 空间里的路径（只给 agent 写的文件，已经规范化过；一般走 writeSpaceFile） */
  path?: string | null
}

/** 内容的存放位置：按月分目录。覆盖时换一个新位置（blob 不可变），旧的提交后删 */
const newStoragePath = (id: string, overwrite = false) => {
  const now = new Date()
  return `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}${overwrite ? `-${randomBytes(4).toString("hex")}` : ""}`
}

export async function saveFile(
  db: DbLike,
  input: SaveFileInput
): Promise<FileRow> {
  const id = newFileId()
  const name = safeFileName(input.name)
  const storagePath = newStoragePath(id)
  await fileStorage().put(storagePath, input.data)
  const [row] = await db
    .insert(t.files)
    .values({
      id,
      sessionId: input.sessionId ?? null,
      taskId: input.taskId ?? null,
      kind: input.kind,
      name,
      mime: input.mime ?? mimeFromName(name),
      size: input.data.length,
      storagePath,
      sha256: sha256Hex(input.data),
      createdById: input.createdById ?? null,
      path: input.path ?? null,
    })
    .returning()
  return row!
}

export async function getFileRow(
  db: DbLike,
  id: string
): Promise<FileRow | undefined> {
  const [row] = await db.select().from(t.files).where(eq(t.files.id, id))
  return row
}

export async function readFileData(row: FileRow): Promise<Buffer> {
  return fileStorage().get(row.storagePath)
}

const SESSION_FILE_KINDS = ["attachment", "artifact", "tool_output", "screenshot", "upload", "download", "clipboard", "network"]

const toSessionFile = (
  row: FileRow,
  scope: "task" | "session",
  path = spacePathOf(row)
): SessionFile => ({
  id: row.id,
  name: row.name,
  mime: row.mime,
  size: row.size,
  kind: (SESSION_FILE_KINDS.includes(row.kind)
    ? row.kind
    : "attachment") as SessionFile["kind"],
  scope,
  path,
  createdAt: row.createdAt.toISOString(),
  updatedAt: row.updatedAt.toISOString(),
  url: fileUrl(row.id),
})

/** session 的附件和产物：快照里的任务附件 + 只属于这次运行的文件，带在空间里的路径（2.3） */
export async function listSessionFiles(
  db: DbLike,
  sessionId: string,
  snapshotAttachmentIds: string[]
): Promise<SessionFile[]> {
  return (await listSpace(db, sessionId, snapshotAttachmentIds)).map((entry) =>
    toSessionFile(entry.row, entry.scope, entry.path)
  )
}

// ---------- Session 空间（docs/dev/session-space.md 第 2 节） ----------

/** 别的来源在空间里的固定目录（只读）；agent 写的文件不能用这几个开头 */
export const RESERVED_SPACE_DIRS = ["attachments", "downloads", "screenshots", "tool-outputs", "clipboard", "network", "subs"] as const
const DIR_BY_KIND: Record<string, (typeof RESERVED_SPACE_DIRS)[number]> = {
  attachment: "attachments",
  upload: "attachments",
  download: "downloads",
  screenshot: "screenshots",
  tool_output: "tool-outputs",
  clipboard: "clipboard",
  network: "network",
}
const spaceDirOf = (kind: string) => DIR_BY_KIND[kind] ?? "attachments"

export const SPACE_PATH_MAX = 300
const SEGMENT_MAX = 100
/** 文件系统一段最多 255 字节：100 个汉字就超了，沙箱里建不出来 */
const SEGMENT_MAX_BYTES = 255
const DEPTH_MAX = 8
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/

export class SpacePathError extends Error {}

/**
 * agent 给的路径规范化（2.1）：去掉开头的 / 和 ./；不许 ..、. 和空段，不许控制字符、反斜杠和双引号；
 * 每段 ≤ 100 字（且 ≤ 255 字节），整条 ≤ 300 字，最多 8 层；不能以保留目录开头。不合规矩抛 SpacePathError（文字直接给 agent）
 */
export function normalizeSpacePath(raw: string): string {
  let path = raw.trim()
  for (;;) {
    if (path.startsWith("/")) path = path.slice(1)
    else if (path.startsWith("./")) path = path.slice(2)
    else break
  }
  if (!path) throw new SpacePathError("路径不能是空的（给相对路径，例如 state/progress.json）")
  if (CONTROL_CHARS.test(path)) throw new SpacePathError(`路径里不能有换行、制表符这类控制字符：${JSON.stringify(raw)}`)
  if (/[\\"]/.test(path)) throw new SpacePathError(`路径里不能有反斜杠和双引号，目录用 / 隔开：${raw}`)
  if (path.length > SPACE_PATH_MAX) throw new SpacePathError(`路径太长（${path.length} 字），最多 ${SPACE_PATH_MAX} 字`)
  const segments = path.split("/")
  if (segments.length > DEPTH_MAX) throw new SpacePathError(`目录太深（${segments.length} 层），最多 ${DEPTH_MAX} 层：${path}`)
  for (const segment of segments) {
    if (segment === "..") throw new SpacePathError(`路径里不能有 ..：${raw}`)
    if (segment === "" || segment === ".") throw new SpacePathError(`路径里有空的一段（// 或 /./，或者以 / 结尾）：${raw}`)
    if (segment.length > SEGMENT_MAX || Buffer.byteLength(segment) > SEGMENT_MAX_BYTES)
      throw new SpacePathError(`「${segment.slice(0, 20)}…」这一段太长，每段最多 ${SEGMENT_MAX} 字`)
  }
  if ((RESERVED_SPACE_DIRS as readonly string[]).includes(segments[0]!.toLowerCase()))
    throw new SpacePathError(
      `${segments[0]}/ 是只读的保留目录（${RESERVED_SPACE_DIRS.map((dir) => `${dir}/`).join(" ")}放附件、下载、截图、工具输出全文、剪贴板、记下的网页请求和子 agent 的文件），换一个路径，例如 out/${segments.slice(1).join("/") || "result.txt"}`
    )
  return path
}

/** 别的来源的文件名放进空间时的样子：只留文件系统里合法的字符，. 和 .. 换掉，太长的截短（保留扩展名） */
export function spaceFileName(name: string) {
  let cleaned = name.replace(new RegExp(`${CONTROL_CHARS.source}|[\\\\/"]`, "g"), "_").trim()
  if (!cleaned || cleaned === "." || cleaned === "..") cleaned = "file"
  if (Buffer.byteLength(cleaned) <= 200) return cleaned
  const ext = extname(cleaned).slice(0, 20)
  let stem = cleaned.slice(0, cleaned.length - ext.length)
  while (stem && Buffer.byteLength(stem + ext) > 200) stem = stem.slice(0, -1)
  return stem + ext
}

/** 单个文件在空间里的路径（不去重，给只看一个文件的地方用；列表用 listSpace） */
export function spacePathOf(row: Pick<FileRow, "kind" | "name" | "path">) {
  if (row.kind === "artifact") return row.path ?? spaceFileName(row.name)
  return `${spaceDirOf(row.kind)}/${spaceFileName(row.name)}`
}

/** 同名加 -2 -3（加在扩展名前面） */
export function withSuffix(path: string, k: number) {
  const slash = path.lastIndexOf("/")
  const base = path.slice(slash + 1)
  const ext = extname(base)
  const stem = base.slice(0, base.length - ext.length)
  return `${path.slice(0, slash + 1)}${stem}-${k}${ext}`
}

export type SpaceSource = "agent" | "attachment" | "download" | "screenshot" | "tool_output" | "sub"
export const SPACE_SOURCE_LABEL: Record<SpaceSource, string> = {
  agent: "agent 写的",
  attachment: "附件",
  download: "浏览器下载",
  screenshot: "截图",
  tool_output: "工具输出全文",
  sub: "子 agent",
}

export interface SpaceEntry {
  row: FileRow
  path: string
  scope: "task" | "session"
  source: SpaceSource
  /** agent 写的才能改（沙箱里可写、file.edit / file.delete 能用） */
  writable: boolean
}

const sourceOf = (kind: string): SpaceSource =>
  kind === "artifact" ? "agent" : kind === "download" || kind === "screenshot" || kind === "tool_output" ? kind : "attachment"

/**
 * 算出每个文件在空间里的路径（2.3），结果是确定的：先让这次运行 agent 写的、有路径的占住自己的路径，
 * 其余（附件、下载、截图、工具输出全文，以及加路径之前存的产物）按创建时间、id 的顺序放进固定目录，同名加 -2 -3。
 * 别的运行的产物（子 agent 拿到的父运行文件，docs/dev/sub-agents.md 5.3）是只读的附件：放 attachments/<原路径>，不占这次运行的路径
 */
export function assignSpacePaths(rows: FileRow[], sessionId: string): SpaceEntry[] {
  const sorted = [...rows].sort(
    (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )
  const taken = new Set<string>()
  const paths = new Map<string, string>()
  for (const row of sorted)
    if (row.kind === "artifact" && row.path && row.sessionId === sessionId) {
      taken.add(row.path)
      paths.set(row.id, row.path)
    }
  for (const row of sorted) {
    if (paths.has(row.id)) continue
    const wanted = row.kind === "artifact" && row.sessionId !== sessionId ? `attachments/${row.path ?? spaceFileName(row.name)}` : spacePathOf(row)
    let path = wanted
    for (let k = 2; taken.has(path); k++) path = withSuffix(wanted, k)
    taken.add(path)
    paths.set(row.id, path)
  }
  return sorted.map((row) => ({
    row,
    path: paths.get(row.id)!,
    scope: row.sessionId === sessionId ? "session" : "task",
    source: row.kind === "artifact" && row.sessionId !== sessionId ? "attachment" : sourceOf(row.kind),
    writable: row.kind === "artifact" && row.sessionId === sessionId,
  }))
}

/** 子 agent 的文件放在父运行空间的哪个目录下（docs/dev/sub-agents.md 5.3） */
export const subSpaceDir = (n: number) => `subs/${n}`

/**
 * 这个 session 空间里的全部文件：快照里的任务附件 + 只属于这次运行的文件；
 * 拆过子 agent 的父运行再加上每个子 agent 自己空间里的文件，放在只读的 subs/<n>/ 下，路径照它在子空间里的（docs/dev/sub-agents.md 5.3）
 */
export async function listSpace(
  db: DbLike,
  sessionId: string,
  snapshotAttachmentIds: string[]
): Promise<SpaceEntry[]> {
  const own = await listOwnSpace(db, sessionId, snapshotAttachmentIds)
  const children = await db
    .select({ id: t.sessions.id, n: sql<number | null>`(${t.sessions.snapshot}->'sub'->>'n')::int` })
    .from(t.sessions)
    .where(and(eq(t.sessions.parentSessionId, sessionId), eq(t.sessions.kind, "sub")))
  if (!children.length) return own
  const rows = await db
    .select()
    .from(t.files)
    .where(inArray(t.files.sessionId, children.map((child) => child.id)))
    .orderBy(asc(t.files.createdAt), asc(t.files.id))
  const subs: SpaceEntry[] = []
  for (const child of children) {
    if (!child.n) continue
    for (const entry of assignSpacePaths(
      rows.filter((row) => row.sessionId === child.id),
      child.id
    ))
      subs.push({ ...entry, path: `${subSpaceDir(child.n)}/${entry.path}`, scope: "session", source: "sub", writable: false })
  }
  return [...own, ...subs]
}

/** 只是这个 session 自己的空间（不含子 agent 的 subs/） */
async function listOwnSpace(
  db: DbLike,
  sessionId: string,
  snapshotAttachmentIds: string[]
): Promise<SpaceEntry[]> {
  const rows = await db
    .select()
    .from(t.files)
    .where(
      snapshotAttachmentIds.length
        ? or(
            eq(t.files.sessionId, sessionId),
            inArray(t.files.id, snapshotAttachmentIds)
          )
        : eq(t.files.sessionId, sessionId)
    )
    .orderBy(asc(t.files.createdAt), asc(t.files.id))
  return assignSpacePaths(rows, sessionId)
}

/** 这个 session 自己的文件一共多大（空间总量的上限按它算；任务附件不算） */
export async function spaceUsage(db: DbLike, sessionId: string): Promise<number> {
  const [row] = await db
    .select({ total: sql<string>`coalesce(sum(${t.files.size}), 0)` })
    .from(t.files)
    .where(eq(t.files.sessionId, sessionId))
  return Number(row?.total ?? 0)
}

async function artifactAt(db: DbLike, sessionId: string, path: string) {
  const [row] = await db
    .select()
    .from(t.files)
    .where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "artifact"), eq(t.files.path, path)))
  return row
}

const pgCode = (error: unknown) =>
  (error as { code?: string })?.code ?? (error as { cause?: { code?: string } })?.cause?.code

export interface WriteSpaceInput {
  sessionId: string
  /** 已经用 normalizeSpacePath 规范化过的路径 */
  path: string
  data: Buffer
  mime?: string
  /** 要写的是一个还没有路径的老产物（加路径之前存的，列表里按名字放）：覆盖它并补上路径 */
  legacyRow?: FileRow
}

/**
 * agent 写文件（2.2）：同一路径已经有了就覆盖（新 blob，更新那一行，id 不变，旧 blob 改完再删），没有就新建。
 * 返回那一行和是不是新建的
 */
export async function writeSpaceFile(
  db: DbLike,
  input: WriteSpaceInput
): Promise<{ row: FileRow; created: boolean }> {
  const name = safeFileName(input.path.slice(input.path.lastIndexOf("/") + 1))
  const mime = input.mime ?? mimeFromName(name)
  const sha256 = sha256Hex(input.data)
  for (let attempt = 0; ; attempt++) {
    const existing = (await artifactAt(db, input.sessionId, input.path)) ?? input.legacyRow
    if (!existing) {
      try {
        const row = await saveFile(db, { data: input.data, name, mime, kind: "artifact", sessionId: input.sessionId, path: input.path })
        return { row, created: true }
      } catch (error) {
        // 同一路径刚被别的调用建了（并发）：再来一次，走覆盖
        if (pgCode(error) === "23505" && attempt === 0) continue
        throw error
      }
    }
    const storagePath = newStoragePath(existing.id, true)
    await fileStorage().put(storagePath, input.data)
    let updated: FileRow | undefined
    try {
      ;[updated] = await db
        .update(t.files)
        .set({ storagePath, size: input.data.length, sha256, mime, name, path: input.path, updatedAt: new Date() })
        .where(eq(t.files.id, existing.id))
        .returning()
    } catch (error) {
      await fileStorage().remove(storagePath).catch(() => {})
      throw error
    }
    if (!updated) {
      // 那一行刚被删了：再来一次，走新建
      await fileStorage().remove(storagePath).catch(() => {})
      if (attempt === 0) {
        input = { ...input, legacyRow: undefined }
        continue
      }
      throw new Error(`写 ${input.path} 时文件刚被删了，请重试`)
    }
    await fileStorage().remove(existing.storagePath).catch(() => {})
    return { row: updated, created: false }
  }
}

/** 这次运行记下的网页请求文件（network/requests.jsonl，docs/dev/solidify.md 19.3）；还没有返回 undefined */
export async function networkLogRow(db: DbLike, sessionId: string, name: string): Promise<FileRow | undefined> {
  const [row] = await db
    .select()
    .from(t.files)
    .where(and(eq(t.files.sessionId, sessionId), eq(t.files.kind, "network"), eq(t.files.name, name)))
    .orderBy(asc(t.files.createdAt))
    .limit(1)
  return row
}

/**
 * 写记下的网页请求：整份覆盖（新 blob、同一行 files，旧 blob 改完再删，同 writeSpaceFile 的覆盖写法），没有就新建。
 * 记的过程中会写很多次（每次浏览器工具调用结束、网关关闭时）
 */
export async function writeNetworkLog(db: DbLike, sessionId: string, name: string, data: Buffer): Promise<FileRow> {
  const existing = await networkLogRow(db, sessionId, name)
  if (!existing) return saveFile(db, { data, name, kind: "network", sessionId })
  const storagePath = newStoragePath(existing.id, true)
  await fileStorage().put(storagePath, data)
  let updated: FileRow | undefined
  try {
    ;[updated] = await db
      .update(t.files)
      .set({ storagePath, size: data.length, sha256: sha256Hex(data), updatedAt: new Date() })
      .where(eq(t.files.id, existing.id))
      .returning()
  } catch (error) {
    await fileStorage().remove(storagePath).catch(() => {})
    throw error
  }
  if (!updated) {
    // 那一行刚被删了（运行被删）：不再写
    await fileStorage().remove(storagePath).catch(() => {})
    return existing
  }
  await fileStorage().remove(existing.storagePath).catch(() => {})
  return updated
}

/** 删 agent 写的文件：先删行再删内容。被别处（图库、比物）引用着的删不了，抛 SpacePathError */
export async function deleteSpaceFile(db: DbLike, row: FileRow) {
  try {
    await db.delete(t.files).where(eq(t.files.id, row.id))
  } catch (error) {
    if (pgCode(error) === "23503")
      throw new SpacePathError(`${row.path ?? row.name} 被别的记录（例如图库、比物）用着，删不了`)
    throw error
  }
  await fileStorage().remove(row.storagePath).catch(() => {})
}

export async function listTaskAttachments(
  db: DbLike,
  taskId: string
): Promise<FileRow[]> {
  return db
    .select()
    .from(t.files)
    .where(
      and(
        eq(t.files.taskId, taskId),
        isNull(t.files.sessionId),
        eq(t.files.kind, "attachment")
      )
    )
    .orderBy(asc(t.files.createdAt))
}

export { toSessionFile }
