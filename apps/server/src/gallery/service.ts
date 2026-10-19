// 图库的业务逻辑：传图、检索、比对、看、改、删、统计。页面（tRPC）、HTTP 接口、MCP、agent 工具都只调这里。
// 检索 = 标签 / JSON 条件先筛（gallery_images 上的 GIN 索引），再按向量相似度排（gallery_embeddings 上的 HNSW 索引，带过滤时用迭代扫描）；
// 没给图或描述时按上传时间倒序翻页。
import {
  can,
  conditionPath,
  galleryImageId,
  gallerySameThreshold,
  normalizeTags,
  type Actor,
  type GalleryCompareResult,
  type GalleryCondition,
  type GalleryEmbedding,
  type GalleryFilter,
  type GalleryImage,
  type GalleryImageRef,
  type GalleryPage,
  type GalleryStats,
  type GalleryTagCount,
  type GalleryUpdateInput,
  type GalleryUploadResult,
  type GalleryVia,
} from "@heyagent/shared"
import { and, arrayContains, arrayOverlaps, count, desc, eq, inArray, isNull, lt, ne, notExists, or, sql, type SQL } from "drizzle-orm"

import { audit, nextNo } from "../data/config/common.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { fileStorage, getFileRow, readFileData, saveFile } from "../files/service.js"
import { sha256Hex } from "../files/storage.js"
import { cosine, currentEmbedModel, embed, requireEmbedModel, vectorLiteral, type EmbedModel } from "./embed.js"
import { GalleryError } from "./errors.js"
import { decodeImage, loadImageRef, makeThumbnail, modelInputImage, type LoadedImage, type RefOptions } from "./images.js"

type ImageRow = typeof t.galleryImages.$inferSelect

/** 谁在用图库：登录的人 / API 密钥（算密钥的创建人）/ agent（user 为空） */
export interface GalleryActor extends RefOptions {
  user: Actor | null
  via: GalleryVia
  apiKeyId?: string
  sessionId?: string
}

export interface ViewOptions {
  /** 返回的图片地址前面加上这个（HTTP 接口、MCP 给外部用，要完整地址）；页面用相对地址 */
  baseUrl?: string
}

export function toGalleryImage(row: ImageRow, embedded: boolean, options: ViewOptions & { score?: number } = {}): GalleryImage {
  const base = `${options.baseUrl ?? ""}/api/gallery/images/${row.id}`
  return {
    id: row.id,
    url: `${base}/file`,
    thumbUrl: `${base}/thumb`,
    text: row.text,
    tags: row.tags,
    name: row.name,
    mime: row.mime,
    size: row.size,
    width: row.width,
    height: row.height,
    sha256: row.sha256,
    via: row.via,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    ...(row.createdById ? { createdById: row.createdById } : {}),
    ...(row.sessionId ? { sessionId: row.sessionId } : {}),
    embedded,
    ...(options.score === undefined ? {} : { score: Math.round(options.score * 10_000) / 10_000 }),
  }
}

/** 这张图有没有当前模型的向量（在 select 里用） */
const embeddedFor = (model: EmbedModel | undefined) =>
  model
    ? sql<boolean>`exists (select 1 from ${t.galleryEmbeddings} e where e.image_id = ${t.galleryImages.id} and e.model_id = ${model.id})`
    : sql<boolean>`false`

async function loadRow(db: Db, id: string): Promise<ImageRow> {
  const [row] = await db.select().from(t.galleryImages).where(eq(t.galleryImages.id, id))
  if (!row) throw new GalleryError("not_found", `图库里没有 ${id}`)
  return row
}

export async function getImage(db: Db, id: string, options: ViewOptions = {}): Promise<GalleryImage> {
  const model = await currentEmbedModel(db)
  const [row] = await db.select({ image: t.galleryImages, embedded: embeddedFor(model) }).from(t.galleryImages).where(eq(t.galleryImages.id, id))
  if (!row) throw new GalleryError("not_found", `图库里没有 ${id}`)
  return toGalleryImage(row.image, row.embedded, options)
}

/** 一张图在当前 embedding 模型下的向量；没设模型、当前模型还没算过时返回 null */
export async function imageEmbedding(db: Db, id: string): Promise<GalleryEmbedding | null> {
  await loadRow(db, id)
  const model = await currentEmbedModel(db)
  if (!model) return null
  const [stored] = await db
    .select({ embedding: t.galleryEmbeddings.embedding })
    .from(t.galleryEmbeddings)
    .where(and(eq(t.galleryEmbeddings.imageId, id), eq(t.galleryEmbeddings.modelId, model.id)))
  return stored ? { model, vector: stored.embedding } : null
}

/** 原图或缩略图的内容（下载接口用） */
export async function imageFile(db: Db, id: string, which: "file" | "thumb") {
  const row = await loadRow(db, id)
  const file = await getFileRow(db, which === "file" ? row.fileId : row.thumbFileId)
  if (!file) throw new GalleryError("not_found", `${id} 的文件不见了`)
  const data = await readFileData(file).catch(() => {
    throw new GalleryError("not_found", `${id} 的文件内容不见了`)
  })
  return { data, mime: file.mime, name: which === "file" ? row.name : `${id}.webp` }
}

// ---------- 传图 ----------

/** 算一张图的向量并存下来；失败时记下原因（后台过一会儿重试），不让传图失败 */
async function embedImage(db: Db, model: EmbedModel, imageId: string, data: Buffer): Promise<boolean> {
  try {
    const [vector] = await embed(db, model.id, [{ image: await modelInputImage(data) }])
    await db
      .insert(t.galleryEmbeddings)
      .values({ imageId, modelId: model.id, embedding: vector! })
      .onConflictDoUpdate({ target: [t.galleryEmbeddings.imageId, t.galleryEmbeddings.modelId], set: { embedding: vector!, createdAt: new Date() } })
    await db.update(t.galleryImages).set({ embedError: null, embedTriedAt: new Date() }).where(eq(t.galleryImages.id, imageId))
    return true
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[gallery] ${imageId} 算向量失败：${reason}`)
    await db.update(t.galleryImages).set({ embedError: reason.slice(0, 500), embedTriedAt: new Date() }).where(eq(t.galleryImages.id, imageId))
    return false
  }
}

export interface UploadInput {
  image: LoadedImage
  text?: Record<string, unknown>
  tags?: string[]
}

/** 传一张图。一模一样的文件（sha256 相同）已经在图库里了：返回那一条，不新建，也不改它的文本和标签 */
export async function uploadImage(db: Db, actor: GalleryActor, input: UploadInput, options: ViewOptions = {}): Promise<GalleryUploadResult> {
  if (actor.user && !can(actor.user, "gallery.upload", {})) throw new GalleryError("forbidden", "你不能往图库里传图")
  const { data } = input.image
  const decoded = await decodeImage(data)
  const sha256 = sha256Hex(data)
  const existing = await findBySha(db, sha256)
  if (existing) return { image: await getImage(db, existing.id, options), duplicate: true }

  const thumb = await makeThumbnail(data)
  const createdById = actor.user?.id ?? null
  const ext = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" }[decoded.mime] ?? ""
  const name = input.image.name && input.image.name !== "image" ? input.image.name : `image${ext}`
  // 文件不挂到 session 上（不然会出现在那次运行的附件和产物里），哪次运行传的记在 gallery_images.session_id
  const original = await saveFile(db, { data, name, mime: decoded.mime, kind: "gallery", createdById })
  const thumbFile = await saveFile(db, { data: thumb, name: "thumb.webp", mime: "image/webp", kind: "gallery_thumb", createdById })
  let id: string
  try {
    id = await db.transaction(async (tx) => {
      const id = galleryImageId(await nextNo(tx, "gallery_no_seq"))
      await tx.insert(t.galleryImages).values({
        id,
        fileId: original.id,
        thumbFileId: thumbFile.id,
        sha256,
        name: original.name,
        mime: decoded.mime,
        size: data.length,
        width: decoded.width,
        height: decoded.height,
        text: input.text ?? {},
        tags: normalizeTags(input.tags ?? []),
        via: actor.via,
        createdById,
        apiKeyId: actor.apiKeyId ?? null,
        sessionId: actor.sessionId ?? null,
      })
      await audit(tx, createdById, "gallery.create", "gallery_images", id, { via: actor.via, name: original.name, tags: normalizeTags(input.tags ?? []), apiKeyId: actor.apiKeyId, sessionId: actor.sessionId })
      return id
    })
  } catch (error) {
    // 两个人同时传同一张图：sha256 唯一索引挡住后一个，删掉刚存的文件，返回先传的那条
    await removeFiles(db, [original.id, thumbFile.id])
    const raced = await findBySha(db, sha256)
    if (raced) return { image: await getImage(db, raced.id, options), duplicate: true }
    throw error
  }
  const model = await currentEmbedModel(db)
  if (model) await embedImage(db, model, id, data)
  return { image: await getImage(db, id, options), duplicate: false }
}

async function findBySha(db: Db, sha256: string) {
  const [row] = await db.select({ id: t.galleryImages.id }).from(t.galleryImages).where(eq(t.galleryImages.sha256, sha256))
  return row
}

async function removeFiles(db: Db, ids: string[]) {
  const rows = ids.length ? await db.select().from(t.files).where(inArray(t.files.id, ids)) : []
  if (rows.length) await db.delete(t.files).where(inArray(t.files.id, ids))
  for (const row of rows) await fileStorage().remove(row.storagePath).catch(() => undefined)
}

// ---------- 改、删 ----------

function assertManage(actor: GalleryActor, row: ImageRow, what: string) {
  // agent 能改（任务里选了图库就能整理图），不能删
  if (!actor.user) {
    if (what === "删") throw new GalleryError("forbidden", "agent 不能删除图库里的图")
    return
  }
  if (!can(actor.user, "gallery.manage", { createdById: row.createdById ?? "" })) throw new GalleryError("forbidden", `只有上传的人和主管能${what}这张图`)
}

export async function updateImage(db: Db, actor: GalleryActor, input: GalleryUpdateInput, options: ViewOptions = {}): Promise<GalleryImage> {
  const row = await loadRow(db, input.id)
  assertManage(actor, row, "改")
  let tags = input.tags ? normalizeTags(input.tags) : row.tags
  if (input.addTags) tags = normalizeTags([...tags, ...input.addTags])
  if (input.removeTags) {
    const remove = new Set(normalizeTags(input.removeTags))
    tags = tags.filter((tag) => !remove.has(tag))
  }
  const text = input.text ?? row.text
  await db.transaction(async (tx) => {
    await tx.update(t.galleryImages).set({ text, tags }).where(eq(t.galleryImages.id, row.id))
    await audit(tx, actor.user?.id ?? null, "gallery.update", "gallery_images", row.id, { via: actor.via, textChanged: input.text !== undefined, before: { tags: row.tags }, after: { tags }, sessionId: actor.sessionId })
  })
  return getImage(db, row.id, options)
}

export async function deleteImage(db: Db, actor: GalleryActor, id: string) {
  const row = await loadRow(db, id)
  assertManage(actor, row, "删")
  await db.transaction(async (tx) => {
    await tx.delete(t.galleryImages).where(eq(t.galleryImages.id, id))
    await audit(tx, actor.user?.id ?? null, "gallery.delete", "gallery_images", id, { via: actor.via, name: row.name, sha256: row.sha256, tags: row.tags })
  })
  await removeFiles(db, [row.fileId, row.thumbFileId])
  return { id }
}

/** 一次删多张（图片墙上选中的）：有一张找不到或没权限删就整批不删 */
export async function deleteImages(db: Db, actor: GalleryActor, ids: string[]) {
  const unique = [...new Set(ids)]
  const rows = unique.length ? await db.select().from(t.galleryImages).where(inArray(t.galleryImages.id, unique)) : []
  const missing = unique.filter((id) => !rows.some((row) => row.id === id))
  if (missing.length) throw new GalleryError("not_found", `图库里没有 ${missing.join("、")}`)
  for (const row of rows) assertManage(actor, row, "删")
  await db.transaction(async (tx) => {
    await tx.delete(t.galleryImages).where(inArray(t.galleryImages.id, unique))
    for (const row of rows) await audit(tx, actor.user?.id ?? null, "gallery.delete", "gallery_images", row.id, { via: actor.via, name: row.name, sha256: row.sha256, tags: row.tags })
  })
  await removeFiles(db, rows.flatMap((row) => [row.fileId, row.thumbFileId]))
  return { ids: unique }
}

// ---------- 检索 ----------

/** ILIKE 的 % _ \ 要转义 */
const likePattern = (text: string) => `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`

const COMPARE: Record<"gt" | "gte" | "lt" | "lte", string> = { gt: ">", gte: ">=", lt: "<", lte: "<=" }

function conditionSql(cond: GalleryCondition): SQL {
  // drizzle 会把 JS 数组拆成一个个参数，路径要自己拼成 array[...]
  const path = sql.join(
    conditionPath(cond.path).map((segment) => sql`${segment}`),
    sql`, `
  )
  const target = sql`(${t.galleryImages.text} #> array[${path}]::text[])`
  const value = cond.value
  switch (cond.op) {
    case "exists":
      return sql`${target} is not null`
    case "eq":
      return sql`${target} = ${JSON.stringify(value)}::jsonb`
    case "ne":
      return sql`${target} is distinct from ${JSON.stringify(value)}::jsonb`
    case "contains":
      return sql`(case jsonb_typeof(${target})
        when 'string' then (${target} #>> '{}') ilike ${likePattern(String(value))}
        when 'array' then ${target} @> ${JSON.stringify([value])}::jsonb
        else false end)`
    default: {
      const op = sql.raw(COMPARE[cond.op])
      // 数字按大小比，字符串按字节序比（日期写成 2026-10-17 这种就能比）；类型对不上的不算
      return typeof value === "number"
        ? sql`(case when jsonb_typeof(${target}) = 'number' then (${target} #>> '{}')::numeric ${op} ${value}::numeric else false end)`
        : sql`(case when jsonb_typeof(${target}) = 'string' then (${target} #>> '{}') collate "C" ${op} ${String(value)} else false end)`
    }
  }
}

function filterSql(filter: GalleryFilter): SQL[] {
  const where: SQL[] = []
  const tags = normalizeTags(filter.tags ?? [])
  const anyTags = normalizeTags(filter.anyTags ?? [])
  if (tags.length) where.push(arrayContains(t.galleryImages.tags, tags))
  if (anyTags.length) where.push(arrayOverlaps(t.galleryImages.tags, anyTags))
  if (filter.text && Object.keys(filter.text).length) where.push(sql`${t.galleryImages.text} @> ${JSON.stringify(filter.text)}::jsonb`)
  for (const cond of filter.where ?? []) where.push(conditionSql(cond))
  if (filter.keyword) {
    // 只找值（字符串、数字、布尔），不找键名
    where.push(sql`exists (
      select 1 from jsonb_path_query(${t.galleryImages.text}, 'strict $.**') as v(value)
      where jsonb_typeof(v.value) in ('string', 'number', 'boolean') and (v.value #>> '{}') ilike ${likePattern(filter.keyword)}
    )`)
  }
  return where
}

const encodeCursor = (row: ImageRow) => Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString("base64url")

function decodeCursor(cursor: string) {
  const [at, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|")
  const date = new Date(at ?? "")
  if (!id || Number.isNaN(date.getTime())) throw new GalleryError("bad_request", "cursor 不对：用上一页返回的 nextCursor")
  return { date, id }
}

/** 检索的输入（三种接口的输入转成这个）：image 是已经读出来的图片内容，或者图库里已有的图 */
export interface SearchQuery extends GalleryFilter {
  image?: LoadedImage | { imageId: string }
  query?: string
  minScore?: number
  limit?: number
  cursor?: string
}

const DEFAULT_LIMIT = 50

export async function searchImages(db: Db, input: SearchQuery, options: ViewOptions = {}): Promise<GalleryPage> {
  if (input.image && input.query) throw new GalleryError("bad_request", "image 和 query 只能传一个：以图搜图，或者用一句描述找图")
  const limit = input.limit ?? DEFAULT_LIMIT
  const filters = filterSql(input)
  if (input.image || input.query) return vectorSearch(db, input, filters, limit, options)

  const model = await currentEmbedModel(db)
  if (input.cursor) {
    const { date, id } = decodeCursor(input.cursor)
    filters.push(or(lt(t.galleryImages.createdAt, date), and(eq(t.galleryImages.createdAt, date), lt(t.galleryImages.id, id)))!)
  }
  const rows = await db
    .select({ image: t.galleryImages, embedded: embeddedFor(model) })
    .from(t.galleryImages)
    .where(and(...filters))
    .orderBy(desc(t.galleryImages.createdAt), desc(t.galleryImages.id))
    .limit(limit + 1)
  const page = rows.slice(0, limit)
  return {
    items: page.map((row) => toGalleryImage(row.image, row.embedded, options)),
    ...(rows.length > limit ? { nextCursor: encodeCursor(page.at(-1)!.image) } : {}),
  }
}

/** 一张图的向量：图库里已有的直接用存好的（当前模型没算过就现算），新图现算 */
async function vectorOfImage(db: Db, model: EmbedModel, image: LoadedImage | { imageId: string }): Promise<number[]> {
  if ("imageId" in image) {
    const [stored] = await db
      .select({ embedding: t.galleryEmbeddings.embedding })
      .from(t.galleryEmbeddings)
      .where(and(eq(t.galleryEmbeddings.imageId, image.imageId), eq(t.galleryEmbeddings.modelId, model.id)))
    if (stored) return stored.embedding
    const file = await imageFile(db, image.imageId, "file")
    return (await embed(db, model.id, [{ image: await modelInputImage(file.data) }]))[0]!
  }
  await decodeImage(image.data)
  return (await embed(db, model.id, [{ image: await modelInputImage(image.data) }]))[0]!
}

/**
 * 检索、比对用哪个模型的向量：默认模型的向量最全时用它；刚换了默认模型、后台还在重算时，用向量最全的那个旧模型
 * （它还在模型列表里才行），免得重算的这段时间搜不到还没算到的图。不同模型的向量不能混着比
 */
async function searchModel(db: Db): Promise<EmbedModel> {
  const current = await requireEmbedModel(db)
  const coverage = await db.select({ modelId: t.galleryEmbeddings.modelId, n: count() }).from(t.galleryEmbeddings).groupBy(t.galleryEmbeddings.modelId)
  const own = coverage.find((row) => row.modelId === current.id)?.n ?? 0
  const better = coverage.filter((row) => row.modelId !== current.id && row.n > own).sort((a, b) => b.n - a.n)
  for (const candidate of better) {
    const [model] = await db
      .select({ id: t.models.id, name: t.models.name })
      .from(t.models)
      .where(and(eq(t.models.id, candidate.modelId), eq(t.models.kind, "embedding")))
    if (model) return model
  }
  return current
}

async function vectorSearch(db: Db, input: SearchQuery, filters: SQL[], limit: number, options: ViewOptions): Promise<GalleryPage> {
  const model = await searchModel(db)
  const vector = input.query ? (await embed(db, model.id, [{ text: input.query }]))[0]! : await vectorOfImage(db, model, input.image!)
  const distance = sql<number>`(${t.galleryEmbeddings.embedding} <=> ${vectorLiteral(vector)}::vector)`
  // 找相似时不把它自己排在第一个
  if (input.image && "imageId" in input.image) filters.push(ne(t.galleryImages.id, input.image.imageId))
  const rows = await db.transaction(async (tx) => {
    // 带筛选条件时 HNSW 先按距离取一批再过滤，可能凑不够 limit 条；迭代扫描会接着往下找（pgvector 0.8 起）
    await tx.execute(sql`set local hnsw.iterative_scan = relaxed_order`)
    await tx.execute(sql`set local hnsw.ef_search = ${sql.raw(String(Math.max(40, Math.min(1000, limit * 2))))}`)
    return tx
      .select({ image: t.galleryImages, distance })
      .from(t.galleryEmbeddings)
      .innerJoin(t.galleryImages, eq(t.galleryImages.id, t.galleryEmbeddings.imageId))
      .where(and(eq(t.galleryEmbeddings.modelId, model.id), ...filters))
      .orderBy(distance)
      .limit(limit)
  })
  // relaxed_order 的结果可能有一点乱序，按分数重新排一遍
  const items = rows
    .map((row) => ({ row, score: 1 - Number(row.distance) }))
    .filter((each) => input.minScore === undefined || each.score >= input.minScore)
    .sort((a, b) => b.score - a.score)
    .map(({ row, score }) => toGalleryImage(row.image, true, { ...options, score }))
  return { items, model: model.id }
}

// ---------- 比对 ----------

export type CompareSide = LoadedImage | { imageId: string }

/** 两张图有多像（余弦相似度），以及算不算同一张 / 同款（不传阈值就用这个模型标定过的默认值） */
export async function compareImages(db: Db, a: CompareSide, b: CompareSide, threshold?: number): Promise<GalleryCompareResult> {
  const model = await searchModel(db)
  const [va, vb] = await Promise.all([vectorOfImage(db, model, a), vectorOfImage(db, model, b)])
  const score = Math.round(cosine(va, vb) * 10_000) / 10_000
  const limit = threshold ?? gallerySameThreshold(model.id)
  return { score, same: score >= limit, threshold: limit, model: model.id }
}

// ---------- 统计、标签 ----------

export async function galleryStats(db: Db): Promise<GalleryStats> {
  const model = await currentEmbedModel(db)
  const [total] = await db.select({ n: count() }).from(t.galleryImages)
  if (!model) return { total: total?.n ?? 0, pending: 0 }
  const missing = notExists(
    db
      .select({ one: sql`1` })
      .from(t.galleryEmbeddings)
      .where(and(eq(t.galleryEmbeddings.imageId, t.galleryImages.id), eq(t.galleryEmbeddings.modelId, model.id)))
  )
  const [pending] = await db.select({ n: count() }).from(t.galleryImages).where(missing)
  const [failed] = await db
    .select({ error: t.galleryImages.embedError })
    .from(t.galleryImages)
    .where(and(missing, sql`${t.galleryImages.embedError} is not null`))
    .orderBy(desc(t.galleryImages.embedTriedAt))
    .limit(1)
  return { total: total?.n ?? 0, embedModel: model, pending: pending?.n ?? 0, ...(failed?.error ? { lastError: failed.error } : {}) }
}

/** 用得最多的标签（页面的标签筛选用） */
export async function galleryTags(db: Db, limit = 300): Promise<GalleryTagCount[]> {
  const result = await db.execute<{ tag: string; n: string }>(
    sql`select tag, count(*) as n from ${t.galleryImages}, unnest(${t.galleryImages.tags}) as tag group by tag order by count(*) desc, tag limit ${limit}`
  )
  return result.rows.map((row) => ({ tag: row.tag, count: Number(row.n) }))
}

// ---------- 读图片引用 ----------

/** 检索、比对时的一张图：imageId 保留（用存好的向量），其余读成内容 */
export async function resolveSide(db: Db, ref: GalleryImageRef, actor: GalleryActor): Promise<CompareSide> {
  if ("imageId" in ref) {
    await loadRow(db, ref.imageId)
    return { imageId: ref.imageId }
  }
  return loadImageRef(db, ref, actor)
}

/** 上传时的图：不能指图库里已有的图 */
export async function resolveUpload(db: Db, ref: GalleryImageRef, actor: GalleryActor): Promise<LoadedImage> {
  if ("imageId" in ref) throw new GalleryError("bad_request", "上传要给新图片：base64、url 或 fileId（imageId 是图库里已有的图）")
  return loadImageRef(db, ref, actor)
}

// ---------- 后台补算向量 ----------

/** 当前模型还没算向量的图（刚换模型、传图时模型调用失败），失败过的隔 10 分钟再试 */
export async function embedPending(db: Db, batch = 8): Promise<number> {
  const model = await currentEmbedModel(db)
  if (!model) return 0
  const missing = notExists(
    db
      .select({ one: sql`1` })
      .from(t.galleryEmbeddings)
      .where(and(eq(t.galleryEmbeddings.imageId, t.galleryImages.id), eq(t.galleryEmbeddings.modelId, model.id)))
  )
  const rows = await db
    .select({ id: t.galleryImages.id, fileId: t.galleryImages.fileId })
    .from(t.galleryImages)
    .where(and(missing, or(isNull(t.galleryImages.embedTriedAt), isNull(t.galleryImages.embedError), sql`${t.galleryImages.embedTriedAt} < now() - interval '10 minutes'`)))
    .orderBy(t.galleryImages.createdAt)
    .limit(batch)
  if (rows.length === 0) {
    // 当前模型一张不落都算完了，旧模型的向量才删（检索在这之前一直用旧的，见 searchModel；换回来时再算，一张图不到一分钱）
    const [left] = await db.select({ n: count() }).from(t.galleryImages).where(missing)
    if ((left?.n ?? 0) === 0) await db.delete(t.galleryEmbeddings).where(ne(t.galleryEmbeddings.modelId, model.id))
    return 0
  }
  const inputs: { id: string; image: Buffer }[] = []
  for (const row of rows) {
    try {
      const file = await getFileRow(db, row.fileId)
      if (!file) throw new Error("原图文件不见了")
      inputs.push({ id: row.id, image: await modelInputImage(await readFileData(file)) })
    } catch (error) {
      await db.update(t.galleryImages).set({ embedError: (error as Error).message.slice(0, 500), embedTriedAt: new Date() }).where(eq(t.galleryImages.id, row.id))
    }
  }
  if (inputs.length === 0) return rows.length
  try {
    const vectors = await embed(db, model.id, inputs.map((input) => ({ image: input.image })))
    await db
      .insert(t.galleryEmbeddings)
      .values(inputs.map((input, i) => ({ imageId: input.id, modelId: model.id, embedding: vectors[i]! })))
      .onConflictDoNothing()
    await db.update(t.galleryImages).set({ embedError: null, embedTriedAt: new Date() }).where(inArray(t.galleryImages.id, inputs.map((input) => input.id)))
  } catch (error) {
    const reason = (error as Error).message.slice(0, 500)
    await db.update(t.galleryImages).set({ embedError: reason, embedTriedAt: new Date() }).where(inArray(t.galleryImages.id, inputs.map((input) => input.id)))
    throw error
  }
  return rows.length
}
