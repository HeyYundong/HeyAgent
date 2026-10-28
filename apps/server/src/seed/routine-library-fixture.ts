// 流程库的演示数据（开发、测试用，不进正式环境，docs/dev/routine-library.md 13.3 的 C 包）：直接写表，不经过发布接口、运行时，
// 流程页、任务弹窗、任务详情、运行过程要看的样子都造出来。
// - 4 个库流程，各有自己的来源任务（routines.task_id 唯一）上的固化流程（另有 E「读 Shopify 商品的规格」，来源 T-1012，转过正式、还没发布，发布弹窗第一次发布时能选）：
//   A「查 1688 工厂的报价和起订量」supplier_quote（来源 T-1035）：第 1、2、3 版转过正式，库里发布过两次（第 1 版、第 2 版），
//     第 3 版转正式了还没发布（详情、来源任务的区块都提示「可以发布」）；第 2 版比第 1 版多要一个必填参数（发布记录带不兼容改动）；
//     脚本里 ha.routine 调 B；T-1012、T-1024 在用；有 agent 调、脚本调的调用记录，有两次停下；
//   B「打开 1688 询盘页」login_inbox（来源 T-1036）：在库里，只被 A 调（「谁在用」列出调它的库流程）；
//   C「导出今天的询价表」export_quote_sheet（来源 T-1041）：连着 3 次停在第 2 步，自动停用；T-1019 在用（任务详情里标「停用」）；
//   D「查库存（旧）」old_stock_check（来源 T-1031）：撤下了。
// - tools 里每个在库里 / 停用的流程一行（source = routine，撤下的没有）；task_tools 里选用的任务。
// - 运行（调用方，note 标记）：T-1024 一次 agent 调 A 两次（一次跑完、一次停在第 3 步交回 agent）；T-1012 一次 agent 写 code.run 脚本循环调 A；
//   别的调用记录挂在几次只有摘要的运行上。过程记录带 trace.library（5.7），两层的 B 在 A 里面。
// 重复跑先删掉上一次插的（按来源任务上的固化流程、note 标记、routine.* 工具），再重新插。
import {
  BROWSER_TOOL_ID,
  manualSessionId,
  routineId as makeRoutineId,
  routineToolId,
  routineVersionId,
  type EventTrace,
  type LibraryTrace,
  type Risk,
  type RoutineCallResult,
  type RoutineCompatIssue,
  type RoutineRequires,
  type RoutineStopKind,
} from "@heyagent/shared"
import { and, eq, inArray, like, sql } from "drizzle-orm"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { syncBuiltinTools } from "../engine/tools/builtin-defs.js"

/** 插的运行都写这个 note，重复跑时据此删掉 */
const FIXTURE_NOTE = "流程库演示数据"
const FIRST_RUN_NO = 951

const nextNo = async (db: Db, seq: string) => Number((await db.execute<{ n: string }>(sql`select nextval(${seq}) as n`)).rows[0]!.n)
const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000)
const DAY = 24 * 60

const SHOP = "https://work.1688.example.com"
const INBOX_URL = `${SHOP}/inquiry/inbox`
const FACTORY_URLS = ["https://shop-hm.1688.example.com", "https://shop-lz.1688.example.com", "https://shop-yk.1688.example.com"]

interface RoutineSpec {
  key: "A" | "B" | "C" | "D" | "E"
  /** 只有来源任务上的固化流程（转过正式），还没发布进库：发布弹窗第一次发布时能选它 */
  unpublished?: true
  sourceTask: string
  slug: string
  title: string
  summary: string
  status: "listed" | "paused" | "withdrawn"
  /** 来源流程的版本：转过正式的标 proven */
  versions: { version: number; proven: boolean; description: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown>; commits: string[]; code: string }[]
  published: number
  /** 发布记录：版本、几天前、当时几个任务在用、不兼容改动 */
  publishes: { version: number; daysAgo: number; taskCount: number; compat: RoutineCompatIssue[] }[]
  requires: RoutineRequires
  risk: Risk
  failStreak: number
  pausedReason: string | null
  usedBy: string[]
}

const quoteInput = (withProduct: boolean) => ({
  type: "object",
  properties: {
    工厂链接: { type: "string", description: "1688 店铺首页的网址" },
    ...(withProduct ? { 商品: { type: "string", description: "要问的商品名，例如「硅胶折叠收纳篮」" } } : {}),
  },
  required: withProduct ? ["工厂链接", "商品"] : ["工厂链接"],
})
const quoteOutput = {
  type: "object",
  properties: {
    报价: { type: "string", description: "最近一次报价（带币种）" },
    起订量: { type: "integer", description: "最小起订量（件）" },
    交期: { type: "string", description: "工厂回复的交期" },
  },
  required: ["报价", "起订量"],
}
const quoteDescription = (tab: string) =>
  ["打开 1688 询盘页（调流程 login_inbox）", "打开工厂的店铺首页", `点「${tab}」`, "读最近一条报价：单价、起订量、交期", "交回报价、起订量、交期"].join("\n")
const quoteCode = (tab: string) => `import ha from "heyagent"

export default async function run(input) {
  await ha.routine("login_inbox", {})
  await ha.browser.navigate({ url: input.工厂链接 })
  await ha.browser.click({ element: "${tab}", target: "getByRole('tab', { name: '${tab}' })" })
  const { rows } = await ha.browser.extract({
    list: "getByRole('row')",
    fields: { 商品: "getByRole('cell').nth(0)", 报价: "getByRole('cell').nth(1)", 起订量: "getByRole('cell').nth(2)", 交期: "getByRole('cell').nth(3)" },
    limit: 5,
  })
  const row = rows.find((each) => !input.商品 || String(each.商品).includes(input.商品))
  if (!row) return ha.finish({ outcome: "not_achieved", summary: "这家工厂还没报过价", reason: "询价记录里没有这个商品" })
  await ha.work.report({ data: { 报价: String(row.报价), 起订量: Number(row.起订量), 交期: String(row.交期) } })
  return ha.finish({ outcome: "achieved", summary: \`\${row.报价}，起订量 \${row.起订量}\`, evidence: "询价记录第一行" })
}
`

const SPECS: RoutineSpec[] = [
  {
    key: "A",
    sourceTask: "T-1035",
    slug: "supplier_quote",
    title: "查 1688 工厂的报价和起订量",
    summary: "要知道某家 1688 工厂对某个商品报了什么价、起订量多少时用（给工厂店铺链接和商品名）",
    status: "listed",
    versions: [
      { version: 1, proven: true, description: quoteDescription("询价记录"), inputSchema: quoteInput(false), outputSchema: quoteOutput, commits: [], code: quoteCode("询价记录") },
      { version: 2, proven: true, description: quoteDescription("询价记录"), inputSchema: quoteInput(true), outputSchema: quoteOutput, commits: [], code: quoteCode("询价记录") },
      { version: 3, proven: true, description: quoteDescription("报价单"), inputSchema: quoteInput(true), outputSchema: { ...quoteOutput, properties: { 报价: quoteOutput.properties.报价, 起订量: quoteOutput.properties.起订量 } }, commits: [], code: quoteCode("报价单") },
      { version: 4, proven: false, description: quoteDescription("报价单"), inputSchema: quoteInput(true), outputSchema: quoteOutput, commits: [], code: quoteCode("报价单") },
    ],
    published: 2,
    publishes: [
      { version: 1, daysAgo: 12, taskCount: 0, compat: [] },
      { version: 2, daysAgo: 5, taskCount: 1, compat: [{ kind: "input_added_required", field: "商品", text: "新加了必填的参数「商品」" }] },
    ],
    requires: { toolIds: [BROWSER_TOOL_ID], browser: {}, routines: ["login_inbox"] },
    risk: "external",
    failStreak: 1,
    pausedReason: null,
    usedBy: ["T-1012", "T-1024"],
  },
  {
    key: "B",
    sourceTask: "T-1036",
    slug: "login_inbox",
    title: "打开 1688 询盘页",
    summary: "要在 1688 后台看询盘、报价之前先调它，打开询盘页并确认登录着",
    status: "listed",
    versions: [
      {
        version: 1,
        proven: true,
        description: ["打开 1688 询盘页", "等「询盘列表」出来（出来的是登录页就停下等人登录）"].join("\n"),
        inputSchema: {},
        outputSchema: {},
        commits: [],
        code: `import ha from "heyagent"

export default async function run() {
  await ha.browser.navigate({ url: "${INBOX_URL}" })
  const seen = await ha.browser.waitAny({ list: "getByRole('heading', { name: '询盘列表' })", login: "getByRole('button', { name: '登录' })" })
  if (seen === "login") return ha.fail("page", "打开后是登录页，要人登录")
  return ha.finish({ outcome: "achieved", summary: "询盘页打开了" })
}
`,
      },
    ],
    published: 1,
    publishes: [{ version: 1, daysAgo: 14, taskCount: 0, compat: [] }],
    requires: { toolIds: [BROWSER_TOOL_ID], browser: {}, routines: [] },
    risk: "read",
    failStreak: 0,
    pausedReason: null,
    usedBy: [],
  },
  {
    key: "C",
    sourceTask: "T-1041",
    slug: "export_quote_sheet",
    title: "导出今天的询价表",
    summary: "要拿今天全部询价的表格（Excel）时用，不用输入",
    status: "paused",
    versions: [
      {
        version: 1,
        proven: true,
        description: ["打开询价管理", "点「导出」，选「今天」", "保存下载的表格（会改东西）"].join("\n"),
        inputSchema: {},
        outputSchema: { type: "object", properties: { 文件: { type: "string", description: "存下的表格文件名" } }, required: ["文件"] },
        commits: ["导出表格"],
        code: `import ha from "heyagent"

export default async function run() {
  await ha.browser.navigate({ url: "${SHOP}/inquiry/manage" })
  await ha.browser.click({ element: "导出", target: "getByRole('button', { name: '导出' })" })
  await ha.commit("导出表格")
  const file = await ha.browser.download({ element: "今天", target: "getByRole('menuitem', { name: '今天' })" })
  await ha.work.report({ data: { 文件: file.name } })
  return ha.finish({ outcome: "achieved", summary: \`导出了 \${file.name}\` })
}
`,
      },
    ],
    published: 1,
    publishes: [{ version: 1, daysAgo: 9, taskCount: 0, compat: [] }],
    requires: { toolIds: [BROWSER_TOOL_ID], browser: { fetch: true }, routines: [] },
    risk: "external",
    failStreak: 3,
    pausedReason: "连着 3 次跑不通，自动停用：都停在第 2 步「点『导出』」（找不到 getByRole('button', { name: '导出' })，页面可能改版了）",
    usedBy: ["T-1019"],
  },
  {
    key: "D",
    sourceTask: "T-1031",
    slug: "old_stock_check",
    title: "查库存（旧）",
    summary: "查一个商品在仓库里还有多少",
    status: "withdrawn",
    versions: [
      {
        version: 1,
        proven: true,
        description: ["打开库存页", "搜商品", "读可用库存"].join("\n"),
        inputSchema: { type: "object", properties: { sku: { type: "string", description: "商品编码" } }, required: ["sku"] },
        outputSchema: { type: "object", properties: { 库存: { type: "integer" } }, required: ["库存"] },
        commits: [],
        code: `import ha from "heyagent"\n\nexport default async function run(input) {\n  return ha.finish({ outcome: "achieved", summary: input.sku })\n}\n`,
      },
    ],
    published: 1,
    publishes: [{ version: 1, daysAgo: 20, taskCount: 0, compat: [] }],
    requires: { toolIds: [BROWSER_TOOL_ID], browser: {}, routines: [] },
    risk: "read",
    failStreak: 0,
    pausedReason: null,
    usedBy: [],
  },
  {
    key: "E",
    unpublished: true,
    sourceTask: "T-1012",
    slug: "shopify_product",
    title: "读 Shopify 商品的规格",
    summary: "",
    status: "listed",
    versions: [
      {
        version: 1,
        proven: true,
        description: ["打开 Shopify 后台的商品页", "读标题、尺寸、材质、主图", "交回规格"].join("\n"),
        inputSchema: { type: "object", properties: { 商品链接: { type: "string", description: "Shopify 后台的商品网址" } }, required: ["商品链接"] },
        outputSchema: { type: "object", properties: { 标题: { type: "string" }, 尺寸: { type: "string" }, 材质: { type: "string" } }, required: ["标题"] },
        commits: [],
        code: `import ha from "heyagent"\n\nexport default async function run(input) {\n  await ha.browser.navigate({ url: input.商品链接 })\n  return ha.finish({ outcome: "achieved", summary: "读到了" })\n}\n`,
      },
    ],
    published: 0,
    publishes: [],
    requires: { toolIds: [BROWSER_TOOL_ID], browser: {}, routines: [] },
    risk: "read",
    failStreak: 0,
    pausedReason: null,
    usedBy: [],
  },
]

interface EventSpec {
  at: number
  kind: "plan" | "think" | "tool" | "done" | "verify" | "error"
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

/** 插入演示数据。返回四个库流程的编号和插的运行 */
export async function insertRoutineLibraryFixtures(db: Db): Promise<{ routines: Record<string, string>; runIds: string[] }> {
  const taskIds = [...new Set([...SPECS.map((spec) => spec.sourceTask), ...SPECS.flatMap((spec) => spec.usedBy)])]
  const tasks = await db.select().from(t.tasks).where(inArray(t.tasks.id, taskIds))
  for (const id of taskIds) if (!tasks.some((task) => task.id === id)) throw new Error(`库里没有任务 ${id}：先灌演示数据（pnpm db:seed）`)
  const taskOf = (id: string) => tasks.find((task) => task.id === id)!
  const [admin] = await db.select({ id: t.users.id }).from(t.users).where(eq(t.users.role, "admin")).limit(1)

  // ---------- 先删掉上一次插的 ----------
  await db.delete(t.tools).where(eq(t.tools.source, "routine"))
  const sourceTasks = SPECS.map((spec) => spec.sourceTask)
  await db.delete(t.routines).where(inArray(t.routines.taskId, sourceTasks))
  await db.delete(t.sessions).where(and(inArray(t.sessions.taskId, taskIds), eq(t.sessions.note, FIXTURE_NOTE)))
  await db.delete(t.taskTools).where(like(t.taskTools.refId, "routine.%"))

  await syncBuiltinTools(db)

  // ---------- 来源任务上的固化流程和版本 ----------
  const ids: Record<string, string> = {}
  for (const spec of SPECS) {
    const id = makeRoutineId(await nextNo(db, "routine_no_seq"))
    ids[spec.key] = id
    const latest = spec.versions.at(-1)!
    await db.insert(t.routines).values({
      id,
      taskId: spec.sourceTask,
      status: latest.proven ? "active" : "trial",
      activeVersion: latest.version,
      directStreak: latest.proven ? 0 : 1,
      createdAt: minutesAgo(20 * DAY),
    })
    await db.insert(t.routineVersions).values(
      spec.versions.map((each) => ({
        id: routineVersionId(id, each.version),
        routineId: id,
        version: each.version,
        status: "approved" as const,
        name: spec.title,
        description: each.description,
        code: each.code,
        inputSchema: each.inputSchema,
        outputSchema: each.outputSchema,
        commits: each.commits,
        assumptions: ["工厂的店铺、询盘页不用另外登录（Chrome 配置里登着 1688）"],
        round: 1,
        approvedById: taskOf(spec.sourceTask).ownerId,
        approvedAt: minutesAgo((18 - each.version * 3) * DAY),
        provenAt: each.proven ? minutesAgo((16 - each.version * 3) * DAY) : null,
        createdById: taskOf(spec.sourceTask).ownerId,
        createdAt: minutesAgo((19 - each.version * 3) * DAY),
      }))
    )
  }

  // ---------- 库里的登记、发布记录、tools 那一行、选用 ----------
  for (const spec of SPECS) {
    if (spec.unpublished) continue
    const id = ids[spec.key]!
    const last = spec.publishes.at(-1)!
    await db.insert(t.routineLibrary).values({
      routineId: id,
      slug: spec.slug,
      title: spec.title,
      summary: spec.summary,
      status: spec.status,
      publishedVersion: spec.published,
      requires: spec.requires,
      risk: spec.risk,
      failStreak: spec.failStreak,
      pausedReason: spec.pausedReason,
      publishedById: admin?.id ?? null,
      publishedAt: minutesAgo(last.daysAgo * DAY),
      createdAt: minutesAgo(spec.publishes[0]!.daysAgo * DAY),
    })
    await db.insert(t.routineLibraryVersions).values(
      spec.publishes.map((each) => ({
        routineId: id,
        version: each.version,
        publishedById: admin?.id ?? null,
        publishedAt: minutesAgo(each.daysAgo * DAY),
        requires: spec.requires,
        risk: spec.risk,
        compat: each.compat,
        taskCount: each.taskCount,
      }))
    )
    if (spec.status === "withdrawn") continue
    const version = spec.versions.find((each) => each.version === spec.published)!
    await db.insert(t.tools).values({
      id: routineToolId(spec.slug),
      name: spec.title,
      summary: spec.summary,
      description: `固化好的流程（几秒做完，不用你一步步操作）。\n什么时候用：${spec.summary}\n做什么：\n${version.description}`,
      source: "routine",
      routineId: id,
      risk: spec.risk,
    })
    for (const taskId of spec.usedBy) {
      const linked = await db.select({ refId: t.taskTools.refId }).from(t.taskTools).where(eq(t.taskTools.taskId, taskId))
      if (!linked.some((row) => row.refId === BROWSER_TOOL_ID)) await db.insert(t.taskTools).values({ taskId, refId: BROWSER_TOOL_ID, position: linked.length })
      await db.insert(t.taskTools).values({ taskId, refId: routineToolId(spec.slug), position: linked.length + 1 })
    }
  }

  // ---------- 调用方的运行 ----------
  type SessionInsert = typeof t.sessions.$inferInsert
  const sessions: SessionInsert[] = []
  const events = new Map<string, EventSpec[]>()
  const runNos = new Map<string, number>()
  const runId = (taskId: string) => {
    const no = runNos.get(taskId) ?? FIRST_RUN_NO
    runNos.set(taskId, no + 1)
    return manualSessionId(taskId, no)
  }
  const addRun = (taskId: string, startMin: number, seconds: number, rest: Partial<SessionInsert> = {}) => {
    const id = runId(taskId)
    sessions.push({
      id,
      taskId,
      status: "done",
      outcome: "achieved",
      outcomeBy: "review",
      outcomeReason: "报价、起订量都拿到了。",
      modelId: taskOf(taskId).modelId,
      triggeredBy: "manual",
      startedAt: minutesAgo(startMin),
      endedAt: new Date(minutesAgo(startMin).getTime() + seconds * 1000),
      note: FIXTURE_NOTE,
      ...rest,
    })
    return id
  }

  const A = ids.A!
  const B = ids.B!
  const lib = (routineId: string, version: number, step: number, callId: string, depth: number): { library: LibraryTrace } => ({ library: { routineId, version, step, callId, depth } })
  const quoteRow = (factory: number) => ({ 报价: ["¥12.50", "¥11.80", "¥13.20"][factory]!, 起订量: [500, 1000, 300][factory]!, 交期: ["15 天", "20 天", "12 天"][factory]! })

  /** A 第 2 版里的步骤（从 at 秒开始）：进 B → B 的两步 → B 跑完 → 打开店铺 → 点「询价记录」→ 读报价。stopAt = 停在 A 的第几步（出错） */
  const quoteSteps = (callId: string, at: number, factory: number, extra: (step: number) => EventTrace, stopAt?: number): EventSpec[] => {
    const url = FACTORY_URLS[factory]!
    const bCall = `${callId}-l1`
    const list: EventSpec[] = [
      { at, kind: "tool", title: "开始跑流程「打开 1688 询盘页」第 1 版", toolId: routineToolId("login_inbox"), input: {}, output: "进入流程「打开 1688 询盘页」第 1 版", ms: 5, trace: { ...extra(1), ...lib(A, 2, 1, callId, 1) } },
      { at: at + 1, kind: "tool", title: "打开 1688 询盘页", toolId: "browser.navigate", input: { url: INBOX_URL }, output: `### Page\n- URL: ${INBOX_URL}\n- Title: 询盘列表`, ms: 1_400, trace: { ...extra(2), ...lib(B, 1, 1, bCall, 2), code: `await page.goto('${INBOX_URL}');`, urlAfter: INBOX_URL, title: "询盘列表" } },
      { at: at + 2, kind: "tool", title: "等询盘列表出来", toolId: "browser.wait_any", input: { outcomes: { list: "getByRole('heading', { name: '询盘列表' })" } }, output: "出现了：list", ms: 300, trace: { ...extra(3), ...lib(B, 1, 2, bCall, 2) } },
      { at: at + 2, kind: "plan", title: "流程「打开 1688 询盘页」跑完：2 步 · 交回 —", trace: { ...extra(3), ...lib(A, 2, 1, callId, 1) } },
      { at: at + 4, kind: "tool", title: "打开工厂店铺", toolId: "browser.navigate", input: { url }, output: `### Page\n- URL: ${url}\n- Title: 工厂店铺`, ms: 1_600, trace: { ...extra(4), ...lib(A, 2, 2, callId, 1), code: `await page.goto('${url}');`, urlAfter: url, title: "工厂店铺" } },
    ]
    if (stopAt === 3) {
      list.push({
        at: at + 10,
        kind: "tool",
        title: "点「询价记录」 · 出错",
        toolId: "browser.click",
        input: { element: "询价记录", target: "getByRole('tab', { name: '询价记录' })" },
        output: "出错：找不到 getByRole('tab', { name: '询价记录' })：页面可能改版了",
        ms: 5_000,
        trace: { ...extra(5), ...lib(A, 2, 3, callId, 1), urlBefore: url },
      })
      return list
    }
    list.push(
      { at: at + 5, kind: "tool", title: "点「询价记录」", toolId: "browser.click", input: { element: "询价记录", target: "getByRole('tab', { name: '询价记录' })" }, output: "已点击", ms: 600, trace: { ...extra(5), ...lib(A, 2, 3, callId, 1), code: "await page.getByRole('tab', { name: '询价记录' }).click();", urlBefore: url, urlAfter: `${url}/inquiry` } },
      { at: at + 6, kind: "tool", title: "读最近的报价", toolId: "browser.extract", input: { list: "getByRole('row')", limit: 5 }, output: `| 商品 | 报价 | 起订量 | 交期 |\n|---|---|---|---|\n| 硅胶折叠收纳篮 | ${quoteRow(factory).报价} | ${quoteRow(factory).起订量} | ${quoteRow(factory).交期} |`, ms: 700, trace: { ...extra(6), ...lib(A, 2, 4, callId, 1) } }
    )
    return list
  }
  const returned = (factory: number) => ({ routine: "supplier_quote", name: "查 1688 工厂的报价和起订量", version: 2, outcome: "achieved" as const, summary: `${quoteRow(factory).报价}，起订量 ${quoteRow(factory).起订量}`, evidence: "询价记录第一行", data: quoteRow(factory) })

  // T-1024：agent 调了两次。第一次跑完；第二次停在第 3 步（标签改名了），交回 agent 接着做
  const agentRun = addRun("T-1024", 70, 95, { tokensIn: 42_000, tokensOut: 1_900, costUsd: 0.0162, stepCount: 6, triggeredBy: "manual" })
  {
    const first = "call_7c1e2a90"
    const second = "call_d04b6e31"
    const none = () => ({})
    const stopReason = "找不到 getByRole('tab', { name: '询价记录' })：页面可能改版了"
    const handoff = [
      "流程「查 1688 工厂的报价和起订量」第 2 版做到第 3 步停下，没跑完：",
      "1. 进入流程「打开 1688 询盘页」✓",
      `2. navigate ${FACTORY_URLS[1]} ✓`,
      `3. ✗ click「询价记录」：${stopReason}`,
      "会改东西的步骤：一步都还没做。",
      `现在的页面：「工厂店铺」 ${FACTORY_URLS[1]}`,
      "请从现在的页面接着把这件事做完，前面做过的不要重复。同样的输入不要再调这个流程。",
    ].join("\n")
    const stopData = { routine: "supplier_quote", name: "查 1688 工厂的报价和起订量", version: 2, steps: 3, stoppedAt: { step: 3, kind: "step_error", tool: "browser.click", label: "click「询价记录」", reason: stopReason }, commits: [] }
    events.set(agentRun, [
      { at: 1, kind: "plan", title: "按任务步骤开始", detail: "3 个步骤", tokensIn: 5_200, tokensOut: 210 },
      { at: 4, kind: "think", title: "两家工厂都要查报价，先用固化好的流程查第一家", tokensIn: 6_900, tokensOut: 160 },
      ...quoteSteps(first, 6, 0, none),
      { at: 13, kind: "tool", title: "查 1688 工厂的报价和起订量", toolId: routineToolId("supplier_quote"), input: { p1: FACTORY_URLS[0], p2: "硅胶折叠收纳篮" }, output: `流程「查 1688 工厂的报价和起订量」第 2 版跑完：办成 · ${returned(0).summary}\n${JSON.stringify(returned(0))}`, ms: 6_400, tokensIn: 8_100, tokensOut: 140 },
      ...quoteSteps(second, 16, 1, none, 3),
      { at: 27, kind: "tool", title: "查 1688 工厂的报价和起订量（出错）", toolId: routineToolId("supplier_quote"), input: { p1: FACTORY_URLS[1], p2: "硅胶折叠收纳篮" }, output: `${handoff}\n${JSON.stringify(stopData)}`, ms: 9_200, tokensIn: 9_400, tokensOut: 120 },
      { at: 40, kind: "tool", title: "看页面快照", toolId: "browser.snapshot", input: {}, output: "- tablist: 店铺首页 / 报价单 / 联系方式", ms: 500, tokensIn: 12_300, tokensOut: 260 },
      { at: 52, kind: "tool", title: "点「报价单」", toolId: "browser.click", input: { element: "报价单标签", ref: "e22" }, output: "已点击", ms: 700, tokensIn: 13_100, tokensOut: 150, trace: { code: "await page.getByRole('tab', { name: '报价单' }).click();" } },
      { at: 66, kind: "tool", title: "读最近的报价", toolId: "browser.extract", input: { list: "getByRole('row')", limit: 5 }, output: "| 商品 | 报价 | 起订量 |\n|---|---|---|\n| 硅胶折叠收纳篮 | ¥11.80 | 1000 |", ms: 600, tokensIn: 14_000, tokensOut: 300 },
      { at: 80, kind: "tool", title: "报告办成了", toolId: "run.finish", input: { outcome: "achieved" }, output: "已收到，交给复核", ms: 20, tokensIn: 15_200, tokensOut: 280 },
      { at: 92, kind: "verify", title: "AI 复核：办成", detail: "两家工厂的报价、起订量都拿到了。" },
      { at: 93, kind: "done", title: "办成了", detail: "红木工厂 ¥12.50 起订 500；利众工厂 ¥11.80 起订 1000。" },
    ])
  }

  // T-1012：agent 写了一段 code.run（tools）脚本，循环调 ha.routine 查三家
  const scriptRun = addRun("T-1012", 40, 60, { tokensIn: 18_000, tokensOut: 1_200, costUsd: 0.0071, stepCount: 3 })
  {
    const callId = "call_5ab3f7e2"
    const loop = `import ha from "heyagent"

const factories = ${JSON.stringify(FACTORY_URLS)}
const out = []
for (const url of factories) {
  const r = await ha.routine("supplier_quote", { 工厂链接: url, 商品: "桌面收纳盒" })
  out.push({ url, ...r.data })
}
console.log(JSON.stringify(out))
`
    const list: EventSpec[] = [
      { at: 1, kind: "plan", title: "按任务步骤开始", detail: "2 个步骤", tokensIn: 4_800, tokensOut: 190 },
      { at: 5, kind: "think", title: "三家工厂都要查，写个脚本循环调「查 1688 工厂的报价和起订量」", tokensIn: 6_100, tokensOut: 420 },
    ]
    let step = 0
    let at = 8
    FACTORY_URLS.forEach((url, factory) => {
      step++
      const enterStep = step
      const enterCall = `${callId}-s${enterStep}`
      list.push({ at, kind: "tool", title: "开始跑流程「查 1688 工厂的报价和起订量」第 2 版", toolId: routineToolId("supplier_quote"), input: { 工厂链接: url, 商品: "桌面收纳盒" }, output: "进入流程「查 1688 工厂的报价和起订量」第 2 版", ms: 4, trace: { scriptStep: enterStep, scriptCallId: callId } })
      const inner = quoteSteps(enterCall, at + 1, factory, (k) => ({ scriptStep: enterStep + k, scriptCallId: callId }))
      list.push(...inner)
      step = enterStep + 6
      at += 9
      list.push({ at, kind: "plan", title: `流程「查 1688 工厂的报价和起订量」跑完：6 步 · 交回 报价=${quoteRow(factory).报价}、起订量=${quoteRow(factory).起订量}、交期=${quoteRow(factory).交期}`, trace: { scriptStep: step, scriptCallId: callId } })
      at += 1
    })
    list.push(
      {
        at: at + 1,
        kind: "tool",
        title: "运行代码",
        toolId: "code.run",
        input: { language: "node", code: loop, tools: true },
        output: `退出码 0 · 用时 ${at - 7} 秒\n--- stdout ---\n${JSON.stringify(FACTORY_URLS.map((url, factory) => ({ url, ...quoteRow(factory) })))}\n--- 脚本调的工具 ---\n脚本调了 ${step} 次工具：routine.supplier_quote 3 次、routine.login_inbox 3 次、browser.navigate 6 次、browser.wait_any 3 次、browser.click 3 次、browser.extract 3 次`,
        ms: (at - 7) * 1000,
        tokensIn: 7_300,
        tokensOut: 980,
        trace: { scriptCallId: callId },
      },
      { at: at + 15, kind: "tool", title: "报告办成了", toolId: "run.finish", input: { outcome: "achieved" }, output: "已收到，交给复核", ms: 20 },
      { at: at + 25, kind: "verify", title: "AI 复核：办成", detail: "三家工厂的报价都拿到了。" },
      { at: at + 26, kind: "done", title: "办成了", detail: "红木 ¥12.50 / 500 件；利众 ¥11.80 / 1000 件；远康 ¥13.20 / 300 件。" }
    )
    events.set(scriptRun, list)
  }

  // 只有摘要的运行，挂别的调用记录
  const pastRuns = [
    addRun("T-1024", 2 * DAY, 120),
    addRun("T-1024", 4 * DAY, 140),
    addRun("T-1012", 3 * DAY, 90),
    addRun("T-1012", 6 * DAY, 110, { outcome: "not_achieved", outcomeReason: "工厂没报过价。" }),
  ]
  const exportRuns = [
    addRun("T-1019", 3 * 60, 80, { outcome: "not_achieved", outcomeReason: "询价表没导出来。" }),
    addRun("T-1019", DAY + 3 * 60, 85, { outcome: "not_achieved", outcomeReason: "询价表没导出来。" }),
    addRun("T-1019", 2 * DAY + 3 * 60, 90, { outcome: "not_achieved", outcomeReason: "询价表没导出来。" }),
    addRun("T-1019", 5 * DAY, 60),
  ]

  for (const session of sessions) session.eventSeq = events.get(session.id!)?.length ?? 0
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

  // ---------- 调用记录（routine_calls） ----------
  type CallInsert = typeof t.routineCalls.$inferInsert
  const calls: CallInsert[] = []
  const call = (
    routineId: string,
    version: number,
    sessionId: string,
    callId: string,
    via: "tool" | "script",
    depth: number,
    result: RoutineCallResult,
    steps: number,
    ms: number,
    at: Date,
    stop?: { kind: RoutineStopKind; step: number; reason: string }
  ) => {
    const session = sessions.find((each) => each.id === sessionId)!
    calls.push({ routineId, version, sessionId, taskId: session.taskId, callId, via, depth, result, stopKind: stop?.kind ?? null, stopStep: stop?.step ?? null, stopReason: stop?.reason ?? null, steps, ms, at })
  }
  const runStart = (id: string, seconds: number) => new Date((sessions.find((each) => each.id === id)!.startedAt as Date).getTime() + seconds * 1000)

  // 有过程的两次
  call(A, 2, agentRun, "call_7c1e2a90", "tool", 1, "achieved", 4, 6_400, runStart(agentRun, 13))
  call(B, 1, agentRun, "call_7c1e2a90-l1", "script", 2, "achieved", 2, 1_700, runStart(agentRun, 8))
  call(A, 2, agentRun, "call_d04b6e31", "tool", 1, "stopped", 3, 9_200, runStart(agentRun, 27), { kind: "step_error", step: 3, reason: "找不到 getByRole('tab', { name: '询价记录' })：页面可能改版了" })
  call(B, 1, agentRun, "call_d04b6e31-l1", "script", 2, "achieved", 2, 1_600, runStart(agentRun, 18))
  for (let factory = 0; factory < 3; factory++) {
    const enter = `call_5ab3f7e2-s${1 + factory * 7}`
    call(A, 2, scriptRun, enter, "script", 1, "achieved", 4, 5_800 + factory * 300, runStart(scriptRun, 16 + factory * 10))
    call(B, 1, scriptRun, `${enter}-l1`, "script", 2, "achieved", 2, 1_500, runStart(scriptRun, 11 + factory * 10))
  }
  // 以前的：大多跑完，一次没办成，一次停在登录页（挂起，不算跑不通）
  pastRuns.forEach((id, index) => {
    for (let k = 0; k < 3; k++) {
      const notAchieved = index === 3 && k === 0
      const page = index === 1 && k === 2
      const version = index >= 2 ? 1 : 2
      if (page) call(A, version, id, `call_past_${index}_${k}`, "tool", 1, "stopped", 1, 2_100, runStart(id, 10 + k * 20), { kind: "suspend", step: 1, reason: "打开后是登录页（登录过期了），等人登录" })
      else call(A, version, id, `call_past_${index}_${k}`, k === 1 ? "script" : "tool", 1, notAchieved ? "not_achieved" : "achieved", 4, 5_200 + k * 700 + index * 150, runStart(id, 10 + k * 20))
      call(B, 1, id, `call_past_${index}_${k}-l1`, "script", 2, page ? "stopped" : "achieved", page ? 1 : 2, 1_500, runStart(id, 8 + k * 20), page ? { kind: "suspend", step: 1, reason: "打开后是登录页，要人登录" } : undefined)
    }
  })
  // C：先跑通一次，后面连着 3 次停在第 2 步 → 自动停用
  call(ids.C!, 1, exportRuns[3]!, "call_export_ok", "tool", 1, "achieved", 4, 7_400, runStart(exportRuns[3]!, 12))
  exportRuns.slice(0, 3).forEach((id, index) =>
    call(ids.C!, 1, id, `call_export_${index}`, "tool", 1, "stopped", 2, 5_300, runStart(id, 15), { kind: "step_error", step: 2, reason: "找不到 getByRole('button', { name: '导出' })：页面可能改版了" })
  )
  await db.insert(t.routineCalls).values(calls)

  return { routines: ids, runIds: sessions.map((session) => session.id!) }
}
