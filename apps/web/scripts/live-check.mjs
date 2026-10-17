#!/usr/bin/env node
// 实时推送演示 / 检查：林舟登录后停在 Session 页，直接改库里 R-1035-1 的状态，看页面多久跟着变，最后改回原来的状态。
// 用法：node apps/web/scripts/live-check.mjs [地址]
//   地址默认 http://127.0.0.1:8080/（整套 pod）；开发时传 http://127.0.0.1:5180/
//   LIVE_PSQL  执行 SQL 的命令（从标准输入读 SQL）。默认连开发数据库：podman exec -i heyagent-pg psql -U heyagent -d heyagent
//              整套 pod 用：podman exec -i heyagent-postgres psql -U heyagent -d heyagent
//   其余环境变量同 smoke.mjs（CHROME_PATH、CHROME_LIBS、FONTCONFIG_FILE、SMOKE_PASSWORD）
import { execSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { chromium } from "playwright-core"

const BASE = (process.argv[2] ?? "http://127.0.0.1:8080/").replace(/\/?$/, "/")
const PSQL = process.env.LIVE_PSQL ?? "podman exec -i heyagent-pg psql -U heyagent -d heyagent"
const PASSWORD = process.env.SMOKE_PASSWORD ?? "heyagent-dev"
const CHROME = process.env.CHROME_PATH ?? join(homedir(), ".cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell")
const SCRATCH = "/tmp/claude-1000/-mnt-toshiba-Projects-HeyAgent/f5a5874c-3877-4626-bd8a-cb20c17939f4/scratchpad"
const LIBS = process.env.CHROME_LIBS ?? join(SCRATCH, "chromelibs/root/usr/lib/x86_64-linux-gnu")
const FONTS = process.env.FONTCONFIG_FILE ?? join(SCRATCH, "fonts/fonts.conf")
const RUN = "R-1035-1"

const sql = (text) => execSync(PSQL + " -tA", { input: text, encoding: "utf8" }).trim()

const browser = await chromium.launch({
  executablePath: CHROME,
  env: {
    ...process.env,
    ...(existsSync(LIBS) ? { LD_LIBRARY_PATH: LIBS } : {}),
    ...(existsSync(FONTS) ? { FONTCONFIG_FILE: FONTS } : {}),
  },
  args: ["--no-sandbox"],
})
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const original = sql(`select status from sessions where id = '${RUN}';`)
let code = 0
try {
  await page.goto(BASE, { waitUntil: "load" })
  await page.fill("#email", "linzhou@heyagent.local")
  await page.fill("#password", PASSWORD)
  await page.click('button[type="submit"]')
  await page.goto(`${BASE}#/sessions`, { waitUntil: "load" })
  const row = page.locator("tr", { hasText: RUN })
  await row.waitFor({ timeout: 15_000 })
  console.log(`改之前：${RUN} 库里是 ${original}，页面上这一行：${(await row.innerText()).replace(/\s+/g, " ").slice(0, 60)}`)
  // 等订阅连上（SSE），再改库
  await page.waitForTimeout(1500)
  const next = original === "running" ? "waiting" : "running"
  const label = next === "running" ? "执行中" : "等待中"
  const started = Date.now()
  sql(`update sessions set status = '${next}' where id = '${RUN}';`)
  await page.locator("tr", { hasText: RUN }).filter({ hasText: label }).waitFor({ timeout: 10_000 })
  console.log(`改库：status = '${next}' → 页面 ${((Date.now() - started) / 1000).toFixed(2)} 秒后显示「${label}」`)
} catch (error) {
  console.log(`失败：${error.message.split("\n")[0]}`)
  code = 1
} finally {
  sql(`update sessions set status = '${original}' where id = '${RUN}';`)
  console.log(`已改回 ${original}`)
  await browser.close()
}
process.exit(code)
