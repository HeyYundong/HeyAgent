// 比图：两张图交给视觉模型，按比对标准逐项打分、写出差异（docs/dev/compare.md）。
// 这里是全部业务逻辑：读记录、新比对（四个入口共用一个函数：页面、HTTP 接口、MCP、agent）、复用、再比一次、删除、视觉模型、比对标准。
// 比对本身在 worker 里（run.ts）；HTTP 接口（routes.ts）、MCP（mcp.ts）、agent 工具组（tools.ts）只做翻译。
import {
  can,
  COMPARE_REUSE_MINUTES,
  compareStandardId,
  comparisonId,
  type Actor,
  type CompareCreateInput,
  type CompareListInput,
  type CompareModel,
  type ComparePage,
  type CompareStandard,
  type CompareStandardInput,
  type CompareVia,
  type Comparison,
  type GalleryImageRef,
} from "@heyagent/shared"
import { and, asc, count, desc, eq, gt, ilike, inArray, isNull, lt, ne, notExists, or, sql, type SQL } from "drizzle-orm"

import { audit, nextNo, type DbOrTx } from "../data/config/common.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { compareRunJobOptions, QUEUES, sendInTx } from "../engine/queue.js"
import { fileStorage, fileUrl, getFileRow, readFileData, saveFile, type FileRow } from "../files/service.js"
import { sha256Hex } from "../files/storage.js"
import { checkSize, decodeImage, loadImageRef, type LoadedImage, type RefOptions } from "../gallery/images.js"
import { DEFAULT_STANDARD_ID, DEFAULT_STANDARD_NAME, DEFAULT_STANDARD_PASS_SCORE, FALLBACK_PASS_SCORE, SAME_ITEM_PROMPT } from "./defaults.js"
import { CompareError } from "./errors.js"

type ComparisonRow = typeof t.comparisons.$inferSelect
type StandardRow = typeof t.compareStandards.$inferSelect

/** 可调的上限（测试里改小） */
export const compareLimits = {
  /** 同步等结果（HTTP / MCP 的 compare_images、agent 工具）最多等多久 */
  waitMs: 90_000,
  /** 等结果时多久查一次库 */
  pollMs: 500,
  /** 还标着「比对中」、超过这么久的，worker 启动时记为没比成（进程崩溃、pg-boss 重试也用完了） */
  staleMinutes: 15,
}

export function configureCompare(patch: Partial<typeof compareLimits>) {
  Object.assign(compareLimits, patch)
}

/** 谁在比：登录的人 / API 密钥（算密钥的创建人）/ agent（user 为空，记哪次运行） */
export interface CompareActor extends RefOptions {
  user: Actor | null
  via: CompareVia
  apiKeyId?: string
  sessionId?: string
  taskId?: string
}

export interface ViewOptions {
  /** HTTP 接口、MCP 给外部用：图片地址要完整，走 /api/compare/files/:id（API 密钥也能下）。页面用相对地址 /api/files/:id */
  baseUrl?: string
}

const iso = (value: Date | null) => (value ? value.toISOString() : null)

export function toComparison(row: ComparisonRow, options: ViewOptions = {}): Comparison {
  const url = (fileId: string) => (options.baseUrl === undefined ? fileUrl(fileId) : `${options.baseUrl}/api/compare/files/${fileId}`)
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    imageA: { fileId: row.fileAId, url: url(row.fileAId), label: row.labelA, from: row.fromA },
    imageB: { fileId: row.fileBId, url: url(row.fileBId), label: row.labelB, from: row.fromB },
    standardId: row.standardId,
    standardName: row.standardName,
    prompt: row.prompt,
    passScore: row.passScore,
    modelId: row.modelId,
    score: row.score,
    passed: row.score === null ? null : row.score >= row.passScore,
    confidence: row.confidence,
    verdict: row.verdict,
    reasons: row.reasons,
    dimensions: row.dimensions,
    differences: row.differences,
    error: row.error,
    costUsd: row.costUsd,
    via: row.via,
    createdById: row.createdById,
    sessionId: row.sessionId,
    taskId: row.taskId,
    apiKeyId: row.apiKeyId,
    createdAt: row.createdAt.toISOString(),
    finishedAt: iso(row.finishedAt),
  }
}

export function toStandard(row: StandardRow): CompareStandard {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    passScore: row.passScore,
    modelId: row.modelId,
    isDefault: row.isDefault,
    createdById: row.createdById,
    updatedAt: row.updatedAt.toISOString(),
  }
}

async function loadRow(db: DbOrTx, id: string): Promise<ComparisonRow> {
  const [row] = await db.select().from(t.comparisons).where(eq(t.comparisons.id, id))
  if (!row) throw new CompareError("not_found", `找不到比对 ${id}`)
  return row
}

export async function getComparison(db: DbOrTx, id: string, options: ViewOptions = {}): Promise<Comparison> {
  return toComparison(await loadRow(db, id), options)
}

/** 新的在前；query 搜标题、编号、要求、模型 */
export async function listComparisons(db: DbOrTx, input: CompareListInput, options: ViewOptions = {}): Promise<ComparePage> {
  const limit = input.limit ?? 50
  const conditions: SQL[] = []
  if (input.query) {
    const like = `%${input.query.replace(/[%_\\]/g, (char) => `\\${char}`)}%`
    conditions.push(or(ilike(t.comparisons.title, like), ilike(t.comparisons.id, like), ilike(t.comparisons.prompt, like), ilike(t.comparisons.modelId, like))!)
  }
  if (input.status) conditions.push(eq(t.comparisons.status, input.status))
  if (input.sessionId) conditions.push(eq(t.comparisons.sessionId, input.sessionId))
  if (input.cursor) {
    const [after] = await db.select({ createdAt: t.comparisons.createdAt }).from(t.comparisons).where(eq(t.comparisons.id, input.cursor))
    if (after) conditions.push(or(lt(t.comparisons.createdAt, after.createdAt), and(eq(t.comparisons.createdAt, after.createdAt), lt(t.comparisons.id, input.cursor)))!)
  }
  const rows = await db
    .select()
    .from(t.comparisons)
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(t.comparisons.createdAt), desc(t.comparisons.id))
    .limit(limit + 1)
  const items = rows.slice(0, limit).map((row) => toComparison(row, options))
  return { items, nextCursor: rows.length > limit ? items.at(-1)!.id : null }
}

/** 等一条比对比完（同步接口用）：比完或者到时间就返回当时的记录（到时间还在比的是 running，让对方之后再查） */
export async function waitForComparison(db: Db, id: string, options: ViewOptions = {}, timeoutMs = compareLimits.waitMs): Promise<Comparison> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = await loadRow(db, id)
    if (row.status !== "running" || Date.now() >= deadline) return toComparison(row, options)
    await new Promise((resolve) => setTimeout(resolve, Math.min(compareLimits.pollMs, Math.max(0, deadline - Date.now()))))
  }
}

// ---------- 视觉模型 ----------

/** 能比图的模型：库里 vision = true 的聊天模型，便宜的在前 */
export async function listVisionModels(db: DbOrTx): Promise<CompareModel[]> {
  const rows = await db
    .select({ id: t.models.id, name: t.models.name, priceIn: t.models.priceIn, priceOut: t.models.priceOut })
    .from(t.models)
    .where(and(eq(t.models.vision, true), eq(t.models.kind, "chat")))
    .orderBy(asc(t.models.priceIn), asc(t.models.priceOut), asc(t.models.id))
  // 「:batch」是批处理线路，聊天接口用不了（实测报错）
  return rows.filter((row) => !row.id.endsWith(":batch"))
}

/**
 * 默认标准优先用的模型（OpenRouter 上的名字，用户 2026-10-18 定的）：实测同款判断最准、约 $0.001 一次、3～8 秒（docs/dev/compare.md 6.6）。
 * 任何服务里名字以它结尾的都算；没有时退回最便宜的「正经」视觉模型
 */
export const DEFAULT_COMPARE_MODEL = "google/gemini-3.1-flash-lite"

/**
 * 默认标准用的模型：有推荐的用推荐的；否则最便宜的「正经」视觉模型。跳过免费线路（:free，限流、常下线）、预览版、
 * 别名（~ 开头，指向会变）和没标价的；都没有时退回列表第一个
 */
async function cheapestVisionModel(db: DbOrTx): Promise<string | undefined> {
  const models = await listVisionModels(db)
  const preferred = models.find((model) => model.id.endsWith(`/${DEFAULT_COMPARE_MODEL}`))
  if (preferred) return preferred.id
  const stable = models.find((model) => model.priceIn > 0 && !/:free$/.test(model.id) && !/preview/i.test(model.id) && !model.id.split("/").some((part) => part.startsWith("~")))
  return (stable ?? models[0])?.id
}

/** 模型必须是库里能看图的聊天模型 */
async function assertVisionModel(db: DbOrTx, modelId: string, context = "") {
  const [model] = await db.select({ name: t.models.name, vision: t.models.vision, kind: t.models.kind }).from(t.models).where(eq(t.models.id, modelId))
  if (!model) throw new CompareError("bad_request", `${context}模型 ${modelId} 不在模型列表里（模型服务刷新后可能没了）：换一个能看图的模型`)
  if (model.kind !== "chat" || !model.vision) throw new CompareError("bad_request", `${context}${model.name}（${modelId}）不能看图：比图要用能看图的聊天模型`)
}

// ---------- 比对标准 ----------

/**
 * 保证至少有一个比对标准：一个都没有时建初始的「同款判断」（模型 = 最便宜的视觉模型）。
 * 库里还没有视觉模型就先不建（接好模型服务以后，下次启动或下次用到时再建）。返回建没建
 */
export async function ensureDefaultStandard(db: Db): Promise<boolean> {
  const [existing] = await db.select({ n: count() }).from(t.compareStandards)
  if ((existing?.n ?? 0) > 0) return false
  const modelId = await cheapestVisionModel(db)
  if (!modelId) return false
  // API 和 worker 同时启动时可能一起建：撞上主键或「只有一个默认」的唯一索引就算了
  const inserted = await db
    .insert(t.compareStandards)
    .values({ id: DEFAULT_STANDARD_ID, name: DEFAULT_STANDARD_NAME, prompt: SAME_ITEM_PROMPT, passScore: DEFAULT_STANDARD_PASS_SCORE, modelId, isDefault: true })
    .onConflictDoNothing()
    .returning({ id: t.compareStandards.id })
  if (inserted.length) await audit(db, null, "compare_standard.create", "compare_standards", DEFAULT_STANDARD_ID, { name: DEFAULT_STANDARD_NAME, modelId, by: "bootstrap" })
  return inserted.length > 0
}

export async function listStandards(db: Db): Promise<CompareStandard[]> {
  await ensureDefaultStandard(db)
  const rows = await db.select().from(t.compareStandards).orderBy(desc(t.compareStandards.isDefault), asc(t.compareStandards.position), asc(t.compareStandards.createdAt))
  return rows.map(toStandard)
}

/** 默认标准：标了默认的那个；万一没有标的，用排第一的 */
async function defaultStandard(db: Db): Promise<StandardRow | undefined> {
  await ensureDefaultStandard(db)
  const [row] = await db.select().from(t.compareStandards).orderBy(desc(t.compareStandards.isDefault), asc(t.compareStandards.position), asc(t.compareStandards.createdAt)).limit(1)
  return row
}

/** 按 id 或名字（不分大小写）找标准 */
async function findStandard(db: DbOrTx, key: string): Promise<StandardRow | undefined> {
  const [row] = await db
    .select()
    .from(t.compareStandards)
    .where(or(eq(t.compareStandards.id, key), sql`lower(${t.compareStandards.name}) = lower(${key})`))
    .orderBy(sql`${t.compareStandards.id} = ${key} desc`)
    .limit(1)
  return row
}

function assertConfig(actor: CompareActor) {
  if (!actor.user || !can(actor.user, "config.manage", {})) throw new CompareError("forbidden", "比对标准由主管维护：只有主管能新建、修改、删除、设默认")
}

async function assertNameFree(db: DbOrTx, name: string, exceptId?: string) {
  const [taken] = await db
    .select({ id: t.compareStandards.id })
    .from(t.compareStandards)
    .where(and(sql`lower(${t.compareStandards.name}) = lower(${name})`, exceptId ? ne(t.compareStandards.id, exceptId) : undefined))
  if (taken) throw new CompareError("bad_request", `已经有叫「${name}」的标准了（${taken.id}）`)
}

/** 名字的唯一索引挡住了（两个人同时建同名的） */
const isUniqueViolation = (error: unknown) => (error as { code?: string })?.code === "23505" || (error as { cause?: { code?: string } })?.cause?.code === "23505"

export async function createStandard(db: Db, actor: CompareActor, input: CompareStandardInput): Promise<CompareStandard> {
  assertConfig(actor)
  await assertNameFree(db, input.name)
  await assertVisionModel(db, input.modelId)
  try {
    const row = await db.transaction(async (tx) => {
      const id = compareStandardId(await nextNo(tx, "compare_standard_no_seq"))
      const [{ n = 0 } = {}] = await tx.select({ n: count() }).from(t.compareStandards)
      const [row] = await tx
        .insert(t.compareStandards)
        .values({ id, name: input.name, prompt: input.prompt, passScore: input.passScore, modelId: input.modelId, isDefault: n === 0, position: n, createdById: actor.user!.id })
        .returning()
      await audit(tx, actor.user!.id, "compare_standard.create", "compare_standards", id, { name: input.name, passScore: input.passScore, modelId: input.modelId })
      return row!
    })
    return toStandard(row)
  } catch (error) {
    if (isUniqueViolation(error)) throw new CompareError("bad_request", `已经有叫「${input.name}」的标准了`)
    throw error
  }
}

export async function updateStandard(db: Db, actor: CompareActor, input: CompareStandardInput & { id: string }): Promise<CompareStandard> {
  assertConfig(actor)
  const [before] = await db.select().from(t.compareStandards).where(eq(t.compareStandards.id, input.id))
  if (!before) throw new CompareError("not_found", `找不到比对标准 ${input.id}`)
  await assertNameFree(db, input.name, input.id)
  if (input.modelId !== before.modelId) await assertVisionModel(db, input.modelId)
  try {
    const row = await db.transaction(async (tx) => {
      const [row] = await tx
        .update(t.compareStandards)
        .set({ name: input.name, prompt: input.prompt, passScore: input.passScore, modelId: input.modelId, updatedAt: new Date() })
        .where(eq(t.compareStandards.id, input.id))
        .returning()
      await audit(tx, actor.user!.id, "compare_standard.update", "compare_standards", input.id, {
        before: { name: before.name, passScore: before.passScore, modelId: before.modelId },
        after: { name: input.name, passScore: input.passScore, modelId: input.modelId },
        promptChanged: before.prompt !== input.prompt,
      })
      return row!
    })
    return toStandard(row)
  } catch (error) {
    if (isUniqueViolation(error)) throw new CompareError("bad_request", `已经有叫「${input.name}」的标准了`)
    throw error
  }
}

/** 删标准：默认的不能删；以前用它比的记录留着（standard_id 置空，standard_name 还在） */
export async function deleteStandard(db: Db, actor: CompareActor, id: string) {
  assertConfig(actor)
  const [row] = await db.select().from(t.compareStandards).where(eq(t.compareStandards.id, id))
  if (!row) throw new CompareError("not_found", `找不到比对标准 ${id}`)
  if (row.isDefault) throw new CompareError("bad_request", `「${row.name}」是默认标准，不能删：先把别的标准设成默认`)
  await db.transaction(async (tx) => {
    await tx.delete(t.compareStandards).where(eq(t.compareStandards.id, id))
    await audit(tx, actor.user!.id, "compare_standard.delete", "compare_standards", id, { name: row.name, passScore: row.passScore, modelId: row.modelId })
  })
  return { id }
}

export async function setDefaultStandard(db: Db, actor: CompareActor, id: string) {
  assertConfig(actor)
  const [row] = await db.select().from(t.compareStandards).where(eq(t.compareStandards.id, id))
  if (!row) throw new CompareError("not_found", `找不到比对标准 ${id}`)
  if (row.isDefault) return { id }
  await db.transaction(async (tx) => {
    // 表上「只有一个默认」是部分唯一索引：先清后设
    await tx.update(t.compareStandards).set({ isDefault: false, updatedAt: new Date() }).where(eq(t.compareStandards.isDefault, true))
    await tx.update(t.compareStandards).set({ isDefault: true, updatedAt: new Date() }).where(eq(t.compareStandards.id, id))
    await audit(tx, actor.user!.id, "compare_standard.set_default", "compare_standards", id, { name: row.name })
  })
  return { id }
}

// ---------- 新比对 ----------

/** 比对里的一张图：图片引用（图库 id、文件 id、网址、base64），或者 HTTP multipart 直接传上来的文件 */
export type CompareSideInput = GalleryImageRef | { upload: LoadedImage }

export type CompareCreateRequest = Omit<CompareCreateInput, "imageA" | "imageB"> & { imageA: CompareSideInput; imageB: CompareSideInput }

interface ResolvedSide {
  data: Buffer
  name: string
  mime: string
  sha256: string
  /** 本来就是比图的文件：直接用，不再存一份 */
  compareFile?: FileRow
  /** 页面上传的文件（kind = upload）：存的时候可以直接改成比图的 */
  uploadFile?: FileRow
  from: string
  defaultLabel: string
}

const FILE_KIND_LABEL: Record<string, string> = { screenshot: "截图", attachment: "附件", artifact: "产物", tool_output: "输出", upload: "文件" }

async function readFileSide(db: Db, actor: CompareActor, fileId: string): Promise<{ row: FileRow; data: Buffer }> {
  const row = await getFileRow(db, fileId)
  const hidden = !row || (actor.canReadFile ? !(await actor.canReadFile(fileId)) : row.kind === "import" && !actor.user?.isAdmin)
  // agent 只能用这次运行看得到的文件；要导入的包（可能有明文密钥）只有主管能读
  if (hidden) throw new CompareError("not_found", actor.canReadFile ? `这次运行里没有文件 ${fileId}` : `找不到文件 ${fileId}`)
  checkSize(row.size)
  const data = await readFileData(row).catch(() => {
    throw new CompareError("not_found", `文件 ${fileId} 的内容不见了`)
  })
  return { row, data }
}

/** 读一张图：读出内容、认格式（不是图片就报错），记下从哪来的、默认的说明 */
async function resolveSide(db: Db, actor: CompareActor, side: CompareSideInput): Promise<ResolvedSide> {
  let data: Buffer
  let name: string
  let from: string
  let defaultLabel: string
  let compareFile: FileRow | undefined
  let uploadFile: FileRow | undefined
  if ("upload" in side) {
    ;({ data, name } = side.upload)
    from = "上传"
    defaultLabel = name === "image" ? "" : name
  } else if ("imageId" in side) {
    const [image] = await db.select({ fileId: t.galleryImages.fileId, name: t.galleryImages.name }).from(t.galleryImages).where(eq(t.galleryImages.id, side.imageId))
    if (!image) throw new CompareError("not_found", `图库里没有 ${side.imageId}`)
    const file = await getFileRow(db, image.fileId)
    if (!file) throw new CompareError("not_found", `${side.imageId} 的文件不见了`)
    data = await readFileData(file).catch(() => {
      throw new CompareError("not_found", `${side.imageId} 的文件内容不见了`)
    })
    name = image.name
    from = `图库 ${side.imageId}`
    defaultLabel = image.name
  } else if ("fileId" in side) {
    const { row, data: content } = await readFileSide(db, actor, side.fileId)
    data = content
    name = row.name
    defaultLabel = row.name
    if (row.kind === "compare") compareFile = row
    if (row.kind === "upload") uploadFile = row
    from = row.sessionId
      ? `运行 ${row.sessionId} 的${FILE_KIND_LABEL[row.kind] ?? "文件"}`
      : row.taskId
        ? `任务 ${row.taskId} 的附件`
        : row.kind === "upload" || row.kind === "compare"
          ? "上传"
          : `文件 ${row.id}`
  } else if ("url" in side) {
    ;({ data, name } = await loadImageRef(db, side))
    from = `网址 ${side.url}`.slice(0, 500)
    defaultLabel = side.url.slice(0, 100)
  } else {
    ;({ data, name } = await loadImageRef(db, side))
    from = "上传"
    defaultLabel = ""
  }
  const { mime } = await decodeImage(data)
  return { data, name, mime, sha256: sha256Hex(data), compareFile, uploadFile, from, defaultLabel }
}

/** 把 Lens 式的字符串认成图片引用（MCP、agent 工具用） */
export function parseImageParam(value: string | GalleryImageRef): GalleryImageRef {
  if (typeof value !== "string") return value
  if (/^https?:\/\//i.test(value)) return { url: value }
  if (/^data:/i.test(value)) return { base64: value }
  if (/^img-\d+$/.test(value)) return { imageId: value }
  if (/^f-[0-9a-z]+$/i.test(value)) return { fileId: value }
  // 不带前缀的 base64（够长、只有 base64 的字符）
  if (value.length > 100 && /^[A-Za-z0-9+/_=\s-]+$/.test(value)) return { base64: value }
  throw new CompareError("bad_request", `认不出图片「${value.slice(0, 60)}」：写网址、data: 开头的 base64、图库 id（img-…）或文件 id（f-…）`)
}

const EXT: Record<string, string> = { "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" }

/**
 * 两张图存成比图自己的文件（kind = compare，同样内容的只存一份）。图库的图、运行的截图、任务附件也复制一份：
 * 比对记录对文件有外键，直接引用别人的文件会让删图、删任务失败；复制一份，删比对时也只删比图自己的
 */
async function storeSide(db: Db, actor: CompareActor, side: ResolvedSide): Promise<FileRow> {
  if (side.compareFile) return side.compareFile
  // 页面刚为这次比对传上来的文件（POST /api/files，不属于任务和运行）：直接改成比图的，或者已经有同样的图时删掉，不留下没人用的
  const ownUpload = Boolean(side.uploadFile && actor.user && side.uploadFile.createdById === actor.user.id)
  const [same] = await db.select().from(t.files).where(and(eq(t.files.kind, "compare"), eq(t.files.sha256, side.sha256))).limit(1)
  if (same) {
    if (ownUpload) {
      const removed = await db
        .delete(t.files)
        .where(and(eq(t.files.id, side.uploadFile!.id), eq(t.files.kind, "upload"), isNull(t.files.taskId), isNull(t.files.sessionId)))
        .returning({ storagePath: t.files.storagePath })
      for (const file of removed) await fileStorage().remove(file.storagePath).catch(() => undefined)
    }
    return same
  }
  if (side.uploadFile && ownUpload) {
    const [claimed] = await db
      .update(t.files)
      .set({ kind: "compare" })
      .where(and(eq(t.files.id, side.uploadFile.id), eq(t.files.kind, "upload"), isNull(t.files.taskId), isNull(t.files.sessionId)))
      .returning()
    if (claimed) return claimed
  }
  const name = side.name && side.name !== "image" ? side.name : `image${EXT[side.mime] ?? ""}`
  return saveFile(db, { data: side.data, name, mime: side.mime, kind: "compare", createdById: actor.user?.id ?? null })
}

/** 复用的 key：两张图的内容 + 要求 + 合格线 + 模型（+ 外部接口的 idempotency_key） */
export const dedupeKeyOf = (parts: { shaA: string; shaB: string; prompt: string; passScore: number; modelId: string; idempotencyKey?: string }) =>
  sha256Hex(Buffer.from(JSON.stringify([parts.shaA, parts.shaB, parts.prompt, parts.passScore, parts.modelId, parts.idempotencyKey ?? null])))

interface Requirement {
  prompt: string
  passScore: number
  modelId: string
  standardId: string | null
  standardName: string | null
}

/** 这次按什么要求比：指定的标准 / 自己写的要求 / 默认标准；换模型要是视觉模型 */
async function resolveRequirement(db: Db, input: Pick<CompareCreateInput, "standard" | "prompt" | "passScore" | "modelId">): Promise<Requirement> {
  let requirement: Requirement
  if (input.standard) {
    const standard = await findStandard(db, input.standard)
    if (!standard) {
      const names = (await listStandards(db)).map((each) => `${each.name}（${each.id}）`)
      throw new CompareError("bad_request", `没有比对标准「${input.standard}」${names.length ? `，现有的：${names.join("、")}` : ""}`)
    }
    requirement = { prompt: standard.prompt, passScore: standard.passScore, modelId: standard.modelId, standardId: standard.id, standardName: standard.name }
  } else {
    const fallback = await defaultStandard(db)
    if (input.prompt) {
      const modelId = input.modelId ?? fallback?.modelId ?? (await cheapestVisionModel(db))
      if (!modelId) throw new CompareError("unavailable", "还没有能看图的模型：先在「模型」页接好模型服务")
      requirement = { prompt: input.prompt, passScore: fallback?.passScore ?? FALLBACK_PASS_SCORE, modelId, standardId: null, standardName: null }
    } else {
      if (!fallback) throw new CompareError("unavailable", "还没有比对标准，也没有能看图的模型：先在「模型」页接好模型服务")
      requirement = { prompt: fallback.prompt, passScore: fallback.passScore, modelId: fallback.modelId, standardId: fallback.id, standardName: fallback.name }
    }
  }
  if (input.passScore !== undefined) requirement.passScore = input.passScore
  if (input.modelId) requirement.modelId = input.modelId
  const context = !input.modelId && requirement.standardName ? `标准「${requirement.standardName}」用的` : ""
  await assertVisionModel(db, requirement.modelId, context)
  return requirement
}

type NewComparison = Omit<typeof t.comparisons.$inferInsert, "id" | "status" | "title" | "via" | "createdById" | "sessionId" | "taskId" | "apiKeyId"> & { title?: string }

/**
 * 建记录 cmp-n（比对中），同一个事务里发 compare.run。reuse 时先在 advisory lock 里找能复用的：
 * 同样的 key、比对中或比完的；10 分钟以内，带 idempotency_key 的不限时间。没比成的不复用
 */
async function insertComparison(db: Db, actor: CompareActor, values: NewComparison, reuse: false | { idempotent: boolean }, options: ViewOptions) {
  const result = await db.transaction(async (tx) => {
    if (reuse) {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`compare:${values.dedupeKey}`}, 0))`)
      const [found] = await tx
        .select()
        .from(t.comparisons)
        .where(
          and(
            eq(t.comparisons.dedupeKey, values.dedupeKey),
            inArray(t.comparisons.status, ["running", "done"]),
            reuse.idempotent ? undefined : gt(t.comparisons.createdAt, new Date(Date.now() - COMPARE_REUSE_MINUTES * 60_000))
          )
        )
        .orderBy(desc(t.comparisons.createdAt))
        .limit(1)
      if (found) return { row: found, reused: true }
    }
    const id = comparisonId(await nextNo(tx, "compare_no_seq"))
    const title = (values.title || (values.standardName ? `${values.standardName} · ${values.labelB || values.fromB || "第二张"}` : `比图 ${id}`)).slice(0, 200)
    const [row] = await tx
      .insert(t.comparisons)
      .values({
        ...values,
        id,
        title,
        status: "running",
        via: actor.via,
        createdById: actor.user?.id ?? null,
        sessionId: actor.sessionId ?? null,
        taskId: actor.taskId ?? null,
        apiKeyId: actor.apiKeyId ?? null,
      })
      .returning()
    await sendInTx(db, tx, QUEUES.compareRun, { comparisonId: id }, compareRunJobOptions(id))
    await audit(tx, actor.user?.id ?? null, "compare.create", "comparisons", id, {
      via: actor.via,
      title,
      standardId: values.standardId,
      modelId: values.modelId,
      ...(actor.apiKeyId ? { apiKeyId: actor.apiKeyId } : {}),
      ...(actor.sessionId ? { sessionId: actor.sessionId } : {}),
    })
    return { row: row!, reused: false }
  })
  return { ...toComparison(result.row, options), reused: result.reused }
}

export interface CreateOptions extends ViewOptions {
  /** 外部接口的 idempotency_key：并进复用的 key，同一个 key（同样的图和要求）不管多久都返回同一条 */
  idempotencyKey?: string
}

/** 新比对（页面、HTTP、MCP、agent 共用）：立即返回「比对中」的记录（或者复用的那条，reused = true） */
export async function createComparison(db: Db, actor: CompareActor, input: CompareCreateRequest, options: CreateOptions = {}): Promise<Comparison> {
  if (actor.user && !can(actor.user, "compare.create", {})) throw new CompareError("forbidden", "你不能比图")
  if (input.standard && input.prompt) throw new CompareError("bad_request", "标准和自己写的要求只能给一个")
  const requirement = await resolveRequirement(db, input)
  const [a, b] = await Promise.all([resolveSide(db, actor, input.imageA), resolveSide(db, actor, input.imageB)])
  const dedupeKey = dedupeKeyOf({ shaA: a.sha256, shaB: b.sha256, prompt: requirement.prompt, passScore: requirement.passScore, modelId: requirement.modelId, idempotencyKey: options.idempotencyKey })
  const fileA = await storeSide(db, actor, a)
  const fileB = a.sha256 === b.sha256 ? fileA : await storeSide(db, actor, b)
  return insertComparison(
    db,
    actor,
    {
      ...requirement,
      title: input.title,
      fileAId: fileA.id,
      fileBId: fileB.id,
      labelA: (input.labelA || a.defaultLabel).slice(0, 100),
      labelB: (input.labelB || b.defaultLabel).slice(0, 100),
      fromA: a.from,
      fromB: b.from,
      dedupeKey,
    },
    { idempotent: Boolean(options.idempotencyKey) },
    options
  )
}

/** 再比一次：同样的两张图、要求、合格线、模型、标准、标题，新建一条（不复用）；发起方算这次调用的 */
export async function compareAgain(db: Db, actor: CompareActor, id: string, options: ViewOptions = {}): Promise<Comparison> {
  if (actor.user && !can(actor.user, "compare.create", {})) throw new CompareError("forbidden", "你不能比图")
  const row = await loadRow(db, id)
  await assertVisionModel(db, row.modelId, "这条比对用的")
  return insertComparison(
    db,
    actor,
    {
      title: row.title,
      fileAId: row.fileAId,
      fileBId: row.fileBId,
      labelA: row.labelA,
      labelB: row.labelB,
      fromA: row.fromA,
      fromB: row.fromB,
      standardId: row.standardId,
      standardName: row.standardName,
      prompt: row.prompt,
      passScore: row.passScore,
      modelId: row.modelId,
      dedupeKey: row.dedupeKey,
    },
    false,
    options
  )
}

// ---------- 删除 ----------

/** 删一条比对：发起的人和主管。两张图的文件没有别的比对、图库、附件再用就一起删（行和磁盘文件） */
export async function deleteComparison(db: Db, actor: CompareActor, id: string) {
  if (!actor.user) throw new CompareError("forbidden", "agent 不能删除比对记录")
  const row = await loadRow(db, id)
  if (!can(actor.user, "compare.manage", { createdById: row.createdById ?? "" })) throw new CompareError("forbidden", "只有发起的人和主管能删这条比对")
  await db.transaction(async (tx) => {
    await tx.delete(t.comparisons).where(eq(t.comparisons.id, id))
    await audit(tx, actor.user!.id, "compare.delete", "comparisons", id, { via: actor.via, title: row.title, score: row.score, modelId: row.modelId })
  })
  await removeUnusedFiles(db, [...new Set([row.fileAId, row.fileBId])])
  return { id }
}

async function removeUnusedFiles(db: Db, ids: string[]) {
  for (const id of ids) {
    try {
      const removed = await db
        .delete(t.files)
        .where(
          and(
            eq(t.files.id, id),
            eq(t.files.kind, "compare"),
            isNull(t.files.taskId),
            isNull(t.files.sessionId),
            notExists(db.select({ one: sql`1` }).from(t.comparisons).where(or(eq(t.comparisons.fileAId, id), eq(t.comparisons.fileBId, id)))),
            notExists(db.select({ one: sql`1` }).from(t.galleryImages).where(or(eq(t.galleryImages.fileId, id), eq(t.galleryImages.thumbFileId, id))))
          )
        )
        .returning({ storagePath: t.files.storagePath })
      for (const file of removed) await fileStorage().remove(file.storagePath).catch(() => undefined)
    } catch (error) {
      // 刚好有新比对用上了这张图（外键挡住）：留着
      console.warn(`[compare] 没删文件 ${id}：${(error as Error).message}`)
    }
  }
}

/** 比对里的一张图的内容（HTTP 接口 /api/compare/files/:id 用）：只给比对记录用到的文件 */
export async function comparisonFile(db: Db, fileId: string) {
  const [used] = await db
    .select({ id: t.comparisons.id })
    .from(t.comparisons)
    .where(or(eq(t.comparisons.fileAId, fileId), eq(t.comparisons.fileBId, fileId)))
    .limit(1)
  const row = used ? await getFileRow(db, fileId) : undefined
  if (!row) throw new CompareError("not_found", `比对记录里没有文件 ${fileId}`)
  const data = await readFileData(row).catch(() => {
    throw new CompareError("not_found", `文件 ${fileId} 的内容不见了`)
  })
  return { data, mime: row.mime, name: row.name }
}
