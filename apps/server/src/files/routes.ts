// 文件的 HTTP 接口（要求登录）：
// - POST /api/files：上传（multipart，字段名 file），有大小上限；传上来先是「未使用」，立即运行或加到任务附件时再关联；
// - GET /api/files/:id：下载。图片直接显示，其他一律作为附件下载（不在控制台的域名下渲染 HTML）；
// - GET /api/files/:id/sheet?rows=200：表格文件（xlsx、xls、csv 等）的预览，每个工作表前 rows 行（JSON，格子都是文字）。
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"

import type { Auth } from "../auth.js"
import type { Db } from "../db/client.js"
import { runtime } from "../engine/runtime.js"
import {
  fileUrl,
  getFileRow,
  isImageMime,
  mimeFromName,
  readFileData,
  saveFile,
  type FileRow,
} from "./service.js"
import { isSheetFile, loadBook, previewOf, SheetError } from "./sheets.js"

export function registerFileRoutes(app: Hono, deps: { db: Db; auth: Auth }) {
  const userOf = async (headers: Headers) =>
    (await deps.auth.api.getSession({ headers }))?.user

  app.post(
    "/api/files",
    bodyLimit({
      maxSize: runtime.uploadMaxBytes + 64 * 1024,
      onError: (c) =>
        c.json(
          {
            error: `文件太大，最多 ${Math.round(runtime.uploadMaxBytes / 1024 / 1024)} MB`,
          },
          413
        ),
    }),
    async (c) => {
      const user = await userOf(c.req.raw.headers)
      if (!user) return c.json({ error: "请先登录" }, 401)
      let form: FormData
      try {
        form = await c.req.formData()
      } catch {
        return c.json(
          { error: "要用 multipart/form-data 上传，字段名 file" },
          400
        )
      }
      const file = form.get("file")
      if (!(file instanceof File))
        return c.json({ error: "没有收到文件（字段名 file）" }, 400)
      if (file.size > runtime.uploadMaxBytes)
        return c.json(
          {
            error: `文件太大，最多 ${Math.round(runtime.uploadMaxBytes / 1024 / 1024)} MB`,
          },
          413
        )
      const data = Buffer.from(await file.arrayBuffer())
      const name = file.name || "file"
      const mime =
        file.type && file.type !== "application/octet-stream"
          ? file.type.split(";")[0]!.trim()
          : mimeFromName(name)
      const row = await saveFile(deps.db, {
        data,
        name,
        mime,
        kind: "upload",
        createdById: user.id,
      })
      return c.json({
        id: row.id,
        name: row.name,
        mime: row.mime,
        size: row.size,
        url: fileUrl(row.id),
      })
    }
  )

  /** 和下载一样的权限：登录就能看；要导入的 zip 只有主管能下 */
  const visibleRow = async (headers: Headers, id: string): Promise<{ row: FileRow } | { status: 401 | 404; error: string }> => {
    const user = await userOf(headers)
    if (!user) return { status: 401, error: "请先登录" }
    const row = await getFileRow(deps.db, id)
    // 要导入的 zip 里可能有明文密钥：只有主管能下（走 /api/imports/:id/file）
    if (!row || (row.kind === "import" && user.role !== "admin")) return { status: 404, error: "找不到文件" }
    return { row }
  }

  app.get("/api/files/:id/sheet", async (c) => {
    const found = await visibleRow(c.req.raw.headers, c.req.param("id"))
    if (!("row" in found)) return c.json({ error: found.error }, found.status)
    const { row } = found
    if (!isSheetFile(row.name, row.mime)) return c.json({ error: `${row.name} 不是表格文件` }, 415)
    const asked = Number(c.req.query("rows") ?? 200)
    const rows = Number.isInteger(asked) && asked > 0 ? Math.min(asked, 1000) : 200
    try {
      return c.json(previewOf(await loadBook(row), rows), 200, { "cache-control": "private, max-age=300" })
    } catch (error) {
      if (error instanceof SheetError) return c.json({ error: error.message }, 422)
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT"
      return c.json({ error: missing ? "文件内容不见了" : `读不了：${(error as Error).message}` }, missing ? 410 : 500)
    }
  })

  app.get("/api/files/:id", async (c) => {
    const found = await visibleRow(c.req.raw.headers, c.req.param("id"))
    if (!("row" in found)) return c.json({ error: found.error }, found.status)
    const { row } = found
    const data = await readFileData(row).catch(() => null)
    if (!data) return c.json({ error: "文件内容不见了" }, 410)
    const inline = isImageMime(row.mime)
    const ascii = row.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_")
    return c.body(new Uint8Array(data), 200, {
      "content-type": row.mime.startsWith("text/")
        ? `${row.mime}; charset=utf-8`
        : row.mime,
      "content-length": String(data.length),
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, max-age=300",
    })
  })
}
