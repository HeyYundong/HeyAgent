// 读包前先挪走明文密钥：模型看到的任何内容里都不能有原值。
// 找的地方：.env* 文件的「名字=值」；JSON / YAML / TOML / 代码里名字像密钥的键；请求头和 cURL 里的 Authorization、Cookie；
// 带用户名密码的网址；常见密钥长相（shared 的 secretTokenPattern，加上几种常见的）；PEM 私钥块。
// 同一个值只起一个名字（照 secretNameSchema，从键名推，重名加 _2），原文换成 {{名字}}。最后再把已知的值在所有文件里全文替换一遍。
// 这里只负责「找、换」；值加密存进 secrets（scope = import）由 reader 做。日志、错误信息里都只写名字和位置，不写值。
import { NOTIFY_SECRET_PREFIX, secretTokenPattern } from "@heyagent/shared"

export interface FoundSecret {
  name: string
  value: string
  /** 在包里哪儿（给人看，例如「config/.env 第 3 行」），不含值 */
  where: string
}

/** 名字合不合 secretNameSchema：大写字母开头，大写字母、数字、下划线，最长 64，NOTIFY_ 开头的留给通知渠道 */
export function secretNameFrom(hint: string): string {
  let name = hint
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
  if (!name) name = "SECRET"
  if (!/^[A-Z]/.test(name)) name = `K_${name}`
  if (name.startsWith(NOTIFY_SECRET_PREFIX)) name = `K_${name}`
  return name.slice(0, 60).replace(/_+$/, "")
}

/** 一次读包里找到的全部密钥：同一个值只起一个名字 */
export class SecretCollector {
  private readonly byValue = new Map<string, FoundSecret>()
  private readonly names = new Set<string>()

  /** taken：已经用掉的名字（例如方案里已经有的） */
  constructor(taken: string[] = []) {
    for (const name of taken) this.names.add(name)
  }

  /** 记下一个值，返回它的名字 */
  slot(hint: string, value: string, where: string): string {
    const same = this.byValue.get(value)
    if (same) return same.name
    const base = secretNameFrom(hint)
    let name = base
    for (let n = 2; this.names.has(name); n++) name = `${base}_${n}`
    this.names.add(name)
    this.byValue.set(value, { name, value, where })
    return name
  }

  /** 已经存好的密钥（例如导入时从 scope = import 里解出来的）：同一个值还用原来的名字 */
  seed(found: FoundSecret[]) {
    for (const each of found) {
      this.names.add(each.name)
      if (!this.byValue.has(each.value)) this.byValue.set(each.value, each)
    }
  }

  get found(): FoundSecret[] {
    return [...this.byValue.values()]
  }

  has(name: string) {
    return this.names.has(name)
  }
}

// ---------- 判断 ----------

/** 键名拆成词：apiKey → api key；client_secret → client secret */
const words = (key: string) =>
  key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)

const STRONG_WORDS = new Set(["password", "passwd", "pwd", "passphrase", "secret", "secrets", "token", "apikey", "credential", "credentials", "cookie", "cookies", "authorization", "privatekey", "accesskey", "secretkey", "jwt", "bearer"])
const WEAK_WORDS = new Set(["key", "auth", "pass", "private", "signature", "sig"])
/** 名字里有这些词就不是密钥（公钥、作者、令牌上限这类） */
const NOT_SECRET_WORDS = new Set(["public", "author", "max", "min", "count", "limit", "length", "type", "url", "uri", "endpoint", "path", "file", "name", "header", "expires", "expiry", "ttl"])

/** 开关类的键名（ALLOW_CREDENTIALS、enable_auth、is_secret）：值是开关，不是密钥 */
const SWITCH_PREFIXES = new Set(["allow", "enable", "enabled", "disable", "disabled", "use", "require", "required", "show", "has", "is", "include", "exclude", "should", "can", "need", "skip", "no", "with", "without"])
/** 分词器的特殊 token 名（eos_token、pad_token、mask_token）：值是 <s> 这类符号 */
const TOKENIZER_WORDS = new Set(["eos", "bos", "pad", "unk", "sep", "cls", "mask"])

type Strength = "strong" | "weak" | undefined

/**
 * 键名像不像密钥：看最后一个词（api_key、client_secret、access_token、password 像；secret_title、token_id、key_error 不像）。
 * strong 的任何值都算；weak 的值要看起来像随机串才算
 */
export function keyStrength(key: string): Strength {
  const list = words(key)
  if (list.length === 0) return undefined
  if (list.some((word) => NOT_SECRET_WORDS.has(word) || TOKENIZER_WORDS.has(word))) return undefined
  if (SWITCH_PREFIXES.has(list[0]!)) return undefined
  const last = list.at(-1)!
  if (STRONG_WORDS.has(last) || /(apikey|accesskey|secretkey|privatekey|clientsecret|apitoken|authtoken)$/.test(list.join(""))) return "strong"
  if (WEAK_WORDS.has(last)) return "weak"
  return undefined
}

/** 明显是占位符、开关、数字，不是真正的值 */
export function isPlaceholder(value: string): boolean {
  const v = value.trim()
  // 已经换成 {{名字}} 的（例如「Bearer {{AUTH_TOKEN}}」）不再挪
  if (v.length < 4 || v.includes("{{")) return true
  return /^(\{\{.*\}\}|\$\{?[\w.:-]+\}?|%[\w]+%|<[^>]*>|\[[^\]]*\]|x{3,}|\*{3,}|•+|\.{3,}|your[_\- ].*|changeme|change_me|todo|tbd|none|null|nil|undefined|true|false|yes|no|on|off|\d+(\.\d+)?|example|placeholder|replace[_\- ]?me|填.*|请填.*|在这里.*)$/i.test(v)
}

/**
 * 像不像一个密钥值（总检查，除了 PEM 块和网址里的密码，所有来源都过）：
 * 没有空白、中文、反引号、竖线、尖括号（那是说明文字、Markdown 表格、占位符）；不是 {参数}、$变量、$(命令)、正则片段；
 * 不以逗号、分号、冒号结尾（代码片段）；够长（.env 里至少 6，别处至少 8）；纯字母的短词（required、Bordered）不算
 */
export function plausibleSecret(value: string, minLength = 8): boolean {
  const v = value.trim()
  if (v.length < minLength || isPlaceholder(v)) return false
  if (/[\s`|<>{}[\]*()\\^]/.test(v)) return false
  if (/[\u2E80-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF00-\uFFEF\u3000-\u303F]/.test(v)) return false
  if (v.startsWith("$") || v.includes("$(") || v.includes("${")) return false
  if (/[,;:]$/.test(v)) return false
  // 省略号（文档里截断的示例）、路径（~/.ssh/id_rsa、/etc/x、./a）
  if (v.includes("…") || v.includes("...") || /^(~|\.{1,2})?\//.test(v)) return false
  if (/^[A-Za-z]+$/.test(v) && v.length < 12) return false
  // 全是小写字母和 - _ . 连起来的词（my-super-secret、ci-cache-key）：是名字、示例，不是随机生成的密钥
  if (/^[a-z]+([-_.][a-z]+)*$/.test(v)) return false
  return true
}

/** .env 里键名像密钥的值：不是占位符、没有空白和 Markdown 符号就算（口令可以是几个小写单词） */
const plausibleEnvSecret = (value: string) => value.length >= 4 && !isPlaceholder(value) && !/[\s`|<>{}]/.test(value) && !value.startsWith("$")

/** 网址里的密码不过总检查（可以很短），但不能是正则片段、变量、占位的单词（user:pass@、user:password@） */
const plausibleUrlPassword = (value: string) => !isPlaceholder(value) && !/[[\]*()\\{}$`|<>]/.test(value) && !(/^[A-Za-z]+$/.test(value) && value.length < 8)

/** Cookie 头的值：「名=值; 名=值」，分号后面可以有空格 */
const plausibleCookie = (value: string) =>
  /^[^\s=;]+=[^\s;]*(;\s*[^\s=;]+=[^\s;]*)*;?$/.test(value.trim()) && value.trim().length >= 8 && !/[`|<>{}$]/.test(value) && !value.includes("...") && !value.includes("…")

/** 看起来像随机串：没有空白，够长，字母数字混着 */
const looksRandom = (value: string) => !/\s/.test(value) && value.length >= 8 && ((/[a-z]/i.test(value) && /\d/.test(value)) || value.length >= 20)

const plainUrl = (value: string) => /^[a-z][a-z0-9+.-]*:\/\/[^\s@]+$/i.test(value.trim())

function secretValue(key: string, value: string): boolean {
  if (plainUrl(value) || !plausibleSecret(value)) return false
  const strength = keyStrength(key)
  if (strength === "strong") return true
  if (strength === "weak") return looksRandom(value)
  return false
}

// ---------- 替换 ----------

const PEM = /-----BEGIN ([A-Z0-9 ]*?)PRIVATE KEY-----[\s\S]*?-----END \1PRIVATE KEY-----/g
const URL_CREDS = /\b([a-z][a-z0-9+.-]*:\/\/)([^\s:@/'"<>]+):([^\s@/'"<>]+)@([^\s/'":?#<>]+)/gi
// 值到引号、反引号、竖线（Markdown 表格）或行尾为止
const HEADER = /\b(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|x-auth-token|x-access-token|x-token)(["'`]?[ \t]*:[ \t]*["']?)((?:bearer|basic|token|bot)[ \t]+)?([^"'`|\r\n]+?)(?=["'`|]|[ \t]*$)/gim
const CURL_USER = /(\s(?:-u|--user)[ \t]+["']?)([^\s:"']+):([^\s"']+)/g
const CURL_COOKIE = /(\s(?:-b|--cookie)[ \t]+)(["'])([^"'\r\n]+)\2/g
const JSON_PAIR = /"([^"\r\n]{1,80})"(\s*:\s*)"((?:[^"\\\r\n]|\\.){4,})"/g
const ASSIGN = /^(\s*(?:-\s+)?(?:export\s+)?)([A-Za-z_][\w.-]{0,80})([ \t]*[:=][ \t]*)(["']?)([^"'\r\n#]+?)\4([ \t]*(?:#.*)?)$/gm
const CODE_ASSIGN = /\b([A-Za-z_][\w]{0,80})(["']?[ \t]*[:=][ \t]*)(["'`])([^"'`\r\n]{4,})\3/g
const QUERY_PAIR = /([?&])([^=&\s"'#]{1,80})=([^&#\s"'<>]{4,})/g
const EXTRA_TOKENS = [
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\beyJ[\w-]{8,}\.eyJ[\w-]{8,}\.[\w-]{8,}/g,
  /\bgithub_pat_\w{20,}/g,
  /\bgh[ousr]_\w{20,}/g,
  /\bglpat-[\w-]{20,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
]

const wrap = (name: string) => `{{${name}}}`

/**
 * 程序源码：大的包里常有原 agent 框架自己的上万个源码文件，里面「api_key = ...」之类多半是测试数据。
 * 读包开始时不全扫（太慢、误报太多），AI 真要读的时候再按同样的规则挪（见 package.ts 的 text）
 */
export const isCodeFile = (path: string) =>
  /\.(py|pyi|js|mjs|cjs|ts|mts|cts|tsx|jsx|go|rs|java|kt|kts|rb|php|c|h|cc|cpp|hpp|cs|swift|scala|lua|pl|r|dart|vue|svelte|css|scss|less|html?|ipynb|lock)$/i.test(path)

/** .env、.env.local、prod.env 这类；.env.example、env.template 这类模板里是示例值，不算（只按键名认） */
export const isEnvFile = (path: string) => /(^|\/)\.env(\.[^/]*)?$|\.env$/i.test(path) && !/\.(example|sample|template|tpl|dist)$/i.test(path)

/**
 * 挪走一个文件里的明文密钥，返回换过的文字。行数不变（PEM 块换成名字后补上空行），AI 引用的行号和原文件对得上
 */
export function redactText(path: string, text: string, collector: SecretCollector): string {
  const where = (line: number) => `${path} 第 ${line} 行`
  // PEM 私钥块（跨行）：整块换成一个名字，行数保持不变
  let out = text.replace(PEM, (block: string, _kind: string, offset: number) => {
    const line = text.slice(0, offset).split("\n").length
    const name = collector.slot("PRIVATE_KEY", block, where(line))
    return wrap(name) + "\n".repeat(block.split("\n").length - 1)
  })
  const env = isEnvFile(path)
  out = out
    .split("\n")
    .map((original, index) => {
      const at = where(index + 1)
      let line = original
      const slot = (hint: string, value: string) => wrap(collector.slot(hint, value, at))
      // 带用户名密码的网址：只换密码
      line = line.replace(URL_CREDS, (whole, scheme: string, user: string, pass: string, host: string) =>
        plausibleUrlPassword(pass) ? `${scheme}${user}:${slot(`${host.split(".").at(-2) ?? host}_PASSWORD`, pass)}@${host}` : whole
      )
      // 请求头（cURL 的 -H、HTTP 文件、JSON 里的 headers）
      line = line.replace(HEADER, (whole, header: string, sep: string, scheme = "", value: string) => {
        const lower = header.toLowerCase()
        if (!(lower.includes("cookie") ? plausibleCookie(value) : plausibleSecret(value))) return whole
        const hint = lower.includes("authorization") ? "AUTH_TOKEN" : lower.includes("cookie") ? "COOKIE" : header
        return `${header}${sep}${scheme}${slot(hint, value.trim())}`
      })
      line = line.replace(CURL_USER, (whole, lead: string, user: string, pass: string) => (plausibleSecret(pass) ? `${lead}${user}:${slot(`${user}_PASSWORD`, pass)}` : whole))
      line = line.replace(CURL_COOKIE, (whole, lead: string, quote: string, value: string) => (plausibleCookie(value) ? `${lead}${quote}${slot("COOKIE", value)}${quote}` : whole))
      // .env（这里放的多半是账号和密钥）：键名像密钥的（PASSWORD、TOKEN、SECRET、KEY……），值只要不是占位符、网址、数字、开关就挪，
      // 口令可能就是几个小写单词（correct-horse-battery）；键名不像密钥的（NODE_ENV、LOG_LEVEL）值看起来像随机串才挪
      if (env) {
        line = line.replace(ASSIGN, (whole, lead: string, key: string, sep: string, quote: string, value: string, tail: string) => {
          const v = value.trim()
          const take = !plainUrl(v) && (keyStrength(key) ? plausibleEnvSecret(v) : plausibleSecret(v, 6))
          return take ? `${lead}${key}${sep}${quote}${slot(key, v)}${quote}${tail}` : whole
        })
      }
      // 名字像密钥的键：JSON、YAML / TOML / ini、代码里的赋值、网址参数
      line = line.replace(JSON_PAIR, (whole, key: string, sep: string, value: string) => (secretValue(key, value) ? `"${key}"${sep}"${slot(key, value)}"` : whole))
      line = line.replace(ASSIGN, (whole, lead: string, key: string, sep: string, quote: string, value: string, tail: string) =>
        secretValue(key, value.trim()) ? `${lead}${key}${sep}${quote}${slot(key, value.trim())}${quote}${tail}` : whole
      )
      line = line.replace(CODE_ASSIGN, (whole, key: string, sep: string, quote: string, value: string) => (secretValue(key, value) ? `${key}${sep}${quote}${slot(key, value)}${quote}` : whole))
      line = line.replace(QUERY_PAIR, (whole, lead: string, key: string, value: string) => (secretValue(key, value) ? `${lead}${key}=${slot(key, value)}` : whole))
      // 常见密钥长相（没有键名也认）
      for (const pattern of [secretTokenPattern(), ...EXTRA_TOKENS]) {
        line = line.replace(new RegExp(pattern.source, "g"), (found: string) => (plausibleSecret(found) ? slot("TOKEN", found) : found))
      }
      return line
    })
    .join("\n")
  return out
}

/**
 * 所有文件都找过一遍以后：已知的值在别的地方（没有键名的上下文里）也可能出现，全文再换一遍。
 * 太短的值不全文替换（容易误伤正常文字），它们只在键名旁边才算
 */
export function replaceKnownValues(text: string, found: FoundSecret[]): string {
  let out = text
  for (const secret of [...found].sort((a, b) => b.value.length - a.value.length)) {
    if (secret.value.length < 6) continue
    const forms = new Set([secret.value, JSON.stringify(secret.value).slice(1, -1), encodeURIComponent(secret.value)])
    for (const form of forms) if (form.length >= 6) out = out.split(form).join(wrap(secret.name))
  }
  return out
}

/** 一段文字里还有没有任何一个已知的原值（测试和兜底检查用） */
export function containsAnyValue(text: string, found: FoundSecret[]): boolean {
  return found.some((secret) => secret.value.length >= 4 && text.includes(secret.value))
}
