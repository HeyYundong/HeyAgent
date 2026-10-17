// 域名输入（平台域名、任务的网址白名单）：表单里是一段文字，每行一个或用逗号、空格隔开；提交前拆开、规整。
// 规整规则和后端一致（shared 的 normalizeDomain：去协议、路径、端口、开头的 *.，转小写）。
import { normalizeDomain } from "@heyagent/shared"

export function parseDomains(text: string): { domains: string[]; invalid: string[] } {
  const domains: string[] = []
  const invalid: string[] = []
  for (const part of text.split(/[\s,，、;；]+/)) {
    if (!part) continue
    const domain = normalizeDomain(part)
    if (!domain) invalid.push(part)
    else if (!domains.includes(domain)) domains.push(domain)
  }
  return { domains, invalid }
}

export const domainsText = (domains: readonly string[]) => domains.join("\n")

/** 校验不过时的提示 */
export const invalidDomainsMessage = (invalid: string[]) => `这些不是合法的域名：${invalid.join("、")}。写成 example.com 这样`
