#!/usr/bin/env node
// 控制台冒烟测试（无头 Chromium，playwright-core），以「空白正式环境」为准（M1 P2）：
//   全新环境一个账号都没有：先在「设置管理员」页建管理员 admin@heyagent.local，随机密码先写进密码文件（权限 600，不打印）；
//   已经设置过的环境就读这个文件。
// 用法：node apps/web/scripts/smoke.mjs [地址]       默认 http://127.0.0.1:8080/（整套 pod）；开发时传自己的前端地址，例如 http://127.0.0.1:5181/
//   SMOKE_ADMIN_PASSWORD_FILE  管理员密码文件（默认仓库根目录的 .dev/admin-password）
//   SMOKE_ADMIN_PASSWORD       直接给管理员密码（优先于文件；全新环境就用它设置管理员）
//   SMOKE_SHOTS      截图放哪（默认仓库根目录的 .dev/shots/m1-p2）
//   CHROME_PATH      Chromium 可执行文件（默认 ~/.cache/ms-playwright 里的 chrome-headless-shell）
//   CHROME_LIBS      Chromium 缺的系统库所在目录（开发机没有 sudo 装不了系统包，放在用户目录里），会加进 LD_LIBRARY_PATH
//   FONTCONFIG_FILE  中文字体配置（截图里中文要正常显示）
// 检查：
//   0. 全新环境：打开控制台是「设置管理员」页，两次密码不一样有提示；建好后直接进控制台；之后不能再设置（接口回 409）；
//   1. 没登录是登录页，密码错有提示；
//   2. 管理员登录，每个页面都能打开（空白环境下显示空状态，写清下一步），控制台没有报错；
//   3. 新建一个员工账号；依次建工具（HTTP，含明文密钥被拦）、技能（发布）、记忆、规则、任务（含步骤和检查点）；
//   4. 修改（规则改名、任务停用）、删除（没人用的规则删了能撤销；被任务用着的记忆删不了）；
//   5. 亮暗两套主题各截一张图；
//   6. 新员工登录：任务只读（「你只能查看」）、看不到用户和设置、不能新建任务；能改自己的密码；
//   7. 全程浏览器控制台没有报错。
// 每次运行用不同的名字，可以对同一个环境重复跑。
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

import { ADMIN_EMAIL, ADMIN_NAME, newAdminPassword, readAdminPassword, setupNeeded } from "./admin-account.mjs"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const BASE = (process.argv[2] ?? "http://127.0.0.1:8080/").replace(/\/?$/, "/")
const PASSWORD_FILE = resolve(process.env.SMOKE_ADMIN_PASSWORD_FILE ?? join(repoRoot, ".dev/admin-password"))
/** 全新环境：要先设置管理员。密码先写进文件再去设置，免得建好了却没存下 */
const FRESH = await setupNeeded(BASE)
const ADMIN_PASSWORD = process.env.SMOKE_ADMIN_PASSWORD ?? (FRESH ? newAdminPassword(PASSWORD_FILE) : readAdminPassword(PASSWORD_FILE))
const SHOTS = resolve(process.env.SMOKE_SHOTS ?? join(repoRoot, ".dev/shots/m1-p2"))
const CHROME = process.env.CHROME_PATH ?? join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell")
const SCRATCH = "/tmp/claude-1000/-mnt-toshiba-Projects-HeyAgent/f5a5874c-3877-4626-bd8a-cb20c17939f4/scratchpad"
const LIBS = process.env.CHROME_LIBS ?? join(SCRATCH, "chromelibs/root/usr/lib/x86_64-linux-gnu")
const FONTS = process.env.FONTCONFIG_FILE ?? join(SCRATCH, "fonts/fonts.conf")

if (!ADMIN_PASSWORD) {
  console.error(`没有管理员密码：找不到 ${PASSWORD_FILE}，也没设置 SMOKE_ADMIN_PASSWORD`)
  process.exit(2)
}

const RUN = Date.now().toString(36).slice(-5)
const ADMIN = { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, name: ADMIN_NAME, admin: true }
const STAFF = { email: `staff-${RUN}@heyagent.local`, password: `staff-pass-${RUN}`, name: `测试员工${RUN}`, admin: false }
const NAMES = {
  tool: `查天气 ${RUN}`,
  skill: `周报整理 ${RUN}`,
  memory: `周报用表格写，按周排 ${RUN}`,
  rule: `对外发送前确认 ${RUN}`,
  spareRule: `临时规则 ${RUN}`,
  task: `整理每周报表 ${RUN}`,
}

/** 每个页面：空白环境下的标题（管理员 / 员工可能不同） */
const PAGES = [
  { id: "tasks", title: "任务" },
  { id: "todos", title: "待办" },
  { id: "sessions", title: "Session" },
  { id: "memory", title: "记忆" },
  { id: "skills", title: "技能" },
  { id: "rules", title: "规则" },
  { id: "tools", title: "工具" },
  { id: "browsers", title: "浏览器" },
  { id: "models", title: "模型" },
  { id: "users", title: "用户" },
  { id: "settings", title: "设置" },
  { id: "learn", title: "看懂架构" },
]

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

/** 一个干净的浏览器上下文，收集页面报错和控制台的 error */
async function newPage() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" })
  const page = await context.newPage()
  const errors = []
  page.on("pageerror", (error) => errors.push(`pageerror: ${error.message}`))
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(`console: ${message.text().slice(0, 200)}`)
  })
  return { context, page, errors }
}

/** 一步检查：出错记一条失败，接着做下一步 */
async function step(name, run) {
  try {
    await run()
    ok(name)
  } catch (error) {
    fail(`${name}：${String(error.message ?? error).split("\n")[0]}`)
  }
}

/** 等页面数据加载完：标题出来、骨架屏消失；出错提示出现算失败 */
async function waitLoaded(page, title) {
  await page.locator("h1", { hasText: title }).first().waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => !document.querySelector('[data-slot="skeleton"]'), null, { timeout: 15_000 })
  if (await page.getByText("加载失败").count()) throw new Error("页面显示「加载失败」")
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

async function signOut(page) {
  await page.goto("about:blank")
  await page.goto(`${BASE}#/tasks`, { waitUntil: "load" })
  await waitLoaded(page, "任务")
  await page.getByRole("button", { name: "账号菜单" }).click()
  await page.getByRole("menuitem", { name: "退出" }).click()
  await page.locator("#email").waitFor({ timeout: 10_000 })
}

/** 等一个 toast 出现（成功或出错的提示文字） */
async function toast(page, text, timeout = 15_000) {
  await page.locator('[data-slot="toast-title"], [data-slot="toast-description"]').filter({ hasText: text }).first().waitFor({ timeout })
}

const dialog = (page) => page.getByRole("dialog").last()

/**
 * 规则对话框（M3 起的流程）：点「保存并翻译」→ 等「规划」模型翻译完 → 能生效就「确认生效」，不支持就「知道了」。
 * 只改了名字、规则文字没变时不会重新翻译，弹窗保存后直接关掉。翻译要调模型，最多等 90 秒。
 */
async function saveAndConfirmRule(page) {
  await dialog(page).getByRole("button", { name: "保存并翻译" }).click()
  const content = page.locator('[data-slot="dialog-content"]')
  const confirm = dialog(page).getByRole("button", { name: "确认生效" })
  const gotIt = dialog(page).getByRole("button", { name: "知道了" })
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if ((await content.count()) === 0) return
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click()
      break
    }
    if (await gotIt.isVisible().catch(() => false)) {
      await gotIt.click()
      break
    }
    await page.waitForTimeout(300)
  }
  await content.waitFor({ state: "detached", timeout: 15_000 })
}

/** Base UI 的下拉：点输入框，打字过滤，点选项 */
async function pick(page, inputSelector, text, optionName = text) {
  const input = page.locator(inputSelector)
  await input.click()
  await input.fill(text)
  await page.getByRole("option", { name: optionName }).first().click()
  // 多选的下拉选完还开着：按 Esc 只关下拉；单选的已经关了，再按 Esc 会把整个弹窗关掉，所以先看一眼
  await page.waitForTimeout(200)
  if (await page.getByRole("listbox").first().isVisible().catch(() => false)) await page.keyboard.press("Escape")
}

// ---------- 首次设置（全新环境才有） ----------

console.log(`冒烟测试（空白环境）：${BASE}`)
if (FRESH) {
  console.log(`\n== 全新环境：先设置管理员（${ADMIN.email}），密码写在 ${PASSWORD_FILE}`)
  const { context, page, errors } = await newPage()
  await step("打开 #/tasks 是「设置管理员」页（不是登录页）；两次密码不一样有提示", async () => {
    await page.goto(`${BASE}#/tasks`, { waitUntil: "load" })
    await page.locator("#setup-email").waitFor({ timeout: 15_000 })
    if (await page.locator("#email").count()) throw new Error("同时出现了登录表单")
    await page.screenshot({ path: join(SHOTS, "setup-dark.png") })
    await page.fill("#setup-name", ADMIN.name)
    await page.fill("#setup-email", ADMIN.email)
    await page.fill("#setup-password", ADMIN.password)
    await page.fill("#setup-confirm", `${ADMIN.password}-x`)
    await page.click('button[type="submit"]')
    await page.getByText("两次输入的密码不一样").waitFor({ timeout: 5_000 })
  })
  await step("建好管理员后直接进控制台（不用再登录），能打开「用户」页", async () => {
    await page.fill("#setup-confirm", ADMIN.password)
    await page.click('button[type="submit"]')
    await page.getByRole("button", { name: "账号菜单" }).waitFor({ timeout: 15_000 })
    await waitLoaded(page, "任务")
    await open(page, "users", "用户")
    await page.getByText(ADMIN.email).first().waitFor({ timeout: 10_000 })
  })
  await step("设置过以后不能再设置：GET /api/setup 说不用，POST 回 409", async () => {
    if (await setupNeeded(BASE)) throw new Error("GET /api/setup 还说要设置")
    const response = await fetch(new URL("api/setup", BASE), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "后来的人", email: `late-${RUN}@heyagent.local`, password: `late-pass-${RUN}` }),
    })
    if (response.status !== 409) throw new Error(`POST /api/setup 回了 HTTP ${response.status}`)
  })
  if (errors.length) fail(`设置页控制台报错：${errors.join(" | ")}`)
  await context.close()
}

// ---------- 0. 没登录 ----------

{
  const { context, page, errors } = await newPage()
  await step("没登录打开 #/tasks 显示登录页；密码错提示「邮箱或密码不对」", async () => {
    await page.goto(`${BASE}#/tasks`, { waitUntil: "load" })
    await page.locator("#email").waitFor({ timeout: 15_000 })
    if (await page.locator("#setup-email").count()) throw new Error("设置过管理员了，还显示「设置管理员」页")
    await page.screenshot({ path: join(SHOTS, "login-dark.png") })
    await page.fill("#email", ADMIN.email)
    await page.fill("#password", "wrong-password")
    await page.click('button[type="submit"]')
    await page.getByText("邮箱或密码不对").waitFor({ timeout: 10_000 })
  })
  // 密码错时 better-auth 回 401，浏览器会把这个请求记成控制台报错，这是预期的，不算
  const unexpected = errors.filter((text) => !/status of 401/.test(text))
  if (unexpected.length) fail(`登录页控制台报错：${unexpected.join(" | ")}`)
  await context.close()
}

// ---------- 1. 管理员 ----------

console.log(`\n== 管理员（${ADMIN.email}）`)
{
  const { context, page, errors } = await newPage()
  try {
    await step("管理员登录", () => login(page, ADMIN))

    for (const each of PAGES) {
      const before = errors.length
      await step(`页面「${each.title}」能打开`, async () => {
        await open(page, each.id, each.title)
        await page.waitForTimeout(300)
        if (errors.length > before) throw new Error(`控制台报错 ${errors.slice(before).join(" | ")}`)
      })
    }

    await step("侧边栏有「用户」「设置」，用户菜单有「修改密码」", async () => {
      await page.getByRole("link", { name: "用户" }).first().waitFor({ timeout: 5_000 })
      await page.getByRole("link", { name: "设置" }).first().waitFor({ timeout: 5_000 })
      await page.getByRole("button", { name: "账号菜单" }).click()
      await page.getByRole("menuitem", { name: "修改密码" }).waitFor({ timeout: 5_000 })
      await page.keyboard.press("Escape")
    })

    await step("空白环境的任务页写清下一步（空状态 + 新建按钮）", async () => {
      await open(page, "tasks", "任务")
      if (await page.locator('main a[href^="#/tasks?id="]').count()) {
        console.log("    （不是空白环境：已经有任务了，跳过这一项）")
        return
      }
      const empty = page.locator('[data-slot="empty"]').first()
      await empty.getByText("还没有任务").waitFor({ timeout: 5_000 })
      await empty.getByRole("button", { name: "新建任务" }).waitFor({ timeout: 5_000 })
    })

    // ---------- 新建员工 ----------
    await step(`新建员工账号 ${STAFF.email}`, async () => {
      await open(page, "users", "用户")
      await page.getByRole("button", { name: "新建用户" }).first().click()
      const d = dialog(page)
      await d.locator("#user-email").fill(STAFF.email)
      await d.locator("#user-name").fill(STAFF.name)
      await d.locator("#user-title").fill("专员")
      await d.locator("#user-password").fill(STAFF.password)
      await d.getByRole("button", { name: "新建用户" }).click()
      await d.waitFor({ state: "hidden", timeout: 15_000 })
      await page.locator("main").getByText(STAFF.email).first().waitFor({ timeout: 10_000 })
    })

    // ---------- 工具 ----------
    await step("新建 HTTP 工具：模板里写明文密钥被拦下", async () => {
      await open(page, "tools", "工具")
      await page.getByRole("button", { name: "新建工具" }).first().click()
      const d = dialog(page)
      await d.locator("#tool-name").fill(NAMES.tool)
      await d.locator("#tool-description").fill("传入城市名，返回天气。只在要查天气时用。")
      await d.locator("#tool-url").fill("https://api.weather.example/v1/now?city={city}")
      await d.locator("#tool-headers").fill("Authorization: Bearer sk_live_abcdefgh12345678")
      await d.getByText("有明文密钥").first().waitFor({ timeout: 5_000 })
      await d.getByRole("button", { name: "接入这个接口" }).click()
      await page.waitForTimeout(500)
      if (!(await d.isVisible())) throw new Error("有明文密钥还是提交了")
    })
    await step("把明文挪进「密钥」后保存成功，密钥不出现在页面上", async () => {
      const d = dialog(page)
      await d.getByRole("button", { name: /明文密钥挪到这里/ }).click()
      await d.getByRole("button", { name: "接入这个接口" }).click()
      await d.waitFor({ state: "hidden", timeout: 15_000 })
      await page.locator("main h2", { hasText: NAMES.tool }).waitFor({ timeout: 10_000 })
      if (await page.getByText("sk_live_abcdefgh12345678").count()) throw new Error("页面上出现了密钥原文")
      await page.getByText("已保存在服务器").first().waitFor({ timeout: 5_000 })
    })

    // ---------- 技能 ----------
    await step("新建技能（草稿）并发布；操作手册按 Markdown 显示", async () => {
      await open(page, "skills", "技能")
      await page.getByRole("button", { name: "新建技能" }).first().click()
      const d = dialog(page)
      await d.locator("#skill-name").fill(NAMES.skill)
      // 第一次跑是「新建「通用」」，重复跑时已经有「通用」了
      await pick(page, "#skill-dept", "通用", /^(新建「)?通用(」)?$/)
      await d.locator("#skill-description").fill("每周五整理周报时使用")
      await d.locator("#skill-body").fill("## 步骤\n1. 汇总本周数据\n2. 写成表格\n\n| 项目 | 进度 |\n| --- | --- |\n| 示例 | 50% |")
      await d.getByRole("button", { name: "保存" }).click()
      await d.waitFor({ state: "hidden", timeout: 15_000 })
      await page.locator("main h2", { hasText: NAMES.skill }).waitFor({ timeout: 10_000 })
      await page.locator("main .typeset table").first().waitFor({ timeout: 5_000 })
      await page.locator("main").getByRole("button", { name: "更多操作" }).click()
      await page.getByRole("menuitem", { name: "发布" }).click()
      await toast(page, "已发布")
    })

    // ---------- 记忆 ----------
    await step("新建记忆", async () => {
      await open(page, "memory", "记忆")
      await page.getByRole("button", { name: "新建记忆" }).first().click()
      const d = dialog(page)
      await d.locator("#memory-content").fill(NAMES.memory)
      await pick(page, "#memory-applies-to", "公司经验", /^(新建「)?公司经验(」)?$/)
      await d.getByRole("button", { name: "保存" }).click()
      await d.waitFor({ state: "hidden", timeout: 15_000 })
      await page.locator("main h2", { hasText: NAMES.memory }).waitFor({ timeout: 10_000 })
    })

    // ---------- 规则 ----------
    for (const name of [NAMES.rule, NAMES.spareRule]) {
      await step(`新建规则「${name}」`, async () => {
        await open(page, "rules", "规则")
        await page.getByRole("button", { name: "新建规则" }).first().click()
        const d = dialog(page)
        await d.locator("#rule-name").fill(name)
        await d.locator("#rule-trigger").fill("要对外发送消息时")
        await d.locator("#rule-action").fill("先拦下，让负责人确认")
        await saveAndConfirmRule(page)
        await page.locator("main h2", { hasText: name }).waitFor({ timeout: 10_000 })
      })
    }

    // ---------- 任务 ----------
    await step("新建任务：两步（一步带检查点）+ 目标 + 选用记忆、技能、工具、规则", async () => {
      await open(page, "tasks", "任务")
      await page.getByRole("button", { name: "新建任务" }).first().click()
      // 建好以后会打开任务抽屉（也是 dialog），所以按标题认这个弹窗
      const d = page.getByRole("dialog", { name: "新建任务" })
      await d.locator("#task-title").fill(NAMES.task)
      await d.getByLabel("步骤 1", { exact: true }).fill("汇总本周的数据")
      await d.getByRole("button", { name: "添加步骤" }).click()
      await d.getByLabel("步骤 2", { exact: true }).fill("发到群里并等确认")
      // Base UI 的复选框：点它的 label
      await d.locator('label[for="step-1-wait"]').click()
      await d.locator('label[for="step-1-cp"]').click()
      await d.getByLabel("步骤 2 的检查点").fill("发出 1 条消息")
      await d.locator("#task-goal").fill("周报发到群里，负责人确认")
      await pick(page, "#task-memoryIds", NAMES.memory.slice(0, 6))
      await pick(page, "#task-skillIds", NAMES.skill)
      await pick(page, "#task-toolIds", NAMES.tool)
      await pick(page, "#task-ruleIds", NAMES.rule)
      await d.getByRole("button", { name: "只创建" }).click()
      await d.waitFor({ state: "hidden", timeout: 15_000 })
      const sheet = dialog(page)
      await sheet.getByText(NAMES.task).first().waitFor({ timeout: 10_000 })
      await sheet.getByText("发出 1 条消息").first().waitFor({ timeout: 5_000 })
      await sheet.getByText(NAMES.rule).first().waitFor({ timeout: 5_000 })
    })
    await step("任务停用（抽屉里的开关）", async () => {
      const sheet = dialog(page)
      await sheet.getByRole("switch", { name: "启动这个任务" }).click()
      await toast(page, "任务已停用")
      await sheet.getByText("已停用").first().waitFor({ timeout: 5_000 })
    })

    // ---------- 浏览器、模型 ----------
    await step("新建 Chrome（SOCKS5 代理，密码只存密文），再加一个新平台的账号", async () => {
      await open(page, "browsers", "浏览器")
      await page.getByRole("button", { name: "新建 Chrome" }).first().click()
      const d = page.getByRole("dialog", { name: "新建 Chrome" })
      await d.locator("#br-name").fill(`Office ${RUN}`)
      await d.locator("#br-desc").fill("办公室出口，用于测试")
      await d.getByRole("button", { name: "SOCKS5" }).click()
      await d.locator("#br-host").fill("10.0.0.8")
      await d.locator("#br-port").fill("1080")
      await d.locator("#br-password").fill(`proxy-pass-${RUN}`)
      await d.getByRole("button", { name: "创建" }).click()
      await d.waitFor({ state: "hidden", timeout: 15_000 })
      await page.locator("main h2", { hasText: `Office ${RUN}` }).waitFor({ timeout: 10_000 })
      if (await page.getByText(`proxy-pass-${RUN}`).count()) throw new Error("页面上出现了代理密码")
      await page.locator("main").getByRole("button", { name: "加账号" }).click()
      const a = page.getByRole("dialog", { name: /加账号/ })
      await pick(page, "#acc-platform", `Shop ${RUN}`, new RegExp(`Shop ${RUN}`))
      await a.locator("#acc-account").fill("ops@example.com")
      await a.getByRole("button", { name: "加账号" }).click()
      await a.waitFor({ state: "hidden", timeout: 15_000 })
      await page.locator("main").getByText("ops@example.com").first().waitFor({ timeout: 10_000 })
    })
    await step("模型页：OpenRouter 的几百个模型能搜索；默认设置能打开", async () => {
      await open(page, "models", "模型")
      await page.locator("main").getByRole("link", { name: /OpenRouter/ }).first().click()
      await page.getByLabel("搜模型").fill("sonnet-5.5")
      await page.locator("main table").getByText("Claude Sonnet 5.5").first().waitFor({ timeout: 10_000 })
      await page.locator("main").getByRole("link", { name: /默认设置/ }).first().click()
      await page.locator("main h2", { hasText: "默认设置" }).waitFor({ timeout: 10_000 })
    })

    // ---------- 修改、删除 ----------
    await step("规则改名", async () => {
      await open(page, "rules", "规则")
      await page.locator("main").getByRole("link", { name: new RegExp(NAMES.spareRule) }).first().click()
      await page.locator("main").getByRole("button", { name: "编辑" }).click()
      const d = dialog(page)
      await d.locator("#rule-name").fill(`${NAMES.spareRule}（改）`)
      await saveAndConfirmRule(page)
      await page.locator("main h2", { hasText: `${NAMES.spareRule}（改）` }).waitFor({ timeout: 10_000 })
    })
    await step("没人用的规则：删除不弹确认，toast 里撤销能恢复", async () => {
      await page.locator("main").getByRole("button", { name: "更多操作" }).click()
      await page.getByRole("menuitem", { name: "删除" }).click()
      await toast(page, "已删除规则")
      await page.getByRole("button", { name: "撤销" }).click()
      await toast(page, "已恢复规则")
      await page.locator("main").getByRole("link", { name: new RegExp(NAMES.spareRule) }).first().waitFor({ timeout: 10_000 })
    })
    await step("再删一次（不撤销）", async () => {
      await page.locator("main").getByRole("link", { name: new RegExp(NAMES.spareRule) }).first().click()
      await page.locator("main").getByRole("button", { name: "更多操作" }).click()
      await page.getByRole("menuitem", { name: "删除" }).click()
      await toast(page, "已删除规则")
      await page.waitForTimeout(500)
      if (await page.locator("main").getByRole("link", { name: new RegExp(NAMES.spareRule) }).count()) throw new Error("删了还在列表里")
    })
    await step("被任务选用的规则删不了，说清楚被哪个任务用着", async () => {
      await page.locator("main").getByRole("link", { name: new RegExp(NAMES.rule) }).first().click()
      await page.locator("main").getByRole("button", { name: "更多操作" }).click()
      await page.getByRole("menuitem", { name: "删除" }).click()
      const alert = page.getByRole("alertdialog")
      await alert.getByText("正在被使用，不能删除").waitFor({ timeout: 5_000 })
      await alert.getByText(NAMES.task).waitFor({ timeout: 5_000 })
      await alert.getByRole("button", { name: "知道了" }).click()
    })
    await step("被任务选用的记忆删不了", async () => {
      await open(page, "memory", "记忆")
      await page.locator("main").getByRole("link", { name: new RegExp(NAMES.memory.slice(0, 8)) }).first().click()
      await page.locator("main").getByRole("button", { name: "更多操作" }).click()
      await page.getByRole("menuitem", { name: "删除" }).click()
      await page.getByRole("alertdialog").getByText("正在被使用，不能删除").waitFor({ timeout: 5_000 })
      await page.getByRole("alertdialog").getByRole("button", { name: "知道了" }).click()
    })

    // ---------- 主题截图 ----------
    await step("默认暗色；亮暗两套主题各截一张图", async () => {
      await page.goto("about:blank")
      await open(page, "tasks", "任务")
      const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"))
      if (!(await isDark())) throw new Error("默认应该是暗色")
      await page.locator("main a", { hasText: NAMES.task }).first().waitFor({ timeout: 10_000 })
      await page.screenshot({ path: join(SHOTS, "admin-tasks-dark.png") })
      await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
      await page.keyboard.press("d")
      await page.waitForTimeout(300)
      if (await isDark()) throw new Error("按 D 没有切到浅色")
      await page.screenshot({ path: join(SHOTS, "admin-tasks-light.png") })
      await open(page, "skills", "技能")
      await page.locator("main").getByRole("link", { name: new RegExp(NAMES.skill) }).first().click()
      await page.locator("main .typeset").first().waitFor({ timeout: 5_000 })
      await page.screenshot({ path: join(SHOTS, "admin-skill-light.png"), fullPage: true })
      await page.getByRole("button", { name: /切换到(浅色|暗色)/ }).click()
      await page.waitForTimeout(300)
      if (!(await isDark())) throw new Error("点主题按钮没有切回暗色")
      await page.screenshot({ path: join(SHOTS, "admin-skill-dark.png"), fullPage: true })
      await open(page, "settings", "设置")
      await page.screenshot({ path: join(SHOTS, "admin-settings-dark.png"), fullPage: true })
      await open(page, "users", "用户")
      await page.screenshot({ path: join(SHOTS, "admin-users-dark.png") })
    })

    await step("退出后回到登录页", () => signOut(page))
  } catch (error) {
    fail(`管理员：${error.message.split("\n")[0]}`)
  }
  if (errors.length) fail(`管理员：控制台共有 ${errors.length} 条报错：${errors.join(" | ")}`)
  else ok("管理员：全程控制台没有报错")
  await context.close()
}

// ---------- 2. 新员工 ----------

console.log(`\n== 新员工（${STAFF.email}）`)
{
  const { context, page, errors } = await newPage()
  try {
    await step("新员工用初始密码登录", () => login(page, STAFF))
    await step("侧边栏看不到「用户」「设置」；任务页没有「新建任务」", async () => {
      if (await page.getByRole("link", { name: "用户" }).count()) throw new Error("员工看到了「用户」")
      if (await page.getByRole("link", { name: "设置" }).count()) throw new Error("员工看到了「设置」")
      await open(page, "tasks", "任务")
      if (await page.getByRole("button", { name: "新建任务" }).count()) throw new Error("员工看到了「新建任务」")
    })
    await step("员工打开别人负责的任务：显示「你只能查看」，没有开关", async () => {
      await page.locator("main a", { hasText: NAMES.task }).first().click()
      const sheet = dialog(page)
      await sheet.getByText("你只能查看").waitFor({ timeout: 10_000 })
      if (await sheet.getByRole("switch", { name: "启动这个任务" }).count()) throw new Error("员工看到了开关")
      await page.keyboard.press("Escape")
    })
    await step("员工直接打开 #/users 和 #/settings：提示只有主管能用", async () => {
      await open(page, "users", "用户")
      await page.getByText("只有主管能管理用户").waitFor({ timeout: 5_000 })
      await open(page, "settings", "设置")
      await page.getByText("只有主管").first().waitFor({ timeout: 5_000 })
    })
    await step("员工看配置页没有新建按钮", async () => {
      for (const each of [["rules", "规则", "新建规则"], ["tools", "工具", "新建工具"], ["skills", "技能", "新建技能"], ["memory", "记忆", "新建记忆"]]) {
        await open(page, each[0], each[1])
        if (await page.getByRole("button", { name: each[2] }).count()) throw new Error(`员工在「${each[1]}」看到了「${each[2]}」`)
      }
    })
    await step("员工在用户菜单里改自己的密码，用新密码能登录", async () => {
      await open(page, "tasks", "任务")
      await page.getByRole("button", { name: "账号菜单" }).click()
      await page.getByRole("menuitem", { name: "修改密码" }).click()
      const d = dialog(page)
      await d.locator("#pw-current").fill(STAFF.password)
      await d.locator("#pw-new").fill(`${STAFF.password}-new`)
      await d.locator("#pw-confirm").fill(`${STAFF.password}-new`)
      await d.getByRole("button", { name: "保存" }).click()
      await toast(page, "密码改好了")
      await signOut(page)
      await login(page, { ...STAFF, password: `${STAFF.password}-new` })
      await page.screenshot({ path: join(SHOTS, "staff-tasks-dark.png") })
    })
  } catch (error) {
    fail(`新员工：${error.message.split("\n")[0]}`)
  }
  if (errors.length) fail(`新员工：控制台共有 ${errors.length} 条报错：${errors.join(" | ")}`)
  else ok("新员工：全程控制台没有报错")
  await context.close()
}

await browser.close()
console.log(`\n截图：${SHOTS}`)
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项`)
  process.exit(1)
}
console.log("\n全部通过")
