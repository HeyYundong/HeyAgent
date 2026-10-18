// 比图：新比对（文件 id、图库 id、base64、网址、multipart）、标准 / 自己写的要求 / 默认标准、换模型、复用、再比一次、
// worker 比对（正常、证据不足、格式不对重试、模型一直出错）、权限、比对标准的增删改和设默认、启动时建默认标准、HTTP 接口、MCP、agent 工具组。
// 真实的测试库 + 进程内 worker + 假模型（按 model id 找剧本），不花钱、不连外网。
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"

import { and, eq, inArray } from "drizzle-orm"
import sharp from "sharp"
import type { SessionSnapshot } from "@heyagent/shared"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

import { recoverRunningComparisons } from "../src/compare/run.js"
import { compareLimits, configureCompare, DEFAULT_COMPARE_MODEL, ensureDefaultStandard } from "../src/compare/service.js"
import { compareToolEntries } from "../src/compare/tools.js"
import * as t from "../src/db/schema.js"
import { QUEUES } from "../src/engine/queue.js"
import type { SessionRow } from "../src/engine/tools/builtin.js"
import { saveFile } from "../src/files/service.js"
import { login, mutate, query } from "./helpers.js"
import { Script, setupEngine, step, text, useScript, waitFor, type CallOptions, type EngineTestContext, type GenerateResult } from "./engine-helpers.js"

let ctx: EngineTestContext
let lin: string // 主管
let wang: string // 员工
let li: string // 另一个员工

const VISION = "openrouter/test/vision-cheap"
const VISION_2 = "openrouter/test/vision-2"
const TEXT_ONLY = "openrouter/test/text-only"
const savedLimits = { ...compareLimits }

const good = {
  score: 97,
  confidence: "high",
  verdict: "同款：轮廓和把手一样，只是背景不同。",
  reasons: ["轮廓一致", "把手位置一致"],
  dimensions: [
    { name: "形态和结构", score: 98, note: "一致" },
    { name: "颜色", score: 150, note: "超出范围的分数要夹到 100" },
  ],
  differences: ["背景不同"],
}
const answer = (value: unknown, cost = 0.002) => step([text(JSON.stringify(value))], cost)

/** 假模型的行为：每个测试按需要换 */
let behavior: (options: CallOptions) => GenerateResult | Promise<GenerateResult> = () => answer(good)
const scriptOf = () => new Script(Array.from({ length: 400 }, () => (options: CallOptions) => behavior(options)))
let script: Script

const svg = (body: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="300" height="200">${body}</svg>`)
const png = (body: string) => sharp(svg(body)).png().toBuffer()
let imgA: Buffer
let imgB: Buffer
let imgC: Buffer

let server: Server
let port = 0

async function uploadFile(cookie: string, data: Buffer, name = "photo.png") {
  const form = new FormData()
  form.append("file", new File([new Uint8Array(data)], name, { type: "image/png" }))
  const res = await ctx.app.request("/api/files", { method: "POST", body: form, headers: { cookie } })
  return ((await res.json()) as { id: string }).id
}

async function finished(id: string) {
  return waitFor(
    async () => {
      const [row] = await ctx.db.select().from(t.comparisons).where(eq(t.comparisons.id, id))
      return row && row.status !== "running" ? row : undefined
    },
    { what: `${id} 比完` }
  )
}

async function create(cookie: string, input: Record<string, unknown>) {
  const res = await mutate(ctx.app, "compare.create", cookie, input)
  if (!res.data) throw new Error(`compare.create 失败：${JSON.stringify(res.error)}`)
  return res.data as { id: string; status: string; reused?: boolean; title: string; imageA: { fileId: string; from: string; label: string }; imageB: { fileId: string; from: string; label: string }; standardId: string | null; standardName: string | null; passScore: number; modelId: string }
}

beforeAll(async () => {
  ctx = await setupEngine()
  lin = await login(ctx.app, "linzhou@heyagent.local")
  wang = await login(ctx.app, "wangyue@heyagent.local")
  li = await login(ctx.app, "lijing@heyagent.local")
  configureCompare({ waitMs: 15_000, pollMs: 100 })
  script = useScript(VISION, scriptOf())
  useScript(VISION_2, scriptOf())
  imgA = await png(`<rect width="300" height="200" fill="#fff"/><circle cx="100" cy="100" r="70" fill="#c00"/>`)
  imgB = await png(`<rect width="300" height="200" fill="#eee"/><circle cx="100" cy="100" r="68" fill="#b00"/>`)
  imgC = await png(`<rect width="300" height="200" fill="#000"/><rect x="50" y="50" width="200" height="100" fill="#0f0"/>`)
  server = createServer((req, res) => {
    if (req.url === "/a.png") {
      res.setHeader("content-type", "image/png")
      return res.end(imgC)
    }
    res.statusCode = 404
    res.end("not found")
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  configureCompare(savedLimits)
  server?.close()
  await ctx?.stop()
})

describe("默认标准", () => {
  it("worker 启动时建好「同款判断」；没有视觉模型时不建，有了再建，模型是最便宜的视觉模型", async () => {
    const [started] = await ctx.db.select().from(t.compareStandards).where(eq(t.compareStandards.id, "std-same-item"))
    expect(started).toMatchObject({ name: "同款判断", passScore: 95, isDefault: true })

    await ctx.db.delete(t.compareStandards)
    const visionIds = (await ctx.db.select({ id: t.models.id }).from(t.models).where(and(eq(t.models.vision, true), eq(t.models.kind, "chat")))).map((row) => row.id)
    await ctx.db.update(t.models).set({ vision: false }).where(inArray(t.models.id, visionIds))
    expect(await ensureDefaultStandard(ctx.db)).toBe(false)
    expect(await ctx.db.select().from(t.compareStandards)).toHaveLength(0)
    await ctx.db.update(t.models).set({ vision: true }).where(inArray(t.models.id, visionIds))
    await ctx.db.insert(t.models).values([
      { id: VISION, providerId: "openrouter", name: "Vision Cheap", contextK: 128, priceIn: 0.01, priceOut: 0.04, vision: true, kind: "chat" },
      { id: VISION_2, providerId: "openrouter", name: "Vision 2", contextK: 128, priceIn: 0.02, priceOut: 0.08, vision: true, kind: "chat" },
      { id: TEXT_ONLY, providerId: "openrouter", name: "Text Only", contextK: 128, priceIn: 0.001, priceOut: 0.002, vision: false, kind: "chat" },
      // 更便宜但不该当默认的：免费线路、批处理线路（聊天接口用不了）、预览版
      { id: `${VISION}:free`, providerId: "openrouter", name: "Vision Free", contextK: 128, priceIn: 0, priceOut: 0, vision: true, kind: "chat" },
      { id: `${VISION}:batch`, providerId: "openrouter", name: "Vision Batch", contextK: 128, priceIn: 0.005, priceOut: 0.02, vision: true, kind: "chat" },
      { id: `${VISION}-preview`, providerId: "openrouter", name: "Vision Preview", contextK: 128, priceIn: 0.006, priceOut: 0.02, vision: true, kind: "chat" },
    ])
    expect(await ensureDefaultStandard(ctx.db)).toBe(true)
    expect(await ensureDefaultStandard(ctx.db)).toBe(false)
    const { data } = await query(ctx.app, "compare.standards", wang)
    expect(data).toEqual([expect.objectContaining({ id: "std-same-item", name: "同款判断", passScore: 95, modelId: VISION, isDefault: true })])
    expect(data[0].prompt).toContain("同一款")
  })

  it("有推荐的模型（Gemini 3.1 Flash Lite）时默认标准用它，哪怕不是最便宜的", async () => {
    const preferred = `openrouter/${DEFAULT_COMPARE_MODEL}`
    await ctx.db.insert(t.models).values({ id: preferred, providerId: "openrouter", name: "Gemini Lite", contextK: 128, priceIn: 0.25, priceOut: 1.5, vision: true, kind: "chat" }).onConflictDoNothing()
    await ctx.db.delete(t.compareStandards)
    expect(await ensureDefaultStandard(ctx.db)).toBe(true)
    const [standard] = await ctx.db.select().from(t.compareStandards)
    expect(standard).toMatchObject({ id: "std-same-item", modelId: preferred })
    // 还原：后面的测试按最便宜的假模型跑
    await ctx.db.delete(t.compareStandards)
    await ctx.db.delete(t.models).where(eq(t.models.id, preferred))
    expect(await ensureDefaultStandard(ctx.db)).toBe(true)
  })

  it("视觉模型列表：只有能看图的聊天模型，便宜的在前，没有批处理线路", async () => {
    const { data } = await query(ctx.app, "compare.models", wang)
    const ids = data.map((model: { id: string }) => model.id)
    expect(ids.slice(0, 4)).toEqual([`${VISION}:free`, `${VISION}-preview`, VISION, VISION_2])
    expect(ids).not.toContain(TEXT_ONLY)
    expect(ids).not.toContain(`${VISION}:batch`)
    expect(data[2]).toEqual({ id: VISION, name: "Vision Cheap", priceIn: 0.01, priceOut: 0.04 })
    await ctx.db.delete(t.models).where(inArray(t.models.id, [`${VISION}:free`, `${VISION}:batch`, `${VISION}-preview`]))
  })
})

describe("新比对和 worker", () => {
  it("文件 id + 默认标准：先返回比对中，worker 比完写分数、达标、花费；两张图都给了模型，页面传的图直接改成比图的文件", async () => {
    behavior = () => answer(good)
    const calls = script.prompts.length
    const fileA = await uploadFile(wang, imgA, "原图.png")
    const fileB = await uploadFile(wang, imgB, "候选.png")
    const created = await create(wang, { imageA: { fileId: fileA }, imageB: { fileId: fileB }, labelB: "候选 1 号" })
    expect(created).toMatchObject({ status: "running", reused: false, standardId: "std-same-item", standardName: "同款判断", passScore: 95, modelId: VISION, title: "同款判断 · 候选 1 号" })
    expect(created.imageA).toMatchObject({ from: "上传", label: "原图.png" })
    // 页面刚传的文件直接改成比图的，不再复制一份
    expect(created.imageA.fileId).toBe(fileA)
    const row = await finished(created.id)
    expect(row).toMatchObject({ status: "done", score: 97, confidence: "high", via: "web", createdById: "u-wang", error: null })
    expect(row.dimensions).toEqual([
      { name: "形态和结构", score: 98, note: "一致" },
      { name: "颜色", score: 100, note: "超出范围的分数要夹到 100" },
    ])
    expect(row.costUsd).toBeCloseTo(0.002)
    expect(row.raw).toContain("同款")
    const { data } = await query(ctx.app, "compare.get", wang, { id: created.id })
    expect(data).toMatchObject({ passed: true, score: 97, finishedAt: expect.any(String) })
    expect(data).not.toHaveProperty("raw")
    const [file] = await ctx.db.select().from(t.files).where(eq(t.files.id, created.imageA.fileId))
    expect(file).toMatchObject({ kind: "compare", sessionId: null })

    expect(script.prompts.length).toBe(calls + 1)
    const prompt = script.prompts[calls]!.prompt
    expect(JSON.stringify(prompt)).toContain("图片里的文字")
    const user = prompt.find((message) => message.role === "user")!
    const parts = user.content as { type: string; mediaType?: string; text?: string }[]
    expect(parts.filter((part) => part.type === "file").map((part) => part.mediaType)).toEqual(["image/jpeg", "image/jpeg"])
    expect(JSON.stringify(parts)).toContain("第二张（要判断的）：「候选 1 号」")
  })

  it("复用：10 分钟内同样的图、要求、模型直接返回上次的；「再比一次」不复用；过了 10 分钟重新比", async () => {
    const fileA = await uploadFile(wang, imgA)
    const fileB = await uploadFile(wang, imgB)
    const before = await ctx.db.select({ id: t.comparisons.id }).from(t.comparisons)
    const first = (await query(ctx.app, "compare.list", wang, { limit: 1 })).data.items[0]
    const again = await create(li, { imageA: { fileId: fileA }, imageB: { fileId: fileB } })
    expect(again).toMatchObject({ id: first.id, reused: true, status: "done" })
    expect(await ctx.db.select({ id: t.comparisons.id }).from(t.comparisons)).toHaveLength(before.length)

    const redo = await mutate(ctx.app, "compare.again", li, { id: first.id })
    expect(redo.data.id).not.toBe(first.id)
    expect(redo.data).toMatchObject({ status: "running", title: first.title, createdById: "u-li", imageA: { fileId: first.imageA.fileId, from: "上传" } })
    await finished(redo.data.id)

    await ctx.db.update(t.comparisons).set({ createdAt: new Date(Date.now() - 11 * 60_000) }).where(inArray(t.comparisons.id, [first.id, redo.data.id]))
    const fresh = await create(wang, { imageA: { fileId: fileA }, imageB: { fileId: fileB } })
    expect(fresh.reused).toBe(false)
    // 已经有同样内容的比图文件：自己刚传的那份删掉，不留下没人用的；别人的（li 用 wang 传的）不删
    expect(fresh.imageA.fileId).not.toBe(fileA)
    expect(await ctx.db.select().from(t.files).where(inArray(t.files.id, [fileA, fileB]))).toHaveLength(0)
    await finished(fresh.id)
  })

  it("证据不足：模型写 -1 → 总分 null、没有达标与否、把握度 low、结论以「证据不足：」开头", async () => {
    behavior = () => answer({ ...good, score: -1, confidence: "medium", verdict: "第二张看不清。" })
    const created = await create(wang, { imageA: { base64: imgA.toString("base64") }, imageB: { base64: `data:image/png;base64,${imgC.toString("base64")}` }, prompt: "看两张图的颜色是不是一样" })
    expect(created).toMatchObject({ standardId: null, standardName: null, passScore: 95, title: expect.stringMatching(/^比图 cmp-\d+$/) })
    expect(created.imageA).toMatchObject({ from: "上传", label: "" })
    const row = await finished(created.id)
    expect(row).toMatchObject({ status: "done", score: null, confidence: "low", verdict: "证据不足：第二张看不清。" })
    expect((await query(ctx.app, "compare.get", wang, { id: created.id })).data.passed).toBeNull()
  })

  it("格式不对：重试一次能好就算好；两次都不对记为没比成，没比成的不复用", async () => {
    let n = 0
    behavior = () => (++n === 1 ? step([text("我觉得挺像的")]) : answer(good))
    const recovered = await create(wang, { imageA: { base64: imgB.toString("base64") }, imageB: { base64: imgC.toString("base64") }, prompt: "格式重试" })
    expect(await finished(recovered.id)).toMatchObject({ status: "done", score: 97 })
    expect(n).toBe(2)

    n = 0
    behavior = () => {
      n += 1
      return answer({ score: "很高" }, 0.001)
    }
    const input = { imageA: { base64: imgB.toString("base64") }, imageB: { base64: imgC.toString("base64") }, prompt: "两次都不对" }
    const failed = await create(wang, input)
    const row = await finished(failed.id)
    expect(row.status).toBe("failed")
    expect(row.error).toContain("格式不对，已经重试过一次")
    expect(n).toBe(2)
    behavior = () => answer(good)
    const retry = await create(wang, input)
    expect(retry.reused).toBe(false)
    expect(retry.id).not.toBe(failed.id)
    expect(await finished(retry.id)).toMatchObject({ status: "done" })
  })

  it("模型一直出错：按退避重试完记为没比成，写清原因", async () => {
    let n = 0
    behavior = () => {
      n += 1
      throw new Error("上游挂了")
    }
    const created = await create(wang, { imageA: { base64: imgA.toString("base64") }, imageB: { base64: imgC.toString("base64") }, prompt: "一直出错" })
    const row = await finished(created.id)
    expect(row.status).toBe("failed")
    expect(row.error).toMatch(/模型调用失败（已经重试 \d 次）：.*上游挂了/)
    expect(n).toBeGreaterThan(1)
    behavior = () => answer(good)
  })

  it("标准按 id、按名字（不分大小写）；自己写要求可以给合格线；换模型要是视觉模型；标准和要求不能同时给", async () => {
    const created = await mutate(ctx.app, "compare.createStandard", lin, { name: "Logo 检查", prompt: "看第二张有没有多出来的标识", passScore: 80, modelId: VISION_2 })
    expect(created.data).toMatchObject({ id: expect.stringMatching(/^std-\d+$/), isDefault: false })
    const images = { imageA: { base64: imgA.toString("base64") }, imageB: { base64: imgB.toString("base64") } }
    const first = await create(wang, { ...images, standard: "logo 检查" })
    expect(first).toMatchObject({ standardId: created.data.id, standardName: "Logo 检查", passScore: 80, modelId: VISION_2, reused: false })
    // 按 id 指同一个标准：同图同要求同模型，复用上一条（标题也是上一条的）
    expect(await create(wang, { ...images, standard: created.data.id, title: "自己起的标题" })).toMatchObject({ id: first.id, standardId: created.data.id, reused: true })
    expect(await create(wang, { ...images, prompt: "只看颜色", passScore: 60, modelId: VISION_2 })).toMatchObject({ standardId: null, passScore: 60, modelId: VISION_2 })

    const notVision = await mutate(ctx.app, "compare.create", wang, { ...images, modelId: TEXT_ONLY })
    expect(notVision.error?.data?.code).toBe("BAD_REQUEST")
    expect(notVision.error?.message).toContain("不能看图")
    const unknown = await mutate(ctx.app, "compare.create", wang, { ...images, standard: "没有这个" })
    expect(unknown.error?.message).toContain("没有比对标准「没有这个」，现有的：同款判断（std-same-item）")
    const both = await mutate(ctx.app, "compare.create", wang, { ...images, standard: "Logo 检查", prompt: "x" })
    expect(both.error?.data?.code).toBe("BAD_REQUEST")
    const notImage = await mutate(ctx.app, "compare.create", wang, { imageA: { base64: Buffer.from("hello").toString("base64") }, imageB: images.imageB })
    expect(notImage.error?.message).toContain("认不出这张图片")
  })

  it("图库的图（imageId）和网址（服务器去下载）", async () => {
    const form = new FormData()
    form.append("image", new File([new Uint8Array(imgC)], "图库里的.png", { type: "image/png" }))
    const uploaded = (await (await ctx.app.request("/api/gallery/images", { method: "POST", body: form, headers: { cookie: wang } })).json()) as { image: { id: string } }
    const url = `http://127.0.0.1:${port}/a.png`
    const created = await create(wang, { imageA: { imageId: uploaded.image.id }, imageB: { url } })
    expect(created.imageA).toMatchObject({ from: `图库 ${uploaded.image.id}`, label: "图库里的.png" })
    expect(created.imageB).toMatchObject({ from: `网址 ${url}`, label: url })
    // 两张是同一个内容：只存一份比图的文件
    expect(created.imageA.fileId).toBe(created.imageB.fileId)
    await finished(created.id)
    const missing = await mutate(ctx.app, "compare.create", wang, { imageA: { imageId: "img-99999" }, imageB: { base64: imgA.toString("base64") } })
    expect(missing.error?.data?.code).toBe("NOT_FOUND")
    const notFound = await mutate(ctx.app, "compare.create", wang, { imageA: { base64: imgA.toString("base64") }, imageB: { url: `http://127.0.0.1:${port}/missing.png` } })
    expect(notFound.error?.message).toContain("HTTP 404")
    // 图库删图不受比对记录影响（比对用的是自己的那份）
    const res = await ctx.app.request(`/api/gallery/images/${uploaded.image.id}`, { method: "DELETE", headers: { cookie: wang } })
    expect(res.status).toBe(200)
  })

  it("worker 启动时：太久的「比对中」记为没比成，其余重新排队", async () => {
    const [sample] = await ctx.db.select().from(t.comparisons).limit(1)
    const base = { ...sample!, finishedAt: null, score: null, status: "running" as const }
    await ctx.db.insert(t.comparisons).values([
      { ...base, id: "cmp-stale", createdAt: new Date(Date.now() - 60 * 60_000) },
      { ...base, id: "cmp-requeue", createdAt: new Date() },
    ])
    const sent: string[] = []
    const n = await recoverRunningComparisons(ctx.db, async (name, data) => {
      expect(name).toBe(QUEUES.compareRun)
      sent.push((data as { comparisonId: string }).comparisonId)
    })
    expect(n).toBe(1)
    expect(sent).toEqual(["cmp-requeue"])
    const [stale] = await ctx.db.select().from(t.comparisons).where(eq(t.comparisons.id, "cmp-stale"))
    expect(stale).toMatchObject({ status: "failed", error: expect.stringContaining("比了太久") })
    await ctx.db.delete(t.comparisons).where(inArray(t.comparisons.id, ["cmp-stale", "cmp-requeue"]))
  })
})

describe("权限和删除", () => {
  it("员工能比、能删自己的，不能删别人的；主管能删别人的；图没人用了文件一起删，还有人用就留着", async () => {
    const imgD = await png(`<rect width="300" height="200" fill="#00f"/>`)
    const imgE = await png(`<rect width="300" height="200" fill="#ff0"/>`)
    const mine = await create(wang, { imageA: { base64: imgD.toString("base64") }, imageB: { base64: imgE.toString("base64") }, prompt: "删除测试" })
    const shared = await create(li, { imageA: { base64: imgD.toString("base64") }, imageB: { base64: imgA.toString("base64") }, prompt: "删除测试 2" })
    expect(shared.imageA.fileId).toBe(mine.imageA.fileId)
    await finished(mine.id)
    await finished(shared.id)

    expect((await mutate(ctx.app, "compare.delete", li, { id: mine.id })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "compare.delete", wang, { id: mine.id })).data).toEqual({ id: mine.id })
    const left = await ctx.db.select({ id: t.files.id }).from(t.files).where(inArray(t.files.id, [mine.imageA.fileId, mine.imageB.fileId]))
    expect(left.map((row) => row.id)).toEqual([mine.imageA.fileId])
    expect((await mutate(ctx.app, "compare.delete", lin, { id: shared.id })).data).toEqual({ id: shared.id })
    expect(await ctx.db.select().from(t.files).where(eq(t.files.id, mine.imageA.fileId))).toHaveLength(0)
    const [audit] = await ctx.db.select().from(t.auditEvents).where(and(eq(t.auditEvents.action, "compare.delete"), eq(t.auditEvents.targetId, shared.id)))
    expect(audit).toMatchObject({ actorId: "u-lin" })
    expect((await mutate(ctx.app, "compare.delete", wang, { id: mine.id })).error?.data?.code).toBe("NOT_FOUND")
  })

  it("员工不能改标准", async () => {
    const input = { name: "员工建的", prompt: "x", passScore: 50, modelId: VISION }
    expect((await mutate(ctx.app, "compare.createStandard", wang, input)).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "compare.updateStandard", wang, { ...input, id: "std-same-item" })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "compare.setDefaultStandard", wang, { id: "std-same-item" })).error?.data?.code).toBe("FORBIDDEN")
    expect((await mutate(ctx.app, "compare.deleteStandard", wang, { id: "std-same-item" })).error?.data?.code).toBe("FORBIDDEN")
  })
})

describe("比对标准", () => {
  it("新建、改（名字不能重复，不分大小写；模型要是视觉模型）、设默认、默认的不能删、删了以后记录里标准名还在", async () => {
    const base = { prompt: "看形状", passScore: 70, modelId: VISION }
    const created = (await mutate(ctx.app, "compare.createStandard", lin, { ...base, name: "形状" })).data
    expect((await mutate(ctx.app, "compare.createStandard", lin, { ...base, name: "形状" })).error?.message).toContain("已经有叫「形状」的标准了")
    expect((await mutate(ctx.app, "compare.createStandard", lin, { ...base, name: "logo 检查" })).error?.message).toContain("已经有叫")
    expect((await mutate(ctx.app, "compare.createStandard", lin, { ...base, name: "x", modelId: TEXT_ONLY })).error?.message).toContain("不能看图")
    expect((await mutate(ctx.app, "compare.createStandard", lin, { ...base, name: "y", modelId: "openrouter/没有这个" })).error?.message).toContain("不在模型列表里")
    const updated = await mutate(ctx.app, "compare.updateStandard", lin, { ...base, id: created.id, name: "形状和比例", passScore: 75 })
    expect(updated.data).toMatchObject({ name: "形状和比例", passScore: 75 })
    expect((await mutate(ctx.app, "compare.updateStandard", lin, { ...base, id: created.id, name: "同款判断" })).error?.message).toContain("已经有叫")

    const used = await create(wang, { imageA: { base64: imgA.toString("base64") }, imageB: { base64: imgC.toString("base64") }, standard: "形状和比例" })
    await finished(used.id)

    await mutate(ctx.app, "compare.setDefaultStandard", lin, { id: created.id })
    const list = (await query(ctx.app, "compare.standards", wang)).data
    expect(list[0]).toMatchObject({ id: created.id, isDefault: true })
    expect(list.filter((each: { isDefault: boolean }) => each.isDefault)).toHaveLength(1)
    expect((await mutate(ctx.app, "compare.deleteStandard", lin, { id: created.id })).error?.message).toContain("先把别的标准设成默认")
    // 不给标准也不给要求：用新的默认标准
    expect(await create(wang, { imageA: { base64: imgB.toString("base64") }, imageB: { base64: imgC.toString("base64") } })).toMatchObject({ standardId: created.id, passScore: 75 })

    await mutate(ctx.app, "compare.setDefaultStandard", lin, { id: "std-same-item" })
    expect((await mutate(ctx.app, "compare.deleteStandard", lin, { id: created.id })).data).toEqual({ id: created.id })
    const after = (await query(ctx.app, "compare.get", wang, { id: used.id })).data
    expect(after).toMatchObject({ standardId: null, standardName: "形状和比例" })
    const actions = (await ctx.db.select({ action: t.auditEvents.action }).from(t.auditEvents).where(eq(t.auditEvents.targetId, created.id))).map((row) => row.action)
    expect(actions).toEqual(expect.arrayContaining(["compare_standard.create", "compare_standard.update", "compare_standard.set_default", "compare_standard.delete"]))
  })
})

describe("HTTP 接口和 MCP", () => {
  let key: string
  const bearer = () => ({ authorization: `Bearer ${key}` })

  beforeAll(async () => {
    key = (await mutate(ctx.app, "apiKeys.create", lin, { name: "比图客户端" })).data.key
  })

  async function post(path: string, body: unknown, headers: Record<string, string> = bearer()) {
    const res = await ctx.app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) })
    return { status: res.status, body: (await res.json()) as any }
  }

  it("没带密钥、密钥不对：401", async () => {
    expect((await ctx.app.request("/api/compare")).status).toBe(401)
    expect((await post("/api/compare", {}, { authorization: "Bearer hk_wrong" })).status).toBe(401)
  })

  it("新比对默认等结果；?wait=false 立即返回；via = api、算在密钥创建人头上；图片地址完整，带密钥能下载", async () => {
    const imgF = await png(`<rect width="300" height="200" fill="#0ff"/>`)
    const waited = await post("/api/compare", { imageA: { base64: imgA.toString("base64") }, imageB: { base64: imgF.toString("base64") }, labelA: "原图" })
    expect(waited.status).toBe(201)
    expect(waited.body).toMatchObject({ status: "done", score: 97, passed: true, via: "api", createdById: "u-lin", apiKeyId: expect.any(String), reused: false })
    expect(waited.body.imageA.url).toMatch(/^http:\/\/localhost\/api\/compare\/files\/f-[0-9a-f]+$/)
    const file = await ctx.app.request(waited.body.imageA.url.replace("http://localhost", ""), { headers: bearer() })
    expect(file.status).toBe(200)
    expect(file.headers.get("content-type")).toBe("image/png")
    expect((await ctx.app.request("/api/compare/files/f-nothing", { headers: bearer() })).status).toBe(404)

    const quick = await post("/api/compare?wait=false", { imageA: { base64: imgF.toString("base64") }, imageB: { base64: imgA.toString("base64") } })
    expect(quick).toMatchObject({ status: 201, body: { status: "running" } })
    const reused = await post("/api/compare?wait=false", { imageA: { base64: imgF.toString("base64") }, imageB: { base64: imgA.toString("base64") } })
    expect(reused).toMatchObject({ status: 200, body: { id: quick.body.id, reused: true } })
    await finished(quick.body.id)

    const got = await ctx.app.request(`/api/compare/${quick.body.id}`, { headers: bearer() })
    expect(((await got.json()) as any).status).toBe("done")
    const list = (await (await ctx.app.request("/api/compare?status=done&limit=2", { headers: bearer() })).json()) as any
    expect(list.items).toHaveLength(2)
    expect(list.nextCursor).toEqual(expect.any(String))
    const again = await post(`/api/compare/${quick.body.id}/again`, {})
    expect(again).toMatchObject({ status: 201, body: { status: "done", via: "api" } })
    expect(again.body.id).not.toBe(quick.body.id)
    const removed = await ctx.app.request(`/api/compare/${again.body.id}`, { method: "DELETE", headers: bearer() })
    expect(removed.status).toBe(200)
    expect(((await (await ctx.app.request("/api/compare/standards", { headers: bearer() })).json()) as any).standards[0].id).toBe("std-same-item")
    expect(((await (await ctx.app.request("/api/compare/models", { headers: bearer() })).json()) as any).models[0].id).toBe(VISION)
    const bad = await post("/api/compare", { imageA: { url: "ftp://x" }, imageB: { base64: "abc" } })
    expect(bad.status).toBe(400)
  })

  it("multipart 传两个文件；idempotencyKey 不管多久都返回同一条", async () => {
    const form = new FormData()
    form.append("image_a", new File([new Uint8Array(imgB)], "左.png", { type: "image/png" }))
    form.append("image_b", new File([new Uint8Array(imgC)], "右.png", { type: "image/png" }))
    form.append("prompt", "multipart 比")
    form.append("idempotency_key", "job-42")
    const res = await ctx.app.request("/api/compare", { method: "POST", body: form, headers: bearer() })
    const body = (await res.json()) as any
    expect(res.status).toBe(201)
    expect(body).toMatchObject({ status: "done", imageA: { label: "左.png", from: "上传" }, imageB: { label: "右.png" }, standardId: null })
    await ctx.db.update(t.comparisons).set({ createdAt: new Date(Date.now() - 24 * 60 * 60_000) }).where(eq(t.comparisons.id, body.id))
    const same = await post("/api/compare", { imageA: { base64: imgB.toString("base64") }, imageB: { base64: imgC.toString("base64") }, prompt: "multipart 比", idempotencyKey: "job-42" })
    expect(same).toMatchObject({ status: 200, body: { id: body.id, reused: true } })
    const other = await post("/api/compare", { imageA: { base64: imgB.toString("base64") }, imageB: { base64: imgC.toString("base64") }, prompt: "multipart 比" })
    expect(other.body.id).not.toBe(body.id)
  })

  describe("MCP", () => {
    let n = 0
    async function rpc(method: string, params: unknown, auth = `Bearer ${key}`) {
      const res = await ctx.app.request("/api/compare/mcp", {
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
    const callTool = async (name: string, args: unknown) => (await rpc("tools/call", { name, arguments: args })).body.result

    it("没带密钥 401；工具名照 Lens", async () => {
      expect((await rpc("tools/list", {}, "")).status).toBe(401)
      const init = await rpc("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })
      expect(init.body.result.serverInfo.name).toBe("heyagent-compare")
      const list = await rpc("tools/list", {})
      expect(list.body.result.tools.map((tool: { name: string }) => tool.name).sort()).toEqual(
        ["compare_images", "get_comparison", "list_compare_standards", "list_comparisons", "list_vision_models", "submit_image_comparison"].sort()
      )
    })

    it("compare_images 等结果，字段蛇形；submit 立即返回；get、list、模型、标准；认不出的图 isError", async () => {
      const imgG = await png(`<rect width="300" height="200" fill="#f0f"/>`)
      const result = await callTool("compare_images", { image_a: `data:image/png;base64,${imgA.toString("base64")}`, image_b: imgG.toString("base64"), pass_score: 99, label_b: "候选" })
      expect(result.structuredContent).toMatchObject({
        status: "done",
        score: 97,
        passed: false,
        pass_score: 99,
        confidence: "high",
        verdict: expect.any(String),
        reasons: expect.any(Array),
        dimensions: expect.any(Array),
        differences: expect.any(Array),
        reused: false,
        url: expect.stringMatching(/^http:\/\/localhost\/#\/compare\?id=cmp-\d+$/),
      })
      const id = result.structuredContent.id
      const [row] = await ctx.db.select().from(t.comparisons).where(eq(t.comparisons.id, id))
      expect(row).toMatchObject({ via: "mcp", labelB: "候选" })

      const submitted = await callTool("submit_image_comparison", { image_a: imgG.toString("base64"), image_b: `http://127.0.0.1:${port}/a.png` })
      expect(submitted.structuredContent).toMatchObject({ status: "running" })
      await finished(submitted.structuredContent.id)
      expect((await callTool("get_comparison", { id: submitted.structuredContent.id })).structuredContent).toMatchObject({ status: "done", image_b: { from: `网址 http://127.0.0.1:${port}/a.png` } })
      const listed = (await callTool("list_comparisons", { limit: 1 })).structuredContent
      expect(listed.items).toHaveLength(1)
      expect(listed.next_cursor).toEqual(expect.any(String))
      expect((await callTool("list_vision_models", {})).structuredContent.models[0]).toMatchObject({ id: VISION, price_in: 0.01 })
      expect((await callTool("list_compare_standards", {})).structuredContent.standards[0]).toMatchObject({ id: "std-same-item", is_default: true, pass_score: 95 })
      const bad = await callTool("compare_images", { image_a: "/home/me/a.png", image_b: "img-1" })
      expect(bad.isError).toBe(true)
      expect(bad.content[0].text).toContain("认不出图片")
      expect((await callTool("get_comparison", { id: "cmp-0" })).isError).toBe(true)
    })
  })
})

describe("agent 的「比图」工具组", () => {
  let session: SessionRow
  let entries: ReturnType<typeof compareToolEntries>
  const tool = (id: string) => entries.find((entry) => entry.id === id)!

  beforeAll(async () => {
    ;[session] = (await ctx.db.select().from(t.sessions).limit(1)) as SessionRow[]
    entries = compareToolEntries({ db: ctx.db, session, snapshot: { attachments: [] } as unknown as SessionSnapshot })
  })

  it("比两张图（等结果）、看一条、比对记录、标准；没有删除", () => {
    expect(entries.map((entry) => entry.id)).toEqual(["compare.images", "compare.get", "compare.list", "compare.standards"])
    expect(tool("compare.images").jsonSchema).toMatchObject({ type: "object", required: ["image_a", "image_b"] })
  })

  it("用这次运行的截图比：记 via = agent、哪次运行、哪个任务；来源写「运行 … 的截图」；返回的文字短，不带图和地址；别的运行的文件用不了", async () => {
    const shot = await saveFile(ctx.db, { data: imgB, name: "screenshot.png", kind: "screenshot", sessionId: session.id })
    const other = await saveFile(ctx.db, { data: imgC, name: "other.png", kind: "upload" })
    const outcome = await tool("compare.images").execute({ image_a: `http://127.0.0.1:${port}/a.png`, image_b: { fileId: shot.id }, standard: "同款判断" })
    expect(outcome.isError).toBeFalsy()
    const result = JSON.parse(outcome.output)
    expect(result).toMatchObject({ status: "done", score: 97, passed: true, confidence: "高", verdict: expect.any(String), reasons: expect.any(Array), differences: expect.any(Array) })
    expect(outcome.output).not.toContain("/api/")
    const [row] = await ctx.db.select().from(t.comparisons).where(eq(t.comparisons.id, result.id))
    expect(row).toMatchObject({ via: "agent", sessionId: session.id, taskId: session.taskId, createdById: null, fromB: `运行 ${session.id} 的截图` })
    const denied = await tool("compare.images").execute({ image_a: { fileId: other.id }, image_b: { fileId: shot.id } })
    expect(denied).toMatchObject({ isError: true, output: expect.stringContaining("这次运行里没有文件") })

    const listed = JSON.parse((await tool("compare.list").execute({})).output)
    expect(listed.results.map((each: { id: string }) => each.id)).toEqual([result.id])
    expect(JSON.parse((await tool("compare.list").execute({ all: true, limit: 3 })).output).results).toHaveLength(3)
    expect(JSON.parse((await tool("compare.get").execute({ id: result.id })).output)).toMatchObject({ id: result.id, score: 97 })
    expect(JSON.parse((await tool("compare.standards").execute({})).output).standards[0]).toMatchObject({ id: "std-same-item", isDefault: true })
  })

  it("任务选了「比图」：快照和工具清单里有这一组（内置工具同步进了 tools 表）", async () => {
    const [row] = await ctx.db.select().from(t.tools).where(eq(t.tools.id, "compare"))
    expect(row).toMatchObject({ source: "builtin", name: "比图" })
  })
})
