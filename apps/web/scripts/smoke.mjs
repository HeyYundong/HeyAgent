#!/usr/bin/env node
// 控制台冒烟测试（无头 Chromium，playwright-core）。由 design/tools/linkcheck.mjs、shot.mjs 改造。
// 用法：node apps/web/scripts/smoke.mjs [地址]       默认 http://127.0.0.1:8080/（整套 pod）；开发时可以传 http://127.0.0.1:5180/
//   SMOKE_PASSWORD   演示账号的密码（默认 heyagent-dev，和 .env.example 的 SEED_PASSWORD 一致）
//   SMOKE_SHOTS      截图放哪（默认仓库根目录的 .dev/shots/m0）
//   CHROME_PATH      Chromium 可执行文件（默认 ~/.cache/ms-playwright 里的 chrome-headless-shell）
//   CHROME_LIBS      Chromium 缺的系统库所在目录（开发机没有 sudo 装不了系统包，放在用户目录里），会加进 LD_LIBRARY_PATH
//   FONTCONFIG_FILE  中文字体配置（截图里中文要正常显示）
// 检查：林舟（主管）、王悦（员工）分别登录；每个页面都打开，并打开一个详情；浏览器控制台没有报错；
// 员工看别人负责的事显示「你只能查看」；主题默认暗色、按钮可见、D 键能切换；亮暗各截一张图；退出后回到登录页。
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")
const BASE = (process.argv[2] ?? "http://127.0.0.1:8080/").replace(/\/?$/, "/")
const PASSWORD = process.env.SMOKE_PASSWORD ?? "heyagent-dev"
const SHOTS = resolve(process.env.SMOKE_SHOTS ?? join(repoRoot, ".dev/shots/m0"))
const CHROME = process.env.CHROME_PATH ?? join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell")
const SCRATCH = "/tmp/claude-1000/-mnt-toshiba-Projects-HeyAgent/f5a5874c-3877-4626-bd8a-cb20c17939f4/scratchpad"
const LIBS = process.env.CHROME_LIBS ?? join(SCRATCH, "chromelibs/root/usr/lib/x86_64-linux-gnu")
const FONTS = process.env.FONTCONFIG_FILE ?? join(SCRATCH, "fonts/fonts.conf")

const USERS = [
  { email: "linzhou@heyagent.local", name: "林舟", admin: true },
  { email: "wangyue@heyagent.local", name: "王悦", admin: false },
]

/** 每个页面：怎么打开一个详情。抽屉类（Sheet）等 role=dialog；左右分栏的等右边详情的标题 h2 */
const PAGES = [
  { id: "tasks", title: "任务", open: 'a[href^="#/tasks?id="]', expect: "dialog" },
  { id: "todos", title: "待办", open: "a[data-board-card]", expect: "dialog" },
  { id: "sessions", title: "Session", open: 'table a[href^="#/sessions?id="]', expect: "dialog" },
  { id: "memory", title: "记忆", open: 'a[href^="#/memory?id="]', expect: "h2" },
  { id: "skills", title: "技能", open: 'a[href^="#/skills?id="]', expect: "h2" },
  { id: "rules", title: "规则", open: 'a[href^="#/rules?id="]', expect: "h2" },
  { id: "tools", title: "工具", open: 'a[href^="#/tools?id="]', expect: "h2" },
  { id: "browsers", title: "浏览器", open: 'a[href^="#/browsers?id="]', expect: "h2" },
  { id: "models", title: "模型", open: 'a[href^="#/models?id="]', expect: "h2" },
  { id: "learn", title: "看懂架构", open: 'a[href^="#/learn?id="]', expect: "h2" },
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

/** 等页面数据加载完：标题出来、骨架屏消失；出错提示出现算失败 */
async function waitLoaded(page, title) {
  await page.locator("h1", { hasText: title }).first().waitFor({ timeout: 15_000 })
  await page.waitForFunction(() => !document.querySelector('[data-slot="skeleton"]'), null, { timeout: 15_000 })
  if (await page.getByText("加载失败").count()) throw new Error("页面显示「加载失败」")
}

async function login(page, user) {
  await page.goto(BASE, { waitUntil: "load" })
  await page.locator("#email").waitFor({ timeout: 15_000 })
  await page.fill("#email", user.email)
  await page.fill("#password", PASSWORD)
  await page.click('button[type="submit"]')
  await page.getByRole("button", { name: "账号菜单" }).waitFor({ timeout: 15_000 })
}

async function checkPages(page, errors, user) {
  for (const each of PAGES) {
    const before = errors.length
    try {
      await page.goto(`${BASE}#/${each.id}`, { waitUntil: "load" })
      await waitLoaded(page, each.title)
      const link = page.locator(each.open).first()
      await link.click()
      if (each.expect === "dialog") await page.getByRole("dialog").first().waitFor({ timeout: 10_000 })
      else await page.locator("main h2").first().waitFor({ timeout: 10_000 })
      await page.waitForTimeout(400)
      if (errors.length > before) fail(`${user.name} · ${each.title}：控制台报错 ${errors.slice(before).join(" | ")}`)
      else ok(`${user.name} · ${each.title}：打开了详情（${each.expect === "dialog" ? "抽屉" : "右侧详情"}），没有报错`)
    } catch (error) {
      fail(`${user.name} · ${each.title}：${error.message.split("\n")[0]}`)
    }
  }
}

/** 员工看别人负责的任务、分给别人的事：显示「你只能查看」，没有操作按钮；主管看同一个任务有开关 */
async function checkReadOnly(page, user) {
  await page.goto(`${BASE}#/tasks?id=T-1031`, { waitUntil: "load" })
  const sheet = page.getByRole("dialog").first()
  await sheet.waitFor({ timeout: 10_000 })
  const readOnly = await sheet.getByText("你只能查看").count()
  const toggle = await sheet.getByRole("switch", { name: "启动这个任务" }).count()
  if (user.admin) {
    if (toggle && !readOnly) ok(`${user.name}：T-1031（陈强负责）的抽屉有开关和「立即运行」`)
    else fail(`${user.name}：主管看 T-1031 应该能操作`)
  } else if (readOnly && !toggle) {
    ok(`${user.name}：T-1031（陈强负责）显示「负责人是 陈强，你只能查看」`)
  } else {
    fail(`${user.name}：员工看 T-1031 应该显示「你只能查看」`)
  }
  if (user.admin) return
  await page.goto(`${BASE}#/todos?id=ap-02`, { waitUntil: "load" })
  const human = page.getByRole("dialog").first()
  await human.waitFor({ timeout: 10_000 })
  if (await human.getByText("你只能查看").count()) ok(`${user.name}：待办 ap-02（分给林舟）显示「这件事分给了 林舟，你只能查看」`)
  else fail(`${user.name}：待办 ap-02 应该显示「你只能查看」`)
}

/** 写操作统一弹只读提示：主管在 T-1024 的抽屉里点「立即运行」/「立即继续」 */
async function checkReadOnlyToast(page) {
  await page.goto(`${BASE}#/tasks?id=T-1024`, { waitUntil: "load" })
  const sheet = page.getByRole("dialog").first()
  await sheet.waitFor({ timeout: 10_000 })
  await sheet.getByRole("switch", { name: "启动这个任务" }).click()
  if (await page.getByText("只读阶段：这个操作下一个里程碑接通").first().isVisible({ timeout: 5_000 }).catch(() => false)) ok("写操作弹「只读阶段：这个操作下一个里程碑接通」")
  else fail("点开关没有弹只读提示")
}

/** 主题：默认暗色、顶栏按钮可见、D 键切换；亮暗各截一张图 */
async function checkTheme(page, user) {
  // 先离开再进来：免得截到上一个抽屉的关闭动画和提示
  await page.goto("about:blank")
  await page.goto(`${BASE}#/tasks`, { waitUntil: "load" })
  await waitLoaded(page, "任务")
  const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"))
  if (await isDark()) ok("默认暗色")
  else fail("默认应该是暗色")
  const toggle = page.getByRole("button", { name: /切换到(浅色|暗色)/ })
  if (await toggle.isVisible()) ok("顶栏主题按钮可见")
  else fail("顶栏主题按钮不可见")
  await page.screenshot({ path: join(SHOTS, `${user.admin ? "admin" : "staff"}-tasks-dark.png`) })
  // D 键在输入框里不生效，先把焦点挪开
  await page.evaluate(() => document.activeElement instanceof HTMLElement && document.activeElement.blur())
  await page.keyboard.press("d")
  await page.waitForTimeout(300)
  if (!(await isDark())) ok("按 D 切换到浅色")
  else fail("按 D 没有切换主题")
  await page.screenshot({ path: join(SHOTS, `${user.admin ? "admin" : "staff"}-tasks-light.png`) })
  // 详情页也各截一张浅色，再切回暗色截一张
  await page.goto(`${BASE}#/todos?id=ap-03`, { waitUntil: "load" })
  await waitLoaded(page, "待办")
  await page.getByRole("dialog").first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(SHOTS, `${user.admin ? "admin" : "staff"}-todos-light.png`) })
  await page.keyboard.press("Escape")
  await page.getByRole("dialog").first().waitFor({ state: "hidden", timeout: 10_000 })
  await toggle.click()
  await page.waitForTimeout(300)
  if (await isDark()) ok("点主题按钮切回暗色")
  else fail("点主题按钮没有切回暗色")
  await page.goto(`${BASE}#/todos?id=ap-03`, { waitUntil: "load" })
  await page.getByRole("dialog").first().waitFor({ timeout: 10_000 })
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(SHOTS, `${user.admin ? "admin" : "staff"}-todos-dark.png`) })
}

async function checkSignOut(page) {
  // 抽屉开着时遮罩会挡住侧边栏，先回到没有抽屉的页面
  await page.goto("about:blank")
  await page.goto(`${BASE}#/tasks`, { waitUntil: "load" })
  await waitLoaded(page, "任务")
  await page.getByRole("button", { name: "账号菜单" }).click()
  await page.getByRole("menuitem", { name: "退出" }).click()
  await page.locator("#email").waitFor({ timeout: 10_000 })
  ok("侧边栏用户菜单「退出」后回到登录页")
  await page.goto(`${BASE}#/memory?id=m-003`, { waitUntil: "load" })
  await page.locator("#email").waitFor({ timeout: 10_000 })
  ok("退出后直接打开 #/memory?id=m-003 也是登录页")
}

console.log(`冒烟测试：${BASE}`)

// 没登录：任何页面都是登录页；截一张登录页
{
  const { context, page, errors } = await newPage()
  await page.goto(`${BASE}#/sessions?id=R-1024-1`, { waitUntil: "load" })
  try {
    await page.locator("#email").waitFor({ timeout: 15_000 })
    ok("没登录打开 #/sessions?id=R-1024-1 显示登录页")
    await page.screenshot({ path: join(SHOTS, "login-dark.png") })
    await page.fill("#email", "linzhou@heyagent.local")
    await page.fill("#password", "wrong-password")
    await page.click('button[type="submit"]')
    await page.getByText("邮箱或密码不对").waitFor({ timeout: 10_000 })
    ok("密码错时提示「邮箱或密码不对」")
  } catch (error) {
    fail(`登录页：${error.message.split("\n")[0]}`)
  }
  // 密码错时 better-auth 回 401，浏览器会把这个请求记成控制台报错，这是预期的，不算
  const unexpected = errors.filter((text) => !/status of 401/.test(text))
  if (unexpected.length) fail(`登录页控制台报错：${unexpected.join(" | ")}`)
  await context.close()
}

for (const user of USERS) {
  console.log(`\n== ${user.name}（${user.admin ? "主管" : "员工"}）`)
  const { context, page, errors } = await newPage()
  try {
    await login(page, user)
    ok(`${user.name} 登录成功`)
    await checkPages(page, errors, user)
    await checkReadOnly(page, user)
    if (user.admin) await checkReadOnlyToast(page)
    await checkTheme(page, user)
    await checkSignOut(page)
  } catch (error) {
    fail(`${user.name}：${error.message.split("\n")[0]}`)
  }
  if (errors.length) fail(`${user.name}：控制台共有 ${errors.length} 条报错：${errors.join(" | ")}`)
  else ok(`${user.name}：全程控制台没有报错`)
  await context.close()
}

await browser.close()
console.log(`\n截图：${SHOTS}`)
if (failures.length) {
  console.log(`\n失败 ${failures.length} 项`)
  process.exit(1)
}
console.log("\n全部通过")
