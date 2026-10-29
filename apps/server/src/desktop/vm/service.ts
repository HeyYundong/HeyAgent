// 系统开的桌面的接口一侧（docs/dev/desktop-vm.md 第 5 节）：建模板、从模板建桌面、开关机 / 重启 / 重置 / 做成模板、存放位置的设置、列表里的虚拟机信息。
// 接口只改库（desired / op / 状态）、写审计，然后交给 worker（desktop.vm 任务）去做，页面看实时推送的状态。
import { randomBytes } from "node:crypto"
import { readdir, stat } from "node:fs/promises"
import { join } from "node:path"

import type { DesktopStorage, DesktopStorageSettings, DesktopVmAction, DesktopVmInfo } from "@heyagent/shared"
import { count, eq, inArray, isNotNull } from "drizzle-orm"

import { assertCan, audit, badRequest, conflict, freeId, notFound, putSecret, slugOf, type DbOrTx, type WriteCtx } from "../../data/config/common.js"
import * as t from "../../db/schema.js"
import { appendEvent } from "../../engine/records.js"
import { desktopLease, forceReleaseDesktop } from "../leases.js"
import { containerNameOf, vmConfig, vmDirOf, vmUrls } from "./config.js"
import { assertMemory, vmProblem } from "./host.js"
import { enqueueVm, loadVm, type VmRow } from "./lifecycle.js"
import { lockVms, usedPorts } from "./ports.js"
import { DESKTOP_STORAGE_SETTING_KEY, kindOfPath, listStorages } from "./storage.js"

const GB = 1024 ** 3

/** 这些操作要先关机：被运行占着时要二次确认（force） */
const ACTION_LABEL: Record<DesktopVmAction["action"], string> = { start: "开机", stop: "关机", restart: "重启", reset: "重置", seal: "做成模板" }

/** 目录里的文件实际占了多少（qcow2 是稀疏的，按块算） */
async function diskUsage(dir: string): Promise<number | undefined> {
  let total = 0
  const walk = async (path: string, depth: number): Promise<void> => {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory() && depth < 3) await walk(full, depth + 1)
      else if (entry.isFile()) total += (await stat(full).catch(() => undefined))?.blocks ?? 0
    }
  }
  try {
    await walk(dir, 0)
  } catch {
    return undefined
  }
  return Math.round(((total * 512) / GB) * 10) / 10
}

/** desktops.list 里每台的 vm 一项 */
export async function vmInfos(db: DbOrTx): Promise<Map<string, DesktopVmInfo>> {
  const rows = await db.select().from(t.desktopVms)
  const result = new Map<string, DesktopVmInfo>()
  if (rows.length === 0) return result
  const storages = await listStorages(db).catch(() => [] as DesktopStorage[])
  const templateIds = [...new Set(rows.map((row) => row.templateId).filter((id): id is string => Boolean(id)))]
  const names = templateIds.length ? await db.select({ id: t.desktops.id, name: t.desktops.name }).from(t.desktops).where(inArray(t.desktops.id, templateIds)) : []
  const used = await db
    .select({ id: t.desktopVms.templateId, n: count() })
    .from(t.desktopVms)
    .where(isNotNull(t.desktopVms.templateId))
    .groupBy(t.desktopVms.templateId)
  const templates = new Set((await db.select({ id: t.desktops.id }).from(t.desktops).where(eq(t.desktops.kind, "template"))).map((row) => row.id))
  await Promise.all(
    rows.map(async (row) => {
      const diskUsedGb = await diskUsage(row.dir)
      const templateName = names.find((each) => each.id === row.templateId)?.name
      result.set(row.desktopId, {
        state: row.state,
        ...(row.message ? { message: row.message } : {}),
        storagePath: row.storagePath,
        diskKind: kindOfPath(storages, row.storagePath),
        memoryGb: row.memoryGb,
        cpus: row.cpus,
        ...(row.templateId ? { templateId: row.templateId } : {}),
        ...(templateName ? { templateName } : {}),
        ...(templates.has(row.desktopId) ? { usedBy: used.find((each) => each.id === row.desktopId)?.n ?? 0 } : {}),
        ...(diskUsedGb !== undefined ? { diskUsedGb } : {}),
        stateSince: row.stateSince.toISOString(),
      })
    })
  )
  return result
}

/** 选存放位置：只能是部署时配置的、现在能用的；不填用默认的 */
async function pickStorage(db: DbOrTx, path: string | undefined): Promise<DesktopStorage> {
  const storages = await listStorages(db)
  const storage = path ? storages.find((each) => each.path === path) : storages.find((each) => each.isDefault)
  if (!storage) throw badRequest(path ? `不能放在 ${path}：只能选部署时配置的存放位置` : "没有能用的存放位置，请主管检查（空间不够或目录不能写）")
  if (storage.problem) throw conflict(`存放位置 ${storage.path} 不能用：${storage.problem}`)
  return storage
}

/** 从 HEYAGENT_DESKTOP_PORT_RANGE 里分两个没用过的端口（Windows-MCP、桌面服务）。开机时被占着的话 worker 再换（ports.ts） */
async function allocatePorts(tx: DbOrTx): Promise<[number, number]> {
  const [low, high] = vmConfig.portRange
  const used = await usedPorts(tx)
  const free: number[] = []
  for (let port = low; port <= high && free.length < 2; port++) if (!used.has(port)) free.push(port)
  if (free.length < 2) throw conflict(`端口用完了（${low}-${high}），删掉不用的桌面再建`)
  return [free[0]!, free[1]!]
}

async function assertHost() {
  const problem = await vmProblem()
  if (problem) throw conflict(problem)
}

async function sameNameCheck(tx: DbOrTx, name: string) {
  const [sameName] = await tx.select({ id: t.desktops.id }).from(t.desktops).where(eq(t.desktops.name, name))
  if (sameName) throw conflict(`已经有叫「${name}」的桌面了`)
}

async function newDesktopId(tx: DbOrTx, name: string, fallback: string) {
  return freeId(async (each) => (await tx.select({ id: t.desktops.id }).from(t.desktops).where(eq(t.desktops.id, each))).length > 0, `dk-${slugOf(name) || fallback}`)
}

async function nextPosition(tx: DbOrTx) {
  const [last] = await tx.select({ n: count() }).from(t.desktops)
  return last?.n ?? 0
}

export interface TemplateInput {
  name: string
  description: string
  storagePath: string
  diskGb: number
  memoryGb: number
  cpus: number
}

/** 做模板（主管）：系统生成密钥和 Windows 密码（只存密文），worker 去装 Windows 和两个服务 */
export async function createTemplate(ctx: WriteCtx, input: TemplateInput): Promise<{ id: string }> {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能做模板")
  await assertHost()
  const storage = await pickStorage(ctx.db, input.storagePath)
  const result = await ctx.db.transaction(async (tx) => {
    await lockVms(tx)
    await sameNameCheck(tx, input.name)
    await assertMemory(tx, input.memoryGb)
    const id = await newDesktopId(tx, input.name, "template")
    const [mcpPort, agentPort] = await allocatePorts(tx)
    await tx.insert(t.desktops).values({ id, kind: "template", name: input.name, description: input.description, ...vmUrls(mcpPort, agentPort), createdById: ctx.actor.id, position: await nextPosition(tx) })
    const keySecretId = await putSecret(tx, ctx.keyring(), { scope: "desktop", refId: id, name: "key" }, randomBytes(24).toString("hex"), ctx.actor.id, 0)
    // Windows 的密码：要有大小写、数字、符号（Windows 的复杂度要求）
    const vmPasswordSecretId = await putSecret(tx, ctx.keyring(), { scope: "desktop", refId: id, name: "vmPassword" }, `Ha-${randomBytes(12).toString("hex")}`, ctx.actor.id, 0)
    await tx.update(t.desktops).set({ keySecretId }).where(eq(t.desktops.id, id))
    await tx.insert(t.desktopVms).values({
      desktopId: id,
      storagePath: storage.path,
      dir: vmDirOf(storage.path, id),
      container: containerNameOf(id),
      state: "creating",
      desired: "running",
      memoryGb: input.memoryGb,
      cpus: input.cpus,
      diskGb: input.diskGb,
      mcpPort,
      agentPort,
      vmPasswordSecretId,
    })
    await audit(tx, ctx.actor.id, "desktop.template.create", "desktops", id, { name: input.name, storagePath: storage.path, diskKind: storage.kind, diskGb: input.diskGb, memoryGb: input.memoryGb, cpus: input.cpus })
    return { id }
  })
  await enqueueVm(ctx.db, result.id)
  return result
}

export interface VmInput {
  name: string
  description: string
  templateId: string
  storagePath?: string
  memoryGb?: number
  cpus?: number
}

/** 从做好的模板建桌面（所有人）：盘是模板盘上的写时复制，地址、密钥由系统填 */
export async function createVm(ctx: WriteCtx, input: VmInput): Promise<{ id: string }> {
  assertCan(ctx.actor, "desktop.create", {})
  await assertHost()
  const template = await loadVm(ctx.db, input.templateId)
  if (!template || template.kind !== "template") throw notFound("模板", input.templateId)
  if (template.state !== "ready") throw conflict(`模板「${template.name}」还没做好，做好以后才能用它建桌面`)
  const storage = await pickStorage(ctx.db, input.storagePath)
  const memoryGb = input.memoryGb ?? template.memoryGb
  const cpus = input.cpus ?? template.cpus
  const result = await ctx.db.transaction(async (tx) => {
    await lockVms(tx)
    await sameNameCheck(tx, input.name)
    await assertMemory(tx, memoryGb)
    const id = await newDesktopId(tx, input.name, "vm")
    const [mcpPort, agentPort] = await allocatePorts(tx)
    await tx.insert(t.desktops).values({
      id,
      kind: "vm",
      name: input.name,
      description: input.description,
      ...vmUrls(mcpPort, agentPort),
      // 从这个模板建的桌面共用模板的密钥（端口只开在本机）
      keySecretId: template.keySecretId,
      createdById: ctx.actor.id,
      position: await nextPosition(tx),
    })
    await tx.insert(t.desktopVms).values({
      desktopId: id,
      templateId: template.desktopId,
      storagePath: storage.path,
      dir: vmDirOf(storage.path, id),
      container: containerNameOf(id),
      state: "creating",
      desired: "running",
      memoryGb,
      cpus,
      diskGb: template.diskGb,
      mcpPort,
      agentPort,
      vmPasswordSecretId: template.vmPasswordSecretId,
    })
    await audit(tx, ctx.actor.id, "desktop.vm.create", "desktops", id, { name: input.name, templateId: template.desktopId, storagePath: storage.path, diskKind: storage.kind, memoryGb, cpus })
    return { id }
  })
  await enqueueVm(ctx.db, result.id)
  return result
}

/** vm 用 desktop.manage（建的人）、模板用 config.manage；主管都能 */
export function assertCanManageVm(ctx: WriteCtx, desktop: { kind: string; createdById: string | null }, what: string) {
  if (desktop.kind === "template") assertCan(ctx.actor, "config.manage", {}, `只有主管能${what}模板`)
  else if (desktop.kind === "vm") assertCan(ctx.actor, "desktop.manage", { createdById: desktop.createdById ?? "" }, `只有建这台桌面的人和主管能${what}它`)
  else assertCan(ctx.actor, "config.manage", {}, `只有主管能${what}手动登记的桌面`)
}

/** 开机 / 关机 / 重启 / 重置（桌面）、做成模板（模板）。被运行占着时不带 force 报 CONFLICT；带 force 先放开占用 */
export async function vmAction(ctx: WriteCtx, input: DesktopVmAction): Promise<void> {
  const row = await loadVm(ctx.db, input.id)
  const [desktop] = await ctx.db.select({ kind: t.desktops.kind, createdById: t.desktops.createdById, name: t.desktops.name }).from(t.desktops).where(eq(t.desktops.id, input.id))
  if (!desktop) throw notFound("桌面", input.id)
  assertCanManageVm(ctx, desktop, ACTION_LABEL[input.action])
  if (!row) throw badRequest("手动登记的电脑不归系统开关机，请在那台电脑上操作")
  if (row.op === "delete" || row.state === "deleting") throw conflict(`桌面「${row.name}」正在删除`)
  const label = ACTION_LABEL[input.action]
  if (row.kind === "template" && row.state === "ready" && input.action !== "stop") throw conflict(`模板「${row.name}」已经做好了（只读），不能再${label}。要改的话重新做一个模板`)
  if (input.action === "reset" && row.kind !== "vm") throw badRequest("只有系统开的桌面能重置")
  if (input.action === "seal") {
    if (row.kind !== "template") throw badRequest("只有模板能「做成模板」")
    if (!(row.state === "setup" || (row.state === "stopped" && row.installedAt)))
      throw conflict(`模板「${row.name}」还没装好（现在：${row.state}），Windows 和两个服务装好、软件装好以后才能做成模板`)
  }
  // 开机、重启要内存：别的开着的 + 这台（这台本来就算在「开着」里也不重复算）
  if (input.action === "start" || input.action === "restart") await assertMemory(ctx.db, row.memoryGb, row.desktopId)
  let released: { sessionId: string; state: string } | undefined
  if (input.action !== "start") {
    const lease = await desktopLease(ctx.db, row.desktopId)
    if (lease && !input.force) throw conflict(`桌面「${row.name}」正被运行用着，${label}会打断那个运行。确定要${label}请再确认一次`)
    if (lease) released = await forceReleaseDesktop(ctx.db, row.desktopId)
  }
  // 出错的：先当成关着，worker 按 Podman 实际状态重新来
  const fromError = row.state === "error" ? { state: "stopped" as const, message: null, stateSince: new Date() } : {}
  const set =
    input.action === "start"
      ? { desired: "running" as const, ...fromError }
      : input.action === "stop"
        ? { desired: "stopped" as const, ...fromError }
        : input.action === "restart"
          ? { desired: "running" as const, op: "restart" as const, ...fromError }
          : { op: input.action, ...fromError }
  await ctx.db.transaction(async (tx) => {
    await tx
      .update(t.desktopVms)
      .set({ ...set, updatedAt: new Date() })
      .where(eq(t.desktopVms.desktopId, row.desktopId))
    await audit(tx, ctx.actor.id, `desktop.vm.${input.action}`, "desktops", row.desktopId, {
      name: row.name,
      ...(released ? { releasedSessionId: released.sessionId, force: true } : {}),
    })
  })
  if (released)
    await appendEvent(ctx.db, released.sessionId, {
      kind: "wait",
      title: `桌面「${row.name}」被${label}了，已放开`,
      detail: `桌面 ${row.desktopId}；有人在桌面页${label}了这台桌面（打断了这个运行）。下一次调桌面工具时重新占它（开着、空着才行）`,
    }).catch(() => {})
  await enqueueVm(ctx.db, row.desktopId)
}

/** 删除系统开的桌面 / 模板：标成删除中，worker 关机、删容器、删目录、删这一行 */
export async function markVmDeleted(ctx: WriteCtx, tx: DbOrTx, row: VmRow) {
  if (row.kind === "template") {
    const [used] = await tx.select({ n: count() }).from(t.desktopVms).where(eq(t.desktopVms.templateId, row.desktopId))
    if (used && used.n > 0) throw conflict(`有 ${used.n} 台桌面是用模板「${row.name}」建的，先删掉它们再删模板`)
  }
  await tx.update(t.desktopVms).set({ op: "delete", state: "deleting", stateSince: new Date(), message: null, updatedAt: new Date() }).where(eq(t.desktopVms.desktopId, row.desktopId))
  await audit(tx, ctx.actor.id, row.kind === "template" ? "desktop.template.delete" : "desktop.vm.delete", "desktops", row.desktopId, { name: row.name, dir: row.dir })
}

/** 存放位置的设置（主管）：默认位置、手动标的盘类型。只能是部署时配置的位置 */
export async function setStorageSettings(ctx: WriteCtx, input: DesktopStorageSettings) {
  assertCan(ctx.actor, "config.manage", {}, "只有主管能改桌面存放位置")
  const roots = vmConfig.storageRoots
  const unknown = [...(input.defaultPath ? [input.defaultPath] : []), ...Object.keys(input.kindOverrides)].filter((path) => !roots.includes(path))
  if (unknown.length) throw badRequest(`不是部署时配置的存放位置：${[...new Set(unknown)].join("、")}`)
  const value: DesktopStorageSettings = { ...(input.defaultPath ? { defaultPath: input.defaultPath } : {}), kindOverrides: input.kindOverrides }
  await ctx.db.transaction(async (tx) => {
    await tx
      .insert(t.settings)
      .values({ key: DESKTOP_STORAGE_SETTING_KEY, value, updatedById: ctx.actor.id })
      .onConflictDoUpdate({ target: t.settings.key, set: { value, updatedById: ctx.actor.id, updatedAt: new Date() } })
    await audit(tx, ctx.actor.id, "desktop.storage.set", "settings", DESKTOP_STORAGE_SETTING_KEY, value as unknown as Record<string, unknown>)
  })
}

/** 这台是不是能分给运行：模板不行；系统开的桌面要开着（running） */
export async function desktopAvailability(db: DbOrTx, desktopIds: string[]): Promise<Map<string, { kind: string; state?: string }>> {
  if (desktopIds.length === 0) return new Map()
  const rows = await db
    .select({ id: t.desktops.id, kind: t.desktops.kind, state: t.desktopVms.state })
    .from(t.desktops)
    .leftJoin(t.desktopVms, eq(t.desktopVms.desktopId, t.desktops.id))
    .where(inArray(t.desktops.id, desktopIds))
  return new Map(rows.map((row) => [row.id, { kind: row.kind, ...(row.state ? { state: row.state } : {}) }]))
}
