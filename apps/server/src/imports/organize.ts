// 整理方案（代码做，不交给模型）：模型交的方案按现有配置核对、规整。
// 负责人、模型、Chrome、平台、已有技能 / 记忆 / 规则 / 工具都按库里的现状对上；对不上的改成默认值或去掉，并在 warnings 里说；
// HTTP 模板、MCP 环境变量里还有明文的密钥挪走；算出方案要的密钥、没用上的文件。规则翻译（要调模型）由 reader 另外做。
import {
  hasPlainSecret,
  moveSecrets,
  normalizeDomain,
  secretNameSchema,
  templatePlaceholders,
  type ImportPlan,
  type PlanMemory,
  type PlanRule,
  type PlanSecret,
  type PlanTool,
  type PlanWarning,
  WORK_DISPATCH_TOOL_ID,
} from "@heyagent/shared"
import { cronText, isValidCron } from "@heyagent/shared"

import type { ImportCatalog } from "./catalog.js"
import { diffNote, lineDiff } from "./diff.js"
import type { ImportPackage } from "./package.js"
import { keyStrength, secretNameFrom, type SecretCollector } from "./redact.js"

export interface OrganizeContext {
  catalog: ImportCatalog
  /** 上传的人：负责人对不上时用他 */
  uploaderId: string
  /** 解压出来的包（文件清单） */
  pkg: ImportPackage
  /** 读包时挪走的密钥；这里挪出来的也记进去，reader 最后统一存 */
  collector: SecretCollector
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/
const HEADER_NAME = /^[A-Za-z0-9-]+$/
const PLACEHOLDER = /\{\{\s*([^{}\s]+)\s*\}\}/g
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

/** {{名字}} 里不合规矩的名字换成合规的（大写、下划线、不以 NOTIFY_ 开头） */
function fixPlaceholderNames(text: string): string {
  return text.replace(PLACEHOLDER, (_whole, name: string) => `{{${secretNameSchema.safeParse(name).success ? name : secretNameFrom(name)}}}`)
}

const headerLines = (headers: Record<string, string>) =>
  Object.entries(headers)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n")

function parseHeaderLines(lines: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of lines.split("\n")) {
    const at = line.indexOf(": ")
    if (at > 0) out[line.slice(0, at)] = line.slice(at + 2)
  }
  return out
}

/** 一段文字里引用的密钥名 */
export const secretNamesOf = (text: string) => templatePlaceholders(text).secrets

/** 一个新工具引用的全部密钥名（HTTP 模板、MCP 环境变量的值） */
export function toolSecretNames(tool: PlanTool): string[] {
  if (tool.kind === "http" && tool.http) return secretNamesOf(`${tool.http.url}\n${headerLines(tool.http.headers)}\n${tool.http.body ?? ""}`)
  if (tool.kind === "mcp" && tool.mcp) return [...new Set(tool.mcp.env.flatMap((each) => secretNamesOf(each.value)))]
  return []
}

/** 方案要的密钥：勾上的新工具引用的全部 {{名字}}。found / exists 按现在的状态算，filled 保留原来的 */
export function planSecrets(plan: ImportPlan, found: { name: string; where: string }[], existingNames: string[]): PlanSecret[] {
  const byName = new Map<string, string[]>()
  for (const tool of plan.tools) {
    if (!tool.include) continue
    for (const name of toolSecretNames(tool)) byName.set(name, [...(byName.get(name) ?? []), tool.key])
  }
  return [...byName.entries()]
    .filter(([name]) => secretNameSchema.safeParse(name).success)
    .slice(0, 100)
    .map(([name, toolKeys]) => {
      const hit = found.find((each) => each.name === name)
      const before = plan.secrets.find((each) => each.name === name)
      return {
        name,
        found: Boolean(hit),
        filled: before?.filled ?? false,
        exists: existingNames.includes(name),
        where: (hit?.where ?? (existingNames.includes(name) ? "已经有同名的密钥" : "包里没有值")).slice(0, 300),
        toolKeys: toolKeys.slice(0, 50),
      }
    })
}

/**
 * 核对、规整模型交的方案（不调模型）。返回新的方案；对不上的写进 warnings。
 * 调用前方案自己要对得上（planProblems 为空，key 不重复）
 */
export function organizePlan(input: ImportPlan, ctx: OrganizeContext): ImportPlan {
  const plan: ImportPlan = structuredClone(input)
  const { catalog } = ctx
  const notes: PlanWarning[] = []
  const warn = (title: string, text: string) => notes.push({ kind: "other", title: title.slice(0, 100), text: text.slice(0, 1000) })
  const dropped = new Set<string>()

  // ---------- 工具 ----------
  const builtinIds = new Set(catalog.builtins.map((tool) => tool.id))
  const toolIds = new Set(catalog.tools.map((tool) => tool.id))
  const serverIds = new Set(catalog.servers.map((server) => server.id))
  plan.tools = plan.tools.filter((tool) => {
    const ref = tool.refId ?? ""
    if (tool.kind === "builtin" || tool.kind === "existing") {
      if (builtinIds.has(ref)) tool.kind = "builtin"
      else if (toolIds.has(ref) || serverIds.has(ref)) tool.kind = "existing"
      else {
        warn(`工具「${tool.name}」没导入`, `它要用的${tool.kind === "builtin" ? "内置工具" : "已有工具"}「${ref || "（没写）"}」这里没有。`)
        dropped.add(tool.key)
        return false
      }
      delete tool.http
      delete tool.mcp
      if (!tool.name) tool.name = catalog.builtins.find((each) => each.id === ref)?.name ?? catalog.tools.find((each) => each.id === ref)?.name ?? ref
      return true
    }
    delete tool.refId
    if (tool.kind === "http") {
      delete tool.mcp
      const http = tool.http
      if (!http || !/^https?:\/\/[^\s/]+/i.test(http.url)) {
        warn(`工具「${tool.name}」没导入`, http?.url.trim() ? "HTTP 接口的地址不对（要 http:// 或 https:// 开头）。" : "只有函数定义、没有接口地址，需要先有接口才能用。")
        dropped.add(tool.key)
        return false
      }
      // 模板里还有明文密钥（读包前没认出来的）：挪走，名字和读包时找到的统一起
      const template = { url: fixPlaceholderNames(http.url), headers: fixPlaceholderNames(headerLines(http.headers)), body: fixPlaceholderNames(http.body ?? "") }
      const taken = secretNamesOf(`${template.url}\n${template.headers}\n${template.body}`)
      const moved = moveSecrets(template, taken)
      let { url, headers, body } = moved.template
      for (const leak of moved.moved) {
        const name = ctx.collector.slot(leak.name, leak.value, `工具「${tool.name}」的${leak.where === "url" ? "地址" : leak.where === "headers" ? "请求头" : "请求体"}`)
        const rename = (text: string) => text.split(`{{${leak.name}}}`).join(`{{${name}}}`)
        url = rename(url)
        headers = rename(headers)
        body = rename(body)
      }
      tool.http = { ...http, url: url.slice(0, 2000), headers: parseHeaderLines(headers), ...(body.trim() ? { body: body.slice(0, 50_000) } : {}) }
      if (!body.trim()) delete tool.http.body
      return true
    }
    // MCP
    delete tool.http
    const mcp = tool.mcp
    const target = mcp ? (mcp.transport === "stdio" ? mcp.command : mcp.url) : undefined
    if (!mcp || !target?.trim()) {
      warn(`工具「${tool.name}」没导入`, mcp?.transport === "http" ? "MCP 服务器没写服务地址。" : "MCP 服务器没写启动命令。")
      dropped.add(tool.key)
      return false
    }
    if (hasPlainSecret(target)) {
      warn(`工具「${tool.name}」没导入`, `${mcp.transport === "stdio" ? "启动命令" : "服务地址"}里有明文密钥。改成放进${mcp.transport === "stdio" ? "环境变量" : "请求头"}以后，到「工具」页手动加。`)
      dropped.add(tool.key)
      return false
    }
    const pattern = mcp.transport === "stdio" ? ENV_NAME : HEADER_NAME
    const seen = new Set<string>()
    mcp.env = mcp.env.flatMap((each) => {
      const name = each.name.trim()
      if (!pattern.test(name) || seen.has(name)) {
        if (!seen.has(name)) warn(`工具「${tool.name}」的「${name.slice(0, 50)}」没导入`, `${mcp.transport === "stdio" ? "环境变量名" : "请求头名"}不对。`)
        return []
      }
      seen.add(name)
      let value = fixPlaceholderNames(each.value.trim())
      // 没有值：先写成 {{名字}}，导入后在「还要你做的」里填
      if (!value) value = `{{${secretNameFrom(name)}}}`
      else if (!value.includes("{{")) {
        const strength = keyStrength(name)
        const secretLike = strength === "strong" || hasPlainSecret(value) || (strength === "weak" && value.length >= 8 && !/\s/.test(value))
        if (secretLike) value = `{{${ctx.collector.slot(name, value, `工具「${tool.name}」的${mcp.transport === "stdio" ? "环境变量" : "请求头"} ${name}`)}}}`
      }
      return [{ name, value }]
    })
    if (mcp.transport === "stdio") delete mcp.url
    else delete mcp.command
    // AI 自己已经提醒过这个地址的（warnings 里写到了它的「主机:端口」），不再补一条一样的
    const hostPort = /^[a-z]+:\/\/([^/]+)/i.exec(mcp.url ?? "")?.[1] ?? ""
    if (mcp.transport === "http" && isLocalAddress(mcp.url ?? "") && !plan.warnings.some((warning) => hostPort && warning.text.includes(hostPort)))
      warn(`MCP 服务器「${tool.name}」的地址是本机`, `${mcp.url} 是原来那台机器上的地址。照样建好了，导入后到「工具」页改成真正的服务地址再连接。`)
    return true
  })
  const toolKeys = new Set(plan.tools.map((tool) => tool.key))
  const newToolKeys = new Set(plan.tools.filter((tool) => tool.kind === "http" || tool.kind === "mcp").map((tool) => tool.key))

  // ---------- 技能：同名的已有技能（不分大小写、去掉首尾空白）默认「用已有的」 ----------
  plan.skills = plan.skills.filter((skill) => {
    skill.name = skill.name.trim()
    if (!skill.name) {
      dropped.add(skill.key)
      return false
    }
    skill.dept = skill.dept.trim() || "通用"
    if (skill.group !== undefined && !skill.group.trim()) delete skill.group
    skill.description = skill.description.trim() || skill.name
    skill.toolKeys = skill.toolKeys.filter((key) => toolKeys.has(key))
    const existing = catalog.skills.find((each) => sameName(each.name, skill.name))
    if (existing) {
      const diff = lineDiff(existing.body, skill.body)
      skill.existing = { id: existing.id, name: existing.name, version: existing.version, status: existing.status, note: diffNote(diff, existing.version), diff }
      if (skill.resolution === "new") skill.resolution = "use_existing"
    } else {
      delete skill.existing
      skill.resolution = "new"
    }
    return true
  })

  // ---------- 任务 ----------
  const staffIds = new Set(catalog.staff.map((user) => user.id))
  const chatModels = new Set(catalog.models.filter((model) => model.chat).map((model) => model.id))
  const profileIds = new Set(catalog.profiles.map((profile) => profile.id))
  const filePaths = new Set(ctx.pkg.files.filter((file) => !file.skipped).map((file) => file.path))
  plan.tasks = plan.tasks.filter((task) => {
    task.title = task.title.trim()
    if (!task.title) {
      dropped.add(task.key)
      return false
    }
    task.goal = task.goal.trim() || task.title
    if (!staffIds.has(task.ownerId)) task.ownerId = ctx.uploaderId
    if (task.modelId && !chatModels.has(task.modelId)) {
      task.modelNote = task.modelNote || `原 agent 用的模型「${task.modelId.slice(0, 100)}」这里没有，换成了默认的执行模型`
      task.modelId = null
    }
    if (task.schedule) {
      // 说法用系统按 cron 生成的（和任务页一致），不用读包 AI 自己写的
      if (isValidCron(task.schedule.cron)) task.schedule = { cron: task.schedule.cron.trim(), text: cronText(task.schedule.cron) ?? task.schedule.cron.trim() }
      else {
        warn(`任务「${task.title.slice(0, 40)}」没设定时`, `原来的定时「${task.schedule.cron}」看不懂（要 5 段 cron）。导入后到任务里设。`)
        task.schedule = null
      }
    }
    task.browserProfileIds = [...new Set(task.browserProfileIds.filter((id) => profileIds.has(id)))]
    task.allowedDomains = [...new Set(task.allowedDomains.map((domain) => normalizeDomain(domain)).filter((domain): domain is string => Boolean(domain)))]
    const logins = new Map<string, (typeof task.logins)[number]>()
    for (const login of task.logins) {
      const domain = normalizeDomain(login.domain)
      if (!domain || logins.has(domain)) continue
      const platform = catalog.platforms.find((each) => each.domains.some((d) => domain === d || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`)))
      const profiles = task.browserProfileIds.length ? task.browserProfileIds : catalog.profiles.map((profile) => profile.id)
      const hasAccount = platform ? catalog.accounts.some((account) => account.platformId === platform.id && profiles.includes(account.profileId)) : false
      logins.set(domain, { platformId: platform?.id ?? null, name: (platform?.name ?? login.name).slice(0, 100) || domain, domain, missing: !hasAccount })
    }
    task.logins = [...logins.values()]
    task.attachments = [...new Set(task.attachments.filter((path) => filePaths.has(path)))]
    return true
  })

  // ---------- 记忆 ----------
  const taskKeys = new Set(plan.tasks.map((task) => task.key))
  const memoryIds = new Set(catalog.memories.map((memory) => memory.id))
  plan.memories = plan.memories.filter((memory: PlanMemory) => {
    memory.text = memory.text.trim()
    if (!memory.text) {
      dropped.add(memory.key)
      return false
    }
    if (memory.target.kind === "task" && !taskKeys.has(memory.target.taskKey)) memory.target = { kind: "shared", appliesTo: plan.name }
    if (memory.target.kind === "shared" && !memory.target.appliesTo.trim()) memory.target = { kind: "shared", appliesTo: plan.name.slice(0, 100) || "导入" }
    // 模型说重复，但说的那条已有记忆不存在：不算重复
    if (memory.flag?.kind === "duplicate" && (!memory.flag.existingId || !memoryIds.has(memory.flag.existingId))) {
      delete memory.flag
      memory.include = true
    }
    // 重复的、可疑的默认不导入
    if (memory.flag) memory.include = false
    return true
  })

  // ---------- 规则 ----------
  plan.rules = plan.rules.filter((rule: PlanRule) => {
    rule.toolKeys = rule.toolKeys.filter((key) => toolKeys.has(key))
    if (rule.kind === "existing") {
      const existing = catalog.rules.find((each) => each.id === rule.existingId)
      if (!existing?.effective) {
        warn(`规则「${rule.name.slice(0, 40)}」去掉了`, `它要用的已有规则 ${rule.existingId ?? "（没写）"} ${existing ? "还没生效" : "不存在"}。`)
        dropped.add(rule.key)
        return false
      }
      rule.name = existing.name.slice(0, 100)
      rule.trigger = existing.trigger.slice(0, 500)
      rule.action = existing.action.slice(0, 500)
      rule.needsNewTools = false
      delete rule.compile
      return true
    }
    delete rule.existingId
    rule.suggested = false
    rule.name = rule.name.trim()
    rule.trigger = rule.trigger.trim()
    rule.action = rule.action.trim()
    if (!rule.trigger || !rule.action) {
      dropped.add(rule.key)
      return false
    }
    if (!rule.name) rule.name = rule.trigger.slice(0, 100)
    if (rule.kind === "unsupported") {
      rule.include = false
      rule.needsNewTools = false
      rule.reason = rule.reason || "要靠理解内容才能判断，v1 的规则管不了"
      return true
    }
    rule.needsNewTools = rule.toolKeys.some((key) => newToolKeys.has(key))
    return true
  })

  // ---------- 派活（第二期，开发说明 1.4）：谁派给谁、派活方要有「派活」工具、参数和名额、被派活的不用定时 ----------
  organizeDispatch(plan, catalog, toolKeys, warn)

  // ---------- 引用：去掉的项从所有引用里拿掉 ----------
  const skillKeys = new Set(plan.skills.map((skill) => skill.key))
  const sharedMemoryKeys = new Set(plan.memories.filter((memory) => memory.target.kind === "shared").map((memory) => memory.key))
  const ruleKeys = new Set(plan.rules.map((rule) => rule.key))
  for (const task of plan.tasks) {
    task.skillKeys = [...new Set(task.skillKeys.filter((key) => skillKeys.has(key)))]
    task.memoryKeys = [...new Set(task.memoryKeys.filter((key) => sharedMemoryKeys.has(key)))]
    task.ruleKeys = [...new Set(task.ruleKeys.filter((key) => ruleKeys.has(key)))]
    task.toolKeys = [...new Set(task.toolKeys.filter((key) => toolKeys.has(key)))]
  }

  // ---------- 密钥、没用上的文件、提醒 ----------
  plan.secrets = planSecrets(plan, ctx.collector.found, catalog.secretNames)
  plan.unused = completeUnused(plan, ctx)
  const found = ctx.collector.found
  const usedNames = new Set(plan.secrets.map((secret) => secret.name))
  const usedFound = found.filter((each) => usedNames.has(each.name))
  const places = [...new Set(found.map((each) => each.where.replace(/ 第 \d+ 行$/, "")))]
  const secretWarning: PlanWarning[] = found.length
    ? [
        {
          kind: "secret",
          title: `发现 ${found.length} 个明文密钥`,
          text: `在 ${places.slice(0, 5).join("、")}${places.length > 5 ? ` 等 ${places.length} 个文件` : ""}里。发给 AI 之前已经换成 {{${found[0]!.name}}} 这样的名字，AI 看不到原值。${
            usedFound.length ? `方案里的工具用到其中 ${usedFound.length} 个，导入时加密存成全局密钥；` : ""
          }其余的（多半是文档里的示例）不导入。`.slice(0, 1000),
        },
      ]
    : []
  plan.warnings = [...secretWarning, ...plan.warnings.filter((warning) => warning.kind !== "secret"), ...notes].slice(0, 50)
  return plan
}

/**
 * 派活的六条（开发说明 1.4）：
 * ① fromKeys 只留方案里有的、不是自己的任务（include 没勾的在导入时再过滤，人在向导里可能改勾选）；
 * ② 派活方的 toolKeys 里没有「派活」：方案里没有 refId = work.dispatch 的工具就补一项，再把它加进派活方；
 * ③ 参数名去空白、去重，空的去掉，最多 20 个；④ 名额卡在 1～20；
 * ⑤ 被派活又有定时的：去掉定时（按定时跑出来的运行没有参数，不知道该办哪件），写一条提醒；
 * ⑥ 被派活、但没有任务派活给它：照样导入（人可以在派活页手动派），写一条提醒
 */
function organizeDispatch(plan: ImportPlan, catalog: ImportCatalog, toolKeys: Set<string>, warn: (title: string, text: string) => void) {
  const taskKeys = new Set(plan.tasks.map((task) => task.key))
  /** 派活方 key → 它派给的任务标题 */
  const senders = new Map<string, string[]>()
  for (const task of plan.tasks) {
    if (!task.dispatch) continue
    const name = task.title.slice(0, 40)
    const fromKeys = [...new Set(task.dispatch.fromKeys)]
    const kept = fromKeys.filter((key) => key !== task.key && taskKeys.has(key))
    const lost = fromKeys.filter((key) => !kept.includes(key))
    if (lost.length) warn(`「${name}」的派活方对不上`, `派活方 ${lost.join("、")} 方案里没有（或者写的是它自己），去掉了。`)
    const seen = new Set<string>()
    const params = task.dispatch.params
      .flatMap((param) => {
        const paramName = param.name.trim().slice(0, 40)
        if (!paramName || seen.has(paramName)) return []
        seen.add(paramName)
        return [{ name: paramName, description: (param.description ?? "").trim().slice(0, 200), required: Boolean(param.required), dedupe: Boolean(param.dedupe) }]
      })
      .slice(0, 20)
    // 要交回的结果（run-outcome，人在向导里改的）：去空白、同名去重，最多 20 个
    const resultNames = new Set<string>()
    const results = (task.dispatch.results ?? [])
      .flatMap((result) => {
        const resultName = result.name.trim().slice(0, 40)
        if (!resultName || resultNames.has(resultName)) return []
        resultNames.add(resultName)
        return [{ name: resultName, description: (result.description ?? "").trim().slice(0, 200), required: result.required !== false }]
      })
      .slice(0, 20)
    const clamp = (value: unknown, min: number, max: number, fallback: number) => Math.min(max, Math.max(min, Number.isFinite(Number(value)) ? Math.round(Number(value)) : fallback))
    const maxRunning = clamp(task.dispatch.maxRunning, 1, 20, 1) || 1
    // 自动重试（人在向导里改的）：次数 0～5、间隔 1～1440 分钟；没写的不加
    const { retries, retryDelayMinutes } = task.dispatch
    task.dispatch = {
      params,
      ...(results.length ? { results } : {}),
      maxRunning,
      ...(retries !== undefined && retries !== null ? { retries: clamp(retries, 0, 5, 0) } : {}),
      ...(retryDelayMinutes !== undefined && retryDelayMinutes !== null ? { retryDelayMinutes: clamp(retryDelayMinutes, 1, 1440, 10) } : {}),
      fromKeys: kept,
    }
    if (task.schedule) {
      warn(`「${name}」会被派活，不用定时`, `原来的定时「${task.schedule.text || task.schedule.cron}」已去掉：按定时跑出来的运行没有参数，不知道该办哪件。要的话在向导里加回来。`)
      task.schedule = null
    }
    if (!kept.length) warn(`还没有任务派活给「${name}」`, "它能被派活，但方案里没有任务派活给它。照样导入，可以在派活页手动派，或者导入后在任务设置的「谁能派活给它」里加。")
    for (const key of kept) senders.set(key, [...(senders.get(key) ?? []), task.title])
  }
  if (!senders.size) return
  let tool = plan.tools.find((each) => each.kind === "builtin" && each.refId === WORK_DISPATCH_TOOL_ID)
  if (!tool) {
    const used = new Set([...plan.tasks, ...plan.skills, ...plan.memories, ...plan.rules, ...plan.tools].map((each) => each.key))
    let n = plan.tools.length + 1
    while (used.has(`x${n}`)) n++
    const def = catalog.builtins.find((each) => each.id === WORK_DISPATCH_TOOL_ID)
    const targets = [...new Set([...senders.values()].flat())]
    tool = {
      key: `x${n}`,
      include: true,
      kind: "builtin",
      name: def?.name ?? "派活",
      summary: (def?.summary ?? "把要办的事一件一张派给别的任务").slice(0, 300),
      refId: WORK_DISPATCH_TOOL_ID,
      why: `把事派给${targets.map((title) => `「${title.slice(0, 40)}」`).join("")}`.slice(0, 300),
    }
    plan.tools.push(tool)
    toolKeys.add(tool.key)
  }
  for (const task of plan.tasks) if (senders.has(task.key) && !task.toolKeys.includes(tool.key)) task.toolKeys.push(tool.key)
}

/** 每个解压出来的文件都要有着落：某一项的来源、被合并、做成附件，或者在「没用上的文件」里。模型漏掉的按目录收拢补上（AI 已经提到的目录不再补） */
function completeUnused(plan: ImportPlan, ctx: OrganizeContext): ImportPlan["unused"] {
  const sources = [
    ...plan.tasks.map((task) => task.source),
    ...plan.skills.map((skill) => skill.source),
    ...plan.memories.map((memory) => memory.source),
    ...plan.rules.map((rule) => rule.source ?? ""),
    ...plan.tools.map((tool) => tool.source ?? ""),
  ].join("\n")
  const used = new Set([...plan.skills.flatMap((skill) => skill.merged), ...plan.tasks.flatMap((task) => task.attachments)])
  // AI 自己的列表先去重（同一个路径只留第一行）
  const seen = new Set<string>()
  const listed = plan.unused.filter((each) => {
    const path = each.path.trim()
    if (!path || seen.has(path)) return false
    seen.add(path)
    return true
  })
  const prefixes = listed.flatMap((each) => ctx.pkg.unusedPaths(each.path))
  const covered = (path: string) => used.has(path) || sources.includes(path) || prefixes.some((prefix) => prefix === path || path.startsWith(prefix.endsWith("/") ? prefix : `${prefix}/`))
  return [...listed, ...ctx.pkg.groupUnused(covered)].slice(0, 500)
}

/** 127.0.0.1、localhost 这类只在原来那台机器上能连的地址 */
export const isLocalAddress = (url: string) => /^[a-z]+:\/\/(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0|\[::1\])(:\d+)?(\/|$)/i.test(url.trim())
