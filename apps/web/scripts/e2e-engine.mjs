#!/usr/bin/env node
// 引擎端到端验收（M1 P3）：照真人的路径在控制台里走一遍，用真模型（默认 anthropic/claude-haiku-5.5，花钱很少）。
// 前提：整套 pod（或 API + worker + 前端）开着；OpenRouter 已接入（空白环境初始化时按 key 自动接入）。
// 跑之前先执行 scripts/or-usage.sh check 18。
// 用法：node apps/web/scripts/e2e-engine.mjs [地址]      默认 http://127.0.0.1:8080/
//   E2E_ADMIN_PASSWORD_FILE  管理员密码文件（默认仓库根目录的 .dev/admin-password）；全新环境会先设置管理员，随机密码写进这个文件
//   E2E_MODEL                执行模型（OpenRouter 上的名字，默认 anthropic/claude-haiku-5.5）
//   E2E_SHOTS                截图放哪（默认 .dev/shots/m1-p3）
//   E2E_MCP_COMMAND          可选：一个 stdio MCP 服务器的启动命令，测「连接并读取工具」
//   CHROME_PATH / CHROME_LIBS / FONTCONFIG_FILE  同 smoke.mjs
// 检查（docs/dev/m1-p3.md 第 4 节）：
//   1. 管理员用初始密码登录；
//   2. 通用任务「整理成 CSV，用存文件工具保存」，带「产出文件」检查点，执行模型选 Haiku：创建并启动 → 过程实时出现 → 完成 → 产物能下载；
//   3. 用 session.wait 等 1 分钟：挂起，到点继续，是同一个 session；
//   4. 先用 ask.human 请示：看板「等人处理」出现卡片 → 负责人批准 → session 继续 → 完成；通知按钮上有未读数；
//   5. 带附件运行：上传一个 txt，agent 用读附件工具读出内容写进结果；
//   6. 员工账号：别人负责的只能看，自己负责的能运行；
//   7. 两个账号全程浏览器控制台没有报错。
// 每次运行用不同的名字，可以对同一个环境重复跑。
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

import { ensureAdmin } from "./admin-account.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const BASE = (process.argv[2] ?? "http://127.0.0.1:8080/").replace(/\/?$/, "/")
const PASSWORD_FILE = resolve(process.env.E2E_ADMIN_PASSWORD_FILE ?? join(repoRoot, ".dev/admin-password"))
const MODEL = process.env.E2E_MODEL ?? "anthropic/claude-haiku-5.5"
const SHOTS = resolve(process.env.E2E_SHOTS ?? join(repoRoot, ".dev/shots/m1-p3"))
const CHROME = process.env.CHROME_PATH ?? join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell")
const SCRATCH = "/tmp/claude-1000/-mnt-toshiba-Projects-HeyAgent/f5a5874c-3877-4626-bd8a-cb20c17939f4/scratchpad"
const LIBS = process.env.CHROME_LIBS ?? join(SCRATCH, "chromelibs/root/usr/lib/x86_64-linux-gnu")
const FONTS = process.env.FONTCONFIG_FILE ?? join(SCRATCH, "fonts/fonts.conf")

const RUN = Date.now().toString(36).slice(-5)
const ADMIN = await ensureAdmin(BASE, PASSWORD_FILE)
const STAFF = { email: `e2e-${RUN}@heyagent.local`, password: `e2e-pass-${RUN}`, name: `验收员工${RUN}` }
const SECRET = `暗号-${RUN}-青柠`

const failures = []
const fail = (message) => {
  failures.push(message)
  console.log(`  ✗ ${message}`)
}
const ok = (message) => console.log(`  ✓ ${message}`)

const browser = await chromium.launch({
  executablePath: CHROME,
  env: {
    ...process.env,
    ...(existsSync(LIBS) ? { LD_LIBRARY_PATH: [LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(":") } : {}),
    ...(existsSync(FONTS) ? { FONTCONFIG_FILE: FONTS } : {}),
  },
  args: ["--no-sandbox"],
})
mkdirSync(SHOTS, { recursive: true })

async function newPage(label) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai", acceptDownloads: true })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text().slice(0, 300)}`)
  })
  return { label, context, page, errors }
}

async function step(name, run) {
  try {
    await run()
    ok(name)
    return true
  } catch (error) {
    fail(`${name}：${String(error.message ?? error).split("\n")[0]}`)
    return false
  }
}

async function waitLoaded(page, title) {
  await page.locator("h1", { hasText: title }).first().waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => !document.querySelector('[data-slot="skeleton"]'), null, { timeout: 15_000 })
}

async function open(page, hash, title) {
  await page.goto(`${BASE}#/${hash}`, { waitUntil: "load" })
  await waitLoaded(page, title)
}

async function login(page, user) {
  await page.goto(BASE, { waitUntil: "load" })
  await page.locator("#email").waitFor({ timeout: 15_000 })
  await page.fill("#email", user.email)
  await page.fill("#password", user.password)
  await page.click('button[type="submit"]')
  await page.getByRole("button", { name: "账号菜单" }).waitFor({ timeout: 15_000 })
}

async function toast(page, text, timeout = 15_000) {
  await page.locator('[data-slot="toast-title"], [data-slot="toast-description"]').filter({ hasText: text }).first().waitFor({ timeout })
}

async function pick(page, inputSelector, text, optionName = text) {
  const input = page.locator(inputSelector)
  await input.click()
  await input.fill(text)
  await page.getByRole("option", { name: optionName }).first().click()
  await page.waitForTimeout(200)
  if (await page.getByRole("listbox").first().isVisible().catch(() => false)) await page.keyboard.press("Escape")
}

/** 直接读接口（同一个浏览器上下文，带着登录 cookie）：查状态用，不代替页面上的检查 */
async function api(page, path, input) {
  const search = input === undefined ? "" : `?input=${encodeURIComponent(JSON.stringify(input))}`
  const response = await page.context().request.get(`${BASE}api/trpc/${path}${search}`)
  const body = await response.json()
  if (!response.ok()) throw new Error(`${path}：${body?.error?.message ?? response.status()}`)
  return body.result.data
}

async function apiPost(page, path, input) {
  const response = await page.context().request.post(`${BASE}api/trpc/${path}`, { data: input })
  const body = await response.json()
  if (!response.ok()) throw new Error(`${path}：${body?.error?.message ?? response.status()}`)
  return body.result.data
}

const runOf = async (page, id) => (await api(page, "sessions.list")).find((run) => run.id === id)

/** 轮询运行状态，直到是想要的之一；失败了直接报出失败原因 */
async function waitRun(page, id, statuses, timeout = 180_000) {
  const deadline = Date.now() + timeout
  let run
  while (Date.now() < deadline) {
    run = await runOf(page, id)
    if (run && statuses.includes(run.status)) return run
    if (run?.status === "failed" && !statuses.includes("failed")) {
      const error = run.events.findLast((event) => event.kind === "error")
      throw new Error(`${id} 失败了：${error?.title ?? ""} ${error?.detail ?? ""}`)
    }
    await page.waitForTimeout(1000)
  }
  throw new Error(`${id} 等 ${statuses.join("/")} 超时，现在是 ${run?.status}`)
}

const routeParams = (page) => new URLSearchParams(new URL(page.url()).hash.split("?")[1] ?? "")

/** 管理员在页面上新建任务；start = true 点「创建并启动」，返回 { taskId, runId } */
async function createTask(page, { title, steps, goal, tools = [], owner, start }) {
  await open(page, "tasks", "任务")
  await page.getByRole("button", { name: "新建任务" }).first().click()
  const d = page.getByRole("dialog", { name: "新建任务" })
  await d.locator("#task-title").fill(title)
  for (const [index, each] of steps.entries()) {
    if (index > 0) await d.getByRole("button", { name: "添加步骤" }).click()
    await d.getByLabel(`步骤 ${index + 1}`, { exact: true }).fill(each.text)
    if (each.wait) await d.locator(`label[for="step-${index}-wait"]`).click()
    if (each.checkpoint) {
      await d.locator(`label[for="step-${index}-cp"]`).click()
      await d.getByLabel(`步骤 ${index + 1} 的检查点`).fill(each.checkpoint)
    }
  }
  await d.locator("#task-goal").fill(goal)
  for (const tool of tools) await pick(page, "#task-toolIds", tool)
  await pick(page, "#task-model", MODEL.split("/").pop(), new RegExp(`${MODEL.replace(/[.]/g, "\\.")}$`))
  if (owner) {
    await d.locator("#task-owner").click()
    await page.getByRole("option", { name: new RegExp(owner) }).first().click()
  }
  await d.getByRole("button", { name: start ? "创建并启动" : "只创建" }).click()
  await d.waitFor({ state: "hidden", timeout: 20_000 })
  if (start) await page.waitForFunction(() => location.hash.includes("run="), null, { timeout: 15_000 })
  else await page.waitForFunction(() => location.hash.includes("id="), null, { timeout: 15_000 })
  const params = routeParams(page)
  return { taskId: params.get("id"), runId: params.get("run") }
}

/** 右侧抽屉（不用 getByRole("dialog")：Base UI 的 toast 也是 dialog） */
const sheet = (page) => page.locator('[data-slot="sheet-content"]').last()

console.log(`引擎端到端验收：${BASE}（模型 ${MODEL}）`)
const admin = await newPage("管理员")
const staff = await newPage("员工")
const state = {}

try {
  // ---------- 1. 登录、准备员工账号 ----------
  console.log("\n== 1. 管理员登录")
  await step("管理员用 .dev/admin-password 里的密码登录", () => login(admin.page, ADMIN))
  await step(`新建员工账号 ${STAFF.email}`, async () => {
    const { page } = admin
    await open(page, "users", "用户")
    await page.getByRole("button", { name: "新建用户" }).first().click()
    const d = page.locator('[data-slot="dialog-content"]').last()
    await d.locator("#user-email").fill(STAFF.email)
    await d.locator("#user-name").fill(STAFF.name)
    await d.locator("#user-title").fill("专员")
    await d.locator("#user-password").fill(STAFF.password)
    await d.getByRole("button", { name: "新建用户" }).click()
    await d.waitFor({ state: "hidden", timeout: 15_000 })
  })

  // ---------- 3（先起）. 等 1 分钟的任务：先启动，后面再回来看 ----------
  console.log("\n== 3. session.wait 等 1 分钟（先启动，其他检查做完再回来看）")
  await step("建任务「先等 1 分钟再回复」并创建并启动", async () => {
    const created = await createTask(admin.page, {
      title: `等一分钟再回复 ${RUN}`,
      steps: [{ text: "调用「挂起等待」工具，afterMinutes 填 1，what 写「等一分钟」", wait: true }, { text: "继续以后直接回复「等完了」，不要再调用工具" }],
      goal: "等满 1 分钟后回复「等完了」",
      start: true,
    })
    state.wait = created
    if (!created.runId) throw new Error("没有跳到这次运行")
  })
  await step("挂起：状态变成「等待中」，页面上显示在等什么", async () => {
    await waitRun(admin.page, state.wait.runId, ["waiting"], 120_000)
    await sheet(admin.page).getByText("session 已挂起").first().waitFor({ timeout: 15_000 })
    await admin.page.screenshot({ path: join(SHOTS, "wait-suspended-dark.png") })
  })

  // ---------- 2. CSV 任务 ----------
  console.log("\n== 2. 通用任务：整理成 CSV，用存文件工具保存")
  await step("建任务（带「产出文件」检查点，执行模型 Haiku）并点「创建并启动」", async () => {
    state.csv = await createTask(admin.page, {
      title: `把下面三行数据整理成 CSV，用存文件工具保存 ${RUN}`,
      steps: [
        { text: "三行数据：张三 25 北京；李四 30 上海；王五 28 广州。整理成带表头（姓名,年龄,城市）的 CSV" },
        { text: "用「存文件」工具保存为 people.csv，然后勾上检查点", checkpoint: "已生成 CSV 文件" },
      ],
      goal: "得到一个 people.csv 文件，三行数据和表头都在",
      tools: ["存文件"],
      start: true,
    })
    if (!state.csv.runId) throw new Error("没有跳到这次运行")
  })
  await step("过程实时出现（不刷新页面，事件一条条出来）", async () => {
    const s = sheet(admin.page)
    await s.getByText("运行开始").first().waitFor({ timeout: 15_000 })
    await s.getByText(/模型决定调用：.*存文件/).first().waitFor({ timeout: 90_000 })
    await admin.page.screenshot({ path: join(SHOTS, "csv-running-dark.png") })
  })
  await step("运行完成；检查点勾上；token 和花费有数", async () => {
    const run = await waitRun(admin.page, state.csv.runId, ["done"])
    const s = sheet(admin.page)
    await s.getByText("已完成").first().waitFor({ timeout: 15_000 })
    if (!run.checkpoints.every((cp) => cp.status === "done")) throw new Error(`检查点没勾完：${JSON.stringify(run.checkpoints.map((cp) => [cp.title, cp.status]))}`)
    if (!(run.tokensIn > 0 && run.costUsd > 0)) throw new Error(`token / 花费没记上：${run.tokensIn} / ${run.costUsd}`)
    state.csvCost = run.costUsd
  })
  await step("产物出现在「附件和产物」里，点下载拿到 CSV（三行数据都在）", async () => {
    const s = sheet(admin.page)
    // 下载按钮是 <a>（Base UI 的 Button 用 render 换成链接），按 aria-label 找
    const link = s.locator('a[aria-label^="下载 "][aria-label$=".csv"]').first()
    await link.waitFor({ timeout: 15_000 })
    const [download] = await Promise.all([admin.page.waitForEvent("download", { timeout: 15_000 }), link.click()])
    const file = await download.path()
    const text = readFileSync(file, "utf8")
    for (const word of ["张三", "李四", "王五"]) if (!text.includes(word)) throw new Error(`下载的文件里没有「${word}」：${text.slice(0, 200)}`)
    await admin.page.screenshot({ path: join(SHOTS, "csv-done-dark.png") })
  })

  // ---------- 5. 带附件运行 ----------
  console.log("\n== 5. 带附件运行：上传 txt，agent 读出内容写进结果")
  await step("建任务（选用「读附件」），任务附件能上传、移除", async () => {
    state.attach = await createTask(admin.page, {
      title: `读附件并转述 ${RUN}`,
      steps: [{ text: "用「读附件」工具读这次运行带的 txt 附件，把里面的暗号原样写进最终答复" }],
      goal: "最终答复里有附件里的暗号",
      tools: ["读附件"],
      start: false,
    })
    const s = sheet(admin.page)
    await s.locator('input[type="file"]').first().setInputFiles({ name: "task-note.txt", mimeType: "text/plain", buffer: Buffer.from("这是任务附件，用来测上传和移除。") })
    await toast(admin.page, "已加上附件 task-note.txt")
    await s.getByRole("button", { name: "移除 task-note.txt" }).click()
    await toast(admin.page, "附件已移除")
  })
  await step("「⋯ → 带附件运行」上传 txt 并立即运行", async () => {
    const { page } = admin
    await sheet(page).getByRole("button", { name: "任务的更多操作" }).click()
    await page.getByRole("menuitem", { name: /带附件运行/ }).click()
    const d = page.getByRole("dialog", { name: /带附件运行/ })
    await d.locator('input[type="file"]').setInputFiles({ name: "secret.txt", mimeType: "text/plain", buffer: Buffer.from(`今天的暗号是：${SECRET}\n`) })
    await d.getByText("secret.txt").waitFor({ timeout: 15_000 })
    await d.getByRole("button", { name: "立即运行" }).click()
    await d.waitFor({ state: "hidden", timeout: 15_000 })
    await page.waitForFunction(() => location.hash.includes("run="), null, { timeout: 15_000 })
    state.attach.runId = routeParams(page).get("run")
  })
  await step("agent 用读附件工具读出内容，结果里有暗号", async () => {
    const run = await waitRun(admin.page, state.attach.runId, ["done"])
    if (!run.events.some((event) => event.kind === "tool" && event.toolId === "file.read")) throw new Error("没有调用读附件工具")
    const answer = run.events.findLast((event) => event.kind === "done")?.detail ?? ""
    if (!answer.includes(SECRET)) throw new Error(`最终答复里没有暗号：${answer.slice(0, 200)}`)
    await sheet(admin.page).getByText(SECRET).first().waitFor({ timeout: 15_000 })
    await sheet(admin.page).getByText("secret.txt").first().waitFor({ timeout: 5_000 })
    await admin.page.screenshot({ path: join(SHOTS, "attachment-done-dark.png") })
  })

  // ---------- 主管手动触发事件 ----------
  console.log("\n== 待办：主管手动触发事件（engine.fireEvent）")
  await step("给 CSV 任务加一条「等事件」的待办，在看板上点「手动触发事件」→ 待办触发、新开一次运行", async () => {
    const { page } = admin
    const event = `e2e.ping.${RUN}`
    const todo = await apiPost(page, "todos.create", { taskId: state.csv.taskId, title: "再整理一次，文件名用 people-2.csv", trigger: { kind: "event", event, fallbackDays: 1 } })
    await page.goto(`${BASE}#/todos?id=${todo.id}`, { waitUntil: "load" })
    await sheet(page).getByRole("button", { name: "手动触发事件" }).click()
    await toast(page, `已触发「${event}」`)
    await toast(page, "触发了 1 条待办")
    const run = await waitRun(page, (await api(page, "sessions.list")).filter((each) => each.taskId === state.csv.taskId).sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0].id, ["running", "done"], 30_000)
    if (run.id === state.csv.runId) throw new Error("没有新开运行")
    state.todoRun = { runId: run.id }
    await page.goto(`${BASE}#/todos`, { waitUntil: "load" })
  })

  // ---------- 4 + 6. 员工负责的「先请示」任务 ----------
  console.log("\n== 4 / 6. 员工：别人负责的只能看，自己负责的能运行；ask.human 请示 → 批准 → 继续 → 完成")
  await step("管理员建一个员工负责的任务（先用 ask.human 请示）", async () => {
    state.ask = await createTask(admin.page, {
      title: `先请示再回复 ${RUN}`,
      steps: [{ text: "先调用「问人」工具，question 写「可以开始吗？」，options 给 [\"批准\", \"不批准\"]" }, { text: "批准以后直接回复「已获批准」，不要再调用工具" }],
      goal: "得到负责人批准后回复「已获批准」",
      owner: STAFF.name,
      start: false,
    })
  })
  await step("员工登录", () => login(staff.page, STAFF))
  await step("员工打开管理员负责的任务：只能查看，没有「立即运行」", async () => {
    const { page } = staff
    await page.goto(`${BASE}#/tasks?id=${state.csv.taskId}`, { waitUntil: "load" })
    const s = sheet(page)
    await s.getByText("你只能查看").waitFor({ timeout: 15_000 })
    if (await s.getByRole("button", { name: "立即运行" }).count()) throw new Error("员工在别人的任务上看到了「立即运行」")
  })
  await step("员工打开自己负责的任务，点「立即运行」", async () => {
    const { page } = staff
    await page.goto(`${BASE}#/tasks?id=${state.ask.taskId}`, { waitUntil: "load" })
    const s = sheet(page)
    await s.getByRole("button", { name: "立即运行" }).click()
    await page.waitForFunction(() => location.hash.includes("run="), null, { timeout: 15_000 })
    state.ask.runId = routeParams(page).get("run")
  })
  await step("agent 请示：运行变成「等人处理」，通知按钮上出现未读数", async () => {
    await waitRun(staff.page, state.ask.runId, ["needs_human"], 120_000)
    // 抽屉是模态的，顶栏在它后面（对读屏隐藏），先回到不带抽屉的任务页
    await open(staff.page, "tasks", "任务")
    await staff.page.getByRole("button", { name: /通知（\d+ 条未读）/ }).waitFor({ timeout: 20_000 })
    await staff.page.screenshot({ path: join(SHOTS, "staff-notification-dark.png") })
  })
  await step("通知列表里有「等你处理」，看板「等人处理」出现卡片", async () => {
    const { page } = staff
    await page.getByRole("button", { name: /通知（\d+ 条未读）/ }).click()
    await page.getByText(/等你处理：/).first().waitFor({ timeout: 10_000 })
    await page.screenshot({ path: join(SHOTS, "staff-notification-list-dark.png") })
    await page.keyboard.press("Escape")
    await open(page, "todos", "待办")
    const item = (await api(page, "todos.board")).humanItems.find((each) => each.runId === state.ask.runId)
    if (!item) throw new Error("待办里没有这次运行的「要人办的事」")
    state.ask.itemId = item.id
    await page.locator(`section[aria-label="等人处理"] a[href="#/todos?id=${item.id}"]`).waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(SHOTS, "board-needs-human-dark.png") })
  })
  await step("负责人在卡片里批准（带备注）→ 卡片离开「等人处理」，session 继续", async () => {
    const { page } = staff
    await page.locator(`section[aria-label="等人处理"] a[href="#/todos?id=${state.ask.itemId}"]`).click()
    const s = sheet(page)
    await s.locator('textarea[id^="human-note-"]').fill("可以开始")
    await s.getByRole("button", { name: "批准", exact: true }).click()
    await toast(page, `已批准，${state.ask.runId} 继续执行`)
    await page.locator(`section[aria-label="等人处理"] a[href="#/todos?id=${state.ask.itemId}"]`).waitFor({ state: "detached", timeout: 15_000 })
    await page.locator('section[aria-label="执行中"] a[data-board-card], section[aria-label="已完成"] a[data-board-card]').filter({ hasText: `先请示再回复 ${RUN}` }).first().waitFor({ timeout: 30_000 })
  })
  await step("同一个 session 继续到完成（这个任务只有 1 次运行，过程里有处理记录和「继续」）", async () => {
    const run = await waitRun(staff.page, state.ask.runId, ["done"])
    if (!run.events.some((event) => event.kind === "resume")) throw new Error("没有「继续」事件")
    const handled = run.events.find((event) => event.kind === "human" && /批准了/.test(event.title))
    if (!handled || !handled.detail?.includes("可以开始")) throw new Error("过程里没有「批准了」和备注")
    const runs = (await api(staff.page, "sessions.list")).filter((each) => each.taskId === state.ask.taskId)
    if (runs.length !== 1) throw new Error(`这个任务有 ${runs.length} 次运行，应该只有 1 次`)
    await staff.page.screenshot({ path: join(SHOTS, "board-after-approve-dark.png") })
  })

  // ---------- 3（回来看）. 等 1 分钟的任务 ----------
  console.log("\n== 3. 回来看等 1 分钟的任务")
  await step("到点继续：同一个 session 完成，中间有挂起和继续", async () => {
    const run = await waitRun(admin.page, state.wait.runId, ["done"], 240_000)
    const kinds = run.events.map((event) => event.kind)
    if (!kinds.includes("wait") || !kinds.includes("resume")) throw new Error(`事件里没有挂起 / 继续：${kinds.join(",")}`)
    const runs = (await api(admin.page, "sessions.list")).filter((each) => each.taskId === state.wait.taskId)
    if (runs.length !== 1 || runs[0].id !== state.wait.runId) throw new Error(`应该只有同一个 session，实际：${runs.map((each) => each.id).join(",")}`)
    const waited = Date.parse(run.events.find((event) => event.kind === "resume").at) - Date.parse(run.events.find((event) => event.kind === "wait").at)
    if (waited < 55_000) throw new Error(`只等了 ${Math.round(waited / 1000)} 秒`)
    await admin.page.goto(`${BASE}#/tasks?id=${state.wait.taskId}&run=${state.wait.runId}`, { waitUntil: "load" })
    await sheet(admin.page).getByText("继续同一个 session").first().waitFor({ timeout: 15_000 })
    await admin.page.screenshot({ path: join(SHOTS, "wait-resumed-dark.png") })
    console.log(`    （挂起 ${Math.round(waited / 1000)} 秒后继续）`)
  })

  // ---------- 可选：MCP 连接并读取工具 ----------
  if (process.env.E2E_MCP_COMMAND) {
    console.log("\n== 可选：工具页「连接并读取工具」")
    await step("新建 stdio MCP 服务器 → 编辑里连接并读取工具 → 勾选保存", async () => {
      const { page } = admin
      await open(page, "tools", "工具")
      await page.getByRole("button", { name: "新建工具" }).first().click()
      let d = page.locator('[data-slot="dialog-content"]').last()
      await d.getByRole("radio", { name: "MCP 服务器" }).click().catch(async () => d.getByRole("button", { name: "MCP 服务器" }).click())
      await d.locator("#mcp-name").fill(`echo ${RUN}`)
      await d.locator("#mcp-target").fill(process.env.E2E_MCP_COMMAND)
      await d.getByRole("button", { name: "存好服务器" }).click()
      await d.waitFor({ state: "hidden", timeout: 15_000 })
      await page.locator("main").getByRole("button", { name: "编辑服务器" }).click()
      d = page.locator('[data-slot="dialog-content"]').last()
      await d.getByRole("button", { name: "连接并读取工具" }).click()
      await d.getByRole("button", { name: /保存勾选的 [1-9]\d* 个工具/ }).click({ timeout: 30_000 })
      await toast(page, "已保存，加入了")
      await page.screenshot({ path: join(SHOTS, "mcp-tools-dark.png") })
      await page.keyboard.press("Escape")
    })
  }

  // ---------- 亮色截图 ----------
  await step("亮色主题下的运行详情、通知列表截图", async () => {
    const { page } = admin
    await open(page, "tasks", "任务")
    await page.getByRole("button", { name: "切换到浅色" }).click()
    await page.waitForTimeout(400)
    await page.getByRole("button", { name: /^通知/ }).click()
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, "notifications-light.png") })
    await page.keyboard.press("Escape")
    await page.goto(`${BASE}#/tasks?id=${state.csv.taskId}&run=${state.csv.runId}`, { waitUntil: "load" })
    await sheet(page).getByText("附件和产物").first().waitFor({ timeout: 15_000 })
    await page.waitForTimeout(400)
    await page.screenshot({ path: join(SHOTS, "csv-done-light.png") })
    await open(page, "tasks", "任务")
    await page.getByRole("button", { name: "切换到暗色" }).click()
  })
} catch (error) {
  fail(`中断：${error.message.split("\n")[0]}`)
}

// ---------- 7. 控制台 ----------
console.log("\n== 7. 浏览器控制台")
for (const each of [admin, staff]) {
  if (each.errors.length) fail(`${each.label}：控制台共有 ${each.errors.length} 条报错：${[...new Set(each.errors)].join(" | ")}`)
  else ok(`${each.label}：全程控制台没有报错`)
}

const total = [state.csv, state.wait, state.ask, state.attach, state.todoRun].filter((each) => each?.runId)
let cost = 0
for (const each of total) cost += (await runOf(admin.page, each.runId).catch(() => undefined))?.costUsd ?? 0
console.log(`\n这次 ${total.length} 次运行的模型花费合计：$${cost.toFixed(4)}`)
await admin.context.close()
await staff.context.close()
await browser.close()
console.log(`截图：${SHOTS}`)
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项`)
  process.exit(1)
}
console.log("\n全部通过")
