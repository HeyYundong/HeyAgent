// 文件的读写：上传、agent 产出、太长的工具输出全文、附件。
// 归属：task_id 有值且 session_id 为空 = 任务附件（跨运行一直有效）；session_id 有值 = 只属于那次运行。
import { randomBytes } from "node:crypto"
import { extname } from "node:path"

import { and, asc, eq, inArray, isNull, or } from "drizzle-orm"
import type { SessionFile } from "@heyagent/shared"

import * as t from "../db/schema.js"
import type { DbLike } from "../engine/records.js"
import { runtime } from "../engine/runtime.js"
import { LocalDiskStorage, sha256Hex, type FileStorage } from "./storage.js"

/** gallery / gallery_thumb：图库的原图和缩略图（归 gallery_images 管，删图时一起删） */
export type FileKind =
  "upload" | "attachment" | "artifact" | "tool_output" | "screenshot" | "gallery" | "gallery_thumb"
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
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
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
}

export async function saveFile(
  db: DbLike,
  input: SaveFileInput
): Promise<FileRow> {
  const id = newFileId()
  const name = safeFileName(input.name)
  const now = new Date()
  const storagePath = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, "0")}/${id}`
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

const toSessionFile = (
  row: FileRow,
  scope: "task" | "session"
): SessionFile => ({
  id: row.id,
  name: row.name,
  mime: row.mime,
  size: row.size,
  kind: ([
    "attachment",
    "artifact",
    "tool_output",
    "screenshot",
    "upload",
  ].includes(row.kind)
    ? row.kind
    : "attachment") as SessionFile["kind"],
  scope,
  createdAt: row.createdAt.toISOString(),
  url: fileUrl(row.id),
})

/** session 的附件和产物：快照里的任务附件 + 只属于这次运行的文件 */
export async function listSessionFiles(
  db: DbLike,
  sessionId: string,
  snapshotAttachmentIds: string[]
): Promise<SessionFile[]> {
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
  return rows.map((row) =>
    toSessionFile(row, row.sessionId === sessionId ? "session" : "task")
  )
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
