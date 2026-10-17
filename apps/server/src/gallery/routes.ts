// 图库的 HTTP 接口（字段说明见 docs/dev/api.md 第 12 节）。鉴权二选一：Authorization: Bearer <API 密钥>（外部系统），或者登录的 cookie（控制台页面）。
// 带了 Bearer 就只认密钥，不对就 401，不会退回去认 cookie。
//   POST   /api/gallery/images          传图：multipart（image 文件 + text JSON 字符串 + tags JSON 数组字符串）或 JSON { image, text, tags }
//   POST   /api/gallery/search          检索：JSON，或 multipart（image 文件 + 其余字段，tags / anyTags / text / where 是 JSON 字符串）
//   POST   /api/gallery/compare         比对：JSON { a, b, threshold }，或 multipart（a、b 两个文件 + threshold）
//   GET    /api/gallery/images          按上传时间倒序列出（?limit=&cursor=）
//   GET    /api/gallery/images/:id      看一张
//   PATCH  /api/gallery/images/:id      改文本、标签：JSON { text, tags, addTags, removeTags }
//   DELETE /api/gallery/images/:id      删
//   GET    /api/gallery/images/:id/file 原图；/thumb 缩略图
//   GET    /api/gallery/tags            常用标签和图数
//   GET    /api/gallery/stats           总数、当前 embedding 模型、还没算向量的张数
//   POST   /api/gallery/mcp             MCP（Streamable HTTP），见 mcp.ts
import {
  galleryCompareSchema,
  gallerySearchSchema,
  galleryTagsSchema,
  galleryTextSchema,
  galleryUpdateSchema,
  galleryUploadSchema,
  type GalleryVia,
} from "@heyagent/shared"
import type { Context, Hono } from "hono"
import { bodyLimit } from "hono/body-limit"
import { z } from "zod"

import type { Auth } from "../auth.js"
import { verifyApiKey } from "../data/config/api-keys.js"
import type { Db } from "../db/client.js"
import { runtime } from "../engine/runtime.js"
import { GalleryError } from "./errors.js"
import type { LoadedImage } from "./images.js"
import { handleGalleryMcp } from "./mcp.js"
import {
  compareImages,
  deleteImage,
  galleryStats,
  galleryTags,
  getImage,
  imageFile,
  resolveSide,
  resolveUpload,
  searchImages,
  updateImage,
  uploadImage,
  type CompareSide,
  type GalleryActor,
} from "./service.js"

interface Deps {
  db: Db
  auth: Auth
}

/** 认人：Bearer 密钥优先，没带才看 cookie。认不出返回 undefined；密钥不对时 reason 说清楚 */
async function authenticate(deps: Deps, req: Request, via: GalleryVia): Promise<GalleryActor | { reason: string }> {
  const bearer = req.headers.get("authorization")?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim()
  if (bearer) {
    const key = await verifyApiKey(deps.db, bearer)
    if (!key) return { reason: "API 密钥不对，或者已经删了（在「设置」→「API 密钥」里看）" }
    return { user: key.user, via, apiKeyId: key.apiKeyId }
  }
  const session = await deps.auth.api.getSession({ headers: req.headers })
  if (!session?.user) return { reason: "请先登录，或者在 Authorization: Bearer 里带上 API 密钥" }
  return { user: { id: session.user.id, isAdmin: session.user.role === "admin" }, via: "web" }
}

/** 返回给外部的图片地址要完整（经过反向代理时看 X-Forwarded-*） */
export function publicBaseUrl(req: Request) {
  const url = new URL(req.url)
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() || url.protocol.replace(/:$/, "")
  const host = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim() || req.headers.get("host") || url.host
  return `${proto}://${host}`
}

/** zod 的错误变成一句话：「tags.0：标签不能是空的」 */
function zodMessage(error: z.ZodError) {
  return error.issues
    .slice(0, 3)
    .map((issue) => (issue.path.length ? `${issue.path.join(".")}：${issue.message}` : issue.message))
    .join("；")
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value)
  if (!result.success) throw new GalleryError("bad_request", zodMessage(result.error))
  return result.data
}

/** multipart 里的 JSON 字段（text 要是对象、tags 要是数组）：先按 JSON 解析，再交给 schema 校验 */
function jsonField(form: FormData, name: string): unknown {
  const value = form.get(name)
  if (value === null || value === "") return undefined
  if (typeof value !== "string") throw new GalleryError("bad_request", `${name} 要是 JSON 字符串，不是文件`)
  try {
    return JSON.parse(value) as unknown
  } catch {
    throw new GalleryError("bad_request", `${name} 不是合法的 JSON：${value.slice(0, 60)}`)
  }
}

function textField(form: FormData, name: string) {
  const value = form.get(name)
  return typeof value === "string" && value !== "" ? value : undefined
}

function numberField(form: FormData, name: string) {
  const value = textField(form, name)
  if (value === undefined) return undefined
  const number = Number(value)
  if (!Number.isFinite(number)) throw new GalleryError("bad_request", `${name} 要是数字`)
  return number
}

async function fileField(form: FormData, ...names: string[]): Promise<LoadedImage | undefined> {
  for (const name of names) {
    const value = form.get(name)
    if (value instanceof File) return { data: Buffer.from(await value.arrayBuffer()), name: value.name || "image" }
  }
  return undefined
}

const isMultipart = (c: Context) => (c.req.header("content-type") ?? "").toLowerCase().startsWith("multipart/form-data")

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json()
  } catch {
    throw new GalleryError("bad_request", "内容要是 JSON（Content-Type: application/json），或者用 multipart/form-data 传文件")
  }
}

async function readForm(c: Context) {
  try {
    return await c.req.formData()
  } catch {
    throw new GalleryError("bad_request", "multipart/form-data 解析失败")
  }
}

function fail(c: Context, error: unknown) {
  if (error instanceof GalleryError) return c.json({ error: error.message }, error.status)
  console.error("[gallery]", error)
  return c.json({ error: "服务器出错了，请稍后再试" }, 500)
}

/** 两张图 + base64 的 JSON 也放得下 */
const bigBody = () =>
  bodyLimit({
    maxSize: runtime.uploadMaxBytes * 3 + 1024 * 1024,
    onError: (c) => c.json({ error: `内容太大，图片最多 ${Math.round(runtime.uploadMaxBytes / 1024 / 1024)} MB` }, 413),
  })

export function registerGalleryRoutes(app: Hono, deps: Deps) {
  const { db } = deps

  /** 包一层：认人 → 执行 → 统一处理错误 */
  const handle =
    (via: GalleryVia, action: (c: Context, actor: GalleryActor) => Promise<Response>) =>
    async (c: Context) => {
      try {
        const actor = await authenticate(deps, c.req.raw, via)
        if ("reason" in actor) return c.json({ error: actor.reason }, 401)
        return await action(c, actor)
      } catch (error) {
        return fail(c, error)
      }
    }

  const view = (c: Context) => ({ baseUrl: publicBaseUrl(c.req.raw) })

  app.post(
    "/api/gallery/images",
    bigBody(),
    handle("api", async (c, actor) => {
      let result
      if (isMultipart(c)) {
        const form = await readForm(c)
        const image = await fileField(form, "image", "file")
        if (!image) throw new GalleryError("bad_request", "没有收到图片：multipart 里的文件字段叫 image")
        const text = parse(galleryTextSchema.optional(), jsonField(form, "text"))
        const tags = parse(galleryTagsSchema.optional(), jsonField(form, "tags"))
        result = await uploadImage(db, actor, { image, text, tags }, view(c))
      } else {
        const input = parse(galleryUploadSchema, await readJson(c))
        const image = await resolveUpload(db, input.image, actor)
        result = await uploadImage(db, actor, { image, text: input.text, tags: input.tags }, view(c))
      }
      return c.json(result, result.duplicate ? 200 : 201)
    })
  )

  app.post(
    "/api/gallery/search",
    bigBody(),
    handle("api", async (c, actor) => {
      if (isMultipart(c)) {
        const form = await readForm(c)
        const input = parse(gallerySearchSchema.omit({ image: true }), {
          query: textField(form, "query"),
          tags: jsonField(form, "tags"),
          anyTags: jsonField(form, "anyTags"),
          text: jsonField(form, "text"),
          where: jsonField(form, "where"),
          keyword: textField(form, "keyword"),
          minScore: numberField(form, "minScore"),
          limit: numberField(form, "limit"),
          cursor: textField(form, "cursor"),
        })
        return c.json(await searchImages(db, { ...input, image: await fileField(form, "image", "file") }, view(c)))
      }
      const { image, ...input } = parse(gallerySearchSchema, await readJson(c))
      return c.json(await searchImages(db, { ...input, image: image ? await resolveSide(db, image, actor) : undefined }, view(c)))
    })
  )

  app.post(
    "/api/gallery/compare",
    bigBody(),
    handle("api", async (c, actor) => {
      let a: CompareSide | undefined
      let b: CompareSide | undefined
      let threshold: number | undefined
      if (isMultipart(c)) {
        const form = await readForm(c)
        a = await fileField(form, "a")
        b = await fileField(form, "b")
        if (!a || !b) throw new GalleryError("bad_request", "multipart 里要有 a、b 两个图片文件")
        threshold = parse(galleryCompareSchema.shape.threshold, numberField(form, "threshold"))
      } else {
        const input = parse(galleryCompareSchema, await readJson(c))
        ;[a, b] = await Promise.all([resolveSide(db, input.a, actor), resolveSide(db, input.b, actor)])
        threshold = input.threshold
      }
      return c.json(await compareImages(db, a, b, threshold))
    })
  )

  app.get(
    "/api/gallery/images",
    handle("api", async (c) => {
      const limit = c.req.query("limit")
      const input = parse(gallerySearchSchema.pick({ limit: true, cursor: true }), { limit: limit ? Number(limit) : undefined, cursor: c.req.query("cursor") || undefined })
      return c.json(await searchImages(db, input, view(c)))
    })
  )

  app.get(
    "/api/gallery/images/:id",
    handle("api", async (c) => c.json(await getImage(db, c.req.param("id")!, view(c))))
  )

  app.patch(
    "/api/gallery/images/:id",
    bodyLimit({ maxSize: 256 * 1024, onError: (c) => c.json({ error: "内容太大" }, 413) }),
    handle("api", async (c, actor) => {
      const body = await readJson(c)
      const input = parse(galleryUpdateSchema, { ...(typeof body === "object" && body ? body : {}), id: c.req.param("id") })
      return c.json(await updateImage(db, actor, input, view(c)))
    })
  )

  app.delete(
    "/api/gallery/images/:id",
    handle("api", async (c, actor) => c.json(await deleteImage(db, actor, c.req.param("id")!)))
  )

  for (const which of ["file", "thumb"] as const) {
    app.get(
      `/api/gallery/images/:id/${which}`,
      handle("api", async (c) => {
        const file = await imageFile(db, c.req.param("id")!, which)
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
  }

  app.get(
    "/api/gallery/tags",
    handle("api", async (c) => c.json({ tags: await galleryTags(db) }))
  )

  app.get(
    "/api/gallery/stats",
    handle("api", async (c) => c.json(await galleryStats(db)))
  )

  app.all(
    "/api/gallery/mcp",
    bigBody(),
    handle("mcp", async (c, actor) => handleGalleryMcp(db, actor, publicBaseUrl(c.req.raw), c.req.raw))
  )
}
