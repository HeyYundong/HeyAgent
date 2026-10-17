#!/usr/bin/env node
// 浏览器端到端验收（M2-B）：照真人的路径在控制台里走一遍，用真模型（默认 anthropic/claude-haiku-5.5）。
// 前提：整套 pod 开着（scripts/pod.sh up，空白环境即可），OpenRouter 已自动接入。跑之前先执行 scripts/or-usage.sh check 18。
// 用法：node apps/web/scripts/e2e-browser.mjs [地址]      默认 http://127.0.0.1:8080/
//   E2E_ADMIN_PASSWORD_FILE  管理员初始密码文件（默认仓库根目录的 .dev/admin-password）
//   E2E_MODEL                执行模型（OpenRouter 上的名字，默认 anthropic/claude-haiku-5.5）
//   E2E_SHOTS                截图放哪（默认 .dev/shots/m2-b）
//   E2E_POD                  pod 名（默认 heyagent），本地测试页用 podman 起在这个 pod 里
//   CHROME_PATH / CHROME_LIBS / FONTCONFIG_FILE  同 smoke.mjs
// 检查（docs/dev/m2.md 验收）：
//   0. 设置页改浏览器设置；浏览器页新建 Chrome 配置、加账号（新平台带域名）；
//   1. 「打开 Chrome 登录」：远程画面出帧，地址栏打开 example.com，关闭就保存（保险箱版本 +1、账号探测通过）；
//   2. 任务「打开 https://example.com，读出页面标题，用存文件工具保存」：任务表单选「浏览器」、Chrome 配置、白名单 → 完成，产物正确，过程里有截图；
//   3. 本地验证码测试页 → session 等人 → 员工打开远程画面是只读 → 负责人在待办里「去浏览器里处理」，
//      在远程画面里输入（输入法组字的中文 + 按键的英文）、点按钮、在网页弹框（confirm）里点确定 → 过了验证
//      → 「已处理好了」→ 同一个 session 继续 → 产物里是过了验证才看得到的暗号；
//   4. Chrome 过了保留时间（设成 1 分钟）：待办里「新开 Chrome 处理」→ 登录 Chrome 里过验证、关闭（保存）→「已处理好了」→ 继续；
//   5. 全程浏览器控制台没有报错。
// 访问范围：只有本地测试页和 example.com。
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "../../..")
const BASE = (process.argv[2] ?? "http://127.0.0.1:8080/").replace(/\/?$/, "/")
const PASSWORD_FILE = resolve(process.env.E2E_ADMIN_PASSWORD_FILE ?? join(repoRoot, ".dev/admin-password"))
const ADMIN_PASSWORD = existsSync(PASSWORD_FILE) ? readFileSync(PASSWORD_FILE, "utf8").trim() : ""
const MODEL = process.env.E2E_MODEL ?? "anthropic/claude-haiku-5.5"
const SHOTS = resolve(process.env.E2E_SHOTS ?? join(repoRoot, ".dev/shots/m2-b"))
const POD = process.env.E2E_POD ?? "heyagent"
const CHROME = process.env.CHROME_PATH ?? join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell")
const SCRATCH = "/tmp/claude-1000/-mnt-toshiba-Projects-HeyAgent/f5a5874c-3877-4626-bd8a-cb20c17939f4/scratchpad"
const LIBS = process.env.CHROME_LIBS ?? join(SCRATCH, "chromelibs/root/usr/lib/x86_64-linux-gnu")
const FONTS = process.env.FONTCONFIG_FILE ?? join(SCRATCH, "fonts/fonts.conf")

if (!ADMIN_PASSWORD) {
  console.error(`没有管理员密码：找不到 ${PASSWORD_FILE}`)
  process.exit(2)
}

const RUN = Date.now().toString(36).slice(-5)
const ADMIN = { email: "admin@heyagent.local", password: ADMIN_PASSWORD }
const STAFF = { email: `e2e-br-${RUN}@heyagent.local`, password: `e2e-pass-${RUN}`, name: `浏览器验收员工${RUN}` }
const CODE = `暗号${RUN}紫藤`
const SITE_PORT = 8099
const SITE = `http://127.0.0.1:${SITE_PORT}`
const SITE_CONTAINER = `${POD}-e2e-site`
// 测试页上输入框、按钮的位置（页面 CSS 像素，见 e2e-browser-site.mjs）
const ANSWER_BOX = { x: 190, y: 170 }
const HUMAN_BUTTON = { x: 190, y: 260 }
const PROFILE = `验收 Chrome ${RUN}`
const PLATFORM = `示例站${RUN}`

const failures = []
const fail = (message) => {
  failures.push(message)
  console.log(`  ✗ ${message}`)
}
const ok = (message) => console.log(`  ✓ ${message}`)

// ---------- 本地验证码测试页：起在 pod 里，worker 的 Chrome 用 127.0.0.1 访问 ----------
function startSite() {
  try {
    execFileSync("podman", ["rm", "-f", SITE_CONTAINER], { stdio: "ignore" })
  } catch {
    // 本来就没有
  }
  execFileSync("podman", [
    "run", "-d", "--rm", "--pod", POD, "--name", SITE_CONTAINER,
    "-e", `PORT=${SITE_PORT}`, "-e", `CODE=${CODE}`,
    "-v", `${join(here, "e2e-browser-site.mjs")}:/site/site.mjs:ro`,
    "--entrypoint", "node", "localhost/heyagent-api:m1", "/site/site.mjs",
  ], { stdio: "ignore" })
}
function stopSite() {
  try {
    execFileSync("podman", ["rm", "-f", SITE_CONTAINER], { stdio: "ignore" })
  } catch {
    // 已经没了
  }
}

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

async function until(check, timeout, what) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    last = await check()
    if (last) return last
    await new Promise((done) => setTimeout(done, 1000))
  }
  throw new Error(`等「${what}」超时`)
}

const runOf = async (page, id) => (await api(page, "sessions.get", { id }))

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
const sheet = (page) => page.locator('[data-slot="sheet-content"]').last()
const dialog = (page) => page.locator('[data-slot="dialog-content"]').last()

/** 远程画面：等画面出来（第一帧 + meta），返回画布 */
async function waitScreen(page, { control = true } = {}) {
  const d = dialog(page)
  const canvas = d.locator(`canvas[aria-label="${control ? "远程画面（可以操作）" : "远程画面（只读）"}"]`)
  await canvas.waitFor({ timeout: 30_000 })
  await page.waitForFunction((el) => el && !el.classList.contains("invisible") && Number(el.dataset.pageWidth) > 0, await canvas.elementHandle(), { timeout: 30_000 })
  return canvas
}

/** 在远程画面上点页面里的某个位置（页面 CSS 像素） */
async function clickScreen(page, canvas, point) {
  const box = await canvas.boundingBox()
  const width = Number(await canvas.getAttribute("data-page-width"))
  const height = Number(await canvas.getAttribute("data-page-height"))
  await page.mouse.click(box.x + (point.x / width) * box.width, box.y + (point.y / height) * box.height)
}

/** 远程画面的地址栏 */
const addressBar = (page) => dialog(page).getByRole("textbox", { name: "地址栏" })

async function createTask(page, { title, steps, goal, tools, domains, start = true }) {
  await open(page, "tasks", "任务")
  await page.getByRole("button", { name: "新建任务" }).first().click()
  const d = page.getByRole("dialog", { name: "新建任务" })
  await d.locator("#task-title").fill(title)
  for (const [index, text] of steps.entries()) {
    if (index > 0) await d.getByRole("button", { name: "添加步骤" }).click()
    await d.getByLabel(`步骤 ${index + 1}`, { exact: true }).fill(text)
  }
  await d.locator("#task-goal").fill(goal)
  for (const tool of tools) await pick(page, "#task-toolIds", tool)
  // 选了「浏览器」工具，表单里出现浏览器的三项
  await d.locator("#task-browserProfileIds").waitFor({ timeout: 5_000 })
  await pick(page, "#task-browserProfileIds", PROFILE)
  await d.locator("#task-allowedDomains").fill(domains.join("\n"))
  await pick(page, "#task-model", MODEL.split("/").pop(), new RegExp(`${MODEL.replace(/[.]/g, "\\.")}$`))
  await d.getByRole("button", { name: start ? "创建并启动" : "只创建" }).click()
  await d.waitFor({ state: "hidden", timeout: 20_000 })
  await page.waitForFunction((started) => location.hash.includes(started ? "run=" : "id="), start, { timeout: 15_000 })
  const params = routeParams(page)
  return { taskId: params.get("id"), runId: params.get("run") }
}

console.log(`浏览器端到端验收：${BASE}（模型 ${MODEL}，这次的后缀 ${RUN}）`)
startSite()
const admin = await newPage("管理员")
const staff = await newPage("员工")
const state = {}

try {
  console.log("\n== 0. 准备：设置、Chrome 配置、账号")
  await step("管理员登录", () => login(admin.page, ADMIN))
  await step("设置页改「遇到验证码时 Chrome 保留多久」并保存（再改回 30）", async () => {
    const { page } = admin
    await open(page, "settings", "设置")
    for (const minutes of [20, 30]) {
      await page.locator("#browser-humanHoldMinutes").fill(String(minutes))
      await page.locator("form", { has: page.locator("#browser-humanHoldMinutes") }).getByRole("button", { name: "保存" }).click()
      await toast(page, "浏览器设置已保存")
      const settings = await until(async () => {
        const value = await api(page, "settings.get")
        return value.browser.humanHoldMinutes === minutes && value
      }, 10_000, `保留时间变成 ${minutes}`)
      if (settings.browser.maxPerWorker < 1) throw new Error("maxPerWorker 不对")
    }
    await page.screenshot({ path: join(SHOTS, "settings-browser-dark.png") })
  })
  await step(`浏览器页新建 Chrome 配置「${PROFILE}」（不用代理）`, async () => {
    const { page } = admin
    await open(page, "browsers", "浏览器")
    await page.getByRole("button", { name: "新建 Chrome" }).first().click()
    const d = dialog(page)
    await d.locator("#br-name").fill(PROFILE)
    await d.locator("#br-desc").fill("端到端验收用：直连，打开本地测试页和 example.com")
    await d.getByRole("button", { name: "创建" }).click()
    await d.waitFor({ state: "hidden", timeout: 15_000 })
    const profile = (await api(page, "browsers.list")).find((each) => each.name === PROFILE)
    if (!profile) throw new Error("没建出来")
    state.profileId = profile.id
  })
  await step(`加账号：新平台「${PLATFORM}」带域名 example.com，登录网址 https://example.com/`, async () => {
    const { page } = admin
    await open(page, `browsers?id=${state.profileId}`, "浏览器")
    await page.getByRole("button", { name: "加账号" }).click()
    const d = dialog(page)
    await d.locator("#acc-platform").fill(PLATFORM)
    await page.getByRole("option", { name: new RegExp(PLATFORM) }).first().click()
    await d.locator("#acc-domains").fill("example.com")
    await d.locator("#acc-account").fill("验收账号")
    await d.locator("#acc-probe").fill("https://example.com/")
    await d.getByRole("button", { name: "加账号" }).click()
    await d.waitFor({ state: "hidden", timeout: 15_000 })
    const platform = (await api(page, "platforms.list")).find((each) => each.name === PLATFORM)
    if (!platform || platform.domains.join() !== "example.com") throw new Error(`平台域名不对：${JSON.stringify(platform)}`)
    await page.getByText("域名：example.com").first().waitFor({ timeout: 10_000 })
    state.accountId = (await api(page, "browser.accountStatus")).find((each) => each.profileId === state.profileId)?.accountId
    if (!state.accountId) throw new Error("accountStatus 里没有新账号")
  })

  console.log("\n== 1. 打开 Chrome 登录 → 远程画面 → 关闭就保存")
  await step("账号行点「去登录」：远程画面出帧，可以操作", async () => {
    const { page } = admin
    await page.getByRole("button", { name: "去登录" }).first().click()
    const canvas = await waitScreen(page)
    state.loginCanvas = canvas
    await dialog(page).getByText("可以操作").waitFor({ timeout: 10_000 })
  })
  await step("地址栏打开 example.com：画面跳过去，「开着的 Chrome」里出现这个登录 Chrome", async () => {
    const { page } = admin
    // 账号的登录网址就是 example.com，先确认已经在那，再用地址栏重新打开一次（测导航）
    await addressBar(page).click()
    await addressBar(page).fill("example.com/?from=remote-view")
    await addressBar(page).press("Enter")
    await until(async () => (await addressBar(page).inputValue()).includes("from=remote-view"), 20_000, "地址栏变成新网址")
    const live = await until(async () => (await api(page, "browser.live")).find((each) => each.kind === "login" && each.profileId === state.profileId), 15_000, "browser.live 里有登录 Chrome")
    if (!live.viewers.length) throw new Error("browser.live 里没记上谁在看")
    await page.waitForTimeout(1500)
    await page.screenshot({ path: join(SHOTS, "login-browser-dark.png") })
  })
  await step("关掉弹窗：保险箱版本 +1，账号探测通过（状态变成已登录），登录 Chrome 关掉", async () => {
    const { page } = admin
    const before = (await api(page, "browsers.list")).find((each) => each.id === state.profileId).vaultVersion
    await page.keyboard.press("Escape")
    await toast(page, "登录状态已保存", 30_000)
    const after = (await api(page, "browsers.list")).find((each) => each.id === state.profileId)
    if (!(after.vaultVersion > before)) throw new Error(`保险箱版本没变：${before} → ${after.vaultVersion}`)
    const site = after.sites.find((each) => each.accountId === state.accountId)
    if (site?.status !== "ok") throw new Error(`账号状态是 ${site?.status}`)
  })
  await step("登录 Chrome 关掉", async () => {
    const { page } = admin
    await until(async () => !(await api(page, "browser.live")).some((each) => each.kind === "login" && each.profileId === state.profileId), 20_000, "登录 Chrome 关掉")
    await page.screenshot({ path: join(SHOTS, "browsers-page-dark.png") })
  })

  console.log("\n== 2. 任务：打开 https://example.com，读出页面标题，用存文件工具保存")
  await step("任务表单选「浏览器」「存文件」、Chrome 配置、白名单 example.com，创建并启动", async () => {
    state.example = await createTask(admin.page, {
      title: `打开 https://example.com，读出页面标题，用存文件工具保存 ${RUN}`,
      steps: ["用浏览器打开 https://example.com", "读出页面标题", "用「存文件」工具把标题保存成 title.txt，内容只写标题"],
      goal: "得到 title.txt，内容是 https://example.com 的页面标题",
      tools: ["浏览器", "存文件"],
      domains: ["example.com"],
    })
    if (!state.example.runId) throw new Error("没有跳到这次运行")
    const task = await api(admin.page, "tasks.get", { id: state.example.taskId })
    if (!task.toolIds.includes("browser") || task.browserProfileIds.join() !== state.profileId || task.allowedDomains.join() !== "example.com")
      throw new Error(`任务的浏览器配置没存对：${JSON.stringify({ toolIds: task.toolIds, profiles: task.browserProfileIds, domains: task.allowedDomains })}`)
  })
  await step("运行中「看浏览器」能打开远程画面（Chrome 开着时）", async () => {
    const { page } = admin
    const button = sheet(page).getByRole("button", { name: /^看浏览器/ })
    try {
      await button.waitFor({ timeout: 60_000 })
      await button.click()
      await waitScreen(page)
      await page.waitForTimeout(1000)
      await page.screenshot({ path: join(SHOTS, "example-running-view-dark.png") })
      await page.keyboard.press("Escape")
    } catch (error) {
      // 运行太快，Chrome 已经关了：不算失败，后面看结果
      const run = await runOf(page, state.example.runId)
      if (run.status !== "done") throw error
      console.log("    （运行已经结束，Chrome 关掉了，没来得及看）")
    }
  })
  await step("运行完成；产物 title.txt 里是 Example Domain；过程里有截图", async () => {
    const run = await waitRun(admin.page, state.example.runId, ["done"])
    const files = await api(admin.page, "engine.sessionFiles", { sessionId: run.id })
    const shots = files.filter((file) => file.kind === "screenshot")
    if (!shots.length) throw new Error("没有截图")
    const artifact = files.find((file) => file.kind === "artifact")
    if (!artifact) throw new Error("没有产物")
    const response = await admin.page.context().request.get(`${BASE}${artifact.url.replace(/^\//, "")}`)
    const text = await response.text()
    if (!/Example Domain/i.test(text)) throw new Error(`产物内容不对：${text.slice(0, 200)}`)
    if (!run.events.some((event) => event.kind === "tool" && event.toolId === "browser.navigate")) throw new Error("过程里没有 browser.navigate")
    state.exampleCost = run.costUsd
    await admin.page.goto(`${BASE}#/tasks?id=${state.example.taskId}&run=${run.id}`, { waitUntil: "load" })
    await sheet(admin.page).getByText("已完成").first().waitFor({ timeout: 15_000 })
    await sheet(admin.page).getByText(artifact.name).first().waitFor({ timeout: 15_000 })
    await admin.page.screenshot({ path: join(SHOTS, "example-done-dark.png") })
    console.log(`    产物 ${artifact.name}：${text.trim().slice(0, 80)}；截图 ${shots.length} 张；花费 $${run.costUsd.toFixed(4)}`)
  })

  console.log("\n== 3. 本地验证码测试页 → 等人 → 远程画面里处理 → 已处理好了 → 继续")
  await step("建任务（白名单 127.0.0.1）并启动", async () => {
    state.captcha = await createTask(admin.page, {
      title: `打开本地测试页，读出暗号，用存文件工具保存 ${RUN}`,
      steps: [
        `用浏览器打开 ${SITE}/captcha`,
        "遇到安全验证时系统会交给人处理，等处理好以后继续：先看一下当前页面",
        "读出页面上的暗号，用「存文件」工具保存成 code.txt，内容只写暗号",
      ],
      goal: "得到 code.txt，内容是测试页上的暗号",
      tools: ["浏览器", "存文件"],
      domains: ["127.0.0.1"],
    })
    if (!state.captcha.runId) throw new Error("没有跳到这次运行")
  })
  await step("检测到验证码：session 变成「等人处理」，Chrome 保留着，待办里有「登录」类的事（带截图）", async () => {
    const { page } = admin
    await waitRun(page, state.captcha.runId, ["needs_human"], 150_000)
    const item = (await api(page, "todos.board")).humanItems.find((each) => each.runId === state.captcha.runId)
    if (!item || item.kind !== "login" || !item.detail.browser) throw new Error(`待办不对：${JSON.stringify(item)?.slice(0, 200)}`)
    state.captcha.itemId = item.id
    const sb = await api(page, "browser.sessionBrowser", { sessionId: state.captcha.runId })
    if (!sb.open || sb.state !== "held") throw new Error(`Chrome 没保留：${JSON.stringify(sb)}`)
    // 运行详情右上角有「看浏览器（等人处理）」
    await page.goto(`${BASE}#/tasks?id=${state.captcha.taskId}&run=${state.captcha.runId}`, { waitUntil: "load" })
    await sheet(page).getByRole("button", { name: "看浏览器（等人处理）" }).waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(SHOTS, "captcha-needs-human-dark.png") })
  })
  await step("员工打开同一件事：远程画面是只读", async () => {
    await apiPost(admin.page, "users.create", { email: STAFF.email, name: STAFF.name, title: "专员", role: "user", password: STAFF.password })
    const { page } = staff
    await login(page, STAFF)
    await page.goto(`${BASE}#/todos?id=${state.captcha.itemId}`, { waitUntil: "load" })
    await sheet(page).getByRole("button", { name: "看画面" }).click()
    await waitScreen(page, { control: false })
    await dialog(page).getByText("只读", { exact: true }).waitFor({ timeout: 10_000 })
    if (await addressBar(page).isEnabled()) throw new Error("只读时地址栏还能用")
    await page.screenshot({ path: join(SHOTS, "captcha-staff-readonly-dark.png") })
    await page.keyboard.press("Escape")
  })
  await step("负责人在待办里点「去浏览器里处理」：远程画面里是安全验证页", async () => {
    const { page } = admin
    await page.goto(`${BASE}#/todos?id=${state.captcha.itemId}`, { waitUntil: "load" })
    const s = sheet(page)
    await s.getByRole("img", { name: /截图/ }).waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(SHOTS, "captcha-human-item-dark.png") })
    await s.getByRole("button", { name: "去浏览器里处理" }).click()
    state.canvas = await waitScreen(page)
    await until(async () => (await addressBar(page).inputValue()).includes("/captcha"), 10_000, "地址栏是 /captcha")
  })
  await step("在远程画面里用输入法组字输入「人类」、按键输入「ok」，点「我不是机器人」，网页弹框里点确定 → 过了验证", async () => {
    const { page } = admin
    await clickScreen(page, state.canvas, ANSWER_BOX)
    await page.waitForTimeout(300)
    // 模拟输入法：先组字（compositionstart/update），再提交（compositionend）。远程画面应该只在组好时发一次 text
    const cdp = await page.context().newCDPSession(page)
    await cdp.send("Input.imeSetComposition", { text: "人", selectionStart: 1, selectionEnd: 1 })
    await cdp.send("Input.imeSetComposition", { text: "人类", selectionStart: 2, selectionEnd: 2 })
    await cdp.send("Input.insertText", { text: "人类" })
    await cdp.detach()
    await page.keyboard.type("ok", { delay: 50 })
    await page.waitForTimeout(500)
    await page.screenshot({ path: join(SHOTS, "captcha-typed-dark.png") })
    await clickScreen(page, state.canvas, HUMAN_BUTTON)
    // 网页的 confirm 显示成控制台里的对话框
    const confirmDialog = page.getByRole("alertdialog").filter({ hasText: "确定你不是机器人？" })
    await confirmDialog.waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(SHOTS, "captcha-page-dialog-dark.png") })
    await confirmDialog.getByRole("button", { name: "确定" }).click()
    await until(async () => (await addressBar(page).inputValue()).includes("/secret"), 15_000, "跳到 /secret（没跳说明输入的字不对）")
    await page.waitForTimeout(1000)
    await page.screenshot({ path: join(SHOTS, "captcha-passed-dark.png") })
  })
  await step("点「已处理好了」：同一个 session 继续，在同一个 Chrome 里读到暗号存成文件", async () => {
    const { page } = admin
    await dialog(page).getByRole("button", { name: "已处理好了" }).click()
    await toast(page, `${state.captcha.runId} 接着在同一个 Chrome 里做`)
    const run = await waitRun(page, state.captcha.runId, ["done"], 180_000)
    if (!run.events.some((event) => event.kind === "resume")) throw new Error("没有「继续」事件")
    const runs = (await api(page, "sessions.list", { taskId: state.captcha.taskId }))
    if (runs.length !== 1) throw new Error(`这个任务有 ${runs.length} 次运行，应该只有 1 次`)
    const files = await api(page, "engine.sessionFiles", { sessionId: run.id })
    const artifact = files.find((file) => file.kind === "artifact")
    if (!artifact) throw new Error("没有产物")
    const text = await (await page.context().request.get(`${BASE}${artifact.url.replace(/^\//, "")}`)).text()
    if (!text.includes(CODE)) throw new Error(`产物里没有暗号 ${CODE}：${text.slice(0, 200)}`)
    state.captchaCost = run.costUsd
    await page.goto(`${BASE}#/tasks?id=${state.captcha.taskId}&run=${run.id}`, { waitUntil: "load" })
    await sheet(page).getByText("已完成").first().waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(SHOTS, "captcha-done-dark.png") })
    console.log(`    产物 ${artifact.name}：${text.trim().slice(0, 80)}；花费 $${run.costUsd.toFixed(4)}`)
  })
  console.log("\n== 4. Chrome 过了保留时间：新开 Chrome 处理 → 关闭就保存 → 已处理好了 → 继续")
  await step("保留时间改成 1 分钟，再跑一次验证码任务（第二轮 ?k=r2）→ 等人处理", async () => {
    const { page } = admin
    const settings = await api(page, "settings.get")
    await apiPost(page, "settings.updateBrowser", { ...settings.browser, humanHoldMinutes: 1 })
    state.restoreHold = settings.browser
    state.expired = await createTask(page, {
      title: `第二轮：打开本地测试页，读出暗号，用存文件工具保存 ${RUN}`,
      steps: [
        `用浏览器打开 ${SITE}/captcha?k=r2`,
        "遇到安全验证时系统会交给人处理，等处理好以后继续：先看一下当前页面，不在暗号页就重新打开上面的网址",
        "读出页面上的暗号，用「存文件」工具保存成 code.txt，内容只写暗号",
      ],
      goal: "得到 code.txt，内容是测试页上的暗号",
      tools: ["浏览器", "存文件"],
      domains: ["127.0.0.1"],
    })
    await waitRun(page, state.expired.runId, ["needs_human"], 150_000)
    state.expired.itemId = (await api(page, "todos.board")).humanItems.find((each) => each.runId === state.expired.runId)?.id
    if (!state.expired.itemId) throw new Error("待办里没有这件事")
  })
  await step("过了 1 分钟 Chrome 写回登录态关掉；待办里变成「新开 Chrome 处理」", async () => {
    const { page } = admin
    await until(async () => !(await api(page, "browser.sessionBrowser", { sessionId: state.expired.runId })).open, 180_000, "保留的 Chrome 关掉")
    await page.goto(`${BASE}#/todos?id=${state.expired.itemId}`, { waitUntil: "load" })
    await sheet(page).getByText("过了保留时间").waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(SHOTS, "expired-human-item-dark.png") })
  })
  await step("「新开 Chrome 处理」：登录 Chrome 里打开测试页、过验证、关闭（保存）", async () => {
    const { page } = admin
    await sheet(page).getByRole("button", { name: "新开 Chrome 处理" }).click()
    const canvas = await waitScreen(page)
    await addressBar(page).click()
    await addressBar(page).fill(`${SITE}/captcha?k=r2`)
    await addressBar(page).press("Enter")
    await until(async () => (await addressBar(page).inputValue()).includes("/captcha?k=r2"), 20_000, "地址栏是测试页")
    await page.waitForTimeout(800)
    await clickScreen(page, canvas, ANSWER_BOX)
    await page.waitForTimeout(300)
    await page.keyboard.insertText("人类ok")
    await page.waitForTimeout(300)
    await clickScreen(page, canvas, HUMAN_BUTTON)
    const confirmDialog = page.getByRole("alertdialog").filter({ hasText: "确定你不是机器人？" })
    await confirmDialog.waitFor({ timeout: 15_000 })
    await confirmDialog.getByRole("button", { name: "确定" }).click()
    await until(async () => (await addressBar(page).inputValue()).includes("/secret"), 15_000, "跳到 /secret")
    await page.screenshot({ path: join(SHOTS, "expired-login-browser-dark.png") })
    await page.keyboard.press("Escape")
    await page.locator('[data-slot="dialog-content"]').waitFor({ state: "detached", timeout: 15_000 })
    await toast(page, "登录状态已保存", 30_000)
  })
  await step("点「已处理好了」：同一个 session 继续，新起的 Chrome 带着刚保存的登录态读到暗号", async () => {
    const { page } = admin
    await sheet(page).getByRole("button", { name: "已处理好了" }).click()
    await toast(page, `${state.expired.runId} 继续执行`)
    const run = await waitRun(page, state.expired.runId, ["done"], 180_000)
    const runs = await api(page, "sessions.list", { taskId: state.expired.taskId })
    if (runs.length !== 1) throw new Error(`这个任务有 ${runs.length} 次运行，应该只有 1 次`)
    const files = await api(page, "engine.sessionFiles", { sessionId: run.id })
    const artifact = files.find((file) => file.kind === "artifact")
    if (!artifact) throw new Error("没有产物")
    const text = await (await page.context().request.get(`${BASE}${artifact.url.replace(/^\//, "")}`)).text()
    if (!text.includes(CODE)) throw new Error(`产物里没有暗号 ${CODE}：${text.slice(0, 200)}`)
    state.expiredCost = run.costUsd
    console.log(`    产物 ${artifact.name}：${text.trim().slice(0, 80)}；花费 $${run.costUsd.toFixed(4)}`)
  })

  await step("浅色主题下看一眼浏览器页和运行详情", async () => {
    const { page } = admin
    await page.goto(`${BASE}?theme=light#/browsers?id=${state.profileId}`, { waitUntil: "load" })
    await waitLoaded(page, "浏览器")
    await page.screenshot({ path: join(SHOTS, "browsers-page-light.png") })
    await page.goto(`${BASE}?theme=dark#/browsers?id=${state.profileId}`, { waitUntil: "load" })
    await waitLoaded(page, "浏览器")
  })

  console.log("\n== 5. 浏览器控制台")
  for (const each of [admin, staff]) {
    // 远程画面断开时浏览器自己会打一条 WebSocket 关闭的日志，不算页面报错
    const errors = each.errors.filter((error) => !/WebSocket connection to .* failed/.test(error))
    if (errors.length) fail(`${each.label}的浏览器控制台有报错：${errors.slice(0, 3).join(" | ")}`)
    else ok(`${each.label}的浏览器控制台没有报错`)
  }
} finally {
  // 保留时间改回去
  if (state.restoreHold) await apiPost(admin.page, "settings.updateBrowser", state.restoreHold).catch(() => {})
  await browser.close()
  stopSite()
}

const cost = (state.exampleCost ?? 0) + (state.captchaCost ?? 0) + (state.expiredCost ?? 0)
console.log(`\n三次运行的模型花费合计 $${cost.toFixed(4)}；截图在 ${SHOTS}`)
if (failures.length) {
  console.log(`\n${failures.length} 项没通过`)
  process.exit(1)
}
console.log("\n全部通过")
