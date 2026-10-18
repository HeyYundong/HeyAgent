// 文件的 HTTP 接口（要求登录）：
// - POST /api/files：上传（multipart，字段名 file），有大小上限；传上来先是「未使用」，立即运行或加到任务附件时再关联；
// - GET /api/files/:id：下载。图片直接显示，其他一律作为附件下载（不在控制台的域名下渲染 HTML）。
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
} from "./service.js"

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

  app.get("/api/files/:id", async (c) => {
    const user = await userOf(c.req.raw.headers)
    if (!user) return c.json({ error: "请先登录" }, 401)
    const row = await getFileRow(deps.db, c.req.param("id"))
    // 要导入的 zip 里可能有明文密钥：只有主管能下（走 /api/imports/:id/file）
    if (!row || (row.kind === "import" && user.role !== "admin")) return c.json({ error: "找不到文件" }, 404)
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
