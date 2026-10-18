// 导入的 HTTP 接口（只有主管）：
// - POST /api/imports：上传 zip（multipart：file 必填，note、modelId 可选），建导入记录（读包中）并在同一个事务里发 import.read；
// - GET /api/imports/:id/file：下载原包。
// 上传的 zip 存成 files 的一行（kind = import）；包里可能有明文密钥，所以 /api/files/:id 不给员工下载这类文件。
import { can, importId, type Actor, type ImportRecord } from "@heyagent/shared"
import { eq } from "drizzle-orm"
import type { Hono } from "hono"
import { bodyLimit } from "hono/body-limit"

import type { Auth } from "../auth.js"
import { audit, nextNo } from "../data/config/common.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { importReadJobOptions, QUEUES, sendInTx } from "../engine/queue.js"
import { fileStorage, getFileRow, readFileData, saveFile } from "../files/service.js"
import { importLimits, sizeText } from "./limits.js"
import { pickReadModel, toImportRecord } from "./service.js"
import { looksLikeZip } from "./zip.js"

export function registerImportRoutes(app: Hono, deps: { db: Db; auth: Auth }) {
  const adminOf = async (headers: Headers): Promise<{ actor?: Actor; status?: 401 | 403 }> => {
    const user = (await deps.auth.api.getSession({ headers }))?.user
    if (!user) return { status: 401 }
    const actor: Actor = { id: user.id, isAdmin: user.role === "admin" }
    if (!can(actor, "config.manage", {})) return { status: 403 }
    return { actor }
  }
  const denied = (status: 401 | 403) => ({ error: status === 401 ? "请先登录" : "只有主管能导入" })

  app.post(
    "/api/imports",
    // 限制按当时的上限算（测试会调小）
    (c, next) =>
      bodyLimit({
        maxSize: importLimits.maxBytes + 64 * 1024,
        onError: (ctx) => ctx.json({ error: `包太大了，最多 ${sizeText(importLimits.maxBytes)}` }, 413),
      })(c, next),
    async (c) => {
      const who = await adminOf(c.req.raw.headers)
      if (!who.actor) return c.json(denied(who.status!), who.status!)
      const actor = who.actor
      let form: FormData
      try {
        form = await c.req.formData()
      } catch {
        return c.json({ error: "要用 multipart/form-data 上传，字段名 file" }, 400)
      }
      const file = form.get("file")
      if (!(file instanceof File)) return c.json({ error: "没有收到文件（字段名 file）" }, 400)
      if (file.size > importLimits.maxBytes) return c.json({ error: `包太大了，最多 ${sizeText(importLimits.maxBytes)}` }, 413)
      const note = String(form.get("note") ?? "").trim()
      if (note.length > 2000) return c.json({ error: "补充说明太长了，最多 2000 个字" }, 400)
      const model = await pickReadModel(deps.db, String(form.get("modelId") ?? ""))
      if ("error" in model) return c.json({ error: model.error }, 400)
      const data = Buffer.from(await file.arrayBuffer())
      // 只认 zip 的文件头，不看扩展名
      if (!looksLikeZip(data)) return c.json({ error: "这不是 zip 包（开头不是 PK）。请把要导入的内容打包成 .zip 再上传" }, 400)
      const name = (file.name || "import.zip").slice(0, 200)
      let storagePath: string | undefined
      try {
        const row = await deps.db.transaction(async (tx) => {
          const saved = await saveFile(tx, { data, name, mime: "application/zip", kind: "import", createdById: actor.id })
          storagePath = saved.storagePath
          const id = importId(await nextNo(tx, "import_no_seq"))
          const [created] = await tx
            .insert(t.imports)
            .values({ id, fileId: saved.id, fileName: saved.name, size: data.length, note, modelId: model.modelId, status: "reading", createdById: actor.id })
            .returning()
          // 和记录一起提交：记录建好了就一定有人去读
          await sendInTx(deps.db, tx, QUEUES.importRead, { importId: id }, importReadJobOptions(id))
          await audit(tx, actor.id, "import.upload", "imports", id, { fileName: saved.name, size: data.length, modelId: model.modelId })
          return created!
        })
        return c.json(toImportRecord(row) satisfies ImportRecord)
      } catch (error) {
        // 事务回滚了：已经写到磁盘的包删掉
        if (storagePath) await fileStorage().remove(storagePath).catch(() => {})
        throw error
      }
    }
  )

  app.get("/api/imports/:id/file", async (c) => {
    const who = await adminOf(c.req.raw.headers)
    if (!who.actor) return c.json(denied(who.status!), who.status!)
    const [row] = await deps.db.select({ fileId: t.imports.fileId, fileName: t.imports.fileName }).from(t.imports).where(eq(t.imports.id, c.req.param("id")))
    if (!row) return c.json({ error: "找不到这次导入" }, 404)
    const file = row.fileId ? await getFileRow(deps.db, row.fileId) : undefined
    const data = file ? await readFileData(file).catch(() => null) : null
    if (!data) return c.json({ error: "上传的包不见了" }, 410)
    const ascii = row.fileName.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_")
    return c.body(new Uint8Array(data), 200, {
      "content-type": "application/zip",
      "content-length": String(data.length),
      "content-disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(row.fileName)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "private, no-store",
    })
  })
}
