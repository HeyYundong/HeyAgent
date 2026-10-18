// 比图页的演示数据（开发、测试用，不进正式环境）：两个比对标准，五条比对（达标、没达标、证据不足、比对中、没比成）。
// 图是用 SVG 画的杯子，sharp 转成 PNG 存成文件（kind = compare）。
import { and, asc, eq, sql } from "drizzle-orm"
import sharp from "sharp"
import { compareStandardId, comparisonId } from "@heyagent/shared"

import { SAME_ITEM_PROMPT } from "../compare/defaults.js"
import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { saveFile } from "../files/service.js"

export { SAME_ITEM_PROMPT }

function mug(body: string, handle: string, options: { stripe?: string; lid?: boolean; bg?: string } = {}) {
  const bg = options.bg ?? "#f4f1ec"
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="800" height="800"><rect width="400" height="400" fill="${bg}"/>
<ellipse cx="200" cy="330" rx="110" ry="14" fill="#00000018"/>
<path d="M110 120 h160 v170 q0 40 -40 40 h-80 q-40 0 -40 -40z" fill="${body}"/>
<path d="M270 160 q60 0 60 50 q0 50 -60 50" fill="none" stroke="${handle}" stroke-width="22"/>
<ellipse cx="190" cy="120" rx="80" ry="14" fill="#00000030"/>
${options.stripe ? `<rect x="110" y="200" width="160" height="22" fill="${options.stripe}"/>` : ""}
${options.lid ? `<rect x="104" y="96" width="172" height="26" rx="8" fill="${handle}"/>` : ""}</svg>`
}

const BOTTLE = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 400" width="800" height="800"><rect width="400" height="400" fill="#f4f1ec"/><rect x="160" y="60" width="80" height="40" rx="6" fill="#5b6470"/><rect x="140" y="100" width="120" height="240" rx="30" fill="#c2c8cf"/></svg>`

async function picture(db: Db, svg: string, name: string, userId: string) {
  const data = await sharp(Buffer.from(svg)).png().toBuffer()
  return saveFile(db, { data, name, mime: "image/png", kind: "compare", createdById: userId })
}

const nextNo = async (db: Db, seq: string) => Number((await db.execute<{ n: string }>(sql`select nextval(${seq}) as n`)).rows[0]!.n)

/** 插入演示数据：标准（已有同名的跳过）和五条比对。返回比对的 id */
export async function insertCompareFixtures(db: Db): Promise<string[]> {
  const [admin] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.role, "admin")).orderBy(asc(t.users.createdAt)).limit(1)
  if (!admin) throw new Error("库里还没有主管账号：先灌演示数据（pnpm db:seed）")
  const [vision] = await db.select({ id: t.models.id }).from(t.models).where(and(eq(t.models.vision, true), eq(t.models.kind, "chat"))).orderBy(asc(t.models.priceIn)).limit(1)
  const modelId = vision?.id ?? "openrouter/google/gemini-3.8-flash"
  const existing = await db.select({ id: t.compareStandards.id, name: t.compareStandards.name }).from(t.compareStandards)
  const ensure = async (name: string, prompt: string, passScore: number, isDefault: boolean, id?: string) => {
    const found = existing.find((each) => each.name === name)
    if (found) return found.id
    const newId = id ?? compareStandardId(await nextNo(db, "compare_standard_no_seq"))
    await db.insert(t.compareStandards).values({ id: newId, name, prompt, passScore, modelId, isDefault: isDefault && !existing.length, createdById: admin.id })
    return newId
  }
  const same = await ensure("同款判断", SAME_ITEM_PROMPT, 95, true, "std-same-item")
  const logo = await ensure("有没有别家的 LOGO", "看第二张图上有没有第一张图里没有的品牌标识、LOGO、水印文字，有就扣分并说明在哪。", 90, false)

  const ref = await picture(db, mug("#9aa3ad", "#7d868f", { stripe: "#d9dde1" }), "原商品.png", admin.id)
  const twin = await picture(db, mug("#97a1ab", "#7a838c", { stripe: "#d6dade", bg: "#ffffff" }), "候选1.png", admin.id)
  const black = await picture(db, mug("#2f3236", "#1e2023", { lid: true }), "候选2.png", admin.id)
  const grayLid = await picture(db, mug("#9aa3ad", "#7d868f", { lid: true, bg: "#eef2f5" }), "候选3.png", admin.id)
  const bottle = await picture(db, BOTTLE, "供应商发来的图.png", admin.id)

  const base = { labelA: "原商品", fromA: "上传", prompt: SAME_ITEM_PROMPT, passScore: 95, modelId, standardId: same, standardName: "同款判断", createdById: admin.id, via: "web" as const }
  const rows: (typeof t.comparisons.$inferInsert)[] = [
    {
      ...base,
      id: "",
      title: "保温杯 · 候选 1 号",
      status: "done",
      fileAId: ref.id,
      fileBId: twin.id,
      labelB: "候选（1688 主图）",
      fromB: "网址 https://detail.example.com/offer/1.html",
      dedupeKey: "fixture-1",
      score: 97,
      confidence: "high",
      verdict: "同款：轮廓、把手和中间那道浅色条纹都一样，只是背景和光线不同。",
      reasons: ["杯身比例、把手的弧度和位置完全一致", "中间浅色条纹的位置和宽度一致", "颜色同为浅灰，第二张略偏蓝，属于拍摄色差"],
      dimensions: [
        { name: "形态和结构", score: 98, note: "轮廓、比例、把手一致" },
        { name: "颜色", score: 94, note: "同为浅灰，第二张略偏冷" },
        { name: "材质", score: 95, note: "都是哑光表面" },
        { name: "图案和细节", score: 97, note: "中间条纹一致" },
      ],
      differences: ["背景：第一张米色，第二张纯白", "第二张颜色略偏冷"],
      costUsd: 0.0021,
      finishedAt: new Date(),
    },
    {
      ...base,
      id: "",
      title: "保温杯 · 候选 2 号",
      status: "done",
      fileAId: ref.id,
      fileBId: black.id,
      labelB: "候选（黑色带盖）",
      fromB: "图库 img-7",
      dedupeKey: "fixture-2",
      score: 61,
      confidence: "high",
      verdict: "不是同款：第二张多了杯盖、没有中间条纹，颜色也不同。",
      reasons: ["第二张有杯盖，第一张没有：结构不同", "第一张有中间浅色条纹，第二张没有", "颜色：浅灰 vs 黑色"],
      dimensions: [
        { name: "形态和结构", score: 58, note: "多了杯盖" },
        { name: "颜色", score: 20, note: "浅灰 vs 黑色" },
        { name: "材质", score: 85, note: "都像不锈钢喷涂" },
        { name: "图案和细节", score: 40, note: "没有中间条纹" },
      ],
      differences: ["第二张有杯盖", "第二张没有中间浅色条纹", "颜色不同：浅灰 vs 黑色"],
      costUsd: 0.0019,
      finishedAt: new Date(),
    },
    {
      ...base,
      id: "",
      title: "包装图有没有别家 LOGO",
      status: "done",
      fileAId: ref.id,
      fileBId: bottle.id,
      labelA: "我们的主图",
      labelB: "供应商发来的图",
      standardId: logo,
      standardName: "有没有别家的 LOGO",
      prompt: "看第二张图上有没有第一张图里没有的品牌标识、LOGO、水印文字，有就扣分并说明在哪。",
      passScore: 90,
      dedupeKey: "fixture-3",
      score: null,
      confidence: "low",
      verdict: "证据不足：第二张图里的商品和第一张不是一个东西，看不出要比的包装。",
      reasons: ["第二张是一个瓶子，不是第一张的杯子", "两张图都看不到包装"],
      differences: ["商品本身就不同"],
      costUsd: 0.0138,
      finishedAt: new Date(),
    },
    { ...base, id: "", title: "保温杯 · 候选 3 号", status: "running", fileAId: ref.id, fileBId: grayLid.id, labelB: "候选（子 SKU 灰色）", fromB: "上传", dedupeKey: "fixture-4" },
    {
      ...base,
      id: "",
      title: "供应商样图核对",
      status: "failed",
      fileAId: ref.id,
      fileBId: twin.id,
      labelB: "https://img.example.com/x.jpg",
      fromB: "网址 https://img.example.com/x.jpg",
      dedupeKey: "fixture-5",
      error: "模型返回的结果格式不对，已经重试过一次。可以「再比一次」，或者换一个模型。",
      via: "api",
      finishedAt: new Date(),
    },
  ]
  const ids: string[] = []
  for (const row of rows) {
    const id = comparisonId(await nextNo(db, "compare_no_seq"))
    await db.insert(t.comparisons).values({ ...row, id })
    ids.push(id)
  }
  return ids
}
