// 种子数据：把原型的假数据灌进库（pages/learn 不灌，它的演示数据前端自己留）。
// - 时间：原型以「2026-10-16 16:30」为现在，这里整体平移到灌数据那一刻，保持「几分钟前、昨天」的相对关系；
// - 可以重复执行：每次先清空业务表再灌（所以只能用在开发、演示库）；5 个演示账号按 id 更新，已登录的会话不受影响；
// - 密钥和登录态用假值，经 lib/crypto.ts 加密后再存。
import { randomBytes } from "node:crypto"

import { hashPassword } from "better-auth/crypto"
import { sql } from "drizzle-orm"
import { describeCompiledRule, LIVE_CHANNEL, shanghaiToIso, type CompiledRule, type Trigger as SharedTrigger } from "@heyagent/shared"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"
import { encrypt, mask, type Keyring } from "../lib/crypto.js"
import { DESCRIPTIONS, SAVED_SECRETS, humanDetails, memoryNotes, skillBodies, skillVersions } from "./fixtures/details.js"
import * as proto from "./fixtures/prototype.js"

/** 原型里的「现在」 */
export const PROTO_NOW = "2026-10-16 16:30"

/** 演示规则翻译后的结构（种子数据：业务例子只放在这里） */
const SEED_RULE_COMPILED: Record<string, Pick<CompiledRule, "trigger" | "actions">> = {
  "rl-wa-confirm": { trigger: { type: "before_tool", toolIds: ["whatsapp.send"], risks: [] }, actions: [{ type: "ask_human", recipient: { to: "owner" } }] },
  "rl-order-approval": { trigger: { type: "before_tool", toolIds: ["order.place"], risks: ["money"] }, actions: [{ type: "ask_human", recipient: { to: "admin" } }] },
  "rl-captcha": { trigger: { type: "page_needs_human" }, actions: [{ type: "screenshot" }, { type: "notify", recipient: { to: "owner" } }] },
  "rl-screenshot": { trigger: { type: "after_tool", toolIds: ["browser.open", "browser.act", "browser"], anyTool: false }, actions: [{ type: "screenshot" }] },
  "rl-memory-review": { trigger: { type: "agent_proposes", what: ["memory"] }, actions: [{ type: "notify", recipient: { to: "owner" } }] },
  "rl-checkpoint-sync": { trigger: { type: "after_tool", toolIds: [], anyTool: true }, actions: [{ type: "sync_checkpoint" }] },
  "rl-verify": { trigger: { type: "agent_done" }, actions: [{ type: "verify" }] },
  "rl-budget": { trigger: { type: "cost_over", usd: 20 }, actions: [{ type: "ask_human", recipient: { to: "owner" } }] },
}

/** 演示账号的邮箱（拼音） */
export const SEED_EMAILS: Record<string, string> = {
  "u-lin": "linzhou@heyagent.local",
  "u-wang": "wangyue@heyagent.local",
  "u-li": "lijing@heyagent.local",
  "u-chen": "chenqiang@heyagent.local",
  "u-emily": "emilyzhao@heyagent.local",
}

/** 种子里的假密钥原文。测试用它检查接口返回里绝不出现原文 */
export const SEED_SECRET_VALUES = {
  WHATSAPP_TOKEN: "EAAGdemo0whatsapp0token0000000000000000",
  ALI1688_TOKEN: "ali1688demo0token000000000000",
  openrouterApiKey: proto.modelProviders.find((provider) => provider.id === "openrouter")!.apiKey!,
  usProxyPassword: "demo-proxy-password-0000",
}

/** 登录态保险箱里假 cookie 的值都带这个前缀，测试用它检查接口不返回登录态内容 */
export const SEED_COOKIE_PREFIX = "demo-cookie-value-"

// 业务表：灌之前整个清空（users 和 better-auth 的表不在这里）
const BUSINESS_TABLES = [
  "account_leases", "browser_vaults", "browser_accounts", "browser_profiles",
  "checkpoint_records", "checkpoints", "session_waits", "session_events", "session_messages", "files",
  "skill_suggestions", "human_items", "human_todos",
  "task_memories", "task_skills", "task_tools", "task_rules",
  "memories", "sessions", "tasks",
  "skill_versions", "skill_tools", "skills", "rule_tools", "rules", "tools", "mcp_servers",
  "model_defaults", "models", "model_providers", "secrets", "platforms",
]

export interface SeedOptions {
  /** 以哪一刻为「现在」（默认当前时间） */
  now?: Date
  /** 演示账号的密码 */
  password: string
}

export interface SeedResult {
  counts: Record<string, number>
}

/** 把原型的时间写法换成绝对时间（ISO 的 Date）。base 是「HH:mm」这种只有时分的写法沿用的日期 */
function makeClock(now: Date) {
  const offset = now.getTime() - Date.parse(shanghaiToIso(PROTO_NOW))
  const shift = (iso: string) => new Date(Date.parse(iso) + offset)
  function at(text: string, baseDate = PROTO_NOW.slice(0, 10)): Date {
    if (/^\d{4}-\d{2}-\d{2}( \d{2}:\d{2})?$/.test(text)) return shift(shanghaiToIso(text))
    if (/^\d{2}-\d{2} \d{2}:\d{2}$/.test(text)) return shift(shanghaiToIso(`${PROTO_NOW.slice(0, 4)}-${text}`))
    if (/^\d{2}-\d{2}$/.test(text)) return shift(shanghaiToIso(`${PROTO_NOW.slice(0, 4)}-${text}`))
    if (/^\d{2}:\d{2}$/.test(text)) return shift(shanghaiToIso(`${baseDate} ${text}`))
    throw new Error(`种子数据里认不出的时间写法：${text}`)
  }
  return { at, shift }
}

const staffIdByName = (name: string) => {
  const found = proto.staff.find((each) => each.name === name)
  if (!found) throw new Error(`原型里没有叫 ${name} 的人`)
  return found.id
}

/** 运行里的「09:58」沿用上一条的日期，「10-15 15:40」带日期（原型 sessions/data.ts 的规则） */
function runClock(clock: ReturnType<typeof makeClock>, run: proto.SessionRun) {
  let date = run.startedAt.slice(0, 10)
  return (text: string) => {
    if (text.length > 5) date = `${run.startedAt.slice(0, 4)}-${text.slice(0, 5)}`
    return clock.at(text.slice(-5), date)
  }
}

export async function seedDemo(db: Db, keyring: Keyring, options: SeedOptions): Promise<SeedResult> {
  const now = options.now ?? new Date()
  const clock = makeClock(now)
  const passwordHash = await hashPassword(options.password)

  await db.transaction(async (tx) => {
    // 灌数据时不逐行推送，灌完发一条「全部刷新」
    await tx.execute(sql`set local heyagent.skip_notify = 'on'`)
    await tx.execute(sql.raw(`truncate table ${BUSINESS_TABLES.map((name) => `"${name}"`).join(", ")} restart identity cascade`))

    // ---------- 人 ----------
    for (const person of proto.staff) {
      const values = {
        id: person.id,
        name: person.name,
        email: SEED_EMAILS[person.id]!,
        emailVerified: true,
        role: person.isAdmin ? "admin" : "user",
        title: person.title,
        banned: false,
      }
      await tx.insert(t.users).values(values).onConflictDoUpdate({ target: t.users.id, set: { ...values, updatedAt: now } })
      // 邮箱密码登录：better-auth 的 credential 账号，account_id 就是用户 id
      const account = { id: `acc-credential-${person.id}`, accountId: person.id, providerId: "credential", userId: person.id, password: passwordHash }
      await tx.insert(t.authAccounts).values(account).onConflictDoUpdate({ target: t.authAccounts.id, set: { password: passwordHash, updatedAt: now } })
    }

    await tx.insert(t.platforms).values(proto.platforms.map((platform, position) => ({ ...platform, position })))

    // ---------- 密钥 ----------
    async function saveSecret(row: { id: string; scope: (typeof t.secretScopeEnum.enumValues)[number]; refId?: string; name: string; value: string; createdById?: string; createdAt?: Date; keepStart?: number }) {
      const version = 1
      await tx.insert(t.secrets).values({
        id: row.id,
        scope: row.scope,
        refId: row.refId ?? null,
        name: row.name,
        version,
        enc: encrypt(keyring, row.value, { table: "secrets", id: row.id, version }),
        masked: mask(row.value, row.keepStart),
        createdById: row.createdById ?? null,
        createdAt: row.createdAt ?? now,
        updatedAt: row.createdAt ?? now,
      })
      return row.id
    }
    for (const [name, saved] of Object.entries(SAVED_SECRETS)) {
      const value = SEED_SECRET_VALUES[name as keyof typeof SEED_SECRET_VALUES]
      if (!value) throw new Error(`没有给密钥 ${name} 准备假值`)
      await saveSecret({ id: `sec-http-${name.toLowerCase()}`, scope: "http_tool", name, value, createdById: staffIdByName(saved.by), createdAt: clock.at(saved.at) })
    }

    // ---------- 模型 ----------
    for (const [position, provider] of proto.modelProviders.entries()) {
      const apiKeySecretId = provider.apiKey
        ? await saveSecret({ id: `sec-model-${provider.id}`, scope: "model_provider", refId: provider.id, name: "api_key", value: provider.apiKey, createdById: "u-lin", keepStart: 9 })
        : null
      await tx.insert(t.modelProviders).values({
        id: provider.id,
        kind: provider.id,
        name: provider.name,
        baseUrl: provider.baseUrl,
        apiKeySecretId,
        status: provider.status,
        checkedAt: provider.checkedAt ? clock.at(provider.checkedAt) : null,
        latencyMs: provider.latencyMs ?? null,
        position,
      })
      if (provider.models.length) {
        await tx.insert(t.models).values(provider.models.map((model, index) => ({ ...model, vision: model.vision ?? false, providerId: provider.id, position: index })))
      }
    }
    await tx.insert(t.modelDefaults).values(Object.entries(proto.modelDefaults).map(([role, modelId]) => ({ role: role as "run" | "plan" | "verify", modelId, updatedById: "u-lin" })))

    // ---------- 浏览器 ----------
    const accountIds = new Map<string, string>() // `${profileId}|${platformId}` → 账号 id
    for (const [position, profile] of proto.browserProfiles.entries()) {
      const proxy = profile.proxy
      const passwordSecretId =
        proxy.kind === "socks5" && proxy.username
          ? await saveSecret({ id: `sec-proxy-${profile.id}`, scope: "browser_proxy", refId: profile.id, name: "password", value: SEED_SECRET_VALUES.usProxyPassword, createdById: "u-lin" })
          : null
      const updatedAt = clock.at(profile.updatedAt)
      await tx.insert(t.browserProfiles).values({
        id: profile.id,
        name: profile.name,
        description: profile.description,
        proxyKind: proxy.kind,
        proxyHost: proxy.kind === "socks5" ? proxy.host : null,
        proxyPort: proxy.kind === "socks5" ? proxy.port : null,
        proxyUsername: proxy.kind === "socks5" ? (proxy.username ?? null) : null,
        proxyPasswordSecretId: passwordSecretId,
        exitIp: profile.exitIp,
        // 方案 2.3.6 要加的字段：按出口所在地给默认值
        timezone: profile.id === "br-us" ? "America/Los_Angeles" : profile.id === "br-de" ? "Europe/Berlin" : "Asia/Shanghai",
        locale: profile.id === "br-us" ? "en-US" : profile.id === "br-de" ? "de-DE" : "zh-CN",
        position,
        createdAt: updatedAt,
        updatedAt,
      })
      for (const [index, site] of profile.sites.entries()) {
        const id = `acc-${profile.id.replace(/^br-/, "")}-${site.platformId}`
        accountIds.set(`${profile.id}|${site.platformId}`, id)
        await tx.insert(t.browserAccounts).values({
          id,
          profileId: profile.id,
          platformId: site.platformId,
          account: site.account,
          status: site.status,
          lastLoginAt: clock.at(site.lastLoginAt),
          loggedInById: site.loggedInById,
          maxConcurrent: site.maxConcurrent,
          position: index,
        })
      }
      // 保险箱：假的 cookie，个数和原型一致，加密后存
      const state = {
        cookies: Array.from({ length: profile.cookieCount }, (_, index) => ({
          name: `demo_${index}`,
          value: `${SEED_COOKIE_PREFIX}${randomBytes(6).toString("hex")}`,
          domain: profile.sites[index % Math.max(1, profile.sites.length)]?.platformId ?? "example.com",
        })),
        origins: [],
      }
      await tx.insert(t.browserVaults).values({
        profileId: profile.id,
        version: profile.vaultVersion,
        enc: encrypt(keyring, JSON.stringify(state), { table: "browser_vaults", id: profile.id, version: profile.vaultVersion }),
        cookieCount: profile.cookieCount,
        updatedAt,
      })
    }

    // ---------- 工具、规则 ----------
    await tx.insert(t.mcpServers).values(proto.mcpServers.map((server, position) => ({ ...server, command: server.command ?? null, url: server.url ?? null, position })))
    await tx.insert(t.tools).values(
      proto.tools.map((tool, position) => ({
        id: tool.id,
        name: tool.name,
        summary: tool.summary,
        description: DESCRIPTIONS[tool.id] ?? tool.summary,
        source: tool.source,
        serverId: tool.serverId ?? null,
        http: tool.http ?? null,
        risk: tool.risk,
        alwaysOn: tool.alwaysOn ?? false,
        position,
      }))
    )
    // M3：演示规则直接带上「人确认过的翻译」（白名单那条没写域名，留着演示「未生效」）
    const toolName = (id: string) => proto.tools.find((tool) => tool.id === id)?.name
    const userName = (id: string) => proto.staff.find((user) => user.id === id)?.name
    await tx.insert(t.rules).values(
      proto.rules.map(({ toolIds: _toolIds, ...rule }, position) => {
        const shape = SEED_RULE_COMPILED[rule.id]
        if (!shape) return { ...rule, createdById: "u-lin", position }
        const compiled: CompiledRule = { v: 1, ...shape, understood: describeCompiledRule(shape, { tool: toolName, user: userName }) }
        return {
          ...rule,
          createdById: "u-lin",
          position,
          compiledTrigger: compiled,
          compiledText: JSON.stringify({ trigger: rule.trigger, action: rule.action }),
          compileDraft: { supported: true, compiled, understood: compiled.understood, trigger: rule.trigger, action: rule.action, modelId: proto.modelDefaults.plan, at: clock.at("10-12 10:00").toISOString() },
          confirmedById: "u-lin",
          confirmedAt: clock.at("10-12 10:00"),
        }
      })
    )
    const ruleTools = proto.rules.flatMap((rule) => rule.toolIds.map((toolId, position) => ({ ruleId: rule.id, toolId, position })))
    if (ruleTools.length) await tx.insert(t.ruleTools).values(ruleTools)

    // ---------- 技能 ----------
    for (const [position, skill] of proto.skills.entries()) {
      const meta = skillVersions[skill.id] ?? { version: 1, updatedAt: PROTO_NOW.slice(0, 10) }
      const body = skillBodies[skill.id] ?? `# ${skill.name}\n`
      const updatedAt = clock.at(meta.updatedAt)
      await tx.insert(t.skills).values({ id: skill.id, name: skill.name, description: skill.description, dept: skill.dept, status: skill.status, ownerId: skill.ownerId, version: meta.version, body, position, createdAt: updatedAt, updatedAt })
      if (skill.toolIds.length) await tx.insert(t.skillTools).values(skill.toolIds.map((toolId, index) => ({ skillId: skill.id, toolId, position: index })))
      // 原型只有当前版本的正文，历史版本没有内容，只记当前这一版
      await tx.insert(t.skillVersions).values({ skillId: skill.id, version: meta.version, name: skill.name, description: skill.description, body, toolIds: skill.toolIds, createdById: skill.ownerId, createdAt: updatedAt })
    }

    // ---------- 任务 ----------
    for (const task of proto.tasks) {
      await tx.insert(t.tasks).values({
        id: task.id,
        title: task.title,
        goal: task.goal,
        steps: task.steps,
        ownerId: task.ownerId,
        enabled: task.enabled,
        scheduleCron: task.schedule?.cron ?? null,
        scheduleText: task.schedule?.text ?? null,
        nextRunAt: task.nextRunAt ? clock.at(task.nextRunAt) : null,
        modelId: task.modelId,
        createdAt: clock.at(task.createdAt),
        updatedAt: clock.at(task.createdAt),
      })
      const links = [
        [t.taskSkills, task.skillIds],
        [t.taskTools, task.toolIds],
        [t.taskRules, task.ruleIds],
      ] as const
      for (const [table, ids] of links) {
        if (ids.length) await tx.insert(table).values(ids.map((refId, position) => ({ taskId: task.id, refId, position })))
      }
    }

    // ---------- 运行（session） ----------
    for (const run of proto.runs) {
      const when = runClock(clock, run)
      await tx.insert(t.sessions).values({
        id: run.id,
        taskId: run.taskId,
        status: run.status,
        modelId: run.modelId,
        triggeredBy: run.events[0]?.title.includes("定时触发") ? "cron" : "manual",
        startedAt: clock.at(run.startedAt),
        endedAt: run.endedAt ? clock.at(run.endedAt) : null,
        tokensIn: run.tokensIn,
        tokensOut: run.tokensOut,
        costUsd: run.costUsd,
        exploredSteps: run.exploredSteps ?? null,
        verification: run.verification ? { ...run.verification, at: clock.at(run.verification.at).toISOString() } : null,
        createdAt: clock.at(run.startedAt),
      })
      if (run.events.length) {
        await tx.insert(t.sessionEvents).values(
          run.events.map((event, index) => ({
            sessionId: run.id,
            seq: index + 1,
            at: when(event.at),
            kind: event.kind,
            title: event.title,
            detail: event.detail ?? null,
            toolId: event.toolId ?? null,
            input: event.input ?? null,
            output: event.output ?? null,
            ms: event.ms ?? null,
            tokensIn: event.tokensIn ?? null,
            tokensOut: event.tokensOut ?? null,
          }))
        )
      }
      const recordClock = runClock(clock, run)
      for (const [position, cp] of run.checkpoints.entries()) {
        const [inserted] = await tx
          .insert(t.checkpoints)
          .values({ sessionId: run.id, position, title: cp.title, kind: cp.kind, target: cp.target ?? null, stepId: cp.stepId ?? null, status: cp.status, progress: cp.progress ?? null, skipReason: cp.skipReason ?? null })
          .returning({ id: t.checkpoints.id })
        if (cp.records.length) {
          await tx.insert(t.checkpointRecords).values(cp.records.map((record) => ({ checkpointId: inserted!.id, at: recordClock(record.at), text: record.text, synced: record.synced })))
        }
      }
      if (run.waiting) {
        const since = clock.at(run.waiting.since)
        await tx.insert(t.sessionWaits).values({ sessionId: run.id, what: run.waiting.what, ...triggerColumns(run.waiting.trigger, clock, since), createdAt: since })
      }
    }

    // 账号租约：原型里 Temu 账号「现在 1 个在用」，就是正在跑的 R-1036-1（它在美国 Chrome 里搜 Temu）
    for (const profile of proto.browserProfiles) {
      for (const site of profile.sites) {
        if (site.running === 0) continue
        const holders = proto.runs.filter((run) => run.status === "running" && run.events.some((event) => event.input?.includes(`"browser": "${profile.id}"`)))
        if (holders.length < site.running) throw new Error(`${profile.id} 的 ${site.platformId} 账号找不到占着它的运行`)
        for (const holder of holders.slice(0, site.running)) {
          await tx.insert(t.accountLeases).values({
            accountId: accountIds.get(`${profile.id}|${site.platformId}`)!,
            sessionId: holder.id,
            acquiredAt: clock.at(holder.startedAt),
            expiresAt: new Date(now.getTime() + 60 * 60 * 1000),
          })
        }
      }
    }

    // ---------- 记忆（引用了 session，所以放在运行后面） ----------
    for (const memory of proto.memories) {
      const note = memoryNotes[memory.id] ?? {}
      const proposedIn = proto.humanItems.find((item) => item.id === memory.id)?.runId
      await tx.insert(t.memories).values({
        id: memory.id,
        content: memory.content,
        appliesTo: memory.appliesTo,
        status: memory.status,
        sourceKind: memory.source.kind,
        sourceById: memory.source.kind === "human" ? memory.source.byId : null,
        sourceTaskId: memory.source.kind === "agent" ? memory.source.taskId : null,
        sourceSessionId: proposedIn ?? null,
        sourceEvidence: memory.source.kind === "agent" ? memory.source.evidence : null,
        reviewerId: memory.reviewerId ?? null,
        webUnverified: memory.webUnverified ?? false,
        evidence: note.evidence ?? null,
        ...lastUsed(note.lastUsed, clock),
        createdAt: clock.at(memory.createdAt),
        updatedAt: clock.at(memory.createdAt),
      })
    }
    for (const task of proto.tasks) {
      if (task.memoryIds.length) await tx.insert(t.taskMemories).values(task.memoryIds.map((refId, position) => ({ taskId: task.id, refId, position })))
    }

    // ---------- 待办 ----------
    for (const item of proto.humanItems) {
      const detail = humanDetails[item.id]
      if (!detail) throw new Error(`原型里没有 ${item.id} 的处理说明`)
      await tx.insert(t.humanItems).values({
        id: item.id,
        kind: item.kind,
        title: item.title,
        summary: item.summary,
        assigneeId: item.assigneeId,
        taskId: item.taskId ?? null,
        sessionId: item.runId ?? null,
        ruleId: item.ruleId ?? null,
        // 原型里记忆审核、技能修改的 id 就是记忆 / 技能的 id
        memoryId: item.kind === "memory" ? item.id : null,
        skillId: item.kind === "skill" ? item.id : null,
        urgency: item.urgency,
        detail,
        createdAt: clock.at(item.createdAt),
      })
    }
    for (const skill of proto.skills) {
      if (!skill.suggestion) continue
      const item = proto.humanItems.find((each) => each.kind === "skill" && each.id === skill.id)
      await tx.insert(t.skillSuggestions).values({
        skillId: skill.id,
        taskId: skill.suggestion.taskId,
        sessionId: item?.runId ?? null,
        summary: skill.suggestion.summary,
        diff: item ? (humanDetails[item.id]?.sections.find((section) => section.diff)?.diff ?? null) : null,
        reviewerId: skill.suggestion.reviewerId,
        humanItemId: item?.id ?? null,
        createdAt: clock.at(skill.suggestion.createdAt),
      })
    }
    for (const todo of proto.humanTodos) {
      const createdAt = clock.at(todo.createdAt)
      const trigger = triggerColumns(todo.trigger, clock, createdAt)
      await tx.insert(t.humanTodos).values({
        id: todo.id,
        taskId: todo.taskId,
        title: todo.title,
        triggerKind: trigger.triggerKind,
        at: trigger.resumeAt,
        cron: trigger.cron,
        cronText: trigger.cronText,
        nextAt: todo.trigger.kind === "cron" ? trigger.resumeAt : null,
        event: trigger.event,
        fallbackDays: trigger.fallbackDays,
        createdById: todo.createdById,
        createdAt,
        updatedAt: createdAt,
      })
    }

    // ---------- 新 id 用的序列推到现有最大值之后 ----------
    await setSequence(tx, "task_no_seq", sql`select max(substring(id from '^T-(\\d+)$')::bigint) from tasks`)
    await setSequence(tx, "memory_no_seq", sql`select max(substring(id from '^m-(\\d+)$')::bigint) from memories`)
    await setSequence(tx, "human_item_no_seq", sql`select max(substring(id from '-(\\d+)$')::bigint) from human_items`)
    await setSequence(tx, "todo_no_seq", sql`select max(substring(id from '^td-(\\d+)$')::bigint) from human_todos`)
  })

  // 灌完通知所有在线的页面全部重新拉
  await db.execute(sql`select pg_notify(${LIVE_CHANNEL}, ${JSON.stringify({ table: "*", id: null })})`)

  return { counts: await countRows(db) }
}

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0]

async function setSequence(tx: Tx, name: string, maxQuery: ReturnType<typeof sql>) {
  const result = await tx.execute<{ max: string | null }>(maxQuery)
  const max = Number(result.rows[0]?.max ?? 0)
  if (max > 0) await tx.execute(sql`select setval(${name}, ${max})`)
}

/** 原型的 Trigger → session_waits / human_todos 的列 */
function triggerColumns(trigger: proto.Trigger | SharedTrigger, clock: ReturnType<typeof makeClock>, since: Date) {
  const base = { resumeAt: null as Date | null, event: null as string | null, cron: null as string | null, cronText: null as string | null, fallbackDays: null as number | null, deadlineAt: null as Date | null }
  switch (trigger.kind) {
    case "time":
      return { ...base, triggerKind: trigger.kind, resumeAt: clock.at(trigger.at) }
    case "cron":
      return { ...base, triggerKind: trigger.kind, cron: trigger.cron, cronText: trigger.text, resumeAt: clock.at(trigger.next) }
    case "event":
      return { ...base, triggerKind: trigger.kind, event: trigger.event, fallbackDays: trigger.fallbackDays, deadlineAt: new Date(since.getTime() + trigger.fallbackDays * 24 * 60 * 60 * 1000) }
    case "time_or_event":
      return { ...base, triggerKind: trigger.kind, resumeAt: clock.at(trigger.at), event: trigger.event }
  }
}

/** 原型的「最近一次：今天 16:10，T-1036 的运行开始时读到」→ 那次运行的 id 和开始时间 */
function lastUsed(text: string | undefined, clock: ReturnType<typeof makeClock>) {
  if (!text) return { lastUsedAt: null, lastUsedSessionId: null }
  const match = /最近一次：(今天|昨天) (\d{2}:\d{2})，(T-\d+) 的运行开始时读到/.exec(text)
  if (!match) throw new Error(`认不出的「最近一次」：${text}`)
  const day = match[1] === "今天" ? PROTO_NOW.slice(0, 10) : "2026-10-15"
  const startedAt = `${day} ${match[2]}`
  const run = proto.runs.find((each) => each.taskId === match[3] && each.startedAt === startedAt)
  if (!run) throw new Error(`找不到 ${match[3]} 在 ${startedAt} 开始的运行`)
  return { lastUsedAt: clock.at(run.startedAt), lastUsedSessionId: run.id }
}

const COUNTED_TABLES = [
  "users", "tasks", "sessions", "session_events", "checkpoints", "checkpoint_records", "session_waits",
  "memories", "skills", "rules", "tools", "mcp_servers", "human_items", "human_todos",
  "browser_profiles", "browser_accounts", "browser_vaults", "account_leases", "model_providers", "models", "secrets",
]

export async function countRows(db: Db): Promise<Record<string, number>> {
  const counts: Record<string, number> = {}
  for (const name of COUNTED_TABLES) {
    const result = await db.execute<{ n: number }>(sql.raw(`select count(*)::int as n from "${name}"`))
    counts[name] = result.rows[0]!.n
  }
  return counts
}

/** 原型里各类数据的数量（模型按 m0 改过的为准），seed 和测试用来核对 */
export function expectedCounts() {
  return {
    users: proto.staff.length,
    tasks: proto.tasks.length,
    sessions: proto.runs.length,
    session_events: proto.runs.reduce((sum, run) => sum + run.events.length, 0),
    checkpoints: proto.runs.reduce((sum, run) => sum + run.checkpoints.length, 0),
    memories: proto.memories.length,
    skills: proto.skills.length,
    rules: proto.rules.length,
    tools: proto.tools.length,
    mcp_servers: proto.mcpServers.length,
    human_items: proto.humanItems.length,
    human_todos: proto.humanTodos.length,
    browser_profiles: proto.browserProfiles.length,
    model_providers: proto.modelProviders.length,
    models: proto.modelProviders.reduce((sum, provider) => sum + provider.models.length, 0),
  }
}
