// 固化流程的演示数据（开发、测试用，不进正式环境，docs/dev/solidify.md 15.4）：在种子数据的一个浏览器任务上造出界面要看的各种样子。
// - 一个正式的固化流程（RT-<n>），任务开着「先跑流程」；5 个版本：启用过的旧版、没成功（不适合固化）、正在用的、不用（写了理由）、待审核（修的版本，带两轮试跑报告和停下时的截图）；
// - 运行：agent 办成的普通运行（固化的原料，能点「固化成流程」）、3 次脚本直接办成、1 次脚本停在第 2 步交给 agent 办完、2 次固化试跑（一次出错、一次停在提交前）；
//   第二期（17.2、17.3）：1 次脚本停在登录页等人处理（suspended，运行在等人）、1 次等人处理后接着跑完（resumes / replayed）、1 次脚本跑完验收反问 agent 接着做（agentAfter）；
//   第二期第二批（18.1、18.2）：1 次 agent 自己用 code.run（tools）写循环脚本（两段脚本：一段逐个打开商品页读详情、有一步出错；一段停在要人审批的那步），
//   1 次脚本直接办成、中间有两次判断（ha.judge）；
//   第三期第一批（19.8）：任务打开「允许直接调网站接口」；1 次 agent 用 browser.fetch 直接调接口（GET 200、POST 403、一次出错），
//   带一份 network/requests.jsonl（19 个请求 + 最后一行 end）；
// - 待审核的第 5 版带 2 条 HTTP 工具建议，正在用的第 3 版带 1 条；
// - 待审核的第 5 版是运行办成后系统自动固化的（auto，17.1）；
// - 一件「审核固化流程」（kind = routine）给任务负责人。
// 运行只插页面要的几列（没有快照和消息，不能「继续」）。重复跑会先删掉上一次插的（按 note 标记和这个任务的固化流程），再重新插。
import sharp from "sharp"
import {
  BROWSER_TOOL_ID,
  humanItemId,
  manualSessionId,
  routineId as makeRoutineId,
  routineTestSessionId,
  routineVersionId,
  NETWORK_LOG_NAME,
  NETWORK_LOG_PATH,
  type EventTrace,
  type HttpToolSuggestion,
  type NetworkLogLine,
  type RoutineTestReport,
  type SessionRoutineState,
} from "@heyagent/shared"
import { and, eq, inArray, like, sql } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { syncBuiltinTools } from "../engine/tools/builtin-defs.js"
import { saveFile } from "../files/service.js"

/** 用种子数据里的这个任务（每天打开榜单、记录新品、写日报：浏览器任务，适合演示固化） */
export const ROUTINE_FIXTURE_TASK = "T-1040"
/** 插的运行都写这个 note，重复跑时据此删掉 */
const FIXTURE_NOTE = "固化演示数据"
/** 演示运行的编号从这里开始（R-1040-901 起），不和种子里的撞 */
const FIRST_RUN_NO = 901

const nextNo = async (db: Db, seq: string) => Number((await db.execute<{ n: string }>(sql`select nextval(${seq}) as n`)).rows[0]!.n)
/** 几分钟前 */
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)
const DAY = 24 * 60

const RANK_URL = "https://shop.example.com/rank/new?cat=home"

/** 网站的源（演示用，example.com） */
const SHOP_ORIGIN = new URL(RANK_URL).origin
/** browser.fetch 在过程里的名字（工具名，19.4） */
const FETCH_TOOL_NAME = "浏览器：调网站接口"

/** 榜单接口返回的几个商品（从第 from 名起 count 个） */
const rankItems = (from: number, count: number) =>
  Array.from({ length: count }, (_, index) => ({ id: 10000 + from + index, name: `新品 ${from + index}`, price: Number((9.9 + (from + index) * 1.3).toFixed(2)), days: 1 + ((from + index) % 6) }))

const RANK_SHAPE = "{ code: number, data: { list: [{ id: number, name: string, price: number, days: number }], total: number } }"

/**
 * 网页自己调的接口记录（network/requests.jsonl，格式见 packages/shared/src/site-api.ts）：
 * 榜单分页、用户信息、收藏（POST，带 csrf；有一次 403）、统计上报连不上（status 0）、用 token 认证的开放接口（HTTP 工具建议的依据），
 * 同一个轮询接口记满 3 次，最后一行 end。started = 运行开始的毫秒时间
 */
function networkLog(started: number): string {
  const at = (second: number) => new Date(started + second * 1000).toISOString()
  const rank = (page: number) => `${SHOP_ORIGIN}/api/rank/new?cat=home&page=${page}&size=20`
  const lines: NetworkLogLine[] = []
  let seq = 0
  const add = (second: number, line: Omit<Extract<NetworkLogLine, { seq: number }>, "seq" | "at" | "type" | "page"> & { type?: "xhr" | "fetch" }) =>
    lines.push({ seq: ++seq, at: at(second), type: "fetch", page: RANK_URL, ...line })
  const cookie = { cookie: true, headers: [] }
  const rankBody = (page: number) => JSON.stringify({ code: 0, data: { list: rankItems((page - 1) * 20 + 1, 3), total: 60 } }).slice(0, -3) + "…"
  add(9, { method: "GET", url: rank(1), headers: ["accept", "x-requested-with"], auth: cookie, status: 200, responseType: "application/json", bytes: 18_342, shape: RANK_SHAPE, responseBody: rankBody(1), ms: 184 })
  add(9, { type: "xhr", method: "GET", url: `${SHOP_ORIGIN}/api/user/profile`, headers: ["accept"], auth: cookie, status: 200, responseType: "application/json", bytes: 412, shape: "{ code: number, data: { id: number, nickname: string, token: string, level: number } }", responseBody: '{"code":0,"data":{"id":3021,"nickname":"采购小王","token":"••••","level":2}}', ms: 66 })
  add(10, { method: "GET", url: `${SHOP_ORIGIN}/api/rank/tabs?cat=home`, headers: ["accept"], auth: cookie, status: 200, responseType: "application/json", bytes: 220, shape: "{ code: number, data: [{ key: string, label: string }] }", responseBody: '{"code":0,"data":[{"key":"hot","label":"热销榜"},{"key":"new","label":"新上架"}]}', ms: 48 })
  add(10, { method: "POST", url: `${SHOP_ORIGIN}/api/track`, headers: ["content-type"], auth: cookie, requestType: "application/json", requestBody: '{"event":"view","page":"rank_new"}', status: 0, error: "net::ERR_BLOCKED_BY_CLIENT" })
  for (let page = 2; page <= 3; page++)
    add(20 + page * 3, { method: "GET", url: rank(page), headers: ["accept", "x-requested-with"], auth: cookie, status: 200, responseType: "application/json", bytes: 18_100 + page * 37, shape: RANK_SHAPE, responseBody: rankBody(page), ms: 150 + page * 11 })
  const csrf = { header: "x-csrf-token", from: "meta" as const, name: "csrf-token" }
  add(30, { method: "POST", url: `${SHOP_ORIGIN}/api/favorites`, headers: ["content-type", "x-csrf-token"], auth: cookie, csrf, requestType: "application/json", requestBody: '{"itemId":10003}', status: 200, responseType: "application/json", bytes: 38, shape: "{ code: number, data: { favorited: boolean } }", responseBody: '{"code":0,"data":{"favorited":true}}', ms: 91 })
  add(32, { method: "POST", url: `${SHOP_ORIGIN}/api/favorites`, headers: ["content-type", "x-csrf-token"], auth: cookie, csrf, requestType: "application/json", requestBody: '{"itemId":10021}', status: 403, responseType: "application/json", bytes: 62, shape: "{ code: number, message: string }", responseBody: '{"code":40301,"message":"请先登录"}', ms: 88 })
  add(36, { method: "GET", url: `${SHOP_ORIGIN}/api/items/10003?fields=desc,material`, headers: ["accept"], auth: cookie, status: 200, responseType: "application/json", bytes: 2_310, shape: "{ code: number, data: { id: number, name: string, desc: string, material: string, images: [string] } }", responseBody: '{"code":0,"data":{"id":10003,"name":"新品 3","desc":"免打孔安装","material":"ABS","images":["https://img.example.com/10003-1.jpg"]}}', ms: 120 })
  for (const [index, page] of [1, 2].entries())
    add(40 + index * 4, { method: "GET", url: `${SHOP_ORIGIN}/openapi/v1/orders?status=paid&page=${page}`, headers: ["accept", "authorization"], auth: { cookie: false, headers: ["authorization"] }, status: 200, responseType: "application/json", bytes: 5_480, shape: "{ orders: [{ orderNo: string, status: string, amount: number, items: [{ sku: string, qty: number }] }], nextPageToken: string }", responseBody: `{"orders":[{"orderNo":"SO2026102${page}01","status":"paid","amount":59.8,"items":[{"sku":"HM-10003","qty":2}]}],"nextPageToken":"p${page + 1}"}`, ms: 210 })
  add(47, { method: "GET", url: `${SHOP_ORIGIN}/openapi/v1/items/10003/stock`, headers: ["accept", "x-api-key"], auth: { cookie: false, headers: ["x-api-key"] }, status: 200, responseType: "application/json", bytes: 96, shape: "{ sku: string, available: number, warehouse: string }", responseBody: '{"sku":"HM-10003","available":128,"warehouse":"US-West"}', ms: 75 })
  add(50, { method: "PUT", url: `${SHOP_ORIGIN}/api/cart/items/10003`, headers: ["content-type", "x-csrf-token"], auth: cookie, csrf, requestType: "application/json", requestBody: '{"qty":1}', status: 204, bytes: 0, ms: 70 })
  add(52, { method: "DELETE", url: `${SHOP_ORIGIN}/api/cart/items/10003`, headers: ["x-csrf-token"], auth: cookie, csrf, status: 204, bytes: 0, ms: 64 })
  add(55, { method: "POST", url: `${SHOP_ORIGIN}/api/search`, headers: ["content-type"], auth: cookie, requestType: "application/x-www-form-urlencoded", requestBody: "q=%E6%94%B6%E7%BA%B3&page=1&sid=••••", status: 200, responseType: "application/json", bytes: 9_870, shape: "{ code: number, data: { hits: [{ id: number, name: string, price: number }], total: number, nextPageToken: string } }", responseBody: '{"code":0,"data":{"hits":[{"id":10007,"name":"新品 7","price":18.9}],"total":132,"nextPageToken":"c2VhcmNoOjI="}}…', responseOmitted: 1_650, ms: 230 })
  add(56, { method: "GET", url: `${SHOP_ORIGIN}/api/cart/count`, headers: ["accept"], auth: cookie, status: 200, responseType: "application/json", bytes: 29, shape: "{ code: number, data: { count: number } }", responseBody: '{"code":0,"data":{"count":0}}', ms: 35 })
  for (let poll = 0; poll < 3; poll++)
    add(58 + poll * 5, { type: "xhr", method: "GET", url: `${SHOP_ORIGIN}/api/notice/unread`, headers: ["accept"], auth: cookie, status: 200, responseType: "application/json", bytes: 31, shape: "{ code: number, data: { count: number } }", responseBody: '{"code":0,"data":{"count":2}}', ms: 40 })
  lines.push({ end: true, skipped: 14, reason: "同一个网址（GET /api/notice/unread）已经记了 3 次，后面的轮询不再记；运行结束前又跳过了 14 个" })
  return lines.map((line) => JSON.stringify(line)).join("\n") + "\n"
}

/** 固化员建议建的 HTTP 工具（用 token 认证的开放接口，browser.fetch 调不了） */
const HTTP_SUGGESTIONS: HttpToolSuggestion[] = [
  {
    name: "查询已付款订单",
    summary: "按状态和页码查网店的订单列表，要看订单、对账时用",
    reason: "网页调 /openapi/v1/orders 时带的是 Authorization 请求头（不靠 cookie），browser.fetch 不能设 Authorization；建成 HTTP 工具以后不用打开页面就能翻订单。",
    http: {
      method: "GET",
      url: `${SHOP_ORIGIN}/openapi/v1/orders?status={status}&page={page}`,
      headers: { Authorization: "Bearer {{shop_api_token}}", Accept: "application/json" },
      params: [
        { name: "status", type: "string", required: true, description: "订单状态：paid、shipped……" },
        { name: "page", type: "string", required: false, description: "第几页，从 1 开始" },
      ],
    },
    secrets: ["shop_api_token"],
    requestSeqs: [10, 11],
  },
  {
    name: "查询商品库存",
    summary: "按商品 id 查可用库存和所在仓库",
    reason: "库存接口用 X-API-Key 认证，网页是自己加的这个请求头；建成 HTTP 工具，挑新品时可以顺带看有没有货。",
    http: {
      method: "GET",
      url: `${SHOP_ORIGIN}/openapi/v1/items/{itemId}/stock`,
      headers: { "X-API-Key": "{{shop_api_key}}" },
      params: [{ name: "itemId", type: "string", required: true, description: "商品 id（榜单接口里的 id）" }],
    },
    secrets: ["shop_api_key"],
    requestSeqs: [12],
  },
]

const inputSchema = {
  type: "object",
  properties: { $note: { type: "string", description: "立即运行时写的一句话" } },
  required: [],
}
const outputSchema = {
  type: "object",
  properties: {
    新品数: { type: "integer", description: "榜单上读到的新品个数（应该是 20）" },
    榜首商品: { type: "string", description: "新品榜第 1 名的商品名" },
    日报文件: { type: "string", description: "存下的日报文件名" },
  },
  required: ["新品数", "日报文件"],
}

const description = (tab: string) =>
  [
    "打开家居类新品榜",
    `点「${tab}」标签，等列表出来（也可能显示「暂无数据」）`,
    "读前 20 个新品：名字、价格、上架天数、链接",
    "按任务记忆里的规则筛：价格不超过 30 美元、上架不超过 7 天，取排在前面的 5 个",
    "写成日报存下（会改东西：提交前停）",
    "勾检查点，报结果",
  ].join("\n")

const code = (tab: string) => `import ha from "heyagent"

export default async function run(input) {
  await ha.browser.navigate({ url: "${RANK_URL}" })
  await ha.browser.click({ element: "${tab}标签", target: "getByRole('tab', { name: '${tab}' })" })
  const seen = await ha.browser.waitAny({
    list: "getByRole('row').nth(1)",
    empty: "getByText('暂无数据')",
  })
  if (seen === "empty")
    return ha.finish({ outcome: "not_achieved", summary: "榜单今天是空的", evidence: "页面显示「暂无数据」", reason: "榜单没有新品" })
  const { rows } = await ha.browser.extract({
    list: "getByRole('row')",
    fields: {
      名字: "getByRole('cell').nth(1)",
      价格: "getByRole('cell').nth(2)",
      上架天数: "getByRole('cell').nth(3)",
      链接: { target: "getByRole('link')", attr: "href" },
    },
    limit: 20,
  })
  await ha.checkpoint.mark({ checkpoint: 2, status: "done", record: \`读到 \${rows.length} 个新品\` })
  const picked = rows
    .filter((row) => Number(String(row.价格).replace("$", "")) <= 30 && Number(row.上架天数) <= 7)
    .slice(0, 5)
  const name = \`新品日报 \${ha.now().slice(5, 10)}.md\`
  const body = picked.map((row, i) => \`\${i + 1}. \${row.名字}（\${row.价格}，上架 \${row.上架天数} 天）\${row.链接}\`).join("\\n")
  await ha.commit("保存日报")
  await ha.file.save({ name, content: \`# 家居新品日报\\n\\n\${body}\\n\` })
  await ha.verified(\`空间里有「\${name}」\`)
  await ha.checkpoint.mark({ checkpoint: 4, status: "done", record: name })
  await ha.work.report({ data: { 新品数: rows.length, 榜首商品: String(rows[0]?.名字 ?? ""), 日报文件: name } })
  return ha.finish({ outcome: "achieved", summary: \`读了 \${rows.length} 个新品，挑了 \${picked.length} 个写进「\${name}」\`, evidence: \`日报文件 \${name}\` })
}
`

const assumptions = [
  "榜单默认按上架时间排，前 20 行就是前 20 个新品（每页 20 行，不翻页）",
  "「适合」按任务记忆里写死的规则筛：价格不超过 30 美元、上架不超过 7 天，取排在前面的 5 个",
  "榜单页不用登录",
]

/** 一张假的「停下时的截图」：画一个榜单页面（SVG 转 PNG） */
const SCREENSHOT_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 400" width="1280" height="800">
<rect width="640" height="400" fill="#f6f6f4"/>
<rect width="640" height="44" fill="#26282c"/>
<text x="20" y="28" font-family="sans-serif" font-size="16" fill="#ffffff">家居 · 新品榜</text>
<rect x="20" y="60" width="72" height="26" fill="#ffffff" stroke="#c9c9c9"/><text x="34" y="78" font-family="sans-serif" font-size="12" fill="#333">热销榜</text>
<rect x="96" y="60" width="72" height="26" fill="#26282c"/><text x="110" y="78" font-family="sans-serif" font-size="12" fill="#ffffff">新上架</text>
${Array.from({ length: 9 }, (_, i) => `<rect x="20" y="${100 + i * 30}" width="600" height="26" fill="${i % 2 ? "#ffffff" : "#ececea"}"/><text x="30" y="${118 + i * 30}" font-family="sans-serif" font-size="12" fill="#333">${i + 1}.  新品 ${i + 1}    $${(9.9 + i * 2.3).toFixed(2)}    上架 ${1 + (i % 6)} 天</text>`).join("")}
</svg>`

const trace = (routineStep: number | undefined, extra: EventTrace = {}): EventTrace => ({ ...(routineStep ? { routineStep } : {}), ...extra })

interface EventSpec {
  /** 开始后第几秒 */
  at: number
  kind: (typeof t.sessionEvents.$inferInsert)["kind"]
  title: string
  detail?: string
  toolId?: string
  input?: unknown
  output?: string
  ms?: number
  trace?: EventTrace
  tokensIn?: number
  tokensOut?: number
}

/** 脚本走的几步（navigate → click 标签 → wait_any → extract → 勾检查点 → 存日报 → 勾检查点 → 报结果 → 结束）。tab = 标签名；upTo = 只做到第几步 */
function routineSteps(tab: string, date: string, upTo = 9, from = 1): EventSpec[] {
  const all: Omit<EventSpec, "at">[] = [
    {
      kind: "tool",
      title: "打开家居类新品榜",
      toolId: "browser.navigate",
      input: { url: RANK_URL },
      output: "### Page\n- URL: " + RANK_URL + "\n- Title: 家居 · 新品榜",
      ms: 1_900,
      trace: { code: `await page.goto('${RANK_URL}');`, urlBefore: "about:blank", urlAfter: RANK_URL, title: "家居 · 新品榜" },
    },
    {
      kind: "tool",
      title: `点「${tab}」标签`,
      toolId: "browser.click",
      input: { element: `${tab}标签`, target: `getByRole('tab', { name: '${tab}' })` },
      output: "已点击",
      ms: 700,
      trace: { code: `await page.getByRole('tab', { name: '${tab}' }).click();`, urlBefore: RANK_URL, urlAfter: `${RANK_URL}&tab=new` },
    },
    { kind: "tool", title: "等列表出来", toolId: "browser.wait_any", input: { outcomes: { list: "getByRole('row').nth(1)", empty: "getByText('暂无数据')" } }, output: "出现了：list", ms: 400 },
    {
      kind: "tool",
      title: "读前 20 个新品",
      toolId: "browser.extract",
      input: { list: "getByRole('row')", fields: { 名字: "getByRole('cell').nth(1)", 价格: "getByRole('cell').nth(2)" }, limit: 20 },
      output: "| 名字 | 价格 | 上架天数 |\n|---|---|---|\n| 桌面理线盒 | $12.90 | 2 |\n| 可折叠硅胶收纳篮 | $9.90 | 3 |\n| …（共 20 行） | | |",
      ms: 600,
    },
    { kind: "tool", title: "勾上「新品 ≥ 20 个」", toolId: "checkpoint.mark", input: { checkpoint: 2, status: "done", record: "读到 20 个新品" }, output: "已记下", ms: 30 },
    { kind: "tool", title: `存下日报「新品日报 ${date}.md」`, toolId: "file.save", input: { name: `新品日报 ${date}.md` }, output: `已保存：新品日报 ${date}.md（1.2 KB）`, ms: 120 },
    { kind: "tool", title: "勾上「日报已保存」", toolId: "checkpoint.mark", input: { checkpoint: 4, status: "done", record: `新品日报 ${date}.md` }, output: "已记下", ms: 30 },
    { kind: "tool", title: "交回结果", toolId: "work.report", input: { data: { 新品数: 20, 榜首商品: "桌面理线盒", 日报文件: `新品日报 ${date}.md` } }, output: "已记下 3 项结果", ms: 20 },
    { kind: "tool", title: "报告办成了", toolId: "run.finish", input: { outcome: "achieved", summary: `读了 20 个新品，挑了 5 个写进「新品日报 ${date}.md」` }, output: "已收到，交给复核", ms: 20 },
  ]
  let second = 2
  return all.slice(from - 1, upTo).map((step, index) => {
    second += Math.max(1, Math.round((step.ms ?? 0) / 1000))
    return { ...step, at: second, trace: trace(from + index, step.trace) }
  })
}

/** 插入演示数据。返回固化流程、待审核的那一版、那件要人办的事、几次运行的 id */
export async function insertRoutineFixtures(db: Db): Promise<{ routineId: string; reviewVersionId: string; itemId: string; runIds: string[]; testRunIds: string[] }> {
  const [task] = await db.select().from(t.tasks).where(eq(t.tasks.id, ROUTINE_FIXTURE_TASK))
  if (!task) throw new Error(`库里没有任务 ${ROUTINE_FIXTURE_TASK}：先灌演示数据（pnpm db:seed）`)
  const [admin] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.role, "admin")).limit(1)
  const ownerId = task.ownerId
  const approverId = ownerId
  const modelId = task.modelId
  const [planDefault] = await db.select({ modelId: t.modelDefaults.modelId }).from(t.modelDefaults).where(eq(t.modelDefaults.role, "plan"))
  const solidifyModel = planDefault?.modelId ?? modelId

  // ---------- 先删掉上一次插的 ----------
  const old = await db.select({ id: t.routines.id }).from(t.routines).where(eq(t.routines.taskId, task.id))
  await db.delete(t.humanItems).where(and(eq(t.humanItems.kind, "routine"), eq(t.humanItems.taskId, task.id)))
  if (old.length) await db.delete(t.routines).where(inArray(t.routines.id, old.map((row) => row.id)))
  const oldRuns = await db.select({ id: t.sessions.id }).from(t.sessions).where(and(eq(t.sessions.taskId, task.id), eq(t.sessions.note, FIXTURE_NOTE)))
  if (oldRuns.length) {
    const ids = oldRuns.map((row) => row.id)
    await db.delete(t.files).where(inArray(t.files.sessionId, ids))
    await db.delete(t.sessions).where(inArray(t.sessions.id, ids))
  }
  // 上一次的试跑运行（id 以 RT- 开头，note 也是标记）已经在上面删了；保险起见再按 id 前缀删一遍这个任务的
  await db.delete(t.sessions).where(and(eq(t.sessions.taskId, task.id), like(t.sessions.id, "RT-%")))

  // ---------- 固化流程和版本 ----------
  const routine = makeRoutineId(await nextNo(db, "routine_no_seq"))
  const vid = (version: number) => routineVersionId(routine, version)
  let runNo = FIRST_RUN_NO
  const runId = () => manualSessionId(task.id, runNo++)

  // 运行（版本要引用它们，先定 id）
  const agentRunA = runId() // 10 天前 agent 办成：第 1 版、第 2 版的原料
  const agentRunB = runId() // 6 天前 agent 办成：第 3 版的原料
  const directRuns = [runId(), runId(), runId()] // 3 次脚本直接办成
  const fallbackRun = runId() // 今天：脚本停在第 2 步，agent 接着办完 → 第 5 版（修的版本）的原料
  const freshRun = runId() // 今天下午 agent 自己办成（没开先跑流程之前的那种）：能点「固化成流程」
  const suspendedRun = runId() // 刚才：脚本第 1 步打开榜单是登录页，停下等人登录，登录好接着跑（17.2）
  const resumedRun = runId() // 一天半前：脚本第 1 步遇到登录页，人登录后按记录跳过 1 步、接着跑完
  const agentAfterRun = runId() // 4 天前：脚本跑完报了办成，三方验收反问，agent 接着做完（17.3）
  const agentScriptRun = runId() // 今天中午：agent 自己写循环脚本（code.run 带 tools，18.1）
  const judgeRun = runId() // 两天半前：脚本直接办成，中间判断了两次（ha.judge，18.2）
  const fetchRun = runId() // 一个半小时前：agent 用 browser.fetch 直接调网站接口，记下了 network/requests.jsonl（19.8）
  const testRuns = [routineTestSessionId(vid(5), 1), routineTestSessionId(vid(5), 2)]
  const testRunV3 = routineTestSessionId(vid(3), 1)

  await db.insert(t.routines).values({
    id: routine,
    taskId: task.id,
    status: "active",
    activeVersion: 3,
    directStreak: 0,
    fallbackStreak: 1,
    pausedReason: null,
    createdAt: minutesAgo(10 * DAY),
  })
  // 打开「允许直接调网站接口」（19.8：一个打开了开关的任务）；种子里这个任务用的是旧的工具 id，挂上「浏览器」工具，
  // 任务详情、编辑弹窗里才有浏览器那几项
  await db.update(t.tasks).set({ routineMode: "first", allowBrowserFetch: true }).where(eq(t.tasks.id, task.id))
  await syncBuiltinTools(db)
  const linkedTools = await db.select({ refId: t.taskTools.refId }).from(t.taskTools).where(eq(t.taskTools.taskId, task.id))
  if (!linkedTools.some((row) => row.refId === BROWSER_TOOL_ID)) await db.insert(t.taskTools).values({ taskId: task.id, refId: BROWSER_TOOL_ID, position: linkedTools.length })

  // ---------- 运行 ----------
  type SessionInsert = typeof t.sessions.$inferInsert
  const base = (id: string, startMin: number, seconds: number): SessionInsert => ({
    id,
    taskId: task.id,
    status: "done",
    modelId,
    triggeredBy: "cron",
    startedAt: minutesAgo(startMin),
    endedAt: new Date(minutesAgo(startMin).getTime() + seconds * 1000),
    note: FIXTURE_NOTE,
  })
  const routineState = (version: number, startMin: number, seconds: number, rest: Partial<SessionRoutineState> & Pick<SessionRoutineState, "state" | "steps">): SessionRoutineState => ({
    routineId: routine,
    versionId: vid(version),
    version,
    mode: "run",
    startedAt: minutesAgo(startMin).toISOString(),
    endedAt: new Date(minutesAgo(startMin).getTime() + seconds * 1000).toISOString(),
    ms: seconds * 1000,
    commits: [],
    ...rest,
  })
  const dateOf = (startMin: number) => {
    const at = new Date(minutesAgo(startMin).getTime() + 8 * 3600_000)
    return `${String(at.getUTCMonth() + 1).padStart(2, "0")}-${String(at.getUTCDate()).padStart(2, "0")}`
  }

  const sessions: SessionInsert[] = []
  const events = new Map<string, EventSpec[]>()

  // agent 办成的两次（固化的原料）：一步一步想，花了 3 分多钟
  const agentEvents = (date: string, tab: string): EventSpec[] => [
    { at: 1, kind: "plan", title: "按任务步骤开始", detail: "4 个步骤", tokensIn: 5_800, tokensOut: 260 },
    { at: 9, kind: "tool", title: "打开家居类新品榜", toolId: "browser.navigate", input: { url: RANK_URL }, output: "### Page\n- Title: 家居 · 新品榜", ms: 2_100, tokensIn: 7_200, tokensOut: 120, trace: { code: `await page.goto('${RANK_URL}');`, urlBefore: "about:blank", urlAfter: RANK_URL, title: "家居 · 新品榜" } },
    { at: 24, kind: "tool", title: `点「${tab}」标签`, toolId: "browser.click", input: { element: `${tab}标签`, ref: "e31" }, output: "已点击", ms: 800, tokensIn: 11_900, tokensOut: 140, trace: { code: `await page.getByRole('tab', { name: '${tab}' }).click();`, urlBefore: RANK_URL, urlAfter: `${RANK_URL}&tab=new` } },
    { at: 70, kind: "tool", title: "看页面快照", toolId: "browser.snapshot", input: {}, output: "- table: 20 行 …", ms: 500, tokensIn: 19_400, tokensOut: 900 },
    { at: 130, kind: "think", title: "按任务记忆里的偏好挑了 5 个", detail: "价格都在 30 美元以内、上架不到一周。", tokensIn: 22_000, tokensOut: 1_400 },
    { at: 160, kind: "tool", title: `存下日报「新品日报 ${date}.md」`, toolId: "file.save", input: { name: `新品日报 ${date}.md` }, output: `已保存：新品日报 ${date}.md（1.2 KB）`, ms: 110, tokensIn: 23_500, tokensOut: 1_100 },
    { at: 175, kind: "tool", title: "报告办成了", toolId: "run.finish", input: { outcome: "achieved" }, output: "已收到，交给复核", ms: 20, tokensIn: 24_100, tokensOut: 300 },
    { at: 190, kind: "verify", title: "AI 复核：办成", detail: "日报里 5 个商品都有名字、价格和链接。" },
    { at: 191, kind: "done", title: "办成了", detail: `读了 20 个新品，挑了 5 个写进「新品日报 ${date}.md」。` },
  ]
  for (const [id, startMin, tab] of [[agentRunA, 10 * DAY + 60, "新品榜"], [agentRunB, 6 * DAY + 60, "新品榜"], [freshRun, 120, "新上架"]] as const) {
    sessions.push({ ...base(id, startMin, 192), outcome: "achieved", outcomeBy: "review", outcomeReason: "日报里 5 个商品都有名字、价格和链接。", tokensIn: 114_000, tokensOut: 4_200, costUsd: 0.0412, stepCount: 7 })
    events.set(id, agentEvents(dateOf(startMin), tab))
  }

  // 3 次脚本直接办成：9 步、十几秒，没调执行模型（只有复核花了一点钱）
  directRuns.forEach((id, index) => {
    const startMin = (3 - index) * DAY + 60
    const date = dateOf(startMin)
    const steps = routineSteps("新品榜", date)
    const seconds = steps.at(-1)!.at + 2
    sessions.push({
      ...base(id, startMin, seconds + 4),
      outcome: "achieved",
      outcomeBy: "review",
      outcomeReason: "脚本报了办成；日报里 5 个商品都有名字、价格和链接。",
      costUsd: 0.0006,
      routine: routineState(3, startMin, seconds, {
        state: "finished",
        steps: steps.length,
        commits: [{ step: 6, label: "保存日报", verified: `空间里有「新品日报 ${date}.md」` }],
        input: {},
        logs: ["挑出 5 个新品"],
      }),
    })
    events.set(id, [
      { at: 1, kind: "plan", title: "先跑固化流程「读家居新品榜、写日报」第 3 版", detail: "不调执行模型；脚本跑不通时交给 agent 接着做" },
      ...steps,
      { at: seconds + 2, kind: "verify", title: "AI 复核：办成", detail: "日报里 5 个商品都有名字、价格和链接。" },
      { at: seconds + 3, kind: "done", title: "办成了", detail: `读了 20 个新品，挑了 5 个写进「新品日报 ${date}.md」。` },
    ])
  })

  // 今天上午：脚本停在第 2 步（标签改了名字），agent 接着办完
  {
    const startMin = 300
    const date = dateOf(startMin)
    const reason = "找不到 getByRole('tab', { name: '新品榜' })：页面可能改版了"
    const handoff = [
      "（系统）这次运行先按固化流程「读家居新品榜、写日报」第 3 版跑了，做到第 2 步停下：",
      `1. navigate ${RANK_URL} ✓`,
      `2. ✗ click「新品榜标签」：${reason}`,
      "会改东西的步骤：一步都还没做。",
      `现在的页面：「家居 · 新品榜」 ${RANK_URL}`,
      "请从现在的页面接着把任务办完，前面做过的不要重复。",
    ].join("\n")
    sessions.push({
      ...base(fallbackRun, startMin, 104),
      outcome: "achieved",
      outcomeBy: "review",
      outcomeReason: "agent 接着做完了；日报里 5 个商品都有名字、价格和链接。",
      tokensIn: 48_000,
      tokensOut: 2_100,
      costUsd: 0.0175,
      stepCount: 4,
      routine: routineState(3, startMin, 4, {
        state: "fell_back",
        steps: 2,
        stoppedAt: { step: 2, kind: "step_error", tool: "browser.click", label: "click「新品榜标签」", reason },
        input: {},
      }),
    })
    events.set(fallbackRun, [
      { at: 1, kind: "plan", title: "先跑固化流程「读家居新品榜、写日报」第 3 版", detail: "不调执行模型；脚本跑不通时交给 agent 接着做" },
      ...routineSteps("新品榜", date, 1),
      { at: 4, kind: "tool", title: "点「新品榜」标签 · 出错", toolId: "browser.click", input: { element: "新品榜标签", target: "getByRole('tab', { name: '新品榜' })" }, output: `出错：${reason}`, ms: 5_000, trace: { routineStep: 2, urlBefore: RANK_URL } },
      { at: 5, kind: "plan", title: "固化流程停在第 2 步，交给 agent 接着做", detail: handoff },
      { at: 22, kind: "tool", title: "看页面快照", toolId: "browser.snapshot", input: {}, output: "- tablist: 热销榜 / 新上架 …", ms: 500, tokensIn: 12_000, tokensOut: 300 },
      { at: 38, kind: "tool", title: "点「新上架」标签", toolId: "browser.click", input: { element: "新上架标签", ref: "e18" }, output: "已点击", ms: 700, tokensIn: 13_500, tokensOut: 160, trace: { code: "await page.getByRole('tab', { name: '新上架' }).click();", urlBefore: RANK_URL, urlAfter: `${RANK_URL}&tab=new` } },
      { at: 60, kind: "tool", title: "读前 20 个新品", toolId: "browser.extract", input: { list: "getByRole('row')", limit: 20 }, output: "20 行", ms: 600, tokensIn: 15_000, tokensOut: 900 },
      { at: 92, kind: "tool", title: `存下日报「新品日报 ${date}.md」`, toolId: "file.save", input: { name: `新品日报 ${date}.md` }, output: `已保存：新品日报 ${date}.md（1.2 KB）`, ms: 110, tokensIn: 7_500, tokensOut: 740 },
      { at: 100, kind: "verify", title: "AI 复核：办成", detail: "日报里 5 个商品都有名字、价格和链接。" },
      { at: 101, kind: "done", title: "办成了", detail: `agent 接着做完：读了 20 个新品，挑了 5 个写进「新品日报 ${date}.md」。` },
    ])
  }

  // 刚才：脚本第 1 步打开榜单是登录页（登录过期了），停下等人登录；运行在等人处理，登录好按记录接着跑
  const loginReason = "打开后是登录页（登录过期了），等人登录"
  {
    const startMin = 30
    sessions.push({
      ...base(suspendedRun, startMin, 0),
      status: "needs_human",
      endedAt: null,
      routine: routineState(3, startMin, 0, {
        state: "suspended",
        steps: 1,
        endedAt: undefined,
        ms: undefined,
        stoppedAt: { step: 1, kind: "suspend", tool: "browser.navigate", label: "navigate 家居类新品榜", reason: loginReason },
        input: {},
      }),
    })
    events.set(suspendedRun, [
      { at: 1, kind: "plan", title: "先跑固化流程「读家居新品榜、写日报」第 3 版", detail: "不调执行模型；脚本跑不通时交给 agent 接着做" },
      { ...routineSteps("新品榜", dateOf(startMin), 1)[0]!, output: "### Page\n- URL: https://shop.example.com/login\n- Title: 登录" },
      { at: 5, kind: "wait", title: "固化流程停在第 1 步：要人处理", detail: `${loginReason}。处理好以后脚本按记录接着跑，前面做过的不重做。` },
    ])
  }

  // 一天半前：同样遇到登录页，人登录好以后脚本接着跑（第 1 步按记录跳过），跑完办成
  {
    const startMin = DAY + 12 * 60
    const date = dateOf(startMin)
    const steps = routineSteps("新品榜", date)
    const waitSeconds = 240
    const late = steps.slice(1).map((step) => ({ ...step, at: step.at + waitSeconds }))
    const seconds = late.at(-1)!.at + 2
    sessions.push({
      ...base(resumedRun, startMin, seconds + 4),
      outcome: "achieved",
      outcomeBy: "review",
      outcomeReason: "脚本报了办成；日报里 5 个商品都有名字、价格和链接。",
      costUsd: 0.0006,
      routine: routineState(3, startMin, seconds, {
        state: "finished",
        steps: steps.length,
        commits: [{ step: 6, label: "保存日报", verified: `空间里有「新品日报 ${date}.md」` }],
        input: {},
        resumes: 1,
        replayed: 1,
      }),
    })
    events.set(resumedRun, [
      { at: 1, kind: "plan", title: "先跑固化流程「读家居新品榜、写日报」第 3 版", detail: "不调执行模型；脚本跑不通时交给 agent 接着做" },
      { ...steps[0]!, output: "### Page\n- URL: https://shop.example.com/login\n- Title: 登录" },
      { at: 5, kind: "wait", title: "固化流程停在第 1 步：要人处理", detail: `${loginReason}。处理好以后脚本按记录接着跑，前面做过的不重做。` },
      { at: waitSeconds, kind: "resume", title: "脚本接着跑：前 1 步按记录跳过，从第 2 步接着做", detail: "负责人登录好了。" },
      ...late,
      { at: seconds + 2, kind: "verify", title: "AI 复核：办成", detail: "日报里 5 个商品都有名字、价格和链接。" },
      { at: seconds + 3, kind: "done", title: "办成了", detail: `读了 20 个新品，挑了 5 个写进「新品日报 ${date}.md」。` },
    ])
  }

  // 4 天前：脚本跑完报了办成，三方验收反问「日报里有没有链接」，agent 接着补上链接（不算直接办成，也不算交给 agent）
  {
    const startMin = 4 * DAY + 60
    const date = dateOf(startMin)
    const steps = routineSteps("新品榜", date)
    const scriptSeconds = steps.at(-1)!.at + 1
    sessions.push({
      ...base(agentAfterRun, startMin, scriptSeconds + 70),
      outcome: "achieved",
      outcomeBy: "verify",
      outcomeReason: "三方验收通过：补上链接以后 5 个商品都有名字、价格和链接。",
      tokensIn: 21_000,
      tokensOut: 900,
      costUsd: 0.0081,
      stepCount: 2,
      routine: routineState(3, startMin, scriptSeconds, {
        state: "finished",
        steps: steps.length,
        commits: [{ step: 6, label: "保存日报", verified: `空间里有「新品日报 ${date}.md」` }],
        input: {},
        agentAfter: true,
      }),
    })
    events.set(agentAfterRun, [
      { at: 1, kind: "plan", title: "先跑固化流程「读家居新品榜、写日报」第 3 版", detail: "不调执行模型；脚本跑不通时交给 agent 接着做" },
      ...steps,
      { at: scriptSeconds + 5, kind: "verify", title: "三方验收：有疑问", detail: "日报里第 3 个商品没有链接，补上再报。" },
      { at: scriptSeconds + 30, kind: "tool", title: `改日报「新品日报 ${date}.md」`, toolId: "file.edit", input: { name: `新品日报 ${date}.md` }, output: "已改", ms: 90, tokensIn: 12_000, tokensOut: 500 },
      { at: scriptSeconds + 50, kind: "tool", title: "报告办成了", toolId: "run.finish", input: { outcome: "achieved" }, output: "已收到，交给验收", ms: 20, tokensIn: 9_000, tokensOut: 400 },
      { at: scriptSeconds + 65, kind: "verify", title: "三方验收：通过", detail: "补上链接以后 5 个商品都有名字、价格和链接。" },
      { at: scriptSeconds + 66, kind: "done", title: "办成了", detail: `agent 补上了链接：「新品日报 ${date}.md」。` },
    ])
  }

  // 今天中午：agent 读完榜单，写了一段 node 脚本（code.run 带 tools）逐个打开 3 个候选的详情页读描述；第 3 个页面读不到，脚本接住了。
  // 第二段脚本要存 2 个文件，第 2 个碰到「存文件要审批」的规则停下，agent 单独调用存完
  {
    const startMin = 90
    const date = dateOf(startMin)
    const products = [
      { name: "桌面理线盒", url: "https://shop.example.com/item/10231" },
      { name: "可折叠硅胶收纳篮", url: "https://shop.example.com/item/10457" },
      { name: "磁吸厨房挂钩", url: "https://shop.example.com/item/10892" },
    ]
    const callA = "call_6f2d0c9a1e"
    const callB = "call_b81e47d203"
    const loop = `import ha from "heyagent"

const items = ${JSON.stringify(products.map((p) => p.url))}
const out = []
for (const url of items) {
  await ha.browser.navigate({ url })
  try {
    const { rows } = await ha.browser.extract({ list: "main", fields: { 描述: "getByTestId('desc')", 材质: "getByText(/材质/)" }, limit: 1 })
    out.push({ url, ...rows[0] })
  } catch (error) {
    ha.log(\`读不到 \${url}：\${error.message}\`)
    out.push({ url, 描述: "" })
  }
}
console.log(JSON.stringify(out, null, 2))
`
    const loopSteps: EventSpec[] = products.flatMap((product, index) => {
      const at = 40 + index * 4
      const step = index * 2 + 1
      const failed = index === 2
      return [
        { at, kind: "tool", title: "打开网页", toolId: "browser.navigate", input: { url: product.url }, output: `### Page\n- URL: ${product.url}\n- Title: ${product.name}`, ms: 1_600, trace: { scriptStep: step, scriptCallId: callA, urlAfter: product.url, title: product.name } },
        failed
          ? { at: at + 2, kind: "tool", title: "读取列表（出错）", toolId: "browser.extract", input: { list: "main", limit: 1 }, output: "出错：找不到 getByTestId('desc')：这个商品页没有描述区", ms: 5_000, trace: { scriptStep: step + 1, scriptCallId: callA } }
          : { at: at + 2, kind: "tool", title: "读取列表", toolId: "browser.extract", input: { list: "main", limit: 1 }, output: `| 描述 | 材质 |\n|---|---|\n| ${product.name}，免打孔安装 | ABS |`, ms: 500, trace: { scriptStep: step + 1, scriptCallId: callA } },
      ] satisfies EventSpec[]
    })
    const save = `import ha from "heyagent"

const details = ${JSON.stringify(products.map((p) => ({ url: p.url })))}
await ha.file.save({ name: "候选详情.json", content: JSON.stringify(details, null, 2) })
await ha.file.save({ name: "新品日报 ${date}.md", content: "# 家居新品日报\\n…" })
`
    sessions.push({ ...base(agentScriptRun, startMin, 150), outcome: "achieved", outcomeBy: "review", outcomeReason: "日报里 5 个商品都有名字、价格和链接，3 个候选补了描述。", tokensIn: 86_000, tokensOut: 5_300, costUsd: 0.0318, stepCount: 9 })
    events.set(agentScriptRun, [
      { at: 1, kind: "plan", title: "按任务步骤开始", detail: "4 个步骤", tokensIn: 5_800, tokensOut: 260 },
      { at: 9, kind: "tool", title: "打开家居类新品榜", toolId: "browser.navigate", input: { url: RANK_URL }, output: "### Page\n- Title: 家居 · 新品榜", ms: 2_100, tokensIn: 7_200, tokensOut: 120 },
      { at: 20, kind: "tool", title: "读前 20 个新品", toolId: "browser.extract", input: { list: "getByRole('row')", limit: 20 }, output: "20 行", ms: 600, tokensIn: 11_000, tokensOut: 400 },
      { at: 36, kind: "think", title: "要逐个打开 3 个候选读描述：写一段脚本循环做", detail: "先手动看过一个商品页，描述在 `data-testid=desc` 里；3 个页面结构一样，用 code.run（tools）一次做完。", tokensIn: 14_000, tokensOut: 900 },
      ...loopSteps,
      {
        at: 54,
        kind: "tool",
        title: "运行代码",
        toolId: "code.run",
        input: { language: "node", code: loop, tools: true, timeout: 120 },
        output: [
          "退出码 0 · 用时 13.4 秒",
          "--- stdout ---",
          JSON.stringify(products.map((p, i) => ({ url: p.url, 描述: i === 2 ? "" : `${p.name}，免打孔安装` })), null, 2),
          "--- stderr ---",
          `读不到 ${products[2]!.url}：找不到 getByTestId('desc')：这个商品页没有描述区`,
          "--- 脚本调的工具 ---",
          "脚本调了 6 次工具（出错 1 次）：browser.navigate 3 次、browser.extract 3 次（出错 1 次）",
          `最后一次出错：第 6 步 读取列表：找不到 getByTestId('desc')：这个商品页没有描述区`,
        ].join("\n"),
        ms: 13_400,
        tokensIn: 16_500,
        tokensOut: 1_200,
        trace: { scriptCallId: callA },
      },
      { at: 80, kind: "tool", title: "存文件", toolId: "file.save", input: { name: "候选详情.json" }, output: "已保存：候选详情.json（0.6 KB）", ms: 110, trace: { scriptStep: 1, scriptCallId: callB } },
      { at: 81, kind: "rule", title: "规则「存日报要审批」：code.run 脚本的第 2 步 存文件 要人审批，没做", detail: "要存「新品日报」开头的文件，规则要求先交给人审批。脚本里不做要审批的动作，脚本停在这一步之前，已让 agent 单独调用这一步。", trace: { scriptStep: 2, scriptCallId: callB } },
      {
        at: 82,
        kind: "tool",
        title: "运行代码（出错）",
        toolId: "code.run",
        input: { language: "node", code: save, tools: true, timeout: 60 },
        output: [
          "退出码 1 · 用时 1.8 秒",
          "--- stderr ---",
          "StepError: 规则「存日报要审批」要人审批",
          "--- 脚本调的工具 ---",
          "脚本调了 2 次工具：file.save 2 次",
          "停在第 2 步：规则「存日报要审批」要人审批。这一步没做（脚本里不做要审批的动作）；要做的话单独调用它（file_save），系统会交给人审批。后面的步骤也没做。",
        ].join("\n"),
        ms: 1_800,
        tokensIn: 19_000,
        tokensOut: 700,
        trace: { scriptCallId: callB },
      },
      { at: 100, kind: "tool", title: `存下日报「新品日报 ${date}.md」`, toolId: "file.save", input: { name: `新品日报 ${date}.md` }, output: `已保存：新品日报 ${date}.md（1.4 KB）`, ms: 110, tokensIn: 20_500, tokensOut: 1_100 },
      { at: 120, kind: "tool", title: "报告办成了", toolId: "run.finish", input: { outcome: "achieved" }, output: "已收到，交给复核", ms: 20, tokensIn: 22_000, tokensOut: 300 },
      { at: 140, kind: "verify", title: "AI 复核：办成", detail: "日报里 5 个商品都有名字、价格和链接，3 个候选补了描述。" },
      { at: 141, kind: "done", title: "办成了", detail: `读了 20 个新品，挑了 5 个写进「新品日报 ${date}.md」，3 个候选补了描述（第 3 个商品页没有描述区）。` },
    ])
  }

  // 两天半前：脚本直接办成，读完榜单后判断了两次「算不算家居收纳类」（ha.judge 用执行模型，花费记在运行上，不算 agent 在想）
  {
    const startMin = 2 * DAY + 12 * 60
    const date = dateOf(startMin)
    const all = routineSteps("新品榜", date)
    const judges: EventSpec[] = [
      { at: 0, kind: "plan", title: "流程判断：「桌面理线盒」算不算家居收纳类？ → 算（理线盒放在桌面上收电线，属于桌面收纳）", detail: "选项：算、不算", tokensIn: 820, tokensOut: 60, ms: 1_300 },
      { at: 0, kind: "plan", title: "流程判断：「车载香薰（出风口款）」算不算家居收纳类？ → 不算（是车用香薰，不是家里用的，也不是收纳）", detail: "选项：算、不算", tokensIn: 790, tokensOut: 70, ms: 1_200 },
    ]
    // 前 4 步（打开、点标签、等列表、读列表）→ 两次判断 → 后面几步，桥的调用序号顺延
    const merged = [...all.slice(0, 4), ...judges, ...all.slice(4)]
    let second = 2
    const steps = merged.map((step, index) => {
      second += Math.max(1, Math.round((step.ms ?? 0) / 1000))
      return { ...step, at: second, trace: { ...step.trace, routineStep: index + 1 } }
    })
    const seconds = steps.at(-1)!.at + 2
    sessions.push({
      ...base(judgeRun, startMin, seconds + 4),
      outcome: "achieved",
      outcomeBy: "review",
      outcomeReason: "脚本报了办成；日报里 5 个商品都有名字、价格和链接。",
      tokensIn: 1_610,
      tokensOut: 130,
      costUsd: 0.0009,
      routine: routineState(3, startMin, seconds, {
        state: "finished",
        steps: steps.length,
        commits: [{ step: 8, label: "保存日报", verified: `空间里有「新品日报 ${date}.md」` }],
        input: {},
        logs: ["判断了 2 次，挑出 5 个新品"],
      }),
    })
    events.set(judgeRun, [
      { at: 1, kind: "plan", title: "先跑固化流程「读家居新品榜、写日报」第 3 版", detail: "不调执行模型；脚本跑不通时交给 agent 接着做" },
      ...steps,
      { at: seconds + 2, kind: "verify", title: "AI 复核：办成", detail: "日报里 5 个商品都有名字、价格和链接。" },
      { at: seconds + 3, kind: "done", title: "办成了", detail: `读了 20 个新品，判断了 2 个拿不准的，挑了 5 个写进「新品日报 ${date}.md」。` },
    ])
  }

  // 一个半小时前：任务开着「允许直接调网站接口」，agent 用 browser.fetch 直接读第 2 页（200）、收藏一个商品被拒（403）、
  // 刷新登录态的接口要跳转（出错）；运行记下了网页自己调的接口 network/requests.jsonl（第三期 19.8）
  const fetchStartMin = 90
  {
    const date = dateOf(fetchStartMin)
    const page2 = `${SHOP_ORIGIN}/api/rank/new?cat=home&page=2&size=20`
    sessions.push({ ...base(fetchRun, fetchStartMin, 75), outcome: "achieved", outcomeBy: "review", outcomeReason: "日报里 5 个商品都有名字、价格和链接。", tokensIn: 52_000, tokensOut: 2_400, costUsd: 0.0191, stepCount: 6 })
    events.set(fetchRun, [
      { at: 1, kind: "plan", title: "按任务步骤开始", detail: "4 个步骤", tokensIn: 5_800, tokensOut: 260 },
      { at: 8, kind: "tool", title: "打开家居类新品榜", toolId: "browser.navigate", input: { url: RANK_URL }, output: "### Page\n- Title: 家居 · 新品榜", ms: 2_100, tokensIn: 7_200, tokensOut: 120, trace: { urlBefore: "about:blank", urlAfter: RANK_URL, title: "家居 · 新品榜", network: { first: 1, last: 4 } } },
      { at: 15, kind: "tool", title: "读取文件", toolId: "file.read", input: { path: "network/requests.jsonl" }, output: "network/requests.jsonl（20 行）\n{\"seq\":1,…", ms: 40, tokensIn: 12_000, tokensOut: 200 },
      {
        at: 22,
        kind: "tool",
        title: FETCH_TOOL_NAME,
        toolId: "browser.fetch",
        input: { url: page2, method: "GET", headers: { accept: "application/json" } },
        output: `GET ${page2} → 200 application/json（17.9 KB，184 毫秒）\n${JSON.stringify({ code: 0, data: { list: rankItems(21, 3), total: 60 } }, null, 2)}\n…`,
        ms: 260,
        tokensIn: 15_400,
        tokensOut: 180,
        trace: { urlBefore: RANK_URL },
      },
      {
        at: 34,
        kind: "tool",
        title: FETCH_TOOL_NAME,
        toolId: "browser.fetch",
        input: { url: `${SHOP_ORIGIN}/api/favorites`, method: "POST", body: { itemId: 10021 }, csrf: { header: "x-csrf-token", from: "meta", name: "csrf-token" } },
        output: `POST ${SHOP_ORIGIN}/api/favorites → 403 application/json（62 字节，96 毫秒）\n多半登录过期了，先用 browser.navigate 打开网站的页面看看要不要登录\n${JSON.stringify({ code: 40301, message: "请先登录" }, null, 2)}`,
        ms: 150,
        tokensIn: 18_000,
        tokensOut: 160,
        trace: { urlBefore: RANK_URL },
      },
      {
        at: 41,
        kind: "tool",
        title: `${FETCH_TOOL_NAME}（出错）`,
        toolId: "browser.fetch",
        input: { url: `${SHOP_ORIGIN}/api/session/refresh`, method: "GET" },
        output: "工具出错：接口要跳转（多半登录过期了）：先用 browser.navigate 打开网站的页面看看",
        ms: 120,
        tokensIn: 18_600,
        tokensOut: 140,
        trace: { urlBefore: RANK_URL },
      },
      { at: 50, kind: "think", title: "收藏不是这次要做的事，跳过；前 20 个新品已经读到", tokensIn: 19_000, tokensOut: 600 },
      { at: 60, kind: "tool", title: `存下日报「新品日报 ${date}.md」`, toolId: "file.save", input: { name: `新品日报 ${date}.md` }, output: `已保存：新品日报 ${date}.md（1.2 KB）`, ms: 110, tokensIn: 20_500, tokensOut: 1_100 },
      { at: 66, kind: "tool", title: "报告办成了", toolId: "run.finish", input: { outcome: "achieved" }, output: "已收到，交给复核", ms: 20, tokensIn: 21_000, tokensOut: 300 },
      { at: 73, kind: "verify", title: "AI 复核：办成", detail: "日报里 5 个商品都有名字、价格和链接。" },
      { at: 74, kind: "done", title: "办成了", detail: `用接口读了 40 个新品，挑了 5 个写进「新品日报 ${date}.md」。` },
    ])
  }

  // 固化试跑：第 3 版 1 轮（通过）；第 5 版两轮：第 1 轮还按旧标签点、出错；第 2 轮停在提交前
  const testState = (version: number, startMin: number, seconds: number, rest: Partial<SessionRoutineState> & Pick<SessionRoutineState, "state" | "steps">): SessionRoutineState => ({
    ...routineState(version, startMin, seconds, rest),
    mode: "test",
    input: {},
  })
  const stopAtCommit = { step: 6, kind: "test_commit" as const, tool: "file.save", label: "保存日报", reason: "试跑走到第一个提交「保存日报」，停在它前面，没有做" }
  const recorded = { report: undefined, checkpoints: [{ checkpoint: 2, status: "done", record: "读到 20 个新品" }] }
  {
    const startMin = 6 * DAY
    const steps = routineSteps("新品榜", dateOf(startMin), 5)
    sessions.push({ ...base(testRunV3, startMin, 12), kind: "routine_test", triggeredBy: "manual", routine: testState(3, startMin, 11, { state: "stopped", steps: 5, stoppedAt: stopAtCommit, recorded }) })
    events.set(testRunV3, [...steps, { at: 12, kind: "done", title: "固化试跑结束：停在提交前「保存日报」" }])
  }
  const round1Error = "找不到 getByRole('tab', { name: '新品榜' })：标签现在叫「新上架」"
  {
    const startMin = 200
    const steps = routineSteps("新品榜", dateOf(startMin), 1)
    sessions.push({
      ...base(testRuns[0]!, startMin, 8),
      kind: "routine_test",
      triggeredBy: "manual",
      routine: testState(5, startMin, 7, { state: "stopped", steps: 2, stoppedAt: { step: 2, kind: "step_error", tool: "browser.click", label: "click「新品榜标签」", reason: round1Error } }),
    })
    events.set(testRuns[0]!, [
      ...steps,
      { at: 6, kind: "tool", title: "点「新品榜」标签 · 出错", toolId: "browser.click", input: { element: "新品榜标签", target: "getByRole('tab', { name: '新品榜' })" }, output: `出错：${round1Error}`, ms: 5_000, trace: { routineStep: 2, urlBefore: RANK_URL } },
      { at: 8, kind: "done", title: "固化试跑结束：第 2 步出错" },
    ])
  }
  {
    const startMin = 190
    const steps = routineSteps("新上架", dateOf(startMin), 5)
    sessions.push({
      ...base(testRuns[1]!, startMin, 12),
      kind: "routine_test",
      triggeredBy: "manual",
      routine: testState(5, startMin, 11, { state: "stopped", steps: 5, stoppedAt: stopAtCommit, recorded: { ...recorded, report: { 新品数: 20, 榜首商品: "桌面理线盒" } } }),
    })
    events.set(testRuns[1]!, [...steps, { at: 12, kind: "done", title: "固化试跑结束：停在提交前「保存日报」" }])
  }

  for (const session of sessions) {
    const list = events.get(session.id!) ?? []
    session.eventSeq = list.length
  }
  await db.insert(t.sessions).values(sessions)
  for (const session of sessions) {
    const list = events.get(session.id!) ?? []
    if (!list.length) continue
    const started = (session.startedAt as Date).getTime()
    await db.insert(t.sessionEvents).values(
      list.map((event, index) => ({
        sessionId: session.id!,
        seq: index + 1,
        at: new Date(started + event.at * 1000),
        kind: event.kind,
        title: event.title,
        detail: event.detail ?? null,
        toolId: event.toolId ?? null,
        input: event.input === undefined ? null : JSON.stringify(event.input),
        output: event.output ?? null,
        ms: event.ms ?? null,
        tokensIn: event.tokensIn ?? null,
        tokensOut: event.tokensOut ?? null,
        trace: event.trace && Object.keys(event.trace).length ? event.trace : null,
      }))
    )
  }

  // 第 5 版第 2 轮停下时的截图（存成那次试跑的文件）
  const shot = await saveFile(db, {
    data: await sharp(Buffer.from(SCREENSHOT_SVG)).png().toBuffer(),
    name: "停在提交前.png",
    mime: "image/png",
    kind: "screenshot",
    sessionId: testRuns[1]!,
    createdById: admin?.id,
  })

  // 直接调接口那次运行记下的网页请求（network/requests.jsonl，19 个请求 + 最后一行 end）
  await saveFile(db, {
    data: Buffer.from(networkLog(minutesAgo(fetchStartMin).getTime())),
    name: NETWORK_LOG_NAME,
    path: NETWORK_LOG_PATH,
    mime: "application/x-ndjson",
    kind: "network",
    sessionId: fetchRun,
    createdById: admin?.id,
  })

  // ---------- 版本 ----------
  const v3Report: RoutineTestReport = {
    rounds: [{ round: 1, sessionId: testRunV3, passed: true, steps: 5, stoppedAt: stopAtCommit, data: { 新品数: 20 }, compare: [{ field: "新品数", expected: "20", actual: "20", same: true }] }],
  }
  const v5Report: RoutineTestReport = {
    rounds: [
      { round: 1, sessionId: testRuns[0]!, passed: false, steps: 2, stoppedAt: { step: 2, kind: "step_error", tool: "browser.click", label: "click「新品榜标签」", reason: round1Error }, error: `第 2 步出错：${round1Error}` },
      {
        round: 2,
        sessionId: testRuns[1]!,
        passed: true,
        steps: 5,
        stoppedAt: stopAtCommit,
        data: { 新品数: 20, 榜首商品: "桌面理线盒" },
        compare: [
          { field: "新品数", expected: "20", actual: "20", same: true },
          { field: "榜首商品", expected: "可折叠硅胶收纳篮", actual: "桌面理线盒", same: false },
          { field: "日报文件", expected: `新品日报 ${dateOf(300)}.md`, actual: "（停在提交前，没存）", same: false },
        ],
        screenshotFileId: shot.id,
      },
    ],
  }
  const name = "读家居新品榜、写日报"
  type VersionInsert = typeof t.routineVersions.$inferInsert
  const common = (version: number, createdMin: number): VersionInsert => ({
    id: vid(version),
    routineId: routine,
    version,
    name,
    description: description("新品榜"),
    code: code("新品榜"),
    inputSchema,
    outputSchema,
    commits: ["保存日报"],
    assumptions,
    modelId: solidifyModel,
    tokensIn: 38_000,
    tokensOut: 4_600,
    costUsd: 0.031,
    createdById: ownerId,
    createdAt: minutesAgo(createdMin),
    round: 1,
  })
  await db.insert(t.routineVersions).values([
    // 第 1 版：启用过（后来被第 3 版换下），能「回到这一版」
    { ...common(1, 10 * DAY), sourceSessionId: agentRunA, status: "approved", approvedById: approverId, approvedAt: minutesAgo(10 * DAY - 30), code: code("新品榜").replace("    limit: 20,\n", ""), assumptions: assumptions.slice(0, 2) },
    // 第 2 版：没成功（固化员判断要看内容挑，不适合整段固化）
    {
      ...common(2, 8 * DAY),
      sourceSessionId: agentRunA,
      status: "failed",
      baseVersion: 1,
      code: "",
      description: "",
      assumptions: [],
      failReason: "固化员判断不适合固化：第 3 步「挑 5 个适合的」要看商品图和描述判断，写不成明确的规则。把挑选的标准写进任务记忆（例如价格、上架天数）以后可以再试。",
      costUsd: 0.008,
    },
    // 第 3 版：正在用（正式）；固化员建议建 1 个 HTTP 工具（固化流程区块显示一行）
    { ...common(3, 6 * DAY + 30), sourceSessionId: agentRunB, status: "approved", baseVersion: 1, testReport: v3Report, approvedById: approverId, approvedAt: minutesAgo(6 * DAY - 60), httpSuggestions: HTTP_SUGGESTIONS.slice(0, 1) },
    // 第 4 版：不用
    {
      ...common(4, 2 * DAY),
      sourceSessionId: directRuns[1],
      status: "rejected",
      baseVersion: 3,
      skipTest: true,
      description: description("新品榜").replace("写成日报存下", "写成表格存下"),
      rejectReason: "日报要 Markdown，不要表格；先不用这一版。",
      approvedById: null,
    },
    // 第 5 版：待审核（修的版本：标签改名了）。运行办成后系统自动固化的（没有人点，createdById 空）
    {
      ...common(5, 240),
      auto: true,
      createdById: null,
      sourceSessionId: fallbackRun,
      status: "review",
      baseVersion: 3,
      round: 2,
      description: description("新上架"),
      code: code("新上架"),
      assumptions: [...assumptions, "标签名是「新上架」（2026-10 网站改版后的名字）"],
      testReport: v5Report,
      // 两条 HTTP 工具建议（19.7、19.8）
      httpSuggestions: HTTP_SUGGESTIONS,
      tokensIn: 71_000,
      tokensOut: 8_900,
      costUsd: 0.058,
    },
  ])

  // ---------- 审核固化流程：给任务负责人 ----------
  const itemId = humanItemId("routine", await nextNo(db, "human_item_no_seq"))
  await db.insert(t.humanItems).values({
    id: itemId,
    kind: "routine",
    title: `审核固化流程「${name}」第 5 版`,
    summary: `运行 ${fallbackRun} 里脚本停在第 2 步、agent 接着办完，系统自动固化：固化员按新的做法修了一版`,
    assigneeId: ownerId,
    taskId: task.id,
    routineVersionId: vid(5),
    urgency: 3,
    detail: {
      sections: [],
      primary: "启用",
      secondary: "不用",
      done: ["已启用第 5 版", "进入试用期"],
      routine: { routineId: routine, versionId: vid(5), version: 5 },
    },
    createdAt: minutesAgo(180),
  })

  return { routineId: routine, reviewVersionId: vid(5), itemId, runIds: [agentRunA, agentRunB, ...directRuns, fallbackRun, freshRun, suspendedRun, resumedRun, agentAfterRun, agentScriptRun, judgeRun, fetchRun], testRunIds: [testRunV3, ...testRuns] }
}
