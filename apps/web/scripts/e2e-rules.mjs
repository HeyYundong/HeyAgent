#!/usr/bin/env node
// 规则、检查点、三方验收端到端验收（M3-B）：照真人的路径在控制台里走一遍，用真模型（执行 Haiku，验收 Gemini Flash）。
// 「验收争议」：模拟「说做完了其实没做完」——步骤让 agent 存完文件就说做完了、不勾检查点，检查点「发给 3 个同事」没有任何记录，
// 验收模型判不通过；验收只给 1 轮，直接交给负责人。（跳过理由站得住的，验收模型会判通过，所以不能让 agent 自己标跳过）
// 前提：整套 pod 开着（scripts/pod.sh up，空白环境即可），OpenRouter 已自动接入。跑之前先执行 scripts/or-usage.sh check 18。
// 用法：node apps/web/scripts/e2e-rules.mjs [地址]      默认 http://127.0.0.1:8080/
//   E2E_ADMIN_PASSWORD_FILE  管理员密码文件（默认仓库根目录的 .dev/admin-password）；全新环境会先设置管理员，随机密码写进这个文件
//   E2E_MODEL                执行模型 id 里要有的字（默认 claude-haiku）
//   E2E_VERIFY_MODEL         验收模型 id 里要有的字（默认 gemini 加 flash）
//   E2E_SHOTS                截图放哪（默认 .dev/shots/m3-b）
//   E2E_SKIP_DISPUTE=1       不跑「验收争议」那一段
//   CHROME_PATH / CHROME_LIBS / FONTCONFIG_FILE  同 smoke.mjs
// 检查（docs/dev/m3.md 第 7 条 + M3-B 说明的端到端验收）：
//   1. 管理员建三条规则，每条都走「保存 → 翻译 → 显示『系统理解为』→ 确认」：调用「通知员工」前交给负责人批准、说做完了交给验收、调工具后自动记录检查点；
//   2. 建一条翻译不进去的规则：显示「未生效」，建任务时选不了；
//   3. 建任务选上三条规则：执行 Haiku、验收 Gemini Flash，用「通知员工」「存文件」，带检查点；
//   4. 运行：待办里「审批工具调用」能看到工具名和参数，批准后继续；存文件后检查点自动记录（标「自动」）；验收结果在 session 页逐条显示；完成；
//   5. 「存为任务步骤」：agent 的步骤存进任务，任务详情里能看到；
//   6. 设置页改 agent 设置；
//   7. 员工能看，但操作不了别人负责的；
//   8. 「验收争议」：故意写和步骤矛盾、做不到的检查点，验收只给 1 轮 → 争议 → 补充说明后继续 → 再争议 → 算通过；再跑一次 → 算失败；
//   9. 两个账号全程浏览器控制台没有报错。
import { existsSync, mkdirSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { chromium } from "playwright-core"

import { ensureAdmin } from "./admin-account.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "../../..")
const BASE = (process.argv[2] ?? "http://127.0.0.1:8080/").replace(/\/?$/, "/")
const PASSWORD_FILE = resolve(process.env.E2E_ADMIN_PASSWORD_FILE ?? join(repoRoot, ".dev/admin-password"))
const MODEL_HINT = process.env.E2E_MODEL ?? "claude-haiku"
const VERIFY_HINT = process.env.E2E_VERIFY_MODEL ?? "gemini"
const SHOTS = resolve(process.env.E2E_SHOTS ?? join(repoRoot, ".dev/shots/m3-b"))
const CHROME = process.env.CHROME_PATH ?? join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell")
const SCRATCH = "/tmp/claude-1000/-mnt-toshiba-Projects-HeyAgent/f5a5874c-3877-4626-bd8a-cb20c17939f4/scratchpad"
const LIBS = process.env.CHROME_LIBS ?? join(SCRATCH, "chromelibs/root/usr/lib/x86_64-linux-gnu")
const FONTS = process.env.FONTCONFIG_FILE ?? join(SCRATCH, "fonts/fonts.conf")

const RUN = Date.now().toString(36).slice(-5)
const ADMIN = await ensureAdmin(BASE, PASSWORD_FILE)
const STAFF = { email: `e2e-rules-${RUN}@heyagent.local`, password: `e2e-pass-${RUN}`, name: `规则验收员工${RUN}` }
const RULES = {
  approval: { name: `通知前要负责人批准 ${RUN}`, trigger: "agent 要调用「通知员工」工具之前", action: "先拦下，交给任务负责人审批，批准了才执行", tools: ["通知员工"] },
  verify: { name: `做完交给三方验收 ${RUN}`, trigger: "agent 说做完了", action: "交给另一家的模型做三方验收，逐条核对检查点", tools: [] },
  sync: { name: `自动记录检查点 ${RUN}`, trigger: "agent 调用任意工具之后", action: "按工具的类别自动记录检查点", tools: [] },
  unsupported: { name: `回复要押韵 ${RUN}`, trigger: "agent 的回复写得不够押韵、读起来不顺口的时候", action: "让 agent 把回复改写成七言绝句再发", tools: [] },
}

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
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: "zh-CN", timezoneId: "Asia/Shanghai" })
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
    const lines = String(error.message ?? error).split("\n")
    // Playwright 的超时只写「Timeout」，把在等哪个元素那一行也带上
    const waiting = lines.find((line) => /waiting for/.test(line))
    fail(`${name}：${lines[0]}${waiting ? `（${waiting.trim()}）` : ""}`)
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

const runOf = async (page, id) => await api(page, "sessions.get", { id })

async function waitRun(page, id, statuses, timeout = 240_000) {
  const deadline = Date.now() + timeout
  let run
  while (Date.now() < deadline) {
    run = await runOf(page, id)
    if (run && statuses.includes(run.status)) return run
    if (run?.status === "failed" && !statuses.includes("failed")) {
      const error = run.events.findLast((event) => event.kind === "error")
      throw new Error(`${id} 失败了：${error?.title ?? ""} ${error?.detail ?? ""}`)
    }
    await page.waitForTimeout(1500)
  }
  throw new Error(`${id} 等 ${statuses.join("/")} 超时，现在是 ${run?.status}`)
}

const routeParams = (page) => new URLSearchParams(new URL(page.url()).hash.split("?")[1] ?? "")
const sheet = (page) => page.locator('[data-slot="sheet-content"]').last()
const dialog = (page) => page.locator('[data-slot="dialog-content"]').last()
const openItems = async (page, runId) => (await api(page, "todos.board")).humanItems.filter((item) => item.runId === runId)

/** 在规则页走一遍「新建 → 保存并翻译 → 系统理解为 → 确认生效（或看到不支持）」 */
async function createRule(page, rule, { expectSupported = true, shot } = {}) {
  await open(page, "rules", "规则")
  await page.getByRole("button", { name: "新建规则" }).first().click()
  const d = dialog(page)
  await d.locator("#rule-name").fill(rule.name)
  await d.locator("#rule-trigger").fill(rule.trigger)
  await d.locator("#rule-action").fill(rule.action)
  for (const tool of rule.tools) await pick(page, "#rule-tools", tool)
  await d.getByRole("button", { name: "保存并翻译" }).click()
  await d.getByText("正在用「规划」模型", { exact: false }).first().waitFor({ timeout: 10_000 }).catch(() => {})
  // 翻译要调模型：等弹窗标题变成「系统理解为」
  await dialog(page).getByRole("heading", { name: "系统理解为" }).waitFor({ timeout: 90_000 })
  const understood = (await dialog(page).locator('[data-slot="alert"]').first().innerText()).replace(/\s+/g, " ")
  if (shot) await page.screenshot({ path: join(SHOTS, shot) })
  const id = routeParams(page).get("id")
  if (expectSupported) {
    if (!/系统理解为/.test(understood)) throw new Error(`没显示「系统理解为」，而是：${understood.slice(0, 200)}`)
    await dialog(page).getByRole("button", { name: "确认生效" }).click()
    // 上一条规则的 toast 可能还在，所以等弹窗关掉、接口读到「生效」
    await page.locator('[data-slot="dialog-content"]').waitFor({ state: "detached", timeout: 15_000 })
    await toast(page, "已确认，这条规则生效了")
    const saved = await until(async () => {
      const each = (await api(page, "rules.list")).find((rule) => rule.id === id)
      return each?.compile?.status === "active" && each.compile.effective && each
    }, 10_000, "规则状态变成生效")
    return { id, understood: saved.compile.understood }
  }
  if (!/未生效/.test(understood)) throw new Error(`没显示「未生效」，而是：${understood.slice(0, 200)}`)
  await dialog(page).getByRole("button", { name: "知道了" }).click()
  const saved = (await api(page, "rules.list")).find((each) => each.id === id)
  if (saved?.compile?.status !== "unsupported" || saved.compile.effective) throw new Error(`状态不对：${JSON.stringify(saved?.compile)}`)
  return { id, understood: saved.compile.understood, reason: saved.compile.reason }
}

/** 新建任务（填步骤和检查点、工具、规则、执行和验收模型），创建并启动 */
async function createTask(page, { title, steps, goal, tools, rules, model, verifyModel, checkDisabledRule, shot }) {
  await open(page, "tasks", "任务")
  await page.getByRole("button", { name: "新建任务" }).first().click()
  const d = page.getByRole("dialog", { name: "新建任务" })
  await d.locator("#task-title").fill(title)
  for (const [index, { text, checkpoint }] of steps.entries()) {
    if (index > 0) await d.getByRole("button", { name: "添加步骤" }).click()
    await d.getByLabel(`步骤 ${index + 1}`, { exact: true }).fill(text)
    if (checkpoint) {
      await d.getByText("检查点", { exact: true }).nth(index).click()
      await d.getByLabel(`步骤 ${index + 1} 的检查点`).fill(checkpoint)
    }
  }
  await d.locator("#task-goal").fill(goal)
  for (const tool of tools) await pick(page, "#task-toolIds", tool)
  if (checkDisabledRule) {
    // 没生效的规则列出来但选不了
    const input = page.locator("#task-ruleIds")
    await input.click()
    await input.fill(checkDisabledRule)
    const option = page.getByRole("option", { name: new RegExp(checkDisabledRule) }).first()
    await option.waitFor({ timeout: 5_000 })
    const disabled = (await option.getAttribute("aria-disabled")) === "true" || (await option.getAttribute("data-disabled")) !== null
    await page.screenshot({ path: join(SHOTS, "task-dialog-rule-disabled-dark.png") })
    if (!disabled) throw new Error("没生效的规则在下拉里还能选")
    await option.click({ force: true }).catch(() => {})
    await page.keyboard.press("Escape")
    const chips = await d.locator('[data-slot="combobox-chip"]').allInnerTexts()
    if (chips.some((chip) => chip.includes(checkDisabledRule))) throw new Error("没生效的规则被选上了")
    await input.fill("")
  }
  for (const rule of rules) await pick(page, "#task-ruleIds", rule)
  await pick(page, "#task-model", model.name, new RegExp(model.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  await pick(page, "#task-verifyModel", verifyModel.name, new RegExp(verifyModel.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  if (await d.getByText("验收就不算第三方了").count()) throw new Error("执行和验收模型被判成同一家")
  await d.locator("#task-verifyModel").scrollIntoViewIfNeeded()
  await page.screenshot({ path: join(SHOTS, shot) })
  await d.getByRole("button", { name: "创建并启动" }).click()
  await d.waitFor({ state: "hidden", timeout: 20_000 })
  await page.waitForFunction(() => location.hash.includes("run="), null, { timeout: 15_000 })
  const params = routeParams(page)
  return { taskId: params.get("id"), runId: params.get("run") }
}

console.log(`规则、检查点、三方验收端到端验收：${BASE}（这次的后缀 ${RUN}）`)
const admin = await newPage("管理员")
const staff = await newPage("员工")
const state = { costs: {} }

try {
  console.log("\n== 0. 准备")
  await step("管理员登录；找到执行模型（Haiku）和验收模型（Gemini Flash）；「规划」默认模型可用", async () => {
    await login(admin.page, ADMIN)
    const overview = await api(admin.page, "models.overview")
    const models = overview.providers.flatMap((provider) => provider.models)
    state.model = models.find((model) => model.id.includes(MODEL_HINT))
    state.verifyModel = models.find((model) => model.id.includes(VERIFY_HINT) && /flash/i.test(model.id) && !/lite|image/i.test(model.id)) ?? models.find((model) => model.id.includes(VERIFY_HINT) && /flash/i.test(model.id))
    if (!state.model || !state.verifyModel) throw new Error(`模型不全：执行 ${state.model?.id}，验收 ${state.verifyModel?.id}（共 ${models.length} 个）`)
    console.log(`    执行 ${state.model.id}，验收 ${state.verifyModel.id}，规划 ${overview.defaults.plan}`)
    await apiPost(admin.page, "users.create", { email: STAFF.email, name: STAFF.name, title: "专员", role: "user", password: STAFF.password })
  })

  console.log("\n== 1. 建三条规则：保存 → 翻译 → 系统理解为 → 确认")
  await step(`审批规则「${RULES.approval.name}」：系统理解为里是调用「通知员工」前交给任务负责人审批`, async () => {
    const rule = await createRule(admin.page, RULES.approval, { shot: "rule-approval-understood-dark.png" })
    if (!/通知员工|notify\.staff/.test(rule.understood) || !/审批/.test(rule.understood) || !/任务负责人/.test(rule.understood)) throw new Error(`翻译不对：${rule.understood}`)
    state.approvalRule = rule
    console.log(`    系统理解为：${rule.understood}`)
  })
  await step(`三方验收规则「${RULES.verify.name}」：agent 说做完了时交给三方验收`, async () => {
    const rule = await createRule(admin.page, RULES.verify, { shot: "rule-verify-understood-dark.png" })
    if (!/做完了/.test(rule.understood) || !/三方验收/.test(rule.understood)) throw new Error(`翻译不对：${rule.understood}`)
    state.verifyRule = rule
    console.log(`    系统理解为：${rule.understood}`)
  })
  await step(`检查点自动记录规则「${RULES.sync.name}」：调用工具之后自动记录检查点`, async () => {
    const rule = await createRule(admin.page, RULES.sync, { shot: "rule-sync-understood-dark.png" })
    if (!/自动记录检查点/.test(rule.understood)) throw new Error(`翻译不对：${rule.understood}`)
    state.syncRule = rule
    console.log(`    系统理解为：${rule.understood}`)
  })
  await step("规则页详情显示「系统理解为」和「生效」", async () => {
    const { page } = admin
    await open(page, `rules?id=${state.approvalRule.id}`, "规则")
    await page.getByText(state.approvalRule.understood).first().waitFor({ timeout: 10_000 })
    await page.locator("main").getByText("生效", { exact: true }).first().waitFor({ timeout: 10_000 })
    await page.screenshot({ path: join(SHOTS, "rules-page-active-dark.png") })
  })

  console.log("\n== 2. 翻译不进去的规则")
  await step(`「${RULES.unsupported.name}」：显示「未生效（v1 还不支持）」和原因`, async () => {
    const rule = await createRule(admin.page, RULES.unsupported, { expectSupported: false, shot: "rule-unsupported-dark.png" })
    state.unsupportedRule = rule
    const { page } = admin
    await open(page, `rules?id=${rule.id}`, "规则")
    await page.locator("main").getByText("未生效（v1 还不支持）").first().waitFor({ timeout: 10_000 })
    await page.screenshot({ path: join(SHOTS, "rules-page-unsupported-dark.png") })
    console.log(`    原因：${rule.reason ?? rule.understood}`)
  })

  console.log("\n== 3. 建任务：三条规则，执行 Haiku，验收 Gemini Flash")
  await step("任务表单：没生效的规则选不了；选上三条规则、两个工具、两种模型，创建并启动", async () => {
    state.main = await createTask(admin.page, {
      title: `写一份今日简报并通知负责人（验收 ${RUN}）`,
      steps: [
        { text: "先用「写下步骤」写下你的做法", checkpoint: undefined },
        { text: "用「存文件」工具保存 brief.md，内容写三条今天要做的事（随便编，简短）", checkpoint: "简报文件已保存" },
        { text: "用「通知员工」工具通知任务负责人：简报已保存，标题写「今日简报已保存」。不要填 to（不填就是通知任务负责人）", checkpoint: "已通知负责人简报保存好了" },
      ],
      goal: "brief.md 已保存，并且通知了任务负责人",
      tools: ["存文件", "通知员工"],
      rules: [RULES.approval.name, RULES.verify.name, RULES.sync.name],
      model: state.model,
      verifyModel: state.verifyModel,
      checkDisabledRule: RULES.unsupported.name,
      shot: "task-dialog-main-dark.png",
    })
    const task = await api(admin.page, "tasks.get", { id: state.main.taskId })
    if (task.verifyModelId !== state.verifyModel.id || task.modelId !== state.model.id) throw new Error(`模型没存对：${task.modelId} / ${task.verifyModelId}`)
    if (task.ruleIds.length !== 3) throw new Error(`规则没存对：${task.ruleIds.join()}`)
  })

  console.log("\n== 4. 运行：审批工具调用 → 批准 → 自动记录检查点 → 验收 → 完成")
  await step("待办里出现「审批工具调用」，能看到工具名和参数；写备注、批准后继续", async () => {
    const { page } = admin
    for (let round = 0; round < 4; round++) {
      const run = await waitRun(page, state.main.runId, ["needs_human", "done"])
      if (run.status === "done") break
      const items = await openItems(page, run.id)
      if (items.some((each) => each.kind === "verify")) break
      const item = items.find((each) => each.kind === "approval")
      if (!item) throw new Error(`等人处理，但不是审批：${JSON.stringify(items.map((each) => each.kind))}`)
      if (!item.detail.toolCall) {
        // agent 自己用「问人」问了个问题（也是 approval 类）：不是规则拦下的，回答一句让它接着做
        console.log(`    （agent 问人：${item.summary.slice(0, 80)}…，回答后继续）`)
        await apiPost(page, "engine.resolveHumanItem", { itemId: item.id, how: "approve", note: "通知不用填 to，默认就发给任务负责人。照原计划继续。" })
        await until(async () => (await openItems(page, run.id)).every((each) => each.id !== item.id), 20_000, "回答后继续")
        continue
      }
      if (item.detail.toolCall.toolId !== "notify.staff") throw new Error(`toolCall 不对：${JSON.stringify(item.detail.toolCall)}`)
      await page.goto(`${BASE}#/todos?id=${item.id}`, { waitUntil: "load" })
      const s = sheet(page)
      await s.getByText("要调用的工具").waitFor({ timeout: 15_000 })
      await s.getByText("通知员工").first().waitFor()
      await s.getByText("notify.staff").first().waitFor()
      const params = await s.locator('[data-slot="code-block"]').first().innerText()
      if (!params.includes("title")) throw new Error(`参数里没有 title：${params.slice(0, 200)}`)
      if (!state.approved) {
        await page.screenshot({ path: join(SHOTS, "approval-tool-call-dark.png") })
        console.log(`    参数：${params.replace(/\s+/g, " ").slice(0, 160)}`)
      }
      await s.locator(`#human-note-${item.id}`).fill("可以发，简短一点")
      await s.getByRole("button", { name: "批准", exact: true }).click()
      await toast(page, "已批准")
      state.approved = (state.approved ?? 0) + 1
      await until(async () => (await runOf(page, run.id)).status !== "needs_human" || (await openItems(page, run.id)).every((each) => each.id !== item.id), 20_000, "批准后继续")
    }
    if (!state.approved) throw new Error("没出现审批")
  })
  await step("运行完成；验收结果在 session 页逐条显示（逐条结论和理由、第几轮、验收模型）", async () => {
    const { page } = admin
    let run = await waitRun(page, state.main.runId, ["done", "needs_human"])
    if (run.status === "needs_human") {
      // 验收没过交给人了：这条路也要能处理（记下来，算通过）
      const item = (await openItems(page, run.id)).find((each) => each.kind === "verify")
      if (!item) throw new Error("等人处理，但不是验收争议")
      console.log(`    （验收没一次通过：${item.detail.verification?.headline}，先算通过）`)
      await apiPost(page, "engine.resolveVerifyDispute", { itemId: item.id, how: "pass", note: "e2e：主流程先算通过" })
      run = await waitRun(page, state.main.runId, ["done"])
    }
    state.costs.main = run.costUsd
    const v = run.verification
    if (!v || !v.items?.length || !v.modelId) throw new Error(`没有逐条验收结果：${JSON.stringify(v)?.slice(0, 300)}`)
    if (v.modelId !== state.verifyModel.id) throw new Error(`验收模型不对：${v.modelId}`)
    if (!run.events.some((event) => event.kind === "rule")) throw new Error("过程里没有规则命中的事件")
    await page.goto(`${BASE}#/tasks?id=${state.main.taskId}&run=${run.id}`, { waitUntil: "load" })
    const s = sheet(page)
    await s.getByText(/^验收 · /).first().waitFor({ timeout: 15_000 })
    await s.getByText(v.items[0].reason).first().waitFor({ timeout: 10_000 })
    await s.getByText("每条检查点的结论").first().waitFor()
    await page.screenshot({ path: join(SHOTS, "session-verification-dark.png") })
    console.log(`    验收：${v.status} · ${v.headline} · ${v.items.map((item) => `${item.index}.${item.verdict}`).join(" ")} · 第 ${v.round} 轮`)
  })
  await step("存文件之后，检查点被自动记录（标「自动」）；过程里有规则命中（标「规则」）", async () => {
    const { page } = admin
    const run = await runOf(page, state.main.runId)
    const artifact = run.checkpoints.find((cp) => cp.kind === "artifact")
    const synced = artifact?.records.find((record) => record.synced)
    if (!synced) throw new Error(`产出文件的检查点没有自动记录：${JSON.stringify(artifact)}`)
    const s = sheet(page)
    await s.getByText(synced.text).first().scrollIntoViewIfNeeded()
    await s.getByText("自动", { exact: true }).first().waitFor({ timeout: 10_000 })
    await page.screenshot({ path: join(SHOTS, "session-checkpoint-auto-dark.png") })
    await s.getByText("规则", { exact: true }).first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SHOTS, "session-rule-events-dark.png") })
    console.log(`    自动记录：${synced.text}`)
  })

  console.log("\n== 5. 存为任务步骤")
  await step("agent 的步骤：「存为任务步骤」覆盖到任务里，任务详情里能看到", async () => {
    const { page } = admin
    const run = await runOf(page, state.main.runId)
    if (!run.exploredSteps?.length) throw new Error("这次运行 agent 没写下步骤（plan.set）")
    const s = sheet(page)
    await s.getByText("agent 的步骤").first().scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SHOTS, "session-agent-steps-dark.png") })
    await s.getByRole("button", { name: "存为任务步骤" }).click()
    // 任务原来有步骤：先确认覆盖
    await page.getByRole("alertdialog").getByRole("button", { name: "覆盖任务步骤" }).click()
    await toast(page, "已存为任务")
    const task = await api(page, "tasks.get", { id: state.main.taskId })
    if (task.steps.map((each) => each.text).join("|") !== run.exploredSteps.join("|")) throw new Error(`任务步骤没换成 agent 的：${task.steps.map((each) => each.text).join(" / ")}`)
    await page.goto(`${BASE}#/tasks?id=${state.main.taskId}`, { waitUntil: "load" })
    await sheet(page).getByText(run.exploredSteps[0]).first().waitFor({ timeout: 10_000 })
    await page.screenshot({ path: join(SHOTS, "task-steps-saved-dark.png") })
    console.log(`    存进任务的步骤：${run.exploredSteps.join(" → ")}`)
  })

  console.log("\n== 6. 设置页改 agent 设置")
  await step("「agent」分区：验收最多 1 轮、压缩上限 200000 token，保存；接口读回一致", async () => {
    const { page } = admin
    await open(page, "settings", "设置")
    await page.locator("#agent-verifyMaxRounds").fill("1")
    await page.locator("#agent-compactMaxTokens").fill("200000")
    await page.locator("form", { has: page.locator("#agent-verifyMaxRounds") }).getByRole("button", { name: "保存" }).click()
    await toast(page, "agent 设置已保存")
    const settings = await api(page, "settings.get")
    if (settings.agent?.verifyMaxRounds !== 1 || settings.agent?.compactMaxTokens !== 200000) throw new Error(`读回来不对：${JSON.stringify(settings.agent)}`)
    await page.locator("#agent-verifyMaxRounds").scrollIntoViewIfNeeded()
    await page.screenshot({ path: join(SHOTS, "settings-agent-dark.png") })
  })

  if (process.env.E2E_SKIP_DISPUTE !== "1") {
    console.log("\n== 8. 验收争议：做不到的检查点，验收只给 1 轮")
    await step("建任务（只选三方验收规则）：检查点里有一条这次做不到的，创建并启动", async () => {
      state.dispute = await createTask(admin.page, {
        title: `存一个 hello 文件 ${RUN}`,
        steps: [
          { text: "用「存文件」工具保存 hello.txt，内容是 hello。保存完不要调用「勾检查点」，也不要做别的，直接回复「做完了」", checkpoint: "已经把 hello.txt 发给 3 个同事" },
        ],
        goal: "hello.txt 已保存，并且发给了 3 个同事",
        tools: ["存文件"],
        rules: [RULES.verify.name],
        model: state.model,
        verifyModel: state.verifyModel,
        shot: "task-dialog-dispute-dark.png",
      })
    })
    await step("验收没过：待办里出现「验收争议」，附验收报告（逐条结论）", async () => {
      const { page } = admin
      const run = await waitRun(page, state.dispute.runId, ["needs_human", "done"])
      if (run.status === "done") throw new Error(`验收直接通过了（${run.verification?.headline}），真模型没触发争议`)
      const item = (await openItems(page, run.id)).find((each) => each.kind === "verify")
      if (!item?.detail.verification?.items?.length) throw new Error(`没有验收争议或没有逐条结论：${JSON.stringify(item)?.slice(0, 300)}`)
      state.dispute.itemId = item.id
      await page.goto(`${BASE}#/todos?id=${item.id}`, { waitUntil: "load" })
      const s = sheet(page)
      await s.getByText("验收报告").first().waitFor({ timeout: 15_000 })
      await s.getByText(item.detail.verification.items[0].reason).first().waitFor()
      for (const name of ["算通过", "补充说明后继续", "算失败"]) await s.getByRole("button", { name }).waitFor()
      await page.screenshot({ path: join(SHOTS, "verify-dispute-dark.png") })
      console.log(`    争议：${item.detail.verification.headline}`)
    })
    await step("员工能看到这件事，但没有处理按钮；规则页没有编辑、翻译；运行详情没有「存为任务步骤」", async () => {
      const { page } = staff
      await login(page, STAFF)
      await page.goto(`${BASE}#/todos?id=${state.dispute.itemId}`, { waitUntil: "load" })
      const s = sheet(page)
      await s.getByText("你只能查看").waitFor({ timeout: 15_000 })
      await s.getByText("验收报告").first().waitFor()
      for (const name of ["算通过", "补充说明后继续", "算失败"]) if (await s.getByRole("button", { name }).count()) throw new Error(`员工看到了「${name}」按钮`)
      await page.screenshot({ path: join(SHOTS, "staff-verify-dispute-readonly-dark.png") })
      await open(page, `rules?id=${state.approvalRule.id}`, "规则")
      await page.getByText(state.approvalRule.understood).first().waitFor({ timeout: 10_000 })
      for (const name of ["编辑", "翻译", "重新翻译", "确认生效", "新建规则"]) if (await page.getByRole("button", { name, exact: true }).count()) throw new Error(`员工在规则页看到了「${name}」`)
      await open(page, `rules?id=${state.unsupportedRule.id}`, "规则")
      await page.locator("main").getByText("未生效（v1 还不支持）").first().waitFor({ timeout: 10_000 })
      if (await page.getByRole("button", { name: "重新翻译" }).count()) throw new Error("员工看到了「重新翻译」")
      await page.screenshot({ path: join(SHOTS, "staff-rules-readonly-dark.png") })
      await page.goto(`${BASE}#/tasks?id=${state.main.taskId}&run=${state.main.runId}`, { waitUntil: "load" })
      await sheet(page).getByText(/^验收 · /).first().waitFor({ timeout: 15_000 })
      if (await sheet(page).getByRole("button", { name: "存为任务步骤" }).count()) throw new Error("员工看到了「存为任务步骤」")
      await page.screenshot({ path: join(SHOTS, "staff-session-readonly-dark.png") })
      // 接口也拦
      const response = await page.context().request.post(`${BASE}api/trpc/engine.resolveVerifyDispute`, { data: { itemId: state.dispute.itemId, how: "pass" } })
      if (response.status() !== 403) throw new Error(`员工调 resolveVerifyDispute 返回 ${response.status()}`)
    })
    await step("「补充说明后继续」：不写说明不让提交；写了说明后同一个 session 继续，再说做完了重新验收", async () => {
      const { page } = admin
      await page.goto(`${BASE}#/todos?id=${state.dispute.itemId}`, { waitUntil: "load" })
      await sheet(page).getByRole("button", { name: "补充说明后继续" }).click()
      const d = dialog(page)
      await d.getByRole("button", { name: "继续" }).click()
      await d.getByText("写上说明").waitFor({ timeout: 5_000 })
      await page.screenshot({ path: join(SHOTS, "verify-dispute-explain-required-dark.png") })
      await d.locator("#dispute-explain").fill("不用补做，也不要调用任何工具，直接再回复一次「做完了」")
      await d.getByRole("button", { name: "继续" }).click()
      await toast(page, "已补充说明")
      const run = await waitRun(page, state.dispute.runId, ["needs_human", "done"])
      const runs = await api(page, "sessions.list", { taskId: state.dispute.taskId })
      if (runs.length !== 1) throw new Error(`应该还是同一个 session，现在有 ${runs.length} 个`)
      state.dispute.second = run.status === "needs_human" ? (await openItems(page, run.id)).find((each) => each.kind === "verify") : undefined
      console.log(`    继续后：${run.status}${run.verification ? ` · ${run.verification.headline}` : ""}`)
    })
    await step("再次争议时「算通过」：运行完成，验收报告写上谁判定的", async () => {
      const { page } = admin
      let run = await runOf(page, state.dispute.runId)
      if (run.status === "done") {
        console.log("    （补做后验收直接通过了，跳过「算通过」）")
        return
      }
      if (!state.dispute.second) throw new Error(`状态是 ${run.status}，但没有新的验收争议`)
      await page.goto(`${BASE}#/todos?id=${state.dispute.second.id}`, { waitUntil: "load" })
      await sheet(page).locator(`#human-note-${state.dispute.second.id}`).fill("截图这次确实做不到，按通过算")
      await sheet(page).getByRole("button", { name: "算通过" }).click()
      await toast(page, "已判定算通过")
      run = await waitRun(page, state.dispute.runId, ["done"], 30_000)
      if (run.verification?.resolution?.how !== "pass") throw new Error(`resolution 不对：${JSON.stringify(run.verification?.resolution)}`)
      state.costs.dispute = run.costUsd
      await page.goto(`${BASE}#/tasks?id=${state.dispute.taskId}&run=${run.id}`, { waitUntil: "load" })
      await sheet(page).getByText("判定算通过").first().waitFor({ timeout: 15_000 })
      await page.screenshot({ path: join(SHOTS, "verify-dispute-passed-dark.png") })
    })
    await step("同一个任务再跑一次 → 争议 →「算失败」（二次确认）：运行标失败", async () => {
      const { page } = admin
      const started = await apiPost(page, "engine.runNow", { taskId: state.dispute.taskId })
      const run = await waitRun(page, started.sessionId, ["needs_human", "done"])
      if (run.status === "done") throw new Error("这次验收直接通过了，没触发争议")
      const item = (await openItems(page, run.id)).find((each) => each.kind === "verify")
      if (!item) throw new Error("没有验收争议")
      await page.goto(`${BASE}#/todos?id=${item.id}`, { waitUntil: "load" })
      await sheet(page).locator(`#human-note-${item.id}`).fill("截图是目标的一部分，没做到就算失败")
      await sheet(page).getByRole("button", { name: "算失败" }).click()
      const confirm = page.getByRole("alertdialog")
      await confirm.getByText("判定这次运行算失败？").waitFor({ timeout: 5_000 })
      await page.screenshot({ path: join(SHOTS, "verify-dispute-fail-confirm-dark.png") })
      await confirm.getByRole("button", { name: "算失败" }).click()
      await toast(page, "已判定算失败")
      const ended = await waitRun(page, started.sessionId, ["failed"], 30_000)
      state.costs.disputeFail = ended.costUsd
      await page.goto(`${BASE}#/tasks?id=${state.dispute.taskId}&run=${ended.id}`, { waitUntil: "load" })
      await sheet(page).getByText("判定算失败").first().waitFor({ timeout: 15_000 })
      await page.screenshot({ path: join(SHOTS, "verify-dispute-failed-dark.png") })
    })
  }

  await step("设置改回默认（验收 2 轮、压缩 0）", async () => {
    await apiPost(admin.page, "settings.updateAgent", { verifyMaxRounds: 2, compactMaxTokens: 0 })
  })
  await step("浅色主题下看一眼规则页和运行详情", async () => {
    const { page } = admin
    await page.goto(`${BASE}?theme=light#/rules?id=${state.approvalRule.id}`, { waitUntil: "load" })
    await waitLoaded(page, "规则")
    await page.screenshot({ path: join(SHOTS, "rules-page-light.png") })
    await page.goto(`${BASE}?theme=light#/tasks?id=${state.main.taskId}&run=${state.main.runId}`, { waitUntil: "load" })
    await sheet(page).getByText(/^验收 · /).first().waitFor({ timeout: 15_000 })
    await page.screenshot({ path: join(SHOTS, "session-verification-light.png") })
    await page.goto(`${BASE}?theme=dark#/rules`, { waitUntil: "load" })
    await waitLoaded(page, "规则")
  })

  console.log("\n== 9. 浏览器控制台")
  for (const each of [admin, staff]) {
    // 员工故意调了一次没权限的接口（看后端拦不拦），那条 403 不是页面报错；页面本身的报错才算
    const errors = each.errors.filter((error) => !/status of 403/.test(error))
    if (errors.length) fail(`${each.label}的浏览器控制台有报错：${errors.slice(0, 3).join(" | ")}`)
    else ok(`${each.label}的浏览器控制台没有报错`)
  }
} finally {
  await apiPost(admin.page, "settings.updateAgent", { verifyMaxRounds: 2, compactMaxTokens: 0 }).catch(() => {})
  await browser.close()
}

const cost = Object.values(state.costs).reduce((sum, value) => sum + (value ?? 0), 0)
console.log(`\n运行的模型花费：${Object.entries(state.costs).map(([key, value]) => `${key} $${(value ?? 0).toFixed(4)}`).join("，")}；合计 $${cost.toFixed(4)}（不含翻译规则和验收之外的调用）；截图在 ${SHOTS}`)
if (failures.length) {
  console.log(`\n${failures.length} 项没通过`)
  process.exit(1)
}
console.log("\n全部通过")
