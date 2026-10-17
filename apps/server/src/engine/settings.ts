// 读全局设置（settings 表，包 P2 的设置页写入）。读不到或格式不对就用默认值。
import { inArray } from "drizzle-orm"
import {
  notifyChannelSchema,
  SETTING_KEYS,
  SETTINGS_DEFAULTS,
  type NotifyChannel,
} from "@heyagent/shared"
import { z } from "zod"

import type { Db } from "../db/client.js"
import * as t from "../db/schema.js"

export interface EngineSettings {
  maxCostUsd: number
  maxSteps: number
  eventFallbackDays: number
  /** 外部事件令牌的 sha256（hex）；没配就不接受外部事件 */
  eventTokenSha256?: string
  channels: NotifyChannel[]
}

const positive = (value: unknown, fallback: number) =>
  typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : fallback

export async function loadEngineSettings(
  db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0]
): Promise<EngineSettings> {
  const keys = Object.values(SETTING_KEYS)
  const rows = await db
    .select()
    .from(t.settings)
    .where(inArray(t.settings.key, keys))
  const value = (key: string) => rows.find((row) => row.key === key)?.value
  // 令牌只要能取到 sha256 就认（设置页写的格式见 shared 的 eventTokenRecordSchema）
  const token = z
    .object({ sha256: z.string() })
    .safeParse(value(SETTING_KEYS.eventToken))
  const channels = z
    .array(notifyChannelSchema)
    .safeParse(value(SETTING_KEYS.notifyChannels))
  return {
    maxCostUsd: positive(
      value(SETTING_KEYS.maxCostUsd),
      SETTINGS_DEFAULTS.maxCostUsd
    ),
    maxSteps: Math.round(
      positive(
        value(SETTING_KEYS.maxSteps),
        SETTINGS_DEFAULTS.maxSteps
      )
    ),
    eventFallbackDays: Math.round(
      positive(
        value(SETTING_KEYS.eventFallbackDays),
        SETTINGS_DEFAULTS.eventFallbackDays
      )
    ),
    eventTokenSha256: token.success
      ? token.data.sha256.toLowerCase()
      : undefined,
    channels: channels.success ? channels.data : [],
  }
}
