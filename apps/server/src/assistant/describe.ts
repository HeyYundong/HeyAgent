// 改动确认卡上给人看的文字：每一项的字段「改前 → 改后」、定时 / 什么时候的中文、编号对应的名字。
// 只做展示，不做校验；校验在 tools.ts 的 prepare 和 data/config/*.ts 里。
import { AsyncLocalStorage } from "node:async_hooks"

import { assistantFieldChangeSchema, cronText, fmtDateTime, riskLabel, shanghaiToIso, skillStatusLabel, type Risk, type SkillStatus } from "@heyagent/shared"
import { inArray } from "drizzle-orm"
import type { z } from "zod"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"

export type FieldChange = z.infer<typeof assistantFieldChangeSchema>

/** 卡上一个值最多显示多少字：太长的人也看不过来，要看全文去对应的页面 */
const FIELD_MAX = 600

export const clip = (value: string, max = FIELD_MAX) => (value.length > max ? `${value.slice(0, max)}…（共 ${value.length} 字）` : value)

export const yesNo = (value: boolean) => (value ? "是" : "否")

/** 定时：cron 翻成中文（看不懂的原样显示），null 是只跑一次 */
export function scheduleText(schedule: { cron: string; text?: string } | null | undefined) {
  if (!schedule) return "不定时（手动运行）"
  const zh = cronText(schedule.cron)
  return zh ? `${zh}（${schedule.cron}）` : schedule.cron
}

/** 人加的待办「什么时候」：时间按上海时间显示 */
export function triggerText(trigger: { kind: string; at?: string; cron?: string; event?: string; fallbackDays?: number }) {
  const at = (value?: string) => {
    if (!value) return "（没写时间）"
    try {
      const iso = /(Z|[+-]\d{2}:?\d{2})$/.test(value.trim()) ? value.trim() : shanghaiToIso(value.trim().slice(0, 16))
      return fmtDateTime(iso)
    } catch {
      return value
    }
  }
  switch (trigger.kind) {
    case "time":
      return `${at(trigger.at)} 到点就做`
    case "cron":
      return `${cronText(trigger.cron ?? "") ?? trigger.cron}（${trigger.cron}）`
    case "event":
      return `等到「${trigger.event}」，最多等 ${trigger.fallbackDays ?? 7} 天`
    case "time_or_event":
      return `${at(trigger.at)} 到点，或者先等到「${trigger.event}」`
    default:
      return trigger.kind
  }
}

export const riskText = (risk: Risk) => riskLabel[risk] ?? risk
export const skillStatusText = (status: SkillStatus) => skillStatusLabel[status] ?? status

/** 步骤列表：一步一行，「（可以停下等）」「检查点：……」跟在后面 */
export function stepsText(steps: { text: string; wait?: boolean; checkpoint?: string }[]) {
  if (steps.length === 0) return "（没有步骤）"
  return steps.map((step, index) => `${index + 1}. ${step.text}${step.wait ? "（这一步可以停下等）" : ""}${step.checkpoint ? `［检查点：${step.checkpoint}］` : ""}`).join("\n")
}

const KIND_TEXT = { user: "人", model: "模型", skill: "技能", memory: "记忆", tool: "工具", rule: "规则", browser: "Chrome", task: "任务" } as const

/**
 * 出卡时收集「引用了但库里没有」的编号：模型常会编一个编号（例如工具 mcp-playwright），
 * 不拦的话卡照出、人点了「应用」才报「找不到」，白点一次。run.ts 用它包住 prepare，有缺的这项就不进卡
 */
const missingScope = new AsyncLocalStorage<Set<string>>()

export async function collectMissing<T>(fn: () => Promise<T>): Promise<{ value: T; missing: string[] }> {
  const missing = new Set<string>()
  const value = await missingScope.run(missing, fn)
  return { value, missing: [...missing] }
}

/**
 * 编号 → 名字：卡上写「技能「导出报表」」比写 sk-export 好懂。每张卡建一个，按表整批读、读过的缓存住。
 * 找不到的照原样显示编号，并记进 collectMissing（出卡时拦下）
 */
export class Names {
  private cache = new Map<string, Map<string, string>>()
  private db: Db
  constructor(db: Db) {
    this.db = db
  }

  private async load(kind: "user" | "model" | "skill" | "memory" | "tool" | "rule" | "browser" | "task", ids: string[]) {
    const map = this.cache.get(kind) ?? new Map<string, string>()
    this.cache.set(kind, map)
    const missing = [...new Set(ids)].filter((id) => id && !map.has(id))
    if (missing.length === 0) return map
    const rows = await this.query(kind, missing)
    for (const row of rows) map.set(row.id, row.name)
    return map
  }

  private async query(kind: string, ids: string[]): Promise<{ id: string; name: string }[]> {
    switch (kind) {
      case "user":
        return this.db.select({ id: t.users.id, name: t.users.name }).from(t.users).where(inArray(t.users.id, ids))
      case "model":
        return this.db.select({ id: t.models.id, name: t.models.name }).from(t.models).where(inArray(t.models.id, ids))
      case "skill":
        return this.db.select({ id: t.skills.id, name: t.skills.name }).from(t.skills).where(inArray(t.skills.id, ids))
      case "memory":
        return (await this.db.select({ id: t.memories.id, name: t.memories.content }).from(t.memories).where(inArray(t.memories.id, ids))).map((row) => ({ id: row.id, name: clip(row.name, 40) }))
      case "tool":
        return this.db.select({ id: t.tools.id, name: t.tools.name }).from(t.tools).where(inArray(t.tools.id, ids))
      case "rule":
        return this.db.select({ id: t.rules.id, name: t.rules.name }).from(t.rules).where(inArray(t.rules.id, ids))
      case "browser":
        return this.db.select({ id: t.browserProfiles.id, name: t.browserProfiles.name }).from(t.browserProfiles).where(inArray(t.browserProfiles.id, ids))
      case "task":
        return this.db.select({ id: t.tasks.id, name: t.tasks.title }).from(t.tasks).where(inArray(t.tasks.id, ids))
      default:
        return []
    }
  }

  /** 「名字（编号）」，一串用顿号隔开；空数组写「（无）」 */
  async list(kind: Parameters<Names["load"]>[0], ids: string[]) {
    if (ids.length === 0) return "（无）"
    const map = await this.load(kind, ids)
    const missing = missingScope.getStore()
    for (const id of ids) if (!map.has(id)) missing?.add(`${KIND_TEXT[kind]} ${id}`)
    return ids.map((id) => (map.has(id) ? `「${map.get(id)}」（${id}）` : id)).join("、")
  }

  async one(kind: Parameters<Names["load"]>[0], id: string | undefined | null, empty = "（无）") {
    if (!id) return empty
    return this.list(kind, [id])
  }
}

/**
 * 修改：只列给了、而且真的变了的字段。format 把值转成给人看的文字（两边用同一个，比较的是文字）
 */
export async function changedFields<T extends object>(
  before: T,
  after: object,
  given: Set<string>,
  labels: Partial<Record<keyof T & string, string>>,
  format: (key: keyof T & string, value: unknown) => string | Promise<string>
): Promise<FieldChange[]> {
  const fields: FieldChange[] = []
  for (const key of Object.keys(labels) as (keyof T & string)[]) {
    if (!given.has(key)) continue
    const old = await format(key, (before as Record<string, unknown>)[key])
    const next = await format(key, (after as Record<string, unknown>)[key])
    if (old === next) continue
    fields.push({ label: labels[key]!, before: clip(old), after: clip(next) })
  }
  return fields
}
