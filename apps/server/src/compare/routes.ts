// 比物的 HTTP 接口（字段说明见 docs/dev/api.md 第 15 节）。鉴权和图库一样（lib/api-auth.ts）：Bearer API 密钥优先，没带看 cookie。
//   POST   /api/compare                新比对：JSON（CompareCreateInput + idempotencyKey），或 multipart（image_a、image_b 两个文件 + 其余字段）。
//                                      默认等比完再返回（最多约 90 秒，还没比完返回 running 的记录）；?wait=false 立即返回
//   GET    /api/compare?query=&status=&sessionId=&limit=&cursor=   比对记录，新的在前
//   GET    /api/compare/:id            一条比对
//   POST   /api/compare/:id/again      同样的两张图和要求再比一次（不复用），?wait=false 立即返回
//   DELETE /api/compare/:id            删除（发起的人和主管）
//   GET    /api/compare/standards      比对标准（默认的排第一）
//   GET    /api/compare/models         能比物的视觉模型（便宜的在前）
//   GET    /api/compare/files/:fileId  比对里的一张图（API 密钥也能下）
//   POST   /api/compare/mcp            MCP（Streamable HTTP），见 mcp.ts
import { compareCreateSchema, compareListInputSchema, compareStatusSchema, type CompareVia } from "@heyagent/shared"
import type { Context, Hono } from "hono"
import { z } from "zod"

import type { Auth } from "../auth.js"
import type { Db } from "../db/client.js"
import { bigBody, fail, fileField, isMultipart, numberField, parse, readForm, readJson, textField } from "../gallery/routes.js"
import { authenticateRequest, publicBaseUrl } from "../lib/api-auth.js"
import { CompareError } from "./errors.js"
import { handleCompareMcp } from "./mcp.js"
import {
  compareAgain,
  comparisonFile,
  createComparison,
  deleteComparison,
  getComparison,
  listComparisons,
  listStandards,
  listVisionModels,
  waitForComparison,
  type CompareActor,
  type CompareCreateRequest,
} from "./service.js"

interface Deps {
  db: Db
  auth: Auth
}

/** multipart 里除了两个文件以外的字段（带 refine 的 schema 不能 omit，从 shape 重建；标准和要求二选一由 service 检查） */
const multipartFields = z.object(compareCreateSchema.shape).omit({ imageA: true, imageB: true })

const idempotencySchema = z.string().trim().min(1).max(200).optional()

/** ?wait=false / 0 / no 立即返回，其余等结果 */
const wantsWait = (c: Context) => !/^(false|0|no)$/i.test(c.req.query("wait") ?? "")

export function registerCompareRoutes(app: Hono, deps: Deps) {
  const { db } = deps

  /** 包一层：认人 → 执行 → 统一处理错误。密钥调用 via = api / mcp，cookie 是 web */
  const handle =
    (via: Exclude<CompareVia, "web" | "agent">, action: (c: Context, actor: CompareActor) => Promise<Response>) =>
    async (c: Context) => {
      try {
        const caller = await authenticateRequest(deps, c.req.raw)
        if ("reason" in caller) return c.json({ error: caller.reason }, 401)
        const actor: CompareActor = caller.apiKeyId ? { user: caller.user, via, apiKeyId: caller.apiKeyId } : { user: caller.user, via: "web" }
        return await action(c, actor)
      } catch (error) {
        return fail(c, error)
      }
    }

  const view = (c: Context) => ({ baseUrl: publicBaseUrl(c.req.raw) })

  // MCP、静态的几条放在 /:id 前面
  app.all(
    "/api/compare/mcp",
    bigBody(),
    handle("mcp", async (c, actor) => handleCompareMcp(db, actor, publicBaseUrl(c.req.raw), c.req.raw))
  )

  app.get(
    "/api/compare/standards",
    handle("api", async (c) => c.json({ standards: await listStandards(db) }))
  )

  app.get(
    "/api/compare/models",
    handle("api", async (c) => c.json({ models: await listVisionModels(db) }))
  )

  app.get(
    "/api/compare/files/:fileId",
    handle("api", async (c) => {
      const file = await comparisonFile(db, c.req.param("fileId")!)
      const ascii = file.name.replace(/[^\x20-\x7e]/g, "_").replace(/"/g, "_")
      return c.body(new Uint8Array(file.data), 200, {
        "content-type": file.mime,
        "content-length": String(file.data.length),
        "content-disposition": `inline; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
        "x-content-type-options": "nosniff",
        // id 不会重复用，文件内容不会变
        "cache-control": "private, max-age=86400, immutable",
      })
    })
  )

  app.post(
    "/api/compare",
    bigBody(),
    handle("api", async (c, actor) => {
      let input: CompareCreateRequest
      let idempotencyKey: string | undefined
      if (isMultipart(c)) {
        const form = await readForm(c)
        const imageA = await fileField(form, "image_a", "imageA", "a")
        const imageB = await fileField(form, "image_b", "imageB", "b")
        if (!imageA || !imageB) throw new CompareError("bad_request", "multipart 里要有 image_a、image_b 两个图片文件")
        const fields = parse(multipartFields, {
          labelA: textField(form, "labelA") ?? textField(form, "label_a"),
          labelB: textField(form, "labelB") ?? textField(form, "label_b"),
          standard: textField(form, "standard"),
          prompt: textField(form, "prompt"),
          passScore: numberField(form, "passScore") ?? numberField(form, "pass_score"),
          modelId: textField(form, "modelId") ?? textField(form, "model"),
          title: textField(form, "title"),
        })
        input = { ...fields, imageA: { upload: imageA }, imageB: { upload: imageB } }
        idempotencyKey = parse(idempotencySchema, textField(form, "idempotencyKey") ?? textField(form, "idempotency_key"))
      } else {
        const body = await readJson(c)
        input = parse(compareCreateSchema, body)
        const raw = typeof body === "object" && body ? (body as Record<string, unknown>) : {}
        idempotencyKey = parse(idempotencySchema, raw.idempotencyKey ?? raw.idempotency_key)
      }
      const created = await createComparison(db, actor, input, { ...view(c), idempotencyKey })
      const result = wantsWait(c) && created.status === "running" ? { ...(await waitForComparison(db, created.id, view(c))), reused: created.reused } : created
      return c.json(result, created.reused ? 200 : 201)
    })
  )

  app.get(
    "/api/compare",
    handle("api", async (c) => {
      const limit = c.req.query("limit")
      const input = parse(compareListInputSchema, {
        query: c.req.query("query") || undefined,
        status: c.req.query("status") ? parse(compareStatusSchema, c.req.query("status")) : undefined,
        sessionId: c.req.query("sessionId") || undefined,
        limit: limit ? Number(limit) : undefined,
        cursor: c.req.query("cursor") || undefined,
      })
      return c.json(await listComparisons(db, input, view(c)))
    })
  )

  app.get(
    "/api/compare/:id",
    handle("api", async (c) => c.json(await getComparison(db, c.req.param("id")!, view(c))))
  )

  app.post(
    "/api/compare/:id/again",
    handle("api", async (c, actor) => {
      const created = await compareAgain(db, actor, c.req.param("id")!, view(c))
      return c.json(wantsWait(c) ? await waitForComparison(db, created.id, view(c)) : created, 201)
    })
  )

  app.delete(
    "/api/compare/:id",
    handle("api", async (c, actor) => c.json(await deleteComparison(db, actor, c.req.param("id")!)))
  )
}
