// 指纹实测：UA 不含 HeadlessChrome、navigator.webdriver=false、时区 / 语言按参数生效、中文网页截图字形正常。
// 用法（容器内）：OUT_DIR=/out node t-fingerprint.mjs
import { chromium } from "playwright-core"
import path from "node:path"
import { startXvfb, startChrome, stopChrome, killGroup, dropStartupTab } from "./lib/browser.mjs"
import { startSite } from "./lib/site.mjs"

const OUT = process.env.OUT_DIR || "/tmp"
const site = await startSite()
const x = await startXvfb()
const result = []

const probe = () => ({
  ua: navigator.userAgent,
  brands: navigator.userAgentData?.brands?.map((b) => `${b.brand} ${b.version}`),
  webdriver: navigator.webdriver,
  tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
  dateString: new Date(Date.UTC(2026, 9, 17, 0, 0)).toString(),
  language: navigator.language,
  languages: navigator.languages,
  plugins: navigator.plugins.length,
  windowChrome: typeof window.chrome,
  screen: `${screen.width}x${screen.height}`,
  inner: `${innerWidth}x${innerHeight}`,
  outer: `${outerWidth}x${outerHeight}`,
  hardwareConcurrency: navigator.hardwareConcurrency,
  deviceMemory: navigator.deviceMemory,
  cjkFont: document.fonts.check('16px "Noto Sans CJK SC"'),
  webgl: (() => { try { const g = document.createElement("canvas").getContext("webgl"); const d = g.getExtension("WEBGL_debug_renderer_info"); return d ? g.getParameter(d.UNMASKED_RENDERER_WEBGL) : "无扩展" } catch (e) { return "无 WebGL" } })(),
})

for (const cfg of [
  { name: "默认：zh-CN + Asia/Shanghai", tz: "Asia/Shanghai", lang: "zh-CN", acceptLang: "zh-CN,zh" },
  { name: "美国出口：en-US + America/New_York", tz: "America/New_York", lang: "en-US", acceptLang: "en-US,en" },
  // 没有 GPU 时默认没有 WebGL；这个参数让 WebGL 走软件渲染（SwiftShader），只用来对比，不推荐默认打开
  { name: "默认 + --enable-unsafe-swiftshader", tz: "Asia/Shanghai", lang: "zh-CN", acceptLang: "zh-CN,zh", extra: ["--enable-unsafe-swiftshader"] },
]) {
  const s = await startChrome({ display: x.display, tz: cfg.tz, lang: cfg.lang, acceptLang: cfg.acceptLang, extra: cfg.extra || [] })
  const b = await chromium.connectOverCDP(s.ws, { noDefaults: true })
  const ctx = b.contexts()[0]
  const startup = ctx.pages()[0]
  await startup.goto(site.base + "/newtab.html")
  const startupTab = await startup.evaluate(() => `${innerWidth}x${innerHeight}`)
  const p = await dropStartupTab(ctx)
  site.requests.length = 0
  await p.goto(site.base + "/index.html")
  const r = { config: cfg.name, startupTabInner: startupTab, ...(await p.evaluate(probe)), acceptLanguageHeader: site.requests.find((q) => q.url === "/index.html")?.acceptLanguage }
  if (cfg.lang === "zh-CN" && !cfg.extra) {
    await p.screenshot({ path: path.join(OUT, "fp-local-zh.png") })
    try {
      await p.goto("https://zh.wikipedia.org/wiki/%E4%B8%AD%E6%96%87", { waitUntil: "load", timeout: 30000 })
      await p.waitForTimeout(1000)
      await p.screenshot({ path: path.join(OUT, "fp-zhwiki.jpg"), type: "jpeg", quality: 70 })
      r.zhwikiTitle = await p.title()
    } catch (e) { r.zhwikiError = e.message.split("\n")[0] }
  }
  result.push(r)
  await b.close()
  await stopChrome(s)
}
await killGroup(x.proc)
await site.close()
console.log(JSON.stringify(result, null, 1))
