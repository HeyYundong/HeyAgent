// 认出 URL、请求头、请求体里的明文密钥，换成 {{名字}}，值挪出来单独存在服务器上。检查（moved 不为空）和导入时自动挪走都用它。

export type Where = "url" | "headers" | "body"
export type Template = { url: string; headers: string; body: string }
export type Moved = { name: string; value: string; where: Where }

const KEYISH = String.raw`[^=&"\s:]*(?:key|token|secret|password|signature)[^=&"\s:]*`
const HEADER = /^([^:\n]*(?:authorization|token|key|secret|cookie)[^:\n]*):[ \t]*((?:Bearer|Basic|Token)[ \t]+)?([^{\n]{4,})$/gim
const PAIR = new RegExp(String.raw`([?&]|^)(${KEYISH})=([^&#{\s]{4,})`, "gim") // ?key=… 或表单 token=…
const JSON_PAIR = new RegExp(String.raw`"(${KEYISH})"\s*:\s*"([^"{]{4,})"`, "gi") // "api_key": "…"
const TOKEN = /\b(?:sk|pk|rk)[-_](?:live_|test_)?[A-Za-z0-9]{8,}|\bAIza[\w-]{20,}|\bghp_\w{20,}|\bxox[abp]-[\w-]{10,}/g // 常见密钥长相

export const snake = (text: string) => text.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "")
/** 名字前缀取接口的域名，例如 api.shipwise.example → SHIPWISE；IP 地址就用 API */
function hostPrefix(url: string) {
  const host = /^https?:\/\/([^/:?#]+)/i.exec(url.trim())?.[1] ?? ""
  return /^[\d.]+$/.test(host) || !host.includes(".") ? "API" : snake(host.split(".").at(-2)!)
}
const headerSuffix = (key: string) => (/authorization/i.test(key) ? "TOKEN" : /cookie/i.test(key) ? "COOKIE" : snake(key).replace(/^X_/, ""))

/** 把模板里的明文密钥换成 {{名字}}；taken 是模板里已经用掉的名字 */
export function moveSecrets(t: Template, taken: string[] = []) {
  const moved: Moved[] = []
  const prefix = hostPrefix(t.url)
  const slot = (suffix: string, value: string, where: Where) => {
    const same = moved.find((m) => m.value === value)
    if (same) return `{{${same.name}}}`
    const base = suffix.startsWith(prefix) ? suffix : `${prefix}_${suffix}`
    let name = base
    for (let n = 2; [...taken, ...moved.map((m) => m.name)].includes(name); n++) name = `${base}_${n}`
    moved.push({ name, value, where })
    return `{{${name}}}`
  }
  const pairs = (text: string, where: Where) => text.replace(PAIR, (_, lead, key, value) => `${lead}${key}=${slot(snake(key), value, where)}`)
  const generic = (text: string, where: Where) => text.replace(TOKEN, (value) => slot("TOKEN", value, where))
  const headers = t.headers.replace(HEADER, (_, key, auth = "", value) => `${key}: ${auth}${slot(headerSuffix(key), value.trim(), "headers")}`)
  const body = t.body.replace(JSON_PAIR, (_, key, value) => `"${key}": "${slot(snake(key), value, "body")}"`)
  const template = { url: generic(pairs(t.url, "url"), "url"), headers: generic(headers, "headers"), body: generic(pairs(body, "body"), "body") }
  return { template, moved }
}
