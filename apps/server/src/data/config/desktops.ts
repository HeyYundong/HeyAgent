// 桌面配置（docs/dev/desktop.md 第 1、7 节）：名字、给 agent 看的说明、Windows-MCP 和桌面服务的地址、两个服务共用的密钥。
// 密钥只存密文（secrets.scope = desktop，ref_id = 桌面 id），接口只给掩码。被运行占着的桌面不能删。只有主管能改。
import { asc, count, eq, inArray } from "drizzle-orm"
import type { Desktop, DesktopHealth } from "@heyagent/shared"

import * as t from "../../db/schema.js"
import { loadDesktopTarget, testDesktop } from "../../desktop/client.js"
import type { Db } from "../../db/client.js"
import { assertCan, audit, badRequest, conflict, deleteSecret, freeId, notFound, putSecret, slugOf, type WriteCtx } from "./common.js"

export interface DesktopFields {
  name: string
  description: string
  mcpUrl: string
  agentUrl: string
  key?: string
}

const keyRef = (desktopId: string) => ({ scope: "desktop" as const, refId: desktopId, name: "key" })
// 掩码只留最后 4 位（••••••••3f2a）
const putKey = (tx: Parameters<typeof putSecret>[0], ctx: WriteCtx, desktopId: string, key: string) => putSecret(tx, ctx.keyring(), keyRef(desktopId), key, ctx.actor.id, 0)

const iso = (value: Date) => value.toISOString()

export async function listDesktops(db: Db): Promise<Desktop[]> {
  const rows = await db
    .select({ desktop: t.desktops, masked: t.secrets.masked })
    .from(t.desktops)
    .leftJoin(t.secrets, eq(t.secrets.id, t.desktops.keySecretId))
    .orderBy(asc(t.desktops.position), asc(t.desktops.createdAt))
  const leases = rows.length
    ? await db
        .select({ lease: t.desktopLeases, taskTitle: t.tasks.title })
        .from(t.desktopLeases)
        .innerJoin(t.sessions, eq(t.sessions.id, t.desktopLeases.sessionId))
        .innerJoin(t.tasks, eq(t.tasks.id, t.sessions.taskId))
        .where(
          inArray(
            t.desktopLeases.desktopId,
            rows.map((row) => row.desktop.id)
          )
        )
    : []
  return rows.map(({ desktop, masked }) => {
    const found = leases.find((each) => each.lease.desktopId === desktop.id)
    const use: Desktop["use"] = found
      ? {
          state: found.lease.state,
          sessionId: found.lease.sessionId,
          taskTitle: found.taskTitle,
          since: iso(found.lease.acquiredAt),
          ...(found.lease.state === "held" && found.lease.holdUntil ? { holdUntil: iso(found.lease.holdUntil) } : {}),
        }
      : { state: "free" }
    return {
      id: desktop.id,
      name: desktop.name,
      description: desktop.description,
      mcpUrl: desktop.mcpUrl,
      agentUrl: desktop.agentUrl,
      keyMask: masked ?? "",
      use,
      createdAt: iso(desktop.createdAt),
      updatedAt: iso(desktop.updatedAt),
    }
  })
}

export async function createDesktop(ctx: WriteCtx, input: DesktopFields & { key: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能新建桌面")
  return ctx.db.transaction(async (tx) => {
    const [sameName] = await tx.select({ id: t.desktops.id }).from(t.desktops).where(eq(t.desktops.name, input.name))
    if (sameName) throw conflict(`已经有叫「${input.name}」的桌面了`)
    const id = await freeId(async (each) => (await tx.select({ id: t.desktops.id }).from(t.desktops).where(eq(t.desktops.id, each))).length > 0, `dk-${slugOf(input.name) || "desktop"}`)
    // 新的排在最后
    const [last] = await tx.select({ n: count() }).from(t.desktops)
    const position = last?.n ?? 0
    await tx.insert(t.desktops).values({ id, name: input.name, description: input.description, mcpUrl: input.mcpUrl, agentUrl: input.agentUrl, position })
    const keySecretId = await putKey(tx, ctx, id, input.key)
    await tx.update(t.desktops).set({ keySecretId }).where(eq(t.desktops.id, id))
    await audit(tx, ctx.actor.id, "desktop.create", "desktops", id, { name: input.name, mcpUrl: input.mcpUrl, agentUrl: input.agentUrl, keySet: true })
    return { id }
  })
}

export async function updateDesktop(ctx: WriteCtx, input: DesktopFields & { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能修改桌面")
  // 编辑时密钥留空 = 不改；填了就要和新建时一样至少 16 位
  if (input.key && input.key.length < 16) throw badRequest("密钥至少 16 位")
  await ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.desktops).where(eq(t.desktops.id, input.id))
    if (!before) throw notFound("桌面", input.id)
    const [sameName] = await tx.select({ id: t.desktops.id }).from(t.desktops).where(eq(t.desktops.name, input.name))
    if (sameName && sameName.id !== input.id) throw conflict(`已经有叫「${input.name}」的桌面了`)
    const keySecretId = input.key ? await putKey(tx, ctx, input.id, input.key) : before.keySecretId
    const next = { name: input.name, description: input.description, mcpUrl: input.mcpUrl, agentUrl: input.agentUrl }
    await tx
      .update(t.desktops)
      .set({ ...next, keySecretId, updatedAt: new Date() })
      .where(eq(t.desktops.id, input.id))
    // 审计里只记改了哪些字段和地址，密钥只记「换了」
    const changed = (Object.keys(next) as (keyof typeof next)[]).filter((key) => before[key] !== next[key])
    await audit(tx, ctx.actor.id, "desktop.update", "desktops", input.id, {
      changed,
      ...(changed.includes("mcpUrl") ? { mcpUrl: input.mcpUrl } : {}),
      ...(changed.includes("agentUrl") ? { agentUrl: input.agentUrl } : {}),
      ...(input.key ? { key: "set" } : {}),
    })
  })
}

export async function deleteDesktop(ctx: WriteCtx, input: { id: string }) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能删除桌面")
  await ctx.db.transaction(async (tx) => {
    const [before] = await tx.select().from(t.desktops).where(eq(t.desktops.id, input.id))
    if (!before) throw notFound("桌面", input.id)
    const [lease] = await tx.select({ id: t.desktopLeases.desktopId }).from(t.desktopLeases).where(eq(t.desktopLeases.desktopId, input.id))
    if (lease) throw conflict("桌面正被运行占着，先放开再删")
    await tx.delete(t.desktops).where(eq(t.desktops.id, input.id))
    await deleteSecret(tx, keyRef(input.id))
    await audit(tx, ctx.actor.id, "desktop.delete", "desktops", input.id, { name: before.name })
  })
}

/** 「测试连接」：MCP 列一次工具、桌面服务调 /health（各自最多 10 秒） */
export async function testDesktopConnection(ctx: WriteCtx, input: { id: string }): Promise<DesktopHealth> {
  // 和工具页的「连接并读取工具」一样只给主管：要用密钥连出去
  assertCan(ctx.actor, "config.manage", {}, "只有主管能测试桌面连接")
  const target = await loadDesktopTarget(ctx.db, ctx.keyring(), input.id)
  if (!target) throw notFound("桌面", input.id)
  return testDesktop(target)
}
