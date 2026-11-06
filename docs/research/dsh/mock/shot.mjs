// Headless Chrome screenshots of the running dsh mock.
// Run (from host):
//   podman run --rm --network host --userns=keep-id --entrypoint node \
//     -v <tmp/dshmock>:/work localhost/heyagent-worker:before-1028 /work/shot.mjs <steps...>
// Reads the startup URL (with token) from /work/url.txt.
import { createRequire } from 'node:module'
import { readFileSync, writeFileSync } from 'node:fs'
const require = createRequire('/opt/browser/package.json')
const { chromium } = require('playwright-core')

const URL0 = readFileSync('/work/url.txt', 'utf8').trim()
const steps = process.argv.slice(2)
const OUT = '/work/shots'
const log = (...a) => console.log('[shot]', ...a)

const browser = await chromium.launch({ executablePath: '/opt/google/chrome/chrome', args: ['--no-sandbox', '--lang=zh-CN'] })

async function open(scheme, height = 900) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height }, colorScheme: scheme, locale: 'zh-CN', deviceScaleFactor: 1 })
  const page = await ctx.newPage()
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') log('console.' + m.type(), m.text().slice(0, 300)) })
  page.on('pageerror', e => log('pageerror', String(e).slice(0, 300)))
  await page.goto(URL0, { waitUntil: 'domcontentloaded' })
  await page.waitForTimeout(6000)
  // First-visit "预览版说明" notice.
  const cont = page.getByRole('button', { name: '继续' })
  if (await cont.count()) { await cont.first().click().catch(() => {}); await page.waitForTimeout(800) }
  return { ctx, page }
}

const shot = async (page, name) => { await page.screenshot({ path: `${OUT}/${name}.png` }); log('saved', name) }
const clickText = async (page, text, opts = {}) => {
  const loc = page.getByText(text, { exact: opts.exact ?? true }).first()
  await loc.click({ timeout: 8000 })
  await page.waitForTimeout(opts.wait ?? 1200)
}

for (const step of steps) {
  const [what, scheme = 'light', h] = step.split(':')
  const { ctx, page } = await open(scheme, h ? Number(h) : 900)
  try {
    if (what === 'home') {
      await shot(page, `home-${scheme}`)
      writeFileSync(`${OUT}/home-${scheme}.html`, await page.content())
    } else if (what === 'panels') {
      for (const [label, file] of [['要人办', 'inbox'], ['任务', 'tasks'], ['浏览器', 'browsers'], ['桌面', 'desktops']]) {
        await page.locator('nav, aside, [class*=sidebar], [class*=Sidebar]').getByText(label, { exact: true }).first().click({ timeout: 8000 })
        await page.waitForTimeout(1200)
        await shot(page, `panel-${file}-${scheme}`)
      }
    } else if (what === 'inbox-login') {
      await page.getByText('要人办', { exact: true }).first().click()
      await page.waitForTimeout(800)
      await page.getByText('1688 要登录：buyer01').first().click()
      await page.waitForTimeout(800)
      await shot(page, `panel-inbox-login-${scheme}`)
    } else if (what === 'task-runs') {
      await page.getByText('任务', { exact: true }).first().click()
      await page.waitForTimeout(800)
      await page.getByRole('tab', { name: '运行' }).click()
      await page.waitForTimeout(600)
      await shot(page, `panel-tasks-runs-${scheme}`)
    } else if (what === 'run') {
      // Start a fresh session and send the scripted task.
      const box = page.locator('[contenteditable="true"], textarea').first()
      await box.click({ timeout: 8000 })
      await page.keyboard.type('跑一次每日比价：不锈钢保温杯 500ml，挑 3 家发询价，交比价表')
      await page.waitForTimeout(400)
      await shot(page, `run-0-typed-${scheme}`)
      await page.keyboard.press('Enter')
      await page.waitForTimeout(4000)
      await shot(page, `run-1-progress-${scheme}`)
      await page.getByText('运行报告 · 每日比价').first().waitFor({ timeout: 120000 })
      await page.waitForTimeout(2500)
      await shot(page, `run-2-done-${scheme}`)
      writeFileSync(`${OUT}/run-${scheme}.html`, await page.content())
    } else if (what === 'open-run') {
      // Open the most recent session, expand the collapsed process, capture.
      const row = page.getByText(/每日比价/).first()
      await row.click({ timeout: 8000 })
      await page.waitForTimeout(2500)
      const done = page.getByText(/已完成，用时/).first()
      if (await done.count()) { await done.click().catch(() => {}); await page.waitForTimeout(1200) }
      for (const label of ['已调用工具', '已完成分析']) {
        const rows = page.getByText(label, { exact: true })
        const n = await rows.count()
        for (let i = n - 1; i >= 0; i--) { await rows.nth(i).click().catch(() => {}); await page.waitForTimeout(500) }
      }
      await page.evaluate(() => { for (const el of document.querySelectorAll('*')) { if (el.scrollHeight > el.clientHeight + 40 && getComputedStyle(el).overflowY.match(/auto|scroll/)) el.scrollTop = 0 } })
      await page.waitForTimeout(1200)
      await shot(page, `run-open-${scheme}${h ? '-tall' : ''}`)
      writeFileSync(`${OUT}/run-open-${scheme}.html`, await page.content())
    } else if (what === 'remote') {
      await page.getByText(/每日比价/).first().click({ timeout: 8000 })
      await page.waitForTimeout(2000)
      await page.getByRole('button', { name: '浏览器画面' }).first().click({ timeout: 8000 })
      await page.waitForTimeout(2000)
      await shot(page, `run-remote-view-${scheme}`)
    } else if (what === 'guide') {
      await page.getByText(/每日比价/).first().click({ timeout: 8000 })
      await page.waitForTimeout(2000)
      await page.getByRole('button', { name: /打开右侧边栏/ }).first().click({ timeout: 8000 })
      await page.waitForTimeout(2000)
      await shot(page, `run-rightbar-guide-${scheme}`)
    } else if (what === 'settings') {
      await page.getByRole('button', { name: '账号菜单' }).first().click({ timeout: 8000 })
      await page.waitForTimeout(800)
      await shot(page, `settings-menu-${scheme}`)
      await page.getByRole('menuitem', { name: /设置/ }).first().click({ timeout: 8000 }).catch(async () => { await clickText(page, '设置') })
      await page.waitForTimeout(1500)
      await shot(page, `settings-${scheme}`)
      await page.getByText('模型', { exact: true }).first().click().catch(() => {})
      await page.waitForTimeout(1500)
      await shot(page, `settings-models-${scheme}`)
    } else if (what === 'eval') {
      // Ad-hoc: dump visible button labels for selector discovery.
      const labels = await page.$$eval('button, [role=button], a', els => els.map(e => (e.getAttribute('aria-label') || e.textContent || '').trim()).filter(Boolean))
      log(JSON.stringify(labels.slice(0, 120)))
    }
  } catch (e) {
    log('step failed', step, String(e).slice(0, 500))
    await shot(page, `fail-${what}-${scheme}`)
  }
  await ctx.close()
}
await browser.close()
