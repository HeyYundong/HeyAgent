// 比图的 MCP 服务（Streamable HTTP，无状态）：POST /api/compare/mcp，Authorization: Bearer <API 密钥>（登录的 cookie 也行）。
// 工具名、参数名、返回字段都照原来本机的 Lens MCP（蛇形），原来调 Lens 的地方换个地址就能用；另外加了 list_compare_standards。
import { createMcpHandler, McpServer, type CallToolResult } from "@modelcontextprotocol/server"
import { compareStatusSchema, galleryImageRefSchema, type Comparison } from "@heyagent/shared"
import { z } from "zod"

import type { Db } from "../db/client.js"
import { CompareError } from "./errors.js"
import {
  createComparison,
  getComparison,
  listComparisons,
  listStandards,
  listVisionModels,
  parseImageParam,
  waitForComparison,
  type CompareActor,
  type CompareCreateRequest,
} from "./service.js"

const SERVER_INFO = { name: "heyagent-compare", version: "1.0.0" }

const INSTRUCTIONS = [
  "HeyAgent 的比图：两张图交给视觉模型，按「比对标准」（或这次自己写的要求）逐项打分、写出差异，判断达没达到合格线。每次比对都存档。",
  "图片可以写网址（http/https）、data: 开头的 base64、图库里的图片 id（img-…）或 HeyAgent 的文件 id（f-…）。",
  "compare_images 等比完再返回（最多约 90 秒，还没比完返回 status = running，之后用 get_comparison 查）；submit_image_comparison 立即返回 id。",
  "score 是 0～100（证据不足时为 null），passed = score 到没到合格线。同样的两张图 + 同样的要求 + 同一个模型，10 分钟内重复比直接返回上次的结果（reused = true）。",
].join("\n")

/** 图片参数：Lens 的写法是一个字符串；也认 HeyAgent 的图片引用对象 */
const imageParam = z
  .union([z.string().trim().min(1), galleryImageRefSchema])
  .describe("图片：网址（http/https）、data:image/...;base64,...、图库 id（img-12）、文件 id（f-…）；也可以写 { url } { base64 } { imageId } { fileId }")

const compareInput = z.object({
  image_a: imageParam.describe("第一张（参照）"),
  image_b: imageParam.describe("第二张（要判断的）"),
  prompt: z.string().trim().max(4000).optional().describe("这次自己写的比对要求（和 standard 二选一；都不给用默认标准）"),
  standard: z.string().trim().max(100).optional().describe("比对标准的 id 或名字（list_compare_standards 看有哪些）"),
  model: z.string().optional().describe("换一个视觉模型（list_vision_models 看有哪些），不填用标准的模型"),
  title: z.string().trim().max(200).optional(),
  label_a: z.string().trim().max(100).optional().describe("第一张的说明，例如「原图」"),
  label_b: z.string().trim().max(100).optional().describe("第二张的说明"),
  pass_score: z.number().int().min(0).max(100).optional().describe("合格线 0～100，不填用标准的"),
  idempotency_key: z.string().trim().min(1).max(200).optional().describe("幂等键：同一个键、同样的图和要求，不管多久都返回同一条"),
})
type CompareMcpInput = z.infer<typeof compareInput>

function toRequest(input: CompareMcpInput): CompareCreateRequest {
  return {
    imageA: parseImageParam(input.image_a),
    imageB: parseImageParam(input.image_b),
    prompt: input.prompt || undefined,
    standard: input.standard || undefined,
    modelId: input.model || undefined,
    title: input.title || undefined,
    labelA: input.label_a || undefined,
    labelB: input.label_b || undefined,
    passScore: input.pass_score,
  }
}

/** 返回给 MCP 的一条比对（蛇形，和 Lens 一致）；url 是控制台里这条比对的链接 */
export function toMcpComparison(comparison: Comparison, baseUrl: string) {
  return {
    id: comparison.id,
    status: comparison.status,
    title: comparison.title,
    score: comparison.score,
    passed: comparison.passed,
    pass_score: comparison.passScore,
    confidence: comparison.confidence,
    verdict: comparison.verdict,
    reasons: comparison.reasons,
    dimensions: comparison.dimensions,
    differences: comparison.differences,
    error: comparison.error,
    standard: comparison.standardName,
    standard_id: comparison.standardId,
    model: comparison.modelId,
    cost_usd: comparison.costUsd,
    reused: comparison.reused ?? false,
    image_a: { url: comparison.imageA.url, label: comparison.imageA.label, from: comparison.imageA.from },
    image_b: { url: comparison.imageB.url, label: comparison.imageB.label, from: comparison.imageB.from },
    url: `${baseUrl}/#/compare?id=${comparison.id}`,
    created_at: comparison.createdAt,
    finished_at: comparison.finishedAt,
  }
}

function json(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }], structuredContent: value as Record<string, unknown> }
}

/** 工具里出错时回 isError，不抛给 MCP 框架 */
async function run(action: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await action()
  } catch (error) {
    const message = error instanceof CompareError ? error.message : `出错了：${(error as Error).message}`
    if (!(error instanceof CompareError)) console.error("[compare mcp]", error)
    return { isError: true, content: [{ type: "text", text: message }] }
  }
}

export function buildCompareMcpServer(db: Db, actor: CompareActor, baseUrl: string) {
  const server = new McpServer(SERVER_INFO, { instructions: INSTRUCTIONS })
  const view = { baseUrl }
  const out = (comparison: Comparison) => json(toMcpComparison(comparison, baseUrl))

  server.registerTool(
    "compare_images",
    {
      title: "比两张图",
      description:
        "两张图交给视觉模型，按比对标准（或 prompt 自己写的要求）逐项打分、写出差异。等比完再返回：score（0～100，证据不足为 null）、passed、confidence、verdict、reasons、dimensions、differences。90 秒还没比完返回 status = running，之后用 get_comparison 查。",
      inputSchema: compareInput,
    },
    (input) =>
      run(async () => {
        const created = await createComparison(db, actor, toRequest(input), { ...view, idempotencyKey: input.idempotency_key })
        if (created.status !== "running") return out(created)
        return out({ ...(await waitForComparison(db, created.id, view)), reused: created.reused })
      })
  )

  server.registerTool(
    "submit_image_comparison",
    {
      title: "提交比图（不等结果）",
      description: "和 compare_images 一样，但立即返回 id 和状态（running），之后用 get_comparison 查结果。",
      inputSchema: compareInput,
    },
    (input) => run(async () => out(await createComparison(db, actor, toRequest(input), { ...view, idempotencyKey: input.idempotency_key })))
  )

  server.registerTool(
    "get_comparison",
    {
      title: "看一条比对",
      description: "按 id（cmp-…）看比对的状态和结果。",
      inputSchema: z.object({ id: z.string().min(1) }),
      annotations: { readOnlyHint: true },
    },
    ({ id }) => run(async () => out(await getComparison(db, id, view)))
  )

  server.registerTool(
    "list_comparisons",
    {
      title: "比对记录",
      description: "比对记录，新的在前。query 搜标题、编号、要求、模型；status 是 running / done / failed；用 next_cursor 翻页。",
      inputSchema: z.object({
        query: z.string().trim().max(200).optional(),
        status: compareStatusSchema.optional(),
        limit: z.number().int().min(1).max(100).optional().describe("默认 20"),
        cursor: z.string().optional().describe("上一页返回的 next_cursor"),
      }),
      annotations: { readOnlyHint: true },
    },
    (input) =>
      run(async () => {
        const page = await listComparisons(db, { ...input, limit: input.limit ?? 20 }, view)
        return json({ items: page.items.map((each) => toMcpComparison(each, baseUrl)), next_cursor: page.nextCursor })
      })
  )

  server.registerTool(
    "list_vision_models",
    {
      title: "能比图的模型",
      description: "能看图的模型，便宜的在前；价格是每百万 token 的美元。",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () => run(async () => json({ models: (await listVisionModels(db)).map((model) => ({ id: model.id, name: model.name, price_in: model.priceIn, price_out: model.priceOut })) }))
  )

  server.registerTool(
    "list_compare_standards",
    {
      title: "比对标准",
      description: "比对标准：名字、打分要求、合格线、模型；is_default 的是不指定标准时用的。",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    () =>
      run(async () =>
        json({
          standards: (await listStandards(db)).map((each) => ({ id: each.id, name: each.name, prompt: each.prompt, pass_score: each.passScore, model: each.modelId, is_default: each.isDefault })),
        })
      )
  )

  return server
}

/** 处理一个 MCP 请求（无状态：每个请求现建服务，GET / DELETE 回 405） */
export function handleCompareMcp(db: Db, actor: CompareActor, baseUrl: string, request: Request) {
  const handler = createMcpHandler(() => buildCompareMcpServer(db, actor, baseUrl), {
    legacy: "stateless",
    onerror: (error) => console.warn(`[compare mcp] ${error.message}`),
  })
  return handler.fetch(request)
}
