// 本机资源（docs/dev/desktop-vm.md 第 3 节）：内存、CPU（pod 里读到的是宿主机的）、开着的虚拟机占的内存、Podman / KVM 能不能用。
// 开机（新建、模板、开机、重启）前检查：开着的虚拟机内存合计 + 这台 ≤ 本机内存 − HEYAGENT_DESKTOP_RESERVED_GB。
import { existsSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { cpus as osCpus, totalmem } from "node:os"
import { join } from "node:path"

import type { DesktopHost } from "@heyagent/shared"
import { and, eq, inArray, ne, notInArray, or, sql } from "drizzle-orm"

import { conflict, type DbOrTx } from "../../data/config/common.js"
import * as t from "../../db/schema.js"
import { vmConfig } from "./config.js"
import { podmanFor } from "./podman.js"
import { listStorages } from "./storage.js"

const GB = 1024 ** 3

/** 本机内存（GB，取整到 0.1）：/proc/meminfo 的 MemTotal，读不到用 os.totalmem() */
export async function hostMemoryGb(): Promise<number> {
  const text = await readFile(join(vmConfig.procRoot, "meminfo"), "utf8").catch(() => "")
  const kb = Number(/^MemTotal:\s+(\d+)\s*kB/m.exec(text)?.[1])
  const bytes = kb > 0 ? kb * 1024 : totalmem()
  return Math.round((bytes / GB) * 10) / 10
}

/**
 * 算「开着」的虚拟机：正在开、开着、装 Windows、关机中的，和要开（desired = running）还没开起来的。
 * 出错、模板做好了、删除中的不算
 */
const occupying = or(
  inArray(t.desktopVms.state, ["creating", "installing", "starting", "running", "setup", "stopping"]),
  and(eq(t.desktopVms.desired, "running"), notInArray(t.desktopVms.state, ["error", "ready", "deleting"]))
)

export async function usedMemory(db: DbOrTx, exceptDesktopId?: string): Promise<{ count: number; memoryGb: number }> {
  const [row] = await db
    .select({ count: sql<number>`count(*)::int`, memoryGb: sql<number>`coalesce(sum(${t.desktopVms.memoryGb}), 0)::int` })
    .from(t.desktopVms)
    .where(exceptDesktopId ? and(occupying, ne(t.desktopVms.desktopId, exceptDesktopId)) : occupying)
  return { count: row?.count ?? 0, memoryGb: row?.memoryGb ?? 0 }
}

/** 内存不够就报错（CONFLICT，页面原样显示） */
export async function assertMemory(db: DbOrTx, memoryGb: number, exceptDesktopId?: string) {
  const problem = await memoryProblem(db, memoryGb, exceptDesktopId)
  if (problem) throw conflict(problem)
}

export async function memoryProblem(db: DbOrTx, memoryGb: number, exceptDesktopId?: string): Promise<string | undefined> {
  const total = await hostMemoryGb()
  const used = await usedMemory(db, exceptDesktopId)
  const limit = total - vmConfig.reservedGb
  if (used.memoryGb + memoryGb <= limit) return undefined
  return `本机内存不够了：开着 ${used.count} 台共 ${used.memoryGb} GB，再开要 ${memoryGb} GB（本机 ${Math.floor(total)} GB，留给系统 ${vmConfig.reservedGb} GB），先关掉不用的桌面`
}

/** 能不能开虚拟机：Podman 连得上、有 KVM。能 = undefined */
export async function vmProblem(): Promise<string | undefined> {
  const podman = podmanFor(vmConfig.podmanSocket)
  if (!podman) return "没有配置 Podman（HEYAGENT_PODMAN_SOCKET），本机不能开虚拟机"
  const kvm = vmConfig.kvmDevice
  if (kvm && !existsSync(kvm)) return `本机没有 KVM（${kvm} 不存在），不能开虚拟机`
  try {
    await podman.ping()
  } catch (error) {
    return `${(error as Error).message}，本机不能开虚拟机`
  }
  if (vmConfig.storageRoots.length === 0) return "没有配置存放位置（HEYAGENT_DESKTOP_STORAGE_ROOTS），本机不能开虚拟机"
  return undefined
}

export async function hostInfo(db: DbOrTx): Promise<DesktopHost> {
  const [problem, memoryGb, used, storages] = await Promise.all([vmProblem(), hostMemoryGb(), usedMemory(db), listStorages(db)])
  return {
    available: !problem,
    ...(problem ? { problem } : {}),
    memoryGb,
    cpus: osCpus().length,
    usedMemoryGb: used.memoryGb,
    runningVms: used.count,
    storages,
  }
}
