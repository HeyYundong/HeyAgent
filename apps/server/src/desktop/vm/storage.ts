// 存放位置（docs/dev/desktop-vm.md 第 2 节）：只能从 HEYAGENT_DESKTOP_STORAGE_ROOTS 里选。
// 每个位置算剩余空间（statfs），按 /sys/dev/block/<maj>:<min>/queue/rotational 认 SSD / HDD（分区没有 queue 就看上一级），
// 管理员可以在设置里手动标（desktop.storage）。空间不够、目录不存在、不能写的写进 problem，不能选。
import { constants } from "node:fs"
import { access, readFile, realpath, stat, statfs } from "node:fs/promises"
import { dirname, join } from "node:path"

import { desktopStorageSettingsSchema, type DesktopStorage, type DesktopStorageSettings, type DiskKind } from "@heyagent/shared"
import { eq } from "drizzle-orm"

import type { DbOrTx } from "../../data/config/common.js"
import * as t from "../../db/schema.js"
import { vmConfig } from "./config.js"

/** 设置里的键：默认存放位置、手动标的盘类型 */
export const DESKTOP_STORAGE_SETTING_KEY = "desktop.storage"

const GB = 1024 ** 3
const round1 = (value: number) => Math.round(value * 10) / 10

/** Linux 的设备号拆成 major:minor（同 glibc 的 gnu_dev_major / gnu_dev_minor） */
export function devNumbers(dev: bigint): { major: number; minor: number } {
  const major = Number(((dev >> 8n) & 0xfffn) | ((dev >> 32n) & ~0xfffn))
  const minor = Number((dev & 0xffn) | ((dev >> 12n) & ~0xffn))
  return { major, minor }
}

async function readRotational(file: string): Promise<DiskKind | undefined> {
  const text = await readFile(file, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  const value = text.trim()
  return value === "0" ? "ssd" : value === "1" ? "hdd" : "unknown"
}

/** 目录在 SSD 还是 HDD 上：读不到（btrfs、overlay、网络盘……）= unknown */
export async function detectDiskKind(path: string, sysRoot = vmConfig.sysRoot): Promise<DiskKind> {
  const info = await stat(path, { bigint: true }).catch(() => undefined)
  if (!info) return "unknown"
  const { major, minor } = devNumbers(info.dev)
  if (major === 0) return "unknown"
  const block = join(sysRoot, "dev", "block", `${major}:${minor}`)
  const direct = await readRotational(join(block, "queue", "rotational"))
  if (direct) return direct
  // 分区（sda1）没有 queue，看它所在的整块盘（/sys/devices/…/sda/sda1 的上一级）
  const real = await realpath(block).catch(() => undefined)
  if (!real) return "unknown"
  return (await readRotational(join(dirname(real), "queue", "rotational"))) ?? "unknown"
}

export async function readStorageSettings(db: DbOrTx): Promise<DesktopStorageSettings> {
  const [row] = await db.select({ value: t.settings.value }).from(t.settings).where(eq(t.settings.key, DESKTOP_STORAGE_SETTING_KEY))
  return desktopStorageSettingsSchema.safeParse(row?.value).data ?? { kindOverrides: {} }
}

export interface StorageOptions {
  roots?: string[]
  sysRoot?: string
  minFreeGb?: number
}

/** 列出可选的存放位置（顺序同 HEYAGENT_DESKTOP_STORAGE_ROOTS），标出默认的那个 */
export async function discoverStorages(settings: DesktopStorageSettings, options: StorageOptions = {}): Promise<DesktopStorage[]> {
  const roots = options.roots ?? vmConfig.storageRoots
  const minFreeGb = options.minFreeGb ?? vmConfig.minFreeGb
  const storages = await Promise.all(
    roots.map(async (path): Promise<DesktopStorage> => {
      const override = settings.kindOverrides[path]
      const base = { path, kind: override ?? ("unknown" as DiskKind), kindOverridden: Boolean(override), freeGb: 0, totalGb: 0, isDefault: false }
      const info = await stat(path).catch(() => undefined)
      if (!info?.isDirectory()) return { ...base, problem: "目录不存在" }
      const kind = override ?? (await detectDiskKind(path, options.sysRoot))
      const fs = await statfs(path).catch(() => undefined)
      const freeGb = fs ? round1((Number(fs.bavail) * Number(fs.bsize)) / GB) : 0
      const totalGb = fs ? round1((Number(fs.blocks) * Number(fs.bsize)) / GB) : 0
      const writable = await access(path, constants.W_OK).then(
        () => true,
        () => false
      )
      const problem = !writable ? "没有写权限" : freeGb < minFreeGb ? `剩余空间不够：剩 ${Math.floor(freeGb)} GB，至少要 ${minFreeGb} GB` : undefined
      return { ...base, kind, freeGb, totalGb, ...(problem ? { problem } : {}) }
    })
  )
  // 默认位置：设置里选的（还能用的话）；没选 = 第一个 SSD，没有 SSD 就第一个能用的
  const usable = storages.filter((storage) => !storage.problem)
  const chosen =
    usable.find((storage) => storage.path === settings.defaultPath) ?? usable.find((storage) => storage.kind === "ssd") ?? usable[0]
  return storages.map((storage) => (storage === chosen ? { ...storage, isDefault: true } : storage))
}

export async function listStorages(db: DbOrTx, options: StorageOptions = {}) {
  return discoverStorages(await readStorageSettings(db), options)
}

/** 某个目录的盘类型（列表里显示）：在存放位置里的按它（含手动标的），否则自己认 */
export function kindOfPath(storages: DesktopStorage[], path: string): DiskKind {
  return storages.find((storage) => storage.path === path)?.kind ?? "unknown"
}
