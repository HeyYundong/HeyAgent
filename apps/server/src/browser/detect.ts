// 验证码和登录页检测（m2.md 第 5 条）：每次调完浏览器工具，编排器看页面的地址、iframe 域名、标题和正文关键词。
// 只检测，不做任何自动破解。规则是通用的（常见验证码服务的域名、通用关键词、密码框），不针对任何具体网站。
// 规则拿不准时返回 uncertain，设置里打开了视觉判断（browser.visionCheck）才交给视觉模型看截图。

export interface PageFacts {
  url: string
  title: string
  /** 各个 frame 的地址（含主 frame） */
  frameUrls: string[]
  /** 正文开头一段（innerText，最多几千字） */
  text: string
  /** 页面上有没有看得见的密码输入框 */
  hasPasswordInput: boolean
}

export type Verdict =
  | { kind: "captcha"; reason: string }
  | { kind: "login"; reason: string }
  | { kind: "uncertain"; reason: string }
  | { kind: "none" }

/** 常见验证码 / 人机验证服务：frame 或页面地址里出现就算验证码页 */
const CAPTCHA_URLS: [RegExp, string][] = [
  [/(^|[./])google\.com\/recaptcha\//i, "reCAPTCHA"],
  [/(^|[./])recaptcha\.net\//i, "reCAPTCHA"],
  [/(^|[./])gstatic\.com\/recaptcha\//i, "reCAPTCHA"],
  [/(^|[./])hcaptcha\.com\//i, "hCaptcha"],
  [/(^|[./])arkoselabs\.com\//i, "Arkose"],
  [/(^|[./])funcaptcha\.com\//i, "Arkose"],
  [/(^|[./])geetest\.com\//i, "GeeTest"],
  [/(^|[./])geevisit\.com\//i, "GeeTest"],
  [/(^|[./])challenges\.cloudflare\.com\//i, "Cloudflare Turnstile"],
  [/(^|[./])captcha-delivery\.com\//i, "人机验证服务"],
]

/** 标题里出现就算验证码页（标题短，误报少） */
const CAPTCHA_TITLE = /captcha|robot check|are you a robot|verify you are (a )?human|human verification|attention required|just a moment|验证|滑块|人机/i

/** 正文里出现就算验证码页的明确说法 */
const CAPTCHA_TEXT_STRONG =
  /(请|需要)(完成|进行)?(安全)?验证|拖动(下方)?滑块|按住滑块|滑动验证|向右滑动|点击按钮(进行|开始)验证|i'?m not a robot|verify (that )?you are (a )?human|enter the characters you see|type the characters (you see|below)|our systems have detected unusual traffic|unusual traffic from your (computer|network)/i

/** 正文里出现只是拿不准（例如讲验证码的文章） */
const CAPTCHA_TEXT_WEAK = /验证码|captcha|robot|bot detection|security check|安全检查/i

/** 地址像登录页 */
const LOGIN_URL = /(^|[/._?=&-])(login|log-in|signin|sign-in|sign_in|logon|passport|sso|auth|account\/?signin)([/._?=&-]|$)/i
const LOGIN_WORDS = /登录|登入|sign in|log in|signin|login/i

export function judgePage(facts: PageFacts): Verdict {
  for (const url of [facts.url, ...facts.frameUrls]) {
    for (const [pattern, name] of CAPTCHA_URLS) if (pattern.test(url)) return { kind: "captcha", reason: `页面里有 ${name} 验证（${shorten(url)}）` }
  }
  if (CAPTCHA_TITLE.test(facts.title)) return { kind: "captcha", reason: `页面标题像验证码页：「${facts.title.slice(0, 60)}」` }
  const strong = CAPTCHA_TEXT_STRONG.exec(facts.text)
  if (strong) return { kind: "captcha", reason: `页面上有「${strong[0]}」` }
  if (/[/?&]captcha/i.test(facts.url)) return { kind: "captcha", reason: `地址像验证码页：${shorten(facts.url)}` }
  if (facts.hasPasswordInput) {
    if (LOGIN_URL.test(safePath(facts.url)) || LOGIN_WORDS.test(facts.title)) return { kind: "login", reason: `打开的是登录页（${shorten(facts.url)}），要人登录` }
    return { kind: "uncertain", reason: "页面上有密码输入框" }
  }
  const weak = CAPTCHA_TEXT_WEAK.exec(facts.text)
  if (weak) return { kind: "uncertain", reason: `页面上有「${weak[0]}」` }
  return { kind: "none" }
}

function safePath(url: string) {
  try {
    const parsed = new URL(url)
    return `${parsed.hostname}${parsed.pathname}${parsed.search}`
  } catch {
    return url
  }
}

const shorten = (url: string) => (url.length > 120 ? `${url.slice(0, 117)}…` : url)

/** 给视觉模型的提示：只要 JSON */
export const VISION_PROMPT =
  '这是一个网页的截图。判断它是不是「验证码 / 人机验证页」或者「要求登录的页面」。只输出 JSON，不要别的文字：{"captcha": true/false, "login": true/false, "reason": "一句话"}'

export function parseVisionAnswer(text: string): { captcha: boolean; login: boolean; reason: string } | undefined {
  const match = /\{[\s\S]*\}/.exec(text)
  if (!match) return undefined
  try {
    const value = JSON.parse(match[0]) as { captcha?: unknown; login?: unknown; reason?: unknown }
    return { captcha: value.captcha === true, login: value.login === true, reason: typeof value.reason === "string" ? value.reason : "" }
  } catch {
    return undefined
  }
}

/** 登录探测：最终地址不像登录页，页面上也没有密码输入框，就算还在登录状态（通用判断，m2.md 第 4 条） */
export function probeLooksLoggedIn(facts: Pick<PageFacts, "url" | "hasPasswordInput">): { ok: boolean; detail: string } {
  if (facts.hasPasswordInput) return { ok: false, detail: `探测网址打开后页面上有密码输入框（${shorten(facts.url)}）` }
  if (LOGIN_URL.test(safePath(facts.url))) return { ok: false, detail: `探测网址跳到了登录页（${shorten(facts.url)}）` }
  return { ok: true, detail: `还在登录状态（${shorten(facts.url)}）` }
}
