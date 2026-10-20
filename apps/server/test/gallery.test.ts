// 图库：模型页的 embedding 模型、传图、检索（标签 / JSON / 以图搜图 / 按描述）、比对、权限、API 密钥、MCP、换模型后重算、agent 的工具。
// 不调真模型：假 embedding 把图缩成 32×32 灰度当向量（同一张图缩放后很像，不同的图不像），文字按内容算一个固定的随机向量。
import { createHash } from "node:crypto"

import { asc, eq, inArray } from "drizzle-orm"
import sharp from "sharp"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import type { SessionSnapshot } from "@heyagent/shared"

import { parseOpenRouterEmbeddingModels } from "../src/data/config/models.js"
import * as t from "../src/db/schema.js"
import { configureEngine, runtime } from "../src/engine/runtime.js"
import type { SessionRow } from "../src/engine/tools/builtin.js"
import { saveFile } from "../src/files/service.js"
import { embedPendingOnce } from "../src/gallery/background.js"
import type { EmbedInput } from "../src/gallery/embed.js"
import { galleryToolEntries } from "../src/gallery/tools.js"
import { login, mutate, query, setupApp, TEST_REVIEW_MODEL, type TestApp } from "./helpers.js"

let ctx: TestApp
let lin: string // 主管
let wang: string // 员工
let li: string // 另一个员工
const savedFactory = runtime.embedFactory

const EMBED = "openrouter/acme/embed-vision"
const EMBED_2 = "openrouter/acme/embed-vision-2"
const EMBED_TEXT = "openrouter/acme/embed-text"

const normalize = (vector: number[]) => {
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0)) || 1
  return vector.map((x) => x / norm)
}

function textVector(text: string) {
  const out: number[] = []
  for (let i = 0; out.length < 1024; i++) {
    for (const byte of createHash("sha256").update(`${text}#${i}`).digest()) out.push(byte / 255 - 0.5)
  }
  return normalize(out.slice(0, 1024))
}

let embedCalls = 0
let embedBroken = false
async function fakeEmbed({ inputs }: { modelId: string; inputs: EmbedInput[] }) {
  embedCalls += 1
  if (embedBroken) throw new Error("模型挂了")
  return Promise.all(
    inputs.map(async (input) => {
      if ("text" in input) return textVector(input.text)
      const raw = await sharp(input.image).resize(32, 32, { fit: "fill" }).greyscale().raw().toBuffer()
      return normalize(Array.from(raw, (x) => x / 255 - 0.5))
    })
  )
}

/** 测试用的图：SVG 画出来，几种明显不同的图案 */
const svg = (body: string, w = 400, h = 300) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">${body}</svg>`)
const png = (body: string, w?: number, h?: number) => sharp(svg(body, w, h)).png().toBuffer()
let imgA: Buffer
let imgB: Buffer
let imgC: Buffer
let imgD: Buffer

async function upload(cookie: string | undefined, image: Buffer, fields: Record<string, string> = {}, headers: Record<string, string> = {}) {
  const form = new FormData()
  form.append("image", new File([new Uint8Array(image)], "photo.png", { type: "image/png" }))
  for (const [key, value] of Object.entries(fields)) form.append(key, value)
  const res = await ctx.app.request("/api/gallery/images", { method: "POST", body: form, headers: { ...(cookie ? { cookie } : {}), ...headers } })
  return { status: res.status, body: (await res.json()) as any }
}

async function post(path: string, cookie: string | undefined, body: unknown, headers: Record<string, string> = {}) {
  const res = await ctx.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}), ...headers }, body: JSON.stringify(body) })
  return { status: res.status, body: (await res.json()) as any }
}

const search = (body: unknown, cookie = wang) => post("/api/gallery/search", cookie, body)
const ids = (result: { body: { items: { id: string }[] } }) => result.body.items.map((item) => item.id)

beforeAll(async () => {
  ctx = await setupApp()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  li = await login(ctx.app, "lijing@heyagent.local")
  configureEngine({ embedFactory: fakeEmbed })
  await ctx.db.insert(t.models).values([
    { id: EMBED, providerId: "openrouter", name: "Embed Vision", note: "", contextK: 8, priceIn: 0.2, priceOut: 0, vision: true, kind: "embedding" },
    { id: EMBED_2, providerId: "openrouter", name: "Embed Vision 2", note: "", contextK: 8, priceIn: 0.1, priceOut: 0, vision: true, kind: "embedding" },
    { id: EMBED_TEXT, providerId: "openrouter", name: "Embed Text", note: "", contextK: 8, priceIn: 0.02, priceOut: 0, vision: false, kind: "embedding" },
  ])
  imgA = await png(`<rect width="400" height="300" fill="#fff"/><circle cx="120" cy="150" r="90" fill="#c00"/><rect x="250" y="40" width="120" height="220" fill="#222"/>`)
  imgB = await png(`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000"/><stop offset="1" stop-color="#fff"/></linearGradient></defs><rect width="400" height="300" fill="url(#g)"/>`)
  imgC = await png(`<rect width="400" height="300" fill="#000"/>${Array.from({ length: 8 }, (_, i) => `<rect x="${i * 50}" y="0" width="25" height="300" fill="#fff"/>`).join("")}`)
  imgD = await png(`<rect width="400" height="300" fill="#888"/><polygon points="200,20 380,280 20,280" fill="#fff"/>`)
})
afterAll(async () => {
  configureEngine({ embedFactory: savedFactory })
  await ctx?.close()
})

describe("模型：embedding 模型和图库的默认模型", () => {
  it("OpenRouter 的 embedding 目录：能不能处理图片记在 vision，价格只有输入", () => {
    const parsed = parseOpenRouterEmbeddingModels({
      data: [
        { id: "google/gemini-embedding-2", name: "Google: Gemini Embedding 2", context_length: 8192, pricing: { prompt: "0.0000002" }, architecture: { input_modalities: ["text", "image"] } },
        { id: "x/text-only", context_length: 512, pricing: { prompt: "0.00000001" }, architecture: { input_modalities: ["text"] } },
      ],
    })
    expect(parsed).toEqual([
      expect.objectContaining({ name: "google/gemini-embedding-2", displayName: "Gemini Embedding 2", priceIn: 0.2, priceOut: 0, vision: true, kind: "embedding", contextK: 8 }),
      expect.objectContaining({ name: "x/text-only", vision: false, kind: "embedding", contextK: 1 }),
    ])
  })

  it("模型页：embedding 模型单独列出来，不混进聊天模型（任务的模型下拉里看不到）", async () => {
    const { data } = await query(ctx.app, "models.overview", wang)
    const openrouter = data.providers.find((provider: { id: string }) => provider.id === "openrouter")
    expect(openrouter.embeddingModels.map((model: { id: string }) => model.id)).toEqual(expect.arrayContaining([EMBED, EMBED_2, EMBED_TEXT]))
    expect(openrouter.models.some((model: { id: string }) => model.id === EMBED)).toBe(false)
    expect(data.defaults.embed).toBeUndefined()
  })

  it("还没设 embedding 模型：传图照样能传，以图搜图说清楚去哪设", async () => {
    const { status, body } = await upload(wang, imgD, { tags: '["临时"]' })
    expect(status).toBe(201)
    expect(body.image.embedded).toBe(false)
    const res = await search({ image: { imageId: body.image.id } })
    expect(res.status).toBe(503)
    expect(res.body.error).toContain("「模型」页")
    expect((await query(ctx.app, "gallery.embedding", wang, { id: body.image.id })).data).toBeNull()
    await ctx.app.request(`/api/gallery/images/${body.image.id}`, { method: "DELETE", headers: { cookie: wang } })
  })

  it("设默认 embedding 模型：要是能处理图片的 embedding 模型；聊天模型不能当 embedding，embedding 模型也不能拿去执行", async () => {
    const { data } = await query(ctx.app, "models.overview", lin)
    const base = { run: data.defaults.run, plan: data.defaults.plan, verify: data.defaults.verify }
    expect((await mutate(ctx.app, "models.setDefaults", lin, { ...base, embed: EMBED_TEXT })).error?.message).toContain("不是能处理图片的 embedding 模型")
    expect((await mutate(ctx.app, "models.setDefaults", lin, { ...base, embed: base.run })).error?.message).toContain("不是能处理图片的 embedding 模型")
    expect((await mutate(ctx.app, "models.setDefaults", lin, { ...base, run: EMBED })).error?.message).toContain("是 embedding 模型")
    expect((await mutate(ctx.app, "models.setDefaults", wang, { ...base, embed: EMBED })).error?.data?.code).toBe("FORBIDDEN")
    const saved = await mutate(ctx.app, "models.setDefaults", lin, { ...base, embed: EMBED })
    expect(saved.data).toEqual({ ...base, embed: EMBED, review: TEST_REVIEW_MODEL })
    expect((await query(ctx.app, "models.overview", lin)).data.defaults.embed).toBe(EMBED)
    // 不传 embed = 不改
    expect((await mutate(ctx.app, "models.setDefaults", lin, base)).data.embed).toBe(EMBED)
  })

  it("建任务不能选 embedding 模型", async () => {
    const res = await mutate(ctx.app, "tasks.create", lin, { title: "x", goal: "y", steps: [], schedule: null, memoryIds: [], skillIds: [], toolIds: [], ruleIds: [], modelId: EMBED, reviewModelId: TEST_REVIEW_MODEL })
    expect(res.error?.message).toContain("是 embedding 模型")
  })
})

describe("传图：图片 + 文本（JSON 对象）+ 标签（字符串数组）", () => {
  let idA: string

  it("没登录、密钥不对：401", async () => {
    expect((await upload(undefined, imgA)).status).toBe(401)
    expect((await upload(undefined, imgA, {}, { authorization: "Bearer hk_wrong" })).status).toBe(401)
  })

  it("multipart 传图：标签去空格去重，文本原样存，算好向量，缩略图和原图都能下载", async () => {
    const { status, body } = await upload(wang, imgA, {
      text: JSON.stringify({ 名称: "保温杯", 价格: 25, 规格: { 颜色: "红" }, 材质: ["不锈钢", "硅胶"] }),
      tags: JSON.stringify([" 红色 ", "杯子", "红色"]),
    })
    expect(status).toBe(201)
    expect(body.duplicate).toBe(false)
    expect(body.image).toMatchObject({ tags: ["红色", "杯子"], text: { 名称: "保温杯", 价格: 25 }, mime: "image/png", width: 400, height: 300, via: "web", embedded: true, name: "photo.png" })
    expect(body.image.id).toMatch(/^img-\d+$/)
    expect(body.image.url).toBe(`http://localhost/api/gallery/images/${body.image.id}/file`)
    idA = body.image.id
    const thumb = await ctx.app.request(`/api/gallery/images/${idA}/thumb`, { headers: { cookie: li } })
    expect(thumb.status).toBe(200)
    expect(thumb.headers.get("content-type")).toBe("image/webp")
    const meta = await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()
    expect(Math.max(meta.width!, meta.height!)).toBe(400)
    const file = await ctx.app.request(`/api/gallery/images/${idA}/file`, { headers: { cookie: li } })
    expect(Buffer.from(await file.arrayBuffer()).equals(imgA)).toBe(true)
  })

  it("抽屉里的向量（tRPC gallery.embedding）：当前模型算的整个数组；没有这张图 404", async () => {
    const { data } = await query(ctx.app, "gallery.embedding", li, { id: idA })
    expect(data.model.id).toBe(EMBED)
    expect(data.vector).toHaveLength(1024)
    expect((await query(ctx.app, "gallery.embedding", li, { id: "img-999999" })).error?.data?.code).toBe("NOT_FOUND")
  })

  it("一模一样的文件再传：返回已有的那条（200，duplicate），不改它的文本和标签", async () => {
    const { status, body } = await upload(li, imgA, { text: '{"名称":"别的"}', tags: '["别的"]' })
    expect(status).toBe(200)
    expect(body).toMatchObject({ duplicate: true, image: { id: idA, tags: ["红色", "杯子"], text: { 名称: "保温杯" } } })
  })

  it("文本必须是 JSON 对象、标签必须是字符串数组、得是图片", async () => {
    const cases: [Record<string, string>, string][] = [
      [{ text: "[1,2]" }, "text 必须是 JSON 对象"],
      [{ text: '"一句话"' }, "text 必须是 JSON 对象"],
      [{ text: "不是 JSON" }, "text 不是合法的 JSON"],
      [{ tags: '"红色"' }, "tags 必须是字符串数组"],
      [{ tags: '{"a":1}' }, "tags 必须是字符串数组"],
      [{ tags: "[1]" }, "标签必须是字符串"],
      [{ tags: '[""]' }, "标签不能是空的"],
    ]
    for (const [fields, message] of cases) {
      const { status, body } = await upload(wang, imgB, fields)
      expect(status, JSON.stringify(fields)).toBe(400)
      expect(body.error).toContain(message)
    }
    const notImage = await upload(wang, Buffer.from("hello, not an image"))
    expect(notImage.status).toBe(400)
    expect(notImage.body.error).toContain("认不出这张图片")
  })

  it("JSON 方式传图（base64，可以带 data: 前缀）", async () => {
    const res = await post("/api/gallery/images", wang, { image: { base64: `data:image/png;base64,${imgB.toString("base64")}` }, text: { 名称: "玻璃杯", 价格: 9.9, 日期: "2026-10-01" }, tags: ["蓝色", "杯子"] })
    expect(res.status).toBe(201)
    expect(res.body.image).toMatchObject({ tags: ["蓝色", "杯子"], embedded: true })
    expect((await post("/api/gallery/images", wang, { image: { imageId: idA } })).body.error).toContain("上传要给新图片")
    expect((await post("/api/gallery/images", wang, { image: { base64: imgC.toString("base64") }, text: [] })).body.error).toContain("text 必须是 JSON 对象")
  })

  it("第三张（后面检索用）", async () => {
    const res = await post("/api/gallery/images", li, { image: { base64: imgC.toString("base64") }, text: { 名称: "收纳筐", 价格: 15, 日期: "2026-09-01" }, tags: ["红色", "筐"] })
    expect(res.status).toBe(201)
  })
})

describe("检索", () => {
  let A: string
  let B: string
  let C: string
  beforeAll(async () => {
    const rows = await ctx.db.select({ id: t.galleryImages.id }).from(t.galleryImages).orderBy(asc(t.galleryImages.createdAt))
    ;[A, B, C] = rows.map((row) => row.id) as [string, string, string]
  })

  it("什么都不传：按上传时间倒序，带 nextCursor 翻页", async () => {
    expect(ids(await search({}))).toEqual([C, B, A])
    const first = await search({ limit: 2 })
    expect(ids(first)).toEqual([C, B])
    const second = await search({ limit: 2, cursor: first.body.nextCursor })
    expect(ids(second)).toEqual([A])
    expect(second.body.nextCursor).toBeUndefined()
    expect((await search({ cursor: "乱写的" })).body.error).toContain("cursor 不对")
  })

  it("标签：tags 都要有，anyTags 有一个就行", async () => {
    expect(ids(await search({ tags: ["红色", "杯子"] }))).toEqual([A])
    expect(ids(await search({ anyTags: ["蓝色", "筐"] }))).toEqual([C, B])
    expect(ids(await search({ tags: ["红色"], anyTags: ["筐", "没有的"] }))).toEqual([C])
  })

  it("JSON 包含匹配", async () => {
    expect(ids(await search({ text: { 规格: { 颜色: "红" } } }))).toEqual([A])
    expect(ids(await search({ text: { 价格: 9.9 } }))).toEqual([B])
    expect(ids(await search({ text: { 价格: "9.9" } }))).toEqual([])
  })

  it("按字段加条件：数字比大小、字符串比字典序、包含、存在、等于", async () => {
    const where = async (...conds: unknown[]) => ids(await search({ where: conds }))
    expect(await where({ path: "价格", op: "gt", value: 10 })).toEqual([C, A])
    expect(await where({ path: "价格", op: "lte", value: 9.9 })).toEqual([B])
    expect(await where({ path: "日期", op: "gte", value: "2026-09-15" })).toEqual([B])
    expect(await where({ path: "名称", op: "contains", value: "杯" })).toEqual([B, A])
    expect(await where({ path: "材质", op: "contains", value: "硅胶" })).toEqual([A])
    expect(await where({ path: ["规格", "颜色"], op: "eq", value: "红" })).toEqual([A])
    expect(await where({ path: "规格.颜色", op: "exists" })).toEqual([A])
    expect(await where({ path: "日期", op: "exists" })).toEqual([C, B])
    expect(await where({ path: "名称", op: "ne", value: "收纳筐" })).toEqual([B, A])
    expect(await where({ path: "价格", op: "gt", value: 10 }, { path: "日期", op: "exists" })).toEqual([C])
    // 类型对不上的不算（字符串和数字不比）
    expect(await where({ path: "名称", op: "gt", value: 1 })).toEqual([])
    const bad = await search({ where: [{ path: "价格", op: "gt", value: { a: 1 } }] })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toContain("要是数字或字符串")
  })

  it("关键词：在值里找（字符串、数字都算），不找键名", async () => {
    expect(ids(await search({ keyword: "不锈" }))).toEqual([A])
    expect(ids(await search({ keyword: "25" }))).toEqual([A])
    expect(ids(await search({ keyword: "名称" }))).toEqual([])
    expect(ids(await search({ keyword: "100%" }))).toEqual([])
  })

  it("以图搜图：同一张图换个大小、格式也能找到，排第一，带相似度；可以再加筛选", async () => {
    const query = await sharp(imgA).resize(200).jpeg({ quality: 70 }).toBuffer()
    const res = await search({ image: { base64: query.toString("base64") } })
    expect(res.status).toBe(200)
    expect(res.body.model).toBe(EMBED)
    expect(res.body.items[0]).toMatchObject({ id: A })
    expect(res.body.items[0].score).toBeGreaterThan(0.95)
    expect(res.body.items[1].score).toBeLessThan(res.body.items[0].score)
    expect(ids(await search({ image: { base64: query.toString("base64") }, minScore: 0.95 }))).toEqual([A])
    expect(ids(await search({ image: { base64: query.toString("base64") }, tags: ["蓝色"] }))).toEqual([B])
  })

  it("以图搜图也能用 multipart 传图", async () => {
    const form = new FormData()
    form.append("image", new File([new Uint8Array(imgC)], "q.png", { type: "image/png" }))
    form.append("tags", '["红色"]')
    form.append("limit", "1")
    const res = await ctx.app.request("/api/gallery/search", { method: "POST", body: form, headers: { cookie: wang } })
    const body = (await res.json()) as any
    expect(body.items.map((item: { id: string }) => item.id)).toEqual([C])
  })

  it("页面的「找相似」（tRPC，similarTo）：不把它自己排进去", async () => {
    const { data } = await query(ctx.app, "gallery.list", wang, { similarTo: A })
    expect(data.items.map((item: { id: string }) => item.id)).not.toContain(A)
    expect(data.items).toHaveLength(2)
    expect(data.items.every((item: { score?: number }) => typeof item.score === "number")).toBe(true)
  })

  it("「找相似」也能限相似度下限和张数（minScore、limit）", async () => {
    const { data: all } = await query(ctx.app, "gallery.list", wang, { similarTo: A })
    const [best, second] = all.items as { id: string; score: number }[]
    const { data: strict } = await query(ctx.app, "gallery.list", wang, { similarTo: A, minScore: (best!.score + second!.score) / 2 })
    expect(strict.items.map((item: { id: string }) => item.id)).toEqual([best!.id])
    const { data: none } = await query(ctx.app, "gallery.list", wang, { similarTo: A, minScore: 1 })
    expect(none.items).toEqual([])
    const { data: one } = await query(ctx.app, "gallery.list", wang, { similarTo: A, limit: 1 })
    expect(one.items.map((item: { id: string }) => item.id)).toEqual([best!.id])
  })

  it("按一句描述找图；image 和 query 不能同时传", async () => {
    const res = await search({ query: "红色的杯子" })
    expect(res.body.items).toHaveLength(3)
    expect(res.body.model).toBe(EMBED)
    const both = await search({ query: "x", image: { imageId: A } })
    expect(both.status).toBe(400)
    expect(both.body.error).toContain("只能传一个")
  })

  it("比对：同一张图换大小是同一张，不同的图不是；可以用 imageId、base64、multipart", async () => {
    const resized = await sharp(imgA).resize(150).webp().toBuffer()
    const same = await post("/api/gallery/compare", wang, { a: { imageId: A }, b: { base64: resized.toString("base64") } })
    expect(same.body).toMatchObject({ same: true, threshold: 0.9, model: EMBED })
    expect(same.body.score).toBeGreaterThan(0.95)
    const different = await post("/api/gallery/compare", wang, { a: { imageId: A }, b: { imageId: B } })
    expect(different.body.same).toBe(false)
    const strict = await post("/api/gallery/compare", wang, { a: { imageId: A }, b: { base64: resized.toString("base64") }, threshold: 0.9999 })
    expect(strict.body.same).toBe(false)
    const form = new FormData()
    form.append("a", new File([new Uint8Array(imgA)], "a.png"))
    form.append("b", new File([new Uint8Array(resized)], "b.webp"))
    const multipart = await ctx.app.request("/api/gallery/compare", { method: "POST", body: form, headers: { cookie: wang } })
    expect(((await multipart.json()) as any).same).toBe(true)
    expect((await post("/api/gallery/compare", wang, { a: { imageId: "img-99999" }, b: { imageId: A } })).status).toBe(404)
  })

  it("常用标签和统计", async () => {
    const { data: tags } = await query(ctx.app, "gallery.tags", wang)
    // 用得多的在前
    expect(tags.slice(0, 2).map((each: { tag: string }) => each.tag).sort()).toEqual(["杯子", "红色"].sort())
    expect(tags).toEqual(expect.arrayContaining([{ tag: "红色", count: 2 }, { tag: "杯子", count: 2 }, { tag: "蓝色", count: 1 }, { tag: "筐", count: 1 }]))
    const { data: stats } = await query(ctx.app, "gallery.stats", wang)
    expect(stats).toEqual({ total: 3, embedModel: { id: EMBED, name: "Embed Vision" }, pending: 0 })
  })
})

describe("改、删和权限：上传的人和主管能改能删，别的员工不行", () => {
  let mine: string
  beforeAll(async () => {
    mine = (await upload(wang, imgD, { tags: '["待整理"]', text: '{"备注":"王的"}' })).body.image.id
  })

  it("别的员工改不了、删不了（HTTP 和 tRPC 一样）", async () => {
    const patch = await ctx.app.request(`/api/gallery/images/${mine}`, { method: "PATCH", headers: { cookie: li, "content-type": "application/json" }, body: JSON.stringify({ tags: ["x"] }) })
    expect(patch.status).toBe(403)
    expect(((await patch.json()) as any).error).toContain("只有上传的人和主管")
    expect((await mutate(ctx.app, "gallery.delete", li, { id: mine })).error?.data?.code).toBe("FORBIDDEN")
  })

  it("自己改：整体替换文本，标签加减", async () => {
    const res = await ctx.app.request(`/api/gallery/images/${mine}`, {
      method: "PATCH",
      headers: { cookie: wang, "content-type": "application/json" },
      body: JSON.stringify({ text: { 备注: "改过了" }, addTags: ["新的", "待整理"], removeTags: ["待整理"] }),
    })
    expect(res.status).toBe(200)
    expect((await res.json()) as any).toMatchObject({ text: { 备注: "改过了" }, tags: ["新的"] })
    expect((await mutate(ctx.app, "gallery.update", wang, { id: mine, text: [1] })).error?.message).toContain("text 必须是 JSON 对象")
  })

  it("主管能改别人的；删了以后文件也没了", async () => {
    expect((await mutate(ctx.app, "gallery.update", lin, { id: mine, tags: ["主管改的"] })).data.tags).toEqual(["主管改的"])
    const [row] = await ctx.db.select().from(t.galleryImages).where(eq(t.galleryImages.id, mine))
    expect((await mutate(ctx.app, "gallery.delete", wang, { id: mine })).data).toEqual({ id: mine })
    expect((await ctx.app.request(`/api/gallery/images/${mine}`, { headers: { cookie: wang } })).status).toBe(404)
    expect(await ctx.db.select().from(t.files).where(eq(t.files.id, row!.fileId))).toHaveLength(0)
    expect(await ctx.db.select().from(t.galleryEmbeddings).where(eq(t.galleryEmbeddings.imageId, mine))).toHaveLength(0)
  })

  it("一次删多张：有一张没权限就整批不删；都能删就一起删、文件也没了", async () => {
    const pic = (fill: string) => png(`<rect width="10" height="10" fill="${fill}"/>`, 10, 10)
    const wangs = [(await upload(wang, await pic("#123"))).body.image.id, (await upload(wang, await pic("#456"))).body.image.id]
    const lis = (await upload(li, await pic("#789"))).body.image.id
    const denied = await mutate(ctx.app, "gallery.deleteMany", wang, { ids: [...wangs, lis] })
    expect(denied.error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "gallery.deleteMany", wang, { ids: [wangs[0], "img-99999"] })).error?.data?.code).toBe("NOT_FOUND")
    expect((await ctx.db.select().from(t.galleryImages).where(inArray(t.galleryImages.id, [...wangs, lis])))).toHaveLength(3)
    const rows = await ctx.db.select().from(t.galleryImages).where(inArray(t.galleryImages.id, wangs))
    expect((await mutate(ctx.app, "gallery.deleteMany", lin, { ids: [...wangs, lis] })).data).toEqual({ ids: [...wangs, lis] })
    expect(await ctx.db.select().from(t.galleryImages).where(inArray(t.galleryImages.id, [...wangs, lis]))).toHaveLength(0)
    expect(await ctx.db.select().from(t.files).where(inArray(t.files.id, rows.map((row) => row.fileId)))).toHaveLength(0)
  })
})

describe("API 密钥：只有主管能建；用密钥调接口算在创建人头上", () => {
  let key: string
  let keyId: string

  it("员工建不了；主管建：原文只给这一次，列表里只有尾号", async () => {
    expect((await mutate(ctx.app, "apiKeys.create", wang, { name: "x" })).error?.data?.code).toBe("FORBIDDEN")
    expect((await query(ctx.app, "apiKeys.list", wang)).error?.data?.code).toBe("FORBIDDEN")
    const created = await mutate(ctx.app, "apiKeys.create", lin, { name: "ERP 同步" })
    key = created.data.key
    keyId = created.data.id
    expect(key).toMatch(/^hk_[A-Za-z0-9_-]{32}$/)
    expect(keyId).toMatch(/^ak-\d+$/)
    const { data: list } = await query(ctx.app, "apiKeys.list", lin)
    expect(list).toEqual([expect.objectContaining({ id: keyId, name: "ERP 同步", hint: key.slice(-4), createdById: "u-lin" })])
    expect(JSON.stringify(list)).not.toContain(key)
    const [row] = await ctx.db.select().from(t.apiKeys).where(eq(t.apiKeys.id, keyId))
    expect(row!.sha256).not.toContain(key)
  })

  it("Bearer 传图、检索：via = api，算在主管头上；记下最近用过的时间", async () => {
    const res = await post("/api/gallery/images", undefined, { image: { base64: (await png(`<rect width="10" height="10" fill="#0a0"/>`, 10, 10)).toString("base64") }, tags: ["接口传的"] }, { authorization: `Bearer ${key}` })
    expect(res.status).toBe(201)
    expect(res.body.image).toMatchObject({ via: "api", createdById: "u-lin", tags: ["接口传的"] })
    const found = await post("/api/gallery/search", undefined, { tags: ["接口传的"] }, { authorization: `Bearer ${key}` })
    expect(found.body.items).toHaveLength(1)
    const [row] = await ctx.db.select().from(t.galleryImages).where(eq(t.galleryImages.id, res.body.image.id))
    expect(row!.apiKeyId).toBe(keyId)
    expect((await query(ctx.app, "apiKeys.list", lin)).data[0].lastUsedAt).toBeTruthy()
    // 用密钥（主管）删
    const del = await ctx.app.request(`/api/gallery/images/${res.body.image.id}`, { method: "DELETE", headers: { authorization: `Bearer ${key}` } })
    expect(del.status).toBe(200)
  })

  it("带了 Bearer 就只认密钥：密钥不对时就算有 cookie 也是 401", async () => {
    const res = await post("/api/gallery/search", wang, {}, { authorization: "Bearer hk_not-a-real-key" })
    expect(res.status).toBe(401)
    expect(res.body.error).toContain("API 密钥不对")
  })

  it("创建人被停用：密钥跟着失效", async () => {
    const admin = await mutate(ctx.app, "users.create", lin, { email: "temp.admin@heyagent.local", name: "临时主管", title: "", role: "admin", password: "temp-password-1" })
    const cookie = await login(ctx.app, "temp.admin@heyagent.local", "temp-password-1")
    const temp = (await mutate(ctx.app, "apiKeys.create", cookie, { name: "临时" })).data.key
    expect((await post("/api/gallery/search", undefined, {}, { authorization: `Bearer ${temp}` })).status).toBe(200)
    await mutate(ctx.app, "users.setDisabled", lin, { id: admin.data.id, disabled: true })
    expect((await post("/api/gallery/search", undefined, {}, { authorization: `Bearer ${temp}` })).status).toBe(401)
  })

  it("删掉密钥立刻失效", async () => {
    expect((await mutate(ctx.app, "apiKeys.delete", lin, { id: keyId })).data).toEqual({ id: keyId })
    expect((await post("/api/gallery/search", undefined, {}, { authorization: `Bearer ${key}` })).status).toBe(401)
  })
})

describe("MCP（Streamable HTTP，无状态）", () => {
  let key: string
  let n = 0

  beforeAll(async () => {
    key = (await mutate(ctx.app, "apiKeys.create", lin, { name: "MCP 客户端" })).data.key
  })

  /** 发一个 JSON-RPC 请求；返回可能是 JSON，也可能是 SSE */
  async function rpc(method: string, params: unknown, auth = `Bearer ${key}`) {
    const res = await ctx.app.request("/api/gallery/mcp", {
      method: "POST",
      headers: { authorization: auth, "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-06-18" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++n, method, params }),
    })
    const text = await res.text()
    if (res.status !== 200) return { status: res.status, body: JSON.parse(text) as any }
    const json = (res.headers.get("content-type") ?? "").includes("text/event-stream")
      ? text
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => JSON.parse(line.slice(5)) as any)
          .find((message) => message.id === n)
      : JSON.parse(text)
    return { status: res.status, body: json as any }
  }

  it("没带密钥：401", async () => {
    expect((await rpc("tools/list", {}, "")).status).toBe(401)
  })

  it("initialize、列出工具", async () => {
    const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })
    expect(init.body.result.serverInfo.name).toBe("heyagent-gallery")
    const list = await rpc("tools/list", {})
    expect(list.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
      ["gallery_compare", "gallery_delete", "gallery_get", "gallery_search", "gallery_tags", "gallery_update", "gallery_upload"].sort()
    )
    const searchTool = list.body.result.tools.find((tool: { name: string }) => tool.name === "gallery_search")
    expect(searchTool.inputSchema.properties).toHaveProperty("where")
  })

  it("调工具：检索、传图（重复的给已有的）、看一张带缩略图、比对、改、删；出错回 isError", async () => {
    const found = await rpc("tools/call", { name: "gallery_search", arguments: { tags: ["红色", "杯子"] } })
    const items = found.body.result.structuredContent.items
    expect(items).toHaveLength(1)
    expect(items[0].url).toMatch(/^http:\/\/localhost\/api\/gallery\/images\/img-\d+\/file$/)
    const dup = await rpc("tools/call", { name: "gallery_upload", arguments: { image: { base64: imgA.toString("base64") } } })
    expect(dup.body.result.structuredContent).toMatchObject({ duplicate: true, image: { id: items[0].id } })
    const created = await rpc("tools/call", { name: "gallery_upload", arguments: { image: { base64: (await png(`<circle cx="50" cy="50" r="40" fill="#00f"/>`, 100, 100)).toString("base64") }, text: { 来源: "mcp" }, tags: ["mcp"] } })
    const newId = created.body.result.structuredContent.image.id
    expect(created.body.result.structuredContent.image).toMatchObject({ via: "mcp", tags: ["mcp"], embedded: true })
    const got = await rpc("tools/call", { name: "gallery_get", arguments: { id: newId, withImage: true } })
    expect(got.body.result.content.map((part: { type: string }) => part.type)).toEqual(["text", "image"])
    expect(got.body.result.content[1].mimeType).toBe("image/webp")
    const compared = await rpc("tools/call", { name: "gallery_compare", arguments: { a: { imageId: newId }, b: { imageId: newId } } })
    expect(compared.body.result.structuredContent).toMatchObject({ same: true, score: 1 })
    const updated = await rpc("tools/call", { name: "gallery_update", arguments: { id: newId, addTags: ["改过"] } })
    expect(updated.body.result.structuredContent.tags).toEqual(["mcp", "改过"])
    const deleted = await rpc("tools/call", { name: "gallery_delete", arguments: { id: newId } })
    expect(deleted.body.result.structuredContent).toEqual({ id: newId })
    const missing = await rpc("tools/call", { name: "gallery_get", arguments: { id: newId } })
    expect(missing.body.result.isError).toBe(true)
    expect(missing.body.result.content[0].text).toContain("图库里没有")
    const tags = await rpc("tools/call", { name: "gallery_tags", arguments: {} })
    expect(tags.body.result.structuredContent.stats.total).toBe(3)
  })
})

describe("换 embedding 模型：后台重算，算完之前检索还用旧模型的向量", () => {
  it("换模型以后：统计显示还差几张；检索仍然搜得到全部（用旧模型）；重算完换成新模型、删掉旧向量", async () => {
    const { data } = await query(ctx.app, "models.overview", lin)
    await mutate(ctx.app, "models.setDefaults", lin, { run: data.defaults.run, plan: data.defaults.plan, verify: data.defaults.verify, embed: EMBED_2 })
    const stats = (await query(ctx.app, "gallery.stats", wang)).data
    expect(stats).toMatchObject({ total: 3, embedModel: { id: EMBED_2 }, pending: 3 })
    const query1 = await sharp(imgA).resize(120).png().toBuffer()
    const during = await search({ image: { base64: query1.toString("base64") } })
    expect(during.body.model).toBe(EMBED)
    expect(during.body.items).toHaveLength(3)
    while ((await embedPendingOnce(ctx.db, 2)) > 0) {
      // 一批两张，直到算完
    }
    await embedPendingOnce(ctx.db)
    expect((await query(ctx.app, "gallery.stats", wang)).data.pending).toBe(0)
    const after = await search({ image: { base64: query1.toString("base64") } })
    expect(after.body.model).toBe(EMBED_2)
    expect(after.body.items).toHaveLength(3)
    const models = await ctx.db.selectDistinct({ modelId: t.galleryEmbeddings.modelId }).from(t.galleryEmbeddings)
    expect(models).toEqual([{ modelId: EMBED_2 }])
  })

  it("传图时模型调用失败：图照样存下来，统计里看得到原因；过 10 分钟后台重试", async () => {
    embedBroken = true
    const { body } = await upload(wang, await png(`<rect width="50" height="50" fill="#f0f"/>`, 50, 50))
    expect(body.image.embedded).toBe(false)
    expect((await query(ctx.app, "gallery.stats", wang)).data).toMatchObject({ pending: 1, lastError: "模型挂了" })
    embedBroken = false
    const calls = embedCalls
    expect(await embedPendingOnce(ctx.db)).toBe(0)
    expect(embedCalls).toBe(calls)
    await ctx.db.update(t.galleryImages).set({ embedTriedAt: new Date(Date.now() - 11 * 60_000) }).where(eq(t.galleryImages.id, body.image.id))
    expect(await embedPendingOnce(ctx.db)).toBe(1)
    expect((await query(ctx.app, "gallery.get", wang, { id: body.image.id })).data.embedded).toBe(true)
  })
})

describe("agent 的「图库」工具组", () => {
  let session: SessionRow
  let entries: ReturnType<typeof galleryToolEntries>
  const tool = (id: string) => entries.find((entry) => entry.id === id)!

  beforeAll(async () => {
    ;[session] = (await ctx.db.select().from(t.sessions).limit(1)) as SessionRow[]
    entries = galleryToolEntries({ db: ctx.db, session, snapshot: { attachments: [] } as unknown as SessionSnapshot })
  })

  it("只有检索、比对、看一张、传图、改（没有删）", () => {
    expect(entries.map((entry) => entry.id)).toEqual(["gallery.search", "gallery.compare", "gallery.get", "gallery.add", "gallery.update"])
    expect(tool("gallery.search").jsonSchema).toMatchObject({ type: "object" })
  })

  it("传这次运行的截图：算在这次运行上；别的运行的文件用不了", async () => {
    const shot = await saveFile(ctx.db, { data: await png(`<rect width="80" height="60" fill="#ff0"/>`, 80, 60), name: "screenshot.png", kind: "screenshot", sessionId: session.id })
    const other = await saveFile(ctx.db, { data: imgB, name: "other.png", kind: "upload" })
    const added = await tool("gallery.add").execute({ image: { fileId: shot.id }, text: { 来源: "截图" }, tags: ["agent"] })
    expect(added.isError).toBeFalsy()
    const result = JSON.parse(added.output)
    expect(result).toMatchObject({ duplicate: false, embedded: true, image: { tags: ["agent"], text: { 来源: "截图" } } })
    const [row] = await ctx.db.select().from(t.galleryImages).where(eq(t.galleryImages.id, result.image.id))
    expect(row).toMatchObject({ via: "agent", sessionId: session.id, createdById: null })
    const denied = await tool("gallery.add").execute({ image: { fileId: other.id } })
    expect(denied).toMatchObject({ isError: true, output: expect.stringContaining("这次运行里没有文件") })
  })

  it("检索、比对、看缩略图、改标签（agent 能改别人传的）", async () => {
    const found = JSON.parse((await tool("gallery.search").execute({ tags: ["红色", "杯子"] })).output)
    expect(found.results).toHaveLength(1)
    expect(found.results[0]).not.toHaveProperty("url")
    const id = found.results[0].id
    const similar = JSON.parse((await tool("gallery.search").execute({ image: { imageId: id }, limit: 1 })).output)
    expect(similar.results[0].score).toEqual(expect.any(Number))
    expect(JSON.parse((await tool("gallery.compare").execute({ a: { imageId: id }, b: { imageId: id } })).output)).toMatchObject({ same: true })
    const seen = await tool("gallery.get").execute({ id, showImage: true })
    expect(seen.images?.[0]?.mime).toBe("image/webp")
    expect(JSON.parse((await tool("gallery.update").execute({ id, addTags: ["agent 看过"] })).output).tags).toContain("agent 看过")
  })
})
