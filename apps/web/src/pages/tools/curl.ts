// 简单的 cURL 解析：从一条 curl 命令里取出方法、URL、请求头、请求体。
// 支持单引号、双引号、Chrome 的 $'…'、行尾 \ 换行，以及 -X -H -b -d/--data*/--json --url；其余开关忽略。

function tokenize(input: string): string[] {
  const text = input.replace(/\\\r?\n/g, " ")
  const tokens: string[] = []
  let current: string | null = null
  let quote: "'" | '"' | "$" | null = null // "$" = $'…'：单引号结尾，里面的 \ 转义有效
  for (let i = 0; i < text.length; i++) {
    const char = text[i]
    if (quote) {
      if (char === (quote === "$" ? "'" : quote)) quote = null
      else if (char === "\\" && quote !== "'") current += text[++i] === "n" && quote === "$" ? "\n" : text[i]
      else current += char
    } else if (char === "'" || char === '"' || (char === "$" && text[i + 1] === "'")) {
      quote = char === "$" ? (i++, "$") : char
      current ??= ""
    } else if (/\s/.test(char)) {
      if (current !== null) tokens.push(current)
      current = null
    } else {
      current = (current ?? "") + (char === "\\" ? text[++i] : char)
    }
  }
  if (current !== null) tokens.push(current)
  return tokens
}

const DATA = ["-d", "--data", "--data-raw", "--data-binary", "--data-urlencode", "--json"]

/** 解析失败时抛出带中文说明的 Error */
export function parseCurl(input: string) {
  const tokens = tokenize(input.trim())
  if (tokens[0] !== "curl") throw new Error("要以 curl 开头，例如从浏览器开发者工具里「复制为 cURL」")
  const result = { method: "", url: "", headers: [] as [string, string][], body: "" }
  const data: string[] = []
  for (let i = 1; i < tokens.length; i++) {
    const flag = tokens[i]
    const glued = /^-X(\w+)$/.exec(flag) // -XPOST
    if (glued) result.method = glued[1].toUpperCase()
    else if (flag === "-X" || flag === "--request") result.method = (tokens[++i] ?? "").toUpperCase()
    else if (flag === "-H" || flag === "--header") {
      const raw = tokens[++i] ?? ""
      const colon = raw.indexOf(":")
      if (colon > 0) result.headers.push([raw.slice(0, colon).trim(), raw.slice(colon + 1).trim()])
    } else if (flag === "-b" || flag === "--cookie") result.headers.push(["Cookie", tokens[++i] ?? ""])
    else if (DATA.includes(flag)) data.push(tokens[++i] ?? "")
    else if (flag === "--url") result.url = tokens[++i] ?? ""
    else if (!flag.startsWith("-") && !result.url) result.url = flag
  }
  if (!result.url) throw new Error("没找到 URL，检查一下命令是不是完整")
  result.body = data.join("&")
  try {
    result.body = result.body && JSON.stringify(JSON.parse(result.body), null, 2)
  } catch { /* 不是 JSON（例如表单），原样保留 */ }
  result.method ||= result.body ? "POST" : "GET"
  return result
}

/** 认出模板里的占位符：{参数} 由模型填，{{密钥}} 存在服务器上 */
export function placeholders(text: string) {
  const unique = (re: RegExp) => [...new Set([...text.matchAll(re)].map((m) => m[1]))]
  return { params: unique(/(?<!\{)\{([^{}]+)\}(?!\})/g), secrets: unique(/\{\{([^{}]+)\}\}/g) }
}
