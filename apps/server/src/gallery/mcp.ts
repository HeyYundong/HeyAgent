// 图库的 MCP 服务（Streamable HTTP，无状态）：POST /api/gallery/mcp，Authorization: Bearer <API 密钥>（登录的 cookie 也行）。
// 每个请求现建一个 McpServer，工具里的「谁在做」就是这次请求认出来的人。工具和 HTTP 接口一一对应，输入用同一套 shared schema。
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server"
import {
  galleryCompareSchema,
  gallerySearchSchema,
  galleryUpdateSchema,
  galleryUploadSchema,
} from "@heyagent/shared"
import { z } from "zod"

import type { Db } from "../db/client.js"
import { GalleryError } from "./errors.js"
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
  type GalleryActor,
} from "./service.js"

const SERVER_INFO = { name: "heyagent-gallery", version: "1.0.0" }

const INSTRUCTIONS = [
  "HeyAgent 的图库：每张图有文本（JSON 对象）和标签（字符串数组）。",
  "图片可以用 { imageId }（图库里已有的）、{ url }、{ base64, mime } 或 { fileId }（HeyAgent 的文件）指定。",
  "gallery_search：传 image 以图搜图、传 query 用一句描述找图，可以再加标签、JSON 条件筛选；都不传就按上传时间倒序列出。",
  "gallery_compare：比两张图有多像（余弦相似度 -1～1），same 表示到没到阈值（算不算同一张 / 同款）。",
].join("\n")

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> }
}

/** 工具里出错时回 isError，不抛给 MCP 框架（框架会变成协议错误，客户端不好看） */
async function run(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action()
  } catch (error) {
    const message = error instanceof GalleryError ? error.message : `出错了：${(error as Error).message}`
    if (!(error instanceof GalleryError)) console.error("[gallery mcp]", error)
    return { isError: true, content: [{ type: "text", text: message }] }
  }
}

export function buildGalleryMcpServer(db: Db, actor: GalleryActor, baseUrl: string) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS })
  const view = { baseUrl }

  server.registerTool(
    "gallery_upload",
    {
      title: "往图库传图",
      description: "传一张图，带上文本（JSON 对象）和标签（字符串数组）。一模一样的文件已经在图库里时返回已有的那条（duplicate = true），不改它的文本和标签。",
      inputSchema: galleryUploadSchema,
    },
    (input) =>
      run(async () => {
        const image = await resolveUpload(db, input.image, actor)
        return json(await uploadImage(db, actor, { image, text: input.text, tags: input.tags }, view))
      })
  )

  server.registerTool(
    "gallery_search",
    {
      title: "检索图库",
      description:
        "检索：image = 以图搜图；query = 用一句描述找图（两个只能传一个，结果带相似度 score）；tags = 这些标签都要有，anyTags = 有一个就行；text = JSON 包含匹配；where = 按字段加条件（op：eq ne gt gte lt lte contains exists）；keyword = 在 JSON 的值里找。都不传就按上传时间倒序，用 nextCursor 翻页。",
      inputSchema: gallerySearchSchema,
      annotations: { readOnlyHint: true },
    },
    (input) =>
      run(async () => {
        const { image, ...rest } = input
        return json(await searchImages(db, { ...rest, image: image ? await resolveSide(db, image, actor) : undefined }, view))
      })
  )

  server.registerTool(
    "gallery_compare",
    {
      title: "比对两张图",
      description: "比两张图有多像：score 是余弦相似度（-1～1，越大越像），same = score 到没到 threshold（不填用系统默认，算不算同一张 / 同款）。",
      inputSchema: galleryCompareSchema,
      annotations: { readOnlyHint: true },
    },
    (input) =>
      run(async () => {
        const [a, b] = await Promise.all([resolveSide(db, input.a, actor), resolveSide(db, input.b, actor)])
        return json(await compareImages(db, a, b, input.threshold))
      })
  )

  server.registerTool(
    "gallery_get",
    {
      title: "看一张图",
      description: "按 id 看一张图的文本、标签和地址；withImage = true 时把缩略图一起发回来。",
      inputSchema: z.object({ id: z.string().min(1), withImage: z.boolean().optional() }),
      annotations: { readOnlyHint: true },
    },
    ({ id, withImage }) =>
      run(async () => {
        const result = json(await getImage(db, id, view))
        if (withImage) {
          const thumb = await imageFile(db, id, "thumb")
          result.content.push({ type: "image", data: thumb.data.toString("base64"), mimeType: thumb.mime })
        }
        return result
      })
  )

  server.registerTool(
    "gallery_update",
    {
      title: "改文本和标签",
      description: "text、tags 是整体替换；addTags、removeTags 是在现有标签上加减。只有上传的人和主管能改。",
      inputSchema: galleryUpdateSchema,
    },
    (input) => run(async () => json(await updateImage(db, actor, input, view)))
  )

  server.registerTool(
    "gallery_delete",
    {
      title: "删除一张图",
      description: "删除图和它的文件，不能撤销。只有上传的人和主管能删。",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { destructiveHint: true },
    },
    ({ id }) => run(async () => json(await deleteImage(db, actor, id)))
  )

  server.registerTool(
    "gallery_tags",
    {
      title: "常用标签",
      description: "图库里用得最多的标签和各自的图数，以及图库的总数、当前的 embedding 模型。",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => run(async () => json({ tags: await galleryTags(db), stats: await galleryStats(db) }))
  )

  return server
}

/** 处理一个 MCP 请求（无状态：每个请求现建服务，GET / DELETE 回 405） */
export function handleGalleryMcp(db: Db, actor: GalleryActor, baseUrl: string, request: Request) {
  const handler = createMcpHandler(() => buildGalleryMcpServer(db, actor, baseUrl), {
    legacy: "stateless",
    onerror: (error) => console.warn(`[gallery mcp] ${error.message}`),
  })
  return handler.fetch(request)
}
