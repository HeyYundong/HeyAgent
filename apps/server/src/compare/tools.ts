// 「比物」内置工具组（任务里选了「比物」时，工具网关展开成下面几个）：比两张图（等结果）、看一条比对、比对记录、比对标准。agent 不能删比对。
// 图片用网址、图库 id、这次运行的文件（截图、附件、产物）指定；agent 只能用这次运行看得到的文件。参数名照 MCP（Lens 的写法）。
import { compareConfidenceLabel, compareStatusSchema, type Comparison, type SessionSnapshot, type SnapshotTool } from "@heyagent/shared"
import { z } from "zod"

import type { Db } from "../db/client.js"
import type { SessionRow, ToolOutcome } from "../engine/tools/builtin.js"
import { getFileRow } from "../files/service.js"
import { CompareError } from "./errors.js"
import { createComparison, getComparison, listComparisons, listStandards, parseImageParam, waitForComparison, type CompareActor } from "./service.js"

interface Ctx {
  db: Db
  session: SessionRow
  snapshot: SessionSnapshot
}

export interface CompareToolEntry {
  id: string
  def: SnapshotTool
  jsonSchema: Record<string, unknown>
  validator: z.ZodType
  execute: (input: unknown) => Promise<ToolOutcome>
}

const imageParam = z
  .union([
    z.string().trim().min(1),
    z.object({ imageId: z.string().min(1).describe("图库里已有图片的 id，例如 img-12") }),
    z.object({ fileId: z.string().min(1).describe("这次运行的文件 id（附件、截图、产物），例如 f-…") }),
    z.object({ url: z.string().regex(/^https?:\/\/\S+$/, "url 要以 http:// 或 https:// 开头").describe("图片网址") }),
  ])
  .describe("图片：网址、图库 id（img-…）、这次运行的文件 id（f-…，截图、附件、产物）；也可以写 { url } { imageId } { fileId }")

const compareInput = z.object({
  image_a: imageParam.describe("第一张（参照）"),
  image_b: imageParam.describe("第二张（要判断的）"),
  standard: z.string().trim().max(100).optional().describe("比对标准的 id 或名字（compare_standards 看有哪些）；和 prompt 都不给用默认标准"),
  prompt: z.string().trim().max(4000).optional().describe("这次自己写的比对要求：什么算像、看哪些方面、哪些差异不算（和 standard 二选一）"),
  pass_score: z.number().int().min(0).max(100).optional().describe("合格线 0～100，不填用标准的"),
  label_a: z.string().trim().max(100).optional().describe("第一张的说明"),
  label_b: z.string().trim().max(100).optional().describe("第二张的说明"),
  title: z.string().trim().max(200).optional(),
})

const getInput = z.object({ id: z.string().min(1).describe("比对 id，例如 cmp-12") })

const listInput = z.object({
  query: z.string().trim().max(200).optional().describe("搜标题、编号、要求、模型"),
  status: compareStatusSchema.optional(),
  all: z.boolean().optional().describe("true = 所有人的比对；默认只列这次运行发起的"),
  limit: z.number().int().min(1).max(50).optional().describe("默认 10"),
})

function schemaOf(schema: z.ZodType): Record<string, unknown> {
  const json = z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>
  delete json.$schema
  return json
}

/** 给模型看的一条：分数、达标、把握度、结论、理由、差异，不带图和地址，省 token */
export function briefComparison(comparison: Comparison) {
  const base = { id: comparison.id, title: comparison.title, status: comparison.status }
  if (comparison.status === "running") return { ...base, note: "还在比，过一会儿用 compare_get 查" }
  if (comparison.status === "failed") return { ...base, error: comparison.error }
  return {
    ...base,
    score: comparison.score,
    passed: comparison.passed,
    passScore: comparison.passScore,
    confidence: comparison.confidence ? compareConfidenceLabel[comparison.confidence] : null,
    verdict: comparison.verdict,
    reasons: comparison.reasons,
    differences: comparison.differences,
    ...(comparison.standardName ? { standard: comparison.standardName } : {}),
    ...(comparison.reused ? { reused: true } : {}),
  }
}

const ok = (value: unknown): ToolOutcome => ({ output: JSON.stringify(value, null, 1) })

async function run(action: () => Promise<ToolOutcome>): Promise<ToolOutcome> {
  try {
    return await action()
  } catch (error) {
    if (error instanceof CompareError) return { output: error.message, isError: true }
    throw error
  }
}

export function compareToolEntries(ctx: Ctx): CompareToolEntry[] {
  const actor: CompareActor = {
    user: null,
    via: "agent",
    sessionId: ctx.session.id,
    taskId: ctx.session.taskId,
    canReadFile: async (fileId) => {
      const row = await getFileRow(ctx.db, fileId)
      return Boolean(row && (row.sessionId === ctx.session.id || ctx.snapshot.attachments.some((file) => file.id === row.id)))
    },
  }
  const def = (id: string, name: string, summary: string, description: string, risk: SnapshotTool["risk"]): SnapshotTool => ({ id, name, summary, description, source: "builtin", risk })
  const { db } = ctx

  return [
    {
      id: "compare.images",
      def: def(
        "compare.images",
        "比物：比两张图",
        "两张图交给视觉模型，按比对标准逐项打分、写出差异，判断达没达到合格线",
        "等比完再返回（一般十几秒，最多约 90 秒）：score 0～100（证据不足为 null）、passed（到没到合格线）、confidence、verdict（一句话结论）、reasons、differences。还没比完返回 status = running，之后用 compare_get 查。同样的两张图和要求 10 分钟内重复比直接返回上次的结果。",
        "write"
      ),
      jsonSchema: schemaOf(compareInput),
      validator: compareInput,
      execute: (input) =>
        run(async () => {
          const value = input as z.output<typeof compareInput>
          const created = await createComparison(db, actor, {
            imageA: parseImageParam(value.image_a),
            imageB: parseImageParam(value.image_b),
            standard: value.standard || undefined,
            prompt: value.prompt || undefined,
            passScore: value.pass_score,
            labelA: value.label_a || undefined,
            labelB: value.label_b || undefined,
            title: value.title || undefined,
          })
          const done = created.status === "running" ? { ...(await waitForComparison(db, created.id)), reused: created.reused } : created
          return ok(briefComparison(done))
        }),
    },
    {
      id: "compare.get",
      def: def("compare.get", "比物：看一条比对", "按 id 看一条比对的状态和结果", "id 是 cmp-…。", "read"),
      jsonSchema: schemaOf(getInput),
      validator: getInput,
      execute: (input) => run(async () => ok(briefComparison(await getComparison(db, (input as z.output<typeof getInput>).id)))),
    },
    {
      id: "compare.list",
      def: def("compare.list", "比物：比对记录", "列出比对记录，默认只列这次运行发起的", "新的在前；all = true 列所有人的；query 搜标题、编号、要求、模型。", "read"),
      jsonSchema: schemaOf(listInput),
      validator: listInput,
      execute: (input) =>
        run(async () => {
          const value = input as z.output<typeof listInput>
          const page = await listComparisons(db, { query: value.query, status: value.status, sessionId: value.all ? undefined : ctx.session.id, limit: value.limit ?? 10 })
          return ok({ results: page.items.map(briefComparison), ...(page.nextCursor ? { more: true } : {}) })
        }),
    },
    {
      id: "compare.standards",
      def: def("compare.standards", "比物：比对标准", "有哪些比对标准：名字、打分要求、合格线", "标准由主管维护；不指定标准时用 isDefault 的那个。", "read"),
      jsonSchema: schemaOf(z.object({})),
      validator: z.object({}),
      execute: () => run(async () => ok({ standards: (await listStandards(db)).map((each) => ({ id: each.id, name: each.name, isDefault: each.isDefault, passScore: each.passScore, prompt: each.prompt })) })),
    },
  ]
}
