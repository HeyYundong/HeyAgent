// 「图库」内置工具组（任务里选了「图库」时，工具网关展开成下面几个）：检索、比对、看一张、传图、改文本和标签。agent 不能删图。
// 图片用 imageId（图库里已有的）、fileId（这次运行的附件、截图、产物）或 url 指定；agent 只能用这次运行看得到的文件。
import {
  galleryFilterSchema,
  galleryTagsSchema,
  galleryTextSchema,
  galleryUpdateSchema,
  type GalleryImage,
  type SessionSnapshot,
  type SnapshotTool,
} from "@heyagent/shared"
import { z } from "zod"

import type { Db } from "../db/client.js"
import type { SessionRow, ToolOutcome } from "../engine/tools/builtin.js"
import { getFileRow } from "../files/service.js"
import { GalleryError } from "./errors.js"
import { compareImages, getImage, imageFile, resolveSide, resolveUpload, searchImages, updateImage, uploadImage, type GalleryActor } from "./service.js"

interface Ctx {
  db: Db
  session: SessionRow
  snapshot: SessionSnapshot
}

export interface GalleryToolEntry {
  id: string
  def: SnapshotTool
  jsonSchema: Record<string, unknown>
  validator: z.ZodType
  execute: (input: unknown) => Promise<ToolOutcome>
}

const agentImageRef = z.union([
  z.object({ imageId: z.string().min(1).describe("图库里已有图片的 id，例如 img-12") }),
  z.object({ fileId: z.string().min(1).describe("这次运行的文件 id（附件、截图、产物），例如 f-…") }),
  z.object({ url: z.string().regex(/^https?:\/\/\S+$/, "url 要以 http:// 或 https:// 开头").describe("图片网址") }),
])

const searchInput = galleryFilterSchema.extend({
  image: agentImageRef.optional().describe("以图搜图：给一张图，找图库里像它的"),
  query: z.string().trim().min(1).max(2000).optional().describe("用一句描述找图，例如「红色的折叠收纳筐」（和 image 只能给一个）"),
  minScore: z.number().min(-1).max(1).optional().describe("只要相似度不低于这个值的（-1～1）"),
  limit: z.number().int().min(1).max(50).optional().describe("最多返回几张，默认 10"),
  cursor: z.string().optional().describe("没给 image / query 时按上传时间倒序翻页：上一页返回的 nextCursor"),
})

const compareInput = z.object({
  a: agentImageRef,
  b: agentImageRef,
  threshold: z.number().min(-1).max(1).optional().describe("相似度到多少算同一张 / 同款，不填用系统默认"),
})

const addInput = z.object({
  image: z.union([agentImageRef.options[1], agentImageRef.options[2]]).describe("要传的图：这次运行的文件（fileId）或网址（url）"),
  text: galleryTextSchema.optional().describe("这张图的说明，必须是 JSON 对象"),
  tags: galleryTagsSchema.optional().describe("标签，字符串数组"),
})

const getInput = z.object({
  id: z.string().min(1),
  showImage: z.boolean().optional().describe("true = 把缩略图发给你看"),
})

function schemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>
  delete json.$schema
  return json
}

/** 给模型看的一条：去掉地址和 sha256 这些它用不上的，省 token */
const brief = (image: GalleryImage) => ({
  id: image.id,
  ...(image.score === undefined ? {} : { score: image.score }),
  name: image.name,
  size: `${image.width}×${image.height}`,
  tags: image.tags,
  text: image.text,
})

const ok = (value: unknown): ToolOutcome => ({ output: JSON.stringify(value, null, 1) })

async function run(action: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof GalleryError) return { output: error.message, isError: true }
    throw error
  }
}

export function galleryToolEntries(ctx: Ctx): GalleryToolEntry[] {
  const actor: GalleryActor = {
    user: null,
    via: "agent",
    sessionId: ctx.session.id,
    canReadFile: async (fileId) => {
      const row = await getFileRow(ctx.db, fileId)
      return Boolean(row && (row.sessionId === ctx.session.id || ctx.snapshot.attachments.some((file) => file.id === row.id)))
    },
  }
  const def = (id: string, name: string, summary: string, description: string, risk: SnapshotTool["risk"]): SnapshotTool => ({ id, name, summary, description, source: "builtin", risk })
  const { db } = ctx

  return [
    {
      id: "gallery.search",
      def: def(
        "gallery.search",
        "图库：检索",
        "在图库里找图：以图搜图、按描述找、按标签和 JSON 字段筛",
        "image = 以图搜图，query = 用一句描述找图（二选一，结果按相似度 score 排，-1～1）；tags = 这些标签都要有，anyTags = 有一个就行；text = JSON 包含匹配（值要完全相等）；where = 按字段加条件，op 是 eq ne gt gte lt lte contains exists；keyword = 在 JSON 的值里找。都不给就按上传时间倒序列出。",
        "read"
      ),
      jsonSchema: schemaOf(searchInput),
      validator: searchInput,
      execute: (input) =>
        run(async () => {
          const { image, ...rest } = input as z.output<typeof searchInput>
          const page = await searchImages(db, { ...rest, limit: rest.limit ?? 10, image: image ? await resolveSide(db, image, actor) : undefined })
          return ok({ ...(page.model ? { model: page.model } : {}), results: page.items.map(brief), ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) })
        }),
    },
    {
      id: "gallery.compare",
      def: def("gallery.compare", "图库：比对", "比两张图有多像，判断是不是同一张 / 同款", "score 是余弦相似度（-1～1，越大越像），same 表示到没到阈值（算不算同一张 / 同款）。", "read"),
      jsonSchema: schemaOf(compareInput),
      validator: compareInput,
      execute: (input) =>
        run(async () => {
          const { a, b, threshold } = input as z.output<typeof compareInput>
          const [sideA, sideB] = await Promise.all([resolveSide(db, a, actor), resolveSide(db, b, actor)])
          return ok(await compareImages(db, sideA, sideB, threshold))
        }),
    },
    {
      id: "gallery.get",
      def: def("gallery.get", "图库：看一张", "按 id 看一张图的文本和标签，可以把缩略图发给你看", "showImage = true 时缩略图（长边 512）作为图片发给你。", "read"),
      jsonSchema: schemaOf(getInput),
      validator: getInput,
      execute: (input) =>
        run(async () => {
          const { id, showImage } = input as z.output<typeof getInput>
          const image = await getImage(db, id)
          if (!showImage) return ok(brief(image))
          const thumb = await imageFile(db, id, "thumb")
          return { output: `${JSON.stringify(brief(image), null, 1)}\n缩略图已作为下一条消息发给你。`, images: [{ name: `${id}.webp`, mime: thumb.mime, base64: thumb.data.toString("base64") }] }
        }),
    },
    {
      id: "gallery.add",
      def: def(
        "gallery.add",
        "图库：传图",
        "把一张图存进图库，带上文本（JSON 对象）和标签",
        "图片用这次运行的文件（fileId，例如截图）或网址（url）。一模一样的图已经在图库里时返回已有的那条（duplicate = true），不改它的文本和标签，需要的话再用「图库：改文本和标签」。",
        "write"
      ),
      jsonSchema: schemaOf(addInput),
      validator: addInput,
      execute: (input) =>
        run(async () => {
          const { image, text, tags } = input as z.output<typeof addInput>
          const loaded = await resolveUpload(db, image, actor)
          const result = await uploadImage(db, actor, { image: loaded, text, tags })
          return ok({ duplicate: result.duplicate, image: brief(result.image), embedded: result.image.embedded })
        }),
    },
    {
      id: "gallery.update",
      def: def("gallery.update", "图库：改文本和标签", "改图库里一张图的文本（JSON 对象）和标签", "text、tags 是整体替换；addTags、removeTags 是在现有标签上加减。", "write"),
      jsonSchema: schemaOf(galleryUpdateSchema),
      validator: galleryUpdateSchema,
      execute: (input) => run(async () => ok(brief(await updateImage(db, actor, input as z.output<typeof galleryUpdateSchema>)))),
    },
  ]
}
